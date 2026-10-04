/*
  Device Lab, as data and pure functions: the device states and how they sort, the blocker
  codes and the fix each one names, formatting, and the Markdown a tester pastes into a ticket.

  Ported from the hand-written Device Lab (device/js/01-core.js, 02-backend.js, 07-detail.js),
  which was verified against a real Pixel 9. Semantics are kept exactly — parity.test.ts holds
  this to the answers the legacy code gave on the same inputs — because the wording, the sort
  order and the Markdown layout are what testers already rely on.

  The Android features (installs, apps, images) word their codes here by the same rule:
  backends return codes, the UI owns the words (DEVICE_HINTS, INSTALL_ERRORS).

  The local helper (backends/agent.ts) reports iPhones, simulators and adb-server Android
  phones in this same shape. A phone two lanes can see is one row: mergeDevices keeps the
  better one. The helper's own codes are worded here and in DEVICE_ERRORS, never in the helper.
*/

import type { InstallErrorCode, InstallFailure } from './backends/android/pm-output'
import { FIX } from './preflight/copy'
import type { Fix, InstallPhone } from './preflight/types'

export type { Fix, FixAction } from './preflight/types'

export type Platform = 'android' | 'ios'
/** How the device is reached. `simulator`: an iOS Simulator or an Android emulator. */
export type Connection = 'usb' | 'network' | 'simulator'
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
  /** Installs from the browser: Android 7.0 or newer (MIN_INSTALL_SDK). */
  install?: boolean
  logs?: boolean
  /** The Apps tab: the installed apps, their details and actions. */
  apps?: boolean
  /** The Images tab: the phone's photos through MediaStore. */
  images?: boolean
}

/** Installs need streamed install sessions (`cmd package`), which arrived in Android 7.0. */
export const MIN_INSTALL_SDK = 24

/** What connect read off an Android phone, for the install checks and the preflight rows. */
export interface AndroidFacts {
  /** ro.build.version.sdk; null when it couldn't be read. */
  readonly sdk: number | null
  readonly release: string
  readonly manufacturer: string
  readonly brand: string
  /** ro.product.cpu.abilist, most preferred first. */
  readonly abis: readonly string[]
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
  /** Android only, once connected. */
  android?: AndroidFacts
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

/** The mock lane never beats a real one: its fixtures reuse real ids. */
const mockRank = (d: Device) => (d.backend === 'mock' ? 1 : 0)

/**
 * Whether `d` is a better source for its id than `cur`. A `held` row means another program owns
 * the USB interface, so any other lane listing the same id (the helper, attached through that
 * very program) is the better source whatever its state. Otherwise the more usable state wins,
 * and a tie keeps lane order.
 */
function better(d: Device, cur: Device): boolean {
  if (mockRank(d) !== mockRank(cur)) return mockRank(d) < mockRank(cur)
  if ((d.state === 'held') !== (cur.state === 'held')) return cur.state === 'held'
  return STATE_WEIGHT[d.state] < STATE_WEIGHT[cur.state]
}

/**
 * Every lane's devices as one sorted list, one row per device id. The same Android phone can be
 * visible to WebUSB and to the helper (through Google's adb server): the best row wins (better()
 * above), so a phone WebUSB can't claim shows as the helper's ready row rather than `held`.
 */
export function mergeDevices(lanes: readonly (readonly Device[])[]): Device[] {
  const best = new Map<string, Device>()
  for (const lane of lanes) {
    for (const d of lane) {
      const cur = best.get(d.id)
      if (!cur || better(d, cur)) best.set(d.id, d)
    }
  }
  return sortDevices([...best.values()])
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
  // The helper's iOS blockers (spec §7.4). Not in parity.json: the legacy page had no helper.
  XCODE_REQUIRED: {
    title: 'Screenshots need Xcode on this Mac',
    body: 'On iOS 17 and newer, the helper takes screenshots through Xcode. Install Xcode from the App Store, open it once, then retry.',
    fixes: [
      { label: 'Open check', action: 'doctor' },
      { label: 'Retry', action: 'retry' },
    ],
    extra: 'Identifiers and logs work without it.',
  },
  XCODE_SETUP_REQUIRED: {
    title: 'Xcode needs to finish setting up',
    body: 'Open Xcode once and let it install its components, then retry. The environment check has the command if you prefer Terminal.',
    fixes: [
      { label: 'Open check', action: 'doctor' },
      { label: 'Retry', action: 'retry' },
    ],
  },
  IOS_DDI_REQUIRED: {
    title: 'Screenshots need Apple’s developer disk image',
    body: 'iOS 16 and older need the image mounted on the device first, with the device unlocked. Connecting it to Xcode’s Devices and Simulators window prepares it. Then retry.',
    fixes: [
      { label: 'Retry', action: 'retry' },
      { label: 'Open check', action: 'doctor' },
    ],
  },
  IOS_LOCKDOWN_FAILED: {
    title: 'The device isn’t answering',
    body: 'Unplug it and plug it back in with the device unlocked, then retry. Avoid USB hubs.',
    fixes: [{ label: 'Retry', action: 'retry' }],
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
  // classifyUsbErrorFor: the system, not another program, refused to let the browser open the
  // phone. Linux needs udev rules; on Windows a maker's driver can sit on the interface.
  USB_ACCESS_DENIED: {
    title: 'The system won’t let the browser open the phone',
    body: 'On Linux, install the Android udev rules for your distribution, then unplug and replug the phone. On Windows, a phone maker’s USB driver may be blocking the browser: switch the phone’s ADB interface to WinUSB in Device Manager, or install Google’s USB driver.',
    // The same commands and link as the checklist's osAccess row, which usually stands in for
    // this hint; it falls back here only when no row is passed.
    fixes: [
      FIX.udevRules,
      FIX.udevFedora,
      FIX.udevArch,
      FIX.snapUsb,
      FIX.winUsb,
      { label: 'Reconnect', action: 'retry', primary: true },
    ],
    extra:
      'On Debian or Ubuntu, also run “sudo usermod -aG plugdev $LOGNAME”, then log out and back in. Chromium installed as a snap needs the snap command, then a restart. On Windows, a running adb server can cause this too: quit it with “adb kill-server”.',
  },
}

/**
 * An Android device over Wi‑Fi (§4.7) says the same codes, but there is no cable to reseat:
 * it asks on its own screen (a TV's, answered with the remote), and it drops off the network.
 */
export const WIFI_HINTS: Readonly<Record<string, Omit<Hint, 'code'>>> = {
  ANDROID_UNAUTHORIZED: {
    title: 'Waiting for you to allow debugging',
    body: 'On the device, choose Allow on “Allow debugging?” (on a TV, with the remote). Tick “Always allow from this computer” so it stops asking.',
    fixes: [{ label: 'Retry', action: 'retry' }],
  },
  ANDROID_OFFLINE: {
    title: 'The device stopped answering over Wi‑Fi',
    body: 'Wake it and check it is still on the same Wi‑Fi as this computer, then connect again.',
    fixes: [{ label: 'Connect over Wi‑Fi…', action: 'open-wifi' }],
  },
}

/** The first blocker the UI has wording for, as a hint. */
export function hintFor(device: Device | null): Hint | null {
  if (!device) return null
  const wifi = device.platform === 'android' && device.connection === 'network'
  for (const code of device.blockers) {
    const hint = (wifi ? WIFI_HINTS[code] : undefined) ?? DEVICE_HINTS[code]
    if (hint) return { code, ...hint }
  }
  return null
}

/** The phone facts the install rows need (preflight's InstallPhone); null for a non-Android row. */
export function installPhoneOf(device: Device): InstallPhone | null {
  const a = device.android
  if (!a) return null
  return {
    name: device.name,
    sdk: a.sdk,
    release: a.release,
    brand: a.brand,
    manufacturer: a.manufacturer,
  }
}

/* ---------------------------------------------------------------- *
 * Install failure → what happened and what to do
 *
 * pm-output.ts turns what the phone printed into a code and the values the message carried;
 * this table words them. Every entry says what happened in the tester's terms, then either a
 * button (action) or a sentence (advice) that gets past it.
 * ---------------------------------------------------------------- */

/** A way past a failed install the dialog offers as a button. */
export type InstallErrorAction =
  | 'uninstall-and-install'
  | 'allow-downgrade'
  | 'install-anyway'
  | 'uninstall-other'
  | 'retry'
  | 'copy-details'

export const INSTALL_ACTION_LABELS: Readonly<Record<InstallErrorAction, string>> = {
  'uninstall-and-install': 'Uninstall and install…',
  'allow-downgrade': 'Install the older version',
  'install-anyway': 'Install anyway',
  'uninstall-other': 'Uninstall {other}…',
  retry: 'Retry',
  'copy-details': 'Copy details',
}

export interface InstallErrorEntry {
  /** What happened. `{name}` takes a value from the failure's params or the context. */
  readonly text: string
  /** Said instead when a value `text` needs is missing. */
  readonly fallback?: string
  /** What to do, when it isn't a button. */
  readonly advice?: string
  readonly action?: InstallErrorAction
  /** The button's label, when it isn't the action's usual one. */
  readonly actionLabel?: string
  readonly fixes?: readonly Fix[]
}

export const INSTALL_ERRORS: Readonly<Record<InstallErrorCode, InstallErrorEntry>> = {
  UPDATE_INCOMPATIBLE: {
    text: 'A different build of this app is installed, signed with another key (for example Google Play vs a debug build).',
    advice: 'Android can’t update it. Uninstalling it first deletes its data on the phone.',
    action: 'uninstall-and-install',
  },
  VERSION_DOWNGRADE: {
    text: 'The phone has a newer version ({installedVersionCode}) than this file ({fileVersionCode}).',
    fallback: 'The phone has a newer version than this file.',
    // installErrorWording offers allow-downgrade instead when the installed copy is debuggable.
    action: 'uninstall-and-install',
  },
  MISSING_SPLIT: {
    text: 'Parts of the app for this phone’s CPU, screen or language are missing.',
    advice: 'Use the full .apks or .aab.',
  },
  NO_MATCHING_ABIS: {
    text: 'This app has no native code for {abis}.',
    fallback: 'This app has no native code for this phone’s CPU.',
  },
  OLDER_SDK: {
    text: 'This app needs Android API {requiredSdk}. This phone has API {deviceSdk}.',
    fallback: 'This app needs a newer Android version than this phone has.',
  },
  DEPRECATED_SDK_VERSION: {
    text: 'This app targets an old Android (API {targetSdk}). Android blocks it unless you allow it.',
    fallback: 'This app targets an old Android version. Android blocks it unless you allow it.',
    action: 'install-anyway',
  },
  NO_CERTIFICATES: {
    text: 'This APK isn’t signed, so Android refuses it.',
    advice:
      'Sign it first. A debug build from Android Studio or Gradle is signed with the debug key.',
  },
  INVALID_APK: {
    text: 'These APKs don’t belong together (different apps, versions or signatures, or no base APK).',
  },
  NOT_APK: {
    text: 'This isn’t a valid APK. It may be an .aab, or a download that was cut short.',
  },
  DUPLICATE_PERMISSION: {
    text: 'Another installed app ({other}) declares the same permission, usually another flavour of this app.',
    fallback:
      'Another installed app declares the same permission, usually another flavour of this app.',
    action: 'uninstall-other',
  },
  CONFLICTING_PROVIDER: {
    text: 'Another installed app ({other}) declares the same provider, usually another flavour of this app.',
    fallback:
      'Another installed app declares the same provider, usually another flavour of this app.',
    action: 'uninstall-other',
  },
  INSUFFICIENT_STORAGE: {
    text: 'Not enough free space on the phone.',
    advice: 'Free some space on the phone, then try again.',
  },
  USER_RESTRICTED: {
    text: 'The phone blocks installs over USB.',
    advice: 'Allow installs over USB in Developer options, then try again.',
    fixes: [
      {
        label: 'Allow installs over USB (Xiaomi, Redmi, POCO)',
        path: 'Settings → Additional settings → Developer options → Install via USB (needs a Mi account)',
      },
    ],
  },
  ABORTED: {
    text: 'The install was cancelled on the phone.',
    action: 'retry',
    actionLabel: 'Retry and watch the phone',
  },
  VERIFICATION_FAILURE: {
    text: 'Play Protect blocked or didn’t approve the install.',
    advice: 'Check the phone: it may be asking you to confirm. Keep it unlocked, then try again.',
    action: 'retry',
  },
  CONNECTION_LOST: {
    text: 'The phone disconnected during the install. Nothing was installed.',
    action: 'retry',
  },
  UNKNOWN: {
    text: 'Android refused the install: {message}',
    fallback: 'Android refused the install.',
    action: 'copy-details',
  },
}

/** CONNECTION_LOST once the phone had started installing: it may have finished. */
const LOST_WHILE_INSTALLING =
  'The phone disconnected while installing. Once it’s back, check the Apps tab to see whether the app was installed.'

/** ABIs that run 32-bit code: a phone that lists none runs 64-bit apps only. */
const ABI_32 = new Set(['armeabi-v7a', 'armeabi', 'x86', 'mips'])

export interface InstallErrorContext {
  /** The phone's ABI list, for NO_MATCHING_ABIS. */
  readonly abis?: readonly string[]
  /** The installed copy is debuggable, so an older version can go over it (`-d`). */
  readonly debuggable?: boolean
}

export interface InstallErrorWording {
  readonly text: string
  readonly advice: string | null
  readonly action: { readonly kind: InstallErrorAction; readonly label: string } | null
  readonly fixes: readonly Fix[]
}

/** `{name}` → the value; null when any value is missing. */
function fill(template: string, values: Readonly<Record<string, string>>): string | null {
  let missing = false
  const text = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name]
    if (!value) missing = true
    return value ?? ''
  })
  return missing ? null : text
}

const listOf = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`

/** A failed install, in words, with the way past it. */
export function installErrorWording(
  failure: InstallFailure,
  context: InstallErrorContext = {},
): InstallErrorWording {
  const entry = INSTALL_ERRORS[failure.code]
  const abis = context.abis ?? []
  const values: Record<string, string> = {
    ...failure.params,
    message: failure.message.trim(),
    abis: listOf(abis),
  }
  let text = fill(entry.text, values) ?? entry.fallback ?? entry.text
  if (failure.code === 'CONNECTION_LOST' && failure.params.phase === 'installing') {
    text = LOST_WHILE_INSTALLING
  }
  if (failure.code === 'NO_MATCHING_ABIS' && abis.length > 0 && !abis.some((a) => ABI_32.has(a))) {
    text += ' This phone runs 64-bit apps only.'
  }

  let kind = entry.action ?? null
  if (failure.code === 'VERSION_DOWNGRADE' && context.debuggable) kind = 'allow-downgrade'
  // "Uninstall {other}…" needs to know which app that is.
  if (kind === 'uninstall-other' && !values.other) kind = null
  const label = kind ? fill(entry.actionLabel ?? INSTALL_ACTION_LABELS[kind], values) : null

  return {
    text,
    advice: entry.advice ?? null,
    action: kind && label ? { kind, label } : null,
    fixes: entry.fixes ?? [],
  }
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
