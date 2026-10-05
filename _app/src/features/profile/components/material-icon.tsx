/*
  The game view's close icon as the Flutter build drew it, taken from the glyphs of its own
  tree-shaken MaterialIcons-Regular.otf (Material Icons, Apache 2.0) and rescaled to a 24 px
  box — the same shape the old profile showed, not a look-alike from another icon set.
*/
const PATHS = {
  close:
    'M18.98 6.42 17.58 5.02 12 10.59 6.42 5.02 5.02 6.42 10.59 12 5.02 17.58 6.42 18.98 12 13.41 17.58 18.98 18.98 17.58 13.41 12 18.98 6.42Z',
} as const

export type MaterialIconName = keyof typeof PATHS

/** Decorative: whatever it sits in carries the accessible name. */
export function MaterialIcon({
  name,
  size = 24,
  className,
}: {
  name: MaterialIconName
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
