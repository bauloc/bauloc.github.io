import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'

import { useMessages } from '@/lib/i18n'
import { LANGUAGES, setLocale, useLocale } from '@/lib/locale'

import { SHEET_GAP, SHEET_WIDTH } from './camera'
import { Crosshair } from './components/crosshair'
import { IntroSheet } from './components/intro-sheet'
import { LinkSheet } from './components/link-sheet'
import { Minimap } from './components/minimap'
import { TextSwitch } from './components/text-switch'
import { ThemeSwitch } from './components/theme-switch'
import { HOME_LINKS } from './home-links'
import { buildView } from './launcher'
import { HOME_MESSAGES } from './messages'
import { STAGE_ID, useIndexCamera } from './use-camera'

/** The statement is sheet 0; the links follow in data order — the same in either language. */
const FIRST_LINK = 1
const SHEETS = HOME_LINKS.en.length + FIRST_LINK

/** Letters typed within this window build one query; a pause starts a new one. */
const TYPE_AHEAD_MS = 900

/*
  Two layouts of the same sheets: `list`, the strip under a camera (the reference's), and
  `grid`, every sheet at once with its description — the way to see the whole list without
  travelling. The choice is remembered.
*/
type Layout = 'list' | 'grid'
const LAYOUT_STORAGE_KEY = 'bauloc:layout'

/**
 * The language switch's choices: each language by its own name, or by its code on a phone,
 * where the full names would reach under the ruler (which keeps the top centre there). The
 * name stays the button's name either way.
 */
const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.value,
  label: (
    <>
      <span aria-hidden="true" className="sm:hidden">
        {language.short}
      </span>
      <span className="max-sm:sr-only">{language.name}</span>
    </>
  ),
  lang: language.value,
}))

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

/**
 * Typing a few letters reaches the best match, ranked by the launcher — the index is meant to
 * grow to dozens of entries, and nobody should travel past thirty to reach one.
 */
function useTypeAhead(onMatch: (sheet: number) => void) {
  const typed = useRef({ text: '', at: Number.NEGATIVE_INFINITY })
  // Matched against the titles on screen, so "ho" finds Hồ sơ in Vietnamese.
  const links = HOME_LINKS[useLocale()]
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.length !== 1 || !/[a-z0-9]/i.test(event.key)) return
      const fresh = event.timeStamp - typed.current.at > TYPE_AHEAD_MS
      const text = fresh ? event.key : typed.current.text + event.key
      typed.current = { text, at: event.timeStamp }
      const best = buildView(links, text).rows[0]
      if (best) onMatch(links.indexOf(best.link) + FIRST_LINK)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onMatch, links])
}

/**
 * The strip, after rauno.me: a camera over white 1200 × 720 sheets on a grey field. The
 * statement is framed at full size; scrolling pulls the camera back and travels along the
 * strip, one sheet per destination, each labelled with its name and, where it matters, a
 * warning ("Needs a GitHub token", "In progress").
 *
 * Keyboard: Tab walks the sheets and the camera follows focus; ← → step sheet to sheet, and
 * typing jumps to the best match. Focus goes wherever the camera goes, so Enter always opens
 * the sheet on screen.
 */
function StripView({ entrance, initialSheet }: { entrance: boolean; initialSheet: number | null }) {
  const { mode, track, stage, strip, minimap, goTo, seek, current } = useIndexCamera(
    SHEETS,
    FIRST_LINK,
    initialSheet,
  )
  const links = HOME_LINKS[useLocale()]

  /**
   * Centre a sheet, and move focus to it when asked or when a sheet already has focus. The
   * statement takes focus too (from script only, see IntroSheet); otherwise stepping onto it
   * would leave focus, and Enter, on a sheet that has left the screen.
   */
  const travel = useCallback(
    (sheet: number, takeFocus: boolean) => {
      const sheets = strip.current
      if (sheets && (takeFocus || sheets.contains(document.activeElement))) {
        const next = sheets.children.item(sheet)
        if (next instanceof HTMLElement) next.focus({ preventScroll: true })
      }
      goTo(sheet)
    },
    [goTo, strip],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      travel(Math.min(SHEETS - 1, Math.max(0, current() + step)), false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [current, travel])

  // Typing is keyboard use, so the match takes focus: Enter then opens it.
  const travelAndFocus = useCallback(
    (sheet: number) => {
      travel(sheet, true)
    },
    [travel],
  )
  useTypeAhead(travelAndFocus)

  /**
   * The sheet that keyboard focus last panned the camera to. When its window comes back to
   * the front, the browser sends that sheet focus again; that must not drag the camera back
   * from wherever scrolling has taken it since. Cleared when focus moves within the page —
   * the only kind of blur during which the document still has focus.
   */
  const panned = useRef<number | null>(null)
  const panTo = (sheet: number) => {
    if (panned.current === sheet) return
    panned.current = sheet
    goTo(sheet)
  }

  return (
    <>
      {/* The scroll track: invisible, it only provides scroll length. See use-camera.ts. */}
      {mode === 'fine' && <div aria-hidden="true" style={{ height: track.height }} />}

      {/*
        On a fine pointer the stage clips with `overflow: clip`, not `hidden`. A hidden box is
        still a scroll container, so focus, find-in-page and text fragments would scroll it
        behind the camera's back, and the strip would no longer be where the camera thinks.
      */}
      <div
        ref={stage}
        data-scroll-restoration-id={STAGE_ID}
        className={
          mode === 'fine'
            ? 'fixed inset-0 overflow-clip'
            : 'fixed inset-0 [scrollbar-width:none] overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden'
        }
      >
        {mode === 'coarse' && (
          <div aria-hidden="true" style={{ width: track.width, height: track.height }} />
        )}
        <div
          ref={strip}
          onBlur={() => {
            if (document.hasFocus()) panned.current = null
          }}
          className="absolute top-0 left-0 flex origin-top-left"
          style={{ gap: SHEET_GAP }}
        >
          <IntroSheet entrance={entrance} />
          {links.map((link, index) => (
            <LinkSheet
              key={link.href}
              link={link}
              index={index + FIRST_LINK}
              entrance={entrance}
              onFocusVisible={() => {
                panTo(index + FIRST_LINK)
              }}
            />
          ))}
        </div>
      </div>

      <Minimap ref={minimap} ticks={SHEETS} entrance={entrance} onSeek={seek} />
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
function GridView({ onSheetFocus }: { onSheetFocus: (sheet: number) => void }) {
  const grid = useRef<HTMLDivElement>(null)
  const links = HOME_LINKS[useLocale()]

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
        <div
          ref={grid}
          onFocus={(event) => {
            const sheet = event.target instanceof Element && event.target.closest('[data-sheet]')
            if (sheet) onSheetFocus(Number(sheet.getAttribute('data-sheet')))
          }}
          className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Cell>
            <IntroSheet entrance={false} />
          </Cell>
          {links.map((link, index) => (
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
 * The site root. "List  Grid" bottom left, "Light  Dark" bottom right, the language top
 * right — the reference puts its own links in the corners of a sheet; these sit in the
 * corners of the page. The top left stays empty, and the ruler keeps the top centre.
 */
export function HomePage() {
  const t = useMessages(HOME_MESSAGES)
  const locale = useLocale()
  const [layout, setLayout] = useState<Layout>(readLayout)
  /** Entrance animations belong to the first load only; after a switch the morph is the motion. */
  const [switched, setSwitched] = useState(false)
  const [returnTo, setReturnTo] = useState(0)
  /**
   * The sheet last focused in the grid, kept as it happens: by the time the List button's
   * click is handled, focus has moved to that button.
   */
  const gridSheet = useRef<number | null>(null)

  const chooseLayout = (next: Layout) => {
    // Leaving the list: remember the sheet in front. Leaving the grid: go back to the sheet
    // focused there, or else to the one the list was left at.
    const from = layout === 'list' ? sheetInFront() : (gridSheet.current ?? returnTo)
    gridSheet.current = null
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
    <main data-page="index" data-layout={layout} className="font-console text-index-ink relative">
      {layout === 'list' ? (
        <StripView entrance={!switched} initialSheet={switched ? returnTo : null} />
      ) : (
        <GridView
          onSheetFocus={(sheet) => {
            gridSheet.current = sheet
          }}
        />
      )}
      <TextSwitch
        label={t.layout}
        options={[
          { value: 'list', label: t.list },
          { value: 'grid', label: t.grid },
        ]}
        value={layout}
        onSelect={chooseLayout}
        className="bottom-6 left-6"
      />
      <TextSwitch
        label={t.language}
        options={LANGUAGE_OPTIONS}
        value={locale}
        onSelect={setLocale}
        className="top-6 right-6"
      />
      <ThemeSwitch />
    </main>
  )
}
