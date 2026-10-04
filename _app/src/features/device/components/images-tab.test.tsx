// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRow } from '../backends/android/media'
import type { Backend, ImageQuery } from '../backends/backend'
import { normalizeDevice } from '../model'
import {
  IMAGE_ALBUMS,
  ImagesTab,
  appendPage,
  createLimiter,
  createPreviewCache,
  gridMove,
  previewKey,
  previewPlan,
} from './images-tab'

/*
  The Images tab as a tester meets it, over a scripted lane: albums, paging, the folder
  fallback and its warning, the blocking card, previews that ask for visible tiles only and at
  most three at a time, and the keyboard. Every name here is made up.
*/

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

const row = (n: number, over: Partial<ImageRow> = {}): ImageRow => ({
  id: String(n),
  name: `shot-${String(n)}.png`,
  folder: 'Pictures/Screenshots/',
  size: 200_000,
  taken: Date.UTC(2026, 9, 1, 8, 0, n),
  modified: Date.UTC(2026, 9, 1, 8, 0, n),
  width: 1080,
  height: 2424,
  mime: 'image/png',
  path: `/storage/emulated/0/Pictures/Screenshots/shot-${String(n)}.png`,
  ...over,
})

const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i))

const DEVICE = normalizeDevice({
  id: 'SERIAL1',
  backend: 'mock',
  name: 'Pixel 9',
  state: 'ready',
  capabilities: { images: true },
})

/** A lane with just the image operations; the rest are never called by this tab. */
function lane(ops: Partial<Pick<Backend, 'images' | 'thumbnail' | 'pull'>>): Backend {
  return {
    kind: 'mock',
    label: 'Mock',
    platforms: ['android'],
    canRequest: false,
    isAvailable: () => true,
    start: () => Promise.resolve(),
    stop: () => undefined,
    subscribe: () => () => undefined,
    list: () => [],
    detail: () => Promise.reject(new Error('unused')),
    screenshot: () => Promise.reject(new Error('unused')),
    ...ops,
  }
}

function renderTab(backend: Backend, device = DEVICE) {
  return render(<ImagesTab device={device} backend={backend} zoom={160} onZoom={() => undefined} />)
}

let urls = 0

beforeEach(() => {
  urls = 0
  // jsdom has neither blob URLs nor a bitmap decoder.
  URL.createObjectURL = vi.fn(() => `blob:preview-${String(++urls)}`)
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 100, height: 100, close: () => undefined })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('previewPlan', () => {
  const both = { thumbnail: true, pull: true }

  it('asks the lane for every row when it has thumbnail(), HEIC included', () => {
    expect(previewPlan(row(1), both)).toEqual({ step: 'thumbnail', otherwise: 'failed' })
    expect(previewPlan(row(1, { mime: 'image/heic' }), both)).toEqual({
      step: 'thumbnail',
      otherwise: 'heic',
    })
  })

  it('pulls the original itself only when the lane has no thumbnail()', () => {
    const pullOnly = { thumbnail: false, pull: true }
    expect(previewPlan(row(1), pullOnly).step).toBe('original')
    expect(previewPlan(row(1, { size: null }), pullOnly).step).toBe('original')
  })

  it('never reads an original the browser can’t draw or that is past the cap', () => {
    const pullOnly = { thumbnail: false, pull: true }
    expect(previewPlan(row(1, { mime: 'image/heif' }), pullOnly)).toEqual({
      step: null,
      otherwise: 'heic',
    })
    expect(previewPlan(row(1, { mime: 'image/x-adobe-dng' }), pullOnly)).toEqual({
      step: null,
      otherwise: 'unsupported',
    })
    expect(previewPlan(row(1, { size: 9 * 1024 * 1024 }), pullOnly)).toEqual({
      step: null,
      otherwise: 'too-large',
    })
    expect(previewPlan(row(1, { path: '' }), pullOnly)).toEqual({
      step: null,
      otherwise: 'unavailable',
    })
    expect(previewPlan(row(1), { thumbnail: false, pull: false }).step).toBeNull()
  })
})

describe('createLimiter', () => {
  it('runs at most `limit` tasks at once, in order', async () => {
    const limiter = createLimiter(2)
    const started: number[] = []
    const finish: (() => void)[] = []
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        started.push(n)
        finish.push(() => {
          resolve(n)
        })
      })
    const live = new AbortController().signal
    const results = [1, 2, 3, 4].map((n) => limiter.run(task(n), live))
    expect(started).toEqual([1, 2])
    expect(limiter.waiting).toBe(2)
    finish[0]?.()
    await results[0]
    await Promise.resolve()
    expect(started).toEqual([1, 2, 3])
    finish[1]?.()
    finish[2]?.()
    await Promise.all(results.slice(1, 3))
    await Promise.resolve()
    finish[3]?.()
    await expect(Promise.all(results)).resolves.toEqual([1, 2, 3, 4])
    expect(limiter.active).toBe(0)
  })

  it('drops a waiting task whose signal aborts, and never starts it', async () => {
    const limiter = createLimiter(1)
    let release = () => undefined as void
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      new AbortController().signal,
    )
    const drop = new AbortController()
    const task = vi.fn(() => Promise.resolve('late'))
    const second = limiter.run(task, drop.signal)
    drop.abort(new Error('scrolled away'))
    await expect(second).rejects.toThrow('scrolled away')
    expect(limiter.waiting).toBe(0)
    release()
    await first
    expect(task).not.toHaveBeenCalled()
  })

  it('refuses a task whose signal has already aborted', async () => {
    const drop = new AbortController()
    drop.abort(new Error('gone'))
    await expect(createLimiter(1).run(() => Promise.resolve(1), drop.signal)).rejects.toThrow(
      'gone',
    )
  })
})

describe('createPreviewCache', () => {
  it('drops the least recently used entry and revokes its URL', () => {
    const revoke = vi.fn()
    const cache = createPreviewCache(2, revoke)
    cache.set('a', { kind: 'ready', url: 'blob:a' })
    cache.set('b', { kind: 'none', reason: 'heic' })
    cache.get('a')
    cache.set('c', { kind: 'ready', url: 'blob:c' })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toEqual({ kind: 'ready', url: 'blob:a' })
    expect(revoke).not.toHaveBeenCalled()
    cache.set('d', { kind: 'none', reason: 'failed' })
    expect(revoke).toHaveBeenCalledWith('blob:c')
  })

  it('revokes the URL a replaced entry held', () => {
    const revoke = vi.fn()
    const cache = createPreviewCache(5, revoke)
    cache.set('a', { kind: 'ready', url: 'blob:old' })
    cache.set('a', { kind: 'ready', url: 'blob:new' })
    expect(revoke).toHaveBeenCalledWith('blob:old')
    expect(cache.size).toBe(1)
  })

  it('forgets one device’s failures for Refresh, and keeps its pictures', () => {
    const cache = createPreviewCache(10, vi.fn())
    cache.set('S1|1', { kind: 'none', reason: 'failed' })
    cache.set('S1|2', { kind: 'ready', url: 'blob:2' })
    cache.set('S2|1', { kind: 'none', reason: 'failed' })
    cache.forgetFailures('S1|')
    expect(cache.get('S1|1')).toBeUndefined()
    expect(cache.get('S1|2')).toBeDefined()
    expect(cache.get('S2|1')).toBeDefined()
  })
})

describe('helpers', () => {
  it('moves focus through a wrapped grid', () => {
    expect(gridMove('ArrowRight', 0, 4, 10)).toBe(1)
    expect(gridMove('ArrowLeft', 0, 4, 10)).toBeNull()
    expect(gridMove('ArrowDown', 1, 4, 10)).toBe(5)
    expect(gridMove('ArrowDown', 7, 4, 10)).toBeNull()
    expect(gridMove('ArrowUp', 5, 4, 10)).toBe(1)
    expect(gridMove('Home', 5, 4, 10)).toBe(0)
    expect(gridMove('End', 5, 4, 10)).toBe(9)
    expect(gridMove('Enter', 5, 4, 10)).toBeNull()
    expect(gridMove('ArrowDown', 0, 0, 3)).toBe(1)
  })

  it('appends a page without the photos a shifted page repeats', () => {
    expect(appendPage(rows(1, 3), rows(3, 3)).map((r) => r.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('keys a preview by device, photo and version', () => {
    expect(previewKey('S1', row(7))).toBe(`S1|7|${String(Date.UTC(2026, 9, 1, 8, 0, 7))}|200000`)
    expect(previewKey('S1', row(7, { id: '', modified: null, size: null }))).toBe(
      'S1|/storage/emulated/0/Pictures/Screenshots/shot-7.png||',
    )
  })

  it('offers Screenshots, Camera and All images', () => {
    expect(IMAGE_ALBUMS.map((a) => a.label)).toEqual(['Screenshots', 'Camera', 'All images'])
  })
})

describe('ImagesTab', () => {
  it('lists Screenshots first, then the album the tester picks', async () => {
    const images = vi.fn((_id: string, q: ImageQuery) =>
      Promise.resolve(q.album === 'screenshots' ? rows(1, 2) : [row(9, { name: 'cam-9.jpg' })]),
    )
    renderTab(lane({ images }))
    expect(await screen.findByRole('button', { name: /^shot-1\.png/ })).toBeInTheDocument()
    expect(images).toHaveBeenCalledWith('SERIAL1', { album: 'screenshots', offset: 0, limit: 60 })
    expect(screen.getByText('2 images')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Camera' }))
    expect(await screen.findByRole('button', { name: /^cam-9\.jpg/ })).toBeInTheDocument()
    expect(images).toHaveBeenLastCalledWith('SERIAL1', { album: 'camera', offset: 0, limit: 60 })
  })

  it('says an empty album is empty, naming the phone', async () => {
    renderTab(lane({ images: () => Promise.resolve([]) }))
    expect(await screen.findByText('No screenshots on Pixel 9.')).toBeInTheDocument()
  })

  it('pages with Load more, from where the list ends', async () => {
    const images = vi.fn((_id: string, q: ImageQuery) =>
      Promise.resolve(q.offset === 0 ? rows(1, 60) : rows(61, 5)),
    )
    renderTab(lane({ images }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('65 images')).toBeInTheDocument()
    expect(images).toHaveBeenLastCalledWith('SERIAL1', {
      album: 'screenshots',
      offset: 60,
      limit: 60,
    })
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('falls back to the folders when MediaStore refuses, and says so', async () => {
    const images = vi.fn((_id: string, q: ImageQuery) =>
      q.folders
        ? Promise.resolve([row(0, { id: '', taken: null })])
        : Promise.reject(new Error('Invalid column datetaken')),
    )
    renderTab(lane({ images }))
    expect(
      await screen.findByText(
        'Showing folders only (Screenshots, Camera, Download). Dates are file times.',
      ),
    ).toBeInTheDocument()
    expect(images).toHaveBeenLastCalledWith('SERIAL1', {
      album: 'screenshots',
      offset: 0,
      limit: 60,
      folders: true,
    })
    expect(screen.getByRole('button', { name: /^shot-0\.png/ })).toBeInTheDocument()
  })

  it('blocks with MediaStore’s own words when the folders fail too, and Retry reads again', async () => {
    const images = vi.fn((_id: string, q: ImageQuery): Promise<ImageRow[]> =>
      Promise.reject(new Error(q.folders ? 'Permission denied' : 'Invalid column datetaken')),
    )
    renderTab(lane({ images }))
    expect(
      await screen.findByText('Android didn’t list the images: Invalid column datetaken.'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('Blocking').length).toBeGreaterThan(0)
    images.mockImplementation(() => Promise.resolve(rows(1, 1)))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /^shot-1\.png/ })).toBeInTheDocument()
  })

  it('reads previews three at a time, by the row’s key, and shows them', async () => {
    const waiting: ((blob: Blob) => void)[] = []
    const thumbnail = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          waiting.push(resolve)
        }),
    )
    const pull = vi.fn(() => Promise.reject(new Error('unused')))
    const { container } = renderTab(
      lane({ images: () => Promise.resolve(rows(100, 5)), thumbnail, pull }),
    )
    await screen.findByRole('button', { name: /^shot-100\.png/ })
    await waitFor(() => {
      expect(thumbnail).toHaveBeenCalledTimes(3)
    })
    expect(thumbnail.mock.calls.map((c: unknown[]) => c[1])).toEqual(['100', '101', '102'])
    await act(async () => {
      waiting[0]?.(new Blob([JPEG], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(thumbnail).toHaveBeenCalledTimes(4)
    })
    await waitFor(() => {
      expect(container.querySelector('img[src^="blob:preview-"]')).not.toBeNull()
    })
    // The lane's thumbnail() does the reading; the tab never pulls originals behind its back.
    expect(pull).not.toHaveBeenCalled()
  })

  it('shows why a tile has no preview, without a toast', async () => {
    const thumbnail = vi.fn(() => Promise.reject(new Error('PREVIEW_UNAVAILABLE')))
    renderTab(
      lane({
        images: () =>
          Promise.resolve([
            // Ids no other test uses: previews are kept for the life of the page.
            row(201, { name: 'photo-201.heic', mime: 'image/heic' }),
            row(202, { name: 'big-202.jpg', mime: 'image/jpeg', size: 12 * 1024 * 1024 }),
            row(203, { name: 'gone-203.png' }),
          ]),
        thumbnail,
      }),
    )
    expect(await screen.findByText('HEIC: open it to save')).toBeInTheDocument()
    expect(await screen.findByText('Large file: open it to view')).toBeInTheDocument()
    expect(await screen.findByText('No preview')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks again for a tile the lane had no preview for, but not for one that failed', async () => {
    // The lane no longer knows the row (a listing from before a reconnect), then does.
    const thumbnail = vi.fn((_id: string, key: string) =>
      key === '301' && thumbnail.mock.calls.length <= 2
        ? Promise.reject(new Error('PREVIEW_UNAVAILABLE'))
        : key === '302'
          ? Promise.reject(new Error('Socket closed'))
          : Promise.resolve(new Blob([JPEG], { type: 'image/jpeg' })),
    )
    const backend = lane({
      images: () => Promise.resolve([row(301), row(302, { name: 'fails-302.png' })]),
      thumbnail,
    })
    const first = renderTab(backend)
    expect(await screen.findByText('No preview')).toBeInTheDocument()
    expect(await screen.findByText('Preview failed')).toBeInTheDocument()
    first.unmount()

    const { container } = renderTab(backend)
    await waitFor(() => {
      expect(container.querySelector('img[src^="blob:preview-"]')).not.toBeNull()
    })
    expect(screen.queryByText('No preview')).not.toBeInTheDocument()
    // A real failure is kept until Refresh: the phone is not read twice for it.
    expect(screen.getByText('Preview failed')).toBeInTheDocument()
    expect(thumbnail.mock.calls.map((c) => c[1])).toEqual(['301', '302', '301'])
  })

  it('moves between tiles with the arrow keys and opens one with Enter', async () => {
    const pull = vi.fn(() => Promise.resolve(new Blob([JPEG], { type: 'image/png' })))
    renderTab(lane({ images: () => Promise.resolve(rows(1, 3)), pull }))
    const first = await screen.findByRole('button', { name: /^shot-1\.png/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    const second = screen.getByRole('button', { name: /^shot-2\.png/ })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'End' })
    expect(screen.getByRole('button', { name: /^shot-3\.png/ })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /^shot-3\.png/ }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('shot-3.png')
  })

  it('opens the viewer on the tile’s own preview while the original is read', async () => {
    const pull = vi.fn(() => new Promise<Blob>(() => undefined))
    const thumbnail = vi.fn(() => Promise.resolve(new Blob([JPEG], { type: 'image/jpeg' })))
    const { container } = renderTab(
      lane({ images: () => Promise.resolve([row(401), row(402)]), thumbnail, pull }),
    )
    await waitFor(() => {
      expect(container.querySelectorAll('img[src^="blob:preview-"]')).toHaveLength(2)
    })
    const tile = container.querySelector('[data-image-index="0"] img')?.getAttribute('src')
    fireEvent.click(screen.getByRole('button', { name: /^shot-401\.png/ }))
    const dialog = await screen.findByRole('dialog')
    expect(
      dialog.querySelector(`[data-slot="image-frame"] img[src="${String(tile)}"]`),
    ).not.toBeNull()
    expect(dialog).toHaveTextContent('Reading from Pixel 9')
    // The tile's preview is reused, not read again.
    expect(thumbnail).toHaveBeenCalledTimes(2)
  })

  it('says so when the lane can’t list images', () => {
    renderTab(lane({}))
    expect(screen.getByText('This connection can’t list the phone’s images.')).toBeInTheDocument()
  })
})
