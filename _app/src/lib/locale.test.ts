import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { LOCALE_STORAGE_KEY, currentLocale, resolveLocale } from './locale'

describe('resolveLocale', () => {
  it('a saved choice wins over the browser', () => {
    expect(resolveLocale('en', ['vi-VN'])).toBe('en')
    expect(resolveLocale('vi', ['en-US'])).toBe('vi')
  })

  it('with nothing saved, takes the first browser language the site speaks', () => {
    expect(resolveLocale(null, ['vi-VN', 'en-US'])).toBe('vi')
    expect(resolveLocale(null, ['en-GB', 'vi'])).toBe('en')
    expect(resolveLocale(null, ['fr-FR', 'VI'])).toBe('vi')
  })

  it('falls back to English for a browser that speaks neither', () => {
    expect(resolveLocale(null, ['fr-FR', 'de'])).toBe('en')
    expect(resolveLocale(null, [])).toBe('en')
  })

  it('ignores anything else that ended up in storage', () => {
    expect(resolveLocale('vi-VN', ['en'])).toBe('en')
    expect(resolveLocale('', ['vi'])).toBe('vi')
  })
})

describe('currentLocale', () => {
  it('is English where there is no browser', () => {
    expect(currentLocale()).toBe('en')
  })
})

describe('the pre-paint script in index.html', () => {
  const html = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html'),
    'utf8',
  )

  it('reads the same storage key as the app', () => {
    expect(html).toContain(`'${LOCALE_STORAGE_KEY}'`)
  })

  it('sets the language on <html>, as the app does', () => {
    expect(html).toContain('document.documentElement.lang = locale')
  })
})
