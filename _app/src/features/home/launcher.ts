import { LINK_GROUPS, type HomeLink, type LinkGroup } from './home-links'

/**
 * The launcher's pure logic: filtering, ranking and grouping. No React, no DOM.
 *
 * Split out so the behaviour that decides what you see when you type two letters is unit
 * tested rather than eyeballed — it is the part of this page most likely to quietly get
 * worse as entries are added.
 */

/** A visible row, flattened. `group` is null when the results are a flat ranked list. */
export interface LauncherRow {
  readonly link: HomeLink
  readonly group: LinkGroup | null
}

export interface LauncherView {
  readonly rows: readonly LauncherRow[]
  /** True when rows are grouped under headings (no query), false when ranked flat. */
  readonly grouped: boolean
}

/**
 * Match rank, lowest wins. Deliberately coarse and predictable: a prefix of the title beats
 * a word inside it, which beats a keyword, which beats the description. Fuzzy subsequence
 * matching was considered and rejected — with a handful of short names it mostly produces
 * surprising hits ("dvc" matching "Device Lab" is fine; "de" matching "GitHub" via
 * d-e in "source code" is not).
 */
function rank(link: HomeLink, needle: string): number {
  const title = fold(link.title)
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  // A word boundary inside the title, e.g. "lab" in "Device Lab".
  if (title.split(/\s+/).some((word) => word.startsWith(needle))) return 2
  if (title.includes(needle)) return 3
  if (fold(link.group).startsWith(needle)) return 4
  if ((link.keywords ?? []).some((k) => fold(k).startsWith(needle))) return 5
  if ((link.keywords ?? []).some((k) => fold(k).includes(needle))) return 6
  if (fold(link.description).includes(needle)) return 7
  return Number.POSITIVE_INFINITY
}

/**
 * Lowercase, without diacritics: Vietnamese is typed without its marks as often as with them
 * (and the index's type-ahead only hears plain letters), so "ho so" has to find "Hồ sơ".
 * Đ is a letter of its own, not D with a mark, so it is folded by hand.
 */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase()
}

export function normaliseQuery(query: string): string {
  return fold(query.trim())
}

/**
 * Build what the page should render.
 *
 * With no query: every link, grouped, in LINK_GROUPS order — so a first-time visitor sees
 * the whole site rather than an empty box asking them to guess.
 * With a query: a flat list ordered by rank, ties broken by the original order so the result
 * never reshuffles arbitrarily between keystrokes.
 */
export function buildView(links: readonly HomeLink[], query: string): LauncherView {
  const needle = normaliseQuery(query)

  if (needle === '') {
    const rows: LauncherRow[] = []
    for (const group of LINK_GROUPS) {
      let first = true
      for (const link of links) {
        if (link.group !== group) continue
        rows.push({ link, group: first ? group : null })
        first = false
      }
    }
    return { rows, grouped: true }
  }

  const scored = links
    .map((link, index) => ({ link, index, score: rank(link, needle) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)

  return { rows: scored.map(({ link }) => ({ link, group: null })), grouped: false }
}

/** Wrap-around index movement for ↑/↓. Returns 0 for an empty list so nothing is selected. */
export function moveActive(active: number, delta: number, count: number): number {
  if (count === 0) return 0
  return (((active + delta) % count) + count) % count
}
