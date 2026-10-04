import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { childEnv, killAll, liveChildren, runTool, streamTool, ToolError } from '../src/process'
import { alive, createFakeBin } from './fakes/bin'
import { tempDir, until } from './harness'

const fakes = () => createFakeBin(tempDir())

describe('runTool', () => {
  it('runs argv without a shell and collects stdout and stderr', async () => {
    const bin = fakes()
    const tool = bin.tool('echoer', 'printf "%s|" "$@"; echo oops >&2')
    const result = await runTool(tool, ['a b', '$(rm -rf /)', '-u'], { timeoutMs: 2_000 })
    expect(result.stdout).toBe('a b|$(rm -rf /)|-u|')
    expect(result.stderr).toBe('oops\n')
    expect(bin.calls()[0]?.argv).toEqual(['a b', '$(rm -rf /)', '-u'])
  })
  it('returns Buffers for PNGs', async () => {
    const bin = fakes()
    const tool = bin.simple('shot', { stdout: Buffer.from([0x89, 0x50, 0, 1, 2]) })
    const { stdout } = await runTool(tool, [], { encoding: 'buffer' })
    expect(stdout.equals(Buffer.from([0x89, 0x50, 0, 1, 2]))).toBe(true)
  })
  it('refuses a relative path: no PATH lookup can run a planted tool', async () => {
    await expect(runTool('adb', ['version'])).rejects.toMatchObject({ reason: 'not-found' })
  })
  it('maps a missing file, a non-zero exit, a timeout and an oversized output', async () => {
    const bin = fakes()
    await expect(runTool(path.join(bin.dir, 'missing'), [])).rejects.toMatchObject({
      reason: 'not-found',
    })
    const failing = bin.simple('failing', { stderr: 'bad device', exit: 3 })
    await expect(runTool(failing, [])).rejects.toMatchObject({
      reason: 'exit',
      code: 3,
      stderr: 'bad device',
    })
    const slow = bin.simple('slow', { sleep: 5 })
    const started = Date.now()
    await expect(runTool(slow, [], { timeoutMs: 100, killGraceMs: 100 })).rejects.toMatchObject({
      reason: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    const chatty = bin.tool('chatty', 'yes 0123456789')
    await expect(runTool(chatty, [], { maxBytes: 1_000 })).rejects.toBeInstanceOf(ToolError)
  })
  it('kills the whole group, grandchild included, when its signal aborts', async () => {
    const bin = fakes()
    const tool = bin.sleeper('hang')
    const controller = new AbortController()
    const running = runTool(tool, [], { signal: controller.signal, killGraceMs: 200 })
    await until(() => alive(bin.gpid('hang')), 3_000, 'the grandchild')
    controller.abort()
    await expect(running).rejects.toMatchObject({ reason: 'aborted' })
    await until(
      () => !alive(bin.pid('hang')) && !alive(bin.gpid('hang')),
      3_000,
      'the group to die',
    )
    expect(liveChildren.size).toBe(0)
  })
  it('settles 1 s after the tool exits when a grandchild still holds stdout, and reaps it', async () => {
    const bin = fakes()
    const tool = bin.tool('leaky', 'sleep 60 & echo $! > "$FAKE_STATE/leaky.gpid"; echo done')
    const started = Date.now()
    const result = await runTool(tool, [], { timeoutMs: 10_000 })
    expect(result.stdout).toBe('done\n')
    expect(Date.now() - started).toBeLessThan(3_000)
    await until(() => !alive(bin.gpid('leaky')), 3_000, 'the grandchild to die')
  })
})

describe('streamTool', () => {
  it('delivers cleaned lines and reaps the group, grandchild included, on kill', async () => {
    const bin = fakes()
    const tool = bin.sleeper('logger', { intervalMs: 10 })
    const seen: string[] = []
    const stream = streamTool(tool, [], {
      onLines: (lines) => seen.push(...lines),
      killGraceMs: 200,
    })
    await until(() => seen.length >= 3, 3_000, 'three lines')
    expect(seen.slice(0, 3)).toEqual(['line 1', 'line 2', 'line 3'])
    stream.kill()
    const result = await stream.done
    expect(result.stopped).toBe(true)
    await until(
      () => !alive(bin.pid('logger')) && !alive(bin.gpid('logger')),
      3_000,
      'the group to die',
    )
  })
  it('stops reading while paused (back-pressure) and resumes', async () => {
    const bin = fakes()
    const tool = bin.sleeper('paced', { intervalMs: 5 })
    const seen: string[] = []
    const stream = streamTool(tool, [], { onLines: (lines) => seen.push(...lines) })
    await until(() => seen.length > 0)
    stream.pause()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const frozen = seen.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen.length).toBe(frozen)
    stream.resume()
    await until(() => seen.length > frozen)
    stream.kill()
    await stream.done
  })
  it('rejects done when the tool never started', async () => {
    const stream = streamTool('/nonexistent/tool', [], { onLines: () => undefined })
    await expect(stream.done).rejects.toMatchObject({ reason: 'not-found' })
  })
})

describe('killAll and childEnv', () => {
  it('killAll TERMs then KILLs only the given set', async () => {
    const bin = fakes()
    const stubborn = bin.tool(
      'stubborn',
      'trap "" TERM; echo $$ > "$FAKE_STATE/stubborn.pid"; while :; do sleep 0.05; done',
    )
    const mine = new Set<ChildProcess>()
    const running = runTool(stubborn, [], { track: mine, timeoutMs: 30_000 }).catch(
      (error: unknown) => error,
    )
    await until(() => alive(bin.pid('stubborn')))
    await killAll(200, mine)
    await until(() => !alive(bin.pid('stubborn')), 3_000, 'SIGKILL after the grace period')
    expect(await running).toBeInstanceOf(ToolError)
  })
  it('childEnv drops the variables that redirect device tools and adds NO_COLOR', () => {
    const env = childEnv(
      { DEVELOPER_DIR: '/x' },
      { PATH: '/bin', ANDROID_SERIAL: 'x', PYMOBILEDEVICE3_UDID: 'y' },
    )
    expect(env).toEqual({ PATH: '/bin', NO_COLOR: '1', DEVELOPER_DIR: '/x' })
  })
})
