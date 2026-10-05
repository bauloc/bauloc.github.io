/*
  A screenshot that came back all black. An iPhone that is locked with its screen off answers a
  screenshot with a black PNG and no error, and an Android TV or phone asleep does the same; the
  tester then sees a black square and no reason. The page keeps the image (it is what the device
  returned) and says why, from a small sample drawn in the browser: every pixel near black.
*/

import { defineMessages, localized } from '@/lib/i18n'

const BLACK_SHOT_MESSAGES = defineMessages({
  en: { text: 'The screen was off or locked: wake and unlock the device, then take it again.' },
  vi: { text: 'Màn hình đang tắt hoặc khóa: hãy đánh thức và mở khóa thiết bị, rồi chụp lại.' },
})

/** What the page says about one: why, and what to do, in the language on screen. */
export const BLACK_SHOT = localized(BLACK_SHOT_MESSAGES)

/**
 * BLACK_SHOT.text, in English only: a string read once can't follow a language switch, so
 * anything on screen reads BLACK_SHOT.text instead.
 */
export const BLACK_SHOT_TEXT = BLACK_SHOT_MESSAGES.en.text

/** The sample's longer side, in pixels: enough to catch a status bar or a line of text. */
const SAMPLE = 96

/**
 * No channel above this (of 255) counts as black: a sleeping panel's PNG is 0 everywhere, while
 * iOS's darkest grey cells (#1C1C1E) and a dark app's text stay above it.
 */
const NEAR_BLACK = 12

/** RGBA bytes, as ImageData holds them: whether every pixel is near black. */
export function isNearBlack(rgba: ArrayLike<number>): boolean {
  if (rgba.length < 4) return false
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) > NEAR_BLACK) return false
    if ((rgba[i + 1] ?? 0) > NEAR_BLACK) return false
    if ((rgba[i + 2] ?? 0) > NEAR_BLACK) return false
  }
  return true
}

/** A 2D context of that size: off screen where the browser has it, else a detached <canvas>. */
function context2d(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height).getContext('2d')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.getContext('2d')
}

/**
 * Whether the image is all black, from a sample at most SAMPLE pixels across. False whenever it
 * can't tell (no createImageBitmap or canvas, an image the browser can't decode): the page then
 * says nothing, as before.
 */
export async function looksBlack(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return false
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, SAMPLE / Math.max(bitmap.width, bitmap.height, 1))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const context = context2d(width, height)
    if (!context) return false
    // Averaged, not picked: a line of white text on black still lifts its sample above black.
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    return isNearBlack(context.getImageData(0, 0, width, height).data)
  } catch {
    return false
  } finally {
    bitmap?.close()
  }
}
