/*
  Device Lab, as data and pure functions: the device states and how they sort, the blocker
  codes and the fix each one names, formatting, and the Markdown a tester pastes into a ticket.

  Ported from the hand-written Device Lab (device/js/01-core.js, 02-backend.js, 07-detail.js),
  which was verified against a real Pixel 9. Semantics are kept exactly — parity.test.ts holds
  this to the answers the legacy code gave on the same inputs — because the wording, the sort
  order and the Markdown layout are what testers already rely on.
*/

export type Platform = 'android' | 'ios'
export type Connection = 'usb' | 'network'
export type BackendKind = 'webusb' | 'agent' | 'mock'

export type DeviceState =
  | 'ready'
  | 'busy'
  | 'connecting'
  | 'authorizing'
  | 'locked'
  | 'held'
  | 'unauthorized'
  | 'untrusted'
  | 'offline'
  | 'recovery'
  | 'unknown'
  | 'absent'

/** How a state reads at a glance. `bad` is something the tester can fix now; `off` is inert. */
export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'off'

/**
 * Sort weights, so the list self-prioritises: usable devices rise, dead ones sink. Borrowed
 * from DeviceFarmer/stf, which learned it across a physical device shelf.
 */
export const STATE_WEIGHT: Readonly<Record<DeviceState, number>> = {
  ready: 10,
  busy: 20,
  connecting: 30,
  authorizing: 40,
  locked: 50,
  held: 55,
  unauthorized: 60,
  untrusted: 60,
  offline: 70,
  recovery: 80,
  unknown: 90,
  absent: 95,
}

/**
 * State → tone + label. The split is deliberate: `unauthorized` is RED because the tester can
 * fix it right now, `offline` is GREY because it is inert and usually a cable. Colour is always
 * paired with this label, never shown alone.
 */
export const STATE_META: Readonly<Record<DeviceState, { tone: Tone; label: string }>> = {
  ready: { tone: 'ok', label: 'Ready' },
  busy: { tone: 'busy', label: 'Busy' },
  connecting: { tone: 'busy', label: 'Connecting…' },
  authorizing: { tone: 'warn', label: 'Authorizing…' },
  locked: { tone: 'warn', label: 'Locked' },
  held: { tone: 'bad', label: 'Held by adb' },
  unauthorized: { tone: 'bad', label: 'Not authorized' },
  untrusted: { tone: 'bad', label: 'Not trusted' },
  offline: { tone: 'off', label: 'Offline' },
  recovery: { tone: 'off', label: 'Recovery mode' },
  unknown: { tone: 'off', label: 'Unknown' },
  absent: { tone: 'off', label: 'Disconnected' },
}

export interface Capabilities {
  screenshot?: boolean
  identifiers?: boolean
  install?: boolean
  logs?: boolean
}

/** The one shape every backend reports, so the list is one table for both platforms. */
export interface Device {
  id: string
  backend: BackendKind
  platform: Platform
  connection: Connection
  state: DeviceState
  name: string
  model: string
  osVersion: string
  /** Taxonomy codes; the backend owns codes, the UI owns wording (DEVICE_HINTS). */
  blockers: string[]
  capabilities: Capabilities
}

export function isDeviceState(value: unknown): value is DeviceState {
  return typeof value === 'string' && value in STATE_META
}

/** Fill the defaults the legacy dvcNormalizeDevice filled; an unknown state becomes `unknown`. */
export function normalizeDevice(
  raw: Partial<Device> & { id: string; backend: BackendKind },
): Device {
  const d: Device = {
    platform: 'android',
    connection: 'usb',
    state: 'unknown',
    name: '',
    model: '',
    osVersion: '',
    blockers: [],
    capabilities: {},
    ...raw,
  }
  d.name = d.name || d.model || d.id
  if (!isDeviceState(d.state)) d.state = 'unknown'
  return d
}

export function sortDevices(list: readonly Device[]): Device[] {
  return list.slice().sort((a, b) => {
    const wa = STATE_WEIGHT[a.state]
    const wb = STATE_WEIGHT[b.state]
    if (wa !== wb) return wa - wb
    return a.name.localeCompare(b.name)
  })
}

/**
 * Every lane's devices as one sorted list. The same Android phone can be visible to two lanes;
 * the first lane listed wins, because whichever claimed the USB interface owns it.
 */
export function mergeDevices(lanes: readonly (readonly Device[])[]): Device[] {
  const seen = new Set<string>()
  const out: Device[] = []
  for (const lane of lanes) {
    for (const d of lane) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      out.push(d)
    }
  }
  return sortDevices(out)
}

/** The list filter: platform facets, then a case-insensitive match on name, model, id, OS. */
export function deviceMatches(
  device: Device,
  filter: string,
  facets: Readonly<Record<Platform, boolean>>,
): boolean {
  if (!facets[device.platform]) return false
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  const hay = [device.name, device.model, device.id, device.osVersion, device.platform]
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

/* ---------------------------------------------------------------- *
 * Blocker → actionable hint
 *
 * Every entry names what to DO. A hint that only restates the problem ("device unauthorized")
 * is the failure mode that makes "Could not find AltServer" the most-searched string in
 * sideloading.
 * ---------------------------------------------------------------- */

export type Fix =
  | { readonly label: string; readonly copy: string; readonly primary?: boolean }
  | { readonly label: string; readonly action: 'retry' | 'doctor'; readonly primary?: boolean }

export interface Hint {
  readonly code: string
  readonly title: string
  readonly body: string
  readonly fixes?: readonly Fix[]
  readonly extra?: string
}

export const DEVICE_HINTS: Readonly<Record<string, Omit<Hint, 'code'>>> = {
  ADB_SERVER_HOLDING: {
    title: 'Google’s adb server is holding this phone',
    body: 'One program at a time can own a USB device. Quit the adb server, then reconnect here.',
    // Two fixes, in order: nothing reclaims a `held` device automatically, so without
    // Reconnect the page looked broken until a reload.
    fixes: [
      { label: 'Copy “adb kill-server”', copy: 'adb kill-server' },
      { label: 'Reconnect', action: 'retry', primary: true },
    ],
    extra:
      'If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ, Flutter, VS Code, Unity or scrcpy.',
  },
  ANDROID_UNAUTHORIZED: {
    title: 'Waiting for you to allow USB debugging',
    body: 'Unlock the phone and tap Allow on the “Allow USB debugging?” prompt. Tick “Always allow” so it stops asking.',
    fixes: [{ label: 'Retry', action: 'retry' }],
  },
  ANDROID_OFFLINE: {
    title: 'The phone is on the bus but not answering',
    body: 'Reseat the cable and avoid USB hubs, then toggle USB debugging off and on.',
    fixes: [{ label: 'Retry', action: 'retry' }],
  },
  ANDROID_RECOVERY: {
    title: 'Device is in recovery / bootloader mode',
    body: 'Screenshots, installs and logs are unavailable until it boots normally.',
  },
  IOS_UNTRUSTED: {
    title: 'Waiting for you to trust this Mac',
    body: 'Unlock the iPhone, tap Trust on “Trust This Computer?”, then enter the passcode.',
    fixes: [{ label: 'Retry', action: 'retry' }],
  },
  IOS_LOCKED: {
    title: 'Unlock the device to read its details',
    body: 'iOS only reports serial number, storage and battery while the device is unlocked.',
    fixes: [{ label: 'Retry', action: 'retry' }],
  },
  IOS_DEVELOPER_MODE_OFF: {
    title: 'Developer Mode is off',
    body: 'Settings → Privacy & Security → Developer Mode → On. The device restarts, then tap Turn On.',
    extra:
      'There is no button for this: enabling it fails when a passcode is set, and it reboots the device.',
  },
  TUNNEL_REQUIRED: {
    title: 'This device needs the privileged tunnel',
    body: 'On iOS 17 and newer, screenshots need a system tunnel that must run as root. It stops when you quit the helper.',
    fixes: [{ label: 'Copy command', copy: 'sudo pymobiledevice3 remote tunneld -d' }],
  },
  IOS_NETWORK_ONLY: {
    title: 'Connected over Wi‑Fi',
    body: 'Identifiers work. Install and logs need a cable — plug it in over USB.',
  },
  TOOL_MISSING: {
    title: 'A required tool is missing',
    body: 'Open the environment check for the exact install command.',
    fixes: [{ label: 'Open check', action: 'doctor' }],
  },
  WEBUSB_CLAIM_FAILED: {
    title: 'Could not claim the USB interface',
    body: 'Another program owns this device. Quit adb and any device tooling, unplug and replug, then reconnect.',
    fixes: [
      { label: 'Copy “adb kill-server”', copy: 'adb kill-server' },
      { label: 'Reconnect', action: 'retry', primary: true },
    ],
  },
}

/** The first blocker the UI has wording for, as a hint. */
export function hintFor(device: Device | null): Hint | null {
  if (!device) return null
  for (const code of device.blockers) {
    const hint = DEVICE_HINTS[code]
    if (hint) return { code, ...hint }
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Detail
 * ---------------------------------------------------------------- */

/** One device's identifiers, in Apple's and Google's own vocabulary, grouped as on screen. */
export interface DeviceDetail {
  platform: Platform
  identity: Record<string, string>
  software: Record<string, string>
  hardware: Record<string, string>
  status: Record<string, string>
  /** Kept for a bug-report bundle. */
  raw?: { getprop?: string }
}

export const DETAIL_GROUPS = [
  ['identity', 'Identity'],
  ['software', 'Software'],
  ['hardware', 'Hardware'],
  ['status', 'Status'],
] as const

/** Keys ending in "note" are UI guidance, not data: shown muted, never copied. */
export const isNote = (key: string) => /note$/i.test(key)

/**
 * "Copy all as Markdown", the highest-value control on the pane: the identifier block is the
 * part testers otherwise retype into a ticket. The legacy layout, byte for byte.
 */
export function detailMarkdown(detail: DeviceDetail, now: Date): string {
  const lines = ['| | |', '|---|---|']
  for (const [group] of DETAIL_GROUPS) {
    for (const [k, v] of Object.entries(detail[group])) {
      if (isNote(k) || !v) continue
      lines.push(`| ${k} | \`${v.replace(/\|/g, '\\|')}\` |`)
    }
  }
  lines.push(`| Captured | ${fmtIsoOffset(now)} |`)
  return lines.join('\n')
}

/* ---------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export function fmtClock(d: Date): string {
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fmtDateTime(d: Date | null): string {
  if (!d) return 'Never'
  if (Number.isNaN(d.getTime())) return 'Unknown'
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()] ?? ''}-${String(d.getFullYear())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * ISO 8601 with the local UTC offset, so a timestamp pasted into a ticket is unambiguous.
 * A bare local time in a bug report is a bug in itself.
 */
export function fmtIsoOffset(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = Number(bytes)
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? String(n) : n.toFixed(n < 10 ? 1 : 0)} ${units[i] ?? ''}`
}

/**
 * `Pixel 9`, 2026-10-03 14:05:09 +07:00 → `pixel-9_2026-10-03T14-05-09+07-00.png`. The legacy
 * page also turned the offset's `+` into `-`, which reads as a negative offset; `+` is a legal
 * file-name character everywhere, so it stays.
 */
export function shotFilename(device: Pick<Device, 'name' | 'id'>, at: Date): string {
  const stamp = fmtIsoOffset(at).replace(/:/g, '-').replace(/\..*$/, '')
  const slug =
    (device.name || device.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'device'
  return `${slug}_${stamp}.png`
}
