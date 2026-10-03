import { describe, expect, it } from 'vitest'

import { androidDetail } from './backends/android'
import { DETAIL_FIXTURES } from './backends/fixtures'
import { classifyUsbError } from './backends/webusb'
import {
  STATE_META,
  detailMarkdown,
  fmtBytes,
  fmtClock,
  fmtDateTime,
  fmtIsoOffset,
  hintFor,
  normalizeDevice,
  shotFilename,
  sortDevices,
  type Device,
  type DeviceState,
} from './model'
import parity from './parity.json'

/*
  PARITY with the hand-written Device Lab this port replaced. Its scripts (device/js/*.js,
  removed with the port, still in git history) were verified against a real Pixel 9. Before
  they went, they were run in a node:vm context on exactly these inputs and their answers
  saved in parity.json, so no expected value here was typed by hand: the detail parser, the
  Markdown, the sort, the hints, the error classification, the file names and the formatters.

  Times are local, and vite.config.ts runs the tests in the zone the answers were recorded in.
*/

describe('parity with the legacy Device Lab', () => {
  it.each(Object.keys(DETAIL_FIXTURES))(
    'reads the %s detail exactly as the legacy page did',
    (key) => {
      const fixture = DETAIL_FIXTURES[key]!
      expect(androidDetail(fixture.outputs, fixture.serial)).toEqual(
        parity.detail[key as keyof typeof parity.detail],
      )
    },
  )

  it('copies the same Markdown, Captured line aside', () => {
    const detail = androidDetail(DETAIL_FIXTURES['pixel-9']!.outputs, '55090DLAQ0026D')
    const lines = detailMarkdown(detail, new Date()).split('\n')
    expect(lines.filter((l) => !l.startsWith('| Captured |'))).toEqual(parity.markdown)
    expect(lines.at(-1)).toMatch(/^\| Captured \| \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \|$/)
  })

  it('sorts devices in the same order', () => {
    const states = Object.keys(STATE_META) as DeviceState[]
    const devices = states.flatMap((state, i) => [
      normalizeDevice({ id: `b${String(i)}`, backend: 'mock', name: `Bravo ${state}`, state }),
      normalizeDevice({ id: `a${String(i)}`, backend: 'mock', name: `Alpha ${state}`, state }),
    ])
    expect(sortDevices(devices).map((d) => d.id)).toEqual(parity.sorted)
  })

  it('normalizes devices the same way, unknown states included', () => {
    for (const { input, output } of parity.normalized) {
      expect(normalizeDevice(input as unknown as Device)).toEqual(output)
    }
  })

  it('names the same fix for every blocker', () => {
    const codes = Object.keys(parity.hints)
    expect(codes.length).toBeGreaterThan(10)
    for (const code of codes) {
      const device = normalizeDevice({ id: 'd', backend: 'webusb', blockers: [code] })
      expect(hintFor(device)).toEqual(parity.hints[code as keyof typeof parity.hints])
    }
  })

  it('classifies a failed connection the same way', () => {
    for (const { error, output } of parity.classify) {
      const e = Object.assign(new Error(error.message), 'name' in error ? { name: error.name } : {})
      expect(classifyUsbError(e)).toEqual(output)
    }
  })

  it('formats sizes, clocks, dates and file names the same way', () => {
    const f = parity.formats
    const [y, mo, d, h, mi, s] = f.at as [number, number, number, number, number, number]
    const at = new Date(y, mo, d, h, mi, s)
    for (const [n, text] of f.bytes as [number, string][]) expect(fmtBytes(n)).toBe(text)
    expect(fmtClock(at)).toBe(f.clock)
    expect(fmtDateTime(at)).toBe(f.dateTime)
    expect(fmtIsoOffset(at)).toBe(f.isoOffset)
    // One deliberate divergence: the legacy name wrote a +07:00 offset as "-07-00".
    for (const { device, output } of f.shotFilenames) {
      expect(shotFilename(device, at)).toBe(output.replace(/-(\d\d-\d\d)\.png$/, '+$1.png'))
    }
  })
})
