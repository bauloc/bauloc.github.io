import type { CSSProperties, FocusEvent } from 'react'

import type { HomeLink } from '../home-links'
import { SheetArt } from './sheet-art'

/** What you need to know before clicking. Nothing for a finished, public destination. */
function statusNote(link: HomeLink): string | null {
  if (link.status === 'internal') return 'Needs a GitHub token'
  if (link.status === 'wip') return 'In progress'
  return null
}

/**
 * Identity for the List ⇄ Grid morph: the same sheet carries the same name in both layouts,
 * so a view transition can fly each one from its place in the strip to its cell in the grid.
 * Only applied while `html.morph` is set (globals.css) — a theme switch is a view transition
 * too, and there the sheets must not be lifted out of the circular reveal.
 */
export function morphName(index: number): CSSProperties {
  return { '--vt': `sheet-${String(index)}` } as CSSProperties
}

/*
  Labels are counter-scaled by the camera's `--k`, so they stay 14 px on screen at every zoom.
  The reference lets its labels shrink with the strip — fine for a portfolio, not for an index
  whose labels carry "needs a token" and "in progress".

  The focus ring is counter-scaled the same way (4 px wide, 4 px out), so it always clears the
  label sitting 12 px above the sheet instead of growing into it at some zoom levels.
*/
const LABEL =
  'pointer-events-none absolute bottom-full pb-3 text-[14px] leading-none whitespace-nowrap text-index-label transition-colors duration-200 group-hover:text-index-ink'
const COUNTER_SCALE = { transform: 'scale(calc(1 / var(--k, 1)))' }
const FOCUS_RING =
  'group-focus-visible:[outline:calc(4px/var(--k,1))_solid_var(--index-focus)] group-focus-visible:[outline-offset:calc(4px/var(--k,1))]'

/**
 * One sheet: a label above, and the whole sheet as the link. Used by the strip and the grid
 * alike; whoever places it sets `--k` to the scale it is drawn at.
 */
export function LinkSheet({
  link,
  index,
  entrance,
  onFocusVisible,
}: {
  link: HomeLink
  /** Position among all sheets, the statement included — names it for the morph. */
  index: number
  /** Fade in with the page's first load; off when the sheet appears through a layout switch. */
  entrance: boolean
  /** Keyboard focus only — a mouse click focuses the link too, and must not pan the camera. */
  onFocusVisible?: () => void
}) {
  const note = statusNote(link)
  const external = link.external === true
  const name = [link.title, note, external ? 'opens in a new tab' : null].filter(Boolean).join(', ')

  return (
    <a
      href={link.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      aria-label={`${name}. ${link.description}`}
      data-sheet={index}
      style={morphName(index)}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        if (event.currentTarget.matches(':focus-visible')) onFocusVisible?.()
      }}
      className={`group text-index-ink relative block h-[720px] w-[1200px] shrink-0 no-underline outline-none ${entrance ? 'motion-safe:animate-sheet-fade' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`${LABEL} left-0 origin-bottom-left`}
        style={COUNTER_SCALE}
      >
        {link.title}
        {external ? ' ↗' : ''}
      </span>
      {note !== null && (
        <span
          aria-hidden="true"
          className={`${LABEL} right-0 origin-bottom-right`}
          style={COUNTER_SCALE}
        >
          {note}
        </span>
      )}
      <span className={`bg-index-sheet absolute inset-0 overflow-hidden ${FOCUS_RING}`}>
        <SheetArt link={link} />
      </span>
    </a>
  )
}
