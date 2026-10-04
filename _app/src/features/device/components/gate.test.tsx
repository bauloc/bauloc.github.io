// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HelperPhase, HelperStatus } from '../helper/connection'
import type { DoctorReport, Health, Lanes } from '../helper/protocol'
import { DOWNLOAD_COMMAND } from '../helper/status'
import {
  browserChecks,
  GATE_STEPS,
  gateChecks,
  helperChecks,
  phoneChecks,
} from '../preflight/checks'
import type { BrowserEnv, PhoneInput } from '../preflight/types'
import { Gate, gateSteps } from './gate'

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

describe('gateSteps', () => {
  it('takes the phone steps in GATE_STEPS order and leaves the other rows out', () => {
    const steps = gateSteps(phoneChecks({ ...NO_PHONE, os: 'linux' }))
    expect(steps.map((s) => s.id)).toEqual(GATE_STEPS)
  })
})

describe('Gate', () => {
  it('numbers the four phone steps, and a step not checked yet has no status word', () => {
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
      'Step 1: USB debugging',
      'Step 2: Data cable',
      'Step 3: Phone allowed in the browser',
      'Step 4: Allowed on the phone',
    ])
    const list = screen.getByRole('list', { name: 'Connect your phone' })
    // Step 3 is a warning (nothing allowed yet); the others are neutral.
    expect(within(list).getAllByText('Warning')).toHaveLength(1)
    expect(within(list).queryByText('Not checked')).toBeNull()
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
    const section = screen.getByRole('region', { name: 'Over Wi‑Fi' })
    expect(section).toHaveTextContent('A TV or phone across the room?')
    fireEvent.click(within(section).getByRole('button', { name: 'Network device (Wi‑Fi)…' }))
    expect(wifi).toHaveBeenCalledTimes(1)
    cleanup()
    render(
      <Gate browser={browserChecks(ENV)} phone={phoneChecks(NO_PHONE)} wiring={{}} helper={OFF} />,
    )
    expect(screen.queryByRole('region', { name: 'Over Wi‑Fi' })).toBeNull()
  })

  it('lists Blocking browser rows first, before the steps, and keeps OK ones out of the way', () => {
    render(
      <Gate
        browser={browserChecks({ ...ENV, secure: false, https: false, appUpdated: true })}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
        helper={OFF}
      />,
    )
    expect(headings().slice(1, 5)).toEqual([
      'Secure page',
      'Device Lab version',
      'WebUSB',
      'Step 1: USB debugging',
    ])
    expect(screen.getAllByText('Blocking')).toHaveLength(2)
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
    expect(
      screen.getByRole('heading', { level: 1, name: 'Android is ready. iOS needs a helper.' }),
    ).toBeInTheDocument()
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
      />,
    )
    const button = screen.getByRole('button', { name: 'Add device' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(/This browser can’t talk to USB devices/)
    fireEvent.click(button)
    expect(add).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: 'Device Lab' })).toBeInTheDocument()
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
    // Nobody asked for the helper yet: no checklist card.
    expect(screen.queryByText('Checklist')).toBeNull()
    expect(screen.getByText(/the helper needs macOS and Node 18 or newer, plus Xcode/)).toBeTruthy()
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
      />,
    )
    expect(screen.getByText('iPhones need a Mac')).toBeInTheDocument()
    expect(screen.queryByText(DOWNLOAD_COMMAND)).toBeNull()
    expect(screen.queryByText(/Run this in Terminal on this Mac/)).toBeNull()
  })

  it('says “Plug in a phone.” once connected, and lists the checklist under the cards', () => {
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
    expect(screen.getByRole('heading', { level: 1, name: 'Plug in a phone.' })).toBeTruthy()
    expect(screen.getByText('Ready for iPhones')).toBeInTheDocument()
    expect(screen.getByText('1 needs attention · 5 passed')).toBeInTheDocument()
    const attention = screen.getByRole('list', { name: 'Needs attention' })
    expect(within(attention).getByText('Xcode')).toBeInTheDocument()
    expect(within(attention).getByRole('link', { name: /Get Xcode/ })).toHaveAttribute(
      'href',
      'https://apps.apple.com/app/xcode/id497799835',
    )
    // What passed folds away behind one line.
    const passed = screen.getByText('Show 5 passed checks').closest('details')
    expect(passed).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(recheck).toHaveBeenCalledTimes(1)
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
