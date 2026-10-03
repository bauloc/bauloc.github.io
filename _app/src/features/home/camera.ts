/**
 * The index is a camera moving over a horizontal strip of sheets. This is its geometry, as
 * pure functions — no DOM, no React — so the numbers that decide what you see are tested.
 *
 * Everything is in DESIGN units: a sheet is always 1200 × 720 and the camera scales the whole
 * strip, so type and art are authored once at a fixed size and never reflow.
 *
 * The constants were measured on the reference (rauno.me at 1440 × 900): the focused sheet is
 * 635 px tall, so it takes 70.6% of the viewport height; browsing pulls back to 0.6, which is
 * 0.68 of that focused scale; and one pixel of scroll moves the strip one pixel on screen.
 */

export const SHEET_WIDTH = 1200
export const SHEET_HEIGHT = 720
export const SHEET_GAP = 40
/** Centre-to-centre distance between neighbouring sheets. */
export const PITCH = SHEET_WIDTH + SHEET_GAP

/** Margin a sheet keeps from each side of the viewport when width is what limits it. */
const SIDE_MARGIN = 15
const HEIGHT_SHARE = 0.706
const BROWSE_RATIO = 0.68

/**
 * `fine` is a mouse or trackpad: vertical scroll drives the camera and it zooms out to browse.
 * `coarse` is touch: the strip scrolls sideways natively and the camera never zooms, because
 * the sheet already fills the phone's width.
 */
export type PointerMode = 'fine' | 'coarse'

export interface Viewport {
  readonly width: number
  readonly height: number
}

export interface Camera {
  /** The design-space x the viewport is centred on. */
  readonly x: number
  readonly scale: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Scale at which one sheet fills the viewport. */
export function focusScale(viewport: Viewport): number {
  const byWidth = (viewport.width - 2 * SIDE_MARGIN) / SHEET_WIDTH
  const byHeight = (viewport.height * HEIGHT_SHARE) / SHEET_HEIGHT
  return Math.max(0.05, Math.min(byWidth, byHeight))
}

/** Scale while travelling between sheets. */
export function travelScale(viewport: Viewport, mode: PointerMode): number {
  return mode === 'coarse' ? focusScale(viewport) : focusScale(viewport) * BROWSE_RATIO
}

/** Scroll distance from the first sheet's centre to the last one's. */
export function scrollRange(count: number, viewport: Viewport, mode: PointerMode): number {
  return Math.max(0, count - 1) * PITCH * travelScale(viewport, mode)
}

export function centreOf(index: number): number {
  return index * PITCH + SHEET_WIDTH / 2
}

/**
 * Where the camera is for a given scroll offset. On a fine pointer it zooms out over the
 * first sheet's worth of travel — the first sheet is a statement and gets the whole screen,
 * the rest is a strip you browse — and then holds that scale.
 */
export function cameraAt(
  scroll: number,
  count: number,
  viewport: Viewport,
  mode: PointerMode,
): Camera {
  const travel = travelScale(viewport, mode)
  const offset = clamp(scroll, 0, scrollRange(count, viewport, mode))
  const x = SHEET_WIDTH / 2 + offset / travel
  if (mode === 'coarse') return { x, scale: travel }

  const focus = focusScale(viewport)
  const t = smoothstep(clamp(offset / (PITCH * travel), 0, 1))
  return { x, scale: focus + (travel - focus) * t }
}

/** The scroll offset that centres sheet `index`. */
export function scrollFor(
  index: number,
  count: number,
  viewport: Viewport,
  mode: PointerMode,
): number {
  return clamp(index, 0, Math.max(0, count - 1)) * PITCH * travelScale(viewport, mode)
}

/** Inverse of `cameraAt`'s x: keeps the same sheet in view when the viewport changes. */
export function scrollForX(
  x: number,
  count: number,
  viewport: Viewport,
  mode: PointerMode,
): number {
  const offset = (x - SHEET_WIDTH / 2) * travelScale(viewport, mode)
  return clamp(offset, 0, scrollRange(count, viewport, mode))
}

export function nearestSheet(x: number, count: number): number {
  return clamp(Math.round((x - SHEET_WIDTH / 2) / PITCH), 0, Math.max(0, count - 1))
}

/**
 * Where a sheet sits relative to the camera, in sheets: 0 is centred, +1 is one sheet to the
 * right. Clamped to [-1, 1] — beyond a neighbour nothing reads it.
 */
export function sheetOffset(index: number, x: number): number {
  return clamp((centreOf(index) - x) / PITCH, -1, 1)
}

/** 0 at the first sheet, 1 at the last. */
export function progressOf(x: number, count: number): number {
  if (count <= 1) return 0
  return clamp((x - SHEET_WIDTH / 2) / ((count - 1) * PITCH), 0, 1)
}
