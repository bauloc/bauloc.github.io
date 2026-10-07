/**
 * The sheets' pixel drawings are written as rows of characters, one character a cell, so a
 * drawing reads in the source the way it looks on the sheet. Every character other than `.`
 * is a mark, and each mark is one layer: one SVG path, painted in one colour.
 */
export interface PixelDrawing {
  readonly width: number
  readonly height: number
  /** Each mark's cells as one path, in cell units: `M x y h w v 1 h -w z` per run. */
  readonly layers: ReadonlyMap<string, string>
}

/** Turn rows of marks into one path per mark, a horizontal run of cells per subpath. */
export function pixelDrawing(rows: readonly string[]): PixelDrawing {
  const width = Math.max(0, ...rows.map((row) => row.length))
  const layers = new Map<string, string>()
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const mark = row.charAt(x)
      let end = x + 1
      while (end < row.length && row.charAt(end) === mark) end += 1
      if (mark !== '.') {
        const run = String(end - x)
        layers.set(mark, `${layers.get(mark) ?? ''}M${String(x)} ${String(y)}h${run}v1h-${run}z`)
      }
      x = end
    }
  })
  return { width, height: rows.length, layers }
}
