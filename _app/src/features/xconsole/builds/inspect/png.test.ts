import { readFileSync } from 'node:fs'
import { deflateRawSync, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { crc32, PNG_1PX } from '@/features/device/backends/archive/__fixtures__/synth'

import { decodeCgbi, isCgbi, MAX_PIXELS, PngError, pngSize } from './png'

/*
  The decoder against Apple's own encoders (see __fixtures__/make-fixtures.sh): icon.png went
  through pngcrush -iphone twice (one file filtered per row, one with Average throughout), and
  actool wrote one icon both plain and as CgBI, the plain one un-premultiplied by Apple, so the
  rounding is checked against Apple's to the bit. Each plain PNG is decoded here by zlib and
  the specification's arithmetic, not by the code under test. Edge cases are built in memory.
*/

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))

afterEach(() => {
  vi.unstubAllGlobals()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof PngError ? error.code : `not a PngError: ${String(error)}`
  }
  return 'decoded'
}

/** RGBA bytes as one [r, g, b, a] per pixel, so a mismatch names its pixel. */
const pixels = (rgba: Uint8ClampedArray) =>
  Array.from({ length: rgba.length / 4 }, (_, i) => Array.from(rgba.subarray(i * 4, i * 4 + 4)))

/**
 * A plain 8-bit RGBA PNG's pixels, the long way round: every IDAT inflated by zlib, every row
 * unfiltered with the predictors exactly as the PNG specification writes them.
 */
function decodePlain(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const idat: Uint8Array[] = []
  let width = 0
  let height = 0
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      expect([bytes[at + 16], bytes[at + 17], bytes[at + 20]]).toEqual([8, 6, 0])
    }
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0
      const b = y > 0 ? rgba[(y - 1) * stride + i]! : 0
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4]! : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const predicted = [0, a, b, Math.floor((a + b) / 2), paeth][filter]!
      rgba[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predicted) % 256
    }
  }
  return { width, height, rgba }
}

/*
  CgBI PNGs made here: the CgBI chunk pngcrush writes, IHDR, the rows as given (each a filter
  byte and BGRA or BGR bytes) deflated raw, optionally across two IDAT chunks, and IEND.
*/

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

function chunk(type: string, data: ArrayLike<number>): number[] {
  const body = Uint8Array.from([...Array.from(type, (c) => c.charCodeAt(0)), ...Array.from(data)])
  return [...u32(data.length), ...body, ...u32(crc32(body))]
}

interface Synth {
  colour?: number
  depth?: number
  compression?: number
  interlace?: number
  /** Where to cut the deflated rows into a second IDAT chunk. */
  split?: number
  /** Leave the CgBI chunk out: a plain PNG header over CgBI data. */
  plain?: boolean
  /** Replace the image data; empty leaves the IDAT chunk out. */
  idat?: Uint8Array
}

function synth(width: number, height: number, rows: readonly number[], options: Synth = {}) {
  const idat = options.idat ?? new Uint8Array(deflateRawSync(Uint8Array.from(rows)))
  const split = options.split ?? idat.length
  const data = [
    ...(split > 0 ? chunk('IDAT', idat.subarray(0, split)) : []),
    ...(split < idat.length ? chunk('IDAT', idat.subarray(split)) : []),
  ]
  const ihdr = [
    ...u32(width),
    ...u32(height),
    options.depth ?? 8,
    options.colour ?? 6,
    options.compression ?? 0,
    0,
    options.interlace ?? 0,
  ]
  return Uint8Array.from([
    ...SIGNATURE,
    ...(options.plain ? [] : chunk('CgBI', [0x50, 0x00, 0x20, 0x02])),
    ...chunk('IHDR', ihdr),
    ...data,
    ...chunk('IEND', []),
  ])
}

/** Bytes from a fixed generator: the same every run. */
function noise(length: number, seed: number): number[] {
  let state = seed
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state >>> 24
  })
}

/** Rows filtered with one filter type: what an encoder writes for `pixels` (BGRA). */
function filtered(pixels: readonly number[], width: number, filter: number): number[] {
  const stride = width * 4
  const rows: number[] = []
  for (let y = 0; y * stride < pixels.length; y++) {
    rows.push(filter)
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i
      const a = i >= 4 ? pixels[at - 4]! : 0
      const b = y > 0 ? pixels[at - stride]! : 0
      const c = i >= 4 && y > 0 ? pixels[at - stride - 4]! : 0
      const p = a + b - c
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!
      rows.push((pixels[at]! - predicted + 256) % 256)
    }
  }
  return rows
}

describe('pngSize and isCgbi', () => {
  it('read the header of plain and CgBI PNGs, from the first 64 bytes alone', () => {
    for (const name of ['icon.png', 'icon-cgbi.png', 'appicon.png', 'appicon-cgbi.png']) {
      const bytes = fixture(name)
      expect(pngSize(bytes), name).toEqual({ width: 120, height: 120 })
      expect(pngSize(bytes.subarray(0, 64)), name).toEqual({ width: 120, height: 120 })
      expect(isCgbi(bytes.subarray(0, 64)), name).toBe(name.includes('cgbi'))
    }
    expect(pngSize(PNG_1PX)).toEqual({ width: 1, height: 1 })
    expect(isCgbi(PNG_1PX)).toBe(false)
  })

  it('answer null and false for anything else', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const zeroWide = synth(0, 1, [0, 0, 0, 0, 0])
    for (const bytes of [new Uint8Array(0), jpeg, PNG_1PX.subarray(0, 20), zeroWide]) {
      expect(pngSize(bytes)).toBeNull()
    }
    expect(isCgbi(jpeg)).toBe(false)
    expect(isCgbi(fixture('icon-cgbi.png').subarray(0, 20))).toBe(false)
  })
})

describe('decodeCgbi', () => {
  it('matches the PNG pngcrush was given, within the ±1 premultiplying leaves', async () => {
    const source = decodePlain(fixture('icon.png'))
    for (const name of ['icon-cgbi.png', 'icon-cgbi-average.png']) {
      const decoded = await decodeCgbi(fixture(name))
      expect(decoded.width).toBe(120)
      expect(decoded.height).toBe(120)
      expect(decoded.rgba).toBeInstanceOf(Uint8ClampedArray)
      const alphas = new Set<number>()
      let worst = 0
      for (let at = 0; at < source.rgba.length; at += 4) {
        const alpha = source.rgba[at + 3]!
        alphas.add(alpha)
        expect(decoded.rgba[at + 3]).toBe(alpha)
        for (let channel = 0; channel < 3; channel++) {
          const expected = alpha === 0 ? 0 : source.rgba[at + channel]!
          worst = Math.max(worst, Math.abs(decoded.rgba[at + channel]! - expected))
        }
      }
      expect(worst, name).toBeLessThanOrEqual(1)
      expect([...alphas].sort((a, b) => a - b)).toEqual([0, 128, 160, 200, 230, 255])
    }
  })

  it('un-premultiplies exactly as Apple does', async () => {
    const plain = decodePlain(fixture('appicon.png'))
    const decoded = await decodeCgbi(fixture('appicon-cgbi.png'))
    expect(Array.from(decoded.rgba)).toEqual(Array.from(plain.rgba))
    // The soft edge holds every alpha from nearly clear to nearly opaque.
    const partial = new Set<number>()
    for (let at = 3; at < plain.rgba.length; at += 4) {
      if (plain.rgba[at]! > 0 && plain.rgba[at]! < 255) partial.add(plain.rgba[at]!)
    }
    expect(partial.size).toBeGreaterThan(100)
  })

  it('undoes each filter type, across IDAT chunks', async () => {
    const width = 7
    // Opaque, so only the filters and the channel order are under test.
    const bgra = noise(width * 5 * 4, 0x1234).map((byte, i) => (i % 4 === 3 ? 255 : byte))
    const expected = pixels(Uint8ClampedArray.from(bgra)).map(([b, g, r, a]) => [r, g, b, a])
    for (const filter of [0, 1, 2, 3, 4]) {
      const rows = filtered(bgra, width, filter)
      for (const split of [undefined, 9]) {
        const decoded = await decodeCgbi(synth(width, 5, rows, { split }))
        expect(pixels(decoded.rgba), `filter ${String(filter)}`).toEqual(expected)
      }
    }
  })

  it('turns BGRA premultiplied into straight RGBA, rounding half up', async () => {
    const bgra = [
      [50, 25, 100, 100],
      [0, 0, 0, 0],
      [200, 0, 0, 100],
      [1, 1, 1, 3],
      [10, 20, 30, 255],
    ]
    const decoded = await decodeCgbi(synth(5, 1, [0, ...bgra.flat()]))
    expect(pixels(decoded.rgba)).toEqual([
      [255, 64, 128, 100], // 100·255/100; 25·255/100 = 63.75; 50·255/100 = 127.5
      [0, 0, 0, 0], // transparent
      [0, 0, 255, 100], // a colour above its alpha (malformed): capped
      [85, 85, 85, 3],
      [30, 20, 10, 255], // opaque: only the order changes
    ])
  })

  it('reads RGB without alpha as opaque', async () => {
    const decoded = await decodeCgbi(synth(2, 1, [0, 10, 20, 30, 40, 50, 60], { colour: 2 }))
    expect(pixels(decoded.rgba)).toEqual([
      [30, 20, 10, 255],
      [60, 50, 40, 255],
    ])
  })

  it('stops at the image: data past its last row is ignored', async () => {
    const rows = [0, 1, 2, 3, 4, 0, 5, 6, 7, 8]
    const decoded = await decodeCgbi(synth(1, 1, rows))
    expect(pixels(decoded.rgba)).toEqual([[191, 128, 64, 4]])
  })

  it('refuses a plain PNG and pixel formats Apple’s tools do not write', async () => {
    const row = [0, 1, 2, 3, 4]
    expect(await codeOf(decodeCgbi(fixture('icon.png')))).toBe('PNG_UNSUPPORTED')
    expect(await codeOf(decodeCgbi(synth(1, 1, row, { plain: true })))).toBe('PNG_UNSUPPORTED')
    for (const options of [{ depth: 16 }, { colour: 3 }, { colour: 4 }, { interlace: 1 }]) {
      const code = await codeOf(decodeCgbi(synth(1, 1, row, options)))
      expect(code, JSON.stringify(options)).toBe('PNG_UNSUPPORTED')
    }
  })

  it('refuses a damaged file', async () => {
    const row = [0, 1, 2, 3, 4]
    const deflated = new Uint8Array(deflateRawSync(Uint8Array.from(noise(4000, 7))))
    for (const [what, bytes] of [
      ['not a PNG', Uint8Array.from([1, 2, 3])],
      ['no IHDR', Uint8Array.from([...SIGNATURE, ...chunk('IEND', [])])],
      ['no IDAT', synth(1, 1, row, { idat: new Uint8Array(0) })],
      ['a compression method PNG does not have', synth(1, 1, row, { compression: 1 })],
      ['a filter type PNG does not have', synth(1, 1, [5, 1, 2, 3, 4])],
      ['too few rows', synth(1, 2, row)],
      ['data that is not DEFLATE', synth(1, 1, row, { idat: Uint8Array.from([0xff, 0xff]) })],
      ['DEFLATE cut short', synth(20, 50, [], { idat: deflated.subarray(0, 100) })],
    ] as const) {
      expect(await codeOf(decodeCgbi(bytes)), what).toBe('PNG_INVALID')
    }
  })

  it('refuses more pixels than it will hold, before inflating anything', async () => {
    expect(MAX_PIXELS).toBe(4096 * 4096)
    const huge = synth(4097, 4096, [], { idat: new Uint8Array(1) })
    expect(await codeOf(decodeCgbi(huge))).toBe('PNG_TOO_LARGE')
  })

  it('says so when the browser cannot inflate', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    expect(await codeOf(decodeCgbi(fixture('icon-cgbi.png')))).toBe('PNG_NO_INFLATE')
  })
})
