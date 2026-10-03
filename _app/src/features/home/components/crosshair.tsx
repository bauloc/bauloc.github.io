/**
 * A fixed hairline cross at the centre of the viewport: the camera's reticle. White with
 * `difference` blending, so it reads black on white and on the grey field, and inverts to
 * blue over the yellow circle.
 */
export function Crosshair() {
  return (
    <svg
      aria-hidden="true"
      width={20}
      height={20}
      viewBox="0 0 30 30"
      className="pointer-events-none fixed top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 mix-blend-difference"
    >
      <line x1="15" y1="0" x2="15" y2="30" stroke="white" strokeWidth="1.5" />
      <line x1="0" y1="15" x2="30" y2="15" stroke="white" strokeWidth="1.5" />
    </svg>
  )
}
