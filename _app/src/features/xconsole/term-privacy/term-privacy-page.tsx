import { CalendarDays, FileText, Plus, RotateCcw, Smartphone, TriangleAlert } from 'lucide-react'
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

import { PageHeader, StatCard } from '../components/page-header'
import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { XCONSOLE_MESSAGES } from '../messages'
import { AuthError } from '../repo/github'
import { DB_PATH, parseDb, planDelete, type DbEntry, type DbIndex } from './model'
import { PageCard } from './page-card'
import { PageSheet } from './page-sheet'

type State =
  | { status: 'loading' }
  | { status: 'ready'; db: DbIndex }
  /** No index on GitHub. Never shown as an empty list: publishing would overwrite the real one. */
  | { status: 'missing' }
  /** `message` is null when the failure came without one: the page words that itself. */
  | { status: 'failed'; message: string | null; auth: boolean }

async function loadDb(read: (path: string) => Promise<string | null>): Promise<State> {
  try {
    const text = await read(DB_PATH)
    return text === null ? { status: 'missing' } : { status: 'ready', db: parseDb(text) }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : null,
      auth: error instanceof AuthError,
    }
  }
}

/** Term & Privacy: the published apps, and the sheet that creates, edits and publishes them. */
export function TermPrivacyPage() {
  const { repo, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = all.pages
  const [state, setState] = useState<State>({ status: 'loading' })
  const [sheet, setSheet] = useState<{ editing: string | null } | null>(null)
  const [deleting, setDeleting] = useState<DbEntry | null>(null)
  /** A delete is committing: every other change waits, so two cannot interleave. */
  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    let live = true
    void loadDb((path) => repo.read(path)).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [repo])

  const reload = () => {
    setState({ status: 'loading' })
    void loadDb((path) => repo.read(path)).then(setState)
  }

  const closeSheet = useCallback(() => {
    setSheet(null)
  }, [])

  const confirmDelete = async (entry: DbEntry) => {
    setCommitting(true)
    const id = toast.loading(t.deleting(entry.app_name))
    try {
      // Read the index at one commit and build on that same commit: if anything lands in
      // between, GitHub refuses the update instead of this delete undoing it.
      const head = await repo.head()
      const fresh = await repo.read(DB_PATH, head)
      if (fresh === null) throw new Error(t.indexMissingNothingDeleted(DB_PATH))
      const index = parseDb(fresh)
      if (!index.entries.some((e) => e.slug === entry.slug)) {
        // Another tab or device got there first: show the list as it is now.
        setState({ status: 'ready', db: index })
        toast.info(t.alreadyDeleted, {
          id,
          description: t.alreadyDeletedDetail(entry.app_name),
        })
        return
      }
      const plan = planDelete(entry.slug, index, new Date().toISOString())
      await repo.commit({ ...plan, parent: head })
      setState({ status: 'ready', db: plan.db })
      toast.success(t.deleted, {
        id,
        description: t.deletedDetail(entry.app_name),
      })
    } catch (error) {
      toastFailure(t.deleteFailed, error, openSettings, id)
    } finally {
      setCommitting(false)
    }
  }

  const entries = state.status === 'ready' ? state.db.entries : []
  const lastUpdated = entries
    .map((e) => e.updated_at)
    .sort()
    .at(-1)

  return (
    <div className="space-y-6">
      <PageHeader
        title={all.module.termPrivacy.title}
        description={all.module.termPrivacy.description}
        actions={
          <Button
            disabled={state.status !== 'ready' || committing}
            onClick={() => {
              setSheet({ editing: null })
            }}
          >
            <Plus /> {t.newPage}
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
                ? t.indexMissingDetail(DB_PATH)
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
              label={t.apps}
              value={entries.length}
              hint={t.pagesLive(entries.length * 2)}
              icon={<FileText />}
            />
            <StatCard
              label={t.platforms}
              value={
                <span>
                  {entries.filter((e) => e.platform.includes('ios')).length}
                  <span className="text-muted-foreground text-base font-normal"> iOS · </span>
                  {entries.filter((e) => e.platform.includes('android')).length}
                  <span className="text-muted-foreground text-base font-normal"> Android</span>
                </span>
              }
              icon={<Smartphone />}
            />
            <StatCard
              label={t.lastPublished}
              value={(lastUpdated && all.date(lastUpdated.split('T')[0] ?? '')) || '—'}
              hint={t.goLive}
              icon={<CalendarDays />}
            />
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
              <div className="bg-primary/10 text-primary grid size-12 place-items-center rounded-full">
                <FileText className="size-6" />
              </div>
              <h2 className="mt-4 font-semibold">{t.empty}</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">{t.emptyDetail}</p>
              <Button
                className="mt-6"
                onClick={() => {
                  setSheet({ editing: null })
                }}
              >
                <Plus /> {t.createFirst}
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {entries.map((entry) => (
                <PageCard
                  key={entry.slug}
                  entry={entry}
                  busy={committing}
                  onEdit={() => {
                    setSheet({ editing: entry.slug })
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
          (a new token that is refused too, a GitHub 500) must not unmount it and its draft. */}
      {sheet !== null && (
        <PageSheet
          key={sheet.editing ?? '(new)'}
          editing={sheet.editing}
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
            <AlertDialogTitle>{t.deleteTitle(deleting?.app_name ?? '')}</AlertDialogTitle>
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
