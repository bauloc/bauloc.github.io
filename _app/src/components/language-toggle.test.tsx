// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { LOCALE_STORAGE_KEY, setLocale } from '@/lib/locale'

import { LanguageToggle } from './language-toggle'
import { PageTitle, SITE_URL, SiteHeader } from './site-header'

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
    // Icons, named for screen readers and in their tooltips.
    const links = within(nav).getAllByRole('link')
    expect(
      links.map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')]),
    ).toEqual([
      ['Home', '/'],
      ['Profile', '/profile/'],
      ['XConsole', '/xconsole/'],
      ['Device Lab', '/device/'],
    ])
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page')).toEqual([links[3]])
  })

  it('prompts at the page’s path, as a shell would', () => {
    const { container, rerender } = render(<SiteHeader current="device" />)
    expect(container.querySelector('header')).toHaveTextContent('bauloc@github.io:~/device$')
    rerender(<SiteHeader current="profile" path="/profile/contact" />)
    expect(container.querySelector('header')).toHaveTextContent('~/profile/contact$')
    rerender(<SiteHeader current="home" />)
    expect(container.querySelector('header')).toHaveTextContent('bauloc@github.io:~$')
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

  it('marks nothing on a page that is no section, which has no row of its own', () => {
    const { container } = render(<SiteHeader current={null} />)
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull()
    expect(container.querySelector('header')?.children).toHaveLength(1)
  })

  it('gives a page its own row: what it is, what it reports, what it offers', () => {
    const { container } = render(
      <SiteHeader
        current="profile"
        title={<PageTitle parent="Nguyen Phuoc Loc">CV</PageTitle>}
        status={<span>Ready</span>}
        actions={<button type="button">Print</button>}
      />,
    )
    const rows = container.querySelector('header')?.children
    expect(rows).toHaveLength(2)
    const page = rows?.[1] as HTMLElement
    expect(page).toHaveTextContent('Nguyen Phuoc Loc/CV')
    expect(within(page).getByText('Ready')).toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Print' })).toBeInTheDocument()
  })
})
