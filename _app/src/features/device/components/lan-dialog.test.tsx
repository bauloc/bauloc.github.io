// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/lib/locale'

import type { HelperStatus } from '../helper/connection'
import type { LanDevice, LanResult } from '../helper/protocol'
import type { LanSnapshot } from '../lan'
import * as Vendors from '../lan-vendors'
import type { ListedDevice, NearbyRow } from '../nearby'
import { HEALTH, helperStatus, LANES } from './helper-status.fixture'
import { LanDialog } from './lan-dialog'

/*
  "Devices on this network" as the tester sees it: the one line under "On this network", then
  the dialog in each of its states (no helper, an older one, the first look, the list, nothing
  found, blocked, failed), the filter and the search, each row's one action, a row opened, and
  Refresh with what it says when it ends.
*/

vi.mock('../lan-vendors', async (importOriginal) => {
  const actual = await importOriginal<typeof Vendors>()
  return { ...actual, loadVendors: vi.fn(actual.loadVendors) }
})

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(Vendors.loadVendors).mockClear()
  // The default elsewhere; a test that switches to Vietnamese must not leak it.
  setLocale('en')
})

const READY = helperStatus('connected', {
  health: { ...HEALTH, features: ['lan.discover', 'android.connect', 'android.discover'] },
})

const lan = (address: string, patch: Partial<LanDevice> = {}): LanDevice => ({
  address,
  self: false,
  gateway: false,
  hostnames: [],
  names: [],
  services: [],
  found: ['reply'],
  ...patch,
})

// The owner's network (2026-10-04), names made up where they'd identify.
const ROUTER = lan('192.168.68.1', {
  gateway: true,
  upnp: {
    deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    manufacturer: 'TP-Link',
  },
  found: ['reply', 'ssdp', 'gateway'],
})
const TV = lan('192.168.68.101', {
  services: [
    { type: '_androidtvremote2._tcp', port: 6466, name: 'SONY KD-43X8050H' },
    { type: '_googlecast._tcp', port: 8009, txt: { fn: 'Living Room TV', md: 'BRAVIA 4K VH2' } },
  ],
  found: ['reply', 'mdns'],
})
const CAMERA = lan('192.168.68.105', { maker: 'AC1C26' })
const IPHONE = lan('192.168.68.110', {
  hostnames: ['Baus-iPhone-12-Pro.local'],
  services: [{ type: '_apple-mobdev2._tcp', port: 32498 }],
  found: ['reply', 'mdns'],
})
const PRIVATE = lan('192.168.68.112', { privateAddress: true })
const MAC = lan('192.168.68.113', {
  self: true,
  hostnames: ['BAULOCs-MacBook-Pro.local'],
  services: [{ type: '_airplay._tcp', name: 'BAULOC’s MacBook Pro', txt: { model: 'Mac16,1' } }],
  found: ['self', 'mdns'],
})
const PIXEL = lan('192.168.68.114', {
  hostnames: ['Android_GWZJSA15.local'],
  services: [
    {
      type: '_adb-tls-connect._tcp',
      port: 43141,
      name: 'adb-55090DLAQ0026D-nK25Qn',
      txt: { given_name: 'BAULOC Pixel 9', name: 'Pixel 9' },
    },
  ],
  found: ['reply', 'mdns'],
})
const PRINTER = lan('192.168.68.125', {
  hostnames: ['NPI9C4E21.local'],
  services: [
    {
      type: '_ipp._tcp',
      port: 631,
      name: 'HP Neverstop Laser MFP 1200w (9C4E21)',
      txt: { ty: 'HP Neverstop Laser MFP 120x', usb_MFG: 'HP' },
    },
  ],
  found: ['reply', 'mdns'],
})
const NETWORK = [ROUTER, TV, CAMERA, IPHONE, PRIVATE, MAC, PIXEL, PRINTER]

const SCANNED_AT = new Date(2026, 9, 5, 9, 30).getTime()

const result = (devices: LanDevice[] = NETWORK, patch: Partial<LanResult> = {}): LanResult => ({
  devices,
  networks: [{ interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 }],
  sources: { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' },
  scannedAt: SCANNED_AT,
  durationMs: 4_000,
  ...patch,
})

const snap = (patch: Partial<LanSnapshot> = {}): LanSnapshot => ({
  state: 'ok',
  result: result(),
  busy: false,
  at: SCANNED_AT + 4_000,
  ...patch,
})

/** The BRAVIA's "On this network" row: Network debugging, not connected yet. */
const TV_ROW: NearbyRow = {
  key: 'serial:b120be004010859',
  name: 'SONY KD-43X8050H',
  address: '192.168.68.101:5555',
  kind: 'adb',
  tv: true,
  pairingOpen: false,
  action: { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } },
}

function show(
  opts: {
    status?: HelperStatus
    snapshot?: LanSnapshot
    nearby?: readonly NearbyRow[]
    listed?: readonly ListedDevice[]
    connecting?: string | null
    refresh?: () => Promise<void>
  } = {},
) {
  const calls = {
    openChange: vi.fn(),
    look: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(opts.refresh ?? (() => Promise.resolve())),
    helper: vi.fn(),
    connect: vi.fn(),
    pair: vi.fn(),
    wifi: vi.fn(),
    show: vi.fn(),
  }
  const props = (open: boolean, snapshot = opts.snapshot ?? snap()) => (
    <LanDialog
      open={open}
      onOpenChange={calls.openChange}
      status={opts.status ?? READY}
      snapshot={snapshot}
      onLook={calls.look}
      onStop={calls.stop}
      onRefresh={calls.refresh}
      nearby={opts.nearby ?? []}
      listed={opts.listed ?? []}
      connecting={opts.connecting ?? null}
      onHelper={calls.helper}
      onConnect={calls.connect}
      onPair={calls.pair}
      onWifi={calls.wifi}
      onShow={calls.show}
    />
  )
  const view = render(props(true))
  return {
    calls,
    rerender: (open: boolean, snapshot?: LanSnapshot) => {
      view.rerender(props(open, snapshot))
    },
  }
}

const dialog = () => screen.getByRole('dialog', { name: 'Devices on this network' })
const list = () => within(dialog()).getByRole('list', { name: 'Devices on this network' })
const row = (name: string) => {
  const item = within(list())
    .getAllByRole('listitem')
    .find((li) => li.textContent.includes(name))
  if (!item) throw new Error(`no row for ${name}`)
  return item
}

describe('LanDialog, inline (Scan Device)', () => {
  it('is a section of the page: it looks while it shows, keeps Refresh, and has no Close', () => {
    const look = vi.fn()
    const stop = vi.fn()
    const refresh = vi.fn(() => Promise.resolve())
    const { unmount } = render(
      <LanDialog
        inline
        open
        status={READY}
        snapshot={snap()}
        onLook={look}
        onStop={stop}
        onRefresh={refresh}
        nearby={[]}
        listed={[]}
        connecting={null}
        onHelper={vi.fn()}
        onConnect={vi.fn()}
        onPair={vi.fn()}
        onWifi={vi.fn()}
        onShow={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    const section = screen.getByRole('region', { name: 'Devices on this network' })
    expect(section).toHaveAccessibleDescription(/^8 devices on 192\.168\.68\.0\/24 · looked /)
    expect(look).toHaveBeenCalledOnce()
    expect(within(section).getByRole('radiogroup', { name: 'Kind' })).toBeVisible()
    fireEvent.click(within(section).getByRole('button', { name: 'Refresh' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(within(section).queryByRole('button', { name: 'Close' })).toBeNull()
    unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('LanDialog', () => {
  it('without the helper: one line pointing at its setup, and it never looks', () => {
    const { calls } = show({
      status: helperStatus('absent'),
      snapshot: snap({ state: 'idle', result: null }),
    })
    expect(dialog()).toHaveTextContent(
      'To list the devices on this network, start the local helper and pair this page.',
    )
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Set up the helper' }))
    expect(calls.helper).toHaveBeenCalledOnce()
    expect(calls.look).not.toHaveBeenCalled()
    expect(within(dialog()).queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('a helper older than the list: says so with the update command, and never looks', () => {
    const old = helperStatus('connected', {
      health: { ...HEALTH, features: ['android.connect', 'android.discover'] },
    })
    const { calls } = show({ status: old, snapshot: snap({ state: 'idle', result: null }) })
    expect(dialog()).toHaveTextContent('Update the helper')
    expect(dialog()).toHaveTextContent(
      'Your helper is older than this page: it can’t list every device on this network yet. Update it: press Ctrl+C in its window, then run:',
    )
    expect(within(dialog()).getByText(/^curl -fsSL /)).toHaveTextContent(
      'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
    )
    expect(calls.look).not.toHaveBeenCalled()
    cleanup()
    // One that lists the feature but has no such route says the same, whatever was listed before.
    show({ snapshot: snap({ state: 'unsupported', code: 'NOT_FOUND' }) })
    expect(dialog()).toHaveTextContent('it can’t list every device on this network yet')
    expect(within(dialog()).queryByRole('radiogroup')).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('looks when it opens, with a skeleton until the first answer, and stops waiting on close', () => {
    const { calls, rerender } = show({
      snapshot: snap({ state: 'looking', busy: true, result: null }),
    })
    expect(calls.look).toHaveBeenCalledOnce()
    expect(within(dialog()).getByRole('list', { name: 'Looking for devices…' })).toBeVisible()
    expect(dialog()).toHaveTextContent('Every device the helper finds on this computer’s network.')
    expect(within(dialog()).getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    rerender(false)
    expect(calls.stop).toHaveBeenCalledOnce()
  })

  it('lists every device: its kind, name, the line under it, the address and badges', () => {
    vi.spyOn(Date, 'now').mockReturnValue(SCANNED_AT + 5_000)
    show()
    expect(dialog()).toHaveAccessibleDescription('8 devices on 192.168.68.0/24 · looked 5 s ago')
    const items = within(list()).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('button span span')?.textContent)).toEqual([
      'TP-Link router',
      'Living Room TV',
      'Unknown device',
      'Baus iPhone 12 Pro',
      'Unknown device',
      'BAULOC’s MacBook Pro',
      'BAULOC Pixel 9',
      'HP Neverstop Laser MFP 1200w (9C4E21)',
    ])
    expect(row('TP-Link router')).toHaveTextContent('192.168.68.1')
    expect(within(row('TP-Link router')).getByText('Router')).toBeVisible()
    expect(within(row('BAULOC’s MacBook Pro')).getByText('This computer')).toBeVisible()
    expect(row('192.168.68.112')).toHaveTextContent(
      'Private address (likely a phone, tablet or laptop)',
    )
    expect(row('Living Room TV')).toHaveTextContent('BRAVIA 4K VH2')
    // What macOS keeps from the helper, said under the list.
    expect(dialog()).toHaveTextContent(
      'Some device makers aren’t shown: macOS doesn’t share device hardware addresses with the helper.',
    )
  })

  it('loads the vendor table only when a device has a maker, then names it by its maker', async () => {
    show({ snapshot: snap({ result: result([ROUTER, TV]) }) })
    expect(Vendors.loadVendors).not.toHaveBeenCalled()
    cleanup()
    show()
    expect(Vendors.loadVendors).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(row('192.168.68.105')).toHaveTextContent('EZVIZ camera')
    })
  })

  it('filters by kind, with counts, and searches name or address', () => {
    show()
    const kind = within(dialog()).getByRole('radiogroup', { name: 'Kind' })
    const radios = within(kind).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'All, 8',
      'Phones & tablets, 2',
      'TVs, 1',
      'Computers, 1',
      'Other, 4',
    ])
    fireEvent.click(within(kind).getByRole('radio', { name: 'TVs, 1' }))
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1)
    expect(list()).toHaveTextContent('Living Room TV')
    fireEvent.click(within(kind).getByRole('radio', { name: 'All, 8' }))
    const search = within(dialog()).getByRole('searchbox', { name: 'Search devices' })
    expect(search).toHaveAttribute('placeholder', 'Search name or address')
    fireEvent.change(search, { target: { value: '.125' } })
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1)
    expect(list()).toHaveTextContent('HP Neverstop Laser MFP 1200w (9C4E21)')
    fireEvent.change(search, { target: { value: 'pixel' } })
    expect(list()).toHaveTextContent('BAULOC Pixel 9')
    fireEvent.change(search, { target: { value: 'toaster' } })
    expect(dialog()).toHaveTextContent('Nothing matches this filter')
    expect(dialog()).toHaveTextContent('Clear the search, or choose All.')
  })

  it('starts afresh on each opening, however it was closed', () => {
    const { rerender } = show()
    const kind = () => within(dialog()).getByRole('radiogroup', { name: 'Kind' })
    fireEvent.click(within(kind()).getByRole('radio', { name: 'TVs, 1' }))
    fireEvent.change(within(dialog()).getByRole('searchbox', { name: 'Search devices' }), {
      target: { value: 'living' },
    })
    // Closed by the page (Show), not by the dialog's own buttons, then opened again.
    rerender(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(true)
    expect(within(kind()).getByRole('radio', { name: 'All, 8' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(dialog()).getByRole('searchbox', { name: 'Search devices' })).toHaveValue('')
    expect(within(list()).getAllByRole('listitem')).toHaveLength(8)
  })

  it('offers what Device Lab can do: Connect, Show, Connect over Wi‑Fi…', () => {
    const { calls } = show({
      nearby: [TV_ROW],
      listed: [{ id: 'adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp', connection: 'network' }],
    })
    fireEvent.click(
      within(row('Living Room TV')).getByRole('button', {
        name: 'Connect Living Room TV (192.168.68.101:5555)',
      }),
    )
    expect(calls.connect).toHaveBeenCalledWith(TV_ROW)
    fireEvent.click(
      within(row('BAULOC Pixel 9')).getByRole('button', {
        name: 'Show BAULOC Pixel 9 in the device list',
      }),
    )
    expect(calls.show).toHaveBeenCalledWith('adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp')
    // Nothing to do for the router, the printer or this computer: only the row's own disclosure.
    for (const name of ['TP-Link router', 'HP Neverstop', 'BAULOC’s MacBook Pro']) {
      const buttons = within(row(name)).getAllByRole('button')
      expect(buttons).toHaveLength(1)
      expect(buttons[0]).toHaveAttribute('aria-expanded')
    }
    cleanup()
    // The same TV and Pixel, advertising nothing: the Wi‑Fi dialog, filled in.
    const second = show()
    const wifi = within(row('Living Room TV')).getByRole('button', {
      name: 'Connect Living Room TV (192.168.68.101:5555) over Wi‑Fi…',
    })
    expect(wifi).toHaveTextContent('Connect over Wi‑Fi…')
    fireEvent.click(wifi)
    expect(second.calls.wifi).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '192.168.68.101:5555',
        action: { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } },
      }),
    )
    fireEvent.click(
      within(row('BAULOC Pixel 9')).getByRole('button', {
        name: 'Connect BAULOC Pixel 9 (192.168.68.114) over Wi‑Fi…',
      }),
    )
    expect(second.calls.wifi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: { kind: 'pair', host: '192.168.68.114', pair: null, connect: null },
      }),
    )
  })

  it('a connect running: every Connect waits, the one running says so; Pair… for a phone', () => {
    const PAIR_ROW: NearbyRow = {
      key: 'serial:55090DLAQ0026D',
      name: '55090DLAQ0026D',
      address: '192.168.68.114:43141',
      kind: 'wireless',
      tv: false,
      pairingOpen: false,
      action: {
        kind: 'pair',
        host: '192.168.68.114',
        pair: null,
        connect: { host: '192.168.68.114', port: 43141 },
      },
    }
    const { calls } = show({ nearby: [TV_ROW, PAIR_ROW], connecting: TV_ROW.key })
    const connect = within(row('Living Room TV')).getByRole('button', {
      name: 'Connect Living Room TV (192.168.68.101:5555)',
    })
    expect(connect).toHaveAttribute('aria-disabled', 'true')
    expect(connect).toHaveTextContent('Connecting…')
    fireEvent.click(connect)
    expect(calls.connect).not.toHaveBeenCalled()
    fireEvent.click(
      within(row('BAULOC Pixel 9')).getByRole('button', {
        name: 'Pair BAULOC Pixel 9 (192.168.68.114:43141)…',
      }),
    )
    expect(calls.pair).toHaveBeenCalledWith(PAIR_ROW)
  })

  it('opens a row on its facts: address to copy, host name, what it announces, how it was found', () => {
    show()
    const printer = row('HP Neverstop')
    expect(within(printer).queryByRole('definition')).toBeNull()
    fireEvent.click(printer.querySelector('button') ?? printer)
    const facts = within(printer).getByLabelText('About HP Neverstop Laser MFP 1200w (9C4E21)')
    expect(facts).toHaveTextContent('Address192.168.68.125')
    expect(within(facts).getByRole('button', { name: 'Copy address' })).toBeVisible()
    expect(facts).toHaveTextContent('Host nameNPI9C4E21.local')
    expect(facts).toHaveTextContent('ModelHP Neverstop Laser MFP 120x')
    expect(facts).toHaveTextContent('MakerHP')
    expect(facts).toHaveTextContent('AnnouncesPrinter (IPP)')
    expect(facts).toHaveTextContent('Found bya reply, mDNS')
    // An iPhone, on a Mac not yet running --wifi: a cable once, or a restart with the flag.
    const iphone = row('Baus iPhone 12 Pro')
    fireEvent.click(iphone.querySelector('button') ?? iphone)
    expect(within(iphone).getByRole('note')).toHaveTextContent(
      'To use it in Device Lab, plug it into this computer once with a cable and tap Trust. To use it without the cable, stop the helper (Ctrl+C) and start it again with --wifi:node ~/device-bridge.mjs --wifi',
    )
    // Closed again on a second click.
    fireEvent.click(printer.querySelector('button') ?? printer)
    expect(within(printer).queryByLabelText(/^About /)).toBeNull()
  })

  it('words the iPhone note by the helper: off a Mac, or when --wifi is already on', () => {
    // Off macOS the helper can't reach an iPhone at all: no restart command.
    const linux = helperStatus('connected', {
      health: { ...HEALTH, platform: 'linux-x64', features: ['lan.discover'] },
      lanes: { ...LANES, ios: { ...LANES.ios, status: 'unavailable', wifi: false } },
    })
    show({ status: linux })
    const off = row('Baus iPhone 12 Pro')
    fireEvent.click(off.querySelector('button') ?? off)
    expect(within(off).getByRole('note')).toHaveTextContent(
      'Only macOS lets the helper reach an iPhone. Open Device Lab on a Mac to use one.',
    )
    expect(within(off).getByRole('note').querySelector('code')).toBeNull()
    cleanup()
    // A Mac already running --wifi: it's listed, or a cable brings it in. No command either.
    const onWifi = helperStatus('connected', {
      health: { ...HEALTH, features: ['lan.discover'] },
      lanes: { ...LANES, ios: { ...LANES.ios, wifi: true } },
    })
    show({ status: onWifi })
    const ready = row('Baus iPhone 12 Pro')
    fireEvent.click(ready.querySelector('button') ?? ready)
    expect(within(ready).getByRole('note')).toHaveTextContent(
      'If it isn’t in the device list yet, plug it into this computer once with a cable and tap Trust.',
    )
    expect(within(ready).getByRole('note').querySelector('code')).toBeNull()
  })

  it('words the off-macOS iPhone note in Vietnamese when the locale is vi', () => {
    // Regression: the note read the English-only NEEDS_MAC instead of the bilingual
    // CARD_SENTENCES.needsMac, so it stayed English on a non-macOS helper under locale vi.
    setLocale('vi')
    const linux = helperStatus('connected', {
      health: { ...HEALTH, platform: 'linux-x64', features: ['lan.discover'] },
      lanes: { ...LANES, ios: { ...LANES.ios, status: 'unavailable', wifi: false } },
    })
    show({ status: linux })
    const off = within(screen.getByRole('dialog'))
      .getAllByRole('listitem')
      .find((li) => li.textContent.includes('Baus iPhone 12 Pro'))
    if (!off) throw new Error('no iPhone row')
    fireEvent.click(off.querySelector('button') ?? off)
    const note = within(off).getByRole('note')
    expect(note).toHaveTextContent(
      'Chỉ trên macOS, helper mới kết nối được với iPhone. Hãy mở Device Lab trên máy Mac để dùng iPhone.',
    )
    // The English constant must not leak through.
    expect(note).not.toHaveTextContent('Only macOS lets the helper reach an iPhone')
    expect(note.querySelector('code')).toBeNull()
  })

  it('nothing found, blocked, failed: each says so plainly', () => {
    show({ snapshot: snap({ result: result([]) }) })
    expect(dialog()).toHaveTextContent('No devices found on this network')
    cleanup()
    // Blocked: the local-network card with its fixes, and what the system's resolver named.
    show({
      snapshot: snap({
        state: 'blocked',
        result: result([IPHONE]),
        detail: 'send EHOSTUNREACH 192.168.68.1:9',
      }),
    })
    expect(dialog()).toHaveTextContent('This computer reaches the local network')
    expect(dialog()).toHaveTextContent('Blocking')
    expect(dialog()).toHaveTextContent('send EHOSTUNREACH 192.168.68.1:9')
    expect(list()).toHaveTextContent('Baus iPhone 12 Pro')
    cleanup()
    show({
      snapshot: snap({
        state: 'failed',
        result: null,
        code: 'HELPER_TIMEOUT',
        message: 'The helper took too long to answer. Try again.',
      }),
    })
    expect(dialog()).toHaveTextContent('The helper took too long to answer. Try again.')
    expect(within(dialog()).queryByRole('list')).toBeNull()
  })

  it('Refresh looks again, turning while it runs, and says how it ended', async () => {
    let finish = () => undefined as void
    const { calls, rerender } = show({
      refresh: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const live = within(dialog()).getByRole('status')
    const refresh = within(dialog()).getByRole('button', { name: 'Refresh' })
    fireEvent.click(refresh)
    expect(calls.refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(refresh)
    expect(calls.refresh).toHaveBeenCalledOnce()
    expect(live).toHaveTextContent('')
    rerender(true, snap({ result: result([ROUTER, MAC]) }))
    finish()
    await waitFor(() => {
      expect(live).toHaveTextContent('Found 2 devices.')
    })
    expect(refresh).not.toHaveAttribute('aria-disabled')
  })

  it('says how an opening look ended too, not only Refresh; a cache hit stays silent', async () => {
    // Opened with nothing fresh: the look runs (busy), and its end is spoken on its own.
    const { rerender } = show({ snapshot: snap({ state: 'looking', busy: true, result: null }) })
    const live = within(dialog()).getByRole('status')
    expect(live).toHaveTextContent('')
    rerender(true, snap())
    await waitFor(() => {
      expect(live).toHaveTextContent('Found 8 devices.')
    })
    cleanup()
    // Opened straight onto a fresh answer (no look ran, busy never flips): nothing is announced.
    show({ snapshot: snap() })
    expect(within(dialog()).getByRole('status')).toHaveTextContent('')
  })
})
