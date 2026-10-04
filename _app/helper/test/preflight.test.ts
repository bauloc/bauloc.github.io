/*
  §12e, helper half: every missing-tool path, each on a fresh fake Mac whose PATH holds only
  the fakes the scenario lists (fakes/mac.ts). Each test asserts the items exactly
  ({status, sentence, fixes}) and that nothing forbidden ran: no Xcode wrapper, no
  `-runFirstLaunch`, no xcrun, no /usr/bin/python3 or /usr/bin/java, and no adb but
  `adb version`. Every tool run goes through a recording runTool, and every fake logs itself
  to calls.log, so "never ran" is checked twice.
*/
import net from 'node:net'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBridge, resolveOptions } from '../src/bridge'
import type { IosLaneFacts } from '../src/ios-lane'
import { collectPreflight, doctorReport, formatChecklist } from '../src/preflight'
import { childEnv, runTool, type RunOptions, type RunTool } from '../src/process'
import { initialLanes } from '../src/registry'
import { resolveTools, shellQuote, toolOptionsFrom } from '../src/tools'
import type {
  BridgeInput,
  DoctorReport,
  Lane,
  PreflightContext,
  PreflightFix,
  PreflightItem,
} from '../src/types'
import { encodeMuxFrame, MUX_HEADER } from '../src/usbmuxd'
import { createFakeAdbServer, pixel } from './fakes/adb-server'
import { fakeMac, type FakeMac } from './fakes/mac'
import { freePort, onCleanup, request, startBridge, tempDir } from './harness'

/* ------------------------------------------------------------------- plumbing --- */

interface Run {
  items: PreflightItem[]
  /** Every tool the checks started: [file, ...argv]. */
  ran: string[][]
  refreshed: number
  byId: (id: string) => PreflightItem | undefined
  /** {status, sentence, fixes} of one item, what the scenarios assert. */
  shape: (id: string) => Pick<PreflightItem, 'status' | 'sentence' | 'fixes'> | undefined
}

type Extra = BridgeInput & { iosFacts?: IosLaneFacts }

/** A PreflightContext on `mac`, with a recording runTool and no bridge around it. */
function contextOf(mac: FakeMac, extra: Extra = {}) {
  const { iosFacts, ...input } = extra
  const options = resolveOptions({
    platform: 'darwin',
    nodeVersion: '24.12.0',
    opensslVersion: '3.6.1',
    tunneldPort: 1,
    ...mac.input,
    ...input,
    timeouts: { ...mac.input.timeouts, ...input.timeouts },
  })
  const cwd = tempDir('preflight-cwd-')
  const ran: string[][] = []
  const recording = ((file: string, argv: readonly string[], opts: RunOptions = {}) => {
    ran.push([file, ...argv])
    return runTool(file, argv, { cwd, env: childEnv({}, options.env), ...opts })
  }) as RunTool
  const toolOptions = toolOptionsFrom(options, recording)
  let refreshed = 0
  const lanes = iosFacts
    ? { ios: { name: 'ios', facts: () => iosFacts } as unknown as Lane<IosLaneFacts> }
    : {}
  const ctx: PreflightContext = {
    options,
    tools: {
      get: () => resolveTools(toolOptions),
      refresh: () => {
        refreshed++
        return resolveTools(toolOptions)
      },
    },
    lanes,
    lanesState: () =>
      initialLanes({ platform: options.platform, wifi: false, android: true, simulators: false }),
    devices: () => [],
    runTool: recording,
    timeouts: options.timeouts,
    workDir: cwd,
    signal: new AbortController().signal,
    now: Date.now,
    about: () => ({
      name: 'bauloc-device-bridge',
      version: '1.1.0',
      protocol: 1,
      node: options.nodeVersion,
      openssl: options.opensslVersion,
      platform: options.platform,
      arch: 'arm64',
      port: 0,
      startedAt: 0,
      local: true,
      tokenPersistent: false,
      flags: [],
      sha256: '',
    }),
  }
  return { ctx, ran, refreshedCount: () => refreshed }
}

async function check(mac: FakeMac, extra: Extra = {}, refresh = false): Promise<Run> {
  const { ctx, ran, refreshedCount } = contextOf(mac, extra)
  const items = await collectPreflight(ctx, { refresh })
  const byId = (id: string) => items.find((i) => i.id === id)
  return {
    items,
    ran,
    refreshed: refreshedCount(),
    byId,
    shape(id) {
      const i = byId(id)
      return i && { status: i.status, sentence: i.sentence, fixes: i.fixes }
    },
  }
}

/** A Mac with Node and macOS 27.0.1 and nothing else: scenario 1's starting point. */
async function bareMac(input: BridgeInput = {}): Promise<FakeMac> {
  const mac = await fakeMac(input)
  mac.macos('27.0.1')
  mac.xcodeSelect(null)
  return mac
}

/** Never ran: Xcode's wrappers, first launch, Apple's shims, any adb but `adb version`. */
function assertNothingForbidden(run: Run, mac: FakeMac): void {
  for (const [file = '', ...argv] of run.ran) {
    expect(path.dirname(file), `${file} must never run`).not.toBe('/usr/bin')
    expect(path.basename(file)).not.toBe('xcrun')
    expect(argv).not.toContain('-runFirstLaunch')
  }
  const calls = mac.bin.calls()
  expect(calls.map((c) => c.name)).not.toContain('devicectl-wrapper')
  expect(calls.map((c) => c.name)).not.toContain('simctl-wrapper')
  expect(calls.filter((c) => c.argv.includes('-runFirstLaunch'))).toEqual([])
  for (const [file = '', ...argv] of run.ran) {
    if (path.basename(file) === 'adb') expect(argv).toEqual(['version'])
  }
}

const BREW_FIRST: PreflightFix = {
  kind: 'link',
  href: 'https://brew.sh',
  label: 'Install Homebrew first',
}
const APP_STORE: PreflightFix = {
  kind: 'link',
  href: 'https://apps.apple.com/app/xcode/id497799835',
  label: 'Get Xcode from the App Store',
}
const FIRST_LAUNCH: PreflightFix[] = [
  { kind: 'step', text: 'Open Xcode once and let it finish.' },
  { kind: 'command', command: 'sudo xcodebuild -runFirstLaunch' },
]
const command = (text: string): PreflightFix => ({ kind: 'command', command: text })

/* ---------------------------------------------------------------- 1. bare Mac --- */

describe('1. a bare Mac: only Node', () => {
  it('words every missing tool, with brew.sh before each brew fix', async () => {
    const mac = await bareMac()
    const run = await check(mac)
    expect(run.items.map((i) => i.id)).toEqual([
      'mac.node',
      'mac.os',
      'ios.usbmuxd',
      'ios.xcode',
      'ios.libimobiledevice',
      'ios.pymobiledevice3',
      'android.adb',
      'android.adb-server',
      'android.wifi',
      'android.bundletool',
    ])
    expect(run.shape('mac.node')).toEqual({
      status: 'ok',
      sentence: 'Node 24.12.0 runs the helper.',
      fixes: [],
    })
    expect(run.byId('mac.os')).toMatchObject({ label: 'macOS 27.0.1', status: 'ok' })
    expect(run.shape('ios.usbmuxd')).toEqual({
      status: 'blocking',
      sentence: "macOS's iPhone service (usbmuxd) isn't answering.",
      fixes: [
        {
          kind: 'step',
          text: 'Unplug the iPhone and plug it back in. If this stays red, restart the Mac.',
        },
      ],
    })
    expect(run.shape('ios.xcode')).toEqual({
      status: 'warning',
      sentence:
        "Xcode isn't installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.",
      fixes: [APP_STORE],
    })
    expect(run.byId('ios.xcode')?.label).toBe('Xcode')
    expect(run.shape('ios.libimobiledevice')).toEqual({
      status: 'warning',
      sentence:
        "Not installed. Only needed for screenshots of iOS 16 and older, or when the helper can't open an iPhone's secure session.",
      fixes: [BREW_FIRST, command('brew install libimobiledevice')],
    })
    expect(run.shape('ios.pymobiledevice3')).toEqual({
      status: 'warning',
      sentence: 'Not installed. Only needed for the optional root tunnel (a later helper version).',
      fixes: [
        {
          kind: 'link',
          href: 'https://www.python.org/downloads/macos/',
          label: 'Get Python from python.org',
        },
      ],
    })
    expect(run.shape('android.adb')).toEqual({
      status: 'warning',
      sentence:
        "adb isn't installed. Chrome and Edge don't need it; Safari and Firefox reach Android only through it.",
      fixes: [BREW_FIRST, command('brew install --cask android-platform-tools')],
    })
    expect(run.shape('android.adb-server')).toEqual({
      status: 'ok',
      sentence:
        "Google's adb server isn't running, so Chrome's WebUSB can use Android phones directly.",
      // No adb: Start adb server would only fail.
      fixes: [],
    })
    expect(run.shape('android.bundletool')).toEqual({
      status: 'warning',
      sentence: 'Not installed. Only needed to install .aab bundles (a later helper version).',
      fixes: [BREW_FIRST, command('brew install bundletool')],
    })
    expect(run.shape('android.wifi')).toEqual({
      status: 'warning',
      sentence:
        "Android TVs and phones on Wi-Fi go through Google's adb server, and adb isn't installed.",
      fixes: [BREW_FIRST, command('brew install --cask android-platform-tools')],
    })
    for (const id of [
      'ios.libimobiledevice',
      'ios.pymobiledevice3',
      'android.wifi',
      'android.bundletool',
    ]) {
      expect(run.byId(id)?.optional).toBe(true)
    }
    expect(run.byId('ios.xcode')?.optional).toBeUndefined()
    assertNothingForbidden(run, mac)
  })

  it('drops the brew.sh link once Homebrew is there', async () => {
    const mac = await bareMac()
    mac.brew()
    const run = await check(mac)
    expect(run.shape('android.adb')?.fixes).toEqual([
      command('brew install --cask android-platform-tools'),
    ])
    expect(run.shape('ios.libimobiledevice')?.fixes).toEqual([
      command('brew install libimobiledevice'),
    ])
  })

  it('Homebrew found only in its own folder, off PATH: its shellenv line comes first', async () => {
    const mac = await bareMac()
    /** A fresh Apple-silicon install whose "Next steps" were skipped: /opt/homebrew/bin. */
    const brewBin = path.join(mac.root, 'homebrew/bin')
    const brew = mac.bin.file(path.join(brewBin, 'brew'), 'exit 0', 'brew')
    mac.brewPython(mac.bin.dir)
    const run = await check(mac, { extraDirs: [brewBin] })
    const shellenv: PreflightFix = {
      kind: 'command',
      command: `eval "$(${brew} shellenv)"`,
      note: "Homebrew is installed but not on this terminal's PATH yet; this adds it",
    }
    expect(run.shape('android.adb')?.fixes).toEqual([
      shellenv,
      command('brew install --cask android-platform-tools'),
    ])
    /** pipx, which Homebrew installs next to itself, is reached the same way. */
    expect(run.shape('ios.pymobiledevice3')?.fixes).toEqual([
      shellenv,
      command('brew install pipx && pipx install pymobiledevice3'),
    ])
    /** On PATH, the bare command alone, as before. */
    const onPath = await check(mac, { extraDirs: [], searchPath: `${mac.bin.dir}:${brewBin}` })
    expect(onPath.shape('android.adb')?.fixes).toEqual([
      command('brew install --cask android-platform-tools'),
    ])
  })

  it('every item has the wire shape of §12c', async () => {
    const run = await check(await bareMac())
    for (const i of run.items) {
      expect(['mac', 'ios', 'android']).toContain(i.group)
      expect(['ok', 'warning', 'blocking', 'unchecked']).toContain(i.status)
      expect(i.label.length).toBeGreaterThan(0)
      expect(i.sentence).toMatch(/[.!]$/)
      expect(Array.isArray(i.neededFor)).toBe(true)
    }
  })
})

/* ----------------------------------------------------------------- 2–9. Xcode --- */

describe('2–9. Xcode', () => {
  it('2. Command Line Tools only → not installed', async () => {
    const mac = await bareMac()
    mac.xcodeSelect('/Library/Developer/CommandLineTools')
    const run = await check(mac)
    expect(run.shape('ios.xcode')).toMatchObject({ status: 'warning', fixes: [APP_STORE] })
    expect(run.shape('ios.xcode')?.sentence).toMatch(/^Xcode isn't installed/)
    assertNothingForbidden(run, mac)
  })

  it('3. Xcode installed, Command Line Tools selected → the exact xcode-select command', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect('/Library/Developer/CommandLineTools')
    const run = await check(mac)
    expect(run.shape('ios.xcode')).toEqual({
      status: 'warning',
      sentence:
        'Xcode is installed, but the Command Line Tools are selected, so screenshots are off.',
      fixes: [command(`sudo xcode-select -s ${devDir}`)],
    })
    expect(run.byId('ios.xcode')?.label).toBe('Xcode 27.0')
    assertNothingForbidden(run, mac)
  })

  it('3b. prefers Xcode.app, then the highest version, and quotes a path with spaces', async () => {
    const mac = await bareMac()
    mac.xcode({ name: 'Xcode 26.app', version: '26.3' })
    const newest = mac.xcode({ name: 'Xcode-beta 2.app', version: '27.1' })
    mac.xcodeSelect('/Library/Developer/CommandLineTools')
    const run = await check(mac)
    expect(run.shape('ios.xcode')?.fixes).toEqual([
      command(`sudo xcode-select -s '${newest.devDir}'`),
    ])
    const main = mac.xcode({ name: 'Xcode.app', version: '26.0' })
    const again = await check(mac)
    expect(again.shape('ios.xcode')?.fixes).toEqual([
      command(`sudo xcode-select -s ${main.devDir}`),
    ])
  })

  it('4. first launch pending: never runs the wrapper, the real devicectl or -runFirstLaunch', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    mac.coreDevice('641.0')
    const run = await check(mac)
    expect(run.shape('ios.xcode')).toEqual({
      status: 'warning',
      sentence: "Xcode hasn't finished installing its components, so screenshots are off.",
      fixes: FIRST_LAUNCH,
    })
    expect(run.byId('ios.xcode')?.detail).toBe(
      `devicectl needs CoreDevice 642.16, found 641.0 · ${devDir}`,
    )
    const files = run.ran.map((r) => path.basename(r[0] ?? ''))
    expect(files).not.toContain('devicectl')
    expect(files).not.toContain('xcodebuild')
    expect(files).toContain('PlistBuddy')
    assertNothingForbidden(run, mac)
  })

  it('5. PlistBuddy fails (no Info.plist) → first launch, as the wrapper decides', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    mac.coreDevice(null)
    const run = await check(mac)
    expect(run.shape('ios.xcode')?.sentence).toBe(
      "Xcode hasn't finished installing its components, so screenshots are off.",
    )
    assertNothingForbidden(run, mac)
  })

  it('6. license not accepted → a warning, but screenshots stay ready', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode({ license: 69 })
    mac.xcodeSelect(devDir)
    const { ctx } = contextOf(mac)
    expect((await ctx.tools.get()).xcode).toMatchObject({ state: 'ready', license: false })
    const run = await check(mac)
    expect(run.shape('ios.xcode')).toEqual({
      status: 'warning',
      sentence: "Xcode's license hasn't been accepted, which can stop its tools.",
      fixes: [command('sudo xcodebuild -license accept')],
    })
    assertNothingForbidden(run, mac)
  })

  it('7. no capture subcommand (devicectl -h exits 64) → no-capture', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode({ capture: 64 })
    mac.xcodeSelect(devDir)
    const run = await check(mac)
    expect(run.shape('ios.xcode')).toEqual({
      status: 'warning',
      sentence: "This Xcode's devicectl has no screenshot command; update Xcode.",
      fixes: [APP_STORE],
    })
    assertNothingForbidden(run, mac)
  })

  it('8. all ready, and DEVELOPER_DIR wins over xcode-select', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect('/Library/Developer/CommandLineTools')
    const run = await check(mac, { env: { ...mac.input.env, DEVELOPER_DIR: devDir } })
    expect(run.shape('ios.xcode')).toEqual({
      status: 'ok',
      sentence: "Screenshots of iOS 17 and newer work through Xcode's devicectl.",
      fixes: [],
    })
    expect(run.byId('ios.xcode')).toMatchObject({
      label: 'Xcode 27.0',
      detail: `devicectl 642.16 · ${devDir}`,
    })
    /** The capture probe ran on the REAL binary, with DEVELOPER_DIR set. */
    const probe = run.ran.find((r) => r.includes('capture'))
    expect(probe?.[0]).toBe(
      path.join(mac.input.coreDeviceDir ?? '', 'Versions/A/Resources/bin/devicectl'),
    )
    expect(probe?.slice(1)).toEqual(['device', 'capture', 'screenshot', '-h'])
    expect(run.ran.map((r) => r[0])).not.toContain(mac.input.xcodeSelectPath)
    assertNothingForbidden(run, mac)
  })

  it('9. older Xcode: devicectl is the binary itself, so no gate and the probe runs it', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode({ devicectl: 'binary', version: '16.4' })
    mac.xcodeSelect(devDir)
    mac.coreDevice(null)
    const run = await check(mac)
    expect(run.byId('ios.xcode')).toMatchObject({ status: 'ok', label: 'Xcode 16.4' })
    expect(run.ran).toContainEqual([
      path.join(devDir, 'usr/bin/devicectl'),
      'device',
      'capture',
      'screenshot',
      '-h',
    ])
    expect(run.ran.filter((r) => r.some((a) => a.includes('CoreDevice.framework')))).toEqual([])
    assertNothingForbidden(run, mac)
  })

  it('9b. an Xcode older than devicectl is selected → no-capture, not "not installed"', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode({ devicectl: 'none', version: '14.3' })
    mac.xcodeSelect(devDir)
    const run = await check(mac)
    expect(run.byId('ios.xcode')).toMatchObject({ status: 'warning', label: 'Xcode 14.3' })
    expect(run.shape('ios.xcode')?.sentence).toMatch(/has no screenshot command/)
  })
})

/* --------------------------------------------------------- 10. libimobiledevice --- */

describe('10. libimobiledevice', () => {
  it('present: ok, with the version from ideviceinfo --version', async () => {
    const mac = await bareMac()
    mac.bin.simple('ideviceinfo', { stdout: 'ideviceinfo 1.4.0\n' })
    mac.bin.simple('idevicesyslog')
    mac.bin.simple('idevicescreenshot')
    const run = await check(mac)
    expect(run.byId('ios.libimobiledevice')).toMatchObject({
      label: 'libimobiledevice 1.4.0',
      status: 'ok',
      sentence: 'Installed: a fallback for details and logs, and screenshots of iOS 16 and older.',
      fixes: [],
      detail: `ideviceinfo, idevicesyslog, idevicescreenshot in ${mac.bin.dir}`,
      optional: true,
    })
    expect(run.ran).toContainEqual([path.join(mac.bin.dir, 'ideviceinfo'), '--version'])
  })
})

/* ---------------------------------------------------------- 11–12. pymobiledevice3 --- */

describe('11–12. pymobiledevice3', () => {
  it('a script with an absolute shebang runs through that Python', async () => {
    const mac = await bareMac()
    const python = mac.python(path.join(mac.root, 'py/bin/python3.9'))
    const script = mac.pymobiledevice3(python)
    const run = await check(mac)
    expect(run.byId('ios.pymobiledevice3')).toMatchObject({
      label: 'pymobiledevice3 9.8.1',
      status: 'ok',
      sentence: `Installed in Python 3.9.6 (${python}). Used only by the optional root tunnel, in a later helper version.`,
      detail: 'root tunnel: not running',
    })
    expect(run.ran).toContainEqual([python, script, 'version'])
    expect(run.ran.filter((r) => r[0] === script)).toEqual([])
    assertNothingForbidden(run, mac)
  })

  it('#!/usr/bin/env python3 resolves python3 itself, skipping Apple’s shim', async () => {
    const mac = await bareMac({ searchPath: undefined })
    const python = mac.python(path.join(mac.bin.dir, 'python3'))
    mac.pymobiledevice3('/usr/bin/env python3')
    const run = await check(mac, { searchPath: `/usr/bin${path.delimiter}${mac.bin.dir}` })
    expect(run.byId('ios.pymobiledevice3')?.sentence).toBe(
      `Installed in Python 3.9.6 (${python}). Used only by the optional root tunnel, in a later helper version.`,
    )
    assertNothingForbidden(run, mac)
  })

  it('a script bound to /usr/bin/python3 is never started', async () => {
    const mac = await bareMac()
    mac.pymobiledevice3('/usr/bin/python3')
    const run = await check(mac)
    expect(run.byId('ios.pymobiledevice3')).toMatchObject({
      status: 'unchecked',
      sentence:
        "Installed for Apple's /usr/bin/python3, which the helper never starts, so it wasn't checked.",
    })
    expect(
      run.ran.filter((r) => r[0]?.includes('pymobiledevice3') || r[0]?.includes('python')),
    ).toEqual([])
    assertNothingForbidden(run, mac)
  })

  it('#!/usr/bin/env python3 with only Apple’s python3 on PATH is never started either', async () => {
    const mac = await bareMac()
    mac.pymobiledevice3('/usr/bin/env python3')
    const run = await check(mac, { searchPath: `/usr/bin${path.delimiter}${mac.bin.dir}` })
    expect(run.shape('ios.pymobiledevice3')?.status).toBe('unchecked')
    assertNothingForbidden(run, mac)
  })

  it('missing, python.org-style Python found → pip; never runs that Python', async () => {
    const mac = await bareMac()
    mac.python(path.join(mac.bin.dir, 'python3'))
    const run = await check(mac)
    expect(run.shape('ios.pymobiledevice3')?.fixes).toEqual([
      command('python3 -m pip install -U pymobiledevice3'),
    ])
    expect(run.ran.filter((r) => path.basename(r[0] ?? '') === 'python3')).toEqual([])
  })

  it('missing, Homebrew Python (PEP 668) → pipx, with brew.sh only when brew is gone', async () => {
    const mac = await bareMac()
    mac.brewPython(mac.bin.dir)
    mac.brew()
    const run = await check(mac)
    expect(run.shape('ios.pymobiledevice3')?.fixes).toEqual([
      command('brew install pipx && pipx install pymobiledevice3'),
    ])
  })

  it('missing, Apple’s python3 only → the python.org link (the shim is not a Python)', async () => {
    const mac = await bareMac()
    const run = await check(mac, { searchPath: `/usr/bin${path.delimiter}${mac.bin.dir}` })
    expect(run.shape('ios.pymobiledevice3')?.fixes).toEqual([
      {
        kind: 'link',
        href: 'https://www.python.org/downloads/macos/',
        label: 'Get Python from python.org',
      },
    ])
    assertNothingForbidden(run, mac)
  })

  it('12. `pymobiledevice3 version` hangs → that item alone says "Check timed out."', async () => {
    const mac = await bareMac()
    const python = mac.python(path.join(mac.root, 'py/bin/python3.9'), { hang: true })
    mac.pymobiledevice3(python)
    const started = Date.now()
    const run = await check(mac, { timeouts: { doctorSlowCheck: 1_200 } })
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(run.byId('ios.pymobiledevice3')).toMatchObject({
      label: 'pymobiledevice3',
      status: 'unchecked',
      sentence: 'Check timed out.',
      fixes: [],
      optional: true,
    })
    expect(run.byId('mac.node')?.status).toBe('ok')
  })

  it('the whole collection stops waiting at doctorTotal', async () => {
    const mac = await bareMac()
    const python = mac.python(path.join(mac.root, 'py/bin/python3.9'), { hang: true })
    mac.pymobiledevice3(python)
    const started = Date.now()
    const run = await check(mac, { timeouts: { doctorSlowCheck: 20_000, doctorTotal: 1_500 } })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(run.shape('ios.pymobiledevice3')).toEqual({
      status: 'unchecked',
      sentence: 'Check timed out.',
      fixes: [],
    })
  })
})

/* -------------------------------------------------------------- 13–15. Android --- */

describe('13–15. adb and its server', () => {
  it('13. adb only in ~/Library/Android/sdk/platform-tools is found', async () => {
    const mac = await bareMac()
    const sdk = path.join(mac.home, 'Library/Android/sdk/platform-tools')
    const adb = mac.bin.file(
      path.join(sdk, 'adb'),
      'printf "Android Debug Bridge version 1.0.41\\nVersion 36.0.0-13206524\\n"',
      'adb',
    )
    const run = await check(mac, { extraDirs: [sdk], adbPort: await freePort() })
    expect(run.byId('android.adb')).toMatchObject({
      label: 'adb 36.0.0',
      status: 'ok',
      sentence: `Google's adb is installed (${adb}).`,
      fixes: [],
    })
    /** Not on the terminal's PATH: a bare `adb` there is "command not found". */
    const full = shellQuote(adb)
    expect(run.byId('android.wifi')?.fixes).toEqual([
      { kind: 'action', action: 'start-adb', label: 'Start adb server' },
      {
        kind: 'command',
        command: `${full} start-server`,
        note: `while it runs, Chrome's WebUSB can't use Android phones on a cable; ${full} kill-server gives them back`,
      },
    ])
  })

  it('14. adb present: argv is exactly ["version"]; nothing that could start a server', async () => {
    const mac = await bareMac()
    mac.bin.simple('adb', {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n',
    })
    const run = await check(mac)
    expect(run.ran.filter((r) => r[0]?.endsWith('/adb'))).toEqual([
      [path.join(mac.bin.dir, 'adb'), 'version'],
    ])
    assertNothingForbidden(run, mac)
  })

  it('15. a running server with 2 phones: ok, the phones named, rows in the detail', async () => {
    const server = await createFakeAdbServer()
    onCleanup(() => server.close())
    server.setDevices([
      pixel(),
      {
        serial: '1A2B3C4D',
        state: 'unauthorized',
        props: ' usb:1-2 transport_id:4',
      },
    ])
    const mac = await bareMac()
    const run = await check(mac, { adbPort: server.port })
    expect(run.byId('android.adb-server')).toMatchObject({
      label: 'adb server',
      status: 'ok',
      sentence:
        "Google's adb server is running and holds 2 phones (Pixel 9, 1A2B3C4D); the helper shares it.",
      fixes: [],
      detail: 'protocol 41 · 55090DLAQ0026D:device · 1A2B3C4D:unauthorized',
    })
    /** Only the two read-only host services, never a transport or a kill, and asked once. */
    expect([...new Set(server.services)].sort()).toEqual(['host:devices-l', 'host:version'])
    expect(server.services.filter((s) => s === 'host:version')).toHaveLength(1)
    /** No Wi-Fi device yet: the Wi-Fi row is ready, with nothing to list. */
    expect(run.byId('android.wifi')).toMatchObject({
      label: 'Wi-Fi devices',
      status: 'ok',
      sentence: "Google's adb server is running: connect a TV or phone by its address.",
      fixes: [],
      neededFor: ['android.wifi'],
      optional: true,
    })
    expect(run.byId('android.wifi')?.detail).toBeUndefined()
  })

  it('Wi-Fi devices: the server lists them in the detail; without a server, how to start one', async () => {
    const server = await createFakeAdbServer()
    onCleanup(() => server.close())
    server.setDevices([
      pixel(),
      {
        serial: '192.168.1.20:5555',
        state: 'device',
        props: ' product:mdarcy model:SHIELD_Android_TV device:mdarcy transport_id:7',
      },
      { serial: 'adb-R5CT1-AbCdEf._adb-tls-connect._tcp', state: 'unauthorized', props: '' },
    ])
    const mac = await bareMac()
    mac.brew()
    mac.bin.simple('adb', {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n',
    })
    const running = await check(mac, { adbPort: server.port })
    expect(running.byId('android.wifi')).toMatchObject({
      status: 'ok',
      detail: '192.168.1.20:5555:device · adb-R5CT1-AbCdEf._adb-tls-connect._tcp:unauthorized',
    })
    await server.close()
    const stopped = await check(mac, { adbPort: server.port })
    expect(stopped.shape('android.wifi')).toEqual({
      status: 'warning',
      sentence:
        "Android TVs and phones on Wi-Fi go through Google's adb server, which isn't running.",
      fixes: [
        { kind: 'action', action: 'start-adb', label: 'Start adb server' },
        {
          kind: 'command',
          command: 'adb start-server',
          note: "while it runs, Chrome's WebUSB can't use Android phones on a cable; adb kill-server gives them back",
        },
      ],
    })
    /** Nothing was started: the doctor and the checklist only ever look. */
    expect(mac.bin.calls().filter((c) => c.name === 'adb' && c.argv[0] !== 'version')).toEqual([])
  })

  it('something on the port that never answers, or not as adb, is stuck: not "not running", no Start', async () => {
    const server = await createFakeAdbServer()
    onCleanup(() => server.close())
    server.hang.add('host:version')
    const mac = await bareMac()
    const adb = mac.bin.simple('adb', {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n',
    })
    const lsof = (port: number): PreflightFix => ({
      kind: 'command',
      command: `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
      note: 'shows what holds the port; quit that app',
    })
    const stuck = (port: number, fixes: PreflightFix[]) => ({
      status: 'warning',
      sentence: `Something on 127.0.0.1:${String(port)} isn't answering like Google's adb server, usually an adb server that got stuck.`,
      fixes,
    })
    const hung = await check(mac, { adbPort: server.port, timeouts: { adbRequest: 300 } })
    const fixes = [command(`${adb} kill-server`), lsof(server.port)]
    expect(hung.shape('android.adb-server')).toEqual(stuck(server.port, fixes))
    expect(hung.byId('android.adb-server')?.detail).toBeTruthy()
    expect(hung.shape('android.wifi')).toEqual(stuck(server.port, fixes))
    assertNothingForbidden(hung, mac)

    /** A web server on the port, and no adb to stop anything with: only the lsof line. */
    const web = net.createServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
    onCleanup(() => {
      web.close()
    })
    const port = (web.address() as net.AddressInfo).port
    const other = await check(await bareMac(), { adbPort: port })
    expect(other.shape('android.adb-server')).toEqual(stuck(port, [lsof(port)]))
    expect(other.shape('android.wifi')).toEqual(stuck(port, [lsof(port)]))
  })

  it('--no-android never connects to the server', async () => {
    const server = await createFakeAdbServer()
    onCleanup(() => server.close())
    const mac = await bareMac()
    const run = await check(mac, { adbPort: server.port, android: false })
    expect(run.shape('android.adb-server')).toEqual({
      status: 'unchecked',
      sentence: 'Not checked: the helper was started with --no-android.',
      fixes: [],
    })
    expect(run.shape('android.wifi')).toEqual({
      status: 'unchecked',
      sentence: 'Not checked: the helper was started with --no-android.',
      fixes: [],
    })
    expect(server.services).toEqual([])
  })
})

/* ------------------------------------------------------------ 16–18. bundletool --- */

describe('16–18. bundletool and Java', () => {
  const bundletool = (mac: FakeMac): string =>
    mac.bin.tool(
      'bundletool',
      `echo "$JAVA_HOME" > "$FAKE_STATE/bundletool.java"
"$JAVA_HOME/bin/java" -version 2>/dev/null || exit 1
echo 1.18.3`,
    )

  it('16. java_home exits 1, no JAVA_HOME, no bundletool: optional warning, /usr/bin/java never run', async () => {
    const mac = await bareMac({ searchPath: undefined })
    mac.javaHome(null)
    const run = await check(mac, { searchPath: `/usr/bin${path.delimiter}${mac.bin.dir}` })
    expect(run.shape('android.bundletool')).toEqual({
      status: 'warning',
      sentence: 'Not installed. Only needed to install .aab bundles (a later helper version).',
      fixes: [BREW_FIRST, command('brew install bundletool')],
    })
    expect(run.byId('android.bundletool')?.optional).toBe(true)
    assertNothingForbidden(run, mac)
  })

  it('17. bundletool and Java OK → "bundletool 1.18.3", "Installed (Java 21.0.11)…"', async () => {
    const mac = await bareMac()
    const home = mac.jdk(path.join(mac.root, 'jbr/Contents/Home'))
    mac.javaHome(home)
    bundletool(mac)
    const run = await check(mac)
    expect(run.byId('android.bundletool')).toMatchObject({
      label: 'bundletool 1.18.3',
      status: 'ok',
      sentence: 'Installed (Java 21.0.11). A later helper version uses it to install .aab bundles.',
      fixes: [],
    })
    expect(run.ran).toContainEqual([mac.input.javaHomePath])
  })

  it('17b. JAVA_HOME wins, and bundletool gets the Java that was checked', async () => {
    const mac = await bareMac()
    const home = mac.jdk(path.join(mac.root, 'jdk17/Contents/Home'), '17.0.9')
    mac.javaHome(mac.jdk(path.join(mac.root, 'jbr/Contents/Home')))
    bundletool(mac)
    const run = await check(mac, { env: { ...mac.input.env, JAVA_HOME: home } })
    expect(run.shape('android.bundletool')?.sentence).toMatch(/^Installed \(Java 17\.0\.9\)/)
    expect(run.ran.map((r) => r[0])).not.toContain(mac.input.javaHomePath)
  })

  it('17c. without java_home, Android Studio’s JBR, then Homebrew’s openjdk', async () => {
    const mac = await bareMac()
    mac.javaHome(null)
    bundletool(mac)
    mac.brew()
    mac.jdk(path.join(mac.root, 'opt/openjdk/libexec/openjdk.jdk/Contents/Home'), '25.0.1')
    expect((await check(mac)).byId('android.bundletool')?.sentence).toMatch(/Java 25\.0\.1/)
    mac.jdk(
      path.join(mac.input.applicationsDir ?? '', 'Android Studio.app/Contents/jbr/Contents/Home'),
      '21.0.8',
    )
    expect((await check(mac)).byId('android.bundletool')?.sentence).toMatch(/Java 21\.0\.8/)
  })

  it('18. bundletool present, no Java → "can\'t start Java" + brew install openjdk', async () => {
    const mac = await bareMac()
    mac.javaHome(null)
    bundletool(mac)
    const run = await check(mac)
    expect(run.shape('android.bundletool')).toEqual({
      status: 'warning',
      sentence: "bundletool is installed but can't start Java.",
      fixes: [BREW_FIRST, command('brew install openjdk')],
    })
    /** Without a Java to hand it, bundletool is not started at all. */
    expect(run.ran.filter((r) => path.basename(r[0] ?? '') === 'bundletool')).toEqual([])
    assertNothingForbidden(run, mac)
  })

  it('18b. a JAVA_HOME pointing at /usr is refused without running /usr/bin/java', async () => {
    const mac = await bareMac()
    bundletool(mac)
    const run = await check(mac, { env: { ...mac.input.env, JAVA_HOME: '/usr' } })
    expect(run.shape('android.bundletool')?.sentence).toBe(
      "bundletool is installed, but JAVA_HOME points at a Java that doesn't run.",
    )
    assertNothingForbidden(run, mac)
  })

  it('18c. JAVA_HOME names a Java that is gone: clear it, not "brew install openjdk"', async () => {
    const mac = await bareMac()
    mac.brew()
    /** Another Java is there, and openjdk too: neither helps while JAVA_HOME wins. */
    mac.javaHome(mac.jdk(path.join(mac.root, 'jbr/Contents/Home')))
    const file = bundletool(mac)
    const gone = path.join(mac.root, 'jdk-17.jdk/Contents/Home')
    const run = await check(mac, { env: { ...mac.input.env, JAVA_HOME: gone } })
    expect(run.shape('android.bundletool')).toEqual({
      status: 'warning',
      sentence: "bundletool is installed, but JAVA_HOME points at a Java that doesn't run.",
      fixes: [
        {
          kind: 'step',
          text: 'Stop the helper (Ctrl+C) and, in the same window, clear JAVA_HOME:',
        },
        {
          kind: 'command',
          command: 'unset JAVA_HOME',
          note: 'delete the JAVA_HOME line in ~/.zshrc too, or a new window sets it again',
        },
        { kind: 'step', text: 'Start the helper again from that window.' },
      ],
    })
    expect(run.byId('android.bundletool')?.detail).toBe(`${file} · JAVA_HOME=${gone}`)
    assertNothingForbidden(run, mac)
  })
})

/* ------------------------------------------------------------ 19–20. Node, OS --- */

describe('19–20. Node and the operating system', () => {
  it.each([
    ['18.20.4', 'warning', 'Node 18.20.4 works, but it no longer gets security updates.'],
    ['20.19.6', 'warning', 'Node 20.19.6 works, but it no longer gets security updates.'],
    ['24.12.0', 'ok', 'Node 24.12.0 runs the helper.'],
  ])('19. Node %s → %s', async (nodeVersion, status, sentence) => {
    const run = await check(await bareMac(), { nodeVersion })
    expect(run.byId('mac.node')).toMatchObject({ label: `Node ${nodeVersion}`, status, sentence })
    expect(run.byId('mac.node')?.fixes).toEqual(
      status === 'ok'
        ? []
        : [
            {
              kind: 'link',
              href: 'https://nodejs.org/en/download',
              label: 'Get the current Node LTS',
            },
          ],
    )
  })

  it('20. linux: mac.os blocking, no iOS items, nothing of Xcode run', async () => {
    const mac = await bareMac()
    const run = await check(mac, { platform: 'linux' })
    expect(run.shape('mac.os')).toEqual({
      status: 'blocking',
      sentence: 'iPhones need a Mac; on linux only Android works through this helper.',
      fixes: [],
    })
    expect(run.items.filter((i) => i.group === 'ios')).toEqual([])
    expect(run.ran).toEqual([])
  })

  it('20b. linux: the banner says iPhones are unavailable and no lane is iOS', async () => {
    const s = await startBridge({ platform: 'linux', lanes: { ios: undefined } })
    expect(s.bridge.lanes.ios).toBeUndefined()
    expect(s.bridge.registry.lanes().ios.reason).toBe('iPhones need macOS.')
  })

  it('macOS falls back to sw_vers when SystemVersion.plist is unreadable', async () => {
    const mac = await fakeMac()
    mac.xcodeSelect(null)
    mac.bin.file(mac.input.swVersPath ?? '', 'echo 27.0.1', 'sw_vers')
    const run = await check(mac)
    expect(run.byId('mac.os')).toMatchObject({ label: 'macOS 27.0.1', sentence: 'macOS 27.0.1.' })
  })
})

/* --------------------------------------------------------------- 21. usbmuxd --- */

/** A Unix socket at a short path (macOS caps them at 104 bytes). */
async function unixServer(onSocket: (socket: net.Socket) => void): Promise<string> {
  const dir = mkdtempSync(path.join('/tmp', 'mux-'))
  const file = path.join(dir, 'usbmuxd')
  const open = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => undefined)
    onSocket(socket)
  })
  await new Promise<void>((resolve) => server.listen(file, resolve))
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy()
        server.close(() => resolve())
      }),
  )
  onCleanup(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })))
  return file
}

describe('21. usbmuxd', () => {
  it('answers ReadBUID → ok', async () => {
    const socket = await unixServer((s) => {
      s.once('data', (data: Buffer) => {
        s.end(
          encodeMuxFrame({ BUID: '7C4A7E1B-1C2D-4E5F-8A9B-0C1D2E3F4A5B' }, data.readUInt32LE(12)),
        )
      })
    })
    const run = await check(await bareMac(), { usbmuxdSocket: socket })
    expect(run.shape('ios.usbmuxd')).toEqual({
      status: 'ok',
      sentence: "macOS's iPhone service (usbmuxd) answers.",
      fixes: [],
    })
  })

  it.each([
    ['accepts then closes', (s: net.Socket) => s.end()],
    ['sends garbage', (s: net.Socket) => s.end(Buffer.alloc(MUX_HEADER + 8, 0xff))],
    ['never answers', () => undefined],
  ])('%s → blocking', async (_name, behave) => {
    const socket = await unixServer(behave)
    const run = await check(await bareMac(), {
      usbmuxdSocket: socket,
      timeouts: { muxRequest: 500 },
    })
    expect(run.shape('ios.usbmuxd')?.status).toBe('blocking')
  })

  it('a plain file where the socket should be → blocking', async () => {
    const file = path.join(tempDir(), 'usbmuxd')
    await import('node:fs').then((fs) => fs.writeFileSync(file, ''))
    const run = await check(await bareMac(), { usbmuxdSocket: file })
    expect(run.shape('ios.usbmuxd')?.status).toBe('blocking')
  })
})

/* ------------------------------------------------------------- 22. relative PATH --- */

describe('22. relative PATH entries', () => {
  it('a fake adb in "." or "" is never found, whatever the working directory', async () => {
    const mac = await bareMac()
    const cwd = process.cwd()
    const planted = tempDir()
    mac.bin.file(path.join(planted, 'adb'), 'echo planted', 'planted-adb')
    process.chdir(planted)
    try {
      const run = await check(mac, { searchPath: `.${path.delimiter}${path.delimiter}bin` })
      expect(run.shape('android.adb')?.status).toBe('warning')
      expect(mac.bin.calls().map((c) => c.name)).not.toContain('planted-adb')
    } finally {
      process.chdir(cwd)
    }
  })
})

/* -------------------------------------------------------------- 23. ios.session --- */

describe('23. ios.session after a native TLS failure', () => {
  const failure = { node: '18.20.4', openssl: '3.0.13', code: 'ERR_SSL_CA_MD_TOO_WEAK' }
  const facts = { usbmuxd: 'ok' as const, tlsFailures: [failure], devices: 1 }

  it('with libimobiledevice: a warning, details and logs come from it', async () => {
    const mac = await bareMac()
    mac.bin.simple('ideviceinfo', { stdout: 'ideviceinfo 1.4.0\n' })
    const run = await check(mac, { iosFacts: facts })
    expect(run.shape('ios.session')).toEqual({
      status: 'warning',
      sentence:
        "Node 18.20.4 (OpenSSL 3.0.13) couldn't open an iPhone's secure session, so details and logs come from libimobiledevice.",
      fixes: [
        { kind: 'link', href: 'https://nodejs.org/en/download', label: 'Get the current Node LTS' },
      ],
    })
  })

  it('without it: blocking, with Node and libimobiledevice fixes', async () => {
    const mac = await bareMac()
    mac.brew()
    const run = await check(mac, { iosFacts: facts })
    expect(run.shape('ios.session')).toEqual({
      status: 'blocking',
      sentence:
        "Node 18.20.4 (OpenSSL 3.0.13) couldn't open an iPhone's secure session, so only basic identifiers are shown.",
      fixes: [
        { kind: 'link', href: 'https://nodejs.org/en/download', label: 'Get the current Node LTS' },
        command('brew install libimobiledevice'),
      ],
    })
  })

  it('absent while no session has failed', async () => {
    const run = await check(await bareMac(), {
      iosFacts: { usbmuxd: 'ok', tlsFailures: [], devices: 0 },
    })
    expect(run.byId('ios.session')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ simulators --- */

describe('ios.simulators (only with --simulators)', () => {
  it('absent without the flag', async () => {
    expect((await check(await bareMac())).byId('ios.simulators')).toBeUndefined()
  })

  it('ready: counts booted iOS simulators only, through the real simctl', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    mac.bootedSimulators(2)
    const run = await check(mac, { simulators: true })
    expect(run.shape('ios.simulators')).toEqual({
      status: 'ok',
      sentence: '2 simulators are booted.',
      fixes: [],
    })
    mac.bootedSimulators(0)
    expect((await check(mac, { simulators: true })).shape('ios.simulators')?.sentence).toBe(
      'No simulator is booted.',
    )
    assertNothingForbidden(run, mac)
  })

  it('CoreSimulator older than the wrapper expects → first launch; simctl never run', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    mac.coreSimulator('1171.6.9')
    const run = await check(mac, { simulators: true })
    expect(run.shape('ios.simulators')).toEqual({
      status: 'warning',
      sentence: "Xcode hasn't finished installing simulator components.",
      fixes: FIRST_LAUNCH,
    })
    expect(run.ran.filter((r) => path.basename(r[0] ?? '') === 'simctl')).toEqual([])
    assertNothingForbidden(run, mac)
  })

  it('1171.7.0 is not older than 1171.7 (trailing .0 removed, as the wrapper does)', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    mac.coreSimulator('1171.7.0')
    const run = await check(mac, { simulators: true })
    expect(run.shape('ios.simulators')?.status).toBe('ok')
  })

  it('no Xcode → "Simulators need Xcode."', async () => {
    const run = await check(await bareMac(), { simulators: true })
    expect(run.shape('ios.simulators')).toEqual({
      status: 'warning',
      sentence: 'Simulators need Xcode.',
      fixes: [APP_STORE],
    })
  })
})

/* ------------------------------------------------------------- refresh, report --- */

describe('collectPreflight({refresh}) and doctorReport()', () => {
  it('refresh re-resolves the tools; a plain call uses the cache', async () => {
    const mac = await bareMac()
    expect((await check(mac, {}, true)).refreshed).toBe(1)
    expect((await check(mac, {}, false)).refreshed).toBe(0)
  })

  it('the report carries the helper facts, macOS, the lanes and the items', async () => {
    const mac = await bareMac()
    const { ctx } = contextOf(mac)
    const report = await doctorReport(ctx, { refresh: false })
    expect(report.helper).toMatchObject({ name: 'bauloc-device-bridge', macos: '27.0.1' })
    expect(report.lanes.android.status).toBe('stopped')
    expect(report.items.map((i) => i.group)).not.toContain('device')
    expect(typeof report.checkedAt).toBe('number')
  })
})

/* ------------------------------------------------------------ 24. --doctor text --- */

describe('24. --doctor output', () => {
  const doctorText = async (mac: FakeMac, input: BridgeInput = {}): Promise<string> => {
    const bridge = createBridge({
      platform: 'darwin',
      nodeVersion: '24.12.0',
      opensslVersion: '3.6.1',
      arch: 'arm64',
      tunneldPort: 1,
      ...mac.input,
      ...input,
    })
    const lines: string[] = []
    await bridge.doctor((line) => lines.push(line))
    expect(lines.join('\n')).not.toContain(bridge.token)
    return lines.join('\n').split(mac.root).join('<fake>')
  }

  it('scenario 1, a bare Mac', async () => {
    const text = await doctorText(await bareMac())
    expect(text).toBe(
      [
        'bauloc-device-bridge 1.1.0 · doctor',
        'Node 24.12.0 (OpenSSL 3.6.1) · darwin-arm64 · macOS 27.0.1 · --no-open',
        '',
        'This Mac',
        '  OK            Node 24.12.0 — Node 24.12.0 runs the helper.',
        '  OK            macOS 27.0.1 — macOS 27.0.1.',
        'iPhone tools',
        "  Needs action  usbmuxd — macOS's iPhone service (usbmuxd) isn't answering.",
        '                → Unplug the iPhone and plug it back in. If this stays red, restart the Mac.',
        "  Warning       Xcode — Xcode isn't installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.",
        '                → Get Xcode from the App Store: https://apps.apple.com/app/xcode/id497799835',
        "  Warning       libimobiledevice (optional) — Not installed. Only needed for screenshots of iOS 16 and older, or when the helper can't open an iPhone's secure session.",
        '                → Install Homebrew first: https://brew.sh',
        '                → brew install libimobiledevice',
        '  Warning       pymobiledevice3 (optional) — Not installed. Only needed for the optional root tunnel (a later helper version).',
        '                → Get Python from python.org: https://www.python.org/downloads/macos/',
        'Android tools',
        "  Warning       adb — adb isn't installed. Chrome and Edge don't need it; Safari and Firefox reach Android only through it.",
        '                → Install Homebrew first: https://brew.sh',
        '                → brew install --cask android-platform-tools',
        "  OK            adb server — Google's adb server isn't running, so Chrome's WebUSB can use Android phones directly.",
        "  Warning       Wi-Fi devices (optional) — Android TVs and phones on Wi-Fi go through Google's adb server, and adb isn't installed.",
        '                → Install Homebrew first: https://brew.sh',
        '                → brew install --cask android-platform-tools',
        '  Warning       bundletool (optional) — Not installed. Only needed to install .aab bundles (a later helper version).',
        '                → Install Homebrew first: https://brew.sh',
        '                → brew install bundletool',
        '',
        'Devices',
        '  No lane can probe devices in this run.',
      ].join('\n'),
    )
  })

  it('scenario 8, everything ready', async () => {
    const mac = await bareMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect('/Library/Developer/CommandLineTools')
    mac.brew()
    mac.bin.simple('adb', {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n',
    })
    mac.bin.simple('ideviceinfo', { stdout: 'ideviceinfo 1.4.0\n' })
    const text = await doctorText(mac, { env: { ...mac.input.env, DEVELOPER_DIR: devDir } })
    const lines = text.split('\n')
    expect(lines).toContain(
      "  OK            Xcode 27.0 — Screenshots of iOS 17 and newer work through Xcode's devicectl.",
    )
    expect(lines).toContain(
      '                devicectl 642.16 · <fake>/mac/Applications/Xcode.app/Contents/Developer',
    )
    expect(lines).toContain(
      "  OK            adb 36.0.0 — Google's adb is installed (<fake>/bin/adb).",
    )
    expect(lines).toContain(
      '  OK            libimobiledevice 1.4.0 (optional) — Installed: a fallback for details and logs, and screenshots of iOS 16 and older.',
    )
    expect(lines).toContain('                → brew install bundletool')
    expect(text).not.toContain('brew.sh')
  })

  it('runs each lane’s probe after the checklist, and survives one that throws', async () => {
    const mac = await bareMac()
    const lines: string[] = []
    const bridge = createBridge({
      ...mac.input,
      platform: 'darwin',
      lanes: {
        ios: () =>
          ({
            name: 'ios',
            facts: () => ({ usbmuxd: 'ok', tlsFailures: [], devices: 0 }),
            probeForDoctor: (write: (line: string) => void) => {
              write('iPhone 12 Pro: pair record yes')
              return Promise.resolve()
            },
          }) as unknown as Lane<IosLaneFacts>,
        simulators: () =>
          ({
            name: 'simulators',
            facts: () => ({ simctl: null, booted: 0 }),
            probeForDoctor: () => Promise.reject(new Error('simctl went away')),
          }) as unknown as Lane<{ simctl: string | null; booted: number }>,
        // The real Android lane prints its server state here too; this test is about the
        // other two, so it stays out.
        android: null,
      },
    })
    await bridge.doctor((line) => lines.push(line))
    const devices = lines.slice(lines.indexOf('Devices'))
    expect(devices).toEqual([
      'Devices',
      '  iPhone 12 Pro: pair record yes',
      '  The simulators probe stopped early: simctl went away',
    ])
  })
})

/* --------------------------------------------------------------- the banner part --- */

describe('formatChecklist', () => {
  const items: PreflightItem[] = [
    {
      id: 'mac.node',
      group: 'mac',
      label: 'Node 20.19.6',
      status: 'warning',
      sentence: 'Node 20.19.6 works, but it no longer gets security updates.',
      fixes: [
        { kind: 'link', href: 'https://nodejs.org/en/download', label: 'Get the current Node LTS' },
      ],
      neededFor: ['helper'],
    },
    {
      id: 'ios.xcode',
      group: 'ios',
      label: 'Xcode 27.0',
      status: 'warning',
      sentence: "Xcode hasn't finished installing its components, so screenshots are off.",
      fixes: FIRST_LAUNCH,
      neededFor: ['ios.screenshot'],
    },
    {
      id: 'ios.libimobiledevice',
      group: 'ios',
      label: 'libimobiledevice',
      status: 'warning',
      sentence: 'Not installed.',
      fixes: [command('brew install libimobiledevice')],
      neededFor: [],
      optional: true,
    },
    {
      id: 'android.adb-server',
      group: 'android',
      label: 'adb server',
      status: 'ok',
      sentence: "Google's adb server isn't running.",
      fixes: [{ kind: 'action', action: 'start-adb', label: 'Start adb server' }],
      neededFor: ['android.helper'],
    },
  ]

  it('{all: false}: non-optional warnings and blockers, in the banner’s columns', () => {
    expect(formatChecklist(items, { all: false })).toEqual([
      'Node 20.19.6 Node 20.19.6 works, but it no longer gets security updates.',
      '            → Get the current Node LTS: https://nodejs.org/en/download',
      "Xcode 27.0  Xcode hasn't finished installing its components, so screenshots are off.",
      '            → Open Xcode once and let it finish.',
      '            → sudo xcodebuild -runFirstLaunch',
    ])
  })

  it('{all: true}: every item under its group, fixes only for what is not OK', () => {
    expect(formatChecklist(items, { all: true })).toEqual([
      'This Mac',
      '  Warning       Node 20.19.6 — Node 20.19.6 works, but it no longer gets security updates.',
      '                → Get the current Node LTS: https://nodejs.org/en/download',
      'iPhone tools',
      "  Warning       Xcode 27.0 — Xcode hasn't finished installing its components, so screenshots are off.",
      '                → Open Xcode once and let it finish.',
      '                → sudo xcodebuild -runFirstLaunch',
      '  Warning       libimobiledevice (optional) — Not installed.',
      '                → brew install libimobiledevice',
      'Android tools',
      "  OK            adb server — Google's adb server isn't running.",
    ])
  })

  it('an empty list prints nothing', () => {
    expect(formatChecklist([], { all: false })).toEqual([])
    expect(formatChecklist([], { all: true })).toEqual([])
  })
})

/* ----------------------------------------------------------------- 25. /api/doctor --- */

/** The page's guard for a DoctorReport, by hand (§12c), until protocol.ts ships one. */
function isDoctorReport(value: unknown): value is DoctorReport {
  const r = value as DoctorReport
  const fixOk = (f: PreflightFix): boolean =>
    (f.kind === 'command' && typeof f.command === 'string') ||
    (f.kind === 'link' && /^https:\/\//.test(f.href) && typeof f.label === 'string') ||
    (f.kind === 'step' && typeof f.text === 'string') ||
    (f.kind === 'action' && typeof f.action === 'string' && typeof f.label === 'string')
  return (
    typeof r === 'object' &&
    typeof r.helper?.name === 'string' &&
    typeof r.helper.version === 'string' &&
    (r.helper.macos === null || typeof r.helper.macos === 'string') &&
    typeof r.lanes?.ios?.status === 'string' &&
    typeof r.checkedAt === 'number' &&
    Array.isArray(r.items) &&
    r.items.every(
      (i) =>
        /^(mac|ios|android)\.[a-z0-9-]+$/.test(i.id) &&
        ['ok', 'warning', 'blocking', 'unchecked'].includes(i.status) &&
        typeof i.label === 'string' &&
        typeof i.sentence === 'string' &&
        Array.isArray(i.neededFor) &&
        Array.isArray(i.fixes) &&
        i.fixes.every(fixOk),
    )
  )
}

describe('25. GET /api/doctor', () => {
  it('401 without the bearer; with it, a report the page can parse, and ?refresh=1 works', async () => {
    const mac = await bareMac()
    const s = await startBridge({ ...mac.input, platform: 'darwin', adbPort: await freePort() })
    expect((await request(s.port, { path: '/api/doctor' })).status).toBe(401)
    const reply = await request(s.port, { path: '/api/doctor', headers: s.auth })
    expect(reply.status).toBe(200)
    const report = reply.json<unknown>()
    expect(isDoctorReport(report)).toBe(true)
    expect(reply.text).not.toContain(s.token)
    const fresh = await request(s.port, { path: '/api/doctor?refresh=1', headers: s.auth })
    expect(isDoctorReport(fresh.json<unknown>())).toBe(true)
  })
})
