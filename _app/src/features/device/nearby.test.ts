import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HelperError } from './helper/client'
import type { VisibilityLike } from './helper/connection'
import type { NearbyDevice, NearbyReply } from './helper/protocol'
import {
  createNearby,
  NEARBY_INTERVAL,
  nearbyAvailability,
  nearbyRows,
  type ListedDevice,
} from './nearby'

/*
  "On this network" on its own: when it looks (first shown, every 30 s while visible, never
  while hidden or unwatched, Refresh at once), what each answer and failure becomes, and how
  what was heard turns into one row per device with one action.
*/

const found = (patch: Partial<NearbyDevice> = {}): NearbyDevice => ({
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
  ...patch,
})

// As dns-sd heard them on the owner's network (2026-10-04).
const BRAVIA = found()
const PIXEL_CONNECT = found({
  id: 'wireless:192.168.68.114:39601',
  instance: 'adb-55090DLAQ0026D-nK25Qn',
  kind: 'wireless',
  host: '192.168.68.114',
  port: 39601,
  serial: '55090DLAQ0026D',
  name: '',
  tv: false,
})
const PIXEL_PAIRING = found({
  id: 'pairing:192.168.68.114:41235',
  instance: 'adb-55090DLAQ0026D-nK25Qn',
  kind: 'pairing',
  host: '192.168.68.114',
  port: 41235,
  serial: '55090DLAQ0026D',
  name: '',
  tv: false,
})

const ok = (devices: NearbyDevice[] = [BRAVIA]): NearbyReply => ({ devices, scannedAt: 1 })

function fakeDocument() {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: 'visibilitychange', l: () => void) => listeners.add(l),
    removeEventListener: (_: 'visibilitychange', l: () => void) => listeners.delete(l),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state
      for (const l of listeners) l()
    },
    listeners,
  }
  return doc satisfies VisibilityLike
}

function setup(answer: (refresh: boolean) => Promise<NearbyReply> = () => Promise.resolve(ok())) {
  const doc = fakeDocument()
  const nearby = vi.fn((refresh?: boolean) => answer(refresh ?? false))
  const store = createNearby({ connection: { nearby }, document: doc, now: () => Date.now() })
  return { store, nearby, doc }
}

describe('createNearby', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks when first shown (Looking…), then every 30 s while visible', async () => {
    const { store, nearby } = setup()
    expect(store.getSnapshot().state).toBe('idle')
    expect(nearby).not.toHaveBeenCalled()
    const release = store.watch()
    expect(store.getSnapshot()).toMatchObject({ state: 'looking', busy: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()).toMatchObject({ state: 'ok', busy: false, devices: [BRAVIA] })
    expect(nearby).toHaveBeenCalledTimes(1)
    expect(nearby).toHaveBeenLastCalledWith(false, expect.any(AbortSignal))

    await vi.advanceTimersByTimeAsync(NEARBY_INTERVAL - 1)
    expect(nearby).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(nearby).toHaveBeenCalledTimes(2)
    // A later look keeps the list while it runs: no "Looking…" flash.
    release()
    await vi.advanceTimersByTimeAsync(NEARBY_INTERVAL * 3)
    expect(nearby).toHaveBeenCalledTimes(2)
  })

  it('never looks while the tab is hidden, and catches up when it shows again', async () => {
    const { store, nearby, doc } = setup()
    store.watch()
    await vi.advanceTimersByTimeAsync(0)
    doc.set('hidden')
    await vi.advanceTimersByTimeAsync(NEARBY_INTERVAL * 4)
    expect(nearby).toHaveBeenCalledTimes(1)
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(nearby).toHaveBeenCalledTimes(2)
  })

  it('a second view shares the looks; a quick reopen reuses a fresh answer', async () => {
    const { store, nearby, doc } = setup()
    const a = store.watch()
    const b = store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(nearby).toHaveBeenCalledTimes(1)
    a()
    b()
    expect(doc.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(nearby).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NEARBY_INTERVAL - 5_000)
    expect(nearby).toHaveBeenCalledTimes(2)
  })

  it('Refresh asks the helper to look again, after a look already running', async () => {
    let resolve: (r: NearbyReply) => void = () => undefined
    const { store, nearby } = setup((refresh) =>
      refresh
        ? Promise.resolve(ok([BRAVIA, PIXEL_CONNECT]))
        : new Promise((r) => {
            resolve = r
          }),
    )
    store.watch()
    const refreshed = store.refresh()
    expect(nearby).toHaveBeenCalledTimes(1)
    resolve(ok())
    await refreshed
    expect(nearby.mock.calls.map((c) => c[0])).toEqual([false, true])
    expect(store.getSnapshot().devices).toHaveLength(2)
  })

  it('blocked: what the system said, and what adb still lists', async () => {
    const { store } = setup(() =>
      Promise.resolve({
        devices: [BRAVIA],
        scannedAt: 1,
        error: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 224.0.0.251:5353' },
      }),
    )
    store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()).toMatchObject({
      state: 'blocked',
      devices: [BRAVIA],
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    })
  })

  it('blocked as an error, too old a helper, and any other failure', async () => {
    const blocked = new HelperError('DISCOVER_FAILED', 'http', {
      status: 502,
      body: { code: 'DISCOVER_FAILED', message: 'm', reason: 'blocked', detail: 'send EPERM' },
    })
    const a = setup(() => Promise.reject(blocked))
    a.store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.store.getSnapshot()).toMatchObject({ state: 'blocked', detail: 'send EPERM' })

    const b = setup(() => Promise.reject(new HelperError('DISCOVER_UNSUPPORTED', 'http')))
    b.store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.store.getSnapshot().state).toBe('unsupported')

    const c = setup(() => Promise.reject(new HelperError('HELPER_UNREACHABLE', 'network')))
    c.store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.store.getSnapshot()).toMatchObject({ state: 'failed', code: 'HELPER_UNREACHABLE' })

    const d = setup(() =>
      Promise.resolve({
        devices: [],
        scannedAt: 1,
        error: { reason: 'no-network', message: 'This computer isn’t on a network.', detail: '' },
      }),
    )
    d.store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(d.store.getSnapshot()).toMatchObject({
      state: 'failed',
      code: 'no-network',
      message: 'This computer isn’t on a network.',
    })
    // The next good answer drops the old words.
    d.nearby.mockImplementation(() => Promise.resolve(ok()))
    await d.store.refresh()
    expect(d.store.getSnapshot().message).toBeUndefined()
  })

  it('a look still running when the last view goes is dropped, not shown later', async () => {
    let resolve: (r: NearbyReply) => void = () => undefined
    const { store } = setup(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const release = store.watch()
    release()
    resolve(ok())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()).toMatchObject({ state: 'idle', busy: false, devices: [] })
  })
})

describe('nearbyRows', () => {
  it('names a device by its friendly name, else model, else serial, else its address', () => {
    const name = (d: Partial<NearbyDevice>) => nearbyRows([found(d)], [])[0]?.name
    expect(name({})).toBe('SONY KD-43X8050H')
    expect(name({ name: '', model: 'BRAVIA 4K UR3' })).toBe('BRAVIA 4K UR3')
    expect(name({ name: '' })).toBe('b120be004010859')
    expect(name({ name: '', serial: '' })).toBe('192.168.68.101')
  })

  it('a TV with Network debugging: Connect on its address', () => {
    expect(nearbyRows([BRAVIA], [])).toEqual([
      {
        key: 'serial:b120be004010859',
        name: 'SONY KD-43X8050H',
        address: '192.168.68.101:5555',
        kind: 'adb',
        tv: true,
        pairingOpen: false,
        action: { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } },
      },
    ])
  })

  it('a phone with Wireless debugging: Pair… until paired, then Connect', () => {
    expect(nearbyRows([PIXEL_CONNECT], [])[0]).toMatchObject({
      name: '55090DLAQ0026D',
      address: '192.168.68.114:39601',
      kind: 'wireless',
      tv: false,
      pairingOpen: false,
      action: {
        kind: 'pair',
        host: '192.168.68.114',
        pair: null,
        connect: { host: '192.168.68.114', port: 39601 },
      },
    })
    // Its pairing screen open too: one row, with both addresses.
    const both = nearbyRows([PIXEL_CONNECT, PIXEL_PAIRING], [])
    expect(both).toHaveLength(1)
    expect(both[0]).toMatchObject({
      pairingOpen: true,
      action: {
        kind: 'pair',
        pair: { host: '192.168.68.114', port: 41235 },
        connect: { host: '192.168.68.114', port: 39601 },
      },
    })
    // Only the pairing screen heard: pair there; the connect port comes from the phone.
    expect(nearbyRows([PIXEL_PAIRING], [])[0]).toMatchObject({
      address: '192.168.68.114:41235',
      kind: 'pairing',
      action: { kind: 'pair', pair: { port: 41235 }, connect: null },
    })
    expect(nearbyRows([{ ...PIXEL_CONNECT, paired: true }], [])[0]?.action).toEqual({
      kind: 'connect',
      target: { host: '192.168.68.114', port: 39601 },
    })
  })

  it('leaves out what is connected already: by address, mDNS name, serial or the helper’s word', () => {
    const listed = (...l: ListedDevice[]) =>
      nearbyRows([BRAVIA, PIXEL_CONNECT], l).map((r) => r.name)
    expect(listed()).toEqual(['55090DLAQ0026D', 'SONY KD-43X8050H'])
    expect(listed({ id: '192.168.68.101:5555', connection: 'network' })).toEqual(['55090DLAQ0026D'])
    expect(
      listed({ id: 'adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp', connection: 'network' }),
    ).toEqual(['SONY KD-43X8050H'])
    // The same phone on a cable is connected too.
    expect(listed({ id: '55090DLAQ0026D', connection: 'usb' })).toEqual(['SONY KD-43X8050H'])
    expect(nearbyRows([{ ...BRAVIA, connected: true }], [])).toEqual([])
    // Another port on the same address is another service, still offered.
    expect(listed({ id: '192.168.68.101:5556', connection: 'network' })).toHaveLength(2)
  })
})

describe('nearbyAvailability', () => {
  const health = (features: string[]) => ({
    name: 'bauloc-device-bridge',
    version: '1.1.0',
    protocol: 1,
    features,
    port: 8787,
    tokenId: 'abcd1234',
    tokenPersistent: false,
    runId: 'r',
    startedAt: 1,
    local: false,
    platform: 'darwin-arm64',
    sha256: '',
  })
  const pairing = { tokenId: 'abcd1234', remembered: true, tokenPersistent: false }

  const lanes = (android: 'ok' | 'off' | 'stopped') => ({
    ios: {
      status: 'ok' as const,
      screenshots: 'devicectl' as const,
      xcode: 'ready' as const,
      wifi: false,
      wifiHidden: 0,
    },
    android: { status: android, adb: 'found' as const, startedByHelper: false },
    simulators: { status: 'off' as const, booted: 0 },
  })

  it('looks only through a running, paired helper that can', () => {
    expect(nearbyAvailability({ phase: 'absent', pairing: null, health: null, lanes: null })).toBe(
      'helper',
    )
    expect(
      nearbyAvailability({
        phase: 'connected',
        pairing: null,
        health: health(['android.discover']),
        lanes: lanes('ok'),
      }),
    ).toBe('helper')
    expect(
      nearbyAvailability({
        phase: 'connected',
        pairing,
        health: health(['android.discover']),
        lanes: lanes('ok'),
      }),
    ).toBe('ready')
  })

  it('tells a helper older than discovery from one started with --no-android', () => {
    // The owner's helper, downloaded before discovery shipped: Android on, no android.discover.
    const old = { phase: 'connected' as const, pairing, health: health(['android.connect']) }
    expect(nearbyAvailability({ ...old, lanes: lanes('ok') })).toBe('older')
    expect(nearbyAvailability({ ...old, lanes: lanes('stopped') })).toBe('older')
    // --no-android leaves every Android feature out: not a reason to download it again.
    expect(nearbyAvailability({ ...old, health: health([]), lanes: lanes('off') })).toBe('off')
    // Connected a moment ago, lanes not read yet: no guess either way.
    expect(nearbyAvailability({ ...old, lanes: null })).toBe('unknown')
  })
})
