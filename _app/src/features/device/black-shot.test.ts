import { afterEach, describe, expect, it, vi } from 'vitest'

import { isNearBlack, looksBlack } from './black-shot'

/*
  The all-black check on RGBA bytes, and the sampling around it with a fake bitmap and canvas
  (Node has neither).
*/

/** `count` pixels of one colour, as ImageData holds them. */
const pixels = (count: number, [r, g, b]: [number, number, number]) =>
  Uint8ClampedArray.from({ length: count * 4 }, (_, i) => [r, g, b, 255][i % 4] ?? 0)

describe('isNearBlack', () => {
  it('is true for a sleeping screen: every pixel black or nearly', () => {
    expect(isNearBlack(pixels(64, [0, 0, 0]))).toBe(true)
    expect(isNearBlack(pixels(64, [12, 10, 8]))).toBe(true)
  })

  it('is false once one pixel is lit: iOS’s darkest grey, a line of text', () => {
    expect(isNearBlack(pixels(64, [28, 28, 30]))).toBe(false)
    const text = pixels(64, [0, 0, 0])
    text.set([40, 40, 40, 255], 32 * 4)
    expect(isNearBlack(text)).toBe(false)
    // One channel is enough: a deep red or blue is not black.
    expect(isNearBlack(pixels(4, [0, 0, 60]))).toBe(false)
  })

  it('is false for no pixels at all', () => {
    expect(isNearBlack(new Uint8ClampedArray(0))).toBe(false)
  })
})

describe('looksBlack', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A 1920×1080 bitmap whose sample is `sample`, through a fake OffscreenCanvas. */
  function stub(sample: Uint8ClampedArray) {
    const drawn: number[][] = []
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 1920, height: 1080, close }))
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            imageSmoothingQuality: 'low',
            drawImage: (_: unknown, x: number, y: number, w: number, h: number) => {
              drawn.push([x, y, w, h])
            },
            getImageData: () => ({ data: sample }),
          }
        }
      },
    )
    return { drawn, close }
  }

  it('samples the image small, at most 96 pixels across, and closes the bitmap', async () => {
    const { drawn, close } = stub(pixels(96 * 54, [0, 0, 0]))
    expect(await looksBlack(new Blob(['png']))).toBe(true)
    expect(drawn).toEqual([[0, 0, 96, 54]])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('is false for a lit screen, and whenever it can’t tell', async () => {
    stub(pixels(96 * 54, [200, 200, 200]))
    expect(await looksBlack(new Blob(['png']))).toBe(false)
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('InvalidStateError')))
    expect(await looksBlack(new Blob(['not an image']))).toBe(false)
    vi.stubGlobal('createImageBitmap', undefined)
    expect(await looksBlack(new Blob(['png']))).toBe(false)
  })
})
