// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { HelperStatus } from '../helper/connection'
import type { Lanes } from '../helper/protocol'
import { normalizeDevice, type Device } from '../model'
import type { WifiAttempt } from '../preflight/types'
import type { WifiSnapshot } from '../wifi'
import { AddDeviceMenu } from './device-list'
import { HEALTH, LANES, helperStatus } from './helper-status.fixture'
import { WifiDialog, wifiAnnouncement } from './wifi-dialog'

/*
  The Wi‑Fi dialog: the helper card in place of the form until the helper can connect, the
  adb server's Start button, the form's own checks, then the progress rows of a connect.
*/

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
})

const READY = helperStatus('connected', {
  health: { ...HEALTH, features: ['android.start-server', 'android.connect'] },
})
const EMPTY: WifiSnapshot = { attempt: null, recent: [], disconnecting: null }

const tv = (patch: Partial<Device> = {}): Device =>
  normalizeDevice({
    id: '192.168.1.42:5555',
    backend: 'agent',
    platform: 'android',
    connection: 'network',
    state: 'ready',
    name: 'Living Room TV',
    ...patch,
  })

function show(
  opts: {
    status?: HelperStatus
    wifi?: Partial<WifiSnapshot>
    devices?: Device[]
    wiring?: Parameters<typeof WifiDialog>[0]['wiring']
    os?: Parameters<typeof WifiDialog>[0]['os']
  } = {},
) {
  const calls = {
    connect: vi.fn(() => Promise.resolve(null)),
    pair: vi.fn(() => Promise.resolve(true)),
    disconnect: vi.fn(),
    forget: vi.fn(),
    show: vi.fn(),
    connectHelper: vi.fn(),
    pairHelper: vi.fn(),
  }
  render(
    <WifiDialog
      open
      onOpenChange={() => undefined}
      status={opts.status ?? READY}
      helperOn={{ connect: calls.connectHelper, pair: calls.pairHelper }}
      wiring={opts.wiring ?? {}}
      wifi={{ ...EMPTY, ...opts.wifi }}
      devices={opts.devices ?? []}
      onConnect={calls.connect}
      onPair={calls.pair}
      onDisconnect={calls.disconnect}
      onForget={calls.forget}
      onShow={calls.show}
      os={opts.os}
    />,
  )
  return calls
}

const dialog = () => screen.getByRole('dialog')

describe('WifiDialog', () => {
  it('shows how to start and pair the helper instead of the form while there is none', () => {
    const calls = show({ status: helperStatus('absent') })
    expect(within(dialog()).queryByLabelText('IP address')).toBeNull()
    expect(dialog()).toHaveTextContent('Browsers can’t open network connections to a TV')
    // The helper card's words, without its case for iPhones.
    expect(dialog()).not.toHaveTextContent('macOS keeps the iPhone’s USB connection')
    expect(dialog()).toHaveTextContent('curl -fsSL')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect helper' }))
    expect(calls.connectHelper).toHaveBeenCalled()
  })

  it('on Windows, says where to type the command and how to get Node.js there', () => {
    show({ status: helperStatus('absent'), os: 'windows' })
    expect(dialog()).toHaveTextContent('Run this in a terminal:')
    expect(dialog()).not.toHaveTextContent('on this Mac')
    expect(dialog()).toHaveTextContent('winget install OpenJS.NodeJS.LTS')
    expect(dialog()).not.toHaveTextContent('brew install node')
  })

  it('offers Pair… while the page isn’t paired', () => {
    const calls = show({ status: helperStatus('unpaired') })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Pair…' }))
    expect(calls.pairHelper).toHaveBeenCalled()
  })

  it('says a helper without Wi‑Fi must be downloaded again', () => {
    show({ status: helperStatus('connected') })
    expect(within(dialog()).queryByLabelText('IP address')).toBeNull()
    expect(dialog()).toHaveTextContent(
      'This helper can’t connect to Wi‑Fi devices. Download it again; the command replaces it.',
    )
  })

  it('offers Start adb server while the server is stopped', () => {
    const start = vi.fn()
    const lanes: Lanes = {
      ...LANES,
      android: { status: 'stopped', adb: 'found', startedByHelper: false },
    }
    show({ status: { ...READY, lanes }, wiring: { on: { 'start-adb': start } } })
    expect(within(dialog()).queryByLabelText('IP address')).toBeNull()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start adb server' }))
    expect(start).toHaveBeenCalled()
  })

  it('checks the address before sending anything, and says why in plain words', () => {
    const calls = show()
    const host = within(dialog()).getByLabelText('IP address')
    fireEvent.change(host, { target: { value: '8.8.8.8' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(calls.connect).not.toHaveBeenCalled()
    expect(host).toHaveAttribute('aria-invalid', 'true')
    expect(host).toHaveAccessibleDescription(
      'Only devices on your local network: an address that starts with 192.168., 10., 172.16–31., 169.254. or 100.64–127.',
    )
    expect(host).toHaveFocus()
    fireEvent.change(host, { target: { value: '192.168.1.42' } })
    const port = within(dialog()).getByLabelText('Port')
    fireEvent.change(port, { target: { value: '99999' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(port).toHaveAccessibleDescription('The port is a number from 1 to 65535.')
    expect(calls.connect).not.toHaveBeenCalled()
  })

  it('connects on 5555 by default, or on the port pasted with the address', () => {
    const calls = show()
    const host = within(dialog()).getByLabelText('IP address')
    fireEvent.change(host, { target: { value: ' 192.168.1.42 ' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(calls.connect).toHaveBeenLastCalledWith({ host: '192.168.1.42', port: 5555 })
    fireEvent.change(host, { target: { value: '192.168.1.42:41235' } })
    fireEvent.change(within(dialog()).getByLabelText('Port'), { target: { value: '' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(calls.connect).toHaveBeenLastCalledWith({ host: '192.168.1.42', port: 41235 })
  })

  it('shows the progress of a connect: waiting for Allow on the TV, then Show it', () => {
    const attempt: WifiAttempt = {
      kind: 'connect',
      host: '192.168.1.42',
      port: 5555,
      state: 'ok',
      serial: '192.168.1.42:5555',
    }
    show({
      wifi: { attempt },
      devices: [tv({ state: 'unauthorized', name: '', blockers: ['ANDROID_UNAUTHORIZED'] })],
    })
    const progress = within(dialog()).getByRole('list', { name: 'Progress' })
    expect(progress).toHaveTextContent('192.168.1.42:5555 answered.')
    expect(progress).toHaveTextContent(
      '192.168.1.42:5555 is waiting for you to choose Allow on “Allow debugging?”.',
    )
    expect(progress).toHaveTextContent('with the remote')
    expect(within(dialog()).queryByRole('button', { name: /^Show / })).toBeNull()
    cleanup()
    const calls = show({ wifi: { attempt }, devices: [tv()] })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Show Living Room TV' }))
    expect(calls.show).toHaveBeenCalledWith('192.168.1.42:5555')
  })

  it('says why a connect failed, with the fix and adb’s words', () => {
    show({
      wifi: {
        attempt: {
          kind: 'connect',
          host: '192.168.1.42',
          port: 5556,
          state: 'failed',
          code: 'ANDROID_CONNECT_FAILED',
          reason: 'refused',
          detail: "failed to connect to '192.168.1.42:5556': Connection refused",
        },
      },
    })
    const progress = within(dialog()).getByRole('list', { name: 'Progress' })
    expect(progress).toHaveTextContent(
      '192.168.1.42 answered, but nothing accepts debugging on port 5556.',
    )
    expect(progress).toHaveTextContent('adb said: “failed to connect to')
    expect(progress).toHaveTextContent('Network debugging')
  })

  it('says this computer blocked a connect, not the TV, with both ways out', () => {
    show({
      wifi: {
        attempt: {
          kind: 'connect',
          host: '192.168.1.42',
          port: 5555,
          state: 'failed',
          code: 'ANDROID_CONNECT_FAILED',
          reason: 'blocked',
          detail: "failed to connect to '192.168.1.42:5555': No route to host",
        },
      },
    })
    const progress = within(dialog()).getByRole('list', { name: 'Progress' })
    const [local, reach] = within(progress).getAllByRole('listitem')
    expect(local).toHaveTextContent('This computer reaches the local network')
    expect(local).toHaveTextContent(
      'This computer blocked the connection to 192.168.1.42:5555, so the device never saw it. The problem is on this computer, not the TV or phone.',
    )
    expect(local).toHaveTextContent('Turn off the VPN')
    expect(local).toHaveTextContent('start it again from the Terminal app')
    expect(local).toHaveTextContent('adb said: “failed to connect to')
    expect(reach).toHaveTextContent('Checked once this computer can reach the local network.')
    // Said once, as the thing to fix.
    const live = within(dialog())
      .getAllByRole('status')
      .find((el) => el.getAttribute('aria-live') === 'polite')
    expect(live).toHaveTextContent('This computer blocked the connection to 192.168.1.42:5555')
  })

  it('says Connecting… while a connect runs, and ignores a second click', () => {
    const calls = show({
      wifi: { attempt: { kind: 'connect', host: '192.168.1.42', port: 5555, state: 'running' } },
    })
    const button = within(dialog()).getByRole('button', { name: 'Connecting…' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(within(dialog()).getByLabelText('IP address'), {
      target: { value: '192.168.1.42' },
    })
    fireEvent.click(button)
    expect(calls.connect).not.toHaveBeenCalled()
  })

  it('pairs with the code, then moves on to the connect port', async () => {
    const calls = show()
    fireEvent.change(within(dialog()).getByLabelText('IP address & port'), {
      target: { value: '192.168.1.42' },
    })
    fireEvent.change(within(dialog()).getByLabelText('Pairing code'), {
      target: { value: '48291' },
    })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Pair' }))
    expect(calls.pair).not.toHaveBeenCalled()
    expect(within(dialog()).getByLabelText('IP address & port')).toHaveAccessibleDescription(
      'Enter the port the Wireless debugging screen shows.',
    )
    expect(within(dialog()).getByLabelText('Pairing code')).toHaveAccessibleDescription(
      'The pairing code is six digits.',
    )
    fireEvent.change(within(dialog()).getByLabelText('IP address & port'), {
      target: { value: '192.168.1.42:37099' },
    })
    fireEvent.change(within(dialog()).getByLabelText('Pairing code'), {
      target: { value: '482 913' },
    })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Pair' }))
    expect(calls.pair).toHaveBeenCalledWith({ host: '192.168.1.42', port: 37099, code: '482913' })
    await waitFor(() => {
      expect(within(dialog()).getByLabelText('Port')).toHaveFocus()
    })
    expect(within(dialog()).getByLabelText('IP address')).toHaveValue('192.168.1.42')
    expect(within(dialog()).getByLabelText('Pairing code')).toHaveValue('')
    // The connect port is the device's own now: no guessing 5555.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(calls.connect).not.toHaveBeenCalled()
    expect(within(dialog()).getByLabelText('Port')).toHaveAccessibleDescription(
      'Enter the port the Wireless debugging screen shows.',
    )
    fireEvent.change(within(dialog()).getByLabelText('Port'), { target: { value: '41235' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect' }))
    expect(calls.connect).toHaveBeenCalledWith({ host: '192.168.1.42', port: 41235 })
  })

  it('reconnects a remembered device in one click, disconnects a listed one, forgets', () => {
    const recent = [
      { host: '192.168.1.42', port: 5555, name: 'Living Room TV', at: 2 },
      { host: '192.168.1.50', port: 5555, name: '', at: 1 },
    ]
    const calls = show({ wifi: { recent }, devices: [tv()] })
    fireEvent.click(
      within(dialog()).getByRole('button', {
        name: 'Disconnect Living Room TV · 192.168.1.42:5555',
      }),
    )
    expect(calls.disconnect).toHaveBeenCalledWith('192.168.1.42:5555')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect 192.168.1.50:5555' }))
    expect(calls.connect).toHaveBeenCalledWith({ host: '192.168.1.50', port: 5555 })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Forget 192.168.1.50:5555' }))
    expect(calls.forget).toHaveBeenCalledWith({ host: '192.168.1.50', port: 5555 })
  })
})

describe('wifiAnnouncement', () => {
  it('speaks the row that changed last, and nothing before an attempt', () => {
    const rows = [
      { id: 'wifi.reachable', group: 'wifi', label: 'r', status: 'ok', sentence: 'Answered.' },
      {
        id: 'wifi.authorized',
        group: 'wifi',
        label: 'a',
        status: 'blocking',
        sentence: 'Allow it.',
      },
    ] as const
    expect(wifiAnnouncement(rows, null)).toBe('')
    expect(wifiAnnouncement(rows, 'running')).toBe('Answered.')
    expect(wifiAnnouncement(rows, 'ok')).toBe('Allow it.')
  })
})

describe('AddDeviceMenu', () => {
  it('offers USB and Wi‑Fi, and says why USB is off without WebUSB', async () => {
    const wifi = vi.fn()
    render(<AddDeviceMenu onAddWifi={wifi} />)
    const trigger = screen.getByRole('button', { name: 'Add a device' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    const usb = await screen.findByRole('menuitem', { name: /USB device/ })
    expect(usb).toHaveAttribute('aria-disabled', 'true')
    expect(usb).toHaveTextContent('Needs Chrome or Edge (WebUSB)')
    fireEvent.click(screen.getByRole('menuitem', { name: /Network device \(Wi‑Fi\)/ }))
    expect(wifi).toHaveBeenCalled()
  })
})
