// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PairResult } from '../helper/connection'
import { HELPER_CARD_TITLE_ID } from './helper-card'
import { helperStatus } from './helper-status.fixture'
import { PairDialog } from './pair-dialog'

const TOKEN = 'Qx7-' + 'a'.repeat(39)

beforeAll(() => {
  // Radix's Switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
})

function open(
  onPair: (input: string, remember: boolean) => Promise<PairResult>,
  onOpenChange = vi.fn(),
  status = helperStatus('unpaired'),
) {
  render(<PairDialog open onOpenChange={onOpenChange} status={status} onPair={onPair} />)
  return { onOpenChange, input: screen.getByLabelText('Token or link') }
}

describe('PairDialog', () => {
  it('takes the token in a field browsers never fill or check', () => {
    const { input } = open(vi.fn())
    expect(screen.getByRole('dialog', { name: 'Pair this page with the helper' })).toBeTruthy()
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input).toHaveClass('font-mono')
    expect(
      screen.getByText(
        'Keeps this browser paired while this helper keeps running. Leave it off on a shared Mac.',
      ),
    ).toBeInTheDocument()
  })

  it('offers no Remember on the helper’s own page, which never remembers a pairing', async () => {
    const onPair = vi.fn<(input: string, remember: boolean) => Promise<PairResult>>(() =>
      Promise.resolve({ ok: true }),
    )
    const base = helperStatus('unpaired')
    const local = { ...base, env: { ...base.env, mode: 'local' as const } }
    const { input, onOpenChange } = open(onPair, vi.fn(), local)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(
      screen.getByText(
        'This is the helper’s own page, so the pairing isn’t saved. It lasts while this tab stays open.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(input, { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(onPair).toHaveBeenCalledWith(TOKEN, false)
  })

  it('pairs with the text and the switch, then closes', async () => {
    const onPair = vi.fn<(input: string, remember: boolean) => Promise<PairResult>>(() =>
      Promise.resolve({ ok: true }),
    )
    const { input, onOpenChange } = open(onPair)
    fireEvent.change(input, { target: { value: `http://127.0.0.1:8787/device/#pair=${TOKEN}` } })
    fireEvent.click(screen.getByRole('switch', { name: 'Remember on this computer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(onPair).toHaveBeenCalledWith(`http://127.0.0.1:8787/device/#pair=${TOKEN}`, true)
  })

  it('starts from the tester’s Remember choice after the helper restarted', async () => {
    const onPair = vi.fn<(input: string, remember: boolean) => Promise<PairResult>>(() =>
      Promise.resolve({ ok: true }),
    )
    // Stale: the old token is gone, so there is no pairing; the choice outlived it.
    const { input } = open(onPair, vi.fn(), helperStatus('stale', { remember: true }))
    expect(screen.getByRole('switch', { name: 'Remember on this computer' })).toBeChecked()
    fireEvent.change(input, { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => {
      expect(onPair).toHaveBeenCalledWith(TOKEN, true)
    })
  })

  it.each<[PairResult, string]>([
    [
      { ok: false, reason: 'format' },
      'That isn’t a helper token. Copy the whole line the helper printed.',
    ],
    [
      { ok: false, reason: 'stale', tokenId: '4d1566a1' },
      'That token is from another helper run. This helper’s fingerprint is 4d1566a1.',
    ],
    [
      { ok: false, reason: 'foreign' },
      'Something on port 8787 answered but couldn’t prove it is your helper. Nothing was sent.',
    ],
    [{ ok: false, reason: 'unreachable' }, 'The helper isn’t answering on 127.0.0.1:8787.'],
  ])('says why it couldn’t pair: %o', async (result, message) => {
    const { input, onOpenChange } = open(() => Promise.resolve(result))
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(message)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('names the port the attempt tried when the connection reports it', async () => {
    const { input } = open(() =>
      Promise.resolve({ ok: false, reason: 'unreachable', port: 8790 } as PairResult),
    )
    fireEvent.change(input, { target: { value: `#pair=${TOKEN}&port=8790` } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The helper isn’t answering on 127.0.0.1:8790.',
    )
  })

  it('paired from the Gate, whose Pair button goes with the phase: focus lands on the card title', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const [paired, setPaired] = useState(false)
      return (
        <>
          <div id={HELPER_CARD_TITLE_ID} tabIndex={-1}>
            {paired ? 'Ready for iPhones' : 'Pair this page'}
          </div>
          {!paired && (
            <button
              type="button"
              onClick={() => {
                setOpen(true)
              }}
            >
              Pair…
            </button>
          )}
          <PairDialog
            open={open}
            onOpenChange={setOpen}
            status={helperStatus('unpaired')}
            onPair={() => {
              setPaired(true)
              return Promise.resolve({ ok: true })
            }}
          />
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Pair…' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(await screen.findByLabelText('Token or link'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(document.getElementById(HELPER_CARD_TITLE_ID))
    })
  })

  it('does nothing with an empty field', () => {
    const onPair = vi.fn(() => Promise.resolve<PairResult>({ ok: true }))
    open(onPair)
    const button = screen.getByRole('button', { name: 'Pair' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(onPair).not.toHaveBeenCalled()
  })

  it('says the pairing survives restarts with --keep-token', () => {
    render(
      <PairDialog
        open
        onOpenChange={vi.fn()}
        status={helperStatus('unpaired', {
          health: { ...helperStatus('unpaired').health!, tokenPersistent: true },
        })}
        onPair={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/even after the helper restarts \(it runs with --keep-token\)/),
    ).toBeTruthy()
  })
})
