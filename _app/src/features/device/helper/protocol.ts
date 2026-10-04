/*
  The local helper's wire protocol (spec §2.3 and §12c), as the page reads it.

  The source of truth is the helper's own _app/helper/src/types.ts: change both together, and
  within protocol 1 only ever ADD fields, codes and endpoints. The page never trusts what it
  receives: every reply goes through a guard below that narrows unknown JSON field by field
  (no casts, no zod in the device chunk), caps every string, drops blocker codes that don't
  look like codes, and turns a state or enum value it doesn't know into a safe default, so a
  newer helper degrades into "unknown" instead of breaking the page.
*/

/* ---------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------- */

/** What answers on 127.0.0.1 must call itself before the page believes anything else it says. */
export const HELPER_NAME = 'bauloc-device-bridge'

/** The protocol majors this page talks to (§2.8). Outside the range: outdated or newer. */
export const DVC_MIN_AGENT = 1
export const DVC_MAX_AGENT = 1

/** The helper's default port, and the range a port must be in to be used at all. */
export const DEFAULT_PORT = 8787
export const isPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535

/** Optional extras a health reply may list (§2.8). Unknown ones are kept, never relied on. */
export type HelperFeature =
  | 'android.start-server'
  /** POST /api/android/connect, /pair and /disconnect: Android devices over Wi‑Fi. */
  | 'android.connect'
  /** GET /api/android/nearby: the Android devices that advertise debugging on the network. */
  | 'android.discover'
  | 'local'
  | 'simulators'
  | 'wifi'

/**
 * Device id shapes (§2.2), as the helper checks them. None starts with `-` or holds `/`, `..`
 * or a space; a row whose id fits none is dropped rather than sent back in a URL.
 */
export const DEVICE_ID = {
  ios: /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9a-f]{40})$/,
  sim: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
  /** An adb serial, or a Wi‑Fi device adb reached over IPv6: `[fe80::1%en0]:5555` (§4.7). */
  android:
    /^(?:[A-Za-z0-9][\w.:-]{0,127}|\[[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){1,7}(?:%[\w-]{1,32})?\]:\d{1,5})$/,
} as const

export const isDeviceId = (id: string): boolean =>
  DEVICE_ID.ios.test(id) || DEVICE_ID.sim.test(id) || DEVICE_ID.android.test(id)

/** A blocker or error code: what the page may look up wording for. */
export const CODE = /^[A-Z0-9_]{1,40}$/

/** String caps, in characters. */
const CAP = {
  name: 200,
  field: 100,
  sentence: 1_000,
  command: 2_000,
  detail: 4_000,
  /** One getprop or dumpsys output: large, but never unbounded. */
  output: 1_048_576,
  /** One log line: the helper caps at 8 KiB plus a marker. */
  line: 16_384,
} as const

/** At most this many lines in one `lines` record; the helper sends 200. */
const MAX_LINES = 1_000

/* ---------------------------------------------------------------- *
 * Types (mirroring _app/helper/src/types.ts)
 * ---------------------------------------------------------------- */

/** A subset of model.ts's DeviceState: the helper never reports held, absent or busy. */
export type HelperState =
  | 'ready'
  | 'connecting'
  | 'authorizing'
  | 'locked'
  | 'unauthorized'
  | 'untrusted'
  | 'offline'
  | 'recovery'
  | 'unknown'

export type HelperConnectionKind = 'usb' | 'network' | 'simulator'

export interface HelperCapabilities {
  readonly screenshot: boolean
  readonly identifiers: boolean
  readonly logs: boolean
  readonly install: false
}

export interface HelperDevice {
  /** UDID, simulator UUID or adb serial; matches one of DEVICE_ID. */
  readonly id: string
  readonly platform: 'ios' | 'android'
  readonly connection: HelperConnectionKind
  readonly state: HelperState
  /** '' lets the page fall back to the model or the id. */
  readonly name: string
  /** The marketing name when the helper knows it. Always '' for iPhones: the page maps modelId. */
  readonly model: string
  /** ProductType, ro.product.device or the simulator's modelIdentifier. */
  readonly modelId: string
  readonly osVersion: string
  /** Codes, most actionable first. */
  readonly blockers: readonly string[]
  readonly capabilities: HelperCapabilities
}

export type XcodeState =
  'ready' | 'not-installed' | 'not-selected' | 'needs-first-launch' | 'no-capture'

export interface IosLaneState {
  readonly status: 'ok' | 'unavailable' | 'error'
  readonly screenshots: 'devicectl' | 'none'
  readonly xcode: XcodeState
  readonly wifi: boolean
  readonly wifiHidden: number
  readonly reason?: string
}

export interface AndroidLaneState {
  readonly status: 'ok' | 'off' | 'stopped' | 'error'
  readonly adb: 'found' | 'missing'
  readonly serverProtocol?: number
  readonly startedByHelper: boolean
  readonly reason?: string
}

export interface SimulatorsLaneState {
  readonly status: 'ok' | 'off' | 'unavailable'
  readonly booted: number
  readonly reason?: string
}

export interface Lanes {
  readonly ios: IosLaneState
  readonly android: AndroidLaneState
  readonly simulators: SimulatorsLaneState
}

export interface Snapshot {
  /** Restarts at 1 every run; bumped on any change to devices or lanes. */
  readonly rev: number
  /** Identifies the run: a restart with --keep-token keeps the token but not the runId. */
  readonly runId: string
  readonly devices: readonly HelperDevice[]
  readonly lanes: Lanes
}

export interface Health {
  readonly name: string
  readonly version: string
  readonly protocol: number
  readonly features: readonly string[]
  /** The port the helper is bound to. */
  readonly port: number
  /** 8 hex of SHA-256(token); '' when the reply didn't carry a valid one. */
  readonly tokenId: string
  /** Started with --keep-token: the pairing survives a restart. */
  readonly tokenPersistent: boolean
  readonly runId: string
  readonly startedAt: number
  /** Serves /device/ itself (local mode). */
  readonly local: boolean
  /** `${process.platform}-${process.arch}`, e.g. darwin-arm64. */
  readonly platform: string
  /** 64 hex of the helper file as loaded, for the update row. */
  readonly sha256: string
  /** base64url HMAC over this port and the page's challenge, when one was sent (§2.8). */
  readonly proof?: string
}

export interface DetailOutputs {
  readonly getprop: string
  readonly wmSize: string
  readonly wmDensity: string
  readonly battery: string
  readonly df: string
  readonly androidId: string
}

export type IosWithheld = 'battery' | 'disk' | 'international' | 'developerMode'

export interface IosFacts {
  readonly udid: string
  readonly connection: 'usb' | 'network'
  readonly source: 'lockdown' | 'ideviceinfo' | 'plaintext'
  readonly device: {
    readonly DeviceName?: string
    readonly DeviceClass?: string
    readonly ProductType?: string
    readonly ProductVersion?: string
    readonly BuildVersion?: string
    readonly SerialNumber?: string
    readonly HardwareModel?: string
    readonly ModelNumber?: string
    readonly RegionInfo?: string
    readonly CPUArchitecture?: string
    readonly TimeZone?: string
    /** A decimal string: an ECID can exceed 2^53. */
    readonly UniqueChipID?: string
  }
  readonly battery?: {
    readonly BatteryCurrentCapacity?: number
    readonly BatteryIsCharging?: boolean
    readonly ExternalConnected?: boolean
    readonly FullyCharged?: boolean
  }
  readonly disk?: {
    readonly TotalDiskCapacity?: number
    readonly TotalDataCapacity?: number
    readonly TotalDataAvailable?: number
    readonly AmountDataAvailable?: number
  }
  readonly international?: { readonly Language?: string; readonly Locale?: string }
  /** null below iOS 16, or when unreadable. */
  readonly developerMode: boolean | null
  /** A passcode is required right now (the session's PasswordProtected). */
  readonly locked: boolean | null
  readonly withheld: readonly IosWithheld[]
}

export interface SimFacts {
  readonly udid: string
  readonly name: string
  readonly deviceType: { readonly name: string; readonly modelIdentifier: string }
  readonly runtime: { readonly name: string; readonly version: string; readonly build: string }
  readonly state: 'Booted' | 'Booting'
  readonly dataPathSize?: number
}

export type DetailResponse =
  | {
      readonly platform: 'android'
      readonly kind: 'android'
      readonly serial: string
      readonly connection: HelperConnectionKind
      readonly outputs: DetailOutputs
    }
  | { readonly platform: 'ios'; readonly kind: 'ios'; readonly facts: IosFacts }
  | { readonly platform: 'ios'; readonly kind: 'simulator'; readonly facts: SimFacts }

export type ScreenshotSource = 'devicectl' | 'idevicescreenshot' | 'simctl' | 'adb'

export type LogSource = 'syslog_relay' | 'idevicesyslog' | 'logcat' | 'simctl'

export type LogEndReason = 'eof' | 'device-gone' | 'client-gone' | 'replaced' | 'shutdown' | 'error'

export type LogMsg =
  | {
      readonly t: 'hello'
      readonly device: string
      readonly source: LogSource
      readonly at: number
    }
  | { readonly t: 'lines'; readonly lines: readonly string[] }
  | { readonly t: 'notice'; readonly text: string }
  | { readonly t: 'ping'; readonly at: number }
  | {
      readonly t: 'end'
      readonly reason: LogEndReason
      readonly code?: string
      readonly message?: string
    }

export interface ErrorBody {
  readonly error: {
    readonly code: string
    /** Plain English, for codes the page has no wording for. */
    readonly message: string
    /** TOOL_MISSING */
    readonly tool?: string
    readonly install?: string
    /** UNAUTHORIZED: which run the helper is. */
    readonly tokenId?: string
    /** DEVICE_NOT_READY and the other 409s. */
    readonly state?: HelperState
    readonly blockers?: readonly string[]
    /** ANDROID_CONNECT_FAILED, ANDROID_PAIR_FAILED: why (refused, unreachable, wrong-code…). */
    readonly reason?: string
    /** …and what adb itself said, cleaned by the helper. */
    readonly detail?: string
  }
}

/* -- §12c preflight -- */

export type PreflightStatus = 'ok' | 'warning' | 'blocking' | 'unchecked'

export type PreflightAction =
  'connect' | 'pair' | 'open-local' | 'reload' | 'start-adb' | 'retry' | 'recheck'

export type PreflightFix =
  | { readonly kind: 'command'; readonly command: string; readonly note?: string }
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  | { readonly kind: 'step'; readonly text: string }
  | { readonly kind: 'action'; readonly action: PreflightAction; readonly label: string }

export type Capability =
  | 'helper'
  | 'ios.list'
  | 'ios.detail'
  | 'ios.screenshot'
  | 'ios.screenshot.legacy'
  | 'ios.logs'
  | 'ios.fallback'
  | 'android.webusb'
  | 'android.helper'
  | 'android.aab'
  | 'simulators'

export type PreflightGroup = 'browser' | 'helper' | 'mac' | 'ios' | 'android' | 'device'

export interface PreflightItem {
  readonly id: string
  readonly group: PreflightGroup
  /** A short noun phrase; may carry a version. */
  readonly label: string
  readonly status: PreflightStatus
  /** One plain sentence. */
  readonly sentence: string
  /** Most direct first. */
  readonly fixes: readonly PreflightFix[]
  /** Facts: a version, a path, server rows. */
  readonly detail?: string
  readonly neededFor: readonly Capability[]
  readonly optional?: boolean
  readonly deviceId?: string
}

export interface HelperAbout {
  readonly name: string
  readonly version: string
  readonly protocol: number
  readonly node: string
  readonly openssl: string
  readonly platform: string
  readonly arch: string
  readonly macos: string | null
  readonly port: number
  readonly startedAt: number
  readonly local: boolean
  readonly tokenPersistent: boolean
  /** The command-line flags in effect; never a token. */
  readonly flags: readonly string[]
  readonly sha256: string
}

export interface DoctorReport {
  readonly helper: HelperAbout
  readonly lanes: Lanes
  /** Groups mac, ios and android, worded by the helper (§12b). */
  readonly items: readonly PreflightItem[]
  readonly checkedAt: number
}

/* ---------------------------------------------------------------- *
 * Narrowing primitives
 * ---------------------------------------------------------------- */

type Json = Readonly<Record<string, unknown>>

export const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A string, cut to `max` characters; anything else is `fallback`. */
function str(value: unknown, max: number = CAP.field, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

/** A string when present and a string, else undefined (optional fields). */
function optStr(value: unknown, max: number = CAP.field): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function num(value: unknown, fallback = 0): number {
  return isNum(value) ? value : fallback
}

const optNum = (value: unknown): number | undefined => (isNum(value) ? value : undefined)

const optBool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** One of `allowed`, else `fallback`: a newer helper's new value reads as the safe default. */
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback
}

/** One of `allowed`, else null: for discriminants, where a default would be a lie. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((a) => a === value) ?? null
}

/** Codes only, so nothing else can reach a lookup table or the screen as a code. */
function codes(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((c): c is string => typeof c === 'string' && CODE.test(c)).slice(0, max)
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((s): s is string => typeof s === 'string')
    .slice(0, maxItems)
    .map((s) => s.slice(0, maxLength))
}

/** Only https links reach an href: a helper can't plant javascript: or a local file. */
const isHttpsUrl = (value: string) => /^https:\/\/[^\s"<>]+$/.test(value)

/* ---------------------------------------------------------------- *
 * Guards
 * ---------------------------------------------------------------- */

const HELPER_STATES: readonly HelperState[] = [
  'ready',
  'connecting',
  'authorizing',
  'locked',
  'unauthorized',
  'untrusted',
  'offline',
  'recovery',
  'unknown',
]
const CONNECTIONS: readonly HelperConnectionKind[] = ['usb', 'network', 'simulator']

/** A state the page knows, else `unknown` (the state model.ts's normalizeDevice falls back to). */
export const toHelperState = (value: unknown): HelperState => pick(value, HELPER_STATES, 'unknown')

/** /api/health. Only `name` and `protocol` are required: an outdated helper must still be told apart. */
export function parseHealth(value: unknown): Health | null {
  if (!isRecord(value)) return null
  if (typeof value.name !== 'string' || !isNum(value.protocol) || !Number.isInteger(value.protocol))
    return null
  const tokenId = str(value.tokenId, 8)
  const sha = str(value.sha256, 64)
  const proof = typeof value.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.proof)
  return {
    name: value.name.slice(0, CAP.field),
    version: str(value.version, 40),
    protocol: value.protocol,
    features: strings(value.features, 20, 40),
    port: isPort(value.port) ? value.port : 0,
    tokenId: /^[0-9a-f]{8}$/.test(tokenId) ? tokenId : '',
    tokenPersistent: value.tokenPersistent === true,
    runId: str(value.runId, 40),
    startedAt: num(value.startedAt),
    local: value.local === true,
    platform: str(value.platform, 40),
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : '',
    ...(proof && typeof value.proof === 'string' ? { proof: value.proof } : {}),
  }
}

/** One row. Null for a row the page can't use at all (no valid id, no platform). */
export function parseDevice(value: unknown): HelperDevice | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  if (!isDeviceId(id)) return null
  const platform = oneOf(value.platform, ['ios', 'android'] as const)
  if (!platform) return null
  const caps = isRecord(value.capabilities) ? value.capabilities : {}
  return {
    id,
    platform,
    connection: pick(value.connection, CONNECTIONS, 'usb'),
    state: toHelperState(value.state),
    name: str(value.name, CAP.name),
    model: str(value.model, CAP.name),
    modelId: str(value.modelId),
    osVersion: str(value.osVersion, 40),
    blockers: codes(value.blockers),
    capabilities: {
      screenshot: caps.screenshot === true,
      identifiers: caps.identifiers === true,
      logs: caps.logs === true,
      install: false,
    },
  }
}

/** Lane facts, field by field: whatever is missing or unknown reads as "not available". */
export function parseLanes(value: unknown): Lanes {
  const lanes = isRecord(value) ? value : {}
  const ios = isRecord(lanes.ios) ? lanes.ios : {}
  const android = isRecord(lanes.android) ? lanes.android : {}
  const sims = isRecord(lanes.simulators) ? lanes.simulators : {}
  const iosReason = optStr(ios.reason, CAP.sentence)
  const androidReason = optStr(android.reason, CAP.sentence)
  const simsReason = optStr(sims.reason, CAP.sentence)
  const serverProtocol = optNum(android.serverProtocol)
  return {
    ios: {
      status: pick(ios.status, ['ok', 'unavailable', 'error'], 'error'),
      screenshots: pick(ios.screenshots, ['devicectl', 'none'], 'none'),
      xcode: pick(
        ios.xcode,
        ['ready', 'not-installed', 'not-selected', 'needs-first-launch', 'no-capture'],
        'not-installed',
      ),
      wifi: ios.wifi === true,
      wifiHidden: Math.max(0, Math.trunc(num(ios.wifiHidden))),
      ...(iosReason === undefined ? {} : { reason: iosReason }),
    },
    android: {
      status: pick(android.status, ['ok', 'off', 'stopped', 'error'], 'error'),
      adb: pick(android.adb, ['found', 'missing'], 'missing'),
      ...(serverProtocol === undefined ? {} : { serverProtocol }),
      startedByHelper: android.startedByHelper === true,
      ...(androidReason === undefined ? {} : { reason: androidReason }),
    },
    simulators: {
      status: pick(sims.status, ['ok', 'off', 'unavailable'], 'off'),
      booted: Math.max(0, Math.trunc(num(sims.booted))),
      ...(simsReason === undefined ? {} : { reason: simsReason }),
    },
  }
}

/** GET /api/devices and POST /api/rescan. */
export function parseSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value) || !isNum(value.rev) || !Array.isArray(value.devices)) return null
  const devices: HelperDevice[] = []
  const seen = new Set<string>()
  for (const raw of value.devices) {
    const device = parseDevice(raw)
    if (device && !seen.has(device.id)) {
      seen.add(device.id)
      devices.push(device)
    }
  }
  return { rev: value.rev, runId: str(value.runId, 40), devices, lanes: parseLanes(value.lanes) }
}

/** POST /api/devices/:id/retry: the row after the re-check, or null when it has gone. */
export function parseRetry(value: unknown): { device: HelperDevice | null } | null {
  if (!isRecord(value) || !('device' in value)) return null
  return { device: value.device === null ? null : parseDevice(value.device) }
}

/** POST /api/android/start-server. */
export function parseStartServer(value: unknown): { android: AndroidLaneState } | null {
  if (!isRecord(value) || !isRecord(value.android)) return null
  return { android: parseLanes({ android: value.android }).android }
}

/*
  Android over Wi‑Fi (§4.7, feature `android.connect`): the helper asks Google's adb server to
  connect, pair or disconnect, on the tester's click. Failures come as ErrorBody (with
  `reason` and adb's own words in `detail`); these are the successes.
*/

/** POST /api/android/connect {host, port}. */
export interface ConnectReply {
  readonly result: 'connected' | 'already-connected'
  /** The serial adb lists it under: "192.168.1.20:5555", "[fe80::1%en0]:5555". */
  readonly serial: string
  /** Its row once the helper lists it (usually unauthorized first), or null. */
  readonly device: HelperDevice | null
}

/** POST /api/android/pair {host, port, code}. The device then offers its own connect port. */
export interface PairReply {
  readonly result: 'paired'
  readonly host: string
  readonly port: number
}

/** POST /api/android/disconnect {serial}. */
export interface DisconnectReply {
  readonly result: 'disconnected'
  readonly serial: string
}

export function parseConnectReply(value: unknown): ConnectReply | null {
  if (!isRecord(value)) return null
  const result = oneOf(value.result, ['connected', 'already-connected'] as const)
  const serial = typeof value.serial === 'string' ? value.serial : ''
  if (!result || !DEVICE_ID.android.test(serial)) return null
  return {
    result,
    serial,
    device: isRecord(value.device) ? parseDevice(value.device) : null,
  }
}

export function parsePairReply(value: unknown): PairReply | null {
  if (!isRecord(value) || value.result !== 'paired') return null
  const host = str(value.host, 260)
  const port = value.port
  if (!host || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return { result: 'paired', host, port }
}

export function parseDisconnectReply(value: unknown): DisconnectReply | null {
  if (!isRecord(value) || value.result !== 'disconnected') return null
  const serial = typeof value.serial === 'string' ? value.serial : ''
  return DEVICE_ID.android.test(serial) ? { result: 'disconnected', serial } : null
}

/*
  Discovery (feature `android.discover`, §4.8): what the helper heard on the local network over
  mDNS, plus what adb lists already. Nothing here is connected: the page offers each one, and
  the tester's click goes through connect or pair above.
*/

/**
 * What a device advertises: `adb` is `_adb._tcp` (a TV's Network debugging, `adb tcpip`),
 * `wireless` is `_adb-tls-connect._tcp` (Wireless debugging, on) and `pairing` is
 * `_adb-tls-pairing._tcp` (its "Pair device with pairing code" screen, open now).
 */
export type NearbyKind = 'adb' | 'wireless' | 'pairing'

export interface NearbyDevice {
  /** The helper's id for it, `<kind>:<host:port>`: unique in one answer. */
  readonly id: string
  readonly kind: NearbyKind
  /**
   * An address on the local network, as connect takes it: private, link-local or carrier-grade
   * NAT only (helper/network.ts checkHost). A device with no such address is never offered.
   */
  readonly host: string
  readonly port: number
  /** The mDNS instance name ("adb-55090DLAQ0026D-nK25Qn"), or ''. */
  readonly instance: string
  /** The adb serial the instance name carries ("55090DLAQ0026D"), or ''. */
  readonly serial: string
  /** What the device calls itself elsewhere on the network ("SONY KD-43X8050H"), or ''. */
  readonly name: string
  /** Its model, when something it advertises says so, or ''. */
  readonly model: string
  /** The same address also advertises Android TV Remote or Google Cast. */
  readonly tv: boolean
  /** adb lists it already (by address, mDNS name or serial, a cable too). */
  readonly connected: boolean
  /** Its row's id in the device list, when `connected` and the helper said. */
  readonly deviceId: string | null
  /**
   * `wireless` and `pairing`: adb lists it over the network, which Wireless debugging allows
   * only once paired. false is "not known to be paired", not "unpaired".
   */
  readonly paired: boolean
}

/**
 * Why the helper's own look couldn't run; adb's list may still have found devices. `blocked`:
 * this computer refused the mDNS query (a VPN, or macOS keeping the helper off the local
 * network), the same cause as a connect's `blocked` (§4.7). `no-network`: no interface is on a
 * network. `failed`: anything else.
 */
export type NearbyFailure = 'blocked' | 'no-network' | 'failed'

/** GET /api/android/nearby[?refresh=1]. */
export interface NearbyReply {
  readonly devices: readonly NearbyDevice[]
  /** When the look these devices come from started (ms since the epoch); 0 when not said. */
  readonly scannedAt: number
  readonly error?: {
    readonly reason: NearbyFailure
    /** The helper's sentence and its fix, for a reason the page has no words for. */
    readonly message: string
    /** What the socket said: "send EHOSTUNREACH 224.0.0.251:5353". */
    readonly detail: string
  }
}

/** At most this many devices from one answer: a network is never this busy. */
const MAX_NEARBY = 64

/** "adb-55090DLAQ0026D-nK25Qn" → "55090DLAQ0026D"; "adb-b120be004010859" → "b120be004010859". */
export function serialOfInstance(instance: string): string {
  const m = /^adb-([A-Za-z0-9]{4,64})(?:-[A-Za-z0-9]{1,16})?$/.exec(instance)
  return m?.[1] ?? ''
}

/** Controls, and the marks that reorder or hide text (bidi overrides, zero-width): never printed. */
function isVisible(char: string): boolean {
  const n = char.codePointAt(0) ?? 0
  return !(
    n < 0x20 ||
    (n >= 0x7f && n < 0xa0) ||
    (n >= 0x200b && n <= 0x200f) ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069)
  )
}

/** A name for the page to print: visible, single-line text only. */
const plain = (value: unknown, max: number) =>
  typeof value === 'string' ? Array.from(value).filter(isVisible).join('').trim().slice(0, max) : ''

function parseNearbyDevice(
  value: unknown,
  isLocal: (host: string) => string | null,
): NearbyDevice | null {
  if (!isRecord(value)) return null
  const kind = oneOf(value.kind, ['adb', 'wireless', 'pairing'] as const)
  const port = value.port
  if (!kind || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  const host = typeof value.host === 'string' ? isLocal(value.host) : null
  if (host === null) return null
  const instance = plain(value.instance, 128)
  const serial = plain(value.serial, 64)
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId : ''
  return {
    id: plain(value.id, 300) || `${kind}:${host}:${String(port)}`,
    kind,
    host,
    port,
    instance,
    serial: /^[A-Za-z0-9._-]{1,64}$/.test(serial) ? serial : serialOfInstance(instance),
    name: plain(value.name, CAP.name),
    model: plain(value.model, CAP.name),
    tv: value.tv === true,
    connected: value.connected === true,
    deviceId: isDeviceId(deviceId) ? deviceId : null,
    paired: kind !== 'adb' && value.paired === true,
  }
}

const NEARBY_FAILURES: readonly NearbyFailure[] = ['blocked', 'no-network', 'failed']

/**
 * GET /api/android/nearby. `isLocal` is helper/network.ts's checkHost, the normalised host or
 * null: the helper keeps only local addresses, and the page checks again, so a public or
 * loopback address never reaches a Connect button. A repeated id is dropped.
 */
export function parseNearby(
  value: unknown,
  isLocal: (host: string) => string | null,
): NearbyReply | null {
  if (!isRecord(value) || !Array.isArray(value.devices)) return null
  const devices: NearbyDevice[] = []
  const seen = new Set<string>()
  for (const raw of value.devices) {
    if (devices.length >= MAX_NEARBY) break
    const d = parseNearbyDevice(raw, isLocal)
    if (!d || seen.has(d.id)) continue
    seen.add(d.id)
    devices.push(d)
  }
  const e = isRecord(value.error) ? value.error : null
  const reason = e ? oneOf(e.reason, NEARBY_FAILURES) : null
  return {
    devices,
    scannedAt: Math.max(0, num(value.scannedAt)),
    ...(e
      ? {
          error: {
            reason: reason ?? 'failed',
            message: str(e.message, CAP.sentence),
            detail: str(e.detail, CAP.sentence),
          },
        }
      : {}),
  }
}

const IOS_DEVICE_KEYS = [
  'DeviceName',
  'DeviceClass',
  'ProductType',
  'ProductVersion',
  'BuildVersion',
  'SerialNumber',
  'HardwareModel',
  'ModelNumber',
  'RegionInfo',
  'CPUArchitecture',
  'TimeZone',
] as const

function iosFacts(value: unknown): IosFacts | null {
  if (!isRecord(value) || typeof value.udid !== 'string') return null
  const device: Record<string, string> = {}
  const raw = isRecord(value.device) ? value.device : {}
  for (const key of IOS_DEVICE_KEYS) {
    const v = optStr(raw[key], CAP.name)
    if (v !== undefined) device[key] = v
  }
  // Decimal digits only; a number is accepted from an older helper, as its decimal text.
  const ecid = raw.UniqueChipID
  if (typeof ecid === 'string' && /^\d{1,24}$/.test(ecid)) device.UniqueChipID = ecid
  else if (isNum(ecid) && Number.isInteger(ecid) && ecid >= 0) device.UniqueChipID = String(ecid)

  // Absent values stay `undefined` keys: the formatters treat both alike.
  const battery = isRecord(value.battery) ? value.battery : null
  const disk = isRecord(value.disk) ? value.disk : null
  const intl = isRecord(value.international) ? value.international : null
  const withheld = Array.isArray(value.withheld)
    ? value.withheld.flatMap((w) => {
        const one = oneOf(w, ['battery', 'disk', 'international', 'developerMode'] as const)
        return one ? [one] : []
      })
    : []
  return {
    udid: value.udid.slice(0, CAP.field),
    connection: pick(value.connection, ['usb', 'network'], 'usb'),
    source: pick(value.source, ['lockdown', 'ideviceinfo', 'plaintext'], 'plaintext'),
    device,
    ...(battery
      ? {
          battery: {
            BatteryCurrentCapacity: optNum(battery.BatteryCurrentCapacity),
            BatteryIsCharging: optBool(battery.BatteryIsCharging),
            ExternalConnected: optBool(battery.ExternalConnected),
            FullyCharged: optBool(battery.FullyCharged),
          },
        }
      : {}),
    ...(disk
      ? {
          disk: {
            TotalDiskCapacity: optNum(disk.TotalDiskCapacity),
            TotalDataCapacity: optNum(disk.TotalDataCapacity),
            TotalDataAvailable: optNum(disk.TotalDataAvailable),
            AmountDataAvailable: optNum(disk.AmountDataAvailable),
          },
        }
      : {}),
    ...(intl
      ? {
          international: { Language: optStr(intl.Language), Locale: optStr(intl.Locale) },
        }
      : {}),
    developerMode: boolOrNull(value.developerMode),
    locked: boolOrNull(value.locked),
    withheld,
  }
}

function simFacts(value: unknown): SimFacts | null {
  if (!isRecord(value) || typeof value.udid !== 'string') return null
  const type = isRecord(value.deviceType) ? value.deviceType : {}
  const runtime = isRecord(value.runtime) ? value.runtime : {}
  const size = optNum(value.dataPathSize)
  return {
    udid: value.udid.slice(0, CAP.field),
    name: str(value.name, CAP.name),
    deviceType: { name: str(type.name, CAP.name), modelIdentifier: str(type.modelIdentifier) },
    runtime: {
      name: str(runtime.name, CAP.name),
      version: str(runtime.version, 40),
      build: str(runtime.build, 40),
    },
    state: pick(value.state, ['Booted', 'Booting'], 'Booting'),
    ...(size === undefined ? {} : { dataPathSize: size }),
  }
}

/** GET /api/devices/:id/detail: raw facts, which the page formats. */
export function parseDetail(value: unknown): DetailResponse | null {
  if (!isRecord(value)) return null
  if (value.kind === 'android' && value.platform === 'android') {
    const outputs = isRecord(value.outputs) ? value.outputs : {}
    return {
      platform: 'android',
      kind: 'android',
      serial: str(value.serial, 128),
      connection: pick(value.connection, CONNECTIONS, 'usb'),
      outputs: {
        getprop: str(outputs.getprop, CAP.output),
        wmSize: str(outputs.wmSize, CAP.output),
        wmDensity: str(outputs.wmDensity, CAP.output),
        battery: str(outputs.battery, CAP.output),
        df: str(outputs.df, CAP.output),
        androidId: str(outputs.androidId, CAP.output),
      },
    }
  }
  if (value.kind === 'ios' && value.platform === 'ios') {
    const facts = iosFacts(value.facts)
    return facts ? { platform: 'ios', kind: 'ios', facts } : null
  }
  if (value.kind === 'simulator' && value.platform === 'ios') {
    const facts = simFacts(value.facts)
    return facts ? { platform: 'ios', kind: 'simulator', facts } : null
  }
  return null
}

const LOG_SOURCES: readonly LogSource[] = ['syslog_relay', 'idevicesyslog', 'logcat', 'simctl']
const END_REASONS: readonly LogEndReason[] = [
  'eof',
  'device-gone',
  'client-gone',
  'replaced',
  'shutdown',
  'error',
]

/** One NDJSON record of a log stream. Null for anything else (the reader skips it). */
export function parseLogMsg(value: unknown): LogMsg | null {
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'hello': {
      const source = oneOf(value.source, LOG_SOURCES)
      if (!source) return null
      return { t: 'hello', device: str(value.device, 128), source, at: num(value.at) }
    }
    case 'lines':
      return Array.isArray(value.lines)
        ? { t: 'lines', lines: strings(value.lines, MAX_LINES, CAP.line) }
        : null
    case 'notice':
      return typeof value.text === 'string'
        ? { t: 'notice', text: str(value.text, CAP.sentence) }
        : null
    case 'ping':
      return { t: 'ping', at: num(value.at) }
    case 'end': {
      const code = typeof value.code === 'string' && CODE.test(value.code) ? value.code : undefined
      const message = optStr(value.message, CAP.sentence)
      return {
        t: 'end',
        reason: pick(value.reason, END_REASONS, 'error'),
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
      }
    }
    default:
      return null
  }
}

/** The JSON error every non-2xx /api/* reply carries. */
export function parseErrorBody(value: unknown): ErrorBody | null {
  if (!isRecord(value) || !isRecord(value.error)) return null
  const e = value.error
  if (typeof e.code !== 'string' || !CODE.test(e.code)) return null
  const tool = optStr(e.tool)
  const install = optStr(e.install, CAP.command)
  const tokenId =
    typeof e.tokenId === 'string' && /^[0-9a-f]{8}$/.test(e.tokenId) ? e.tokenId : undefined
  const state = e.state === undefined ? undefined : toHelperState(e.state)
  return {
    error: {
      code: e.code,
      message: str(e.message, CAP.sentence),
      ...(tool === undefined ? {} : { tool }),
      ...(install === undefined ? {} : { install }),
      ...(tokenId === undefined ? {} : { tokenId }),
      ...(state === undefined ? {} : { state }),
      ...(Array.isArray(e.blockers) ? { blockers: codes(e.blockers) } : {}),
      ...(typeof e.reason === 'string' && /^[a-z-]{1,40}$/.test(e.reason)
        ? { reason: e.reason }
        : {}),
      ...(typeof e.detail === 'string' && e.detail ? { detail: str(e.detail, CAP.sentence) } : {}),
    },
  }
}

const PREFLIGHT_ACTIONS: readonly PreflightAction[] = [
  'connect',
  'pair',
  'open-local',
  'reload',
  'start-adb',
  'retry',
  'recheck',
]
const CAPABILITIES: readonly Capability[] = [
  'helper',
  'ios.list',
  'ios.detail',
  'ios.screenshot',
  'ios.screenshot.legacy',
  'ios.logs',
  'ios.fallback',
  'android.webusb',
  'android.helper',
  'android.aab',
  'simulators',
]
const GROUPS: readonly PreflightGroup[] = ['browser', 'helper', 'mac', 'ios', 'android', 'device']

function parseFix(value: unknown): PreflightFix | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'command': {
      if (typeof value.command !== 'string' || !value.command) return null
      const note = optStr(value.note, CAP.sentence)
      return {
        kind: 'command',
        command: value.command.slice(0, CAP.command),
        ...(note === undefined ? {} : { note }),
      }
    }
    case 'link': {
      const href = str(value.href, CAP.command)
      return isHttpsUrl(href)
        ? { kind: 'link', href, label: str(value.label, CAP.name, href) }
        : null
    }
    case 'step':
      return typeof value.text === 'string'
        ? { kind: 'step', text: str(value.text, CAP.sentence) }
        : null
    case 'action': {
      const action = oneOf(value.action, PREFLIGHT_ACTIONS)
      return action ? { kind: 'action', action, label: str(value.label, CAP.name) } : null
    }
    default:
      return null
  }
}

export function parsePreflightItem(value: unknown): PreflightItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[\w.:-]{1,200}$/.test(value.id))
    return null
  const group = oneOf(value.group, GROUPS)
  if (!group) return null
  const detail = optStr(value.detail, CAP.detail)
  const optional = optBool(value.optional)
  const deviceId =
    typeof value.deviceId === 'string' && isDeviceId(value.deviceId) ? value.deviceId : undefined
  return {
    id: value.id,
    group,
    label: str(value.label, CAP.name),
    status: pick(value.status, ['ok', 'warning', 'blocking', 'unchecked'], 'unchecked'),
    sentence: str(value.sentence, CAP.sentence),
    fixes: Array.isArray(value.fixes)
      ? value.fixes.flatMap((f) => {
          const fix = parseFix(f)
          return fix ? [fix] : []
        })
      : [],
    ...(detail === undefined ? {} : { detail }),
    neededFor: Array.isArray(value.neededFor)
      ? value.neededFor.flatMap((c) => {
          const cap = oneOf(c, CAPABILITIES)
          return cap ? [cap] : []
        })
      : [],
    ...(optional === undefined ? {} : { optional }),
    ...(deviceId === undefined ? {} : { deviceId }),
  }
}

/** GET /api/doctor. */
export function parseDoctor(value: unknown): DoctorReport | null {
  if (!isRecord(value) || !isRecord(value.helper) || !Array.isArray(value.items)) return null
  const h = value.helper
  return {
    helper: {
      name: str(h.name),
      version: str(h.version, 40),
      protocol: num(h.protocol),
      node: str(h.node, 40),
      openssl: str(h.openssl, 40),
      platform: str(h.platform, 40),
      arch: str(h.arch, 40),
      macos: typeof h.macos === 'string' ? h.macos.slice(0, 40) : null,
      port: isPort(h.port) ? h.port : 0,
      startedAt: num(h.startedAt),
      local: h.local === true,
      tokenPersistent: h.tokenPersistent === true,
      flags: strings(h.flags, 20, 40),
      sha256: /^[0-9a-f]{64}$/.test(str(h.sha256, 64)) ? str(h.sha256, 64) : '',
    },
    lanes: parseLanes(value.lanes),
    items: value.items.flatMap((i) => {
      const item = parsePreflightItem(i)
      return item ? [item] : []
    }),
    checkedAt: num(value.checkedAt),
  }
}
