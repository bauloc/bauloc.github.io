// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { LOCALE_STORAGE_KEY, setLocale } from '@/lib/locale'

import { HomeButton } from './home-button'
import { LanguageToggle } from './language-toggle'
import { ThemeToggle } from './theme-toggle'

beforeAll(() => {
  // jsdom has no matchMedia; the theme toggle asks it for the system's dark mode.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
})

afterEach(() => {
  cleanup()
  act(() => {
    setLocale('en')
  })
  window.localStorage.clear()
})

describe('LanguageToggle', () => {
  it('offers both languages, each named in itself, with the current one on', () => {
    render(<LanguageToggle />)
    expect(screen.getByRole('radio', { name: 'English' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByRole('radio', { name: 'Tiếng Việt' })).toHaveAttribute('lang', 'vi')
  })

  it('switches the page, remembers the choice, and rewords the controls around it', () => {
    render(
      <>
        <HomeButton />
        <LanguageToggle />
        <ThemeToggle />
      </>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Tiếng Việt' }))

    expect(document.documentElement.lang).toBe('vi')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('vi')
    expect(screen.getByRole('radiogroup', { name: 'Ngôn ngữ' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Trang chủ' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('button', { name: /Chuyển sang giao diện/ })).toBeInTheDocument()
  })
})

describe('HomeButton', () => {
  it('keeps its word in the link name on a phone, where only the arrow shows', () => {
    render(<HomeButton href="https://bauloc.github.io/" />)
    const link = screen.getByRole('link', { name: 'Home' })
    expect(link).toHaveAttribute('href', 'https://bauloc.github.io/')
    expect(link.querySelector('span')).toHaveClass('sr-only')
  })
})
