import {
  CalendarDays,
  HardDrive,
  Package,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

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
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PlatformIcon } from '@/features/device/components/platform-icon'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'
import { useHeldWhileClosing } from '@/lib/use-held-while-closing'

import { PageHeader, StatCard } from '../components/page-header'
import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { formatBytes, formatDateTime } from '../format'
import { XCONSOLE_MESSAGES } from '../messages'
import { AuthError, hasReleases, type Repo } from '../repo/github'
import { BuildCard } from './build-card'
import { BuildSheet, type BuildSheetTarget } from './build-sheet'
import { BUILD_MESSAGES } from './messages'
import {
  deleteBuildRelease,
  matchesBuild,
  planBuildDelete,
  readBuildDb,
  storageUsed,
} from './model'
import { BUILD_DB_PATH, SITE_BUDGET_BYTES, buildDir } from './paths'
import type { BuildDb, BuildEntry, BuildPlatform } from './types'

type State =
  | { status: 'loading' }
  | { status: 'ready'; db: BuildDb }
  /**
   * Builds exist but their index does not. Never shown as an empty list: an upload would
   * overwrite the real one.
   */
  | { status: 'missing' }
  /** `message` is null when the failure came without one: the page words that itself. */
  | { status: 'failed'; message: string | null; auth: boolean }

async function loadBuilds(repo: Repo): Promise<State> {
  try {
    const db = await readBuildDb(repo)
    return db === null ? { status: 'missing' } : { status: 'ready', db }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : null,
      auth: error instanceof AuthError,
    }
  }
}

type PlatformFilter = 'all' | BuildPlatform

const PLATFORM_FILTERS: readonly PlatformFilter[] = ['all', 'android', 'ios']

const isPlatformFilter = (value: string): value is PlatformFilter =>
  PLATFORM_FILTERS.some((f) => f === value)

/** Builds: the APKs and IPAs shared with testers, and the sheet that uploads and edits them. */
export function BuildsPage() {
  const { repo, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = useMessages(BUILD_MESSAGES).page
  const locale = useLocale()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [sheet, setSheet] = useState<BuildSheetTarget | null>(null)
  const [deleting, setDeleting] = useState<BuildEntry | null>(null)
  /** Its name stays in the dialog while it fades out. */
  const shownDeleting = useHeldWhileClosing(deleting !== null, deleting)
  /** A delete is committing: every other change waits, so two cannot interleave. */
  const [committing, setCommitting] = useState(false)
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    void loadBuilds(repo).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [repo])

  const reload = () => {
    setState({ status: 'loading' })
    void loadBuilds(repo).then(setState)
  }

  const closeSheet = useCallback(() => {
    setSheet(null)
  }, [])

  const showIndex = useCallback((db: BuildDb) => {
    setState({ status: 'ready', db })
  }, [])

  const confirmDelete = async (entry: BuildEntry) => {
    setCommitting(true)
    const id = toast.loading(t.deleting(entry.name))
    try {
      // Read at one commit and build on that same commit: if anything lands in between, GitHub
      // refuses the update instead of this delete undoing it.
      const head = await repo.head()
      const index = await readBuildDb(repo, head)
      if (index === null) throw new Error(t.indexMissingNothingDeleted(BUILD_DB_PATH))
      const fresh = index.entries.find((e) => e.id === entry.id)
      if (fresh === undefined) {
        // Another tab or device got there first: show the list as it is now.
        setState({ status: 'ready', db: index })
        toast.info(t.alreadyDeleted, { id, description: t.alreadyDeletedDetail(entry.name) })
        return
      }
      // What the directory holds now, so the commit deletes what is there and nothing that is not.
      const listing = await repo.list(buildDir(entry.id), head)
      const found = (listing ?? []).filter((f) => f.type === 'file').map((f) => f.path)
      const plan = planBuildDelete(fresh, found, index, new Date().toISOString())
      await repo.commit({ ...plan, parent: head })
      setState({ status: 'ready', db: plan.db })
      toast.success(t.deleted, { id, description: t.deletedDetail(entry.name) })
      // A file of 100 MiB or more was a release's: nothing links it any more, so it goes too,
      // after the commit and best effort — a release that stays never brings the build back.
      const release = fresh.release
      if (release !== null) {
        const gone = hasReleases(repo) && (await deleteBuildRelease(repo, release))
        if (!gone) toast.warning(t.releaseLeft(entry.name, release.tag))
      }
    } catch (error) {
      toastFailure(t.deleteFailed, error, openSettings, id)
    } finally {
      setCommitting(false)
    }
  }

  const entries = state.status === 'ready' ? state.db.entries : []
  const counts: Readonly<Record<PlatformFilter, number>> = {
    all: entries.length,
    android: entries.filter((e) => e.platform === 'android').length,
    ios: entries.filter((e) => e.platform === 'ios').length,
  }
  const visible = entries.filter(
    (e) => (platform === 'all' || e.platform === platform) && matchesBuild(e, query),
  )
  const used = state.status === 'ready' ? storageUsed(state.db) : 0
  const lastUpload = entries
    .map((e) => e.uploaded_at)
    .sort()
    .at(-1)
  // The day alone: the card is narrow, and the time is on the build's own card.
  const lastDay = lastUpload ? formatDateTime(lastUpload, locale).split(' ')[0] : ''

  const upload = () => {
    setSheet({ mode: 'new' })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={all.module.builds.title}
        description={all.module.builds.description}
        actions={
          <Button disabled={state.status !== 'ready' || committing} onClick={upload}>
            <Plus /> {t.upload}
          </Button>
        }
      />

      {state.status === 'loading' && (
        <div className="grid gap-4 md:grid-cols-3" aria-label={all.loading}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
          <Skeleton className="h-44 rounded-xl md:col-span-3" />
        </div>
      )}

      {(state.status === 'missing' || state.status === 'failed') && (
        <div className="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-xl border p-5 sm:flex-row sm:items-center">
          <TriangleAlert className="text-destructive size-5 shrink-0" />
          <div className="flex-1 text-sm">
            <p className="font-medium">
              {state.status === 'missing' ? t.indexMissing : t.loadFailed}
            </p>
            <p className="text-muted-foreground mt-0.5">
              {state.status === 'missing'
                ? t.indexMissingDetail(BUILD_DB_PATH)
                : (state.message ?? all.unknownError)}
            </p>
          </div>
          {state.status === 'failed' && state.auth ? (
            <Button variant="outline" onClick={openSettings}>
              {all.updateToken}
            </Button>
          ) : (
            <Button variant="outline" onClick={reload}>
              <RotateCcw /> {t.retry}
            </Button>
          )}
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label={t.builds}
              value={entries.length}
              hint={t.perPlatform(counts.android, counts.ios)}
              icon={<Package />}
            />
            <StatCard
              label={t.storage}
              value={
                <>
                  <span className="block">
                    {formatBytes(used, locale)}
                    <span className="text-muted-foreground text-base font-normal">
                      {' '}
                      {t.storageOf}
                    </span>
                  </span>
                  <Progress
                    value={Math.min(100, (used / SITE_BUDGET_BYTES) * 100)}
                    aria-label={t.storage}
                    className="mt-2 h-1.5"
                  />
                </>
              }
              hint={t.storageHint}
              icon={<HardDrive />}
            />
            <StatCard
              label={t.lastUpload}
              value={lastDay || '—'}
              hint={t.liveHint}
              icon={<CalendarDays />}
            />
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
              <div className="bg-primary/10 text-primary grid size-12 place-items-center rounded-full">
                <Package className="size-6" />
              </div>
              <h2 className="mt-4 font-semibold">{t.empty}</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">{t.emptyDetail}</p>
              <Button className="mt-6" onClick={upload}>
                <Plus /> {t.uploadFirst}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {/* Segmented, as Device Lab's platform filter: one choice, never none. */}
                <ToggleGroup
                  type="single"
                  value={platform}
                  onValueChange={(value) => {
                    if (isPlatformFilter(value)) setPlatform(value)
                  }}
                  aria-label={t.platform}
                  className="bg-muted text-foreground/75 h-9 w-full rounded-lg p-[3px] sm:w-auto"
                >
                  {PLATFORM_FILTERS.map((value) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      // Radio semantics, radio behaviour: an arrow key moves focus AND
                      // chooses, as the ARIA radio group pattern expects; Radix only moves focus.
                      onFocus={() => {
                        setPlatform(value)
                      }}
                      className={cn(
                        'h-full flex-1 gap-1.5 rounded-md border border-transparent px-3 data-[spacing=0]:rounded-md',
                        'hover:text-foreground hover:bg-transparent',
                        'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
                        'dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30',
                      )}
                    >
                      {value !== 'all' && <PlatformIcon platform={value} />}
                      {t.platforms[value]}
                      <span className="tabular-nums">{counts[value]}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <div className="relative sm:ml-auto sm:w-72">
                  <Search
                    aria-hidden="true"
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                  />
                  <Input
                    type="search"
                    value={query}
                    placeholder={t.searchPlaceholder}
                    aria-label={t.search}
                    className="pl-8"
                    onChange={(e) => {
                      setQuery(e.target.value)
                    }}
                  />
                </div>
              </div>

              {visible.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center text-sm">
                  <Search className="mb-3 size-8 opacity-60" aria-hidden="true" />
                  <p className="text-foreground font-medium">{t.noMatch}</p>
                  <p className="mt-1">{t.noMatchDetail}</p>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {visible.map((entry) => (
                    <BuildCard
                      key={entry.id}
                      entry={entry}
                      busy={committing}
                      onEdit={() => {
                        setSheet({ mode: 'edit', entry })
                      }}
                      onReplace={() => {
                        setSheet({ mode: 'replace', entry })
                      }}
                      onDelete={() => {
                        setDeleting(entry)
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Outside the list's ready state on purpose: a reload that fails behind the open sheet
          (a new token that is refused too, a GitHub 500) must not unmount it and its upload. */}
      {sheet !== null && (
        <BuildSheet
          key={sheet.mode === 'new' ? '(new)' : `${sheet.mode}:${sheet.entry.id}`}
          target={sheet}
          takenIds={entries.map((e) => e.id)}
          onClose={closeSheet}
          onIndex={showIndex}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.deleteTitle(shownDeleting?.name ?? '')}</AlertDialogTitle>
            <AlertDialogDescription>
              {shownDeleting?.release ? t.deleteDetailRelease : t.deleteDetail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{all.cancel}</AlertDialogCancel>
            {/* The variant, not a class: asChild joins the classes unmerged, so bg-primary won. */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void confirmDelete(deleting)
              }}
            >
              {t.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
