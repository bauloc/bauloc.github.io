import { describe, expect, it } from 'vitest'

import { pixelDrawing } from './pixels'

describe('pixelDrawing', () => {
  it('draws each mark as its own layer, one run of cells per subpath', () => {
    const drawing = pixelDrawing(['.##.', '#..#', '.oo.'])
    expect(drawing.width).toBe(4)
    expect(drawing.height).toBe(3)
    expect([...drawing.layers.keys()]).toEqual(['#', 'o'])
    expect(drawing.layers.get('#')).toBe('M1 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1z')
    expect(drawing.layers.get('o')).toBe('M1 2h2v1h-2z')
  })

  it('leaves the dots empty, and a row that is all dots draws nothing', () => {
    const drawing = pixelDrawing(['....', '#...'])
    expect(drawing.layers.get('#')).toBe('M0 1h1v1h-1z')
    expect(drawing.layers.has('.')).toBe(false)
  })
})
