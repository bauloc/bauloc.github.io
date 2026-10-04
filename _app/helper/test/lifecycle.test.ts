import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { bundleHelper } from '../build.mjs'
import { loadKeptToken } from '../src/auth'
import { createBridge } from '../src/bridge'
import { main, type MainEnv } from '../src/main'
import type { BridgeInput, LogMsg } from '../src/types'
import { alive } from './fakes/bin'
import { IPHONE, PIXEL } from './fakes/devices'
import { fakeAndroidLane, fakeIosLane } from './fakes/lane'
import {
  freePort,
  isStream,
  isolation,
  onCleanup,
  openStream,
  request,
  tempDir,
  until,
} from './harness'

interface Run {
  env: MainEnv
  out: string[]
  err: string[]
  opened: string[]
  signals: Map<string, () => void>
  exited: Promise<number>
  exits: number[]
  stdout: () => string
}

/** main() in-process: a fake terminal, captured exits and signal handlers, isolated options. */
async function run(
  argv: string[],
  opts: { bridge?: BridgeInput; env?: Partial<MainEnv> } = {},
): Promise<Run> {
  const iso = await isolation(opts.bridge)
  const out: string[] = []
  const err: string[] = []
  const opened: string[] = []
  const exits: number[] = []
  const signals = new Map<string, () => void>()
  let settle: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => (settle = resolve))
  // main() owns the terminal: the isolation's log writers must not capture its lines.
  const bridge: BridgeInput = { ...iso.input, port: opts.bridge?.port ?? 0 }
  delete bridge.log
  delete bridge.errorLog
  const env: MainEnv = {
    argv,
    scriptPath: path.join(iso.home, 'device-bridge.mjs'),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: false,
    platform: 'darwin',
    home: iso.home,
    cwd: iso.home,
    getuid: () => 501,
    onSignal: (signal, handler) => signals.set(signal, handler),
    exit: (code) => {
      exits.push(code)
      settle(code)
    },
    openUrl: (url) => opened.push(url),
    bridge,
    ...opts.env,
  }
  await main(env)
  onCleanup(() => signals.get('SIGTERM')?.())
  return { env, out, err, opened, signals, exited, exits, stdout: () => out.join('') }
}

describe('main(): command line and refusals (§1.7, §1.10)', () => {
  it('--help and --version print and exit 0', async () => {
    const help = await run(['--help'])
    expect(help.exits).toEqual([0])
    expect(help.stdout()).toContain('node ~/device-bridge.mjs [options]')
    const version = await run(['--version'])
    expect([version.exits, version.stdout()]).toEqual([[0], '1.0.0\n'])
  })
  it('an unknown option exits 64 with the exact sentence', async () => {
    const r = await run(['--foo'])
    expect(r.exits).toEqual([64])
    expect(r.err.join('')).toBe('Unknown option --foo. Run: node ~/device-bridge.mjs --help\n')
  })
  it('refuses to run as root', async () => {
    const r = await run([], { env: { getuid: () => 0 } })
    expect(r.exits).toEqual([1])
    expect(r.err.join('')).toBe(
      "Don't run the Device Lab helper with sudo; it never needs root. Run it as yourself: node ~/device-bridge.mjs\n",
    )
  })
  it('refuses a kept token file other users can read', async () => {
    const iso = await isolation()
    const kept = loadKeptToken({
      home: iso.home,
      platform: 'darwin',
      env: {},
      getuid: process.getuid,
      newToken: false,
    })
    chmodSync(kept.path, 0o644)
    const r = await run(['--keep-token'], {
      bridge: { home: iso.home },
      env: { getuid: process.getuid?.bind(process) },
    })
    expect(r.exits).toEqual([1])
    expect(r.err.join('')).toContain('can be read by other users. Fix it with: chmod 600')
  })
  it('names our own helper when the port is taken by it, and another program otherwise', async () => {
    const iso = await isolation()
    const ours = createBridge({ ...iso.input, port: await freePort() })
    const { port } = await ours.listen()
    onCleanup(() => ours.close())
    const r1 = await run(['--port', String(port)], { bridge: { port } })
    expect(r1.exits).toEqual([1])
    expect(r1.err.join('')).toBe(
      `A Device Lab helper (1.0.0) is already running on port ${String(port)}. Use that window, or stop it with Ctrl+C there.\n`,
    )
    const other = http.createServer((_req, res) => res.end('hello'))
    const otherPort = await freePort()
    await new Promise<void>((resolve) => other.listen(otherPort, '127.0.0.1', resolve))
    onCleanup(() => other.close())
    const r2 = await run(['--port', String(otherPort)], { bridge: { port: otherPort } })
    expect(r2.err.join('')).toBe(
      `Port ${String(otherPort)} is used by another program. Start the helper on another port:\n  node ~/device-bridge.mjs --port ${String(otherPort + 1)}\n`,
    )
  })
  it('--doctor prints and exits 0 without serving anything', async () => {
    const r = await run(['--doctor'])
    expect(r.exits).toEqual([0])
    expect(r.stdout()).toContain('bauloc-device-bridge 1.0.0 · doctor')
  })
})

describe('main(): start, banner, auto-open, signals', () => {
  it('prints the banner first, then the lines held while starting', async () => {
    const r = await run(['--no-open'], {
      bridge: { lanes: { ios: fakeIosLane({ rows: [IPHONE] }).factory } },
    })
    const text = r.stdout()
    expect(text.startsWith('Device Lab helper 1.0.0 · http://127.0.0.1:')).toBe(true)
    expect(text).toContain('Open Device Lab with the link for your browser:')
    const banner = text.indexOf('Keep this window open')
    expect(text.indexOf('+ Ngọc’s iPhone 12 Pro · iOS 27.0 · USB · trusted')).toBeGreaterThan(
      banner,
    )
    expect(r.opened).toEqual([])
  })
  it('opens the hosted link only on macOS, in a terminal, without --no-open', async () => {
    const tty = await run([], { env: { isTTY: true } })
    expect(tty.opened).toHaveLength(1)
    expect(tty.opened[0]).toMatch(
      /^https:\/\/bauloc\.github\.io\/device\/#pair=[A-Za-z0-9_-]{43}&port=\d+$/,
    )
    expect(tty.stdout()).toContain('Opening Device Lab in your browser.')
    expect((await run([], { env: { isTTY: false } })).opened).toEqual([])
    expect((await run(['--no-open'], { env: { isTTY: true } })).opened).toEqual([])
    expect((await run([], { env: { isTTY: true, platform: 'linux' } })).opened).toEqual([])
  })
  it('first signal: Stopping…, streams end with shutdown, exit 0; adb advice when it started adb', async () => {
    const r = await run(['--no-open'], {
      bridge: {
        lanes: {
          android: fakeAndroidLane({
            state: { status: 'ok', startedByHelper: true },
            rows: [PIXEL],
            logs: async (_id, sink, signal) => {
              sink.hello('logcat')
              await new Promise((resolve) => signal.addEventListener('abort', resolve))
            },
          }).factory,
        },
      },
    })
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(r.stdout())?.[1])
    const token = /#pair=([A-Za-z0-9_-]{43})/.exec(r.stdout())?.[1] ?? ''
    const stream = await openStream(port, '/api/devices/55090DLAQ0026D/logs', {
      Authorization: `Bearer ${token}`,
    })
    if (!isStream(stream)) throw new Error(stream.text)
    await stream.waitFor((m) => m.t === 'hello')
    r.signals.get('SIGINT')?.()
    expect(await r.exited).toBe(0)
    expect(stream.messages.at(-1)).toEqual({ t: 'end', reason: 'shutdown' })
    expect(r.stdout()).toContain('\nStopping… (press Ctrl+C again to force)\n')
    expect(r.stdout()).toContain(
      "The adb server started from Device Lab is still running. Chrome's WebUSB can use Android phones again after: adb kill-server\n",
    )
    await expect(request(port, { path: '/api/health' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
  })
  it('the adb advice names adb by its full path when the terminal’s PATH does not reach it', async () => {
    const adb = '/Users/tester/Library/Android/sdk/platform-tools/adb'
    const r = await run(['--no-open'], {
      bridge: {
        lanes: {
          android: fakeAndroidLane(
            { state: { status: 'ok', startedByHelper: true } },
            { adb, version: '36.0.0', startedByHelper: true },
          ).factory,
        },
      },
    })
    r.signals.get('SIGINT')?.()
    expect(await r.exited).toBe(0)
    expect(r.stdout()).toContain(
      `Chrome's WebUSB can use Android phones again after: ${adb} kill-server\n`,
    )
  })
  it('second signal: exit 130 at once', async () => {
    const r = await run(['--no-open'])
    r.signals.get('SIGINT')?.()
    r.signals.get('SIGINT')?.()
    expect(r.exits[0]).toBe(130)
  })
})

describe('the built file, in a real process', () => {
  let bundle = ''
  beforeAll(async () => {
    const { code } = await bundleHelper()
    bundle = path.join(tempDir('bundle-'), 'device-bridge.mjs')
    writeFileSync(bundle, code)
  })

  async function spawnHelper(extra: Record<string, unknown>, argv: string[]) {
    const iso = await isolation()
    const port = await freePort()
    const token = 'k'.repeat(43)
    iso.bin.sleeper('logcat')
    const options = JSON.stringify({
      ...iso.input,
      port,
      token,
      logTool: path.join(iso.bin.dir, 'logcat'),
      ...extra,
    })
    const runner = fileURLToPath(new URL('./fakes/run-main.mjs', import.meta.url))
    const child = spawn(
      process.execPath,
      [runner, bundle, options, '--port', String(port), '--no-open', ...argv],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    )
    onCleanup(() => child.kill('SIGKILL'))
    await until(
      () => stdout.includes('Keep this window open'),
      10_000,
      `the banner (stderr: ${stderr})`,
    )
    return { child, port, token, iso, exited, out: () => stdout }
  }

  it('starts, streams, and on SIGINT ends the stream, kills the tool group and exits 0', async () => {
    const h = await spawnHelper({}, [])
    expect(h.out()).toContain(
      `Device Lab helper 1.0.0 · http://127.0.0.1:${String(h.port)} (this Mac only)`,
    )
    const stream = await openStream(h.port, '/api/devices/55090DLAQ0026D/logs', {
      Authorization: `Bearer ${h.token}`,
    })
    if (!isStream(stream)) throw new Error(stream.text)
    await stream.waitFor((m: LogMsg) => m.t === 'lines')
    await until(() => alive(h.iso.bin.gpid('logcat')), 3_000, 'the log tool’s grandchild')
    h.child.kill('SIGINT')
    expect(await h.exited).toBe(0)
    expect(stream.messages.at(-1)).toEqual({ t: 'end', reason: 'shutdown' })
    expect(alive(h.iso.bin.pid('logcat'))).toBe(false)
    expect(alive(h.iso.bin.gpid('logcat'))).toBe(false)
    expect(h.out()).toContain('Stopping… (press Ctrl+C again to force)')
  })
  it('exits 130 on a second signal during shutdown', async () => {
    const h = await spawnHelper({}, [])
    const stream = await openStream(h.port, '/api/devices/55090DLAQ0026D/logs', {
      Authorization: `Bearer ${h.token}`,
    })
    if (!isStream(stream)) throw new Error(stream.text)
    await stream.waitFor((m: LogMsg) => m.t === 'hello')
    h.child.kill('SIGINT')
    await until(() => h.out().includes('Stopping…'), 3_000, 'the first signal')
    h.child.kill('SIGINT')
    expect(await h.exited).toBe(130)
    await until(
      () => !alive(h.iso.bin.pid('logcat')) && !alive(h.iso.bin.gpid('logcat')),
      3_000,
      'the exit hook to reap the tool group',
    )
  })
})
