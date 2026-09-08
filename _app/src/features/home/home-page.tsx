import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { HOME_LINKS } from './home-links'
import { buildView, moveActive } from './launcher'
import { LinkRow } from './components/link-row'

/**
 * The site root: an index of everything here.
 *
 * Structure over decoration. Four choices carry it, and each replaces something the
 * previous card-grid version did:
 *
 *  1. ONE NARROW LEFT-ALIGNED COLUMN. The cards were a centred three-across grid capped at
 *     872px, which stopped working around the seventh entry. A single measure of ~34rem
 *     absorbs sixty rows without a layout change.
 *  2. NO BOXES. Whitespace separates rows — no border, no background, no divider. Chrome
 *     around every entry stops scaling long before the entries do.
 *  3. TOP-ALIGNED, never vertically centred. Centring is what the card page did, and with a
 *     filtering list it makes the whole page jump on each keystroke as the count changes.
 *  4. QUIET SECTION LABELS instead of headings. Small, uppercase, tracked, dim: enough to
 *     group, not enough to compete with the rows.
 *
 * `dark` sits on this wrapper rather than on <html>: the same SPA also serves /xconsole/ and
 * /device/, which are light. `.dark` in theme.css is a class selector, so redefining the
 * tokens here scopes them to this subtree — no effect, no flash, nothing to unwind on
 * navigation.
 */
export function HomePage() {
  const [query, setQuery] = useState('')
  /*
    The keyboard cursor is stored as an HREF, not an index. An index has to be reset every
    time the result set changes, and doing that in an effect is a cascading render. An href
    needs no reset: after a keystroke it either survives the new filter or it does not, and
    `findIndex` returning -1 falls back to the first row. Derived, not synchronised.
  */
  const [activeHref, setActiveHref] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const view = useMemo(() => buildView(HOME_LINKS, query), [query])
  const rows = view.rows

  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.link.href === activeHref),
  )
  const activeLink = rows[activeIndex]?.link

  // Keep the keyboard cursor visible without stealing focus from the filter.
  useEffect(() => {
    const el = listRef.current?.querySelector(`#index-row-${String(activeIndex)}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  /*
    Typing anywhere focuses the filter. The filter is deliberately small and easy to miss —
    that restraint only works if you never have to find it before you can use it.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (document.activeElement === inputRef.current) return
      if (event.key === '/') {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
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
    <div className="dark bg-background text-foreground min-h-screen px-6 pt-[14vh] pb-24">
      <div className="mx-auto w-full max-w-[34rem]">
        <header>
          <h1 className="text-foreground font-mono text-lg font-semibold tracking-tight">
            bauloc.github.io
          </h1>
          <p className="text-muted-foreground mt-1.5 text-[0.8125rem] leading-[1.6]">
            Software Developer, Electrical &amp; Electronic Engineer.
          </p>
        </header>

        {/*
          The filter is one quiet line, not a prompt. It only earns visual weight once the
          index is long enough to need it, and `/` or any keystroke reaches it from anywhere.
        */}
        <div className="mt-10">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label="Filter this index"
            role="combobox"
            aria-expanded
            aria-controls="site-index"
            aria-activedescendant={
              activeLink === undefined ? undefined : `index-row-${String(activeIndex)}`
            }
            placeholder="Filter  /"
            className="caret-accent placeholder:text-muted-foreground/50 text-foreground w-full border-none bg-transparent p-0 font-mono text-sm outline-none"
          />
          {/* A hairline, not a box: the input reads as a line of text you can type on. */}
          <div
            className={`mt-1.5 h-px transition-colors duration-150 ${
              query === '' ? 'bg-border' : 'bg-accent/60'
            }`}
          />
        </div>

        {/* Announce the count, not each row. */}
        <p className="sr-only" role="status" aria-live="polite">
          {query === ''
            ? `${String(rows.length)} entries`
            : `${String(rows.length)} result${rows.length === 1 ? '' : 's'} for ${query}`}
        </p>

        <div ref={listRef} id="site-index" role="listbox" aria-label="Site index" className="mt-8">
          {rows.map((row, index) => (
            /*
              A Fragment, not a wrapping <div>. Two reasons, and the first was a real bug:

              1. Wrapped, the label was always its wrapper's `:first-child`, so a
                 `first:mt-0` meant to spare the FIRST group applied to every group. The
                 labels then sat 25px below the previous row and 32px above their own — a
                 heading grouped with the wrong side, which is a proximity error, not a
                 spacing preference. The first group is now identified by index.
              2. `role="option"` should be a direct child of `role="listbox"`. The wrappers
                 put a plain div between them.
            */
            <Fragment key={row.link.href}>
              {row.group !== null && (
                <div
                  className={`text-muted-foreground/50 mb-1.5 font-mono text-[0.625rem] tracking-[0.16em] uppercase ${
                    index === 0 ? '' : 'mt-10'
                  }`}
                >
                  {row.group}
                </div>
              )}
              <LinkRow
                link={row.link}
                active={index === activeIndex}
                id={`index-row-${String(index)}`}
                onHover={() => setActiveHref(row.link.href)}
              />
            </Fragment>
          ))}

          {rows.length === 0 && (
            <p className="text-muted-foreground py-4 font-mono text-sm">
              Nothing matches <span className="text-foreground">{query}</span>.
            </p>
          )}
        </div>

        <footer className="text-muted-foreground/50 mt-16 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.625rem] tracking-[0.02em]">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>⌘↵ new tab</span>
          <span>esc clear</span>
        </footer>
      </div>
    </div>
  )
}
