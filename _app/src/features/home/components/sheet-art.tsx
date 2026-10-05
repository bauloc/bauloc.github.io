import { useLayoutEffect, useRef } from 'react'

import type { HomeLink, SheetArt as SheetArtSpec } from '../home-links'

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
  A phone on a 14 × 30 pixel grid at 20 design px a cell: the body (rows 0–23) is 280 × 480,
  and its cable (rows 24–29) runs off the bottom edge of the sheet — a device that is plugged
  in, which is what Device Lab is about.
*/
const PHONE_CELLS: readonly (readonly [x: number, y: number, w: number, h: number])[] = [
  [2, 0, 10, 1], // top edge
  [1, 1, 1, 1],
  [12, 1, 1, 1],
  [0, 2, 1, 20], // left edge
  [13, 2, 1, 20], // right edge
  [1, 22, 1, 1],
  [12, 22, 1, 1],
  [2, 23, 10, 1], // bottom edge
  [5, 2, 4, 1], // earpiece
  [5, 20, 4, 1], // home indicator
  [5, 24, 4, 2], // plug
  [6, 26, 2, 4], // cable
]

function PixelPhone() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 30"
      width={280}
      height={600}
      shapeRendering="crispEdges"
      className="text-index-blue absolute top-[120px] left-1/2 -translate-x-1/2"
      fill="currentColor"
    >
      {PHONE_CELLS.map(([x, y, w, h]) => (
        <rect key={`${String(x)}-${String(y)}`} x={x} y={y} width={w} height={h} />
      ))}
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
    case 'testCard':
      return <TestCard />
  }
}
