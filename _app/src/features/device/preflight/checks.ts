import type {
  Capability,
  DoctorReport,
  PreflightAction,
  PreflightFix,
  PreflightItem,
} from '../helper/protocol'
import {
  DEV_COMMAND,
  DOWNLOAD_COMMAND,
  downloadCommand,
  otherPortCommand,
  startCommand,
} from '../helper/status'
import { DEVICE_HINTS, type Device, type DeviceState } from '../model'
import {
  BROWSER_NAMES,
  COPY,
  FIX,
  GROUP_TITLES,
  LABELS,
  STATUS_META,
  bundletoolCommand,
  bundletoolFix,
  copyLinkFix,
  helperPageFix,
  siteSettingsFix,
} from './copy'
import {
  USB_ACCESS_DENIED,
  type AabProbe,
  type AndroidDoctor,
  type BrowserEnv,
  type BrowserName,
  type CheckGroup,
  type CheckItem,
  type CheckStatus,
  type DeviceCheckId,
  type Feature,
  type FeatureContext,
  type Fix,
  type FixAction,
  type FixedCheckId,
  type HelperHealth,
  type HelperProbe,
  type ImagesOutcome,
  type InstallPhone,
  type PhoneInput,
  type PublishedHelper,
  type ToolCheckId,
  type UsbHolder,
  type WifiAttempt,
  type WifiInput,
} from './types'

/*
  The checklist's decisions (PLAN §3.1–3.4): pure functions from what env.ts, usb-diagnose.ts,
  the store and the helper report, to rows in display order. Which sentence a row says is
  decided here; the words themselves live in copy.ts.

  Two rules run through all of it:
  - A row that can't know yet says `unchecked` and when it will know. It never guesses OK,
    and never dresses ignorance up as a warning.
  - Every non-OK row carries a fix, or says what to do in its sentence.
*/

/** Installs need Android 7.0 (decision 6): the session path the plan tests. */
export const MIN_INSTALL_SDK = 24
/** How long "Allow USB debugging?" may go unanswered before the prompt is presumed missing. */
export const AUTHORIZE_PATIENCE_MS = 30_000
/** The oldest helper protocol the page talks to (DVC_MIN_AGENT in the helper design). */
export const HELPER_MIN_PROTOCOL = 1
/** The capability a helper reports when it can turn an .aab into APKs. */
export const BUILD_APKS = 'android.buildApks'

/** The phone rows the Gate shows as numbered steps, in this order. */
export const GATE_STEPS: readonly FixedCheckId[] = [
  'phone.usbDebugging',
  'phone.cable',
  'phone.permission',
  'phone.authorized',
]

/** Not-OK rows rank above OK ones; not knowing ranks below a warning. */
const SEVERITY: Readonly<Record<CheckStatus, number>> = {
  ok: 0,
  unchecked: 1,
  warning: 2,
  blocking: 3,
}

function row(
  id: FixedCheckId,
  group: CheckGroup,
  status: CheckStatus,
  sentence: string,
  fixes: readonly Fix[] = [],
  detail = '',
): CheckItem {
  return {
    id,
    group,
    label: LABELS[id],
    status,
    sentence,
    ...(fixes.length > 0 ? { fixes } : {}),
    ...(detail ? { detail } : {}),
  }
}

const primary = (fix: Fix): Fix => ({ ...fix, primary: true })

/* ---------------------------------------------------------------- *
 * This browser
 * ---------------------------------------------------------------- */

export function browserChecks(env: BrowserEnv): CheckItem[] {
  const secure = env.secure
    ? row('browser.secure', 'browser', 'ok', env.https ? COPY.secure.ok : COPY.secure.okLocal)
    : row('browser.secure', 'browser', 'blocking', COPY.secure.blocking, [FIX.openSecure])

  let webusb: CheckItem
  if (!env.secure) {
    // navigator.usb only exists in secure contexts, so its absence here says nothing yet.
    webusb = row('browser.webusb', 'browser', 'unchecked', COPY.webusb.unchecked)
  } else if (!env.webusb) {
    webusb = row('browser.webusb', 'browser', 'blocking', COPY.webusb.missing, [FIX.getChrome])
  } else if (env.usbPolicy === false) {
    // An iframe without allow="usb": the API is there, and every call to it is refused.
    webusb = row('browser.webusb', 'browser', 'blocking', COPY.webusb.policy, [
      copyLinkFix(env.href),
    ])
  } else {
    webusb = row('browser.webusb', 'browser', 'ok', COPY.webusb.ok)
  }

  const app = env.appUpdated
    ? row('app.current', 'browser', 'blocking', COPY.app.updated, [FIX.reload])
    : row('app.current', 'browser', 'ok', COPY.app.ok(env.version))

  return [secure, webusb, app]
}

/* ---------------------------------------------------------------- *
 * The phone
 * ---------------------------------------------------------------- */

/** The phone has answered: Device Lab owns the interface and the phone allowed this computer. */
const CONNECTED: ReadonlySet<DeviceState> = new Set(['ready', 'busy'])
/** Device Lab owns the interface and is waiting on "Allow USB debugging?". */
const AUTHORIZING: ReadonlySet<DeviceState> = new Set(['authorizing', 'unauthorized'])

/** "If adb comes straight back, an IDE is restarting it…": today's wording, from the hint. */
const IDE_RESTART = DEVICE_HINTS.ADB_SERVER_HOLDING?.extra ?? ''

/**
 * Whether the system, not another program, refused to let the browser open the phone. Until
 * webusb.ts reports USB_ACCESS_DENIED, that refusal arrives as classifyUsbError's answer to a
 * SecurityError — `held` with WEBUSB_CLAIM_FAILED — which on Linux and Windows is the udev
 * rules or a driver: nothing there takes a phone with that error.
 */
function osDenied({ device, os }: PhoneInput): boolean {
  if (!device) return false
  if (device.blockers.includes(USB_ACCESS_DENIED)) return true
  return (
    (os === 'linux' || os === 'windows') &&
    device.state === 'held' &&
    device.blockers.includes('WEBUSB_CLAIM_FAILED')
  )
}

/**
 * The phone's rows, the Gate's numbered steps first (GATE_STEPS), then who holds the phone,
 * then — on Linux and Windows, or once the system refused — the system's own permission.
 */
export function phoneChecks(input: PhoneInput): CheckItem[] {
  // An Android device the helper serves needs nothing from this browser's USB side: one OK
  // row says so, instead of five rows about a phone nobody has to allow here.
  if (!input.device && input.helperPhone) {
    return [row('phone.permission', 'phone', 'ok', COPY.permission.notNeeded(input.helperPhone))]
  }
  // Only the helper's devices (an iPhone, say) and no Add device tried: nobody is using WebUSB
  // here, so one row says it isn't checked, rather than a Warning about a phone nobody plugged.
  if (
    !input.device &&
    input.helperDevice &&
    input.picker === 'none' &&
    input.usb.kind === 'unknown'
  ) {
    return [
      row('phone.permission', 'phone', 'unchecked', COPY.permission.notUsed(input.helperDevice), [
        FIX.addDevice,
      ]),
    ]
  }
  const denied = osDenied(input)
  const rows = [
    usbDebuggingRow(input),
    cableRow(input),
    permissionRow(input),
    authorizedRow(input),
    notHeldRow(input, denied),
  ]
  const access = osAccessRow(input, denied)
  return access ? [...rows, access] : rows
}

function usbDebuggingRow({ device, usb }: PhoneInput): CheckItem {
  const id = 'phone.usbDebugging'
  const turnOn = [FIX.developerOptions, FIX.usbDebugging, FIX.devOptionsGuide]
  // Device Lab only sees devices that have the ADB interface, so seeing one at all means it is on.
  if (device || usb.kind === 'adb') return row(id, 'phone', 'ok', COPY.usbDebugging.ok)
  switch (usb.kind) {
    case 'debugging-off':
      return row(id, 'phone', 'blocking', COPY.usbDebugging.off(usb.name), [
        ...turnOn,
        primary(FIX.addDevice),
      ])
    case 'bootloader':
      return row(id, 'phone', 'warning', COPY.usbDebugging.bootloader(usb.name), [
        primary(FIX.addDevice),
      ])
    case 'not-android':
      return row(
        id,
        'phone',
        'warning',
        COPY.usbDebugging.notAndroid,
        [primary(FIX.addDevice), FIX.findPhone],
        COPY.usbDebugging.picked(usb.name, usb.sure),
      )
    case 'not-listed':
      return row(id, 'phone', 'warning', COPY.usbDebugging.notListed, [
        FIX.usbDebugging,
        primary(FIX.findPhone),
      ])
    case 'unknown':
      return row(id, 'phone', 'unchecked', COPY.usbDebugging.unchecked, turnOn)
  }
}

function cableRow({ device, usb }: PhoneInput): CheckItem {
  // Whatever the browser can describe came over the data lines; a charge-only cable shows nothing.
  const seen =
    device !== null ||
    usb.kind === 'adb' ||
    usb.kind === 'debugging-off' ||
    usb.kind === 'bootloader'
  return seen
    ? row('phone.cable', 'phone', 'ok', COPY.cable.ok)
    : row('phone.cable', 'phone', 'unchecked', COPY.cable.unchecked)
}

function permissionRow({ device, usb, picker, browser }: PhoneInput): CheckItem {
  const id = 'phone.permission'
  // "Find my phone…" grants what it picks, so a phone found with the ADB interface is allowed too.
  const name = device?.name ?? (usb.kind === 'adb' ? usb.name : null)
  if (name !== null) return row(id, 'phone', 'ok', COPY.permission.ok(BROWSER_NAMES[browser], name))
  // A closed picker usually means the phone wasn't in it, which "Find my phone…" explains.
  return picker === 'dismissed'
    ? row(id, 'phone', 'warning', COPY.permission.dismissed, [
        FIX.addDevice,
        primary(FIX.findPhone),
      ])
    : row(id, 'phone', 'warning', COPY.permission.none, [primary(FIX.addDevice), FIX.findPhone])
}

function authorizedRow({ device, authorizingSince, now }: PhoneInput): CheckItem {
  const id = 'phone.authorized'
  if (!device) return row(id, 'phone', 'unchecked', COPY.authorized.first)
  if (CONNECTED.has(device.state)) return row(id, 'phone', 'ok', COPY.authorized.ok)
  if (AUTHORIZING.has(device.state)) {
    const stuck = authorizingSince !== null && now - authorizingSince >= AUTHORIZE_PATIENCE_MS
    return stuck
      ? row(
          id,
          'phone',
          'warning',
          COPY.authorized.stuck,
          [FIX.retry, FIX.revoke],
          COPY.authorized.newKey,
        )
      : row(id, 'phone', 'warning', COPY.authorized.waiting, [FIX.retry], COPY.authorized.newKey)
  }
  return row(id, 'phone', 'unchecked', COPY.notConnected)
}

function notHeldRow({ device, otherTab, holder, os }: PhoneInput, denied: boolean): CheckItem {
  const id = 'phone.notHeld'
  if (!device) return row(id, 'phone', 'unchecked', COPY.notConnected)
  // The phone was never opened, so who else might have it is unknown.
  if (denied) return row(id, 'phone', 'unchecked', COPY.notHeld.osDenied)
  if (device.state === 'held') {
    if (otherTab) {
      return row(id, 'phone', 'blocking', COPY.notHeld.otherTab(device.name), [
        primary(FIX.releaseOtherTab),
        FIX.reconnect,
      ])
    }
    if (holder) return heldBy(holder, device.name)
    // On Windows the same error can be a maker's driver on the ADB interface, with no adb at
    // all; the tester can tell which, so the row names both and gives both ways out.
    if (os === 'windows') {
      return row(
        id,
        'phone',
        'blocking',
        COPY.notHeld.heldWindows,
        [FIX.killServer, FIX.winUsbSwitch, FIX.winUsb, primary(FIX.reconnect)],
        IDE_RESTART,
      )
    }
    return row(
      id,
      'phone',
      'blocking',
      COPY.notHeld.held,
      [FIX.killServer, primary(FIX.reconnect)],
      IDE_RESTART,
    )
  }
  if (CONNECTED.has(device.state) || AUTHORIZING.has(device.state)) {
    return row(id, 'phone', 'ok', COPY.notHeld.ok)
  }
  return row(id, 'phone', 'unchecked', COPY.notConnected)
}

/** Process names of browsers, which only hold a phone for a page — usually another tab. */
const BROWSER_PROCESS = /chrome|chromium|edge|opera|brave|vivaldi|^arc$/i

/** The holder the helper named (macOS ioreg), in place of the generic "another program". */
function heldBy(holder: UsbHolder, name: string): CheckItem {
  const id = 'phone.notHeld'
  if (/^adb(\.exe)?$/i.test(holder.process)) {
    return row(
      id,
      'phone',
      'blocking',
      COPY.notHeld.adb(holder.pid, name),
      [FIX.killServer, primary(FIX.reconnect)],
      IDE_RESTART,
    )
  }
  if (BROWSER_PROCESS.test(holder.process)) {
    return row(id, 'phone', 'blocking', COPY.notHeld.browser(holder.process, holder.pid, name), [
      primary(FIX.releaseOtherTab),
      FIX.reconnect,
    ])
  }
  return row(id, 'phone', 'blocking', COPY.notHeld.other(holder.process, holder.pid, name), [
    primary(FIX.reconnect),
  ])
}

/** The device got far enough that the system had let the browser open it. */
const OPENED: ReadonlySet<DeviceState> = new Set([...CONNECTED, ...AUTHORIZING, 'held'])

function osAccessRow({ device, os }: PhoneInput, denied: boolean): CheckItem | null {
  const id = 'phone.osAccess'
  // `held` is sticky, so once the tester has fixed the system nothing reconnects by itself:
  // every refusal ends in Reconnect, as the USB_ACCESS_DENIED hint this row stands in for does.
  if (denied) {
    if (os === 'linux') {
      return row(
        id,
        'phone',
        'blocking',
        COPY.osAccess.linux,
        [
          FIX.udevRules,
          FIX.udevFedora,
          FIX.udevArch,
          FIX.plugdev,
          FIX.snapUsb,
          primary(FIX.reconnect),
        ],
        COPY.osAccess.linuxDetail,
      )
    }
    if (os === 'windows') {
      return row(
        id,
        'phone',
        'blocking',
        COPY.osAccess.windows,
        [FIX.winUsbSwitch, FIX.winUsb, FIX.killServer, primary(FIX.reconnect)],
        COPY.osAccess.windowsDetail,
      )
    }
    return row(id, 'phone', 'blocking', COPY.osAccess.other, [primary(FIX.reconnect)])
  }
  // macOS and ChromeOS put no permission of their own between the browser and the phone.
  if (os !== 'linux' && os !== 'windows') return null
  return device && OPENED.has(device.state)
    ? row(id, 'phone', 'ok', COPY.osAccess.ok)
    : row(id, 'phone', 'unchecked', COPY.osAccess.unchecked)
}

/* ---------------------------------------------------------------- *
 * The local helper (spec §12b, §12c)
 *
 * Its own rows — reaching it, whether it runs, its version, the pairing, the published file —
 * come from HelperConnection's status and are worded here. This Mac's tools come from
 * /api/doctor and keep the helper's words, so the terminal and the page say the same thing;
 * the page only adjusts how much they matter here (relevance), never what they say.
 * ---------------------------------------------------------------- */

/** What else the helper's rows read. Everything is optional: a missing fact leaves its default. */
export interface HelperCheckContext {
  /** Names the browser's settings path for a blocked permission. */
  readonly browser?: BrowserName
  /** This browser has WebUSB: without it, Android needs adb and its server (relevance). */
  readonly webusb?: boolean
  /** The listed devices: an iOS 16 or older phone puts the legacy screenshot tool in play. */
  readonly devices?: readonly Pick<Device, 'platform' | 'osVersion' | 'connection'>[]
  /** The published helper file (Environment check only). Undefined: no update row. */
  readonly published?: PublishedHelper | null
}

/** Phases in which a helper answered /api/health, so its version and fingerprint are known. */
const ANSWERED: ReadonlySet<HelperProbe['phase']> = new Set([
  'connected',
  'unpaired',
  'stale',
  'outdated',
  'newer',
])

const helperAddress = (probe: HelperProbe) => `127.0.0.1:${String(probe.env.port)}`

const copyCommand = (command: string, primaryFix = false): Fix => ({
  label: 'Copy command',
  copy: command,
  ...(primaryFix ? { primary: true } : {}),
})

/**
 * The local helper's rows: the page's own (reach, running, version, pairing, and the published
 * file when `ctx.published` is given), then this Mac's tools from /api/doctor.
 *
 * `probe` null: no helper connection at all — only the install dialog's .aab card asks that,
 * and gets the P1 rows saying the .aab helper is coming. `doctor` null: /api/doctor hasn't
 * answered yet (it needs a connected, paired page).
 */
export function helperChecks(
  probe: HelperProbe | null,
  doctor: DoctorReport | null = null,
  ctx: HelperCheckContext = {},
): CheckItem[] {
  if (!probe) return aabHelperChecks(null, null)
  const rows = [
    reachRow(probe, ctx.browser ?? 'other'),
    helperRunningRow(probe),
    helperVersionRow(probe),
    pairingRow(probe),
  ]
  if (ctx.published !== undefined) rows.push(updateRow(probe, ctx.published))
  return [...rows, ...toolChecks(probe, doctor, ctx)]
}

/** Whether this page may reach the helper at all: the browser's Local Network Access (§6.3). */
function reachRow(probe: HelperProbe, browser: BrowserName): CheckItem {
  const id = 'helper.lna'
  if (probe.env.mode === 'local' || probe.permission === 'not-needed') {
    return row(id, 'helper', 'ok', COPY.reach.local, [], COPY.reach.localCosts)
  }
  // Safari never lets an https page reach 127.0.0.1; the helper's own copy of the page can.
  if (probe.env.safariLike) {
    return row(id, 'helper', 'blocking', COPY.reach.safari, [helperPageFix(probe.env.port)])
  }
  // An answer proves the page may reach it, whatever the permission read before.
  if (probe.health && ANSWERED.has(probe.phase))
    return row(id, 'helper', 'ok', COPY.reach.granted, [], COPY.reach.grantedScope)
  switch (probe.permission) {
    case 'granted':
      return row(id, 'helper', 'ok', COPY.reach.granted, [], COPY.reach.grantedScope)
    case 'unsupported':
      return row(id, 'helper', 'ok', COPY.reach.unsupported)
    case 'prompt':
      return row(id, 'helper', 'unchecked', COPY.reach.prompt, [FIX.connectHelper])
    case 'denied':
      return row(id, 'helper', 'blocking', COPY.reach.denied, [
        ...lnaFixes(browser),
        { ...helperPageFix(probe.env.port), primary: false },
      ])
  }
}

function helperRunningRow(probe: HelperProbe): CheckItem {
  const id = 'helper.running'
  const address = helperAddress(probe)
  const { phase, health, env } = probe
  if (ANSWERED.has(phase) && health) {
    return row(id, 'helper', 'ok', COPY.helperRunning.ok(health.version, address))
  }
  switch (phase) {
    case 'off':
      return row(id, 'helper', 'unchecked', COPY.helperRunning.unchecked, [FIX.connectHelper])
    case 'checking':
      return row(id, 'helper', 'unchecked', COPY.helperRunning.checking(address))
    case 'dismissed':
      return row(id, 'helper', 'unchecked', COPY.helperRunning.dismissed, [FIX.connectHelper])
    case 'denied':
    case 'safari':
      // The helper's own page, the way round the block, exists only while the helper runs.
      return row(
        id,
        'helper',
        'unchecked',
        COPY.helperRunning.blocked,
        [copyCommand(downloadCommand(env.port)), FIX.getNode],
        COPY.helperRunning.node,
      )
    case 'absent':
      // A dev server is refused unless the helper runs with --dev, and that refusal looks
      // exactly like nothing listening (no CORS headers, so a TypeError).
      return row(
        id,
        'helper',
        'blocking',
        env.devOrigin ? COPY.helperRunning.absentDev(address) : COPY.helperRunning.absent(address),
        [
          copyCommand(env.devOrigin ? DEV_COMMAND : downloadCommand(env.port)),
          FIX.checkHelper,
          FIX.getNode,
        ],
        COPY.helperRunning.node,
      )
    case 'lost':
      // On the port this page polls, or it never reconnects by itself.
      return row(id, 'helper', 'blocking', COPY.helperRunning.lost, [
        copyCommand(startCommand(env.port)),
      ])
    case 'foreign':
      return row(
        id,
        'helper',
        'blocking',
        COPY.helperRunning.foreign(env.port),
        [copyCommand(otherPortCommand(env.port)), FIX.getNode],
        COPY.helperRunning.node,
      )
    default:
      return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  }
}

function helperVersionRow({ phase, health, env }: HelperProbe): CheckItem {
  const id = 'helper.version'
  if (phase === 'outdated') {
    return row(id, 'helper', 'blocking', COPY.helperVersion.outdated(health?.version ?? ''), [
      copyCommand(downloadCommand(env.port)),
    ])
  }
  if (phase === 'newer')
    return row(id, 'helper', 'blocking', COPY.helperVersion.newer, [FIX.reload])
  if (!health || !ANSWERED.has(phase)) return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  return row(id, 'helper', 'ok', COPY.helperVersion.ok(health.protocol, health.version))
}

function pairingRow({ phase, pairing, env }: HelperProbe): CheckItem {
  const id = 'helper.paired'
  switch (phase) {
    case 'connected':
      return pairing
        ? row(id, 'helper', 'ok', COPY.pairing.ok(pairing.tokenId, pairing.remembered))
        : row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
    case 'unpaired':
      return row(id, 'helper', 'blocking', COPY.pairing.unpaired, [FIX.pair])
    case 'stale':
      return row(id, 'helper', 'blocking', COPY.pairing.stale, [FIX.pair])
    case 'foreign':
      return row(id, 'helper', 'blocking', COPY.pairing.foreign(env.port))
    case 'outdated':
    case 'newer':
      return row(id, 'helper', 'unchecked', COPY.pairing.waitVersion)
    default:
      return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  }
}

/**
 * Compares two dotted versions numerically ("1.10.0" > "1.9.2"); a missing part counts as 0 and
 * anything after a `-` is ignored. Negative, zero or positive, like a sort comparator.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map((n) => Number(n) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Whether the running helper is the published file (same SHA-256), or which is newer. */
function updateRow(probe: HelperProbe, published: PublishedHelper | null): CheckItem {
  const id = 'helper.update'
  const { health } = probe
  if (!health || !ANSWERED.has(probe.phase)) {
    return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  }
  if (!published) return row(id, 'helper', 'unchecked', COPY.update.unchecked)
  if (published.sha256.toLowerCase() === health.sha256.toLowerCase()) {
    return row(id, 'helper', 'ok', COPY.update.ok(published.version))
  }
  const download = [copyCommand(downloadCommand(probe.env.port))]
  return compareVersions(published.version, health.version) > 0
    ? row(id, 'helper', 'warning', COPY.update.newer(published.version), download)
    : row(id, 'helper', 'warning', COPY.update.differs, download)
}

/* -- This Mac's tools, from /api/doctor -- */

/** The doctor's groups this page shows as they are; its other groups are the page's own rows. */
const TOOL_GROUPS: ReadonlySet<string> = new Set(['mac', 'ios', 'android'])
const TOOL_ID = /^(?:mac|ios|android)\.[a-z0-9][a-z0-9.-]*$/

/** Whether a doctor row's id is one this page may show (protocol.ts already capped it). */
export const isToolId = (id: string): id is ToolCheckId => TOOL_ID.test(id)

/** The page's FixAction for each of the helper's actions; open-local is a link instead. */
const TOOL_ACTIONS: Readonly<Record<Exclude<PreflightAction, 'open-local'>, FixAction>> = {
  connect: 'connect-helper',
  pair: 'pair-helper',
  reload: 'reload',
  'start-adb': 'start-adb',
  retry: 'retry',
  recheck: 'recheck',
}

/** One of the helper's fixes as the checklist draws it. */
export function toolFix(fix: PreflightFix, port: number): Fix {
  switch (fix.kind) {
    case 'command':
      return copyCommand(fix.command)
    case 'link':
      return { label: fix.label, href: fix.href }
    case 'step':
      return { label: 'Steps', path: fix.text }
    case 'action':
      return fix.action === 'open-local'
        ? { ...helperPageFix(port), label: fix.label, primary: false }
        : { label: fix.label, action: TOOL_ACTIONS[fix.action] }
  }
}

const hasAction = (fixes: readonly Fix[], action: FixAction) =>
  fixes.some((f) => 'action' in f && f.action === action)

/**
 * The capabilities that make an optional tool worth showing (§12c relevance): the legacy
 * screenshot tool once an iOS 16 or older iPhone is listed, the fallback once the helper failed
 * to open an iPhone's secure session. `android.aab` is never in play in v1.
 */
function optionalInPlay(
  items: readonly PreflightItem[],
  devices: HelperCheckContext['devices'] = [],
): ReadonlySet<Capability> {
  const inPlay = new Set<Capability>()
  const legacy = devices.some((d) => {
    const major = majorOf(d.osVersion)
    return d.platform === 'ios' && d.connection !== 'simulator' && major !== null && major <= 16
  })
  if (legacy) inPlay.add('ios.screenshot.legacy')
  if (items.some((i) => i.id === 'ios.session')) inPlay.add('ios.fallback')
  return inPlay
}

/**
 * This Mac's tools. Until the helper is connected, one placeholder row says how to get them
 * checked; once it is, the doctor's rows in its words, with the page's relevance rules:
 * - adb missing in a browser without WebUSB blocks Android altogether;
 * - a stopped adb server only matters without WebUSB, and only then offers Start adb server
 *   (which the helper must also list as a feature): otherwise starting it would take Android
 *   phones away from Chrome's WebUSB for nothing;
 * - no row offers Start adb server while adb isn't installed: it could only fail, and the adb
 *   row above says to install it first (as the Gate's Android card does);
 * - an optional tool nothing here needs moves to the Optional tools section.
 */
export function toolChecks(
  probe: HelperProbe,
  doctor: DoctorReport | null,
  ctx: HelperCheckContext = {},
): CheckItem[] {
  // A helper that answers needs pairing or a matching version, not starting.
  if (probe.phase === 'unpaired' || probe.phase === 'stale')
    return [row('mac.tools', 'mac', 'unchecked', COPY.tools.unpaired)]
  if (probe.phase === 'outdated' || probe.phase === 'newer')
    return [row('mac.tools', 'mac', 'unchecked', COPY.pairing.waitVersion)]
  // No command here: the helper's own row, just above, carries the one to start it.
  if (probe.phase !== 'connected')
    return [row('mac.tools', 'mac', 'unchecked', COPY.tools.notConnected)]
  if (!doctor) return [row('mac.tools', 'mac', 'unchecked', COPY.tools.pending)]
  const items = doctor.items.filter((i) => TOOL_GROUPS.has(i.group))
  const inPlay = optionalInPlay(items, ctx.devices)
  const webusb = ctx.webusb ?? true
  const canStart = probe.health?.features.includes('android.start-server') ?? false
  const adb = items.find((i) => i.id === 'android.adb')
  const adbReady = !adb || adb.status === 'ok'
  return items.flatMap((item): CheckItem[] => {
    const { id } = item
    if (!isToolId(id)) return []
    let status = item.status
    let sentence = item.sentence
    let fixes = item.fixes.map((fix) => toolFix(fix, probe.env.port))
    const notes = item.fixes.flatMap((fix) =>
      fix.kind === 'command' && fix.note ? [fix.note] : [],
    )
    if (id === 'android.adb' && status === 'warning' && !webusb) status = 'blocking'
    if (id === 'android.adb-server' && hasAction(fixes, 'start-adb') && adbReady) {
      if (!webusb) {
        status = 'warning'
        sentence = COPY.tools.adbServerNeeded
      }
      if (webusb || !canStart)
        fixes = fixes.filter((f) => !('action' in f && f.action === 'start-adb'))
    }
    if (!adbReady) fixes = fixes.filter((f) => !('action' in f && f.action === 'start-adb'))
    const relevant = !item.optional || item.neededFor.some((cap) => inPlay.has(cap))
    const group: CheckGroup = relevant ? item.group : 'optional'
    const detail = [item.detail ?? '', ...notes].filter(Boolean).join(' · ')
    return [
      {
        id,
        group,
        label: item.label,
        status,
        sentence,
        ...(fixes.length > 0 ? { fixes } : {}),
        ...(detail ? { detail } : {}),
      },
    ]
  })
}

/* -- Devices -- */

/** The newest iOS major this helper version knows (spec §12b `.ios-version`). */
export const IOS_KNOWN_MAX = 27
/** The oldest iOS the helper is tested on. */
export const IOS_TESTED_MIN = 15

/** "27.0.1" → 27; null when there is no number. */
export function majorOf(version: string): number | null {
  const m = /^(\d+)/.exec(version.trim())
  return m ? Number(m[1]) : null
}

const nameOf = (d: Pick<Device, 'name' | 'model' | 'id'>) => d.name || d.model || d.id

/** The tool row a device's screenshot blocker points at, in the order §12d names them. */
const BLOCKER_TOOLS: Readonly<Record<string, readonly string[]>> = {
  XCODE_REQUIRED: ['ios.xcode'],
  XCODE_SETUP_REQUIRED: ['ios.xcode'],
  TOOL_MISSING: ['ios.libimobiledevice', 'ios.session'],
}

/** Blockers that send the page to /api/doctor for the rows under a device's hint. */
export const TOOL_BLOCKERS: ReadonlySet<string> = new Set([
  ...Object.keys(BLOCKER_TOOLS),
  'IOS_DDI_REQUIRED',
])

/** The tool rows behind a device's first tool blocker, worst first; [] when none applies. */
function toolsFor(device: Pick<Device, 'blockers'>, tools: readonly CheckItem[]): CheckItem[] {
  const code = device.blockers.find((c) => c in BLOCKER_TOOLS)
  if (!code) return []
  const ids = BLOCKER_TOOLS[code] ?? []
  return bySeverity(tools.filter((t) => ids.includes(t.id)))
}

/**
 * The rows under a device's hint card in its detail pane (§12d inline): the helper's row for the
 * tool its first blocker needs ("Xcode is installed, but the Command Line Tools are selected"
 * and the exact command), which the hint itself can't know. `tools` are toolChecks' rows.
 */
export function inlineChecks(device: Device, tools: readonly CheckItem[]): CheckItem[] {
  if (device.backend !== 'agent') return []
  return toolsFor(device, tools).filter((t) => t.status !== 'ok')
}

/** One iPhone's rows: trust, lock, Developer Mode, iOS version and screenshots. */
function iosRows(d: Device, tools: readonly CheckItem[]): CheckItem[] {
  const name = nameOf(d)
  const label = (what: string) => COPY.device.label(name, what)
  const at = (what: string): DeviceCheckId => `device.${d.id}.${what}`
  const major = majorOf(d.osVersion)

  let version: CheckItem[] = []
  if (major !== null) {
    const v = (status: CheckStatus, sentence: string, fixes: readonly Fix[] = []) =>
      cell(at('ios-version'), label('iOS version'), status, sentence, fixes)
    version = [
      major > IOS_KNOWN_MAX
        ? v('warning', COPY.device.iosNew(major), [copyCommand(DOWNLOAD_COMMAND)])
        : major < IOS_TESTED_MIN
          ? v('warning', COPY.device.iosOld)
          : v('ok', COPY.device.iosOk(d.osVersion)),
    ]
  }

  if (d.state === 'untrusted' || d.state === 'authorizing') {
    // Nothing else can be read until the iPhone trusts this Mac.
    return [
      cell(at('trust'), label('Trust'), 'blocking', COPY.device.trust, [
        { label: 'iPhone', path: COPY.device.noneIosStep },
      ]),
      ...version,
    ]
  }
  const rows = [cell(at('trust'), label('Trust'), 'ok', COPY.device.trustOk)]
  rows.push(
    d.state === 'locked'
      ? cell(at('lock'), label('Unlocked'), 'blocking', COPY.device.lock, [
          { label: 'iPhone', path: COPY.device.lockStep },
        ])
      : cell(at('lock'), label('Unlocked'), 'ok', COPY.device.lockOk),
  )
  // iOS 15 has no Developer Mode at all.
  if (major === null || major >= 16) {
    rows.push(
      d.blockers.includes('IOS_DEVELOPER_MODE_OFF')
        ? cell(at('devmode'), label('Developer Mode'), 'warning', COPY.device.devMode, [
            { label: 'iPhone', path: COPY.device.devModeStep },
          ])
        : cell(at('devmode'), label('Developer Mode'), 'ok', COPY.device.devModeOk),
    )
  }
  rows.push(...version)
  if (d.state === 'ready') {
    if (d.capabilities.screenshot) {
      rows.push(cell(at('screenshots'), label('Screenshots'), 'ok', COPY.device.shotsOk))
    } else if (d.blockers.includes('IOS_DDI_REQUIRED')) {
      // A warning, as the tool rows that cause it are: everything else on a ready device works.
      rows.push(
        cell(at('screenshots'), label('Screenshots'), 'warning', COPY.device.ddi, [
          { label: 'iPhone', path: COPY.device.ddiStep },
        ]),
      )
    } else {
      // The tool that would take it says why and how (Xcode, libimobiledevice).
      const tool = toolsFor(d, tools)[0]
      rows.push(
        cell(
          at('screenshots'),
          label('Screenshots'),
          'warning',
          COPY.device.shotsOff,
          tool?.fixes ?? [],
          tool ? `${tool.label}: ${tool.sentence}` : '',
        ),
      )
    }
  }
  return rows
}

/** A device row: its label names the device, since a section can hold several. */
function cell(
  id: DeviceCheckId,
  label: string,
  status: CheckStatus,
  sentence: string,
  fixes: readonly Fix[] = [],
  detail = '',
): CheckItem {
  return {
    id,
    group: 'device',
    label,
    status,
    sentence,
    ...(fixes.length > 0 ? { fixes } : {}),
    ...(detail ? { detail } : {}),
  }
}

/** An Android phone's rows when the helper, or a WebUSB conflict the helper can solve, has it. */
function androidRows(d: Device, connected: boolean): CheckItem[] {
  const label = (what: string) => COPY.device.label(nameOf(d), what)
  if (d.backend === 'webusb') {
    // Held by Google's adb server: the helper shares that server instead of fighting it. Once
    // the helper is connected it lists the phone itself (and its row wins the merge).
    if (d.state !== 'held' || connected) return []
    return [
      cell(`device.${d.id}.adb-conflict`, label('adb server'), 'blocking', COPY.device.conflict, [
        FIX.killServer,
        FIX.useHelper,
      ]),
    ]
  }
  if (d.backend !== 'agent') return []
  if (d.connection === 'network') return wifiDeviceRows(d)
  if (d.state === 'unauthorized' || d.state === 'authorizing') {
    return [
      cell(
        `device.${d.id}.android-auth`,
        label('USB debugging'),
        'blocking',
        COPY.device.androidAuth,
        [{ label: 'Phone', path: COPY.device.androidAuthStep }],
      ),
    ]
  }
  if (d.state === 'offline') {
    return [
      cell(`device.${d.id}.offline`, label('Connection'), 'warning', COPY.device.offline, [
        { label: 'Steps', path: COPY.device.offlineStep },
      ]),
    ]
  }
  return [cell(`device.${d.id}.adb-conflict`, label('adb server'), 'ok', COPY.device.shared)]
}

/** Where a Wi‑Fi device asks to allow this computer: on its screen, with the remote on a TV. */
export const ALLOW_DEBUGGING = { label: 'On the device', path: COPY.wifi.allowStep } satisfies Fix

/** A Wi‑Fi device's rows: allowing this computer is done with the TV's remote, not a cable. */
function wifiDeviceRows(d: Device): CheckItem[] {
  const label = (what: string) => COPY.device.label(nameOf(d), what)
  if (d.state === 'unauthorized' || d.state === 'authorizing') {
    return [
      cell(
        `device.${d.id}.android-auth`,
        label('Debugging'),
        'blocking',
        COPY.wifi.authWaiting(nameOf(d)),
        [ALLOW_DEBUGGING],
      ),
    ]
  }
  if (d.state === 'offline') {
    return [
      cell(`device.${d.id}.offline`, label('Wi‑Fi'), 'warning', COPY.wifi.offline(nameOf(d)), [
        { label: 'Steps', path: COPY.wifi.offlineStep },
        FIX.openWifi,
      ]),
    ]
  }
  return [cell(`device.${d.id}.wifi`, label('Wi‑Fi'), 'ok', COPY.device.sharedWifi)]
}

/** What deviceChecks needs besides the list. */
export interface DeviceCheckContext {
  /** The helper is connected: it would list an iPhone that is plugged in. */
  readonly connected: boolean
  readonly webusb: boolean
  /** toolChecks' rows, for what a screenshot blocker needs. */
  readonly tools?: readonly CheckItem[]
}

/**
 * The Devices section (§12b): each iPhone's trust, lock, Developer Mode, iOS version and
 * screenshots; each Android phone the helper serves; and, with the helper connected, what to
 * plug in when nothing is. Simulators need nothing, so they have no rows.
 */
export function deviceChecks(devices: readonly Device[], ctx: DeviceCheckContext): CheckItem[] {
  const tools = ctx.tools ?? []
  const rows = devices.flatMap((d) => {
    if (d.connection === 'simulator') return []
    return d.platform === 'ios' ? iosRows(d, tools) : androidRows(d, ctx.connected)
  })
  if (!ctx.connected) return rows
  const phones = devices.filter((d) => d.connection !== 'simulator')
  if (!phones.some((d) => d.platform === 'ios')) {
    rows.push(
      cell('device.none.ios', 'iPhone', 'unchecked', COPY.device.noneIos, [
        { label: 'iPhone', path: COPY.device.noneIosStep },
      ]),
    )
  }
  if (!ctx.webusb && !phones.some((d) => d.platform === 'android')) {
    rows.push(
      cell('device.none.android', 'Android phone', 'unchecked', COPY.device.noneAndroid, [
        { label: 'Phone', path: COPY.device.noneAndroidStep },
      ]),
    )
  }
  return rows
}

/* -- Views -- */

/** Every section, in the Environment check's order. */
export const GROUP_ORDER: readonly CheckGroup[] = [
  'browser',
  'phone',
  'helper',
  'mac',
  'ios',
  'android',
  'device',
  'wifi',
  'optional',
  'feature',
]

/** By section, then blocking, warning, not checked, OK; ties keep their order (§12c step 5). */
export function sortChecks(items: readonly CheckItem[]): CheckItem[] {
  const group = (item: CheckItem) => GROUP_ORDER.indexOf(item.group)
  return items
    .slice()
    .sort((a, b) => group(a) - group(b) || SEVERITY[b.status] - SEVERITY[a.status])
}

/** The sections the Gate's checklist card shows: the helper and this Mac's relevant tools. */
const GATE_GROUPS: ReadonlySet<CheckGroup> = new Set(['helper', 'mac', 'ios', 'android'])

/** The Gate's checklist (§12d): never the optional tools, sorted. */
export function gateChecks(items: readonly CheckItem[]): CheckItem[] {
  return sortChecks(items.filter((item) => GATE_GROUPS.has(item.group)))
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

/** "2 need attention · 5 passed · 3 not checked yet", for the Gate's checklist card. */
export function gateSummary(items: readonly CheckItem[]): string {
  const count = (...statuses: CheckStatus[]) =>
    items.filter((item) => statuses.includes(item.status)).length
  const parts = [
    [
      count('blocking', 'warning'),
      plural(count('blocking', 'warning'), 'needs attention', 'need attention'),
    ],
    [count('ok'), plural(count('ok'), 'passed', 'passed')],
    [count('unchecked'), plural(count('unchecked'), 'not checked yet', 'not checked yet')],
  ] as const
  return parts
    .filter(([n]) => n > 0)
    .map(([, text]) => text)
    .join(' · ')
}

/* ---------------------------------------------------------------- *
 * The .aab helper (PLAN §3.4)
 *
 * The P1 plan's rows for a helper that builds APKs from an .aab: Java, bundletool and the
 * debug key. That is a later helper version (spec §12c: `android.aab` is never in play in v1),
 * so the install dialog's .aab card keeps these, and says they are coming, until it exists.
 * ---------------------------------------------------------------- */

const HELPER_IDS = [
  'helper.running',
  'helper.lna',
  'helper.paired',
  'helper.version',
  'aab.java',
  'aab.bundletool',
  'aab.key',
  'helper.adbServer',
] as const satisfies readonly FixedCheckId[]

/** The helper rows an .aab install depends on. The adb server row is about connecting instead. */
const AAB_HELPER_IDS: ReadonlySet<string> = new Set<string>(
  HELPER_IDS.filter((id) => id !== 'helper.adbServer'),
)

/**
 * The .aab card's helper rows. `probe` null: no helper that builds APKs — every row says it is
 * coming rather than pretending to know. `doctor` null: that helper's doctor hasn't answered.
 */
export function aabHelperChecks(probe: AabProbe | null, doctor: AndroidDoctor | null): CheckItem[] {
  if (!probe) return HELPER_IDS.map((id) => row(id, 'helper', 'unchecked', COPY.helper.coming))
  const { health } = probe
  const paired = health !== null && probe.tokenId === health.tokenId
  const waiting = health !== null && !paired ? COPY.helper.waitPairing : COPY.helper.waitAnswer
  const doctorRows = doctor
    ? [javaRow(doctor, health), bundletoolRow(doctor, health), keyRow(doctor), adbServerRow(doctor)]
    : [
        row('aab.java', 'helper', 'unchecked', waiting),
        row('aab.bundletool', 'helper', 'unchecked', waiting),
        row('aab.key', 'helper', 'unchecked', waiting, [], COPY.key.play),
        row('helper.adbServer', 'helper', 'unchecked', waiting),
      ]
  return [runningRow(probe), lnaRow(probe), pairedRow(probe), versionRow(health), ...doctorRows]
}

function runningRow({ health, browser, lna }: AabProbe): CheckItem {
  const id = 'helper.running'
  if (health) return row(id, 'helper', 'ok', COPY.running.ok(health.version))
  // A blocked request fails exactly like a stopped helper; the permission tells them apart.
  if (browser === 'safari' || lna === 'denied') {
    return row(id, 'helper', 'unchecked', COPY.running.blocked)
  }
  return row(
    id,
    'helper',
    'blocking',
    COPY.running.down,
    [FIX.startHelper, FIX.checkHelper],
    COPY.running.node,
  )
}

function lnaRow({ lna, browser, health }: AabProbe): CheckItem {
  const id = 'helper.lna'
  // An answer proves the page may reach it, whatever the permission read before the request
  // (a prompt answered since, a browser without LNA, Safari on the helper's own page).
  if (health) return row(id, 'helper', 'ok', COPY.lna.ok)
  // Safari has no such permission: it blocks https pages from http://127.0.0.1 outright.
  if (browser === 'safari') return row(id, 'helper', 'blocking', COPY.lna.safari, [FIX.helperPage])
  const name = BROWSER_NAMES[browser]
  switch (lna) {
    case 'granted':
      return row(id, 'helper', 'ok', COPY.lna.ok)
    case 'prompt':
      return row(id, 'helper', 'warning', COPY.lna.prompt(name))
    case 'denied':
      return row(id, 'helper', 'blocking', COPY.lna.denied(name), lnaFixes(browser))
    case 'unsupported':
      return row(id, 'helper', 'unchecked', COPY.lna.unsupported)
  }
}

function lnaFixes(browser: BrowserName): Fix[] {
  if (browser === 'firefox') return [FIX.lnaFirefox]
  const scheme = browser === 'edge' ? 'edge' : browser === 'opera' ? 'opera' : 'chrome'
  return [FIX.lnaChromium, siteSettingsFix(scheme)]
}

function pairedRow({ health, tokenId }: AabProbe): CheckItem {
  const id = 'helper.paired'
  if (!health) return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  if (tokenId === null) return row(id, 'helper', 'warning', COPY.paired.none, [FIX.pair])
  // The token changes on every start: a stale one means the helper restarted, not a typo.
  if (tokenId !== health.tokenId) return row(id, 'helper', 'warning', COPY.paired.stale, [FIX.pair])
  return row(id, 'helper', 'ok', COPY.paired.ok)
}

function versionRow(health: HelperHealth | null): CheckItem {
  const id = 'helper.version'
  if (!health) return row(id, 'helper', 'unchecked', COPY.helper.waitAnswer)
  const capable =
    health.protocol >= HELPER_MIN_PROTOCOL && (health.capabilities ?? []).includes(BUILD_APKS)
  return capable
    ? row(id, 'helper', 'ok', COPY.version.ok(health.version))
    : row(id, 'helper', 'blocking', COPY.version.old, [FIX.helperDownload])
}

/** Homebrew commands only help on a Mac; a helper that doesn't say gets them too. */
const onMac = (health: HelperHealth | null) => !health?.platform || health.platform === 'darwin'

/**
 * The major version from what `java -version` printed: `1.8.0_402` is Java 8, `21.0.11` is 21.
 * Null when there is no number to read.
 */
export function javaMajor(version: string): number | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(version)
  if (!m) return null
  const first = Number(m[1])
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first
}

function javaRow({ java }: AndroidDoctor, health: HelperHealth | null): CheckItem {
  const id = 'aab.java'
  const fixes = onMac(health) ? [FIX.java, FIX.brewJava] : [FIX.java]
  if (!java.found) return row(id, 'helper', 'blocking', COPY.java.missing, fixes)
  const major = javaMajor(java.version)
  if (major === null) return row(id, 'helper', 'warning', COPY.java.unreadable, fixes)
  if (major < 11) return row(id, 'helper', 'blocking', COPY.java.old(java.version), fixes)
  return row(id, 'helper', 'ok', COPY.java.ok(java.version, java.vendor))
}

function bundletoolRow({ bundletool }: AndroidDoctor, health: HelperHealth | null): CheckItem {
  const id = 'aab.bundletool'
  if (bundletool.found) return row(id, 'helper', 'ok', COPY.bundletool.ok(bundletool.version))
  const fixes = onMac(health)
    ? [FIX.downloadBundletool, FIX.brewBundletool]
    : [FIX.downloadBundletool]
  return row(id, 'helper', 'warning', COPY.bundletool.missing, fixes)
}

function keyRow({ keystore }: AndroidDoctor): CheckItem {
  // The Play caveat shows either way: it is what a debug-signed build means.
  return keystore.found
    ? row('aab.key', 'helper', 'ok', COPY.key.ok, [], COPY.key.play)
    : row('aab.key', 'helper', 'warning', COPY.key.missing, [FIX.createKey], COPY.key.play)
}

/** "Pixel 9", "Pixel 9 and Galaxy S21", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

function adbServerRow({ adbServer }: AndroidDoctor): CheckItem {
  const id = 'helper.adbServer'
  if (!adbServer.running) return row(id, 'helper', 'ok', COPY.adbServer.ok)
  if (adbServer.devices.length === 0) {
    return row(id, 'helper', 'warning', COPY.adbServer.running, [FIX.killServer])
  }
  // `host:devices-l` writes models with underscores: model:Pixel_9.
  const names = adbServer.devices.map((d) => d.model?.replace(/_/g, ' ') || d.serial)
  return row(id, 'helper', 'blocking', COPY.adbServer.holds(joinNames(names)), [FIX.killServer])
}

/* ---------------------------------------------------------------- *
 * Features (PLAN §3.3)
 * ---------------------------------------------------------------- */

/** The prerequisites of one feature, for its inline card (and the dialog's Features section). */
export function featureChecks(feature: Feature, ctx: FeatureContext): CheckItem[] {
  switch (feature) {
    case 'install':
      return installRows(ctx)
    case 'xapk':
      return [...installRows(ctx), unzipRow(ctx)]
    case 'apkm':
      return [...installRows(ctx), unzipRow(ctx), ...apkmRows(ctx)]
    case 'aab':
      return [...installRows(ctx), ...aabRows(ctx)]
    case 'images':
      return [imagesRow(ctx)]
    case 'viewer':
      return heicRows(ctx)
    case 'summary':
      return [...installRows(ctx), unzipRow(ctx), ...(ctx.images ? [imagesRow(ctx)] : [])]
  }
}

const XIAOMI = /^(xiaomi|redmi|poco)$/i

/** The rows every install shares, whatever the file. */
function installRows(ctx: FeatureContext): CheckItem[] {
  const phone = ctx.phone ?? null
  if (!phone) {
    return [
      row('install.android', 'feature', 'unchecked', COPY.install.unchecked),
      row('install.verify', 'feature', 'unchecked', COPY.install.unchecked),
    ]
  }
  // verifier_verify_adb_installs is "Verify apps over USB". Unread, or `null` (never set), it
  // is at its default: on.
  const verify =
    ctx.verifyAdbInstalls === '0'
      ? row('install.verify', 'feature', 'ok', COPY.install.verifyOff)
      : row('install.verify', 'feature', 'warning', COPY.install.verify)
  return [androidRow(phone), ...oemRows(phone, ctx.userRestricted === true), verify]
}

function androidRow({ sdk, release }: InstallPhone): CheckItem {
  const id = 'install.android'
  if (sdk === null) return row(id, 'feature', 'unchecked', COPY.install.unchecked)
  const running = release ? `Android ${release}` : `API ${String(sdk)}`
  return sdk < MIN_INSTALL_SDK
    ? row(id, 'feature', 'blocking', COPY.install.old(running))
    : row(id, 'feature', 'ok', COPY.install.ok(running))
}

/**
 * Xiaomi's "Install via USB" toggle can't be read, so its phones get the warning up front and
 * the block once Android has refused with INSTALL_FAILED_USER_RESTRICTED. Other phones only
 * get a row after such a refusal: there is nothing known to warn about before it.
 */
function oemRows(phone: InstallPhone, restricted: boolean): CheckItem[] {
  if (XIAOMI.test(phone.brand) || XIAOMI.test(phone.manufacturer)) {
    return [
      row('install.oem', 'feature', restricted ? 'blocking' : 'warning', COPY.install.xiaomi, [
        FIX.xiaomiUsbInstall,
      ]),
    ]
  }
  return restricted ? [row('install.oem', 'feature', 'blocking', COPY.install.restricted)] : []
}

function unzipRow({ inflate }: FeatureContext): CheckItem {
  const id = 'install.unzip'
  if (inflate === undefined) return row(id, 'feature', 'unchecked', COPY.unzip.unchecked)
  return inflate
    ? row(id, 'feature', 'ok', COPY.unzip.ok)
    : row(id, 'feature', 'blocking', COPY.unzip.missing, [FIX.getChrome])
}

function apkmRows({ apkmEncrypted }: FeatureContext): CheckItem[] {
  // Unknown until the file's first bytes are read; there is nothing to say before that.
  if (apkmEncrypted === undefined) return []
  return [
    apkmEncrypted
      ? row('install.apkmEncrypted', 'feature', 'blocking', COPY.apkm.encrypted)
      : row('install.apkmEncrypted', 'feature', 'ok', COPY.apkm.ok),
  ]
}

/**
 * An .aab never goes to the phone as it is: bundletool must build APKs from it, which only the
 * helper can run. Without a helper (all of P1) the card says so, lists the helper's rows as
 * coming, and offers the manual bundletool command — which stays offered until the helper can
 * actually do the build.
 */
function aabRows(ctx: FeatureContext): CheckItem[] {
  const probe = ctx.probe ?? null
  const helper = aabHelperChecks(probe, ctx.doctor ?? null).filter((r) => AAB_HELPER_IDS.has(r.id))
  const ready = helper.every((r) => r.status === 'ok' || r.status === 'warning')
  const rows = probe ? helper : [row('aab.build', 'feature', 'blocking', COPY.aab.build), ...helper]
  if (ready) return rows
  return [
    ...rows,
    row(
      'aab.manual',
      'feature',
      'warning',
      COPY.aab.manual,
      [bundletoolFix(bundletoolCommand(ctx.fileName))],
      COPY.aab.manualDetail,
    ),
  ]
}

/** The first line of the phone's complaint, short enough for a sentence. */
function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const short = line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line
  return short.replace(/\.+$/, '')
}

function imagesRow({ images }: FeatureContext): CheckItem {
  const id = 'images.mediastore'
  const outcome: ImagesOutcome = images ?? { status: 'loading' }
  switch (outcome.status) {
    case 'loading':
      return row(id, 'feature', 'unchecked', COPY.images.loading)
    case 'listed':
      return row(id, 'feature', 'ok', COPY.images.ok)
    case 'fallback':
      return row(id, 'feature', 'warning', COPY.images.fallback, [FIX.retryImages])
    case 'failed':
      return row(id, 'feature', 'blocking', COPY.images.failed(firstLine(outcome.stderr)), [
        primary(FIX.retryImages),
      ])
  }
}

const HEIC = /^image\/hei[cf](-sequence)?$/i

/** The viewer's note on an image the browser can't draw. Safari draws HEIC; Chrome doesn't. */
function heicRows({ mime, browser = 'other' }: FeatureContext): CheckItem[] {
  if (!mime || !HEIC.test(mime) || browser === 'safari') return []
  return [
    row('images.heic', 'feature', 'warning', COPY.images.heic(BROWSER_NAMES[browser]), [
      FIX.saveImage,
    ]),
  ]
}

/* ---------------------------------------------------------------- *
 * Summaries
 * ---------------------------------------------------------------- */

/** The status a group of rows adds up to: the card's tint, and whether its button is enabled. */
export function worst(items: readonly CheckItem[]): CheckStatus {
  let result: CheckStatus = 'ok'
  for (const item of items) if (SEVERITY[item.status] > SEVERITY[result]) result = item.status
  return result
}

/** Blocking rows first, then warnings, then the unknown, then OK; ties keep their order. */
export function bySeverity(items: readonly CheckItem[]): CheckItem[] {
  return items.slice().sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status])
}

function fixText(fix: Fix): string {
  if ('copy' in fix) return `\`${fix.copy}\``
  if ('href' in fix) return `${fix.label}: ${fix.href}`
  if ('path' in fix) return `${fix.label}: ${fix.path}`
  return fix.label
}

/** A run of exactly 43 base64url characters: the shape of the helper's token (32 bytes). */
const TOKEN_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g

/**
 * Anything that could be the helper's token: a `#pair=` fragment, a bearer header, a `token=`
 * parameter, or a bare 43-character token. No row should carry one; this makes sure a pasted
 * checklist never does. (A SHA-256 in hex is 64 characters, and a fingerprint 8: both stay.)
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/#pair=[^\s)`'"]+/g, '#pair=…')
    .replace(/\bBearer\s+\S+/g, 'Bearer …')
    .replace(/([?&]token=)[^\s&#)`'"]+/g, '$1…')
    .replace(TOKEN_RUN, '…')
}

/**
 * "Copy as text" in the Environment check: one `status — label — sentence — fixes` line per
 * row, under its section's title, ready to paste into a ticket.
 */
export function checklistText(items: readonly CheckItem[], phone?: string): string {
  const sections: string[] = []
  for (const group of GROUP_ORDER) {
    const rows = items.filter((item) => item.group === group)
    if (rows.length === 0) continue
    const title =
      group === 'phone' && phone ? `${GROUP_TITLES.phone}: ${phone}` : GROUP_TITLES[group]
    const lines = rows.map((item) => {
      const parts = [
        STATUS_META[item.status].label,
        item.label,
        item.detail ? `${item.sentence} ${item.detail}` : item.sentence,
      ]
      if (item.fixes && item.fixes.length > 0) parts.push(item.fixes.map(fixText).join(' · '))
      return parts.join(' — ')
    })
    sections.push([title, ...lines].join('\n'))
  }
  return redactSecrets(sections.join('\n\n'))
}

/* ---------------------------------------------------------------- *
 * Android over Wi‑Fi (§4.7)
 *
 * The path a Wi‑Fi device takes, in order: the helper (running and paired, and new enough to
 * connect), Google's adb server, the device answering at its address, and the device allowing
 * this computer. The Wi‑Fi dialog shows them while it connects; the Environment check lists
 * them once the tester tried.
 * ---------------------------------------------------------------- */

/** "192.168.1.20:5555", or "[fe80::1]:5555". */
const wifiAddress = (a: Pick<WifiAttempt, 'host' | 'port'>) =>
  `${a.host.includes(':') ? `[${a.host}]` : a.host}:${String(a.port)}`

/** Whether the helper can take a Wi‑Fi connect right now: running, paired, and new enough. */
export function wifiHelperReady(helper: HelperProbe): boolean {
  return (
    helper.phase === 'connected' &&
    helper.pairing !== null &&
    (helper.health?.features.includes('android.connect') ?? false)
  )
}

function wifiHelperRow(helper: HelperProbe): CheckItem {
  const id = 'wifi.helper'
  if (helper.phase === 'connected' && helper.pairing) {
    return helper.health?.features.includes('android.connect')
      ? row(id, 'wifi', 'ok', COPY.wifi.helperOk(helper.pairing.tokenId))
      : row(id, 'wifi', 'blocking', COPY.wifi.helperOld, [
          copyCommand(downloadCommand(helper.env.port), true),
        ])
  }
  if (helper.phase === 'unpaired' || helper.phase === 'stale') {
    return row(id, 'wifi', 'blocking', COPY.wifi.helperUnpaired, [FIX.pair])
  }
  if (helper.phase === 'outdated') {
    return row(id, 'wifi', 'blocking', COPY.wifi.helperOld, [
      copyCommand(downloadCommand(helper.env.port), true),
    ])
  }
  const command = helper.env.devOrigin ? DEV_COMMAND : downloadCommand(helper.env.port)
  return row(id, 'wifi', 'blocking', COPY.wifi.helperOff, [copyCommand(command), FIX.connectHelper])
}

function wifiAdbRow(helper: HelperProbe): CheckItem {
  const id = 'wifi.adbServer'
  const android = helper.phase === 'connected' ? helper.lanes?.android : undefined
  if (!android) return row(id, 'wifi', 'unchecked', COPY.wifi.adbUnchecked)
  if (android.status === 'ok') return row(id, 'wifi', 'ok', COPY.wifi.adbOk)
  if (android.status === 'off') {
    return row(id, 'wifi', 'blocking', COPY.wifi.adbOff, [], COPY.wifi.adbOffStep)
  }
  if (android.adb === 'missing') {
    return row(id, 'wifi', 'blocking', COPY.wifi.adbMissing, [primary(FIX.installAdb)])
  }
  if (android.status === 'stopped') {
    const canStart = helper.health?.features.includes('android.start-server') ?? false
    return row(
      id,
      'wifi',
      'blocking',
      COPY.wifi.adbStopped,
      canStart ? [FIX.startAdb] : [copyCommand('adb start-server', true)],
      COPY.wifi.adbStartNote,
    )
  }
  return row(id, 'wifi', 'blocking', android.reason ?? COPY.tools.adbServerNeeded)
}

/** A connect or pairing that failed, in words: the sentence, its fixes, and adb's own. */
export function wifiFailure(a: WifiAttempt): {
  status: CheckStatus
  sentence: string
  fixes: Fix[]
  detail: string
} {
  const address = wifiAddress(a)
  const said = a.detail ? COPY.wifi.adbSaid(a.detail) : ''
  const out = (sentence: string, fixes: Fix[] = [], detail = said) => ({
    status: 'blocking' as const,
    sentence,
    fixes,
    detail,
  })
  const deviceSteps: Fix[] = [FIX.tvNetworkDebugging, FIX.phoneWirelessDebugging]
  switch (a.code) {
    case 'ANDROID_CONNECT_FAILED':
    case 'ANDROID_PAIR_FAILED':
      switch (a.reason) {
        case 'refused':
          return out(COPY.wifi.refused(a.host, a.port), [
            { label: 'Steps', path: COPY.wifi.refusedStep },
            ...(a.kind === 'pair' ? [FIX.pairWithCode] : deviceSteps),
          ])
        case 'unreachable':
          return out(COPY.wifi.unreachable(address), [
            { label: 'Steps', path: COPY.wifi.unreachableStep },
          ])
        case 'blocked':
          // Never left this computer: a VPN, or macOS keeping the helper off the local network.
          return out(COPY.wifi.blocked(address), [
            { label: 'VPN', path: COPY.wifi.blockedVpn },
            { label: 'macOS', path: COPY.wifi.blockedMac },
          ])
        case 'timeout':
          return out(COPY.wifi.timeout(address), [
            { label: 'Steps', path: COPY.wifi.unreachableStep },
          ])
        case 'unresolved':
          return out(COPY.wifi.unresolved(a.host), [
            { label: 'Steps', path: COPY.wifi.unresolvedStep },
          ])
        case 'wrong-code':
          return out(COPY.wifi.pairWrong, [{ label: 'Steps', path: COPY.wifi.pairWrongStep }])
        case 'unsupported':
          return out(COPY.wifi.pairUnsupported, [primary(FIX.updateAdb)])
        case 'unpaired':
          return out(COPY.wifi.needsPairing(address), [FIX.pairWithCode])
        default:
          // Not "failed to authenticate" read as a pairing: adb says that to a TV that is
          // only waiting for Allow, and the helper answers those as connected (§4.7).
          return out(
            a.kind === 'pair' ? COPY.wifi.pairFailed(address) : COPY.wifi.failed(address),
            [{ label: 'Steps', path: COPY.wifi.unreachableStep }],
          )
      }
    case 'ADB_SERVER_STOPPED':
      return out(COPY.wifi.adbStopped, [FIX.startAdb], COPY.wifi.adbStartNote)
    case 'TOOL_MISSING':
      return out(COPY.wifi.adbMissing, [primary(FIX.installAdb)])
    case 'ANDROID_OFF':
      return out(COPY.wifi.adbOff, [], COPY.wifi.adbOffStep)
    case 'NETWORK_UNSUPPORTED':
      return out(COPY.wifi.helperOld, [copyCommand(DOWNLOAD_COMMAND, true)])
    case 'BUSY':
      return { status: 'unchecked', sentence: COPY.wifi.busy(a.host), fixes: [], detail: '' }
    case 'TOOL_TIMEOUT':
    case 'HELPER_TIMEOUT':
      return out(COPY.wifi.timeout(address), [{ label: 'Steps', path: COPY.wifi.unreachableStep }])
    default:
      // The helper's own sentence (BAD_REQUEST names what it refused), or the code's.
      return out(a.message || COPY.wifi.failed(address))
  }
}

function wifiReachRow(a: WifiAttempt | null, device: WifiInput['device']): CheckItem {
  const id = 'wifi.reachable'
  // The tester's last attempt says the most; else the Wi‑Fi device listed now, if any.
  if (a?.state === 'running') {
    const address = wifiAddress(a)
    return row(
      id,
      'wifi',
      'unchecked',
      a.kind === 'pair' ? COPY.wifi.pairing(address) : COPY.wifi.reaching(address),
    )
  }
  // This computer blocked it: its own row says so, and whether the device answers is unknown.
  if (a?.state === 'failed' && isBlocked(a))
    return row(id, 'wifi', 'unchecked', COPY.wifi.reachBlocked)
  if (a?.state === 'failed') {
    const failure = wifiFailure(a)
    return row(id, 'wifi', failure.status, failure.sentence, failure.fixes, failure.detail)
  }
  if (a?.state === 'ok' && a.kind === 'pair') {
    return row(id, 'wifi', 'ok', COPY.wifi.paired(wifiAddress(a)))
  }
  if (device) {
    const name = device.name || device.id
    return device.state === 'offline'
      ? row(id, 'wifi', 'warning', COPY.wifi.offline(name), [
          { label: 'Steps', path: COPY.wifi.offlineStep },
          FIX.openWifi,
        ])
      : row(id, 'wifi', 'ok', COPY.wifi.reachOk(device.id))
  }
  if (a?.state === 'ok') return row(id, 'wifi', 'ok', COPY.wifi.reachOk(wifiAddress(a)))
  return row(id, 'wifi', 'unchecked', COPY.wifi.reachUnchecked)
}

/** A connect or pairing this computer blocked (the helper's reason `blocked`). */
const isBlocked = (a: WifiAttempt) =>
  (a.code === 'ANDROID_CONNECT_FAILED' || a.code === 'ANDROID_PAIR_FAILED') &&
  a.reason === 'blocked'

/**
 * Shown only after a blocked attempt: the computer's side, with both ways out and, on macOS,
 * the command that starts the helper again from Terminal.
 */
function wifiLocalNetworkRow(a: WifiAttempt, helper: HelperProbe): CheckItem {
  const failure = wifiFailure(a)
  const mac = helper.health?.platform?.startsWith('darwin') ?? true
  const command = helper.env.devOrigin ? DEV_COMMAND : startCommand(helper.env.port)
  // The checklist draws a command above the steps, so the macOS step points up at it.
  const fixes = mac
    ? [
        ...failure.fixes.map((fix) =>
          fix.label === 'macOS' ? { label: 'macOS', path: COPY.wifi.blockedMacCommand } : fix,
        ),
        copyCommand(command),
      ]
    : failure.fixes.filter((fix) => fix.label !== 'macOS')
  return row('wifi.localNetwork', 'wifi', 'blocking', failure.sentence, fixes, failure.detail)
}

function wifiAuthRow(device: WifiInput['device']): CheckItem {
  const id = 'wifi.authorized'
  if (!device) return row(id, 'wifi', 'unchecked', COPY.wifi.authUnchecked)
  const name = device.name || device.id
  switch (device.state) {
    case 'ready':
    case 'busy':
      return row(id, 'wifi', 'ok', COPY.wifi.authOk(name))
    case 'unauthorized':
    case 'authorizing':
      return row(id, 'wifi', 'blocking', COPY.wifi.authWaiting(name), [ALLOW_DEBUGGING])
    default:
      // Offline: the reach row says so; whether it allows this computer is unknown again.
      return row(id, 'wifi', 'unchecked', COPY.wifi.authUnchecked)
  }
}

/** The Wi‑Fi path's rows, in order: four, and this computer's own after a blocked attempt. */
export function wifiChecks({ helper, attempt, device }: WifiInput): CheckItem[] {
  const blocked = attempt?.state === 'failed' && isBlocked(attempt)
  return [
    wifiHelperRow(helper),
    wifiAdbRow(helper),
    ...(blocked ? [wifiLocalNetworkRow(attempt, helper)] : []),
    wifiReachRow(attempt, device),
    wifiAuthRow(device),
  ]
}
