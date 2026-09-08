import { useEffect, useMemo, useRef, useState } from 'react'

import { HOME_LINKS } from './home-links'
import { buildView, moveActive } from './launcher'
import { LinkRow } from './components/link-row'

/**
 * The site root, as a launcher.
 *
 * Why a launcher and not the card grid it replaces: the grid capped at three across and
 * 872px wide, so it stopped working somewhere around the seventh entry — and the plan is to
 * keep adding entries. A search box absorbs fifty without a layout change. It also makes
 * honest what the old page was already implying: it had a `~>` prompt, a blinking cursor and
 * a monospace face, but nothing to type into.
 *
 * `dark` sits on this wrapper rather than on <html>: the same SPA also serves /xconsole/ and
 * /device/, which are light. `.dark` in theme.css is a class selector, so redefining the
 * tokens on a wrapper scopes them to this subtree — no effect, no flash, nothing to unwind
 * on navigation.
 *
 * The layout is TOP-ALIGNED, not vertically centred. Centring is what the old three-card
 * page did, and with a filtering list it makes the whole page jump on every keystroke as the
 * result count changes. The offset is `vh`-based so it stays put regardless of how many rows
 * are showing.
 */
export function HomePage() {
  const [query, setQuery] = useState('')
  /*
    The keyboard cursor is stored as an HREF, not an index.

    An index needs resetting every time the result set changes, and doing that in an effect
    triggers a cascading render (react-hooks/set-state-in-effect says so, correctly). An href
    needs no reset: after a keystroke it either survives in the new list or it does not, and
    `findIndex` returning -1 falls back to the first row — which is exactly the behaviour we
    want, derived rather than synchronised.
  */
  const [activeHref, setActiveHref] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const view = useMemo(() => buildView(HOME_LINKS, query), [query])
  const rows = view.rows

  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.link.href === activeHref),
  )
  const activeLink = rows[activeIndex]?.link

  // Keep the keyboard cursor visible without stealing focus from the input.
  useEffect(() => {
    const el = listRef.current?.querySelector(`#launcher-row-${String(activeIndex)}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  /*
    Typing anywhere goes to the input. A launcher whose box you have to click first is a
    launcher you stop using — and `autoFocus` alone does not survive a click on the page
    background. Modifier combinations are left alone so browser shortcuts still work.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (document.activeElement === inputRef.current) return
      if (event.key.length === 1 || event.key === 'Backspace') inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveHref(rows[moveActive(activeIndex, 1, rows.length)]?.link.href ?? null)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveHref(rows[moveActive(activeIndex, -1, rows.length)]?.link.href ?? null)
        break
      case 'Enter': {
        if (activeLink === undefined) break
        event.preventDefault()
        // ⌘/Ctrl+Enter opens in a new tab, matching every other launcher.
        if (event.metaKey || event.ctrlKey || activeLink.external === true) {
          window.open(activeLink.href, '_blank', 'noopener,noreferrer')
        } else {
          window.location.assign(activeLink.href)
        }
        break
      }
      case 'Escape':
        event.preventDefault()
        setQuery('')
        break
    }
  }

  return (
    <div className="dark bg-background text-foreground flex min-h-screen flex-col items-center px-6 pt-[14vh] pb-10">
      <div className="w-full max-w-3xl">
        <header>
          <div className="flex items-baseline gap-2.5 font-mono text-[clamp(1.125rem,4vw,1.625rem)] font-semibold">
            <span className="text-accent select-none" aria-hidden="true">
              ~&gt;
            </span>
            <div className="relative flex min-w-0 flex-1 items-baseline">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                // This page IS a launcher: the box is the page, so focusing it on load is
                // the point rather than an accessibility slip.
                autoFocus
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="Search this site"
                role="combobox"
                aria-expanded
                aria-controls="launcher-results"
                aria-activedescendant={
                  activeLink === undefined ? undefined : `launcher-row-${String(activeIndex)}`
                }
                placeholder="bauloc.github.io"
                className="caret-accent placeholder:text-foreground w-full min-w-0 border-none bg-transparent p-0 font-mono font-semibold outline-none"
              />
              {/*
                The native caret is the blinking cursor while the input has focus. This one
                covers the unfocused case, so the prompt never looks dead — the old page's
                cursor blinked unconditionally because it was decoration.
              */}
              {!focused && query === '' && (
                <span
                  aria-hidden="true"
                  className="bg-accent animate-blink motion-reduce:animate-none pointer-events-none absolute left-[10.6ch] inline-block h-[1.1em] w-0.5 self-center"
                />
              )}
            </div>
          </div>

          <p className="text-muted-foreground mt-3 font-mono text-[0.8125rem] tracking-[0.04em]">
            {'// Software Developer, Electrical & Electronic Engineer'}
          </p>
        </header>

        {/* Announce the count, not each row: a screen reader should hear "3 results", not a list read twice. */}
        <p className="sr-only" role="status" aria-live="polite">
          {query === ''
            ? `${String(rows.length)} destinations`
            : `${String(rows.length)} result${rows.length === 1 ? '' : 's'} for ${query}`}
        </p>

        <div
          ref={listRef}
          id="launcher-results"
          role="listbox"
          aria-label="Destinations"
          className="mt-8 flex flex-col gap-0.5"
        >
          {rows.map((row, index) => (
            <div key={row.link.href}>
              {row.group !== null && (
                <div className="text-muted-foreground/70 mt-5 mb-1.5 px-3 font-mono text-[0.6875rem] tracking-[0.12em] uppercase first:mt-0">
                  {row.group}
                </div>
              )}
              <LinkRow
                link={row.link}
                active={index === activeIndex}
                id={`launcher-row-${String(index)}`}
                onHover={() => setActiveHref(row.link.href)}
              />
            </div>
          ))}

          {rows.length === 0 && (
            <p className="text-muted-foreground px-3 py-6 font-mono text-sm">
              No match for <span className="text-foreground">{query}</span>. Press Esc to clear.
            </p>
          )}
        </div>

        <footer className="text-muted-foreground/70 mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6875rem]">
          <span>
            <kbd className="text-muted-foreground">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="text-muted-foreground">↵</kbd> open
          </span>
          <span>
            <kbd className="text-muted-foreground">⌘↵</kbd> new tab
          </span>
          <span>
            <kbd className="text-muted-foreground">esc</kbd> clear
          </span>
        </footer>
      </div>
    </div>
  )
}
