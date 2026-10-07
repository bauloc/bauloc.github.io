import {
  CalendarDays,
  FileCode2,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Upload,
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
import { Skeleton } from '@/components/ui/skeleton'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { PageHeader, StatCard } from '../components/page-header'
import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { formatBytes, formatDateTime } from '../format'
import { XCONSOLE_MESSAGES } from '../messages'
import { AuthError, type Repo } from '../repo/github'
import { liveOrigin } from '../site'
import { ArtifactCard } from './artifact-card'
import { ArtifactSheet } from './artifact-sheet'
import { PublishedReadError, isServed, loadArtifactDb, loadPublished } from './load'
import { ARTIFACT_MESSAGES } from './messages'
import {
  ARTIFACT_DB_PATH,
  artifactUrl,
  planArtifactDelete,
  type ArtifactDb,
  type ArtifactEntry,
} from './model'

type State =
  | { status: 'loading' }
  | { status: 'ready'; db: ArtifactDb }
  /**
   * No index on GitHub while artifact/ still serves pages. Never shown as an empty list:
   * publishing would overwrite the real one.
   */
  | { status: 'missing' }
  /** `message` is null when the failure came without one: the page words that itself. */
  | { status: 'failed'; message: string | null; auth: boolean }

async function loadState(repo: Repo): Promise<State> {
  try {
    const db = await loadArtifactDb(repo)
    return db === null ? { status: 'missing' } : { status: 'ready', db }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : null,
      auth: error instanceof AuthError,
    }
  }
}

/**
 * Saves text as a file. As bytes, not text/html: a browser that opens the blob instead of
 * saving it shows them, and never runs the page in the console's origin, next to the token.
 */
function saveAs(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60_000)
}

/** Artifacts: the hosted HTML pages, and the sheet that uploads, edits and publishes them. */
export function ArtifactsPage() {
  const { repo, mock, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = useMessages(ARTIFACT_MESSAGES)
  const locale = useLocale()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [sheet, setSheet] = useState<{ editing: ArtifactEntry | null } | null>(null)
  const [deleting, setDeleting] = useState<ArtifactEntry | null>(null)
  /** A delete is committing: every other change waits, so two cannot interleave. */
  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    let live = true
    void loadState(repo).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [repo])

  const reload = () => {
    setState({ status: 'loading' })
    void loadState(repo).then(setState)
  }

  const closeSheet = useCallback(() => {
    setSheet(null)
  }, [])

  const confirmDelete = async (entry: ArtifactEntry) => {
    setCommitting(true)
    const id = toast.loading(t.deleting(entry.title))
    try {
      // Read the index at one commit and build on that same commit: if anything lands in
      // between, GitHub refuses the update instead of this delete undoing it.
      const head = await repo.head()
      const index = await loadArtifactDb(repo, head)
      if (index === null) throw new Error(t.indexMissingNothingDeleted(ARTIFACT_DB_PATH))
      if (!index.entries.some((e) => e.id === entry.id)) {
        // Another tab or device got there first: show the list as it is now.
        setState({ status: 'ready', db: index })
        toast.info(t.alreadyDeleted, { id, description: t.alreadyDeletedDetail(entry.title) })
        return
      }
      const served = await isServed(repo, entry.id, head)
      const plan = planArtifactDelete(entry.id, index, new Date().toISOString(), served)
      await repo.commit({ ...plan, parent: head })
      setState({ status: 'ready', db: plan.db })
      toast.success(t.deleted, { id, description: t.deletedDetail(entry.title) })
    } catch (error) {
      toastFailure(t.deleteFailed, error, openSettings, id)
    } finally {
      setCommitting(false)
    }
  }

  const download = async (entry: ArtifactEntry) => {
    const id = toast.loading(t.downloading)
    try {
      // Read with its entry: how the served file holds the page is the entry's to say now, and
      // the list may predate the sandbox being switched.
      const { source } = await loadPublished(repo, entry, locale)
      saveAs(source, `${entry.id}.html`)
      toast.dismiss(id)
    } catch (error) {
      if (error instanceof PublishedReadError && error.index !== null) {
        setState({ status: 'ready', db: error.index })
      }
      toastFailure(t.downloadFailed, error, openSettings, id)
    }
  }

  const entries = state.status === 'ready' ? state.db.entries : []
  const totalSize = entries.reduce((sum, e) => sum + e.size, 0)
  const sandboxed = entries.filter((e) => e.sandbox).length
  const lastUpdated = entries
    .map((e) => e.updated_at)
    .sort()
    .at(-1)
  const origin = liveOrigin(mock)

  return (
    <div className="space-y-6">
      <PageHeader
        title={all.module.artifacts.title}
        description={all.module.artifacts.description}
        actions={
          <Button
            disabled={state.status !== 'ready' || committing}
            onClick={() => {
              setSheet({ editing: null })
            }}
          >
            <Upload /> {t.upload}
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
                ? t.indexMissingDetail(ARTIFACT_DB_PATH)
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
              label={t.count}
              value={entries.length}
              hint={t.totalSize(formatBytes(totalSize, locale))}
              icon={<FileCode2 />}
            />
            <StatCard
              label={t.sandboxed}
              value={
                <span>
                  {sandboxed}
                  <span className="text-muted-foreground text-base font-normal">
                    {' '}
                    / {entries.length}
                  </span>
                </span>
              }
              hint={
                sandboxed === entries.length
                  ? t.allIsolated
                  : t.fullPages(entries.length - sandboxed)
              }
              icon={<ShieldCheck />}
            />
            <StatCard
              label={t.lastPublished}
              // The date alone: the card is narrow, and each artifact shows its time.
              value={(lastUpdated && formatDateTime(lastUpdated, locale).split(' ')[0]) || '—'}
              hint={t.goLive}
              icon={<CalendarDays />}
            />
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
              <div className="bg-primary/10 text-primary grid size-12 place-items-center rounded-full">
                <FileCode2 className="size-6" />
              </div>
              <h2 className="mt-4 font-semibold">{t.empty}</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">{t.emptyDetail}</p>
              <Button
                className="mt-6"
                onClick={() => {
                  setSheet({ editing: null })
                }}
              >
                <Upload /> {t.uploadFirst}
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {entries.map((entry) => (
                <ArtifactCard
                  key={entry.id}
                  entry={entry}
                  url={artifactUrl(entry.id, origin)}
                  busy={committing}
                  onEdit={() => {
                    setSheet({ editing: entry })
                  }}
                  onDownload={() => {
                    void download(entry)
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

      {/* Outside the list's ready state on purpose: a reload that fails behind the open sheet
          (a new token that is refused too, a GitHub 500) must not unmount it and its page. */}
      {sheet !== null && (
        <ArtifactSheet
          key={sheet.editing?.id ?? '(new)'}
          editing={sheet.editing}
          takenIds={entries.map((e) => e.id)}
          onClose={closeSheet}
          onIndex={(db) => {
            setState({ status: 'ready', db })
          }}
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
            <AlertDialogTitle>{t.deleteTitle(deleting?.title ?? '')}</AlertDialogTitle>
            <AlertDialogDescription>{t.deleteDetail}</AlertDialogDescription>
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
