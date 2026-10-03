import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { THEME_STORAGE_KEY, resolveTheme } from './theme'

describe('resolveTheme', () => {
  it('a saved choice wins over the system', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('with nothing saved, follows the system', () => {
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
  })

  it('ignores anything else that ended up in storage', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('', false)).toBe('light')
  })
})

describe('the pre-paint script in index.html', () => {
  const html = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html'),
    'utf8',
  )

  it('reads the same storage key as the app', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`)
  })

  it('toggles the same class the app does', () => {
    expect(html).toContain("classList.add('dark')")
  })
})
