import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { Game } from '../games'
import { MaterialIcon } from './material-icon'

/**
 * A game, playing in a frame under an app bar with a close button and its title.
 *
 * Presented the way the Flutter build presented it. With a mouse it is a full-screen dialog
 * route inside the content area, sliding up over the section while the rail and the side
 * panel stay usable — so it is not modal, and choosing another section closes it, as popping
 * that navigator did. On a touch screen it is a popup over the whole screen, scaling in.
 *
 * The thin bar under the app bar runs until the game's page has loaded.
 */
export function GameView({ game, onClose }: { game: Game; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose()
  })

  useEffect(() => {
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      onKey(event)
    }
    window.addEventListener('keydown', handleKey)
    // The game owns the screen; the page under it must not scroll along with a swipe.
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handleKey)
      root.style.overflow = overflow
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-label={game.title}
      className="animate-slide-up wide:left-[379px] pointer-coarse:animate-pop-in fixed inset-y-0 right-0 left-[79px] z-20 flex flex-col bg-white pointer-coarse:left-0!"
    >
      <header className="bg-profile-surface relative flex h-14 shrink-0 items-center px-1">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
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
            aria-label={`Loading ${game.title}`}
            className="bg-profile-secondary-container absolute inset-x-0 top-0 h-1 overflow-hidden"
          >
            <span className="animate-progress-bar bg-profile-primary absolute inset-y-0" />
          </div>
        )}
      </div>
    </div>
  )
}
