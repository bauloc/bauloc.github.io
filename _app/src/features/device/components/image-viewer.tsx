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
import { cn } from '@/lib/cn'
import { defineMessages, localized, useMessages } from '@/lib/i18n'

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
  closing or stepping on), with its facts, Save (the original bytes, untouched), Copy image, and
  ←/→ through the album. While the original is on its way the grid's preview stands in, and once
  it is shown the next photo the way the user is walking is read ahead, so stepping is instant.
  HEIC and other types the browser can't draw are not read until Save asks for them.

  The dialog keeps one size and one body for every photo: a frame that resized, or a body
  remounted per photo, made the dialog jump on each step and dropped focus from ← and →.

  The helpers here are shared with the Images tab (images-tab.tsx imports them), so the two
  files never import each other in a circle.
*/

/** What the helpers below say (facts, progress, errors), worded when they run. */
const IMAGE_TEXT = localized({
  en: {
    image: 'Image',
    unknown: 'Unknown',
    facts: {
      taken: 'Taken',
      modified: 'Modified',
      dimensions: 'Dimensions',
      size: 'Size',
      type: 'Type',
      folder: 'Folder',
    },
    progress: (sent: string, total: string, pct: number) => `${sent} of ${total} · ${String(pct)}%`,
    cannotDraw: 'This browser couldn’t draw the image.',
    cannotConvert: 'This browser couldn’t convert the image.',
  },
  vi: {
    image: 'Ảnh',
    unknown: 'Không rõ',
    facts: {
      taken: 'Ngày chụp',
      modified: 'Ngày sửa đổi',
      dimensions: 'Kích thước',
      size: 'Dung lượng',
      type: 'Loại',
      folder: 'Thư mục',
    },
    progress: (sent: string, total: string, pct: number) => `${sent}/${total} · ${String(pct)}%`,
    cannotDraw: 'Trình duyệt này không vẽ lại được ảnh.',
    cannotConvert: 'Trình duyệt này không chuyển đổi được ảnh.',
  },
})

const IMAGE_VIEWER_MESSAGES = defineMessages({
  en: {
    untitled: 'Untitled image',
    position: (at: number, count: number, more: boolean) =>
      `${String(at)} of ${String(count)}${more ? '+' : ''}`,
    typeOn: (type: string, device: string) => `${type} on ${device}`,
    previous: 'Previous image (←)',
    previousTitle: 'Previous (←)',
    next: 'Next image (→)',
    nextTitle: 'Next (→)',
    cannotRead: 'This connection can’t read files.',
    saved: 'Saved',
    theImage: 'the image',
    readFailed: (name: string, device: string) => `Couldn’t read ${name} from ${device}`,
    copyUnsupported: 'Copy image unsupported',
    copyUnsupportedDetail: 'This browser can’t put images on the clipboard. Use Save.',
    copied: 'Image copied',
    copyFailed: 'Copy image failed',
    writeRejected: 'The clipboard write was rejected.',
    saveTitle: 'Save the original file',
    cannotReadTitle: 'This connection can’t read files',
    save: 'Save',
    copyTitle: 'Copy the image',
    cannotDrawTitle: 'This browser can’t draw this type',
    copyImage: 'Copy image',
    readStraight:
      'Read straight from the phone into this tab. Nothing is uploaded, and nothing is written to the phone.',
    path: 'Path',
    copyPath: 'Copy path',
    fromPhone: 'Image from the phone',
    readingFrom: (device: string) => `Reading from ${device}`,
    starting: 'Starting…',
    reading: (name: string) => `Reading ${name}`,
    cannotReadPhone: 'This connection can’t read files from the phone.',
    readImageFailed: (device: string, reason: string) =>
      `Couldn’t read the image from ${device}: ${reason}`,
    retry: 'Retry',
    noHeicPreview: 'No preview for HEIC in this browser.',
    cannotShow: (browser: string, type: string) =>
      `${browser} can’t show ${type} images. Save it to open it on this computer.`,
    couldNotDraw: (browser: string) =>
      `${browser} couldn’t draw this image. Save it to open it on this computer.`,
    notRead: 'Not read yet.',
  },
  vi: {
    untitled: 'Ảnh không tên',
    position: (at: number, count: number, more: boolean) =>
      `${String(at)}/${String(count)}${more ? '+' : ''}`,
    typeOn: (type: string, device: string) => `${type} trên ${device}`,
    previous: 'Ảnh trước (←)',
    previousTitle: 'Trước (←)',
    next: 'Ảnh tiếp theo (→)',
    nextTitle: 'Tiếp (→)',
    cannotRead: 'Kết nối này không đọc được tệp.',
    saved: 'Đã lưu',
    theImage: 'ảnh',
    readFailed: (name: string, device: string) => `Không đọc được ${name} từ ${device}`,
    copyUnsupported: 'Không hỗ trợ sao chép ảnh',
    copyUnsupportedDetail: 'Trình duyệt này không sao chép được ảnh vào bộ nhớ tạm. Hãy dùng Lưu.',
    copied: 'Đã sao chép ảnh',
    copyFailed: 'Không sao chép được ảnh',
    writeRejected: 'Trình duyệt từ chối ghi vào bộ nhớ tạm.',
    saveTitle: 'Lưu tệp gốc',
    cannotReadTitle: 'Kết nối này không đọc được tệp',
    save: 'Lưu',
    copyTitle: 'Sao chép ảnh',
    cannotDrawTitle: 'Trình duyệt này không hiển thị được định dạng này',
    copyImage: 'Sao chép ảnh',
    readStraight:
      'Đọc thẳng từ điện thoại vào thẻ này. Không tải lên gì cả và không ghi gì vào điện thoại.',
    path: 'Đường dẫn',
    copyPath: 'Sao chép đường dẫn',
    fromPhone: 'Ảnh từ điện thoại',
    readingFrom: (device: string) => `Đang đọc từ ${device}`,
    starting: 'Đang bắt đầu…',
    reading: (name: string) => `Đang đọc ${name}`,
    cannotReadPhone: 'Kết nối này không đọc được tệp từ điện thoại.',
    readImageFailed: (device: string, reason: string) =>
      `Không đọc được ảnh từ ${device}: ${reason}`,
    retry: 'Thử lại',
    noHeicPreview: 'Trình duyệt này không xem trước được ảnh HEIC.',
    cannotShow: (browser: string, type: string) =>
      `${browser} không hiển thị được ảnh ${type}. Hãy lưu ảnh để mở trên máy tính này.`,
    couldNotDraw: (browser: string) =>
      `${browser} không hiển thị được ảnh này. Hãy lưu ảnh để mở trên máy tính này.`,
    notRead: 'Chưa đọc ảnh.',
  },
})

/**
 * The same messages, read in the language on screen when a toast is raised: Save and Copy
 * toast once the original has been read over USB, which may be after a language switch.
 */
const SAID = localized(IMAGE_VIEWER_MESSAGES)

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

/** `image/jpeg` → `jpeg`, `image/x-adobe-dng` → `dng`, as MediaStore wrote it; null if unknown. */
function imageSubtype(mime: string): string | null {
  return /^image\/(?:x-adobe-)?([\w.+-]+)$/i.exec(mime)?.[1] ?? null
}

/** `image/jpeg` → `JPEG`, `image/x-adobe-dng` → `DNG`; `Image` when the type is unknown. */
export function typeLabel(mime: string): string {
  return imageSubtype(mime)?.toUpperCase() ?? IMAGE_TEXT.image
}

/** The tile's second line and the viewer's subtitle: `4032 × 3024 · 3.1 MB`. */
export function imageFacts(row: Pick<ImageRow, 'width' | 'height' | 'size'>): string {
  return [fmtDimensions(row.width, row.height), row.size === null ? null : fmtBytes(row.size)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The viewer's facts, every row every time ("Unknown" when MediaStore did not say), so the rows
 * below a missing one stay where they were when stepping between photos.
 */
export function viewerFacts(
  row: Pick<ImageRow, 'taken' | 'modified' | 'width' | 'height' | 'size' | 'mime' | 'folder'>,
): [label: string, value: string][] {
  const { unknown, facts } = IMAGE_TEXT
  return [
    [facts.taken, row.taken === null ? unknown : fmtDateTime(new Date(row.taken))],
    [facts.modified, row.modified === null ? unknown : fmtDateTime(new Date(row.modified))],
    [facts.dimensions, fmtDimensions(row.width, row.height) ?? unknown],
    [facts.size, row.size === null ? unknown : fmtBytes(row.size)],
    [facts.type, row.mime || unknown],
    [facts.folder, row.folder || unknown],
  ]
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
  // From the type itself: typeLabel's word for an unknown type is in the language on screen.
  const ext = imageSubtype(mime)?.toLowerCase() ?? 'image'
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
 * Originals in memory, and the reads that fill it
 * ---------------------------------------------------------------- */

/**
 * The last few originals read, so ← then → doesn't read the same photo over USB twice, the
 * photo ahead can be read before it is asked for, and Save or Copy reuse what the viewer
 * already has. Small on purpose: these are whole photos.
 */
const ORIGINALS_KEPT = 4
const ORIGINALS_MAX_BYTES = 96 * 1024 * 1024
const originals = new Map<string, Blob>()
/**
 * Originals on screen, counted (StrictMode mounts twice): eviction skips them, so reading the
 * photo ahead never revokes the URL of the one being looked at.
 */
const onScreen = new Map<string, number>()
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
    if (k === key || onScreen.has(k)) continue
    originals.delete(k)
    total -= b.size
    releaseUrl(b)
  }
}

/** The kept original, now the most recently used. */
function touchOriginal(key: string): Blob | undefined {
  const blob = originals.get(key)
  if (blob) keepOriginal(key, blob)
  return blob
}

/** Marks an original as on screen until the returned function is called. */
function holdOriginal(key: string): () => void {
  onScreen.set(key, (onScreen.get(key) ?? 0) + 1)
  return () => {
    const n = (onScreen.get(key) ?? 1) - 1
    if (n > 0) onScreen.set(key, n)
    else onScreen.delete(key)
  }
}

/**
 * Whether reading an original of `size` bytes ahead of time leaves the ones on screen alone:
 * the kept originals are capped, and a read ahead must never be the reason a shown one goes.
 * An unknown size is tried; eviction still skips what is on screen.
 */
export function fitsAhead(
  size: number | null,
  shownBytes: number,
  maxBytes = ORIGINALS_MAX_BYTES,
): boolean {
  return size === null || shownBytes + size <= maxBytes
}

function shownBytes(): number {
  let total = 0
  for (const key of onScreen.keys()) total += originals.get(key)?.size ?? 0
  return total
}

export const originalKey = (deviceId: string, row: ImageRow) =>
  `${deviceId}|${imageKey(row)}|${String(row.modified ?? '')}|${String(row.size ?? '')}`

type Progress = (sent: number, total: number | null) => void

/** One read of one original over USB, and everyone waiting for it. */
interface Transfer {
  readonly done: Promise<Blob>
  readonly stop: AbortController
  readonly listeners: Set<Progress>
  users: number
  sent: number
  total: number | null
}

const transfers = new Map<string, Transfer>()

/** What reading an original needs: where it is, and the lane that reads it. */
export interface OriginalSource {
  readonly key: string
  readonly deviceId: string
  readonly row: Pick<ImageRow, 'path' | 'mime' | 'size'>
  readonly pull: NonNullable<Backend['pull']>
}

/**
 * An original: from memory, else from one read over USB that everyone who asks shares (the
 * viewer, the read ahead, Save and Copy). Each caller brings its own signal and leaves when it
 * aborts; the read itself stops once nobody is left. Leaving is settled a microtask later, so
 * the viewer stepping onto the photo it was reading ahead takes that read over, not a new one.
 */
export function readOriginal(
  source: OriginalSource,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<Blob> {
  const { key, deviceId, row, pull } = source
  const kept = originals.get(key)
  if (kept) return Promise.resolve(kept)
  if (signal.aborted) return Promise.reject(signal.reason as Error)
  let transfer = transfers.get(key)
  if (!transfer) {
    const stop = new AbortController()
    const listeners = new Set<Progress>()
    const done = pull(
      deviceId,
      row.path,
      (sent, total) => {
        if (stop.signal.aborted) return
        const known = total > 0 ? total : row.size
        started.sent = sent
        started.total = known
        for (const listener of listeners) listener(sent, known)
      },
      stop.signal,
    ).then((blob) => {
      // MediaStore's type is the truth for Save's name; the blob may arrive untyped.
      const typed = blob.type || !row.mime ? blob : new Blob([blob], { type: row.mime })
      keepOriginal(key, typed)
      return typed
    })
    const started: Transfer = { done, stop, listeners, users: 0, sent: 0, total: row.size }
    const forget = () => {
      if (transfers.get(key) === started) transfers.delete(key)
    }
    done.then(forget, forget)
    transfers.set(key, started)
    transfer = started
  }
  const shared = transfer
  shared.users++
  const listener: Progress = (sent, total) => {
    onProgress(sent, total)
  }
  shared.listeners.add(listener)
  return new Promise<Blob>((resolve, reject) => {
    let left = false
    const leave = () => {
      if (left) return
      left = true
      signal.removeEventListener('abort', onAbort)
      shared.listeners.delete(listener)
      shared.users--
    }
    const onAbort = () => {
      leave()
      reject(signal.reason as Error)
      queueMicrotask(() => {
        if (shared.users > 0) return
        shared.stop.abort()
        if (transfers.get(key) === shared) transfers.delete(key)
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    shared.done.then(
      (blob) => {
        leave()
        resolve(blob)
      },
      (error: unknown) => {
        leave()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Previews decoded ahead of their step, held so the browser keeps them decoded: a preview
 * first drawn by a fresh <img> is blank for a frame or two while it decodes, exactly when it is
 * meant to stand in. A few at a time; they are small.
 */
const WARM_KEPT = 6
const warm = new Map<string, HTMLImageElement>()

function warmUp(url: string): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve()
  let img = warm.get(url)
  if (!img) {
    img = new Image()
    img.src = url
    warm.set(url, img)
    for (const old of warm.keys()) {
      if (warm.size <= WARM_KEPT) break
      warm.delete(old)
    }
  }
  return typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve()
}

/** How far a read under way has got, for a viewer that joins it. */
function progressOf(key: string): { readonly sent: number; readonly total: number | null } | null {
  const transfer = transfers.get(key)
  return transfer ? { sent: transfer.sent, total: transfer.total } : null
}

/** Redraw an image as PNG, for the clipboard. */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(IMAGE_TEXT.cannotDraw)
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error(IMAGE_TEXT.cannotConvert))
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
  // The error, not its message: worded when shown, so it follows a language switch.
  | { readonly status: 'failed'; readonly error: unknown }

/** `2.1 of 4.3 MB · 48%`, or just the bytes so far when the size is unknown. */
export function progressText(sent: number, total: number | null): string {
  if (!total || total <= 0) return fmtBytes(sent)
  const pct = Math.min(100, Math.floor((sent / total) * 100))
  return IMAGE_TEXT.progress(fmtBytes(sent), fmtBytes(total), pct)
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

/** The grid's previews, which the viewer shows while a photo's original is on its way. */
export interface PreviewSource {
  /** The tile's preview, when the grid already has it. */
  readonly get: (row: ImageRow) => string | undefined
  /** Reads it (or joins a tile's read); undefined when the photo has none. */
  readonly load: (row: ImageRow, signal: AbortSignal) => Promise<string | undefined>
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
  previews,
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
  previews?: PreviewSource
}) {
  const t = useMessages(IMAGE_VIEWER_MESSAGES)
  const row = index === null ? undefined : rows[index]
  /**
   * The photo last shown. Closing clears `index` at once, but the dialog fades out for a moment
   * after: it fades with that photo in it, not as an empty panel.
   */
  const [last, setLast] = useState<{ readonly row: ImageRow; readonly index: number } | null>(null)
  if (row && index !== null && (last?.row !== row || last.index !== index)) setLast({ row, index })
  const shown = row && index !== null ? { row, index } : last
  const closing = row === undefined
  const [browser] = useState(currentBrowser)
  const [extending, setExtending] = useState(false)
  /** Which way the user walks (the photo ahead is read early), and whether they have yet. */
  const [travel, setTravel] = useState<{ readonly dir: 1 | -1; readonly stepped: boolean }>({
    dir: 1,
    stepped: false,
  })

  // Closed (by the user or because the photos went away): the next opening starts afresh.
  if (index === null && travel.stepped) setTravel({ dir: 1, stepped: false })

  const go = (next: number) => {
    if (index === null || next < 0 || next >= rows.length || next === index) return
    setTravel({ dir: next < index ? -1 : 1, stepped: true })
    onIndex(next)
  }
  const forward = () => {
    if (index === null || extending) return
    if (index + 1 < rows.length) {
      go(index + 1)
      return
    }
    if (!hasMore) return
    setExtending(true)
    void onLoadMore()
      .then((grew) => {
        if (!grew) return
        setTravel({ dir: 1, stepped: true })
        onIndex(index + 1)
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

  const at = shown?.index ?? 0
  const atEnd = at >= rows.length - 1 && !hasMore
  const position = t.position(at + 1, rows.length, hasMore)
  const ahead = index === null ? undefined : rows[index + travel.dir]

  return (
    <Dialog
      open={row !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/*
        A fixed height, whatever the photo: the dialog is centred, so a frame that grew or
        shrank with each picture would move the whole dialog, and the buttons with it.
      */}
      <DialogContent
        className="flex h-[min(92dvh,56rem)] flex-col gap-4 sm:max-w-5xl"
        onKeyDown={onKeyDown}
        onCloseAutoFocus={(e) => {
          if (!onCloseFocus) return
          e.preventDefault()
          onCloseFocus()
        }}
      >
        {shown && (
          <>
            <DialogHeader className="min-w-0 pr-8 text-left">
              <DialogTitle className="truncate leading-tight" title={shown.row.name}>
                {shown.row.name || t.untitled}
              </DialogTitle>
              {/* Two lines kept on a phone and one beside the picture: never a line more or less. */}
              <DialogDescription className="line-clamp-2 min-h-[2lh] md:line-clamp-1 md:min-h-0">
                {[position, imageFacts(shown.row), t.typeOn(typeLabel(shown.row.mime), device.name)]
                  .filter(Boolean)
                  .join(' · ')}
              </DialogDescription>
            </DialogHeader>
            {/* Focus stays on ← or →, so the new photo is said here; opening reads the title. */}
            <p role="status" aria-live="polite" className="sr-only">
              {travel.stepped && !closing ? `${shown.row.name || t.untitled}, ${position}` : ''}
            </p>
            <ViewerBody
              device={device}
              backend={backend}
              row={shown.row}
              closing={closing}
              ahead={ahead}
              browser={browser}
              previews={previews}
              nav={
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t.previous}
                    title={t.previousTitle}
                    aria-disabled={at === 0}
                    className="aria-disabled:opacity-50"
                    onClick={() => {
                      if (index !== null) go(index - 1)
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t.next}
                    title={t.nextTitle}
                    aria-disabled={atEnd || extending}
                    className="aria-disabled:opacity-50"
                    onClick={forward}
                  >
                    {extending ? (
                      <Loader2 className="motion-safe:animate-spin" />
                    ) : (
                      <ChevronRight />
                    )}
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

/** One photo's state in the viewer. Replaced, not remounted, when the photo changes. */
interface Photo {
  readonly key: string
  readonly original: Original
  /** The original is decoded and on screen; until then the grid's preview stands in. */
  readonly drawn: boolean
  readonly broken: boolean
  readonly preview: string | undefined
}

function photoFor(
  key: string,
  row: ImageRow,
  wanted: boolean,
  displayable: boolean,
  previews: PreviewSource | undefined,
): Photo {
  const kept = originals.get(key)
  const sofar = progressOf(key)
  return {
    key,
    original: kept
      ? { status: 'ready', blob: kept }
      : wanted
        ? { status: 'loading', sent: sofar?.sent ?? 0, total: sofar?.total ?? row.size }
        : { status: 'idle' },
    drawn: false,
    broken: false,
    preview: displayable ? previews?.get(row) : undefined,
  }
}

/** What the picture frame shows: a picture (or none) and what sits over it. */
export type FrameLayers =
  | { readonly overlay: 'note'; readonly picture: null }
  | {
      readonly overlay: 'progress' | 'spinner' | null
      readonly picture: 'preview' | 'original' | 'both' | null
    }

/**
 * The frame's layers. While the original is read or decoded the grid's preview stands in (the
 * original is drawn over it, hidden, and shown once decoded), so stepping never shows an
 * empty frame; a reason to have no picture is a note on its own.
 */
export function frameLayers(state: {
  readonly canRead: boolean
  readonly displayable: boolean
  readonly original: Original['status']
  readonly drawn: boolean
  readonly broken: boolean
  readonly preview: boolean
}): FrameLayers {
  const { canRead, displayable, original, drawn, broken, preview } = state
  if (!canRead || original === 'failed') return { overlay: 'note', picture: null }
  if (original === 'loading') {
    return { overlay: 'progress', picture: displayable && preview ? 'preview' : null }
  }
  if (!displayable || original !== 'ready' || broken) return { overlay: 'note', picture: null }
  if (drawn) return { overlay: null, picture: 'original' }
  return preview ? { overlay: null, picture: 'both' } : { overlay: 'spinner', picture: 'original' }
}

/** One photo: its bytes, its picture or the reason there is none, its facts and its actions. */
function ViewerBody({
  device,
  backend,
  row,
  closing,
  ahead,
  browser,
  previews,
  nav,
}: {
  device: Device
  backend: Backend
  row: ImageRow
  /** The dialog is fading out: everything still being read stops now, not once it has gone. */
  closing: boolean
  /** The next photo the way the user is walking: read once this one is shown. */
  ahead: ImageRow | undefined
  browser: BrowserName
  previews: PreviewSource | undefined
  nav: ReactNode
}) {
  const t = useMessages(IMAGE_VIEWER_MESSAGES)
  const key = originalKey(device.id, row)
  const displayable = canDisplay(row.mime, browser)
  const pull = backend.pull
  const canRead = Boolean(pull) && row.path !== ''
  const wanted = displayable && canRead

  // A new photo resets the state while rendering, not in an effect, so no frame ever pairs one
  // photo's title with another's picture.
  const [stored, setPhoto] = useState<Photo>(() =>
    photoFor(key, row, wanted, displayable, previews),
  )
  let photo = stored
  if (stored.key !== key) {
    photo = photoFor(key, row, wanted, displayable, previews)
    setPhoto(photo)
  }
  const patch = (forKey: string, change: (p: Photo) => Photo) => {
    setPhoto((p) => (p.key === forKey ? change(p) : p))
  }

  /** Save and Copy outlive a step (they were asked for), not the viewer: closing stops them. */
  const open = useRef<AbortController | null>(null)
  /** This photo's own read, Retry's included: stepping on or closing stops it. */
  const life = useRef<AbortController | null>(null)
  /** The read ahead, and which photo it is for. */
  const reading = useRef<{ readonly key: string; readonly stop: AbortController } | null>(null)
  /**
   * Previews read for the photo ahead, by photo. Each is stopped once its photo is neither this
   * one nor the one ahead: queued behind the grid's few slots, reads for photos walked past would
   * otherwise hold up the preview of the photo the user stops on.
   */
  const previewReads = useRef(new Map<string, AbortController>())

  useEffect(() => {
    if (closing) return
    const controller = new AbortController()
    open.current = controller
    return () => {
      controller.abort()
      reading.current?.stop.abort()
      reading.current = null
    }
  }, [closing])

  /** Reads this photo's original into the state, sharing the read with anyone else. */
  const read = (signal: AbortSignal): Promise<Blob> => {
    if (!pull || !row.path) return Promise.reject(new Error(t.cannotRead))
    const forKey = key
    let last = 0
    return readOriginal(
      { key: forKey, deviceId: device.id, row, pull },
      (sent, total) => {
        // Progress at most every 100 ms: a fast cable reports thousands of chunks.
        const now = performance.now()
        if (now - last < 100) return
        last = now
        patch(forKey, (p) =>
          p.original.status === 'loading'
            ? { ...p, original: { status: 'loading', sent, total } }
            : p,
        )
      },
      signal,
    ).then(
      (blob) => {
        patch(forKey, (p) => ({ ...p, original: { status: 'ready', blob } }))
        return blob
      },
      (error: unknown) => {
        if (!signal.aborted) {
          patch(forKey, (p) => ({ ...p, original: { status: 'failed', error } }))
        }
        throw error
      },
    )
  }

  // Each photo: hold its original on screen, read it (taking over the read ahead when it was
  // this photo), and fetch the grid's preview if the tile never had one. Stepping on aborts it.
  useEffect(() => {
    if (closing) return
    const photoLife = new AbortController()
    life.current = photoLife
    const release = holdOriginal(key)
    if (wanted) {
      touchOriginal(key)
      read(photoLife.signal).catch(() => undefined)
      if (!originals.has(key) && previews && !previews.get(row)) {
        previews
          .load(row, photoLife.signal)
          .then(async (url) => {
            if (!url) return
            await warmUp(url)
            patch(key, (p) => (p.preview ? p : { ...p, preview: url }))
          })
          .catch(() => undefined)
      }
    }
    // Joined above, so a read ahead of this very photo carries on as this photo's read.
    reading.current?.stop.abort()
    reading.current = null
    return () => {
      photoLife.abort()
      if (life.current === photoLife) life.current = null
      release()
    }
    // Once per photo: `key` names it, and the rest follows from the row it names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, closing])

  // Once this photo is on screen (or has nothing to show), read the next one ahead, if the
  // kept originals have room for it beside this one.
  const settled = !wanted || photo.drawn || photo.broken || photo.original.status === 'failed'
  const aheadKey = ahead ? originalKey(device.id, ahead) : null
  useEffect(() => {
    if (closing || !settled || !ahead || !aheadKey || !pull) return
    if (reading.current?.key === aheadKey) return
    reading.current?.stop.abort()
    reading.current = null
    if (
      !canDisplay(ahead.mime, browser) ||
      !ahead.path ||
      originals.has(aheadKey) ||
      !fitsAhead(ahead.size, shownBytes())
    ) {
      return
    }
    const stop = new AbortController()
    reading.current = { key: aheadKey, stop }
    readOriginal(
      { key: aheadKey, deviceId: device.id, row: ahead, pull },
      () => undefined,
      stop.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        if (reading.current?.stop === stop) reading.current = null
      })
    // The photo ahead is named by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing, settled, aheadKey])

  // The photo ahead's preview, straight away and decoded: a few KB, so the next step has a
  // picture at once even when its original is still to come. Kept for the grid too. Stepping
  // onto that photo keeps its read going (this photo's own preview joins it); walking past it
  // or closing stops it.
  useEffect(() => {
    const reads = previewReads.current
    for (const [k, stop] of reads) {
      if (!closing && (k === key || k === aheadKey)) continue
      stop.abort()
      reads.delete(k)
    }
    if (closing || !ahead || !aheadKey || !previews || !canDisplay(ahead.mime, browser)) return
    const kept = previews.get(ahead)
    if (kept) {
      void warmUp(kept)
      return
    }
    if (reads.has(aheadKey)) return
    const stop = new AbortController()
    reads.set(aheadKey, stop)
    previews
      .load(ahead, stop.signal)
      .then((url) => (url ? warmUp(url) : undefined))
      .catch(() => undefined)
      .finally(() => {
        if (reads.get(aheadKey) === stop) reads.delete(aheadKey)
      })
    // The photos are named by their keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing, key, aheadKey])

  useEffect(() => {
    const reads = previewReads.current
    return () => {
      for (const stop of reads.values()) stop.abort()
      reads.clear()
    }
  }, [])

  /** For buttons: say it is loading, then read for as long as `signal` lets it. */
  const ensureOriginal = (signal: AbortSignal | undefined): Promise<Blob> => {
    if (photo.original.status === 'ready') return Promise.resolve(photo.original.blob)
    if (photo.original.status !== 'loading') {
      const sofar = progressOf(key)
      patch(key, (p) => ({
        ...p,
        original: { status: 'loading', sent: sofar?.sent ?? 0, total: sofar?.total ?? row.size },
      }))
    }
    return read(signal ?? new AbortController().signal)
  }

  const save = () => {
    const signal = open.current?.signal
    ensureOriginal(signal).then(
      (blob) => {
        saveBlob(blob, saveName(row.name, row.mime))
        toast.success(SAID.saved, { description: saveName(row.name, row.mime) })
      },
      (error: unknown) => {
        if (signal?.aborted) return
        toast.error(SAID.readFailed(row.name || SAID.theImage, device.name), {
          description: deviceErrorMessage(error),
        })
      },
    )
  }

  const copy = () => {
    if (!('ClipboardItem' in window) || !('write' in navigator.clipboard)) {
      toast.error(t.copyUnsupported, {
        description: t.copyUnsupportedDetail,
      })
      return
    }
    const supports = (type: string) =>
      typeof ClipboardItem.supports === 'function' && ClipboardItem.supports(type)
    const plan = clipboardPlan(row.mime, supports)
    // A promise, not an awaited blob: Safari drops the user gesture across an await.
    const data = ensureOriginal(open.current?.signal).then((blob) =>
      plan.convert ? toPng(blob) : blob,
    )
    navigator.clipboard.write([new ClipboardItem({ [plan.type]: data })]).then(
      () => toast.success(SAID.copied),
      (error: unknown) => {
        toast.error(SAID.copyFailed, {
          description: error instanceof Error ? error.message : SAID.writeRejected,
        })
      },
    )
  }

  const notes = featureChecks('viewer', { mime: row.mime, browser })

  return (
    // Beside the picture (md and up) the side column scrolls on its own, so a longer path or a
    // note never makes the frame taller; on a phone the frame has its own height and the
    // whole body scrolls under the header. -m-1 p-1 keeps focus rings inside the scroller.
    <div className="-m-1 grid min-h-0 flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-1 md:grid-cols-[minmax(0,1fr)_16rem] md:grid-rows-[minmax(0,1fr)] md:content-stretch md:overflow-hidden">
      <Frame
        row={row}
        photo={photo}
        displayable={displayable}
        canRead={canRead}
        browserName={BROWSER_NAMES[browser]}
        deviceName={device.name}
        onDrawn={() => {
          patch(key, (p) => (p.drawn ? p : { ...p, drawn: true }))
        }}
        onBroken={() => {
          patch(key, (p) => ({ ...p, broken: true }))
        }}
        onRetry={() => {
          // The photo's own read again: stepping away stops it, unlike Save and Copy.
          const signal = life.current?.signal
          if (signal) void ensureOriginal(signal).catch(() => undefined)
        }}
        note={
          // The note's Save is the toolbar's: not wired, so not shown twice.
          notes.length > 0 ? <InlineChecklist id={`image-note-${device.id}`} items={notes} /> : null
        }
      />

      <div className="-m-1 flex min-w-0 flex-col gap-4 p-1 md:min-h-0 md:overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          {nav}
          <Button
            disabled={!canRead}
            title={canRead ? t.saveTitle : t.cannotReadTitle}
            onClick={save}
          >
            <Download /> {t.save}
          </Button>
          <Button
            variant="outline"
            disabled={!canRead || !displayable || photo.broken}
            title={displayable ? t.copyTitle : t.cannotDrawTitle}
            onClick={copy}
          >
            <Copy /> {t.copyImage}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">{t.readStraight}</p>
        <dl className="divide-y text-sm">
          {viewerFacts(row).map(([label, value]) => (
            <div key={label} className="grid grid-cols-[5.5rem_1fr] gap-2 py-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 wrap-anywhere">{value}</dd>
            </div>
          ))}
          {row.path && (
            // Top-aligned: a path that wraps to one line more moves nothing beside it.
            <div className="grid grid-cols-[5.5rem_1fr] items-start gap-2 py-1.5">
              <dt className="text-muted-foreground">{t.path}</dt>
              <dd className="flex min-w-0 items-start gap-1">
                <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{row.path}</span>
                <CopyButton text={row.path} label={t.copyPath} />
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

/**
 * The picture frame: one size whatever is in it (on a phone its own height, beside the facts
 * the row's), so stepping between a tall screenshot, a wide photo and a note moves nothing.
 * Every layer is positioned over the frame and none of them sizes it.
 */
function Frame({
  row,
  photo,
  displayable,
  canRead,
  browserName,
  deviceName,
  onDrawn,
  onBroken,
  onRetry,
  note,
}: {
  row: ImageRow
  photo: Photo
  displayable: boolean
  canRead: boolean
  browserName: string
  deviceName: string
  onDrawn: () => void
  onBroken: () => void
  onRetry: () => void
  /** The preflight note for a type this browser can't draw (HEIC), shown in the frame. */
  note: ReactNode
}) {
  const t = useMessages(IMAGE_VIEWER_MESSAGES)
  const { original } = photo
  const layers = frameLayers({
    canRead,
    displayable,
    original: original.status,
    drawn: photo.drawn,
    broken: photo.broken,
    preview: photo.preview !== undefined,
  })
  const showPreview = layers.picture === 'preview' || layers.picture === 'both'
  const showOriginal = layers.picture === 'original' || layers.picture === 'both'

  return (
    <div
      data-slot="image-frame"
      className="bg-muted/30 relative h-[min(50dvh,28rem)] min-h-48 overflow-hidden rounded-lg border md:h-auto md:min-h-0"
    >
      {showPreview && photo.preview && (
        // Where the original will land: contained, and never larger than the original is.
        <img
          src={photo.preview}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 m-auto size-full object-contain"
          style={{
            ...(row.width ? { maxWidth: `${String(row.width)}px` } : {}),
            ...(row.height ? { maxHeight: `${String(row.height)}px` } : {}),
          }}
        />
      )}
      {showOriginal && original.status === 'ready' && (
        <img
          key={photo.key}
          src={urlOf(original.blob)}
          alt={row.name || t.fromPhone}
          decoding="async"
          className={cn(
            'absolute inset-0 size-full object-scale-down',
            !photo.drawn && 'opacity-0',
          )}
          onLoad={(e) => {
            // Shown once decoded, so the preview is never swapped for a half-drawn picture.
            const img = e.currentTarget
            const decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve()
            decoded.then(onDrawn, onDrawn)
          }}
          onError={onBroken}
        />
      )}
      {layers.overlay === 'progress' && original.status === 'loading' && (
        <ReadProgress
          photoKey={photo.key}
          row={row}
          sent={original.sent}
          total={original.total}
          deviceName={deviceName}
        />
      )}
      {layers.overlay === 'spinner' && (
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 className="text-muted-foreground size-6 motion-safe:animate-spin" />
        </div>
      )}
      {layers.overlay === 'note' && (
        <FrameNote
          row={row}
          original={original}
          displayable={displayable}
          canRead={canRead}
          browserName={browserName}
          deviceName={deviceName}
          onRetry={onRetry}
          note={note}
        />
      )}
    </div>
  )
}

/**
 * The read's progress, at the foot of the frame over the preview. Three lines of fixed height
 * whatever the numbers say, so the card never grows as they change.
 */
function ReadProgress({
  photoKey,
  row,
  sent,
  total,
  deviceName,
}: {
  /** The card stays from photo to photo; its bar starts afresh with each one. */
  photoKey: string
  row: ImageRow
  sent: number
  total: number | null
  deviceName: string
}) {
  const t = useMessages(IMAGE_VIEWER_MESSAGES)
  const pct = total && total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : null
  return (
    <div className="bg-background/90 text-muted-foreground absolute inset-x-0 bottom-3 mx-auto flex w-72 max-w-[calc(100%-1.5rem)] flex-col gap-1.5 rounded-md border p-3 text-sm shadow-sm backdrop-blur-sm">
      <p className="flex min-w-0 items-center gap-2">
        <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" />
        <span className="truncate">{t.readingFrom(deviceName)}</span>
      </p>
      <p className="truncate text-xs tabular-nums">
        {sent > 0 ? progressText(sent, total) : t.starting}
      </p>
      <div
        className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        {...(pct === null
          ? {}
          : {
              role: 'progressbar',
              'aria-label': t.reading(row.name || t.theImage),
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': pct,
            })}
      >
        {/*
          Keyed by photo: the width eases while one photo is read, but a new photo's bar starts
          at its own value instead of sliding there from the last photo's.
        */}
        <div
          key={photoKey}
          data-slot="read-progress-bar"
          className="bg-primary h-full motion-safe:transition-[width]"
          style={{ width: `${String(pct ?? 0)}%` }}
        />
      </div>
    </div>
  )
}

/** Why there is no picture, and what to do. */
function FrameNote({
  row,
  original,
  displayable,
  canRead,
  browserName,
  deviceName,
  onRetry,
  note,
}: {
  row: ImageRow
  original: Original
  displayable: boolean
  canRead: boolean
  browserName: string
  deviceName: string
  onRetry: () => void
  note: ReactNode
}) {
  const t = useMessages(IMAGE_VIEWER_MESSAGES)
  if (!canRead) {
    return <Placeholder text={t.cannotReadPhone} />
  }
  if (original.status === 'failed') {
    return (
      <Placeholder text={t.readImageFailed(deviceName, deviceErrorMessage(original.error))}>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t.retry}
        </Button>
      </Placeholder>
    )
  }
  // HEIC's note is preflight's, with what to do; other types the browser can't draw get one here.
  // Inside the frame, so a note that comes and goes with the photo moves nothing beside it.
  if (!displayable) {
    if (note) {
      return (
        <div className="absolute inset-0 grid place-items-center overflow-y-auto p-4">
          <div className="w-full max-w-sm">{note}</div>
        </div>
      )
    }
    return isHeif(row.mime) ? (
      <Placeholder text={t.noHeicPreview} />
    ) : (
      <Placeholder text={t.cannotShow(browserName, typeLabel(row.mime))} />
    )
  }
  if (original.status === 'ready') {
    return <Placeholder text={t.couldNotDraw(browserName)} />
  }
  return <Placeholder text={t.notRead} />
}

function Placeholder({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
      <div className="text-muted-foreground flex max-w-sm flex-col items-center gap-3 text-center text-sm">
        <ImageOff className="size-7 opacity-60" />
        <p>{text}</p>
        {children}
      </div>
    </div>
  )
}
