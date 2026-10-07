import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IconSource } from '../types'
import { adaptiveRect, argbToCss, coverRect, renderIconPng } from './icon'

/*
  The geometry and the colours as plain functions, then the drawing through a fake canvas and
  a fake decoder (Node has neither): what is drawn where and in which order, and that every
  failure ends in null rather than an error.
*/

const SQUARE_256 = { x: 0, y: 0, width: 256, height: 256 }
const bytes = (...values: number[]) => Uint8Array.from(values)

describe('argbToCss', () => {
  it('writes an Android colour as a canvas fill', () => {
    expect(argbToCss(0xff447aee)).toBe('rgba(68, 122, 238, 1)')
    expect(argbToCss(0x80000000)).toBe('rgba(0, 0, 0, 0.502)')
    expect(argbToCss(0x00ffffff)).toBe('rgba(255, 255, 255, 0)')
  })
})

describe('coverRect', () => {
  it('fills a square with a square image', () => {
    expect(coverRect(1024, 1024, SQUARE_256)).toEqual(SQUARE_256)
    expect(coverRect(96, 96, SQUARE_256)).toEqual(SQUARE_256)
  })

  it('crops a wide or a tall image evenly on both sides', () => {
    expect(coverRect(200, 100, SQUARE_256)).toEqual({ x: -128, y: 0, width: 512, height: 256 })
    expect(coverRect(50, 100, { x: 0, y: 0, width: 100, height: 100 })).toEqual({
      x: 0,
      y: -50,
      width: 100,
      height: 200,
    })
  })

  it('covers a box that does not start at the corner', () => {
    expect(coverRect(432, 432, adaptiveRect(256))).toEqual(adaptiveRect(256))
  })
})

describe('adaptiveRect', () => {
  it('draws a layer at 150%, so that its middle 72 of 108 dp fill the square', () => {
    const layer = adaptiveRect(256)
    expect(layer).toEqual({ x: -64, y: -64, width: 384, height: 384 })
    expect((layer.width * 72) / 108).toBe(256)
    // 18 dp of every 108 fall outside on each side.
    expect(-layer.x / layer.width).toBeCloseTo(18 / 108)
  })
})

/* ---------------------------------------------------------------- *
 * Drawing, through fakes
 * ---------------------------------------------------------------- */

class FakeContext {
  fillStyle = ''
  imageSmoothingEnabled = false
  imageSmoothingQuality = 'low'
  readonly ops: unknown[][] = []

  fillRect(x: number, y: number, width: number, height: number) {
    this.ops.push(['fillRect', this.fillStyle, x, y, width, height])
  }
  drawImage(image: unknown, x: number, y: number, width: number, height: number) {
    this.ops.push(['drawImage', image, x, y, width, height])
  }
  putImageData(data: unknown, x: number, y: number) {
    this.ops.push(['putImageData', data, x, y])
  }
}

interface FakeBitmap {
  readonly width: number
  readonly height: number
  /** The type of the Blob it was decoded from. */
  readonly mime: string
  closed: boolean
  close(): void
}

interface Options {
  /** Each decoded image's size, in decoding order; 108 × 108 past the end. */
  readonly sizes?: readonly (readonly [number, number])[]
  readonly undecodable?: boolean
  readonly noContext?: boolean
  readonly encodeFails?: boolean
}

/** OffscreenCanvas, createImageBitmap and ImageData as a browser has them, recording use. */
function fakeBrowser({ sizes = [], undecodable, noContext, encodeFails }: Options = {}) {
  const canvases: FakeCanvas[] = []
  const bitmaps: FakeBitmap[] = []

  class FakeCanvas {
    readonly width: number
    readonly height: number
    readonly context = new FakeContext()
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
      canvases.push(this)
    }
    getContext(kind: string) {
      return kind === '2d' && !noContext ? this.context : null
    }
    convertToBlob(options: { type?: string } = {}) {
      if (encodeFails) return Promise.reject(new DOMException('Out of memory.', 'EncodingError'))
      return Promise.resolve(new Blob(['png'], { type: options.type ?? '' }))
    }
  }

  class FakeImageData {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      // What browsers throw when the pixels do not match the size given.
      if (width <= 0 || data.length !== width * height * 4) {
        throw new DOMException('The input data has an invalid length.', 'IndexSizeError')
      }
      this.data = data
      this.width = width
      this.height = height
    }
  }

  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  vi.stubGlobal('ImageData', FakeImageData)
  vi.stubGlobal('createImageBitmap', (blob: Blob) => {
    if (undecodable) {
      return Promise.reject(
        new DOMException('The source image cannot be decoded.', 'InvalidStateError'),
      )
    }
    const [width, height] = sizes[bitmaps.length] ?? [108, 108]
    const bitmap: FakeBitmap = {
      width,
      height,
      mime: blob.type,
      closed: false,
      close() {
        this.closed = true
      },
    }
    bitmaps.push(bitmap)
    return Promise.resolve(bitmap)
  })
  return { canvases, bitmaps }
}

const png = (...values: number[]) => ({ mime: 'image/png' as const, bytes: bytes(...values) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderIconPng', () => {
  it('draws an image over the whole square, and hands back a PNG', async () => {
    const { canvases, bitmaps } = fakeBrowser({ sizes: [[1024, 1024]] })
    const out = await renderIconPng({ kind: 'image', mime: 'image/webp', bytes: bytes(1, 2, 3) })
    expect(out?.type).toBe('image/png')
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[256, 256]])
    expect(canvases[0]!.context.ops).toEqual([['drawImage', bitmaps[0], 0, 0, 256, 256]])
    expect(canvases[0]!.context.imageSmoothingQuality).toBe('high')
    // Decoded as what it is, and let go once drawn.
    expect(bitmaps[0]).toMatchObject({ mime: 'image/webp', closed: true })
  })

  it('draws at the size asked for, cropping an image that is not square', async () => {
    const { canvases, bitmaps } = fakeBrowser({ sizes: [[200, 100]] })
    await renderIconPng({ kind: 'image', mime: 'image/jpeg', bytes: bytes(1) }, 128)
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[128, 128]])
    expect(canvases[0]!.context.ops).toEqual([['drawImage', bitmaps[0], -64, 0, 256, 128]])
  })

  it('draws an APK’s bitmap icon like any image', async () => {
    const { canvases, bitmaps } = fakeBrowser({ sizes: [[192, 192]] })
    const icon: IconSource = { kind: 'badge', icon: { kind: 'bitmap', ...png(1, 2) } }
    expect(await renderIconPng(icon)).not.toBeNull()
    expect(canvases[0]!.context.ops).toEqual([['drawImage', bitmaps[0], 0, 0, 256, 256]])
  })

  it('draws an adaptive icon: its colour, then its foreground at 150%', async () => {
    const { canvases, bitmaps } = fakeBrowser()
    const icon: IconSource = {
      kind: 'badge',
      icon: { kind: 'adaptive', foreground: png(1), background: { argb: 0xff447aee } },
    }
    expect(await renderIconPng(icon)).not.toBeNull()
    expect(canvases[0]!.context.ops).toEqual([
      ['fillRect', 'rgba(68, 122, 238, 1)', 0, 0, 256, 256],
      ['drawImage', bitmaps[0], -64, -64, 384, 384],
    ])
  })

  it('draws a bitmap background under the foreground, both at 150%', async () => {
    const { canvases, bitmaps } = fakeBrowser({
      sizes: [
        [432, 432],
        [432, 432],
      ],
    })
    const icon: IconSource = {
      kind: 'badge',
      icon: { kind: 'adaptive', foreground: png(1), background: png(2) },
    }
    expect(await renderIconPng(icon)).not.toBeNull()
    expect(bitmaps).toHaveLength(2)
    expect(canvases[0]!.context.ops).toEqual([
      ['drawImage', bitmaps[0], -64, -64, 384, 384],
      ['drawImage', bitmaps[1], -64, -64, 384, 384],
    ])
    expect(bitmaps.every((b) => b.closed)).toBe(true)
  })

  it('leaves a background it cannot draw transparent', async () => {
    const { canvases, bitmaps } = fakeBrowser()
    const icon: IconSource = {
      kind: 'badge',
      icon: { kind: 'adaptive', foreground: png(1), background: null },
    }
    expect(await renderIconPng(icon)).not.toBeNull()
    expect(canvases[0]!.context.ops).toEqual([['drawImage', bitmaps[0], -64, -64, 384, 384]])
  })

  it('puts decoded pixels on a canvas of their own size, then scales them up', async () => {
    const { canvases } = fakeBrowser()
    const rgba = new Uint8ClampedArray(2 * 2 * 4).fill(200)
    expect(await renderIconPng({ kind: 'rgba', width: 2, height: 2, rgba })).not.toBeNull()
    const [target, pixels] = canvases
    expect(canvases.map((c) => [c.width, c.height])).toEqual([
      [256, 256],
      [2, 2],
    ])
    expect(pixels!.context.ops).toEqual([
      ['putImageData', expect.objectContaining({ data: rgba, width: 2, height: 2 }), 0, 0],
    ])
    expect(target!.context.ops).toEqual([['drawImage', pixels, 0, 0, 256, 256]])
  })

  it('draws on a <canvas> where there is no OffscreenCanvas', async () => {
    fakeBrowser({ sizes: [[180, 180]] })
    vi.stubGlobal('OffscreenCanvas', undefined)
    const context = new FakeContext()
    const element = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (done: (blob: Blob | null) => void, type: string) => {
        done(new Blob(['png'], { type }))
      },
    }
    vi.stubGlobal('document', { createElement: () => element })
    const out = await renderIconPng({ kind: 'image', ...png(1) })
    expect(out?.type).toBe('image/png')
    expect(element).toMatchObject({ width: 256, height: 256 })
    expect(context.ops).toHaveLength(1)
  })

  it('gives null, never an error, whenever it cannot draw', async () => {
    const image: IconSource = { kind: 'image', ...png(1) }

    fakeBrowser({ undecodable: true })
    expect(await renderIconPng(image)).toBeNull()

    fakeBrowser({ noContext: true })
    expect(await renderIconPng(image)).toBeNull()

    // Pixels that do not add up to their size.
    fakeBrowser()
    const short = new Uint8ClampedArray(3)
    expect(await renderIconPng({ kind: 'rgba', width: 2, height: 2, rgba: short })).toBeNull()

    // No canvas at all: no OffscreenCanvas, and no document to make a <canvas> in.
    fakeBrowser()
    vi.stubGlobal('OffscreenCanvas', undefined)
    expect(await renderIconPng(image)).toBeNull()
  })

  it('lets go of what it decoded when making the PNG fails', async () => {
    const { bitmaps } = fakeBrowser({ encodeFails: true })
    expect(await renderIconPng({ kind: 'image', ...png(1) })).toBeNull()
    expect(bitmaps).toMatchObject([{ closed: true }])
  })
})
