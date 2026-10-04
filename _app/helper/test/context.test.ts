import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaneContext } from '../src/types'
import { alive } from './fakes/bin'
import { fakeIosLane } from './fakes/lane'
import { request, startBridge, toolbox, until } from './harness'

async function withLane(input: Parameters<typeof startBridge>[0] = {}) {
  const lane = fakeIosLane()
  const s = await startBridge({ ...input, lanes: { ios: lane.factory, ...input.lanes } })
  return { s, ctx: (): LaneContext => lane.ctx() }
}

describe('the LaneContext a lane gets (§1.4)', () => {
  it('runs tools in this run’s private folder with the cleaned environment', async () => {
    const { s, ctx } = await withLane({
      env: { PATH: '/usr/bin:/bin', ANDROID_SERIAL: 'x', KEEP: 'yes' },
    })
    const tool = s.bin.tool(
      'where',
      'pwd -P; printf "%s|%s|%s\\n" "${ANDROID_SERIAL:-unset}" "$NO_COLOR" "$KEEP"',
    )
    const { stdout } = await ctx().runTool(tool, [], { timeoutMs: 5_000 })
    const [cwd, env] = stdout.trim().split('\n')
    const workDir = ctx().workDir
    expect(path.basename(workDir)).toMatch(/^device-bridge-/)
    expect(statSync(workDir).mode & 0o777).toBe(0o700)
    expect(cwd).toBe(realpathSync(workDir))
    expect(env).toBe('unset|1|yes')
  })
  it('gives each operation a fresh private folder and removes it afterwards', async () => {
    const { ctx } = await withLane()
    let seen = ''
    await ctx().withTempDir(async (dir) => {
      seen = dir
      expect(dir.startsWith(ctx().workDir)).toBe(true)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      return Promise.resolve()
    })
    expect(existsSync(seen)).toBe(false)
  })
  it('runs at most four one-shot tools at once', async () => {
    const { s, ctx } = await withLane()
    const tool = s.bin.tool(
      'busy',
      'echo "+ $$" >> "$FAKE_STATE/busy.log"; sleep 0.3; echo "- $$" >> "$FAKE_STATE/busy.log"',
    )
    await Promise.all(
      Array.from({ length: 7 }, () => ctx().runTool(tool, [], { timeoutMs: 10_000 })),
    )
    let running = 0
    let peak = 0
    for (const line of readFileSync(path.join(s.bin.state, 'busy.log'), 'utf8')
      .split('\n')
      .filter(Boolean)) {
      running += line.startsWith('+') ? 1 : -1
      peak = Math.max(peak, running)
    }
    expect(peak).toBe(4)
  })
  it('caches tool discovery for 30 s; refresh() looks again', async () => {
    const { s, ctx } = await withLane()
    expect((await ctx().tools.get()).adb).toBeNull()
    s.bin.simple('adb', { stdout: 'Android Debug Bridge version 1.0.41\n' })
    expect((await ctx().tools.get()).adb).toBeNull()
    expect((await ctx().tools.refresh()).adb?.path).toBe(path.join(s.bin.dir, 'adb'))
  })
  it('uses an injected toolbox (lane suites fake Xcode and adb this way)', async () => {
    const injected = toolbox((t) => {
      t.xcode = { ...t.xcode, state: 'ready', version: '27.0', devicectl: '/fake/devicectl' }
    })
    const { ctx } = await withLane({ resolveTools: () => Promise.resolve(injected) })
    expect((await ctx().tools.get()).xcode).toMatchObject({
      state: 'ready',
      devicectl: '/fake/devicectl',
    })
  })
  it('is active for 30 s after an authenticated request only', async () => {
    const { s, ctx } = await withLane()
    expect(ctx().isActive()).toBe(false)
    await request(s.port, { path: '/api/health' })
    expect(ctx().isActive()).toBe(false)
    await request(s.port, { path: '/api/devices', headers: s.auth })
    expect(ctx().isActive()).toBe(true)
  })
  it('on close: aborts ctx.signal, kills every tool group, removes the folder', async () => {
    const { s, ctx } = await withLane()
    const workDir = ctx().workDir
    const hang = s.bin.sleeper('hang', { silent: true })
    const running = ctx()
      .runTool(hang, [], { timeoutMs: 60_000 })
      .catch((error: unknown) => error)
    const stream = ctx().streamTool(s.bin.sleeper('tail'), [], { onLines: () => undefined })
    await until(() => alive(s.bin.gpid('hang')) && alive(s.bin.gpid('tail')), 5_000, 'both tools')
    await s.bridge.close()
    expect(ctx().signal.aborted).toBe(true)
    for (const name of ['hang', 'tail']) {
      expect(alive(s.bin.pid(name))).toBe(false)
      expect(alive(s.bin.gpid(name))).toBe(false)
    }
    expect(existsSync(workDir)).toBe(false)
    await running
    await stream.done
  })
  it('logs one line per tool run with --verbose: name and outcome, never arguments', async () => {
    const { s, ctx } = await withLane({ verbose: true })
    const tool = s.bin.simple('devicectl', { stdout: '{}' })
    await ctx().runTool(tool, ['device', 'capture', 'screenshot', '--device', 'SECRET-UDID'], {
      timeoutMs: 5_000,
    })
    const line = s.logs.find((l) => l.includes('tool devicectl'))
    expect(line).toMatch(/tool devicectl ok \d+\.\d s$/)
    expect(s.logs.join('\n')).not.toContain('SECRET-UDID')
  })
})
