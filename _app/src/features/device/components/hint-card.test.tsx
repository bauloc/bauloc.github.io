// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hintFor, normalizeDevice, type Device, type DeviceState, type Hint } from '../model'
import { phoneChecks } from '../preflight/checks'
import { USB_ACCESS_DENIED, type CheckItem, type Os, type PhoneInput } from '../preflight/types'
import { HintCard, deviceCheck, hintContent } from './hint-card'

function device(state: DeviceState, blockers: string[]): Device {
  return normalizeDevice({ id: 'serial-1', backend: 'webusb', name: 'Pixel 9', state, blockers })
}

function phone(d: Device, os: Os = 'mac', more: Partial<PhoneInput> = {}): CheckItem[] {
  return phoneChecks({
    device: { name: d.name, state: d.state, blockers: d.blockers },
    picker: 'picked',
    usb: { kind: 'unknown' },
    authorizingSince: null,
    now: 0,
    os,
    browser: 'chrome',
    otherTab: false,
    holder: null,
    ...more,
  })
}

function hintOf(d: Device): Hint {
  const hint = hintFor(d)
  if (!hint) throw new Error(`no hint for ${d.blockers.join(',')}`)
  return hint
}

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('deviceCheck', () => {
  it('leaves a plain “held by adb” to the hint and its wording', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    expect(deviceCheck(d, phone(d))).toBeNull()
    expect(deviceCheck(d, phone(d, 'linux'))).toBeNull()
  })

  it('takes Windows’ held row, which adds the maker’s driver the hint doesn’t know', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    expect(deviceCheck(d, phone(d, 'windows'))?.sentence).toMatch(
      /phone maker’s USB driver probably owns the phone’s ADB interface/,
    )
  })

  it('names the holder when another tab answered, or the helper knows the process', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    expect(deviceCheck(d, phone(d, 'mac', { otherTab: true }))?.sentence).toBe(
      'Another Device Lab tab in this browser has Pixel 9.',
    )
    expect(
      deviceCheck(d, phone(d, 'mac', { holder: { pid: 4242, process: 'adb' } }))?.sentence,
    ).toBe('The adb server (pid 4242) has Pixel 9.')
  })

  it('takes the system’s refusal on Linux over “another program”', () => {
    const d = device('held', ['WEBUSB_CLAIM_FAILED'])
    expect(deviceCheck(d, phone(d, 'linux'))?.id).toBe('phone.osAccess')
    expect(deviceCheck(d, phone(d, 'mac'))).toBeNull()
    const denied = device('offline', [USB_ACCESS_DENIED])
    expect(deviceCheck(denied, phone(denied, 'windows'))?.id).toBe('phone.osAccess')
  })

  it('has nothing to add for a phone that is not held', () => {
    const d = device('unauthorized', ['ANDROID_UNAUTHORIZED'])
    expect(deviceCheck(d, phone(d))).toBeNull()
  })
})

describe('hintContent', () => {
  it('is the hint as it was when no phone row knows more', () => {
    const hint = hintOf(device('held', ['ADB_SERVER_HOLDING']))
    expect(hintContent(hint, null)).toEqual({
      title: hint.title,
      body: hint.body,
      fixes: hint.fixes,
      extra: hint.extra,
    })
    expect(hintContent(null, null)).toBeNull()
  })

  it('takes a phone row’s sentence, fixes and detail, under a title that fits it', () => {
    const d = device('held', ['WEBUSB_CLAIM_FAILED'])
    const check = deviceCheck(d, phone(d, 'linux'))
    const content = hintContent(hintOf(d), check)
    expect(content?.title).toBe('This computer won’t let the browser open the phone')
    expect(content?.body).toMatch(/^Linux must allow the browser to open the phone/)
    expect(content?.fixes.map((f) => f.label)).toEqual([
      'Copy udev rules: Debian/Ubuntu',
      'Copy udev rules: Fedora',
      'Copy udev rules: Arch',
      'Copy the plugdev command',
      'Copy the snap Chromium command',
      'Reconnect',
    ])
    expect(content?.extra).toMatch(/^On Debian or Ubuntu, also run the plugdev command/)
  })
})

describe('HintCard', () => {
  it('copies a command, and Reconnect retries with a spinner while it runs', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    const onRetry = vi.fn(() => Promise.resolve())
    const { rerender } = render(
      <HintCard
        device={d}
        hint={hintOf(d)}
        retrying={false}
        onRetry={onRetry}
        onDoctor={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy “adb kill-server”' }))
    expect(writeText).toHaveBeenCalledWith('adb kill-server')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<HintCard device={d} hint={hintOf(d)} retrying onRetry={onRetry} onDoctor={vi.fn()} />)
    const busy = screen.getByRole('button', { name: 'Reconnecting…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('opens the environment check for a doctor fix', () => {
    const d = device('unknown', ['TOOL_MISSING'])
    const onDoctor = vi.fn()
    render(
      <HintCard
        device={d}
        hint={hintOf(d)}
        retrying={false}
        onRetry={() => Promise.resolve()}
        onDoctor={onDoctor}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open check' }))
    expect(onDoctor).toHaveBeenCalledTimes(1)
  })

  it('offers “Ask the other tab to let go” only when the page can do it', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    const check = deviceCheck(d, phone(d, 'mac', { otherTab: true }))
    const props = {
      device: d,
      hint: hintOf(d),
      check,
      retrying: false,
      onRetry: () => Promise.resolve(),
      onDoctor: vi.fn(),
    }
    const { rerender } = render(<HintCard {...props} />)
    expect(
      screen.getByRole('heading', { name: 'Something else is using this phone' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Another Device Lab tab in this browser has Pixel 9.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ask the other tab to let go' })).toBeNull()

    const release = vi.fn()
    rerender(<HintCard {...props} wiring={{ on: { 'release-other-tab': release } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask the other tab to let go' }))
    expect(release).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
  })

  it('keeps Reconnect and adb kill-server on the Windows card the system refused', () => {
    const d = device('held', [USB_ACCESS_DENIED])
    const onRetry = vi.fn(() => Promise.resolve())
    render(
      <HintCard
        device={d}
        hint={hintOf(d)}
        check={deviceCheck(d, phone(d, 'windows'))}
        retrying={false}
        onRetry={onRetry}
        onDoctor={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'This computer won’t let the browser open the phone' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy “adb kill-server”' }))
    expect(writeText).toHaveBeenCalledWith('adb kill-server')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/^Device Manager → the phone’s “ADB Interface”/)).toBeInTheDocument()
  })

  it('names both causes on Windows when the claim fails, with both ways out', () => {
    const d = device('held', ['ADB_SERVER_HOLDING'])
    const onRetry = vi.fn(() => Promise.resolve())
    render(
      <HintCard
        device={d}
        hint={hintOf(d)}
        check={deviceCheck(d, phone(d, 'windows'))}
        retrying={false}
        onRetry={onRetry}
        onDoctor={vi.fn()}
      />,
    )
    expect(screen.getByText(/Google’s adb server .* phone maker’s USB driver/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy “adb kill-server”' }))
    expect(writeText).toHaveBeenCalledWith('adb kill-server')
    expect(screen.getByText('Switch the ADB interface to WinUSB:')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get Google’s USB driver/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders links and settings paths', () => {
    const d = device('held', ['WEBUSB_CLAIM_FAILED'])
    const check: CheckItem = {
      id: 'phone.osAccess',
      group: 'phone',
      label: 'System access to USB',
      status: 'blocking',
      sentence: 'A driver blocks the browser.',
      fixes: [
        {
          label: 'Get Google’s USB driver',
          href: 'https://developer.android.com/studio/run/win-usb',
        },
        { label: 'Revoke authorizations', path: 'Settings → System → Developer options' },
      ],
    }
    render(
      <HintCard
        device={d}
        hint={hintOf(d)}
        check={check}
        retrying={false}
        onRetry={() => Promise.resolve()}
        onDoctor={vi.fn()}
      />,
    )
    expect(screen.getByRole('link', { name: /Get Google’s USB driver/ })).toHaveAttribute(
      'href',
      'https://developer.android.com/studio/run/win-usb',
    )
    expect(screen.getByText('Settings → System → Developer options')).toBeInTheDocument()
  })

  it('renders nothing with neither a hint nor a row', () => {
    const { container } = render(
      <HintCard
        device={device('ready', [])}
        hint={null}
        retrying={false}
        onRetry={() => Promise.resolve()}
        onDoctor={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
