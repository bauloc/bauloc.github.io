import {
  AppWindow,
  Download,
  Eraser,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { useHeldWhileClosing } from '@/lib/use-held-while-closing'

import { installerName } from '../backends/android/packages'
import type { IconImage } from '../backends/archive/apk-badge'
import { apkFileName } from '../backends/archive/xapk'
import {
  deviceErrorMessage,
  type AppAction,
  type AppBadge,
  type AppDetail,
  type AppRow,
  type Backend,
} from '../backends/backend'
import { fmtBytes, fmtDateTime, type Device } from '../model'

/*
  One installed app: its details, and what a tester does to it — open it, stop it, open its
  App info on the phone, export its APKs, clear its data or uninstall it. The last two are
  destructive and always go through ConfirmAppAction, which names the app, the phone and what
  is lost.

  Also the pieces the Apps tab shares with this sheet: the avatar (the app's own icon once read
  from its APK, its initial until then), the action wording, and an export's progress. The
  export itself (one .apk, or an .xapk of a split app) is archive/xapk's.
*/

/** What the Apps tab and this sheet use of a lane (PLAN §2); every operation is optional. */
export type AppsLane = Pick<Backend, 'apps' | 'app' | 'appAction' | 'pull' | 'appBadge'>

/* ---------------------------------------------------------------- *
 * The avatar
 * ---------------------------------------------------------------- */

/** An icon ready to draw: blob URLs made once per badge, revoked when the badge is dropped. */
export type IconView =
  | {
      readonly kind: 'bitmap'
      readonly url: string
      /** The image itself: an export puts it in the .xapk as the app's icon. */
      readonly blob: Blob
    }
  | {
      readonly kind: 'adaptive'
      readonly foreground: string
      /** A CSS colour or an image URL; null draws the foreground on the muted surface. */
      readonly background: { readonly color: string } | { readonly url: string } | null
    }

export interface BadgeView {
  readonly label: string | null
  readonly icon: IconView | null
}

const imageBlob = (image: IconImage) => new Blob([image.bytes], { type: image.mime })
const imageUrl = (image: IconImage) => URL.createObjectURL(imageBlob(image))

/** 0xAARRGGBB → `rgb(r g b / a)`. Built at runtime: the palette rule bans colour literals. */
export function argbCss(argb: number): string {
  const channel = (shift: number) => (argb >>> shift) & 0xff
  const alpha = Math.round((channel(24) / 255) * 1000) / 1000
  return `rgb(${String(channel(16))} ${String(channel(8))} ${String(channel(0))} / ${String(alpha)})`
}

export function badgeView(badge: AppBadge): BadgeView {
  const { icon } = badge
  let view: IconView | null = null
  if (icon?.kind === 'bitmap') {
    const blob = imageBlob(icon)
    view = { kind: 'bitmap', url: URL.createObjectURL(blob), blob }
  }
  if (icon?.kind === 'adaptive') {
    const bg = icon.background
    view = {
      kind: 'adaptive',
      foreground: imageUrl(icon.foreground),
      background: !bg ? null : 'argb' in bg ? { color: argbCss(bg.argb) } : { url: imageUrl(bg) },
    }
  }
  return { label: badge.label?.trim() || null, icon: view }
}

/** Revokes a view's blob URLs; its avatar must no longer be on screen. */
export function releaseBadgeView(view: BadgeView | null): void {
  const icon = view?.icon
  if (!icon) return
  if (icon.kind === 'bitmap') URL.revokeObjectURL(icon.url)
  else {
    URL.revokeObjectURL(icon.foreground)
    if (icon.background && 'url' in icon.background) URL.revokeObjectURL(icon.background.url)
  }
}

/** Last segments that say nothing about the app, skipped when picking a package's initial. */
const GENERIC_SEGMENTS = new Set([
  'android',
  'app',
  'apps',
  'beta',
  'client',
  'debug',
  'dev',
  'internal',
  'mobile',
  'prod',
  'qa',
  'release',
  'staging',
])

/**
 * The avatar's letters: a label's first two words ("Google Maps" → "GM"), or for a package the
 * initial of its last meaningful segment (com.example.shop.debug → "S").
 */
export function initials(label: string | null, packageName: string): string {
  const words = (label ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((w) => Array.from(w)[0] ?? '')
      .join('')
      .toUpperCase()
  }
  const segments = packageName.split('.').filter(Boolean)
  const meaningful = segments.filter((s, i) => i > 0 && !GENERIC_SEGMENTS.has(s.toLowerCase()))
  const pick = meaningful.at(-1) ?? segments.at(-1) ?? '?'
  return (pick[0] ?? '?').toUpperCase()
}

/** Tinted surfaces for initials, picked by the package name so an app keeps its colour. */
const AVATAR_TONES = [
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
] as const

export function avatarTone(packageName: string): string {
  let hash = 0
  for (const ch of packageName) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0]
}

/** Both layers of an adaptive icon are 108 dp, of which a launcher shows the middle 72: 150%. */
const LAYER = 'absolute top-1/2 left-1/2 size-[150%] max-w-none -translate-1/2 object-cover'

/** The app's icon as the launcher draws it, or its initials while (or when) there is none. */
export function AppAvatar({
  packageName,
  view,
  className,
}: {
  packageName: string
  /** undefined: not read yet; null: read, nothing to draw. */
  view: BadgeView | null | undefined
  className?: string
}) {
  const icon = view?.icon
  const base = cn('relative size-9 shrink-0 overflow-hidden rounded-lg', className)
  if (icon?.kind === 'bitmap') {
    return <img src={icon.url} alt="" className={cn(base, 'object-contain')} />
  }
  if (icon?.kind === 'adaptive') {
    const bg = icon.background
    return (
      <span
        aria-hidden="true"
        className={cn(base, 'bg-muted')}
        style={bg && 'color' in bg ? { backgroundColor: bg.color } : undefined}
      >
        {bg && 'url' in bg && <img src={bg.url} alt="" className={LAYER} />}
        <img src={icon.foreground} alt="" className={LAYER} />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(base, 'grid place-items-center text-sm font-semibold', avatarTone(packageName))}
    >
      {initials(view?.label ?? null, packageName)}
    </span>
  )
}

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

/** "1.4.0 (812)", "812", or "" when neither is known. */
export function fmtVersion(name: string | null | undefined, code: number | null): string {
  if (name && code !== null) return `${name} (${String(code)})`
  return name ?? (code === null ? '' : String(code))
}

/** What each action says when it worked (a toast and the live region) and when it did not. */
export function actionMessages(
  action: AppAction,
  name: string,
  device: string,
): { readonly done: string; readonly failed: string } {
  switch (action) {
    case 'launch':
      return { done: `Opened ${name} on ${device}.`, failed: `Couldn’t open ${name}` }
    case 'stop':
      return { done: `Stopped ${name}.`, failed: `Couldn’t stop ${name}` }
    case 'info':
      return {
        done: `App info for ${name} is open on ${device}’s screen.`,
        failed: `Couldn’t open App info for ${name}`,
      }
    case 'clear':
      return {
        done: `Cleared ${name}’s data on ${device}.`,
        failed: `Couldn’t clear ${name}’s data`,
      }
    case 'uninstall':
      return { done: `Uninstalled ${name} from ${device}.`, failed: `Couldn’t uninstall ${name}` }
  }
}

export type DestructiveAction = Extract<AppAction, 'clear' | 'uninstall'>

/** The confirmation names the app (and its package, when the label differs), the phone, and what is lost. */
export function confirmCopy(
  action: DestructiveAction,
  name: string,
  packageName: string,
  device: string,
): { readonly title: string; readonly body: string; readonly confirm: string } {
  const who = name === packageName ? name : `${name} (${packageName})`
  if (action === 'uninstall') {
    return {
      title: `Uninstall ${name} from ${device}?`,
      body: `This removes ${who} and all of its data on the phone: accounts, settings and files. It can’t be undone.`,
      confirm: 'Uninstall',
    }
  }
  return {
    title: `Clear all data of ${name} on ${device}?`,
    body: `Android deletes the accounts, settings, databases and files of ${who}, as if it were just installed. The app stays installed. This can’t be undone.`,
    confirm: 'Clear data',
  }
}

/* ---------------------------------------------------------------- *
 * Export: one .apk, or an .xapk of a split app's APKs (archive/xapk)
 * ---------------------------------------------------------------- */

/** An export in flight, as the row and the sheet show it. */
export interface ExportProgress {
  /** Reading `pm path`, pulling the APKs, then (for a split app) checksumming them into an .xapk. */
  readonly phase: 'reading' | 'pulling' | 'packing'
  /** Bytes pulled, or while packing, bytes checksummed. */
  readonly received: number
  /** null until every APK's size is known. */
  readonly total: number | null
  /** APKs; 0 while they are being listed. */
  readonly files: number
}

/**
 * Whole percent of the phase, or null while its size is unknown. Packing starts again from 0:
 * checksumming a large app takes seconds, and a bar left full would read as done or stuck.
 */
export function exportPercent(p: ExportProgress): number | null {
  if (p.phase === 'reading') return null
  if (p.total === null || p.total <= 0) return null
  return Math.min(100, Math.floor((p.received / p.total) * 100))
}

/** "Exporting 12.3 of 45.6 MB (3 APKs) · 27%", or what is happening before and after. */
export function exportText(p: ExportProgress): string {
  if (p.phase === 'reading') return 'Finding the APK files…'
  const pct = exportPercent(p)
  if (p.phase === 'packing') {
    const packing = `Packing ${String(p.files)} APKs into an .xapk`
    return pct === null ? `${packing}…` : `${packing} · ${String(pct)}%`
  }
  const files = p.files > 1 ? ` (${String(p.files)} APKs)` : ''
  if (p.total === null || pct === null) return `Exporting ${fmtBytes(p.received)}${files}…`
  return `Exporting ${fmtBytes(p.received)} of ${fmtBytes(p.total)}${files} · ${String(pct)}%`
}

/** The same, short enough for a row's second line at 390 px: the percentage leads. */
export function exportShortText(p: ExportProgress): string {
  if (p.phase === 'reading') return 'Finding the APK files…'
  const pct = exportPercent(p)
  if (p.phase === 'packing') {
    return pct === null ? 'Packing the .xapk…' : `Packing the .xapk · ${String(pct)}%`
  }
  if (p.total === null || pct === null) return `Exporting · ${fmtBytes(p.received)}`
  return `Exporting · ${String(pct)}% of ${fmtBytes(p.total)}`
}

/**
 * The export's name in the row menu and the sheet alike. Neutral on purpose: the row can't know
 * before the export whether the app is one APK (saved as .apk) or a split app (saved as .xapk).
 */
export const EXPORT_LABEL = 'Export app'

/**
 * What the export saves, under the sheet's button once the APKs are listed: one APK as it is, a
 * split app's APKs as one .xapk (which adb install can't take). null while they are unknown.
 */
export function exportNote(apks: number | null): string | null {
  if (apks === null || apks < 1) return null
  return apks === 1 ? 'Saves one .apk.' : `Saves its ${String(apks)} APKs as one .xapk.`
}

/*
 * An export and an uninstall of the same app exclude each other: uninstalling deletes the APKs
 * the export is pulling, so the export would fail halfway (or save a backup the user meant to
 * keep from an app that is gone). Clear data stays open: `pm clear` leaves /data/app alone.
 */

/** Uninstall waits while an action or an export of the app runs. */
export const canUninstall = (busy: AppAction | undefined, exporting: ExportProgress | undefined) =>
  busy === undefined && exporting === undefined

/** One export per app at a time, and none of an app being uninstalled. */
export const canStartExport = (
  busy: AppAction | undefined,
  exporting: ExportProgress | undefined,
) => exporting === undefined && busy !== 'uninstall'

/** Said where Uninstall is held back by an export. */
export const UNINSTALL_WAITS = 'Cancel the export or let it finish to uninstall'

/**
 * For a control that goes away by itself, like an export's Cancel when the export ends: if it
 * holds focus then, focus moves to `returnFocus`'s target instead of falling to <body> or to
 * the dialog around it.
 */
export function useFocusAfterUnmount(ref: RefObject<HTMLElement | null>, returnFocus: () => void) {
  const refocus = useEffectEvent(returnFocus)
  useLayoutEffect(() => {
    const el = ref.current
    // Layout cleanups run before React removes the node, while it still holds focus.
    return () => {
      if (el && el === document.activeElement) refocus()
    }
  }, [ref])
}

/** The bar under an export: a determinate meter once the size is known, a pulse until then. */
export function ExportMeter({
  progress,
  label,
  className,
}: {
  progress: ExportProgress
  label: string
  className?: string
}) {
  const pct = exportPercent(progress)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={exportText(progress)}
      className={cn('bg-muted h-1.5 overflow-hidden rounded-full', className)}
    >
      <div
        className={cn(
          'bg-primary h-full rounded-full motion-safe:transition-[width]',
          pct === null && 'w-1/3 motion-safe:animate-pulse',
        )}
        style={pct === null ? undefined : { width: `${String(pct)}%` }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * The confirmation
 * ---------------------------------------------------------------- */

export interface PendingConfirm {
  readonly row: AppRow
  readonly name: string
  readonly action: DestructiveAction
}

/**
 * Clear data and Uninstall, behind a red action that spells out what is lost. The dialog stays
 * open while the phone works, so the result lands where the tester is looking.
 */
export function ConfirmAppAction({
  device,
  pending,
  running,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  device: Device
  pending: PendingConfirm | null
  /** The confirmed action is in flight. */
  running: boolean
  onCancel: () => void
  onConfirm: (pending: PendingConfirm) => void
  /** Where focus goes once it has closed; by default, back where it was. */
  onCloseAutoFocus?: (event: Event) => void
}) {
  const open = pending !== null
  // The wording fades out with the dialog; the action below still reads the live `pending`.
  const shown = useHeldWhileClosing(open, pending)
  const copy = shown
    ? confirmCopy(shown.action, shown.name, shown.row.packageName, device.name)
    : null
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onCancel()
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">{copy?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
          {/* aria-disabled while running: disabling the focused button drops focus to <body>. */}
          <AlertDialogAction
            variant="destructive"
            className="aria-disabled:opacity-50"
            aria-disabled={running}
            onClick={(e) => {
              // The tab closes it once the phone answers, not Radix on click.
              e.preventDefault()
              if (pending && !running) onConfirm(pending)
            }}
          >
            {running && <Loader2 className="animate-spin" />}
            {copy?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ---------------------------------------------------------------- *
 * The sheet
 * ---------------------------------------------------------------- */

type DetailLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly detail: AppDetail }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unavailable' }

/** A dump's device-local time ("2026-10-03 14:05:09"), with the phone's zone named when known. */
const phoneTime = (text: string, timeZone: string | undefined) =>
  `${text} (${timeZone ? `${timeZone} time` : 'phone time'})`

function when(ms: number | null, dump: string | null, timeZone: string | undefined): string {
  if (ms !== null) return fmtDateTime(new Date(ms))
  return dump ? phoneTime(dump, timeZone) : ''
}

function Field({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  if (!value) return null
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-1.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        {/* Phone-supplied: rendered as text, never markup. */}
        <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">{value}</span>
        {copy && <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />}
      </dd>
    </div>
  )
}

/** The details, once read: versions, SDK levels, installer, times, flags and the APK files. */
function Details({
  row,
  detail,
  timeZone,
}: {
  row: AppRow
  detail: AppDetail
  timeZone: string | undefined
}) {
  const splits = detail.splits.filter((s) => s !== 'base')
  const apkTotal = detail.apks.every((a) => a.size !== null)
    ? detail.apks.reduce((n, a) => n + (a.size ?? 0), 0)
    : null
  return (
    <>
      <dl className="divide-y">
        <Field label="Version" value={fmtVersion(detail.versionName, detail.versionCode)} />
        <Field label="Package" value={detail.packageName} copy />
        <Field label="Installed by" value={installerName(detail.installer ?? row.installer)} />
        <Field
          label="First installed"
          value={when(row.firstInstalled, detail.firstInstalled, timeZone)}
        />
        <Field label="Last updated" value={when(row.lastUpdated, detail.lastUpdated, timeZone)} />
        <Field
          label="Min Android"
          value={detail.minSdk === null ? '' : `API ${String(detail.minSdk)}`}
        />
        <Field
          label="Target Android"
          value={detail.targetSdk === null ? '' : `API ${String(detail.targetSdk)}`}
        />
        <Field label="Debuggable" value={detail.debuggable ? 'Yes' : 'No'} />
        {detail.testOnly && <Field label="Test-only" value="Yes" />}
        <Field label="CPU ABI" value={detail.primaryCpuAbi ?? ''} />
        <Field label="Data folder" value={detail.dataDir ?? ''} copy />
        <Field label="Splits" value={splits.join(', ')} />
      </dl>
      {detail.apks.length > 0 && (
        <section aria-label="APK files" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            APK files
            <span className="text-muted-foreground font-normal">
              {' '}
              · {detail.apks.length}
              {apkTotal !== null && ` · ${fmtBytes(apkTotal)}`}
            </span>
          </h3>
          <ul className="flex flex-col gap-1.5">
            {detail.apks.map((apk) => (
              <li
                key={apk.path}
                className="bg-muted/30 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs font-medium">
                    {apkFileName(apk.path)}
                  </span>
                  <span className="text-muted-foreground block font-mono text-xs wrap-anywhere">
                    {apk.path}
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {fmtBytes(apk.size)}
                </span>
                <CopyButton text={apk.path} label={`Copy the path of ${apkFileName(apk.path)}`} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/**
 * "App details": opened from a row of the Apps tab. Reads `dumpsys package` and `pm path` when
 * it opens; the actions live in the tab, which also runs the exports (they outlive the sheet).
 */
export function AppSheet({
  device,
  lane,
  row,
  view,
  busy,
  exporting,
  timeZone,
  onOpenChange,
  onAction,
  onConfirm,
  onExport,
  onCancelExport,
  onCloseAutoFocus,
}: {
  device: Device
  lane: AppsLane
  /** The app shown; null closes the sheet. */
  row: AppRow | null
  view: BadgeView | null | undefined
  /** The action running on this app, if any. */
  busy: AppAction | undefined
  exporting: ExportProgress | undefined
  /** The phone's time zone name (persist.sys.timezone), for dumpsys's local times. */
  timeZone?: string
  onOpenChange: (open: boolean) => void
  onAction: (action: Exclude<AppAction, DestructiveAction>) => void
  onConfirm: (action: DestructiveAction) => void
  onExport: (detail: AppDetail) => void
  onCancelExport: () => void
  /** Where focus goes once it has closed; by default, back where it was. */
  onCloseAutoFocus?: (event: Event) => void
}) {
  const open = row !== null
  // What the sheet fades out with. It is inert while it closes, so nothing held here can act.
  const shown = {
    row: useHeldWhileClosing(open, row),
    view: useHeldWhileClosing(open, view),
    busy: useHeldWhileClosing(open, busy),
    exporting: useHeldWhileClosing(open, exporting),
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {shown.row && (
          // Keyed: another app's details start from loading, never from this one's.
          <SheetBody
            key={`${device.id}|${shown.row.packageName}`}
            device={device}
            lane={lane}
            row={shown.row}
            view={shown.view}
            busy={shown.busy}
            exporting={shown.exporting}
            timeZone={timeZone}
            onAction={onAction}
            onConfirm={onConfirm}
            onExport={onExport}
            onCancelExport={onCancelExport}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({
  device,
  lane,
  row,
  view,
  busy,
  exporting,
  timeZone,
  onAction,
  onConfirm,
  onExport,
  onCancelExport,
}: {
  device: Device
  lane: AppsLane
  row: AppRow
  view: BadgeView | null | undefined
  busy: AppAction | undefined
  exporting: ExportProgress | undefined
  timeZone: string | undefined
  onAction: (action: Exclude<AppAction, DestructiveAction>) => void
  onConfirm: (action: DestructiveAction) => void
  onExport: (detail: AppDetail) => void
  onCancelExport: () => void
}) {
  const [load, setLoad] = useState<DetailLoad>(() =>
    lane.app ? { status: 'loading' } : { status: 'unavailable' },
  )
  const [attempt, setAttempt] = useState(0)
  const name = view?.label ?? row.packageName

  const fetchDetail = useEffectEvent((isLive: () => boolean) => {
    if (!lane.app) return
    lane.app(device.id, row.packageName).then(
      (detail) => {
        if (isLive()) setLoad({ status: 'ready', detail })
      },
      (error: unknown) => {
        if (isLive()) setLoad({ status: 'failed', message: deviceErrorMessage(error) })
      },
    )
  })

  useEffect(() => {
    let live = true
    fetchDetail(() => live)
    return () => {
      live = false
    }
  }, [attempt])

  const detail = load.status === 'ready' ? load.detail : null
  const exportButton = useRef<HTMLButtonElement>(null)
  const exportNoteId = useId()
  const saves = exportNote(detail ? detail.apks.length : null)
  const exportable = detail !== null && detail.apks.length > 0 && canStartExport(busy, exporting)
  const uninstallable = canUninstall(busy, exporting)
  const can = Boolean(lane.appAction) && busy === undefined
  const actionButton = (
    action: Exclude<AppAction, DestructiveAction>,
    label: string,
    Icon: typeof Play,
  ) => (
    // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
    <Button
      variant="outline"
      size="sm"
      aria-disabled={!can}
      className="justify-start aria-disabled:opacity-50"
      onClick={() => {
        if (can) onAction(action)
      }}
    >
      {busy === action ? <Loader2 className="animate-spin" /> : <Icon />}
      {label}
    </Button>
  )

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <div className="flex min-w-0 items-center gap-3">
          <AppAvatar packageName={row.packageName} view={view} className="size-12 rounded-xl" />
          <div className="min-w-0">
            {/* App labels come from the APK: rendered as text, never markup. */}
            <SheetTitle className="text-lg wrap-anywhere">{name}</SheetTitle>
            <SheetDescription className="font-mono text-xs wrap-anywhere">
              {row.packageName}
            </SheetDescription>
          </div>
        </div>
        <StateBadges row={row} detail={detail} />
      </SheetHeader>

      <div className="flex flex-col gap-5 p-4">
        <section aria-label="Actions" className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            {actionButton('launch', 'Open', Play)}
            {actionButton('stop', 'Force stop', Square)}
            {actionButton('info', 'App info on phone', Info)}
            {lane.pull && (
              <Button
                ref={exportButton}
                variant="outline"
                size="sm"
                aria-disabled={!exportable}
                className="justify-start aria-disabled:opacity-50"
                title={detail ? undefined : 'Available once the details are read'}
                aria-describedby={saves && !exporting ? exportNoteId : undefined}
                onClick={() => {
                  if (exportable) onExport(detail)
                }}
              >
                {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                {EXPORT_LABEL}
              </Button>
            )}
          </div>
          {lane.pull && saves && !exporting && (
            <p id={exportNoteId} className="text-muted-foreground text-xs">
              {saves}
            </p>
          )}
          {exporting && (
            <ExportBar
              progress={exporting}
              onCancel={() => {
                // The bar and its button go once the export stops: keep focus in the sheet.
                exportButton.current?.focus()
                onCancelExport()
              }}
              // And when the export ends by itself while its Cancel has focus.
              returnFocus={() => exportButton.current?.focus()}
            />
          )}
        </section>

        <section aria-label="Details" className="flex flex-col gap-3">
          {load.status === 'loading' ? (
            <div className="flex flex-col gap-2" aria-label="Loading details">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-6" />
              ))}
            </div>
          ) : load.status === 'failed' ? (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">Couldn’t read the details of {name}</p>
                <p className="text-muted-foreground mt-0.5 wrap-anywhere">{load.message}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoad({ status: 'loading' })
                  setAttempt((n) => n + 1)
                }}
              >
                <RotateCcw /> Retry
              </Button>
            </div>
          ) : load.status === 'ready' ? (
            <Details row={row} detail={load.detail} timeZone={timeZone} />
          ) : (
            <dl className="divide-y">
              <Field label="Version" value={fmtVersion(null, row.versionCode)} />
              <Field label="Package" value={row.packageName} copy />
              <Field label="Installed by" value={installerName(row.installer)} />
              <Field label="Last updated" value={when(row.lastUpdated, null, timeZone)} />
            </dl>
          )}
        </section>

        {lane.appAction && (
          <>
            <Separator />
            <section aria-label="Destructive actions" className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs leading-relaxed">
                These delete data on {device.name}. Each one asks first.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-disabled={busy !== undefined}
                  className="text-destructive hover:text-destructive aria-disabled:opacity-50"
                  onClick={() => {
                    if (busy === undefined) onConfirm('clear')
                  }}
                >
                  {busy === 'clear' ? <Loader2 className="animate-spin" /> : <Eraser />}
                  Clear data…
                </Button>
                {/* System apps can't be uninstalled for good, so the entry isn't offered. */}
                {!row.system && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-disabled={!uninstallable}
                    className="text-destructive hover:text-destructive aria-disabled:opacity-50"
                    title={exporting ? UNINSTALL_WAITS : undefined}
                    onClick={() => {
                      if (uninstallable) onConfirm('uninstall')
                    }}
                  >
                    {busy === 'uninstall' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    Uninstall…
                  </Button>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  )
}

/** System, Disabled, Stopped, Debuggable: words, never colour alone. */
export function StateBadges({ row, detail }: { row: AppRow; detail?: AppDetail | null }) {
  const badges: string[] = []
  if (row.system) badges.push('System')
  if (row.enabled === false) badges.push('Disabled')
  if (row.stopped === true) badges.push('Stopped')
  if (detail?.debuggable) badges.push('Debuggable')
  if (detail?.testOnly) badges.push('Test-only')
  if (badges.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <Badge key={b} variant="outline" className="text-muted-foreground font-normal">
          {b === 'Debuggable' ? <AppWindow /> : null}
          {b}
        </Badge>
      ))}
    </div>
  )
}

function ExportBar({
  progress,
  onCancel,
  returnFocus,
}: {
  progress: ExportProgress
  onCancel: () => void
  returnFocus: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  useFocusAfterUnmount(cancel, returnFocus)
  return (
    <div className="flex items-center gap-3 rounded-lg border p-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs tabular-nums">{exportText(progress)}</p>
        <ExportMeter progress={progress} label="Export" className="mt-1.5" />
      </div>
      <Button ref={cancel} variant="ghost" size="sm" onClick={onCancel}>
        <X /> Cancel
      </Button>
    </div>
  )
}
