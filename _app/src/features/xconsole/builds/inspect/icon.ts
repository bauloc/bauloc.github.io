import type { IconImage } from '@/features/device/backends/archive/apk-badge'

import type { IconSource } from '../types'

/*
  The app's icon as build/<id>/icon.png: one square PNG that the install page, the console's
  list and the iOS manifest all show. The browser draws it, since it already decodes PNG, WebP
  and JPEG; whatever the app shipped (a bitmap, an adaptive icon's two layers, or an Apple
  "CgBI" PNG that the IPA reader decoded to pixels) comes out the same way. No mask is applied:
  the pages round the square with CSS, as launchers do with their own shape.

  The drawing needs a canvas, so it runs only in a browser. Its geometry and colours are plain
  functions, exported and tested on their own.
*/

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 0xAARRGGBB → `rgba(r, g, b, a)`, built at runtime (the palette rule bans colour literals),
 * in the comma form every canvas parses.
 */
export function argbToCss(argb: number): string {
  const channel = (shift: number) => (argb >>> shift) & 0xff
  const alpha = Math.round((channel(24) / 255) * 1000) / 1000
  return `rgba(${String(channel(16))}, ${String(channel(8))}, ${String(channel(0))}, ${String(alpha)})`
}

/** An image of `width`×`height` scaled to cover `box` and centred on it, cropped evenly. */
export function coverRect(width: number, height: number, box: Rect): Rect {
  const scale = Math.max(box.width / width, box.height / height)
  const w = width * scale
  const h = height * scale
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
}

/**
 * Where an adaptive icon's layers go in a `size` square. Each layer is 108 dp, of which the
 * launcher shows the middle 72 (the rest is room for its masks and parallax), so a layer is
 * drawn at 150%, centred, with a sixth of it cut off on every side.
 */
export function adaptiveRect(size: number): Rect {
  return { x: -size / 4, y: -size / 4, width: size * 1.5, height: size * 1.5 }
}

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

interface Surface {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement
  readonly context: Context
  readonly png: () => Promise<Blob | null>
}

/** A blank canvas: off screen where the browser has one with a 2D context, else a <canvas>. */
function surface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context) return { canvas, context, png: () => canvas.convertToBlob({ type: 'image/png' }) }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  return {
    canvas,
    context,
    png: () =>
      new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/png')
      }),
  }
}

/**
 * The icon drawn into a `size` square PNG, or null when this browser cannot draw it (no canvas,
 * an image it cannot decode). Never rejects: a build without an icon shows its initial instead.
 */
export async function renderIconPng(source: IconSource, size = 256): Promise<Blob | null> {
  const side = Math.max(1, Math.round(size))
  const decoded: ImageBitmap[] = []
  /** A compressed image as the browser decodes it; closed once the PNG is made. */
  const decode = async (image: IconImage) => {
    const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.mime }))
    decoded.push(bitmap)
    return bitmap
  }
  try {
    const target = surface(side, side)
    if (!target) return null
    const { context } = target
    // The browser's best filter, since icons are scaled both ways: an iPhone's is 180 px and a
    // legacy launcher icon 192, while an adaptive layer comes at 432.
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const square = { x: 0, y: 0, width: side, height: side }
    const draw = (image: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, box: Rect) => {
      const at = coverRect(image.width, image.height, box)
      context.drawImage(image, at.x, at.y, at.width, at.height)
    }

    if (source.kind === 'image') draw(await decode(source), square)
    else if (source.kind === 'rgba') {
      // Straight RGBA is what ImageData holds; put at its own size, then scaled like a bitmap.
      const pixels = surface(source.width, source.height)
      if (!pixels) return null
      pixels.context.putImageData(new ImageData(source.rgba, source.width, source.height), 0, 0)
      draw(pixels.canvas, square)
    } else if (source.icon.kind === 'bitmap') draw(await decode(source.icon), square)
    else {
      const { foreground, background } = source.icon
      const layer = adaptiveRect(side)
      if (background && 'argb' in background) {
        context.fillStyle = argbToCss(background.argb)
        context.fillRect(0, 0, side, side)
      } else if (background) draw(await decode(background), layer)
      // A background Device Lab cannot draw (a vector) is left transparent: the page's tile
      // shows through, rather than a colour the app never had.
      draw(await decode(foreground), layer)
    }
    return await target.png()
  } catch {
    return null
  } finally {
    for (const bitmap of decoded) bitmap.close()
  }
}
