import { describe, expect, it } from 'vitest'

import { formatBytes, formatDateTime } from './format'

describe('formatBytes', () => {
  it('counts in 1024s with one decimal below 100', () => {
    expect(formatBytes(0, 'en')).toBe('0 B')
    expect(formatBytes(1023, 'en')).toBe('1,023 B')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatBytes(24_537_088, 'en')).toBe('23.4 MB')
    expect(formatBytes(100 * 1024 * 1024, 'en')).toBe('100 MB')
    expect(formatBytes(1024 ** 3, 'en')).toBe('1.0 GB')
  })

  it('writes a Vietnamese decimal comma', () => {
    expect(formatBytes(24_537_088, 'vi')).toBe('23,4 MB')
  })

  it('says nothing it cannot know', () => {
    expect(formatBytes(Number.NaN, 'en')).toBe('—')
    expect(formatBytes(-1, 'en')).toBe('—')
  })
})

describe('formatDateTime', () => {
  // The suite runs in Asia/Ho_Chi_Minh (vite.config.ts), UTC+7.
  it('writes local time the way the console writes dates', () => {
    expect(formatDateTime('2026-10-07T01:15:00Z', 'en')).toBe('07-Oct-2026 08:15')
    expect(formatDateTime('2026-10-07T01:15:00Z', 'vi')).toBe('07/10/2026 08:15')
  })

  it('is empty for anything that is not a time', () => {
    expect(formatDateTime('', 'en')).toBe('')
    expect(formatDateTime('soon', 'vi')).toBe('')
  })
})
