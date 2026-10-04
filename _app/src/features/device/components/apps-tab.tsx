import {
  ArrowDownUp,
  ClipboardCopy,
  Download,
  Eraser,
  Info,
  MoreHorizontal,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { untilAborted } from '@/lib/abort'
import { cn } from '@/lib/cn'

import { appMatches, installerName, sortApps, type AppSort } from '../backends/android/packages'
import { packApp, type PackedApp, type PulledApk } from '../backends/archive/xapk'
import {
  deviceErrorMessage,
  type AppAction,
  type AppBadge,
  type AppDetail,
  type AppRow,
  type AppScope,
} from '../backends/backend'
import { fmtDateTime, type Device } from '../model'
import {
  AppAvatar,
  AppSheet,
  ConfirmAppAction,
  EXPORT_LABEL,
  ExportMeter,
  actionMessages,
  UNINSTALL_WAITS,
  badgeView,
  canStartExport,
  canUninstall,
  exportShortText,
  fmtVersion,
  releaseBadgeView,
  useFocusAfterUnmount,
  type AppsLane,
  type BadgeView,
  type DestructiveAction,
  type ExportProgress,
  type PendingConfirm,
} from './app-sheet'

/*
  The Apps tab (PLAN §4.4): what is installed on the phone, newest update first, with a filter,
  User · System · All, and a sheet per app. Labels and icons are read out of each app's APK by
  the lane, lazily — only for rows on screen, two at a time, newest request first — and cached
  for the page's life by package, version code and update time. Until one arrives (or when an
  app has none Device Lab can draw) the row shows the package name and an initial.

  Destructive actions (Clear data, Uninstall) always go through ConfirmAppAction. Exports (from
  a row's menu or the sheet) are run here rather than in the sheet, so closing the sheet does
  not cancel one; the row shows its progress and a Cancel.

  Rows are memoized and every callback they get keeps its identity, so opening the sheet, a
  menu or a dialog, a badge arriving or an export ticking re-renders only the row it is about.
*/

export type { AppsLane } from './app-sheet'

/* ---------------------------------------------------------------- *
 * Badges: lazily read, cached, drawn from blob URLs
 * ---------------------------------------------------------------- */

/** Enough for every app on two or three phones; the oldest are released past it. */
const BADGE_CACHE_LIMIT = 1500
/** Reads over USB at once: each is a handful of `tail | head` pieces of the APK. */
export const BADGE_CONCURRENCY = 2

/** A read badge; null when the APK had nothing to show or could not be read. */
const badgeCache = new Map<string, BadgeView | null>()

/** An update changes the APK, so it changes the key: the new label and icon are read again. */
export const badgeKey = (deviceId: string, row: AppRow) =>
  [deviceId, row.packageName, row.versionCode ?? '', row.lastUpdated ?? ''].join('|')

function cacheBadge(key: string, view: BadgeView | null) {
  badgeCache.delete(key)
  badgeCache.set(key, view)
  for (const [old, dropped] of badgeCache) {
    if (badgeCache.size <= BADGE_CACHE_LIMIT) break
    badgeCache.delete(old)
    releaseBadgeView(dropped)
  }
}

/** Failed reads for one phone, forgotten so Refresh tries them again. */
function forgetFailedBadges(deviceId: string) {
  for (const [key, view] of badgeCache) {
    if (view === null && key.startsWith(`${deviceId}|`)) badgeCache.delete(key)
  }
}

export interface BadgeQueue {
  /** The row is on screen: read its badge unless it is cached, running or waiting. */
  want(row: AppRow): void
  /** The row left the screen before its turn: skip it. */
  drop(packageName: string): void
  /** Abandon everything; nothing is reported after this. */
  stop(): void
}

/**
 * Reads badges for rows on screen, `concurrency` at a time, the most recently wanted first (the
 * rows the tester scrolled to, not the ones scrolled past). A failed read is cached as null, so
 * a broken APK is not read again on every scroll; an abandoned one is not cached at all.
 */
export function createBadgeQueue({
  deviceId,
  load,
  onBadge,
  concurrency = BADGE_CONCURRENCY,
}: {
  deviceId: string
  load: (row: AppRow, signal: AbortSignal) => Promise<AppBadge | null>
  onBadge: (row: AppRow, view: BadgeView | null) => void
  concurrency?: number
}): BadgeQueue {
  const controller = new AbortController()
  const waiting = new Map<string, AppRow>()
  const running = new Set<string>()

  const pump = () => {
    while (running.size < concurrency && !controller.signal.aborted) {
      const next = Array.from(waiting.values()).at(-1)
      if (!next) return
      waiting.delete(next.packageName)
      running.add(next.packageName)
      const key = badgeKey(deviceId, next)
      load(next, controller.signal)
        .then(
          (badge) => (badge ? badgeView(badge) : null),
          () => null,
        )
        .then((view) => {
          running.delete(next.packageName)
          if (controller.signal.aborted) {
            releaseBadgeView(view)
            return
          }
          cacheBadge(key, view)
          onBadge(next, view)
          pump()
        })
        .catch(() => undefined)
    }
  }

  return {
    want(row) {
      const cached = badgeCache.get(badgeKey(deviceId, row))
      if (cached !== undefined) {
        onBadge(row, cached)
        return
      }
      if (running.has(row.packageName)) return
      // Re-wanted rows move to the front of the line.
      waiting.delete(row.packageName)
      waiting.set(row.packageName, row)
      pump()
    },
    drop(packageName) {
      waiting.delete(packageName)
    },
    stop() {
      controller.abort()
      waiting.clear()
    },
  }
}

/** Every row's badge already in the cache, so a revisited list draws its icons at once. */
function cachedBadges(deviceId: string, rows: readonly AppRow[]): Map<string, BadgeView | null> {
  const out = new Map<string, BadgeView | null>()
  for (const row of rows) {
    const view = badgeCache.get(badgeKey(deviceId, row))
    if (view !== undefined) out.set(row.packageName, view)
  }
  return out
}

/** The fetched rows that are on screen but have no badge to draw: they must be asked for. */
export function staleOnScreen(
  rows: readonly AppRow[],
  badges: ReadonlyMap<string, BadgeView | null>,
  onScreen: ReadonlySet<string>,
): AppRow[] {
  return rows.filter((row) => onScreen.has(row.packageName) && !badges.has(row.packageName))
}

/** Package → label, for the filter and the Name sort. */
function labelsOf(badges: ReadonlyMap<string, BadgeView | null>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [pkg, view] of badges) if (view?.label) out.set(pkg, view.label)
  return out
}

/* ---------------------------------------------------------------- *
 * Visibility: one IntersectionObserver for every row
 * ---------------------------------------------------------------- */

const watchers = new WeakMap<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

/** Calls back as `el` comes within a screen's margin of view and leaves it. */
function watchVisibility(el: Element, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    // No observer (old browser, test DOM): every row counts as on screen.
    onChange(true)
    return () => undefined
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting)
    },
    { rootMargin: '200px 0px' },
  )
  watchers.set(el, onChange)
  observer.observe(el)
  return () => {
    observer?.unobserve(el)
    watchers.delete(el)
  }
}

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

const SCOPES: readonly { value: AppScope; label: string }[] = [
  { value: 'user', label: 'User' },
  { value: 'system', label: 'System' },
  { value: 'all', label: 'All' },
]

const isScope = (value: string): value is AppScope => SCOPES.some((s) => s.value === value)

const SORTS: readonly { value: AppSort; label: string }[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' },
]

const isSort = (value: string): value is AppSort => SORTS.some((s) => s.value === value)

/** The app after `pkg` in the list as shown, or before it when it was the last; null when alone. */
export function neighbourOf(shown: readonly AppRow[], pkg: string): string | null {
  const at = shown.findIndex((r) => r.packageName === pkg)
  if (at < 0) return null
  return (shown[at + 1] ?? shown[at - 1])?.packageName ?? null
}

/** "1 app", "12 apps", "3 of 12 apps". */
export function countText(shown: number, total: number): string {
  const noun = total === 1 ? 'app' : 'apps'
  return shown === total
    ? `${String(total)} ${noun}`
    : `${String(shown)} of ${String(total)} ${noun}`
}

/** What an empty list means in each scope, and what to do next. */
export function emptyCopy(scope: AppScope): { readonly title: string; readonly body: string } {
  switch (scope) {
    case 'user':
      return {
        title: 'No apps installed on top of Android',
        body: 'Apps from a store or an install show here. Choose System or All to see Android’s own apps.',
      }
    case 'system':
      return { title: 'No system apps listed', body: 'Android listed none. Refresh to ask again.' }
    case 'all':
      return {
        title: 'No apps listed',
        body: 'Android returned an empty list. Refresh to ask again.',
      }
  }
}

/** The second line of a row: package (when a label stands above it), version, installer, update. */
export function rowMeta(row: AppRow, view: BadgeView | null | undefined): string {
  return [
    view?.label ? row.packageName : '',
    fmtVersion(null, row.versionCode),
    installerName(row.installer),
    row.lastUpdated === null ? '' : `Updated ${fmtDateTime(new Date(row.lastUpdated))}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Save a Blob under `fileName` through the browser's download. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  // Late enough for the download to have taken the bytes.
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60_000)
}

/** The toast under "Saved …": what the file is and how to install it again. */
export function savedCopy(packed: Pick<PackedApp, 'kind' | 'apks'>): string {
  if (packed.kind === 'apk') {
    return 'To install it again, drop it on Device Lab or use adb install.'
  }
  return `The app’s ${String(packed.apks)} APKs in one .xapk. To install it, drop it on Device Lab, or open it with SAI or APKPure on the phone. adb install can’t install an .xapk.`
}

/* ---------------------------------------------------------------- *
 * Exports in flight
 * ---------------------------------------------------------------- */

/*
 * Kept outside the tab, per device: an export goes on when the tab is left (the file is saved
 * and the toast shows wherever the user is), and the tab shows it again, with its Cancel, when
 * it comes back.
 */
const exportControllers = new Map<string, AbortController>()
const exportProgress = new Map<string, ReadonlyMap<string, ExportProgress>>()
const exportListeners = new Set<() => void>()
const NO_EXPORTS: ReadonlyMap<string, ExportProgress> = new Map()
const exportKey = (deviceId: string, pkg: string) => `${deviceId}\n${pkg}`

function subscribeExports(listener: () => void): () => void {
  exportListeners.add(listener)
  return () => {
    exportListeners.delete(listener)
  }
}

/** This device's exports by package. A new Map only when one of them moved. */
const exportsOf = (deviceId: string) => exportProgress.get(deviceId) ?? NO_EXPORTS

function setExportProgress(deviceId: string, pkg: string, progress: ExportProgress | null) {
  const next = new Map(exportsOf(deviceId))
  if (progress) next.set(pkg, progress)
  else next.delete(pkg)
  if (next.size > 0) exportProgress.set(deviceId, next)
  else exportProgress.delete(deviceId)
  for (const listener of exportListeners) listener()
}

/** Cancels every export in flight, of one device or of all. */
export function cancelExports(deviceId?: string) {
  for (const [key, controller] of exportControllers) {
    if (deviceId === undefined || key.startsWith(`${deviceId}\n`)) controller.abort()
  }
}

/**
 * A function whose identity never changes but always runs the latest `fn`: what a memoized row
 * is handed, so the tab's re-renders don't reach rows that did not change.
 */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}

/* ---------------------------------------------------------------- *
 * One row
 * ---------------------------------------------------------------- */

type RowAction = Exclude<AppAction, DestructiveAction>

interface AppListItemProps {
  row: AppRow
  view: BadgeView | null | undefined
  busy: AppAction | undefined
  /** This app's export, while one runs. */
  exporting: ExportProgress | undefined
  canAct: boolean
  canExport: boolean
  onOpen: (packageName: string) => void
  onAction: (row: AppRow, action: RowAction) => void
  onConfirm: (row: AppRow, action: DestructiveAction) => void
  onExport: (row: AppRow) => void
  onCancelExport: (packageName: string) => void
  onVisible: (row: AppRow, visible: boolean) => void
}

/** Memoized: every prop is a value of this row or a callback that keeps its identity. */
const AppListItem = memo(function AppListItem({
  row,
  view,
  busy,
  exporting,
  canAct,
  canExport,
  onOpen,
  onAction,
  onConfirm,
  onExport,
  onCancelExport,
  onVisible,
}: AppListItemProps) {
  const ref = useRef<HTMLLIElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const name = view?.label ?? row.packageName
  const visibility = useEffectEvent((visible: boolean) => {
    onVisible(row, visible)
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const unwatch = watchVisibility(el, (visible) => {
      visibility(visible)
    })
    return () => {
      unwatch()
      // A row that leaves the list (filtered out, list replaced) is no longer on screen.
      visibility(false)
    }
  }, [])

  const item = (action: RowAction, label: string, Icon: typeof Play) => (
    <DropdownMenuItem
      disabled={busy !== undefined}
      onSelect={() => {
        onAction(row, action)
      }}
    >
      <Icon /> {label}
    </DropdownMenuItem>
  )

  return (
    // content-visibility: with hundreds of apps, opening any overlay restyles the whole page
    // (the scroll lock, pointer-events on <body>); rows off screen are skipped. It also clips
    // paint to the row, so the row's focus ring is drawn inset.
    <li
      ref={ref}
      data-package={row.packageName}
      className="relative flex items-center gap-1 pr-2 [contain-intrinsic-size:auto_58px] [content-visibility:auto]"
    >
      <button
        type="button"
        onClick={() => {
          onOpen(row.packageName)
        }}
        className={cn(
          'hover:bg-accent/50 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2.5 text-left transition-colors',
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] focus-visible:ring-inset',
        )}
      >
        <AppAvatar packageName={row.packageName} view={view} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Labels come from the APK: rendered as text, never markup. */}
            <span className={cn('truncate font-medium', !view?.label && 'font-mono text-sm')}>
              {name}
            </span>
            {row.system && <RowBadge>System</RowBadge>}
            {row.enabled === false && <RowBadge>Disabled</RowBadge>}
            {row.stopped === true && <RowBadge>Stopped</RowBadge>}
          </span>
          <span
            className={cn(
              'text-muted-foreground mt-0.5 block truncate text-xs',
              exporting && 'tabular-nums',
            )}
          >
            {exporting ? exportShortText(exporting) : rowMeta(row, view)}
          </span>
        </span>
      </button>
      {exporting && (
        <>
          <ExportMeter
            progress={exporting}
            label={`Export of ${name}`}
            className="absolute right-2 bottom-0.5 left-[3.625rem] h-0.5"
          />
          <CancelExport
            name={name}
            onCancel={() => {
              onCancelExport(row.packageName)
            }}
            returnFocus={() => trigger.current?.focus()}
          />
        </>
      )}
      {(canAct || canExport) && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`More actions for ${name}`}
              title="More actions"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {canAct && (
              <>
                {item('launch', 'Open', Play)}
                {item('stop', 'Force stop', Square)}
                {item('info', 'App info on phone', Info)}
              </>
            )}
            {canExport && (
              // One export per app at a time; its progress and Cancel are on the row.
              <DropdownMenuItem
                disabled={!canStartExport(busy, exporting)}
                onSelect={() => {
                  onExport(row)
                }}
              >
                <Download /> {EXPORT_LABEL}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                navigator.clipboard.writeText(row.packageName).then(
                  () => toast.success('Copied', { description: row.packageName }),
                  () =>
                    toast.error('Copy failed', {
                      description: 'Select the text and copy it by hand.',
                    }),
                )
              }}
            >
              <ClipboardCopy /> Copy package name
            </DropdownMenuItem>
            {canAct && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy !== undefined}
                  onSelect={() => {
                    onConfirm(row, 'clear')
                  }}
                >
                  <Eraser /> Clear data…
                </DropdownMenuItem>
                {/* System apps can't be uninstalled for good, so the entry isn't offered. */}
                {!row.system && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!canUninstall(busy, exporting)}
                    title={exporting ? UNINSTALL_WAITS : undefined}
                    onSelect={() => {
                      onConfirm(row, 'uninstall')
                    }}
                  >
                    <Trash2 /> Uninstall…
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
})

/**
 * The row's Cancel while an export runs. It goes away when the export ends; if it had focus
 * then, focus moves to the row's menu button instead of falling to <body>.
 */
function CancelExport({
  name,
  onCancel,
  returnFocus,
}: {
  name: string
  onCancel: () => void
  returnFocus: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useFocusAfterUnmount(ref, returnFocus)
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label={`Cancel export of ${name}`}
      title="Cancel export"
      onClick={onCancel}
    >
      <X />
    </Button>
  )
}

function RowBadge({ children }: { children: string }) {
  return (
    <Badge variant="outline" className="text-muted-foreground shrink-0 px-1.5 py-0 font-normal">
      {children}
    </Badge>
  )
}

function LoadingRows() {
  return (
    <ul aria-label="Loading apps" className="flex flex-col">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <li key={i} className="flex items-center gap-3 p-2.5">
          <Skeleton className="size-9 rounded-lg" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center rounded-lg border border-dashed px-4 py-10 text-center text-sm">
      <Package className="mb-3 size-8 opacity-60" />
      <p className="text-foreground font-medium">{title}</p>
      <p className="mt-1 max-w-sm">{body}</p>
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * The tab
 * ---------------------------------------------------------------- */

type ListLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly AppRow[] }
  | { readonly status: 'failed'; readonly message: string }

export interface AppsTabProps {
  device: Device
  /** The device's lane: the selected device's Backend. */
  lane: AppsLane
  /** Bump it to reload the list quietly, e.g. after an install finished on this device. */
  reloadKey?: number
  /** The phone's time zone name, for the times dumpsys prints without an offset. */
  timeZone?: string
  /**
   * The store's appAction for this device (lab.appAction bound to its id): it announces the
   * result, and an uninstall bumps appsRevision, which should come back as `reloadKey`. Without
   * it the tab calls the lane itself and announces through `onAnnounce`.
   */
  act?: (pkg: string, action: AppAction) => Promise<string | null>
  /** The page's polite live region (the store's announce), for exports and lane actions. */
  onAnnounce?: (text: string) => void
}

/** The Apps tab for one device. Its state starts over when the device changes. */
export function AppsTab(props: AppsTabProps) {
  return <AppsTabBody key={props.device.id} {...props} />
}

function AppsTabBody({ device, lane, reloadKey = 0, timeZone, act, onAnnounce }: AppsTabProps) {
  const [scope, setScope] = useState<AppScope>('user')
  const [sort, setSort] = useState<AppSort>('updated')
  const [filter, setFilter] = useState('')
  const [list, setList] = useState<ListLoad>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [badges, setBadges] = useState<ReadonlyMap<string, BadgeView | null>>(new Map())
  /**
   * The labels the order was computed with. Frozen until the next sort, filter, scope or
   * refresh, so rows don't jump under the pointer while labels stream in.
   */
  const [orderLabels, setOrderLabels] = useState<ReadonlyMap<string, string>>(new Map())
  const [openPkg, setOpenPkg] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlyMap<string, AppAction>>(new Map())
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  /**
   * After an uninstall, where focus goes: the uninstalled app's row is gone, and focus would
   * fall to <body>, losing the user's place in the list. `pkg` is the row that takes it; null
   * when no row is left to take it (the only one shown was uninstalled), and the filter or
   * Refresh does.
   */
  const focusAfter = useRef<{ readonly pkg: string | null } | null>(null)
  const listEl = useRef<HTMLUListElement>(null)
  const filterEl = useRef<HTMLInputElement>(null)
  const refreshEl = useRef<HTMLButtonElement>(null)
  const exporting = useSyncExternalStore(subscribeExports, () => exportsOf(device.id))
  const queue = useRef<BadgeQueue | null>(null)
  /**
   * Packages whose row is on screen now. A row that stays in view gets no new visibility
   * callback, so after a list fetch this is how its missing badge is asked for again.
   */
  const onScreen = useRef(new Set<string>())

  const ready = device.state === 'ready'
  const rows = list.status === 'ready' ? list.rows : null
  const labels = useMemo(() => labelsOf(badges), [badges])
  const nameOf = (row: AppRow) => badges.get(row.packageName)?.label ?? row.packageName

  /* The list: read on mount, on scope change, on Retry/Refresh, and when reloadKey moves. */
  const fetchList = useEffectEvent((isLive: () => boolean) => {
    if (!lane.apps || !ready) return
    lane.apps(device.id, scope).then(
      (fresh) => {
        if (!isLive()) return
        const cached = cachedBadges(device.id, fresh)
        setBadges(cached)
        setOrderLabels(labelsOf(cached))
        setList({ status: 'ready', rows: fresh })
        setRefreshing(false)
        // An app updated in place has a new badge key, so its badge was just dropped; its row
        // never left the screen, so nothing else would read the new one.
        for (const row of staleOnScreen(fresh, cached, onScreen.current)) queue.current?.want(row)
      },
      (error: unknown) => {
        if (!isLive()) return
        setList({ status: 'failed', message: deviceErrorMessage(error) })
        setRefreshing(false)
      },
    )
  })

  useEffect(() => {
    let live = true
    fetchList(() => live)
    return () => {
      live = false
    }
  }, [scope, attempt, reloadKey, ready])

  /* Badges for rows on screen. */
  useEffect(() => {
    const read = lane.appBadge
    if (!read) return
    const q = createBadgeQueue({
      deviceId: device.id,
      load: (row, signal) => read(device.id, row.packageName, signal),
      onBadge: (row, view) => {
        setBadges((current) => new Map(current).set(row.packageName, view))
      },
    })
    queue.current = q
    return () => {
      q.stop()
      queue.current = null
    }
  }, [device.id, lane])

  const onVisible = useStableCallback((row: AppRow, visible: boolean) => {
    if (visible) onScreen.current.add(row.packageName)
    else onScreen.current.delete(row.packageName)
    if (badges.has(row.packageName)) return
    if (visible) queue.current?.want(row)
    else queue.current?.drop(row.packageName)
  })

  const shown = useMemo(
    () =>
      rows
        ? sortApps(
            rows.filter((r) => appMatches(r, filter, labels.get(r.packageName))),
            sort,
            orderLabels,
          )
        : [],
    [rows, filter, labels, sort, orderLabels],
  )

  const reload = () => {
    forgetFailedBadges(device.id)
    setBadges((current) => new Map(Array.from(current).filter(([, view]) => view !== null)))
    setRefreshing(true)
    setAttempt((n) => n + 1)
  }

  const patchRow = (pkg: string, patch: Partial<AppRow> | null) => {
    setList((current) => {
      if (current.status !== 'ready') return current
      const next = patch
        ? current.rows.map((r) => (r.packageName === pkg ? { ...r, ...patch } : r))
        : current.rows.filter((r) => r.packageName !== pkg)
      return { status: 'ready', rows: next }
    })
  }

  /** Resolves to null on success, or the failure's wording. */
  const perform = async (pkg: string, action: AppAction, done: string): Promise<string | null> => {
    if (act) return act(pkg, action)
    if (!lane.appAction) return deviceErrorMessage(new Error('DEVICE_NOT_READY'))
    try {
      await lane.appAction(device.id, pkg, action)
    } catch (error) {
      return deviceErrorMessage(error)
    }
    onAnnounce?.(done)
    return null
  }

  const runAction = async (row: AppRow, action: AppAction) => {
    const pkg = row.packageName
    if (!lane.appAction || busy.has(pkg)) return
    // The menu and the sheet hold Uninstall back during an export of the app; so does this.
    if (action === 'uninstall' && exportControllers.has(exportKey(device.id, pkg))) return
    const words = actionMessages(action, nameOf(row), device.name)
    setBusy((current) => new Map(current).set(pkg, action))
    try {
      const failure = await perform(pkg, action, words.done)
      if (failure !== null) {
        toast.error(words.failed, { description: failure })
        return
      }
      toast.success(words.done)
      if (action === 'launch') patchRow(pkg, { stopped: false })
      // Clearing data force-stops the app too.
      if (action === 'stop' || action === 'clear') patchRow(pkg, { stopped: true })
      if (action === 'uninstall') {
        focusAfter.current = { pkg: neighbourOf(shown, pkg) }
        patchRow(pkg, null)
        setOpenPkg((open) => (open === pkg ? null : open))
        // And ask the phone again, quietly: the list is the phone's, not a guess. Through the
        // store, its appsRevision comes back as reloadKey instead.
        if (!act) setAttempt((n) => n + 1)
      }
    } finally {
      setBusy((current) => {
        const next = new Map(current)
        next.delete(pkg)
        return next
      })
      setConfirm((pending) => (pending?.row.packageName === pkg ? null : pending))
    }
  }

  /**
   * Pulls every APK `pm path` lists and saves them as one file: the APK itself, or an .xapk for
   * a split app. From a row the APKs are listed first; the sheet passes the details it read.
   */
  const startExport = async (row: AppRow, known?: AppDetail) => {
    const pkg = row.packageName
    const { pull, app } = lane
    // Everything below outlives the tab: it uses only what it captured here.
    const deviceId = device.id
    const key = exportKey(deviceId, pkg)
    if (!pull || (!known && !app) || exportControllers.has(key)) return
    const controller = new AbortController()
    const { signal } = controller
    exportControllers.set(key, controller)
    const name = nameOf(row)
    const icon = badges.get(pkg)?.icon
    const show = (progress: ExportProgress) => {
      setExportProgress(deviceId, pkg, progress)
    }
    /** At most every 100 ms, except when `force`d: a fast pull reports far more often. */
    let shownAt = 0
    const showSoon = (progress: ExportProgress, force: boolean) => {
      const now = performance.now()
      if (!force && now - shownAt < 100) return
      shownAt = now
      show(progress)
    }
    show({ phase: 'reading', received: 0, total: null, files: 0 })
    onAnnounce?.(`Exporting ${name}.`)
    try {
      const detail = known ?? (app ? await untilAborted(app(deviceId, pkg), signal) : null)
      signal.throwIfAborted()
      if (!detail || detail.apks.length === 0) {
        throw new Error('Android listed no APK files for this app.')
      }
      const files = detail.apks.length
      const sizes = detail.apks.map((a) => a.size)
      const received = detail.apks.map(() => 0)
      const report = (force: boolean) => {
        const total = sizes.every((s) => s !== null)
          ? sizes.reduce<number>((n, s) => n + (s ?? 0), 0)
          : null
        const got = received.reduce((n, r) => n + r, 0)
        showSoon({ phase: 'pulling', received: got, total, files }, force)
      }
      report(true)
      const pulled: PulledApk[] = []
      for (const [i, apk] of detail.apks.entries()) {
        const blob = await pull(
          deviceId,
          apk.path,
          (got, total) => {
            received[i] = got
            // 0 while the phone hasn't said.
            if (total > 0) sizes[i] = total
            report(false)
          },
          signal,
        )
        received[i] = blob.size
        sizes[i] = blob.size
        pulled.push({ path: apk.path, blob })
      }
      const packed = await packApp(
        {
          packageName: pkg,
          name,
          versionCode: detail.versionCode,
          versionName: detail.versionName,
          minSdk: detail.minSdk,
          targetSdk: detail.targetSdk,
        },
        pulled,
        {
          icon: icon?.kind === 'bitmap' ? icon.blob : null,
          signal,
          onProgress: (done, total) => {
            showSoon({ phase: 'packing', received: done, total, files }, done === 0)
          },
        },
      )
      signal.throwIfAborted()
      saveBlob(packed.blob, packed.fileName)
      toast.success(`Saved ${packed.fileName}`, { description: savedCopy(packed) })
      onAnnounce?.(`Saved ${packed.fileName}.`)
    } catch (error) {
      if (signal.aborted) onAnnounce?.('Export cancelled.')
      else toast.error(`Couldn’t export ${name}`, { description: deviceErrorMessage(error) })
    } finally {
      exportControllers.delete(key)
      setExportProgress(deviceId, pkg, null)
    }
  }

  /* What the rows are handed: callbacks that keep their identity across the tab's renders. */
  const openApp = useStableCallback((pkg: string) => {
    focusAfter.current = null
    setOpenPkg(pkg)
  })
  const rowAction = useStableCallback((row: AppRow, action: RowAction) => {
    void runAction(row, action)
  })
  const rowConfirm = useStableCallback((row: AppRow, action: DestructiveAction) => {
    focusAfter.current = null
    setConfirm({ row, name: nameOf(row), action })
  })
  const rowExport = useStableCallback((row: AppRow) => {
    void startExport(row)
  })
  const cancelExport = useStableCallback((pkg: string) => {
    exportControllers.get(exportKey(device.id, pkg))?.abort()
  })

  /** The row's own button (the one that opens the sheet), while the row is listed. */
  const rowButton = (pkg: string) =>
    Array.from(listEl.current?.children ?? [])
      .find((el) => el instanceof HTMLElement && el.dataset.package === pkg)
      ?.querySelector<HTMLElement>(':scope > button') ?? null

  /**
   * onCloseAutoFocus for the sheet and the confirmation, once an uninstall took a row away: the
   * next row, else the filter that still holds the query that left it alone, else Refresh.
   */
  const focusNeighbour = (event: Event) => {
    const after = focusAfter.current
    if (after === null) return
    const target =
      after.pkg === null ? (filter ? filterEl.current : refreshEl.current) : rowButton(after.pkg)
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  const openRow = rows?.find((r) => r.packageName === openPkg) ?? null
  const canAct = Boolean(lane.appAction)
  const canExport = Boolean(lane.pull && lane.app)

  let body
  if (!lane.apps) {
    body = (
      <EmptyState
        title="This device can’t list its apps here"
        body="Apps are listed for Android phones connected over USB in Chrome or Edge."
      />
    )
  } else if (!ready) {
    body = <EmptyState title="Not ready yet" body="Apps appear once the device is ready." />
  } else if (list.status === 'loading') {
    body = <LoadingRows />
  } else if (list.status === 'failed') {
    body = (
      <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Couldn’t read the app list from {device.name}</p>
          <p className="text-muted-foreground mt-0.5 wrap-anywhere">{list.message}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setList({ status: 'loading' })
            reload()
          }}
        >
          <RotateCcw /> Retry
        </Button>
      </div>
    )
  } else if (list.rows.length === 0) {
    body = <EmptyState {...emptyCopy(scope)} />
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        title={`Nothing matches “${filter.trim()}”`}
        body="Clear the filter, or choose All."
      />
    )
  } else {
    body = (
      // Keyed by attempt: after a refresh every row reports itself on screen again, so badges
      // that failed before are asked for once more.
      <ul ref={listEl} key={attempt} aria-label="Installed apps" className="-mx-2.5 flex flex-col">
        {shown.map((row) => (
          <AppListItem
            key={row.packageName}
            row={row}
            view={badges.get(row.packageName)}
            busy={busy.get(row.packageName)}
            exporting={exporting.get(row.packageName)}
            canAct={canAct}
            canExport={canExport}
            onOpen={openApp}
            onAction={rowAction}
            onConfirm={rowConfirm}
            onExport={rowExport}
            onCancelExport={cancelExport}
            onVisible={onVisible}
          />
        ))}
      </ul>
    )
  }

  const sortLabel = SORTS.find((s) => s.value === sort)?.label ?? ''

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Apps</CardTitle>
        <CardDescription>
          {rows ? `${countText(shown.length, rows.length)} on ${device.name}` : device.name}
        </CardDescription>
        <CardAction>
          {/* aria-disabled, not disabled: disabling the focused button drops focus to <body>. */}
          <Button
            ref={refreshEl}
            variant="outline"
            size="sm"
            aria-disabled={refreshing || list.status === 'loading' || !lane.apps || !ready}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (refreshing || list.status === 'loading' || !lane.apps || !ready) return
              reload()
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            ref={filterEl}
            type="search"
            placeholder="Filter by name, package or installer"
            aria-label="Filter apps"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setOrderLabels(labels)
            }}
            className="sm:max-w-xs"
          />
          {/* A segmented control, as the platform filter draws it: one choice, never none. */}
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(value) => {
              if (!isScope(value) || value === scope) return
              setScope(value)
              setList({ status: 'loading' })
            }}
            aria-label="Which apps"
            className="bg-muted text-foreground/75 h-9 w-full rounded-lg p-[3px] sm:w-auto"
          >
            {SCOPES.map(({ value, label }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className={cn(
                  'h-full flex-1 rounded-md border border-transparent px-3 data-[spacing=0]:rounded-md',
                  'hover:text-foreground hover:bg-transparent',
                  'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
                  'dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30',
                )}
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 sm:ml-auto">
                <ArrowDownUp /> {sortLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) => {
                  if (!isSort(value)) return
                  setSort(value)
                  setOrderLabels(labels)
                }}
              >
                {SORTS.map(({ value, label }) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {body}
      </CardContent>

      <AppSheet
        device={device}
        lane={lane}
        row={openRow}
        view={openRow ? badges.get(openRow.packageName) : undefined}
        busy={openRow ? busy.get(openRow.packageName) : undefined}
        exporting={openRow ? exporting.get(openRow.packageName) : undefined}
        timeZone={timeZone}
        onOpenChange={(open) => {
          if (!open) setOpenPkg(null)
        }}
        onAction={(action) => {
          if (openRow) void runAction(openRow, action)
        }}
        onConfirm={(action) => {
          focusAfter.current = null
          if (openRow) setConfirm({ row: openRow, name: nameOf(openRow), action })
        }}
        onExport={(detail) => {
          if (openRow) void startExport(openRow, detail)
        }}
        onCancelExport={() => {
          if (openRow) cancelExport(openRow.packageName)
        }}
        onCloseAutoFocus={focusNeighbour}
      />
      <ConfirmAppAction
        device={device}
        pending={confirm}
        running={confirm !== null && busy.get(confirm.row.packageName) === confirm.action}
        onCancel={() => {
          setConfirm(null)
        }}
        onConfirm={(pending) => {
          void runAction(pending.row, pending.action)
        }}
        onCloseAutoFocus={focusNeighbour}
      />
    </Card>
  )
}
