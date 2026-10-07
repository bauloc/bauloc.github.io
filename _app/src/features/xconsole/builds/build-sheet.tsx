import { Check, Loader2, Package, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { isAbortError } from '@/features/device/helper/client'
import { isDevOrigin } from '@/features/device/helper/env'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { DropZone, useFileDropGuard } from '../components/drop-zone'
import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { formatBytes, formatDateTime } from '../format'
import { randomId } from '../ids'
import { XCONSOLE_MESSAGES } from '../messages'
import {
  AuthError,
  hasReleases,
  type ReleaseAsset,
  type Releases,
  type Repo,
  type UploadOptions,
} from '../repo/github'
import { readToken } from '../repo/token'
import { liveOrigin } from '../site'
import { AppIcon, iconUrl } from './build-card'
import {
  BuildSummary,
  FindingList,
  UnreadFile,
  factsOfEntry,
  factsOfInspection,
} from './build-summary'
import {
  HelperUploadError,
  probeHelper,
  releaseContentType,
  uploadViaHelper,
  type HelperProbe,
  type ReadyHelper,
} from './helper'
import { HelperCard, type HelperView } from './helper-card'
import { inspectBuild } from './inspect'
import { renderIconPng } from './inspect/icon'
import { LinkRow } from './link-row'
import { BUILD_MESSAGES, type FindingValues } from './messages'
import {
  NOTES_MAX,
  buildConflict,
  cleanName,
  cleanNotes,
  deleteBuildRelease,
  entryFromInspection,
  fileFindings,
  idTaken,
  planBuildEdit,
  planBuildPublish,
  readBuildDb,
  releaseFor,
  sha256Hex,
  suggestedName,
  uploadedOf,
  validateBuildDraft,
  versionLabel,
  type BuildDraft,
  type Finding,
  type Findings,
} from './model'
import {
  BUILD_DB_PATH,
  binaryFileName,
  buildDir,
  buildUrl,
  needsRelease,
  releaseDownloadUrl,
} from './paths'
import { QrCode } from './qr-dialog'
import type { BuildDb, BuildEntry, BuildInspection, ReleaseInfo } from './types'

/** What the sheet is for: a new link, a new version under a link, or a build's name and notes. */
export type BuildSheetTarget =
  { readonly mode: 'new' } | { readonly mode: 'replace' | 'edit'; readonly entry: BuildEntry }

/** The file dropped on the sheet, while it is read and once it has been. */
type Reading =
  | { readonly status: 'reading'; readonly file: File }
  | {
      readonly status: 'read'
      readonly file: File
      readonly inspection: BuildInspection
      /** icon.png as it will be published, or null when the app's icon could not be drawn. */
      readonly icon: Blob | null
    }
  | { readonly status: 'failed'; readonly file: File; readonly message: string }

type ReadBuild = Extract<Reading, { status: 'read' }>

/**
 * Where a publish is. Everything up to the release's file can still be cancelled; `cleanup`
 * removes the release of a publish that failed or was cancelled, and `committing` is final.
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hashing' }
  | { readonly kind: 'icon' }
  /** The binary going into the repo as a blob (under 100 MiB). */
  | { readonly kind: 'binary'; readonly fraction: number }
  /** A binary of 100 MiB or more: its GitHub Release being created… */
  | { readonly kind: 'release' }
  /** …and the file going up to it, through the helper (or the dev mock). */
  | { readonly kind: 'asset'; readonly fraction: number }
  | { readonly kind: 'cleanup' }
  | { readonly kind: 'committing' }

const IDLE: Phase = { kind: 'idle' }
const NO_FINDINGS: Findings = { problems: [], warnings: [] }
const CANCELLABLE: ReadonlySet<Phase['kind']> = new Set([
  'hashing',
  'icon',
  'binary',
  'release',
  'asset',
])

/**
 * What a publish uploaded, kept so a retry places the same blobs instead of sending them again.
 * `binary` is null for a file that goes to a release: a failed publish deletes its release, so
 * a retry makes and fills a new one.
 */
interface Uploaded {
  readonly sha256: string
  readonly binary: string | null
  readonly icon: string | null
}

/** The repository's GitHub Releases. Both repositories the console uses have them. */
function releasesOf(repo: Repo): Repo & Releases {
  if (!hasReleases(repo)) throw new Error('This repository cannot publish GitHub Releases.')
  return repo
}

/** A build file read in the browser: its facts and findings, and its icon drawn as a PNG. */
async function readBuild(file: File): Promise<{ inspection: BuildInspection; icon: Blob | null }> {
  const inspection = await inspectBuild(file)
  let icon: Blob | null = null
  if (inspection.icon !== null) {
    try {
      icon = await renderIconPng(inspection.icon)
    } catch {
      // An icon that cannot be drawn is no reason to hold the build back: the page shows the
      // app's initial instead.
    }
  }
  return { inspection, icon }
}

/** What the read's announcement calls a file: the app and its version, or else the file itself. */
function readSubject(read: ReadBuild, isBuild: boolean): string {
  const { inspection } = read
  const app = isBuild
    ? [inspection.name || inspection.bundleId, versionLabel(inspection)].filter(Boolean).join(' ')
    : ''
  return app || read.file.name
}

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

/** Where a publish is, above the buttons: the upload's bar, or what is happening now. */
function PhaseStrip({ phase, size, mock }: { phase: Phase; size: number; mock: boolean }) {
  const t = useMessages(BUILD_MESSAGES).sheet
  const locale = useLocale()
  if (phase.kind === 'idle') return null
  if ((phase.kind === 'binary' || phase.kind === 'asset') && phase.fraction < 1) {
    const percent = Math.floor(phase.fraction * 100)
    const { sent, total } = uploadedOf(phase.fraction * size, size, locale)
    const label =
      phase.kind === 'binary'
        ? t.uploading(sent, total, percent)
        : mock
          ? t.uploadingReleaseMock(sent, total, percent)
          : t.uploadingRelease(sent, total, percent)
    return (
      <div className="grid gap-1.5">
        <p className="text-muted-foreground text-xs tabular-nums">{label}</p>
        <Progress value={percent} className="h-1.5" aria-label={label} />
      </div>
    )
  }
  const label =
    phase.kind === 'hashing'
      ? t.hashing
      : phase.kind === 'icon'
        ? t.uploadingIcon
        : phase.kind === 'binary' || phase.kind === 'asset'
          ? t.storing
          : phase.kind === 'release'
            ? t.creatingRelease
            : phase.kind === 'cleanup'
              ? t.cleaningUp
              : t.committing
  return (
    <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {label}
    </p>
  )
}

/** After a publish: the link to send, its QR code, and when it starts working. */
function Published({
  entry,
  icon,
  replaced,
}: {
  entry: BuildEntry
  icon: string | null
  replaced: boolean
}) {
  const { mock } = useConsole()
  const words = useMessages(BUILD_MESSAGES)
  const t = words.sheet
  const url = buildUrl(entry.id, liveOrigin(mock))
  const version = versionLabel(entry)
  return (
    <div className="flex flex-col items-center gap-5 py-2 text-center">
      <div className="bg-success/10 text-success grid size-12 place-items-center rounded-full">
        <Check className="size-6" aria-hidden="true" />
      </div>
      <div role="status" className="space-y-1">
        <h3 className="text-lg font-semibold">{replaced ? t.publishedReplace : t.publishedNew}</h3>
        <p className="text-muted-foreground text-sm">{mock ? t.liveMock : t.liveSoon}</p>
      </div>
      <div className="flex max-w-full min-w-0 items-center gap-3 text-left">
        <AppIcon src={icon} name={entry.name} />
        <div className="min-w-0">
          <p className="truncate font-medium">{entry.name}</p>
          {version && <p className="text-muted-foreground text-xs tabular-nums">{version}</p>}
        </div>
      </div>
      <QrCode text={url} label={words.qr.label(entry.name)} className="aspect-square w-48" />
      <div className="w-full max-w-sm space-y-2">
        <LinkRow url={url} />
        <p className="text-muted-foreground text-xs">{t.share}</p>
      </div>
    </div>
  )
}

/**
 * Upload a build, upload a new version of one under the same link, or edit one's name and
 * notes — in a sheet from the right, like Term & Privacy's.
 *
 * The file is read in the browser as soon as it is dropped, so what is wrong with it shows
 * before anything is sent. Publishing sends the bytes first, with a progress bar and a Cancel,
 * then reads the index at the branch's head and commits everything at once on that same commit.
 * The sheet cannot be closed while bytes are going up: Cancel first.
 *
 * A binary of 100 MiB or more cannot go into the repo, so it goes to a GitHub Release made for
 * it, through the Device Lab helper on this Mac (helper.ts; the helper card says what it needs
 * first), and the commit records the release instead of placing a blob. A release that a failed
 * or cancelled publish leaves without a commit is deleted again, and so is the release of a
 * version this one replaced, once this one is in.
 */
export function BuildSheet({
  target,
  takenIds,
  onClose,
  onIndex,
}: {
  target: BuildSheetTarget
  /** The links the list already shows, refused before an upload rather than after it. */
  takenIds: readonly string[]
  onClose: () => void
  /** The index as it now stands: after a publish, or as read when a publish was refused. */
  onIndex: (db: BuildDb) => void
}) {
  const { repo, mock, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const words = useMessages(BUILD_MESSAGES)
  const t = words.sheet
  const locale = useLocale()
  const current = target.mode === 'new' ? null : target.entry

  const [draft, setDraft] = useState<BuildDraft>(() => ({
    id: current?.id ?? randomId(),
    name: current?.name ?? '',
    notes: current?.notes ?? '',
  }))
  const [reading, setReading] = useState<Reading | null>(null)
  /** The drawn icon as a blob: URL, for the summary; revoked when replaced and on unmount. */
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const previewUrl = useRef<string | null>(null)
  /** Bumped by every file picked: a read that finishes after another file was picked is dropped. */
  const generation = useRef(0)
  /** The name was typed: a new file no longer replaces it with the app's own. */
  const nameTouched = useRef(false)
  const [phase, setPhase] = useState<Phase>(IDLE)
  const upload = useRef<AbortController | null>(null)
  const uploaded = useRef<{ file: File; icon: Blob | null; result: Uploaded } | null>(null)
  const [published, setPublished] = useState<BuildEntry | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  /**
   * The repo whose token the last publish was refused with. The error box offers to replace
   * the token, keeping the file and the answers, for as long as that is still the token in use.
   */
  const [refusedRepo, setRefusedRepo] = useState<Repo | null>(null)
  const tokenRefused = refusedRepo !== null && refusedRepo === repo
  const body = useRef<HTMLDivElement>(null)
  const busy = phase.kind !== 'idle'
  const cancellable = CANCELLABLE.has(phase.kind)
  /**
   * The last look for the Device Lab helper: for which file, at which ask (Check again, a
   * pairing and a failed upload each ask again), and what it found. The card shows it only
   * while both still match; until then it shows the look under way.
   */
  const [probe, setProbe] = useState<{
    readonly file: File
    readonly asked: number
    readonly found: HelperProbe
  } | null>(null)
  const [asked, setAsked] = useState(0)
  /** The console runs on a dev server: the helper must be started with --dev to answer it. */
  const dev = isDevOrigin(window.location)

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

  // An upload can take minutes, and leaving the page drops it: the browser asks first.
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

  // Gone (the route changed under the sheet): stop the upload, drop any read still under way,
  // and free the icon's preview.
  useEffect(
    () => () => {
      generation.current += 1
      upload.current?.abort()
      if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current)
    },
    [],
  )

  const showIcon = (blob: Blob | null) => {
    if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = blob === null ? null : URL.createObjectURL(blob)
    setIconPreview(previewUrl.current)
  }

  const pick = (file: File) => {
    generation.current += 1
    const turn = generation.current
    showIcon(null)
    setReading({ status: 'reading', file })
    setErrors([])
    void readBuild(file).then(
      ({ inspection, icon }) => {
        if (generation.current !== turn) return
        showIcon(icon)
        setReading({ status: 'read', file, inspection, icon })
        // Until the owner types a name, it follows the file read last: the app's own for a new
        // link, and for a new version the link's, unless the file is another app.
        if (target.mode !== 'edit' && !nameTouched.current) {
          setDraft((d) => ({ ...d, name: suggestedName(inspection, current) }))
        }
      },
      (error: unknown) => {
        if (generation.current !== turn) return
        setReading({
          status: 'failed',
          file,
          message: error instanceof Error ? error.message : all.unknownError,
        })
      },
    )
  }

  const chooseAnother = () => {
    generation.current += 1
    showIcon(null)
    setReading(null)
    setErrors([])
  }

  // For the sheet's whole life, a file let go beside the drop zone never makes the browser open
  // it over the console. While the zone is showing, it is taken as if dropped on the zone; at
  // any other time — a file being read or already read, an upload under way, an edit, which
  // takes no file — it is refused, rather than swapping the build out from under the owner.
  useFileDropGuard(
    target.mode !== 'edit' && published === null && reading === null && !busy ? pick : undefined,
  )

  const set = <K extends keyof BuildDraft>(key: K, value: BuildDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors([])
  }

  const read: ReadBuild | null = reading?.status === 'read' ? reading : null
  const findings = read
    ? fileFindings(read.inspection, read.file.size, target.mode === 'replace' ? target.entry : null)
    : NO_FINDINGS
  const notABuild = findings.problems.some((p) => p.code === 'NOT_A_BUILD')
  // Said by the file section's one live region, which stays mounted while the boxes under it
  // come and go: a region that appears with its text already in it is not read out, and the
  // summary and the findings are not live themselves, so a screen reader would hear the read
  // start and never end — nor why Publish stays off. A failed read says so in its own alert.
  const announcement =
    reading?.status === 'reading'
      ? t.reading
      : read !== null
        ? t.readResult(
            readSubject(read, !notABuild),
            findings.problems.length,
            findings.warnings.length,
          )
        : ''
  // A build of 100 MiB or more goes to a GitHub Release, through the helper on this Mac — but
  // in the dev mock, which simulates the release itself.
  const viaRelease = read !== null && findings.warnings.some((w) => w.code === 'VIA_RELEASE')
  const helperFile = viaRelease && !mock ? read.file : null
  const helperView: HelperView | null =
    helperFile === null
      ? null
      : probe !== null && probe.file === helperFile && probe.asked === asked
        ? probe.found
        : { state: 'checking' }

  /**
   * Quiet asks: the window back in focus. The card keeps what it shows meanwhile — a link half
   * pasted into it stays — and changes only if the answer does.
   */
  const [refreshed, setRefreshed] = useState(0)

  // Looks for the helper as soon as such a file is read, and again at each ask. What it finds
  // is kept with the file and the ask it answers, so a late answer to an older one is ignored.
  useEffect(() => {
    if (helperFile === null) return
    const controller = new AbortController()
    probeHelper(controller.signal).then(
      (found) => {
        setProbe({ file: helperFile, asked, found })
      },
      (error: unknown) => {
        // Cancelled: a newer ask, another file or the sheet closing answers instead.
        if (!isAbortError(error)) console.warn('[builds] could not look for the helper', error)
      },
    )
    return () => {
      controller.abort()
    }
  }, [helperFile, asked, refreshed])

  // Back from Terminal, where the owner started, updated or restarted the helper: ask again.
  const helperState = helperView?.state ?? null
  useEffect(() => {
    if (helperState === null || helperState === 'ready' || helperState === 'checking' || busy) {
      return
    }
    const again = () => {
      setRefreshed((n) => n + 1)
    }
    window.addEventListener('focus', again)
    return () => {
      window.removeEventListener('focus', again)
    }
  }, [helperState, busy])

  /** What the card's Pair found: proved just now, so ready, and the look under way is old. */
  const paired = (ready: ReadyHelper) => {
    if (helperFile === null) return
    setAsked(asked + 1)
    setProbe({ file: helperFile, asked: asked + 1, found: ready })
  }

  // An edit that changes nothing would only move the build's date: there is nothing to save.
  const edited =
    target.mode === 'edit' &&
    (cleanName(draft.name) !== target.entry.name || cleanNotes(draft.notes) !== target.entry.notes)
  // Publish waits for the helper to be ready, when the file needs it.
  const ready =
    target.mode === 'edit'
      ? edited
      : read !== null &&
        findings.problems.length === 0 &&
        (helperView === null || helperView.state === 'ready')

  const valuesOf = (finding: Finding): FindingValues => {
    const profile = read?.inspection.ios?.profile ?? null
    // A date finding without its own date is about the profile's expiry.
    const when = finding.detail ?? profile?.expires ?? ''
    return {
      detail: finding.detail ?? '',
      date: formatDateTime(when, locale),
      size: formatBytes(reading?.file.size ?? 0, locale),
      devices:
        profile === null || profile.device_count === null ? '' : String(profile.device_count),
      platform: current ? words.platformNames[current.platform] : '',
    }
  }

  /**
   * Hashes and uploads the icon and the binary, once per file: a retry reuses the blobs. A
   * binary that goes to a release is hashed but not uploaded here (`binary` null).
   */
  const uploadOnce = async (file: File, icon: Blob | null, signal: AbortSignal) => {
    const done = uploaded.current
    if (done !== null && done.file === file && done.icon === icon) {
      // Busy at once, as the upload would be: a second click must not start a second publish.
      setPhase({ kind: 'committing' })
      return done.result
    }
    setPhase({ kind: 'hashing' })
    const sha256 = await sha256Hex(file)
    signal.throwIfAborted()
    setPhase({ kind: 'icon' })
    const iconSha = icon === null ? null : await repo.upload(icon, { signal })
    let binary: string | null = null
    if (!needsRelease(file.size)) {
      setPhase({ kind: 'binary', fraction: 0 })
      binary = await repo.upload(file, {
        signal,
        onProgress: (fraction) => {
          if (!signal.aborted) setPhase({ kind: 'binary', fraction })
        },
      })
    }
    const result: Uploaded = { sha256, binary, icon: iconSha }
    uploaded.current = { file, icon, result }
    return result
  }

  /**
   * Sends a release's file through the helper. The helper is proved again first, whatever the
   * card said: the owner's GitHub token goes with the file, and only to a helper that has just
   * proved itself on that port (§2.8). What it finds is the card's new state, too.
   */
  const throughHelper = async (
    file: File,
    release: number,
    name: string,
    contentType: ReturnType<typeof releaseContentType>,
    options: UploadOptions,
  ): Promise<ReleaseAsset> => {
    const found = await probeHelper(options.signal)
    setProbe({ file, asked, found })
    if (found.state !== 'ready') throw new Error(t.helperNotReady)
    return uploadViaHelper({
      port: found.port,
      token: found.token,
      pat: readToken(),
      releaseId: release,
      name,
      file,
      contentType,
      onProgress: options.onProgress,
      signal: options.signal,
    })
  }

  /**
   * A binary of 100 MiB or more, sent to a GitHub Release made for it: the release first, then
   * its file — through the helper, or, in the dev mock, to the mock's own releases. `made` is
   * told the release as soon as it exists, so a failure from then on can delete it again.
   */
  const sendToRelease = async (
    id: string,
    file: string,
    source: ReadBuild,
    signal: AbortSignal,
    made: (release: { readonly id: number; readonly tag: string }) => void,
  ): Promise<ReleaseInfo> => {
    const releases = releasesOf(repo)
    const { inspection } = source
    const request = releaseFor(
      { id, name: draft.name, version: inspection.version, build: inspection.build },
      new Date(),
    )
    setPhase({ kind: 'release' })
    // Not abortable once sent: a Cancel meanwhile is honoured as soon as it is made.
    const { id: release } = await releases.createRelease(request)
    made({ id: release, tag: request.tag })
    signal.throwIfAborted()
    setPhase({ kind: 'asset', fraction: 0 })
    const options: UploadOptions = {
      signal,
      onProgress: (fraction) => {
        if (!signal.aborted) setPhase({ kind: 'asset', fraction })
      },
    }
    const contentType = releaseContentType(inspection.platform)
    let asset: ReleaseAsset
    if (mock) {
      if (!releases.uploadReleaseAsset) throw new Error('The mock cannot store release files.')
      asset = await releases.uploadReleaseAsset(release, file, source.file, options)
    } else {
      asset = await throughHelper(source.file, release, file, contentType, options)
    }
    // The install page links the file by its tag and name: an asset stored anywhere else would
    // be a dead Install button.
    if (asset.url !== releaseDownloadUrl(request.tag, file)) {
      throw new HelperUploadError('HELPER_BAD_REPLY')
    }
    return { id: release, tag: request.tag, asset_id: asset.id }
  }

  /** A new build, or a new version under a link: upload, then one commit at the head. */
  const publishBuild = async (id: string, source: ReadBuild) => {
    const used = repo
    const controller = new AbortController()
    upload.current = controller
    const { inspection } = source
    // The name the binary is published under: the release's asset, or the repo's file.
    const file = binaryFileName(
      draft.name,
      inspection.version,
      inspection.build,
      inspection.platform,
    )
    /** The release this publish made, until a commit records it: what a failure deletes. */
    const made: { release: { readonly id: number; readonly tag: string } | null } = {
      release: null,
    }
    /**
     * Deletes the release of a publish that will not be committed — best effort, and said when
     * it stays — before the failure itself is reported.
     */
    const abandon = async () => {
      const release = made.release
      made.release = null
      if (release === null) return
      setPhase({ kind: 'cleanup' })
      // Never throws: a failure is being reported already, and this only adds to it.
      if (!hasReleases(used) || !(await deleteBuildRelease(used, release))) {
        toast.warning(t.releaseLeft(release.tag))
      }
    }
    try {
      // The bytes go up before the head is read: an upload takes minutes on a slow line, and
      // reading after it keeps the window another publish could slip into as short as the commit.
      const blobs = await uploadOnce(source.file, source.icon, controller.signal)
      const release = needsRelease(source.file.size)
        ? await sendToRelease(id, file, source, controller.signal, (created) => {
            made.release = created
          })
        : null
      // From here the change is one commit, which cannot be taken back halfway.
      upload.current = null
      setPhase({ kind: 'committing' })
      const head = await repo.head()
      const index = await readBuildDb(repo, head)
      if (index === null) throw new Error(t.indexMissingNothingPublished(BUILD_DB_PATH))
      const listing = await repo.list(buildDir(id), head)
      if (current === null) {
        if (idTaken(id, index, listing)) {
          await abandon()
          showErrors([t.idTaken(id)])
          return
        }
      } else {
        const conflict = buildConflict(current, index, locale)
        if (conflict !== null) {
          await abandon()
          // The list behind the sheet shows the index as it is now.
          onIndex(index)
          showErrors([conflict])
          return
        }
      }
      const now = new Date().toISOString()
      const entry = entryFromInspection({
        inspection,
        id,
        name: draft.name,
        notes: draft.notes,
        file,
        size: source.file.size,
        sha256: blobs.sha256,
        icon: blobs.icon !== null,
        release,
        now,
        // Unchanged since the sheet opened (buildConflict), so it is the index's entry too.
        existing: current,
      })
      const plan = planBuildPublish(
        {
          entry,
          shas: { binary: blobs.binary, icon: blobs.icon },
          found: (listing ?? []).filter((f) => f.type === 'file').map((f) => f.path),
        },
        index,
        current,
        now,
      )
      await repo.commit({ ...plan, parent: head })
      // Recorded: the release is the build's now.
      made.release = null
      onIndex(plan.db)
      setPublished(entry)
      // The version this one replaced had its file in a release: nothing links it any more.
      // Its removal never undoes the publish; one that fails is only said.
      const old = current?.release ?? null
      if (old !== null && hasReleases(used)) {
        void deleteBuildRelease(used, old).then((gone) => {
          if (!gone) toast.warning(t.oldReleaseLeft(old.tag))
        })
      }
    } catch (error) {
      await abandon()
      if (controller.signal.aborted) {
        toast.info(t.cancelled, { description: t.cancelledDetail })
      } else if (error instanceof AuthError) {
        // A toast's action cannot be clicked under the open sheet, so the fix lives in the
        // sheet: replacing the token opens Settings on top and keeps the file and the answers.
        setRefusedRepo(used)
        setShown((n) => n + 1)
      } else {
        toastFailure(t.publishFailed, error, openSettings)
      }
      // The helper may be what failed: the card looks again, and says what it finds.
      if (!controller.signal.aborted && needsRelease(source.file.size) && !mock) {
        setAsked((n) => n + 1)
      }
    } finally {
      upload.current = null
      setPhase(IDLE)
    }
  }

  /** A new name or new notes: the page, the manifest and the index, in one commit. */
  const saveEdit = async (loaded: BuildEntry) => {
    const used = repo
    setPhase({ kind: 'committing' })
    try {
      const head = await repo.head()
      const index = await readBuildDb(repo, head)
      if (index === null) throw new Error(t.indexMissingNothingPublished(BUILD_DB_PATH))
      const conflict = buildConflict(loaded, index, locale)
      if (conflict !== null) {
        onIndex(index)
        showErrors([conflict])
        return
      }
      const plan = planBuildEdit(
        { ...loaded, name: draft.name, notes: draft.notes },
        index,
        new Date().toISOString(),
      )
      await repo.commit({ ...plan, parent: head })
      onIndex(plan.db)
      const saved = plan.db.entries.find((e) => e.id === loaded.id)
      toast.success(t.saved, {
        description: mock ? t.liveMock : t.savedDetail(saved?.name ?? loaded.name),
      })
      onClose()
    } catch (error) {
      if (error instanceof AuthError) {
        setRefusedRepo(used)
        setShown((n) => n + 1)
      } else {
        toastFailure(t.publishFailed, error, openSettings)
      }
    } finally {
      setPhase(IDLE)
    }
  }

  const publish = async () => {
    const id = current?.id ?? draft.id.trim()
    const problems = validateBuildDraft({ ...draft, id }, locale)
    // Refused before the upload, not after it: the list on screen already knows these.
    if (current === null && problems.length === 0 && takenIds.includes(id)) {
      problems.push(t.idTaken(id))
    }
    showErrors(problems)
    setRefusedRepo(null)
    if (problems.length > 0) return
    if (target.mode === 'edit') await saveEdit(target.entry)
    else if (read !== null && ready) await publishBuild(id, read)
  }

  /** Back to the drop zone, from a file that has been read. */
  const another = (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 shrink-0"
      disabled={busy}
      aria-label={t.chooseAnother}
      title={t.chooseAnother}
      onClick={chooseAnother}
    >
      <X />
    </Button>
  )

  const host = liveOrigin(mock).replace(/^https?:\/\//, '')
  const notesLength = cleanNotes(draft.notes).length

  const title =
    target.mode === 'new' ? t.newTitle : target.mode === 'replace' ? t.replaceTitle : t.editTitle
  const description =
    target.mode === 'new'
      ? t.newDescription
      : target.mode === 'replace'
        ? t.replaceDescription(target.entry.name)
        : t.editDescription(target.entry.name)

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl" showCloseButton={!busy}>
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="text-lg">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div ref={body} className="flex-1 overflow-y-auto px-6 py-6">
          {published !== null ? (
            <Published entry={published} icon={iconPreview} replaced={target.mode === 'replace'} />
          ) : (
            <>
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

              <div className="grid gap-8">
                {target.mode === 'edit' ? (
                  <Section title={t.current}>
                    <BuildSummary
                      facts={factsOfEntry(target.entry)}
                      iconSrc={iconUrl(target.entry, liveOrigin(mock))}
                    />
                  </Section>
                ) : (
                  <Section title={t.file}>
                    <p role="status" className="sr-only">
                      {announcement}
                    </p>
                    {current !== null && (
                      <p className="text-muted-foreground -mt-1 text-xs tabular-nums">
                        {t.current}: {versionLabel(current) || '—'} ·{' '}
                        {formatBytes(current.size, locale)}
                      </p>
                    )}
                    {reading === null ? (
                      <DropZone
                        accept=".apk,.ipa"
                        onFile={pick}
                        label={t.drop}
                        hint={t.dropHint}
                        icon={<Package />}
                      />
                    ) : reading.status === 'reading' ? (
                      <div className="flex items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-sm">
                        <Loader2
                          className="text-primary size-5 shrink-0 animate-spin"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="font-medium">{t.reading}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {reading.file.name} · {formatBytes(reading.file.size, locale)}
                          </p>
                        </div>
                      </div>
                    ) : reading.status === 'failed' ? (
                      <div
                        role="alert"
                        className="border-destructive/30 bg-destructive/5 rounded-xl border p-4 text-sm"
                      >
                        <p className="text-destructive font-medium">{t.readFailed}</p>
                        <p className="text-muted-foreground mt-1 break-words">
                          {reading.file.name}: {reading.message}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={chooseAnother}
                        >
                          {t.chooseAnother}
                        </Button>
                      </div>
                    ) : (
                      <>
                        {notABuild ? (
                          <UnreadFile file={reading.file} action={another} />
                        ) : (
                          <BuildSummary
                            facts={factsOfInspection(reading.inspection, reading.file.size)}
                            iconSrc={iconPreview}
                            action={another}
                          />
                        )}
                        <FindingList findings={findings} valuesOf={valuesOf} />
                        {viaRelease && (
                          <HelperCard
                            view={helperView ?? { state: 'checking' }}
                            mock={mock}
                            dev={dev}
                            disabled={busy}
                            onCheck={() => {
                              setAsked((n) => n + 1)
                            }}
                            onPaired={paired}
                          />
                        )}
                      </>
                    )}
                  </Section>
                )}

                <Section title={t.details}>
                  <Field id="build-name" label={t.appName} required hint={t.appNameHint}>
                    <Input
                      id="build-name"
                      value={draft.name}
                      disabled={busy}
                      onChange={(e) => {
                        nameTouched.current = true
                        set('name', e.target.value)
                      }}
                    />
                  </Field>
                  <Field
                    id="build-id"
                    label={t.link}
                    required
                    hint={
                      <>
                        {current !== null && <span className="block">{t.linkFixed}</span>}
                        <span className="font-mono break-all">
                          {host}/build/
                          <b className="text-foreground">{draft.id.trim() || '…'}</b>/
                        </span>
                      </>
                    }
                  >
                    <div className="flex gap-2">
                      <Input
                        id="build-id"
                        value={draft.id}
                        disabled={current !== null || busy}
                        className="font-mono"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => {
                          // Lowercase only: a macOS checkout cannot tell two cases apart.
                          set('id', e.target.value.toLowerCase())
                        }}
                      />
                      {current === null && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          disabled={busy}
                          aria-label={t.regenerate}
                          title={t.regenerate}
                          onClick={() => {
                            set('id', randomId())
                          }}
                        >
                          <RefreshCw />
                        </Button>
                      )}
                    </div>
                  </Field>
                  <Field
                    id="build-notes"
                    label={t.notes}
                    hint={
                      <div className="flex justify-between gap-4">
                        <span>
                          {target.mode === 'replace' && current?.notes
                            ? t.notesFromCurrent
                            : t.notesHint}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 tabular-nums',
                            notesLength > NOTES_MAX && 'text-destructive',
                          )}
                        >
                          {t.count(notesLength, NOTES_MAX)}
                        </span>
                      </div>
                    }
                  >
                    <Textarea
                      id="build-notes"
                      rows={5}
                      value={draft.notes}
                      disabled={busy}
                      placeholder={t.notesPlaceholder}
                      onChange={(e) => {
                        set('notes', e.target.value)
                      }}
                    />
                  </Field>
                </Section>
              </div>
            </>
          )}
        </div>

        <SheetFooter className="gap-3 border-t px-6 py-4">
          <PhaseStrip phase={phase} size={reading?.file.size ?? 0} mock={mock} />
          <div className="flex flex-row justify-end gap-2">
            {published !== null ? (
              <Button onClick={onClose}>{t.done}</Button>
            ) : (
              <>
                {cancellable ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      upload.current?.abort()
                    }}
                  >
                    <X /> {t.cancelUpload}
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={onClose}>
                    {all.cancel}
                  </Button>
                )}
                <Button
                  disabled={!ready || busy}
                  onClick={() => {
                    void publish()
                  }}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Check />}
                  {target.mode === 'edit' ? t.save : t.publish}
                </Button>
              </>
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
