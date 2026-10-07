/*
  The PNGs inside an iOS app. Xcode stores them for the device in Apple's own variant, "CgBI"
  (actool --compress-pngs, pngcrush -iphone): a CgBI chunk ahead of IHDR, IDAT holding raw
  DEFLATE with no zlib header or checksum, and pixels in BGRA order with the colour
  premultiplied by alpha. Only Apple's decoders read that, so a browser shows a broken image;
  decodeCgbi turns one into plain RGBA pixels for icon.ts to draw, inflating with the browser's
  own DecompressionStream.

  Only what Apple's tools write is decoded: 8-bit RGBA or RGB, not interlaced. Sizes are
  checked before anything is allocated, since an IPA is untrusted input.
*/

export interface PngSize {
  readonly width: number
  readonly height: number
}

export interface DecodedPng extends PngSize {
  /** Straight (not premultiplied) RGBA, row after row: what an ImageData holds. */
  readonly rgba: Uint8ClampedArray<ArrayBuffer>
}

export type PngErrorCode =
  /** Not a PNG, or one whose chunks or image data do not add up. */
  | 'PNG_INVALID'
  /** A PNG this does not decode: not CgBI, not 8-bit RGB or RGBA, or interlaced. */
  | 'PNG_UNSUPPORTED'
  /** More pixels than MAX_PIXELS. */
  | 'PNG_TOO_LARGE'
  /** This browser has no DecompressionStream('deflate-raw'). */
  | 'PNG_NO_INFLATE'

/** A refusal. Its message is the code, as with Device Lab's ZipError; callers own the wording. */
export class PngError extends Error {
  readonly code: PngErrorCode

  constructor(code: PngErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'PngError'
    this.code = code
  }
}

/** 4096 × 4096: four times the App Store's 1024-pixel icon each way, and still a bounded 64 MB. */
export const MAX_PIXELS = 4096 * 4096

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

interface Chunk {
  readonly type: string
  readonly data: Uint8Array
}

/**
 * The chunks in file order, through IEND. It stops quietly where the bytes do (a truncated
 * file, or only the head of one), so a caller decides whether what it got is enough.
 */
function* chunks(bytes: Uint8Array): Generator<Chunk> {
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = SIGNATURE.length; at + 12 <= bytes.length;) {
    const length = view.getUint32(at)
    const next = at + 12 + length
    if (next > bytes.length) return
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    yield { type, data: bytes.subarray(at + 8, at + 8 + length) }
    if (type === 'IEND') return
    at = next
  }
}

/** IHDR's width and height; null when either is 0 or past the format's 2^31 - 1. */
function sizeOf(header: Uint8Array): PngSize | null {
  if (header.length < 13) return null
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const valid = (n: number) => n > 0 && n <= 0x7fffffff
  return valid(width) && valid(height) ? { width, height } : null
}

/**
 * A PNG's size from its header, CgBI or not; null for anything that is not a PNG. The first
 * 64 bytes of a file are enough.
 */
export function pngSize(bytes: Uint8Array): PngSize | null {
  for (const { type, data } of chunks(bytes)) {
    if (type === 'IHDR') return sizeOf(data)
    if (type === 'IDAT') return null
  }
  return null
}

/** Whether a PNG is Apple's CgBI variant, which a browser cannot show. */
export function isCgbi(bytes: Uint8Array): boolean {
  for (const { type } of chunks(bytes)) {
    if (type === 'CgBI') return true
    if (type === 'IHDR' || type === 'IDAT') return false
  }
  return false
}

/**
 * Exactly `size` bytes inflated from raw DEFLATE. Inflating stops there, which caps what a
 * crafted stream can make the browser produce; bytes after the image are ignored, as libpng
 * ignores them.
 */
async function inflateRaw(parts: readonly Uint8Array[], size: number): Promise<Uint8Array> {
  let inflater: DecompressionStream
  try {
    inflater = new DecompressionStream('deflate-raw')
  } catch (error) {
    throw new PngError('PNG_NO_INFLATE', { cause: error })
  }
  const input = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    input.set(part, offset)
    offset += part.length
  }
  const reader = new Blob([input]).stream().pipeThrough(inflater).getReader()
  const out = new Uint8Array(size)
  let at = 0
  try {
    while (at < size) {
      const step = await reader.read()
      if (step.done) break
      const piece = step.value.subarray(0, size - at)
      out.set(piece, at)
      at += piece.length
    }
  } catch (error) {
    // The inflater's own TypeError for a damaged stream.
    throw new PngError('PNG_INVALID', { cause: error })
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (at < size) throw new PngError('PNG_INVALID')
  return out
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toCorner = Math.abs(estimate - corner)
  if (toLeft <= toUp && toLeft <= toCorner) return left
  return toUp <= toCorner ? up : corner
}

/**
 * Undoes each row's filter in place (PNG §9). `raw` is the inflated image: per row, a filter
 * byte, then `stride` bytes predicted from the pixel to the left (`bpp` bytes back), the one
 * above, or both. The row above the first one reads as zeros.
 */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): void {
  const line = stride + 1
  for (let y = 0; y < height; y++) {
    const row = y * line + 1
    const prior = row - line
    const first = y === 0
    switch (raw[row - 1]) {
      case 0: // None
        break
      case 1: // Sub
        for (let i = bpp; i < stride; i++) {
          raw[row + i] = ((raw[row + i] ?? 0) + (raw[row + i - bpp] ?? 0)) & 0xff
        }
        break
      case 2: // Up
        if (first) break
        for (let i = 0; i < stride; i++) {
          raw[row + i] = ((raw[row + i] ?? 0) + (raw[prior + i] ?? 0)) & 0xff
        }
        break
      case 3: // Average
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? (raw[row + i - bpp] ?? 0) : 0
          const up = first ? 0 : (raw[prior + i] ?? 0)
          raw[row + i] = ((raw[row + i] ?? 0) + ((left + up) >> 1)) & 0xff
        }
        break
      case 4: // Paeth
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? (raw[row + i - bpp] ?? 0) : 0
          const up = first ? 0 : (raw[prior + i] ?? 0)
          const corner = first || i < bpp ? 0 : (raw[prior + i - bpp] ?? 0)
          raw[row + i] = ((raw[row + i] ?? 0) + paeth(left, up, corner)) & 0xff
        }
        break
      default:
        throw new PngError('PNG_INVALID')
    }
  }
}

/**
 * A colour premultiplied by `alpha`, back to straight: c × 255 / a, rounded half up. Apple
 * rounds the same way: actool's plain and CgBI output of one icon agree to the bit through it
 * (png.test.ts). Over 255 only in a malformed file, whose colour exceeds its alpha.
 */
const unpremultiply = (colour: number, alpha: number) =>
  Math.min(255, Math.round((colour * 255) / alpha))

/** Unfiltered BGRA (or BGR) rows, premultiplied, to straight RGBA without row filter bytes. */
function straighten(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(width * height * 4)
  const line = width * channels + 1
  for (let y = 0; y < height; y++) {
    let from = y * line + 1
    let to = y * width * 4
    for (let x = 0; x < width; x++, from += channels, to += 4) {
      const alpha = channels === 4 ? (raw[from + 3] ?? 0) : 255
      // Fully transparent stays (0, 0, 0, 0): the colour was multiplied away.
      if (alpha === 0) continue
      const blue = raw[from] ?? 0
      const green = raw[from + 1] ?? 0
      const red = raw[from + 2] ?? 0
      rgba[to] = alpha === 255 ? red : unpremultiply(red, alpha)
      rgba[to + 1] = alpha === 255 ? green : unpremultiply(green, alpha)
      rgba[to + 2] = alpha === 255 ? blue : unpremultiply(blue, alpha)
      rgba[to + 3] = alpha
    }
  }
  return rgba
}

/**
 * An Apple CgBI PNG as straight RGBA pixels. Rejects with PngError: PNG_UNSUPPORTED for a
 * plain PNG (the browser decodes those itself) or a pixel format Apple's tools do not write,
 * PNG_TOO_LARGE, PNG_INVALID for a damaged file, PNG_NO_INFLATE without DecompressionStream.
 */
export async function decodeCgbi(bytes: Uint8Array): Promise<DecodedPng> {
  let cgbi = false
  let header: Uint8Array | null = null
  const idat: Uint8Array[] = []
  for (const { type, data } of chunks(bytes)) {
    if (type === 'CgBI' && !header) cgbi = true
    else if (type === 'IHDR' && !header) header = data
    else if (type === 'IDAT') idat.push(data)
  }
  const size = header && sizeOf(header)
  if (!header || !size) throw new PngError('PNG_INVALID')
  if (!cgbi) throw new PngError('PNG_UNSUPPORTED')

  const [depth, colourType, compression, filtering, interlace] = header.subarray(8, 13)
  if (compression !== 0 || filtering !== 0) throw new PngError('PNG_INVALID')
  if (depth !== 8 || (colourType !== 6 && colourType !== 2) || interlace !== 0) {
    throw new PngError('PNG_UNSUPPORTED')
  }
  const { width, height } = size
  if (width * height > MAX_PIXELS) throw new PngError('PNG_TOO_LARGE')
  if (idat.length === 0) throw new PngError('PNG_INVALID')

  const channels = colourType === 6 ? 4 : 3
  const stride = width * channels
  const raw = await inflateRaw(idat, height * (stride + 1))
  unfilter(raw, height, stride, channels)
  return { width, height, rgba: straighten(raw, width, height, channels) }
}
