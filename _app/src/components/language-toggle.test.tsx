// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { LOCALE_STORAGE_KEY, setLocale } from '@/lib/locale'

import { LanguageToggle } from './language-toggle'
import { SITE_URL, SiteHeader } from './site-header'

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

  it('switches the page, remembers the choice, and rewords the header around it', () => {
    render(<SiteHeader current="profile" />)
    fireEvent.click(screen.getByRole('radio', { name: 'Tiếng Việt' }))

    expect(document.documentElement.lang).toBe('vi')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('vi')
    expect(screen.getByRole('radiogroup', { name: 'Ngôn ngữ' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Các mục' })
    expect(within(nav).getByRole('link', { name: 'Trang chủ' })).toHaveAttribute('href', '/')
    expect(within(nav).getByRole('link', { name: 'Hồ sơ' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /Chuyển sang giao diện/ })).toBeInTheDocument()
  })
})

describe('SiteHeader', () => {
  it('leads to every section, Home first, and marks the current one', () => {
    render(<SiteHeader current="device" />)
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Home', '/'],
      ['Profile', '/profile/'],
      ['XConsole', '/xconsole/'],
      ['Device Lab', '/device/'],
    ])
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page')).toEqual([links[3]])
    // The phone menu is named after the current section.
    expect(screen.getByRole('button', { name: 'Menu: Device Lab' })).toBeInTheDocument()
  })

  it('links to the site itself from the helper’s own copy of a page', () => {
    render(<SiteHeader current="device" base={SITE_URL} />)
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      'https://bauloc.github.io/',
    )
    expect(within(nav).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      'https://bauloc.github.io/profile/',
    )
  })

  it('marks nothing on a page that is no section, and shows the page’s own controls', () => {
    render(<SiteHeader current={null} actions={<button type="button">Print</button>} />)
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument()
  })
})
