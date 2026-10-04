import { CheckCircle2, ChevronDown, Info, Loader2, PackagePlus, RotateCcw, X } from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { useHeldWhileClosing } from '@/lib/use-held-while-closing'

import {
  deviceErrorMessage,
  isFileChangedFailure,
  isLocalFailure,
  phoneFactsOf,
  type DeviceSpec,
  type InstallFacts,
  type InstallOptions,
} from '../backends/backend'
import type { InstallFailure, InstallOutcome } from '../backends/android/pm-output'
import type { BadgeIcon, IconImage } from '../backends/archive/apk-badge'
import type {
  InstallPart,
  InstallPlan,
  PhoneCheck,
  PlanIssue,
  PlanIssueCode,
} from '../backends/archive/plan'
import { featureChecks } from '../preflight/checks'
import { COPY, STATUS_META } from '../preflight/copy'
import { isStaleBuildError } from '../preflight/env'
import type { CheckItem, Feature, InstallPhone } from '../preflight/types'
import {
  fmtBytes,
  installErrorWording,
  type Device,
  type InstallErrorAction,
  type InstallErrorWording,
} from '../model'
import {
  Command,
  FixButton,
  InlineChecklist,
  PathFix,
  StatusWord,
  splitFixes,
  type FixWiring,
} from './checklist'
import type { Job } from '../store'
import { ProgressBar, fmtTransfer, percentOf } from './jobs-strip'
import { TONE_SURFACE } from './status'

/*
  Install an app on one phone (PLAN §4.1–4.3): whatever was dropped or picked is read here,
  in the browser, into an install plan; the phone's own checks join it; nothing is sent until
  Install. Then the bytes stream into one install session, with Cancel until Android starts
  committing, and the outcome is said in plain words with the way forward.

  The archive code (zip, toc, matchers, manifest readers) loads on the first install, never
  with the page. The dialog never talks to the phone itself: the page hands it `actions`, and
  `install` runs as a job in the store, which owns its progress, its Cancel and its
  announcements. Closing the dialog mid-send leaves the job in the jobs strip, where it can
  still be cancelled; the dialog follows it through the `job` prop.
*/

/** The picker's filter. Files are recognised by content; this only narrows the list. */
export const INSTALL_ACCEPT = '.apk,.apks,.xapk,.apkm,.aab,.zip'

/** What the dialog needs from the page: the selected phone's operations, bound to it. */
export interface InstallActions {
  /** The phone as bundletool would describe it, for picking splits. */
  readonly deviceSpec: () => Promise<DeviceSpec>
  /** Free space, the installed copy and Play Protect's setting. Rejecting only skips those checks. */
  readonly installFacts: (packageName: string | null) => Promise<InstallFacts>
  /**
   * Starts the install as a store job (lab.install) and resolves with the job once it ended:
   * done or failed with Android's outcome, or cancelled. Rejects when it couldn't start.
   */
  readonly install: (plan: InstallPlan, options: InstallOptions) => Promise<InstallResult>
  /** Rejects with the failure's wording. */
  readonly openApp: (packageName: string) => Promise<void>
  /** Rejects with the failure's wording. */
  readonly uninstall: (packageName: string) => Promise<void>
}

/** The store's install job, as far as the dialog follows it. */
export type InstallJob = Pick<Job, 'id' | 'phase' | 'sent' | 'total' | 'phaseSince' | 'cancel'>

/** How a job ended. */
export type InstallResult = Pick<Job, 'phase' | 'outcome'>

/** A job still sending or installing; one per device. */
export const isRunningJob = (job: Pick<Job, 'phase'> | null | undefined): boolean =>
  job?.phase === 'sending' || job?.phase === 'installing'

/* ---------------------------------------------------------------- *
 * Reading the plan
 * ---------------------------------------------------------------- */

/** Which preflight rows apply: the container decides, an encrypted .apkm counts as an .apkm. */
export function featureOf(plan: InstallPlan): Feature {
  if (plan.kind === 'aab') return 'aab'
  if (plan.kind === 'apkm' || plan.inputs.some((i) => i.kind === 'apkm-encrypted')) return 'apkm'
  if (plan.kind === 'xapk') return 'xapk'
  return 'install'
}

/** Plan issues a preflight row already says, in the same words or with more help. */
const COVERED: ReadonlySet<PlanIssueCode> = new Set([
  'AAB_NEEDS_HELPER',
  'APKM_ENCRYPTED',
  'UNZIP_UNSUPPORTED',
])

/** A problem or warning from the plan or the phone's checks, as the dialog lists it. */
export interface IssueRow {
  readonly key: string
  readonly status: 'blocking' | 'warning'
  readonly sentence: string
  readonly action?: PlanIssue['action']
}

/** The plan's and the phone's problems, then their warnings; notes are listed apart. */
export function issueRows(plan: InstallPlan, phone: PhoneCheck | null): IssueRow[] {
  const rows = (status: IssueRow['status'], issues: readonly PlanIssue[]) =>
    issues
      .filter((issue) => !COVERED.has(issue.code))
      .map((issue, i): IssueRow => ({
        key: `${status}-${issue.code}-${String(i)}`,
        status,
        sentence: issue.message,
        ...(issue.action ? { action: issue.action } : {}),
      }))
  return [
    ...rows('blocking', [...plan.problems, ...(phone?.problems ?? [])]),
    ...rows('warning', [...plan.warnings, ...(phone?.warnings ?? [])]),
  ]
}

/** What the tester agreed to: each one adds a flag. */
export interface Consent {
  /** `--bypass-low-target-sdk-block`, for an old targetSdk. */
  readonly bypass: boolean
  /** `-d`, offered only when the installed copy is debuggable. */
  readonly downgrade: boolean
  /** `-g`. Off by default: it hides the permission prompts a tester may be testing. */
  readonly grant: boolean
}

export const NO_CONSENT: Consent = { bypass: false, downgrade: false, grant: false }

const BLOCKED = 'Fix what’s marked Blocking above first.'

/**
 * Whether Install may run, and the sentence when it may not. A warning whose way past is a
 * consent (Install anyway, Allow downgrade) holds the button until it is given: Android would
 * refuse without it, after the whole app had been sent.
 */
export function installGate(
  plan: InstallPlan,
  checks: readonly CheckItem[],
  issues: readonly IssueRow[],
  consent: Consent,
  phone: { readonly deviceName: string; readonly ready: boolean; readonly busy: boolean },
): string | null {
  if (!phone.ready) return `${phone.deviceName} isn’t ready. Reconnect it to install.`
  if (phone.busy) {
    return `Another install is running on ${phone.deviceName}. Wait for it to finish.`
  }
  const blocked =
    checks.some((c) => c.status === 'blocking') || issues.some((i) => i.status === 'blocking')
  if (blocked || plan.parts.length === 0) return BLOCKED
  if (issues.some((r) => r.action === 'install-anyway') && !consent.bypass) {
    return 'Turn on “Install anyway” to install an app that targets an old Android.'
  }
  if (issues.some((r) => r.action === 'allow-downgrade') && !consent.downgrade) {
    return 'Turn on “Allow downgrade” under Options to put the older version over the newer one.'
  }
  return null
}

/**
 * Whether "Uninstall and install" may run, and the sentence when it may not. Uninstalling
 * deletes the app's data on the phone, so it is only worth it when the installed copy is the
 * one thing in the way: anything else still Blocking (no APK for this CPU, too old an Android,
 * installs over USB turned off…) would make the install fail after the data was gone.
 */
export function uninstallFirstGate(
  plan: InstallPlan,
  checks: readonly CheckItem[],
  issues: readonly IssueRow[],
  consent: Consent,
  phone: { readonly deviceName: string; readonly ready: boolean; readonly busy: boolean },
): string | null {
  // The rows uninstalling clears are left out; every other reason Install is shut still holds.
  const others = issues.filter((r) => r.action !== 'uninstall-first')
  const gate = installGate(plan, checks, others, consent, phone)
  return gate === BLOCKED
    ? 'Uninstalling wouldn’t help yet: something else marked Blocking above stops the install. Fix that first.'
    : gate
}

/** The flags for this install; `-t` follows the plan, in the lane. */
export function installOptions(consent: Consent): InstallOptions {
  return {
    grantPermissions: consent.grant,
    allowDowngrade: consent.downgrade,
    bypassLowTargetSdkBlock: consent.bypass,
  }
}

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

const versionText = (name: string, code: number) =>
  name ? `${name} (${String(code)})` : String(code)

/** "1.4.0 (812)"; empty when the plan has no app. */
export function appVersion(plan: InstallPlan): string {
  return plan.app ? versionText(plan.app.versionName, plan.app.versionCode) : ''
}

/** What the dialog calls the app: its label, its package name, or the file. */
export function appName(plan: InstallPlan): string {
  return plan.app?.label ?? plan.app?.packageName ?? plan.inputs[0]?.name ?? 'the app'
}

/** "3 of 9 APKs for this phone · arm64-v8a · xxhdpi · en, vi"; null for a single APK. */
export function selectionLine(plan: InstallPlan): string | null {
  const s = plan.selection
  if (!s) return plan.parts.length > 1 ? `${String(plan.parts.length)} APKs` : null
  const facets = [s.abi, s.density, s.languages.join(', ')].filter(Boolean)
  return [
    `${String(plan.parts.length)} of ${String(s.offered)} APKs for this phone`,
    ...facets,
  ].join(' · ')
}

/** Why a part was picked, for "Why these?". */
export function partReason(part: Pick<InstallPart, 'role'>): string {
  const { module, kind, value } = part.role
  const of = module === 'base' ? '' : ` of ${module}`
  switch (kind) {
    case 'base':
      return 'The app itself'
    case 'feature':
      return `Module ${module}, installed with the app`
    case 'asset-pack':
      return `Asset pack ${module}, installed with the app`
    case 'abi':
      return `Native code for ${value}${of}`
    case 'density':
      return `Graphics for ${value} dpi screens${of}`
    case 'language':
      return `Language ${value}${of}`
    case 'other':
      return value ? `For ${value}${of}` : `Part${of}`
  }
}

/** "34 MB/s". */
export function fmtRate(bytesPerSecond: number): string {
  return `${fmtBytes(Math.round(bytesPerSecond))}/s`
}

/** "Sending to Pixel 9 · 21.5 of 34.7 MB · 62% · 28 MB/s". */
export function sendingText(
  deviceName: string,
  sent: number,
  total: number,
  rate: number | null,
): string {
  const parts = [`Sending to ${deviceName}`]
  if (total > 0) parts.push(fmtTransfer(sent, total), `${String(percentOf(sent, total))}%`)
  if (rate !== null && rate > 0) parts.push(fmtRate(rate))
  return parts.join(' · ')
}

/** What a successful install says: "Installed Probe 1.4.0 (812) on Pixel 9." */
export function successTitle(plan: InstallPlan, deviceName: string): string {
  const version = appVersion(plan)
  return `Installed ${appName(plan)}${version ? ` ${version}` : ''} on ${deviceName}.`
}

/** What the wording knows besides the failure itself. */
export interface FailureContext {
  readonly plan: InstallPlan
  readonly spec: Pick<DeviceSpec, 'sdkVersion' | 'supportedAbis'> | null
  readonly facts: Pick<InstallFacts, 'installed'> | null
}

/**
 * INSTALL_ERRORS' wording for a refusal, with the values Android didn't print filled in from
 * what the file and the phone said. Android's own values win.
 */
export function failureWording(failure: InstallFailure, ctx: FailureContext): InstallErrorWording {
  const app = ctx.plan.app
  const installed = ctx.facts?.installed ?? null
  const params: Record<string, string> = {
    ...(app
      ? {
          fileVersionCode: versionText(app.versionName, app.versionCode),
          requiredSdk: String(app.minSdk),
          targetSdk: String(app.targetSdk),
        }
      : {}),
    ...(installed
      ? { installedVersionCode: versionText(installed.versionName, installed.versionCode) }
      : {}),
    ...(ctx.spec ? { deviceSdk: String(ctx.spec.sdkVersion) } : {}),
    ...failure.params,
  }
  // A file that changed or moved since it was picked: Retry would send the same stale File, so
  // the way past is picking it again, which the dialog offers beside this wording.
  if (isFileChangedFailure(failure)) {
    return { text: failure.message, advice: null, action: null, fixes: [] }
  }
  // Not Android's refusal but the browser's (a phone that stopped answering, say): its own words.
  if (isLocalFailure(failure)) {
    return {
      text: failure.message,
      advice: null,
      action: { kind: 'retry', label: 'Retry' },
      fixes: [],
    }
  }
  return installErrorWording(
    { ...failure, params },
    { abis: ctx.spec?.supportedAbis ?? [], debuggable: installed?.debuggable ?? false },
  )
}

const NO_ANSWER = 'The install ended without an answer from the phone. Check the Apps tab.'

/** A failure that came from the browser side rather than from pm. */
const localFailure = (message: string): InstallFailure => ({
  ok: false,
  code: 'UNKNOWN',
  androidCode: null,
  message,
  params: {},
  output: '',
})

/** A refusal's Details: Android's code and message, then everything it printed. */
export function detailsText(failure: InstallFailure): string {
  const head = failure.androidCode ? `${failure.androidCode}: ${failure.message}` : failure.message
  return [head, failure.output]
    .map((t) => t.trim())
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .join('\n\n')
}

/* ---------------------------------------------------------------- *
 * Icons
 * ---------------------------------------------------------------- */

/** A data: URL rather than a blob URL: nothing to revoke, so nothing leaks or breaks on remount. */
export function imageUrl(image: IconImage): string {
  let binary = ''
  for (let i = 0; i < image.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000))
  }
  return `data:${image.mime};base64,${btoa(binary)}`
}

/** 0xAARRGGBB → `rgb(r g b / a)`, built at runtime: no colour literals in the source. */
export function argbCss(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255
  const r = (argb >>> 16) & 0xff
  const g = (argb >>> 8) & 0xff
  const b = argb & 0xff
  return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(Math.round(a * 1000) / 1000)})`
}

/** The initials avatar's text: the label's first letter, or the package's last segment's. */
export function initialOf(name: string): string {
  const word = name.includes('.') && !name.includes(' ') ? (name.split('.').pop() ?? name) : name
  return (word.trim()[0] ?? '?').toUpperCase()
}

/**
 * The app's icon as the launcher shows it. An adaptive icon's layers are 108 dp squares of
 * which the launcher shows the middle 72: both are drawn at 150% and clipped.
 */
function AppIcon({ icon, name }: { icon: BadgeIcon | null; name: string }) {
  const layers = useMemo(() => {
    if (!icon) return null
    if (icon.kind === 'bitmap') return { fg: imageUrl(icon), bg: null, color: null }
    const bg = icon.background
    return {
      fg: imageUrl(icon.foreground),
      bg: bg && 'bytes' in bg ? imageUrl(bg) : null,
      color: bg && 'argb' in bg ? argbCss(bg.argb) : null,
    }
  }, [icon])
  const box = 'relative size-12 shrink-0 overflow-hidden rounded-xl border'
  if (!layers) {
    return (
      <div
        aria-hidden="true"
        className={cn(box, 'bg-muted text-muted-foreground grid place-items-center text-lg')}
      >
        {initialOf(name)}
      </div>
    )
  }
  if (icon?.kind === 'bitmap') {
    return <img src={layers.fg} alt="" className={cn(box, 'bg-muted/40 object-contain')} />
  }
  const layer = 'absolute -inset-1/4 size-[150%] max-w-none'
  return (
    <div
      aria-hidden="true"
      className={cn(box, 'bg-muted')}
      style={layers.color ? { backgroundColor: layers.color } : undefined}
    >
      {layers.bg && <img src={layers.bg} alt="" className={layer} />}
      <img src={layers.fg} alt="" className={layer} />
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * Pieces
 * ---------------------------------------------------------------- */

const ISSUE_TITLES: Readonly<Record<IssueRow['status'], string>> = {
  blocking: 'Can’t install this yet',
  warning: 'Before you install',
}

/**
 * What the file and the phone say about this install, in the inline card's look: tinted by
 * the worst row, whose status the heading carries. A row of another status (a warning under
 * Blocking) says so above its sentence. `extra` adds a row's control, such as its Install
 * anyway switch.
 */
function IssuesCard({
  id,
  issues,
  extra,
}: {
  id: string
  issues: readonly IssueRow[]
  extra: (row: IssueRow) => ReactNode
}) {
  if (issues.length === 0) return null
  const status = issues.some((i) => i.status === 'blocking') ? 'blocking' : 'warning'
  const headingId = `${id}-title`
  return (
    <div
      id={id}
      role="note"
      aria-labelledby={headingId}
      className={cn('rounded-xl border p-4', TONE_SURFACE[STATUS_META[status].tone])}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="font-semibold">
          {ISSUE_TITLES[status]}
        </h3>
        <StatusWord status={status} />
      </div>
      <ul className="mt-3 space-y-3">
        {issues.map((issue) => (
          <li key={issue.key} className="space-y-2">
            {issue.status !== status && <StatusWord status={issue.status} className="h-5" />}
            <p className="text-muted-foreground text-sm leading-5">{issue.sentence}</p>
            {extra(issue)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Notes({ notes }: { notes: readonly PlanIssue[] }) {
  if (notes.length === 0) return null
  return (
    <ul className="text-muted-foreground space-y-1 text-xs leading-relaxed">
      {notes.map((note, i) => (
        <li key={`${note.code}-${String(i)}`} className="flex gap-2">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {note.message}
        </li>
      ))}
    </ul>
  )
}

/** Everything the phone printed, copyable for a ticket. */
function Details({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <details className="group text-sm">
      <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
        Details
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="bg-muted/60 mt-2 flex items-start gap-2 rounded-lg border p-2">
        <pre className="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
        <CopyButton text={text} label="Copy the phone’s output" />
      </div>
    </details>
  )
}

/** Step 1: what the file is, read locally. */
function AppSummary({ plan }: { plan: InstallPlan }) {
  const name = appName(plan)
  const line = selectionLine(plan)
  const size = plan.totalBytes || plan.inputs.reduce((n, i) => n + i.size, 0)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <AppIcon icon={plan.app?.icon ?? null} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-muted-foreground truncate text-xs">
            {[appVersion(plan), plan.app?.label ? plan.app.packageName : '', fmtBytes(size)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {line && <p className="text-muted-foreground truncate text-xs">{line}</p>}
        </div>
      </div>
      {plan.parts.length > 1 && (
        <details className="group text-sm">
          <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
            Why these?
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {plan.parts.map((part) => (
              <li key={part.name} className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-1.5 text-xs">
                <span className="truncate font-mono" title={part.source}>
                  {part.source}
                </span>
                <span className="text-muted-foreground tabular-nums">{fmtBytes(part.size)}</span>
                <span className="text-muted-foreground col-span-2">{partReason(part)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* A single file is the header's name already (appName), so it isn't listed again. */}
      {!plan.app && plan.inputs.length > 1 && (
        <ul className="text-muted-foreground text-xs">
          {plan.inputs.map((input, i) => (
            <li key={`${input.name}-${String(i)}`} className="truncate">
              {input.name} · {fmtBytes(input.size)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>}
      </div>
    </div>
  )
}

/** A panel in the tone of how it went: the outcome, the removal that failed. */
function Outcome({
  tone,
  title,
  children,
  alert = false,
}: {
  tone: 'ok' | 'bad'
  title: ReactNode
  children?: ReactNode
  alert?: boolean
}) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      className={cn('space-y-2 rounded-xl border p-4 text-sm', TONE_SURFACE[tone])}
    >
      <p className="flex items-center gap-2 font-medium">{title}</p>
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * The dialog
 * ---------------------------------------------------------------- */

interface Prepared {
  readonly plan: InstallPlan
  readonly spec: DeviceSpec
  readonly facts: InstallFacts | null
  readonly check: PhoneCheck | null
  readonly inflate: boolean
}

type Stage =
  | { readonly step: 'reading' }
  | { readonly step: 'unreadable'; readonly message: string; readonly stale: boolean }
  | { readonly step: 'review' }
  | { readonly step: 'removing'; readonly pkg: string }
  /** The store's job runs it; the `job` prop says how far it got. */
  | { readonly step: 'running'; readonly slow: boolean }
  | { readonly step: 'done'; readonly outcome: InstallOutcome }
  | { readonly step: 'remove-failed'; readonly pkg: string; readonly message: string }
  | { readonly step: 'cancelled' }

interface Session {
  readonly files: readonly File[] | null
  /** Bumped by Try again after a failed read, to read the files once more. */
  readonly attempt: number
  readonly prepared: Prepared | null
  readonly stage: Stage
  readonly consent: Consent
  /** Android refused with INSTALL_FAILED_USER_RESTRICTED: the OEM row turns Blocking. */
  readonly userRestricted: boolean
}

const freshSession = (files: readonly File[] | null): Session => ({
  files,
  attempt: 0,
  prepared: null,
  stage: { step: 'reading' },
  consent: NO_CONSENT,
  userRestricted: false,
})

/**
 * Reads the files into a plan for this phone, then the phone's side of the checks. The archive
 * code loads here, on the first install. Rejects only when the phone or the build fails it.
 */
async function preparePlan(files: readonly File[], actions: InstallActions): Promise<Prepared> {
  const [{ planInstall, checkPhone }, { canInflate }] = await Promise.all([
    import('../backends/archive/plan'),
    import('../backends/archive/zip'),
  ])
  const spec = await actions.deviceSpec()
  const plan = await planInstall(files, spec)
  const facts = await actions
    .installFacts(plan.kind === 'aab' ? null : (plan.app?.packageName ?? null))
    .catch(() => null)
  const phoneFacts = facts ? phoneFactsOf(facts) : null
  const check = plan.app && phoneFacts ? checkPhone(plan, phoneFacts) : null
  return { plan, spec, facts, check, inflate: canInflate() }
}

const RUNNING: ReadonlySet<Stage['step']> = new Set(['removing', 'running'])

/** "probe.apk", or "3 files". */
const filesText = (list: readonly File[] | null) =>
  list?.length === 1 ? (list[0]?.name ?? 'the file') : `${String(list?.length ?? 0)} files`

/** Android may sit on a Play Protect prompt; after this long the dialog says to look. */
export const SLOW_COMMIT_MS = 10_000
/** How often the speed is worked out again while sending. */
const RATE_MS = 500

type Confirm =
  | { readonly kind: 'replace'; readonly reason: 'signature' | 'downgrade' }
  | { readonly kind: 'uninstall-other'; readonly pkg: string }

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

export interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: Pick<Device, 'id' | 'name'>
  /** What connect read off the phone (model.installPhoneOf), for the preflight rows. */
  phone: InstallPhone | null
  /** The device is Ready. Install waits for it. */
  ready: boolean
  /**
   * The device's latest install job from the store (running, or ended and not dismissed).
   * While this dialog's own install runs it is that job; otherwise a running one holds Install.
   */
  job: InstallJob | null
  /** What was dropped or picked. A new array starts over, unless an install is running. */
  files: readonly File[] | null
  actions: InstallActions
  /** The checklist's own buttons (Reload, Check again…), as the page wires them. */
  wiring?: FixWiring
}

/** "Install on Pixel 9": read, check, send, install, and say how it went. */
export function InstallDialog({
  open,
  onOpenChange,
  device,
  phone,
  ready,
  job,
  files,
  actions,
  wiring,
}: InstallDialogProps) {
  const [session, setSession] = useState<Session>(() => freshSession(files))
  const [seen, setSeen] = useState(files)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  // What the confirmation fades out with; its action reads the live `confirm`.
  const shownConfirm = useHeldWhileClosing(confirm !== null, confirm)
  const [clock, setClock] = useState(0)
  const openRef = useRef(open)
  /** Files arrived while the install ran: the dialog moves on to them once it ends. */
  const waitingRef = useRef(false)
  const ids = useId()
  const checksId = `${ids}-checks`
  const issuesId = `${ids}-issues`
  const gateId = `${ids}-gate`
  const replaceId = `${ids}-replace`

  // New files start a new session, but never under a running install, whose outcome is still
  // to come: they wait, unread, until it ends. Adjusted while rendering, as React recommends
  // over an effect.
  const running = RUNNING.has(session.stage.step)
  if (files !== seen && !running) {
    setSeen(files)
    setSession(freshSession(files))
  }
  const waiting = running && files !== seen && files && files.length > 0 ? files : null

  useEffect(() => {
    openRef.current = open
    // Unmounted (its phone unplugged and dropped from the list) counts as closed, so an install
    // still in flight says how it ended in a toast.
    return () => {
      openRef.current = false
    }
  }, [open])

  useEffect(() => {
    waitingRef.current = waiting !== null
  }, [waiting])

  const setStage = (stage: Stage) => {
    setSession((s) => ({ ...s, stage }))
  }

  // The latest actions, without restarting the read when the page passes new ones.
  const readPlan = useEffectEvent((list: readonly File[]) => preparePlan(list, actions))

  useEffect(() => {
    const list = session.files
    if (!list || list.length === 0) return
    // A reply for files since replaced, or for an unmounted dialog, is dropped.
    let live = true
    readPlan(list).then(
      (ready) => {
        if (live) setSession((s) => ({ ...s, prepared: ready, stage: { step: 'review' } }))
      },
      (error: unknown) => {
        if (!live) return
        const stale = isStaleBuildError(error)
        const message = stale ? COPY.app.updated : deviceErrorMessage(error)
        setSession((s) => ({ ...s, stage: { step: 'unreadable', stale, message } }))
      },
    )
    return () => {
      live = false
    }
  }, [session.files, session.attempt])

  const ours = session.stage.step === 'running'
  const live = ours && isRunningJob(job) ? job : null

  // The speed needs the time, which a render may not read: a clock ticks while sending.
  const sending = live?.phase === 'sending'
  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => {
      setClock(Date.now())
    }, RATE_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [sending])

  // Android can't be hurried, but after a while the tester should look at the phone.
  const installing = live?.phase === 'installing'
  useEffect(() => {
    if (!installing) return
    const timer = window.setTimeout(() => {
      setSession((s) =>
        s.stage.step === 'running' ? { ...s, stage: { step: 'running', slow: true } } : s,
      )
    }, SLOW_COMMIT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [installing])

  const { prepared, stage, consent } = session
  const busy = !ours && isRunningJob(job)
  const plan = prepared?.plan ?? null
  const name = plan ? appName(plan) : 'the app'
  const pkg = plan?.app?.packageName ?? null

  const checks = useMemo(() => {
    if (!prepared) return []
    const { plan, facts, inflate } = prepared
    return featureChecks(featureOf(plan), {
      phone,
      verifyAdbInstalls: facts?.verifyAdbInstalls ?? null,
      userRestricted: session.userRestricted,
      inflate,
      ...(plan.inputs.some((i) => i.kind === 'apkm-encrypted') ? { apkmEncrypted: true } : {}),
      fileName: plan.inputs.find((i) => i.kind === 'aab')?.name,
      probe: null,
      doctor: null,
    })
  }, [prepared, phone, session.userRestricted])
  const issues = useMemo(
    () => (prepared ? issueRows(prepared.plan, prepared.check) : []),
    [prepared],
  )
  const notes = prepared ? [...prepared.plan.notes, ...(prepared.check?.notes ?? [])] : []
  const phoneState = { deviceName: device.name, ready, busy }
  const gate = plan ? installGate(plan, checks, issues, consent, phoneState) : null
  const replaceGate = plan ? uninstallFirstGate(plan, checks, issues, consent, phoneState) : BLOCKED
  const downgradeOffered = issues.some((r) => r.action === 'allow-downgrade')
  const describedBy = [
    checks.some((c) => c.status !== 'ok') ? checksId : '',
    issues.length > 0 ? issuesId : '',
    gate ? gateId : '',
  ]
    .filter(Boolean)
    .join(' ')

  const openApp = (packageName: string) => {
    actions.openApp(packageName).catch((error: unknown) => {
      toast.error(`Android couldn’t open ${packageName}`, {
        description: deviceErrorMessage(error),
      })
    })
  }

  const wordingOf = (failure: InstallFailure, current: Prepared) =>
    failureWording(failure, { plan: current.plan, spec: current.spec, facts: current.facts })

  /**
   * Whether the dialog won't show how this install ended, so a toast must: it is closed (the
   * install ran in the background), or files are waiting and it moves straight on to them.
   */
  const unseen = () => !openRef.current || waitingRef.current

  const finish = (outcome: InstallOutcome, current: Prepared) => {
    setSession((s) => ({
      ...s,
      stage: { step: 'done', outcome },
      userRestricted: s.userRestricted || (!outcome.ok && outcome.code === 'USER_RESTRICTED'),
    }))
    if (outcome.ok) {
      const title = successTitle(current.plan, device.name)
      const packageName = current.plan.app?.packageName
      if (unseen()) {
        toast.success(title, {
          ...(outcome.warnings.length > 0 ? { description: 'Installed, with warnings.' } : {}),
          ...(packageName
            ? {
                action: {
                  label: 'Open',
                  onClick: () => {
                    openApp(packageName)
                  },
                },
              }
            : {}),
        })
      }
      return
    }
    const { text } = wordingOf(outcome, current)
    const appLabel = appName(current.plan)
    if (unseen()) {
      // Show reopens the dialog on this outcome, unless it has moved on to the waiting files.
      const movedOn = waitingRef.current
      toast.error(`Couldn’t install ${appLabel} on ${device.name}`, {
        description: text,
        ...(movedOn
          ? {}
          : {
              action: {
                label: 'Show',
                onClick: () => {
                  onOpenChange(true)
                },
              },
            }),
      })
    }
  }

  /**
   * Sends the plan, after uninstalling `remove` first when asked to. The store announces the
   * job's phases and its end; the dialog shows them.
   */
  const run = async (overrides: Partial<Consent> = {}, remove?: string) => {
    const current = prepared
    if (!current || RUNNING.has(stage.step)) return
    const agreed = { ...consent, ...overrides }

    if (remove) {
      // Checked again here, whatever button led here: uninstalling deletes the app's data, and
      // must not happen when the install would fail anyway.
      const why = uninstallFirstGate(current.plan, checks, issues, agreed, phoneState)
      if (why !== null) {
        toast.error(`Didn’t uninstall ${remove}`, { description: why })
        return
      }
    }
    setSession((s) => ({ ...s, consent: agreed }))

    if (remove) {
      setStage({ step: 'removing', pkg: remove })
      try {
        await actions.uninstall(remove)
      } catch (error) {
        const message = deviceErrorMessage(error)
        setStage({ step: 'remove-failed', pkg: remove, message })
        if (unseen()) {
          toast.error(`Couldn’t uninstall ${remove}`, {
            description: `${message} Nothing was installed.`,
          })
        }
        return
      }
    }

    setStage({ step: 'running', slow: false })
    try {
      const result = await actions.install(current.plan, installOptions(agreed))
      if (result.phase === 'cancelled') setStage({ step: 'cancelled' })
      else finish(result.outcome ?? localFailure(NO_ANSWER), current)
    } catch (error) {
      finish(localFailure(deviceErrorMessage(error)), current)
    }
  }

  const copyDetails = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copied the details'),
      () => toast.error('Copy failed', { description: 'Select the text and copy it by hand.' }),
    )
  }

  /** The button under a refusal, by what INSTALL_ERRORS says gets past it. */
  const remedy = (failure: InstallFailure, kind: InstallErrorAction, details: string) => {
    switch (kind) {
      case 'uninstall-and-install':
        setConfirm({
          kind: 'replace',
          reason: failure.code === 'UPDATE_INCOMPATIBLE' ? 'signature' : 'downgrade',
        })
        return
      case 'uninstall-other': {
        const other = failure.params.other ?? ''
        if (PACKAGE.test(other)) setConfirm({ kind: 'uninstall-other', pkg: other })
        return
      }
      case 'allow-downgrade':
        void run({ downgrade: true })
        return
      case 'install-anyway':
        void run({ bypass: true })
        return
      case 'retry':
        void run()
        return
      case 'copy-details':
        copyDetails(details)
    }
  }

  const issueControl = (row: IssueRow): ReactNode => {
    if (row.action === 'install-anyway') {
      return (
        <div className="pl-[6.25rem]">
          <Toggle
            id={`${ids}-bypass`}
            label="Install anyway"
            checked={consent.bypass}
            onChange={(bypass) => {
              setSession((s) => ({ ...s, consent: { ...s.consent, bypass } }))
            }}
          />
        </div>
      )
    }
    if (row.action === 'uninstall-first' && pkg) {
      // The phone's own reasons (not ready, busy) are already said under the cards.
      const own = replaceGate !== null && replaceGate !== gate
      const describedBy = replaceGate === null ? undefined : own ? replaceId : gateId
      return (
        <div className="space-y-1 pl-[6.25rem]">
          <Button
            size="sm"
            variant="outline"
            aria-disabled={replaceGate !== null || undefined}
            aria-describedby={describedBy}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (replaceGate === null) setConfirm({ kind: 'replace', reason: 'downgrade' })
            }}
          >
            Uninstall and install…
          </Button>
          {own && (
            <p id={replaceId} className="text-muted-foreground text-xs">
              {replaceGate}
            </p>
          )}
        </div>
      )
    }
    return null
  }

  /* ---- what each stage shows ---- */

  let body: ReactNode = null
  let footer: ReactNode = null
  const closeButton = (label = 'Close') => (
    <Button
      variant="outline"
      onClick={() => {
        onOpenChange(false)
      }}
    >
      {label}
    </Button>
  )
  const backButton = (
    <Button
      onClick={() => {
        setStage({ step: 'review' })
      }}
    >
      Back to install
    </Button>
  )

  /** Said under a running install when files arrived meanwhile, so they don't seem lost. */
  const waitingLine = waiting && (
    <p role="status" className="text-muted-foreground text-xs">
      Next: {filesText(waiting)}. It’s read once this install ends.
    </p>
  )

  if (stage.step === 'reading') {
    const what = filesText(session.files)
    body = (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
        Reading {what} and {device.name}’s details…
      </p>
    )
    footer = closeButton()
  } else if (stage.step === 'unreadable') {
    body = (
      <Outcome tone="bad" title="Couldn’t get ready to install" alert>
        <p className="text-muted-foreground">{stage.message}</p>
      </Outcome>
    )
    footer = (
      <>
        {closeButton()}
        {stage.stale ? (
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            Reload
          </Button>
        ) : (
          <Button
            onClick={() => {
              setSession((s) => ({ ...s, attempt: s.attempt + 1, stage: { step: 'reading' } }))
            }}
          >
            <RotateCcw /> Try again
          </Button>
        )}
      </>
    )
  } else if (plan && prepared) {
    const summary = <AppSummary plan={plan} />
    switch (stage.step) {
      case 'review':
        body = (
          <>
            {summary}
            <InlineChecklist id={checksId} items={checks} wiring={wiring} />
            <IssuesCard id={issuesId} issues={issues} extra={issueControl} />
            <Notes notes={notes} />
            {plan.parts.length > 0 && (
              <details className="group text-sm" open={downgradeOffered || undefined}>
                <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
                  Options
                  <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-3 space-y-3">
                  <Toggle
                    id={`${ids}-grant`}
                    label="Grant all runtime permissions"
                    hint="The app won’t ask for the camera, location and the like. Leave it off to test those prompts."
                    checked={consent.grant}
                    onChange={(grant) => {
                      setSession((s) => ({ ...s, consent: { ...s.consent, grant } }))
                    }}
                  />
                  {downgradeOffered && (
                    <Toggle
                      id={`${ids}-downgrade`}
                      label="Allow downgrade"
                      hint="The installed copy is debuggable, so Android lets an older version replace it and keeps its data."
                      checked={consent.downgrade}
                      onChange={(downgrade) => {
                        setSession((s) => ({ ...s, consent: { ...s.consent, downgrade } }))
                      }}
                    />
                  )}
                </div>
              </details>
            )}
            {gate && (
              <p id={gateId} className="text-muted-foreground text-xs">
                {gate}
              </p>
            )}
          </>
        )
        footer = (
          <>
            {closeButton()}
            {/* aria-disabled, not disabled: it stays focusable and the cards say why. */}
            <Button
              aria-disabled={gate !== null || undefined}
              aria-describedby={describedBy || undefined}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (gate === null) void run()
              }}
            >
              <PackagePlus /> Install
            </Button>
          </>
        )
        break

      case 'removing':
        body = (
          <>
            {summary}
            <div role="status" className="space-y-2">
              <p className="text-sm">
                Uninstalling {stage.pkg} from {device.name}…
              </p>
              <ProgressBar label={`Uninstalling ${stage.pkg}`} />
            </div>
            {waitingLine}
          </>
        )
        footer = closeButton()
        break

      case 'running': {
        if (live?.phase === 'installing') {
          body = (
            <>
              {summary}
              <div className="space-y-2">
                <p className="text-sm">Installing on the phone…</p>
                <ProgressBar label="Installing on the phone" />
                {stage.slow && (
                  <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
                    Still installing. Check the phone: it may be asking you to confirm (Play
                    Protect).
                  </p>
                )}
              </div>
              {waitingLine}
            </>
          )
          footer = closeButton()
          break
        }
        const sent = live?.sent ?? 0
        const total = live?.total ?? plan.totalBytes
        const elapsed = live ? (clock - live.phaseSince) / 1000 : 0
        const text = sendingText(device.name, sent, total, elapsed >= 0.5 ? sent / elapsed : null)
        const cancel = live?.cancel
        body = (
          <>
            {summary}
            <div className="space-y-2">
              <p className="text-sm tabular-nums">{text}</p>
              <ProgressBar label={`Sending to ${device.name}`} value={sent} max={total} />
              <p className="text-muted-foreground text-xs">
                Closing this window doesn’t stop the install: its progress and Cancel stay on the
                page.
              </p>
            </div>
            {waitingLine}
          </>
        )
        footer = (
          <>
            {closeButton()}
            {cancel && (
              <Button variant="outline" onClick={cancel}>
                <X /> Cancel install
              </Button>
            )}
          </>
        )
        break
      }

      case 'cancelled':
        body = (
          <>
            {summary}
            <p className="text-sm">Cancelled. Nothing was installed.</p>
          </>
        )
        footer = (
          <>
            {closeButton()}
            {backButton}
          </>
        )
        break

      case 'remove-failed':
        body = (
          <>
            {summary}
            <Outcome tone="bad" title={`Couldn’t uninstall ${stage.pkg}`} alert>
              <p className="text-muted-foreground">{stage.message}</p>
              <p className="text-muted-foreground">Nothing was installed.</p>
            </Outcome>
          </>
        )
        footer = (
          <>
            {closeButton()}
            {backButton}
          </>
        )
        break

      case 'done': {
        const outcome = stage.outcome
        if (outcome.ok) {
          body = (
            <>
              {summary}
              <Outcome
                tone="ok"
                title={
                  <>
                    <CheckCircle2 aria-hidden="true" className="text-success size-4 shrink-0" />
                    {successTitle(plan, device.name)}
                  </>
                }
              >
                {outcome.warnings.length > 0 && (
                  <>
                    <p>Installed, with warnings:</p>
                    <ul className="text-muted-foreground list-disc space-y-0.5 pl-5">
                      {outcome.warnings.map((w, i) => (
                        <li key={`${String(i)}-${w}`}>{w}</li>
                      ))}
                    </ul>
                  </>
                )}
              </Outcome>
              {outcome.warnings.length > 0 && <Details text={outcome.output} />}
            </>
          )
          footer = (
            <>
              {closeButton('Done')}
              {pkg && (
                <Button
                  onClick={() => {
                    openApp(pkg)
                  }}
                >
                  Open app
                </Button>
              )}
            </>
          )
          break
        }
        const wording = wordingOf(outcome, prepared)
        const details = detailsText(outcome)
        const { commands, paths, buttons } = splitFixes(wording.fixes)
        const action = wording.action
        body = (
          <>
            {summary}
            <Outcome tone="bad" title={`Couldn’t install ${name}`} alert>
              <p className="text-muted-foreground leading-relaxed">{wording.text}</p>
              {wording.advice && <p className="leading-relaxed">{wording.advice}</p>}
              {commands.map((fix) => (
                <Command key={fix.copy} text={fix.copy} label={fix.label} />
              ))}
              {paths.map((fix) => (
                <PathFix key={fix.label + fix.path} fix={fix} />
              ))}
              {buttons.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {buttons.map((fix) => (
                    <FixButton key={fix.label} fix={fix} wiring={wiring} />
                  ))}
                </div>
              )}
            </Outcome>
            <Details text={details} />
          </>
        )
        // Copying needs no phone; everything else does.
        const needsPhone = action !== null && action.kind !== 'copy-details'
        const held = needsPhone && (!ready || busy)
        footer = (
          <>
            {closeButton()}
            {isFileChangedFailure(outcome) && (
              <InstallButton
                label="Pick again…"
                onFiles={(picked) => {
                  setSession(freshSession(picked))
                }}
              />
            )}
            {action && (
              <Button
                aria-disabled={held || undefined}
                title={held ? `${device.name} isn’t ready. Reconnect it first.` : undefined}
                className="aria-disabled:opacity-50"
                onClick={() => {
                  if (!held) remedy(outcome, action.kind, details)
                }}
              >
                {action.label}
              </Button>
            )}
          </>
        )
        break
      }
    }
  }

  const copyOf = (c: Confirm | null) =>
    c === null
      ? null
      : c.kind === 'replace'
        ? {
            title: `Replace ${name} on ${device.name}?`,
            body:
              c.reason === 'signature'
                ? 'The installed copy is signed with a different key (for example from Google Play), so Android can’t update it. Device Lab will uninstall it, which deletes its data on the phone, and then install this build.'
                : 'A newer version is installed, and Android won’t put an older one over it. Device Lab will uninstall it, which deletes its data on the phone, and then install this build.',
            remove: pkg,
          }
        : {
            title: `Uninstall ${c.pkg} from ${device.name}?`,
            body: `This removes the app and all of its data on the phone: accounts, settings and files. It can’t be undone. Device Lab then installs ${name}.`,
            remove: c.pkg,
          }
  const confirmCopy = copyOf(confirm)
  const shownCopy = copyOf(shownConfirm)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Install on {device.name}</DialogTitle>
            <DialogDescription>
              The file is read on this computer. Nothing is sent until you press Install.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-4">{body}</div>
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmCopy !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{shownCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{shownCopy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const remove = confirmCopy?.remove
                if (remove) void run({}, remove)
              }}
            >
              Uninstall and install
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* ---------------------------------------------------------------- *
 * Entry points: the button and the page-level drop target
 * ---------------------------------------------------------------- */

const MAX_DROPPED = 200
const MAX_DEPTH = 4

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    // readEntries hands over a batch at a time (100 in Chrome) until it returns none.
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject)
  })

async function walk(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (out.length >= MAX_DROPPED || entry.name.startsWith('.')) return
  if (entry.isFile) {
    out.push(await fileOf(entry as FileSystemFileEntry))
    return
  }
  if (!entry.isDirectory || depth >= MAX_DEPTH) return
  for (const child of await readEntries(entry as FileSystemDirectoryEntry)) {
    await walk(child, depth + 1, out)
  }
}

/**
 * The files of a drop, with dropped folders opened: "a folder of APKs" is one app. The items
 * are taken synchronously, as the drop event requires; hidden files are skipped.
 */
export function filesFromDrop(data: DataTransfer): Promise<File[]> {
  const items = Array.from(data.items ?? [])
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
  const plain = Array.from(data.files)
  if (entries.length === 0 || entries.some((e) => e === null)) return Promise.resolve(plain)
  return (async () => {
    const out: File[] = []
    for (const entry of entries) if (entry) await walk(entry, 0, out)
    return out
  })()
}

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

/**
 * Wraps the detail column: dragging files over it shows "Drop to install on Pixel 9", and a
 * drop hands the files (folders opened) to `onFiles`. When installing isn't possible the drop
 * is still caught, so the browser doesn't navigate away to the file, and `onRefused` says why.
 */
export function InstallDropZone({
  enabled,
  deviceName,
  onFiles,
  onRefused,
  className,
  children,
}: {
  enabled: boolean
  deviceName: string
  onFiles: (files: File[]) => void
  onRefused?: () => void
  className?: string
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        depth.current++
        if (enabled) setOver(true)
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (!enabled) {
          onRefused?.()
          return
        }
        filesFromDrop(e.dataTransfer).then(
          (files) => {
            if (files.length > 0) onFiles(files)
          },
          () => {
            toast.error('Couldn’t read what was dropped', {
              description: 'Pick the files with Install app instead.',
            })
          },
        )
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden="true"
          className="bg-background/90 text-muted-foreground border-primary/50 pointer-events-none absolute inset-0 z-20 rounded-xl border-2 border-dashed text-sm backdrop-blur-sm"
        >
          {/* Sticky, so on a zone taller than the window the words stay in view. */}
          <div className="sticky top-1/2 flex -translate-y-1/2 flex-col items-center py-16">
            <PackagePlus className="mb-2 size-7 opacity-60" />
            Drop to install on {deviceName}
          </div>
        </div>
      )}
    </div>
  )
}

/** "Install app": opens the file picker (several files at once) and hands the pick on. */
export function InstallButton({
  disabled = false,
  title,
  label = 'Install app',
  onFiles,
}: {
  disabled?: boolean
  title?: string
  label?: string
  onFiles: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        title={title}
        onClick={() => {
          input.current?.click()
        }}
      >
        <PackagePlus /> {label}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={INSTALL_ACCEPT}
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          // Cleared, so picking the same file again still fires change.
          e.target.value = ''
          if (picked.length > 0) onFiles(picked)
        }}
      />
    </>
  )
}
