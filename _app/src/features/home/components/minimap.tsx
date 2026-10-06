import { useImperativeHandle, useRef, type PointerEvent, type Ref } from 'react'

export interface MinimapHandle {
  /** `progress` 0…1 along the strip; `lit` when the camera rests on a sheet you can open. */
  update(progress: number, lit: boolean): void
}

/** The widest gap between ticks, and the tracker's width when there is room for it. */
const MAX_GAP = 40
const TRACKER = 30
/** Past this the gaps shrink instead of the ruler growing, down to MIN_GAP. */
const MAX_WIDTH = 320
const MIN_GAP = 14
/** Ticks within this distance of the tracker step aside, so it never sits on a hairline. */
const CLEARANCE = 4

/** Whether a tick at `at` lies under (or too close to) a tracker whose left edge is at `x`. */
export function isUnderTracker(at: number, x: number, tracker: number): boolean {
  return at > x - CLEARANCE && at < x + tracker + CLEARANCE
}

/**
 * The ruler's geometry for `stops` sheets: one tick per sheet, so it counts what the strip
 * holds. Sheet i rests at progress i/(stops-1), which is where its tick sits, and the
 * tracker is never so wide that, resting on one tick, it hides a neighbour as well.
 */
export function rulerLayout(stops: number): { gap: number; tracker: number; width: number } {
  const n = Math.max(1, Math.round(stops))
  const gap =
    n > 1 ? Math.min(MAX_GAP, Math.max(MIN_GAP, Math.floor(MAX_WIDTH / (n - 1)))) : MAX_GAP
  const tracker = Math.min(TRACKER, 2 * (gap - CLEARANCE - 1))
  return { gap, tracker, width: (n - 1) * gap + 1 }
}

/**
 * A ruler with one hairline tick per sheet and a hollow tracker riding it — the strip's
 * scrollbar, since the real one is hidden. The tick under the tracker steps aside; the
 * tracker fills yellow when the camera has come to rest on a sheet you can open.
 *
 * Driven imperatively: it moves on every animation frame, and re-rendering React that often
 * would cost more than the whole camera.
 *
 * It hangs below the site header (`--site-header`), halfway down to the opening sheet. On a
 * short screen — a phone on its side — the sheet reaches up under the ruler, which then
 * drew across the art and took taps meant for the sheet; there it sits at the bottom instead,
 * clear of the layout switch in the corner.
 */
export function Minimap({
  ticks,
  entrance,
  onSeek,
  ref,
}: {
  /** How many sheets the strip holds: one tick each. */
  ticks: number
  /** Fade in with the page's first load, not when the strip returns from the grid. */
  entrance: boolean
  onSeek: (progress: number) => void
  ref: Ref<MinimapHandle>
}) {
  const tracker = useRef<HTMLSpanElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const { gap, tracker: trackerWidth, width } = rulerLayout(ticks)
  // Half a tracker of room each side, so it can centre on the first and last ticks.
  const inset = trackerWidth / 2
  const span = width - 1

  useImperativeHandle(
    ref,
    () => ({
      update(progress, lit) {
        // The tracker's left edge; its centre then lies on the tick at `progress`.
        const x = progress * span
        if (tracker.current) {
          tracker.current.style.transform = `translateX(${String(x)}px)`
          tracker.current.dataset.lit = String(lit)
        }
        const marks = ruler.current?.children
        if (!marks) return
        for (let i = 0; i < marks.length; i++) {
          const hidden = isUnderTracker(inset + i * gap, x, trackerWidth)
          ;(marks[i] as HTMLElement).style.opacity = hidden ? '0' : '1'
        }
      },
    }),
    [span, inset, gap, trackerWidth],
  )

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const progress = span > 0 ? (event.clientX - box.left - inset) / span : 0
    onSeek(Math.min(1, Math.max(0, progress)))
  }

  return (
    <div
      aria-hidden="true"
      onPointerDown={seek}
      className={`short-screen:top-auto short-screen:bottom-6 short-screen:py-1 fixed top-[calc(var(--site-header,0px)_+_2rem)] left-1/2 z-10 -translate-x-1/2 cursor-pointer py-4 ${entrance ? 'motion-safe:animate-sheet-fade' : ''}`}
    >
      <span className="relative block h-[18px]" style={{ width: width + trackerWidth }}>
        <span ref={ruler} className="absolute inset-y-0 flex" style={{ left: inset, gap: gap - 1 }}>
          {Array.from({ length: ticks }, (_, i) => (
            <span
              key={i}
              className="bg-index-rule h-full w-px shrink-0 transition-opacity duration-150"
            />
          ))}
        </span>
        <span
          ref={tracker}
          className="border-index-rule data-[lit=true]:border-index-yellow data-[lit=true]:bg-index-yellow absolute top-0 left-0 h-full border transition-colors duration-300"
          style={{ width: trackerWidth }}
        />
      </span>
    </div>
  )
}
