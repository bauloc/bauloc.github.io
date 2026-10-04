// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CheckItem } from '../preflight/types'
import { DEV_COMMAND, DOWNLOAD_COMMAND, START_COMMAND } from '../helper/status'
import { HELPER_CARD_TITLE_ID, IosSetup, HelperCardBody } from './helper-card'
import { LANES, helperStatus } from './helper-status.fixture'

afterEach(() => {
  cleanup()
})

/** The <li> of the step whose heading reads `name` ("Step 2: …"). */
function stepNamed(name: string): HTMLElement {
  // By text: the sr-only "Step n: " prefix keeps its space in the text, not in the name.
  const heading = screen.getAllByRole('heading').find((h) => h.textContent === name)
  const li = heading?.closest('li')
  if (!li) throw new Error(`no step ${name}`)
  return li
}

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

describe('IosSetup, the Gate’s iPhone side', () => {
  it('explains the helper, gives the command, and offers Connect', () => {
    const connect = vi.fn()
    render(<IosSetup status={helperStatus('absent')} on={{ connect }} />)
    expect(screen.getByText('Needs the helper')).toBeInTheDocument()
    // Why iPhones need it is the Gate's headline; the step says what the helper is.
    // What the command does is part of what the step is: no question left hanging.
    expect(
      screen.getByText(
        'One file that runs with Node.js, only while its Terminal window is open. It opens this page paired.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText('Nothing answers on 127.0.0.1:8787. Is the helper running?'),
    ).toBeTruthy()
    expect(screen.getByText(DOWNLOAD_COMMAND).tagName).toBe('CODE')
    // The way round for a helper already running: on the button's own row, the browser's
    // prompt explained right under it.
    const button = screen.getByRole('button', { name: 'Connect helper' })
    const row = button.parentElement
    expect(row).toHaveTextContent(/^Already running\?Connect helper$/)
    expect(row?.nextElementSibling).toHaveTextContent(/Choose Allow\./)
    // The links about the command sit with the command, before that row.
    const source = screen.getByRole('link', { name: /Review the source/ })
    expect(source.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(button)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('gives a dev server the repo’s own command', () => {
    render(
      <IosSetup
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
    const { rerender } = render(<IosSetup status={helperStatus('off')} on={{ connect }} />)
    const button = screen.getByRole('button', { name: 'Connect helper' })
    button.focus()
    rerender(<IosSetup status={helperStatus('checking')} on={{ connect }} />)
    expect(screen.getByText('Looking for the helper on 127.0.0.1:8787…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect helper' })).toBe(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(connect).not.toHaveBeenCalled()
    // Nothing found: the same button, live again, still focused.
    rerender(<IosSetup status={helperStatus('absent')} on={{ connect }} />)
    expect(document.activeElement).toBe(button)
    expect(button).not.toHaveAttribute('aria-disabled')
  })

  it('puts focus on the title when the phase takes away the control it was on', () => {
    const on = { connect: vi.fn(), pair: vi.fn() }
    const { rerender } = render(<IosSetup status={helperStatus('off')} on={on} />)
    screen.getByRole('button', { name: 'Connect helper' }).focus()
    rerender(<IosSetup status={helperStatus('checking')} on={on} />)
    // The helper runs unpaired: Connect is gone, Pair… takes its place.
    rerender(<IosSetup status={helperStatus('unpaired')} on={on} />)
    const title = document.getElementById(HELPER_CARD_TITLE_ID)
    expect(title).toHaveTextContent('Pair this page')
    expect(document.activeElement).toBe(title)
  })

  it('leaves focus alone when it is elsewhere on the page', () => {
    const on = { connect: vi.fn(), pair: vi.fn() }
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <IosSetup status={helperStatus('off')} on={on} />
      </>,
    )
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <IosSetup status={helperStatus('unpaired')} on={on} />
      </>,
    )
    expect(document.activeElement).toBe(elsewhere)
  })

  it('says the helper needs Node.js, and links where to get it', () => {
    render(<IosSetup status={helperStatus('absent')} on={{}} />)
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
    render(<IosSetup status={helperStatus('absent')} on={{ connect: vi.fn() }} os="windows" />)
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
    render(<IosSetup status={helperStatus('foreign')} on={{}} />)
    expect(screen.getByText(`${DOWNLOAD_COMMAND} --port 8788`).tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: /Download device-bridge\.mjs/ })).toBeInTheDocument()
  })

  it('says it is ready, and points at Xcode when screenshots can’t be taken', () => {
    render(
      <IosSetup
        status={helperStatus('connected', {
          lanes: { ...LANES, ios: { ...LANES.ios, screenshots: 'none', xcode: 'not-installed' } },
        })}
        on={{}}
      />,
    )
    expect(screen.getByText('Ready for iPhones')).toBeInTheDocument()
    const xcode = stepNamed('Step 6: Xcode, for iOS 17 and newer')
    expect(xcode).toHaveTextContent('Warning')
    expect(xcode).toHaveTextContent(/Screenshots of iOS 17 and newer need Xcode on this Mac\./)
  })

  it('gives the restart command once the helper stopped', () => {
    render(<IosSetup status={helperStatus('lost')} on={{}} />)
    expect(screen.getByText('The helper stopped')).toBeInTheDocument()
    expect(screen.getByText(START_COMMAND)).toBeInTheDocument()
  })

  it('sends a blocked browser to the helper’s own page, after how to start the helper', () => {
    render(<IosSetup status={helperStatus('denied', { permission: 'denied' })} on={{}} />)
    expect(screen.getByRole('link', { name: 'Open the helper’s page' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:8787/device/',
    )
    expect(screen.getByText(DOWNLOAD_COMMAND).tagName).toBe('CODE')
    expect(screen.getByText('Already running? Open its page:')).toBeInTheDocument()
  })

  it('opens the step the phase is at: start, then pair, then plug in', () => {
    const on = { connect: vi.fn(), pair: vi.fn() }
    const { rerender } = render(<IosSetup status={helperStatus('absent')} on={on} />)
    expect(stepNamed('Step 2: Download and start the helper')).toHaveTextContent('Warning')
    expect(
      within(stepNamed('Step 3: Pair this page with the helper')).queryByRole('button'),
    ).toBeNull()

    rerender(<IosSetup status={helperStatus('unpaired')} on={on} />)
    expect(stepNamed('Step 1: Node.js 18 or newer')).toHaveTextContent('Node.js runs the helper.')
    expect(stepNamed('Step 2: Download and start the helper')).toHaveTextContent(
      'Running on 127.0.0.1:8787.',
    )
    fireEvent.click(
      within(stepNamed('Step 3: Pair this page with the helper')).getByRole('button', {
        name: 'Pair…',
      }),
    )
    expect(on.pair).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Connect helper' })).toBeNull()

    rerender(<IosSetup status={helperStatus('connected')} on={on} />)
    expect(stepNamed('Step 3: Pair this page with the helper')).toHaveTextContent(
      'This page is paired with the helper.',
    )
    expect(stepNamed('Step 4: Plug in the iPhone and tap Trust')).toHaveTextContent(
      'If it asks, tap Trust.',
    )
    expect(stepNamed('Step 6: Xcode, for iOS 17 and newer')).toHaveTextContent(
      'Xcode is ready for screenshots.',
    )
  })

  it('takes Node.js and Xcode from the checklist once the helper has said', () => {
    const rows: CheckItem[] = [
      {
        id: 'mac.node',
        group: 'mac',
        label: 'Node 24.12.0',
        status: 'ok',
        sentence: 'Node 24.12.0 runs the helper.',
      },
      {
        id: 'ios.xcode',
        group: 'ios',
        label: 'Xcode',
        status: 'warning',
        sentence: 'Xcode isn’t installed, so screenshots of iOS 17 and newer are off.',
        fixes: [
          {
            label: 'Get Xcode from the App Store',
            href: 'https://apps.apple.com/app/xcode/id497799835',
          },
        ],
      },
    ]
    render(<IosSetup status={helperStatus('connected')} on={{}} checklist={rows} />)
    expect(stepNamed('Step 1: Node.js 18 or newer')).toHaveTextContent(
      'Node 24.12.0 runs the helper.',
    )
    const xcode = stepNamed('Step 6: Xcode, for iOS 17 and newer')
    expect(xcode).toHaveTextContent('Warning')
    expect(
      within(xcode).getByRole('link', { name: /Get Xcode from the App Store/ }),
    ).toHaveAttribute('href', 'https://apps.apple.com/app/xcode/id497799835')
  })
})
