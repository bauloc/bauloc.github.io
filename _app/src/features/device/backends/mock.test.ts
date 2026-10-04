import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallPlan } from './archive/plan'
import { createMockBackend, MOCK_FIXTURES, MOCK_RECONNECT_MS, MOCK_UNPLUGGED_MS } from './mock'

const PIXEL = '55090DLAQ0026D'

const planOf = (fileName: string): InstallPlan => ({
  kind: 'apk',
  inputs: [{ name: fileName, size: 4_000_000, kind: 'apk', used: true }],
  app: {
    packageName: 'com.example.app',
    versionCode: 812,
    versionName: '1.4.0',
    minSdk: 24,
    targetSdk: 35,
    testOnly: false,
    debuggable: false,
    nativeAbis: [],
    label: null,
    icon: null,
  },
  parts: [{} as InstallPlan['parts'][number]],
  totalBytes: 4_000_000,
  selection: null,
  expansions: [],
  problems: [],
  warnings: [],
  notes: [],
})

describe('mock lane, -disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('unplugs the phone from the list, then plugs it back in: connecting, then ready', async () => {
    const lane = createMockBackend()
    const pixel = () => lane.list().find((d) => d.id === PIXEL)
    const changed = vi.fn()
    lane.subscribe(changed)
    expect(pixel()?.state).toBe('ready')

    const install = lane.install?.(
      PIXEL,
      planOf('shop-disconnect.apk'),
      {},
      () => undefined,
      new AbortController().signal,
    )
    const failed = expect(install).rejects.toThrow('Socket closed')
    await vi.advanceTimersByTimeAsync(1500)
    await failed

    // Gone, not listed as 'absent': the page must see the device leave, as with a real cable.
    expect(pixel()).toBeUndefined()
    expect(changed).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MOCK_UNPLUGGED_MS)
    expect(pixel()?.state).toBe('connecting')

    await vi.advanceTimersByTimeAsync(MOCK_RECONNECT_MS)
    expect(pixel()?.state).toBe('ready')
  })

  it('leaves the other fixtures listed while one is unplugged', async () => {
    const lane = createMockBackend()
    const before = lane.list().length
    const install = lane.install?.(
      PIXEL,
      planOf('a-disconnect.apk'),
      {},
      () => undefined,
      new AbortController().signal,
    )
    const failed = expect(install).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1500)
    await failed
    expect(lane.list().map((d) => d.id)).not.toContain(PIXEL)
    expect(lane.list()).toHaveLength(before - 1)
  })
})

describe('mock lane, the iPhone', () => {
  const IPHONE = '00008101-000A1B2C3D4E5F02'

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is what the helper reports on a Mac without Xcode: ready, logs, no screenshots', () => {
    const lane = createMockBackend()
    expect(lane.list().find((d) => d.id === IPHONE)).toMatchObject({
      platform: 'ios',
      state: 'ready',
      osVersion: '27.0',
      blockers: ['XCODE_REQUIRED'],
      capabilities: { screenshot: false, identifiers: true, logs: true },
    })
  })

  it('gives its Apple devices made-up UDIDs, so none can shadow a real phone’s row', () => {
    // A real UDID's second half is the chip's ECID; these spell out a counting pattern instead.
    const apple = MOCK_FIXTURES.filter((f) => f.platform === 'ios').map((f) => f.id)
    expect(apple.length).toBeGreaterThan(0)
    for (const id of apple) expect(id).toMatch(/^0000\d{4}-000A1B2C3D4E5F0\d$/)
  })

  it('refuses a screenshot with the blocker’s code, and keeps it across Retry', async () => {
    const lane = createMockBackend()
    const shot = expect(lane.screenshot(IPHONE)).rejects.toThrow('XCODE_REQUIRED')
    await vi.advanceTimersByTimeAsync(500)
    await shot
    const retry = lane.retry?.(IPHONE)
    await vi.advanceTimersByTimeAsync(600)
    await retry
    expect(lane.list().find((d) => d.id === IPHONE)?.blockers).toEqual(['XCODE_REQUIRED'])
  })

  it('reads its detail through the helper’s iOS formatter', async () => {
    const lane = createMockBackend()
    const detail = lane.detail(IPHONE)
    await vi.advanceTimersByTimeAsync(400)
    expect(await detail).toMatchObject({
      platform: 'ios',
      identity: {
        Model: 'iPhone 12 Pro',
        // Made up, like the UDID: a published bundle carries the mock.
        'Device name': 'Ngọc’s iPhone 12 Pro',
        Serial: 'F2LZZ0FAKE01',
        Identifier: IPHONE,
        ECID: '0x000A1B2C3D4E5F02',
      },
      hardware: { Capacity: '256 GB' },
      status: { Connection: 'USB (mock)' },
    })
  })

  it('streams syslog lines', async () => {
    const lane = createMockBackend()
    const controller = new AbortController()
    const lines: string[] = []
    const done = lane.logs?.(IPHONE, (l) => lines.push(...l), controller.signal)
    expect(lines[0]).toMatch(/ <Notice>: mock event #0$/)
    controller.abort()
    await vi.advanceTimersByTimeAsync(700)
    await done
  })
})
