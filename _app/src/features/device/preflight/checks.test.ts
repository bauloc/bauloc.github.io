import { describe, expect, it } from 'vitest'

import type { DeviceState } from '../model'
import {
  AUTHORIZE_PATIENCE_MS,
  GATE_STEPS,
  browserChecks,
  bySeverity,
  checklistText,
  featureChecks,
  helperChecks,
  javaMajor,
  phoneChecks,
  worst,
} from './checks'
import {
  USB_ACCESS_DENIED,
  type AndroidDoctor,
  type BrowserEnv,
  type CheckId,
  type CheckItem,
  type CheckStatus,
  type Feature,
  type FeatureContext,
  type Fix,
  type HelperHealth,
  type HelperProbe,
  type PhoneInput,
} from './types'

/*
  One row per item × status, each built from an injected environment, so every missing
  prerequisite of PLAN §3.5 is a case here. Expected sentences are typed out rather than read
  from copy.ts: they are the plan's wording, and a change to one should be a deliberate edit
  in two places.
*/

const SAY = {
  usbOff: 'Turn it on once per phone.',
  notListed:
    'The computer doesn’t see the phone. Try another cable or port (some cables only charge), unlock the phone, and check USB debugging.',
  noPhone: 'No phone allowed yet. Click Add device and pick your phone in the browser’s list.',
  dismissed: 'No phone was picked. If yours wasn’t in the list, check USB debugging and the cable.',
  waiting:
    'Unlock the phone and tap Allow on “Allow USB debugging?”. Tick “Always allow from this computer” so it stops asking.',
  stuck:
    'No prompt on the phone? Unplug and replug the cable. Still nothing: Developer options → Revoke USB debugging authorizations, then reconnect.',
  notConnected: 'Checked once Device Lab connects to the phone.',
  held: 'Another program is using the phone’s debugging connection: usually Google’s adb server (Android Studio, Flutter, scrcpy, a terminal), another browser tab, or chrome://inspect with “Discover USB devices” on.',
  heldWindows:
    'Something else has the phone’s debugging connection: usually Google’s adb server (Android Studio, Flutter, scrcpy, a terminal) or another browser tab. No adb running? Then a phone maker’s USB driver probably owns the phone’s ADB interface: switch it to WinUSB.',
  linux:
    'Linux must allow the browser to open the phone. Install the Android udev rules for your distribution, then unplug and replug.',
  windows:
    'A phone maker’s USB driver may be blocking the browser. Switch the phone’s ADB interface to WinUSB in Device Manager, or install Google’s USB driver.',
  winUsbSwitch:
    'path:Device Manager → the phone’s “ADB Interface” (under Universal Serial Bus devices, Android Device or Portable Devices) → Update driver → Browse my computer for drivers → Let me pick → “Android ADB Interface” or “WinUSB Device”',
  coming: 'Coming with the Device Lab helper.',
  waitAnswer: 'Checked once the helper answers.',
  waitPairing: 'Checked once this page is paired with the helper.',
  ide: 'If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ, Flutter, VS Code, Unity or scrcpy.',
} as const

function find(items: readonly CheckItem[], id: CheckId): CheckItem {
  const item = items.find((i) => i.id === id)
  if (!item) throw new Error(`no ${id} row in ${items.map((i) => i.id).join(', ')}`)
  return item
}

const ids = (items: readonly CheckItem[]) => items.map((i) => i.id)

/** A fix's target, whatever its kind, for compact assertions. */
function target(fix: Fix): string {
  if ('copy' in fix) return `copy:${fix.copy}`
  if ('href' in fix) return `href:${fix.href}`
  if ('path' in fix) return `path:${fix.path}`
  return `action:${fix.action}`
}
const targets = (item: CheckItem) => (item.fixes ?? []).map(target)
const primaries = (item: CheckItem) => (item.fixes ?? []).filter((f) => f.primary).map(target)

/* ---------------------------------------------------------------- */

const ENV: BrowserEnv = {
  secure: true,
  https: true,
  href: 'https://bauloc.github.io/device/',
  webusb: true,
  usbPolicy: true,
  inflate: true,
  lna: 'unsupported',
  os: 'mac',
  browser: 'chrome',
  version: '1.0.0',
  appUpdated: false,
}

describe('browserChecks', () => {
  it.each<[string, Partial<BrowserEnv>, CheckId, CheckStatus, string]>([
    ['https', {}, 'browser.secure', 'ok', 'Opened over HTTPS.'],
    [
      'localhost',
      { https: false },
      'browser.secure',
      'ok',
      'Opened on this computer (localhost), which counts as secure.',
    ],
    [
      'plain http',
      { secure: false, https: false, webusb: false },
      'browser.secure',
      'blocking',
      'USB access only works on https:// pages or on localhost. This page was opened over plain http.',
    ],
    [
      'plain http',
      { secure: false, https: false, webusb: false },
      'browser.webusb',
      'unchecked',
      'Can’t check until the page is on HTTPS.',
    ],
    [
      'no navigator.usb (Firefox, Safari)',
      { webusb: false },
      'browser.webusb',
      'blocking',
      'This browser can’t talk to USB devices. Use Chrome, Edge or Opera on a computer.',
    ],
    [
      'USB blocked by the embedding page',
      { usbPolicy: false },
      'browser.webusb',
      'blocking',
      'The page that embeds Device Lab blocks USB. Open Device Lab in its own tab.',
    ],
    [
      'no permissions policy API',
      { usbPolicy: null },
      'browser.webusb',
      'ok',
      'This browser can talk to Android phones over USB.',
    ],
    ['WebUSB', {}, 'browser.webusb', 'ok', 'This browser can talk to Android phones over USB.'],
    ['the current build', {}, 'app.current', 'ok', 'This tab runs Device Lab 1.0.0.'],
    [
      'a preload error',
      { appUpdated: true },
      'app.current',
      'blocking',
      'Device Lab was updated while this tab was open. Reload to continue.',
    ],
  ])('%s: %s is %s', (_, patch, id, status, sentence) => {
    const item = find(browserChecks({ ...ENV, ...patch }), id)
    expect(item.status).toBe(status)
    expect(item.sentence).toBe(sentence)
    expect(item.group).toBe('browser')
  })

  it('points each browser blocker at its way out', () => {
    const insecure = browserChecks({ ...ENV, secure: false, https: false, webusb: false })
    expect(targets(find(insecure, 'browser.secure'))).toEqual([
      'href:https://bauloc.github.io/device/',
    ])
    expect(targets(find(browserChecks({ ...ENV, webusb: false }), 'browser.webusb'))).toEqual([
      'href:https://www.google.com/chrome/',
    ])
    const embedded = browserChecks({ ...ENV, usbPolicy: false, href: 'https://x.test/device/' })
    expect(targets(find(embedded, 'browser.webusb'))).toEqual(['copy:https://x.test/device/'])
    expect(primaries(find(browserChecks({ ...ENV, appUpdated: true }), 'app.current'))).toEqual([
      'action:reload',
    ])
  })

  it('carries no fixes on rows that are fine', () => {
    for (const item of browserChecks(ENV)) expect(item.fixes).toBeUndefined()
  })
})

/* ---------------------------------------------------------------- */

const NOW = 1_800_000_000_000
const PHONE: PhoneInput = {
  device: null,
  picker: 'none',
  usb: { kind: 'unknown' },
  authorizingSince: null,
  now: NOW,
  os: 'mac',
  browser: 'chrome',
  otherTab: false,
  holder: null,
}
const pixel = (state: DeviceState, blockers: string[] = []): PhoneInput['device'] => ({
  name: 'Pixel 9',
  state,
  blockers,
})

describe('phoneChecks', () => {
  it('lists the Gate’s four steps first, then the holder; the system row only where it applies', () => {
    expect(ids(phoneChecks(PHONE))).toEqual([...GATE_STEPS, 'phone.notHeld'])
    expect(ids(phoneChecks({ ...PHONE, os: 'linux' }))).toEqual([
      ...GATE_STEPS,
      'phone.notHeld',
      'phone.osAccess',
    ])
    expect(ids(phoneChecks({ ...PHONE, os: 'windows' })).at(-1)).toBe('phone.osAccess')
    expect(ids(phoneChecks({ ...PHONE, os: 'chromeos' }))).not.toContain('phone.osAccess')
    for (const item of phoneChecks(PHONE)) expect(item.group).toBe('phone')
  })

  it.each<[string, Partial<PhoneInput>, CheckId, CheckStatus, string]>([
    // Nothing connected: the Gate's steps.
    ['nothing yet', {}, 'phone.usbDebugging', 'unchecked', SAY.usbOff],
    [
      'nothing yet',
      {},
      'phone.cable',
      'unchecked',
      'Use a cable that carries data. Some cables only charge.',
    ],
    ['zero granted devices', {}, 'phone.permission', 'warning', SAY.noPhone],
    [
      'nothing yet',
      {},
      'phone.authorized',
      'unchecked',
      'When the phone asks “Allow USB debugging?”, tap Allow.',
    ],
    ['nothing yet', {}, 'phone.notHeld', 'unchecked', SAY.notConnected],
    ['picker dismissed', { picker: 'dismissed' }, 'phone.permission', 'warning', SAY.dismissed],
    ['picker used, nothing kept', { picker: 'picked' }, 'phone.permission', 'warning', SAY.noPhone],

    // What "Find my phone…" (or the granted list) found.
    [
      'nothing listed',
      { usb: { kind: 'not-listed' } },
      'phone.usbDebugging',
      'warning',
      SAY.notListed,
    ],
    [
      'Google device without the ADB interface',
      { usb: { kind: 'debugging-off', name: 'Pixel 9' } },
      'phone.usbDebugging',
      'blocking',
      'Pixel 9 is plugged in, but USB debugging is off.',
    ],
    [
      'Google device without the ADB interface',
      { usb: { kind: 'debugging-off', name: 'Pixel 9' } },
      'phone.cable',
      'ok',
      'The phone is on a cable that carries data.',
    ],
    [
      'Apple device',
      { usb: { kind: 'not-android', name: 'iPhone', sure: true } },
      'phone.usbDebugging',
      'warning',
      'That device has no Android debugging interface. Pick your phone.',
    ],
    [
      'Apple device',
      { usb: { kind: 'not-android', name: 'iPhone', sure: true } },
      'phone.cable',
      'unchecked',
      'Use a cable that carries data. Some cables only charge.',
    ],
    [
      'a phone in fastboot',
      { usb: { kind: 'bootloader', name: 'Pixel 9' } },
      'phone.usbDebugging',
      'warning',
      'Pixel 9 is in fastboot mode. Restart it into Android, then add it again.',
    ],
    [
      'found with the ADB interface',
      { usb: { kind: 'adb', name: 'Pixel 9' } },
      'phone.usbDebugging',
      'ok',
      'USB debugging is on.',
    ],
    [
      'found with the ADB interface',
      { usb: { kind: 'adb', name: 'Pixel 9' } },
      'phone.permission',
      'ok',
      'Chrome may use Pixel 9.',
    ],

    // A ready phone.
    ['ready', { device: pixel('ready') }, 'phone.usbDebugging', 'ok', 'USB debugging is on.'],
    [
      'ready',
      { device: pixel('ready') },
      'phone.cable',
      'ok',
      'The phone is on a cable that carries data.',
    ],
    ['ready', { device: pixel('ready') }, 'phone.permission', 'ok', 'Chrome may use Pixel 9.'],
    [
      'ready in Edge',
      { device: pixel('ready'), browser: 'edge' },
      'phone.permission',
      'ok',
      'Edge may use Pixel 9.',
    ],
    [
      'ready in another Chromium',
      { device: pixel('ready'), browser: 'other' },
      'phone.permission',
      'ok',
      'This browser may use Pixel 9.',
    ],
    ['ready', { device: pixel('ready') }, 'phone.authorized', 'ok', 'This computer is allowed.'],
    [
      'ready',
      { device: pixel('ready') },
      'phone.notHeld',
      'ok',
      'Device Lab has the phone’s debugging connection.',
    ],
    ['busy', { device: pixel('busy') }, 'phone.authorized', 'ok', 'This computer is allowed.'],

    // Waiting on "Allow USB debugging?".
    [
      'authorizing for less than 30 s',
      {
        device: pixel('authorizing', ['ANDROID_UNAUTHORIZED']),
        authorizingSince: NOW - AUTHORIZE_PATIENCE_MS + 1,
      },
      'phone.authorized',
      'warning',
      SAY.waiting,
    ],
    [
      'authorizing for 30 s',
      {
        device: pixel('authorizing', ['ANDROID_UNAUTHORIZED']),
        authorizingSince: NOW - AUTHORIZE_PATIENCE_MS,
      },
      'phone.authorized',
      'warning',
      SAY.stuck,
    ],
    [
      'authorizing for a minute',
      { device: pixel('authorizing'), authorizingSince: NOW - 60_000 },
      'phone.authorized',
      'warning',
      SAY.stuck,
    ],
    [
      'authorizing since an unknown time',
      { device: pixel('authorizing') },
      'phone.authorized',
      'warning',
      SAY.waiting,
    ],
    [
      'unauthorized',
      { device: pixel('unauthorized', ['ANDROID_UNAUTHORIZED']) },
      'phone.authorized',
      'warning',
      SAY.waiting,
    ],
    [
      'authorizing',
      { device: pixel('authorizing') },
      'phone.notHeld',
      'ok',
      'Device Lab has the phone’s debugging connection.',
    ],
    [
      'connecting',
      { device: pixel('connecting') },
      'phone.authorized',
      'unchecked',
      SAY.notConnected,
    ],
    ['connecting', { device: pixel('connecting') }, 'phone.notHeld', 'unchecked', SAY.notConnected],
    [
      'offline',
      { device: pixel('offline', ['ANDROID_OFFLINE']) },
      'phone.notHeld',
      'unchecked',
      SAY.notConnected,
    ],

    // Held by someone else.
    [
      'DeviceBusyError or "Unable to claim interface"',
      { device: pixel('held', ['ADB_SERVER_HOLDING']) },
      'phone.notHeld',
      'blocking',
      SAY.held,
    ],
    [
      'held',
      { device: pixel('held', ['ADB_SERVER_HOLDING']) },
      'phone.authorized',
      'unchecked',
      SAY.notConnected,
    ],
    [
      'held',
      { device: pixel('held', ['ADB_SERVER_HOLDING']) },
      'phone.usbDebugging',
      'ok',
      'USB debugging is on.',
    ],
    [
      'another tab answered',
      { device: pixel('held', ['ADB_SERVER_HOLDING']), otherTab: true },
      'phone.notHeld',
      'blocking',
      'Another Device Lab tab in this browser has Pixel 9.',
    ],
    [
      'the helper says adb',
      {
        device: pixel('held', ['ADB_SERVER_HOLDING']),
        holder: { serial: '55090DLAQ0026D', pid: 4242, process: 'adb' },
      },
      'phone.notHeld',
      'blocking',
      'The adb server (pid 4242) has Pixel 9.',
    ],
    [
      'the helper says Chrome',
      {
        device: pixel('held', ['ADB_SERVER_HOLDING']),
        holder: { pid: 35744, process: 'Google Chrome' },
      },
      'phone.notHeld',
      'blocking',
      'Google Chrome (pid 35744) has Pixel 9, probably another tab.',
    ],
    [
      'the helper names another program',
      { device: pixel('held', ['ADB_SERVER_HOLDING']), holder: { pid: 777, process: 'scrcpy' } },
      'phone.notHeld',
      'blocking',
      'scrcpy (pid 777) has Pixel 9. Quit it, then reconnect.',
    ],
    [
      'a SecurityError on macOS',
      { device: pixel('held', ['WEBUSB_CLAIM_FAILED']) },
      'phone.notHeld',
      'blocking',
      SAY.held,
    ],

    // The system's own permission (Linux, Windows).
    [
      'a SecurityError on Linux',
      { device: pixel('held', ['WEBUSB_CLAIM_FAILED']), os: 'linux' },
      'phone.osAccess',
      'blocking',
      SAY.linux,
    ],
    [
      'a SecurityError on Linux',
      { device: pixel('held', ['WEBUSB_CLAIM_FAILED']), os: 'linux' },
      'phone.notHeld',
      'unchecked',
      'Can’t check until the system lets the browser open the phone.',
    ],
    [
      'a SecurityError on Windows',
      { device: pixel('held', ['WEBUSB_CLAIM_FAILED']), os: 'windows' },
      'phone.osAccess',
      'blocking',
      SAY.windows,
    ],
    [
      'USB_ACCESS_DENIED on Windows',
      { device: pixel('offline', [USB_ACCESS_DENIED]), os: 'windows' },
      'phone.osAccess',
      'blocking',
      SAY.windows,
    ],
    [
      'USB_ACCESS_DENIED on Linux',
      { device: pixel('offline', [USB_ACCESS_DENIED]), os: 'linux' },
      'phone.osAccess',
      'blocking',
      SAY.linux,
    ],
    [
      'USB_ACCESS_DENIED on macOS',
      { device: pixel('offline', [USB_ACCESS_DENIED]) },
      'phone.osAccess',
      'blocking',
      'The system didn’t let the browser open the phone. Unplug and replug it, then reconnect.',
    ],
    [
      'held by adb on Linux: the system did let it open',
      { device: pixel('held', ['ADB_SERVER_HOLDING']), os: 'linux' },
      'phone.osAccess',
      'ok',
      'The system lets this browser open the phone.',
    ],
    [
      'ready on Windows',
      { device: pixel('ready'), os: 'windows' },
      'phone.osAccess',
      'ok',
      'The system lets this browser open the phone.',
    ],
    [
      'nothing yet on Linux',
      { os: 'linux' },
      'phone.osAccess',
      'unchecked',
      'Checked once Device Lab opens the phone.',
    ],
    [
      'connecting on Linux',
      { device: pixel('connecting'), os: 'linux' },
      'phone.osAccess',
      'unchecked',
      'Checked once Device Lab opens the phone.',
    ],
  ])('%s: %s is %s', (_, patch, id, status, sentence) => {
    const item = find(phoneChecks({ ...PHONE, ...patch }), id)
    expect(item.status).toBe(status)
    expect(item.sentence).toBe(sentence)
  })

  it('tells how to turn USB debugging on, before and after it is found off', () => {
    const steps = [
      'path:Settings → About phone → tap Build number 7 times (Samsung: About phone → Software information → Build number)',
      'path:Settings → System → Developer options → USB debugging (some phones: System → Advanced)',
      'href:https://developer.android.com/studio/debug/dev-options',
    ]
    expect(targets(find(phoneChecks(PHONE), 'phone.usbDebugging'))).toEqual(steps)
    const off = find(
      phoneChecks({ ...PHONE, usb: { kind: 'debugging-off', name: 'Pixel 9' } }),
      'phone.usbDebugging',
    )
    expect(targets(off)).toEqual([...steps, 'action:add-device'])
    expect(primaries(off)).toEqual(['action:add-device'])
  })

  it('names the picked device, and hedges only when its maker could make Android phones', () => {
    const apple = find(
      phoneChecks({ ...PHONE, usb: { kind: 'not-android', name: 'iPhone', sure: true } }),
      'phone.usbDebugging',
    )
    expect(apple.detail).toBe('You picked iPhone.')
    expect(primaries(apple)).toEqual(['action:add-device'])
    const unknown = find(
      phoneChecks({ ...PHONE, usb: { kind: 'not-android', name: 'Acme Tab', sure: false } }),
      'phone.usbDebugging',
    )
    expect(unknown.detail).toBe(
      'You picked Acme Tab. If it is your phone, turn on USB debugging, then pick it again.',
    )
  })

  it('offers "Find my phone…" first once the picker came back empty-handed', () => {
    expect(primaries(find(phoneChecks(PHONE), 'phone.permission'))).toEqual(['action:add-device'])
    const dismissed = find(phoneChecks({ ...PHONE, picker: 'dismissed' }), 'phone.permission')
    expect(targets(dismissed)).toEqual(['action:add-device', 'action:find-phone'])
    expect(primaries(dismissed)).toEqual(['action:find-phone'])
    const unseen = find(
      phoneChecks({ ...PHONE, usb: { kind: 'not-listed' } }),
      'phone.usbDebugging',
    )
    expect(primaries(unseen)).toEqual(['action:find-phone'])
  })

  it('adds the revoke path once the prompt seems not to have appeared', () => {
    const waiting = find(
      phoneChecks({ ...PHONE, device: pixel('authorizing') }),
      'phone.authorized',
    )
    expect(targets(waiting)).toEqual(['action:retry'])
    expect(waiting.detail).toBe(
      'Clearing this site’s data makes a new key, so the phone asks again.',
    )
    const stuck = find(
      phoneChecks({ ...PHONE, device: pixel('authorizing'), authorizingSince: NOW - 31_000 }),
      'phone.authorized',
    )
    expect(targets(stuck)).toEqual([
      'action:retry',
      'path:Settings → System → Developer options → Revoke USB debugging authorizations',
    ])
    expect(stuck.detail).toBe(waiting.detail)
  })

  it('gives each holder its own way out', () => {
    const held = (patch: Partial<PhoneInput>) =>
      find(
        phoneChecks({ ...PHONE, device: pixel('held', ['ADB_SERVER_HOLDING']), ...patch }),
        'phone.notHeld',
      )
    const generic = held({})
    expect(targets(generic)).toEqual(['copy:adb kill-server', 'action:retry'])
    expect(primaries(generic)).toEqual(['action:retry'])
    expect(generic.fixes?.map((f) => f.label)).toEqual(['Copy “adb kill-server”', 'Reconnect'])
    expect(generic.detail).toBe(SAY.ide)

    const tab = held({ otherTab: true })
    expect(targets(tab)).toEqual(['action:release-other-tab', 'action:retry'])
    expect(primaries(tab)).toEqual(['action:release-other-tab'])

    const adb = held({ holder: { pid: 4242, process: 'adb' } })
    expect(targets(adb)).toEqual(['copy:adb kill-server', 'action:retry'])
    expect(adb.detail).toBe(SAY.ide)

    const chrome = held({ holder: { pid: 35744, process: 'Google Chrome' } })
    expect(primaries(chrome)).toEqual(['action:release-other-tab'])
    expect(held({ holder: { pid: 9, process: 'Microsoft Edge' } }).sentence).toBe(
      'Microsoft Edge (pid 9) has Pixel 9, probably another tab.',
    )

    // Windows can't tell adb from a maker's driver on the ADB interface: both, with both fixes.
    const windows = held({ os: 'windows' })
    expect(windows.sentence).toBe(SAY.heldWindows)
    expect(targets(windows)).toEqual([
      'copy:adb kill-server',
      SAY.winUsbSwitch,
      'href:https://developer.android.com/studio/run/win-usb',
      'action:retry',
    ])
    expect(primaries(windows)).toEqual(['action:retry'])
    expect(windows.detail).toBe(SAY.ide)
    // A holder the helper named is still more specific than either guess.
    expect(held({ os: 'windows', holder: { pid: 4242, process: 'adb.exe' } }).sentence).toBe(
      'The adb server (pid 4242) has Pixel 9.',
    )
    expect(held({ os: 'linux' }).sentence).toBe(SAY.held)

    expect(targets(held({ holder: { pid: 777, process: 'scrcpy' } }))).toEqual(['action:retry'])
    // The tab's own answer is more specific than the helper's process name.
    expect(held({ otherTab: true, holder: { pid: 1, process: 'adb' } }).sentence).toBe(
      'Another Device Lab tab in this browser has Pixel 9.',
    )
  })

  it('gives the udev commands on Linux and the driver page on Windows', () => {
    const linux = find(
      phoneChecks({ ...PHONE, os: 'linux', device: pixel('held', ['WEBUSB_CLAIM_FAILED']) }),
      'phone.osAccess',
    )
    expect(targets(linux)).toEqual([
      'copy:sudo apt-get install android-sdk-platform-tools-common',
      'copy:sudo dnf install android-tools',
      'copy:sudo pacman -S android-udev',
      'copy:sudo usermod -aG plugdev $LOGNAME',
      'copy:sudo snap connect chromium:raw-usb',
      'action:retry',
    ])
    // Each command says which distribution it is for.
    expect(linux.fixes?.slice(0, 3).map((f) => f.label)).toEqual([
      'Copy udev rules: Debian/Ubuntu',
      'Copy udev rules: Fedora',
      'Copy udev rules: Arch',
    ])
    // `held` is sticky: once the rules are in, only Reconnect brings the phone back.
    expect(primaries(linux)).toEqual(['action:retry'])
    expect(linux.detail).toBe(
      'On Debian or Ubuntu, also run the plugdev command, then log out and back in. Chromium installed as a snap needs USB access too: run the snap command, then restart Chromium.',
    )
    const windows = find(
      phoneChecks({ ...PHONE, os: 'windows', device: pixel('held', ['WEBUSB_CLAIM_FAILED']) }),
      'phone.osAccess',
    )
    expect(targets(windows)).toEqual([
      SAY.winUsbSwitch,
      'href:https://developer.android.com/studio/run/win-usb',
      'copy:adb kill-server',
      'action:retry',
    ])
    expect(primaries(windows)).toEqual(['action:retry'])
    expect(windows.detail).toBe(
      'A running adb server can cause this too: quit it with “adb kill-server”, then reconnect.',
    )
  })

  it('never reads the system’s refusal into a legacy held answer from other errors', () => {
    // An unknown error lands as offline + WEBUSB_CLAIM_FAILED: not the system, not a holder.
    const items = phoneChecks({
      ...PHONE,
      os: 'linux',
      device: pixel('offline', ['WEBUSB_CLAIM_FAILED']),
    })
    expect(find(items, 'phone.osAccess').status).toBe('unchecked')
    expect(find(items, 'phone.notHeld').status).toBe('unchecked')
  })
})

/* ---------------------------------------------------------------- */

const HEALTH: HelperHealth = {
  version: '0.2.0',
  protocol: 1,
  tokenId: '60699787',
  capabilities: ['android.buildApks'],
  platform: 'darwin',
}
const PROBE: HelperProbe = {
  lna: 'granted',
  browser: 'chrome',
  health: HEALTH,
  tokenId: '60699787',
}
const DOCTOR: AndroidDoctor = {
  java: { found: true, version: '21.0.11', vendor: 'Eclipse Adoptium' },
  bundletool: { found: true, version: '1.18.3' },
  keystore: { found: true },
  adbServer: { running: false },
  usbHolders: [],
}
const HELPER_ROWS: CheckId[] = [
  'helper.running',
  'helper.lna',
  'helper.paired',
  'helper.version',
  'aab.java',
  'aab.bundletool',
  'aab.key',
  'helper.adbServer',
]

describe('helperChecks', () => {
  it('says every row is coming with the helper while there is none (P1)', () => {
    const items = helperChecks(null, null)
    expect(ids(items)).toEqual(HELPER_ROWS)
    for (const item of items) {
      expect(item).toMatchObject({ group: 'helper', status: 'unchecked', sentence: SAY.coming })
      expect(item.fixes).toBeUndefined()
    }
  })

  it('is all OK with a running, paired, current helper and a complete toolbox', () => {
    const items = helperChecks(PROBE, DOCTOR)
    expect(ids(items)).toEqual(HELPER_ROWS)
    expect(items.map((i) => [i.status, i.sentence])).toEqual([
      ['ok', 'Helper 0.2.0 is running on this computer.'],
      ['ok', 'This page may reach apps on this computer.'],
      ['ok', 'This page is paired with the helper.'],
      ['ok', 'Helper 0.2.0 can build APKs from an .aab.'],
      ['ok', 'Java 21.0.11 (Eclipse Adoptium).'],
      ['ok', 'bundletool 1.18.3.'],
      ['ok', 'APKs are signed with this computer’s debug key.'],
      ['ok', 'No adb server is running.'],
    ])
  })

  it.each<[string, Partial<HelperProbe>, AndroidDoctor | null, CheckId, CheckStatus, string]>([
    // Local Network Access.
    ['LNA granted', {}, DOCTOR, 'helper.lna', 'ok', 'This page may reach apps on this computer.'],
    [
      'LNA prompt',
      { lna: 'prompt', health: null },
      null,
      'helper.lna',
      'warning',
      'Chrome will ask once to let this page reach apps on this computer. Choose Allow.',
    ],
    [
      'LNA prompt, allowed since',
      { lna: 'prompt' },
      DOCTOR,
      'helper.lna',
      'ok',
      'This page may reach apps on this computer.',
    ],
    [
      'LNA denied',
      { lna: 'denied', health: null },
      null,
      'helper.lna',
      'blocking',
      'Chrome blocks this page from reaching the helper.',
    ],
    [
      'LNA denied',
      { lna: 'denied', health: null },
      null,
      'helper.running',
      'unchecked',
      'Can’t tell while the browser blocks this page from reaching the helper.',
    ],
    [
      'LNA denied in Edge',
      { lna: 'denied', health: null, browser: 'edge' },
      null,
      'helper.lna',
      'blocking',
      'Edge blocks this page from reaching the helper.',
    ],
    [
      'LNA unsupported',
      { lna: 'unsupported', health: null },
      null,
      'helper.lna',
      'unchecked',
      'This browser doesn’t report this permission.',
    ],
    [
      'LNA unsupported, and the helper answered',
      { lna: 'unsupported' },
      DOCTOR,
      'helper.lna',
      'ok',
      'This page may reach apps on this computer.',
    ],
    [
      'Safari',
      { lna: 'unsupported', browser: 'safari', health: null },
      null,
      'helper.lna',
      'blocking',
      'Safari can’t reach the helper from this page. Open the helper’s own page.',
    ],
    [
      'Safari on the helper’s own page',
      { lna: 'unsupported', browser: 'safari' },
      DOCTOR,
      'helper.lna',
      'ok',
      'This page may reach apps on this computer.',
    ],
    [
      'Safari',
      { lna: 'unsupported', browser: 'safari', health: null },
      null,
      'helper.running',
      'unchecked',
      'Can’t tell while the browser blocks this page from reaching the helper.',
    ],

    // The helper itself.
    [
      'helper down',
      { health: null },
      null,
      'helper.running',
      'blocking',
      'The helper isn’t running. Start it in Terminal, then press Check again.',
    ],
    ['helper down', { health: null }, null, 'helper.paired', 'unchecked', SAY.waitAnswer],
    ['helper down', { health: null }, null, 'helper.version', 'unchecked', SAY.waitAnswer],
    ['helper down', { health: null }, null, 'aab.java', 'unchecked', SAY.waitAnswer],
    ['helper down', { health: null }, null, 'helper.adbServer', 'unchecked', SAY.waitAnswer],
    [
      'unpaired',
      { tokenId: null },
      null,
      'helper.paired',
      'warning',
      'Pair this page with the helper using the link it printed (…#pair=…).',
    ],
    ['unpaired', { tokenId: null }, null, 'aab.bundletool', 'unchecked', SAY.waitPairing],
    ['unpaired', { tokenId: null }, null, 'aab.key', 'unchecked', SAY.waitPairing],
    [
      'stale token',
      { tokenId: 'deadbeef' },
      null,
      'helper.paired',
      'warning',
      'The helper has restarted since this page was paired. Pair again using the link it printed (…#pair=…).',
    ],
    ['paired, doctor not back yet', {}, null, 'aab.java', 'unchecked', SAY.waitAnswer],
    [
      'too old: protocol 0',
      { health: { ...HEALTH, protocol: 0 } },
      DOCTOR,
      'helper.version',
      'blocking',
      'This helper is too old for .aab installs. Download the latest one and restart it.',
    ],
    [
      'too old: no .aab builds',
      { health: { ...HEALTH, capabilities: [] } },
      DOCTOR,
      'helper.version',
      'blocking',
      'This helper is too old for .aab installs. Download the latest one and restart it.',
    ],
    [
      'too old: no capabilities at all',
      { health: { version: '0.1.0', protocol: 1, tokenId: '60699787' } },
      DOCTOR,
      'helper.version',
      'blocking',
      'This helper is too old for .aab installs. Download the latest one and restart it.',
    ],

    // The doctor's Android rows.
    [
      'Java missing',
      {},
      { ...DOCTOR, java: { found: false } },
      'aab.java',
      'blocking',
      'Building APKs from an .aab needs Java, and none was found.',
    ],
    [
      'Java 8',
      {},
      { ...DOCTOR, java: { found: true, version: '1.8.0_402' } },
      'aab.java',
      'blocking',
      'Java 1.8.0_402 is too old. bundletool needs 11 or newer.',
    ],
    [
      'Java 11',
      {},
      { ...DOCTOR, java: { found: true, version: '11.0.24' } },
      'aab.java',
      'ok',
      'Java 11.0.24.',
    ],
    [
      'Java 21',
      {},
      { ...DOCTOR, java: { found: true, version: '21.0.11', vendor: 'Homebrew' } },
      'aab.java',
      'ok',
      'Java 21.0.11 (Homebrew).',
    ],
    [
      'Java without a readable version',
      {},
      { ...DOCTOR, java: { found: true, version: 'unknown' } },
      'aab.java',
      'warning',
      'The helper found Java but couldn’t read its version. bundletool needs 11 or newer.',
    ],
    [
      'bundletool missing',
      {},
      { ...DOCTOR, bundletool: { found: false } },
      'aab.bundletool',
      'warning',
      'The helper will download bundletool 1.18.3 (32.5 MB, checksum-checked) the first time you install an .aab.',
    ],
    [
      'key missing',
      {},
      { ...DOCTOR, keystore: { found: false } },
      'aab.key',
      'warning',
      'There’s no debug signing key on this computer. The helper can create one.',
    ],
    [
      'adb server running',
      {},
      { ...DOCTOR, adbServer: { running: true, devices: [] } },
      'helper.adbServer',
      'warning',
      'An adb server is running on this computer. It can take the phone away from the browser.',
    ],
    [
      'adb server holding phones',
      {},
      {
        ...DOCTOR,
        adbServer: {
          running: true,
          devices: [{ serial: '55090DLAQ0026D', model: 'Pixel_9' }, { serial: 'R58MC0ABCDE' }],
        },
      },
      'helper.adbServer',
      'blocking',
      'The adb server on this computer has Pixel 9 and R58MC0ABCDE.',
    ],
  ])('%s: %s is %s', (_, patch, doctor, id, status, sentence) => {
    const item = find(helperChecks({ ...PROBE, ...patch }, doctor), id)
    expect(item.status).toBe(status)
    expect(item.sentence).toBe(sentence)
  })

  it('shows how to allow the helper again, per browser', () => {
    const lna = (browser: HelperProbe['browser']) =>
      targets(
        find(helperChecks({ ...PROBE, lna: 'denied', health: null, browser }, null), 'helper.lna'),
      )
    const settings =
      'path:Site controls (left of the address) → Site settings → Apps on device → Allow'
    expect(lna('chrome')).toEqual([
      settings,
      'copy:chrome://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io',
    ])
    expect(lna('edge')).toEqual([
      settings,
      'copy:edge://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io',
    ])
    expect(lna('firefox')).toEqual([
      'path:Settings → Privacy & Security → Device apps and services',
    ])
    const safari = find(
      helperChecks({ ...PROBE, browser: 'safari', lna: 'unsupported', health: null }, null),
      'helper.lna',
    )
    expect(targets(safari)).toEqual(['href:http://127.0.0.1:8787/device/'])
  })

  it('offers the start command and Check again while the helper is down', () => {
    const down = find(helperChecks({ ...PROBE, health: null }, null), 'helper.running')
    expect(targets(down)).toEqual(['copy:node device-bridge.mjs', 'action:check-helper'])
    expect(primaries(down)).toEqual(['action:check-helper'])
    expect(down.detail).toBe('Needs Node.js 18 or newer.')
    expect(targets(find(helperChecks({ ...PROBE, tokenId: null }, null), 'helper.paired'))).toEqual(
      ['action:pair-helper'],
    )
  })

  it('offers Homebrew only to a Mac', () => {
    const missing = {
      ...DOCTOR,
      java: { found: false as const },
      bundletool: { found: false as const },
    }
    const mac = helperChecks(PROBE, missing)
    expect(targets(find(mac, 'aab.java'))).toEqual([
      'href:https://adoptium.net/',
      'copy:brew install --cask temurin',
    ])
    expect(targets(find(mac, 'aab.bundletool'))).toEqual([
      'action:get-bundletool',
      'copy:brew install bundletool',
    ])
    const linux = helperChecks({ ...PROBE, health: { ...HEALTH, platform: 'linux' } }, missing)
    expect(targets(find(linux, 'aab.java'))).toEqual(['href:https://adoptium.net/'])
    expect(targets(find(linux, 'aab.bundletool'))).toEqual(['action:get-bundletool'])
  })

  it('always says what a debug-signed build can’t do', () => {
    const play = 'A build signed here can’t update a copy installed from Google Play.'
    expect(find(helperChecks(PROBE, DOCTOR), 'aab.key').detail).toBe(play)
    const missing = find(helperChecks(PROBE, { ...DOCTOR, keystore: { found: false } }), 'aab.key')
    expect(missing.detail).toBe(play)
    expect(primaries(missing)).toEqual(['action:create-key'])
    expect(find(helperChecks({ ...PROBE, tokenId: null }, null), 'aab.key').detail).toBe(play)
  })

  it('reads Java’s major version the way java -version prints it', () => {
    expect(javaMajor('1.8.0_402')).toBe(8)
    expect(javaMajor('11.0.24')).toBe(11)
    expect(javaMajor('21.0.11')).toBe(21)
    expect(javaMajor('17')).toBe(17)
    expect(javaMajor('openjdk version "21.0.11" 2026-04-21')).toBe(21)
    expect(javaMajor('java version "1.8.0_402"')).toBe(8)
    expect(javaMajor('unknown')).toBeNull()
  })
})

/* ---------------------------------------------------------------- */

const ANDROID_17 = {
  name: 'Pixel 9',
  sdk: 37,
  release: '17',
  brand: 'google',
  manufacturer: 'Google',
}
const CTX: FeatureContext = { phone: ANDROID_17, verifyAdbInstalls: '1', inflate: true }

describe('featureChecks', () => {
  it.each<[Feature, string, FeatureContext, CheckId, CheckStatus, string]>([
    // Any install.
    [
      'install',
      'no phone',
      { phone: null },
      'install.android',
      'unchecked',
      'Checked once the phone is connected.',
    ],
    [
      'install',
      'no phone',
      { phone: null },
      'install.verify',
      'unchecked',
      'Checked once the phone is connected.',
    ],
    [
      'install',
      'Android 17',
      CTX,
      'install.android',
      'ok',
      'Android 17 supports installs over USB.',
    ],
    [
      'install',
      'Android 7.0',
      { ...CTX, phone: { ...ANDROID_17, sdk: 24, release: '7.0' } },
      'install.android',
      'ok',
      'Android 7.0 supports installs over USB.',
    ],
    [
      'install',
      'Android 6.0.1',
      { ...CTX, phone: { ...ANDROID_17, sdk: 23, release: '6.0.1' } },
      'install.android',
      'blocking',
      'Installing needs Android 7.0 or newer. This phone runs Android 6.0.1.',
    ],
    [
      'install',
      'an old phone without a release name',
      { ...CTX, phone: { ...ANDROID_17, sdk: 21, release: '' } },
      'install.android',
      'blocking',
      'Installing needs Android 7.0 or newer. This phone runs API 21.',
    ],
    [
      'install',
      'an unreadable API level',
      { ...CTX, phone: { ...ANDROID_17, sdk: null } },
      'install.android',
      'unchecked',
      'Checked once the phone is connected.',
    ],
    [
      'install',
      'a Xiaomi phone',
      { ...CTX, phone: { ...ANDROID_17, brand: 'Xiaomi', manufacturer: 'Xiaomi' } },
      'install.oem',
      'warning',
      'Xiaomi, Redmi and POCO phones refuse installs over USB until you allow them.',
    ],
    [
      'install',
      'a POCO phone',
      { ...CTX, phone: { ...ANDROID_17, brand: 'POCO', manufacturer: 'Xiaomi' } },
      'install.oem',
      'warning',
      'Xiaomi, Redmi and POCO phones refuse installs over USB until you allow them.',
    ],
    [
      'install',
      'a Redmi phone after INSTALL_FAILED_USER_RESTRICTED',
      {
        ...CTX,
        phone: { ...ANDROID_17, brand: 'Redmi', manufacturer: 'Xiaomi' },
        userRestricted: true,
      },
      'install.oem',
      'blocking',
      'Xiaomi, Redmi and POCO phones refuse installs over USB until you allow them.',
    ],
    [
      'install',
      'another phone after INSTALL_FAILED_USER_RESTRICTED',
      { ...CTX, userRestricted: true },
      'install.oem',
      'blocking',
      'The phone blocks installs over USB. Look for a setting that allows them in Developer options, or ask whoever manages the phone.',
    ],
    [
      'install',
      'Verify apps over USB on',
      CTX,
      'install.verify',
      'warning',
      'Play Protect may scan the app and ask on the phone. Keep the phone unlocked and watch its screen.',
    ],
    [
      'install',
      'Verify apps over USB unread',
      { ...CTX, verifyAdbInstalls: null },
      'install.verify',
      'warning',
      'Play Protect may scan the app and ask on the phone. Keep the phone unlocked and watch its screen.',
    ],
    [
      'install',
      'Verify apps over USB off',
      { ...CTX, verifyAdbInstalls: '0' },
      'install.verify',
      'ok',
      '“Verify apps over USB” is off on this phone.',
    ],

    // Archives.
    [
      'xapk',
      'DecompressionStream',
      CTX,
      'install.unzip',
      'ok',
      'This browser can unpack .xapk and .apkm files.',
    ],
    [
      'xapk',
      'no DecompressionStream',
      { ...CTX, inflate: false },
      'install.unzip',
      'blocking',
      'This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer).',
    ],
    [
      'apkm',
      'no DecompressionStream',
      { ...CTX, inflate: false },
      'install.unzip',
      'blocking',
      'This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer).',
    ],
    [
      'xapk',
      'unknown inflate support',
      { phone: ANDROID_17 },
      'install.unzip',
      'unchecked',
      'Checked when the file is opened.',
    ],
    [
      'apkm',
      'an encrypted .apkm',
      { ...CTX, apkmEncrypted: true },
      'install.apkmEncrypted',
      'blocking',
      'This .apkm is encrypted (an old APKMirror format). Download it again from APKMirror.',
    ],
    [
      'apkm',
      'a plain .apkm',
      { ...CTX, apkmEncrypted: false },
      'install.apkmEncrypted',
      'ok',
      'This .apkm isn’t encrypted.',
    ],

    // .aab.
    [
      'aab',
      'no helper',
      CTX,
      'aab.build',
      'blocking',
      'Browsers can’t install an .aab directly: bundletool has to build APKs from it first.',
    ],
    ['aab', 'no helper', CTX, 'helper.running', 'unchecked', SAY.coming],
    ['aab', 'no helper', CTX, 'aab.java', 'unchecked', SAY.coming],
    [
      'aab',
      'no helper',
      CTX,
      'aab.manual',
      'warning',
      'No helper? Build an .apks yourself and drop it here:',
    ],
    [
      'aab',
      'helper down',
      { ...CTX, probe: { ...PROBE, health: null } },
      'aab.manual',
      'warning',
      'No helper? Build an .apks yourself and drop it here:',
    ],

    // Images.
    ['images', 'loading', {}, 'images.mediastore', 'unchecked', 'Checked when the images load.'],
    [
      'images',
      'listed',
      { images: { status: 'listed' } },
      'images.mediastore',
      'ok',
      'Android listed the images.',
    ],
    [
      'images',
      'the folder fallback',
      { images: { status: 'fallback' } },
      'images.mediastore',
      'warning',
      'Showing folders only (Screenshots, Camera, Download). Dates are file times.',
    ],
    [
      'images',
      'a failed query',
      {
        images: {
          status: 'failed',
          stderr: '\nError while accessing provider:media\njava.lang.IllegalArgumentException: …\n',
        },
      },
      'images.mediastore',
      'blocking',
      'Android didn’t list the images: Error while accessing provider:media.',
    ],
    [
      'images',
      'a failed query ending in a period',
      { images: { status: 'failed', stderr: 'Invalid column date_taken.' } },
      'images.mediastore',
      'blocking',
      'Android didn’t list the images: Invalid column date_taken.',
    ],
    [
      'images',
      'a failed query with no stderr',
      { images: { status: 'failed', stderr: '  \n' } },
      'images.mediastore',
      'blocking',
      'Android didn’t list the images.',
    ],

    // The viewer.
    [
      'viewer',
      'HEIC in Chrome',
      { mime: 'image/heic', browser: 'chrome' },
      'images.heic',
      'warning',
      'Chrome can’t show HEIC images. Save it to open it on this computer.',
    ],
    [
      'viewer',
      'HEIF in Edge',
      { mime: 'image/HEIF', browser: 'edge' },
      'images.heic',
      'warning',
      'Edge can’t show HEIC images. Save it to open it on this computer.',
    ],
    [
      'viewer',
      'a HEIC burst, browser unknown',
      { mime: 'image/heic-sequence' },
      'images.heic',
      'warning',
      'This browser can’t show HEIC images. Save it to open it on this computer.',
    ],
  ])('%s, %s: %s is %s', (feature, _, ctx, id, status, sentence) => {
    const item = find(featureChecks(feature, ctx), id)
    expect(item.status).toBe(status)
    expect(item.sentence).toBe(sentence)
  })

  it('lists each file kind’s rows, in order', () => {
    const xiaomi = { ...CTX, phone: { ...ANDROID_17, brand: 'Xiaomi' } }
    expect(ids(featureChecks('install', CTX))).toEqual(['install.android', 'install.verify'])
    expect(ids(featureChecks('install', xiaomi))).toEqual([
      'install.android',
      'install.oem',
      'install.verify',
    ])
    expect(ids(featureChecks('xapk', CTX))).toEqual([
      'install.android',
      'install.verify',
      'install.unzip',
    ])
    // The .apkm's first bytes decide whether it is encrypted; before that there is no row.
    expect(ids(featureChecks('apkm', CTX))).toEqual([
      'install.android',
      'install.verify',
      'install.unzip',
    ])
    expect(ids(featureChecks('apkm', { ...CTX, apkmEncrypted: false })).at(-1)).toBe(
      'install.apkmEncrypted',
    )
    expect(ids(featureChecks('summary', CTX))).toEqual([
      'install.android',
      'install.verify',
      'install.unzip',
    ])
    expect(ids(featureChecks('summary', { ...CTX, images: { status: 'listed' } })).at(-1)).toBe(
      'images.mediastore',
    )
    for (const item of featureChecks('install', CTX)) expect(item.group).toBe('feature')
  })

  it('blocks an .aab without a helper, and offers the manual build instead', () => {
    const items = featureChecks('aab', { ...CTX, fileName: 'My App.aab' })
    expect(ids(items)).toEqual([
      'install.android',
      'install.verify',
      'aab.build',
      'helper.running',
      'helper.lna',
      'helper.paired',
      'helper.version',
      'aab.java',
      'aab.bundletool',
      'aab.key',
      'aab.manual',
    ])
    expect(worst(items)).toBe('blocking')
    const manual = find(items, 'aab.manual')
    expect(targets(manual)).toEqual([
      'copy:bundletool build-apks --bundle="My App.aab" --output="My App.apks" --mode=universal',
    ])
    expect(primaries(manual)).toHaveLength(1)
    expect(manual.detail).toBe(
      'Needs Java 11 or newer, bundletool, and the debug key Android Studio creates (~/.android/debug.keystore). A build signed with it can’t update a copy installed from Google Play.',
    )
    expect(targets(find(featureChecks('aab', CTX), 'aab.manual'))).toEqual([
      'copy:bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ])
  })

  it('drops the fallback once the helper can build', () => {
    const items = featureChecks('aab', { ...CTX, probe: PROBE, doctor: DOCTOR })
    expect(ids(items)).not.toContain('aab.build')
    expect(ids(items)).not.toContain('aab.manual')
    // The adb server row is about connecting, not about building.
    expect(ids(items)).not.toContain('helper.adbServer')
    expect(worst(items.filter((i) => i.group === 'helper'))).toBe('ok')
    // Warnings (a bundletool download still to come) don't stand in the way of a build.
    const toDownload = featureChecks('aab', {
      ...CTX,
      probe: PROBE,
      doctor: { ...DOCTOR, bundletool: { found: false } },
    })
    expect(ids(toDownload)).not.toContain('aab.manual')
    // Nor does a browser without Local Network Access, once the helper has answered.
    const noLna = featureChecks('aab', {
      ...CTX,
      probe: { ...PROBE, lna: 'unsupported', browser: 'firefox' },
      doctor: DOCTOR,
    })
    expect(ids(noLna)).not.toContain('aab.manual')
  })

  it('keeps the fallback while any helper row blocks', () => {
    const old = featureChecks('aab', {
      ...CTX,
      probe: { ...PROBE, health: { ...HEALTH, protocol: 0 } },
      doctor: DOCTOR,
    })
    expect(find(old, 'helper.version').status).toBe('blocking')
    expect(ids(old)).toContain('aab.manual')
    expect(ids(old)).not.toContain('aab.build')
  })

  it('points the image rows at their buttons', () => {
    expect(
      targets(
        find(featureChecks('images', { images: { status: 'fallback' } }), 'images.mediastore'),
      ),
    ).toEqual(['action:retry-images'])
    const failed = find(
      featureChecks('images', { images: { status: 'failed', stderr: 'x' } }),
      'images.mediastore',
    )
    expect(primaries(failed)).toEqual(['action:retry-images'])
    const heic = find(
      featureChecks('viewer', { mime: 'image/heic', browser: 'chrome' }),
      'images.heic',
    )
    expect(primaries(heic)).toEqual(['action:save-image'])
  })

  it('shortens a long complaint from the phone', () => {
    const stderr = `Error: ${'x'.repeat(300)}`
    const { sentence } = find(
      featureChecks('images', { images: { status: 'failed', stderr } }),
      'images.mediastore',
    )
    expect(sentence.length).toBeLessThan(200)
    expect(sentence.endsWith('….')).toBe(true)
  })

  it('has nothing to say about images Chrome can draw, or HEIC in Safari', () => {
    expect(featureChecks('viewer', { mime: 'image/jpeg', browser: 'chrome' })).toEqual([])
    expect(featureChecks('viewer', { browser: 'chrome' })).toEqual([])
    expect(featureChecks('viewer', { mime: 'image/heic', browser: 'safari' })).toEqual([])
  })

  it('points the Xiaomi row at the setting, and the unzip row at a newer browser', () => {
    const xiaomi = find(
      featureChecks('install', { ...CTX, phone: { ...ANDROID_17, brand: 'Xiaomi' } }),
      'install.oem',
    )
    expect(targets(xiaomi)).toEqual([
      'path:Settings → Additional settings → Developer options → Install via USB (needs a Mi account)',
    ])
    expect(
      targets(find(featureChecks('xapk', { ...CTX, inflate: false }), 'install.unzip')),
    ).toEqual(['href:https://www.google.com/chrome/'])
  })
})

/* ---------------------------------------------------------------- */

const at = (status: CheckStatus, id: CheckId = 'browser.secure'): CheckItem => ({
  id,
  group: 'browser',
  label: id,
  status,
  sentence: status,
})

describe('worst and bySeverity', () => {
  it.each<[CheckStatus[], CheckStatus]>([
    [[], 'ok'],
    [['ok', 'ok'], 'ok'],
    [['ok', 'unchecked'], 'unchecked'],
    [['unchecked', 'warning', 'ok'], 'warning'],
    [['warning', 'blocking', 'unchecked'], 'blocking'],
  ])('%j adds up to %s', (statuses, expected) => {
    expect(worst(statuses.map((s) => at(s)))).toBe(expected)
  })

  it('puts blocking rows first and keeps the order within a status', () => {
    const items = [
      at('ok', 'browser.secure'),
      at('warning', 'browser.webusb'),
      at('blocking', 'app.current'),
      at('unchecked', 'phone.cable'),
      at('blocking', 'phone.notHeld'),
    ]
    expect(ids(bySeverity(items))).toEqual([
      'app.current',
      'phone.notHeld',
      'browser.webusb',
      'phone.cable',
      'browser.secure',
    ])
    expect(ids(items)[0]).toBe('browser.secure') // not sorted in place
  })
})

describe('checklistText', () => {
  it('writes one "status — label — sentence — fix" line per row, under its section', () => {
    const items = [
      ...browserChecks({ ...ENV, secure: false, https: false, webusb: false }),
      ...phoneChecks({ ...PHONE, device: pixel('held', ['ADB_SERVER_HOLDING']) }).filter(
        (i) => i.id === 'phone.notHeld' || i.id === 'phone.authorized',
      ),
      ...helperChecks(null, null).slice(0, 1),
      ...featureChecks('xapk', { ...CTX, inflate: false }).slice(-1),
    ]
    expect(checklistText(items, 'Pixel 9')).toBe(
      [
        'This browser',
        'Blocking — Secure page — USB access only works on https:// pages or on localhost. This page was opened over plain http. — Open the secure page: https://bauloc.github.io/device/',
        'Not checked — WebUSB — Can’t check until the page is on HTTPS.',
        'OK — Device Lab version — This tab runs Device Lab 1.0.0.',
        '',
        'Phone: Pixel 9',
        'Not checked — Allowed on the phone — Checked once Device Lab connects to the phone.',
        `Blocking — No other program has the phone — ${SAY.held} ${SAY.ide} — \`adb kill-server\` · Reconnect`,
        '',
        'Helper',
        'Not checked — Device Lab helper — Coming with the Device Lab helper.',
        '',
        'Features',
        'Blocking — Unpack .xapk and .apkm — This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer). — Get Chrome: https://www.google.com/chrome/',
      ].join('\n'),
    )
  })

  it('titles the phone section plainly when there is no phone, and skips empty sections', () => {
    const text = checklistText(phoneChecks(PHONE))
    expect(text.split('\n')[0]).toBe('Phone')
    expect(text).not.toContain('This browser')
    expect(text).toContain(
      'Not checked — USB debugging — Turn it on once per phone. — Turn on Developer options: Settings → About phone',
    )
    expect(checklistText([])).toBe('')
  })

  it('never prints a token', () => {
    const leaky: CheckItem = {
      id: 'helper.paired',
      group: 'helper',
      label: 'Paired with the helper',
      status: 'warning',
      sentence: 'Pair this page with the helper using the link it printed (…#pair=…).',
      detail:
        'Sent Authorization: Bearer s3cr3t-T0KEN to http://127.0.0.1:8787/api/doctor?token=s3cr3t-T0KEN',
      fixes: [
        {
          label: 'Open the helper’s page',
          href: 'http://127.0.0.1:8787/device/#pair=s3cr3t-T0KEN',
        },
      ],
    }
    const text = checklistText([leaky])
    expect(text).not.toContain('s3cr3t')
    expect(text).toContain('(…#pair=…)')
    expect(text).toContain('Bearer …')
    expect(text).toContain('?token=…')
    expect(text).toContain('http://127.0.0.1:8787/device/#pair=…')
  })

  it('redacts a token even from a link that slipped past env.ts', () => {
    const items = [
      ...browserChecks({
        ...ENV,
        usbPolicy: false,
        href: 'https://bauloc.github.io/device/#pair=s3cr3t',
      }),
      ...phoneChecks(PHONE),
      ...helperChecks(null, null),
      ...featureChecks('summary', CTX),
    ]
    const text = checklistText(items, 'Pixel 9')
    expect(text).not.toContain('s3cr3t')
    expect(text).toContain('`https://bauloc.github.io/device/#pair=…`')
  })
})
