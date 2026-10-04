import type { Adb } from '@yume-chan/adb'

import { listDirectory, pullFile, type DirEntry } from './files'
import {
  androidError,
  assertDevicePath,
  run,
  shellCmd,
  type RunResult,
  type ShellCommand,
} from './shell'

/*
  The Images tab: the phone's photos through MediaStore, read with `content query` as the shell
  user, which MediaProvider lets see every image. Formats from AOSP main (Content.java,
  MediaStore, MediaProvider); the Pixel run has not checked them yet.

  Things that bite:
  - the column is `datetaken`, not `date_taken`: MediaProvider is strict for shell callers, and
    an unknown column fails the whole query;
  - values come back unescaped (`Row: 0 _id=1, _display_name=a, b.jpg, …`), so rows are cut on
    the KNOWN columns, in projection order;
  - `relative_path` exists from Android 10; before that the folder comes from `_data`.

  Previews never write to the phone. Reading a thumbnail URI makes MediaProvider generate and
  SAVE a cache file when there is none, so it is never read. A preview is either a thumbnail
  Android already has (Pictures/.thumbnails/<id>.jpg, read as a plain file) or the original,
  pulled for visible rows only and shrunk in the browser. HEIC has no preview: Chrome can't
  decode it, so the viewer offers Save.
*/

export type Album = 'screenshots' | 'camera' | 'all'

export const IMAGES_URI = 'content://media/external/images/media'
export const IMAGE_PAGE_SIZE = 60

export interface ImageRow {
  /** MediaStore `_id`; empty for a row listed straight from a folder (the fallback). */
  readonly id: string
  readonly name: string
  /** Relative to the storage root, with a trailing slash: `DCIM/Camera/`. */
  readonly folder: string
  readonly size: number | null
  /** When the photo was taken, epoch ms; null for most downloads and edits. */
  readonly taken: number | null
  /** The file's time, epoch ms. */
  readonly modified: number | null
  readonly width: number | null
  readonly height: number | null
  readonly mime: string
  /** The file on the phone (`_data`), for reading it over sync. */
  readonly path: string
}

export interface ImagePage {
  readonly offset: number
  readonly limit: number
}

const COLUMNS = [
  '_id',
  '_display_name',
  'relative_path',
  '_size',
  'datetaken',
  'date_modified',
  'width',
  'height',
  'mime_type',
  // Last: a path is the likeliest value to hold ", ", and the last column takes the line's rest.
  '_data',
] as const

/** The projection this phone accepts: no relative_path before Android 10. */
export function imageColumns(sdk: number): readonly string[] {
  return sdk >= 29 ? COLUMNS : COLUMNS.filter((c) => c !== 'relative_path')
}

const ALBUM_FOLDERS: Readonly<Record<Exclude<Album, 'all'>, readonly string[]>> = {
  // Pixel and most phones use Pictures/Screenshots; Samsung, DCIM/Screenshots.
  screenshots: ['Pictures/Screenshots/', 'DCIM/Screenshots/'],
  camera: ['DCIM/Camera/'],
}

/** The `--where` clause for an album; null for All images. */
export function albumWhere(sdk: number, album: Album): string | null {
  if (album === 'all') return null
  return ALBUM_FOLDERS[album]
    .map((folder) => (sdk >= 29 ? `relative_path LIKE '${folder}%'` : `_data LIKE '%/${folder}%'`))
    .join(' OR ')
}

/**
 * How a page is ordered, newest first:
 * - `shown`: by the time the tile shows, when taken, else the file's time. datetaken is NULL
 *   for most downloads, chat images and edits (no EXIF capture time), and SQLite puts NULLs
 *   last under DESC: sorted on datetaken alone, an image saved a minute ago comes after every
 *   camera photo on the phone. date_modified is in seconds, datetaken in milliseconds;
 * - `taken`: datetaken alone, for a phone whose MediaProvider refuses the expression.
 * `_id` breaks ties in both, so a page boundary never repeats or skips a photo.
 */
export type ImageSort = 'shown' | 'taken'

export const IMAGE_SORTS: Readonly<Record<ImageSort, string>> = {
  shown: 'COALESCE(datetaken, date_modified * 1000) DESC, _id DESC',
  taken: 'datetaken DESC, _id DESC',
}

/** The time a row is sorted and shown by: when it was taken, else the file's time. */
export const shownTime = (row: Pick<ImageRow, 'taken' | 'modified'>): number | null =>
  row.taken ?? row.modified

/**
 * One page of an album, newest first. Pages are asked for with `--extra` query args on Android
 * 11+ (type `i`: MediaProvider reads them with getInt, and silently ignores a long), and with
 * the URI's `?limit=<offset>,<count>` before, or when `content` turns `--extra` down.
 */
export function imagesQuery(
  sdk: number,
  album: Album,
  page: ImagePage,
  paging: 'extras' | 'uri' = sdk >= 30 ? 'extras' : 'uri',
  sort: ImageSort = 'shown',
): ShellCommand {
  const { offset, limit } = page
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw androidError('INVALID_ARGUMENT')
  }
  const where = albumWhere(sdk, album)
  const whereArg = where === null ? shellCmd`` : shellCmd` --where ${where}`
  // The colon inside the key is escaped for content's own `name:type:value` split.
  const extras =
    paging === 'extras'
      ? shellCmd` --extra ${`android\\:query-arg-limit:i:${String(limit)}`} --extra ${`android\\:query-arg-offset:i:${String(offset)}`}`
      : shellCmd``
  const uri =
    paging === 'uri' ? `${IMAGES_URI}?limit=${String(offset)},${String(limit)}` : IMAGES_URI
  return shellCmd`content query --uri ${uri} --projection ${imageColumns(sdk).join(':')}${whereArg} --sort ${IMAGE_SORTS[sort]}${extras}`
}

/** Lines that are never the rest of a value: the error and stack trace exec: mixes in. */
const NOT_A_ROW =
  /^(Error while accessing provider|No result found\.|\s+at |Caused by:|[\w.$]+(Exception|Error)\b)/

/**
 * `Row: <n> col=val, col=val, …` → one record per row, cut on the known columns in order.
 * `NULL` becomes null (a text "NULL" reads the same: Android prints both alike). A value with a
 * newline in it continues on the next line. `No result found.` is an empty result.
 */
export function parseContentRows(
  text: string,
  columns: readonly string[],
): Record<string, string | null>[] {
  const bodies: string[] = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^Row: \d+ (.*)$/.exec(line)
    if (m) bodies.push(m[1] ?? '')
    else if (bodies.length > 0 && line !== '' && !NOT_A_ROW.test(line)) {
      bodies[bodies.length - 1] += `\n${line}`
    }
  }
  return bodies.map((body) => {
    const row: Record<string, string | null> = {}
    let at = 0
    for (const [i, column] of columns.entries()) {
      const key = `${column}=`
      if (!body.startsWith(key, at)) break
      const start = at + key.length
      const next = columns[i + 1]
      const found = next === undefined ? -1 : body.indexOf(`, ${next}=`, start)
      const end = found < 0 ? body.length : found
      const value = body.slice(start, end)
      row[column] = value === 'NULL' ? null : value
      at = end + 2
    }
    return row
  })
}

/**
 * Why `content` listed nothing, in the phone's words, or null when it answered (rows, or
 * `No result found.`). An argument it refused prints the usage and `[ERROR] …` on stdout; a
 * provider failure prints `Error while accessing provider:media` and a stack trace on stderr.
 */
export function contentFailure(
  result: Pick<RunResult, 'stdout' | 'stderr' | 'exitCode'>,
): string | null {
  if (/^Row: \d+ /m.test(result.stdout) || /^No result found\./m.test(result.stdout)) return null
  const text = `${result.stderr}\n${result.stdout}`
  const usage = /\[ERROR\]\s*(.+)/.exec(text)
  if (usage?.[1]) return usage[1].trim()
  const exception = /^\s*[\w.$]*(?:Exception|Error): (.+)$/m.exec(text)
  if (exception?.[1]) return exception[1].trim()
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return first ?? 'MediaStore did not answer.'
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  dng: 'image/x-adobe-dng',
}

/** The type a file name implies, or '' for something that is not an image. */
export function mimeFromName(name: string): string {
  return IMAGE_TYPES[/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? ''
}

/** `/storage/emulated/0/DCIM/Camera/a.jpg` → `DCIM/Camera/`: the folder below the volume. */
export function folderOf(path: string): string {
  const m =
    /^(?:\/storage\/emulated\/\d+|\/storage\/[^/]+|\/sdcard|\/mnt\/sdcard)\/(.*\/)?[^/]*$/.exec(
      path,
    )
  return m?.[1] ?? ''
}

const positive = (value: string | null | undefined) => {
  const n = Number(value)
  return value != null && value !== '' && Number.isFinite(n) && n > 0 ? n : null
}

/** Parsed rows → ImageRows. A row without a numeric `_id` is dropped. */
export function toImageRows(rows: readonly Record<string, string | null>[]): ImageRow[] {
  return rows.flatMap((r) => {
    const id = r._id ?? ''
    if (!/^\d+$/.test(id)) return []
    const path = r._data ?? ''
    const name = r._display_name || path.slice(path.lastIndexOf('/') + 1)
    const modified = positive(r.date_modified)
    return [
      {
        id,
        name,
        folder: r.relative_path ?? folderOf(path),
        size: positive(r._size),
        taken: positive(r.datetaken),
        // date_modified is in seconds, datetaken in milliseconds.
        modified: modified === null ? null : modified * 1000,
        width: positive(r.width),
        height: positive(r.height),
        mime: r.mime_type ?? mimeFromName(name),
        path,
      },
    ]
  })
}

/* ---------------------------------------------------------------- *
 * Previews, without writing to the phone
 * ---------------------------------------------------------------- */

/** Where MediaProvider keeps the thumbnails it made (Android 10+), as `<id>.jpg`. */
export const THUMBNAIL_DIR = '/sdcard/Pictures/.thumbnails'
/** Originals larger than this get a placeholder, not a preview. */
export const PREVIEW_MAX_ORIGINAL_BYTES = 8 * 1024 * 1024
/** Previews read at once: each is a USB transfer, and the log and screenshots share the cable. */
export const PREVIEW_CONCURRENCY = 3
/** Longest edge of a preview shrunk in the browser: the grid's widest tile, with margin. */
export const PREVIEW_MAX_EDGE = 512

/** The thumbnail folder's listing → `_id` → the cached file's size. */
export function thumbnailIndex(
  entries: readonly Pick<DirEntry, 'name' | 'size' | 'isFile'>[],
): Map<string, number> {
  const index = new Map<string, number>()
  for (const entry of entries) {
    const m = /^(\d+)\.jpg$/.exec(entry.name)
    if (m?.[1] && entry.isFile && entry.size > 0) index.set(m[1], entry.size)
  }
  return index
}

export const isHeif = (mime: string) => /^image\/hei[cf](-sequence)?$/i.test(mime)

/** What Chrome's <img> and createImageBitmap decode. */
export const browserCanShow = (mime: string) => /^image\/(jpe?g|png|webp|gif|bmp|avif)$/i.test(mime)

/** A path MediaStore or a folder listing gave, on shared storage: safe to read for a preview. */
export function isMediaPath(path: string): boolean {
  try {
    assertDevicePath(path)
  } catch {
    return false
  }
  return /^\/(storage\/[^/]+|sdcard)\/./.test(path)
}

export type PreviewSource =
  | { readonly kind: 'cache' | 'original'; readonly path: string; readonly size: number | null }
  | { readonly kind: 'none'; readonly reason: 'heic' | 'unsupported' | 'too-large' | 'no-path' }

/**
 * Where a row's preview comes from: a thumbnail Android already made (any type, HEIC included:
 * those are JPEGs), else the original when the browser can show it and it is small enough,
 * else nothing, with the reason the tile shows.
 */
export function previewSource(
  row: ImageRow,
  thumbnails: ReadonlyMap<string, number>,
  maxBytes = PREVIEW_MAX_ORIGINAL_BYTES,
): PreviewSource {
  const cached = row.id ? thumbnails.get(row.id) : undefined
  if (cached !== undefined)
    return { kind: 'cache', path: `${THUMBNAIL_DIR}/${row.id}.jpg`, size: cached }
  if (isHeif(row.mime)) return { kind: 'none', reason: 'heic' }
  if (!browserCanShow(row.mime)) return { kind: 'none', reason: 'unsupported' }
  if (!isMediaPath(row.path)) return { kind: 'none', reason: 'no-path' }
  if (row.size !== null && row.size > maxBytes) return { kind: 'none', reason: 'too-large' }
  return { kind: 'original', path: row.path, size: row.size }
}

/** A preview's size: the longest edge at most `edge`, never enlarged. */
export function previewSize(
  width: number,
  height: number,
  edge = PREVIEW_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'heif' | 'avif'

/** What the bytes are, from their first bytes; null for anything else (an error message, say). */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (/^avi[fs]$/.test(brand)) return 'avif'
    if (/^(hei[cmsx]|hev[cmsx]|mif1|msf1)$/.test(brand)) return 'heif'
  }
  if (ascii(0, 2) === 'BM' && bytes.length >= 26) return 'bmp'
  return null
}

/* ---------------------------------------------------------------- *
 * The fallback when MediaStore fails: the usual folders, file times only
 * ---------------------------------------------------------------- */

export const IMAGE_FOLDERS: Readonly<Record<Album, readonly string[]>> = {
  screenshots: ['Pictures/Screenshots', 'DCIM/Screenshots'],
  camera: ['DCIM/Camera'],
  all: ['Pictures/Screenshots', 'DCIM/Screenshots', 'DCIM/Camera', 'Download'],
}

/** By shownTime, newest first and unknown last, as the `shown` sort orders a page. */
export function newestShownFirst(a: ImageRow, b: ImageRow): number {
  return (shownTime(b) ?? -1) - (shownTime(a) ?? -1)
}

/**
 * A folder listing → ImageRows for its image files, newest first. Hidden files are left out:
 * MediaStore's own `.pending-…` and `.trashed-…` files among them. A folder row has no date
 * taken, so its file time is its shownTime: the same order as MediaStore's `shown` sort.
 */
export function folderImageRows(folder: string, entries: readonly DirEntry[]): ImageRow[] {
  return entries
    .filter((e) => e.isFile && !e.name.startsWith('.') && mimeFromName(e.name) !== '')
    .map((e) => ({
      id: '',
      name: e.name,
      folder: `${folder}/`,
      size: e.size,
      taken: null,
      modified: e.modified || null,
      width: null,
      height: null,
      mime: mimeFromName(e.name),
      path: `/sdcard/${folder}/${e.name}`,
    }))
    .sort(newestShownFirst)
}

/* ---------------------------------------------------------------- *
 * io
 * ---------------------------------------------------------------- */

export interface ImageQueryOptions {
  /**
   * The sort this phone took for an earlier page. Without one, `shown` is tried first and
   * `taken` once if MediaStore refuses it; the caller keeps the answer's `sort` for the next
   * pages, so every page of a listing is in the same order.
   */
  readonly sort?: ImageSort
  readonly signal?: AbortSignal
}

/**
 * One page of an album, and the sort that listed it. Rejects with the phone's words ("Invalid
 * column …") when MediaStore refused, which the tab shows as "Android didn't list the
 * images: …".
 */
export async function queryImages(
  adb: Adb,
  sdk: number,
  album: Album,
  page: ImagePage,
  options: ImageQueryOptions = {},
): Promise<{ rows: ImageRow[]; sort: ImageSort }> {
  const { signal } = options
  const ask = async (sort: ImageSort) => {
    let result = await run(adb, imagesQuery(sdk, album, page, undefined, sort), signal)
    if (sdk >= 30 && /Unsupported argument: --extra/.test(result.stdout + result.stderr)) {
      result = await run(adb, imagesQuery(sdk, album, page, 'uri', sort), signal)
    }
    return result
  }
  let sort = options.sort ?? 'shown'
  let result = await ask(sort)
  // MediaProvider's strict grammar for shell callers may turn the expression down; the plain
  // column always passes. Any failure gets the one retry: the phone's words differ by release.
  if (options.sort === undefined && contentFailure(result) !== null) {
    sort = 'taken'
    result = await ask(sort)
  }
  const failure = contentFailure(result)
  if (failure !== null) throw new Error(failure)
  return { rows: toImageRows(parseContentRows(result.stdout, imageColumns(sdk))), sort }
}

/** The thumbnails Android already has, by `_id`. One folder listing, nothing written. */
export async function listThumbnailCache(adb: Adb): Promise<Map<string, number>> {
  return thumbnailIndex(await listDirectory(adb, THUMBNAIL_DIR))
}

/**
 * A preview's bytes, as a plain file read over sync, checked to be an image. Rejects with
 * `PREVIEW_UNAVAILABLE` for a source of kind `none` and `PREVIEW_NOT_IMAGE` for other bytes.
 */
export async function readPreview(
  adb: Adb,
  source: PreviewSource,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (source.kind === 'none') throw androidError('PREVIEW_UNAVAILABLE')
  const bytes = await pullFile(adb, source.path, { signal, maxBytes: PREVIEW_MAX_ORIGINAL_BYTES })
  if (sniffImage(bytes) === null) throw androidError('PREVIEW_NOT_IMAGE')
  return bytes
}

/** The album from its usual folders, when MediaStore did not answer. Dates are file times. */
export async function listFolderImages(adb: Adb, album: Album): Promise<ImageRow[]> {
  const lists = await Promise.all(
    IMAGE_FOLDERS[album].map(async (folder) =>
      folderImageRows(folder, await listDirectory(adb, `/sdcard/${folder}`)),
    ),
  )
  return lists.flat().sort(newestShownFirst)
}
