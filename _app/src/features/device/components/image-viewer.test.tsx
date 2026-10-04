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
  fmtDimensions,
  imageFacts,
  imageWhen,
  progressText,
  saveName,
  typeLabel,
  viewerStep,
} from './image-viewer'

/*
  The viewer over a scripted lane: the original is read when a photo opens (with progress, and
  cancelled by closing), HEIC is only read when Save asks, and the arrow keys walk the album,
  loading the next page at its end. Every name here is made up.
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
    expect(screen.getByText('Reading from Pixel 9…')).toBeInTheDocument()
    expect(calls[0]?.path).toBe('/storage/emulated/0/DCIM/Camera/photo-1.jpg')

    act(() => {
      calls[0]?.onProgress(1024 * 1024, 4 * 1024 * 1024)
    })
    expect(screen.getByText('Reading from Pixel 9 · 1.0 MB of 4.0 MB · 25%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')

    await act(async () => {
      calls[0]?.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      await Promise.resolve()
    })
    expect(await screen.findByRole('img', { name: 'photo-1.jpg' })).toHaveAttribute(
      'src',
      'blob:original',
    )
    expect(screen.getByText('DCIM/Camera/')).toBeInTheDocument()
    expect(screen.getByText('4032 × 3024')).toBeInTheDocument()
  })

  it('cancels the read when the viewer closes', () => {
    const { pull, calls } = manualPull()
    const onClose = vi.fn()
    render(
      <ImageViewer {...props} backend={lane(pull)} rows={[row(2)]} index={0} onClose={onClose} />,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    cleanup()
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

  it('stays closed without an index', () => {
    render(<ImageViewer {...props} backend={lane()} rows={[row(7)]} index={null} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
