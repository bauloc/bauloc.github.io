import { useLayoutEffect, useRef } from 'react'

import type { HomeLink, SheetArt as SheetArtSpec } from '../home-links'
import { pixelDrawing, type PixelDrawing as PixelDrawingSpec } from '../pixels'

/*
  Everything here is drawn in DESIGN units on a 1200 × 720 sheet; the camera scales it.
  All art is decorative — the sheet's link carries the accessible name — so every root here
  is aria-hidden.
*/

/** Room the word may take: the sheet less 96 px a side. */
const WORD_ROOM = 1200 - 2 * 96
/** Short words stop growing here, or "Lab" would fill the sheet edge to edge. */
const WORD_MAX = 320
const WORD_PROBE = 100

/**
 * The title, as large as fits the sheet whole.
 *
 * It used to be set at 720 px and cropped, which looks like the reference but leaves a word
 * you cannot read ("Conso…"). The size is measured, not guessed from the letter count: set at
 * a probe size, measured, scaled to the room. Measured again once the web font has loaded,
 * because the fallback face has different widths. The sheet's layout is in fixed design
 * units, so this never depends on the viewport.
 *
 * Centred on its capitals, as the reference centres its letters: with `leading-none`, Geist's
 * cap height sits exactly mid-line (ascent 1005 − descent 295 = cap height 710), so -50% is
 * the true centre. The right padding
 * gives back the letter-space the negative tracking takes after the last glyph, so that the
 * ink is what gets centred, not the advance box.
 */
function Word({ text }: { text: string }) {
  const word = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const element = word.current
    if (!element) return
    let live = true
    const fit = () => {
      if (!live) return
      element.style.fontSize = `${String(WORD_PROBE)}px`
      const width = element.offsetWidth
      if (width === 0) return
      element.style.fontSize = `${String(Math.min(WORD_MAX, (WORD_PROBE * WORD_ROOM) / width))}px`
    }
    fit()
    void document.fonts.ready.then(fit)
    return () => {
      live = false
    }
  }, [text])

  return (
    <span
      ref={word}
      aria-hidden="true"
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pr-[0.04em] leading-none font-medium tracking-[-0.04em] whitespace-nowrap"
    >
      {text}
    </span>
  )
}

/**
 * A flat circle in `currentColor`.
 *
 * SVG, not a `rounded-full` box. At the fractional scales the camera produces, Chrome bleeds
 * a rounded box's background one pixel along every edge it shares with its clipping parent —
 * a full-height circle shares three, and they showed as hairlines of colour running the
 * length of the sheet. (The reference has the same hairline along its first sheet.) A vector
 * circle paints nothing at its box edge, so there is nothing to bleed.
 */
export function Disc({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 2 2" className={className}>
      <circle cx="1" cy="1" r="1" fill="currentColor" />
    </svg>
  )
}

/**
 * Two letters, the second sitting on a full-height circle that warms from yellow to orange
 * while the sheet is the one in front of the camera (or hovered).
 *
 * Centred on their capitals like the word above. The first letter keeps about 30 design px
 * clear of the circle, as the reference's does; it was set closer, and the two shapes
 * pinched. Its offset and the gap move together, so the second letter stays put, centred on
 * the circle. Both are measured from Geist's B and L: a face with other side bearings moves
 * the letters onto the circle's edge.
 */
function Monogram({ letters }: { letters: string }) {
  const first = letters.slice(0, 1)
  const rest = letters.slice(1)
  return (
    <span aria-hidden="true" className="absolute inset-0">
      <Disc className="text-index-yellow group-hover:text-index-orange group-data-[active=true]:text-index-orange absolute top-0 right-0 size-[720px] transition-colors duration-500" />
      <span className="absolute top-1/2 left-[11px] flex -translate-y-1/2 gap-[165px] text-[720px] leading-none font-medium tracking-[-0.04em]">
        <span>{first}</span>
        {/* Sits wholly on the circle, which stays yellow in dark mode — so it stays dark. */}
        <span className="dark:text-index-on-yellow">{rest}</span>
      </span>
    </span>
  )
}

/*
  The pixel drawings: the reference's pixel hand is the model, a flat outline on a grid of
  20 design px cells, in the blue, with the statement's yellow where a drawing needs a second
  colour. Each is written out cell by cell (pixels.ts reads the rows), and a part of it that
  comes alive while its sheet is the one in front of the camera (or hovered) is a mark of its
  own.
*/
const CELL = 20

function Pixels({
  drawing,
  layers,
  className,
}: {
  drawing: PixelDrawingSpec
  /** Each mark's classes: its colour, and what it does while the sheet is in front. */
  layers: Readonly<Record<string, string>>
  className: string
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${String(drawing.width)} ${String(drawing.height)}`}
      width={drawing.width * CELL}
      height={drawing.height * CELL}
      shapeRendering="crispEdges"
      className={className}
    >
      {Object.entries(layers).map(([mark, classes]) => (
        <path key={mark} d={drawing.layers.get(mark)} className={classes} />
      ))}
    </svg>
  )
}

/*
  A phone, 280 × 480, and its cable (the last six rows) running off the bottom edge of the
  sheet: a device that is plugged in, which is what Device Lab is about. Its home screen is a
  grid of apps. In front of the camera the screen (`s`) lights up yellow, and the apps, the
  earpiece and the home indicator (`o`) go dark on it.
*/
const PHONE = pixelDrawing([
  '..##########..',
  '.#ssssssssss#.',
  '#ssssoooossss#',
  '#ssssssssssss#',
  '#ssssssssssss#',
  '#ssoosoosooss#',
  '#ssoosoosooss#',
  '#ssssssssssss#',
  '#ssoosoosooss#',
  '#ssoosoosooss#',
  '#ssssssssssss#',
  '#ssoosoosooss#',
  '#ssoosoosooss#',
  '#ssssssssssss#',
  '#ssoosoosooss#',
  '#ssoosoosooss#',
  '#ssssssssssss#',
  '#ssssssssssss#',
  '#ssssssssssss#',
  '#ssssssssssss#',
  '#ssssoooossss#',
  '#ssssssssssss#',
  '.#ssssssssss#.',
  '..##########..',
  '.....####.....',
  '.....####.....',
  '......##......',
  '......##......',
  '......##......',
  '......##......',
])

function PixelPhone() {
  return (
    <Pixels
      drawing={PHONE}
      layers={{
        s: 'fill-transparent transition-[fill] duration-500 group-hover:fill-index-yellow group-data-[active=true]:fill-index-yellow',
        '#': 'fill-index-blue',
        o: 'fill-index-blue transition-[fill] duration-500 group-hover:fill-index-on-yellow group-data-[active=true]:fill-index-on-yellow',
      }}
      className="absolute top-[120px] left-1/2 -translate-x-1/2"
    />
  )
}

/*
  A console window, 560 × 380: a title bar with its three buttons, and a prompt whose caret
  blinks while the sheet is in front of the camera — the site header's own caret, writ large.
*/
const TERMINAL = pixelDrawing([
  '..########################..',
  '.#........................#.',
  '#..##.##.##................#',
  '#..##.##.##................#',
  '#..........................#',
  '############################',
  '#..........................#',
  '#..........................#',
  '#.......##.................#',
  '#........##................#',
  '#.........##...............#',
  '#..........##..............#',
  '#.........##...............#',
  '#........##...._____.......#',
  '#.......##....._____.......#',
  '#..........................#',
  '#..........................#',
  '.#........................#.',
  '..########################..',
])

function Terminal() {
  return (
    <Pixels
      drawing={TERMINAL}
      layers={{
        '#': 'fill-index-blue',
        _: 'fill-index-blue group-hover:animate-blink group-data-[active=true]:animate-blink',
      }}
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    />
  )
}

/*
  A name badge, 600 × 400: the slot for its lanyard, a portrait — a bust on yellow that warms
  to orange in front of the camera, as the monogram's circle does — and the lines of a CV
  beside it. The yellow goes all the way round the bust: the bust is near-black
  in both modes, and on the dark sheet it would melt into the sheet wherever it touched it.
*/
const BADGE = pixelDrawing([
  '..##########################..',
  '.#..........................#.',
  '#............####............#',
  '#............................#',
  '#............................#',
  '#..oooooooooo................#',
  '#..oooxxxxooo..############..#',
  '#..ooxxxxxxoo..############..#',
  '#..ooxxxxxxoo................#',
  '#..ooxxxxxxoo................#',
  '#..ooxxxxxxoo..##########....#',
  '#..oooxxxxooo................#',
  '#..oooooooooo..#######.......#',
  '#..ooxxxxxxoo................#',
  '#..oxxxxxxxxo..###########...#',
  '#..oxxxxxxxxo................#',
  '#..oooooooooo................#',
  '#............................#',
  '.#..........................#.',
  '..##########################..',
])

function Badge() {
  return (
    <Pixels
      drawing={BADGE}
      layers={{
        '#': 'fill-index-blue',
        o: 'fill-index-yellow transition-[fill] duration-500 group-hover:fill-index-orange group-data-[active=true]:fill-index-orange',
        x: 'fill-index-on-yellow',
      }}
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    />
  )
}

/*
  A contribution graph, GitHub's calendar of squares, seven days a column, with a word
  written into it in a 5 × 7 type: the squares of the letters are the busy days. In front of
  the camera the letters fill to the darkest green, a column at a time from the left.

  The squares are 24 design px with 6 px between them: 39 columns, the word and two empty
  weeks either side, run nearly edge to edge, a band as bold as the other sheets' drawings.
*/
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
}
const DAY = 24
const DAY_PITCH = 30
const MARGIN_WEEKS = 2
/** Full class names, so Tailwind sees them: an empty day, then the four greens. */
const DAY_FILLS = [
  'fill-index-day',
  'fill-index-day-1',
  'fill-index-day-2',
  'fill-index-day-3',
  'fill-index-day-4',
] as const

/** A fixed scatter in [0, 1) for a square, so the graph looks lived-in and never changes. */
function scatter(x: number, y: number): number {
  let h = Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** The graph's columns: each a week of seven days, true where a letter fills the day. */
function weeksOf(text: string): boolean[][] {
  const empty = () => Array.from({ length: 7 }, () => false)
  const weeks: boolean[][] = Array.from({ length: MARGIN_WEEKS }, empty)
  Array.from(text.toUpperCase()).forEach((letter, index) => {
    if (index > 0) weeks.push(empty())
    const glyph = GLYPHS[letter] ?? []
    for (let x = 0; x < 5; x++)
      weeks.push(Array.from({ length: 7 }, (_, y) => glyph[y]?.[x] === '#'))
  })
  for (let i = 0; i < MARGIN_WEEKS; i++) weeks.push(empty())
  return weeks
}

function Contributions({ text }: { text: string }) {
  const weeks = weeksOf(text)
  const width = weeks.length * DAY_PITCH - (DAY_PITCH - DAY)
  const height = 7 * DAY_PITCH - (DAY_PITCH - DAY)
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    >
      {weeks.map((days, x) =>
        days.map((busy, y) => {
          const chance = scatter(x, y)
          // A letter's days are busy, a few of them less so; around them, a quiet scatter
          // of light days that never reads as part of a letter.
          const level = busy ? (chance < 0.12 ? 3 : 4) : chance < 0.86 ? 0 : 1
          return (
            <rect
              key={`${String(x)}-${String(y)}`}
              x={x * DAY_PITCH}
              y={y * DAY_PITCH}
              width={DAY}
              height={DAY}
              rx={5}
              className={
                busy
                  ? `${DAY_FILLS[level]} group-hover:fill-index-day-4 group-data-[active=true]:fill-index-day-4 transition-[fill] duration-300`
                  : DAY_FILLS[level]
              }
              style={busy ? { transitionDelay: `${String(x * 20)}ms` } : undefined}
            />
          )
        }),
      )}
    </svg>
  )
}

/** Television colour bars, in the reference's flat primaries. Full class names, so Tailwind sees them. */
const BARS = [
  'bg-index-yellow',
  'bg-index-cyan',
  'bg-index-green',
  'bg-index-pink',
  'bg-index-red',
  'bg-index-azure',
] as const

function TestCard() {
  return (
    <span aria-hidden="true" className="absolute inset-0 flex">
      {BARS.map((bar) => (
        <span key={bar} className={`h-full flex-1 ${bar}`} />
      ))}
    </span>
  )
}

export function SheetArt({ link }: { link: HomeLink }) {
  const art: SheetArtSpec = link.art ?? { kind: 'word' }
  switch (art.kind) {
    case 'word':
      return <Word text={art.text ?? link.title} />
    case 'monogram':
      return <Monogram letters={art.letters} />
    case 'pixelPhone':
      return <PixelPhone />
    case 'terminal':
      return <Terminal />
    case 'badge':
      return <Badge />
    case 'contributions':
      return <Contributions text={art.text} />
    case 'testCard':
      return <TestCard />
  }
}
