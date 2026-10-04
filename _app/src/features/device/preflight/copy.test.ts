import { describe, expect, it } from 'vitest'

import { COPY, FIX, LABELS, LINKS, STATUS_META, bundletoolCommand } from './copy'

/*
  The wording's own rules, checked over every string at once: sentences end like sentences,
  apostrophes are the typographic ones the rest of Device Lab uses, and every fix leads
  somewhere real.
*/

/** Every literal sentence in COPY (the parametrised ones are covered row by row in checks.test.ts). */
function sentences(node: unknown, path = 'COPY'): [string, string][] {
  if (typeof node === 'string') return [[path, node]]
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => sentences(value, `${path}.${key}`))
  }
  return []
}

describe('copy', () => {
  it.each(sentences(COPY))('%s reads as a sentence', (_, text) => {
    // A capital, or a name that starts small (iOS).
    expect(text).toMatch(/^(?:[A-Z“]|iOS\b)/)
    expect(text).toMatch(/[.:]$/)
    expect(text).not.toMatch(/'/)
    expect(text).not.toMatch(/ {2}/)
  })

  it('labels every row and status with typographic apostrophes', () => {
    for (const label of [
      ...Object.values(LABELS),
      ...Object.values(STATUS_META).map((m) => m.label),
    ]) {
      expect(label.trim()).toBe(label)
      expect(label).not.toMatch(/'/)
    }
    expect(Object.values(STATUS_META).map((m) => m.label)).toEqual([
      'OK',
      'Warning',
      'Blocking',
      'Not checked',
    ])
  })

  it('gives every fix a label and a target that leads somewhere', () => {
    for (const fix of Object.values(FIX)) {
      expect(fix.label).not.toMatch(/'/)
      if ('href' in fix) expect(fix.href).toMatch(/^(https:\/\/|http:\/\/127\.0\.0\.1:8787\/)/)
      if ('copy' in fix) expect(fix.copy.trim()).toBe(fix.copy)
      // A path starts where the tester opens it: the phone's or browser's settings, or Windows'.
      if ('path' in fix) expect(fix.path).toMatch(/^(Settings|Site controls|Device Manager)\b.* → /)
    }
    for (const link of Object.values(LINKS)) expect(() => new URL(link)).not.toThrow()
  })
})

describe('bundletoolCommand', () => {
  it.each<[string, string | undefined, string]>([
    [
      'no file name',
      undefined,
      'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ],
    [
      'a plain name',
      'shop-release_1.4.0.aab',
      'bundletool build-apks --bundle=shop-release_1.4.0.aab --output=shop-release_1.4.0.apks --mode=universal',
    ],
    [
      'an upper-case extension',
      'Shop.AAB',
      'bundletool build-apks --bundle=Shop.AAB --output=Shop.apks --mode=universal',
    ],
    [
      'a name with spaces',
      'My App (2).aab',
      'bundletool build-apks --bundle="My App (2).aab" --output="My App (2).apks" --mode=universal',
    ],
    [
      'a name in Vietnamese',
      'ứng dụng.aab',
      'bundletool build-apks --bundle="ứng dụng.aab" --output="ứng dụng.apks" --mode=universal',
    ],
    [
      'a name a shell would expand',
      'build$HOME.aab',
      'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ],
    [
      'a name with a backtick',
      'a`whoami`.aab',
      'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ],
    [
      'a name with a double quote',
      'a"b.aab',
      'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ],
    [
      'a file that is not an .aab',
      'app.apks',
      'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal',
    ],
  ])('%s', (_, fileName, expected) => {
    expect(bundletoolCommand(fileName)).toBe(expected)
  })
})
