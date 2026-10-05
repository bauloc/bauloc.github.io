import { Camera, Copy, Download, Loader2, MoonStar, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { defineMessages, localized, useMessages } from '@/lib/i18n'
import { INTL_LOCALE } from '@/lib/locale'

import { BLACK_SHOT } from '../black-shot'
import { fmtBytes, fmtClock } from '../model'
import type { Shot } from '../store'

/** What the copy menu's work says (its errors, sizes and toasts), worded when it runs. */
const COPY_TEXT = localized({
  en: {
    tooBig: (width: number, height: number, size: string) =>
      `Even at ${String(width)} × ${String(height)} px it was ${size}.`,
    cannotScale: 'It could not be scaled down.',
    noCanvas: 'Canvas is unavailable',
    noEncoder: 'The browser could not encode a PNG',
    bytes: (size: number) => `${size.toLocaleString('en-US')} bytes`,
    copiedOriginal: (size: string) => `Copied original · ${size}`,
    asCaptured: 'The PNG as captured.',
    copiedSmall: (size: string) => `Copied ≤ 1 MB · ${size}`,
    alreadySmall: 'Already under 1 MB, so this is the original.',
    recompressed: (width: number, height: number, from: string) =>
      `Full size, ${String(width)} × ${String(height)} px, re-compressed from ${from}.`,
    scaledDown: (width: number, height: number, from: string) =>
      `Scaled down to ${String(width)} × ${String(height)} px from ${from}.`,
    notUnderCap: 'Couldn’t get it under 1 MB',
    suggestOriginal: (reason: string) => `${reason} Use Copy original or Save instead.`,
    shrinkFailed: 'Couldn’t shrink the screenshot',
    /** `reason` without its full stop: browsers end some messages with one and not others. */
    shrinkFailedDetail: (reason: string) => `${reason}. Use Copy original or Save instead.`,
    unreadable: 'The image could not be read',
    copyFailed: 'Copy image failed',
    copySmallFailed: 'Copy ≤ 1 MB failed',
    writeRejected: 'The clipboard write was rejected.',
    unsupported: 'Copy image unsupported',
    unsupportedDetail: 'This browser cannot put images on the clipboard. Use Save.',
    shrinking: 'Shrinking the screenshot under 1 MB…',
  },
  vi: {
    tooBig: (width: number, height: number, size: string) =>
      `Ngay cả ở ${String(width)} × ${String(height)} px, ảnh vẫn nặng ${size}.`,
    cannotScale: 'Không thu nhỏ được ảnh.',
    noCanvas: 'Canvas không khả dụng',
    noEncoder: 'Trình duyệt không mã hóa được ảnh PNG',
    bytes: (size: number) => `${size.toLocaleString(INTL_LOCALE.vi)} byte`,
    copiedOriginal: (size: string) => `Đã sao chép bản gốc · ${size}`,
    asCaptured: 'Ảnh PNG đúng như lúc chụp.',
    copiedSmall: (size: string) => `Đã sao chép bản ≤ 1 MB · ${size}`,
    alreadySmall: 'Ảnh vốn đã dưới 1 MB nên đây là bản gốc.',
    recompressed: (width: number, height: number, from: string) =>
      `Nguyên kích thước ${String(width)} × ${String(height)} px, đã nén lại từ ${from}.`,
    scaledDown: (width: number, height: number, from: string) =>
      `Đã thu nhỏ xuống ${String(width)} × ${String(height)} px từ ${from}.`,
    notUnderCap: 'Không thu nhỏ được xuống dưới 1 MB',
    suggestOriginal: (reason: string) => `${reason} Hãy dùng Sao chép bản gốc hoặc Lưu.`,
    shrinkFailed: 'Không thu nhỏ được ảnh chụp màn hình',
    shrinkFailedDetail: (reason: string) => `${reason}. Hãy dùng Sao chép bản gốc hoặc Lưu.`,
    unreadable: 'Không đọc được ảnh',
    copyFailed: 'Không sao chép được ảnh',
    copySmallFailed: 'Không sao chép được bản ≤ 1 MB',
    writeRejected: 'Trình duyệt từ chối ghi vào bộ nhớ tạm.',
    unsupported: 'Không hỗ trợ sao chép ảnh',
    unsupportedDetail: 'Trình duyệt này không sao chép được ảnh vào bộ nhớ tạm. Hãy dùng Lưu.',
    shrinking: 'Đang thu nhỏ ảnh chụp màn hình xuống dưới 1 MB…',
  },
})

const SCREENSHOTS_MESSAGES = defineMessages({
  en: {
    copyImage: 'Copy image',
    copyOriginal: 'Copy original',
    copySmall: 'Copy ≤ 1 MB',
    smallerCopy: 'smaller copy',
    title: 'Screenshots',
    size: 'Size',
    thumbnailSize: 'Thumbnail size',
    clearTitle: 'Clear screenshots',
    clear: 'Clear',
    takeTitle: 'Take a screenshot (S)',
    take: 'Take Screenshot',
    empty: 'No screenshots yet — press S or Take Screenshot.',
    openFull: 'Open full size',
    shotAlt: (device: string, clock: string, black: boolean) =>
      `Screenshot of ${device} at ${clock}${black ? ', all black' : ''}`,
    allBlack: 'All black.',
    saveFile: (fileName: string) => `Save ${fileName}`,
    save: 'Save',
  },
  vi: {
    copyImage: 'Sao chép ảnh',
    copyOriginal: 'Sao chép bản gốc',
    copySmall: 'Sao chép bản ≤ 1 MB',
    smallerCopy: 'bản nhỏ hơn',
    title: 'Ảnh chụp màn hình',
    size: 'Cỡ',
    thumbnailSize: 'Cỡ ảnh thu nhỏ',
    clearTitle: 'Xóa các ảnh chụp màn hình',
    clear: 'Xóa',
    takeTitle: 'Chụp màn hình (S)',
    take: 'Chụp màn hình',
    empty: 'Chưa có ảnh chụp màn hình nào — bấm S hoặc Chụp màn hình.',
    openFull: 'Mở ảnh cỡ đầy đủ',
    shotAlt: (device: string, clock: string, black: boolean) =>
      `Ảnh chụp màn hình của ${device} lúc ${clock}${black ? ', toàn màu đen' : ''}`,
    allBlack: 'Toàn màu đen.',
    saveFile: (fileName: string) => `Lưu ${fileName}`,
    save: 'Lưu',
  },
})

/**
 * "Copy ≤ 1 MB" stays at or under a million bytes: under 1 MB however the place it is pasted
 * counts a megabyte.
 */
export const COPY_CAP = 1_000_000

/** The search aims a little under the cap, so the first guess usually fits… */
const AIM = 0.97
/** …and stops once a fit is this close to the cap: more pixels are not worth another encode. */
const GOOD_ENOUGH = 0.9
/** Encodes per search. A guess from the byte ratio usually lands in one or two. */
const MAX_TRIES = 6
/** Smaller than this on its long side, a phone screenshot is no longer readable. */
const MIN_LONG_SIDE = 320

/** A decoded image that can be re-encoded as a PNG at another size. */
export interface Raster {
  readonly width: number
  readonly height: number
  encode: (width: number, height: number) => Promise<Blob>
}

/** What "Copy ≤ 1 MB" puts on the clipboard. */
export interface Shrunk {
  readonly blob: Blob
  /** Already under the cap, so the PNG as captured. */
  readonly original: boolean
  readonly width: number | null
  readonly height: number | null
  /** 1 when re-encoded at full size: the browser's PNG can beat the device's. */
  readonly scale: number
}

/** No size of the image fits under the cap: the message says how close it got. */
export class TooBigError extends Error {
  override name = 'TooBigError'
}

/** The pixel size at `scale`, never under 1 px a side. */
export function scaledSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * The next scale to try, never past 1. A PNG's bytes grow roughly with its pixel count —
 * scale squared — so the last try's bytes say where the cap should fall. The guess stays
 * strictly between the largest scale known to fit (`lo`, 0 while none has) and the smallest
 * known too big (`hi`, Infinity while none is); when the estimate leaves that bracket it is
 * off, and halving the bracket is the safe step.
 */
export function nextScale(
  last: { scale: number; size: number },
  lo: number,
  hi: number,
  cap: number,
): number {
  const estimate = Math.min(1, last.scale * Math.sqrt((cap * AIM) / last.size))
  if (estimate > lo && estimate < hi) return estimate
  const top = Math.min(hi, 1)
  return lo > 0 ? (lo + top) / 2 : top / 2
}

/**
 * The largest downscale of `raster` whose PNG is at most `cap` bytes, starting from the
 * original's byte ratio. Never upscales and keeps the aspect. Throws TooBigError when nothing
 * fits within MAX_TRIES or before the image gets too small to read.
 */
export async function searchScale(
  raster: Raster,
  originalSize: number,
  cap: number = COPY_CAP,
  maxTries: number = MAX_TRIES,
): Promise<Shrunk> {
  const longSide = Math.max(raster.width, raster.height)
  const floor = Math.min(1, MIN_LONG_SIDE / longSide)
  let lo = 0
  // Not 1: the device's PNG is over the cap, but the browser's encoder may fit the same pixels.
  let hi = Number.POSITIVE_INFINITY
  let best: Shrunk | null = null
  let smallest: { size: number; width: number; height: number } | null = null
  const tried = new Set<string>()
  let scale = Math.min(1, Math.sqrt((cap * AIM) / originalSize))

  for (let i = 0; i < maxTries; i++) {
    scale = Math.max(scale, floor)
    const size = scaledSize(raster.width, raster.height, scale)
    const key = `${String(size.width)}x${String(size.height)}`
    if (tried.has(key)) break
    tried.add(key)

    const blob = await raster.encode(size.width, size.height)
    if (blob.size <= cap) {
      lo = scale
      if (!best || blob.size > best.blob.size) best = { blob, original: false, scale, ...size }
      if (blob.size >= cap * GOOD_ENOUGH) break
    } else {
      hi = scale
      if (!smallest || size.width < smallest.width) smallest = { size: blob.size, ...size }
      // Too big at the floor already: smaller would be unreadable.
      if (scale <= floor) break
    }
    scale = nextScale({ scale, size: blob.size }, lo, hi, cap)
  }

  if (best) return best
  throw new TooBigError(
    smallest
      ? COPY_TEXT.tooBig(smallest.width, smallest.height, fmtBytes(smallest.size))
      : COPY_TEXT.cannotScale,
  )
}

/** The browser's raster: decoded once, redrawn on a canvas for every size tried. */
async function decodeRaster(blob: Blob): Promise<Raster & { close: () => void }> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  return {
    width: bitmap.width,
    height: bitmap.height,
    encode: (width, height) => {
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return Promise.reject(new Error(COPY_TEXT.noCanvas))
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, width, height)
      return new Promise((resolve, reject) => {
        canvas.toBlob((png) => {
          if (png) resolve(png)
          else reject(new Error(COPY_TEXT.noEncoder))
        }, 'image/png')
      })
    },
    close: () => {
      bitmap.close()
    },
  }
}

/** One search per screenshot: a second "Copy ≤ 1 MB" of it is instant. */
const shrunkCache = new WeakMap<Blob, Promise<Shrunk>>()

/** The screenshot at most `cap` bytes; the original itself when it already is. */
export function shrinkForClipboard(
  blob: Blob,
  cap: number = COPY_CAP,
  decode: (blob: Blob) => Promise<Raster & { close?: () => void }> = decodeRaster,
): Promise<Shrunk> {
  if (blob.size <= cap) {
    return Promise.resolve({ blob, original: true, width: null, height: null, scale: 1 })
  }
  const cached = shrunkCache.get(blob)
  if (cached) return cached
  const work = (async () => {
    const raster = await decode(blob)
    try {
      return await searchScale(raster, blob.size, cap)
    } finally {
      raster.close?.()
    }
  })()
  shrunkCache.set(blob, work)
  // A failure may be the browser's (memory, a lost canvas): the next try starts afresh.
  work.catch(() => {
    shrunkCache.delete(blob)
  })
  return work
}

export type CopyKind = 'original' | 'small'

/**
 * A size as the copy menu and its toasts show it. The page counts in 1024s, so a PNG just over
 * the million-byte cap would read "996 KB" or "1.0 MB" and look as if it needed no shrinking:
 * there the exact bytes say why it does.
 */
export function sizeText(size: number): string {
  const shown = fmtBytes(size)
  if (size <= COPY_CAP || !(shown.endsWith(' KB') || shown === '1.0 MB')) return shown
  return COPY_TEXT.bytes(size)
}

/** The toast after a copy: which one went on the clipboard, and its size. */
export function copiedText(
  kind: CopyKind,
  copied: Shrunk,
  originalSize: number,
): { title: string; description: string } {
  const size = fmtBytes(copied.blob.size)
  if (kind === 'original') {
    return {
      title: COPY_TEXT.copiedOriginal(sizeText(copied.blob.size)),
      description: COPY_TEXT.asCaptured,
    }
  }
  if (copied.original || copied.width === null || copied.height === null) {
    return {
      title: COPY_TEXT.copiedSmall(size),
      description: COPY_TEXT.alreadySmall,
    }
  }
  if (copied.scale >= 1) {
    return {
      title: COPY_TEXT.copiedSmall(size),
      description: COPY_TEXT.recompressed(copied.width, copied.height, sizeText(originalSize)),
    }
  }
  return {
    title: COPY_TEXT.copiedSmall(size),
    description: COPY_TEXT.scaledDown(copied.width, copied.height, sizeText(originalSize)),
  }
}

/** An error's message. A DOMException is not an Error in every realm, so this duck-types. */
function messageOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('message' in error)) return null
  return typeof error.message === 'string' && error.message ? error.message : null
}

/** The toast when the copy fails: the search's own reason first, then the clipboard's. */
export function failedText(
  kind: CopyKind,
  reason: unknown,
  writeError: unknown,
): { title: string; description: string } {
  if (reason instanceof TooBigError) {
    return {
      title: COPY_TEXT.notUnderCap,
      description: COPY_TEXT.suggestOriginal(reason.message),
    }
  }
  if (reason !== null) {
    return {
      title: COPY_TEXT.shrinkFailed,
      // Browsers end some messages with a full stop and not others.
      description: COPY_TEXT.shrinkFailedDetail(
        (messageOf(reason) ?? COPY_TEXT.unreadable).replace(/\.$/, ''),
      ),
    }
  }
  return {
    title: kind === 'original' ? COPY_TEXT.copyFailed : COPY_TEXT.copySmallFailed,
    description: messageOf(writeError) ?? COPY_TEXT.writeRejected,
  }
}

/** A newer copy started before this one reached the clipboard, so this one stands down. */
export class SupersededError extends Error {
  override name = 'SupersededError'
}

/**
 * The newest copy. The clipboard holds one image, and the one the tester picked last must be
 * the one left on it, whatever each took to prepare: a newer copy stands the older one down
 * and lets it settle before its own image goes in.
 */
let latestCopy: { supersede: () => void; settled: Promise<void> } | null = null

type ToastId = string | number

/** The newest copy toast, so the one in front always speaks for what is on the clipboard. */
let frontCopyToast: ToastId | undefined

/**
 * A copy's result. It turns its own "Shrinking…" toast into the result when that toast is still
 * the newest; behind a newer copy's toast it would update out of sight, so it goes and the result
 * comes in front.
 */
function showResult(
  type: 'success' | 'error',
  id: ToastId | undefined,
  text: { title: string; description: string },
) {
  const inPlace = id !== undefined && id === frontCopyToast
  if (id !== undefined && !inPlace) toast.dismiss(id)
  frontCopyToast = toast[type](text.title, {
    id: inPlace ? id : undefined,
    description: text.description,
  })
}

/**
 * Put a screenshot on the clipboard. ClipboardItem gets a PROMISE and write() is called in the
 * click itself: Safari loses the user gesture across an await, and the shrink takes a moment.
 * Chrome's async clipboard takes images as image/png only, so the small copy is a PNG too.
 */
function copyShot(shot: Shot, kind: CopyKind) {
  if (!('ClipboardItem' in window) || !('write' in navigator.clipboard)) {
    toast.error(COPY_TEXT.unsupported, {
      description: COPY_TEXT.unsupportedDetail,
    })
    return
  }
  const work: Promise<Shrunk> =
    kind === 'original'
      ? Promise.resolve({ blob: shot.blob, original: true, width: null, height: null, scale: 1 })
      : shrinkForClipboard(shot.blob)
  const slow = kind === 'small' && shot.blob.size > COPY_CAP
  const id = slow ? toast.loading(COPY_TEXT.shrinking) : undefined
  if (id !== undefined) frontCopyToast = id
  const reason = work.then(
    () => null,
    (error: unknown) => error,
  )

  const previous = latestCopy
  previous?.supersede()
  let standDown = () => {}
  const stoodDown = new Promise<never>((_, reject) => {
    standDown = () => {
      reject(new SupersededError())
    }
  })
  // Too late to stand down once the image is handed over: the newer copy then waits for it.
  const png = Promise.race([work.then((shrunk) => shrunk.blob), stoodDown])
  // Also handles png at once, so a rejection before the write takes it is not "unhandled".
  const wasStoodDown = png.then(
    () => false,
    (error: unknown) => error instanceof SupersededError,
  )
  const item = new ClipboardItem({
    'image/png': previous ? previous.settled.then(() => png) : png,
  })
  const writing = navigator.clipboard.write([item])
  latestCopy = {
    supersede: standDown,
    settled: writing.then(
      () => undefined,
      () => undefined,
    ),
  }
  writing.then(
    async () => {
      showResult('success', id, copiedText(kind, await work, shot.blob.size))
    },
    async (error: unknown) => {
      // The newer copy has its own toast; this one has nothing left to say.
      if (await wasStoodDown) {
        if (id !== undefined) toast.dismiss(id)
        return
      }
      showResult('error', id, failedText(kind, await reason, error))
    },
  )
}

/** A tile's copy button: a small menu of the original or a copy under 1 MB. */
function CopyMenu({ shot }: { shot: Shot }) {
  const t = useMessages(SCREENSHOTS_MESSAGES)
  const size = shot.blob.size
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t.copyImage}
          title={t.copyImage}
        >
          <Copy />
        </Button>
      </DropdownMenuTrigger>
      {/* The page's 16 px gutter: a left-column tile at 390 px would put it on the edge. */}
      <DropdownMenuContent align="end" collisionPadding={16} className="min-w-52">
        <DropdownMenuItem
          onSelect={() => {
            copyShot(shot, 'original')
          }}
        >
          {t.copyOriginal}
          <DropdownMenuShortcut className="tracking-normal tabular-nums">
            {sizeText(size)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            copyShot(shot, 'small')
          }}
        >
          {t.copySmall}
          <DropdownMenuShortcut className="tracking-normal tabular-nums">
            {/* Not "scaled down": the browser's PNG of every pixel sometimes fits. */}
            {size > COPY_CAP ? t.smallerCopy : fmtBytes(size)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The device's screenshots this session, newest first, at a size the tester picks. */
export function Screenshots({
  shots,
  zoom,
  capturing,
  canCapture,
  captureTitle,
  captureDescribedBy,
  onCapture,
  onZoom,
  onClear,
}: {
  shots: readonly Shot[]
  zoom: number
  /** A capture is in flight: the button shows it and ignores presses. */
  capturing: boolean
  /** The device's lane can take screenshots. */
  canCapture: boolean
  /** The header button's tooltip: what takes the screenshot, or why it can't (screenshotTitle). */
  captureTitle?: string
  /** The note that says why screenshots are unavailable, when there is one. */
  captureDescribedBy?: string
  /** The header's Take Screenshot, and S: the same action. */
  onCapture: () => void
  onZoom: (zoom: number) => void
  onClear: () => void
}) {
  const t = useMessages(SCREENSHOTS_MESSAGES)
  return (
    <Card className="gap-4">
      {/* A row rather than the header's grid, so the title centres on the taller buttons and
          the controls wrap under it on a very narrow screen. */}
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CardTitle>{t.title}</CardTitle>
        {/* At 390 px the two buttons drop their words; the names stay for screen readers. */}
        <CardAction className="ml-auto flex items-center gap-2 sm:gap-3">
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            {t.size}
            <input
              type="range"
              min={80}
              max={480}
              step={20}
              value={zoom}
              aria-label={t.thumbnailSize}
              className="accent-primary w-20 sm:w-28"
              onChange={(e) => {
                onZoom(Number(e.target.value))
              }}
            />
          </label>
          {/* aria-disabled: once it has cleared, a disabled button would drop focus to <body>. */}
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={shots.length === 0}
            className="aria-disabled:opacity-50"
            title={t.clearTitle}
            onClick={() => {
              if (shots.length > 0) onClear()
            }}
          >
            <Trash2 /> <span className="sr-only sm:not-sr-only">{t.clear}</span>
          </Button>
          {/* Busy is aria-disabled for the same reason: focus stays on the button. */}
          <Button
            variant="outline"
            size="sm"
            aria-disabled={capturing || !canCapture}
            aria-describedby={canCapture ? undefined : captureDescribedBy}
            aria-keyshortcuts="S"
            className="aria-disabled:opacity-50"
            title={captureTitle ?? t.takeTitle}
            onClick={() => {
              if (!capturing && canCapture) onCapture()
            }}
          >
            {capturing ? <Loader2 className="animate-spin" /> : <Camera />}
            <span className="sr-only sm:not-sr-only">{t.take}</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {shots.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center rounded-lg border border-dashed py-10 text-sm">
            <Camera className="mb-2 size-7 opacity-60" />
            {t.empty}
          </div>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {shots.map((shot) => (
              <li
                key={shot.id}
                className="bg-muted/30 overflow-hidden rounded-lg border"
                style={{ width: zoom }}
              >
                <a href={shot.url} target="_blank" rel="noopener noreferrer" title={t.openFull}>
                  <img
                    src={shot.url}
                    alt={t.shotAlt(shot.deviceName, fmtClock(shot.at), shot.black)}
                    loading="lazy"
                    className="block w-full"
                  />
                </a>
                {shot.black && (
                  // Kept, since it is what the device returned; said, since black alone says nothing.
                  <p className="flex gap-1.5 border-t border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs leading-snug">
                    <MoonStar
                      aria-hidden="true"
                      className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                    />
                    <span>
                      <span className="font-medium">{t.allBlack}</span>{' '}
                      <span className="text-muted-foreground">{BLACK_SHOT.text}</span>
                    </span>
                  </p>
                )}
                <div className="flex items-center gap-1 border-t px-2 py-1.5">
                  <span className="text-muted-foreground flex-1 font-mono text-xs tabular-nums">
                    {fmtClock(shot.at)}
                  </span>
                  <CopyMenu shot={shot} />
                  <Button variant="ghost" size="icon" className="size-7" asChild>
                    <a
                      href={shot.url}
                      download={shot.fileName}
                      aria-label={t.saveFile(shot.fileName)}
                      title={t.save}
                    >
                      <Download />
                    </a>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
