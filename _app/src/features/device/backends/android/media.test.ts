import { describe, expect, it } from 'vitest'

import { fakeAdb } from './fake-adb'
import {
  CONTENT_EMPTY,
  CONTENT_INVALID_COLUMN_STDERR,
  CONTENT_ROWS,
  CONTENT_ROWS_OLDER,
  CONTENT_ROW_MULTILINE,
  CONTENT_UNSUPPORTED_EXTRA,
} from './fixtures'
import {
  THUMBNAIL_DIR,
  albumWhere,
  contentFailure,
  folderImageRows,
  folderOf,
  imageColumns,
  IMAGE_SORTS,
  imagesQuery,
  listFolderImages,
  newestShownFirst,
  listThumbnailCache,
  mimeFromName,
  parseContentRows,
  previewSize,
  previewSource,
  queryImages,
  readPreview,
  sniffImage,
  thumbnailIndex,
  toImageRows,
  type ImageRow,
} from './media'

const MAIN = imageColumns(33)
const OLDER = imageColumns(28)

describe('imagesQuery', () => {
  it('asks Android 11+ for one page with --extra query args, newest first, by real column names', () => {
    expect(imagesQuery(37, 'screenshots', { offset: 60, limit: 60 }).text).toBe(
      "content query --uri 'content://media/external/images/media' --projection '_id:_display_name:relative_path:_size:datetaken:date_modified:width:height:mime_type:_data'" +
        ` --where 'relative_path LIKE '\\''Pictures/Screenshots/%'\\'' OR relative_path LIKE '\\''DCIM/Screenshots/%'\\'''` +
        " --sort 'COALESCE(datetaken, date_modified * 1000) DESC, _id DESC'" +
        String.raw` --extra 'android\:query-arg-limit:i:60' --extra 'android\:query-arg-offset:i:60'`,
    )
  })

  it('pages with the URI on Android 10 and older, and lists All images without --where', () => {
    expect(imagesQuery(29, 'all', { offset: 0, limit: 60 }).text).toBe(
      "content query --uri 'content://media/external/images/media?limit=0,60' --projection '_id:_display_name:relative_path:_size:datetaken:date_modified:width:height:mime_type:_data' --sort 'COALESCE(datetaken, date_modified * 1000) DESC, _id DESC'",
    )
  })

  it('reads the folder from _data before Android 10, which has no relative_path', () => {
    expect(OLDER).not.toContain('relative_path')
    expect(albumWhere(28, 'camera')).toBe("_data LIKE '%/DCIM/Camera/%'")
    expect(albumWhere(29, 'camera')).toBe("relative_path LIKE 'DCIM/Camera/%'")
    expect(albumWhere(37, 'all')).toBeNull()
  })

  it('sorts by the time a tile shows, so an image with no date taken is not buried', () => {
    // datetaken is ms, date_modified seconds; the plain column is the fallback sort.
    expect(IMAGE_SORTS.shown).toBe('COALESCE(datetaken, date_modified * 1000) DESC, _id DESC')
    expect(imagesQuery(37, 'all', { offset: 0, limit: 60 }, 'extras', 'taken').text).toContain(
      " --sort 'datetaken DESC, _id DESC' --extra",
    )
  })

  it('never asks for date_taken, which strict MediaStore rejects', () => {
    expect(imagesQuery(37, 'camera', { offset: 0, limit: 1 }).text).not.toContain('date_taken')
  })

  it('refuses a page that is not a whole, positive range', () => {
    expect(() => imagesQuery(37, 'all', { offset: -1, limit: 60 })).toThrow('INVALID_ARGUMENT')
    expect(() => imagesQuery(37, 'all', { offset: 0, limit: 0 })).toThrow('INVALID_ARGUMENT')
    expect(() => imagesQuery(37, 'all', { offset: 0.5, limit: 60 })).toThrow('INVALID_ARGUMENT')
  })
})

describe('parseContentRows', () => {
  it('cuts rows on the known columns, so ", " and "=" inside a name survive', () => {
    const rows = parseContentRows(CONTENT_ROWS, MAIN)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({
      _display_name: 'menu, final, v2=ok.jpg',
      relative_path: 'DCIM/Camera/',
      datetaken: null,
      _data: '/storage/emulated/0/DCIM/Camera/menu, final, v2=ok.jpg',
    })
  })

  it('carries a value with a newline on to the next line', () => {
    expect(parseContentRows(CONTENT_ROW_MULTILINE, MAIN)[0]).toMatchObject({
      _id: '7',
      _display_name: 'two\nlines.png',
      _data: '/storage/emulated/0/Pictures/two\nlines.png',
    })
  })

  it('reads "No result found." as no rows, and keeps an error mixed into stdout out of the last value', () => {
    expect(parseContentRows(CONTENT_EMPTY, MAIN)).toEqual([])
    const mixed = `${CONTENT_ROWS_OLDER}${CONTENT_INVALID_COLUMN_STDERR}`
    expect(parseContentRows(mixed, OLDER)[0]?._data).toBe(
      '/storage/emulated/0/DCIM/Camera/IMG_0001.jpg',
    )
  })
})

describe('toImageRows', () => {
  it('turns rows into images: ms dates, a seconds file time made ms, nulls kept', () => {
    const [shot, menu, heic] = toImageRows(parseContentRows(CONTENT_ROWS, MAIN))
    expect(shot).toEqual({
      id: '1000012345',
      name: 'Screenshot_20261001-101010.png',
      folder: 'Pictures/Screenshots/',
      size: 3215801,
      taken: 1790000000000,
      modified: 1790000000000,
      width: 1080,
      height: 2424,
      mime: 'image/png',
      path: '/storage/emulated/0/Pictures/Screenshots/Screenshot_20261001-101010.png',
    })
    expect(menu?.taken).toBeNull()
    expect(heic?.mime).toBe('image/heic')
  })

  it('derives the folder from _data on older Android', () => {
    expect(toImageRows(parseContentRows(CONTENT_ROWS_OLDER, OLDER))[0]).toMatchObject({
      id: '4711',
      folder: 'DCIM/Camera/',
    })
    expect(folderOf('/storage/1234-ABCD/Pictures/x.png')).toBe('Pictures/')
    expect(folderOf('/storage/emulated/0/x.png')).toBe('')
  })

  it('drops a row without a numeric id', () => {
    expect(toImageRows([{ _id: null }, { _id: 'abc' }])).toEqual([])
  })
})

describe('contentFailure', () => {
  it('says nothing when content answered, rows or none', () => {
    expect(contentFailure({ stdout: CONTENT_ROWS, stderr: '', exitCode: 0 })).toBeNull()
    expect(contentFailure({ stdout: CONTENT_EMPTY, stderr: '', exitCode: 0 })).toBeNull()
  })

  it("gives the provider's reason, not its stack", () => {
    expect(contentFailure({ stdout: '', stderr: CONTENT_INVALID_COLUMN_STDERR, exitCode: 0 })).toBe(
      'Invalid column date_taken',
    )
  })

  it('gives the argument content refused', () => {
    expect(contentFailure({ stdout: CONTENT_UNSUPPORTED_EXTRA, stderr: '', exitCode: 0 })).toBe(
      'Unsupported argument: --extra',
    )
    expect(contentFailure({ stdout: '', stderr: '', exitCode: 0 })).toBe(
      'MediaStore did not answer.',
    )
  })
})

describe('previews, without writing to the phone', () => {
  const row = (over: Partial<ImageRow>): ImageRow => ({
    id: '1000012345',
    name: 'a.jpg',
    folder: 'DCIM/Camera/',
    size: 3_000_000,
    taken: null,
    modified: null,
    width: 4000,
    height: 3000,
    mime: 'image/jpeg',
    path: '/storage/emulated/0/DCIM/Camera/a.jpg',
    ...over,
  })
  const cache = thumbnailIndex([
    { name: '1000012345.jpg', size: 41_000, isFile: true },
    { name: '1000012343.jpg', size: 38_000, isFile: true },
    { name: '1000012300.jpg', size: 0, isFile: true },
    { name: 'journal.db', size: 10, isFile: true },
    { name: '777.jpg', size: 10, isFile: false },
  ])

  it('indexes only the non-empty <id>.jpg files of the thumbnail folder', () => {
    expect([...cache.keys()]).toEqual(['1000012345', '1000012343'])
  })

  it('uses a thumbnail Android already made, for any type, HEIC included', () => {
    expect(previewSource(row({}), cache)).toEqual({
      kind: 'cache',
      path: `${THUMBNAIL_DIR}/1000012345.jpg`,
      size: 41_000,
    })
    expect(previewSource(row({ id: '1000012343', mime: 'image/heic' }), cache).kind).toBe('cache')
  })

  it('otherwise pulls the original, when the browser can show it and it is small enough', () => {
    expect(previewSource(row({ id: '1' }), cache)).toEqual({
      kind: 'original',
      path: '/storage/emulated/0/DCIM/Camera/a.jpg',
      size: 3_000_000,
    })
    expect(previewSource(row({ id: '1', size: 9_000_000 }), cache)).toEqual({
      kind: 'none',
      reason: 'too-large',
    })
    expect(previewSource(row({ id: '1', mime: 'image/heif' }), cache)).toEqual({
      kind: 'none',
      reason: 'heic',
    })
    expect(previewSource(row({ id: '1', mime: 'image/x-adobe-dng' }), cache)).toEqual({
      kind: 'none',
      reason: 'unsupported',
    })
    expect(previewSource(row({ id: '1', path: '/data/local/tmp/a.jpg' }), cache)).toEqual({
      kind: 'none',
      reason: 'no-path',
    })
  })

  it('shrinks to the longest edge, never enlarging', () => {
    expect(previewSize(4000, 3000)).toEqual({ width: 512, height: 384 })
    expect(previewSize(1080, 2424, 240)).toEqual({ width: 107, height: 240 })
    expect(previewSize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('knows image bytes by their first bytes', () => {
    const bytes = (...b: number[]) => Uint8Array.from(b)
    const text = (s: string) => new TextEncoder().encode(s)
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg')
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png')
    expect(sniffImage(text('GIF89a...'))).toBe('gif')
    expect(sniffImage(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffImage(text('\0\0\0\x18ftypheic\0\0\0\0'))).toBe('heif')
    expect(sniffImage(text('\0\0\0\x1cftypavif\0\0\0\0'))).toBe('avif')
    expect(sniffImage(text('Error: No such file'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  it('reads the type a name implies', () => {
    expect(mimeFromName('a.JPG')).toBe('image/jpeg')
    expect(mimeFromName('b.heic')).toBe('image/heic')
    expect(mimeFromName('notes.txt')).toBe('')
  })
})

describe('io', () => {
  it('runs one page query over the shell protocol and parses it', async () => {
    const { adb, calls } = fakeAdb({ answer: () => ({ stdout: CONTENT_ROWS }) })
    const { rows, sort } = await queryImages(adb, 37, 'camera', { offset: 0, limit: 60 })
    expect(rows.map((r) => r.id)).toEqual(['1000012345', '1000012344', '1000012343'])
    expect(sort).toBe('shown')
    expect(calls).toMatchObject([
      { via: 'shell', command: imagesQuery(37, 'camera', { offset: 0, limit: 60 }).text },
    ])
  })

  it('pages with the URI instead when content turns --extra down', async () => {
    const { adb, calls } = fakeAdb({
      answer: (call) =>
        call.command.includes('--extra')
          ? { stdout: CONTENT_UNSUPPORTED_EXTRA }
          : { stdout: CONTENT_EMPTY },
    })
    expect(await queryImages(adb, 30, 'all', { offset: 120, limit: 60 })).toEqual({
      rows: [],
      sort: 'shown',
    })
    expect(calls[1]?.command).toContain(
      "--uri 'content://media/external/images/media?limit=120,60'",
    )
  })

  it("rejects with the phone's reason when MediaStore refuses either sort", async () => {
    const { adb, calls } = fakeAdb({ answer: () => ({ stderr: CONTENT_INVALID_COLUMN_STDERR }) })
    await expect(queryImages(adb, 37, 'all', { offset: 0, limit: 60 })).rejects.toThrow(
      'Invalid column date_taken',
    )
    expect(calls.map((c) => c.command.includes('COALESCE'))).toEqual([true, false])
  })

  it('falls back to datetaken alone, once, when the phone refuses the expression', async () => {
    const refused = [
      'Error while accessing provider:media',
      'java.lang.IllegalArgumentException: Invalid token 1000',
      '',
    ].join('\n')
    const { adb, calls } = fakeAdb({
      answer: (call) =>
        call.command.includes('COALESCE') ? { stderr: refused } : { stdout: CONTENT_ROWS },
    })
    const first = await queryImages(adb, 37, 'all', { offset: 0, limit: 60 })
    expect(first.sort).toBe('taken')
    expect(first.rows).toHaveLength(3)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.command).toContain("--sort 'datetaken DESC, _id DESC'")
    // The next page, told the sort that worked, asks for it straight away.
    await queryImages(adb, 37, 'all', { offset: 60, limit: 60 }, { sort: first.sort })
    expect(calls).toHaveLength(3)
    expect(calls[2]?.command).toContain("--sort 'datetaken DESC, _id DESC'")
  })

  it('does not change sorts mid-listing: a sort that worked before is not retried', async () => {
    const { adb, calls } = fakeAdb({ answer: () => ({ stderr: CONTENT_INVALID_COLUMN_STDERR }) })
    await expect(
      queryImages(adb, 37, 'all', { offset: 60, limit: 60 }, { sort: 'shown' }),
    ).rejects.toThrow('Invalid column date_taken')
    expect(calls).toHaveLength(1)
  })

  it('orders folder rows as the shown sort does: the file time stands in for a date taken', () => {
    const row = (name: string, taken: number | null, modified: number | null): ImageRow => ({
      id: '',
      name,
      folder: 'Download/',
      size: null,
      taken,
      modified,
      width: null,
      height: null,
      mime: 'image/jpeg',
      path: `/sdcard/Download/${name}`,
    })
    const rows = [
      row('camera-old', 1_000_000, 5000),
      row('saved-just-now', null, 3_000_000),
      row('camera-older', 500_000, 9000),
      row('unknown', null, null),
    ]
    expect(rows.sort(newestShownFirst).map((r) => r.name)).toEqual([
      'saved-just-now',
      'camera-old',
      'camera-older',
      'unknown',
    ])
  })

  it('lists the thumbnail cache with one folder read, and writes nothing', async () => {
    const { adb, calls, syncs } = fakeAdb({
      dirs: {
        [THUMBNAIL_DIR]: [
          { name: '1000012345.jpg', size: 41_000 },
          { name: 'x', size: 1, dir: true },
        ],
      },
    })
    expect(await listThumbnailCache(adb)).toEqual(new Map([['1000012345', 41_000]]))
    expect(calls).toEqual([])
    expect(syncs).toMatchObject([{ disposed: true, reads: [] }])
  })

  it('reads a preview as a plain file, and refuses bytes that are not an image', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const { adb, calls } = fakeAdb({
      files: {
        [`${THUMBNAIL_DIR}/1.jpg`]: jpeg,
        '/sdcard/DCIM/Camera/b.jpg': new TextEncoder().encode('oops'),
      },
    })
    expect(
      await readPreview(adb, { kind: 'cache', path: `${THUMBNAIL_DIR}/1.jpg`, size: 7 }),
    ).toEqual(jpeg)
    await expect(
      readPreview(adb, { kind: 'original', path: '/sdcard/DCIM/Camera/b.jpg', size: 4 }),
    ).rejects.toThrow('PREVIEW_NOT_IMAGE')
    await expect(readPreview(adb, { kind: 'none', reason: 'heic' })).rejects.toThrow(
      'PREVIEW_UNAVAILABLE',
    )
    expect(calls).toEqual([])
  })

  it('falls back to the usual folders: visible image files only, newest first', async () => {
    const { adb } = fakeAdb({
      dirs: {
        '/sdcard/Pictures/Screenshots': [
          { name: 'Screenshot_1.png', size: 10, mtime: 100 },
          { name: '.trashed-1790000000-Screenshot_0.png', size: 9, mtime: 300 },
          { name: 'notes.txt', size: 5, mtime: 400 },
        ],
        '/sdcard/DCIM/Screenshots': [{ name: 'Screenshot_2.jpg', size: 20, mtime: 200 }],
      },
    })
    const rows = await listFolderImages(adb, 'screenshots')
    expect(rows.map((r) => r.name)).toEqual(['Screenshot_2.jpg', 'Screenshot_1.png'])
    expect(rows[0]).toMatchObject({
      id: '',
      folder: 'DCIM/Screenshots/',
      path: '/sdcard/DCIM/Screenshots/Screenshot_2.jpg',
      modified: 200_000,
      mime: 'image/jpeg',
    })
    expect(folderImageRows('Download', [])).toEqual([])
  })
})
