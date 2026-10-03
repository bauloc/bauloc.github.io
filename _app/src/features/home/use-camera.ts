import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react'

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

  Scrolling is always native — a mouse wheel, a trackpad, PageDown, Space and scroll
  restoration all work for free — and an invisible track element provides exactly the scroll
  range the strip needs. Who scrolls depends on the pointer:

  - fine: the DOCUMENT scrolls vertically over a tall track, and the strip sits in a fixed
    stage, moved by a transform.
  - coarse: the STAGE itself scrolls sideways over a wide track, with the strip inside it, so a
    swipe moves the strip natively with no script in the loop. Not the document: a document
    wider than a phone makes mobile browsers zoom out to fit it, and the only way to stop
    that is `user-scalable=no` (the reference does), which takes pinch-zoom away from
    everyone who needs it.
*/

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
  /** Jump to a point along the strip, 0…1. */
  seek: (progress: number) => void
  /** The sheet the camera is heading for — what arrow keys count from. */
  current: () => number
}

/**
 * @param initialSheet where to open the strip on mount — coming back from the grid, the sheet
 *   that was in front before; otherwise 0, and the browser's own scroll restoration applies.
 */
export function useIndexCamera(count: number, firstLink: number, initialSheet = 0): IndexCamera {
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
    () => window.innerHeight,
    () => 900,
  )

  const stage = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const minimap = useRef<MinimapHandle>(null)
  /** The camera as last painted — eased, so it can lag the scroll position. */
  const shown = useRef<Camera | null>(null)

  const range = scrollRange(count, { width, height }, mode)
  const track =
    mode === 'fine' ? { width: 1, height: height + range } : { width: width + range, height: 1 }

  /*
    Before paint, on mount and whenever the geometry changes: put the camera where it was in
    the strip (a resize changes how many pixels of scroll a sheet is worth), and paint
    synchronously so the strip never shows a frame at its unscaled 1200 px design size.
  */
  useLayoutEffect(() => {
    const element = strip.current
    if (!element) return
    const viewport = { width, height }
    const previous = shown.current
    if (previous) {
      const offset = scrollForX(previous.x, count, viewport, mode)
      scrollToOffset(offset, mode, stage.current, 'instant')
    } else if (initialSheet > 0) {
      scrollToOffset(scrollFor(initialSheet, count, viewport, mode), mode, stage.current, 'instant')
    }
    const camera = cameraAt(readScroll(mode, stage.current), count, viewport, mode)
    shown.current = camera
    paint(element, minimap.current, camera, { viewport, mode, count, firstLink })
  }, [width, height, mode, count, firstLink, initialSheet])

  useEffect(() => {
    const viewport = { width, height }
    const context = { viewport, mode, count, firstLink }
    const source: Window | HTMLDivElement | null = mode === 'fine' ? window : stage.current
    let frame = 0
    let last = 0

    const tick = (now: number) => {
      frame = 0
      const element = strip.current
      if (!element) return
      const target = cameraAt(readScroll(mode, stage.current), count, viewport, mode)
      let next = target
      // Ease only where script moves the strip. On touch the browser already scrolled it.
      if (mode === 'fine' && !reduced && shown.current) {
        const from = shown.current
        const blend = 1 - Math.exp(-Math.max(0, now - last) / 80)
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
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }

    // A sideways trackpad swipe has nowhere to go on a page that scrolls vertically: make it travel.
    const onWheel = (event: WheelEvent) => {
      if (mode === 'fine' && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        window.scrollBy({ top: event.deltaX, behavior: 'instant' })
      }
    }

    source?.addEventListener('scroll', request, { passive: true })
    window.addEventListener('wheel', onWheel, { passive: true })
    request()
    return () => {
      source?.removeEventListener('scroll', request)
      window.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame)
    }
  }, [width, height, mode, count, firstLink, reduced])

  const behavior: ScrollBehavior = reduced ? 'instant' : 'smooth'

  const goTo = useCallback(
    (index: number) => {
      const offset = scrollFor(index, count, { width, height }, mode)
      scrollToOffset(offset, mode, stage.current, behavior)
    },
    [count, width, height, mode, behavior],
  )

  const seek = useCallback(
    (progress: number) => {
      const offset = progress * scrollRange(count, { width, height }, mode)
      scrollToOffset(offset, mode, stage.current, behavior)
    },
    [count, width, height, mode, behavior],
  )

  const current = useCallback(() => {
    const camera = cameraAt(readScroll(mode, stage.current), count, { width, height }, mode)
    return nearestSheet(camera.x, count)
  }, [count, width, height, mode])

  return { mode, track, stage, strip, minimap, goTo, seek, current }
}
