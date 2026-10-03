import { useImperativeHandle, useRef, type PointerEvent, type Ref } from 'react'

export interface MinimapHandle {
  /** `progress` 0…1 along the strip; `lit` when the camera rests on a sheet you can open. */
  update(progress: number, lit: boolean): void
}

const TICK_GAP = 10 // 1 px tick + 9 px space, as measured on the reference
const TRACKER = 30

/** The reference draws ~2.5 ticks per sheet; past a few dozen sheets the ruler stops growing. */
export function tickCount(sheets: number): number {
  return Math.min(48, Math.max(14, Math.round(sheets * 3 + 2)))
}

/**
 * A ruler of hairline ticks with a hollow tracker riding it — the strip's scrollbar, since the
 * real one is hidden. Ticks under the tracker step aside; the tracker fills yellow when the
 * camera has come to rest on a sheet you can open.
 *
 * Driven imperatively: it moves on every animation frame, and re-rendering React that often
 * would cost more than the whole camera.
 */
export function Minimap({
  ticks,
  entrance,
  onSeek,
  ref,
}: {
  ticks: number
  /** Fade in with the page's first load, not when the strip returns from the grid. */
  entrance: boolean
  onSeek: (progress: number) => void
  ref: Ref<MinimapHandle>
}) {
  const tracker = useRef<HTMLSpanElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const width = ticks * TICK_GAP - (TICK_GAP - 1)

  useImperativeHandle(
    ref,
    () => ({
      update(progress, lit) {
        const x = progress * (width - TRACKER)
        if (tracker.current) {
          tracker.current.style.transform = `translateX(${String(x)}px)`
          tracker.current.dataset.lit = String(lit)
        }
        const marks = ruler.current?.children
        if (!marks) return
        for (let i = 0; i < marks.length; i++) {
          const at = i * TICK_GAP
          const hidden = at > x - 4 && at < x + TRACKER + 4
          ;(marks[i] as HTMLElement).style.opacity = hidden ? '0' : '1'
        }
      },
    }),
    [width],
  )

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const progress = (event.clientX - box.left - TRACKER / 2) / (width - TRACKER)
    onSeek(Math.min(1, Math.max(0, progress)))
  }

  return (
    <div
      aria-hidden="true"
      onPointerDown={seek}
      className={`fixed top-12 left-1/2 z-10 -translate-x-1/2 cursor-pointer py-4 ${entrance ? 'motion-safe:animate-sheet-fade' : ''}`}
    >
      <span className="relative block h-[18px]" style={{ width }}>
        <span ref={ruler} className="flex h-full gap-[9px]">
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
          style={{ width: TRACKER }}
        />
      </span>
    </div>
  )
}
