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

import { PageHeader, StatCard } from '../components/page-header'
import { useConsole } from '../console-context'
import { CONSOLE_MODULES } from '../console-menu'
import { toastFailure } from '../errors'
import { AuthError } from '../repo/github'
import { DB_PATH, parseDb, planDelete, type DbEntry, type DbIndex } from './model'
import { PageCard } from './page-card'
import { PageSheet } from './page-sheet'
import { formatDate } from './templates/format'

type State =
  | { status: 'loading' }
  | { status: 'ready'; db: DbIndex }
  /** No index on GitHub. Never shown as an empty list: publishing would overwrite the real one. */
  | { status: 'missing' }
  | { status: 'failed'; message: string; auth: boolean }

const MODULE = CONSOLE_MODULES[0]

async function loadDb(read: (path: string) => Promise<string | null>): Promise<State> {
  try {
    const text = await read(DB_PATH)
    return text === null ? { status: 'missing' } : { status: 'ready', db: parseDb(text) }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      auth: error instanceof AuthError,
    }
  }
}

/** Term & Privacy: the published apps, and the sheet that creates, edits and publishes them. */
export function TermPrivacyPage() {
  const { repo, openSettings } = useConsole()
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
    const id = toast.loading(`Deleting ${entry.app_name}…`)
    try {
      // Read the index at one commit and build on that same commit: if anything lands in
      // between, GitHub refuses the update instead of this delete undoing it.
      const head = await repo.head()
      const fresh = await repo.read(DB_PATH, head)
      if (fresh === null) throw new Error(`${DB_PATH} is missing on GitHub — nothing was deleted.`)
      const index = parseDb(fresh)
      if (!index.entries.some((e) => e.slug === entry.slug)) {
        // Another tab or device got there first: show the list as it is now.
        setState({ status: 'ready', db: index })
        toast.info('Already deleted', {
          id,
          description: `${entry.app_name} was deleted elsewhere.`,
        })
        return
      }
      const plan = planDelete(entry.slug, index, new Date().toISOString())
      await repo.commit({ ...plan, parent: head })
      setState({ status: 'ready', db: plan.db })
      toast.success('Deleted', {
        id,
        description: `${entry.app_name} and both of its pages are gone.`,
      })
    } catch (error) {
      toastFailure('Delete failed', error, openSettings, id)
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
        title={MODULE.title}
        description={MODULE.description}
        actions={
          <Button
            disabled={state.status !== 'ready' || committing}
            onClick={() => {
              setSheet({ editing: null })
            }}
          >
            <Plus /> New page
          </Button>
        }
      />

      {state.status === 'loading' && (
        <div className="grid gap-4 md:grid-cols-3" aria-label="Loading">
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
              {state.status === 'missing'
                ? 'The page index was not found'
                : 'Could not load the pages'}
            </p>
            <p className="text-muted-foreground mt-0.5">
              {state.status === 'missing'
                ? `There is no ${DB_PATH} on the master branch. Publishing stays off until it is back, so the real list cannot be overwritten.`
                : state.message}
            </p>
          </div>
          {state.status === 'failed' && state.auth ? (
            <Button variant="outline" onClick={openSettings}>
              Update token
            </Button>
          ) : (
            <Button variant="outline" onClick={reload}>
              <RotateCcw /> Retry
            </Button>
          )}
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Apps"
              value={entries.length}
              hint={`${String(entries.length * 2)} pages live`}
              icon={<FileText />}
            />
            <StatCard
              label="Platforms"
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
              label="Last published"
              value={(lastUpdated && formatDate(lastUpdated.split('T')[0] ?? '')) || '—'}
              hint="Pages go live about a minute after publishing"
              icon={<CalendarDays />}
            />
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
              <div className="bg-primary/10 text-primary grid size-12 place-items-center rounded-full">
                <FileText className="size-6" />
              </div>
              <h2 className="mt-4 font-semibold">No pages yet</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                Create the Terms of Service and Privacy Policy an app needs for the App Store and
                Google Play.
              </p>
              <Button
                className="mt-6"
                onClick={() => {
                  setSheet({ editing: null })
                }}
              >
                <Plus /> Create the first page
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
            <AlertDialogTitle>Delete {deleting?.app_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its saved answers and both published pages from GitHub. Any store listing
              that links to them will show a 404.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* The variant, not a class: asChild joins the classes unmerged, so bg-primary won. */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void confirmDelete(deleting)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
