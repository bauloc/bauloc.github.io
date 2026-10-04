import { LIMITS, isDeviceId } from './constants'
import type { HelperDevice, HelperState, LaneName, Lanes, Snapshot } from './types'
import { clean, plural } from './util'

/** Lane order breaks ties when two lanes list one id (they never should). */
const LANE_ORDER: readonly LaneName[] = ['ios', 'android', 'simulators']

/** The page's STATE_WEIGHT order, so `curl /api/devices` reads the way the page sorts. */
const STATE_ORDER: Readonly<Record<HelperState, number>> = {
  ready: 10,
  connecting: 30,
  authorizing: 40,
  locked: 50,
  unauthorized: 60,
  untrusted: 60,
  offline: 70,
  recovery: 80,
  unknown: 90,
}

export interface RegistryChange {
  /** Ids that left the device list in this change. */
  removed: string[]
}

/**
 * The single source of truth for what the helper lists (§1.3). Lanes publish their whole
 * row list; the registry merges, sorts and serialises, bumps `rev` only when the JSON the
 * page sees changed, and prints one terminal line per transition.
 */
export interface Registry {
  /** `departures`: why a row that leaves with this list left, by id, for its `-` line. */
  readonly publish: (
    lane: LaneName,
    rows: HelperDevice[],
    departures?: Readonly<Record<string, string>>,
  ) => void
  readonly setLane: <K extends LaneName>(lane: K, patch: Partial<Lanes[K]>) => void
  readonly snapshot: () => Snapshot
  readonly lanes: () => Lanes
  readonly devices: () => HelperDevice[]
  readonly device: (id: string) => HelperDevice | null
  /** Which lane lists `id`: the only way an operation finds its lane. */
  readonly owner: (id: string) => LaneName | null
  /** An authenticated request arrived: the §1.3 cadences run while this is recent. */
  readonly touch: () => void
  readonly isActive: () => boolean
  readonly subscribe: (listener: (change: RegistryChange) => void) => () => void
}

/** Lanes before any lane has reported: off when not started, unavailable off macOS. */
export function initialLanes(opts: {
  platform: NodeJS.Platform
  wifi: boolean
  android: boolean
  simulators: boolean
}): Lanes {
  const darwin = opts.platform === 'darwin'
  return {
    ios: {
      status: 'unavailable',
      screenshots: 'none',
      xcode: 'not-installed',
      wifi: opts.wifi,
      wifiHidden: 0,
      ...(darwin ? {} : { reason: 'iPhones need macOS.' }),
    },
    android: opts.android
      ? { status: 'stopped', adb: 'missing', startedByHelper: false }
      : { status: 'off', adb: 'missing', startedByHelper: false },
    simulators:
      opts.simulators && darwin
        ? { status: 'unavailable', booted: 0 }
        : opts.simulators
          ? { status: 'unavailable', booted: 0, reason: 'Simulators need macOS.' }
          : { status: 'off', booted: 0 },
  }
}

/**
 * A row as the page may see it: text cleaned and capped (names come from devices), blocker
 * codes well-formed and unique, `install` always false in protocol 1. null for an id no
 * request could ever address: that is a lane bug, reported once and dropped.
 */
export function normalizeRow(row: HelperDevice): HelperDevice | null {
  if (typeof row.id !== 'string' || !isDeviceId(row.id)) return null
  return {
    id: row.id,
    platform: row.platform,
    connection: row.connection,
    state: row.state,
    name: clean(row.name, LIMITS.name),
    model: clean(row.model, LIMITS.field),
    modelId: clean(row.modelId, LIMITS.field),
    osVersion: clean(row.osVersion, LIMITS.field),
    blockers: [...new Set(row.blockers.filter((code) => /^[A-Z0-9_]{1,40}$/.test(code)))],
    capabilities: {
      screenshot: row.capabilities.screenshot === true,
      identifiers: row.capabilities.identifiers === true,
      logs: row.capabilities.logs === true,
      install: false,
    },
  }
}

function sortRows(rows: HelperDevice[]): HelperDevice[] {
  return rows.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/* ------------------------------------------------------------- terminal wording --- */

const IOS_WORDS: Readonly<Record<HelperState, string>> = {
  ready: 'trusted',
  connecting: 'connecting',
  authorizing: 'waiting for Trust',
  locked: 'locked since it restarted',
  unauthorized: 'waiting for Trust',
  untrusted: 'waiting for Trust',
  offline: 'not answering',
  recovery: 'in recovery',
  unknown: 'not answering as an iPhone',
}

const ANDROID_WORDS: Readonly<Record<HelperState, string>> = {
  ready: 'ready via adb',
  connecting: 'connecting',
  authorizing: 'waiting for "Allow USB debugging?"',
  locked: 'locked',
  unauthorized: 'waiting for "Allow USB debugging?"',
  untrusted: 'waiting for "Allow USB debugging?"',
  offline: 'offline',
  recovery: 'in recovery or bootloader mode',
  unknown: 'state unknown',
}

/** An Android device on Wi-Fi (§4.7) is asked "Allow debugging?", and has no cable to reseat. */
const ANDROID_NETWORK_WORDS: Readonly<Partial<Record<HelperState, string>>> = {
  authorizing: 'waiting for "Allow debugging?"',
  unauthorized: 'waiting for "Allow debugging?"',
  untrusted: 'waiting for "Allow debugging?"',
  offline: 'not answering over Wi-Fi',
}

const ANDROID_NETWORK_BLOCKER_LINES: Readonly<Record<string, string>> = {
  ANDROID_UNAUTHORIZED:
    'Choose Allow on "Allow debugging?" on the device (with the remote on a TV)',
  ANDROID_OFFLINE: 'The device is not answering over Wi-Fi: wake it, or connect it again',
}

/** The second line under a device that gained a blocker, in the terminal's own words. */
const BLOCKER_LINES: Readonly<Record<string, string>> = {
  IOS_UNTRUSTED: 'Unlock it and tap Trust on the iPhone',
  IOS_LOCKED: 'Unlock it with the passcode: it has not been unlocked since it restarted',
  IOS_LOCKDOWN_FAILED: 'It is not answering: unplug it and plug it back in, unlocked',
  IOS_DEVELOPER_MODE_OFF: 'Developer Mode is off: screenshots stay off until it is on',
  XCODE_REQUIRED: 'Screenshots need Xcode on this Mac (identifiers and logs work)',
  XCODE_SETUP_REQUIRED: 'Xcode must finish setting up before screenshots work: open Xcode once',
  IOS_DDI_REQUIRED: 'Screenshots need the developer disk image mounted on the device first',
  TOOL_MISSING: 'A tool is missing for this device: run the helper with --doctor',
  ANDROID_UNAUTHORIZED: 'Tap Allow on "Allow USB debugging?" on the phone',
  ANDROID_OFFLINE: 'The phone is not answering adb: reseat the cable',
  ANDROID_RECOVERY: 'The phone is in recovery or bootloader mode',
}

function label(row: HelperDevice): string {
  if (row.platform === 'android') {
    const fallback = row.connection === 'network' ? 'Android device' : 'Android phone'
    return `${row.name || row.modelId || fallback} (${row.id})`
  }
  return (
    row.name ||
    row.model ||
    row.modelId ||
    (row.connection === 'simulator' ? 'Simulator' : 'iPhone')
  )
}

function words(row: HelperDevice): string {
  if (row.platform === 'android') {
    const network = row.connection === 'network' ? ANDROID_NETWORK_WORDS[row.state] : undefined
    return network ?? ANDROID_WORDS[row.state]
  }
  if (row.connection === 'simulator') {
    if (row.state === 'ready') return 'booted'
    if (row.state === 'connecting') return 'booting'
  }
  return IOS_WORDS[row.state]
}

function arrivalLine(row: HelperDevice): string {
  const os =
    (row.platform === 'ios' ? 'iOS' : 'Android') + (row.osVersion ? ` ${row.osVersion}` : '')
  const via =
    row.connection === 'usb'
      ? 'USB'
      : row.connection === 'network'
        ? 'Wi-Fi'
        : row.platform === 'ios'
          ? 'Simulator'
          : 'Emulator'
  return `+ ${label(row)} · ${os} · ${via} · ${words(row)}`
}

function blockerLines(row: HelperDevice, codes: readonly string[]): string[] {
  const network = row.platform === 'android' && row.connection === 'network'
  return codes.flatMap((code) => {
    const line = (network ? ANDROID_NETWORK_BLOCKER_LINES[code] : undefined) ?? BLOCKER_LINES[code]
    return line ? [`  ${line}`] : []
  })
}

/**
 * The terminal lines for one lane's rows going from `before` to `after`. A row that left
 * with a `departures` entry says why: "- BRAVIA 4K UR3 (192.168.1.20:5555) · disconnected".
 */
export function transitionLines(
  before: readonly HelperDevice[],
  after: readonly HelperDevice[],
  departures: Readonly<Record<string, string>> = {},
): string[] {
  const lines: string[] = []
  const old = new Map(before.map((row) => [row.id, row]))
  const now = new Set(after.map((row) => row.id))
  for (const row of after) {
    const previous = old.get(row.id)
    if (!previous) {
      lines.push(arrivalLine(row), ...blockerLines(row, row.blockers))
      continue
    }
    if (previous.state !== row.state) lines.push(`~ ${label(row)} · ${words(row)}`)
    const added = row.blockers.filter((code) => !previous.blockers.includes(code))
    lines.push(...blockerLines(row, added))
  }
  for (const row of before) {
    if (now.has(row.id)) continue
    const why = Object.hasOwn(departures, row.id) ? departures[row.id] : undefined
    lines.push(`- ${label(row)}${why ? ` · ${why}` : ''}`)
  }
  return lines
}

/**
 * Lane-level transitions worth a line. A lane's first report only settles its state (the
 * banner already describes it); later changes are news.
 */
export function laneLines<K extends LaneName>(
  lane: K,
  before: Lanes[K],
  after: Lanes[K],
): string[] {
  if (lane === 'android') {
    const a = before as Lanes['android']
    const b = after as Lanes['android']
    if (a.status !== 'ok' && b.status === 'ok') {
      const how = b.startedByHelper ? 'started from Device Lab' : 'appeared'
      const protocol =
        b.serverProtocol === undefined ? '' : ` (protocol ${String(b.serverProtocol)})`
      return [`adb server ${how}${protocol}: sharing it for Android`]
    }
    if (a.status === 'ok' && b.status === 'stopped') {
      return ["adb server stopped: Android phones are back with Chrome's WebUSB"]
    }
  }
  if (lane === 'ios') {
    const a = before as Lanes['ios']
    const b = after as Lanes['ios']
    if (a.status === 'ok' && b.status === 'error') {
      return [
        `macOS's iPhone service (usbmuxd) stopped answering${b.reason ? `: ${b.reason}` : ''}`,
      ]
    }
    if (a.status === 'error' && b.status === 'ok')
      return ["macOS's iPhone service (usbmuxd) is back"]
  }
  return []
}

/**
 * The single source of truth for what the helper lists (§1.3, §2.4). Lanes publish their
 * whole row list; the registry merges, sorts and serialises, bumps `rev` only when the JSON
 * the page sees changes, prints one terminal line per transition, and tells subscribers
 * (log streams) which devices left.
 */
export function createRegistry(opts: {
  runId: string
  lanes: Lanes
  now: () => number
  activeMs: number
  /** One terminal line (the bridge adds the time). */
  log: (line: string) => void
  /** A lane bug worth knowing about (stderr). */
  bug: (line: string) => void
}): Registry {
  const rows = new Map<LaneName, HelperDevice[]>()
  const settled = new Set<LaneName>()
  const listeners = new Set<(change: RegistryChange) => void>()
  let lanes: Lanes = JSON.parse(JSON.stringify(opts.lanes)) as Lanes
  let devices: HelperDevice[] = []
  let rev = 1
  let serialized = JSON.stringify({ devices, lanes })
  let lastActive = Number.NEGATIVE_INFINITY

  const rebuild = (removed: string[]): void => {
    const merged = new Map<string, HelperDevice>()
    for (const lane of LANE_ORDER) {
      for (const row of rows.get(lane) ?? []) if (!merged.has(row.id)) merged.set(row.id, row)
    }
    const next = sortRows([...merged.values()])
    const json = JSON.stringify({ devices: next, lanes })
    if (json !== serialized) {
      serialized = json
      devices = next
      rev++
    }
    const gone = removed.filter((id) => !merged.has(id))
    if (gone.length) for (const listener of [...listeners]) listener({ removed: gone })
  }

  return {
    publish(lane, incoming, departures) {
      const previous = rows.get(lane) ?? []
      const next: HelperDevice[] = []
      const seen = new Set<string>()
      for (const row of incoming) {
        const normal = normalizeRow(row)
        if (!normal) {
          opts.bug(
            `The ${lane} lane listed a device id no request can address: ${JSON.stringify(row.id)}`,
          )
          continue
        }
        if (seen.has(normal.id)) continue
        seen.add(normal.id)
        next.push(normal)
      }
      rows.set(lane, next)
      for (const line of transitionLines(previous, next, departures)) opts.log(line)
      rebuild(previous.map((row) => row.id).filter((id) => !seen.has(id)))
    },
    setLane(lane, patch) {
      const before = lanes[lane]
      const after = { ...before, ...patch }
      lanes = { ...lanes, [lane]: after }
      if (settled.has(lane)) for (const line of laneLines(lane, before, after)) opts.log(line)
      else settled.add(lane)
      rebuild([])
    },
    snapshot: () => ({ rev, runId: opts.runId, devices, lanes }),
    lanes: () => lanes,
    devices: () => devices,
    device: (id) => devices.find((row) => row.id === id) ?? null,
    owner(id) {
      for (const lane of LANE_ORDER) if (rows.get(lane)?.some((row) => row.id === id)) return lane
      return null
    },
    touch() {
      lastActive = opts.now()
    },
    isActive: () => opts.now() - lastActive < opts.activeMs,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** "1 phone", "2 phones": for the banner's Android line. */
export function phones(n: number): string {
  return plural(n, 'phone')
}
