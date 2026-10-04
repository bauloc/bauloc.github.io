import { describe, expect, it } from 'vitest'

import { HEALTH, LANES, helperStatus } from '../components/helper-status.fixture'
import type { HelperStatus } from './connection'
import { compareVersions, featureSupport, helperUpdate, type GatedFeature } from './update'

/*
  Is the running helper behind this page: per feature (what a place that would use it says),
  and against the published file (what the chip and the notice strip say).
*/

const withFeatures = (features: string[], patch: Partial<HelperStatus> = {}) =>
  helperStatus('connected', { health: { ...HEALTH, features }, ...patch })

const androidOff = { ...LANES, android: { ...LANES.android, status: 'off' as const } }

describe('featureSupport', () => {
  const ALL: readonly GatedFeature[] = [
    'android.discover',
    'android.connect',
    'android.start-server',
  ]

  it('is ready for every feature the helper lists', () => {
    const current = withFeatures([...ALL])
    for (const feature of ALL) expect(featureSupport(current, feature)).toBe('ready')
  })

  it('is older for a feature a helper with Android on leaves out (downloaded before it shipped)', () => {
    // The owner's helper: 1.0.0 from before discovery, with Wi‑Fi but no android.discover.
    const before = withFeatures(['android.start-server', 'android.connect'])
    expect(featureSupport(before, 'android.discover')).toBe('older')
    expect(featureSupport(before, 'android.connect')).toBe('ready')
    // The adb server being stopped is no reason either way: the lane runs.
    const stopped = withFeatures([], {
      lanes: { ...LANES, android: { ...LANES.android, status: 'stopped' } },
    })
    for (const feature of ALL) expect(featureSupport(stopped, feature)).toBe('older')
  })

  it('is off, not older, for a helper started with --no-android', () => {
    const off = withFeatures([], { lanes: androidOff })
    for (const feature of ALL) expect(featureSupport(off, feature)).toBe('off')
  })

  it('waits for the lanes rather than guess, the moment after connecting', () => {
    expect(featureSupport(withFeatures([], { lanes: null }), 'android.discover')).toBe('unknown')
    // Listed is listed, lanes or not.
    expect(
      featureSupport(withFeatures(['android.discover'], { lanes: null }), 'android.discover'),
    ).toBe('ready')
  })

  it('leaves a helper that isn’t running and paired to the setup steps', () => {
    for (const phase of ['off', 'absent', 'unpaired', 'stale', 'outdated', 'lost'] as const) {
      expect(featureSupport(helperStatus(phase), 'android.discover')).toBe('helper')
    }
    expect(featureSupport(withFeatures([], { pairing: null }), 'android.discover')).toBe('helper')
  })
})

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(0)
  })
})

describe('helperUpdate', () => {
  const running = { version: '1.0.0', sha256: 'AB'.repeat(32) }

  it('names a newer published version', () => {
    expect(helperUpdate(running, { version: '1.1.0', sha256: 'cd'.repeat(32) })).toEqual({
      version: '1.1.0',
      running: '1.0.0',
      kind: 'newer',
    })
  })

  it('counts the same version with other bytes: discovery shipped while both said 1.0.0', () => {
    expect(helperUpdate(running, { version: '1.0.0', sha256: 'cd'.repeat(32) })).toEqual({
      version: '1.0.0',
      running: '1.0.0',
      kind: 'rebuilt',
    })
  })

  it('is null for the same file (whatever the hex case), an older one, or nothing to compare', () => {
    expect(helperUpdate(running, { version: '1.0.0', sha256: 'ab'.repeat(32) })).toBeNull()
    // A helper built ahead of the deploy is not asked to go back.
    expect(
      helperUpdate({ version: '1.2.0', sha256: '' }, { version: '1.1.0', sha256: 'cd'.repeat(32) }),
    ).toBeNull()
    expect(helperUpdate(running, null)).toBeNull()
    expect(helperUpdate(running, undefined)).toBeNull()
    expect(helperUpdate(null, { version: '9.0.0', sha256: '' })).toBeNull()
  })
})
