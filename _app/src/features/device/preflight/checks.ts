import { DEVICE_HINTS, type DeviceState } from '../model'
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
  siteSettingsFix,
} from './copy'
import {
  USB_ACCESS_DENIED,
  type AndroidDoctor,
  type BrowserEnv,
  type BrowserName,
  type CheckGroup,
  type CheckId,
  type CheckItem,
  type CheckStatus,
  type Feature,
  type FeatureContext,
  type Fix,
  type HelperHealth,
  type HelperProbe,
  type ImagesOutcome,
  type InstallPhone,
  type PhoneInput,
  type UsbHolder,
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
export const GATE_STEPS: readonly CheckId[] = [
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
  id: CheckId,
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
 * The helper (PLAN §3.4)
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
] as const satisfies readonly CheckId[]

/** The helper rows an .aab install depends on. The adb server row is about connecting instead. */
const AAB_HELPER_IDS: ReadonlySet<CheckId> = new Set(
  HELPER_IDS.filter((id) => id !== 'helper.adbServer'),
)

/**
 * The helper's rows. `probe` null: the page hasn't looked — and in P1 there is no helper to
 * look for, so every row says it is coming with the helper rather than pretending to know.
 * `doctor` null: /api/doctor hasn't answered (it needs a paired page).
 */
export function helperChecks(probe: HelperProbe | null, doctor: AndroidDoctor | null): CheckItem[] {
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

function runningRow({ health, browser, lna }: HelperProbe): CheckItem {
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

function lnaRow({ lna, browser, health }: HelperProbe): CheckItem {
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

function pairedRow({ health, tokenId }: HelperProbe): CheckItem {
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
  const helper = helperChecks(probe, ctx.doctor ?? null).filter((r) => AAB_HELPER_IDS.has(r.id))
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

const GROUP_ORDER: readonly CheckGroup[] = ['browser', 'phone', 'helper', 'feature']

function fixText(fix: Fix): string {
  if ('copy' in fix) return `\`${fix.copy}\``
  if ('href' in fix) return `${fix.label}: ${fix.href}`
  if ('path' in fix) return `${fix.label}: ${fix.path}`
  return fix.label
}

/**
 * Anything that could be the helper's token: a `#pair=` fragment, a bearer header, a `token=`
 * parameter. No row should carry one; this makes sure a pasted checklist never does.
 */
function redact(text: string): string {
  return text
    .replace(/#pair=[^\s)`'"]+/g, '#pair=…')
    .replace(/\bBearer\s+\S+/g, 'Bearer …')
    .replace(/([?&]token=)[^\s&#)`'"]+/g, '$1…')
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
  return redact(sections.join('\n\n'))
}
