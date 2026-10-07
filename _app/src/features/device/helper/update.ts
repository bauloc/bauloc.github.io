import type { PublishedHelper } from '../preflight/types'
import type { HelperStatus } from './connection'
import type { Health, HelperFeature } from './protocol'

/*
  Is the running helper behind this page? Two questions, both pure:

  - featureSupport: the page is about to use a feature (android.discover, android.connect,
    android.start-server, android.adb, lan.discover) and the helper doesn't list it. A helper downloaded
    before the feature shipped keeps running for weeks, so the place that would use the
    feature says "Your helper is older than this page" with the command that updates it,
    instead of hiding. Every Android feature is also missing when the helper runs with
    --no-android: that is `off`, not `older`. lan.discover isn't Android's: --no-android
    leaves it on, so a helper without it is only ever older.
  - helperUpdate: the published file (readPublishedHelper, the Environment check's update row)
    is newer than the running helper, or the same version built differently. The header chip
    and the notice strip say "update available" from it, so it shows outside the check too.

  The page still never decides behaviour from `version` (§2.8): features decide what it uses.
  Versions only word the notices.
*/

/** The features the page gates something on, which an older helper may lack. */
export type GatedFeature = Extract<
  HelperFeature,
  'android.discover' | 'android.connect' | 'android.start-server' | 'android.adb' | 'lan.discover'
>

/** The features --no-android leaves out. */
const ANDROID_FEATURES: ReadonlySet<GatedFeature> = new Set([
  'android.discover',
  'android.connect',
  'android.start-server',
  'android.adb',
])

export type FeatureSupport =
  /** Not running and paired: the page's helper setup says what to do first. */
  | 'helper'
  /** Listed: use it. */
  | 'ready'
  /** Running and paired, the feature not listed (an Android one with its lane on): update. */
  | 'older'
  /** Started with --no-android, which leaves every Android feature out. */
  | 'off'
  /** Connected a moment ago, its lanes not read yet: wait for them rather than guess. */
  | 'unknown'

export function featureSupport(
  status: Pick<HelperStatus, 'phase' | 'pairing' | 'health' | 'lanes'>,
  feature: GatedFeature,
): FeatureSupport {
  if (status.phase !== 'connected' || status.pairing === null) return 'helper'
  if (status.health?.features.includes(feature)) return 'ready'
  // Nothing turns any other feature off: no lane to wait for.
  if (!ANDROID_FEATURES.has(feature)) return 'older'
  if (!status.lanes) return 'unknown'
  return status.lanes.android.status === 'off' ? 'off' : 'older'
}

/**
 * Compares two dotted versions numerically ("1.10.0" > "1.9.2"); a missing part counts as 0 and
 * anything after a `-` is ignored. Negative, zero or positive, like a sort comparator.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map((n) => Number(n) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface HelperUpdate {
  /** The published file's version. */
  readonly version: string
  /** The running helper's. */
  readonly running: string
  /**
   * `newer`: a higher version is published. `rebuilt`: the same version with other bytes, as
   * when discovery shipped while both files said 1.0.0.
   */
  readonly kind: 'newer' | 'rebuilt'
}

/**
 * Whether the published helper should replace the running one. Null when it is the same file,
 * when it is older than the running one (a helper built ahead of the deploy), or when either
 * side is unknown (not read yet, offline, not connected).
 */
export function helperUpdate(
  health: Pick<Health, 'version' | 'sha256'> | null | undefined,
  published: PublishedHelper | null | undefined,
): HelperUpdate | null {
  if (!health || !published) return null
  if (published.sha256.toLowerCase() === health.sha256.toLowerCase()) return null
  const order = compareVersions(published.version, health.version)
  if (order < 0) return null
  return {
    version: published.version,
    running: health.version,
    kind: order > 0 ? 'newer' : 'rebuilt',
  }
}
