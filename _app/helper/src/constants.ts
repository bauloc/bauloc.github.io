import type { Timeouts } from './types'

/** What answers on 127.0.0.1: the page checks `health.name` before it trusts anything else. */
export const NAME = 'bauloc-device-bridge'
/** Semver of this file. The page shows it and compares it with the published file. */
export const VERSION = '1.0.0'
/**
 * The wire protocol's integer major. Within a major only additions are allowed (fields,
 * codes, endpoints, `features`); the page accepts DVC_MIN_AGENT ≤ PROTOCOL ≤ DVC_MAX_AGENT.
 */
export const PROTOCOL = 1

export const SITE = 'https://bauloc.github.io'
export const DEFAULT_PORT = 8787
/**
 * `npm run dev` (Vite, 7360), `vite preview` (4173) and `npm run serve:site` (8000), on both
 * loopback names. Allowed only with --dev: on a normal run no local web server may drive
 * the phones.
 */
export const DEV_ORIGINS = [
  'http://localhost:7360',
  'http://127.0.0.1:7360',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
] as const

/** Where testers download this file, and where the "Review the source" links point. */
export const DOWNLOAD_URL = `${SITE}/device/agent/device-bridge.mjs`
export const SOURCE_URL =
  'https://github.com/bauloc/bauloc.github.io/blob/master/device/agent/device-bridge.mjs'

const KiB = 1024
const MiB = 1024 * KiB

/** Caps (§1.12). Every one bounds something a device, a tool or a page could make unbounded. */
export const LIMITS = {
  /** A tool's text output: devicectl JSON, getprop, simctl lists. */
  text: 8 * MiB,
  /** A screenshot: the largest iPad PNG is far below this. */
  png: 32 * MiB,
  /** Only the tail of stderr is kept, for TOOL_FAILED messages. */
  stderr: 64 * KiB,
  /** One log line, after which ` [truncated]` is appended. */
  line: 8 * KiB,
  /** Request bodies: only the Wi-Fi routes read one, a small JSON object (§4.7). */
  body: KiB,
  /** One upstream file in local mode. */
  upstream: 16 * MiB,
  /** usbmuxd and lockdown frames. */
  frame: 4 * MiB,
  /** A `lines` record carries at most this many lines… */
  batchLines: 200,
  /** …and stays far below the page's 1 MiB per-record cap even with 8 KiB lines. */
  batchBytes: 256 * KiB,
  /** Three streams leave room in the browser's six connections per host for polling. */
  streamsTotal: 3,
  maxConnections: 64,
  /** One-shot tools at a time (devicectl, simctl, ideviceinfo…). */
  tools: 4,
  /** Device names, models and versions as listed. */
  name: 200,
  field: 100,
  /** Upstream responses kept in memory by local mode. */
  upstreamEntries: 300,
} as const

/** §1.12 timeouts in milliseconds. Tests pass shorter ones through createBridge(). */
export const TIMEOUTS: Timeouts = {
  requestTimeout: 30_000,
  headersTimeout: 10_000,
  muxRequest: 2_000,
  muxConnectUsb: 3_000,
  muxConnectNetwork: 6_000,
  lockdownRequest: 5_000,
  lockdownTls: 5_000,
  probeTotal: 12_000,
  detailTotal: 15_000,
  domain: 3_000,
  devicectlScreenshot: 45_000,
  devicectlHelp: 5_000,
  plistBuddy: 2_000,
  xcodeSelect: 2_000,
  xcodebuildLicense: 5_000,
  ideviceinfo: 8_000,
  idevicescreenshot: 20_000,
  simctlList: 10_000,
  simctlScreenshot: 20_000,
  adbConnect: 1_000,
  adbRequest: 5_000,
  adbExec: 10_000,
  adbScreencap: 20_000,
  adbStartPoll: 8_000,
  adbNetworkConnect: 20_000,
  adbPair: 15_000,
  doctorCheck: 5_000,
  doctorSlowCheck: 10_000,
  doctorTotal: 12_000,
  logFirstByte: 10_000,
  logSilenceSwitch: 8_000,
  logBatch: 100,
  logHello: 30_000,
  upstream: 15_000,
  htmlRevalidate: 60_000,
  killGrace: 1_500,
  rescan: 5_000,
  retry: 10_000,
  banner: 3_000,
  portProbe: 2_000,
  toolsCache: 30_000,
  doctorCache: 30_000,
  active: 30_000,
}

/**
 * Device id shapes (§2.2). None allows a leading `-`, so an id can never be read as an
 * option by a tool, and none allows `/`, `..` or a space. Matching a shape is necessary,
 * never sufficient: the id must also be in the live device list, and the owning lane
 * comes from the registry, never from which pattern matched.
 */
export const ID = {
  ios: /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9a-f]{40})$/,
  sim: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
  /** An adb serial, or a Wi-Fi device reached over IPv6: `[fe80::1%en0]:5555` (§4.7). */
  android:
    /^(?:[A-Za-z0-9][\w.:-]{0,127}|\[[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){1,7}(?:%[\w-]{1,32})?\]:\d{1,5})$/,
} as const

export function isDeviceId(id: string): boolean {
  return ID.ios.test(id) || ID.sim.test(id) || ID.android.test(id)
}

/*
  Allowlists (T11). Every request the helper can send to a device is named here, and the
  clients refuse anything else; tests assert both the lists and the refusals. The
  "never" lists exist so a test can prove those requests are refused, not merely unused.
*/

/** The only lockdown requests a client may send. */
export const LOCKDOWN_REQUESTS = [
  'QueryType',
  'GetValue',
  'StartSession',
  'StopSession',
  'StartService',
] as const
/** The only lockdown services a client may start. */
export const LOCKDOWN_SERVICES = ['com.apple.syslog_relay'] as const
/** Lockdown requests that change pairing or device state: never sent. */
export const LOCKDOWN_NEVER = [
  'Pair',
  'Unpair',
  'ValidatePair',
  'SetValue',
  'RemoveValue',
  'EnterRecovery',
  'Activate',
] as const

/** The only usbmuxd messages a client may send. */
export const MUX_MESSAGES = [
  'ListDevices',
  'Listen',
  'ReadPairRecord',
  'ReadBUID',
  'Connect',
] as const
/** usbmuxd messages that write the Mac's pairing: never sent. */
export const MUX_NEVER = ['SavePairRecord', 'DeletePairRecord'] as const

/**
 * The only devicectl subcommands the helper runs. `info lockState` runs in --doctor only
 * (§3.6). Both are read-only; `capture screenshot -h` probes the same subcommand.
 */
export const DEVICECTL_COMMANDS = [
  ['device', 'capture', 'screenshot'],
  ['device', 'info', 'lockState'],
] as const

/**
 * The Android detail commands, in the order the page's androidDetail() takes their outputs.
 * Must equal DETAIL_COMMANDS.map(c => c.join(' ')) in src/features/device/backends/android.ts
 * (asserted by the page's contract test), so the helper's detail is byte-identical to WebUSB's.
 */
export const ADB_DETAIL = [
  ['getprop', 'getprop'],
  ['wmSize', 'wm size'],
  ['wmDensity', 'wm density'],
  ['battery', 'dumpsys battery'],
  ['df', 'df /data'],
  ['androidId', 'settings get secure android_id'],
] as const

/**
 * Every `exec:` service string the helper sends to adbd: constants only. The serial travels
 * in `host:transport:<serial>` alone, so no page input ever reaches a device command.
 */
export const ADB_EXEC: readonly string[] = [
  ...ADB_DETAIL.map(([, command]) => command),
  'getprop ro.product.model',
  'getprop ro.product.device',
  'getprop ro.build.version.release',
  'screencap -p',
  'logcat -v threadtime -T 200',
]

/**
 * Every row-blocker code the helper can send. The page's contract test checks each one has
 * DEVICE_HINTS wording, so a new code cannot ship without its hint.
 */
export const EMITTED_BLOCKERS = [
  'IOS_UNTRUSTED',
  'IOS_LOCKED',
  'IOS_LOCKDOWN_FAILED',
  'IOS_DEVELOPER_MODE_OFF',
  'XCODE_REQUIRED',
  'XCODE_SETUP_REQUIRED',
  'IOS_DDI_REQUIRED',
  'TOOL_MISSING',
  'ANDROID_UNAUTHORIZED',
  'ANDROID_OFFLINE',
  'ANDROID_RECOVERY',
] as const

/** Install commands named in TOOL_MISSING errors and in the banner. */
export const INSTALL = {
  adb: 'brew install --cask android-platform-tools',
  libimobiledevice: 'brew install libimobiledevice',
} as const
