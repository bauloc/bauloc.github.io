// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HelperChip } from './helper-chip'
import { IPHONE_ROW, helperStatus } from './helper-status.fixture'

afterEach(() => {
  cleanup()
})

describe('HelperChip', () => {
  it('is a button that connects while nothing has been looked for', () => {
    const connect = vi.fn()
    render(<HelperChip status={helperStatus('off')} devices={[]} on={{ connect }} />)
    const chip = screen.getByRole('button', { name: 'Connect helper: Connect helper' })
    expect(chip).toHaveAttribute('title', expect.stringMatching(/The browser may ask first/))
    fireEvent.click(chip)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does nothing while it looks, and says when the browser is asking', () => {
    render(<HelperChip status={helperStatus('checking')} devices={[]} on={{}} />)
    expect(screen.getByRole('button', { name: 'Looking for the helper…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    cleanup()
    render(
      <HelperChip status={helperStatus('checking', { promptLikely: true })} devices={[]} on={{}} />,
    )
    expect(screen.getByText('Allow in the browser prompt')).toBeInTheDocument()
  })

  it('keeps keyboard focus from Connect helper through the look to its answer', () => {
    const on = { connect: vi.fn(), check: vi.fn() }
    const { rerender } = render(<HelperChip status={helperStatus('off')} devices={[]} on={on} />)
    const chip = screen.getByRole('button', { name: 'Connect helper: Connect helper' })
    chip.focus()
    rerender(<HelperChip status={helperStatus('checking')} devices={[]} on={on} />)
    expect(document.activeElement).toBe(chip)
    fireEvent.click(chip)
    expect(on.connect).not.toHaveBeenCalled()
    rerender(<HelperChip status={helperStatus('absent')} devices={[]} on={on} />)
    expect(document.activeElement).toBe(chip)
    expect(chip).toHaveAccessibleName('Helper not running: open the Environment check')
  })

  it('counts the helper’s ready devices and opens the Environment check', () => {
    const check = vi.fn()
    const locked = { ...IPHONE_ROW, id: '00008101-000A1B2C3D4E5F03', state: 'locked' as const }
    render(
      <HelperChip
        status={helperStatus('connected')}
        devices={[IPHONE_ROW, locked]}
        on={{ check }}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '1/2 ready via helper: open the Environment check' }),
    )
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('pairs a stale page, and sends Safari to the helper’s own page', () => {
    const pair = vi.fn()
    render(<HelperChip status={helperStatus('stale')} devices={[]} on={{ pair }} />)
    fireEvent.click(screen.getByRole('button', { name: /^Helper restarted — pair again/ }))
    expect(pair).toHaveBeenCalledTimes(1)
    cleanup()
    render(
      <HelperChip
        status={helperStatus('safari', { env: { ...helperStatus('off').env, port: 8788 } })}
        devices={[]}
        on={{}}
      />,
    )
    expect(screen.getByRole('link', { name: /^Helper: use its own page/ })).toHaveAttribute(
      'href',
      'http://127.0.0.1:8788/device/',
    )
  })

  it('stays plain text when the page wired nothing to its action', () => {
    render(<HelperChip status={helperStatus('lost')} devices={[]} on={{}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Helper stopped')).toBeInTheDocument()
  })
})
