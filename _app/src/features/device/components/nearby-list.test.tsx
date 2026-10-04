// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HelperStatus } from '../helper/connection'
import type { NearbyDevice } from '../helper/protocol'
import { nearbyRows, type NearbySnapshot } from '../nearby'
import { HEALTH, helperStatus } from './helper-status.fixture'
import { NearbySection, nearbyAnnouncement } from './nearby-list'

/*
  "On this network" as the tester sees it: one quiet line without the helper, the update
  command for a helper too old to look, Looking…, the empty state with how to turn debugging
  on, the blocked state with both ways out, and one action per found device.
*/

afterEach(() => {
  cleanup()
})

const READY = helperStatus('connected', {
  health: { ...HEALTH, features: ['android.connect', 'android.discover'] },
})

const TV: NearbyDevice = {
  id: 'adb:192.168.68.101:5555',
  kind: 'adb',
  host: '192.168.68.101',
  port: 5555,
  instance: 'adb-b120be004010859',
  serial: 'b120be004010859',
  name: 'SONY KD-43X8050H',
  model: '',
  tv: true,
  connected: false,
  deviceId: null,
  paired: false,
}
const PIXEL: NearbyDevice = {
  id: 'wireless:192.168.68.114:39601',
  kind: 'wireless',
  host: '192.168.68.114',
  port: 39601,
  instance: 'adb-55090DLAQ0026D-nK25Qn',
  serial: '55090DLAQ0026D',
  name: '',
  model: '',
  tv: false,
  connected: false,
  deviceId: null,
  paired: false,
}

const snap = (patch: Partial<NearbySnapshot> = {}): NearbySnapshot => ({
  state: 'ok',
  devices: [],
  busy: false,
  at: 1,
  ...patch,
})

function show(
  opts: {
    status?: HelperStatus
    snapshot?: NearbySnapshot
    connecting?: string | null
    refresh?: () => Promise<void>
  } = {},
) {
  const snapshot = opts.snapshot ?? snap()
  const calls = {
    release: vi.fn(),
    watch: vi.fn(() => calls.release),
    refresh: vi.fn(opts.refresh ?? (() => Promise.resolve())),
    connect: vi.fn(),
    pair: vi.fn(),
    helper: vi.fn(),
  }
  const view = render(
    <NearbySection
      status={opts.status ?? READY}
      snapshot={snapshot}
      rows={nearbyRows(snapshot.devices, [])}
      connecting={opts.connecting ?? null}
      onWatch={calls.watch}
      onRefresh={calls.refresh}
      onConnect={calls.connect}
      onPair={calls.pair}
      onHelper={calls.helper}
    />,
  )
  return { calls, view, section: screen.getByRole('region', { name: 'On this network' }) }
}

describe('NearbySection', () => {
  it('without the helper: one line pointing at its setup, and it never looks', () => {
    const { calls, section } = show({ status: helperStatus('absent') })
    expect(section).toHaveTextContent(
      'To list the TVs and phones on this network, start the local helper and pair this page.',
    )
    expect(within(section).queryByRole('button', { name: /look again/i })).toBeNull()
    fireEvent.click(within(section).getByRole('button', { name: 'Set up the helper' }))
    expect(calls.helper).toHaveBeenCalledOnce()
    expect(calls.watch).not.toHaveBeenCalled()
    // Running but not paired with this page: still the helper's setup.
    cleanup()
    expect(show({ status: helperStatus('unpaired') }).calls.watch).not.toHaveBeenCalled()
  })

  it('a helper too old to look: the command that replaces it, and no looking', () => {
    const { calls, section } = show({ status: helperStatus('connected') })
    expect(section).toHaveTextContent('This helper can’t look for devices on the network.')
    expect(section).toHaveTextContent('curl -fsSL')
    expect(calls.watch).not.toHaveBeenCalled()
  })

  it('looks while it shows, and stops when it goes', () => {
    const { calls, view } = show({ snapshot: snap({ state: 'looking', busy: true, at: null }) })
    expect(calls.watch).toHaveBeenCalledOnce()
    expect(screen.getByText('Looking…')).toBeInTheDocument()
    view.unmount()
    expect(calls.release).toHaveBeenCalledOnce()
  })

  it('found nothing: how to turn debugging on, for a TV and for a phone', () => {
    const { section } = show()
    expect(section).toHaveTextContent('No Android device on this network has debugging turned on.')
    expect(section).toHaveTextContent('Android TV:')
    expect(section).toHaveTextContent('Network debugging')
    expect(section).toHaveTextContent('Phone:')
    expect(section).toHaveTextContent('Wireless debugging → On (Android 11 or newer)')
    expect(section).toHaveTextContent(
      'Already on? Check that the device is on the same Wi‑Fi as this computer, and that no VPN',
    )
  })

  it('everything heard is connected already: says so, not that nothing has debugging on', () => {
    const snapshot = snap({ devices: [{ ...TV, connected: true }] })
    const { section } = show({ snapshot })
    expect(section).toHaveTextContent('Every device found on this network is connected.')
    expect(section).not.toHaveTextContent('has debugging turned on')
    expect(nearbyAnnouncement(snapshot, [])).toBe(
      'Every device found on this network is connected.',
    )
  })

  it('one row per device: name, address, kind, and Connect or Pair…', () => {
    const { calls, section } = show({ snapshot: snap({ devices: [TV, PIXEL] }) })
    const items = within(section).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('55090DLAQ0026D')
    expect(items[0]).toHaveTextContent('192.168.68.114:39601')
    expect(items[0]).toHaveTextContent('Wireless debugging')
    expect(items[1]).toHaveTextContent('SONY KD-43X8050H')
    expect(items[1]).toHaveTextContent('192.168.68.101:5555')
    expect(items[1]).toHaveTextContent('Network debugging')

    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Connect SONY KD-43X8050H (192.168.68.101:5555)',
      }),
    )
    expect(calls.connect).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SONY KD-43X8050H' }),
    )
    fireEvent.click(
      within(section).getByRole('button', { name: 'Pair 55090DLAQ0026D (192.168.68.114:39601)…' }),
    )
    expect(calls.pair).toHaveBeenCalledWith(expect.objectContaining({ name: '55090DLAQ0026D' }))
  })

  it('a connect running: that row says so, and no other Connect starts', () => {
    const other = {
      ...TV,
      id: 'adb:192.168.68.120:5555',
      host: '192.168.68.120',
      serial: 'x1234',
      name: 'Den TV',
    }
    const devices = [TV, other]
    const key = nearbyRows(devices, []).find((r) => r.name === 'SONY KD-43X8050H')?.key ?? ''
    const { calls, section } = show({ snapshot: snap({ devices }), connecting: key })
    expect(within(section).getByRole('button', { name: /Connect SONY/ })).toHaveTextContent(
      'Connecting…',
    )
    const den = within(section).getByRole('button', { name: /Connect Den TV/ })
    expect(den).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(den)
    expect(calls.connect).not.toHaveBeenCalled()
  })

  it('blocked: this computer’s doing, with the VPN and macOS ways out and the command', () => {
    const { section } = show({
      snapshot: snap({ state: 'blocked', detail: 'send EHOSTUNREACH 224.0.0.251:5353' }),
    })
    expect(section).toHaveTextContent('This computer reaches the local network')
    expect(section).toHaveTextContent('Blocking')
    expect(section).toHaveTextContent(
      'This computer can’t reach the local network, so it can’t look for devices on it. The problem is on this computer, not the TV or phone.',
    )
    expect(section).toHaveTextContent('Turn off the VPN (Cloudflare WARP, a work VPN)')
    expect(section).toHaveTextContent('start it again from the Terminal app')
    expect(section).toHaveTextContent('node ~/device-bridge.mjs')
    expect(section).toHaveTextContent('send EHOSTUNREACH 224.0.0.251:5353')
    // Not the empty state: nothing is known about the devices.
    expect(section).not.toHaveTextContent('has debugging turned on')
  })

  it.each(['blocked', 'failed'] as const)(
    '%s, with only what adb lists already connected: no claim that a look found them all',
    (state) => {
      const { section } = show({
        snapshot: snap({
          state,
          devices: [{ ...TV, connected: true, deviceId: '192.168.68.101:5555' }],
          message: state === 'failed' ? 'Could not look for devices on the network.' : undefined,
          detail: 'send EHOSTUNREACH 224.0.0.251:5353',
        }),
      })
      expect(section).not.toHaveTextContent('Every device found on this network is connected.')
      expect(section).not.toHaveTextContent('has debugging turned on')
      expect(section).toHaveTextContent(
        state === 'blocked'
          ? 'This computer reaches the local network'
          : 'Could not look for devices on the network.',
      )
    },
  )

  it('Refresh looks again, turns while it runs, and says how it ended', async () => {
    let finish: () => void = () => undefined
    const { calls, section } = show({
      snapshot: snap({ devices: [TV] }),
      refresh: () =>
        new Promise<void>((r) => {
          finish = r
        }),
    })
    const button = within(section).getByRole('button', {
      name: 'Look again for devices on this network',
    })
    fireEvent.click(button)
    expect(calls.refresh).toHaveBeenCalledOnce()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(calls.refresh).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('1 device found on this network.')
    })
  })

  it('words each ending for the live region', () => {
    const tv = nearbyRows([TV], [])
    expect(nearbyAnnouncement(snap(), [])).toBe('No devices found on this network.')
    expect(nearbyAnnouncement(snap(), [...tv, ...tv])).toBe('2 devices found on this network.')
    expect(nearbyAnnouncement(snap({ state: 'blocked' }), tv)).toMatch(/^This computer can’t/)
    expect(nearbyAnnouncement(snap({ state: 'failed', message: 'No network.' }), [])).toBe(
      'No network.',
    )
  })
})
