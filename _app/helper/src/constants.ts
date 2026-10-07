import type { Timeouts } from './types'

/** What answers on 127.0.0.1: the page checks `health.name` before it trusts anything else. */
export const NAME = 'bauloc-device-bridge'
/** Semver of this file. The page shows it and compares it with the published file. */
export const VERSION = '1.4.0'
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
const GiB = 1024 * MiB

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
  /**
   * Request bodies: only the Wi-Fi routes read one, a small JSON object (§4.7). The release
   * upload is the one exception: it streams its body to GitHub and never holds it (§2.10).
   */
  body: KiB,
  /**
   * A release asset (§2.10): GitHub takes files under 2 GiB, so 2 147 483 647 bytes at most,
   * the same number XConsole checks before it asks.
   */
  releaseAsset: 2 * GiB - 1,
  /** GitHub's answer to an upload: a few KiB of JSON. A longer one is not read on. */
  githubAnswer: 64 * KiB,
  /** GitHub's own words in an error, as passed on to the page. */
  githubMessage: 300,
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
  /** Devices one Wi-Fi scan reports (§4.8). */
  nearby: 64,
  /** Devices one look at this computer's network reports (§4.9). */
  lanDevices: 256,
  /** Addresses one presence check covers: two /24 networks (§4.9). */
  lanTargets: 512,
  /** Presence sockets open at once (§4.9): a /24 in one go, far below Node's file limit. */
  lanSockets: 256,
  /**
   * adb tunnels open at once (§4.10), in all and per device. The page reads at most three
   * previews and two app icons at a time, beside a listing and an install; these leave room
   * for two tabs, and for the HTTP requests that share `maxConnections`.
   */
  tunnels: 32,
  tunnelsPerDevice: 16,
  /** One frame from the page: it sends at most 256 KiB at a time. */
  tunnelFrame: 4 * MiB,
  /** The tunnel's opening message, and the service it names (a command line). */
  tunnelHello: 64 * KiB,
  tunnelService: 32 * KiB,
  /** Features one `host:features` answer may list. */
  adbFeatures: 64,
} as const

/** §1.12 timeouts in milliseconds. Tests pass shorter ones through createBridge(). */
export const TIMEOUTS: Timeouts = {
  requestTimeout: 30_000,
  headersTimeout: 10_000,
  requestCheck: 30_000,
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
  tunnelHello: 10_000,
  adbNetworkConnect: 20_000,
  adbPair: 15_000,
  mdnsWindow: 2_000,
  systemBrowse: 1_500,
  systemResolve: 1_500,
  lanPresence: 1_000,
  lanSsdp: 3_000,
  lanDescription: 2_000,
  lanReverse: 1_200,
  lanScan: 7_000,
  lanCache: 30_000,
  lanGap: 3_000,
  githubIdle: 120_000,
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

/*
  Every device on this network (§4.9). What the helper asks the network is fixed here, and so
  is what a device's own answer may pass on to the page.
*/

/**
 * The presence check's one port: 9, discard. A host that is there answers a datagram to a
 * closed port with ICMP port unreachable; one that listens on it stays silent, which is as
 * harmless.
 */
export const LAN_PRESENCE_PORT = 9

/** The search targets of each SSDP M-SEARCH: every device and service, and every root device. */
export const LAN_SSDP_TARGETS = ['ssdp:all', 'upnp:rootdevice'] as const

/**
 * The only TXT keys a service passes on (§4.9): models, makers, the names owners give their
 * devices, HomeKit's category and Android's API level. Never an id, a serial, a key or an
 * address: `deviceid`, `id`, `pk`, `authTag`, `identifier`, `mac`, `UUID` and the rest stay out.
 */
export const LAN_TXT_KEYS = [
  'model',
  'md',
  'fn',
  'ty',
  'product',
  'usb_MFG',
  'usb_MDL',
  'mfg',
  'mdl',
  'am',
  'rpMd',
  'ci',
  'n',
  'given_name',
  'name',
  'api',
  'manufacturer',
  'friendly_name',
] as const

/**
 * Service types asked about on every look, besides those the network lists: Device Lab's
 * own. macOS's daemon leaves `_adb-tls-connect._tcp` out of its list of types even while it
 * knows a phone that advertises it [V 2026-10-04].
 */
export const LAN_STATIC_TYPES = [
  '_adb._tcp',
  '_adb-tls-connect._tcp',
  '_adb-tls-pairing._tcp',
  '_androidtvremote2._tcp',
  '_googlecast._tcp',
  '_apple-mobdev2._tcp',
  '_remotepairing._tcp',
] as const

/*
  Release assets for XConsole (§2.10, T25): the one request the helper sends off this computer
  on a page's behalf. Where it goes, and how, is fixed here; the page names only a release
  number and a file name.
*/

/** The only host that takes release assets. createBridge's `githubUploads` stands a fake in for tests. */
export const GITHUB_UPLOADS = 'https://uploads.github.com'
/** The site's own repository: the route has no way to name another. */
export const GITHUB_REPO = 'bauloc/bauloc.github.io'
/** Where every file GitHub stores in that repository's releases downloads from. */
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${GITHUB_REPO}/releases/download/`
/** The REST API version the upload is written against, sent with it. */
export const GITHUB_API_VERSION = '2022-11-28'
/** What a build may be sent as: an APK's own type, or plain bytes (what an IPA is served as). */
export const RELEASE_ASSET_TYPES = [
  'application/vnd.android.package-archive',
  'application/octet-stream',
] as const
