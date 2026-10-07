import { CircleX, FileQuestion, TriangleAlert } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { formatBytes, formatDateTime } from '../format'
import { PlatformBadges } from '../term-privacy/page-card'
import { AppIcon } from './build-card'
import { BUILD_MESSAGES, type FindingValues } from './messages'
import { versionLabel, type Finding, type Findings } from './model'
import { androidRelease } from './templates/android-versions'
import type { AndroidFacts, BuildEntry, BuildInspection, BuildPlatform, IosFacts } from './types'

/** What the summary shows of a build, whether read from a file just now or from the index. */
export interface BuildFacts {
  readonly platform: BuildPlatform
  readonly name: string
  readonly bundleId: string
  readonly version: string
  readonly build: string
  readonly minOs: string
  readonly size: number
  readonly android: AndroidFacts | null
  readonly ios: IosFacts | null
}

export const factsOfInspection = (inspection: BuildInspection, size: number): BuildFacts => ({
  platform: inspection.platform,
  name: inspection.name,
  bundleId: inspection.bundleId,
  version: inspection.version,
  build: inspection.build,
  minOs: inspection.minOs,
  size,
  android: inspection.android,
  ios: inspection.ios,
})

export const factsOfEntry = (entry: BuildEntry): BuildFacts => ({
  platform: entry.platform,
  name: entry.name,
  bundleId: entry.bundle_id,
  version: entry.version,
  build: entry.build,
  minOs: entry.min_os,
  size: entry.size,
  android: entry.android,
  ios: entry.ios,
})

/**
 * A build at a glance: icon, name, platform and version, then what a tester's device needs
 * (the OS, the ABIs, the iPhone or iPad, how it is signed and until when) and the size.
 */
export function BuildSummary({
  facts,
  iconSrc,
  action,
}: {
  facts: BuildFacts
  iconSrc: string | null
  /** A button at the top right: choosing another file. */
  action?: ReactNode
}) {
  const t = useMessages(BUILD_MESSAGES).sheet.facts
  const locale = useLocale()
  const rows: [string, ReactNode][] = []
  if (facts.bundleId) {
    rows.push([
      facts.platform === 'android' ? t.package : t.bundleId,
      <span className="font-mono text-xs break-all">{facts.bundleId}</span>,
    ])
  }
  // An API level by the version a tester finds in Settings too, as the install page names it:
  // the two must not disagree about what a phone needs. A value that is no level at all (a
  // preview's codename) keeps the plain wording.
  const api = (level: string) => androidRelease(level) || t.api(level)
  if (facts.minOs) {
    rows.push([t.requires, facts.platform === 'android' ? api(facts.minOs) : t.ios(facts.minOs)])
  }
  const { android, ios } = facts
  if (android && android.target_sdk > 0) rows.push([t.target, api(String(android.target_sdk))])
  if (android && android.abis.length > 0) rows.push([t.abis, android.abis.join(', ')])
  if (ios && ios.devices.length > 0) {
    rows.push([t.devices, ios.devices.map((d) => t.appleDevices[d]).join(', ')])
  }
  const profile = ios?.profile
  if (profile) {
    const devices = profile.device_count === null ? '' : t.deviceCount(profile.device_count)
    rows.push([t.distribution, [t.profile[profile.kind], devices].filter(Boolean).join(' · ')])
    if (profile.team) rows.push([t.team, profile.team])
    const expires = formatDateTime(profile.expires, locale)
    if (expires) rows.push([t.expires, expires])
  }
  rows.push([t.size, formatBytes(facts.size, locale)])
  const version = versionLabel(facts)

  return (
    <div className="bg-muted/30 min-w-0 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <AppIcon src={iconSrc} name={facts.name || facts.bundleId} className="size-12 text-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="truncate leading-tight font-medium">
            {facts.name || facts.bundleId || '—'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <PlatformBadges platforms={[facts.platform]} />
            {version && (
              <span className="text-muted-foreground text-xs tabular-nums">{version}</span>
            )}
          </div>
        </div>
        {action}
      </div>
      <dl className="mt-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

/**
 * A file that turned out not to be a build at all: its name and size, and no guess at what it
 * is for — no platform, no version — beside the problem that says so.
 */
export function UnreadFile({ file, action }: { file: File; action?: ReactNode }) {
  const locale = useLocale()
  return (
    <div className="bg-muted/30 flex min-w-0 items-center gap-3 rounded-xl border p-4">
      <span className="bg-muted text-muted-foreground grid size-12 shrink-0 place-items-center rounded-[22%]">
        <FileQuestion className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{file.name}</p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {formatBytes(file.size, locale)}
        </p>
      </div>
      {action}
    </div>
  )
}

/**
 * What reading the build found: problems in red (publishing waits until they are fixed), then
 * warnings in amber. Each is worded with the fix, in messages.ts.
 */
export function FindingList({
  findings,
  valuesOf,
}: {
  findings: Findings
  valuesOf: (finding: Finding) => FindingValues
}) {
  const t = useMessages(BUILD_MESSAGES).finding
  return (
    <>
      {findings.problems.length > 0 && (
        <ul className="border-destructive/30 bg-destructive/5 text-destructive space-y-2 rounded-lg border p-3 text-sm">
          {findings.problems.map((problem) => (
            <li key={problem.code} className="flex gap-2">
              <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t[problem.code](valuesOf(problem))}</span>
            </li>
          ))}
        </ul>
      )}
      {findings.warnings.length > 0 && (
        <ul className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
          {findings.warnings.map((warning) => (
            <li key={warning.code} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t[warning.code](valuesOf(warning))}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
