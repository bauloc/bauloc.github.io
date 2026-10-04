// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Shot } from '../store'
import {
  COPY_CAP,
  Screenshots,
  TooBigError,
  copiedText,
  failedText,
  nextScale,
  scaledSize,
  searchScale,
  shrinkForClipboard,
  sizeText,
  type Raster,
} from './screenshots'

/*
  The Screenshots card: its own Take Screenshot, and a copy menu of the PNG as captured or one
  scaled down to at most a million bytes. The size search runs on an injected encoder, so its
  numbers are exact here; headless Chrome checks the real canvas and clipboard.
*/

const toast = vi.hoisted(() => ({
  // Like sonner, every toast call hands back its toast's id.
  success: vi.fn<(title: string, options?: object) => string>(() => 'result-toast'),
  error: vi.fn<(title: string, options?: object) => string>(() => 'result-toast'),
  loading: vi.fn(() => 'loading-toast'),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

/** A blob of exactly `size` bytes. */
const bytes = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/png' })

/** A Pixel 9 screenshot. */
const PIXEL = { width: 1080, height: 2424 }

/**
 * A raster whose PNG costs `perPixel` bytes a pixel, times `wobble(width)` for encoders whose
 * bytes are not quite proportional. Records every size asked for.
 */
function fakeRaster(perPixel: number, wobble: (width: number) => number = () => 1) {
  const calls: { width: number; height: number }[] = []
  const raster: Raster = {
    ...PIXEL,
    encode: (width, height) => {
      calls.push({ width, height })
      return Promise.resolve(bytes(Math.round(width * height * perPixel * wobble(width))))
    },
  }
  return { raster, calls }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('scaledSize', () => {
  it('rounds to whole pixels and never under one', () => {
    expect(scaledSize(1080, 2424, 0.5)).toEqual({ width: 540, height: 1212 })
    expect(scaledSize(1080, 2424, 0.6175)).toEqual({ width: 667, height: 1497 })
    expect(scaledSize(1080, 2424, 0.0001)).toEqual({ width: 1, height: 1 })
  })
})

describe('nextScale', () => {
  it('estimates from the bytes, which grow with the scale squared', () => {
    // 4 MB at full size → a quarter of the pixels, a little under, lands near the cap.
    const s = nextScale({ scale: 1, size: 4 * COPY_CAP }, 0, 1, COPY_CAP)
    expect(s).toBeCloseTo(0.5 * Math.sqrt(0.97), 6)
  })

  it('halves the bracket when the estimate leaves it', () => {
    // A fit at 0.4 that says "go to 0.9", with 0.6 known too big: the estimate is off.
    expect(nextScale({ scale: 0.4, size: 0.2 * COPY_CAP }, 0.4, 0.6, COPY_CAP)).toBeCloseTo(0.5)
    // Nothing fits yet and the estimate is past the smallest too-big scale.
    expect(nextScale({ scale: 0.5, size: 0.9 * COPY_CAP }, 0, 0.5, COPY_CAP)).toBe(0.25)
  })
})

describe('searchScale', () => {
  it('fits a 2.4 MB screenshot under the cap in one encode, aspect kept', async () => {
    const { raster, calls } = fakeRaster(0.9)
    const fit = await searchScale(raster, Math.round(PIXEL.width * PIXEL.height * 0.9))
    expect(fit.blob.size).toBeLessThanOrEqual(COPY_CAP)
    expect(fit.blob.size).toBeGreaterThanOrEqual(COPY_CAP * 0.9)
    expect(calls).toHaveLength(1)
    expect(fit.original).toBe(false)
    const { width, height } = fit
    expect(width).not.toBeNull()
    expect(height).not.toBeNull()
    expect(Math.abs((width ?? 0) / PIXEL.width - (height ?? 0) / PIXEL.height)).toBeLessThan(0.002)
  })

  it('refines when the browser encodes worse than the device did', async () => {
    // The device's PNG was 1.6 MB, but the canvas writes 1.5 times the bytes per pixel.
    const { raster, calls } = fakeRaster((1.5 * (1.6 * COPY_CAP)) / (PIXEL.width * PIXEL.height))
    const fit = await searchScale(raster, 1.6 * COPY_CAP)
    expect(fit.blob.size).toBeLessThanOrEqual(COPY_CAP)
    expect(fit.blob.size).toBeGreaterThanOrEqual(COPY_CAP * 0.9)
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it('refines upward when the first guess fits with room to spare', async () => {
    // The canvas compresses far better than the device: the first guess is well under.
    const { raster, calls } = fakeRaster(0.4)
    const fit = await searchScale(raster, 3 * COPY_CAP)
    expect(calls).toHaveLength(2)
    expect(fit.blob.size).toBeLessThanOrEqual(COPY_CAP)
    expect(fit.blob.size).toBeGreaterThanOrEqual(COPY_CAP * 0.9)
  })

  it('keeps every pixel when the browser’s PNG of the full size already fits', async () => {
    const { raster, calls } = fakeRaster(0.25)
    const fit = await searchScale(raster, 3 * COPY_CAP)
    expect(fit).toMatchObject({ ...PIXEL, scale: 1, original: false })
    expect(fit.blob.size).toBeLessThanOrEqual(COPY_CAP)
    expect(calls).toHaveLength(2)
  })

  it('stays under the cap on an encoder whose bytes wobble, within the try budget', async () => {
    const wobble = (width: number) => 0.85 + ((width * 7919) % 31) / 100
    const { raster, calls } = fakeRaster(1.2, wobble)
    const fit = await searchScale(raster, 3.2 * COPY_CAP)
    expect(fit.blob.size).toBeLessThanOrEqual(COPY_CAP)
    expect(calls.length).toBeLessThanOrEqual(6)
    expect(new Set(calls.map((c) => c.width)).size).toBe(calls.length)
  })

  it('never upscales', async () => {
    const { raster, calls } = fakeRaster(0.01)
    const fit = await searchScale(raster, COPY_CAP + 1)
    for (const call of calls) expect(call.width).toBeLessThanOrEqual(PIXEL.width)
    expect(fit.width).toBeLessThanOrEqual(PIXEL.width)
  })

  it('gives up with how close it got, and never goes below a readable size', async () => {
    const calls: number[] = []
    const stubborn: Raster = {
      ...PIXEL,
      encode: (width, height) => {
        calls.push(Math.max(width, height))
        return Promise.resolve(bytes(2 * COPY_CAP))
      },
    }
    const failure = searchScale(stubborn, 3 * COPY_CAP)
    await expect(failure).rejects.toBeInstanceOf(TooBigError)
    await expect(failure).rejects.toThrow(/^Even at 143 × 320 px it was 1\.9 MB\.$/)
    expect(Math.min(...calls)).toBe(320)
    expect(calls.length).toBeLessThanOrEqual(6)
  })
})

describe('shrinkForClipboard', () => {
  it('hands back the original, undecoded, when it is already under the cap', async () => {
    const decode = vi.fn()
    const blob = bytes(COPY_CAP)
    const shrunk = await shrinkForClipboard(blob, COPY_CAP, decode)
    expect(shrunk.blob).toBe(blob)
    expect(shrunk.original).toBe(true)
    expect(decode).not.toHaveBeenCalled()
  })

  it('decodes once, closes the bitmap, and serves a second copy from the cache', async () => {
    const close = vi.fn()
    const { raster } = fakeRaster(0.9)
    const decode = vi.fn(() => Promise.resolve({ ...raster, close }))
    const blob = bytes(2.4 * COPY_CAP)
    const first = await shrinkForClipboard(blob, COPY_CAP, decode)
    const second = await shrinkForClipboard(blob, COPY_CAP, decode)
    expect(second).toBe(first)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('forgets a failure, so the next copy tries again', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('The source image could not be decoded')))
    const blob = bytes(2 * COPY_CAP)
    await expect(shrinkForClipboard(blob, COPY_CAP, decode)).rejects.toThrow(/decoded/)
    await expect(shrinkForClipboard(blob, COPY_CAP, decode)).rejects.toThrow(/decoded/)
    expect(decode).toHaveBeenCalledTimes(2)
  })
})

describe('sizeText', () => {
  it('uses the page’s units, except where they would hide that a PNG is over the cap', () => {
    expect(sizeText(584_702)).toBe('571 KB')
    expect(sizeText(COPY_CAP)).toBe('977 KB')
    // Over a million bytes, yet "996 KB" or "1.0 MB" would read as already under 1 MB.
    expect(sizeText(1_020_000)).toBe('1,020,000 bytes')
    expect(sizeText(1_048_576)).toBe('1,048,576 bytes')
    expect(sizeText(1_200_000)).toBe('1.1 MB')
    expect(sizeText(2_300_000)).toBe('2.2 MB')
  })
})

describe('copiedText', () => {
  it('says which copy went on the clipboard and its size', () => {
    const original = { blob: bytes(2_300_000), original: true, width: null, height: null, scale: 1 }
    expect(copiedText('original', original, 2_300_000)).toEqual({
      title: 'Copied original · 2.2 MB',
      description: 'The PNG as captured.',
    })
    const small = { blob: bytes(976_000), original: false, width: 642, height: 1441, scale: 0.59 }
    expect(copiedText('small', small, 2_300_000)).toEqual({
      title: 'Copied ≤ 1 MB · 953 KB',
      description: 'Scaled down to 642 × 1441 px from 2.2 MB.',
    })
    const full = { blob: bytes(990_000), original: false, ...PIXEL, scale: 1 }
    expect(copiedText('small', full, 1_200_000).description).toBe(
      'Full size, 1080 × 2424 px, re-compressed from 1.1 MB.',
    )
    const near = { blob: bytes(980_000), original: false, width: 1058, height: 2375, scale: 0.98 }
    expect(copiedText('small', near, 1_020_000).description).toBe(
      'Scaled down to 1058 × 2375 px from 1,020,000 bytes.',
    )
    const under = { blob: bytes(584_702), original: true, width: null, height: null, scale: 1 }
    expect(copiedText('small', under, 584_702)).toEqual({
      title: 'Copied ≤ 1 MB · 571 KB',
      description: 'Already under 1 MB, so this is the original.',
    })
  })
})

describe('failedText', () => {
  it('puts the search’s own reason before the clipboard’s', () => {
    expect(
      failedText('small', new TooBigError('Even at 143 × 320 px it was 1.9 MB.'), null),
    ).toEqual({
      title: 'Couldn’t get it under 1 MB',
      description: 'Even at 143 × 320 px it was 1.9 MB. Use Copy original or Save instead.',
    })
    expect(failedText('small', new Error('Canvas is unavailable'), null)).toEqual({
      title: 'Couldn’t shrink the screenshot',
      description: 'Canvas is unavailable. Use Copy original or Save instead.',
    })
    // Chrome's own message ends in a full stop: not two.
    expect(
      failedText('small', new DOMException('The source image could not be decoded.'), null)
        .description,
    ).toBe('The source image could not be decoded. Use Copy original or Save instead.')
    expect(failedText('original', null, new DOMException('Document is not focused.'))).toEqual({
      title: 'Copy image failed',
      description: 'Document is not focused.',
    })
  })
})

const shot = (size: number): Shot => ({
  id: 'shot_1',
  deviceId: 'pixel',
  deviceName: 'Pixel 9',
  blob: bytes(size),
  url: 'blob:shot-1',
  at: new Date(2026, 9, 4, 14, 5, 9),
  fileName: 'pixel-9_2026-10-04T14-05-09+07-00.png',
  black: false,
})

function renderCard(over: Partial<Parameters<typeof Screenshots>[0]> = {}) {
  const props = {
    shots: [shot(584_702)],
    zoom: 160,
    capturing: false,
    canCapture: true,
    onCapture: vi.fn(),
    onZoom: vi.fn(),
    onClear: vi.fn(),
    ...over,
  }
  render(<Screenshots {...props} />)
  return props
}

describe('Screenshots: Take Screenshot', () => {
  it('takes one, with the S shortcut announced', () => {
    const { onCapture } = renderCard()
    const button = screen.getByRole('button', { name: 'Take Screenshot' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'S')
    fireEvent.click(button)
    expect(onCapture).toHaveBeenCalledTimes(1)
  })

  it('ignores presses while one is in flight, and keeps focus', () => {
    const { onCapture } = renderCard({ capturing: true })
    const button = screen.getByRole('button', { name: 'Take Screenshot' })
    button.focus()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onCapture).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  it('is off when the device cannot take screenshots, and says why', () => {
    // aria-disabled, as the header's button: focusable, so its reason can be read.
    const props = renderCard({
      canCapture: false,
      captureTitle: 'Screenshots are unavailable for this device — see the note above.',
    })
    const button = screen.getByRole('button', { name: 'Take Screenshot' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute(
      'title',
      'Screenshots are unavailable for this device — see the note above.',
    )
    fireEvent.click(button)
    expect(props.onCapture).not.toHaveBeenCalled()
  })
})

/** A promise to settle by hand, to order the slow parts of a copy. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * The browser's canvas, encoding 0.9 bytes a pixel, and its decoder: `bitmap` decides when the
 * screenshot has been decoded. Returns the widths drawn and a restore.
 */
function stubCanvas(
  bitmap: () => Promise<unknown> = () => Promise.resolve({ ...PIXEL, close: vi.fn() }),
) {
  const drawn: number[] = []
  vi.stubGlobal('createImageBitmap', vi.fn(bitmap))
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      drawn.push(this.width)
      return { drawImage: vi.fn(), imageSmoothingQuality: 'low' } as never
    })
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done,
  ) {
    done(bytes(Math.round(this.width * this.height * 0.9)))
  })
  return {
    drawn,
    restore: () => {
      getContext.mockRestore()
      toBlob.mockRestore()
    },
  }
}

describe('Screenshots: the copy menu', () => {
  const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>()
  /** What the fake clipboard holds: the last image whose write went through. */
  let clipboard: Blob | null = null
  class FakeClipboardItem {
    readonly items: Record<string, Promise<Blob>>
    constructor(items: Record<string, Promise<Blob>>) {
      this.items = items
    }
  }

  beforeAll(() => {
    // Radix's popper measures itself; jsdom has no ResizeObserver.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  beforeEach(() => {
    write.mockReset()
    clipboard = null
    write.mockImplementation(async (items) => {
      // Like the browser: the write waits for the item's promise, and fails if it rejects.
      const [item] = items as unknown as FakeClipboardItem[]
      const png = (await item?.items['image/png']) ?? null
      // And like Chrome, which decodes and re-encodes what it is given, a bigger PNG lands later.
      await new Promise((done) => setTimeout(done, (png?.size ?? 0) / 20_000))
      clipboard = png
    })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Opens the tile's menu from the keyboard, the way a screen reader user would. */
  function openMenu() {
    const trigger = screen.getByRole('button', { name: 'Copy image' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    return trigger
  }

  /** The PNG promise handed to the last ClipboardItem. */
  const written = () => {
    const [item] = write.mock.calls[0]?.[0] as unknown as FakeClipboardItem[]
    const png = item?.items['image/png']
    if (!png) throw new Error('nothing written')
    return png
  }

  it('offers the original with its size, and the copy under 1 MB', () => {
    renderCard({ shots: [shot(2_300_000)] })
    openMenu()
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'Copy original2.2 MB',
      'Copy ≤ 1 MBsmaller copy',
    ])
  })

  it('shows the exact bytes of an original just over the cap', () => {
    renderCard({ shots: [shot(1_020_000)] })
    openMenu()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Copy original1,020,000 bytes',
      'Copy ≤ 1 MBsmaller copy',
    ])
  })

  it('closes on Escape and gives focus back to the copy button', async () => {
    renderCard()
    const trigger = openMenu()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Copy original/ }), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })

  it('copies the original in the click itself, then says so', async () => {
    renderCard({ shots: [shot(2_300_000)] })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy original/ }))
    // Synchronously, so Safari keeps the user gesture.
    expect(write).toHaveBeenCalledTimes(1)
    expect((await written()).size).toBe(2_300_000)
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Copied original · 2.2 MB', {
        id: undefined,
        description: 'The PNG as captured.',
      })
    })
    expect(toast.loading).not.toHaveBeenCalled()
  })

  it('returns focus to the copy button when the menu closes', async () => {
    renderCard()
    const trigger = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy original/ }))
    await waitFor(() => {
      expect(trigger).toHaveFocus()
    })
  })

  it('scales a big screenshot under the cap, writing a promise straight away', async () => {
    const { drawn, restore } = stubCanvas()
    try {
      renderCard({ shots: [shot(2_356_000)] })
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy ≤ 1 MB/ }))
      expect(write).toHaveBeenCalledTimes(1)
      expect(toast.loading).toHaveBeenCalledWith('Shrinking the screenshot under 1 MB…')
      const png = await act(() => written())
      expect(png.size).toBeLessThanOrEqual(COPY_CAP)
      expect(Math.max(...drawn)).toBeLessThan(PIXEL.width)
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringMatching(/^Copied ≤ 1 MB · \d+ KB$/),
          {
            id: 'loading-toast',
            description: expect.stringMatching(/^Scaled down to \d+ × \d+ px from 2\.2 MB\.$/),
          },
        )
      })
    } finally {
      restore()
    }
  })

  it('leaves the original on the clipboard when it was picked while the shrink ran', async () => {
    const decoded = deferred<unknown>()
    const { restore } = stubCanvas(() => decoded.promise)
    try {
      const big = shot(2_300_000)
      renderCard({ shots: [big] })
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy ≤ 1 MB/ }))
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy original/ }))
      expect(write).toHaveBeenCalledTimes(2)
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Copied original · 2.2 MB', {
          id: undefined,
          description: 'The PNG as captured.',
        })
      })
      // The shrink only finishes now, long after: it must not land on top.
      await act(async () => {
        decoded.resolve({ ...PIXEL, close: vi.fn() })
        await new Promise((done) => setTimeout(done, 0))
      })
      expect(clipboard).toBe(big.blob)
      // Its "Shrinking…" toast goes quietly: no error, no second success.
      expect(toast.dismiss).toHaveBeenCalledWith('loading-toast')
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('lands the newer copy last even when the older one takes longer to land', async () => {
    const { restore } = stubCanvas()
    try {
      const big = shot(2_300_000)
      renderCard({ shots: [big] })
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy original/ }))
      // A second click is a later task: the original has been handed to the clipboard by then.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0))
      })
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy ≤ 1 MB/ }))
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledTimes(2)
      })
      expect(toast.success.mock.calls.map(([title]) => title)).toEqual([
        'Copied original · 2.2 MB',
        expect.stringMatching(/^Copied ≤ 1 MB · \d+ KB$/),
      ])
      expect(clipboard).not.toBe(big.blob)
      expect(clipboard?.size).toBeLessThanOrEqual(COPY_CAP)
      // Its "Shrinking…" toast is behind the original's by then: the result comes in front.
      expect(toast.dismiss).toHaveBeenCalledWith('loading-toast')
      expect(toast.success).toHaveBeenLastCalledWith(expect.stringMatching(/^Copied ≤ 1 MB/), {
        id: undefined,
        description: expect.stringMatching(/^Scaled down to/),
      })
    } finally {
      restore()
    }
  })

  it('copies the original as the ≤ 1 MB copy when it is already under', async () => {
    renderCard()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy ≤ 1 MB/ }))
    expect((await written()).size).toBe(584_702)
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Copied ≤ 1 MB · 571 KB', {
        id: undefined,
        description: 'Already under 1 MB, so this is the original.',
      })
    })
  })

  it('says why when the shrink fails', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('The source image could not be decoded'))),
    )
    renderCard({ shots: [shot(3_000_000)] })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy ≤ 1 MB/ }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Couldn’t shrink the screenshot', {
        id: 'loading-toast',
        description: 'The source image could not be decoded. Use Copy original or Save instead.',
      })
    })
  })

  it('points to Save where the browser cannot copy images', () => {
    vi.stubGlobal('ClipboardItem', undefined)
    Reflect.deleteProperty(window, 'ClipboardItem')
    renderCard()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy original/ }))
    expect(write).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Copy image unsupported', {
      description: 'This browser cannot put images on the clipboard. Use Save.',
    })
  })
})
