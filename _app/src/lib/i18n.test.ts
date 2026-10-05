// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { defineMessages, localized } from './i18n'
import { setLocale } from './locale'

afterEach(() => {
  setLocale('en')
  window.localStorage.clear()
})

describe('localized', () => {
  const words = localized({
    en: { title: 'Ready', count: (n: number) => `${String(n)} devices`, nested: { ok: 'OK' } },
    vi: { title: 'Sẵn sàng', count: (n: number) => `${String(n)} thiết bị`, nested: { ok: 'Ổn' } },
  })

  it('reads as the language on screen at each access', () => {
    expect(words.title).toBe('Ready')
    setLocale('vi')
    expect(words.title).toBe('Sẵn sàng')
    expect(words.count(3)).toBe('3 thiết bị')
    expect(words.nested.ok).toBe('Ổn')
  })

  it('lists the same keys as its English catalog', () => {
    expect(Object.keys(words)).toEqual(['title', 'count', 'nested'])
  })
})

describe('defineMessages', () => {
  it('hands back both catalogs as given', () => {
    const messages = defineMessages({ en: { a: 'A' }, vi: { a: 'Á' } })
    expect(messages.vi.a).toBe('Á')
  })
})
