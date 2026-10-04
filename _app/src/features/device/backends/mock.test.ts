import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallPlan } from './archive/plan'
import { createMockBackend, MOCK_RECONNECT_MS, MOCK_UNPLUGGED_MS } from './mock'

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
