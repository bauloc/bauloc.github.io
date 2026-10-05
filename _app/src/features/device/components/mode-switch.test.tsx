// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModeSwitch, parseView } from './mode-switch'

afterEach(cleanup)

describe('parseView', () => {
  it('reads ?view=scan as Scan Device, and anything else as Connect Device', () => {
    expect(parseView('scan')).toBe('scan')
    expect(parseView('connect')).toBe('connect')
    expect(parseView(undefined)).toBe('connect')
    expect(parseView('Scan')).toBe('connect')
    expect(parseView(1)).toBe('connect')
  })
})

describe('ModeSwitch', () => {
  it('shows Device Lab’s two jobs as the page’s tabs, under its title', () => {
    render(<ModeSwitch value="connect" onChange={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Scan or connect a device' })).toBeVisible()
    const nav = screen.getByRole('navigation', { name: 'Device Lab' })
    expect(nav).toBeVisible()
    expect(screen.getByRole('link', { name: 'Scan Device' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Connect Device' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('links each tab to its own address, keeping the page’s other parameters', () => {
    window.history.replaceState(null, '', '/device/?mock=1')
    render(<ModeSwitch value="connect" onChange={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Scan Device' })).toHaveAttribute(
      'href',
      '/device/?mock=1&view=scan',
    )
    window.history.replaceState(null, '', '/')
  })

  it('switches in place on a plain click, and leaves a modified click to the browser', () => {
    const change = vi.fn()
    render(<ModeSwitch value="connect" onChange={change} />)
    const scan = screen.getByRole('link', { name: 'Scan Device' })
    expect(fireEvent.click(scan)).toBe(false)
    expect(change).toHaveBeenLastCalledWith('scan')
    change.mockClear()
    // A new tab: the browser follows the link, the page doesn't switch.
    expect(fireEvent.click(scan, { metaKey: true })).toBe(true)
    expect(change).not.toHaveBeenCalled()
  })

  it('without its intro: only the two tabs, above the device list', () => {
    render(<ModeSwitch value="scan" onChange={vi.fn()} intro={false} />)
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.getByRole('link', { name: 'Scan Device' })).toHaveAttribute('aria-current', 'page')
  })
})
