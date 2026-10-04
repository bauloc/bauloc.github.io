/*
  The bundle's entry. The modules are imported in the order of the spec's sections (§1.2)
  because ESM evaluates imports in source order and the bundler lays the built file out in
  that order; the bare imports exist only to place a section. The guard comes first: it is
  the first code an old Node runs.
*/
import './guard'
import { NAME, VERSION } from './constants'
import { UsageError, helpText, parseCli, scriptHint, type CliOptions } from './cli'
import { sleep } from './util'
import './plist'
import './process'
import './tools'
import './usbmuxd'
import './lockdown'
import './ios-lane'
import './simulator-lane'
import './mdns'
import './android-lane'
import './registry'
import { TokenFileError } from './auth'
import { formatChecklist } from './preflight'
import { bugText } from './http'
import './local-mode'
import { createBridge, type Bridge } from './bridge'
import { bannerText, lanesReported, pairLinks } from './banner'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { adbCommand, type Toolbox } from './tools'
import type { BridgeInput, PreflightItem } from './types'

/*
  Its exports are the public surface of device-bridge.mjs: what the tests and the page's
  contract test import (§1.2). main() runs only when the file is executed directly.
*/
export { createBridge } from './bridge'
export {
  ADB_DETAIL,
  ADB_EXEC,
  EMITTED_BLOCKERS,
  ID,
  LOCKDOWN_REQUESTS,
  LOCKDOWN_SERVICES,
  NAME,
  PROTOCOL,
  VERSION,
} from './constants'
export { proofOf, tokenIdOf } from './auth'
/** The bridge answers only its own class with a code: helper-fake builds its errors from it. */
export { HelperError } from './util'
export { buildPlist, parsePlist } from './plist'
export { mapAdbState, parseDevicesL } from './android-lane'
export { classifyDevicectl, deriveIos, splitSyslogRelay } from './ios-lane'
export { which } from './tools'
export { liveChildren, runTool } from './process'
export { bootHtml } from './local-mode'
export { formatChecklist } from './preflight'

/** Everything main() touches outside itself, so tests can run it in-process. */
export interface MainEnv {
  readonly argv: readonly string[]
  /** process.argv[1]: how the tester ran this file, for the commands we print. */
  readonly scriptPath: string | undefined
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly isTTY: boolean
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly cwd: string
  readonly getuid: (() => number) | undefined
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) => void
  readonly exit: (code: number) => void
  readonly openUrl: (url: string) => void
  /** Bridge options for tests (fake paths and ports); never set from the command line. */
  readonly bridge?: BridgeInput
}

/** The real process. */
export function processEnv(): MainEnv {
  return {
    argv: process.argv.slice(2),
    scriptPath: process.argv[1],
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    isTTY: process.stdout.isTTY === true,
    platform: process.platform,
    home: os.homedir(),
    cwd: process.cwd(),
    getuid: process.getuid?.bind(process),
    onSignal: (signal, handler) => void process.on(signal, handler),
    exit: (code) => process.exit(code),
    openUrl(url) {
      /**
       * The link carries the token, so it goes to AppleScript's `open location` on stdin, not in
       * argv: any user on the Mac can read a process's arguments with `ps`, even for the moment
       * `/usr/bin/open` would live (threat T8). Detached and unref'd: the browser must not become
       * our child or hold our terminal.
       */
      const child = spawn('/usr/bin/osascript', ['-'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      })
      child.on('error', () => undefined)
      child.stdin.on('error', () => undefined)
      child.stdin.end(`open location ${JSON.stringify(url)}\n`)
      child.unref()
    },
  }
}

/** Terminal lines are held until the banner is out, so the banner always comes first. */
function heldLines(write: (text: string) => void): {
  line: (text: string) => void
  release: () => void
} {
  let held: string[] | null = []
  return {
    line(text) {
      if (held) held.push(text)
      else write(text + '\n')
    },
    release() {
      const lines = held ?? []
      held = null
      for (const text of lines) write(text + '\n')
    },
  }
}

/** What answers on `port`, when something does: our own helper, or another program. */
function probeHealth(
  port: number,
  timeoutMs: number,
): Promise<{ name?: unknown; version?: unknown } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 65_536) req.destroy()
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as { name?: unknown; version?: unknown })
          } catch {
            resolve(null)
          }
        })
        res.on('error', () => resolve(null))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

/** §1.10's two port messages: never switch ports silently (it is part of every pairing). */
export async function portInUseText(
  port: number,
  script: string,
  timeoutMs: number,
): Promise<string> {
  const health = await probeHealth(port, timeoutMs)
  if (health?.name === NAME && typeof health.version === 'string') {
    return `A Device Lab helper (${health.version}) is already running on port ${String(port)}. Use that window, or stop it with Ctrl+C there.\n`
  }
  const next = port === 65535 ? port - 1 : port + 1
  return `Port ${String(port)} is used by another program. Start the helper on another port:\n  node ${script} --port ${String(next)}\n`
}

function bridgeInputFrom(cli: CliOptions, env: MainEnv, log: (line: string) => void): BridgeInput {
  return {
    port: cli.port,
    open: cli.open,
    keepToken: cli.keepToken,
    newToken: cli.newToken,
    wifi: cli.wifi,
    simulators: cli.simulators,
    android: cli.android,
    local: cli.local,
    dev: cli.dev,
    verbose: cli.verbose,
    platform: env.platform,
    home: env.home,
    getuid: env.getuid,
    log,
    errorLog: (line) => env.stderr(line + '\n'),
    ...env.bridge,
  }
}

/** Waits for `work` at most `ms`; null when it did not finish (the banner prints "checking…"). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  const late = sleep(ms).then(() => null)
  return Promise.race([work.catch(() => null), late])
}

/** §1.7. Returns once the helper is serving, or after env.exit() was called. */
export async function main(env: MainEnv): Promise<void> {
  const script = scriptHint(env.scriptPath, env.home, env.cwd)
  let cli: CliOptions
  try {
    cli = parseCli(env.argv, script)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    env.stderr(error.message + '\n')
    return env.exit(64)
  }
  if (cli.help) {
    env.stdout(helpText(script))
    return env.exit(0)
  }
  if (cli.version) {
    env.stdout(VERSION + '\n')
    return env.exit(0)
  }
  if (env.getuid?.() === 0) {
    env.stderr(
      `Don't run the Device Lab helper with sudo; it never needs root. Run it as yourself: node ${script}\n`,
    )
    return env.exit(1)
  }

  const out = heldLines(env.stdout)
  let bridge: Bridge
  try {
    bridge = createBridge(bridgeInputFrom(cli, env, out.line))
  } catch (error) {
    if (!(error instanceof TokenFileError)) throw error
    env.stderr(error.message + '\n')
    return env.exit(1)
  }
  const { timeouts } = bridge.options

  if (cli.doctor) {
    await bridge.doctor((line) => env.stdout(line + '\n'))
    return env.exit(0)
  }

  try {
    await bridge.listen()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') env.stderr(await portInUseText(cli.port, script, timeouts.portProbe))
    else
      env.stderr(
        `The Device Lab helper could not listen on 127.0.0.1:${String(cli.port)}: ${bugText(error)}\n`,
      )
    await bridge.close()
    return env.exit(1)
  }

  let stopping = false
  const stop = (): void => {
    if (stopping) return env.exit(130)
    stopping = true
    out.release()
    env.stdout('\nStopping… (press Ctrl+C again to force)\n')
    bridge.close().then(
      () => {
        if (bridge.registry.lanes().android.startedByHelper) {
          const facts = bridge.lanes.android?.facts()
          const adb = facts?.adb ? { path: facts.adb, version: facts.version } : null
          const kill = `${adbCommand(adb, bridge.options.searchPath)} kill-server`
          env.stdout(
            `The adb server started from Device Lab is still running. Chrome's WebUSB can use Android phones again after: ${kill}\n`,
          )
        }
        env.exit(0)
      },
      (error: unknown) => {
        env.stderr(bugText(error) + '\n')
        env.exit(1)
      },
    )
  }
  env.onSignal('SIGINT', stop)
  env.onSignal('SIGTERM', stop)
  env.onSignal('SIGHUP', stop)

  const bannerBy = Date.now() + timeouts.banner
  const [items, toolbox] = await Promise.all([
    within<PreflightItem[]>(bridge.preflight(), timeouts.banner),
    within<Toolbox>(bridge.toolbox(), timeouts.banner),
  ])
  /**
   * A lane's first report prints no terminal line, so the banner is the only place the
   * tester learns "3 booted": give the lanes the rest of the same budget to report.
   */
  while (!stopping && !lanesReported(bridge.registry.lanes()) && Date.now() < bannerBy) {
    await sleep(50)
  }
  if (stopping) return
  const opening = env.platform === 'darwin' && env.isTTY && cli.open
  const lanes = bridge.registry.lanes()
  env.stdout(
    bannerText({
      version: VERSION,
      port: bridge.port,
      token: bridge.token,
      tokenId: bridge.tokenId,
      keepToken: cli.keepToken,
      dev: cli.dev,
      opening,
      script,
      platform: env.platform,
      lanes,
      androidDevices: bridge.registry.devices().filter((d) => d.platform === 'android').length,
      toolbox,
      checklist: items ? formatChecklist(items, { all: false }) : null,
    }) + '\n\n',
  )
  out.release()
  if (opening) env.openUrl(pairLinks(bridge.port, bridge.token).hosted)
}

/** True when this file is the one Node was asked to run (not imported by a test). */
export function isMain(
  scriptPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  try {
    return !!scriptPath && realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isMain()) {
  /**
   * A lane bug must not take the helper down mid-test; it is reported and the rest keeps working.
   */
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`Device Lab helper hit a bug: ${bugText(error)}\n`)
  })
  /** `node device-bridge.mjs | head` closes stdout early; that is not a reason to crash. */
  process.stdout.on('error', () => undefined)
  main(processEnv()).catch((error: unknown) => {
    process.stderr.write(`Device Lab helper hit a bug: ${bugText(error)}\n`)
    process.exit(1)
  })
}
