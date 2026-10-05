/**
 * §12 Doctor and preflight: the Mac, iPhone-tool and Android-tool items of the checklist,
 * worded here so the terminal and the page say the same thing (§12b, exact strings).
 *
 * The bridge calls four functions:
 * - collectPreflight(): in the background at start (for the banner) and for /api/doctor;
 * - doctorReport(): the body of GET /api/doctor (the bridge caches it 30 s);
 * - formatChecklist(): the banner's lines ({all: false}) and --doctor's ({all: true});
 * - printDoctor(): everything `--doctor` prints, including each lane's probeForDoctor().
 *
 * Every check is read-only and bounded: each tool run has its own timeout (§1.12, Doctor),
 * and the whole collection stops waiting after 12 s, so one hung tool turns its own item
 * "Not checked" instead of holding the checklist back. Fixes are text for the tester to
 * copy; the helper never runs one.
 */
import http from 'node:http'
import path from 'node:path'
import { lstat, readFile } from 'node:fs/promises'
import { INSTALL, NAME } from './constants'
import { adbConnection, createAdbClient, parseDevicesL } from './android-lane'
import { asDict, parsePlist } from './plist'
import {
  findBrew,
  findPython,
  isTimeout,
  libimobiledeviceVersion,
  resolveBundletool,
  resolvePymobiledevice3,
  adbCommand,
  onSearchPath,
  shellQuote,
  toolOptionsFrom,
  type BundletoolInfo,
  type Pymobiledevice3Info,
  type PythonInfo,
  type SimctlInfo,
  type ToolInfo,
  type ToolOptions,
  type Toolbox,
  type XcodeInfo,
} from './tools'
import type {
  Capability,
  DoctorReport,
  PreflightContext,
  PreflightFix,
  PreflightItem,
  PreflightStatus,
} from './types'
import { childEnv } from './process'
import { createUsbmux } from './usbmuxd'
import { clean, errorText, plural, withTimeout } from './util'

/* --------------------------------------------------------------------- wording --- */

/** The fixed parts of an item: what it is, whatever the check finds. */
interface ItemBase {
  id: string
  group: PreflightItem['group']
  label: string
  neededFor: Capability[]
  optional?: boolean
}

function item(
  base: ItemBase,
  status: PreflightStatus,
  sentence: string,
  fixes: PreflightFix[] = [],
  extra: { label?: string; detail?: string } = {},
): PreflightItem {
  return {
    id: base.id,
    group: base.group,
    label: extra.label ?? base.label,
    status,
    sentence,
    fixes,
    ...(extra.detail ? { detail: extra.detail } : {}),
    neededFor: base.neededFor,
    ...(base.optional ? { optional: true } : {}),
  }
}

const IOS_ALL: Capability[] = ['ios.list', 'ios.detail', 'ios.screenshot', 'ios.logs']

export const ITEMS = {
  node: { id: 'mac.node', group: 'mac', label: 'Node', neededFor: ['helper'] },
  os: { id: 'mac.os', group: 'mac', label: 'macOS', neededFor: IOS_ALL },
  usbmuxd: {
    id: 'ios.usbmuxd',
    group: 'ios',
    label: 'usbmuxd',
    neededFor: ['ios.list', 'ios.detail', 'ios.logs'],
  },
  session: {
    id: 'ios.session',
    group: 'ios',
    label: 'Secure session',
    neededFor: ['ios.detail', 'ios.logs'],
  },
  xcode: { id: 'ios.xcode', group: 'ios', label: 'Xcode', neededFor: ['ios.screenshot'] },
  libimobiledevice: {
    id: 'ios.libimobiledevice',
    group: 'ios',
    label: 'libimobiledevice',
    neededFor: ['ios.screenshot.legacy', 'ios.fallback'],
    optional: true,
  },
  pymobiledevice3: {
    id: 'ios.pymobiledevice3',
    group: 'ios',
    label: 'pymobiledevice3',
    neededFor: [],
    optional: true,
  },
  simulators: {
    id: 'ios.simulators',
    group: 'ios',
    label: 'Simulators',
    neededFor: ['simulators'],
  },
  adb: { id: 'android.adb', group: 'android', label: 'adb', neededFor: ['android.helper'] },
  adbServer: {
    id: 'android.adb-server',
    group: 'android',
    label: 'adb server',
    neededFor: ['android.helper'],
  },
  wifi: {
    id: 'android.wifi',
    group: 'android',
    label: 'Wi-Fi devices',
    neededFor: ['android.wifi'],
    optional: true,
  },
  bundletool: {
    id: 'android.bundletool',
    group: 'android',
    label: 'bundletool',
    neededFor: ['android.aab'],
    optional: true,
  },
} satisfies Record<string, ItemBase>

const NODE_LTS: PreflightFix = {
  kind: 'link',
  href: 'https://nodejs.org/en/download',
  label: 'Get the current Node LTS',
}
const APP_STORE_XCODE: PreflightFix = {
  kind: 'link',
  href: 'https://apps.apple.com/app/xcode/id497799835',
  label: 'Get Xcode from the App Store',
}
const HOMEBREW: PreflightFix = {
  kind: 'link',
  href: 'https://brew.sh',
  label: 'Install Homebrew first',
}
const FIRST_LAUNCH: PreflightFix[] = [
  { kind: 'step', text: 'Open Xcode once and let it finish.' },
  { kind: 'command', command: 'sudo xcodebuild -runFirstLaunch' },
]

/** Homebrew's `brew` as found, and whether a bare `brew` on the helper's PATH reaches it. */
export interface Brew {
  path: string
  onPath: boolean
}

/**
 * A `brew install …` fix. Without Homebrew (§12b: neither /opt/homebrew/bin/brew nor
 * /usr/local/bin/brew) the command would only print "command not found", so the way to
 * get Homebrew comes first. Homebrew found only in its own folder (a fresh install whose
 * "Next steps" were skipped) puts itself on the terminal's PATH first, for `brew` and for
 * what it installs (pipx).
 */
export function brewFix(command: string, brew: Brew | null): PreflightFix[] {
  const install: PreflightFix = { kind: 'command', command }
  if (!brew) return [HOMEBREW, install]
  if (brew.onPath) return [install]
  return [
    {
      kind: 'command',
      command: `eval "$(${shellQuote(brew.path)} shellenv)"`,
      note: "Homebrew is installed but not on this terminal's PATH yet; this adds it",
    },
    install,
  ]
}

/** findBrew(), and whether its folder is on the PATH the helper (and its terminal) uses. */
function brewOf(opts: ToolOptions): Brew | null {
  const file = findBrew(opts)
  if (!file) return null
  return { path: file, onPath: onSearchPath(file, opts.searchPath) }
}

const selectXcode = (devDir: string): PreflightFix => ({
  kind: 'command',
  command: `sudo xcode-select -s ${shellQuote(devDir)}`,
})

export function nodeItem(version: string): PreflightItem {
  const major = parseInt(version, 10)
  const label = `Node ${version}`
  if (major >= 22) return item(ITEMS.node, 'ok', `Node ${version} runs the helper.`, [], { label })
  if (major >= 18) {
    return item(
      ITEMS.node,
      'warning',
      `Node ${version} works, but it no longer gets security updates.`,
      [NODE_LTS],
      { label },
    )
  }
  return item(ITEMS.node, 'blocking', `Node ${version} is too old for the helper.`, [NODE_LTS], {
    label,
  })
}

export function macosItem(platform: string, version: string | null): PreflightItem {
  if (platform !== 'darwin') {
    return item(
      ITEMS.os,
      'blocking',
      `iPhones need a Mac; on ${platform} only Android works through this helper.`,
      [],
      { label: platform },
    )
  }
  return version
    ? item(ITEMS.os, 'ok', `macOS ${version}.`, [], { label: `macOS ${version}` })
    : item(ITEMS.os, 'ok', "macOS (its version couldn't be read).")
}

export function usbmuxdItem(answers: boolean): PreflightItem {
  return answers
    ? item(ITEMS.usbmuxd, 'ok', "macOS's iPhone service (usbmuxd) answers.")
    : item(ITEMS.usbmuxd, 'blocking', "macOS's iPhone service (usbmuxd) isn't answering.", [
        {
          kind: 'step',
          text: 'Unplug the iPhone and plug it back in. If this stays red, restart the Mac.',
        },
      ])
}

/** Shown only after the native TLS session failed on this Node (§3.3, R2). */
export function sessionItem(
  failure: { node: string; openssl: string },
  libimobiledevice: boolean,
  brew: Brew | null,
): PreflightItem {
  const lead = `Node ${failure.node} (OpenSSL ${failure.openssl}) couldn't open an iPhone's secure session`
  return libimobiledevice
    ? item(ITEMS.session, 'warning', `${lead}, so details and logs come from libimobiledevice.`, [
        NODE_LTS,
      ])
    : item(ITEMS.session, 'blocking', `${lead}, so only basic identifiers are shown.`, [
        NODE_LTS,
        ...brewFix(INSTALL.libimobiledevice, brew),
      ])
}

export function xcodeItem(x: XcodeInfo): PreflightItem {
  const label = x.version ? `Xcode ${x.version}` : 'Xcode'
  const where = x.devDir ?? ''
  switch (x.state) {
    case 'ready': {
      const detail = [x.coreDevice ? `devicectl ${x.coreDevice}` : null, where]
        .filter(Boolean)
        .join(' · ')
      return x.license === false
        ? item(
            ITEMS.xcode,
            'warning',
            "Xcode's license hasn't been accepted, which can stop its tools.",
            [{ kind: 'command', command: 'sudo xcodebuild -license accept' }],
            { label, detail },
          )
        : item(
            ITEMS.xcode,
            'ok',
            "Screenshots of iOS 17 and newer work through Xcode's devicectl.",
            [],
            { label, detail },
          )
    }
    case 'not-selected':
      return item(
        ITEMS.xcode,
        'warning',
        'Xcode is installed, but the Command Line Tools are selected, so screenshots are off.',
        x.suggest ? [selectXcode(x.suggest)] : [],
        { label, detail: where ? `selected: ${where}` : undefined },
      )
    case 'needs-first-launch':
      return item(
        ITEMS.xcode,
        'warning',
        "Xcode hasn't finished installing its components, so screenshots are off.",
        FIRST_LAUNCH,
        {
          label,
          detail: [
            x.expected
              ? `devicectl needs CoreDevice ${x.expected}, found ${x.coreDevice || 'none'}`
              : null,
            where,
          ]
            .filter(Boolean)
            .join(' · '),
        },
      )
    case 'no-capture':
      return item(
        ITEMS.xcode,
        'warning',
        "This Xcode's devicectl has no screenshot command; update Xcode.",
        [APP_STORE_XCODE],
        { label, detail: where },
      )
    case 'not-installed':
      return item(
        ITEMS.xcode,
        'warning',
        "Xcode isn't installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.",
        [APP_STORE_XCODE],
        { detail: where ? `selected: ${where}` : undefined },
      )
  }
}

/** `ideviceinfo, idevicesyslog in /opt/homebrew/bin`: one folder named once. */
function toolsByFolder(tools: readonly ToolInfo[]): string {
  const folders = new Map<string, string[]>()
  for (const t of tools) {
    const dir = path.dirname(t.path)
    folders.set(dir, [...(folders.get(dir) ?? []), path.basename(t.path)])
  }
  return [...folders].map(([dir, names]) => `${names.join(', ')} in ${dir}`).join(' · ')
}

export function libimobiledeviceItem(
  tools: ReadonlyArray<ToolInfo | null>,
  version: string | null,
  brew: Brew | null,
): PreflightItem {
  const present = tools.filter((t): t is ToolInfo => t !== null)
  if (!present.length) {
    return item(
      ITEMS.libimobiledevice,
      'warning',
      "Not installed. Only needed for screenshots of iOS 16 and older, or when the helper can't open an iPhone's secure session.",
      brewFix(INSTALL.libimobiledevice, brew),
    )
  }
  return item(
    ITEMS.libimobiledevice,
    'ok',
    'Installed: a fallback for details and logs, and screenshots of iOS 16 and older.',
    [],
    {
      label: version ? `libimobiledevice ${version}` : 'libimobiledevice',
      detail: toolsByFolder(present),
    },
  )
}

/** The way to install pymobiledevice3 into the Python this Mac has (§12b). */
export function pymobiledevice3Fixes(python: PythonInfo | null, brew: Brew | null): PreflightFix[] {
  if (!python) {
    return [
      {
        kind: 'link',
        href: 'https://www.python.org/downloads/macos/',
        label: 'Get Python from python.org',
      },
    ]
  }
  return python.kind === 'externally-managed'
    ? brewFix('brew install pipx && pipx install pymobiledevice3', brew)
    : [{ kind: 'command', command: 'python3 -m pip install -U pymobiledevice3' }]
}

export function pymobiledevice3Item(
  info: Pymobiledevice3Info | null,
  tunnel: boolean | null,
  fixes: PreflightFix[],
): PreflightItem {
  const later = 'Used only by the optional root tunnel, in a later helper version.'
  if (!info) {
    return item(
      ITEMS.pymobiledevice3,
      'warning',
      'Not installed. Only needed for the optional root tunnel (a later helper version).',
      fixes,
    )
  }
  const label = info.version ? `pymobiledevice3 ${info.version}` : 'pymobiledevice3'
  const python = info.python
  if (python?.state === 'shim') {
    return item(
      ITEMS.pymobiledevice3,
      'unchecked',
      `Installed for Apple's ${python.path}, which the helper never starts, so it wasn't checked.`,
      [],
      { label, detail: info.path },
    )
  }
  if (python?.state === 'missing') {
    return item(
      ITEMS.pymobiledevice3,
      'warning',
      `Installed, but the Python it needs (${python.path}) is gone.`,
      fixes,
      { label, detail: info.path },
    )
  }
  const where = python
    ? `Installed in ${python.version ? `Python ${python.version}` : 'Python'} (${python.path}).`
    : 'Installed.'
  return item(ITEMS.pymobiledevice3, 'ok', `${where} ${later}`, [], {
    label,
    detail: tunnel === null ? undefined : `root tunnel: ${tunnel ? 'running' : 'not running'}`,
  })
}

export function simulatorsItem(s: SimctlInfo, booted: number | null): PreflightItem {
  switch (s.state) {
    case 'ready':
      return item(
        ITEMS.simulators,
        'ok',
        booted
          ? `${plural(booted, 'simulator')} ${booted === 1 ? 'is' : 'are'} booted.`
          : 'No simulator is booted.',
        [],
        { detail: s.simctl ?? undefined },
      )
    case 'needs-first-launch':
      return item(
        ITEMS.simulators,
        'warning',
        "Xcode hasn't finished installing simulator components.",
        FIRST_LAUNCH,
      )
    case 'not-selected':
      return item(
        ITEMS.simulators,
        'warning',
        'Simulators need Xcode, but the Command Line Tools are selected.',
        s.suggest ? [selectXcode(s.suggest)] : [],
      )
    case 'not-installed':
      return item(ITEMS.simulators, 'warning', 'Simulators need Xcode.', [APP_STORE_XCODE])
  }
}

export function adbItem(adb: ToolInfo | null, brew: Brew | null): PreflightItem {
  return adb
    ? item(ITEMS.adb, 'ok', `Google's adb is installed (${adb.path}).`, [], {
        label: adb.version ? `adb ${adb.version}` : 'adb',
      })
    : item(
        ITEMS.adb,
        'warning',
        "adb isn't installed. Chrome and Edge don't need it; Safari and Firefox reach Android only through it.",
        brewFix(INSTALL.adb, brew),
      )
}

/** What the adb server said: null when nothing listens. */
export interface AdbServerFacts {
  protocol: number
  devices: Array<{ serial: string; state: string; model: string }>
}

/**
 * Something accepts on the adb port but doesn't answer `host:version` in time, or not as an
 * adb server: most often an adb server that got stuck (after sleep), which still holds the
 * phones. Not "not running": WebUSB can't have them, and Start adb server would fail.
 */
export interface AdbServerStuck {
  stuck: true
  port: number
  /** What went wrong, for the item's detail. */
  why: string
}

export type AdbServerState = AdbServerFacts | AdbServerStuck | null | 'off'

const isStuck = (server: AdbServerState): server is AdbServerStuck =>
  typeof server === 'object' && server !== null && 'stuck' in server

const stuckSentence = (port: number): string =>
  `Something on 127.0.0.1:${String(port)} isn't answering like Google's adb server, usually an adb server that got stuck.`

/** Stop the stuck server (adb by its full path, when found); else find what holds the port. */
function stuckFixes(adb: ToolInfo | null, port: number): PreflightFix[] {
  const lsof: PreflightFix = {
    kind: 'command',
    command: `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
    note: 'shows what holds the port; quit that app',
  }
  if (!adb) return [lsof]
  return [{ kind: 'command', command: `${shellQuote(adb.path)} kill-server` }, lsof]
}

/** Offered only with adb installed: the helper starts the server with that adb, else it fails. */
const START_ADB: PreflightFix = { kind: 'action', action: 'start-adb', label: 'Start adb server' }

export function adbServerItem(server: AdbServerState, adb: ToolInfo | null): PreflightItem {
  if (server === 'off') {
    return item(
      ITEMS.adbServer,
      'unchecked',
      'Not checked: the helper was started with --no-android.',
    )
  }
  if (isStuck(server)) {
    return item(
      ITEMS.adbServer,
      'warning',
      stuckSentence(server.port),
      stuckFixes(adb, server.port),
      { detail: server.why },
    )
  }
  if (!server) {
    return item(
      ITEMS.adbServer,
      'ok',
      "Google's adb server isn't running, so Chrome's WebUSB can use Android phones directly.",
      adb ? [START_ADB] : [],
    )
  }
  const phones = server.devices
  const holds = phones.length
    ? `${plural(phones.length, 'phone')} (${phones.map((p) => p.model || p.serial).join(', ')})`
    : 'no phones'
  return item(
    ITEMS.adbServer,
    'ok',
    `Google's adb server is running and holds ${holds}; the helper shares it.`,
    [],
    {
      detail: [
        `protocol ${String(server.protocol)}`,
        ...phones.map((p) => `${p.serial}:${p.state}`),
      ].join(' · '),
    },
  )
}

/**
 * §4.7: Android TVs and phones on the network are reached only through Google's adb server,
 * so this row is about that server, for Wi-Fi's sake. Optional: a tester who never uses
 * Wi-Fi must not see a warning for it in the banner, and the server not running is what
 * Chrome's WebUSB wants (the adb server row says so). `searchPath` is the PATH the tester's
 * terminal has: an adb found off it is named by its full path in the commands.
 */
export function wifiItem(
  adb: ToolInfo | null,
  server: AdbServerState,
  brew: Brew | null,
  searchPath: string,
): PreflightItem {
  if (server === 'off') {
    return item(ITEMS.wifi, 'unchecked', 'Not checked: the helper was started with --no-android.')
  }
  if (isStuck(server)) {
    return item(ITEMS.wifi, 'warning', stuckSentence(server.port), stuckFixes(adb, server.port), {
      detail: server.why,
    })
  }
  if (!server && !adb) {
    return item(
      ITEMS.wifi,
      'warning',
      "Android TVs and phones on Wi-Fi go through Google's adb server, and adb isn't installed.",
      // Installing adb comes first: Start adb server can't work without it.
      brewFix(INSTALL.adb, brew),
    )
  }
  if (!server) {
    const adbCmd = adbCommand(adb, searchPath)
    return item(
      ITEMS.wifi,
      'warning',
      "Android TVs and phones on Wi-Fi go through Google's adb server, which isn't running.",
      [
        START_ADB,
        {
          kind: 'command',
          command: `${adbCmd} start-server`,
          note: `while it runs, Chrome's WebUSB can't use Android phones on a cable; ${adbCmd} kill-server gives them back`,
        },
      ],
    )
  }
  const onWifi = server.devices.filter((d) => adbConnection(d.serial) === 'network')
  return item(
    ITEMS.wifi,
    'ok',
    "Google's adb server is running: connect a TV or phone by its address.",
    [],
    onWifi.length ? { detail: onWifi.map((d) => `${d.serial}:${d.state}`).join(' · ') } : {},
  )
}

export function bundletoolItem(info: BundletoolInfo | null, brew: Brew | null): PreflightItem {
  if (!info) {
    return item(
      ITEMS.bundletool,
      'warning',
      'Not installed. Only needed to install .aab bundles (a later helper version).',
      brewFix('brew install bundletool', brew),
    )
  }
  const label = info.version ? `bundletool ${info.version}` : 'bundletool'
  if (info.brokenJavaHome) {
    return item(
      ITEMS.bundletool,
      'warning',
      "bundletool is installed, but JAVA_HOME points at a Java that doesn't run.",
      [
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
      { label, detail: `${info.path} · JAVA_HOME=${info.brokenJavaHome}` },
    )
  }
  if (!info.java || !info.works) {
    return item(
      ITEMS.bundletool,
      'warning',
      "bundletool is installed but can't start Java.",
      brewFix('brew install openjdk', brew),
      { label, detail: info.path },
    )
  }
  return item(
    ITEMS.bundletool,
    'ok',
    `Installed (Java ${info.java.version}). A later helper version uses it to install .aab bundles.`,
    [],
    { label, detail: `${info.path} · Java ${info.java.version} (${info.java.home})` },
  )
}

/* -------------------------------------------------------------------- detection --- */

/** macOS's ProductVersion from SystemVersion.plist (XML [V]), else `sw_vers -productVersion`. */
async function macosVersion(ctx: PreflightContext): Promise<string | null> {
  try {
    const plist = asDict(parsePlist(await readFile(ctx.options.systemVersionPlist, 'utf8')))
    const version = plist?.ProductVersion
    if (typeof version === 'string' && version) return version
  } catch {
    /** Unreadable: ask sw_vers below. */
  }
  try {
    const { stdout } = await ctx.runTool(ctx.options.swVersPath, ['-productVersion'], {
      timeoutMs: ctx.timeouts.xcodeSelect,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * usbmuxd answers when its socket exists and a `ReadBUID` comes back (2 s). A socket that
 * accepts and then closes, or sends garbage, is not answering.
 */
async function usbmuxdAnswers(ctx: PreflightContext): Promise<boolean> {
  const socketPath = ctx.options.usbmuxdSocket
  try {
    if (!(await lstat(socketPath)).isSocket()) return false
    const buid = await withTimeout(
      createUsbmux({ socketPath, timeouts: ctx.timeouts }).readBuid(),
      ctx.timeouts.muxRequest + 500,
      () => new Error('usbmuxd did not answer'),
    )
    return typeof buid === 'string' && buid.length > 0
  } catch {
    return false
  }
}

/**
 * `host:version` on the adb server (attach only: a refused connect costs about 1 ms and
 * starts nothing), then `host:devices-l` when one answers. Only a refused connect means "not
 * running"; anything else on the port that doesn't answer in time, or not as adb, is stuck.
 */
async function adbServer(ctx: PreflightContext): Promise<AdbServerFacts | AdbServerStuck | null> {
  /** §12b gives this check 2 s per request, not the lanes' 5 s: it must not hold up the banner. */
  const timeouts = { ...ctx.timeouts, adbRequest: Math.min(ctx.timeouts.adbRequest, 2_000) }
  const client = createAdbClient({ port: ctx.options.adbPort, timeouts })
  try {
    const protocol = await client.version(ctx.signal)
    if (protocol === null) return null
    const text = await client.devicesL(ctx.signal).catch(() => '')
    return {
      protocol,
      devices: parseDevicesL(text).map((row) => ({
        serial: row.serial,
        state: row.state,
        model: (row.props.model ?? '').replace(/_/g, ' '),
      })),
    }
  } catch (error) {
    return { stuck: true, port: ctx.options.adbPort, why: clean(errorText(error), 200) }
  } finally {
    client.close()
  }
}

/** pymobiledevice3's root tunnel (`tunneld`) answers `GET /hello` on 127.0.0.1:49151. */
function tunnelRunning(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/hello', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/** Booted iOS simulators from the real simctl (`list -j devices booted`, about 80 ms [V]). */
async function bootedSimulators(ctx: PreflightContext, s: SimctlInfo): Promise<number | null> {
  if (s.state !== 'ready' || !s.simctl || !s.devDir) return null
  const { stdout } = await ctx.runTool(s.simctl, ['list', '-j', 'devices', 'booted'], {
    timeoutMs: ctx.timeouts.doctorCheck,
    env: childEnv({ DEVELOPER_DIR: s.devDir }, ctx.options.env),
  })
  const devices = asRecord(asRecord(JSON.parse(stdout) as unknown)?.devices)
  let booted = 0
  for (const [runtime, list] of Object.entries(devices ?? {})) {
    if (!runtime.includes('SimRuntime.iOS-') || !Array.isArray(list)) continue
    booted += list.filter((d) => asRecord(d)?.state === 'Booted').length
  }
  return booted
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/* -------------------------------------------------------------------- collecting --- */

interface Check {
  base: ItemBase
  run: () => Promise<PreflightItem | null>
}

const TIMED_OUT = 'Check timed out.'

/**
 * One check, bounded by the collection's deadline. Out of time (its own tool's timeout or
 * the 12 s for everything) → "Check timed out."; a bug → "This check couldn't run.". Either
 * way the item is there, so the page never shows a gap where a tool should be.
 */
async function settle(check: Check, deadline: Promise<'late'>): Promise<PreflightItem | null> {
  try {
    const result = await Promise.race([check.run(), deadline])
    return result === 'late' ? item(check.base, 'unchecked', TIMED_OUT) : result
  } catch (error) {
    if (isTimeout(error)) return item(check.base, 'unchecked', TIMED_OUT)
    return item(check.base, 'unchecked', "This check couldn't run.", [], {
      detail: clean(errorText(error), 200),
    })
  }
}

function toolOptionsOf(ctx: PreflightContext): ToolOptions {
  return toolOptionsFrom({ ...ctx.options, timeouts: ctx.timeouts, now: ctx.now }, ctx.runTool)
}

/** The checks for this Mac, in the order §12a lists them. */
function checks(ctx: PreflightContext, toolbox: Promise<Toolbox>): Check[] {
  const o = ctx.options
  const opts = toolOptionsOf(ctx)
  const brew = brewOf(opts)
  const darwin = o.platform === 'darwin'
  const list: Check[] = [
    { base: ITEMS.node, run: () => Promise.resolve(nodeItem(o.nodeVersion)) },
    {
      base: ITEMS.os,
      run: async () => macosItem(o.platform, darwin ? await macosVersion(ctx) : null),
    },
  ]
  if (darwin) {
    list.push(
      { base: ITEMS.usbmuxd, run: async () => usbmuxdItem(await usbmuxdAnswers(ctx)) },
      {
        base: ITEMS.session,
        run: async () => {
          const failure = ctx.lanes.ios?.facts().tlsFailures[0]
          if (!failure) return null
          return sessionItem(failure, (await toolbox).ideviceinfo !== null, brew)
        },
      },
      { base: ITEMS.xcode, run: async () => xcodeItem((await toolbox).xcode) },
      {
        base: ITEMS.libimobiledevice,
        run: async () => {
          const t = await toolbox
          const version = t.ideviceinfo
            ? await libimobiledeviceVersion(opts, t.ideviceinfo.path)
            : null
          return libimobiledeviceItem(
            [t.ideviceinfo, t.idevicesyslog, t.idevicescreenshot],
            version,
            brew,
          )
        },
      },
      {
        base: ITEMS.pymobiledevice3,
        run: async () => {
          const info = await resolvePymobiledevice3(opts)
          const runs = info !== null && (!info.python || info.python.state === 'ok')
          const fixes = runs ? [] : pymobiledevice3Fixes(await findPython(opts), brew)
          const tunnel = runs ? await tunnelRunning(o.tunneldPort, 500) : null
          return pymobiledevice3Item(info, tunnel, fixes)
        },
      },
    )
    if (o.simulators) {
      list.push({
        base: ITEMS.simulators,
        run: async () => {
          const s = (await toolbox).simctl
          return simulatorsItem(s, await bootedSimulators(ctx, s))
        },
      })
    }
  }
  /** Asked once for both rows that read it. */
  let server: Promise<AdbServerFacts | AdbServerStuck | null> | null = null
  const serverFacts = async (): Promise<AdbServerState> =>
    o.android ? await (server ??= adbServer(ctx)) : 'off'
  list.push(
    { base: ITEMS.adb, run: async () => adbItem((await toolbox).adb, brew) },
    {
      base: ITEMS.adbServer,
      run: async () => adbServerItem(await serverFacts(), (await toolbox).adb),
    },
    {
      base: ITEMS.wifi,
      run: async () => wifiItem((await toolbox).adb, await serverFacts(), brew, opts.searchPath),
    },
    {
      base: ITEMS.bundletool,
      run: async () => bundletoolItem(await resolveBundletool(opts), brew),
    },
  )
  return list
}

async function gather(
  ctx: PreflightContext,
  opts: { refresh: boolean },
): Promise<{ items: PreflightItem[]; macos: string | null }> {
  const toolbox = opts.refresh ? ctx.tools.refresh() : ctx.tools.get()
  /** Unhandled until a check awaits it; a rejection then lands in that check's item. */
  toolbox.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ctx.timeouts.doctorTotal)
  })
  try {
    const items = (await Promise.all(checks(ctx, toolbox).map((c) => settle(c, deadline)))).filter(
      (i): i is PreflightItem => i !== null,
    )
    const os = items.find((i) => i.id === ITEMS.os.id)
    const macos =
      ctx.options.platform === 'darwin' && os?.label.startsWith('macOS ')
        ? os.label.slice('macOS '.length)
        : null
    return { items, macos }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every Mac, iPhone-tool and Android-tool item of §12b, helper-worded. `refresh` re-resolves
 * the tools first (the tester just installed something: Re-check, `?refresh=1`).
 */
export async function collectPreflight(
  ctx: PreflightContext,
  opts: { refresh: boolean },
): Promise<PreflightItem[]> {
  return (await gather(ctx, opts)).items
}

/** GET /api/doctor (§12c): the helper's facts, the lanes, and the checklist. */
export async function doctorReport(
  ctx: PreflightContext,
  opts: { refresh: boolean },
): Promise<DoctorReport> {
  const gathered = gather(ctx, opts)
  /**
   * Re-check also has the Android lane re-read the tools gather() just refreshed, so the
   * report's `lanes.android.adb` agrees with its adb row (the tester just installed adb).
   */
  const lane = opts.refresh ? ctx.lanes.android?.rescan().catch(() => undefined) : undefined
  const [{ items, macos }] = await Promise.all([gathered, lane])
  return {
    helper: { ...ctx.about(), macos },
    lanes: ctx.lanesState(),
    items,
    checkedAt: ctx.now(),
  }
}

/* -------------------------------------------------------------------- terminal --- */

const STATUS_WORD: Record<PreflightStatus, string> = {
  ok: 'OK',
  warning: 'Warning',
  blocking: 'Needs action',
  unchecked: 'Not checked',
}

const GROUP_TITLE: Record<PreflightItem['group'], string> = {
  browser: 'This browser',
  helper: 'Local helper',
  mac: 'This Mac',
  ios: 'iPhone tools',
  android: 'Android tools',
  device: 'Devices',
}

/** A fix as one terminal line: the command itself, so it can be copied as it stands. */
export function fixText(fix: PreflightFix): string {
  switch (fix.kind) {
    case 'command':
      return fix.note ? `${fix.command}  (${fix.note})` : fix.command
    case 'link':
      return `${fix.label}: ${fix.href}`
    case 'step':
      return fix.text
    case 'action':
      return `${fix.label} (a button on the Device Lab page)`
  }
}

/**
 * Terminal lines for `items`.
 *
 * {all: false} is the banner's part: only the blocking and warning items that are not
 * optional, in the banner's twelve-column layout, each fix on its own line after "→ ".
 * {all: true} is --doctor's: every item under its group, with its status in words (colour
 * never carries meaning alone), the detail line, and the fixes of anything not OK.
 */
export function formatChecklist(items: readonly PreflightItem[], opts: { all: boolean }): string[] {
  const lines: string[] = []
  if (!opts.all) {
    for (const i of items) {
      if (i.optional || (i.status !== 'blocking' && i.status !== 'warning')) continue
      lines.push(`${i.label.padEnd(11)} ${i.sentence}`)
      for (const fix of i.fixes) lines.push(`${' '.repeat(12)}→ ${fixText(fix)}`)
    }
    return lines
  }
  const indent = ' '.repeat(16)
  let group: PreflightItem['group'] | null = null
  for (const i of items) {
    if (i.group !== group) {
      group = i.group
      lines.push(GROUP_TITLE[i.group])
    }
    const label = i.optional ? `${i.label} (optional)` : i.label
    lines.push(`  ${STATUS_WORD[i.status].padEnd(14)}${label} — ${i.sentence}`)
    if (i.detail) lines.push(indent + i.detail)
    if (i.status !== 'ok') for (const fix of i.fixes) lines.push(`${indent}→ ${fixText(fix)}`)
  }
  return lines
}

/**
 * The whole `--doctor` output (§1.9): who is running, the full checklist, each lane's
 * read-only probe of its attached devices, then one look at this computer's network (§4.9).
 * Paste it into a PR or a bug report: it never holds the token, key material, log text, IMEI,
 * phone numbers, a hardware address or a device's name.
 */
export async function printDoctor(
  ctx: PreflightContext,
  write: (line: string) => void,
): Promise<void> {
  const { items, macos } = await gather(ctx, { refresh: true })
  const about = ctx.about()
  write(`${NAME} ${about.version} · doctor`)
  write(
    [
      `Node ${about.node} (OpenSSL ${about.openssl})`,
      `${about.platform}-${about.arch}`,
      macos ? `macOS ${macos}` : null,
      about.flags.length ? about.flags.join(' ') : null,
    ]
      .filter(Boolean)
      .join(' · '),
  )
  write('')
  for (const line of formatChecklist(items, { all: true })) write(line)
  write('')
  write('Devices')
  let probed = false
  for (const lane of [ctx.lanes.ios, ctx.lanes.android, ctx.lanes.simulators]) {
    if (!lane?.probeForDoctor) continue
    probed = true
    try {
      await lane.probeForDoctor((line) => write(`  ${line}`))
    } catch (error) {
      write(`  The ${lane.name} probe stopped early: ${clean(errorText(error), 200)}`)
    }
  }
  if (!probed) write('  No lane can probe devices in this run.')
  if (!ctx.lan) return
  write('')
  write('Network')
  try {
    await ctx.lan.probeForDoctor((line) => write(`  ${line}`))
  } catch (error) {
    write(`  The network probe stopped early: ${clean(errorText(error), 200)}`)
  }
}
