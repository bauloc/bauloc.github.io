/**
 * §7 iOS lane: iPhones and iPads over usbmuxd and lockdown, in plain Node.
 *
 * - Listing and hot-plug come from usbmuxd's Listen socket; rows are keyed by UDID.
 * - A probe per device (§3.4) reads what lockdownd says before a session, checks the Mac's
 *   pair record, opens a TLS session with it, and derives the row (§3.10).
 * - Identifiers come only through whitelists (§3.5): IMEI, phone number, MAC addresses and
 *   every key not listed are never read out of a reply, let alone sent to the page.
 * - Screenshots use Xcode's real devicectl binary (never its first-launch wrapper), or
 *   idevicescreenshot for iOS 16 and older; logs use the phone's syslog_relay, or
 *   idevicesyslog when that is not possible.
 *
 * Everything here is read-only towards the phone: no Pair, no SetValue, no Developer Mode
 * toggle, no disk image mount, and ideviceinfo never runs without an existing pair record
 * (its handshake would show the Trust dialog).
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import path from 'node:path'
import { ID, INSTALL, LIMITS } from './constants'
import {
  LOCKDOWN_PORT,
  LockdownError,
  createLockdown,
  startTls,
  type Lockdown,
  type SessionInfo,
} from './lockdown'
import { asDict, parsePlist, type PlistValue } from './plist'
import { ToolError, type RunTool } from './process'
import type { Toolbox } from './tools'
import type {
  HelperDevice,
  IosFacts,
  Lane,
  LaneContext,
  LogSink,
  Timeouts,
  XcodeState,
} from './types'
import { createUsbmux, MuxError, type MuxDevice, type PairRecord, type Usbmux } from './usbmuxd'
import {
  HelperError,
  abortError,
  aborted,
  clean,
  createLimiter,
  errorText,
  isAbortError,
  linkSignals,
  singleFlight,
  sleep,
} from './util'

/** What preflight (§12) reads from the iOS lane. */
export interface IosLaneFacts {
  usbmuxd: 'ok' | 'missing' | 'error'
  /** One entry per distinct native TLS failure, for the `ios.session` item. */
  tlsFailures: Array<{ node: string; openssl: string; code: string }>
  devices: number
}

/* ------------------------------------------------------------------ whitelists --- */

/** §3.5: what a pre-session GetValue may contribute. Over USB it answers 26 keys [V]. */
export const PLAINTEXT_KEYS = [
  'DeviceName',
  'DeviceClass',
  'ProductType',
  'ProductVersion',
  'BuildVersion',
  'HardwareModel',
  'CPUArchitecture',
] as const

/** §3.5: what the session's default domain may contribute (UniqueChipID as a decimal string). */
export const SESSION_KEYS = [
  ...PLAINTEXT_KEYS,
  'SerialNumber',
  'ModelNumber',
  'RegionInfo',
  'TimeZone',
] as const

type Kind = 'number' | 'boolean' | 'string'

/** §3.5 domains for the detail, each with the only keys kept from it. */
export const DOMAINS = {
  battery: {
    domain: 'com.apple.mobile.battery',
    keys: {
      BatteryCurrentCapacity: 'number',
      BatteryIsCharging: 'boolean',
      ExternalConnected: 'boolean',
      FullyCharged: 'boolean',
    },
  },
  disk: {
    domain: 'com.apple.disk_usage',
    keys: {
      TotalDiskCapacity: 'number',
      TotalDataCapacity: 'number',
      TotalDataAvailable: 'number',
      AmountDataAvailable: 'number',
    },
  },
  international: {
    domain: 'com.apple.international',
    keys: { Language: 'string', Locale: 'string' },
  },
} as const satisfies Record<string, { domain: string; keys: Record<string, Kind> }>

/** Developer Mode lives here; the domain dumps as {} unless the key is named [V]. */
export const AMFI = { domain: 'com.apple.security.mac.amfi', key: 'DeveloperModeStatus' } as const

/** Lockdown refusals that mean "not now" for one domain: listed in `withheld`, not errors. */
const WITHHELD_CODES = new Set(['PasswordProtected', 'GetProhibited', 'MissingValue'])

type DeviceFacts = IosFacts['device']

/**
 * The whitelisted identity from one GetValue reply. Strings only, except UniqueChipID,
 * which becomes a decimal string because ECIDs exceed 2^53 (P10). Nothing else survives.
 */
export function whitelistDevice(
  value: PlistValue | undefined,
  phase: 'plaintext' | 'session',
): DeviceFacts {
  const dict = asDict(value)
  const out: DeviceFacts = {}
  if (!dict) return out
  for (const key of phase === 'plaintext' ? PLAINTEXT_KEYS : SESSION_KEYS) {
    const v = dict[key]
    if (typeof v === 'string') out[key] = clean(v, LIMITS.name)
  }
  const chip = dict.UniqueChipID
  if (phase === 'session' && (typeof chip === 'bigint' || typeof chip === 'number')) {
    out.UniqueChipID = chip.toString()
  }
  return out
}

/** The listed keys of one domain reply, each only with its expected type. */
function pickTyped<K extends string>(
  value: PlistValue | undefined,
  keys: Readonly<Record<K, Kind>>,
): Partial<Record<K, number | boolean | string>> | undefined {
  const dict = asDict(value)
  if (!dict) return undefined
  const out: Partial<Record<K, number | boolean | string>> = {}
  for (const key of Object.keys(keys) as K[]) {
    const v = dict[key]
    const want = keys[key]
    if (want === 'number' && typeof v === 'number') out[key] = v
    else if (want === 'number' && typeof v === 'bigint') out[key] = Number(v)
    else if (want === 'boolean' && typeof v === 'boolean') out[key] = v
    else if (want === 'string' && typeof v === 'string') out[key] = clean(v, LIMITS.field)
  }
  return out
}

/** The major iOS version, or 0 when unknown. */
export function iosMajor(version: string | undefined): number {
  const major = Number.parseInt(version ?? '', 10)
  return Number.isFinite(major) && major > 0 ? major : 0
}

/** usbmuxd also carries Apple TVs and Watches; the Device Lab lists phones and tablets. */
function isHandheld(device: DeviceFacts): boolean {
  const kind = device.DeviceClass ?? device.ProductType
  return kind === undefined || /^(?:iPhone|iPad|iPod)/.test(kind)
}

/* -------------------------------------------------------------------- entries --- */

export type IosStatus = 'ready' | 'untrusted' | 'authorizing' | 'locked' | 'offline' | 'unknown'

/** The probe state of one UDID that deriveIos() turns into a row (§3.10). */
export interface IosEntry {
  udid: string
  connection: 'usb' | 'network'
  /** A probe is running right now. */
  probing: boolean
  /** What the last probe concluded; null before one finished ("nothing known"). */
  status: IosStatus | null
  /** Why, for untrusted and offline: `pair-record:none`, `InvalidHostID`, `tls:reset`… */
  reason: string
  /** Where the identifiers came from once ready. */
  source: 'lockdown' | 'ideviceinfo' | 'plaintext' | null
  device: DeviceFacts
  developerMode: boolean | null
  /** The session's PasswordProtected: a passcode is required right now (AFU-locked). */
  locked: boolean | null
  /** idevicescreenshot could not start screenshotr: sticky until Retry. */
  ddiRequired: boolean
  /** devicectl said "not supported" (1001) for this device this run. */
  devicectlUnsupported: boolean
}

/** The tools as they bear on one iOS row. */
export interface IosTools {
  /** The Xcode state as screenshots see it (a broken capture command reads 'no-capture'). */
  xcode: XcodeState
  idevicescreenshot: boolean
  idevicesyslog: boolean
}

export const NO_IOS_TOOLS: IosTools = {
  xcode: 'not-installed',
  idevicescreenshot: false,
  idevicesyslog: false,
}

/** §3.7 for one row: can it take screenshots, and if not, which blocker says why. */
function screenshotGap(
  entry: IosEntry,
  tools: IosTools,
): { possible: boolean; blocker: string | null } {
  const legacy =
    iosMajor(entry.device.ProductVersion) > 0 && iosMajor(entry.device.ProductVersion) <= 16
  const devicectl = tools.xcode === 'ready' && !entry.devicectlUnsupported
  const fallback = legacy && tools.idevicescreenshot
  if (entry.ddiRequired) return { possible: false, blocker: 'IOS_DDI_REQUIRED' }
  if (devicectl || fallback) return { possible: true, blocker: null }
  if (legacy) return { possible: false, blocker: 'TOOL_MISSING' }
  /** devicectl answered "not supported" for this phone: no tool the tester could add helps. */
  if (entry.devicectlUnsupported) return { possible: false, blocker: null }
  return {
    possible: false,
    blocker: tools.xcode === 'needs-first-launch' ? 'XCODE_SETUP_REQUIRED' : 'XCODE_REQUIRED',
  }
}

const NOTHING = { screenshot: false, identifiers: false, logs: false, install: false } as const

/** §3.10: the row for one entry. The first matching case wins. */
export function deriveIos(entry: IosEntry, tools: IosTools = NO_IOS_TOOLS): HelperDevice {
  const base = {
    id: entry.udid,
    platform: 'ios' as const,
    connection: entry.connection,
    name: entry.device.DeviceName ?? '',
    model: '',
    modelId: entry.device.ProductType ?? '',
    osVersion: entry.device.ProductVersion ?? '',
  }
  const blocked = (state: HelperDevice['state'], blockers: string[]): HelperDevice => ({
    ...base,
    state,
    blockers,
    capabilities: { ...NOTHING },
  })
  switch (entry.status) {
    case null:
      return blocked('connecting', [])
    case 'untrusted':
      return blocked('untrusted', ['IOS_UNTRUSTED'])
    case 'authorizing':
      return blocked('authorizing', ['IOS_UNTRUSTED'])
    case 'locked':
      return blocked('locked', ['IOS_LOCKED'])
    case 'offline':
      return blocked('offline', ['IOS_LOCKDOWN_FAILED'])
    case 'unknown':
      return blocked('unknown', [])
    case 'ready': {
      const gap = screenshotGap(entry, tools)
      const blockers: string[] = []
      if (entry.source === 'plaintext') blockers.push('TOOL_MISSING')
      if (entry.developerMode === false) blockers.push('IOS_DEVELOPER_MODE_OFF')
      if (gap.blocker) blockers.push(gap.blocker)
      return {
        ...base,
        state: 'ready',
        blockers: [...new Set(blockers)],
        capabilities: {
          screenshot: gap.possible && entry.developerMode !== false,
          identifiers: true,
          logs:
            entry.source === 'lockdown' || (entry.source === 'ideviceinfo' && tools.idevicesyslog),
          install: false,
        },
      }
    }
  }
}

/* ------------------------------------------------------------------ devicectl --- */

function wrapped(value: unknown): string {
  if (typeof value === 'string') return value
  const dict = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  return typeof dict?.string === 'string' ? dict.string : ''
}

/**
 * §3.7: devicectl's verdict from its JSON envelope (written with --json-output) and exit
 * code, as the HelperError the page gets, or null for a success. `userInfo` values come
 * wrapped as {string} / {array} [V]. The lane reads two codes as "try something else":
 * SCREENSHOT_UNSUPPORTED (1001: next lane) and IOS_UNREACHABLE (4016: once more after 2 s).
 */
export function classifyDevicectl(envelope: unknown, exitCode: number | null): HelperError | null {
  const root = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {}
  const info = (root.info ?? {}) as Record<string, unknown>
  const error = (root.error ?? null) as Record<string, unknown> | null
  const outcome = typeof info.outcome === 'string' ? info.outcome : null
  if (exitCode === 0 && outcome === 'success' && !error) return null
  if (exitCode === 72) {
    return new HelperError('XCODE_REQUIRED', 503, 'Screenshots of this iPhone need Xcode.')
  }
  if (exitCode === 64) {
    return new HelperError(
      'XCODE_REQUIRED',
      503,
      "This Xcode's devicectl has no screenshot command; update Xcode.",
    )
  }
  if (outcome === 'timeout' || exitCode === 2) {
    return new HelperError('TOOL_TIMEOUT', 504, 'devicectl took too long to take the screenshot.')
  }
  const code = typeof error?.code === 'number' ? error.code : null
  const userInfo = (error?.userInfo ?? {}) as Record<string, unknown>
  const description = clean(wrapped(userInfo.NSLocalizedDescription), 500)
  if (code === 1000) {
    return new HelperError('DEVICE_NOT_FOUND', 404, 'Xcode does not see this iPhone.')
  }
  if (code === 1001) {
    return new HelperError(
      'SCREENSHOT_UNSUPPORTED',
      501,
      'Xcode cannot take screenshots of this device.',
    )
  }
  if (/locked/i.test(description)) {
    return new HelperError('IOS_LOCKED', 409, 'Unlock the iPhone, then take the screenshot again.')
  }
  if (/Developer Mode/i.test(description)) {
    return new HelperError(
      'IOS_DEVELOPER_MODE_OFF',
      409,
      'Developer Mode is off on this iPhone, so screenshots are off.',
    )
  }
  if (code === 4016) {
    return new HelperError('IOS_UNREACHABLE', 502, 'Xcode could not reach the iPhone.')
  }
  return new HelperError(
    'TOOL_FAILED',
    502,
    description || `devicectl failed (exit code ${String(exitCode)}).`,
  )
}

/**
 * Xcode 26 and newer install devicectl as a zsh wrapper that, when CoreDevice's version does
 * not match the one it expects, runs `xcodebuild -runFirstLaunch` (installing packages)
 * before the real binary [V]. Tool discovery hands lanes the real binary; this is the last
 * check before running one, so the helper never installs anything by accident.
 */
export function isFirstLaunchWrapper(file: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(64 * 1024)
    const read = readSync(fd, head, 0, head.length, 0)
    const text = head.subarray(0, read).toString('latin1')
    return text.startsWith('#!') && /runFirstLaunch|EXPECTED_VERSION/.test(text)
  } catch {
    /** Unreadable: treat it as unsafe, so it is not run. */
    return true
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/* ----------------------------------------------------------------- syslog_relay --- */

/** A message without a NUL after this many bytes is cut, so a broken stream cannot grow without bound. */
const MAX_CARRY = LIMITS.line * 4

function capLine(raw: string): string {
  const text = clean(raw, Number.MAX_SAFE_INTEGER)
  return text.length > LIMITS.line ? text.slice(0, LIMITS.line) + ' [truncated]' : text
}

function messageLines(bytes: Buffer, out: string[], cut = false): void {
  let text = bytes.toString('utf8')
  if (text.endsWith('\n')) text = text.slice(0, -1)
  const parts = text.split('\n')
  parts.forEach((part, i) => {
    const line = capLine(part)
    if (!line) return
    out.push(
      cut && i === parts.length - 1 && !line.endsWith(' [truncated]')
        ? line + ' [truncated]'
        : line,
    )
  })
}

/**
 * §3.8: syslog_relay sends each message followed by a NUL byte; a message ends with a
 * newline, and about 1 % carry inner newlines [V], which become continuation lines. Lines
 * are cleaned (no escapes, no control characters but tab) and capped at 8 KiB. `carry`
 * holds a message whose NUL has not arrived yet; splitting on the NUL byte keeps UTF-8
 * intact, because a NUL never occurs inside a multi-byte character.
 */
export function splitSyslogRelay(chunk: Buffer, carry: Buffer): { lines: string[]; carry: Buffer } {
  const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
  const lines: string[] = []
  let start = 0
  for (let nul = buffer.indexOf(0); nul >= 0; nul = buffer.indexOf(0, start)) {
    messageLines(buffer.subarray(start, nul), lines)
    start = nul + 1
  }
  const rest = buffer.subarray(start)
  if (rest.length > MAX_CARRY) {
    messageLines(rest, lines, true)
    return { lines, carry: Buffer.alloc(0) }
  }
  return { lines, carry: Buffer.from(rest) }
}

/* ---------------------------------------------------------------------- probe --- */

/** Timing the spec fixes (§3.2–§3.9); tests pass shorter values to createIosLane(). */
export interface IosTuning {
  /** Untrusted without a record: ReadPairRecord this often while active (§1.3). */
  pairPollMs: number
  /** Untrusted with a record, authorizing, locked or offline: a full probe this often while active. */
  reprobeMs: number
  /** A Wi-Fi-only entry is shown once it has stayed this long (--wifi)… */
  wifiStableMs: number
  /**
   * …and kept this long after usbmuxd says it left. usbmuxd lists an iPhone on Wi-Fi in
   * short stretches, each under a new DeviceID [V, 2026-10-04: an iPhone 12 Pro on iOS 27
   * over 15 minutes was listed for 1–133 s at a time, and away for 6–90 s between, once
   * 289 s]: 30 s dropped the row in half of those gaps.
   */
  wifiHoldMs: number
  /** While usbmuxd is away, rows are kept this long, then dropped. */
  muxGraceMs: number
  /** Lockdown unreachable this many times, `unreachableGapMs` apart → offline. */
  unreachableTries: number
  unreachableGapMs: number
  /** devicectl 4016: one more try after this. */
  devicectlRetryMs: number
  /** A new device is listed as "connecting" only if its probe takes longer than this. */
  connectingGraceMs: number
  /** A detail is reused for this long. */
  detailCacheMs: number
  /** Housekeeping cadence (cadences, Wi-Fi stability, grace periods). */
  tickMs: number
  reconnectMs: readonly number[]
  /** --doctor counts syslog_relay bytes for this long. */
  doctorSyslogMs: number
  /**
   * End the session when the phone's certificate is not the pair record's (G25). On since
   * Phase 0 (P0-6): an iPhone 12 Pro on iOS 27 presented exactly that certificate in three runs
   * out of three. It holds for every lockdown session and service handshake (probe, detail,
   * logs): a mismatch ends it, marks the row offline, and --doctor says why.
   */
  enforcePinning: boolean
}

export const IOS_TUNING: IosTuning = {
  pairPollMs: 3_000,
  reprobeMs: 5_000,
  wifiStableMs: 2_000,
  wifiHoldMs: 120_000,
  muxGraceMs: 10_000,
  unreachableTries: 3,
  unreachableGapMs: 1_000,
  devicectlRetryMs: 2_000,
  connectingGraceMs: 750,
  detailCacheMs: 5_000,
  tickMs: 250,
  reconnectMs: [1_000, 2_000, 4_000, 8_000, 10_000],
  doctorSyslogMs: 3_000,
  enforcePinning: true,
}

/** Which usbmuxd attachment to use for one device. */
interface Target {
  udid: string
  deviceId: number
  network: boolean
}

/** Everything one probe learned; the lane applies it, --doctor prints it. */
export interface ProbeReport {
  status: IosStatus
  reason: string
  source: IosEntry['source']
  device: DeviceFacts
  queryType: string | null
  plaintextKeys: number
  hasRecord: boolean | null
  /** 'ok', or lockdown's error string for StartSession. */
  session: string | null
  tls: { protocol: string | null; cipher: string | null; peerMatches: boolean | null } | null
  sessionKeys: number | null
  locked: boolean | null
  developerMode: boolean | null
  /** Why this Node could not do the handshake (ERR_SSL_…), for the `ios.session` item. */
  tlsFailure: string | null
  /** --doctor only: battery and disk, as key counts or lockdown's refusal. */
  domains: Record<string, string>
}

interface ProbeIo {
  mux: Usbmux
  timeouts: Timeouts
  tuning: IosTuning
  tools: () => Promise<Toolbox>
  runTool: RunTool
  /** Registers a closer run by stop(); returns its removal. */
  track: (close: () => void) => () => void
}

/** StartSession refusals and what they mean for the row (§3.4 step 5, §3.10). */
function sessionVerdict(code: string): IosStatus | 'tls-failed' {
  switch (code) {
    case 'InvalidHostID':
    case 'InvalidConnection':
    case 'UserDeniedPairing':
    case 'tls-reset':
      return 'untrusted'
    case 'PasswordProtected':
      return 'locked'
    case 'PairingDialogResponsePending':
      return 'authorizing'
    case 'tls-failed':
      return 'tls-failed'
    default:
      return 'offline'
  }
}

/** The row's reason for a StartSession refusal: the client's own codes read as `tls:…`. */
function sessionReason(code: string): string {
  if (code === 'tls-reset') return 'tls:reset'
  if (code === 'tls-pin') return 'tls:pin'
  return code
}

function connectTimeout(io: ProbeIo, target: Target): number {
  return target.network ? io.timeouts.muxConnectNetwork : io.timeouts.muxConnectUsb
}

/** A lockdown channel over a fresh usbmuxd pipe, closed when `signal` aborts. */
async function openLockdown(io: ProbeIo, target: Target, signal: AbortSignal): Promise<Lockdown> {
  const raw = await io.mux.connect(target.deviceId, LOCKDOWN_PORT, {
    timeoutMs: connectTimeout(io, target),
    signal,
  })
  const lockdown = createLockdown(raw, { timeouts: io.timeouts, pin: io.tuning.enforcePinning })
  const untrack = io.track(lockdown.close)
  const onAbort = (): void => lockdown.close()
  signal.addEventListener('abort', onAbort, { once: true })
  raw.once('close', () => {
    untrack()
    signal.removeEventListener('abort', onAbort)
  })
  return lockdown
}

async function readAmfi(lockdown: Lockdown, timeoutMs: number): Promise<boolean | null> {
  try {
    const value = await lockdown.getValue(AMFI.domain, AMFI.key, { timeoutMs })
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

/**
 * §3.4 steps 1–9 for one attachment. It never throws for something the phone said: every
 * outcome is a report. It throws only when aborted (detach, shutdown, the 12 s budget).
 */
export async function probeOnce(
  io: ProbeIo,
  target: Target,
  signal: AbortSignal,
  opts: { domains?: boolean } = {},
): Promise<ProbeReport> {
  const report: ProbeReport = {
    status: 'offline',
    reason: '',
    source: null,
    device: {},
    queryType: null,
    plaintextKeys: 0,
    hasRecord: null,
    session: null,
    tls: null,
    sessionKeys: null,
    locked: null,
    developerMode: null,
    tlsFailure: null,
    domains: {},
  }
  const done = (status: IosStatus, reason = ''): ProbeReport => {
    report.status = status
    report.reason = reason
    return report
  }

  /** Step 1: three tries, a second apart, before the phone counts as not answering. */
  let lockdown: Lockdown | null = null
  for (let attempt = 1; !lockdown; attempt++) {
    try {
      lockdown = await openLockdown(io, target, signal)
    } catch (error) {
      if (signal.aborted) throw abortError()
      if (attempt >= io.tuning.unreachableTries) {
        return done('offline', `connect:${error instanceof MuxError ? error.code : 'error'}`)
      }
      await sleep(io.tuning.unreachableGapMs, signal)
    }
  }
  try {
    report.queryType = await lockdown.queryType()
    if (report.queryType !== 'com.apple.mobile.lockdown') return done('unknown', 'query-type')
    const plain = await lockdown.getValue().catch(() => undefined)
    report.plaintextKeys = Object.keys(asDict(plain) ?? {}).length
    report.device = whitelistDevice(plain, 'plaintext')

    const record = await io.mux.readPairRecord(target.udid)
    report.hasRecord = record !== null
    if (!record) return done('untrusted', 'pair-record:none')

    let session: SessionInfo
    try {
      session = await lockdown.startSession(record)
    } catch (error) {
      if (signal.aborted) throw abortError()
      if (!(error instanceof LockdownError)) throw error
      report.session = error.code
      if (error.code === 'tls-pin')
        report.tls = { protocol: null, cipher: null, peerMatches: false }
      const verdict = sessionVerdict(error.code)
      if (verdict !== 'tls-failed') return done(verdict, sessionReason(error.code))
      report.tlsFailure = error.detail || error.code
      return await ideviceinfoProbe(io, target, report, signal)
    }
    report.session = 'ok'
    report.tls = session.tls
      ? { protocol: session.protocol, cipher: session.cipher, peerMatches: session.peerMatches }
      : null

    const all = await lockdown.getValue()
    report.sessionKeys = Object.keys(asDict(all) ?? {}).length
    report.device = { ...report.device, ...whitelistDevice(all, 'session') }
    const passcode = asDict(all)?.PasswordProtected
    report.locked = typeof passcode === 'boolean' ? passcode : null
    if (iosMajor(report.device.ProductVersion) >= 16) {
      report.developerMode = await readAmfi(lockdown, io.timeouts.domain)
    }
    if (opts.domains) {
      for (const [name, spec] of Object.entries(DOMAINS)) {
        try {
          const value = await lockdown.getValue(spec.domain, undefined, {
            timeoutMs: io.timeouts.domain,
          })
          const kept = pickTyped(value, spec.keys as Record<string, Kind>)
          report.domains[name] = `ok (${String(Object.keys(kept ?? {}).length)} keys kept)`
        } catch (error) {
          report.domains[name] = error instanceof LockdownError ? error.code : 'failed'
        }
      }
    }
    await lockdown.stopSession().catch(() => undefined)
    report.source = 'lockdown'
    return done('ready')
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError()
    if (error instanceof LockdownError || error instanceof MuxError) {
      return done('offline', `lockdown:${error.code}`)
    }
    throw error
  } finally {
    lockdown.close()
  }
}

/**
 * A probe that ended because the link went, not because the phone said something: offline for
 * any reason (no connect, lockdown's pipe closing mid-request), or a TLS handshake reset.
 */
export function linkCut(report: Pick<ProbeReport, 'status' | 'reason'>): boolean {
  if (report.reason === 'tls:pin') return false
  return report.status === 'offline' || report.reason === 'tls:reset'
}

/** ideviceinfo prints lockdown's refusals as text; these two decide the row (§3.4). */
function ideviceinfoVerdict(error: unknown): IosStatus | null {
  if (!(error instanceof ToolError)) return null
  const text = `${error.stderr}\n${String(error.stdout)}`
  if (/Invalid HostID|\(-21\)/i.test(text)) return 'untrusted'
  if (/Password protected|\(-17\)/i.test(text)) return 'locked'
  return null
}

function ideviceinfoArgs(target: Target, extra: string[]): string[] {
  return ['-u', target.udid, ...(target.network ? ['-n'] : []), ...extra, '-x']
}

/**
 * The TLS-failed path (§3.4): this Node could not do the handshake, so libimobiledevice's
 * own TLS stack reads the facts instead, if it is installed. It runs only here, after a
 * pair record was found: without one its handshake would ask the phone to trust the Mac.
 */
async function ideviceinfoProbe(
  io: ProbeIo,
  target: Target,
  report: ProbeReport,
  signal: AbortSignal,
): Promise<ProbeReport> {
  const tool = (await io.tools()).ideviceinfo?.path
  if (!tool) {
    report.status = 'ready'
    report.source = 'plaintext'
    return report
  }
  try {
    const { stdout } = await io.runTool(tool, ideviceinfoArgs(target, []), {
      timeoutMs: io.timeouts.ideviceinfo,
      signal,
    })
    const all = parsePlist(stdout)
    report.sessionKeys = Object.keys(asDict(all) ?? {}).length
    report.device = { ...report.device, ...whitelistDevice(all, 'session') }
    const passcode = asDict(all)?.PasswordProtected
    report.locked = typeof passcode === 'boolean' ? passcode : null
    if (iosMajor(report.device.ProductVersion) >= 16) {
      report.developerMode = await io
        .runTool(tool, ideviceinfoArgs(target, ['-q', AMFI.domain, '-k', AMFI.key]), {
          timeoutMs: io.timeouts.ideviceinfo,
          signal,
        })
        .then(({ stdout: out }) => {
          const value = parsePlist(out)
          return typeof value === 'boolean' ? value : null
        })
        .catch(() => null)
    }
    report.status = 'ready'
    report.source = 'ideviceinfo'
    return report
  } catch (error) {
    if (signal.aborted) throw abortError()
    const verdict = ideviceinfoVerdict(error)
    if (verdict) {
      report.status = verdict
      report.reason = verdict === 'untrusted' ? 'InvalidHostID' : 'PasswordProtected'
      return report
    }
    report.status = 'ready'
    report.source = 'plaintext'
    return report
  }
}

/* ----------------------------------------------------------------------- lane --- */

interface Live extends IosEntry {
  usbId: number | null
  networkId: number | null
  /** Aborts everything this device is doing: it left, or the helper stops. */
  abort: AbortController
  /** When its first probe began: a "connecting" row waits connectingGraceMs from here. */
  firstProbeAt: number | null
  /** First seen on Wi-Fi in this stretch; null while not on Wi-Fi. */
  networkSince: number | null
  /** --wifi: still shown until then after usbmuxd said it left. */
  heldUntil: number | null
  /** Listed once; until then a "connecting" row waits for connectingGraceMs. */
  shown: boolean
  /** Not an iPhone, iPad or iPod: never listed. */
  ignored: boolean
  hasRecord: boolean | null
  needsProbe: boolean
  polling: boolean
  lastPoll: number
  lastProbe: number
  pinLogged: boolean
  detail: { at: number; facts: IosFacts } | null
  /**
   * This entry's single-flight key for probes. A replugged phone gets a new entry, which must
   * not wait on the old entry's probe while that one is still unwinding.
   */
  flight: string
}

/** Session-holding work per device: at most two at once (§1.3). */
const SESSIONS_PER_DEVICE = 2

export function createIosLane(
  ctx: LaneContext,
  tuning: Partial<IosTuning> = {},
): Lane<IosLaneFacts> {
  const t: IosTuning = { ...IOS_TUNING, ...tuning }
  const { timeouts, options } = ctx
  const mux = createUsbmux({
    socketPath: options.usbmuxdSocket,
    timeouts,
    reconnectMs: t.reconnectMs,
  })
  const entries = new Map<string, Live>()
  const closers = new Set<() => void>()
  const probes = singleFlight()
  const details = singleFlight()
  let entrySerial = 0
  const sessionLimits = new Map<string, <T>(fn: () => Promise<T>) => Promise<T>>()
  const tlsFailures: IosLaneFacts['tlsFailures'] = []
  const wrapperChecks = new Map<string, boolean>()
  let toolbox: Toolbox | null = null
  let started = false
  let stopped = false
  /** 'pending' until Listen first answers or fails, so startup reports no false outage. */
  let mux_: 'pending' | 'ok' | 'missing' | 'error' = 'pending'
  let muxDownSince: number | null = null
  let muxReason: string | undefined
  /** devicectl exited 64 (no capture subcommand) this run: read as 'no-capture' until tools change. */
  let captureBroken = false
  let unwatch: () => void = () => undefined
  let ticker: NodeJS.Timeout | undefined
  let lastToolsCheck = 0

  const track = (close: () => void): (() => void) => {
    closers.add(close)
    return () => closers.delete(close)
  }
  const io: ProbeIo = {
    mux,
    timeouts,
    tuning: t,
    tools: () => ctx.tools.get(),
    runTool: ctx.runTool,
    track,
  }
  const sessions = (udid: string): (<T>(fn: () => Promise<T>) => Promise<T>) => {
    let limit = sessionLimits.get(udid)
    if (!limit) {
      limit = createLimiter(SESSIONS_PER_DEVICE)
      sessionLimits.set(udid, limit)
    }
    return limit
  }

  /* ----------------------------------------------------------------- tools --- */

  const wrapper = (file: string): boolean => {
    let known = wrapperChecks.get(file)
    if (known === undefined) {
      known = isFirstLaunchWrapper(file)
      wrapperChecks.set(file, known)
    }
    return known
  }

  /** The Xcode state as screenshots see it: discovery's verdict, then this run's own findings. */
  function xcodeState(box: Toolbox | null): XcodeState {
    const xcode = box?.xcode
    if (!xcode) return 'not-installed'
    if (xcode.state !== 'ready') return xcode.state
    if (captureBroken) return 'no-capture'
    if (!xcode.devicectl || wrapper(xcode.devicectl)) return 'needs-first-launch'
    return 'ready'
  }

  function iosTools(): IosTools {
    return {
      xcode: xcodeState(toolbox),
      idevicescreenshot: !!toolbox?.idevicescreenshot,
      idevicesyslog: !!toolbox?.idevicesyslog,
    }
  }

  async function loadTools(refresh = false): Promise<Toolbox> {
    const box = await (refresh ? ctx.tools.refresh() : ctx.tools.get())
    if (box !== toolbox) {
      if (refresh || box.xcode.devicectl !== toolbox?.xcode.devicectl) {
        captureBroken = false
        wrapperChecks.clear()
      }
      toolbox = box
      publish()
    }
    return box
  }

  /* ------------------------------------------------------------- publishing --- */

  /**
   * Whether an entry may be listed at all: a USB attachment, or (with --wifi) a Wi-Fi one
   * that has stayed 2 s or is being held after it left (§3.9). A row already listed is back
   * the moment usbmuxd re-adds it: the 2 s are for a phone first seen, not for each of its
   * returns (otherwise every return hid the row for 2 s).
   */
  function reachable(e: Live, now: number): boolean {
    if (e.ignored) return false
    if (e.usbId !== null) return true
    if (!options.wifi) return false
    if (e.heldUntil !== null) return true
    if (e.networkSince === null) return false
    return e.shown || now - e.networkSince >= t.wifiStableMs
  }

  function publish(): void {
    if (stopped || !started) return
    const now = ctx.now()
    const tools = iosTools()
    const rows: HelperDevice[] = []
    let wifiHidden = 0
    for (const e of entries.values()) {
      if (e.ignored) continue
      e.connection = e.usbId !== null ? 'usb' : 'network'
      if (!options.wifi && e.usbId === null && e.networkId !== null) wifiHidden++
      if (!reachable(e, now)) continue
      if (!e.shown) {
        const waiting = e.firstProbeAt === null || now - e.firstProbeAt < t.connectingGraceMs
        if (e.status === null && waiting) continue
        e.shown = true
      }
      rows.push(deriveIos(e, tools))
    }
    ctx.publish('ios', rows)
    ctx.setLane('ios', {
      ...(mux_ === 'pending' ? {} : { status: mux_ === 'ok' ? 'ok' : 'error' }),
      screenshots: tools.xcode === 'ready' ? 'devicectl' : 'none',
      xcode: tools.xcode,
      wifi: options.wifi,
      wifiHidden,
      reason: mux_ === 'ok' || mux_ === 'pending' ? undefined : muxReason,
    })
  }

  /* --------------------------------------------------------------- entries --- */

  function newEntry(udid: string): Live {
    return {
      udid,
      connection: 'usb',
      probing: false,
      status: null,
      reason: '',
      source: null,
      device: {},
      developerMode: null,
      locked: null,
      ddiRequired: false,
      devicectlUnsupported: false,
      usbId: null,
      networkId: null,
      abort: new AbortController(),
      firstProbeAt: null,
      networkSince: null,
      heldUntil: null,
      shown: false,
      ignored: false,
      hasRecord: null,
      needsProbe: false,
      polling: false,
      lastPoll: 0,
      lastProbe: 0,
      pinLogged: false,
      detail: null,
      flight: `${udid}#${String(++entrySerial)}`,
    }
  }

  function remove(e: Live): void {
    entries.delete(e.udid)
    sessionLimits.delete(e.udid)
    e.abort.abort()
  }

  function attach(device: MuxDevice): void {
    const udid = device.Properties.SerialNumber
    if (!ID.ios.test(udid)) return
    let e = entries.get(udid)
    if (!e) {
      e = newEntry(udid)
      entries.set(udid, e)
    }
    e.heldUntil = null
    if (device.Properties.ConnectionType === 'USB') {
      if (e.usbId === device.DeviceID) return
      e.usbId = device.DeviceID
      void probe(e)
    } else {
      if (e.networkId === device.DeviceID) return
      e.networkId = device.DeviceID
      e.networkSince ??= ctx.now()
      /** Wi-Fi presence flaps every few seconds [V]: probed once it has stayed (tick). */
      if (e.usbId === null) e.needsProbe = true
    }
  }

  function detach(deviceId: number): void {
    for (const e of entries.values()) {
      if (e.usbId === deviceId) {
        e.usbId = null
        /** §3.2: a USB detach removes the row at once (or leaves only its Wi-Fi presence). */
        if (e.networkId === null) remove(e)
        else {
          /** Whatever ran over the cable is gone with it; Wi-Fi gets a fresh probe. */
          e.abort.abort()
          e.abort = new AbortController()
          e.needsProbe = true
        }
      } else if (e.networkId === deviceId) {
        e.networkId = null
        e.networkSince = null
        if (e.usbId !== null) continue
        if (options.wifi && e.shown) e.heldUntil = ctx.now() + t.wifiHoldMs
        else remove(e)
      }
    }
  }

  function targetOf(e: Live): Target {
    const deviceId = e.usbId ?? e.networkId
    if (deviceId === null) {
      throw new HelperError(
        'IOS_UNREACHABLE',
        502,
        'The iPhone dropped off Wi-Fi for now. It usually comes back within a minute; a cable keeps it steady.',
      )
    }
    return { udid: e.udid, deviceId, network: e.usbId === null }
  }

  function entryFor(id: string): Live {
    const e = entries.get(id)
    if (!e || e.ignored) {
      throw new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.')
    }
    return e
  }

  function noteTlsFailure(code: string): void {
    if (tlsFailures.some((failure) => failure.code === code)) return
    tlsFailures.push({ node: options.nodeVersion, openssl: options.opensslVersion, code })
    ctx.log(
      `Node ${options.nodeVersion} (OpenSSL ${options.opensslVersion}) could not open an iPhone's secure session (${code})`,
    )
  }

  function apply(e: Live, report: ProbeReport): void {
    e.status = report.status
    e.reason = report.reason
    e.hasRecord = report.hasRecord ?? e.hasRecord
    e.device = { ...e.device, ...report.device }
    if (!isHandheld(e.device)) e.ignored = true
    if (report.status === 'ready') {
      e.source = report.source
      e.locked = report.locked
      e.developerMode = report.developerMode
    }
    if (report.tlsFailure) noteTlsFailure(report.tlsFailure)
    if (report.tls?.peerMatches === false) notePin(e)
  }

  /** Once per entry: the phone's certificate is not the pair record's (G25). */
  function notePin(e: Live): void {
    if (e.pinLogged) return
    e.pinLogged = true
    ctx.log(
      `${e.device.DeviceName ?? 'iPhone'}: its certificate differs from the pair record (${t.enforcePinning ? 'refused' : 'not enforced'})`,
    )
  }

  /** §3.4: single-flight per entry, its own abort, 12 s at most. */
  function probe(e: Live): Promise<void> {
    return probes.run(e.flight, async () => {
      if (stopped || entries.get(e.udid) !== e) return
      let target: Target
      try {
        target = targetOf(e)
      } catch {
        return
      }
      e.probing = true
      e.firstProbeAt ??= ctx.now()
      const op = linkSignals([ctx.signal, e.abort.signal], timeouts.probeTotal)
      try {
        const report = await sessions(e.udid)(() => probeOnce(io, target, op.signal))
        /**
         * usbmuxd re-adds a Wi-Fi phone for as little as a second, and often notices it left
         * only after the link died. A probe whose attachment went while it ran, or whose link
         * was cut under it (a refused connect, a dead pipe, a reset TLS handshake that reads
         * as "untrusted"), says nothing about the phone: it changes nothing, and the next
         * attachment is probed afresh. So a ready Wi-Fi row stays ready through anything but
         * the phone's own answer (InvalidHostID, PasswordProtected, a pending Trust dialog, a
         * missing pair record), whatever order Detached and the cut arrive in.
         */
        const left = target.network && e.networkId !== target.deviceId
        if (!left && !(target.network && e.status === 'ready' && linkCut(report))) {
          apply(e, report)
        }
      } catch (error) {
        if (!op.signal.aborted && !isAbortError(error)) {
          ctx.log(`iPhone probe failed: ${errorText(error)}`)
        }
        /** The 12 s budget ran out with nothing known: the phone is not answering. */
        if (!e.abort.signal.aborted && !ctx.signal.aborted && e.status === null) {
          e.status = 'offline'
          e.reason = 'probe:timeout'
        }
      } finally {
        op.dispose()
        e.probing = false
        e.lastProbe = ctx.now()
        /** The row's screenshot gap depends on the tools: read them (cached 30 s) first. */
        await loadTools().catch(() => undefined)
        publish()
      }
    })
  }

  async function pollRecord(e: Live): Promise<void> {
    if (e.polling) return
    e.polling = true
    e.lastPoll = ctx.now()
    try {
      if (await mux.readPairRecord(e.udid)) await probe(e)
    } catch {
      /** usbmuxd hiccup: the next tick polls again. */
    } finally {
      e.polling = false
    }
  }

  /** ListDevices after Listen (re)connects and on rescan: attach first, then drop the rest. */
  async function resync(): Promise<void> {
    const list = await mux.listDevices()
    const seen = new Set<number>()
    for (const device of list) {
      seen.add(device.DeviceID)
      attach(device)
    }
    for (const e of [...entries.values()]) {
      if (e.usbId !== null && !seen.has(e.usbId)) detach(e.usbId)
      if (e.networkId !== null && !seen.has(e.networkId)) detach(e.networkId)
    }
    publish()
  }

  function onMux(event: Parameters<Parameters<Usbmux['watch']>[0]>[0]): void {
    switch (event.type) {
      case 'listening':
        mux_ = 'ok'
        muxDownSince = null
        muxReason = undefined
        resync().catch((error: unknown) => {
          ctx.log(`usbmuxd ListDevices failed: ${errorText(error)}`)
        })
        return
      case 'disconnected':
        mux_ = event.error.code === 'missing' ? 'missing' : 'error'
        muxReason =
          event.error.code === 'missing'
            ? `there is no usbmuxd socket at ${options.usbmuxdSocket}`
            : undefined
        muxDownSince ??= ctx.now()
        publish()
        return
      case 'attached':
        attach(event.device)
        publish()
        return
      case 'detached':
        detach(event.deviceId)
        publish()
        return
      case 'paired':
        for (const e of entries.values()) {
          if (e.usbId === event.deviceId || e.networkId === event.deviceId) void probe(e)
        }
        return
    }
  }

  /** §1.3 cadences, Wi-Fi stability, grace periods: cheap, and only timed work while active. */
  function tick(): void {
    const now = ctx.now()
    let changed = false
    const active = ctx.isActive()
    if (active && now - lastToolsCheck >= 5_000) {
      lastToolsCheck = now
      void loadTools().catch(() => undefined)
    }
    for (const e of [...entries.values()]) {
      if (e.ignored) continue
      if (e.heldUntil !== null && now >= e.heldUntil) {
        remove(e)
        changed = true
        continue
      }
      if (!reachable(e, now)) continue
      if (!e.shown && e.firstProbeAt !== null && now - e.firstProbeAt >= t.connectingGraceMs) {
        changed = true
      }
      if (e.usbId === null) {
        if (e.heldUntil !== null) continue
        if (e.needsProbe && !e.probing) {
          e.needsProbe = false
          changed = true
          void probe(e)
          continue
        }
      }
      if (!active || e.probing) continue
      if (e.status === 'untrusted' && e.hasRecord === false) {
        if (now - e.lastPoll >= t.pairPollMs) void pollRecord(e)
      } else if (e.status !== 'ready' && e.status !== 'unknown' && e.status !== null) {
        /**
         * Revoked trust, a lock, a pending Trust dialog, or a phone that attached while still
         * booting (offline): all clear up on the phone, so look again every 5 s.
         */
        if (now - e.lastProbe >= t.reprobeMs) void probe(e)
      }
    }
    if (muxDownSince !== null && now - muxDownSince >= t.muxGraceMs && entries.size) {
      for (const e of [...entries.values()]) remove(e)
      changed = true
    }
    if (changed) publish()
  }

  /* ---------------------------------------------------------- sessions for ops --- */

  /** A trust or lock refusal during an operation updates the row and re-probes (§2.7). */
  function refusal(e: Live, status: IosStatus, reason: string): HelperError {
    e.status = status
    e.reason = reason
    publish()
    void probe(e)
    if (status === 'locked') {
      return new HelperError(
        'IOS_LOCKED',
        409,
        'The iPhone has not been unlocked since it restarted.',
        {
          state: 'locked',
          blockers: ['IOS_LOCKED'],
        },
      )
    }
    return new HelperError('IOS_UNTRUSTED', 409, 'This iPhone does not trust this Mac.', {
      state: status === 'authorizing' ? 'authorizing' : 'untrusted',
      blockers: ['IOS_UNTRUSTED'],
    })
  }

  /**
   * G25 during an operation: the phone (or something answering for it) presented a certificate
   * other than the pair record's. Nothing it said is used; the row goes offline until a probe
   * sees the paired phone again.
   */
  function pinRefused(e: Live): HelperError {
    e.status = 'offline'
    e.reason = 'tls:pin'
    e.detail = null
    notePin(e)
    publish()
    return new HelperError(
      'IOS_LOCKDOWN_FAILED',
      502,
      'The iPhone presented a certificate other than the one it was paired with, so the helper stopped talking to it.',
    )
  }

  /**
   * A lockdown or usbmuxd failure during an operation, as the page should see it: a trust or
   * lock refusal updates the row, anything else is IOS_UNREACHABLE and a fresh probe.
   */
  function sessionFailure(e: Live, error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) return abortError()
    if (error instanceof HelperError) return error
    if (!(error instanceof LockdownError) && !(error instanceof MuxError)) {
      return error instanceof Error ? error : new Error(String(error))
    }
    if (error.code === 'tls-pin') return pinRefused(e)
    const verdict = sessionVerdict(error.code)
    if (verdict === 'untrusted' || verdict === 'locked' || verdict === 'authorizing') {
      return refusal(e, verdict, sessionReason(error.code))
    }
    void probe(e)
    return new HelperError(
      'IOS_UNREACHABLE',
      502,
      `The iPhone did not answer (${errorText(error)}).`,
    )
  }

  interface OpenSession {
    lockdown: Lockdown
    session: SessionInfo
    record: PairRecord
    target: Target
  }

  /**
   * A session for one operation. Trust and lock refusals become the matching HelperError
   * (and update the row); a TLS failure is rethrown as LockdownError('tls-failed') for the
   * caller's fallback; a pinning mismatch is IOS_LOCKDOWN_FAILED; anything else is
   * IOS_UNREACHABLE.
   */
  async function openSession(e: Live, signal: AbortSignal): Promise<OpenSession> {
    const target = targetOf(e)
    let lockdown: Lockdown
    try {
      lockdown = await openLockdown(io, target, signal)
    } catch (error) {
      if (signal.aborted) throw abortError()
      void probe(e)
      throw new HelperError(
        'IOS_UNREACHABLE',
        502,
        `The iPhone did not answer (${errorText(error)}).`,
      )
    }
    try {
      const record = await mux.readPairRecord(e.udid)
      if (!record) {
        e.hasRecord = false
        throw refusal(e, 'untrusted', 'pair-record:none')
      }
      const session = await lockdown.startSession(record)
      return { lockdown, session, record, target }
    } catch (error) {
      lockdown.close()
      if (!signal.aborted && error instanceof LockdownError && error.code === 'tls-failed') {
        noteTlsFailure(error.detail || error.code)
        throw error
      }
      throw sessionFailure(e, error, signal)
    }
  }

  /** An operation's signal: the request's, the device's and shutdown's, plus a deadline. */
  function opSignal(e: Live, signal: AbortSignal, timeoutMs?: number) {
    return linkSignals([signal, e.abort.signal, ctx.signal], timeoutMs)
  }

  /** An aborted operation: the client left (null reply) or our own deadline (504). */
  function abortedError(signal: AbortSignal, what: string): Error {
    return signal.aborted
      ? abortError()
      : new HelperError('TOOL_TIMEOUT', 504, `The iPhone took too long to ${what}.`)
  }

  /* ------------------------------------------------------------------ detail --- */

  async function lockdownDetail(e: Live, signal: AbortSignal): Promise<IosFacts> {
    const s = await openSession(e, signal)
    try {
      const all = await s.lockdown.getValue()
      const device = { ...whitelistDevice(all, 'session') }
      const passcode = asDict(all)?.PasswordProtected
      const withheld: IosFacts['withheld'] = []
      const facts: IosFacts = {
        udid: e.udid,
        connection: s.target.network ? 'network' : 'usb',
        source: 'lockdown',
        device,
        developerMode: null,
        locked: typeof passcode === 'boolean' ? passcode : null,
        withheld,
      }
      for (const name of ['battery', 'disk', 'international'] as const) {
        const spec = DOMAINS[name]
        try {
          const value = await s.lockdown.getValue(spec.domain, undefined, {
            timeoutMs: timeouts.domain,
          })
          const kept = pickTyped(value, spec.keys as Record<string, Kind>)
          if (kept) Object.assign(facts, { [name]: kept })
        } catch (error) {
          if (error instanceof LockdownError && WITHHELD_CODES.has(error.code)) withheld.push(name)
        }
      }
      if (iosMajor(device.ProductVersion) >= 16) {
        try {
          const value = await s.lockdown.getValue(AMFI.domain, AMFI.key, {
            timeoutMs: timeouts.domain,
          })
          facts.developerMode = typeof value === 'boolean' ? value : null
        } catch (error) {
          if (error instanceof LockdownError && WITHHELD_CODES.has(error.code)) {
            withheld.push('developerMode')
          }
        }
      }
      await s.lockdown.stopSession().catch(() => undefined)
      return facts
    } catch (error) {
      /** The link dropped or lockdownd refused mid-session: never a raw LockdownError. */
      throw sessionFailure(e, error, signal)
    } finally {
      s.lockdown.close()
    }
  }

  async function ideviceinfoDetail(e: Live, signal: AbortSignal): Promise<IosFacts> {
    const tool = (await loadTools()).ideviceinfo?.path
    if (!tool) return plaintextFacts(e)
    const target = targetOf(e)
    const read = async (extra: string[]): Promise<PlistValue | undefined> => {
      const { stdout } = await ctx.runTool(tool, ideviceinfoArgs(target, extra), {
        timeoutMs: timeouts.ideviceinfo,
        signal,
      })
      return parsePlist(stdout)
    }
    let all: PlistValue | undefined
    try {
      all = await read([])
    } catch (error) {
      if (signal.aborted) throw abortError()
      const verdict = ideviceinfoVerdict(error)
      if (verdict)
        throw refusal(e, verdict, verdict === 'untrusted' ? 'InvalidHostID' : 'PasswordProtected')
      throw error
    }
    const device = whitelistDevice(all, 'session')
    const passcode = asDict(all)?.PasswordProtected
    const withheld: IosFacts['withheld'] = []
    const facts: IosFacts = {
      udid: e.udid,
      connection: target.network ? 'network' : 'usb',
      source: 'ideviceinfo',
      device,
      developerMode: null,
      locked: typeof passcode === 'boolean' ? passcode : null,
      withheld,
    }
    for (const name of ['battery', 'disk', 'international'] as const) {
      const spec = DOMAINS[name]
      try {
        const kept = pickTyped(await read(['-q', spec.domain]), spec.keys as Record<string, Kind>)
        if (kept) Object.assign(facts, { [name]: kept })
      } catch (error) {
        if (signal.aborted) throw abortError()
        if (ideviceinfoVerdict(error) === 'locked') withheld.push(name)
      }
    }
    if (iosMajor(device.ProductVersion) >= 16) {
      try {
        const value = await read(['-q', AMFI.domain, '-k', AMFI.key])
        facts.developerMode = typeof value === 'boolean' ? value : null
      } catch {
        if (signal.aborted) throw abortError()
      }
    }
    return facts
  }

  function plaintextFacts(e: Live): IosFacts {
    return {
      udid: e.udid,
      connection: e.connection,
      source: 'plaintext',
      device: { ...e.device },
      developerMode: e.developerMode,
      locked: null,
      withheld: [],
    }
  }

  async function detail(
    id: string,
    signal: AbortSignal,
  ): Promise<{ platform: 'ios'; kind: 'ios'; facts: IosFacts }> {
    const e = entryFor(id)
    const cached = e.detail
    if (cached && ctx.now() - cached.at < t.detailCacheMs) {
      return { platform: 'ios', kind: 'ios', facts: cached.facts }
    }
    const facts = await details.run(id, async () => {
      const op = opSignal(e, signal, timeouts.detailTotal)
      try {
        let result: IosFacts
        if (e.source === 'plaintext') result = plaintextFacts(e)
        else if (e.source === 'ideviceinfo') result = await ideviceinfoDetail(e, op.signal)
        else {
          try {
            result = await sessions(e.udid)(() => lockdownDetail(e, op.signal))
          } catch (error) {
            if (!(error instanceof LockdownError) || error.code !== 'tls-failed') throw error
            result = await ideviceinfoDetail(e, op.signal)
          }
        }
        e.detail = { at: ctx.now(), facts: result }
        /** The detail is the freshest read of these: the row follows it. */
        const before = JSON.stringify([e.developerMode, e.device])
        e.device = { ...e.device, ...result.device }
        if (result.developerMode !== null) e.developerMode = result.developerMode
        if (JSON.stringify([e.developerMode, e.device]) !== before) publish()
        return result
      } catch (error) {
        if (op.signal.aborted && !(error instanceof HelperError))
          throw abortedError(signal, 'answer')
        throw error
      } finally {
        op.dispose()
      }
    })
    return { platform: 'ios', kind: 'ios', facts }
  }

  /* -------------------------------------------------------------- screenshots --- */

  async function readJson(file: string): Promise<unknown> {
    try {
      const info = await stat(file)
      if (info.size > LIMITS.text) return null
      return JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch {
      return null
    }
  }

  async function readPng(file: string, what: string): Promise<Buffer> {
    try {
      const info = await stat(file)
      if (info.size > LIMITS.png) {
        throw new HelperError(
          'TOOL_FAILED',
          502,
          `${what} wrote an image larger than the helper accepts.`,
        )
      }
      return await readFile(file)
    } catch (error) {
      if (error instanceof HelperError) throw error
      throw new HelperError('TOOL_FAILED', 502, `${what} reported success but wrote no image.`)
    }
  }

  /** One devicectl capture (§3.7 lane 1), in its own private folder. */
  async function devicectlOnce(e: Live, box: Toolbox, signal: AbortSignal): Promise<Buffer> {
    const xcode = box.xcode
    const file = xcode.devicectl
    if (!file)
      throw new HelperError('XCODE_REQUIRED', 503, 'Screenshots of this iPhone need Xcode.')
    return ctx.withTempDir(async (dir) => {
      const png = path.join(dir, 'shot.png')
      const json = path.join(dir, 'out.json')
      const deviceTimeout = Math.max(5, Math.round(timeouts.devicectlScreenshot / 1000) - 5)
      let exitCode: number | null = 0
      try {
        await ctx.runTool(
          file,
          [
            'device',
            'capture',
            'screenshot',
            '--device',
            e.udid,
            '--destination',
            png,
            '--timeout',
            String(deviceTimeout),
            '--json-output',
            json,
          ],
          {
            timeoutMs: timeouts.devicectlScreenshot,
            signal,
            cwd: dir,
            env: ctx.childEnv(xcode.devDir ? { DEVELOPER_DIR: xcode.devDir } : {}),
            maxBytes: LIMITS.text,
          },
        )
      } catch (error) {
        if (!(error instanceof ToolError)) throw error
        if (error.reason === 'not-found') exitCode = 72
        else if (error.reason === 'exit') exitCode = error.code
        else throw error
      }
      if (exitCode === 64) {
        captureBroken = true
        publish()
      }
      if (exitCode === 72) void loadTools(true).catch(() => undefined)
      const verdict = classifyDevicectl(await readJson(json), exitCode)
      if (verdict) throw verdict
      return readPng(png, 'devicectl')
    })
  }

  async function devicectlShot(e: Live, box: Toolbox, signal: AbortSignal): Promise<Buffer> {
    try {
      return await devicectlOnce(e, box, signal)
    } catch (error) {
      if (!(error instanceof HelperError) || error.code !== 'IOS_UNREACHABLE') throw error
      await sleep(t.devicectlRetryMs, signal)
      return devicectlOnce(e, box, signal)
    }
  }

  /** §3.7 lane 2: iOS 16 and older, with a disk image already mounted. */
  async function idevicescreenshotShot(
    e: Live,
    tool: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const target = targetOf(e)
    return ctx.withTempDir(async (dir) => {
      const png = path.join(dir, 'shot.png')
      const ddi = (text: string): boolean => /screenshotr/i.test(text)
      const required = (): HelperError => {
        e.ddiRequired = true
        publish()
        return new HelperError(
          'IOS_DDI_REQUIRED',
          409,
          'Screenshots of this iPhone need its developer disk image mounted first.',
        )
      }
      let said: string
      try {
        const run = await ctx.runTool(
          tool,
          ['-u', target.udid, ...(target.network ? ['-n'] : []), png],
          { timeoutMs: timeouts.idevicescreenshot, signal, cwd: dir },
        )
        said = `${run.stdout}\n${run.stderr}`
      } catch (error) {
        if (error instanceof ToolError && error.reason === 'exit') {
          if (ddi(`${error.stderr}\n${String(error.stdout)}`)) throw required()
        }
        throw error
      }
      if (!existsSync(png) && ddi(said)) throw required()
      return readPng(png, 'idevicescreenshot')
    })
  }

  /** §3.7 lane 3: nothing applies, and the error names what would. */
  function nothingApplies(e: Live, box: Toolbox): HelperError {
    const legacy = iosMajor(e.device.ProductVersion) > 0 && iosMajor(e.device.ProductVersion) <= 16
    if (legacy) {
      return new HelperError(
        'TOOL_MISSING',
        503,
        'Screenshots of iOS 16 and older need libimobiledevice.',
        {
          tool: 'idevicescreenshot',
          install: INSTALL.libimobiledevice,
        },
      )
    }
    if (e.devicectlUnsupported) {
      return new HelperError(
        'SCREENSHOT_UNSUPPORTED',
        501,
        'Xcode cannot take screenshots of this device.',
      )
    }
    return xcodeState(box) === 'needs-first-launch'
      ? new HelperError(
          'XCODE_SETUP_REQUIRED',
          503,
          'Xcode must finish setting up before screenshots work.',
        )
      : new HelperError('XCODE_REQUIRED', 503, 'Screenshots of iOS 17 and newer need Xcode.')
  }

  async function screenshot(
    id: string,
    signal: AbortSignal,
  ): Promise<{ png: Buffer; source: 'devicectl' | 'idevicescreenshot' }> {
    const e = entryFor(id)
    const box = await loadTools()
    if (e.developerMode === false) {
      throw new HelperError(
        'IOS_DEVELOPER_MODE_OFF',
        409,
        'Developer Mode is off on this iPhone, so screenshots are off.',
      )
    }
    if (e.ddiRequired) {
      throw new HelperError(
        'IOS_DDI_REQUIRED',
        409,
        'Screenshots of this iPhone need its developer disk image mounted first.',
      )
    }
    const op = opSignal(e, signal)
    try {
      const legacy =
        iosMajor(e.device.ProductVersion) > 0 && iosMajor(e.device.ProductVersion) <= 16
      const fallback = legacy ? (box.idevicescreenshot?.path ?? null) : null
      if (xcodeState(box) === 'ready' && !e.devicectlUnsupported) {
        try {
          return { png: await devicectlShot(e, box, op.signal), source: 'devicectl' }
        } catch (error) {
          if (!(error instanceof HelperError)) throw error
          if (error.code === 'IOS_DEVELOPER_MODE_OFF') {
            e.developerMode = false
            publish()
          }
          if (error.code !== 'SCREENSHOT_UNSUPPORTED') throw error
          e.devicectlUnsupported = true
          publish()
          if (!fallback) throw error
        }
      }
      if (fallback) {
        return {
          png: await idevicescreenshotShot(e, fallback, op.signal),
          source: 'idevicescreenshot',
        }
      }
      throw nothingApplies(e, box)
    } finally {
      op.dispose()
    }
  }

  /* ---------------------------------------------------------------------- logs --- */

  /**
   * §3.8 lane 1: a session, StartService syslog_relay, a pipe to its port (TLS when asked),
   * then StopSession and close: the relay keeps streaming on its own connection. null means
   * "use the fallback": the service is missing, or this Node could not do TLS.
   */
  async function openSyslogRelay(e: Live, signal: AbortSignal): Promise<Socket | null> {
    let s: OpenSession
    try {
      s = await sessions(e.udid)(() => openSession(e, signal))
    } catch (error) {
      if (error instanceof LockdownError) return null
      throw error
    }
    try {
      let service: { port: number; ssl: boolean }
      try {
        service = await s.lockdown.startService('com.apple.syslog_relay')
      } catch (error) {
        if (error instanceof LockdownError && error.code === 'PasswordProtected') {
          throw new HelperError('IOS_LOCKED', 409, 'Unlock the iPhone, then start the log again.')
        }
        return null
      }
      let socket: Socket
      try {
        socket = await mux.connect(s.target.deviceId, service.port, {
          timeoutMs: connectTimeout(io, s.target),
          signal,
        })
      } catch {
        if (signal.aborted) throw abortError()
        return null
      }
      /** A stream that ends during the handshake must not leave the relay behind (§3.8). */
      const raw = socket
      const onAbort = (): void => {
        raw.destroy()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (service.ssl) {
          socket = (
            await startTls(socket, s.record, timeouts.lockdownTls, { pin: t.enforcePinning })
          ).socket
        }
      } catch (error) {
        if (signal.aborted) throw abortError()
        if (error instanceof LockdownError && error.code === 'tls-pin') throw pinRefused(e)
        if (error instanceof LockdownError && error.code === 'tls-failed') {
          noteTlsFailure(error.detail || error.code)
        }
        return null
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      await s.lockdown.stopSession().catch(() => undefined)
      if (signal.aborted) {
        socket.destroy()
        throw abortError()
      }
      return socket
    } finally {
      s.lockdown.close()
    }
  }

  /**
   * Reads the relay until it ends, with back-pressure. 'silent' when nothing arrived in the
   * first `logSilenceSwitch` and a fallback exists: the caller switches to idevicesyslog.
   */
  function pumpRelay(
    socket: Socket,
    sink: LogSink,
    signal: AbortSignal,
    canSwitch: boolean,
  ): Promise<'ended' | 'silent'> {
    return new Promise((resolve) => {
      /** An abort that came first would never fire the listener below. */
      if (signal.aborted) {
        socket.destroy()
        resolve('ended')
        return
      }
      const untrack = track(() => socket.destroy())
      let carry: Buffer = Buffer.alloc(0)
      let heard = false
      let outcome: 'ended' | 'silent' = 'ended'
      const silence = canSwitch
        ? setTimeout(() => {
            if (heard) return
            outcome = 'silent'
            socket.destroy()
          }, timeouts.logSilenceSwitch)
        : undefined
      const onAbort = (): void => {
        socket.destroy()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.on('data', (chunk: Buffer) => {
        heard = true
        const { lines, carry: rest } = splitSyslogRelay(chunk, carry)
        carry = rest
        if (lines.length && !sink.push(lines)) {
          socket.pause()
          void sink.drain().then(() => socket.resume())
        }
      })
      socket.on('error', () => undefined)
      socket.once('close', () => {
        clearTimeout(silence)
        signal.removeEventListener('abort', onAbort)
        untrack()
        if (carry.length && outcome === 'ended' && !signal.aborted) {
          const { lines } = splitSyslogRelay(Buffer.from([0]), carry)
          if (lines.length) sink.push(lines)
        }
        resolve(outcome)
      })
      sink.hello('syslog_relay')
      socket.resume()
    })
  }

  /**
   * §3.8 lane 2: `idevicesyslog -u <UDID> --no-colors -x [-n]`, its own TLS stack and service.
   * `[connected:…]` becomes a notice, `[disconnected:…]` ends the stream as device-gone, and
   * nothing within `logFirstByte` means the lane does not work for this phone.
   */
  function runIdevicesyslog(
    e: Live,
    tool: string,
    sink: LogSink,
    signal: AbortSignal,
    switched: boolean,
  ): Promise<void> {
    const target = targetOf(e)
    return new Promise<void>((resolve, reject) => {
      let started = switched
      let gone = false
      let firstByte: NodeJS.Timeout | undefined
      const handle = ctx.streamTool(
        tool,
        ['-u', target.udid, '--no-colors', '-x', ...(target.network ? ['-n'] : [])],
        {
          signal,
          onLines(lines) {
            if (!started) {
              started = true
              clearTimeout(firstByte)
              sink.hello('idevicesyslog')
            }
            const out: string[] = []
            for (const line of lines) {
              if (/^\[connected:/.test(line)) {
                if (!switched) sink.notice('Connected through idevicesyslog')
              } else if (/^\[disconnected:/.test(line)) {
                gone = true
                handle.kill()
              } else out.push(line)
            }
            if (out.length && !sink.push(out)) {
              handle.pause()
              void sink.drain().then(() => handle.resume())
            }
          },
        },
      )
      if (!started) {
        firstByte = setTimeout(() => {
          handle.kill()
        }, timeouts.logFirstByte)
      }
      handle.done.then(
        (result) => {
          clearTimeout(firstByte)
          if (signal.aborted) return reject(abortError())
          if (gone)
            return reject(new HelperError('DEVICE_NOT_FOUND', 404, 'The device disconnected.'))
          if (!started) {
            return reject(
              new HelperError(
                'LOGS_UNAVAILABLE',
                503,
                clean(result.stderr.trim(), 500) || 'idevicesyslog printed nothing.',
              ),
            )
          }
          resolve()
        },
        (error: unknown) => {
          clearTimeout(firstByte)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  /**
   * A log over Wi-Fi that ends without being asked to is a link that dropped: syslog_relay
   * and idevicesyslog never end on their own. The row stays (the hold), so without this the
   * stream would end as a plain `eof` and the page could not tell a drop from a finish.
   */
  function dropped(): HelperError {
    return new HelperError('DEVICE_DROPPED', 503, 'The iPhone dropped off Wi-Fi.')
  }

  async function logs(id: string, sink: LogSink, signal: AbortSignal): Promise<void> {
    const e = entryFor(id)
    const network = targetOf(e).network
    const op = opSignal(e, signal)
    try {
      const box = await loadTools()
      const fallback = box.idevicesyslog?.path ?? null
      if (e.source === 'lockdown') {
        const relay = await openSyslogRelay(e, op.signal)
        if (relay) {
          const outcome = await pumpRelay(relay, sink, op.signal, fallback !== null)
          if (op.signal.aborted) return
          if (outcome === 'ended') {
            if (network) throw dropped()
            return
          }
          sink.notice('Switched to idevicesyslog')
          if (fallback) await runIdevicesyslog(e, fallback, sink, op.signal, true)
          if (network && !op.signal.aborted) throw dropped()
          return
        }
      }
      if (fallback) {
        await runIdevicesyslog(e, fallback, sink, op.signal, false)
        if (network && !op.signal.aborted) throw dropped()
        return
      }
      throw new HelperError('LOGS_UNAVAILABLE', 503, 'No log source works for this iPhone.')
    } finally {
      op.dispose()
    }
  }

  /* --------------------------------------------------------------- --doctor --- */

  /**
   * --doctor (§1.9): a read-only probe of every attached iPhone, printed as facts: counts,
   * protocol names and yes/no. Never key material, log text, IMEI or phone numbers, and
   * not the device name either: this output is pasted into pull requests.
   */
  async function probeForDoctor(write: (line: string) => void): Promise<void> {
    const deadline = linkSignals([ctx.signal], timeouts.doctorTotal)
    const say = (line: string): void => write(line)
    try {
      try {
        await mux.readBuid()
        say('iPhone: usbmuxd answers')
      } catch (error) {
        say(
          `iPhone: usbmuxd is not answering (${error instanceof MuxError ? error.code : errorText(error)})`,
        )
        return
      }
      const list = await mux.listDevices()
      const byUdid = new Map<string, Target & { deviceIds: string[] }>()
      for (const device of list) {
        const udid = device.Properties.SerialNumber
        if (!ID.ios.test(udid)) continue
        const usb = device.Properties.ConnectionType === 'USB'
        const known = byUdid.get(udid)
        const label = `${usb ? 'USB' : 'Wi-Fi'} DeviceID ${String(device.DeviceID)}`
        if (!known)
          byUdid.set(udid, { udid, deviceId: device.DeviceID, network: !usb, deviceIds: [label] })
        else {
          known.deviceIds.push(label)
          if (usb) Object.assign(known, { deviceId: device.DeviceID, network: false })
        }
      }
      say(`iPhone: ${String(byUdid.size)} device(s) listed by usbmuxd`)
      for (const target of byUdid.values()) {
        if (deadline.signal.aborted) {
          say('  (stopped: the doctor ran out of time)')
          break
        }
        await doctorDevice(target, say, deadline.signal)
      }
    } finally {
      deadline.dispose()
    }
  }

  async function doctorDevice(
    target: Target & { deviceIds: string[] },
    say: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    say(`  ${target.udid} · ${target.deviceIds.join(' · ')}`)
    let report: ProbeReport
    try {
      report = await probeOnce(io, target, signal, { domains: true })
    } catch {
      say('    probe: did not finish')
      return
    }
    const yesNo = (value: boolean | null): string =>
      value === null ? 'unknown' : value ? 'yes' : 'no'
    const d = report.device
    say(
      `    model: ${d.ProductType ?? '?'} · ${d.DeviceClass ?? '?'} · iOS ${d.ProductVersion ?? '?'} (${d.BuildVersion ?? '?'})`,
    )
    say(
      `    QueryType: ${report.queryType ?? 'no answer'} · plaintext GetValue: ${String(report.plaintextKeys)} keys`,
    )
    say(`    pair record: ${yesNo(report.hasRecord)}`)
    say(`    StartSession: ${report.session ?? 'not tried'}`)
    if (report.tls) say(`    TLS: ${report.tls.protocol ?? '?'} ${report.tls.cipher ?? '?'}`)
    if (report.tlsFailure) say(`    TLS failed on this Node: ${report.tlsFailure}`)
    if (report.sessionKeys !== null) {
      say(
        `    session GetValue: ${String(report.sessionKeys)} keys · PasswordProtected ${yesNo(report.locked)}`,
      )
    }
    for (const [name, result] of Object.entries(report.domains)) say(`    ${name}: ${result}`)
    if (report.source === 'lockdown') {
      say(
        `    amfi DeveloperModeStatus: ${report.developerMode === null ? 'unreadable' : String(report.developerMode)}`,
      )
      say(
        `    peer certificate equals the pair record's DeviceCertificate: ${yesNo(report.tls?.peerMatches ?? null)}`,
      )
    }
    say(
      `    row: ${report.status}${report.reason ? ` (${report.reason})` : ''}${report.source ? ` · source ${report.source}` : ''}`,
    )
    if (report.source === 'lockdown') await doctorSyslog(target, say, signal)
    await doctorLockState(target, say, signal)
  }

  async function doctorSyslog(
    target: Target,
    say: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const e = newEntry(target.udid)
    if (target.network) e.networkId = target.deviceId
    else e.usbId = target.deviceId
    const op = linkSignals([signal], t.doctorSyslogMs + timeouts.lockdownRequest * 2)
    try {
      const socket = await openSyslogRelay(e, op.signal)
      if (!socket) {
        say('    syslog_relay: not available')
        return
      }
      let bytes = 0
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length
      })
      socket.on('error', () => undefined)
      socket.resume()
      await Promise.race([
        sleep(t.doctorSyslogMs, op.signal).catch(() => undefined),
        aborted(op.signal),
      ])
      socket.destroy()
      say(`    syslog_relay ${String(t.doctorSyslogMs / 1000)} s: ${String(bytes)} bytes`)
    } catch (error) {
      say(`    syslog_relay: ${error instanceof HelperError ? error.code : errorText(error)}`)
    } finally {
      op.dispose()
    }
  }

  /** devicectl `device info lockState`: --doctor only (§3.6), and only with a ready Xcode. */
  async function doctorLockState(
    target: Target,
    say: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const box = await loadTools().catch(() => null)
    if (!box || xcodeState(box) !== 'ready' || !box.xcode.devicectl) {
      say('    devicectl lockState: skipped (Xcode is not ready)')
      return
    }
    const file = box.xcode.devicectl
    const devDir = box.xcode.devDir
    try {
      const result = await ctx.withTempDir(async (dir) => {
        const json = path.join(dir, 'lock.json')
        await ctx.runTool(
          file,
          [
            'device',
            'info',
            'lockState',
            '--device',
            target.udid,
            '--timeout',
            '8',
            '--json-output',
            json,
          ],
          {
            timeoutMs: timeouts.doctorSlowCheck,
            signal,
            cwd: dir,
            env: ctx.childEnv(devDir ? { DEVELOPER_DIR: devDir } : {}),
          },
        )
        return readJson(json)
      })
      const value = (result as { result?: Record<string, unknown> } | null)?.result ?? {}
      say(
        `    devicectl lockState: passcodeRequired ${String(value.passcodeRequired)} · unlockedSinceBoot ${String(value.unlockedSinceBoot)}`,
      )
    } catch (error) {
      say(
        `    devicectl lockState: ${error instanceof ToolError ? error.reason : errorText(error)}`,
      )
    }
  }

  /* --------------------------------------------------------------- lifecycle --- */

  return {
    name: 'ios',
    start() {
      if (started) return
      started = true
      ticker = setInterval(tick, t.tickMs)
      ticker.unref()
      unwatch = mux.watch(onMux)
      void loadTools().catch(() => undefined)
    },
    async stop() {
      stopped = true
      unwatch()
      clearInterval(ticker)
      for (const e of entries.values()) e.abort.abort()
      for (const close of [...closers]) close()
      closers.clear()
      return Promise.resolve()
    },
    async rescan(opts = {}) {
      const signal = opts.signal ?? ctx.signal
      await loadTools().catch(() => undefined)
      await Promise.race([resync(), aborted(signal)])
      await Promise.race([
        Promise.allSettled([...entries.values()].filter((e) => !e.ignored).map((e) => probe(e))),
        aborted(signal),
      ])
    },
    detail,
    screenshot,
    logs,
    async retry(id, signal) {
      const e = entryFor(id)
      e.ddiRequired = false
      await Promise.race([Promise.allSettled([loadTools(true), probe(e)]), aborted(signal)])
    },
    facts: () => ({
      usbmuxd: mux_ === 'pending' ? (existsSync(options.usbmuxdSocket) ? 'ok' : 'missing') : mux_,
      tlsFailures: tlsFailures.map((failure) => ({ ...failure })),
      devices: [...entries.values()].filter((e) => e.shown && !e.ignored).length,
    }),
    probeForDoctor,
  }
}
