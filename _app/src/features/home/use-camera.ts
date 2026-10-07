import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { useElementScrollRestoration } from '@tanstack/react-router'

import {
  SHEET_HEIGHT,
  SHEET_WIDTH,
  cameraAt,
  nearestSheet,
  progressOf,
  scrollFor,
  scrollForX,
  scrollRange,
  sheetOffset,
  type Camera,
  type PointerMode,
  type Viewport,
} from './camera'
import type { MinimapHandle } from './components/minimap'

/*
  The DOM half of the camera. `camera.ts` decides where the camera is; this hook reads the
  scroll position, eases towards that camera, and writes it to the strip.

  Scrolling is always native — a mouse wheel, a trackpad, a swipe, PageDown and Space all
  work — and an invisible track element provides exactly the scroll range the strip needs.
  The router saves that position per history entry (main.tsx), so a reload or Back opens on
  the sheet you left. Who scrolls depends on the pointer:

  - fine: the DOCUMENT scrolls vertically over a tall track, and the strip sits in a fixed
    stage, moved by a transform.
  - coarse: the STAGE itself scrolls sideways over a wide track, with the strip inside it, so a
    swipe moves the strip natively with no script in the loop. Not the document: a document
    wider than a phone makes mobile browsers zoom out to fit it, and the only way to stop
    that is `user-scalable=no` (the reference does), which takes pinch-zoom away from
    everyone who needs it.
*/

/** Names the touch stage for the router's scroll restoration, instead of a DOM path. */
export const STAGE_ID = 'index-stage'

/** Keys the browser scrolls the page with: pressing one takes over from a glide. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown'])

function subscribeResize(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => {
    window.removeEventListener('resize', onChange)
  }
}

function mediaStore(query: string) {
  return {
    subscribe: (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => {
        list.removeEventListener('change', onChange)
      }
    },
    matches: () => window.matchMedia(query).matches,
  }
}

const coarsePointer = mediaStore('(pointer: coarse)')
const reducedMotion = mediaStore('(prefers-reduced-motion: reduce)')

function readScroll(mode: PointerMode, stage: HTMLElement | null): number {
  return mode === 'fine' ? window.scrollY : (stage?.scrollLeft ?? 0)
}

function scrollToOffset(
  offset: number,
  mode: PointerMode,
  stage: HTMLElement | null,
  behavior: ScrollBehavior,
) {
  if (mode === 'fine') window.scrollTo({ top: offset, behavior })
  else stage?.scrollTo({ left: offset, behavior })
}

/** A wheel delta in pixels. Firefox counts a mouse wheel in lines; 40 px makes a notch ~120 px. */
function wheelPixels(delta: number, event: WheelEvent): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * 40 : delta
}

interface PaintContext {
  readonly viewport: Viewport
  readonly mode: PointerMode
  readonly count: number
  readonly firstLink: number
}

/** Write one camera position to the DOM. Called once per animation frame at most. */
function paint(
  strip: HTMLDivElement,
  minimap: MinimapHandle | null,
  camera: Camera,
  context: PaintContext,
) {
  const { viewport, mode, count, firstLink } = context
  const k = camera.scale
  // On touch the browser scrolls the strip; the transform only places the first sheet.
  const left = viewport.width / 2 - (mode === 'fine' ? camera.x : SHEET_WIDTH / 2) * k
  const top = viewport.height / 2 - (SHEET_HEIGHT / 2) * k
  strip.style.transform = `translate3d(${String(left)}px, ${String(top)}px, 0) scale(${String(k)})`
  strip.style.setProperty('--k', String(k))

  const nearest = nearestSheet(camera.x, count)
  Array.from(strip.children).forEach((child, index) => {
    const sheet = child as HTMLElement
    const active = String(index === nearest)
    if (sheet.dataset.active !== active) sheet.dataset.active = active
  })

  const resting = Math.abs(sheetOffset(nearest, camera.x)) < 0.12
  minimap?.update(progressOf(camera.x, count), resting && nearest >= firstLink)
}

export interface IndexCamera {
  readonly mode: PointerMode
  /** Size of the invisible element that provides the scroll range (see the note above). */
  readonly track: { readonly width: number; readonly height: number }
  /** The fixed viewport the strip is seen through; on touch it is also the scroller. */
  readonly stage: RefObject<HTMLDivElement | null>
  readonly strip: RefObject<HTMLDivElement | null>
  readonly minimap: RefObject<MinimapHandle | null>
  /** Centre sheet `index`. */
  goTo: (index: number) => void
  /** Centre the sheet nearest a point along the strip, 0…1 — never the gap between two. */
  seek: (progress: number) => void
  /** The sheet the camera is heading for — what arrow keys count from. */
  current: () => number
}

/**
 * @param initialSheet where to open the strip on mount — coming back from the grid, the sheet
 *   that was in front before. `null` on a page load, which opens where the router saved the
 *   position (a reload, Back), or else on the first sheet.
 * @param inset the px at the top of the window that the site header takes. The stage starts
 *   below them, so the camera frames the window less that band. The header sits in the
 *   document's flow above the scroll track, and the track is shorter by as much, so the scroll
 *   range is still exactly the strip's.
 */
export function useIndexCamera(
  count: number,
  firstLink: number,
  initialSheet: number | null = null,
  inset = 0,
): IndexCamera {
  const mode: PointerMode = useSyncExternalStore(
    coarsePointer.subscribe,
    coarsePointer.matches,
    () => false,
  )
    ? 'coarse'
    : 'fine'
  const reduced = useSyncExternalStore(reducedMotion.subscribe, reducedMotion.matches, () => false)
  const width = useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1440,
  )
  const height = useSyncExternalStore(
    subscribeResize,
    () => window.innerHeight - inset,
    () => 900 - inset,
  )

  const stage = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const minimap = useRef<MinimapHandle>(null)
  /** The camera as last painted — eased, so it can lag the scroll position. */
  const shown = useRef<Camera | null>(null)
  /**
   * Where the scroll position puts the camera, in design units, before easing. A resize
   * re-places the strip from this: not from the painted camera, which lags, and not from the
   * scroll offset, which is in the old viewport's pixels.
   */
  const aim = useRef<number | null>(null)
  /**
   * The sheet a `goTo` is gliding to, until it arrives or the user scrolls. A smooth scroll
   * takes up to a second, and a key pressed meanwhile must count from where the camera is
   * going, not from wherever it has got to.
   */
  const heading = useRef<number | null>(null)

  /*
    The router saves the scroll position per history entry and restores it once the route has
    rendered — after this camera has painted the first sheet, so it would then glide past
    every sheet in between. Read the saved position on mount instead, and open there before
    the first paint.
  */
  const saved = useElementScrollRestoration(
    mode === 'fine' ? { getElement: () => window } : { id: STAGE_ID },
  )
  const [restoreTo] = useState(saved ? (mode === 'fine' ? saved.scrollY : saved.scrollX) : null)

  const range = scrollRange(count, { width, height }, mode)
  const track =
    mode === 'fine' ? { width: 1, height: height + range } : { width: width + range, height: 1 }
  const behavior: ScrollBehavior = reduced ? 'instant' : 'smooth'

  /*
    Before paint, on mount and whenever the geometry changes: put the camera where it was in
    the strip (a resize changes how many pixels of scroll a sheet is worth), and paint
    synchronously so the strip never shows a frame at its unscaled 1200 px design size.
  */
  useLayoutEffect(() => {
    const element = strip.current
    if (!element) return
    const viewport = { width, height }
    if (aim.current !== null) {
      scrollToOffset(scrollForX(aim.current, count, viewport, mode), mode, stage.current, 'instant')
      // That instant scroll cancels a glide in flight: send it on again, at the new scale.
      if (heading.current !== null) {
        const offset = scrollFor(heading.current, count, viewport, mode)
        scrollToOffset(offset, mode, stage.current, behavior)
      }
    } else if (initialSheet !== null) {
      scrollToOffset(scrollFor(initialSheet, count, viewport, mode), mode, stage.current, 'instant')
    } else if (restoreTo !== null) {
      scrollToOffset(restoreTo, mode, stage.current, 'instant')
    }
    const camera = cameraAt(readScroll(mode, stage.current), count, viewport, mode)
    shown.current = camera
    aim.current = camera.x
    paint(element, minimap.current, camera, { viewport, mode, count, firstLink })
  }, [width, height, mode, count, firstLink, initialSheet, restoreTo, behavior])

  useEffect(() => {
    const viewport = { width, height }
    const context = { viewport, mode, count, firstLink }
    const source: Window | HTMLDivElement | null = mode === 'fine' ? window : stage.current
    let frame = 0
    /** The previous tick's timestamp, or -1 when a run of ticks is just starting. */
    let last = -1

    const tick = (now: number) => {
      frame = 0
      const element = strip.current
      if (!element) return
      const scroll = readScroll(mode, stage.current)
      if (
        heading.current !== null &&
        Math.abs(scroll - scrollFor(heading.current, count, viewport, mode)) < 1
      ) {
        heading.current = null
      }
      const target = cameraAt(scroll, count, viewport, mode)
      aim.current = target.x
      let next = target
      // Ease only where script moves the strip. On touch the browser already scrolled it.
      if (mode === 'fine' && !reduced && shown.current) {
        const from = shown.current
        // A run's first tick counts as one whole frame. Its `now` is the frame's start, which
        // comes before the scroll event that asked for it: measured from that event, the step
        // would be zero and the frame wasted.
        const elapsed = last < 0 ? 1000 / 60 : Math.max(0, now - last)
        const blend = 1 - Math.exp(-elapsed / 80)
        next = {
          x: from.x + (target.x - from.x) * blend,
          scale: from.scale + (target.scale - from.scale) * blend,
        }
        if (Math.abs(target.x - next.x) < 0.5 && Math.abs(target.scale - next.scale) < 1e-4)
          next = target
      }
      last = now
      shown.current = next
      paint(element, minimap.current, next, context)
      if (next !== target) frame = requestAnimationFrame(tick)
    }

    const request = () => {
      if (frame !== 0) return
      last = -1
      frame = requestAnimationFrame(tick)
    }

    const onWheel = (event: WheelEvent) => {
      // The user is scrolling: a glide that a key or the ruler started is over.
      heading.current = null
      // A trackpad pinch arrives as a ctrl+wheel; that is the browser's zoom, not travel.
      if (event.ctrlKey) return
      // A sideways swipe has nowhere to go on a page that scrolls vertically, nor a vertical
      // one on a stage that scrolls sideways (a tablet with a trackpad): make either travel.
      if (mode === 'fine' && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        window.scrollBy({ top: wheelPixels(event.deltaX, event), behavior: 'instant' })
      } else if (mode === 'coarse' && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        stage.current?.scrollBy({ left: wheelPixels(event.deltaY, event), behavior: 'instant' })
      }
    }

    // A touch or a click takes over from a glide too. Captured, so this runs before the
    // ruler's own handler, which may start a new glide of its own.
    const onPointerDown = () => {
      heading.current = null
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) heading.current = null
    }

    source?.addEventListener('scroll', request, { passive: true })
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    window.addEventListener('keydown', onKeyDown)
    request()
    return () => {
      source?.removeEventListener('scroll', request)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('keydown', onKeyDown)
      cancelAnimationFrame(frame)
    }
  }, [width, height, mode, count, firstLink, reduced])

  const goTo = useCallback(
    (index: number) => {
      const sheet = Math.min(Math.max(0, index), count - 1)
      heading.current = sheet
      const offset = scrollFor(sheet, count, { width, height }, mode)
      scrollToOffset(offset, mode, stage.current, behavior)
    },
    [count, width, height, mode, behavior],
  )

  const seek = useCallback(
    (progress: number) => {
      goTo(Math.round(progress * (count - 1)))
    },
    [count, goTo],
  )

  const current = useCallback(() => {
    if (heading.current !== null) return heading.current
    const camera = cameraAt(readScroll(mode, stage.current), count, { width, height }, mode)
    return nearestSheet(camera.x, count)
  }, [count, width, height, mode])

  return { mode, track, stage, strip, minimap, goTo, seek, current }
}
