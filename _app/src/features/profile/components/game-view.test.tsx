// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/lib/locale'

import { GAMES } from '../games'
import { RelaxSection } from '../sections/relax-section'
import { GameView } from './game-view'

const [GAME] = GAMES
if (GAME === undefined) throw new Error('games.ts lists no game')

/** The app's mount point, which a playing game makes inert. */
function appRoot(): HTMLElement {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  return root
}

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
  document.documentElement.style.overflow = ''
  act(() => {
    setLocale('en')
  })
})

describe('GameView', () => {
  it('takes the screen while it plays: the page can neither scroll nor take focus', () => {
    const root = appRoot()
    const { unmount } = render(<GameView game={GAME} onClose={() => undefined} />, {
      container: root,
    })

    const dialog = screen.getByRole('dialog', { name: GAME.title })
    // In a portal on <body>, outside the inert page.
    expect(root).not.toContainElement(dialog)
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(root.inert).toBe(true)
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    unmount()
    expect(root.inert).toBe(false)
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('closes with its close button and with Esc', () => {
    const onClose = vi.fn()
    render(<GameView game={GAME} onClose={onClose} />, { container: appRoot() })

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('RelaxSection', () => {
  it('gives focus back to the game that was playing once it closes', () => {
    render(<RelaxSection />, { container: appRoot() })
    const card = screen.getByRole('button', { name: `Play ${GAME.title}` })

    fireEvent.click(card)
    expect(screen.getByRole('dialog', { name: GAME.title })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(card).toHaveFocus()
  })
})
