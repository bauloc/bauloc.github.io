import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AndroidFacts } from '../model'
import type { ImageRow } from './android/media'
import { classifyPmOutput } from './android/pm-output'
import type { InstallPlan } from './archive/plan'
import {
  INSTALL_TRIGGERS,
  MAX_SYNTHETIC_APPS,
  createMockAndroid,
  installTrigger,
  newestFirst,
  syntheticApps,
  syntheticCount,
} from './mock-android'

/*
  The mock lane's install triggers: each file name asks for one outcome, and each outcome is
  text the real classifier reads the way it would read the phone's.
*/

describe('installTrigger', () => {
  it('finds the trigger at the end of a file name, longest first', () => {
    expect(installTrigger(['probe-incompatible.apk'])).toBe('incompatible')
    expect(installTrigger(['set-no-space.apks'])).toBe('no-space')
    expect(installTrigger(['base.apk', 'split_config.en-missing-split.apk'])).toBe('missing-split')
    expect(installTrigger(['probe.apk', 'Probe-SLOW.XAPK'])).toBe('slow')
    expect(installTrigger(['probe.apk'])).toBeNull()
    // Only at the end: a trigger word inside a name is just a name.
    expect(installTrigger(['unsigned-but-fine.apk'])).toBeNull()
  })

  it('makes every failure trigger classify as the code it is named for', () => {
    const expected: Partial<Record<keyof typeof INSTALL_TRIGGERS, string>> = {
      incompatible: 'UPDATE_INCOMPATIBLE',
      downgrade: 'VERSION_DOWNGRADE',
      'missing-split': 'MISSING_SPLIT',
      'no-abis': 'NO_MATCHING_ABIS',
      'older-sdk': 'OLDER_SDK',
      'deprecated-sdk': 'DEPRECATED_SDK_VERSION',
      unsigned: 'NO_CERTIFICATES',
      invalid: 'INVALID_APK',
      'not-apk': 'NOT_APK',
      'duplicate-permission': 'DUPLICATE_PERMISSION',
      'conflicting-provider': 'CONFLICTING_PROVIDER',
      'no-space': 'INSUFFICIENT_STORAGE',
      restricted: 'USER_RESTRICTED',
      aborted: 'ABORTED',
      verification: 'VERIFICATION_FAILURE',
      unknown: 'UNKNOWN',
    }
    for (const [trigger, code] of Object.entries(expected)) {
      const text = INSTALL_TRIGGERS[trigger as keyof typeof INSTALL_TRIGGERS]
        .replaceAll('{pkg}', 'com.example.app')
        .replaceAll('{code}', '1')
        .replaceAll('{newer}', '2')
        .replaceAll('{sdk}', '37')
      expect(classifyPmOutput(text)).toMatchObject({ ok: false, code })
    }
    expect(classifyPmOutput(INSTALL_TRIGGERS.warnings.replaceAll('{pkg}', 'a.b'))).toMatchObject({
      ok: true,
      warnings: ['Package a.b has a deprecated legacy permission'],
    })
  })
})

describe('the mock lane over time', () => {
  const FACTS: AndroidFacts = {
    sdk: 37,
    release: '17',
    manufacturer: 'Google',
    brand: 'google',
    abis: ['arm64-v8a'],
  }
  const mock = () =>
    createMockAndroid({ isReady: () => true, facts: () => FACTS, disconnect: () => undefined })

  /** Runs one operation to the end, its fake waits included. */
  async function settle<T>(work: Promise<T>): Promise<T> {
    const done = work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(500)
    const result = await done
    if ('error' in result) throw result.error
    return result.value
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps every app’s update time still between calls, and moves only the one installed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 4, 9, 0))
    const ops = mock()
    const before = await settle(ops.apps('d', 'all'))
    // Minutes later, nothing installed: the rows (and the tab's badge keys) are the same.
    expect(await settle(ops.apps('d', 'all'))).toEqual(before)

    const plan = {
      problems: [],
      parts: [{ size: 1000 }],
      totalBytes: 1000,
      inputs: [{ name: 'shop-12.8.2.apk' }],
      app: {
        packageName: 'com.example.shop',
        label: 'Shop',
        versionName: '12.8.2',
        versionCode: 128200,
        targetSdk: 35,
        minSdk: 24,
        debuggable: false,
      },
    } as unknown as InstallPlan
    const outcome = await settle(
      ops.install('d', plan, {}, () => undefined, new AbortController().signal),
    )
    expect(outcome).toMatchObject({ ok: true })
    await settle(ops.appAction('d', 'com.example.notes.debug', 'uninstall'))
    const installedAt = Date.now()

    const after = await settle(ops.apps('d', 'all'))
    const shop = after.find((r) => r.packageName === 'com.example.shop')
    expect(shop?.versionCode).toBe(128200)
    expect(shop?.lastUpdated).toBeGreaterThan(before[0]?.lastUpdated ?? 0)
    expect(shop?.lastUpdated).toBeLessThanOrEqual(installedAt)
    // First installed stays when an update goes over it.
    expect(shop?.firstInstalled).toBe(
      before.find((r) => r.packageName === 'com.example.shop')?.firstInstalled,
    )
    const untouched = (rows: typeof before) =>
      rows.filter((r) => !/^com\.example\.(shop|notes\.debug)$/.test(r.packageName))
    expect(untouched(after)).toEqual(untouched(before))
  })

  it('lists images by the time a tile shows, so a download with no date taken is not last', async () => {
    vi.useFakeTimers()
    const ops = mock()
    const rows = await settle(ops.images('d', { album: 'all', offset: 0, limit: 500 }))
    const shown = rows.map((r) => r.taken ?? r.modified ?? -1)
    expect(shown).toEqual([...shown].sort((a, b) => b - a))
    const firstDownload = rows.findIndex((r) => r.folder === 'Download/')
    const lastPhoto = rows.findLastIndex((r) => r.taken !== null)
    expect(firstDownload).toBeGreaterThanOrEqual(0)
    expect(firstDownload).toBeLessThan(lastPhoto)
  })

  it('breaks ties by id, newest first, and puts rows with no time at all last', () => {
    const row = (id: string, taken: number | null, modified: number | null) =>
      ({ id, taken, modified }) as ImageRow
    const sorted = [
      row('1', null, null),
      row('2', 100, 5),
      row('3', null, 100),
      row('4', null, 300),
    ].sort(newestFirst)
    expect(sorted.map((r) => r.id)).toEqual(['4', '3', '2', '1'])
  })
})

describe('&apps=<n>: synthetic apps for a long list', () => {
  it('reads only a whole number as a count, capped, and anything else as none', () => {
    expect(syntheticCount('300')).toBe(300)
    expect(syntheticCount('0')).toBe(0)
    expect(syntheticCount('')).toBe(0)
    expect(syntheticCount('failed')).toBe(0)
    expect(syntheticCount('-5')).toBe(0)
    expect(syntheticCount('2.5')).toBe(0)
    expect(syntheticCount('99999')).toBe(MAX_SYNTHETIC_APPS)
  })

  it('makes the same distinct, labelled user apps every time, with every icon kind', () => {
    const apps = syntheticApps(400)
    expect(apps).toEqual(syntheticApps(400))
    expect(new Set(apps.map((a) => a.packageName)).size).toBe(400)
    expect(new Set(apps.map((a) => a.label)).size).toBe(400)
    expect(apps.every((a) => !a.system && a.packageName.startsWith('com.example.synthetic.'))).toBe(
      true,
    )
    expect(new Set(apps.map((a) => a.icon))).toEqual(new Set(['bitmap', 'adaptive', null]))
  })

  it('adds them to the list only when the page asks, leaving the plain fixtures as they are', async () => {
    vi.useFakeTimers()
    const list = async (search: string) => {
      // The same clock for each list, so the fixtures' dates compare equal.
      vi.setSystemTime(Date.UTC(2026, 9, 4, 9, 0))
      vi.stubGlobal('location', { search })
      const ops = createMockAndroid({
        isReady: () => true,
        facts: () => ({
          sdk: 37,
          release: '17',
          manufacturer: 'Google',
          brand: 'google',
          abis: ['arm64-v8a'],
        }),
        disconnect: () => undefined,
      })
      const work = ops.apps('d', 'all').catch((error: unknown) => error as Error)
      await vi.advanceTimersByTimeAsync(1000)
      return work
    }
    try {
      const plain = await list('?mock=1')
      const long = await list('?mock=1&apps=300')
      if (!Array.isArray(plain) || !Array.isArray(long)) throw new Error('the list failed')
      expect(long).toHaveLength(plain.length + 300)
      expect(long.slice(0, plain.length)).toEqual(plain)
      expect(await list('?mock=1&apps=failed')).toBeInstanceOf(Error)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
