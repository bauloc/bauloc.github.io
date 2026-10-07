import { encode } from 'uqr'
import { describe, expect, it } from 'vitest'

import { qrPath, qrSvg } from './qr'

const URL = 'https://bauloc.github.io/build/k3x9q2mf/'

/** Draws a path back into modules, checking on the way that it holds nothing but runs. */
function rasterise(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const RUN = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/y
  let at = 0
  while (at < path.length) {
    RUN.lastIndex = at
    const match = RUN.exec(path)
    if (!match) throw new Error(`Not a run at ${String(at)}: ${path.slice(at, at + 24)}`)
    const [, x, y, width, back] = match.map(Number)
    expect(back).toBe(width)
    for (let i = 0; i < width!; i++) {
      const row = grid[y!]!
      expect(row[x! + i], `module ${String(x! + i)},${String(y)} drawn twice`).toBe(false)
      row[x! + i] = true
    }
    at = RUN.lastIndex
  }
  return grid
}

describe('qrPath', () => {
  for (const text of [
    URL,
    'https://bauloc.github.io/build/a/',
    'Cài đặt bản build 😀',
    'x'.repeat(300),
  ]) {
    it(`draws exactly uqr's modules for ${JSON.stringify(text.slice(0, 40))}`, () => {
      const { data } = encode(text, { ecc: 'M', border: 0 })
      const { size, path } = qrPath(text)
      expect(size).toBe(data.length + 8)
      const grid = rasterise(path, size)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const inside = x >= 4 && y >= 4 && x < size - 4 && y < size - 4
          const expected = inside ? data[y - 4]![x - 4]! : false
          expect(grid[y]![x], `module ${String(x)},${String(y)}`).toBe(expected)
        }
      }
    })
  }

  it('leaves a quiet zone of four modules on every side', () => {
    const { size, path } = qrPath(URL)
    const grid = rasterise(path, size)
    const ring = (i: number) => i < 4 || i >= size - 4
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (ring(x) || ring(y)) expect(grid[y]![x]).toBe(false)
      }
    }
    // The finder pattern's corner sits right inside it.
    expect(grid[4]![4]).toBe(true)
  })

  it('merges each row into maximal runs, so no two runs touch', () => {
    const { path } = qrPath(URL)
    const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].map((m) => m.slice(1).map(Number))
    for (let i = 1; i < runs.length; i++) {
      const [x, y] = runs[i]!
      const [px, py, pw] = runs[i - 1]!
      if (y === py) expect(x).toBeGreaterThan(px! + pw!)
    }
  })

  it('is deterministic', () => {
    expect(qrPath(URL)).toEqual(qrPath(URL))
    expect(qrSvg(URL)).toBe(qrSvg(URL))
  })
})

describe('qrSvg', () => {
  it('is a crisp, labelled, black-on-white SVG sized by its viewBox', () => {
    const { size, path } = qrPath(URL)
    const svg = qrSvg(URL)
    const side = String(size)
    expect(svg).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
        `<rect width="${side}" height="${side}" fill="white"/><path d="${path}" fill="black"/></svg>`,
    )
    expect(svg.match(/<path /g)).toHaveLength(1)
    // No size of its own: the page or the dialog that shows it decides how big it is.
    const open = svg.slice(0, svg.indexOf('>') + 1)
    expect(open).not.toMatch(/\s(?:width|height)=/)
  })
})
