import { describe, expect, it } from 'vitest'

import type { HelperPhase, HelperStatus } from '../helper/connection'
import {
  parseDoctor,
  type DoctorReport,
  type Health,
  type Lanes,
  type PreflightItem,
} from '../helper/protocol'
import { startRealHelper } from '../helper/testing/real-helper'
import type { Device, DeviceState } from '../model'
import {
  AUTHORIZE_PATIENCE_MS,
  GATE_STEPS,
  TOOL_BLOCKERS,
  aabHelperChecks,
  browserChecks,
  bySeverity,
  checklistText,
  compareVersions,
  deviceChecks,
  featureChecks,
  gateChecks,
  gateSummary,
  helperChecks,
  inlineChecks,
  isToolId,
  javaMajor,
  phoneChecks,
  redactSecrets,
  sortChecks,
  toolChecks,
  toolFix,
  wifiChecks,
  nearbyBlockedCheck,
  wifiFailure,
  wifiHelperReady,
  worst,
  GROUP_ORDER,
  type HelperCheckContext,
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
  type AabProbe,
  type BrowserName,
  type HelperHealth,
  type PublishedHelper,
  type PhoneInput,
  type WifiAttempt,
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

  it('needs no phone of its own while the helper serves one, and never warns about it', () => {
    const items = phoneChecks({ ...PHONE, helperPhone: 'Living room TV' })
    expect(items).toEqual([
      {
        id: 'phone.permission',
        group: 'phone',
        label: 'Phone allowed in the browser',
        status: 'ok',
        sentence:
          'Not needed: Living room TV is ready through the local helper, which doesn’t use WebUSB.',
      },
    ])
    expect(worst(items)).toBe('ok')
    // A phone this browser opened itself still gets its own rows.
    expect(ids(phoneChecks({ ...PHONE, device: pixel('ready'), helperPhone: 'TV' }))).toEqual([
      ...GATE_STEPS,
      'phone.notHeld',
    ])
    // No helper phone: the usual warning stays.
    expect(phoneChecks({ ...PHONE, helperPhone: null })[2]?.status).toBe('warning')
  })

  it('waits instead of warning while only the helper’s devices are here (an iPhone)', () => {
    const items = phoneChecks({ ...PHONE, helperDevice: 'Ngọc’s iPhone' })
    expect(items).toEqual([
      {
        id: 'phone.permission',
        group: 'phone',
        label: 'Phone allowed in the browser',
        status: 'unchecked',
        sentence:
          'Not checked: Ngọc’s iPhone goes through the local helper, which doesn’t use WebUSB. For an Android phone on a cable in this browser, click Add device.',
        fixes: [{ label: 'Add device', action: 'add-device' }],
      },
    ])
    expect(worst(items)).toBe('unchecked')
    // An Android phone the helper lists but isn't ready yet reads the same.
    expect(phoneChecks({ ...PHONE, helperDevice: 'Living room TV' })[0]?.status).toBe('unchecked')
    // Once the tester tries Add device, the browser's own steps are back.
    for (const tried of [
      { picker: 'dismissed' as const },
      { picker: 'picked' as const },
      { usb: { kind: 'not-listed' as const } },
    ]) {
      expect(ids(phoneChecks({ ...PHONE, helperDevice: 'Ngọc’s iPhone', ...tried }))).toEqual([
        ...GATE_STEPS,
        'phone.notHeld',
      ])
    }
    // A ready Android phone through the helper still reads as not needed, and OK.
    expect(
      phoneChecks({ ...PHONE, helperPhone: 'TV', helperDevice: 'Ngọc’s iPhone' })[0]?.status,
    ).toBe('ok')
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
const PROBE: AabProbe = {
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

describe('aabHelperChecks', () => {
  it('says every row is coming with the helper while there is none (P1)', () => {
    const items = aabHelperChecks(null, null)
    expect(ids(items)).toEqual(HELPER_ROWS)
    for (const item of items) {
      expect(item).toMatchObject({ group: 'helper', status: 'unchecked', sentence: SAY.coming })
      expect(item.fixes).toBeUndefined()
    }
  })

  it('is all OK with a running, paired, current helper and a complete toolbox', () => {
    const items = aabHelperChecks(PROBE, DOCTOR)
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

  it.each<[string, Partial<AabProbe>, AndroidDoctor | null, CheckId, CheckStatus, string]>([
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
    const item = find(aabHelperChecks({ ...PROBE, ...patch }, doctor), id)
    expect(item.status).toBe(status)
    expect(item.sentence).toBe(sentence)
  })

  it('shows how to allow the helper again, per browser', () => {
    const lna = (browser: AabProbe['browser']) =>
      targets(
        find(
          aabHelperChecks({ ...PROBE, lna: 'denied', health: null, browser }, null),
          'helper.lna',
        ),
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
      aabHelperChecks({ ...PROBE, browser: 'safari', lna: 'unsupported', health: null }, null),
      'helper.lna',
    )
    expect(targets(safari)).toEqual(['href:http://127.0.0.1:8787/device/'])
  })

  it('offers the start command and Check again while the helper is down', () => {
    const down = find(aabHelperChecks({ ...PROBE, health: null }, null), 'helper.running')
    expect(targets(down)).toEqual(['copy:node device-bridge.mjs', 'action:check-helper'])
    expect(primaries(down)).toEqual(['action:check-helper'])
    expect(down.detail).toBe('Needs Node.js 18 or newer.')
    expect(
      targets(find(aabHelperChecks({ ...PROBE, tokenId: null }, null), 'helper.paired')),
    ).toEqual(['action:pair-helper'])
  })

  it('offers Homebrew only to a Mac', () => {
    const missing = {
      ...DOCTOR,
      java: { found: false as const },
      bundletool: { found: false as const },
    }
    const mac = aabHelperChecks(PROBE, missing)
    expect(targets(find(mac, 'aab.java'))).toEqual([
      'href:https://adoptium.net/',
      'copy:brew install --cask temurin',
    ])
    expect(targets(find(mac, 'aab.bundletool'))).toEqual([
      'action:get-bundletool',
      'copy:brew install bundletool',
    ])
    const linux = aabHelperChecks({ ...PROBE, health: { ...HEALTH, platform: 'linux' } }, missing)
    expect(targets(find(linux, 'aab.java'))).toEqual(['href:https://adoptium.net/'])
    expect(targets(find(linux, 'aab.bundletool'))).toEqual(['action:get-bundletool'])
  })

  it('always says what a debug-signed build can’t do', () => {
    const play = 'A build signed here can’t update a copy installed from Google Play.'
    expect(find(aabHelperChecks(PROBE, DOCTOR), 'aab.key').detail).toBe(play)
    const missing = find(
      aabHelperChecks(PROBE, { ...DOCTOR, keystore: { found: false } }),
      'aab.key',
    )
    expect(missing.detail).toBe(play)
    expect(primaries(missing)).toEqual(['action:create-key'])
    expect(find(aabHelperChecks({ ...PROBE, tokenId: null }, null), 'aab.key').detail).toBe(play)
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

/* ---------------------------------------------------------------- *
 * The local helper (spec §12b, §12c)
 * ---------------------------------------------------------------- */

const LANES: Lanes = {
  ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: false, wifiHidden: 0 },
  android: { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: false },
  simulators: { status: 'off', booted: 0 },
}

const SHA = 'ab'.repeat(32)

const LIVE: Health = {
  name: 'bauloc-device-bridge',
  version: '1.0.0',
  protocol: 1,
  features: ['android.start-server'],
  port: 8787,
  tokenId: '4d1566a1',
  tokenPersistent: false,
  runId: 'r',
  startedAt: 0,
  local: false,
  platform: 'darwin-arm64',
  sha256: SHA,
}

const ANSWERING: readonly HelperPhase[] = ['connected', 'unpaired', 'stale', 'outdated', 'newer']

function helperAt(phase: HelperPhase, patch: Partial<HelperStatus> = {}): HelperStatus {
  return {
    phase,
    promptLikely: false,
    env: {
      mode: 'hosted',
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: false,
      devOrigin: false,
    },
    permission: 'granted',
    health: ANSWERING.includes(phase)
      ? phase === 'outdated'
        ? { ...LIVE, version: '0.9.0', protocol: 0 }
        : LIVE
      : null,
    lanes: phase === 'connected' ? LANES : null,
    pairing:
      phase === 'connected'
        ? { tokenId: '4d1566a1', remembered: false, tokenPersistent: false }
        : null,
    remember: false,
    intent: true,
    since: 0,
    error: null,
    ...patch,
  }
}

const tool = (patch: Partial<PreflightItem> & Pick<PreflightItem, 'id'>): PreflightItem => ({
  group: 'ios',
  label: patch.id,
  status: 'ok',
  sentence: 'Fine.',
  fixes: [],
  neededFor: [],
  ...patch,
})

const ITEMS: PreflightItem[] = [
  tool({
    id: 'mac.node',
    group: 'mac',
    label: 'Node 24.12.0',
    sentence: 'Node 24.12.0 runs the helper.',
  }),
  tool({
    id: 'ios.xcode',
    label: 'Xcode',
    status: 'warning',
    sentence:
      'Xcode is installed, but the Command Line Tools are selected, so screenshots are off.',
    fixes: [
      {
        kind: 'command',
        command: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      },
    ],
    detail: 'devicectl 642.16',
    neededFor: ['ios.screenshot'],
  }),
  tool({
    id: 'ios.libimobiledevice',
    label: 'libimobiledevice',
    status: 'warning',
    sentence: 'Not installed. Only needed for screenshots of iOS 16 and older.',
    fixes: [
      { kind: 'link', href: 'https://brew.sh', label: 'Install Homebrew first' },
      { kind: 'command', command: 'brew install libimobiledevice' },
    ],
    neededFor: ['ios.screenshot.legacy', 'ios.fallback'],
    optional: true,
  }),
  tool({
    id: 'ios.pymobiledevice3',
    label: 'pymobiledevice3',
    status: 'warning',
    sentence: 'Not installed. Only needed for the optional root tunnel (a later helper version).',
    neededFor: [],
    optional: true,
  }),
  tool({
    id: 'android.adb',
    group: 'android',
    label: 'adb',
    status: 'warning',
    sentence:
      'adb isn’t installed. Chrome and Edge don’t need it; Safari and Firefox reach Android only through it.',
    fixes: [{ kind: 'command', command: 'brew install --cask android-platform-tools' }],
    neededFor: ['android.helper'],
  }),
  tool({
    id: 'android.adb-server',
    group: 'android',
    label: 'adb server',
    sentence:
      'Google’s adb server isn’t running, so Chrome’s WebUSB can use Android phones directly.',
    fixes: [{ kind: 'action', action: 'start-adb', label: 'Start adb server' }],
    neededFor: ['android.helper'],
  }),
  tool({
    id: 'android.bundletool',
    group: 'android',
    label: 'bundletool',
    status: 'warning',
    sentence: 'Not installed. Only needed to install .aab bundles (a later helper version).',
    neededFor: ['android.aab'],
    optional: true,
  }),
  // The page words its own groups: a helper row in them is ignored.
  tool({ id: 'helper.running', group: 'helper', sentence: 'Not the helper’s to say.' }),
]

const REPORT: DoctorReport = {
  helper: {
    name: 'bauloc-device-bridge',
    version: '1.0.0',
    protocol: 1,
    node: '24.12.0',
    openssl: '3.6.1',
    platform: 'darwin',
    arch: 'arm64',
    macos: '27.0.1',
    port: 8787,
    startedAt: 0,
    local: false,
    tokenPersistent: false,
    flags: [],
    sha256: SHA,
  },
  lanes: LANES,
  items: ITEMS,
  checkedAt: 0,
}

const iphone = (patch: Partial<Device> = {}): Device => ({
  id: '00008101-000A1B2C3D4E5F02',
  backend: 'agent',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone',
  model: 'iPhone 12 Pro',
  osVersion: '27.0',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true },
  ...patch,
})

const helperRow = (status: HelperStatus, id: CheckId, ctx: HelperCheckContext = {}) =>
  find(helperChecks(status, null, ctx), id)

describe('helperChecks (the local helper)', () => {
  it('keeps the .aab card’s P1 rows when there is no connection at all', () => {
    expect(helperChecks(null, null)).toEqual(aabHelperChecks(null, null))
  })

  it.each<[HelperPhase, string, CheckStatus, string, string[]]>([
    ['off', 'helper.running', 'unchecked', 'Not checked yet.', ['action:connect-helper']],
    ['checking', 'helper.running', 'unchecked', 'Looking for the helper on 127.0.0.1:8787…', []],
    [
      'absent',
      'helper.running',
      'blocking',
      'Nothing answers on 127.0.0.1:8787.',
      [
        'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
        'action:check-helper',
        'href:https://nodejs.org/en/download',
      ],
    ],
    [
      'dismissed',
      'helper.running',
      'unchecked',
      'The browser’s prompt was closed before the helper could be checked.',
      ['action:connect-helper'],
    ],
    [
      'lost',
      'helper.running',
      'blocking',
      'The helper stopped.',
      ['copy:node ~/device-bridge.mjs'],
    ],
    [
      'foreign',
      'helper.running',
      'blocking',
      'Another program answers on port 8787.',
      [
        // A first-time tester has no file yet: the command downloads it too.
        'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs --port 8788',
        'href:https://nodejs.org/en/download',
      ],
    ],
    ['connected', 'helper.running', 'ok', 'Helper 1.0.0 answers on 127.0.0.1:8787.', []],
    ['unpaired', 'helper.running', 'ok', 'Helper 1.0.0 answers on 127.0.0.1:8787.', []],
    ['connected', 'helper.version', 'ok', 'Protocol 1, version 1.0.0.', []],
    ['off', 'helper.version', 'unchecked', 'Checked once the helper answers.', []],
    [
      'outdated',
      'helper.version',
      'blocking',
      'This helper (0.9.0) is older than this page needs.',
      [
        'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
      ],
    ],
    [
      'newer',
      'helper.version',
      'blocking',
      'This page is older than the helper.',
      ['action:reload'],
    ],
    ['connected', 'helper.paired', 'ok', 'Paired · fingerprint 4d1566a1 · this tab only.', []],
    [
      'unpaired',
      'helper.paired',
      'blocking',
      'This page isn’t paired with the helper.',
      ['action:pair-helper'],
    ],
    [
      'stale',
      'helper.paired',
      'blocking',
      'The helper restarted, so this page’s pairing ended.',
      ['action:pair-helper'],
    ],
    [
      'foreign',
      'helper.paired',
      'blocking',
      'The program on port 8787 couldn’t prove it is your helper; nothing was sent.',
      [],
    ],
    [
      'outdated',
      'helper.paired',
      'unchecked',
      'Checked once the helper and this page agree on a version.',
      [],
    ],
    ['lost', 'helper.paired', 'unchecked', 'Checked once the helper answers.', []],
  ])('%s: %s is %s', (phase, id, status, sentence, fixes) => {
    const item = helperRow(helperAt(phase), id as CheckId)
    expect([item.status, item.sentence, targets(item)]).toEqual([status, sentence, fixes])
  })

  it('names the remembered pairing, and never the token', () => {
    const item = helperRow(
      helperAt('connected', {
        pairing: { tokenId: '4d1566a1', remembered: true, tokenPersistent: true },
      }),
      'helper.paired',
    )
    expect(item.sentence).toBe('Paired · fingerprint 4d1566a1 · remembered on this computer.')
  })

  it('tells a dev server the helper may need --dev, with the repo’s command', () => {
    const dev = helperAt('absent', {
      env: { ...helperAt('absent').env, devOrigin: true },
    })
    const item = helperRow(dev, 'helper.running')
    expect(item.sentence).toBe(
      'Nothing answers on 127.0.0.1:8787, or the helper was started without --dev.',
    )
    expect(targets(item)[0]).toBe('copy:node ../device/agent/device-bridge.mjs --dev')
    expect(item.detail).toBe('The helper needs Node.js 18 or newer: node -v shows yours.')
  })

  it('says where to get Node.js wherever a first run may lack it', () => {
    for (const phase of ['absent', 'foreign', 'denied', 'safari'] as const) {
      const item = helperRow(helperAt(phase), 'helper.running')
      expect(targets(item)).toContain('href:https://nodejs.org/en/download')
      expect(item.detail).toBe('The helper needs Node.js 18 or newer: node -v shows yours.')
    }
  })

  it('blocked by the browser, still says how to start the helper its page needs', () => {
    for (const phase of ['denied', 'safari'] as const) {
      const item = helperRow(helperAt(phase), 'helper.running')
      expect(item.status).toBe('unchecked')
      expect(item.sentence).toBe(
        'Can’t tell while the browser blocks this page from reaching the helper. Not started yet? Start it with this command.',
      )
      expect(targets(item)[0]).toBe(
        'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
      )
    }
  })

  it('starts the helper on the port this page uses, so the page finds it again', () => {
    const env = { ...helperAt('lost').env, apiBase: 'http://127.0.0.1:8790', port: 8790 }
    const at = (phase: HelperPhase) => helperAt(phase, { env })
    expect(targets(helperRow(at('lost'), 'helper.running'))).toEqual([
      'copy:node ~/device-bridge.mjs --port 8790',
    ])
    expect(targets(helperRow(at('absent'), 'helper.running'))[0]).toBe(
      'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs --port 8790',
    )
    expect(targets(helperRow(at('outdated'), 'helper.version'))).toEqual([
      'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs --port 8790',
    ])
    expect(targets(helperRow(at('foreign'), 'helper.running'))[0]).toBe(
      'copy:curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs --port 8791',
    )
  })

  it.each<[string, Partial<HelperStatus>, CheckStatus, string]>([
    [
      'the helper’s own page',
      { permission: 'not-needed', env: { ...helperAt('off').env, mode: 'local' } },
      'ok',
      'Not needed: the helper serves this page.',
    ],
    ['granted', { permission: 'granted' }, 'ok', 'Allowed to reach apps on this device.'],
    [
      'unsupported',
      { permission: 'unsupported' },
      'ok',
      'This browser doesn’t ask for this permission.',
    ],
    [
      'prompt',
      { permission: 'prompt' },
      'unchecked',
      'The browser will ask once to let this page reach apps on this device; choose Allow.',
    ],
    [
      'denied',
      { permission: 'denied' },
      'blocking',
      'This browser blocks this page from reaching apps on this device.',
    ],
    [
      'hosted Safari',
      { permission: 'unsupported', env: { ...helperAt('off').env, safariLike: true } },
      'blocking',
      'Safari can’t reach the helper from this secure page.',
    ],
  ])('reach: %s', (_, patch, status, sentence) => {
    const item = helperRow(helperAt('off', patch), 'helper.lna', { browser: 'chrome' })
    expect([item.status, item.sentence]).toEqual([status, sentence])
  })

  it('says what the helper’s own page costs, and how far a granted permission reaches', () => {
    const local = helperRow(
      helperAt('connected', {
        permission: 'not-needed',
        env: { ...helperAt('off').env, mode: 'local' },
      }),
      'helper.lna',
    )
    expect(local.detail).toBe(
      'This copy is a separate site: the theme, USB permissions and the browser’s adb key from bauloc.github.io don’t carry over. It needs internet access, and can’t reload once the helper stops.',
    )
    const granted = helperRow(helperAt('off', { permission: 'granted' }), 'helper.lna')
    expect(granted.detail).toBe(
      'The permission covers every page of this site and every app on this Mac that listens locally; the helper still answers only to its token.',
    )
    expect(
      helperRow(helperAt('off', { permission: 'prompt' }), 'helper.lna').detail,
    ).toBeUndefined()
  })

  it('points a blocked permission at the browser’s setting, or at the helper’s own page', () => {
    const denied = (browser: BrowserName) =>
      targets(helperRow(helperAt('denied', { permission: 'denied' }), 'helper.lna', { browser }))
    expect(denied('firefox')).toEqual([
      'path:Settings → Privacy & Security → Device apps and services',
      'href:http://127.0.0.1:8787/device/',
    ])
    expect(denied('edge')).toContain(
      'copy:edge://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io',
    )
    const safari = helperRow(
      helperAt('safari', {
        permission: 'unsupported',
        env: { ...helperAt('off').env, port: 8788, safariLike: true },
      }),
      'helper.lna',
    )
    expect(targets(safari)).toEqual(['href:http://127.0.0.1:8788/device/'])
    expect(helperRow(helperAt('off', { permission: 'prompt' }), 'helper.lna').fixes).toEqual([
      { label: 'Connect helper', action: 'connect-helper' },
    ])
  })

  it('treats any answer as proof the page may reach the helper', () => {
    const item = helperRow(helperAt('connected', { permission: 'prompt' }), 'helper.lna')
    expect(item.status).toBe('ok')
  })

  it.each<[string, PublishedHelper | null, CheckStatus, string]>([
    [
      'the same file',
      { version: '1.0.0', sha256: SHA.toUpperCase() },
      'ok',
      'Matches the published helper (1.0.0).',
    ],
    [
      'a newer one',
      { version: '1.1.0', sha256: 'cd'.repeat(32) },
      'warning',
      'A newer helper (1.1.0) is published.',
    ],
    [
      'another build',
      { version: '1.0.0', sha256: 'cd'.repeat(32) },
      'warning',
      'This helper differs from the published file.',
    ],
    ['offline', null, 'unchecked', 'Couldn’t read the published helper, so this wasn’t compared.'],
  ])('compares with the published helper: %s', (_, published, status, sentence) => {
    const item = helperRow(helperAt('connected'), 'helper.update', { published })
    expect([item.status, item.sentence]).toEqual([status, sentence])
    if (status === 'warning') expect(targets(item)[0]).toMatch(/^copy:curl -fsSL /)
  })

  it('has no update row unless the Environment check read the published file', () => {
    expect(ids(helperChecks(helperAt('connected'), REPORT))).not.toContain('helper.update')
    expect(helperRow(helperAt('absent'), 'helper.update', { published: null }).status).toBe(
      'unchecked',
    )
  })

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.1.0-beta', '1.1.0')).toBe(0)
  })
})

describe('toolChecks', () => {
  const connected = helperAt('connected')

  it('stands one placeholder in for the tools until the helper is connected', () => {
    expect(toolChecks(helperAt('absent'), REPORT)).toEqual([
      {
        id: 'mac.tools',
        group: 'mac',
        label: 'This Mac’s tools',
        status: 'unchecked',
        sentence:
          'This Mac’s tools aren’t checked yet; start the helper to check Xcode, adb and the rest.',
      },
    ])
    // A helper that answers needs pairing or a matching version, not a start command.
    expect(toolChecks(helperAt('unpaired'), null)).toEqual([
      {
        id: 'mac.tools',
        group: 'mac',
        label: 'This Mac’s tools',
        status: 'unchecked',
        sentence: 'Checked once this page is paired with the helper.',
      },
    ])
    expect(toolChecks(helperAt('stale'), null)[0]?.sentence).toBe(
      'Checked once this page is paired with the helper.',
    )
    expect(toolChecks(helperAt('outdated'), null)[0]?.sentence).toBe(
      'Checked once the helper and this page agree on a version.',
    )
    expect(toolChecks(connected, null)).toMatchObject([
      {
        id: 'mac.tools',
        status: 'unchecked',
        sentence: 'Checked once the helper reports this Mac’s tools.',
      },
    ])
  })

  it('keeps the helper’s words, ids and order, and draws its fixes', () => {
    const rows = toolChecks(connected, REPORT, { webusb: true })
    expect(ids(rows)).toEqual([
      'mac.node',
      'ios.xcode',
      'ios.libimobiledevice',
      'ios.pymobiledevice3',
      'android.adb',
      'android.adb-server',
      'android.bundletool',
    ])
    const xcode = find(rows, 'ios.xcode')
    expect(xcode).toMatchObject({
      group: 'ios',
      label: 'Xcode',
      status: 'warning',
      sentence:
        'Xcode is installed, but the Command Line Tools are selected, so screenshots are off.',
      detail: 'devicectl 642.16',
    })
    expect(targets(xcode)).toEqual([
      'copy:sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
    ])
    expect(targets(find(rows, 'ios.libimobiledevice'))).toEqual([
      'href:https://brew.sh',
      'copy:brew install libimobiledevice',
    ])
  })

  it('draws every kind of helper fix', () => {
    expect(toolFix({ kind: 'step', text: 'Open Xcode once and let it finish.' }, 8787)).toEqual({
      label: 'Steps',
      path: 'Open Xcode once and let it finish.',
    })
    expect(
      toolFix({ kind: 'action', action: 'open-local', label: 'Open the helper’s page' }, 8788),
    ).toEqual({
      label: 'Open the helper’s page',
      href: 'http://127.0.0.1:8788/device/',
      primary: false,
    })
    expect(toolFix({ kind: 'action', action: 'recheck', label: 'Re-check' }, 8787)).toEqual({
      label: 'Re-check',
      action: 'recheck',
    })
    expect(toolFix({ kind: 'action', action: 'connect', label: 'Connect helper' }, 8787)).toEqual({
      label: 'Connect helper',
      action: 'connect-helper',
    })
  })

  it('moves the optional tools nothing here needs to Optional tools', () => {
    const rows = toolChecks(connected, REPORT)
    expect(find(rows, 'ios.libimobiledevice').group).toBe('optional')
    expect(find(rows, 'ios.pymobiledevice3').group).toBe('optional')
    expect(find(rows, 'android.bundletool').group).toBe('optional')
    expect(find(rows, 'ios.xcode').group).toBe('ios')
    // An iOS 16 iPhone needs libimobiledevice for screenshots; a simulator doesn't count.
    const legacy = toolChecks(connected, REPORT, { devices: [iphone({ osVersion: '16.7.10' })] })
    expect(find(legacy, 'ios.libimobiledevice').group).toBe('ios')
    const sim = toolChecks(connected, REPORT, {
      devices: [iphone({ osVersion: '16.4', connection: 'simulator' })],
    })
    expect(find(sim, 'ios.libimobiledevice').group).toBe('optional')
    // So does an iPhone whose secure session failed (ios.session is listed then).
    const session = toolChecks(connected, {
      ...REPORT,
      items: [...ITEMS, tool({ id: 'ios.session', status: 'blocking', neededFor: ['ios.detail'] })],
    })
    expect(find(session, 'ios.libimobiledevice').group).toBe('ios')
    // .aab bundles are never in play in v1.
    expect(find(legacy, 'android.bundletool').group).toBe('optional')
  })

  it('makes adb blocking only without WebUSB', () => {
    expect(find(toolChecks(connected, REPORT, { webusb: true }), 'android.adb').status).toBe(
      'warning',
    )
    expect(find(toolChecks(connected, REPORT, { webusb: false }), 'android.adb').status).toBe(
      'blocking',
    )
  })

  it('offers Start adb server only without WebUSB, and only when the helper can', () => {
    // adb installed: only the server is missing.
    const report = {
      ...REPORT,
      items: REPORT.items.map((i) =>
        i.id === 'android.adb' ? { ...i, status: 'ok' as const, fixes: [] } : i,
      ),
    }
    const withUsb = find(toolChecks(connected, report, { webusb: true }), 'android.adb-server')
    expect(withUsb.status).toBe('ok')
    expect(withUsb.fixes).toBeUndefined()

    const without = find(toolChecks(connected, report, { webusb: false }), 'android.adb-server')
    expect(without.status).toBe('warning')
    expect(without.sentence).toBe(
      'Without WebUSB, Android goes through Google’s adb server, which isn’t running.',
    )
    expect(targets(without)).toEqual(['action:start-adb'])

    const cannot = helperAt('connected', { health: { ...LIVE, features: [] } })
    expect(
      find(toolChecks(cannot, report, { webusb: false }), 'android.adb-server').fixes,
    ).toBeUndefined()
  })

  it('never offers Start adb server while adb isn’t installed: it could only fail', () => {
    // REPORT's adb row is "not installed".
    const rows = toolChecks(connected, REPORT, { webusb: false })
    expect(find(rows, 'android.adb')).toMatchObject({
      status: 'blocking',
      fixes: [{ copy: 'brew install --cask android-platform-tools' }],
    })
    const server = find(rows, 'android.adb-server')
    expect(server.status).toBe('ok')
    expect(server.sentence).toBe(
      'Google’s adb server isn’t running, so Chrome’s WebUSB can use Android phones directly.',
    )
    expect(server.fixes).toBeUndefined()
    // Any other row of the helper's with the button loses it too (install first, then start).
    const wifi = toolChecks(
      connected,
      {
        ...REPORT,
        items: [
          ...REPORT.items,
          tool({
            id: 'android.wifi',
            group: 'android',
            status: 'warning',
            fixes: [
              { kind: 'command', command: 'brew install --cask android-platform-tools' },
              { kind: 'action', action: 'start-adb', label: 'Start adb server' },
            ],
            neededFor: ['android.helper'],
          }),
        ],
      },
      { webusb: false },
    )
    expect(targets(find(wifi, 'android.wifi'))).toEqual([
      'copy:brew install --cask android-platform-tools',
    ])
  })

  it('adds a command’s note to the detail line', () => {
    const rows = toolChecks(connected, {
      ...REPORT,
      items: [
        tool({
          id: 'ios.xcode',
          detail: 'devicectl 642.16',
          fixes: [
            {
              kind: 'command',
              command: 'sudo xcodebuild -runFirstLaunch',
              note: 'Asks for your password.',
            },
          ],
        }),
      ],
    })
    expect(rows[0]?.detail).toBe('devicectl 642.16 · Asks for your password.')
  })

  it('drops rows whose id isn’t a tool’s', () => {
    expect(isToolId('ios.xcode')).toBe(true)
    expect(isToolId('mac.node')).toBe(true)
    expect(isToolId('device.x.trust')).toBe(false)
    expect(isToolId('ios.')).toBe(false)
    const rows = toolChecks(connected, {
      ...REPORT,
      items: [tool({ id: 'ios.Bad Id' }), tool({ id: 'helper.version', group: 'ios' })],
    })
    expect(rows).toEqual([])
  })
})

describe('deviceChecks', () => {
  const tools = toolChecks(helperAt('connected'), REPORT)
  // The device's own rows: what to plug in next is tested on its own below.
  const rows = (d: Device, connected = true, webusb = true) =>
    deviceChecks([d], { connected, webusb, tools }).filter((i) => !i.id.startsWith('device.none'))
  const byWhat = (items: CheckItem[]) =>
    Object.fromEntries(items.map((i) => [i.id.split('.').at(-1) ?? '', [i.status, i.sentence]]))

  it('lists a ready iPhone’s trust, lock, Developer Mode, iOS and screenshots, all OK', () => {
    const items = rows(iphone())
    expect(ids(items)).toEqual([
      'device.00008101-000A1B2C3D4E5F02.trust',
      'device.00008101-000A1B2C3D4E5F02.lock',
      'device.00008101-000A1B2C3D4E5F02.devmode',
      'device.00008101-000A1B2C3D4E5F02.ios-version',
      'device.00008101-000A1B2C3D4E5F02.screenshots',
    ])
    expect(items.every((i) => i.status === 'ok' && i.group === 'device')).toBe(true)
    expect(items[0]?.label).toBe('Ngọc’s iPhone: Trust')
    expect(find(items, 'device.00008101-000A1B2C3D4E5F02.ios-version').sentence).toBe(
      'iOS 27.0 is supported.',
    )
  })

  it('says only trust (and the version) until the iPhone trusts this Mac', () => {
    const items = rows(iphone({ state: 'untrusted' }))
    expect(byWhat(items)).toEqual({
      trust: ['blocking', 'This iPhone doesn’t trust this Mac yet.'],
      'ios-version': ['ok', 'iOS 27.0 is supported.'],
    })
    expect(targets(items[0] as CheckItem)[0]).toMatch(/^path:When asked, tap Trust/)
  })

  it('says a locked iPhone needs its passcode, and Developer Mode when it is off', () => {
    const locked = byWhat(rows(iphone({ state: 'locked' })))
    expect(locked.lock).toEqual(['blocking', 'The iPhone hasn’t been unlocked since it restarted.'])
    const off = byWhat(rows(iphone({ blockers: ['IOS_DEVELOPER_MODE_OFF'] })))
    expect(off.devmode).toEqual(['warning', 'Developer Mode is off, so screenshots are off.'])
  })

  it.each<[string, CheckStatus | null, string]>([
    ['14.8', 'warning', 'iOS 14 and older are untested; some details may be missing.'],
    ['15.8', 'ok', 'iOS 15.8 is supported.'],
    ['27.0', 'ok', 'iOS 27.0 is supported.'],
    [
      '28.0',
      'warning',
      'iOS 28 is newer than this helper knows; update the helper if something fails.',
    ],
  ])('iOS %s', (osVersion, status, sentence) => {
    const items = rows(iphone({ osVersion }))
    expect(byWhat(items)['ios-version']).toEqual([status, sentence])
    // iOS 15 has no Developer Mode.
    expect(ids(items).some((id) => id.endsWith('.devmode'))).toBe(Number.parseInt(osVersion) >= 16)
  })

  it('points screenshots that are off at the tool that would take them, as a warning', () => {
    const items = rows(
      iphone({ blockers: ['XCODE_REQUIRED'], capabilities: { screenshot: false } }),
    )
    const shots = find(items, 'device.00008101-000A1B2C3D4E5F02.screenshots')
    // Everything else on a ready iPhone works: a warning, as the Xcode row itself is.
    expect(shots.status).toBe('warning')
    expect(shots.sentence).toBe('Screenshots are off for this device.')
    expect(targets(shots)).toEqual([
      'copy:sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
    ])
    expect(shots.detail).toBe(
      'Xcode: Xcode is installed, but the Command Line Tools are selected, so screenshots are off.',
    )
    const ddi = rows(
      iphone({ osVersion: '16.7', blockers: ['IOS_DDI_REQUIRED'], capabilities: {} }),
    )
    expect(byWhat(ddi).screenshots).toEqual([
      'warning',
      'iOS 16 and older need Apple’s developer disk image mounted before a screenshot.',
    ])
    // Nothing else on the ready phone is blocked by it.
    expect(ddi.filter((item) => item.status === 'blocking')).toEqual([])
  })

  it('covers the Android phones the helper serves', () => {
    const pixel: Device = {
      ...iphone(),
      id: '55090DLAQ0026D',
      platform: 'android',
      name: 'Pixel 9',
    }
    expect(byWhat(rows({ ...pixel, state: 'unauthorized' }))).toEqual({
      'android-auth': ['blocking', 'The phone is waiting for you to allow USB debugging.'],
    })
    expect(byWhat(rows({ ...pixel, state: 'offline' }))).toEqual({
      offline: ['warning', 'The phone isn’t answering.'],
    })
    expect(byWhat(rows(pixel))).toEqual({
      'adb-conflict': ['ok', 'Shared through Google’s adb server.'],
    })
    // Held over WebUSB while the helper isn't connected: the helper is the way out.
    const held = rows({ ...pixel, backend: 'webusb', state: 'held' }, false)
    expect(byWhat(held)).toEqual({
      'adb-conflict': ['blocking', 'Google’s adb server is holding this phone.'],
    })
    expect(targets(held[0] as CheckItem)).toEqual(['copy:adb kill-server', 'action:connect-helper'])
    expect(rows({ ...pixel, backend: 'webusb', state: 'held' }, true)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ status: 'blocking' })]),
    )
  })

  it('words a Wi‑Fi device by its screen and its network, not a cable', () => {
    const tv: Device = {
      ...iphone(),
      id: '192.168.1.42:5555',
      platform: 'android',
      connection: 'network',
      name: 'Living Room TV',
    }
    const waiting = rows({ ...tv, state: 'unauthorized' })
    expect(byWhat(waiting)).toEqual({
      'android-auth': [
        'blocking',
        'Living Room TV is waiting for you to choose Allow on “Allow debugging?”.',
      ],
    })
    expect(targets(waiting[0] as CheckItem)[0]).toMatch(/^path:Choose Allow .*with the remote/)
    const offline = rows({ ...tv, state: 'offline' })
    expect(byWhat(offline)).toEqual({
      offline: ['warning', 'Living Room TV stopped answering over Wi‑Fi.'],
    })
    expect(targets(offline[0] as CheckItem)).toContain('action:open-wifi')
    expect(byWhat(rows(tv))).toEqual({
      wifi: ['ok', 'Connected over Wi‑Fi through Google’s adb server.'],
    })
  })

  it('says what to plug in when the helper is connected and nothing is', () => {
    expect(ids(deviceChecks([], { connected: true, webusb: true }))).toEqual(['device.none.ios'])
    expect(ids(deviceChecks([], { connected: true, webusb: false }))).toEqual([
      'device.none.ios',
      'device.none.android',
    ])
    expect(deviceChecks([], { connected: false, webusb: false })).toEqual([])
    // Simulators have nothing to check, and don't count as a plugged-in iPhone.
    const sim = iphone({ connection: 'simulator' })
    expect(ids(deviceChecks([sim], { connected: true, webusb: true }))).toEqual(['device.none.ios'])
  })
})

describe('inlineChecks', () => {
  const tools = toolChecks(helperAt('connected'), REPORT)

  it('shows the helper’s row for the tool a blocker needs, never an OK one', () => {
    expect(ids(inlineChecks(iphone({ blockers: ['XCODE_REQUIRED'] }), tools))).toEqual([
      'ios.xcode',
    ])
    expect(ids(inlineChecks(iphone({ blockers: ['TOOL_MISSING'] }), tools))).toEqual([
      'ios.libimobiledevice',
    ])
    expect(inlineChecks(iphone({ blockers: ['IOS_LOCKED'] }), tools)).toEqual([])
    const fine = tools.map((t) => ({ ...t, status: 'ok' as const }))
    expect(inlineChecks(iphone({ blockers: ['XCODE_REQUIRED'] }), fine)).toEqual([])
    // Not the helper's device: nothing of the helper's applies.
    expect(inlineChecks(iphone({ backend: 'mock', blockers: ['XCODE_REQUIRED'] }), tools)).toEqual(
      [],
    )
    expect(TOOL_BLOCKERS.has('IOS_DDI_REQUIRED')).toBe(true)
  })
})

describe('the checklist’s views', () => {
  const all = [
    ...helperChecks(helperAt('connected'), REPORT, { webusb: true }),
    ...deviceChecks([], { connected: true, webusb: true }),
  ]

  it('sorts by section, then blocking, warning, not checked, OK', () => {
    const sorted = sortChecks(all)
    const groups = [...new Set(sorted.map((i) => i.group))]
    expect(groups).toEqual(['helper', 'mac', 'ios', 'android', 'device', 'optional'])
    const android = sorted.filter((i) => i.group === 'android').map((i) => i.status)
    expect(android).toEqual(['warning', 'ok'])
  })

  it('keeps the optional tools and the devices off the Gate', () => {
    const gate = gateChecks(all)
    expect(gate.some((i) => i.group === 'optional' || i.group === 'device')).toBe(false)
    expect(gateSummary(gate)).toBe('2 need attention · 6 passed')
    expect(gateSummary(gateChecks(helperChecks(helperAt('absent'), null)))).toBe(
      '1 needs attention · 1 passed · 3 not checked yet',
    )
  })

  it('never lets a 43-character token into Copy as text, and keeps hashes and fingerprints', () => {
    const token = 'Qx7-' + 'a'.repeat(39)
    expect(token).toHaveLength(43)
    const leaky: CheckItem = {
      id: 'mac.node',
      group: 'mac',
      label: 'Node',
      status: 'ok',
      sentence: `Token ${token} pasted here.`,
      detail: `sha ${SHA} · fingerprint 4d1566a1`,
    }
    const text = checklistText([...all, leaky])
    expect(text).not.toContain(token)
    expect(text).toContain(SHA)
    expect(text).toContain('4d1566a1')
    expect(redactSecrets(`x ${token}.`)).toBe('x ….')
    expect(text.split('\n\n').map((s) => s.split('\n')[0])).toEqual([
      'Helper',
      'This Mac',
      'iPhone tools',
      'Android tools',
      'Devices',
      'Optional tools',
    ])
  })
})

describe('the real helper’s /api/doctor', () => {
  it('merges into the checklist as the helper words it', async () => {
    const helper = await startRealHelper()
    try {
      const response = await helper.fetch(`${helper.apiBase}/api/doctor`, {
        headers: { Authorization: `Bearer ${helper.token}` },
      })
      const report = parseDoctor(await response.json())
      expect(report).not.toBeNull()
      if (!report) return
      const status = helperAt('connected', {
        health: { ...LIVE, port: helper.port, tokenId: helper.tokenId },
        env: { ...helperAt('connected').env, port: helper.port },
      })
      const rows = toolChecks(status, report, { webusb: true })
      expect(rows.length).toBeGreaterThan(0)
      for (const item of rows) {
        expect(isToolId(item.id)).toBe(true)
        expect(['mac', 'ios', 'android', 'optional']).toContain(item.group)
        expect(item.label).not.toBe('')
        expect(item.sentence).not.toBe('')
      }
      // Every row the helper sent in its tool groups made it, in its order.
      const sent = report.items.filter((i) => ['mac', 'ios', 'android'].includes(i.group))
      expect(ids(rows)).toEqual(sent.map((i) => i.id))
      expect(checklistText(rows)).not.toContain(helper.token)
    } finally {
      await helper.close()
    }
  })
})

describe('wifiChecks', () => {
  // A helper new enough for Wi‑Fi, running and paired.
  const CONNECT = helperAt('connected', {
    health: { ...LIVE, features: ['android.start-server', 'android.connect'] },
  })
  const attempt = (patch: Partial<WifiAttempt> = {}): WifiAttempt => ({
    kind: 'connect',
    host: '192.168.1.42',
    port: 5555,
    state: 'running',
    ...patch,
  })
  const say = (items: CheckItem[]) =>
    Object.fromEntries(items.map((i) => [i.id.slice(5), [i.status, i.sentence]]))

  it('lists the path in order, unchecked until the tester tries', () => {
    const items = wifiChecks({ helper: CONNECT, attempt: null, device: null })
    expect(ids(items)).toEqual([
      'wifi.helper',
      'wifi.adbServer',
      'wifi.reachable',
      'wifi.authorized',
    ])
    expect(items.map((i) => i.status)).toEqual(['ok', 'ok', 'unchecked', 'unchecked'])
    expect(wifiHelperReady(CONNECT)).toBe(true)
    expect(GROUP_ORDER.indexOf('wifi')).toBe(GROUP_ORDER.indexOf('device') + 1)
  })

  it('points at the helper first: absent, unpaired, or too old for Wi‑Fi', () => {
    const absent = wifiChecks({ helper: helperAt('absent'), attempt: null, device: null })
    expect(absent[0]).toMatchObject({ status: 'blocking' })
    expect(targets(absent[0] as CheckItem)).toEqual([
      expect.stringMatching(/^copy:curl -fsSL /),
      'action:connect-helper',
    ])
    expect(absent[1]?.status).toBe('unchecked')
    const unpaired = wifiChecks({ helper: helperAt('unpaired'), attempt: null, device: null })
    expect(targets(unpaired[0] as CheckItem)).toEqual(['action:pair-helper'])
    const old = helperAt('connected')
    expect(wifiHelperReady(old)).toBe(false)
    const oldRow = wifiChecks({ helper: old, attempt: null, device: null })[0] as CheckItem
    expect(oldRow).toMatchObject({
      status: 'blocking',
      sentence:
        'Your helper is older than this page: it can’t connect to devices over Wi‑Fi yet. Update it: press Ctrl+C in its window, then run:',
      detail: 'Then reload this page.',
    })
    expect(targets(oldRow)).toEqual([expect.stringMatching(/^copy:curl -fsSL /)])
    // --no-android leaves android.connect out too: the adb server's row says why, not this one.
    const off: HelperStatus = {
      ...old,
      lanes: { ...LANES, android: { status: 'off', adb: 'found', startedByHelper: false } },
    }
    const offRows = wifiChecks({ helper: off, attempt: null, device: null })
    expect(offRows[0]?.status).toBe('ok')
    expect(offRows[1]).toMatchObject({
      status: 'blocking',
      sentence: expect.stringMatching(/--no-android/),
    })
  })

  it('then the adb server: stopped with its Start button, missing with the install command', () => {
    const lanes = (android: Lanes['android']): HelperStatus => ({
      ...CONNECT,
      lanes: { ...LANES, android },
    })
    const stopped = wifiChecks({
      helper: lanes({ status: 'stopped', adb: 'found', startedByHelper: false }),
      attempt: null,
      device: null,
    })[1] as CheckItem
    expect(stopped).toMatchObject({
      status: 'blocking',
      sentence: 'Google’s adb server isn’t running, and Wi‑Fi devices go through it.',
    })
    expect(targets(stopped)).toEqual(['action:start-adb'])
    const missing = wifiChecks({
      helper: lanes({ status: 'stopped', adb: 'missing', startedByHelper: false }),
      attempt: null,
      device: null,
    })[1] as CheckItem
    expect(targets(missing)).toEqual(['copy:brew install --cask android-platform-tools'])
    const off = wifiChecks({
      helper: lanes({ status: 'off', adb: 'found', startedByHelper: false }),
      attempt: null,
      device: null,
    })[1] as CheckItem
    expect(off.detail).toBe('Stop the helper (Ctrl+C) and start it again without --no-android.')
  })

  it('follows a connect: connecting, answered, then waiting for Allow, then allowed', () => {
    expect(say(wifiChecks({ helper: CONNECT, attempt: attempt(), device: null }))).toMatchObject({
      reachable: ['unchecked', 'Connecting to 192.168.1.42:5555…'],
    })
    const ok = attempt({ state: 'ok', serial: '192.168.1.42:5555' })
    const waiting = wifiChecks({
      helper: CONNECT,
      attempt: ok,
      device: { id: '192.168.1.42:5555', name: '192.168.1.42:5555', state: 'unauthorized' },
    })
    expect(say(waiting)).toMatchObject({
      reachable: ['ok', '192.168.1.42:5555 answered.'],
      authorized: [
        'blocking',
        '192.168.1.42:5555 is waiting for you to choose Allow on “Allow debugging?”.',
      ],
    })
    const allowed = wifiChecks({
      helper: CONNECT,
      attempt: ok,
      device: { id: '192.168.1.42:5555', name: 'Living Room TV', state: 'ready' },
    })
    expect(say(allowed)).toMatchObject({
      authorized: [
        'ok',
        'Living Room TV allows this computer. Details, screenshots, logs, apps, images and installs all work.',
      ],
    })
  })

  it('reads a Wi‑Fi device listed now when there was no attempt in this page', () => {
    const items = wifiChecks({
      helper: CONNECT,
      attempt: null,
      device: { id: '192.168.1.42:5555', name: 'Living Room TV', state: 'offline' },
    })
    expect(say(items)).toMatchObject({
      reachable: ['warning', 'Living Room TV stopped answering over Wi‑Fi.'],
      authorized: ['unchecked', 'Checked once the device answers.'],
    })
  })

  it('adds this computer’s own row after a blocked connect, and leaves the device unknown', () => {
    const blocked = attempt({
      state: 'failed',
      code: 'ANDROID_CONNECT_FAILED',
      reason: 'blocked',
      detail: "failed to connect to '192.168.1.42:5555': No route to host",
    })
    const items = wifiChecks({ helper: CONNECT, attempt: blocked, device: null })
    expect(ids(items)).toEqual([
      'wifi.helper',
      'wifi.adbServer',
      'wifi.localNetwork',
      'wifi.reachable',
      'wifi.authorized',
    ])
    const local = find(items, 'wifi.localNetwork')
    expect(local).toMatchObject({
      status: 'blocking',
      label: 'This computer reaches the local network',
      detail: "adb said: “failed to connect to '192.168.1.42:5555': No route to host”",
    })
    expect(targets(local)).toEqual([
      expect.stringMatching(/^path:Turn off the VPN/),
      expect.stringMatching(
        /^path:Stop the helper \(Ctrl\+C\), start it again from the Terminal app with the command above,/,
      ),
      'copy:node ~/device-bridge.mjs',
    ])
    expect(say(items).reachable).toEqual([
      'unchecked',
      'Checked once this computer can reach the local network.',
    ])
    expect(worst(items)).toBe('blocking')
    // A helper on Linux or Windows: only the VPN applies.
    const linux = helperAt('connected', {
      health: { ...LIVE, platform: 'linux-x64', features: ['android.connect'] },
    })
    const other = find(
      wifiChecks({ helper: linux, attempt: blocked, device: null }),
      'wifi.localNetwork',
    )
    expect(targets(other)).toEqual([expect.stringMatching(/^path:Turn off the VPN/)])
    // Any other failure keeps the four rows.
    const refused = attempt({ state: 'failed', code: 'ANDROID_CONNECT_FAILED', reason: 'refused' })
    expect(ids(wifiChecks({ helper: CONNECT, attempt: refused, device: null }))).not.toContain(
      'wifi.localNetwork',
    )
  })

  it('words a blocked look for nearby devices as this computer’s doing, with the same ways out', () => {
    const item = nearbyBlockedCheck(CONNECT, 'send EHOSTUNREACH 224.0.0.251:5353')
    expect(item).toMatchObject({
      id: 'wifi.localNetwork',
      status: 'blocking',
      label: 'This computer reaches the local network',
      sentence:
        'This computer can’t reach the local network, so it can’t look for devices on it. The problem is on this computer, not the TV or phone.',
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    })
    expect(targets(item)).toEqual([
      'path:Turn off the VPN (Cloudflare WARP, a work VPN), or let it reach the local network, then refresh.',
      expect.stringMatching(
        /^path:Stop the helper \(Ctrl\+C\), start it again from the Terminal app with the command above,/,
      ),
      'copy:node ~/device-bridge.mjs',
    ])
    const linux = helperAt('connected', {
      health: { ...LIVE, platform: 'linux-x64', features: ['android.discover'] },
    })
    expect(targets(nearbyBlockedCheck(linux))).toEqual([
      expect.stringMatching(/^path:Turn off the VPN/),
    ])
    expect(nearbyBlockedCheck(linux).detail).toBeUndefined()
  })

  it('says a pairing went through, and that connecting comes next on another port', () => {
    const paired = wifiChecks({
      helper: CONNECT,
      attempt: attempt({ kind: 'pair', port: 37099, state: 'ok' }),
      device: null,
    })
    expect(paired[2]?.sentence).toBe(
      'Paired with 192.168.1.42:37099. Now connect, with the port the Wireless debugging screen shows next to “IP address & Port”.',
    )
  })
})

describe('wifiFailure', () => {
  const failed = (patch: Partial<WifiAttempt>): WifiAttempt => ({
    kind: 'connect',
    host: '192.168.1.42',
    port: 5556,
    state: 'failed',
    code: 'ANDROID_CONNECT_FAILED',
    ...patch,
  })

  it.each<[Partial<WifiAttempt>, string, string[]]>([
    [
      { reason: 'refused', detail: 'Connection refused' },
      '192.168.1.42 answered, but nothing accepts debugging on port 5556.',
      [
        'path:Turn on Network debugging',
        'path:Settings → Device Preferences',
        'path:Settings → System',
      ],
    ],
    [
      { reason: 'unreachable' },
      'Nothing answered at 192.168.1.42:5556.',
      ['path:Check that the device'],
    ],
    [
      { reason: 'blocked', detail: "failed to connect to '192.168.1.42:5556': No route to host" },
      'This computer blocked the connection to 192.168.1.42:5556, so the device never saw it. The problem is on this computer, not the TV or phone.',
      ['path:Turn off the VPN', 'path:Stop the helper (Ctrl+C), start it again from the Terminal'],
    ],
    [
      { reason: 'timeout' },
      '192.168.1.42:5556 didn’t answer in time.',
      ['path:Check that the device'],
    ],
    [
      { reason: 'unresolved', host: 'tv.local' },
      'No device called tv.local was found on this network.',
      ['path:Use the IP address instead'],
    ],
    [
      // adb says this to a TV still asking "Allow debugging?": never read as "pair first".
      { reason: 'failed', detail: 'failed to authenticate to 192.168.1.42:5556' },
      'adb couldn’t connect to 192.168.1.42:5556.',
      ['path:Check that the device is on and awake'],
    ],
    [
      { reason: 'unpaired', detail: 'failed to authenticate to 192.168.1.42:5556' },
      '192.168.1.42:5556 uses Wireless debugging, which needs pairing with a code first.',
      ['path:Settings → System → Developer options → Wireless debugging → Pair'],
    ],
    [
      { kind: 'pair', code: 'ANDROID_PAIR_FAILED', reason: 'wrong-code' },
      'The pairing code was wrong, or the pairing screen closed.',
      ['path:Settings → System → Developer options → Wireless debugging → Pair'],
    ],
    [
      { kind: 'pair', code: 'ANDROID_PAIR_FAILED', reason: 'unsupported' },
      'This Mac’s adb is too old to pair with a code.',
      ['copy:brew upgrade --cask android-platform-tools'],
    ],
    [
      { code: 'ADB_SERVER_STOPPED' },
      'Google’s adb server isn’t running, and Wi‑Fi devices go through it.',
      ['action:start-adb'],
    ],
    [
      { code: 'HELPER_TIMEOUT' },
      '192.168.1.42:5556 didn’t answer in time.',
      ['path:Check that the device'],
    ],
    [
      {
        code: 'BAD_REQUEST',
        message: 'Only devices on your local network: 10.x, 172.16–31.x, 192.168.x.',
      },
      'Only devices on your local network: 10.x, 172.16–31.x, 192.168.x.',
      [],
    ],
  ])('%j', (patch, sentence, fixes) => {
    const failure = wifiFailure(failed(patch))
    expect(failure.sentence).toBe(sentence)
    const shown = failure.fixes.map(target)
    expect(shown).toHaveLength(fixes.length)
    fixes.forEach((prefix, i) => {
      expect(shown[i]?.startsWith(prefix)).toBe(true)
    })
  })

  it('quotes adb’s own words, and a second click while one runs is not a failure', () => {
    expect(wifiFailure(failed({ reason: 'refused', detail: 'Connection refused' })).detail).toBe(
      'adb said: “Connection refused”',
    )
    expect(wifiFailure(failed({ code: 'BUSY' }))).toMatchObject({
      status: 'unchecked',
      sentence: 'Already connecting to 192.168.1.42. Wait for that to finish.',
    })
  })
})
