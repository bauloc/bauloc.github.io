// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserChecks, GATE_STEPS, phoneChecks } from '../preflight/checks'
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
    render(<Gate browser={browserChecks(ENV)} phone={phoneChecks(NO_PHONE)} wiring={{ on: {} }} />)
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

  it('lists Blocking browser rows first, before the steps, and keeps OK ones out of the way', () => {
    render(
      <Gate
        browser={browserChecks({ ...ENV, secure: false, https: false, appUpdated: true })}
        phone={phoneChecks(NO_PHONE)}
        wiring={{ on: {} }}
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
    render(<Gate browser={browserChecks(ENV)} phone={phoneChecks(NO_PHONE)} wiring={{ on: {} }} />)
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
      />,
    )
    expect(screen.getByText('Pixel 9 is plugged in, but USB debugging is off.')).toBeInTheDocument()
    expect(screen.getAllByText('Blocking')).toHaveLength(1)
  })
})
