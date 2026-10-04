// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRow } from '../backends/android/media'
import type { Backend } from '../backends/backend'
import { normalizeDevice } from '../model'
import {
  ImageViewer,
  canDisplay,
  clipboardPlan,
  fitsAhead,
  fmtDimensions,
  frameLayers,
  imageFacts,
  imageWhen,
  originalKey,
  progressText,
  readOriginal,
  saveName,
  typeLabel,
  viewerFacts,
  viewerStep,
  type PreviewSource,
} from './image-viewer'

/*
  The viewer over a scripted lane: the original is read when a photo opens (with progress, and
  cancelled by closing or stepping on), the grid's preview stands in until it is decoded, the
  photo ahead is read once one is shown, HEIC is only read when Save asks, and the arrow keys
  walk the album, loading the next page at its end, without the body or its buttons being
  remade. Originals are kept for the life of the module, so every test uses its own photo
  numbers. Every name here is made up.
*/

const row = (n: number, over: Partial<ImageRow> = {}): ImageRow => ({
  id: String(n),
  name: `photo-${String(n)}.jpg`,
  folder: 'DCIM/Camera/',
  size: 3_000_000,
  taken: Date.UTC(2026, 8, 30, 3, 4, 5),
  modified: Date.UTC(2026, 8, 30, 3, 4, 9),
  width: 4032,
  height: 3024,
  mime: 'image/jpeg',
  path: `/storage/emulated/0/DCIM/Camera/photo-${String(n)}.jpg`,
  ...over,
})

const DEVICE = normalizeDevice({ id: 'SERIAL1', backend: 'mock', name: 'Pixel 9', state: 'ready' })

type Pull = NonNullable<Backend['pull']>

function lane(pull?: Pull): Backend {
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
    ...(pull ? { pull } : {}),
  }
}

/** A pull the test finishes by hand, recording what it was asked. */
function manualPull() {
  const calls: {
    path: string
    onProgress: (sent: number, total: number) => void
    signal: AbortSignal
    resolve: (blob: Blob) => void
    reject: (error: Error) => void
  }[] = []
  const pull = vi.fn<Pull>(
    (_id, path, onProgress, signal) =>
      new Promise<Blob>((resolve, reject) => {
        calls.push({ path, onProgress, signal, resolve, reject })
      }),
  )
  return { pull, calls }
}

/** Lets the microtask that settles a left read run. */
const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

/** The original <img> loads and decodes (jsdom does neither). */
function decode(name: string) {
  fireEvent.load(screen.getByRole('img', { name }))
}

/** The grid's previews, by photo id. */
function previewsOf(urls: Record<string, string>): PreviewSource {
  return {
    get: (r) => urls[r.id],
    load: () => Promise.resolve(undefined),
  }
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:original')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('facts as text', () => {
  it('formats dimensions, facts and types', () => {
    expect(fmtDimensions(4032, 3024)).toBe('4032 × 3024')
    expect(fmtDimensions(null, 3024)).toBeNull()
    expect(imageFacts(row(1))).toBe('4032 × 3024 · 2.9 MB')
    expect(imageFacts(row(1, { width: null, size: null }))).toBe('')
    expect(typeLabel('image/jpeg')).toBe('JPEG')
    expect(typeLabel('image/x-adobe-dng')).toBe('DNG')
    expect(typeLabel('')).toBe('Image')
  })

  it('dates a photo by when it was taken, else by its file time', () => {
    expect(imageWhen({ taken: 5, modified: 9 })).toEqual({ at: 5, source: 'taken' })
    expect(imageWhen({ taken: null, modified: 9 })).toEqual({ at: 9, source: 'modified' })
    expect(imageWhen({ taken: null, modified: null })).toEqual({ at: null, source: null })
  })

  it('keeps the phone’s file name for Save, minus what a computer refuses', () => {
    expect(saveName('PXL_20260930_030405.jpg', 'image/jpeg')).toBe('PXL_20260930_030405.jpg')
    expect(saveName('a/b:c?.png', 'image/png')).toBe('a_b_c_.png')
    expect(saveName('', 'image/jpeg')).toBe('image.jpg')
    expect(saveName('..', 'image/heic')).toBe('image.heic')
    expect(saveName('', '')).toBe('image.jpg')
  })

  it('lists every fact for every photo, Unknown where MediaStore did not say', () => {
    const labels = (r: ImageRow) => viewerFacts(r).map(([label]) => label)
    const bare = row(1, { taken: null, width: null, size: null, mime: '', folder: '' })
    expect(labels(bare)).toEqual(labels(row(1)))
    expect(Object.fromEntries(viewerFacts(bare))).toMatchObject({
      Taken: 'Unknown',
      Dimensions: 'Unknown',
      Size: 'Unknown',
      Type: 'Unknown',
      Folder: 'Unknown',
    })
  })

  it('reports progress with and without a known size', () => {
    expect(progressText(1024 * 1024, 4 * 1024 * 1024)).toBe('1.0 MB of 4.0 MB · 25%')
    expect(progressText(2048, 0)).toBe('2.0 KB')
  })
})

describe('clipboard and display', () => {
  it('puts PNG on the clipboard as it is, and redraws the rest as PNG', () => {
    const none = () => false
    expect(clipboardPlan('image/png', none)).toEqual({ type: 'image/png', convert: false })
    expect(clipboardPlan('image/jpeg', none)).toEqual({ type: 'image/png', convert: true })
    expect(clipboardPlan('image/jpeg', (t) => t === 'image/jpeg')).toEqual({
      type: 'image/jpeg',
      convert: false,
    })
    expect(clipboardPlan('image/webp', () => true)).toEqual({ type: 'image/png', convert: true })
  })

  it('draws HEIC only in Safari', () => {
    expect(canDisplay('image/jpeg', 'chrome')).toBe(true)
    expect(canDisplay('image/heic', 'chrome')).toBe(false)
    expect(canDisplay('image/heic', 'safari')).toBe(true)
    expect(canDisplay('image/x-adobe-dng', 'safari')).toBe(false)
  })

  it('walks the album with the arrow keys, Home and End', () => {
    expect(viewerStep('ArrowRight', 0, 3)).toBe(1)
    expect(viewerStep('ArrowRight', 2, 3)).toBeNull()
    expect(viewerStep('ArrowLeft', 0, 3)).toBeNull()
    expect(viewerStep('End', 0, 3)).toBe(2)
    expect(viewerStep('Home', 2, 3)).toBe(0)
    expect(viewerStep('ArrowDown', 1, 3)).toBeNull()
  })
})

describe('the frame', () => {
  const base = {
    canRead: true,
    displayable: true,
    original: 'loading' as const,
    drawn: false,
    broken: false,
    preview: true,
  }

  it('shows the preview under the progress, then the original over it until it is decoded', () => {
    expect(frameLayers(base)).toEqual({ overlay: 'progress', picture: 'preview' })
    expect(frameLayers({ ...base, preview: false })).toEqual({ overlay: 'progress', picture: null })
    expect(frameLayers({ ...base, original: 'ready' })).toEqual({ overlay: null, picture: 'both' })
    expect(frameLayers({ ...base, original: 'ready', drawn: true })).toEqual({
      overlay: null,
      picture: 'original',
    })
    expect(frameLayers({ ...base, original: 'ready', preview: false })).toEqual({
      overlay: 'spinner',
      picture: 'original',
    })
  })

  it('gives a note, never a picture, when there is a reason for none', () => {
    const note = { overlay: 'note', picture: null }
    expect(frameLayers({ ...base, canRead: false })).toEqual(note)
    expect(frameLayers({ ...base, original: 'failed' })).toEqual(note)
    expect(frameLayers({ ...base, displayable: false, original: 'idle' })).toEqual(note)
    expect(frameLayers({ ...base, original: 'ready', broken: true })).toEqual(note)
    // Save reading a HEIC photo: its progress, and no preview the browser can't draw anyway.
    expect(frameLayers({ ...base, displayable: false })).toEqual({
      overlay: 'progress',
      picture: null,
    })
  })

  it('reads ahead only what leaves the photos on screen in memory', () => {
    const MB = 1024 * 1024
    expect(fitsAhead(10 * MB, 50 * MB, 96 * MB)).toBe(true)
    expect(fitsAhead(50 * MB, 50 * MB, 96 * MB)).toBe(false)
    expect(fitsAhead(null, 90 * MB, 96 * MB)).toBe(true)
  })
})

describe('readOriginal', () => {
  const source = (n: number, pull: Pull) => ({
    key: originalKey('SERIAL1', row(n)),
    deviceId: 'SERIAL1',
    row: row(n),
    pull,
  })

  it('shares one read between everyone who asks, with progress for each', async () => {
    const { pull, calls } = manualPull()
    const a = vi.fn()
    const b = vi.fn()
    const first = readOriginal(source(500, pull), a, new AbortController().signal)
    const second = readOriginal(source(500, pull), b, new AbortController().signal)
    expect(pull).toHaveBeenCalledTimes(1)
    calls[0]?.onProgress(10, 0)
    expect(a).toHaveBeenCalledWith(10, 3_000_000)
    expect(b).toHaveBeenCalledWith(10, 3_000_000)
    calls[0]?.resolve(new Blob(['x']))
    const [one, two] = await Promise.all([first, second])
    expect(one).toBe(two)
    // MediaStore's type, for Save's name.
    expect(one.type).toBe('image/jpeg')
    // Kept: the next ask doesn't read the phone.
    await readOriginal(source(500, pull), () => undefined, new AbortController().signal)
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('stops the read once everyone has left, and not while someone is still there', async () => {
    const { pull, calls } = manualPull()
    const a = new AbortController()
    const b = new AbortController()
    const first = readOriginal(source(501, pull), () => undefined, a.signal)
    const second = readOriginal(source(501, pull), () => undefined, b.signal)
    a.abort()
    await expect(first).rejects.toBeDefined()
    await Promise.resolve()
    expect(calls[0]?.signal.aborted).toBe(false)
    b.abort()
    await expect(second).rejects.toBeDefined()
    await Promise.resolve()
    expect(calls[0]?.signal.aborted).toBe(true)
  })

  it('hands a read over to whoever joins in the same tick as the last one leaves', async () => {
    const { pull, calls } = manualPull()
    const ahead = new AbortController()
    void readOriginal(source(502, pull), () => undefined, ahead.signal).catch(() => undefined)
    // The viewer steps onto the photo it was reading ahead: it joins, then the read ahead goes.
    const viewing = readOriginal(source(502, pull), () => undefined, new AbortController().signal)
    ahead.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls[0]?.signal.aborted).toBe(false)
    calls[0]?.resolve(new Blob(['x']))
    await expect(viewing).resolves.toBeInstanceOf(Blob)
    expect(pull).toHaveBeenCalledTimes(1)
  })
})

describe('ImageViewer', () => {
  const props = {
    device: DEVICE,
    hasMore: false,
    onIndex: () => undefined,
    onLoadMore: () => Promise.resolve(false),
    onClose: () => undefined,
  }

  it('reads the original with progress, then shows it with its facts', async () => {
    const { pull, calls } = manualPull()
    render(<ImageViewer {...props} backend={lane(pull)} rows={[row(1)]} index={0} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('photo-1.jpg')
    expect(screen.getByText('Reading from Pixel 9')).toBeInTheDocument()
    expect(screen.getByText('Starting…')).toBeInTheDocument()
    expect(calls[0]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-1.jpg')

    act(() => {
      calls[0]?.onProgress(1024 * 1024, 4 * 1024 * 1024)
    })
    expect(screen.getByText('1.0 MB of 4.0 MB · 25%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')

    await act(async () => {
      calls[0]?.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    const img = await screen.findByRole('img', { name: 'photo-1.jpg' })
    expect(img).toHaveAttribute('src', 'blob:original')
    // Hidden until decoded, then shown where it is, at its own size at most.
    expect(img).toHaveClass('opacity-0', 'object-scale-down')
    decode('photo-1.jpg')
    await waitFor(() => {
      expect(img).not.toHaveClass('opacity-0')
    })
    expect(screen.getByText('DCIM/Camera/')).toBeInTheDocument()
    expect(screen.getByText('4032 × 3024')).toBeInTheDocument()
  })

  it('cancels the read when the viewer closes', async () => {
    const { pull, calls } = manualPull()
    const onClose = vi.fn()
    render(
      <ImageViewer {...props} backend={lane(pull)} rows={[row(2)]} index={0} onClose={onClose} />,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    cleanup()
    await settle()
    expect(calls[0]?.signal.aborted).toBe(true)
  })

  it('says what went wrong, and Retry reads again', async () => {
    const { pull, calls } = manualPull()
    render(<ImageViewer {...props} backend={lane(pull)} rows={[row(3)]} index={0} />)
    await act(async () => {
      calls[0]?.reject(new Error('FILE_READ_FAILED'))
      await Promise.resolve()
    })
    expect(
      await screen.findByText(
        'Couldn’t read the image from Pixel 9: The phone didn’t let Device Lab read that file.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(pull).toHaveBeenCalledTimes(2)
  })

  /** Photo `n`'s reads over USB, in the order they were asked for. */
  const readsOf = (calls: ReturnType<typeof manualPull>['calls'], n: number) =>
    calls.filter((c) => c.path === `/storage/emulated/0/DCIM/Camera/photo-${String(n)}.jpg`)

  it('stops a retried read when the user steps away: Retry is the photo’s own read', async () => {
    const { pull, calls } = manualPull()
    const rows = [row(90), row(91)]
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} />
    )
    const { rerender } = render(view(0))
    await act(async () => {
      readsOf(calls, 90)[0]?.reject(new Error('FILE_READ_FAILED'))
      await Promise.resolve()
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    const retried = readsOf(calls, 90)[1]
    expect(retried).toBeDefined()

    rerender(view(1))
    await settle()
    expect(retried?.signal.aborted).toBe(true)
  })

  it('keeps a Save going when the user steps away: it was asked for', async () => {
    const { pull, calls } = manualPull()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const rows = [row(92), row(93)]
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} />
    )
    const { rerender } = render(view(0))
    await act(async () => {
      readsOf(calls, 92)[0]?.reject(new Error('FILE_READ_FAILED'))
      await Promise.resolve()
    })
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    const saving = readsOf(calls, 92)[1]
    expect(saving).toBeDefined()

    rerender(view(1))
    await settle()
    expect(saving?.signal.aborted).toBe(false)
    await act(async () => {
      saving?.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1)
    })
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('photo-92.jpg')
  })

  it('doesn’t read a HEIC photo until Save asks, then saves the original', async () => {
    const pull = vi.fn<Pull>(() => Promise.resolve(new Blob(['heic'], { type: 'image/heic' })))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={[row(4, { name: 'IMG_0004.HEIC', mime: 'image/heic' })]}
        index={0}
      />,
    )
    expect(
      screen.getByText('This browser can’t show HEIC images. Save it to open it on this computer.'),
    ).toBeInTheDocument()
    expect(pull).not.toHaveBeenCalled()
    // One Save: the note's own is the toolbar's.
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1)
    })
    expect(pull).toHaveBeenCalledTimes(1)
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('IMG_0004.HEIC')
  })

  it('moves with the arrow keys, and loads the next page at the end', async () => {
    const { pull } = manualPull()
    const onIndex = vi.fn()
    const onLoadMore = vi.fn(() => Promise.resolve(true))
    const rows = [row(5), row(6)]
    const { rerender } = render(
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={rows}
        index={0}
        hasMore
        onIndex={onIndex}
        onLoadMore={onLoadMore}
      />,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    expect(onIndex).toHaveBeenLastCalledWith(1)
    rerender(
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={rows}
        index={1}
        hasMore
        onIndex={onIndex}
        onLoadMore={onLoadMore}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('2 of 2+')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
    expect(onIndex).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(onIndex).toHaveBeenLastCalledWith(2)
    })
  })

  it('steps without remaking the body: focus stays on → and the last read is cancelled', async () => {
    const { pull, calls } = manualPull()
    const rows = [row(10), row(11), row(12)]
    const onIndex = vi.fn()
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} onIndex={onIndex} />
    )
    const { rerender } = render(view(0))
    const next = screen.getByRole('button', { name: 'Next image (→)' })
    const frame = document.querySelector('[data-slot="image-frame"]')
    next.focus()
    fireEvent.click(next)
    expect(onIndex).toHaveBeenLastCalledWith(1)
    rerender(view(1))
    // The same button, still focused; the same frame.
    expect(screen.getByRole('button', { name: 'Next image (→)' })).toBe(next)
    expect(next).toHaveFocus()
    expect(document.querySelector('[data-slot="image-frame"]')).toBe(frame)
    // Said, since focus didn't move: the dialog's polite status line.
    expect(screen.getByText('photo-11.jpg, 2 of 3')).toHaveAttribute('aria-live', 'polite')
    await settle()
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(calls[1]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-11.jpg')
    // The arrow keys still work from the button.
    fireEvent.keyDown(next, { key: 'ArrowRight' })
    expect(onIndex).toHaveBeenLastCalledWith(2)
  })

  it('shows the grid’s preview while the original is read, and the original once decoded', async () => {
    const { pull, calls } = manualPull()
    const { container } = render(
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={[row(20, { width: 300, height: 200 })]}
        index={0}
        previews={previewsOf({ '20': 'blob:preview-20' })}
      />,
    )
    const preview = () => document.querySelector('img[src="blob:preview-20"]')
    expect(preview()).not.toBeNull()
    // Where the original will land: never larger than the original is.
    expect(preview()).toHaveStyle({ maxWidth: '300px', maxHeight: '200px' })
    expect(screen.getByText('Reading from Pixel 9')).toBeInTheDocument()

    await act(async () => {
      calls[0]?.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    // Read but not yet decoded: both, the preview still the one seen.
    expect(preview()).not.toBeNull()
    expect(screen.queryByText('Reading from Pixel 9')).not.toBeInTheDocument()
    decode('photo-20.jpg')
    await waitFor(() => {
      expect(preview()).toBeNull()
    })
    expect(container.ownerDocument.querySelectorAll('[data-slot="image-frame"] img')).toHaveLength(
      1,
    )
  })

  it('fetches a preview the grid doesn’t have yet', async () => {
    const { pull } = manualPull()
    const load = vi.fn(() => Promise.resolve('blob:preview-25'))
    render(
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={[row(25)]}
        index={0}
        previews={{ get: () => undefined, load }}
      />,
    )
    await waitFor(() => {
      expect(document.querySelector('img[src="blob:preview-25"]')).not.toBeNull()
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reads the photo ahead once this one is shown, and stepping onto it reads nothing more', async () => {
    const { pull, calls } = manualPull()
    const rows = [row(30), row(31), row(32)]
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} />
    )
    const { rerender } = render(view(0))
    expect(pull).toHaveBeenCalledTimes(1)
    await act(async () => {
      calls[0]?.resolve(new Blob(['a'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    // Not before it is shown: the cable is this photo's first.
    expect(pull).toHaveBeenCalledTimes(1)
    decode('photo-30.jpg')
    await waitFor(() => {
      expect(pull).toHaveBeenCalledTimes(2)
    })
    expect(calls[1]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-31.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Next image (→)' }))
    rerender(view(1))
    await settle()
    // The read ahead became this photo's read: not cancelled, not started again.
    expect(calls[1]?.signal.aborted).toBe(false)
    expect(pull).toHaveBeenCalledTimes(2)
    act(() => {
      calls[1]?.onProgress(1_500_000, 3_000_000)
    })
    expect(await screen.findByText('1.4 MB of 2.9 MB · 50%')).toBeInTheDocument()
  })

  it('cancels a read ahead the user walks away from', async () => {
    const { pull, calls } = manualPull()
    const rows = [row(40), row(41), row(42)]
    const onIndex = vi.fn()
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} onIndex={onIndex} />
    )
    const { rerender } = render(view(1))
    await act(async () => {
      calls[0]?.resolve(new Blob(['b'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    decode('photo-41.jpg')
    await waitFor(() => {
      expect(calls[1]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-42.jpg')
    })
    // ← instead: the photo ahead is now the other way.
    fireEvent.click(screen.getByRole('button', { name: 'Previous image (←)' }))
    expect(onIndex).toHaveBeenLastCalledWith(0)
    rerender(view(0))
    await settle()
    expect(calls[1]?.signal.aborted).toBe(true)
    expect(calls[2]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-40.jpg')
  })

  it('keeps HEIC’s note, in the frame, and reads nothing ahead it can’t draw', async () => {
    const { pull, calls } = manualPull()
    const rows = [row(50), row(51, { name: 'IMG_0051.HEIC', mime: 'image/heic' })]
    const { rerender } = render(
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={0} />,
    )
    await act(async () => {
      calls[0]?.resolve(new Blob(['c'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    decode('photo-50.jpg')
    await settle()
    expect(pull).toHaveBeenCalledTimes(1)
    rerender(<ImageViewer {...props} backend={lane(pull)} rows={rows} index={1} />)
    const frame = document.querySelector('[data-slot="image-frame"]')
    expect(frame).toHaveTextContent(
      'This browser can’t show HEIC images. Save it to open it on this computer.',
    )
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('stops the preview read for a photo ahead once the user walks past it', async () => {
    const { pull } = manualPull()
    const asked: { id: string; signal: AbortSignal }[] = []
    const load = vi.fn((r: ImageRow, signal: AbortSignal) => {
      asked.push({ id: r.id, signal })
      return new Promise<string | undefined>(() => undefined)
    })
    const rows = [row(60), row(61), row(62), row(63), row(64)]
    const view = (index: number | null) => (
      <ImageViewer
        {...props}
        backend={lane(pull)}
        rows={rows}
        index={index}
        previews={{ get: () => undefined, load }}
      />
    )
    const { rerender } = render(view(0))
    const signalsFor = (id: string) => asked.filter((a) => a.id === id).map((a) => a.signal)
    expect(signalsFor('61')).toHaveLength(1)

    // Onto the photo ahead: its preview read carries on as this photo's.
    fireEvent.click(screen.getByRole('button', { name: 'Next image (→)' }))
    rerender(view(1))
    expect(signalsFor('61').every((s) => !s.aborted)).toBe(true)
    expect(signalsFor('62')).toHaveLength(1)

    // Two more steps: 61 and 62 are walked past, so nothing waits on them any more.
    rerender(view(2))
    rerender(view(3))
    expect(signalsFor('61').every((s) => s.aborted)).toBe(true)
    expect(signalsFor('62').every((s) => s.aborted)).toBe(true)
    // This photo and the one ahead are still wanted.
    expect(signalsFor('63').some((s) => !s.aborted)).toBe(true)
    expect(signalsFor('64').every((s) => !s.aborted)).toBe(true)

    rerender(view(null))
    await settle()
    expect(asked.every((a) => a.signal.aborted)).toBe(true)
  })

  it('starts each photo’s progress bar afresh instead of sliding it from the last one', () => {
    const { pull, calls } = manualPull()
    const rows = [row(70), row(71)]
    const view = (index: number) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} />
    )
    const { rerender } = render(view(0))
    act(() => {
      calls[0]?.onProgress(600_000, 3_000_000)
    })
    const bar = () => document.querySelector<HTMLElement>('[data-slot="read-progress-bar"]')
    const first = bar()
    expect(first).toHaveStyle({ width: '20%' })
    rerender(view(1))
    // A new element, so its width has nothing to ease from.
    expect(bar()).not.toBe(first)
    expect(bar()).toHaveStyle({ width: '0%' })
  })

  it('fades out with the last photo in it, and stops reading as soon as it starts closing', async () => {
    // Radix keeps the dialog while its exit animation runs; jsdom runs none, so say there is one.
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = computed(el, pseudo)
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'animationName') {
            return el.getAttribute('data-state') === 'closed' ? 'exit' : 'enter'
          }
          const value: unknown = Reflect.get(target, prop)
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value
        },
      })
    })
    const { pull, calls } = manualPull()
    const rows = [row(80), row(81)]
    const view = (index: number | null) => (
      <ImageViewer {...props} backend={lane(pull)} rows={rows} index={index} />
    )
    const { rerender } = render(view(1))
    rerender(view(null))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(dialog).toHaveAttribute('data-state', 'closed')
    // Still the photo, its frame and its buttons: never an empty panel.
    expect(dialog).toHaveTextContent('photo-81.jpg')
    expect(dialog).toHaveTextContent('2 of 2')
    expect(dialog.querySelector('[data-slot="image-frame"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next image (→)', hidden: true })).toBeInTheDocument()
    await settle()
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('stays closed without an index', () => {
    render(<ImageViewer {...props} backend={lane()} rows={[row(7)]} index={null} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
