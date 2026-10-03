import { morphName } from './link-sheet'
import { Disc } from './sheet-art'

/*
  The statement, one phrase per line with every other line indented — the reference's rhythm.
  Only the site's existing copy ("BAULOC — Mobile Developer", "Software Developer, Electrical
  & Electronic Engineer"), recombined into a sentence; nothing invented.
*/
const LINES = [
  'bauloc',
  'is a mobile',
  'software developer',
  'and an electrical',
  '& electronic',
  'engineer',
]

/** Shared by the heading and its dark-mode twin, which must line up glyph for glyph. */
const LAYOUT =
  'h-full flex-col justify-center px-16 text-[85px] leading-[1.2] font-medium tracking-[-0.01em]'

/**
 * The sentence, a clipped line at a time so each line can rise out of its own clip.
 *
 * The name is set apart by colour alone — the reference's electric blue, the complement of
 * the yellow circle — in the same face and size as the rest; a second typeface for it was
 * tried and rejected. `tinted` is off for the dark-mode twin, which is near-black throughout.
 */
function Statement({ tinted, entrance }: { tinted: boolean; entrance: boolean }) {
  return LINES.map((line, index) => (
    <span key={line} className={`block overflow-hidden ${index % 2 === 1 ? 'ml-16' : ''}`}>
      <span
        className={`block ${entrance ? 'motion-safe:animate-line-rise' : ''} ${tinted && index === 0 ? 'text-index-blue' : ''}`}
        style={{ animationDelay: `${String(0.3 + index * 0.06)}s` }}
      >
        {line}
      </span>
    </span>
  ))
}

/**
 * The first sheet. It is the only one that is not a link, and the only one the camera frames
 * at full size: on the page's first load it grows in, its circle follows, and its lines rise
 * out of their own clips. `entrance` is off when it appears through a List ⇄ Grid switch —
 * the morph is the motion then, and a sheet scaled to zero would morph into nothing.
 *
 * Focusable from script only (`tabIndex={-1}`, no ring, as it opens nothing): stepping back
 * onto it moves focus here, off the sheet that has just left the screen.
 */
export function IntroSheet({ entrance }: { entrance: boolean }) {
  return (
    <section
      data-sheet={0}
      tabIndex={-1}
      style={morphName(0)}
      className={`bg-index-sheet relative h-[720px] w-[1200px] shrink-0 overflow-hidden outline-none ${entrance ? 'motion-safe:animate-sheet-grow' : ''}`}
    >
      <Disc
        className={`text-index-yellow absolute top-0 right-0 size-[720px] ${entrance ? 'motion-safe:animate-circle-grow' : ''}`}
      />
      <h1 className={`relative flex ${LAYOUT}`}>
        <Statement tinted entrance={entrance} />
      </h1>
      {/*
        Dark mode only: the sentence again in near-black, clipped to the circle, so the words
        that cross it read dark-on-yellow exactly as in light mode — light ink on that yellow
        would all but vanish. Its clip grows with the circle on load.
      */}
      <div
        aria-hidden="true"
        className={`text-index-on-yellow pointer-events-none absolute inset-0 hidden dark:flex ${LAYOUT} ${entrance ? 'motion-safe:animate-disc-clip' : ''}`}
        style={{ clipPath: 'circle(360px at 840px 360px)' }}
      >
        <Statement tinted={false} entrance={entrance} />
      </div>
    </section>
  )
}
