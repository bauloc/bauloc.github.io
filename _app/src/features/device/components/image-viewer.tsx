import { ChevronLeft, ChevronRight, Copy, Download, ImageOff, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { browserCanShow, isHeif, type ImageRow } from '../backends/android/media'
import type { Backend } from '../backends/backend'
import { deviceErrorMessage, imageKey } from '../backends/backend'
import { fmtBytes, fmtDateTime, type Device } from '../model'
import { featureChecks } from '../preflight/checks'
import { BROWSER_NAMES } from '../preflight/copy'
import { parseBrowser } from '../preflight/env'
import type { BrowserName } from '../preflight/types'
import { InlineChecklist } from './checklist'

/*
  One photo from the phone, full size: read over USB when it opens (with progress, cancelled by
  closing), with its facts, Save (the original bytes, untouched), Copy image, and ←/→ through
  the album. HEIC and other types the browser can't draw are not read until Save asks for them.

  The helpers here are shared with the Images tab (images-tab.tsx imports them), so the two
  files never import each other in a circle.
*/

/* ---------------------------------------------------------------- *
 * Facts, as text
 * ---------------------------------------------------------------- */

/** `4032 × 3024`, or null when MediaStore did not say. */
export function fmtDimensions(width: number | null, height: number | null): string | null {
  return width && height ? `${String(width)} × ${String(height)}` : null
}

/**
 * The time a tile shows: when the photo was taken, else the file's time (most downloads have
 * no `datetaken`), and which one it is so the UI can say so.
 */
export function imageWhen(row: Pick<ImageRow, 'taken' | 'modified'>): {
  readonly at: number | null
  readonly source: 'taken' | 'modified' | null
} {
  if (row.taken !== null) return { at: row.taken, source: 'taken' }
  if (row.modified !== null) return { at: row.modified, source: 'modified' }
  return { at: null, source: null }
}

/** `image/jpeg` → `JPEG`, `image/x-adobe-dng` → `DNG`; `Image` when the type is unknown. */
export function typeLabel(mime: string): string {
  const sub = /^image\/(?:x-adobe-)?([\w.+-]+)$/i.exec(mime)?.[1]
  return sub ? sub.toUpperCase() : 'Image'
}

/** The tile's second line and the viewer's subtitle: `4032 × 3024 · 3.1 MB`. */
export function imageFacts(row: Pick<ImageRow, 'width' | 'height' | 'size'>): string {
  return [fmtDimensions(row.width, row.height), row.size === null ? null : fmtBytes(row.size)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * A name the computer accepts for Save: the phone's own name, without folder separators or
 * characters Windows refuses. Empty or all-dots becomes `image` plus the type's extension.
 */
export function saveName(name: string, mime: string): string {
  const clean = name
    .replace(/[/\\:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex -- control characters are what is being removed
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (clean && !/^\.*$/.test(clean)) return clean
  const ext = typeLabel(mime).toLowerCase()
  return `image.${ext === 'image' ? 'jpg' : ext === 'jpeg' ? 'jpg' : ext}`
}

/**
 * How an image goes on the clipboard. Browsers take PNG everywhere; anything else goes as it
 * is only where ClipboardItem.supports() says so (no browser takes JPEG today, but asking is
 * free), and is otherwise redrawn as PNG.
 */
export function clipboardPlan(
  mime: string,
  supports: (type: string) => boolean,
): { readonly type: string; readonly convert: boolean } {
  if (/^image\/png$/i.test(mime)) return { type: 'image/png', convert: false }
  if (/^image\/jpe?g$/i.test(mime) && supports('image/jpeg')) {
    return { type: 'image/jpeg', convert: false }
  }
  return { type: 'image/png', convert: true }
}

/**
 * Whether this browser draws the type. Safari draws HEIC; Chrome, Edge and Firefox don't
 * (preflight's `images.heic` row says the same).
 */
export function canDisplay(mime: string, browser: BrowserName): boolean {
  return browserCanShow(mime) || (isHeif(mime) && browser === 'safari')
}

/** The browser, the way preflight names it, from what this page can read synchronously. */
export function currentBrowser(): BrowserName {
  if (typeof navigator === 'undefined') return 'other'
  const data = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData
  return parseBrowser(data?.brands ?? [], navigator.userAgent)
}

/* ---------------------------------------------------------------- *
 * Originals in memory
 * ---------------------------------------------------------------- */

/**
 * The last few originals read, so ← then → doesn't read the same photo over USB twice, and
 * Save or Copy reuse what the viewer already has. Small on purpose: these are whole photos.
 */
const ORIGINALS_KEPT = 4
const ORIGINALS_MAX_BYTES = 96 * 1024 * 1024
const originals = new Map<string, Blob>()
/** One blob URL per blob, so a re-render (or StrictMode's second one) never makes another. */
const blobUrls = new WeakMap<Blob, string>()

function urlOf(blob: Blob): string {
  let url = blobUrls.get(blob)
  if (url === undefined) {
    url = URL.createObjectURL(blob)
    blobUrls.set(blob, url)
  }
  return url
}

function releaseUrl(blob: Blob) {
  const url = blobUrls.get(blob)
  if (url === undefined) return
  URL.revokeObjectURL(url)
  blobUrls.delete(blob)
}

function keepOriginal(key: string, blob: Blob) {
  originals.delete(key)
  originals.set(key, blob)
  let total = 0
  for (const b of originals.values()) total += b.size
  for (const [k, b] of originals) {
    if (originals.size <= ORIGINALS_KEPT && total <= ORIGINALS_MAX_BYTES) break
    if (k === key) continue
    originals.delete(k)
    total -= b.size
    releaseUrl(b)
  }
}

const originalKey = (deviceId: string, row: ImageRow) =>
  `${deviceId}|${imageKey(row)}|${String(row.modified ?? '')}|${String(row.size ?? '')}`

/** Redraw an image as PNG, for the clipboard. */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser couldn’t draw the image.')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('This browser couldn’t convert the image.'))
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = urlOf(blob)
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

/* ---------------------------------------------------------------- *
 * The viewer
 * ---------------------------------------------------------------- */

type Original =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly sent: number; readonly total: number | null }
  | { readonly status: 'ready'; readonly blob: Blob }
  | { readonly status: 'failed'; readonly message: string }

/** `2.1 of 4.3 MB · 48%`, or just the bytes so far when the size is unknown. */
export function progressText(sent: number, total: number | null): string {
  if (!total || total <= 0) return fmtBytes(sent)
  const pct = Math.min(100, Math.floor((sent / total) * 100))
  return `${fmtBytes(sent)} of ${fmtBytes(total)} · ${String(pct)}%`
}

/** Which way a key moves through the album, or null for a key the viewer leaves alone. */
export function viewerStep(key: string, index: number, count: number): number | null {
  const next =
    key === 'ArrowRight'
      ? index + 1
      : key === 'ArrowLeft'
        ? index - 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? count - 1
            : null
  if (next === null || next < 0 || next >= count || next === index) return null
  return next
}

/**
 * The album's photos, one at a time. Open while `index` is a number; closing calls onClose.
 * `onLoadMore` resolves to whether more rows arrived, so → at the end of a page carries on.
 */
export function ImageViewer({
  device,
  backend,
  rows,
  index,
  hasMore,
  onIndex,
  onLoadMore,
  onClose,
  onCloseFocus,
}: {
  device: Device
  backend: Backend
  rows: readonly ImageRow[]
  index: number | null
  hasMore: boolean
  onIndex: (index: number) => void
  onLoadMore: () => Promise<boolean>
  onClose: () => void
  /** Where focus goes when the viewer closes: the tile of the photo last shown. */
  onCloseFocus?: () => void
}) {
  const row = index === null ? undefined : rows[index]
  const [browser] = useState(currentBrowser)
  const [extending, setExtending] = useState(false)

  const go = (next: number) => {
    if (next >= 0 && next < rows.length) onIndex(next)
  }
  const forward = () => {
    if (index === null || extending) return
    if (index + 1 < rows.length) {
      onIndex(index + 1)
      return
    }
    if (!hasMore) return
    setExtending(true)
    void onLoadMore()
      .then((grew) => {
        if (grew) onIndex(index + 1)
      })
      .finally(() => {
        setExtending(false)
      })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (index === null || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowRight' && index === rows.length - 1) {
      e.preventDefault()
      forward()
      return
    }
    const next = viewerStep(e.key, index, rows.length)
    if (next === null) return
    e.preventDefault()
    go(next)
  }

  const atEnd = index !== null && index >= rows.length - 1 && !hasMore

  return (
    <Dialog
      open={row !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[92dvh] flex-col gap-4 sm:max-w-5xl"
        onKeyDown={onKeyDown}
        onCloseAutoFocus={(e) => {
          if (!onCloseFocus) return
          e.preventDefault()
          onCloseFocus()
        }}
      >
        {row && index !== null && (
          <>
            <DialogHeader className="min-w-0 pr-8">
              <DialogTitle className="truncate" title={row.name}>
                {row.name || 'Untitled image'}
              </DialogTitle>
              <DialogDescription>
                {[
                  `${String(index + 1)} of ${String(rows.length)}${hasMore ? '+' : ''}`,
                  imageFacts(row),
                  `${typeLabel(row.mime)} on ${device.name}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </DialogDescription>
            </DialogHeader>
            <ViewerBody
              key={originalKey(device.id, row)}
              device={device}
              backend={backend}
              row={row}
              browser={browser}
              nav={
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous image (←)"
                    title="Previous (←)"
                    aria-disabled={index === 0}
                    className="aria-disabled:opacity-50"
                    onClick={() => {
                      go(index - 1)
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next image (→)"
                    title="Next (→)"
                    aria-disabled={atEnd || extending}
                    className="aria-disabled:opacity-50"
                    onClick={forward}
                  >
                    {extending ? <Loader2 className="animate-spin" /> : <ChevronRight />}
                  </Button>
                </>
              }
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One photo: its bytes, its picture or the reason there is none, its facts and its actions. */
function ViewerBody({
  device,
  backend,
  row,
  browser,
  nav,
}: {
  device: Device
  backend: Backend
  row: ImageRow
  browser: BrowserName
  nav: ReactNode
}) {
  const key = originalKey(device.id, row)
  const displayable = canDisplay(row.mime, browser)
  const canRead = Boolean(backend.pull) && row.path !== ''
  const [original, setOriginal] = useState<Original>(() => {
    const kept = originals.get(key)
    if (kept) return { status: 'ready', blob: kept }
    return displayable && canRead
      ? { status: 'loading', sent: 0, total: row.size }
      : { status: 'idle' }
  })
  const [broken, setBroken] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef<Promise<Blob> | null>(null)

  /** Read the original once; every caller shares the one transfer. No synchronous setState. */
  const fetchOriginal = (): Promise<Blob> => {
    const kept = originals.get(key)
    if (kept) return Promise.resolve(kept)
    if (pending.current) return pending.current
    const pull = backend.pull
    if (!pull || !row.path) return Promise.reject(new Error('This connection can’t read files.'))
    const abort = new AbortController()
    controller.current = abort
    let last = 0
    const promise = pull(
      device.id,
      row.path,
      (sent: number, total: number | null) => {
        // Progress at most every 100 ms: a fast cable reports thousands of chunks.
        const now = performance.now()
        if (now - last < 100 || abort.signal.aborted) return
        last = now
        setOriginal({ status: 'loading', sent, total: total && total > 0 ? total : row.size })
      },
      abort.signal,
    ).then(
      (blob) => {
        // MediaStore's type is the truth for Save's name; the blob may arrive untyped.
        const typed = blob.type || !row.mime ? blob : new Blob([blob], { type: row.mime })
        keepOriginal(key, typed)
        if (!abort.signal.aborted) setOriginal({ status: 'ready', blob: typed })
        return typed
      },
      (error: unknown) => {
        pending.current = null
        if (!abort.signal.aborted) {
          setOriginal({ status: 'failed', message: deviceErrorMessage(error) })
        }
        throw error
      },
    )
    pending.current = promise
    return promise
  }

  /** For buttons: say it is loading, then read. */
  const ensureOriginal = (): Promise<Blob> => {
    if (original.status === 'ready') return Promise.resolve(original.blob)
    if (!pending.current) setOriginal({ status: 'loading', sent: 0, total: row.size })
    return fetchOriginal()
  }

  useEffect(() => {
    if (displayable && canRead) fetchOriginal().catch(() => undefined)
    return () => {
      // Closing or moving on cancels the transfer; a finished original stays in `originals`,
      // whose eviction releases its URL.
      controller.current?.abort()
      pending.current = null
    }
    // Mount and unmount only: the body is keyed by the photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = () => {
    ensureOriginal().then(
      (blob) => {
        saveBlob(blob, saveName(row.name, row.mime))
        toast.success('Saved', { description: saveName(row.name, row.mime) })
      },
      (error: unknown) => {
        toast.error(`Couldn’t read ${row.name || 'the image'} from ${device.name}`, {
          description: deviceErrorMessage(error),
        })
      },
    )
  }

  const copy = () => {
    if (!('ClipboardItem' in window) || !('write' in navigator.clipboard)) {
      toast.error('Copy image unsupported', {
        description: 'This browser can’t put images on the clipboard. Use Save.',
      })
      return
    }
    const supports = (type: string) =>
      typeof ClipboardItem.supports === 'function' && ClipboardItem.supports(type)
    const plan = clipboardPlan(row.mime, supports)
    // A promise, not an awaited blob: Safari drops the user gesture across an await.
    const data = ensureOriginal().then((blob) => (plan.convert ? toPng(blob) : blob))
    navigator.clipboard.write([new ClipboardItem({ [plan.type]: data })]).then(
      () => toast.success('Image copied'),
      (error: unknown) => {
        toast.error('Copy image failed', {
          description: error instanceof Error ? error.message : 'The clipboard write was rejected.',
        })
      },
    )
  }

  const notes = featureChecks('viewer', { mime: row.mime, browser })
  const when = imageWhen(row)
  const facts: [string, string | null][] = [
    ['Taken', row.taken === null ? null : fmtDateTime(new Date(row.taken))],
    ['Modified', row.modified === null ? null : fmtDateTime(new Date(row.modified))],
    ['Dimensions', fmtDimensions(row.width, row.height)],
    ['Size', row.size === null ? null : fmtBytes(row.size)],
    ['Type', row.mime || null],
    ['Folder', row.folder || null],
  ]

  return (
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[1fr_16rem]">
      <div className="bg-muted/30 relative grid min-h-64 place-items-center overflow-hidden rounded-lg border">
        <Picture
          row={row}
          original={original}
          displayable={displayable}
          canRead={canRead}
          broken={broken}
          browserName={BROWSER_NAMES[browser]}
          deviceName={device.name}
          onBroken={() => {
            setBroken(true)
          }}
          onRetry={() => {
            void ensureOriginal().catch(() => undefined)
          }}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {/* The note's Save is the toolbar's, right below it: not wired, so not shown twice. */}
        <InlineChecklist id={`image-note-${device.id}`} items={notes} />
        <div className="flex flex-wrap gap-2">
          {nav}
          <Button
            disabled={!canRead}
            title={canRead ? 'Save the original file' : 'This connection can’t read files'}
            onClick={save}
          >
            <Download /> Save
          </Button>
          <Button
            variant="outline"
            disabled={!canRead || !displayable || broken}
            title={displayable ? 'Copy the image' : 'This browser can’t draw this type'}
            onClick={copy}
          >
            <Copy /> Copy image
          </Button>
        </div>
        <dl className="divide-y text-sm">
          {facts.map(([label, value]) =>
            value === null ? null : (
              <div key={label} className="grid grid-cols-[5.5rem_1fr] gap-2 py-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 wrap-anywhere">{value}</dd>
              </div>
            ),
          )}
          {when.source === null && (
            <div className="grid grid-cols-[5.5rem_1fr] gap-2 py-1.5">
              <dt className="text-muted-foreground">Date</dt>
              <dd>Unknown</dd>
            </div>
          )}
          {row.path && (
            <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2 py-1.5">
              <dt className="text-muted-foreground">Path</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{row.path}</span>
                <CopyButton text={row.path} label="Copy path" />
              </dd>
            </div>
          )}
        </dl>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Read straight from the phone into this tab. Nothing is uploaded, and nothing is written to
          the phone.
        </p>
      </div>
    </div>
  )
}

/** The picture area: the photo, its progress, or why there is no picture and what to do. */
function Picture({
  row,
  original,
  displayable,
  canRead,
  broken,
  browserName,
  deviceName,
  onBroken,
  onRetry,
}: {
  row: ImageRow
  original: Original
  displayable: boolean
  canRead: boolean
  broken: boolean
  browserName: string
  deviceName: string
  onBroken: () => void
  onRetry: () => void
}) {
  if (!canRead) {
    return <Placeholder text="This connection can’t read files from the phone." />
  }
  if (original.status === 'failed') {
    return (
      <Placeholder text={`Couldn’t read the image from ${deviceName}: ${original.message}`}>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </Placeholder>
    )
  }
  if (original.status === 'loading') {
    const pct =
      original.total && original.total > 0
        ? Math.min(100, Math.floor((original.sent / original.total) * 100))
        : null
    return (
      <div className="flex w-full max-w-xs flex-col items-center gap-3 p-6 text-center text-sm">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
        <p className="text-muted-foreground">
          Reading from {deviceName}
          {original.sent > 0 ? ` · ${progressText(original.sent, original.total)}` : '…'}
        </p>
        {pct !== null && (
          <div
            role="progressbar"
            aria-label={`Reading ${row.name || 'the image'}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-primary h-full transition-[width]"
              style={{ width: `${String(pct)}%` }}
            />
          </div>
        )}
      </div>
    )
  }
  // HEIC has its own note in the side column; other types the browser can't draw get one here.
  if (!displayable) {
    return isHeif(row.mime) ? (
      <Placeholder text="No preview for HEIC in this browser." />
    ) : (
      <Placeholder
        text={`${browserName} can’t show ${typeLabel(row.mime)} images. Save it to open it on this computer.`}
      />
    )
  }
  if (original.status !== 'ready') return <Placeholder text="Not read yet." />
  if (broken) {
    return (
      <Placeholder
        text={`${browserName} couldn’t draw this image. Save it to open it on this computer.`}
      />
    )
  }
  return (
    <img
      src={urlOf(original.blob)}
      alt={row.name || 'Image from the phone'}
      className="max-h-[70dvh] w-auto max-w-full object-contain"
      onError={onBroken}
    />
  )
}

function Placeholder({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex max-w-sm flex-col items-center gap-3 p-6 text-center text-sm">
      <ImageOff className="size-7 opacity-60" />
      <p>{text}</p>
      {children}
    </div>
  )
}
