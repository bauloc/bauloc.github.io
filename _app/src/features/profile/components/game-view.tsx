import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { SITE_MESSAGES } from '@/components/messages'
import { useMessages } from '@/lib/i18n'

import type { Game } from '../games'
import { PROFILE_MESSAGES } from '../messages'
import { MaterialIcon } from './material-icon'

/**
 * A game, playing in a frame under an app bar with a close button and its title.
 *
 * It takes the whole screen, the site header included: sliding up with a mouse, scaling in on
 * a touch screen, as the Flutter build's game route did. The page under it can neither scroll
 * nor take focus (`#root` is inert, so the view lives in a portal on <body>) until the close
 * button or Esc closes it.
 *
 * The thin bar under the app bar runs until the game's page has loaded.
 */
export function GameView({ game, onClose }: { game: Game; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const site = useMessages(SITE_MESSAGES)
  const t = useMessages(PROFILE_MESSAGES)

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose()
  })

  useEffect(() => {
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      onKey(event)
    }
    window.addEventListener('keydown', handleKey)
    // The game owns the screen; the page under it must not scroll along with a swipe, nor
    // take focus or reach a screen reader.
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    const page = document.getElementById('root')
    if (page !== null) page.inert = true
    return () => {
      window.removeEventListener('keydown', handleKey)
      root.style.overflow = overflow
      if (page !== null) page.inert = false
    }
  }, [])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={game.title}
      className="animate-slide-up pointer-coarse:animate-pop-in bg-profile-page fixed inset-0 z-[60] flex flex-col"
    >
      <header className="bg-profile-surface relative flex h-14 shrink-0 items-center px-1">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={site.close}
          className="text-profile-on-surface hover:bg-profile-on-surface/[0.08] active:bg-profile-on-surface/10 grid size-12 cursor-pointer place-items-center rounded-full transition-colors focus-visible:-outline-offset-2"
        >
          <MaterialIcon name="close" />
        </button>
        <h2 className="text-profile-on-surface absolute inset-x-16 truncate text-center text-[22px] leading-7 tracking-normal">
          {game.title}
        </h2>
      </header>
      <div className="relative flex-1">
        <iframe
          src={game.url}
          title={game.title}
          allow="autoplay; fullscreen; gamepad"
          onLoad={() => {
            setLoaded(true)
          }}
          className="absolute inset-0 size-full border-0"
        />
        {!loaded && (
          <div
            role="progressbar"
            aria-label={t.loadingGame(game.title)}
            className="bg-profile-secondary-container absolute inset-x-0 top-0 h-1 overflow-hidden"
          >
            <span className="animate-progress-bar bg-profile-primary absolute inset-y-0" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
