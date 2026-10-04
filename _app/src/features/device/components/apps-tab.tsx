import {
  ArrowDownUp,
  ClipboardCopy,
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
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/cn'

import { appMatches, installerName, sortApps, type AppSort } from '../backends/android/packages'
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
  actionMessages,
  apkFileName,
  badgeView,
  downloadName,
  fmtVersion,
  releaseBadgeView,
  storedZip,
  type AppsLane,
  type BadgeView,
  type DestructiveAction,
  type DownloadProgress,
  type PendingConfirm,
} from './app-sheet'

/*
  The Apps tab (PLAN §4.4): what is installed on the phone, newest update first, with a filter,
  User · System · All, and a sheet per app. Labels and icons are read out of each app's APK by
  the lane, lazily — only for rows on screen, two at a time, newest request first — and cached
  for the page's life by package, version code and update time. Until one arrives (or when an
  app has none Device Lab can draw) the row shows the package name and an initial.

  Destructive actions (Clear data, Uninstall) always go through ConfirmAppAction. Downloads are
  run here rather than in the sheet, so closing the sheet does not cancel one.
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

const APK_TYPE = 'application/vnd.android.package-archive'

/* ---------------------------------------------------------------- *
 * One row
 * ---------------------------------------------------------------- */

type RowAction = Exclude<AppAction, DestructiveAction>

function AppListItem({
  row,
  view,
  busy,
  canAct,
  onOpen,
  onAction,
  onConfirm,
  onVisible,
}: {
  row: AppRow
  view: BadgeView | null | undefined
  busy: AppAction | undefined
  canAct: boolean
  onOpen: () => void
  onAction: (action: RowAction) => void
  onConfirm: (action: DestructiveAction) => void
  onVisible: (row: AppRow, visible: boolean) => void
}) {
  const ref = useRef<HTMLLIElement>(null)
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
        onAction(action)
      }}
    >
      <Icon /> {label}
    </DropdownMenuItem>
  )

  return (
    <li ref={ref} className="flex items-center gap-1 pr-2">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'hover:bg-accent/50 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2.5 text-left transition-colors',
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
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
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {rowMeta(row, view)}
          </span>
        </span>
      </button>
      {canAct && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
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
            {item('launch', 'Open', Play)}
            {item('stop', 'Force stop', Square)}
            {item('info', 'App info on phone', Info)}
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
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={busy !== undefined}
              onSelect={() => {
                onConfirm('clear')
              }}
            >
              <Eraser /> Clear data…
            </DropdownMenuItem>
            {/* System apps can't be uninstalled for good, so the entry isn't offered. */}
            {!row.system && (
              <DropdownMenuItem
                variant="destructive"
                disabled={busy !== undefined}
                onSelect={() => {
                  onConfirm('uninstall')
                }}
              >
                <Trash2 /> Uninstall…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
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
  /** The page's polite live region (the store's announce), for downloads and lane actions. */
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
  const [downloads, setDownloads] = useState<ReadonlyMap<string, DownloadProgress>>(new Map())
  const transfers = useRef(new Map<string, AbortController>())
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

  /* Downloads end with the tab: the bytes would have nowhere to go. */
  useEffect(() => {
    const running = transfers.current
    return () => {
      for (const controller of running.values()) controller.abort()
    }
  }, [])

  const onVisible = (row: AppRow, visible: boolean) => {
    if (visible) onScreen.current.add(row.packageName)
    else onScreen.current.delete(row.packageName)
    if (badges.has(row.packageName)) return
    if (visible) queue.current?.want(row)
    else queue.current?.drop(row.packageName)
  }

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

  const startDownload = async (row: AppRow, detail: AppDetail) => {
    const pkg = row.packageName
    const pull = lane.pull
    if (!pull || transfers.current.has(pkg) || detail.apks.length === 0) return
    const controller = new AbortController()
    transfers.current.set(pkg, controller)
    const name = nameOf(row)
    const sizes = detail.apks.map((a) => a.size)
    const received = detail.apks.map(() => 0)
    let shownAt = 0
    const report = (force: boolean) => {
      const now = performance.now()
      if (!force && now - shownAt < 100) return
      shownAt = now
      const total = sizes.every((s) => s !== null)
        ? sizes.reduce<number>((n, s) => n + (s ?? 0), 0)
        : null
      const progress: DownloadProgress = {
        received: received.reduce((n, r) => n + r, 0),
        total,
        files: detail.apks.length,
      }
      setDownloads((current) => new Map(current).set(pkg, progress))
    }
    report(true)
    try {
      const files: { name: string; blob: Blob }[] = []
      for (const [i, apk] of detail.apks.entries()) {
        const blob = await pull(
          device.id,
          apk.path,
          (got, total) => {
            received[i] = got
            // 0 while the phone hasn't said.
            if (total > 0) sizes[i] = total
            report(false)
          },
          controller.signal,
        )
        received[i] = blob.size
        sizes[i] = blob.size
        files.push({ name: apkFileName(apk.path), blob })
      }
      report(true)
      const version =
        detail.versionName ?? (detail.versionCode === null ? '' : String(detail.versionCode))
      const fileName = downloadName(pkg, version, files.length)
      const single = files.length === 1 ? files[0] : undefined
      const out = single ? new Blob([single.blob], { type: APK_TYPE }) : await storedZip(files)
      saveBlob(out, fileName)
      toast.success(`Saved ${fileName}`, {
        description: single
          ? undefined
          : `A .zip of the app’s ${String(files.length)} APKs. Drop it on Device Lab to install it again.`,
      })
      onAnnounce?.(`Saved ${fileName}.`)
    } catch (error) {
      if (controller.signal.aborted) onAnnounce?.('Download cancelled.')
      else toast.error(`Couldn’t download ${name}`, { description: deviceErrorMessage(error) })
    } finally {
      transfers.current.delete(pkg)
      setDownloads((current) => {
        const next = new Map(current)
        next.delete(pkg)
        return next
      })
    }
  }

  const openRow = rows?.find((r) => r.packageName === openPkg) ?? null
  const canAct = Boolean(lane.appAction)

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
      <ul key={attempt} aria-label="Installed apps" className="-mx-2.5 flex flex-col">
        {shown.map((row) => (
          <AppListItem
            key={row.packageName}
            row={row}
            view={badges.get(row.packageName)}
            busy={busy.get(row.packageName)}
            canAct={canAct}
            onOpen={() => {
              setOpenPkg(row.packageName)
            }}
            onAction={(action) => {
              void runAction(row, action)
            }}
            onConfirm={(action) => {
              setConfirm({ row, name: nameOf(row), action })
            }}
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
        download={openRow ? downloads.get(openRow.packageName) : undefined}
        timeZone={timeZone}
        onOpenChange={(open) => {
          if (!open) setOpenPkg(null)
        }}
        onAction={(action) => {
          if (openRow) void runAction(openRow, action)
        }}
        onConfirm={(action) => {
          if (openRow) setConfirm({ row: openRow, name: nameOf(openRow), action })
        }}
        onDownload={(detail) => {
          if (openRow) void startDownload(openRow, detail)
        }}
        onCancelDownload={() => {
          if (openRow) transfers.current.get(openRow.packageName)?.abort()
        }}
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
      />
    </Card>
  )
}
