// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { START_COMMAND } from '../helper/status'
import { HelperNotice } from './helper-notice'
import { helperStatus } from './helper-status.fixture'

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('HelperNotice', () => {
  it('says when the helper stopped, and copies the command to start it', async () => {
    render(<HelperNotice status={helperStatus('lost')} on={{}} />)
    const strip = screen.getByRole('region', { name: 'Local helper' })
    expect(strip).toHaveTextContent(
      'The helper stopped at 14:05. Start it again; this page reconnects by itself.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(START_COMMAND)
    })
  })

  it('pairs again after a restart', () => {
    const pair = vi.fn()
    render(<HelperNotice status={helperStatus('stale')} on={{ pair }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair…' }))
    expect(pair).toHaveBeenCalledTimes(1)
  })

  it('says nothing to a tester who never asked for the helper, or while all is well', () => {
    const { container } = render(
      <HelperNotice status={helperStatus('lost', { intent: false })} on={{}} />,
    )
    expect(container).toBeEmptyDOMElement()
    cleanup()
    const ok = render(<HelperNotice status={helperStatus('connected')} on={{}} />)
    expect(ok.container).toBeEmptyDOMElement()
  })
})
