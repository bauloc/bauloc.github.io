// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/lib/locale'

import { PendingPage } from './pending-page'

beforeAll(() => {
  // jsdom has no matchMedia; the page's theme follows the system's dark mode through it.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  cleanup()
  setLocale('en')
})

describe('PendingPage', () => {
  it('keeps a tester on their link: one button to try again, and no link anywhere', () => {
    setLocale('en')
    const { container } = render(<PendingPage kind="build" />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This build isn’t ready yet')
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy()
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('header')).toBeNull()
  })

  it('speaks Vietnamese, and names an artifact a page', () => {
    setLocale('vi')
    render(<PendingPage kind="artifact" />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Trang này chưa sẵn sàng')
    expect(screen.getByRole('button', { name: /Thử lại/ })).toBeTruthy()
  })
})
