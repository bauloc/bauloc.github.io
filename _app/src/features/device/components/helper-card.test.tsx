// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEV_COMMAND, DOWNLOAD_COMMAND, START_COMMAND } from '../helper/status'
import { HELPER_CARD_TITLE_ID, HelperCard, HelperCardBody } from './helper-card'
import { LANES, helperStatus } from './helper-status.fixture'

afterEach(() => {
  cleanup()
})

describe('HelperCardBody', () => {
  it('leaves out why iPhones need the helper when asked, and keeps the rest', () => {
    const connect = vi.fn()
    render(<HelperCardBody status={helperStatus('absent')} on={{ connect }} withoutIphoneCase />)
    expect(screen.queryByText(/macOS keeps the iPhone’s USB connection/)).toBeNull()
    expect(
      screen.getByText('Nothing answers on 127.0.0.1:8787. Is the helper running?'),
    ).toBeInTheDocument()
    expect(screen.getByText(DOWNLOAD_COMMAND)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect helper' }))
    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('HelperCard', () => {
  it('explains the helper, gives the command, and offers Connect', () => {
    const connect = vi.fn()
    render(<HelperCard status={helperStatus('absent')} on={{ connect }} />)
    expect(screen.getByText('Needs the helper')).toBeInTheDocument()
    expect(screen.getByText(/macOS keeps the iPhone’s USB connection for itself/)).toBeTruthy()
    expect(
      screen.getByText('Nothing answers on 127.0.0.1:8787. Is the helper running?'),
    ).toBeTruthy()
    expect(screen.getByText(DOWNLOAD_COMMAND).tagName).toBe('CODE')
    expect(screen.getByText('It opens this page paired. Already running?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect helper' }))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Choose Allow\./)).toBeInTheDocument()
  })

  it('gives a dev server the repo’s own command', () => {
    render(
      <HelperCard
        status={helperStatus('absent', { env: { ...helperStatus('off').env, devOrigin: true } })}
        on={{}}
      />,
    )
    expect(screen.getByText(DEV_COMMAND)).toBeInTheDocument()
    expect(screen.getByText(/Is the helper running, and started with --dev\?/)).toBeInTheDocument()
    // That command doesn't download anything, so neither does the card.
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull()
  })

  it('keeps Connect helper while it looks, inert, so keyboard focus stays on it', () => {
    const connect = vi.fn()
    const { rerender } = render(<HelperCard status={helperStatus('off')} on={{ connect }} />)
    const button = screen.getByRole('button', { name: 'Connect helper' })
    button.focus()
    rerender(<HelperCard status={helperStatus('checking')} on={{ connect }} />)
    expect(screen.getByText('Looking for the helper on 127.0.0.1:8787…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect helper' })).toBe(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(connect).not.toHaveBeenCalled()
    // Nothing found: the same button, live again, still focused.
    rerender(<HelperCard status={helperStatus('absent')} on={{ connect }} />)
    expect(document.activeElement).toBe(button)
    expect(button).not.toHaveAttribute('aria-disabled')
  })

  it('puts focus on the title when the phase takes away the control it was on', () => {
    const on = { connect: vi.fn(), pair: vi.fn() }
    const { rerender } = render(<HelperCard status={helperStatus('off')} on={on} />)
    screen.getByRole('button', { name: 'Connect helper' }).focus()
    rerender(<HelperCard status={helperStatus('checking')} on={on} />)
    // The helper runs unpaired: Connect is gone, Pair… takes its place.
    rerender(<HelperCard status={helperStatus('unpaired')} on={on} />)
    const title = document.getElementById(HELPER_CARD_TITLE_ID)
    expect(title).toHaveTextContent('Pair this page')
    expect(document.activeElement).toBe(title)
  })

  it('leaves focus alone when it is elsewhere on the page', () => {
    const on = { connect: vi.fn(), pair: vi.fn() }
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <HelperCard status={helperStatus('off')} on={on} />
      </>,
    )
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <HelperCard status={helperStatus('unpaired')} on={on} />
      </>,
    )
    expect(document.activeElement).toBe(elsewhere)
  })

  it('says the helper needs Node.js, and links where to get it', () => {
    render(<HelperCard status={helperStatus('absent')} on={{}} />)
    expect(screen.queryByText(/nothing to install/)).toBeNull()
    expect(
      screen.getByText(
        'Needs Node.js 18 or newer (node -v shows yours). No Node? Get the installer from nodejs.org, or run brew install node.',
      ),
    ).toBeInTheDocument()
    const node = screen.getByRole('link', { name: /Get Node\.js \(LTS\)/ })
    expect(node).toHaveAttribute('href', 'https://nodejs.org/en/download')
    expect(node).toHaveAttribute('target', '_blank')
  })

  it('off macOS, says iPhones need a Mac and offers no command', () => {
    render(<HelperCard status={helperStatus('absent')} on={{ connect: vi.fn() }} os="windows" />)
    expect(screen.getByText('iPhones need a Mac')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Only macOS lets the helper reach an iPhone. Open Device Lab on a Mac to use one.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('code')).toBeNull()
    expect(screen.queryByText(/Run this in Terminal/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect helper' })).toBeNull()
  })

  it('port taken: the command downloads the file too, and so does the link beside it', () => {
    render(<HelperCard status={helperStatus('foreign')} on={{}} />)
    expect(screen.getByText(`${DOWNLOAD_COMMAND} --port 8788`).tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: /Download device-bridge\.mjs/ })).toBeInTheDocument()
  })

  it('says it is ready, and points at Xcode when screenshots can’t be taken', () => {
    render(
      <HelperCard
        status={helperStatus('connected', {
          lanes: { ...LANES, ios: { ...LANES.ios, screenshots: 'none', xcode: 'not-installed' } },
        })}
        on={{}}
      />,
    )
    expect(screen.getByText('Ready for iPhones')).toBeInTheDocument()
    expect(screen.getByText(/need Xcode on this Mac — see the checklist below\./)).toBeTruthy()
  })

  it('gives the restart command once the helper stopped', () => {
    render(<HelperCard status={helperStatus('lost')} on={{}} />)
    expect(screen.getByText('The helper stopped')).toBeInTheDocument()
    expect(screen.getByText(START_COMMAND)).toBeInTheDocument()
  })

  it('sends a blocked browser to the helper’s own page, after how to start the helper', () => {
    render(<HelperCard status={helperStatus('denied', { permission: 'denied' })} on={{}} />)
    expect(screen.getByRole('link', { name: 'Open the helper’s page' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:8787/device/',
    )
    expect(screen.getByText(DOWNLOAD_COMMAND).tagName).toBe('CODE')
    expect(screen.getByText('Already running? Open its page:')).toBeInTheDocument()
  })
})
