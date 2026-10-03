import { useRef, useState } from 'react'

import { GameView } from '../components/game-view'
import { GAMES, type Game } from '../games'

/**
 * The games, as 16:9 covers: two to a row with a mouse, one on a touch screen (the Flutter
 * build asked whether it ran in a mobile browser, which a coarse pointer stands in for).
 */
export function RelaxPage() {
  const [playing, setPlaying] = useState<Game | null>(null)
  /** The cover that opened the game, to take focus back when it closes. */
  const opener = useRef<HTMLButtonElement | null>(null)

  const close = () => {
    setPlaying(null)
    opener.current?.focus()
  }

  return (
    <div className="wide:p-8 p-3">
      <ul className="grid grid-cols-2 gap-4 pointer-coarse:grid-cols-1">
        {GAMES.map((game) => (
          <li key={game.url}>
            <button
              type="button"
              title={game.description}
              onClick={(event) => {
                opener.current = event.currentTarget
                setPlaying(game)
              }}
              className="block aspect-video w-full cursor-pointer overflow-hidden rounded-lg"
            >
              <img
                src={game.cover}
                alt={`Play ${game.title}`}
                width={1000}
                height={563}
                className="size-full object-cover"
              />
            </button>
          </li>
        ))}
      </ul>
      {playing !== null && <GameView key={playing.url} game={playing} onClose={close} />}
    </div>
  )
}
