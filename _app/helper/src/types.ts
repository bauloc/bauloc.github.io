/*
  Types shared by every section of the helper. Nothing here exists at run time.

  Two kinds live here:
  - The wire protocol (§2.3 and §12c). The page mirrors it, with hand-written guards, in
    src/features/device/helper/protocol.ts: change both together, and within protocol 1
    only ever ADD fields, codes and endpoints.
  - The helper's internal seams (§1.4): the Lane interface every platform implements, the
    LaneContext the bridge hands each lane, and the options createBridge() takes.
*/
import type { ChildProcess } from 'node:child_process'
import type { RunTool, StreamTool } from './process'
import type { ToolOptions, Toolbox } from './tools'
import type { IosLaneFacts } from './ios-lane'
import type { AndroidLaneFacts } from './android-lane'
import type { SimulatorLaneFacts } from './simulator-lane'
import type { OpenMdnsTransport } from './mdns'
import type { FetchDescription, LanInterface, OpenPresence, OpenSsdp } from './lan-net'

/* ------------------------------------------------------------------ wire: devices --- */

/** A subset of the page's DeviceState: the helper never reports held, absent or busy. */
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

export type Connection = 'usb' | 'network' | 'simulator'

export interface Capabilities {
  screenshot: boolean
  identifiers: boolean
  logs: boolean
  install: false
}

export interface HelperDevice {
  /** UDID, simulator UUID or adb serial. Matches one of ID (constants). */
  id: string
  platform: 'ios' | 'android'
  connection: Connection
  state: HelperState
  /** At most 200 characters, control characters stripped; '' lets the page fall back. */
  name: string
  /** Marketing name when the helper knows it, else ''. */
  model: string
  /** ProductType, ro.product.device or the simulator's modelIdentifier. */
  modelId: string
  osVersion: string
  /** Blocker codes, most actionable first; every one is in EMITTED_BLOCKERS. */
  blockers: string[]
  capabilities: Capabilities
}

export type XcodeState =
  'ready' | 'not-installed' | 'not-selected' | 'needs-first-launch' | 'no-capture'

export interface IosLaneState {
  status: 'ok' | 'unavailable' | 'error'
  screenshots: 'devicectl' | 'none'
  xcode: XcodeState
  wifi: boolean
  wifiHidden: number
  reason?: string
}

export interface AndroidLaneState {
  status: 'ok' | 'off' | 'stopped' | 'error'
  adb: 'found' | 'missing'
  serverProtocol?: number
  startedByHelper: boolean
  reason?: string
}

export interface SimulatorsLaneState {
  status: 'ok' | 'off' | 'unavailable'
  booted: number
  reason?: string
}

export interface Lanes {
  ios: IosLaneState
  android: AndroidLaneState
  simulators: SimulatorsLaneState
}

export interface Snapshot {
  rev: number
  runId: string
  devices: HelperDevice[]
  lanes: Lanes
}

/* -------------------------------------------------------------- wire: health, detail --- */

export interface Health {
  name: string
  version: string
  protocol: number
  features: string[]
  port: number
  tokenId: string
  tokenPersistent: boolean
  runId: string
  startedAt: number
  local: boolean
  platform: string
  sha256: string
  proof?: string
}

export interface DetailOutputs {
  getprop: string
  wmSize: string
  wmDensity: string
  battery: string
  df: string
  androidId: string
}

export interface IosFacts {
  udid: string
  connection: 'usb' | 'network'
  source: 'lockdown' | 'ideviceinfo' | 'plaintext'
  device: {
    DeviceName?: string
    DeviceClass?: string
    ProductType?: string
    ProductVersion?: string
    BuildVersion?: string
    SerialNumber?: string
    HardwareModel?: string
    ModelNumber?: string
    RegionInfo?: string
    CPUArchitecture?: string
    TimeZone?: string
    /** Decimal string: it can exceed 2^53. */
    UniqueChipID?: string
  }
  battery?: {
    BatteryCurrentCapacity?: number
    BatteryIsCharging?: boolean
    ExternalConnected?: boolean
    FullyCharged?: boolean
  }
  disk?: {
    TotalDiskCapacity?: number
    TotalDataCapacity?: number
    TotalDataAvailable?: number
    AmountDataAvailable?: number
  }
  international?: { Language?: string; Locale?: string }
  /** null below iOS 16, or when unreadable. */
  developerMode: boolean | null
  /** The session's PasswordProtected: a passcode is required right now. */
  locked: boolean | null
  withheld: Array<'battery' | 'disk' | 'international' | 'developerMode'>
}

export interface SimFacts {
  udid: string
  name: string
  deviceType: { name: string; modelIdentifier: string }
  runtime: { name: string; version: string; build: string }
  state: 'Booted' | 'Booting'
  dataPathSize?: number
}

export type DetailResponse =
  | {
      platform: 'android'
      kind: 'android'
      serial: string
      connection: Connection
      outputs: DetailOutputs
    }
  | { platform: 'ios'; kind: 'ios'; facts: IosFacts }
  | { platform: 'ios'; kind: 'simulator'; facts: SimFacts }

export type ScreenshotSource = 'devicectl' | 'idevicescreenshot' | 'simctl' | 'adb'

/* ------------------------------------------------------------------ wire: logs, errors --- */

export type LogSource = 'syslog_relay' | 'idevicesyslog' | 'logcat' | 'simctl'

export type LogEndReason = 'eof' | 'device-gone' | 'client-gone' | 'replaced' | 'shutdown' | 'error'

export type LogMsg =
  | { t: 'hello'; device: string; source: LogSource; at: number }
  | { t: 'lines'; lines: string[] }
  | { t: 'notice'; text: string }
  | { t: 'ping'; at: number }
  | { t: 'end'; reason: LogEndReason; code?: string; message?: string }

export interface ErrorBody {
  error: {
    code: string
    /** Plain English, for codes the page has no wording for. */
    message: string
    tool?: string
    install?: string
    tokenId?: string
    state?: HelperState
    blockers?: string[]
    /** ANDROID_CONNECT_FAILED, ANDROID_PAIR_FAILED: why, for the page's wording (§4.7). */
    reason?: string
    /** …and what adb itself said, cleaned. */
    detail?: string
  }
}

/* ---------------------------------------------------------- wire: Wi-Fi (§4.7) --- */

/**
 * POST /api/android/connect {host, port?}: 200 once adb said "connected to" or "already
 * connected to". adb lists the device a moment later, usually `unauthorized` until the
 * device allows this Mac; the row is included once the tracker lists it.
 */
export interface AndroidConnectResult {
  result: 'connected' | 'already-connected'
  /** The network serial adb lists it under: `192.168.1.20:5555`, `[fe80::1%en0]:5555`. */
  serial: string
  /** adb's own words, cleaned: "connected to 192.168.1.20:5555". */
  message: string
  /** Its row once the tracker lists it, or null. */
  device: HelperDevice | null
}

/** POST /api/android/pair {host, port, code}: Wireless debugging's "Pair device with pairing code". */
export interface AndroidPairResult {
  result: 'paired'
  /** The pairing address, normalised. The device then offers its own connect port. */
  host: string
  port: number
  /** "Successfully paired to 192.168.1.20:37123 [guid=adb-…]". */
  message: string
}

/** POST /api/android/disconnect {serial}. */
export interface AndroidDisconnectResult {
  result: 'disconnected'
  serial: string
  /** "disconnected 192.168.1.20:5555". */
  message: string
}

/* ------------------------------------------------- wire: Wi-Fi discovery (§4.8) --- */

/**
 * How a device on the network offers adb, by the mDNS service it advertises:
 * - `adb`: `_adb._tcp`, plain Network debugging (a TV, `adb tcpip 5555`): connect to
 *   host:port directly;
 * - `wireless`: `_adb-tls-connect._tcp`, Android 11+ Wireless debugging: connect works only
 *   once this Mac is paired, otherwise the page offers pairing;
 * - `pairing`: `_adb-tls-pairing._tcp`, a pairing port open right now (the device shows
 *   "Pair device with pairing code"), for the pair step.
 */
export type NearbyKind = 'adb' | 'wireless' | 'pairing'

export interface AndroidNearbyDevice {
  /** `<kind>:<host:port>`, as networkSerial() writes the address: `adb:192.168.68.101:5555`. */
  id: string
  /** An address on the local network only, by the rules of POST /api/android/connect. */
  host: string
  port: number
  kind: NearbyKind
  /** The mDNS instance name, cleaned: `adb-b120be004010859`, `adb-55090DLAQ0026D-nK25Qn`. */
  instance: string
  /**
   * The device's own name: TXT `given_name=` ("BAULOC Pixel 9"), else Cast's `fn=`, else the
   * Android TV Remote's instance name, at the same address; '' when none.
   */
  name: string
  /** TXT `name=`, the model ("Pixel 9"), when advertised. */
  model?: string
  /** The Android version TXT `api=` stands for ("17" for api=37.1), when advertised and known. */
  osVersion?: string
  /** The serial the instance name carries, else TXT `serial=`, when there is one. */
  serial?: string
  /** The same address also advertises Android TV Remote or Google Cast. */
  tv: boolean
  /** adb lists it already: by this host:port, by its mDNS name, or by its serial (over USB too). */
  connected: boolean
  /** The id of its row in /api/devices, when `connected`. */
  deviceId?: string
  /**
   * `wireless` and `pairing` only: adb lists it over the network, which a Wireless-debugging
   * device allows only once paired. false means "not known to be paired", not "unpaired".
   */
  paired?: boolean
}

/** Why the helper's own scan could not run; adb's own list may still have found devices. */
export type NearbyFailure = 'blocked' | 'no-network' | 'failed'

/** GET /api/android/nearby[?refresh=1]. */
export interface AndroidNearbyResult {
  devices: AndroidNearbyDevice[]
  /** When the scan these devices come from started (epoch ms). */
  scannedAt: number
  error?: {
    reason: NearbyFailure
    /** One plain sentence and its fix, for a page with no wording of its own. */
    message: string
    /** What the socket said: "send EHOSTUNREACH 224.0.0.251:5353". */
    detail: string
  }
  /**
   * The helper's own queries could not leave, but the system's resolver (dns-sd, avahi)
   * looked instead, so the list is complete and there is no `error`. Connecting may still
   * fail for the same reason; a connect that does says so with its own `blocked` wording.
   */
  note?: {
    reason: NearbyFailure
    message: string
    detail: string
  }
}

/* ------------------------------------------- wire: every device on this network (§4.9) --- */

/**
 * How the helper came to know a device: `reply` the presence check (its port unreachable),
 * `neighbors` the neighbour (ARP) table, `mdns` a service it announces, `ssdp` its SSDP answer,
 * `reverse` the name the system's resolver gave its address, `gateway` the default route,
 * `self` this computer's own address.
 */
export type LanSource = 'reply' | 'neighbors' | 'mdns' | 'ssdp' | 'reverse' | 'gateway' | 'self'

export interface LanName {
  text: string
  source: 'mdns' | 'ssdp'
}

export interface LanService {
  /** `_ipp._tcp`, without `.local`. */
  type: string
  port?: number
  /** The instance name, cleaned; never one that carries a hardware address, a serial or an id. */
  name?: string
  /** Only the keys of LAN_TXT_KEYS. */
  txt?: Record<string, string>
}

/** The UPnP description a device pointed to in its SSDP answer, and that answer's SERVER. */
export interface LanUpnp {
  deviceType?: string
  friendlyName?: string
  manufacturer?: string
  modelName?: string
  modelNumber?: string
  server?: string
}

export interface LanDevice {
  /** An IPv4 address on the local network, as offerableAddress() writes it. */
  address: string
  self: boolean
  gateway: boolean
  /** `.local` names: SRV targets and reverse names, at most 4. */
  hostnames: string[]
  /** At most 8. */
  names: LanName[]
  /** At most 24. */
  services: LanService[]
  upnp?: LanUpnp
  /**
   * `A1B2C3`: the first three bytes of its hardware address, its maker's prefix, only when
   * that address is not a private one. The address itself is never sent.
   */
  maker?: string
  /** Whether its hardware address is a private (randomized) one; only when one was seen. */
  privateAddress?: boolean
  /** In the fixed order of LanSource. */
  found: LanSource[]
}

/** A network the helper looked at: of its `size` host addresses, `scanned` were covered. */
export interface LanNetwork {
  /** `en0` */
  interface: string
  /** This computer's own address on it. */
  address: string
  prefix: number
  size: number
  scanned: number
}

/** What could look on this computer. */
export interface LanSources {
  /** `off`: not run (Windows, or no network to check). */
  presence: 'ok' | 'blocked' | 'off'
  /** `hidden`: the table was read and listed nothing, as macOS 27 does for the helper. */
  neighbors: 'ok' | 'hidden' | 'none'
  resolver: 'dns-sd' | 'avahi' | 'none'
  ssdp: 'ok' | 'blocked'
}

/** GET /api/lan/devices[?refresh=1]. */
export interface LanResult {
  /** Gateway first, then by address; at most LIMITS.lanDevices. */
  devices: LanDevice[]
  networks: LanNetwork[]
  sources: LanSources
  /** When the look these devices come from started (epoch ms). */
  scannedAt: number
  durationMs: number
  /** More devices than LIMITS.lanDevices were found: only the first are here. */
  truncated?: boolean
  /** Nothing could look: why, and its fix (what was known anyway is still listed). */
  error?: { reason: NearbyFailure; message: string; detail: string }
  /** The helper's own packets could not leave, but the system's resolver listed devices. */
  note?: { reason: NearbyFailure; message: string; detail: string }
}

/* ------------------------------------------------------------- wire: preflight (§12c) --- */

export type PreflightStatus = 'ok' | 'warning' | 'blocking' | 'unchecked'

export type PreflightAction =
  'connect' | 'pair' | 'open-local' | 'reload' | 'start-adb' | 'retry' | 'recheck'

export type PreflightFix =
  | { kind: 'command'; command: string; note?: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'step'; text: string }
  | { kind: 'action'; action: PreflightAction; label: string }

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
  /** Android devices on the network, through the adb server (§4.7). */
  | 'android.wifi'
  | 'android.aab'
  | 'simulators'

export interface PreflightItem {
  id: string
  group: 'browser' | 'helper' | 'mac' | 'ios' | 'android' | 'device'
  /** Short noun phrase; may carry a version. */
  label: string
  status: PreflightStatus
  /** ONE plain sentence. */
  sentence: string
  /** 0–2, most direct first. */
  fixes: PreflightFix[]
  /** Facts such as a version, a path or server rows. Helper items only: paths are auth-gated. */
  detail?: string
  neededFor: Capability[]
  optional?: boolean
  deviceId?: string
}

/** The helper's own facts, the `helper` part of a DoctorReport minus what preflight detects. */
export interface HelperAbout {
  name: string
  version: string
  protocol: number
  node: string
  openssl: string
  platform: string
  arch: string
  port: number
  startedAt: number
  local: boolean
  tokenPersistent: boolean
  /** The command-line flags in effect; never a token. */
  flags: string[]
  sha256: string
}

export interface DoctorReport {
  helper: HelperAbout & { macos: string | null }
  lanes: Lanes
  /** Groups 'mac' | 'ios' | 'android', worded by the helper (§12b). */
  items: PreflightItem[]
  checkedAt: number
}

/* ------------------------------------------------------------ internal: lanes (§1.4) --- */

export type LaneName = 'ios' | 'android' | 'simulators'

/** §1.12, in milliseconds unless the name says otherwise. Tests shorten them. */
export interface Timeouts {
  /** HTTP: a request whose headers or body never finish. Never cuts a streaming response. */
  requestTimeout: number
  headersTimeout: number
  /** usbmuxd */
  muxRequest: number
  muxConnectUsb: number
  muxConnectNetwork: number
  /** lockdown */
  lockdownRequest: number
  lockdownTls: number
  probeTotal: number
  detailTotal: number
  domain: number
  /** Xcode and system tools */
  devicectlScreenshot: number
  devicectlHelp: number
  plistBuddy: number
  xcodeSelect: number
  xcodebuildLicense: number
  /** libimobiledevice */
  ideviceinfo: number
  idevicescreenshot: number
  /** simctl */
  simctlList: number
  simctlScreenshot: number
  /** adb host protocol */
  adbConnect: number
  adbRequest: number
  adbExec: number
  adbScreencap: number
  adbStartPoll: number
  /**
   * `host:connect:` (§4.7): the server dials the device, then waits up to 10 s for its
   * handshake; more than that here, so adb's own answer arrives before ours.
   */
  adbNetworkConnect: number
  adbPair: number
  /** One mDNS scan for devices on the network (§4.8): how long answers are collected. */
  mdnsWindow: number
  /** The same scan through the system's daemon (§4.8): how long `dns-sd -B` browses. */
  systemBrowse: number
  /** …and how long one `dns-sd -L` or `-G` may take (avahi-browse: browse + resolve). */
  systemResolve: number
  /** Every device on this network (§4.9): how long one presence socket waits for its answer. */
  lanPresence: number
  /** …how long SSDP answers are collected. */
  lanSsdp: number
  /** …one UPnP description document, connect to last byte. */
  lanDescription: number
  /** …one reverse name; the whole reverse step is cut at twice this. */
  lanReverse: number
  /** …the whole look, whatever each source does. */
  lanScan: number
  /** …how long a look answers GET /api/lan/devices without ?refresh=1. */
  lanCache: number
  /** …?refresh=1 starts a new look only this long after the last one started. */
  lanGap: number
  /** --doctor and /api/doctor */
  doctorCheck: number
  doctorSlowCheck: number
  doctorTotal: number
  /** Logs */
  logFirstByte: number
  logSilenceSwitch: number
  logBatch: number
  /** How long the HTTP layer waits for a lane to say hello before answering 504. */
  logHello: number
  /** Local mode */
  upstream: number
  htmlRevalidate: number
  /** SIGTERM → SIGKILL */
  killGrace: number
  /** Bounds on whole operations */
  rescan: number
  retry: number
  /** Startup */
  banner: number
  portProbe: number
  /** Caches */
  toolsCache: number
  doctorCache: number
  /** An authenticated request in this window makes the helper "active" (§1.3 cadences). */
  active: number
}

/**
 * Where a lane's log lines go. The HTTP layer owns batching, pings, the `end` record, the
 * stream caps and noticing that the client left; a lane only produces lines.
 */
export interface LogSink {
  /** Call once, before any line: until then an error is still an ordinary JSON error. */
  readonly hello: (source: LogSource) => void
  /** Lines are cleaned and capped again here. false = back-pressure: await drain(). */
  readonly push: (lines: string[]) => boolean
  readonly drain: () => Promise<void>
  /** A line for the tester, such as "Switched to idevicesyslog". */
  readonly notice: (text: string) => void
}

/**
 * One platform. Operations are plain functions, never methods leaning on `this`. Lanes
 * throw HelperError; a ToolError from ctx.runTool is mapped by the HTTP layer.
 */
export interface Lane<F = unknown> {
  readonly name: LaneName
  /** Begin watching (sockets, timers). Must not block and must not throw. */
  readonly start: () => void
  /** Close sockets, abort work, clear timers. ctx.signal has already aborted. */
  readonly stop: () => Promise<void>
  /** Re-list now (Refresh, R). The bridge bounds it at 5 s and aborts the signal then. */
  readonly rescan: (opts?: { signal?: AbortSignal }) => Promise<void>
  readonly detail: (id: string, signal: AbortSignal) => Promise<DetailResponse>
  readonly screenshot: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ png: Buffer; source: ScreenshotSource }>
  /** Resolves when the source ends. The signal aborts on client-gone, replaced, shutdown. */
  readonly logs: (id: string, sink: LogSink, signal: AbortSignal) => Promise<void>
  /** Re-check one device (read-only). The bridge bounds it at 10 s. */
  readonly retry: (id: string, signal: AbortSignal) => Promise<void>
  /** Read-only facts for preflight (§12). Cheap and synchronous. */
  readonly facts: () => F
  /** --doctor only: a read-only probe of each attached device, printed line by line. */
  readonly probeForDoctor?: (write: (line: string) => void) => Promise<void>
}

/**
 * The Android lane also starts Google's adb server (§4.5) and connects, pairs and
 * disconnects devices on the local network (§4.7), each on an explicit click only. The
 * HTTP layer validates the page's input (parseNetworkHost & co.) before calling these.
 */
export interface AndroidLane extends Lane<AndroidLaneFacts> {
  readonly startServer: (signal: AbortSignal) => Promise<void>
  readonly connectNetwork: (
    target: { host: string; port: number },
    signal: AbortSignal,
  ) => Promise<Omit<AndroidConnectResult, 'device'>>
  readonly pairNetwork: (
    target: { host: string; port: number; code: string },
    signal: AbortSignal,
  ) => Promise<Pick<AndroidPairResult, 'message'>>
  readonly disconnectNetwork: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<Pick<AndroidDisconnectResult, 'message'>>
  /**
   * §4.8: the Android devices advertising adb on the local network, read-only. A scan is
   * cached; `refresh` asks for a new one, which still runs at most one at a time and not
   * more often than the lane allows.
   */
  readonly nearby: (refresh: boolean, signal: AbortSignal) => Promise<AndroidNearbyResult>
}

export interface LaneSet {
  ios?: Lane<IosLaneFacts>
  android?: AndroidLane
  simulators?: Lane<SimulatorLaneFacts>
}

/** §4b tool discovery, cached 30 s. refresh() after the tester installs something. */
export interface ToolsCache {
  readonly get: () => Promise<Toolbox>
  readonly refresh: () => Promise<Toolbox>
}

/** What the bridge hands each lane. Everything a lane needs from outside comes through here. */
export interface LaneContext {
  /**
   * Replace the lane's rows. The registry diffs, bumps `rev` and prints transitions.
   * `departures`: why a row that leaves with this list left, by id ("disconnected"), for its
   * terminal line.
   */
  readonly publish: (
    lane: LaneName,
    rows: HelperDevice[],
    departures?: Readonly<Record<string, string>>,
  ) => void
  /** Merge into Lanes[lane]. */
  readonly setLane: <K extends LaneName>(lane: K, patch: Partial<Lanes[K]>) => void
  readonly tools: ToolsCache
  /**
   * runTool with cwd = workDir, childEnv() and --verbose timing filled in, already going
   * through the one-shot limiter (4 at a time): never wrap it in `limit`, which would wait
   * for a second slot while holding the first.
   */
  readonly runTool: RunTool
  /** streamTool with the same defaults. */
  readonly streamTool: StreamTool
  /**
   * The same 4-at-a-time limiter, for one-shot work that is not ctx.runTool (a tool spawned
   * some other way). Never around ctx.runTool.
   */
  readonly limit: <T>(fn: () => Promise<T>) => Promise<T>
  /** An authenticated request arrived in the last 30 s: run the §1.3 cadences. */
  readonly isActive: () => boolean
  /** One terminal line, timestamped by the bridge. Never tokens, headers or log text. */
  readonly log: (line: string) => void
  readonly timeouts: Timeouts
  /** This run's private directory (0700). Exists once the bridge listens or runs --doctor. */
  readonly workDir: string
  /** A fresh private subdirectory of workDir for one operation, removed afterwards. */
  readonly withTempDir: <T>(fn: (dir: string) => Promise<T>) => Promise<T>
  /** Aborts on shutdown. */
  readonly signal: AbortSignal
  readonly options: BridgeOptions
  readonly now: () => number
  /** process.env minus the variables that redirect device tools, plus NO_COLOR and `extra`. */
  readonly childEnv: (extra?: Record<string, string>) => NodeJS.ProcessEnv
}

export interface LaneFactories {
  ios?: ((ctx: LaneContext) => Lane<IosLaneFacts>) | null
  android?: ((ctx: LaneContext) => AndroidLane) | null
  simulators?: ((ctx: LaneContext) => Lane<SimulatorLaneFacts>) | null
}

/** What preflight (§12, WP4) gets from the bridge. */
export interface PreflightContext {
  readonly options: BridgeOptions
  readonly tools: ToolsCache
  readonly lanes: LaneSet
  readonly lanesState: () => Lanes
  readonly devices: () => HelperDevice[]
  readonly runTool: RunTool
  readonly timeouts: Timeouts
  readonly workDir: string
  readonly signal: AbortSignal
  readonly now: () => number
  readonly about: () => HelperAbout
  /** --doctor's Network section (§4.9); a context built by hand may leave it out. */
  readonly lan?: LanScanner
}

/* ------------------------------------------- internal: every device on this network --- */

/** What a look at this computer's network (§4.9) runs with: the bridge's own runners. */
export interface LanScanContext {
  readonly options: BridgeOptions
  readonly timeouts: Timeouts
  /** The bridge's runTool and streamTool: its cwd, environment and shutdown tracking. */
  readonly runTool: RunTool
  readonly streamTool: StreamTool
  /** Aborts on shutdown. A look runs on it, never on a request's signal. */
  readonly signal: AbortSignal
  readonly now: () => number
}

/** One look: the real scanLan() (lan.ts), or a test's whole fake network. */
export type ScanLan = (ctx: LanScanContext) => Promise<LanResult>

/** The bridge's one LAN scanner (lan.ts): cached, one look at a time, nothing in the background. */
export interface LanScanner {
  /** GET /api/lan/devices: `refresh` asks for a new look, within the cache's rules. */
  readonly devices: (refresh: boolean, signal: AbortSignal) => Promise<LanResult>
  /** --doctor: one look, printed without a device's name (T18). */
  readonly probeForDoctor: (write: (line: string) => void) => Promise<void>
  /** Shutdown: a look that ends after this is not kept. */
  readonly stop: () => void
}

/* --------------------------------------------------------------- internal: options --- */

/** §1.6. createBridge() fills every field it is not given. */
export interface BridgeOptions {
  /** 8787; 0 in tests. */
  port: number
  /** Generated when absent (or read from the kept file with keepToken). */
  token: string | undefined
  keepToken: boolean
  newToken: boolean
  home: string
  /** process.env.PATH. Relative entries are ignored by which(). */
  searchPath: string
  /** undefined = the §1.5 extra directories; tests pass [] so no real tool leaks in. */
  extraDirs: string[] | undefined
  platform: NodeJS.Platform
  arch: string
  nodeVersion: string
  opensslVersion: string
  getuid: (() => number) | undefined
  usbmuxdSocket: string
  adbPort: number
  tunneldPort: number
  upstream: string
  xcodeSelectPath: string
  plistBuddyPath: string
  javaHomePath: string
  openPath: string
  swVersPath: string
  applicationsDir: string
  coreDeviceDir: string
  coreSimulatorDir: string
  systemVersionPlist: string
  open: boolean
  wifi: boolean
  simulators: boolean
  android: boolean
  local: boolean
  dev: boolean
  verbose: boolean
  timeouts: Timeouts
  heartbeatMs: number
  now: () => number
  /** Terminal output (stdout), one line per call, no newline. */
  log: (line: string) => void
  /** Bugs and unexpected failures (stderr). */
  errorLog: (line: string) => void
  /** The environment tools inherit, and where ANDROID_HOME and friends are read. */
  env: NodeJS.ProcessEnv
  /** Where the per-run workDir is created ($TMPDIR). */
  tmpDir: string
  /** The file whose SHA-256 /api/health reports; defaults to this module's file. */
  selfPath: string | undefined
  /** Lane factories; tests replace them, null disables a lane. */
  lanes: LaneFactories
  /**
   * Tool discovery (§4b). Tests replace it with a fixed Toolbox so a lane can be exercised
   * with, say, a ready Xcode, before or without the real discovery.
   */
  resolveTools: (opts: ToolOptions) => Promise<Toolbox>
  /** The fetch local mode uses for the upstream; tests may inject one. */
  fetch: typeof fetch
  /**
   * How mDNS queries reach the network (§4.8): a UDP socket by default. Tests always replace
   * it, so the suite never sends a packet to a real network.
   */
  mdns: OpenMdnsTransport
  /**
   * The system resolver (§4.8). macOS: dns-sd at this fixed path, /usr/bin/dns-sd. Linux:
   * avahi-browse at this path, or looked up on PATH (and /usr/bin, /usr/local/bin unless
   * extraDirs says otherwise) when undefined. A path that is not there turns it off.
   */
  dnsSdPath: string
  avahiBrowsePath: string | undefined
  /*
    Every device on this network (§4.9). Each reaches the network or the system, so tests
    always replace them (harness.ts isolation(): no interface, sockets that send nothing,
    tools that are not there): the suite never sends a packet to a real network.
  */
  /** This computer's interfaces, from os.networkInterfaces(): the only networks looked at. */
  lanInterfaces: () => LanInterface[]
  /** The presence check: a connected UDP socket per address, one byte each. */
  lanPresence: OpenPresence
  /** SSDP's M-SEARCH socket. */
  lanSsdp: OpenSsdp
  /** The one HTTP request: a UPnP description, at the address that answered SSDP. */
  lanDescription: FetchDescription
  /** The neighbour table: macOS `/usr/sbin/arp -an`, Windows `%SystemRoot%\System32\ARP.EXE -a`. */
  arpPath: string
  /** Linux's neighbour table, read as a file: /proc/net/arp. */
  procNetArpPath: string
  /** Linux's routes, read as a file: /proc/net/route (the default gateway). */
  procNetRoutePath: string
  /** The default gateway: macOS `/sbin/route`, Windows `%SystemRoot%\System32\ROUTE.EXE`. */
  routePath: string
  /** Linux reverse names: avahi-resolve at this path, or looked up like avahi-browse. */
  avahiResolvePath: string | undefined
  /** The whole look; `helper:fake` and the page's tests replace it with a fake network. */
  lanScan: ScanLan
}

export type BridgeInput = Partial<Omit<BridgeOptions, 'timeouts' | 'lanes'>> & {
  timeouts?: Partial<Timeouts>
  lanes?: LaneFactories
}

/** Used by the process runner to let a bridge track only its own children. */
export type ChildSet = Set<ChildProcess>
