/**
 * A fixed hairline cross at the centre of the stage — the window below the site header
 * (`--site-header`) — which is where the camera centres its sheet: its reticle. White with
 * `difference` blending, so it reads black on white and on the grey field, and inverts to
 * blue over the yellow circle.
 *
 * `crispEdges`, because the viewport centre falls on a pixel boundary: anti-aliased, each
 * 1 px arm was spread over two pixels at half strength, and a half-strength difference
 * reads as grey everywhere — no black, no blue — on any 1x display.
 */
export function Crosshair() {
  return (
    <svg
      aria-hidden="true"
      width={20}
      height={20}
      viewBox="0 0 30 30"
      shapeRendering="crispEdges"
      className="pointer-events-none fixed top-[calc(50%_+_var(--site-header,0px)/2)] left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 mix-blend-difference"
    >
      <line x1="15" y1="0" x2="15" y2="30" stroke="white" strokeWidth="1.5" />
      <line x1="0" y1="15" x2="30" y2="15" stroke="white" strokeWidth="1.5" />
    </svg>
  )
}
