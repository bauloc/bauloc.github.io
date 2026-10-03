import { cn } from '@/lib/cn'

/**
 * Material's indeterminate circular progress indicator, in `currentColor`.
 *
 * `size` and `stroke` are in CSS pixels, as Flutter's `CircularProgressIndicator` takes them,
 * and like Flutter the arc runs inside the box: the radius gives up half the stroke.
 */
export function Spinner({
  size,
  stroke,
  className,
}: {
  size: number
  stroke: number
  className?: string
}) {
  return (
    <svg
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn('animate-spinner-turn', className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={(size - stroke) / 2}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="animate-spinner-arc origin-center -rotate-90"
      />
    </svg>
  )
}
