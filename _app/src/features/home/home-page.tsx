import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'

import { SHEET_GAP, SHEET_WIDTH } from './camera'
import { Crosshair } from './components/crosshair'
import { IntroSheet } from './components/intro-sheet'
import { LinkSheet } from './components/link-sheet'
import { Minimap, tickCount } from './components/minimap'
import { TextSwitch } from './components/text-switch'
import { ThemeSwitch } from './components/theme-switch'
import { HOME_LINKS } from './home-links'
import { buildView } from './launcher'
import { useIndexCamera } from './use-camera'

/** The statement is sheet 0; the links follow in data order. */
const FIRST_LINK = 1
const SHEETS = HOME_LINKS.length + FIRST_LINK

/** Letters typed within this window build one query; a pause starts a new one. */
const TYPE_AHEAD_MS = 900

/*
  Two layouts of the same sheets: `list`, the strip under a camera (the reference's), and
  `grid`, every sheet at once with its description — the way to see the whole list without
  travelling. The choice is remembered.
*/
type Layout = 'list' | 'grid'
const LAYOUT_STORAGE_KEY = 'bauloc:layout'
const LAYOUTS = [
  { value: 'list', label: 'List' },
  { value: 'grid', label: 'Grid' },
] as const satisfies readonly { value: Layout; label: string }[]

function readLayout(): Layout {
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function saveLayout(layout: Layout) {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout)
  } catch {
    // Storage blocked: the switch still works, it just is not remembered.
  }
}

/**
 * Switch layouts through a view transition. While `html.morph` is set, every sheet carries a
 * view-transition-name (globals.css), so the browser flies each one from its old place to
 * its new one — the strip folding into the grid and back.
 */
function morph(update: () => void) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || !('startViewTransition' in document)) {
    update()
    return
  }
  const root = document.documentElement
  root.classList.add('morph')
  const transition = document.startViewTransition(update)
  void transition.finished.finally(() => {
    root.classList.remove('morph')
  })
}

/** The sheet in front of the camera, in the list. */
function sheetInFront(): number {
  const element = document.querySelector('[data-sheet][data-active="true"]')
  return Number(element?.getAttribute('data-sheet') ?? 0)
}

/** The sheet holding keyboard focus, if any — in the grid, the one you were looking at. */
function focusedSheet(): number | null {
  const element = document.activeElement?.closest('[data-sheet]')
  return element ? Number(element.getAttribute('data-sheet')) : null
}

/**
 * Typing a few letters reaches the best match, ranked by the launcher — the index is meant to
 * grow to dozens of entries, and nobody should travel past thirty to reach one.
 */
function useTypeAhead(onMatch: (sheet: number) => void) {
  const typed = useRef({ text: '', at: Number.NEGATIVE_INFINITY })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.length !== 1 || !/[a-z0-9]/i.test(event.key)) return
      const fresh = event.timeStamp - typed.current.at > TYPE_AHEAD_MS
      const text = fresh ? event.key : typed.current.text + event.key
      typed.current = { text, at: event.timeStamp }
      const best = buildView(HOME_LINKS, text).rows[0]
      if (best) onMatch(HOME_LINKS.indexOf(best.link) + FIRST_LINK)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onMatch])
}

/**
 * The strip, after rauno.me: a camera over white 1200 × 720 sheets on a grey field. The
 * statement is framed at full size; scrolling pulls the camera back and travels along the
 * strip, one sheet per destination, each labelled with its name and, where it matters, a
 * warning ("Needs a GitHub token", "In progress").
 *
 * Keyboard: Tab walks the sheets and the camera follows focus; ← → step sheet to sheet.
 */
function StripView({ entrance, initialSheet }: { entrance: boolean; initialSheet: number }) {
  const { mode, track, stage, strip, minimap, goTo, seek, current } = useIndexCamera(
    SHEETS,
    FIRST_LINK,
    initialSheet,
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      const target = Math.min(SHEETS - 1, Math.max(0, current() + step))
      // When a sheet has focus, focus travels with the camera, so Enter opens what you see.
      const sheets = strip.current
      if (sheets?.contains(document.activeElement) === true) {
        const next = sheets.children.item(target)
        if (next instanceof HTMLAnchorElement) next.focus({ preventScroll: true })
      }
      goTo(target)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [current, goTo, strip])

  useTypeAhead(goTo)

  return (
    <>
      {/* The scroll track: invisible, it only provides scroll length. See use-camera.ts. */}
      {mode === 'fine' && <div aria-hidden="true" style={{ height: track.height }} />}

      <div
        ref={stage}
        className={
          mode === 'fine'
            ? 'fixed inset-0 overflow-hidden'
            : 'fixed inset-0 [scrollbar-width:none] overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden'
        }
      >
        {mode === 'coarse' && (
          <div aria-hidden="true" style={{ width: track.width, height: track.height }} />
        )}
        <div
          ref={strip}
          className="absolute top-0 left-0 flex origin-top-left"
          style={{ gap: SHEET_GAP }}
        >
          <IntroSheet entrance={entrance} />
          {HOME_LINKS.map((link, index) => (
            <LinkSheet
              key={link.href}
              link={link}
              index={index + FIRST_LINK}
              entrance={entrance}
              onFocusVisible={() => {
                goTo(index + FIRST_LINK)
              }}
            />
          ))}
        </div>
      </div>

      <Minimap ref={minimap} ticks={tickCount(SHEETS)} entrance={entrance} onSeek={seek} />
      <Crosshair />
    </>
  )
}

/**
 * One grid cell: room for the sheet's label above, the sheet drawn at the cell's width, and —
 * for a link — its description below, which the strip never shows.
 */
function Cell({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div className="pt-7">
      <div data-cell className="relative aspect-[5/3]">
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: 'scale(var(--k, 0))' }}
        >
          {children}
        </div>
      </div>
      {caption !== undefined && (
        <p className="text-index-label mt-3 max-w-[48ch] text-[14px] leading-snug">{caption}</p>
      )}
    </div>
  )
}

/**
 * Every sheet at once: one column on a phone, two, then three. The sheets are the strip's own
 * components, drawn at the cell's width (`--k` = cell width ÷ 1200, which also keeps their
 * counter-scaled labels at 14 px). Typing jumps focus to the best match.
 */
function GridView() {
  const grid = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = grid.current
    const cell = element?.querySelector<HTMLElement>('[data-cell]')
    if (!element || !cell) return
    const update = () => {
      element.style.setProperty('--k', String(cell.clientWidth / SHEET_WIDTH))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(cell)
    return () => {
      observer.disconnect()
    }
  }, [])

  const focusSheet = useCallback((sheet: number) => {
    grid.current?.querySelector<HTMLElement>(`[data-sheet="${String(sheet)}"]`)?.focus()
  }, [])
  useTypeAhead(focusSheet)

  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-6 pt-20 pb-28 sm:px-12">
        <div ref={grid} className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          <Cell>
            <IntroSheet entrance={false} />
          </Cell>
          {HOME_LINKS.map((link, index) => (
            <Cell key={link.href} caption={link.description}>
              <LinkSheet link={link} index={index + FIRST_LINK} entrance={false} />
            </Cell>
          ))}
        </div>
      </div>
      {/*
        The page scrolls under the corner switches; fade it out there so they stay legible —
        the reference's own bottom fade, for the same reason.
      */}
      <div
        aria-hidden="true"
        className="from-index-ground pointer-events-none fixed inset-x-0 bottom-0 z-[5] h-28 bg-linear-to-t from-50% to-transparent"
      />
    </>
  )
}

/**
 * The site root. "List  Grid" bottom left, "Light  Dark" bottom right — the reference puts its
 * own links in the corners of a sheet; these sit in the corners of the page.
 */
export function HomePage() {
  const [layout, setLayout] = useState<Layout>(readLayout)
  /** Entrance animations belong to the first load only; after a switch the morph is the motion. */
  const [switched, setSwitched] = useState(false)
  const [returnTo, setReturnTo] = useState(0)

  const chooseLayout = (next: Layout) => {
    // Leaving the list: remember the sheet in front. Leaving the grid: go back to the focused
    // sheet, or else to the one the list was left at.
    const from = layout === 'list' ? sheetInFront() : (focusedSheet() ?? returnTo)
    saveLayout(next)
    morph(() => {
      flushSync(() => {
        setReturnTo(from)
        setSwitched(true)
        setLayout(next)
      })
      if (next === 'grid') window.scrollTo({ top: 0, behavior: 'instant' })
    })
  }

  return (
    <main data-page="index" data-layout={layout} className="font-display text-index-ink relative">
      {layout === 'list' ? (
        <StripView entrance={!switched} initialSheet={switched ? returnTo : 0} />
      ) : (
        <GridView />
      )}
      <TextSwitch
        label="Layout"
        options={LAYOUTS}
        value={layout}
        onSelect={chooseLayout}
        className="left-6"
      />
      <ThemeSwitch />
    </main>
  )
}
