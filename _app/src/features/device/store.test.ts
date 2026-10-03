import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Backend } from './backends/backend'
import { normalizeDevice, type Device, type DeviceDetail, type DeviceState } from './model'
import { SHOT_LIMIT, createDeviceLab } from './store'

/** A scriptable lane: tests set its devices and fire its change notification. */
function fakeBackend(kind: Backend['kind'] = 'webusb') {
  let devices: Device[] = []
  const listeners = new Set<() => void>()
  const detail = vi.fn<(id: string) => Promise<DeviceDetail>>((id) =>
    Promise.resolve({
      platform: 'android',
      identity: { Serial: id },
      software: {},
      hardware: {},
      status: {},
    }),
  )
  const screenshot = vi.fn<(id: string) => Promise<Blob>>(() => Promise.resolve(new Blob(['png'])))
  const backend: Backend = {
    kind,
    label: kind,
    platforms: ['android'],
    canRequest: false,
    isAvailable: () => true,
    start: () => Promise.resolve(),
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    list: () => devices,
    detail,
    screenshot,
  }
  return {
    backend,
    detail,
    screenshot,
    set(...list: [string, DeviceState][]) {
      devices = list.map(([id, state]) => normalizeDevice({ id, backend: kind, state, name: id }))
      for (const listener of listeners) listener()
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const revokeObjectURL = vi.fn<(url: string) => void>()

beforeEach(() => {
  let n = 0
  revokeObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${String(++n)}`, revokeObjectURL })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDeviceLab', () => {
  it('selects the only ready device, and never guesses among several', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()

    lane.set(['a', 'ready'], ['b', 'unauthorized'])
    expect(lab.getSnapshot().selectedId).toBe('a')

    const two = fakeBackend()
    const lab2 = createDeviceLab([two.backend])
    await lab2.start()
    two.set(['a', 'ready'], ['b', 'ready'])
    expect(lab2.getSnapshot().selectedId).toBeNull()
  })

  it('loads the detail when the selected device becomes ready, and drops it when it stops being', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'authorizing'])
    lab.select('a')
    expect(lab.getSnapshot().detail.status).toBe('idle')

    lane.set(['a', 'ready'])
    expect(lab.getSnapshot().detail.status).toBe('loading')
    await flush()
    expect(lab.getSnapshot().detail).toMatchObject({ status: 'ready', deviceId: 'a' })

    lane.set(['a', 'offline'])
    expect(lab.getSnapshot().detail.status).toBe('idle')
  })

  it('drops a slow detail reply for a device that is no longer selected', async () => {
    const lane = fakeBackend()
    let resolveA: (d: DeviceDetail) => void = () => undefined
    lane.detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve
        }),
    )
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'ready'])
    lab.select('a')
    lab.select('b')
    await flush()
    resolveA({
      platform: 'android',
      identity: { Serial: 'stale' },
      software: {},
      hardware: {},
      status: {},
    })
    await flush()
    expect(lab.getSnapshot().detail).toMatchObject({ status: 'ready', deviceId: 'b' })
  })

  it('keeps the selection of a device that disconnected, so the page can say it went', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'offline'])
    lane.set(['b', 'offline'])
    const snap = lab.getSnapshot()
    expect(snap.selectedId).toBe('a')
    expect(snap.devices.map((d) => d.id)).toEqual(['b'])
    expect(snap.announcement.text).toBe('The selected device disconnected.')
  })

  it('picks the next phone on the cable once nothing else is attached (a swap)', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['pixel', 'ready'])
    lane.set()
    expect(lab.getSnapshot().selectedId).toBeNull()
    lane.set(['galaxy', 'authorizing'])
    lane.set(['galaxy', 'ready'])
    expect(lab.getSnapshot().selectedId).toBe('galaxy')
  })

  it('makes a repeated announcement a new one, so a live region speaks it again', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    await lab.capture('a')
    const first = lab.getSnapshot().announcement
    await lab.capture('a')
    const second = lab.getSnapshot().announcement
    expect(second.text).toBe(first.text)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('tracks a Retry per device, so its button follows the device', async () => {
    const lane = fakeBackend()
    let finish: () => void = () => undefined
    const retry = vi.fn<(id: string) => Promise<void>>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const lab = createDeviceLab([{ ...lane.backend, retry }])
    await lab.start()
    lane.set(['a', 'unauthorized'], ['b', 'unauthorized'])
    const pending = lab.retry('a')
    expect(lab.getSnapshot().retrying).toEqual(['a'])
    await lab.retry('a') // a second press while the first is in flight does nothing
    expect(retry).toHaveBeenCalledTimes(1)
    finish()
    await pending
    expect(lab.getSnapshot().retrying).toEqual([])
  })

  it('lets work still in flight at stop() change nothing after it', async () => {
    const lane = fakeBackend()
    let deliver: (blob: Blob) => void = () => undefined
    lane.screenshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    const capture = lab.capture('a')
    lab.stop()
    deliver(new Blob(['png']))
    expect(await capture).toBeNull()
    expect(lab.getSnapshot().shots).toEqual([])
  })

  it('lists a device two lanes can see once, from the first lane', async () => {
    const usb = fakeBackend('webusb')
    const mock = fakeBackend('mock')
    const lab = createDeviceLab([usb.backend, mock.backend])
    await lab.start()
    usb.set(['same', 'ready'])
    mock.set(['same', 'offline'], ['other', 'ready'])
    // Both ready, so sorted by name; 'same' comes from the WebUSB lane, as it listed it first.
    expect(lab.getSnapshot().devices.map((d) => `${d.id}:${d.backend}`)).toEqual([
      'other:mock',
      'same:webusb',
    ])
  })

  it(`keeps the newest ${String(SHOT_LIMIT)} screenshots and releases the rest`, async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    for (let i = 0; i < SHOT_LIMIT + 2; i++) expect(await lab.capture('a')).toBeNull()
    expect(lab.getSnapshot().shots).toHaveLength(SHOT_LIMIT)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)

    lab.clearShots('a')
    expect(lab.getSnapshot().shots).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledTimes(SHOT_LIMIT + 2)
  })

  it('reports a failed screenshot in words, not codes', async () => {
    const lane = fakeBackend()
    lane.screenshot.mockRejectedValueOnce(new Error('SCREENSHOT_NOT_PNG'))
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    expect(await lab.capture('a')).toMatch(/not a PNG/)
    expect(lab.getSnapshot().capturing).toBe(false)
  })
})
