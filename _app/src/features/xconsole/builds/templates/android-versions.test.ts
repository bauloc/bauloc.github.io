import { describe, expect, it } from 'vitest'

import { androidRelease, apiLevel } from './android-versions'

describe('androidRelease', () => {
  it('names every level from Ice Cream Sandwich to Android 16', () => {
    expect(androidRelease('14')).toBe('Android 4.0 (API 14)')
    expect(androidRelease(15)).toBe('Android 4.0.3 (API 15)')
    // What apps built with older Flutter or React Native defaults still declare.
    expect(androidRelease('16')).toBe('Android 4.1 (API 16)')
    expect(androidRelease('19')).toBe('Android 4.4 (API 19)')
    expect(androidRelease(20)).toBe('Android 4.4W (API 20)')
    expect(androidRelease('21')).toBe('Android 5.0 (API 21)')
    expect(androidRelease('24')).toBe('Android 7.0 (API 24)')
    expect(androidRelease(28)).toBe('Android 9 (API 28)')
    expect(androidRelease(32)).toBe('Android 12L (API 32)')
    expect(androidRelease(35)).toBe('Android 15 (API 35)')
    expect(androidRelease('36')).toBe('Android 16 (API 36)')
    for (let level = 14; level <= 36; level++) {
      expect(androidRelease(level)).toMatch(new RegExp(`^Android \\S+ \\(API ${String(level)}\\)$`))
    }
  })

  it('shows a level it has no name for as the level alone', () => {
    expect(androidRelease('13')).toBe('API 13')
    expect(androidRelease(1)).toBe('API 1')
    expect(androidRelease(37)).toBe('API 37')
  })

  it('shows nothing for what is not a level', () => {
    for (const value of ['', '0', '-1', '24.0', 'abc', '<b>', '1000', 'constructor']) {
      expect(androidRelease(value), value).toBe('')
    }
    expect(apiLevel(' 24 ')).toBe(24)
    expect(apiLevel(Number.NaN)).toBeNull()
  })
})
