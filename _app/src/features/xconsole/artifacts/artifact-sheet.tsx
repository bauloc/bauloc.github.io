import {
  Check,
  ClipboardPaste,
  Eye,
  FileCode2,
  FileUp,
  Loader2,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { DropZone, useFileDropGuard } from '../components/drop-zone'
import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { formatBytes } from '../format'
import { randomId } from '../ids'
import { XCONSOLE_MESSAGES } from '../messages'
import { AuthError, MAX_FILE_BYTES, type Repo } from '../repo/github'
import { liveOrigin } from '../site'
import { PublishedReadError, isServed, loadArtifactDb, loadPublished } from './load'
import { ARTIFACT_MESSAGES } from './messages'
import {
  ARTIFACT_DB_PATH,
  MAX_ARTIFACT_BYTES,
  UPLOAD_FIRST_BYTES,
  WARN_ARTIFACT_BYTES,
  artifactPath,
  artifactUrl,
  decodeUtf8,
  editConflict,
  planArtifactPublish,
  servedHtml,
  sizeProblem,
  utf8Length,
  validateArtifact,
  type ArtifactDb,
  type ArtifactDraft,
  type ArtifactEntry,
} from './model'
import {
  PREVIEW_ALLOW,
  PREVIEW_STORAGE_ID,
  PREVIEW_SANDBOX_FLAGS,
  artifactHtml,
  htmlMeta,
  htmlTitle,
  previewDoc,
} from './templates/wrapper'

/** A page as chosen in the sheet: its HTML and the file it came from ('' when pasted). */
interface Content {
  readonly source: string
  readonly fileName: string
}

type Origin = 'file' | 'paste'

/** Cancel stopped the upload: nothing failed, so nothing is reported as a failure. */
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** The preview waits for typing to pause: each change reloads the frame and reruns the page. */
const PREVIEW_DELAY_MS = 300

function Field({
  id,
  label,
  required,
  hint,
  children,
}: {
  id?: string
  label: string
  required?: boolean
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {hint !== undefined && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h3 className="text-muted-foreground border-b pb-2 text-xs font-semibold tracking-wider uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * Upload or edit an artifact, in a sheet from the right: the page (a file, or pasted HTML), its
 * title and link, whether it runs in the sandbox, and a live preview — then one commit.
 *
 * An edit keeps the link, which people already hold. It starts from the page read back out of
 * the served file and the entry read with it, and publishes over them only if neither has
 * changed since (editConflict).
 *
 * A file let go anywhere on the sheet is taken while the drop zone shows, and never opened by
 * the browser over the console. The sheet cannot be closed while the page is going up: Cancel
 * first.
 */
export function ArtifactSheet({
  editing,
  takenIds,
  onClose,
  onIndex,
}: {
  /** The artifact being edited, as listed when the sheet opened; null for a new one. */
  editing: ArtifactEntry | null
  /** The links the list already shows, refused before an upload rather than after it. */
  takenIds: readonly string[]
  onClose: () => void
  /** The index as it now stands: after a publish, or as read when a publish was refused. */
  onIndex: (db: ArtifactDb) => void
}) {
  const { repo, mock, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = useMessages(ARTIFACT_MESSAGES)
  const locale = useLocale()
  const origin = liveOrigin(mock)

  /**
   * What the edit starts from, read at one commit: the artifact's entry, the served file and
   * the page inside it. The entry, not the list's copy, is what the sheet shows and what
   * publish() compares against: the list may be older.
   */
  const [loaded, setLoaded] = useState<{
    readonly entry: ArtifactEntry
    readonly text: string
    readonly source: string
  } | null>(null)
  const loading = editing !== null && loaded === null
  const [tab, setTab] = useState<Origin>('file')
  const [file, setFile] = useState<Content | null>(null)
  const [pasted, setPasted] = useState('')
  /** The title as typed; until then it follows the page: its <title>, else the file name. */
  const [typedTitle, setTypedTitle] = useState(editing?.title ?? '')
  const [titleTouched, setTitleTouched] = useState(editing !== null)
  const [newId, setNewId] = useState(() => randomId())
  const [sandbox, setSandbox] = useState(editing?.sandbox ?? true)
  const [errors, setErrors] = useState<string[]>([])
  /**
   * The repo whose token the last publish was refused with. The error box offers to replace
   * the token, keeping the page, for as long as that is still the token in use.
   */
  const [refusedRepo, setRefusedRepo] = useState<Repo | null>(null)
  const tokenRefused = refusedRepo !== null && refusedRepo === repo
  const [busy, setBusy] = useState(false)
  /** Bytes of the served file sent so far, while it uploads. */
  const [progress, setProgress] = useState<{
    readonly sent: number
    readonly total: number
  } | null>(null)
  /** Aborts the upload in flight: the footer's Cancel while the progress bar shows. */
  const uploading = useRef<AbortController | null>(null)
  // Gone mid-upload (the route changed under the sheet): stop the upload rather than let a
  // publish nobody is watching carry on and commit in the background.
  useEffect(
    () => () => {
      uploading.current?.abort()
    },
    [],
  )
  /** Counts file reads, so a file chosen while another is still being read wins. */
  const reads = useRef(0)
  const body = useRef<HTMLDivElement>(null)

  /** Bumped each time a problem is shown, so the box comes into view even when it repeats. */
  const [shown, setShown] = useState(0)
  const showErrors = (problems: string[]) => {
    setErrors(problems)
    if (problems.length > 0) setShown((n) => n + 1)
  }

  // The error box renders at the top of the scrolled body: bring it into view once it is in
  // the DOM, or Publish looks dead. Never on a keystroke, which only clears problems.
  useLayoutEffect(() => {
    if (shown > 0) body.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [shown])

  /*
    What would be published. The open tab decides: a chosen file, or the pasted HTML. An edit
    with neither keeps the page it loaded, under the file name it had.
  */
  const chosen: Content | null =
    tab === 'file' ? file : /\S/.test(pasted) ? { source: pasted, fileName: '' } : null
  const content: Content | null =
    chosen ?? (loaded ? { source: loaded.source, fileName: loaded.entry.file_name } : null)
  const source = content?.source ?? ''
  const fileName = content?.fileName ?? ''
  const size = useMemo(() => utf8Length(source), [source])
  const suggestedTitle = useMemo(
    () => htmlTitle(source) || fileName.replace(/\.html?$/i, ''),
    [source, fileName],
  )
  const title = titleTouched ? typedTitle : suggestedTitle
  const id = editing?.id ?? newId
  const draft: ArtifactDraft = { id, title, source, file_name: fileName, sandbox }

  const [previewSource, setPreviewSource] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewSource(source)
    }, PREVIEW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [source])
  const preview = useMemo(
    () => (/\S/.test(previewSource) ? previewDoc(previewSource) : ''),
    [previewSource],
  )

  // Loads the page once per sheet. An effect event, so a new `repo` — which replacing the token
  // produces, as the error box below offers mid-edit — does not reload the page over the
  // changes made so far, nor move the baseline that publish() compares against.
  const load = useEffectEvent((listed: ArtifactEntry, isLive: () => boolean) => {
    loadPublished(repo, listed, locale)
      .then((published) => {
        if (!isLive()) return
        const { entry } = published
        // The fields start from the entry as it is now (they are not shown until here), and
        // the list behind the sheet catches up with it.
        setLoaded({ entry, text: published.served, source: published.source })
        setTypedTitle(entry.title)
        setSandbox(entry.sandbox)
        onIndex(published.index)
      })
      .catch((error: unknown) => {
        if (!isLive()) return
        // Deleted elsewhere: the list drops the page instead of offering it again.
        if (error instanceof PublishedReadError && error.index !== null) onIndex(error.index)
        toastFailure(t.openFailed, error, openSettings)
        onClose()
      })
  })

  useEffect(() => {
    if (editing === null) return
    let live = true
    load(editing, () => live)
    return () => {
      live = false
    }
  }, [editing])

  const chooseFile = (picked: File) => {
    setErrors([])
    // The picker filters by extension; a drop is not filtered at all.
    if (!/\.html?$/i.test(picked.name) && picked.type !== 'text/html') {
      showErrors([t.notHtml])
      return
    }
    // Refused before reading: a file far over the limit is not worth holding in memory.
    const tooLarge = sizeProblem(picked.size, locale)
    if (tooLarge !== null) {
      showErrors([tooLarge])
      return
    }
    const turn = ++reads.current
    picked.arrayBuffer().then(
      (bytes) => {
        if (turn !== reads.current) return
        // Decoded strictly: another encoding would come through garbled and be published so.
        const text = decodeUtf8(bytes)
        if (text === null) showErrors([t.notUtf8])
        else setFile({ source: text, fileName: picked.name })
      },
      (error: unknown) => {
        if (turn !== reads.current) return
        toast.error(t.readFailed, {
          description: error instanceof Error ? error.message : all.unknownError,
        })
      },
    )
  }

  // A file let go beside the zone (on the title, the preview, the dimmed page) is taken as if
  // dropped on it while the zone shows and can take one. Any other time it is refused, never
  // opened by the browser in place of the console and what was typed here.
  useFileDropGuard(tab === 'file' && !loading && !busy ? chooseFile : undefined)

  // A large page takes a while to go up, and leaving the page drops it: the browser asks first.
  useEffect(() => {
    if (!busy) return
    const hold = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', hold)
    return () => {
      window.removeEventListener('beforeunload', hold)
    }
  }, [busy])

  /**
   * The page in a tab of its own, from a blob: always inside the wrapper, never as raw HTML, and
   * with no device, as in the preview frame below.
   */
  const openPreview = () => {
    const html = artifactHtml(
      {
        /*
          Not the link's id: the preview tab runs on this origin, and its storage would land
          in the published artifact's own key ('bauloc:artifact:<id>'), so trying a draft
          would change what readers of the live page have saved here. No link can hold
          parentheses, so every preview shares this one key and no artifact's.
        */
        id: PREVIEW_STORAGE_ID,
        title: title.trim() || t.untitled,
        source,
        sandbox: true,
        meta: htmlMeta(source),
      },
      PREVIEW_ALLOW,
    )
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 60_000)
  }

  const publish = async () => {
    // Publish is off until an edit has loaded: there is nothing to compare against before.
    if (editing !== null && loaded === null) return
    const problems = validateArtifact(draft, locale)
    // Refused before the upload, not after it: the list on screen already knows these. A link
    // taken since the list was read is still caught at the head, below.
    if (editing === null && problems.length === 0 && takenIds.includes(id)) {
      problems.push(t.idTaken(id))
    }
    showErrors(problems)
    setRefusedRepo(null)
    if (problems.length > 0) return
    const html = servedHtml(draft)
    const bytes = utf8Length(html)
    // Only a sandboxed page can get here, and only a pathological one: the wrapper writes each
    // `<` as six characters, so a page of almost nothing else grows that much.
    if (bytes >= MAX_FILE_BYTES) {
      showErrors([
        t.servedTooLarge(formatBytes(bytes, locale), formatBytes(MAX_FILE_BYTES, locale)),
      ])
      return
    }
    const used = repo

    setBusy(true)
    const toastId = toast.loading(editing ? t.updating : t.publishing)
    try {
      let sha: string | undefined
      if (bytes > UPLOAD_FIRST_BYTES) {
        // Up first, before the head is read: an upload takes a while on a slow line, and the
        // window in which another publish can slip in should be only as long as the commit.
        const controller = new AbortController()
        uploading.current = controller
        setProgress({ sent: 0, total: bytes })
        sha = await repo.upload(new Blob([html], { type: 'text/html' }), {
          signal: controller.signal,
          onProgress: (fraction) => {
            setProgress({ sent: fraction * bytes, total: bytes })
          },
        })
        uploading.current = null
        setProgress(null)
      }
      // Everything is read at ONE commit and the change is built on that same commit: if the
      // branch moves in between, GitHub refuses the update instead of this publish silently
      // undoing what landed (another tab, another device).
      const head = await repo.head()
      const index = await loadArtifactDb(repo, head)
      if (index === null) throw new Error(t.indexMissingNothingPublished(ARTIFACT_DB_PATH))
      if (loaded === null) {
        if (index.entries.some((e) => e.id === id) || (await isServed(repo, id, head))) {
          toast.dismiss(toastId)
          showErrors([t.idTaken(id)])
          return
        }
      } else {
        const current = await repo.read(artifactPath(loaded.entry.id), head)
        const conflict = editConflict(loaded.entry, index, loaded.text, current, locale)
        if (conflict !== null) {
          toast.dismiss(toastId)
          // The list behind the sheet shows the index as it is now, a deleted page gone.
          onIndex(index)
          showErrors([conflict])
          return
        }
      }
      const now = new Date().toISOString()
      const plan = planArtifactPublish({ draft, sha }, index, loaded?.entry ?? null, now)
      await repo.commit({ ...plan, parent: head })
      const url = artifactUrl(id, origin)
      toast.success(editing ? t.updated : t.published, {
        id: toastId,
        description: (
          <span>
            {t.liveSoon}{' '}
            <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
              {url.replace(/^https?:\/\//, '')}
            </a>
          </span>
        ),
        duration: 8000,
      })
      onIndex(plan.db)
      onClose()
    } catch (error) {
      if (isAbort(error)) {
        toast.info(t.uploadCancelled, { id: toastId })
      } else if (error instanceof AuthError) {
        // A toast's action cannot be clicked under the open sheet, so the fix lives in the
        // sheet: replacing the token opens Settings on top and keeps the page chosen here.
        toast.dismiss(toastId)
        setRefusedRepo(used)
        setShown((n) => n + 1)
      } else {
        toastFailure(t.publishFailed, error, openSettings, toastId)
      }
    } finally {
      uploading.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  const tooLarge = content === null ? null : sizeProblem(size, locale)
  const percent = progress ? Math.round((progress.sent / Math.max(progress.total, 1)) * 100) : 0

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl" showCloseButton={!busy}>
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="text-lg">{editing ? t.editTitle : t.newTitle}</SheetTitle>
          <SheetDescription>
            {editing ? t.editDescription(editing.id) : t.newDescription}
          </SheetDescription>
        </SheetHeader>

        <div ref={body} className="flex-1 overflow-y-auto px-6 py-6">
          {(errors.length > 0 || tokenRefused) && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive mb-6 flex gap-3 rounded-lg border p-3 text-sm"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1 space-y-2">
                <ul className="list-inside space-y-0.5">
                  {tokenRefused && <li>{t.tokenRefused}</li>}
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                {tokenRefused && (
                  <Button size="sm" variant="outline" onClick={openSettings}>
                    {all.updateToken}
                  </Button>
                )}
              </div>
            </div>
          )}

          {loading ? (
            <div className="space-y-4" aria-label={all.loading}>
              <Skeleton className="h-32 w-full rounded-xl" />
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-8">
              <Section title={t.page}>
                <Tabs
                  value={tab}
                  onValueChange={(value) => {
                    if (value === 'file' || value === 'paste') setTab(value)
                    setErrors([])
                  }}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="file">
                      <FileUp /> {t.fromFile}
                    </TabsTrigger>
                    <TabsTrigger value="paste">
                      <ClipboardPaste /> {t.paste}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="file" className="grid gap-3 pt-2">
                    <DropZone
                      accept=".html,.htm,text/html"
                      onFile={chooseFile}
                      disabled={busy}
                      icon={<FileUp />}
                      label={t.dropLabel}
                      hint={t.dropHint(formatBytes(MAX_ARTIFACT_BYTES, locale))}
                    />
                    {file ? (
                      <div className="bg-muted/40 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3 text-sm">
                        <FileCode2 className="text-muted-foreground size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {formatBytes(size, locale)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={busy}
                          aria-label={t.removeFile}
                          title={t.removeFile}
                          onClick={() => {
                            reads.current++
                            setFile(null)
                            setErrors([])
                          }}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : (
                      loaded && (
                        <p className="text-muted-foreground text-xs">
                          {t.current(
                            loaded.entry.file_name || t.pasted,
                            formatBytes(loaded.entry.size, locale),
                          )}{' '}
                          {t.replaceHint}
                        </p>
                      )
                    )}
                  </TabsContent>
                  <TabsContent value="paste" className="grid gap-2 pt-2">
                    <Label htmlFor="artifact-paste" className="sr-only">
                      {t.pasteLabel}
                    </Label>
                    <Textarea
                      id="artifact-paste"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="<!DOCTYPE html>…"
                      value={pasted}
                      disabled={busy}
                      className="field-sizing-fixed h-56 resize-y font-mono text-xs md:text-xs"
                      onChange={(e) => {
                        setPasted(e.target.value)
                        setErrors([])
                      }}
                    />
                    <div className="text-muted-foreground flex justify-between gap-4 text-xs">
                      <span>{editing ? t.pasteKeep : ''}</span>
                      {chosen && <span className="tabular-nums">{formatBytes(size, locale)}</span>}
                    </div>
                  </TabsContent>
                </Tabs>
                {tooLarge !== null ? (
                  <p className="text-destructive flex gap-2 text-xs">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" />
                    {tooLarge}
                  </p>
                ) : (
                  size >= WARN_ARTIFACT_BYTES && (
                    <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-300">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" />
                      {t.large(formatBytes(size, locale))}
                    </p>
                  )
                )}
              </Section>

              <Section title={t.details}>
                {/* No hint for an edit: its title stays as published, whatever the page says. */}
                <Field
                  id="artifact-title"
                  label={t.title}
                  required
                  hint={editing ? undefined : t.titleHint}
                >
                  <Input
                    id="artifact-title"
                    placeholder={t.titlePlaceholder}
                    value={title}
                    disabled={busy}
                    onChange={(e) => {
                      setTitleTouched(true)
                      setTypedTitle(e.target.value)
                      setErrors([])
                    }}
                  />
                </Field>
                <Field
                  id="artifact-id"
                  label={t.link}
                  required
                  hint={
                    editing ? (
                      t.linkFixed
                    ) : (
                      <span className="font-mono break-all">
                        {origin.replace(/^https?:\/\//, '')}/artifact/
                        <b className="text-foreground">{id || 'id'}</b>.html
                      </span>
                    )
                  }
                >
                  <div className="flex gap-2">
                    <Input
                      id="artifact-id"
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      value={id}
                      disabled={editing !== null || busy}
                      onChange={(e) => {
                        // Lowercase as typed: the link is, and a capital would only be refused.
                        setNewId(e.target.value.trim().toLowerCase())
                        setErrors([])
                      }}
                    />
                    {editing === null && (
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={busy}
                        aria-label={t.regenerate}
                        title={t.regenerate}
                        onClick={() => {
                          setNewId(randomId())
                          setErrors([])
                        }}
                      >
                        <RefreshCw />
                      </Button>
                    )}
                  </div>
                </Field>
              </Section>

              <Section title={t.security}>
                <div className="flex items-start justify-between gap-4">
                  <div className="grid gap-1">
                    <Label htmlFor="artifact-sandbox">{t.sandbox}</Label>
                    <p className="text-muted-foreground text-xs">{t.sandboxHint}</p>
                  </div>
                  <Switch
                    id="artifact-sandbox"
                    className="mt-0.5"
                    checked={sandbox}
                    disabled={busy}
                    onCheckedChange={(on) => {
                      setSandbox(on)
                      setErrors([])
                    }}
                  />
                </div>
                {!sandbox && (
                  <div className="border-destructive/30 bg-destructive/5 text-destructive flex gap-3 rounded-lg border p-3 text-sm">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                    <p>{t.fullWarning}</p>
                  </div>
                )}
              </Section>

              <Section title={t.preview}>
                <div className="bg-muted/30 h-80 overflow-hidden rounded-lg border">
                  {preview ? (
                    <iframe
                      title={t.previewFrame(title.trim() || t.untitled)}
                      srcDoc={preview}
                      sandbox={PREVIEW_SANDBOX_FLAGS}
                      allow={PREVIEW_ALLOW}
                      className="size-full bg-white"
                    />
                  ) : (
                    <div className="text-muted-foreground grid h-full place-items-center p-6 text-center text-sm">
                      {t.previewEmpty}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={content === null}
                    onClick={openPreview}
                  >
                    <Eye /> {t.openPreview}
                  </Button>
                  {!sandbox && (
                    <span className="text-muted-foreground text-xs">{t.previewSandboxed}</span>
                  )}
                </div>
              </Section>
            </div>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-4">
          {progress ? (
            <>
              <div className="grid min-w-0 flex-1 gap-1.5">
                <div className="text-muted-foreground flex justify-between gap-2 text-xs tabular-nums">
                  <span className="truncate">
                    {t.uploading(
                      formatBytes(progress.sent, locale),
                      formatBytes(progress.total, locale),
                    )}
                  </span>
                  <span>{percent}%</span>
                </div>
                <Progress value={percent} aria-label={t.uploadProgress} />
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  uploading.current?.abort()
                }}
              >
                {t.cancelUpload}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {all.cancel}
              </Button>
              <Button
                disabled={busy || loading}
                onClick={() => {
                  void publish()
                }}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Check />}
                {editing ? t.savePublish : t.publish}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
