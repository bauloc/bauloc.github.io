import { encode } from 'uqr'

/*
  The QR codes a build is shared with: on its install page, for a tester at a desk to scan with
  their phone, and in the console's QR dialog. Drawn as ONE path of horizontal runs rather than
  a square per module, which keeps a link's code to a few kilobytes of markup, and with
  `crispEdges` so no browser anti-aliases the seams between runs into faint grey lines.
*/

/** The light margin around the code, in modules: the four ISO/IEC 18004 asks readers to get. */
const QUIET_ZONE = 4

/** A QR code as one SVG path. */
export interface QrPath {
  /** Modules per side, the 4-module quiet zone included: the SVG's viewBox is 0 0 size size. */
  readonly size: number
  /** Every dark module, as one path of merged runs. */
  readonly path: string
}

/**
 * `text` as a QR code at error correction M, which survives a smudged screen or a glare spot
 * (15% of the code) while keeping a build's link at a size phones read from a metre away.
 */
export function qrPath(text: string): QrPath {
  const { data } = encode(text, { ecc: 'M', border: 0 })
  let path = ''
  data.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (row[x]) x++
      const run = String(x - start)
      path += `M${String(start + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h${run}v1h-${run}z`
    }
  })
  return { size: data.length + 2 * QUIET_ZONE, path }
}

/**
 * The same code as a standalone SVG element, black on white whatever the page's theme: a white
 * ground is part of the code (its quiet zone), and phone cameras read dark-on-light codes best.
 * It has no width or height, so it takes the size its container gives it.
 */
export function qrSvg(text: string): string {
  const { size, path } = qrPath(text)
  const side = String(size)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${side}" height="${side}" fill="white"/><path d="${path}" fill="black"/></svg>`
  )
}
