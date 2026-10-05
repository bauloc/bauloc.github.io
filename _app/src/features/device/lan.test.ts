import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HelperError } from './helper/client'
import type { LanDevice, LanResult } from './helper/protocol'
import {
  createLan,
  LAN_FRESH,
  lanAction,
  lanAnnouncement,
  lanNotes,
  networkName,
  shownDevices,
  type LanSnapshot,
} from './lan'
import type { NearbyRow } from './nearby'

/*
  "Devices on this network" on its own: it looks when the list opens and on Refresh, never by
  itself (no timer at all), joins a look already running, stops waiting when the list closes,
  and words every failure the page's way. Then what each device offers: Show, the "On this
  network" Connect or Pair…, Connect over Wi‑Fi…, or the iPhone note.
*/

const device = (patch: Partial<LanDevice> = {}): LanDevice => ({
  address: '192.168.68.1',
  self: false,
  gateway: true,
  hostnames: [],
  names: [],
  services: [],
  found: ['reply', 'gateway'],
  ...patch,
})

const result = (patch: Partial<LanResult> = {}): LanResult => ({
  devices: [device()],
  networks: [{ interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 }],
  sources: { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' },
  scannedAt: 1,
  durationMs: 4_000,
  ...patch,
})

/** A connection whose answers the test hands out one by one. */
function setup() {
  const pending: {
    refresh: boolean
    signal: AbortSignal
    resolve: (r: LanResult) => void
    reject: (e: unknown) => void
  }[] = []
  const lanDevices = vi.fn(
    (refresh = false, signal?: AbortSignal) =>
      new Promise<LanResult>((resolve, reject) => {
        pending.push({ refresh, signal: signal ?? new AbortController().signal, resolve, reject })
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The request was aborted.', 'AbortError'))
        })
      }),
  )
  const lan = createLan({ connection: { lanDevices }, now: () => Date.now() })
  const snaps: LanSnapshot[] = []
  lan.subscribe(() => snaps.push(lan.getSnapshot()))
  return { lan, lanDevices, pending, snaps }
}

describe('createLan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks when the list opens (the helper’s cached answer), and never by itself', async () => {
    const { lan, lanDevices, pending } = setup()
    expect(lan.getSnapshot()).toEqual({ state: 'idle', result: null, busy: false, at: null })
    lan.open()
    expect(lanDevices).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    expect(lan.getSnapshot()).toMatchObject({ state: 'looking', busy: true })
    pending[0]?.resolve(result())
    await vi.advanceTimersByTimeAsync(0)
    expect(lan.getSnapshot()).toMatchObject({ state: 'ok', busy: false, result: result() })
    // Nothing in the background: no timer to come back with.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(lanDevices).toHaveBeenCalledTimes(1)
  })

  it('a reopen within 30 s shows the same answer; later it asks again; Refresh looks anew', async () => {
    const { lan, lanDevices, pending } = setup()
    lan.open()
    pending[0]?.resolve(result())
    await vi.advanceTimersByTimeAsync(0)
    lan.close()
    await vi.advanceTimersByTimeAsync(LAN_FRESH - 1)
    lan.open()
    expect(lanDevices).toHaveBeenCalledTimes(1)
    lan.close()
    await vi.advanceTimersByTimeAsync(1)
    lan.open()
    expect(lanDevices).toHaveBeenCalledTimes(2)
    expect(lanDevices).toHaveBeenLastCalledWith(false, expect.any(AbortSignal))
    // A later look keeps the list while it runs: no skeleton.
    expect(lan.getSnapshot()).toMatchObject({ state: 'ok', busy: true, result: result() })
    pending[1]?.resolve(result({ scannedAt: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    const refreshed = lan.refresh()
    expect(lanDevices).toHaveBeenLastCalledWith(true, expect.any(AbortSignal))
    pending[2]?.resolve(result({ scannedAt: 3 }))
    await refreshed
    expect(lan.getSnapshot().result?.scannedAt).toBe(3)
  })

  it('never two looks at once: a reopen joins, a Refresh waits, then looks again', async () => {
    const { lan, lanDevices, pending } = setup()
    lan.open()
    lan.open()
    const first = lan.refresh()
    const second = lan.refresh()
    expect(lanDevices).toHaveBeenCalledTimes(1)
    pending[0]?.resolve(result())
    await vi.advanceTimersByTimeAsync(0)
    expect(lanDevices).toHaveBeenCalledTimes(2)
    expect(lanDevices).toHaveBeenLastCalledWith(true, expect.any(AbortSignal))
    pending[1]?.resolve(result({ scannedAt: 9 }))
    await Promise.all([first, second])
    expect(lanDevices).toHaveBeenCalledTimes(2)
    expect(lan.getSnapshot()).toMatchObject({ state: 'ok', busy: false })
  })

  it('closing stops waiting: the request aborts, the skeleton goes, a queued Refresh never runs', async () => {
    const { lan, lanDevices, pending } = setup()
    lan.open()
    const refreshed = lan.refresh()
    lan.close()
    expect(pending[0]?.signal.aborted).toBe(true)
    expect(lan.getSnapshot()).toEqual({ state: 'idle', result: null, busy: false, at: null })
    await refreshed
    await vi.advanceTimersByTimeAsync(0)
    expect(lanDevices).toHaveBeenCalledTimes(1)
    // Opened again: a new look, since nothing came.
    lan.open()
    expect(lanDevices).toHaveBeenCalledTimes(2)
  })

  it('an abort it didn’t ask for (the connection stopping) leaves nothing busy', async () => {
    const { lan, pending } = setup()
    lan.open()
    pending[0]?.reject(new DOMException('The request was aborted.', 'AbortError'))
    await vi.advanceTimersByTimeAsync(0)
    expect(lan.getSnapshot()).toMatchObject({ state: 'idle', busy: false })
  })

  it('words every failure the page’s way, never as a bare code', async () => {
    const cases: [unknown, Partial<LanSnapshot>][] = [
      [
        new HelperError('LAN_UNSUPPORTED', 'http'),
        { state: 'unsupported', code: 'LAN_UNSUPPORTED' },
      ],
      [
        new HelperError('NOT_FOUND', 'http', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'm' },
        }),
        { state: 'unsupported', code: 'NOT_FOUND' },
      ],
      [
        new HelperError('TOOL_TIMEOUT', 'timeout'),
        {
          state: 'failed',
          code: 'HELPER_TIMEOUT',
          message: 'The helper took too long to answer. Try again.',
        },
      ],
      [
        new HelperError('HELPER_UNREACHABLE', 'network'),
        {
          state: 'failed',
          code: 'HELPER_UNREACHABLE',
          message:
            'The local helper stopped answering. Start it again; this page reconnects by itself.',
        },
      ],
      [
        new HelperError('HELPER_BAD_REPLY', 'protocol'),
        {
          state: 'failed',
          message:
            'The helper answered something this page can’t read. Reload the page, or update the helper.',
        },
      ],
      [
        new HelperError('LAN_LATER', 'http', { status: 500 }),
        {
          state: 'failed',
          code: 'LAN_LATER',
          message: 'The helper couldn’t look for devices on this network. Try again.',
        },
      ],
      [
        new TypeError('x is undefined'),
        {
          state: 'failed',
          message: 'The helper couldn’t look for devices on this network. Try again.',
        },
      ],
    ]
    for (const [error, want] of cases) {
      const { lan, pending } = setup()
      lan.open()
      pending[0]?.reject(error)
      await vi.advanceTimersByTimeAsync(0)
      expect(lan.getSnapshot()).toMatchObject({ ...want, busy: false, at: expect.any(Number) })
    }
  })

  it('a blocked look keeps what the system’s resolver named; no network is said in plain words', async () => {
    const { lan, pending } = setup()
    lan.open()
    const blocked = result({
      note: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 192.168.68.1:9' },
    })
    pending[0]?.resolve(blocked)
    await vi.advanceTimersByTimeAsync(0)
    expect(lan.getSnapshot()).toMatchObject({
      state: 'blocked',
      result: blocked,
      detail: 'send EHOSTUNREACH 192.168.68.1:9',
    })
    const refreshed = lan.refresh()
    pending[1]?.resolve(
      result({ devices: [], error: { reason: 'no-network', message: 'm', detail: '' } }),
    )
    await refreshed
    expect(lan.getSnapshot()).toMatchObject({
      state: 'failed',
      code: 'no-network',
      message:
        'This computer isn’t on a local network, so there is nothing to list. Join a Wi‑Fi or wired network, then refresh.',
    })
    expect(lan.getSnapshot()).not.toHaveProperty('detail')
    // The words go with their state.
    const again = lan.refresh()
    pending[2]?.resolve(result())
    await again
    expect(lan.getSnapshot()).toEqual({
      state: 'ok',
      result: result(),
      busy: false,
      at: expect.any(Number),
    })
  })
})

describe('lanAction', () => {
  const nearbyRow = (patch: Partial<NearbyRow> = {}): NearbyRow => ({
    key: 'host:192.168.68.101',
    name: 'SONY KD-43X8050H',
    address: '192.168.68.101:5555',
    kind: 'adb',
    tv: true,
    pairingOpen: false,
    action: { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } },
    ...patch,
  })
  const tv = device({ address: '192.168.68.101', gateway: false })
  const TV_VIEW = { kind: 'tv', name: 'Living Room TV', os: 'android' } as const
  const PIXEL = device({
    address: '192.168.68.114',
    gateway: false,
    services: [{ type: '_adb-tls-connect._tcp', port: 43141, name: 'adb-55090DLAQ0026D-nK25Qn' }],
  })
  const PIXEL_VIEW = { kind: 'phone', name: 'BAULOC Pixel 9', os: 'android' } as const

  it('Show for a device listed already: by its Wi‑Fi address, its adb name or its serial', () => {
    expect(
      lanAction(tv, TV_VIEW, [], [{ id: '192.168.68.101:5555', connection: 'network' }]),
    ).toEqual({
      kind: 'show',
      id: '192.168.68.101:5555',
    })
    // A USB row at that address isn't it.
    expect(
      lanAction(tv, TV_VIEW, [], [{ id: '192.168.68.101:5555', connection: 'usb' }])?.kind,
    ).toBe('wifi')
    const mdns = 'adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp'
    expect(lanAction(PIXEL, PIXEL_VIEW, [], [{ id: mdns, connection: 'network' }])).toEqual({
      kind: 'show',
      id: mdns,
    })
    expect(lanAction(PIXEL, PIXEL_VIEW, [], [{ id: '55090DLAQ0026D', connection: 'usb' }])).toEqual(
      {
        kind: 'show',
        id: '55090DLAQ0026D',
      },
    )
  })

  it('the "On this network" row at the same address: its Connect or Pair…', () => {
    const connect = nearbyRow()
    expect(lanAction(tv, TV_VIEW, [connect], [])).toEqual({ kind: 'nearby', row: connect })
    const pair = nearbyRow({
      key: 'serial:55090DLAQ0026D',
      address: '192.168.68.114:43141',
      kind: 'wireless',
      tv: false,
      action: {
        kind: 'pair',
        host: '192.168.68.114',
        pair: null,
        connect: { host: '192.168.68.114', port: 43141 },
      },
    })
    expect(lanAction(PIXEL, PIXEL_VIEW, [connect, pair], [])).toEqual({ kind: 'nearby', row: pair })
  })

  it('Connect over Wi‑Fi… for an Android TV or phone that doesn’t advertise debugging', () => {
    expect(lanAction(tv, TV_VIEW, [], [])).toEqual({
      kind: 'wifi',
      row: {
        key: 'lan:192.168.68.101',
        name: 'Living Room TV',
        address: '192.168.68.101:5555',
        kind: 'adb',
        tv: true,
        pairingOpen: false,
        action: { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } },
      },
    })
    // A phone pairs first: the pairing screen gives the port.
    expect(lanAction(PIXEL, PIXEL_VIEW, [], [])).toMatchObject({
      kind: 'wifi',
      row: {
        address: '192.168.68.114',
        action: { kind: 'pair', host: '192.168.68.114', pair: null, connect: null },
      },
    })
  })

  it('the note for an iPhone or iPad; nothing for this computer or a printer', () => {
    const iphone = device({ address: '192.168.68.110', gateway: false })
    expect(
      lanAction(iphone, { kind: 'phone', name: 'Baus iPhone 12 Pro', os: 'ios' }, [], []),
    ).toEqual({ kind: 'iphone' })
    expect(lanAction(iphone, { kind: 'tablet', name: 'iPad', os: 'ios' }, [], [])?.kind).toBe(
      'iphone',
    )
    const self = device({ address: '192.168.68.113', gateway: false, self: true })
    expect(lanAction(self, { kind: 'computer', name: 'Mac' }, [], [])).toBeNull()
    expect(lanAction(tv, { kind: 'printer', name: 'HP' }, [], [])).toBeNull()
    // An Apple TV is no iPhone: nothing to offer.
    expect(lanAction(tv, { kind: 'tv', name: 'Apple TV' }, [], [])).toBeNull()
  })
})

describe('shownDevices', () => {
  it('leaves out a link-local row that repeats a device on the Wi‑Fi, keeps one known only there', () => {
    const mac = device({
      address: '192.168.88.33',
      gateway: false,
      self: true,
      hostnames: ['BAULOCs-MacBook-Pro.local'],
      names: [{ text: 'BAULOC’s MacBook Pro', source: 'mdns' }],
    })
    // The same Mac on the cable to its iPhone: 169.254/16, the same host name.
    const macOnCable = device({
      address: '169.254.21.186',
      gateway: false,
      hostnames: ['baulocs-macbook-pro.local'],
    })
    const iphone = device({
      address: '192.168.88.34',
      gateway: false,
      names: [{ text: 'Baus iPhone 12 Pro', source: 'mdns' }],
    })
    const iphoneOnCable = device({
      address: '169.254.111.80',
      gateway: false,
      names: [{ text: 'Baus iPhone 12 Pro', source: 'mdns' }],
    })
    // A camera with no DHCP: on 169.254/16 only, so it stays.
    const camera = device({ address: '169.254.7.9', gateway: false, hostnames: ['cam.local'] })
    expect(shownDevices([mac, macOnCable, iphone, iphoneOnCable, camera])).toEqual([
      mac,
      iphone,
      camera,
    ])
  })

  it('keeps every row when nothing is on the Wi‑Fi', () => {
    const lone = [device({ address: '169.254.1.2', gateway: false, hostnames: ['a.local'] })]
    expect(shownDevices(lone)).toBe(lone)
  })
})

describe('networkName', () => {
  it('writes the network an address is on, as people do', () => {
    expect(networkName({ address: '192.168.68.113', prefix: 24 })).toBe('192.168.68.0/24')
    expect(networkName({ address: '10.0.5.20', prefix: 16 })).toBe('10.0.0.0/16')
    expect(networkName({ address: '172.20.10.2', prefix: 28 })).toBe('172.20.10.0/28')
    expect(networkName({ address: '192.168.1.7', prefix: 32 })).toBe('192.168.1.7/32')
    expect(networkName({ address: '192.168.1.7', prefix: 0 })).toBe('0.0.0.0/0')
  })
})

describe('lanNotes and lanAnnouncement', () => {
  it('says what this list could not use here, with the fix when there is one', () => {
    expect(lanNotes(result(), 'darwin-arm64')).toEqual([
      {
        text: 'Device makers aren’t shown: macOS doesn’t share device hardware addresses with the helper.',
      },
    ])
    // A printer that says its own address still gets a maker.
    expect(
      lanNotes(result({ devices: [device({ maker: '6C02E0' })] }), 'darwin-arm64')[0]?.text,
    ).toMatch(/^Some device makers aren’t shown/)
    expect(
      lanNotes(
        result({ sources: { presence: 'ok', neighbors: 'ok', resolver: 'none', ssdp: 'ok' } }),
        'linux-x64',
      ),
    ).toEqual([
      { text: 'Install avahi-utils for device names:', command: 'sudo apt install avahi-utils' },
    ])
    expect(
      lanNotes(
        result({
          sources: { presence: 'ok', neighbors: 'ok', resolver: 'dns-sd', ssdp: 'ok' },
          networks: [
            { interface: 'en0', address: '10.0.5.20', prefix: 16, size: 65_534, scanned: 254 },
          ],
          devices: Array.from({ length: 256 }, () => device()),
          truncated: true,
        }),
        'darwin-arm64',
      ).map((n) => n.text),
    ).toEqual([
      'On 10.0.0.0/16, 254 of its 65,534 addresses were checked; devices that announce themselves are listed from all of it.',
      'Only the first 256 devices are listed.',
    ])
    // Windows has no presence check: nothing was swept, so nothing was swept partly.
    expect(
      lanNotes(
        result({
          sources: { presence: 'off', neighbors: 'ok', resolver: 'none', ssdp: 'ok' },
          networks: [
            { interface: 'Wi-Fi', address: '192.168.1.5', prefix: 24, size: 254, scanned: 0 },
          ],
        }),
        'win32-x64',
      ),
    ).toEqual([])
    // A /24 whose counts don't tally (a parallel helper that counts its own address, or 2^n,
    // its own way): never a false partial note. §3 pins a full /24 at 254/254; only a prefix
    // shorter than /24, or an unswept interface (scanned 0), is a real trim worth flagging.
    for (const network of [
      { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 253 },
      { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 256, scanned: 253 },
    ]) {
      expect(
        lanNotes(
          result({
            sources: { presence: 'ok', neighbors: 'ok', resolver: 'dns-sd', ssdp: 'ok' },
            networks: [network],
          }),
          'linux-x64',
        ),
      ).toEqual([])
    }
  })

  it('says how a Refresh ended', () => {
    const snap = (patch: Partial<LanSnapshot>): LanSnapshot => ({
      state: 'ok',
      result: result(),
      busy: false,
      at: 1,
      ...patch,
    })
    expect(lanAnnouncement(snap({}))).toBe('Found 1 device.')
    expect(lanAnnouncement(snap({ result: result({ devices: [device(), device()] }) }))).toBe(
      'Found 2 devices.',
    )
    expect(lanAnnouncement(snap({ state: 'failed', message: 'No network.' }))).toBe('No network.')
    expect(lanAnnouncement(snap({ state: 'blocked' }), 'This computer can’t reach…')).toBe(
      'This computer can’t reach…',
    )
    expect(lanAnnouncement(snap({ state: 'unsupported' }))).toBe('')
  })
})
