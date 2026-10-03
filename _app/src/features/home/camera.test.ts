import { describe, expect, it } from 'vitest'

import {
  PITCH,
  SHEET_WIDTH,
  cameraAt,
  centreOf,
  focusScale,
  nearestSheet,
  progressOf,
  scrollFor,
  scrollForX,
  scrollRange,
  sheetOffset,
  travelScale,
} from './camera'

const desktop = { width: 1440, height: 900 }
const phone = { width: 390, height: 844 }

describe('scales match what was measured on the reference', () => {
  it('a 1440 × 900 window focuses at 0.882 and browses at 0.6', () => {
    expect(focusScale(desktop)).toBeCloseTo(0.8825, 3)
    expect(travelScale(desktop, 'fine')).toBeCloseTo(0.6, 2)
  })

  it('a phone is limited by width: the sheet spans the screen less 15 px a side', () => {
    expect(focusScale(phone) * SHEET_WIDTH).toBeCloseTo(phone.width - 30, 5)
  })

  it('touch never zooms out to browse', () => {
    expect(travelScale(phone, 'coarse')).toBe(focusScale(phone))
  })

  it('never collapses to zero in a degenerate window', () => {
    expect(focusScale({ width: 0, height: 0 })).toBeGreaterThan(0)
  })
})

describe('cameraAt', () => {
  it('starts centred on the first sheet at the focused scale', () => {
    const cam = cameraAt(0, 6, desktop, 'fine')
    expect(cam.x).toBe(centreOf(0))
    expect(cam.scale).toBeCloseTo(focusScale(desktop), 6)
  })

  it('has zoomed out fully by the time the second sheet is centred, and holds there', () => {
    const second = cameraAt(scrollFor(1, 6, desktop, 'fine'), 6, desktop, 'fine')
    expect(second.x).toBeCloseTo(centreOf(1), 6)
    expect(second.scale).toBeCloseTo(travelScale(desktop, 'fine'), 6)

    const last = cameraAt(scrollRange(6, desktop, 'fine'), 6, desktop, 'fine')
    expect(last.scale).toBeCloseTo(travelScale(desktop, 'fine'), 6)
  })

  it('moves one screen pixel per pixel of scroll once zoomed out', () => {
    const a = cameraAt(2000, 6, desktop, 'fine')
    const b = cameraAt(2100, 6, desktop, 'fine')
    expect((b.x - a.x) * b.scale).toBeCloseTo(100, 6)
  })

  it('clamps at both ends instead of travelling past the strip', () => {
    expect(cameraAt(-500, 6, desktop, 'fine').x).toBe(centreOf(0))
    expect(cameraAt(1e9, 6, desktop, 'fine').x).toBeCloseTo(centreOf(5), 6)
  })

  it('on touch keeps a constant scale', () => {
    const scales = [0, 300, 900].map((s) => cameraAt(s, 6, phone, 'coarse').scale)
    expect(new Set(scales).size).toBe(1)
  })
})

describe('scroll positions', () => {
  it('scrollFor centres every sheet exactly', () => {
    for (let i = 0; i < 6; i++) {
      expect(cameraAt(scrollFor(i, 6, desktop, 'fine'), 6, desktop, 'fine').x).toBeCloseTo(
        centreOf(i),
        6,
      )
      expect(cameraAt(scrollFor(i, 6, phone, 'coarse'), 6, phone, 'coarse').x).toBeCloseTo(
        centreOf(i),
        6,
      )
    }
  })

  it('scrollFor clamps an out-of-range index', () => {
    expect(scrollFor(-3, 6, desktop, 'fine')).toBe(0)
    expect(scrollFor(99, 6, desktop, 'fine')).toBe(scrollRange(6, desktop, 'fine'))
  })

  it('scrollForX keeps the same place in the strip across a resize', () => {
    const x = cameraAt(1234, 6, desktop, 'fine').x
    const smaller = { width: 1024, height: 700 }
    expect(cameraAt(scrollForX(x, 6, smaller, 'fine'), 6, smaller, 'fine').x).toBeCloseTo(x, 6)
  })

  it('a single sheet has nowhere to scroll', () => {
    expect(scrollRange(1, desktop, 'fine')).toBe(0)
  })
})

describe('reading the camera', () => {
  it('nearestSheet rounds to the closest centre and stays in range', () => {
    expect(nearestSheet(centreOf(2) + PITCH * 0.4, 6)).toBe(2)
    expect(nearestSheet(centreOf(2) + PITCH * 0.6, 6)).toBe(3)
    expect(nearestSheet(-1e6, 6)).toBe(0)
    expect(nearestSheet(1e6, 6)).toBe(5)
  })

  it('sheetOffset is 0 when centred, signed by side, and clamped to one sheet', () => {
    expect(sheetOffset(2, centreOf(2))).toBe(0)
    expect(sheetOffset(3, centreOf(2))).toBe(1)
    expect(sheetOffset(1, centreOf(2))).toBe(-1)
    expect(sheetOffset(5, centreOf(0))).toBe(1)
  })

  it('progress runs 0 → 1 from the first sheet to the last', () => {
    expect(progressOf(centreOf(0), 6)).toBe(0)
    expect(progressOf(centreOf(5), 6)).toBe(1)
    expect(progressOf(centreOf(0), 1)).toBe(0)
  })
})
