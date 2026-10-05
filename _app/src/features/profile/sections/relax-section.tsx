import { Play } from 'lucide-react'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { GameView } from '../components/game-view'
import { Section } from '../components/section'
import { GAMES, type Game } from '../games'
import { PROFILE_MESSAGES } from '../messages'

/**
 * Tevi's minigames, two to a row: a 16:9 cover, the name and a line about it, lit like the
 * reference's cards under the pointer. A game plays in place, over the page (GameView), and
 * focus returns to its card when it closes.
 */
export function RelaxSection() {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  const [playing, setPlaying] = useState<Game | null>(null)
  /** The card that opened the game, to take focus back when it closes. */
  const opener = useRef<HTMLButtonElement | null>(null)

  // The page is inert while a game plays: close it first, then the card can take focus.
  const close = () => {
    flushSync(() => {
      setPlaying(null)
    })
    opener.current?.focus()
  }

  return (
    <Section id="relax" title={t.section.relax}>
      <ul className="group/list grid gap-x-8 gap-y-10 sm:grid-cols-2">
        {GAMES.map((game, index) => (
          <li key={game.url}>
            <button
              type="button"
              aria-label={t.play(game.title)}
              aria-describedby={`game-${String(index)}`}
              onClick={(event) => {
                opener.current = event.currentTarget
                setPlaying(game)
              }}
              className="group relative block w-full cursor-pointer text-left transition-all motion-reduce:transition-none lg:group-hover/list:opacity-50 lg:hover:!opacity-100"
            >
              <span className="lg:group-hover:bg-profile-hover absolute -inset-3 z-0 hidden rounded-md transition motion-reduce:transition-none lg:block" />
              <img
                src={game.cover}
                alt=""
                width={1000}
                height={563}
                loading="lazy"
                className="border-profile-line/60 group-hover:border-profile-line relative z-10 aspect-video w-full rounded border-2 object-cover transition"
              />
              <span className="text-profile-ink group-hover:text-profile-primary relative z-10 mt-3 flex items-center gap-1.5 font-medium transition-colors">
                <Play aria-hidden="true" className="size-3.5 fill-current" />
                {game.title}
              </span>
              <span
                id={`game-${String(index)}`}
                className="relative z-10 mt-1 block text-sm leading-normal"
              >
                {game.description[locale]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {playing !== null && <GameView key={playing.url} game={playing} onClose={close} />}
    </Section>
  )
}
