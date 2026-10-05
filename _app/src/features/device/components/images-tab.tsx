import { FileImage, ImageOff, Images, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { untilAborted } from '@/lib/abort'
import { cn } from '@/lib/cn'
import { defineMessages, localized, useMessages } from '@/lib/i18n'
import { INTL_LOCALE } from '@/lib/locale'

import {
  IMAGE_PAGE_SIZE,
  PREVIEW_CONCURRENCY,
  PREVIEW_MAX_EDGE,
  PREVIEW_MAX_ORIGINAL_BYTES,
  browserCanShow,
  isHeif,
  previewSize,
  sniffImage,
  type Album,
  type ImageFormat,
  type ImageRow,
} from '../backends/android/media'
import type { Backend } from '../backends/backend'
import { deviceErrorMessage, imageKey } from '../backends/backend'
import { fmtDateTime, type Device } from '../model'
import { featureChecks } from '../preflight/checks'
import type { ImagesOutcome } from '../preflight/types'
import { InlineChecklist } from './checklist'
import { ImageViewer, imageFacts, imageWhen, typeLabel, type PreviewSource } from './image-viewer'

/*
  The Images tab (PLAN §4.5): the phone's photos by album, newest first, a page at a time,
  with a preview for each tile and the viewer one click away.

  Previews never make Android write anything (the lead's STRICT NO-WRITE decision). Reading a
  MediaStore thumbnail URI makes MediaProvider generate and SAVE a cache file when it has none,
  so a preview is only ever:
  1. a thumbnail Android already has, read as a plain file, else
  2. the original, when it is small enough and the browser can draw it,
  both through backend.thumbnail (a lane without it gets the original through pull), then
  shrunk here with createImageBitmap.
  Only tiles on screen ask, PREVIEW_CONCURRENCY at a time (the log and screenshots share the
  cable), and the shrunk previews are kept in memory for the life of the page. A tile with no
  preview says why; it never toasts.
*/

/** The albums' names, in the language on screen whenever one is read. */
const ALBUM_LABELS = localized<Readonly<Record<Album, string>>>({
  en: { screenshots: 'Screenshots', camera: 'Camera', all: 'All images' },
  vi: { screenshots: 'Ảnh chụp màn hình', camera: 'Máy ảnh', all: 'Tất cả ảnh' },
})

/**
 * The albums, in the segmented control's order. Screenshots first: it is what testers want.
 * Downloads and Videos come in P2 (PLAN §4.5). Each label is a getter, so it reads the
 * language at the moment it is shown.
 */
export const IMAGE_ALBUMS: readonly { readonly value: Album; readonly label: string }[] = (
  ['screenshots', 'camera', 'all'] as const
).map((value) => ({
  value,
  get label() {
    return ALBUM_LABELS[value]
  },
}))

const isAlbum = (value: string): value is Album => IMAGE_ALBUMS.some((a) => a.value === value)

const IMAGES_TAB_MESSAGES = defineMessages({
  en: {
    title: 'Images',
    readStraight: (device: string) =>
      `Read straight from ${device} into this tab. Nothing is uploaded, and nothing is written to the phone.`,
    size: 'Size',
    thumbnailSize: 'Thumbnail size',
    refreshLabel: 'Refresh images',
    refreshTitle: 'Read the album again',
    refresh: 'Refresh',
    album: 'Album',
    cannotList: 'This connection can’t list the phone’s images.',
    loading: 'Loading images',
    /** What an empty album says. */
    empty: {
      screenshots: (device: string) => `No screenshots on ${device}.`,
      camera: (device: string) => `No camera photos on ${device}.`,
      all: (device: string) => `No images on ${device}.`,
    },
    albumOn: (album: string, device: string) => `${album} on ${device}`,
    count: (count: number, more: boolean) =>
      `${count.toLocaleString('en')} ${count === 1 ? 'image' : 'images'}${more ? ' so far' : ''}`,
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    moreFailed: (device: string, reason: string) =>
      `Couldn’t read more images from ${device}: ${reason}`,
    dateUnknown: 'Date unknown',
    image: 'Image',
    fileTime: 'File time: the photo has no date taken',
    taken: 'Taken',
  },
  vi: {
    title: 'Ảnh',
    readStraight: (device: string) =>
      `Đọc thẳng từ ${device} vào thẻ này. Không tải lên gì cả và không ghi gì vào điện thoại.`,
    size: 'Cỡ',
    thumbnailSize: 'Cỡ ảnh thu nhỏ',
    refreshLabel: 'Làm mới ảnh',
    refreshTitle: 'Đọc lại album',
    refresh: 'Làm mới',
    album: 'Album',
    cannotList: 'Kết nối này không liệt kê được ảnh trên điện thoại.',
    loading: 'Đang tải ảnh',
    empty: {
      screenshots: (device: string) => `Không có ảnh chụp màn hình nào trên ${device}.`,
      camera: (device: string) => `Không có ảnh chụp từ máy ảnh nào trên ${device}.`,
      all: (device: string) => `Không có ảnh nào trên ${device}.`,
    },
    albumOn: (album: string, device: string) => `${album} trên ${device}`,
    count: (count: number, more: boolean) =>
      `${more ? 'Đã tải ' : ''}${count.toLocaleString(INTL_LOCALE.vi)} ảnh`,
    loadMore: 'Tải thêm',
    loadingMore: 'Đang tải…',
    moreFailed: (device: string, reason: string) =>
      `Không đọc thêm được ảnh từ ${device}: ${reason}`,
    dateUnknown: 'Không rõ ngày',
    image: 'Ảnh',
    fileTime: 'Thời gian của tệp: ảnh không có ngày chụp',
    taken: 'Ngày chụp',
  },
})

/** Page two onwards, without a photo a shifted page would repeat. */
export function appendPage(rows: readonly ImageRow[], page: readonly ImageRow[]): ImageRow[] {
  const seen = new Set(rows.map(imageKey))
  return rows.concat(page.filter((r) => !seen.has(imageKey(r))))
}

/* ---------------------------------------------------------------- *
 * Previews: what to read, in what order, and why there is none
 * ---------------------------------------------------------------- */

/** Why a tile shows a placeholder instead of a picture. */
export type PreviewReason = 'heic' | 'unsupported' | 'too-large' | 'unavailable' | 'failed'

export type Preview =
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'none'; readonly reason: PreviewReason }

export const PREVIEW_REASON_TEXT = localized<Readonly<Record<PreviewReason, string>>>({
  en: {
    heic: 'HEIC: open it to save',
    unsupported: 'No preview for this type',
    'too-large': 'Large file: open it to view',
    unavailable: 'No preview',
    failed: 'Preview failed',
  },
  vi: {
    heic: 'HEIC: mở ảnh để lưu',
    unsupported: 'Không xem trước được định dạng này',
    'too-large': 'Tệp lớn: mở ảnh để xem',
    unavailable: 'Không có bản xem trước',
    failed: 'Lỗi xem trước',
  },
})

/**
 * Where a row's preview comes from, and the reason its tile shows when there is none. The
 * lane's thumbnail() makes the no-write choice itself (an existing thumbnail, else a small
 * original), so it is asked for every row: a HEIC photo can have a JPEG thumbnail. A lane
 * without it gets the original through pull(), when the browser can draw it and it is at most
 * `maxBytes`; a row of unknown size is tried, and the read stops once it passes the cap.
 */
export function previewPlan(
  row: Pick<ImageRow, 'mime' | 'path' | 'size'>,
  can: { readonly thumbnail: boolean; readonly pull: boolean },
  maxBytes = PREVIEW_MAX_ORIGINAL_BYTES,
): { readonly step: 'thumbnail' | 'original' | null; readonly otherwise: PreviewReason } {
  let otherwise: PreviewReason
  if (isHeif(row.mime)) otherwise = 'heic'
  else if (!browserCanShow(row.mime)) otherwise = 'unsupported'
  else if (row.size !== null && row.size > maxBytes) otherwise = 'too-large'
  else if (!can.thumbnail && (!can.pull || !row.path)) otherwise = 'unavailable'
  else otherwise = 'failed'
  if (can.thumbnail) return { step: 'thumbnail', otherwise }
  return { step: otherwise === 'failed' ? 'original' : null, otherwise }
}

/**
 * Runs at most `limit` tasks at once, first come first served. A task whose `signal` aborts
 * while it waits is dropped (its tile scrolled away) and rejects with the signal's reason; once
 * started it runs to the end.
 */
export function createLimiter(limit: number) {
  let active = 0
  const queue: { readonly start: () => void; readonly signal: AbortSignal }[] = []

  const pump = () => {
    while (active < limit) {
      const job = queue.shift()
      if (!job) return
      if (job.signal.aborted) continue
      active++
      job.start()
    }
  }

  return {
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason as Error)
          return
        }
        const onAbort = () => {
          const at = queue.indexOf(job)
          if (at < 0) return
          queue.splice(at, 1)
          reject(signal.reason as Error)
        }
        const job = {
          signal,
          start: () => {
            signal.removeEventListener('abort', onAbort)
            task()
              .then(resolve, reject)
              .finally(() => {
                active--
                pump()
              })
          },
        }
        signal.addEventListener('abort', onAbort, { once: true })
        queue.push(job)
        pump()
      })
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}

/**
 * Previews by key, least recently used first out. Dropping a ready preview revokes its blob
 * URL; failures are kept too, so a tile scrolled past twice doesn't read the phone twice.
 */
export function createPreviewCache(max: number, revoke: (url: string) => void) {
  const map = new Map<string, Preview>()
  const drop = (key: string) => {
    const value = map.get(key)
    if (value?.kind === 'ready') revoke(value.url)
    map.delete(key)
  }
  return {
    get(key: string): Preview | undefined {
      const value = map.get(key)
      if (value) {
        map.delete(key)
        map.set(key, value)
      }
      return value
    },
    set(key: string, value: Preview) {
      if (map.has(key)) drop(key)
      map.set(key, value)
      for (const oldest of map.keys()) {
        if (map.size <= max) break
        drop(oldest)
      }
    },
    /** Forget the failures under a prefix (one device), so Refresh tries them again. */
    forgetFailures(prefix: string) {
      for (const [key, value] of [...map]) {
        if (value.kind === 'none' && key.startsWith(prefix)) map.delete(key)
      }
    },
    get size() {
      return map.size
    },
  }
}

/** A preview's identity: the device, the photo, and its version (an edit changes both). */
export const previewKey = (deviceId: string, row: ImageRow) =>
  `${deviceId}|${imageKey(row)}|${String(row.modified ?? '')}|${String(row.size ?? '')}`

/** The tile ↔ arrow-key arithmetic of a wrapped grid: the index focus moves to, or null. */
export function gridMove(
  key: string,
  index: number,
  columns: number,
  count: number,
): number | null {
  const cols = Math.max(1, columns)
  const next =
    key === 'ArrowRight'
      ? index + 1
      : key === 'ArrowLeft'
        ? index - 1
        : key === 'ArrowDown'
          ? index + cols
          : key === 'ArrowUp'
            ? index - cols
            : key === 'Home'
              ? 0
              : key === 'End'
                ? count - 1
                : null
  if (next === null || next < 0 || next >= count || next === index) return null
  return next
}

/* ---------------------------------------------------------------- *
 * Previews: the reading, in the browser
 * ---------------------------------------------------------------- */

/** About 400 tiles of ~40 KB each: under 20 MB for the life of the page. */
const PREVIEWS_KEPT = 400
const previews = createPreviewCache(PREVIEWS_KEPT, (url) => {
  URL.revokeObjectURL(url)
})
const inflight = new Map<string, Promise<Preview>>()
const limiter = createLimiter(PREVIEW_CONCURRENCY)

class PreviewTooLarge extends Error {
  constructor() {
    super('PREVIEW_TOO_LARGE')
  }
}

async function sniffBlob(blob: Blob): Promise<ImageFormat | null> {
  return sniffImage(new Uint8Array(await blob.slice(0, 32).arrayBuffer()))
}

/**
 * Shrink to PREVIEW_MAX_EDGE on the longest side. createImageBitmap decodes off the main
 * thread and applies the photo's EXIF orientation; WebP keeps a screenshot's transparency, and
 * a browser without a WebP encoder hands back PNG instead.
 */
async function shrink(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const size = previewSize(bitmap.width, bitmap.height, PREVIEW_MAX_EDGE)
    if (size.width === bitmap.width && size.height === bitmap.height && blob.size < 256 * 1024) {
      return blob
    }
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return blob
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((small) => {
        resolve(small ?? blob)
      }, 'image/webp')
    })
  } finally {
    bitmap.close()
  }
}

/** The original, refused once the phone says (or the bytes show) it is past the preview cap. */
async function pullForPreview(
  pull: NonNullable<Backend['pull']>,
  deviceId: string,
  path: string,
  signal: AbortSignal,
): Promise<Blob> {
  const stop = new AbortController()
  const relay = () => {
    stop.abort(signal.reason)
  }
  signal.addEventListener('abort', relay, { once: true })
  let tooLarge = false
  try {
    return await pull(
      deviceId,
      path,
      (sent: number, total: number) => {
        if (sent > PREVIEW_MAX_ORIGINAL_BYTES || total > PREVIEW_MAX_ORIGINAL_BYTES) {
          tooLarge = true
          stop.abort()
        }
      },
      stop.signal,
    )
  } catch (error) {
    if (tooLarge) throw new PreviewTooLarge()
    throw error
  } finally {
    signal.removeEventListener('abort', relay)
  }
}

/** A tile's preview, and whether it is kept for the next time the tile asks. */
interface PreviewRead {
  readonly preview: Preview
  readonly keep: boolean
}

const kept = (preview: Preview): PreviewRead => ({ preview, keep: true })

async function readPreview(
  backend: Backend,
  deviceId: string,
  row: ImageRow,
  signal: AbortSignal,
): Promise<PreviewRead> {
  signal.throwIfAborted()
  const { thumbnail, pull } = backend
  const plan = previewPlan(row, { thumbnail: Boolean(thumbnail), pull: Boolean(pull) })
  let blob: Blob
  try {
    // untilAborted: a slow lane that ignores the signal must not keep one of the
    // PREVIEW_CONCURRENCY slots after its tile has gone.
    if (plan.step === 'thumbnail' && thumbnail) {
      blob = await untilAborted(thumbnail(deviceId, imageKey(row), signal), signal)
    } else if (plan.step === 'original' && pull) {
      blob = await untilAborted(pullForPreview(pull, deviceId, row.path, signal), signal)
    } else {
      return kept({ kind: 'none', reason: plan.otherwise })
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PreviewTooLarge) return kept({ kind: 'none', reason: 'too-large' })
    // "None for this row" is the lane's normal answer, not a failure. It is not kept: the lane
    // gives it before reading anything, so asking again costs nothing, and it is also what a
    // lane says for a row it no longer knows (a listing from before a reconnect), which a
    // later ask can answer with a picture.
    const none = error instanceof Error && error.message === 'PREVIEW_UNAVAILABLE'
    return {
      preview: {
        kind: 'none',
        reason: none && plan.otherwise === 'failed' ? 'unavailable' : plan.otherwise,
      },
      keep: !none,
    }
  }
  const format = await sniffBlob(blob)
  // MediaStore said JPEG, the bytes say HEIF: it gets HEIC's placeholder.
  if (format === 'heif') return kept({ kind: 'none', reason: 'heic' })
  if (format === null) return kept({ kind: 'none', reason: 'failed' })
  try {
    return kept({ kind: 'ready', url: URL.createObjectURL(await shrink(blob)) })
  } catch {
    // Bytes the browser can't decode after all (a truncated file, an exotic JPEG).
    return kept({ kind: 'none', reason: 'failed' })
  }
}

/**
 * A tile's preview: from memory, from a read already under way, or queued. `drop` (the tile
 * scrolled away) takes a queued read off the queue, while a started one finishes and is kept
 * for next time; `life` (the tile unmounted) also stops a started one.
 */
function requestPreview(
  key: string,
  backend: Backend,
  deviceId: string,
  row: ImageRow,
  drop: AbortSignal,
  life: AbortSignal,
): Promise<Preview> {
  const cached = previews.get(key)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(key)
  if (running) return running
  const promise = limiter
    .run(() => readPreview(backend, deviceId, row, life), drop)
    .then(({ preview, keep }) => {
      if (keep) previews.set(key, preview)
      return preview
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, promise)
  return promise
}

/**
 * The grid's previews as the viewer sees them: what a tile already has, or a read it can join
 * (stopped when the viewer moves on), so a photo shows its preview while its original is read.
 */
export function viewerPreviews(backend: Backend, deviceId: string): PreviewSource {
  return {
    get(row) {
      const preview = previews.get(previewKey(deviceId, row))
      return preview?.kind === 'ready' ? preview.url : undefined
    },
    load(row, signal) {
      return requestPreview(previewKey(deviceId, row), backend, deviceId, row, signal, signal).then(
        (preview) => (preview.kind === 'ready' ? preview.url : undefined),
      )
    },
  }
}

/* ---------------------------------------------------------------- *
 * The tab
 * ---------------------------------------------------------------- */

/**
 * The Images tab. Nothing is read until it mounts; each album or Refresh starts a fresh
 * listing (the grid below is keyed by both).
 */
export function ImagesTab({
  device,
  backend,
  zoom,
  onZoom,
}: {
  device: Device
  backend: Backend
  /** The Screenshots card's thumbnail width, shared (prefs.ts). */
  zoom: number
  onZoom: (zoom: number) => void
}) {
  const t = useMessages(IMAGES_TAB_MESSAGES)
  const [album, setAlbum] = useState<Album>('screenshots')
  const [reload, setReload] = useState(0)
  const refresh = () => {
    previews.forgetFailures(`${device.id}|`)
    setReload((n) => n + 1)
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.readStraight(device.name)}</CardDescription>
        <CardAction className="flex items-center gap-3">
          <label className="text-muted-foreground hidden items-center gap-2 text-xs sm:flex">
            {t.size}
            <input
              type="range"
              min={80}
              max={480}
              step={20}
              value={zoom}
              aria-label={t.thumbnailSize}
              className="accent-primary w-28"
              onChange={(e) => {
                onZoom(Number(e.target.value))
              }}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.refreshLabel}
            title={t.refreshTitle}
            onClick={refresh}
          >
            <RefreshCw /> {t.refresh}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={album}
          aria-label={t.album}
          className="flex-wrap"
          onValueChange={(value) => {
            // Radix sends '' when the pressed item is pressed again; an album stays chosen.
            if (isAlbum(value)) setAlbum(value)
          }}
        >
          {IMAGE_ALBUMS.map((a) => (
            <ToggleGroupItem key={a.value} value={a.value}>
              {a.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {backend.images ? (
          <AlbumGrid
            key={`${device.id}|${album}|${String(reload)}`}
            device={device}
            backend={backend}
            album={album}
            zoom={zoom}
            onRetry={refresh}
          />
        ) : (
          <p className="text-muted-foreground text-sm">{t.cannotList}</p>
        )}
      </CardContent>
    </Card>
  )
}

type Listing =
  | { readonly status: 'loading' }
  // The error, not its message: worded when shown, so it follows a language switch.
  | { readonly status: 'failed'; readonly error: unknown }
  | {
      readonly status: 'ready'
      readonly rows: readonly ImageRow[]
      readonly more: boolean
      /** MediaStore failed and the album's usual folders were listed instead. */
      readonly fallback: boolean
    }

/** What preflight's `images.mediastore` row is told. */
function outcomeOf(listing: Listing): ImagesOutcome {
  if (listing.status === 'loading') return { status: 'loading' }
  if (listing.status === 'failed') {
    return { status: 'failed', stderr: deviceErrorMessage(listing.error) }
  }
  return listing.fallback ? { status: 'fallback' } : { status: 'listed' }
}

/** One album's listing, its grid, paging, and the viewer over it. */
function AlbumGrid({
  device,
  backend,
  album,
  zoom,
  onRetry,
}: {
  device: Device
  backend: Backend
  album: Album
  zoom: number
  onRetry: () => void
}) {
  const t = useMessages(IMAGES_TAB_MESSAGES)
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  /** Why the last page failed, worded when shown. */
  const [moreError, setMoreError] = useState<{ readonly error: unknown } | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  const lastViewed = useRef(0)
  const grid = useRef<HTMLUListElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  /** The listing as of now, for callbacks that outlive the render that made them. */
  const current = useRef<Listing>(listing)
  const alive = useRef(true)

  const commit = (next: Listing) => {
    current.current = next
    setListing(next)
  }

  useEffect(() => {
    alive.current = true
    const images = backend.images
    if (!images) return
    const first = { album, offset: 0, limit: IMAGE_PAGE_SIZE }
    // MediaStore first; when it refuses, the usual folders (file times only), with preflight's
    // warning. Only when both fail does the tab show MediaStore's own complaint.
    void images(device.id, first)
      .then(
        (rows) => ({ rows, fallback: false }),
        async (error: unknown) => {
          if (!alive.current) throw error
          try {
            return { rows: await images(device.id, { ...first, folders: true }), fallback: true }
          } catch {
            throw error
          }
        },
      )
      .then(
        ({ rows, fallback }) => {
          if (!alive.current) return
          commit({ status: 'ready', rows, more: rows.length >= IMAGE_PAGE_SIZE, fallback })
        },
        (error: unknown) => {
          if (alive.current) commit({ status: 'failed', error })
        },
      )
    return () => {
      alive.current = false
    }
    // Mount only: the grid is keyed by device, album and Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The page being read, so the scroll, the button and the viewer share one request. */
  const nextPage = useRef<Promise<boolean> | null>(null)

  /** The next page. Resolves to whether rows were added (the viewer's → carries on with it). */
  const loadMore = (): Promise<boolean> => {
    nextPage.current ??= readNextPage().finally(() => {
      nextPage.current = null
    })
    return nextPage.current
  }

  const readNextPage = async (): Promise<boolean> => {
    const now = current.current
    const images = backend.images
    if (now.status !== 'ready' || !now.more || !images) return false
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await images(device.id, {
        album,
        offset: now.rows.length,
        limit: IMAGE_PAGE_SIZE,
        ...(now.fallback ? { folders: true } : {}),
      })
      if (!alive.current) return false
      const rows = appendPage(now.rows, page)
      commit({
        ...now,
        rows,
        more: page.length >= IMAGE_PAGE_SIZE && rows.length > now.rows.length,
      })
      return rows.length > now.rows.length
    } catch (error) {
      if (alive.current) setMoreError({ error })
      return false
    } finally {
      if (alive.current) setLoadingMore(false)
    }
  }

  // Scrolling near the end loads the next page; the Load more button does the same by hand.
  const more = listing.status === 'ready' && listing.more
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more || moreError !== null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
    // loadMore reads the listing through a ref; re-observing per render would refire it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [more, moreError, loadingMore])

  const focusTile = (index: number) => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-image-index="${String(index)}"]`)?.focus()
  }

  const onGridKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || listing.status !== 'ready') return
    const target = e.target
    if (!(target instanceof HTMLElement) || !target.dataset.imageIndex) return
    const index = Number(target.dataset.imageIndex)
    const tiles = grid.current?.querySelectorAll<HTMLElement>('[data-image-index]') ?? []
    const firstTop = tiles[0]?.offsetTop ?? 0
    let columns = 0
    for (const tile of tiles) {
      if (tile.offsetTop !== firstTop) break
      columns++
    }
    const next = gridMove(e.key, index, columns, listing.rows.length)
    if (next === null) return
    e.preventDefault()
    focusTile(next)
  }

  if (listing.status === 'loading') {
    return (
      <ul className="flex flex-wrap gap-3" aria-label={t.loading}>
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} style={{ width: tileWidth(zoom) }}>
            <Skeleton className="aspect-square w-full rounded-lg" />
          </li>
        ))}
      </ul>
    )
  }

  const checks = featureChecks('images', { images: outcomeOf(listing) })
  const card = (
    <InlineChecklist
      id={`images-check-${device.id}`}
      items={checks}
      wiring={{ on: { 'retry-images': onRetry } }}
    />
  )

  if (listing.status === 'failed') return card

  const { rows } = listing
  return (
    <div className="space-y-4">
      {card}
      {rows.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center rounded-lg border border-dashed py-10 text-sm">
          <Images className="mb-2 size-7 opacity-60" />
          {t.empty[album](device.name)}
        </div>
      ) : (
        <ul
          ref={grid}
          className="flex flex-wrap gap-3"
          aria-label={t.albumOn(
            IMAGE_ALBUMS.find((a) => a.value === album)?.label ?? t.title,
            device.name,
          )}
          onKeyDown={onGridKey}
        >
          {rows.map((row, index) => (
            <Tile
              key={previewKey(device.id, row)}
              device={device}
              backend={backend}
              row={row}
              index={index}
              zoom={zoom}
              onOpen={() => {
                lastViewed.current = index
                setViewing(index)
              }}
            />
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <div ref={sentinel} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground tabular-nums">
            {t.count(rows.length, listing.more)}
          </span>
          {listing.more && (
            <Button
              variant="outline"
              size="sm"
              aria-disabled={loadingMore}
              className="aria-disabled:opacity-50"
              onClick={() => {
                void loadMore()
              }}
            >
              {loadingMore && <Loader2 className="animate-spin" />}
              {loadingMore ? t.loadingMore : t.loadMore}
            </Button>
          )}
          {moreError !== null && (
            <span role="status" className="text-red-600 dark:text-red-400">
              {t.moreFailed(device.name, deviceErrorMessage(moreError.error))}
            </span>
          )}
        </div>
      )}

      <ImageViewer
        device={device}
        backend={backend}
        rows={rows}
        index={viewing}
        hasMore={listing.more}
        onIndex={(index) => {
          lastViewed.current = index
          setViewing(index)
        }}
        onLoadMore={loadMore}
        onClose={() => {
          setViewing(null)
        }}
        onCloseFocus={() => {
          focusTile(lastViewed.current)
        }}
        previews={viewerPreviews(backend, device.id)}
      />
    </div>
  )
}

/**
 * A tile's width: the Size slider's, but never more than half the row (gap-3 is 12px), so a
 * phone-width screen, where the slider is hidden, still shows two columns.
 */
const tileWidth = (zoom: number) => `min(${String(zoom)}px, calc(50% - 6px))`

/** One photo in the grid: its preview (read once on screen), when it was taken, its size. */
function Tile({
  device,
  backend,
  row,
  index,
  zoom,
  onOpen,
}: {
  device: Device
  backend: Backend
  row: ImageRow
  index: number
  zoom: number
  onOpen: () => void
}) {
  const t = useMessages(IMAGES_TAB_MESSAGES)
  const key = previewKey(device.id, row)
  const [preview, setPreview] = useState<Preview | undefined>(() => previews.get(key))
  // Without IntersectionObserver (old browsers, tests) every tile counts as on screen.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const item = useRef<HTMLLIElement>(null)
  /**
   * Aborted on unmount: stops this tile's read even once it has started. Made by an effect, not
   * held in state: StrictMode unmounts and remounts once, and a controller kept across that
   * would stay aborted, leaving every tile without a preview.
   */
  const life = useRef<AbortController | null>(null)
  /** Asks again when it joined a read that an earlier mount of this tile then stopped. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    life.current = controller
    return () => {
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const el = item.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((e) => e.isIntersecting))
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const alive = life.current?.signal
    if (!visible || preview || !alive || alive.aborted) return
    const drop = new AbortController()
    requestPreview(key, backend, device.id, row, drop.signal, alive).then(
      (p) => {
        if (!drop.signal.aborted) setPreview(p)
      },
      () => {
        // Rejected for someone else's abort while this tile still wants it: once more.
        if (!drop.signal.aborted && !alive.aborted && attempt < 2) setAttempt((n) => n + 1)
      },
    )
    return () => {
      drop.abort()
    }
  }, [visible, preview, key, backend, device.id, row, attempt])

  const when = imageWhen(row)
  const date = when.at === null ? t.dateUnknown : fmtDateTime(new Date(when.at))
  const facts = imageFacts(row)
  const label = [row.name || t.image, date, facts].filter(Boolean).join(', ')

  return (
    <li
      ref={item}
      className="bg-muted/30 overflow-hidden rounded-lg border"
      style={{ width: tileWidth(zoom) }}
    >
      <button
        type="button"
        data-image-index={index}
        aria-label={label}
        title={row.name}
        className="focus-visible:ring-ring/50 relative block aspect-square w-full outline-none focus-visible:ring-[3px]"
        onClick={onOpen}
      >
        {preview?.kind === 'ready' ? (
          <img src={preview.url} alt="" className="size-full object-cover" draggable={false} />
        ) : preview?.kind === 'none' ? (
          <span className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center text-xs">
            {preview.reason === 'heic' || preview.reason === 'unsupported' ? (
              <FileImage className="size-6 opacity-60" />
            ) : (
              <ImageOff className="size-6 opacity-60" />
            )}
            {PREVIEW_REASON_TEXT[preview.reason]}
          </span>
        ) : (
          <Skeleton className="size-full rounded-none" />
        )}
        {(isHeif(row.mime) || !browserCanShow(row.mime)) && row.mime && (
          <span className="bg-background/80 absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium">
            {typeLabel(row.mime)}
          </span>
        )}
      </button>
      <div className="border-t px-2 py-1.5 text-xs">
        <p
          className={cn(
            'text-muted-foreground truncate font-mono tabular-nums',
            when.source === 'modified' && 'italic',
          )}
          title={when.source === 'modified' ? t.fileTime : t.taken}
        >
          {date}
        </p>
        {facts && <p className="text-muted-foreground truncate">{facts}</p>}
      </div>
    </li>
  )
}
