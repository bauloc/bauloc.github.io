import { describe, expect, it } from 'vitest'

import { isUnderTracker, rulerLayout } from './minimap'

/** The ticks a tracker resting on sheet `sheet` hides, laid out as Minimap lays them out. */
function hiddenAtRest(stops: number, sheet: number): number[] {
  const { gap, tracker, width } = rulerLayout(stops)
  const progress = stops > 1 ? sheet / (stops - 1) : 0
  const x = progress * (width - 1)
  return Array.from({ length: stops }, (_, i) => i).filter((i) =>
    isUnderTracker(tracker / 2 + i * gap, x, tracker),
  )
}

describe('the minimap ruler', () => {
  it('has one tick per sheet, and resting on a sheet hides exactly that sheet’s tick', () => {
    for (let stops = 1; stops <= 60; stops++) {
      for (let sheet = 0; sheet < stops; sheet++) {
        expect(hiddenAtRest(stops, sheet)).toEqual([sheet])
      }
    }
  })

  it('spreads a short list wide, and packs a long one rather than growing without end', () => {
    expect(rulerLayout(5)).toEqual({ gap: 40, tracker: 30, width: 161 })
    const long = rulerLayout(60)
    expect(long.gap).toBeGreaterThanOrEqual(14)
    expect(long.tracker).toBeLessThan(long.gap * 2)
  })
})
