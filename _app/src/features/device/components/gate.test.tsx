// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HelperPhase, HelperStatus } from '../helper/connection'
import type { DoctorReport, Health, Lanes, PreflightItem } from '../helper/protocol'
import { DOWNLOAD_COMMAND } from '../helper/status'
import {
  browserChecks,
  GATE_STEPS,
  gateChecks,
  gateSummary,
  helperChecks,
  phoneChecks,
} from '../preflight/checks'
import type { BrowserEnv, PhoneInput } from '../preflight/types'
import {
  Gate,
  gateSteps,
  platformChecklist,
  presetPlatform,
  readGatePlatform,
  saveGatePlatform,
  stepStatus,
} from './gate'

const ENV: BrowserEnv = {
  secure: true,
  https: true,
  href: 'https://bauloc.github.io/device/',
  webusb: true,
  usbPolicy: true,
  inflate: true,
  lna: 'prompt',
  os: 'mac',
  browser: 'chrome',
  version: '1.0.0',
  appUpdated: false,
}

const NO_PHONE: PhoneInput = {
  device: null,
  picker: 'none',
  usb: { kind: 'unknown' },
  authorizingSince: null,
  now: 0,
  os: 'mac',
  browser: 'chrome',
  otherTab: false,
  holder: null,
}

const LANES: Lanes = {
  ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: false, wifiHidden: 0 },
  android: { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: false },
  simulators: { status: 'off', booted: 0 },
}

const HEALTH: Health = {
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
  sha256: 'a'.repeat(64),
}

function helper(phase: HelperPhase, patch: Partial<HelperStatus> = {}): HelperStatus {
  const answered = phase === 'connected' || phase === 'unpaired' || phase === 'stale'
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
    health: answered ? HEALTH : null,
    lanes: phase === 'connected' ? LANES : null,
    pairing:
      phase === 'connected'
        ? { tokenId: '4d1566a1', remembered: false, tokenPersistent: false }
        : null,
    remember: false,
    intent: phase !== 'off',
    since: 0,
    error: null,
    ...patch,
  }
}

const OFF = helper('off')

/** A doctor report with Xcode missing and everything else fine. */
const DOCTOR: DoctorReport = {
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
    sha256: 'a'.repeat(64),
  },
  lanes: LANES,
  items: [
    {
      id: 'mac.node',
      group: 'mac',
      label: 'Node 24.12.0',
      status: 'ok',
      sentence: 'Node 24.12.0 runs the helper.',
      fixes: [],
      neededFor: ['helper'],
    },
    {
      id: 'ios.xcode',
      group: 'ios',
      label: 'Xcode',
      status: 'warning',
      sentence:
        'Xcode isn’t installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.',
      fixes: [
        {
          kind: 'link',
          href: 'https://apps.apple.com/app/xcode/id497799835',
          label: 'Get Xcode from the App Store',
        },
      ],
      neededFor: ['ios.screenshot'],
    },
  ],
  checkedAt: 0,
}

afterEach(() => {
  cleanup()
})

/** The headings on screen, in document order. */
const headings = () => screen.getAllByRole('heading').map((h) => h.textContent)

/** The <li> of the step whose heading reads `name` ("Step 2: …"). */
function stepNamed(name: string): HTMLElement {
  const heading = screen.getAllByRole('heading').find((h) => h.textContent === name)
  const li = heading?.closest('li')
  if (!li) throw new Error(`no step ${name}`)
  return li
}

describe('gateSteps', () => {
  it('takes the phone steps in GATE_STEPS order and leaves the other rows out', () => {
    const steps = gateSteps(phoneChecks({ ...NO_PHONE, os: 'linux' }))
    expect(steps.map((s) => s.id)).toEqual(GATE_STEPS)
  })
})

describe('Gate', () => {
  it('numbers this browser and the four phone steps; nothing went wrong, so no status word', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    const steps = within(screen.getByRole('list', { name: 'Connect your phone' }))
      .getAllByRole('heading')
      .map((h) => h.textContent)
    expect(steps).toEqual([
      'Step 1: This browser',
      'Step 2: USB debugging',
      'Step 3: Data cable',
      'Step 4: Phone allowed in the browser',
      'Step 5: Allowed on the phone',
    ])
    const list = screen.getByRole('list', { name: 'Connect your phone' })
    // "No phone allowed yet" is the next thing to do, not a problem: no Warning, no amber.
    expect(within(list).queryByText('Warning')).toBeNull()
    expect(within(list).queryByText('Not checked')).toBeNull()
  })

  it('keeps Warning for a step that went wrong: the browser’s list closed without a phone', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks({ ...NO_PHONE, picker: 'dismissed' })}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    expect(stepNamed('Step 4: Phone allowed in the browser')).toHaveTextContent('Warning')
  })

  it('tells a step to do next from a problem', () => {
    const [permission] = phoneChecks(NO_PHONE).filter((item) => item.id === 'phone.permission')
    if (!permission) throw new Error('no permission row')
    expect(stepStatus(permission)).toBeUndefined()
    const dismissed = phoneChecks({ ...NO_PHONE, picker: 'dismissed' }).find(
      (item) => item.id === 'phone.permission',
    )
    expect(dismissed && stepStatus(dismissed)).toBe('warning')
    const off = phoneChecks({ ...NO_PHONE, usb: { kind: 'debugging-off', name: 'Pixel 9' } }).find(
      (item) => item.id === 'phone.usbDebugging',
    )
    expect(off && stepStatus(off)).toBe('blocking')
  })

  it('lays the USB debugging paths out as a lettered list, and Android’s guide as a link', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    const step = stepNamed('Step 2: USB debugging')
    const paths = within(step).getAllByRole('listitem')
    expect(paths.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Turn on Developer options: Settings → About phone/),
      expect.stringMatching(/^Turn on USB debugging: Settings → System → Developer options/),
    ])
    const guide = within(step).getByRole('link', { name: /Read Android’s guide/ })
    expect(guide).toHaveAttribute('target', '_blank')
    expect(guide).not.toHaveAttribute('data-slot', 'button')
  })

  it('offers a TV or phone across the room over Wi‑Fi, when the page wires it', () => {
    const wifi = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
        onWifi={wifi}
      />,
    )
    const section = screen.getByRole('region', { name: /Phone or TV on Wi‑Fi\?/ })
    expect(section).toHaveTextContent('Through the helper')
    fireEvent.click(within(section).getByRole('button', { name: 'Network device (Wi‑Fi)…' }))
    expect(wifi).toHaveBeenCalledTimes(1)
    cleanup()
    render(
      <Gate browser={browserChecks(ENV)} phone={phoneChecks(NO_PHONE)} wiring={{}} helper={OFF} />,
    )
    expect(screen.queryByRole('region', { name: /Phone or TV on Wi‑Fi\?/ })).toBeNull()
  })

  it('shows what is on the network in the Wi‑Fi part, when given', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
        onWifi={() => undefined}
        nearby={<p>SONY KD-43X8050H</p>}
      />,
    )
    expect(screen.getByRole('region', { name: /Phone or TV on Wi‑Fi/ })).toHaveTextContent(
      'SONY KD-43X8050H',
    )
  })

  it('lists Blocking browser rows first, before the steps, and keeps OK ones out of the way', () => {
    render(
      <Gate
        browser={browserChecks({ ...ENV, secure: false, https: false, appUpdated: true })}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
        choice="android"
      />,
    )
    // After the page's H1 and Android's headline: step 1 is this browser, worst first.
    expect(headings().slice(2, 7)).toEqual([
      'Step 1: This browser',
      'Secure page',
      'Device Lab version',
      'WebUSB',
      'Step 2: USB debugging',
    ])
    // The step says its worst; with several problems, each says its own.
    expect(within(stepNamed('Step 1: This browser')).getAllByText('Blocking')).toHaveLength(3)
    expect(within(stepNamed('Step 1: This browser')).getByText('Not checked')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the secure page/ })).toHaveAttribute(
      'href',
      'https://bauloc.github.io/device/',
    )
  })

  it('says the browser is ready in one line when nothing about it is wrong', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    expect(screen.queryByText('Secure page')).toBeNull()
    expect(
      screen.getByText('This browser can talk to Android phones over USB. Nothing to install.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Connect a device' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up Android over USB' }),
    ).toBeInTheDocument()
    // Step 1, done: its sentence, and no word of its own.
    expect(stepNamed('Step 1: This browser')).not.toHaveTextContent('OK')
    // What the steps say isn't said again in a footnote.
    expect(screen.queryByText(/WebUSB needs Chrome, Edge or Opera ·/)).toBeNull()
  })

  it('runs Add device from step 3 when the browser can do USB', () => {
    const add = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: { 'add-device': add } }}
        helper={OFF}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }))
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('points Add device at the browser problem instead of running it without WebUSB', () => {
    const add = vi.fn()
    render(
      <Gate
        browser={browserChecks({ ...ENV, webusb: false, browser: 'firefox' })}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: { 'add-device': add } }}
        helper={OFF}
        choice="android"
      />,
    )
    const button = screen.getByRole('button', { name: 'Add device' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(/This browser can’t talk to USB devices/)
    fireEvent.click(button)
    expect(add).not.toHaveBeenCalled()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // No WebUSB, no "Didn't see your phone?": there is no picker to be empty.
    expect(screen.queryByText('Didn’t see your phone?')).toBeNull()
  })

  it('keeps the adb help under “Didn’t see your phone?”, with Find my phone… when wired', () => {
    const find = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: { 'find-phone': find } }}
        helper={OFF}
      />,
    )
    const details = screen.getByText('Didn’t see your phone?').closest('details')
    expect(details).not.toBeNull()
    if (!details) return
    expect(within(details).getByText('adb kill-server').tagName).toBe('CODE')
    expect(within(details).getByText(/an IDE is restarting it/)).toBeInTheDocument()
    fireEvent.click(within(details).getByRole('button', { name: 'Find my phone…' }))
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('shows what Find my phone… found in step 1', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks({ ...NO_PHONE, usb: { kind: 'debugging-off', name: 'Pixel 9' } })}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    expect(screen.getByText('Pixel 9 is plugged in, but USB debugging is off.')).toBeInTheDocument()
    expect(screen.getAllByText('Blocking')).toHaveLength(1)
  })
})

describe('Gate, with the local helper', () => {
  it('shows the helper card with its command, Connect and the download link', () => {
    const connect = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
        helperOn={{ connect }}
        choice="ios"
      />,
    )
    expect(screen.getByText('Needs the helper')).toBeInTheDocument()
    expect(screen.getByText(DOWNLOAD_COMMAND).tagName).toBe('CODE')
    fireEvent.click(screen.getByRole('button', { name: 'Connect helper' }))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: /Download device-bridge\.mjs/ })).toHaveAttribute(
      'href',
      'https://bauloc.github.io/device/agent/device-bridge.mjs',
    )
    expect(screen.getByRole('link', { name: /Review the source/ })).toHaveAttribute(
      'target',
      '_blank',
    )
    // Nobody asked for the helper yet: no checks.
    expect(screen.queryByText(/^All checks/)).toBeNull()
    expect(screen.queryByText(/helper needs macOS and Node 18 or newer, plus Xcode/)).toBeNull()
  })

  it('off macOS, the iPhone card says iPhones need a Mac instead of a Mac-only command', () => {
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        os="windows"
        helper={OFF}
        helperOn={{ connect: vi.fn() }}
        choice="ios"
      />,
    )
    expect(screen.getByText('iPhones need a Mac')).toBeInTheDocument()
    expect(screen.queryByText(DOWNLOAD_COMMAND)).toBeNull()
    expect(screen.queryByText(/Run this in Terminal on this Mac/)).toBeNull()
  })

  it('once connected, opens “plug in”, and repeats nothing the steps say in the checks', () => {
    const status = helper('connected')
    const items = gateChecks(helperChecks(status, DOCTOR, { webusb: true }))
    const recheck = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: { recheck } }}
        helper={status}
        checklist={items}
      />,
    )
    // The helper is in play: the Gate presets iPhone & iPad.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up iPhone through the helper' }),
    ).toBeTruthy()
    expect(screen.getByText('Ready for iPhones')).toBeInTheDocument()
    // Xcode is a step of its own now, with its link, rather than a checklist row.
    const xcode = stepNamed('Step 6: Xcode, for iOS 17 and newer')
    expect(xcode).toHaveTextContent('Warning')
    expect(within(xcode).getByRole('link', { name: /Get Xcode/ })).toHaveAttribute(
      'href',
      'https://apps.apple.com/app/xcode/id497799835',
    )
    const card = platformChecklist(items, 'ios')
    // What the steps say is not said again: Node.js, reaching the helper, it running, current
    // and paired, Xcode. Here that is every row, so there are no checks at all.
    for (const id of [
      'mac.node',
      'helper.lna',
      'helper.running',
      'helper.version',
      'helper.paired',
      'ios.xcode',
    ])
      expect(card.some((item) => item.id === id)).toBe(false)
    expect(card).toEqual([])
    expect(screen.queryByText(/^All checks/)).toBeNull()
    expect(recheck).not.toHaveBeenCalled()
  })

  it('gathers the other checks behind “All checks” at the foot of the card', () => {
    const status = helper('connected')
    const items = gateChecks(helperChecks(status, DOCTOR, { webusb: true }))
    const recheck = vi.fn()
    const props = {
      browser: browserChecks(ENV),
      phone: phoneChecks(NO_PHONE),
      wiring: { on: { recheck } },
      helper: status,
    }
    const { unmount } = render(<Gate {...props} checklist={items} choice="android" />)
    const card = platformChecklist(items, 'android')
    // Android's side: the helper's rows, none of the iPhone's.
    expect(card.map((item) => item.id)).not.toContain('ios.xcode')
    const region = screen.getByRole('region', { name: 'Set up Android over USB' })
    const summary = within(region).getByText(`All checks (${String(card.length)})`)
    const details = summary.closest('details')
    // Everything passed: folded away, with the count and the summary on its one line.
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent(gateSummary(card))
    fireEvent.click(within(region).getByRole('button', { name: 'Re-check' }))
    expect(recheck).toHaveBeenCalledTimes(1)
    unmount()

    // A row that needs attention opens it by itself.
    const adb: PreflightItem = {
      id: 'android.adb',
      group: 'android',
      label: 'adb',
      status: 'warning',
      sentence: 'adb isn’t installed.',
      fixes: [],
      neededFor: ['android.helper'],
    }
    const withAdb = gateChecks(
      helperChecks(status, { ...DOCTOR, items: [...DOCTOR.items, adb] }, { webusb: true }),
    )
    render(<Gate {...props} checklist={withAdb} choice="android" />)
    expect(screen.getByText(/^All checks/).closest('details')).toHaveAttribute('open')
    expect(screen.getByText('adb isn’t installed.')).toBeInTheDocument()
  })

  it('offers Start adb server in the Android card only without WebUSB, and only when wired', () => {
    const status = helper('connected', {
      lanes: { ...LANES, android: { status: 'stopped', adb: 'found', startedByHelper: false } },
    })
    const start = vi.fn()
    const props = {
      phone: phoneChecks(NO_PHONE),
      wiring: { on: { 'start-adb': start } },
      helper: status,
      choice: 'android' as const,
    }
    const { unmount } = render(<Gate browser={browserChecks(ENV)} {...props} />)
    expect(screen.queryByRole('button', { name: 'Start adb server' })).toBeNull()
    unmount()
    render(
      <Gate browser={browserChecks({ ...ENV, webusb: false, browser: 'firefox' })} {...props} />,
    )
    const section = screen.getByRole('region', { name: 'Through the local helper' })
    expect(
      within(section).getByText(
        'The helper reaches Android through Google’s adb server, which isn’t running.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Start adb server' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(within(section).getByText(/adb kill-server gives them back/)).toBeInTheDocument()
  })

  it('a helper without Start adb server: says it is older than this page, with the command', () => {
    const status = helper('connected', {
      health: { ...HEALTH, features: [] },
      lanes: { ...LANES, android: { status: 'stopped', adb: 'found', startedByHelper: false } },
    })
    render(
      <Gate
        browser={browserChecks({ ...ENV, webusb: false, browser: 'firefox' })}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: { 'start-adb': vi.fn() } }}
        helper={status}
        choice="android"
      />,
    )
    const section = screen.getByRole('region', { name: 'Through the local helper' })
    expect(within(section).queryByRole('button', { name: 'Start adb server' })).toBeNull()
    expect(section).toHaveTextContent(
      'Your helper is older than this page: it can’t start Google’s adb server yet.',
    )
    expect(within(section).getByText(/^curl -fsSL /)).toBeInTheDocument()
    expect(section).toHaveTextContent('Then reload this page.')
  })

  it('pairs from the card when the helper runs unpaired', () => {
    const pair = vi.fn()
    render(
      <Gate
        browser={browserChecks(ENV)}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={helper('unpaired')}
        helperOn={{ pair }}
      />,
    )
    expect(screen.getByText('Pair this page')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pair…' }))
    expect(pair).toHaveBeenCalledTimes(1)
  })
})

describe('Gate, one platform at a time', () => {
  const props = {
    browser: browserChecks(ENV),
    phone: phoneChecks(NO_PHONE),
    wiring: { on: {} },
    helper: OFF,
    onWifi: () => undefined,
  }
  const radio = (name: RegExp) => screen.getByRole('radio', { name })

  it('shows only the chosen platform, and switches on a click', () => {
    const chose = vi.fn()
    render(<Gate {...props} onChoose={chose} />)
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('list', { name: 'Connect your phone' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Network device (Wi‑Fi)…' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Set up the helper' })).toBeNull()
    expect(screen.queryByText('Needs the helper')).toBeNull()

    fireEvent.click(radio(/iPhone & iPad/))
    expect(chose).toHaveBeenCalledWith('ios')
    expect(radio(/iPhone & iPad/)).toHaveAttribute('aria-checked', 'true')
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('list', { name: 'Set up the helper' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Connect your phone' })).toBeNull()
    // Wi‑Fi is Android's, and so is the browser line.
    expect(screen.queryByRole('button', { name: 'Network device (Wi‑Fi)…' })).toBeNull()
    expect(screen.queryByText(/This browser can talk to Android phones/)).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Set up iPhone through the helper',
    ])
  })

  it('keeps the Wi‑Fi path inside the Android card, as a section of it', () => {
    render(<Gate {...props} choice="android" />)
    const region = screen.getByRole('region', { name: 'Set up Android over USB' })
    const wifi = within(region).getByRole('region', { name: /Phone or TV on Wi‑Fi\?/ })
    expect(wifi.tagName).toBe('SECTION')
    expect(wifi).toHaveTextContent('Through the helper')
  })

  it('is a radio group: Tab lands on the chosen tile, arrows move and choose', () => {
    const chose = vi.fn()
    render(<Gate {...props} onChoose={chose} />)
    expect(screen.getByRole('radiogroup', { name: 'Platform' })).toBeInTheDocument()
    const android = radio(/Android/)
    const ios = radio(/iPhone & iPad/)
    expect(android).toHaveAttribute('tabindex', '0')
    expect(ios).toHaveAttribute('tabindex', '-1')
    android.focus()
    fireEvent.keyDown(android, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radio(/iPhone & iPad/))
    expect(radio(/iPhone & iPad/)).toHaveAttribute('aria-checked', 'true')
    expect(radio(/iPhone & iPad/)).toHaveAttribute('tabindex', '0')
    expect(chose).toHaveBeenLastCalledWith('ios')
    // Wraps around, and Home and End go to the ends.
    fireEvent.keyDown(radio(/iPhone & iPad/), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(radio(/Android/))
    fireEvent.keyDown(radio(/Android/), { key: 'End' })
    expect(radio(/iPhone & iPad/)).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio(/iPhone & iPad/), { key: 'Home' })
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(radio(/Android/))
    // Other keys do nothing.
    chose.mockClear()
    fireEvent.keyDown(radio(/Android/), { key: 'a' })
    expect(chose).not.toHaveBeenCalled()
  })

  it('follows the page’s remembered choice over any preset', () => {
    // Pairing in progress presets iOS, but the tester chose Android.
    render(<Gate {...props} helper={helper('unpaired')} choice="android" />)
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Pair this page')).toBeNull()
  })

  it('presets iOS while the helper is being paired, with no choice made', () => {
    render(<Gate {...props} helper={helper('unpaired')} choice={null} />)
    expect(radio(/iPhone & iPad/)).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Pair this page')).toBeInTheDocument()
  })

  it('keeps the platform it preset for the visit, though the helper changes phase', () => {
    const { rerender } = render(<Gate {...props} helper={OFF} choice={null} />)
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
    // A Connect for Android's Wi-Fi path brings the helper up: the page stays on Android.
    rerender(<Gate {...props} helper={helper('unpaired')} choice={null} />)
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
    rerender(<Gate {...props} helper={helper('connected')} choice={null} />)
    expect(radio(/Android/)).toHaveAttribute('aria-checked', 'true')
  })

  it('counts Network device (Wi‑Fi)… as choosing Android', () => {
    const onChoose = vi.fn()
    const onWifi = vi.fn()
    render(<Gate {...props} helper={OFF} choice={null} onChoose={onChoose} onWifi={onWifi} />)
    fireEvent.click(screen.getByRole('button', { name: /Network device/ }))
    expect(onChoose).toHaveBeenCalledWith('android')
    expect(onWifi).toHaveBeenCalledTimes(1)
  })
})

describe('presetPlatform', () => {
  it('knows better on an iPhone, or with the helper in play: iOS', () => {
    expect(presetPlatform({ os: 'ios', webusb: false, helper: OFF })).toBe('ios')
    expect(presetPlatform({ os: 'mac', webusb: true, helper: helper('unpaired') })).toBe('ios')
    expect(presetPlatform({ os: 'mac', webusb: true, helper: helper('stale') })).toBe('ios')
    expect(presetPlatform({ os: 'mac', webusb: true, helper: helper('connected') })).toBe('ios')
    // Connect clicked: the tester wants the helper.
    expect(presetPlatform({ os: 'mac', webusb: true, helper: helper('checking') })).toBe('ios')
  })

  it('a browser that talks USB with no helper: Android', () => {
    expect(presetPlatform({ os: 'mac', webusb: true, helper: OFF })).toBe('android')
    expect(presetPlatform({ os: 'windows', webusb: true, helper: OFF })).toBe('android')
    // The browser looked by itself (no Connect click) and found nothing: still Android.
    const looked = helper('absent', { intent: false })
    expect(presetPlatform({ os: 'mac', webusb: true, helper: looked })).toBe('android')
  })

  it('off a Mac, the helper says nothing about the platform: it serves Android there', () => {
    for (const os of ['windows', 'linux', 'chromeos', 'android'] as const) {
      for (const phase of ['unpaired', 'connected', 'checking'] as const) {
        expect(presetPlatform({ os, webusb: true, helper: helper(phase) })).toBe('android')
        expect(presetPlatform({ os, webusb: false, helper: helper(phase) })).toBe('android')
      }
    }
  })

  it('without WebUSB: iOS on a Mac, Android elsewhere', () => {
    expect(presetPlatform({ os: 'mac', webusb: false, helper: OFF })).toBe('ios')
    expect(presetPlatform({ webusb: false, helper: OFF })).toBe('ios')
    expect(presetPlatform({ os: 'linux', webusb: false, helper: OFF })).toBe('android')
  })
})

describe('the remembered platform', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('is null until chosen, then remembered beside the other prefs', () => {
    window.localStorage.setItem('dvc_prefs', JSON.stringify({ shotZoom: 240 }))
    expect(readGatePlatform()).toBeNull()
    saveGatePlatform('ios')
    expect(readGatePlatform()).toBe('ios')
    expect(JSON.parse(window.localStorage.getItem('dvc_prefs') ?? '{}')).toEqual({
      shotZoom: 240,
      gatePlatform: 'ios',
    })
    saveGatePlatform('android')
    expect(readGatePlatform()).toBe('android')
  })

  it('ignores junk, and blocked storage neither throws nor remembers', () => {
    window.localStorage.setItem('dvc_prefs', JSON.stringify({ gatePlatform: 'windows-phone' }))
    expect(readGatePlatform()).toBeNull()
    window.localStorage.setItem('dvc_prefs', '{not json')
    expect(readGatePlatform()).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => {
      saveGatePlatform('ios')
    }).not.toThrow()
    expect(readGatePlatform()).toBeNull()
  })
})
