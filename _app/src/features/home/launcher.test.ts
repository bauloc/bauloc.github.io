import { describe, expect, it } from 'vitest'

import { HOME_LINKS, LINK_GROUPS } from './home-links'
import { buildView, moveActive, normaliseQuery } from './launcher'

const titles = (query: string) => buildView(HOME_LINKS, query).rows.map((r) => r.link.title)

describe('no query: the whole site, grouped', () => {
  it('shows every link', () => {
    expect(buildView(HOME_LINKS, '').rows).toHaveLength(HOME_LINKS.length)
  })

  it('is marked as grouped', () => {
    expect(buildView(HOME_LINKS, '').grouped).toBe(true)
  })

  it('orders groups by LINK_GROUPS, not by the data order', () => {
    const groupsInOrder = buildView(HOME_LINKS, '').rows.map((r) => r.link.group)
    const firstSeen = [...new Set(groupsInOrder)]
    expect(firstSeen).toEqual(LINK_GROUPS.filter((g) => firstSeen.includes(g)))
  })

  it('sets the heading on the first row of each group only', () => {
    const rows = buildView(HOME_LINKS, '').rows
    const headings = rows.filter((r) => r.group !== null).map((r) => r.group)
    expect(headings).toEqual([...new Set(rows.map((r) => r.link.group))])
  })

  it('whitespace-only is treated as no query', () => {
    expect(buildView(HOME_LINKS, '   ').grouped).toBe(true)
  })
})

describe('ranking is predictable', () => {
  it('a title prefix wins', () => {
    expect(titles('dev')[0]).toBe('Device Lab')
  })

  it('a word inside the title matches', () => {
    expect(titles('lab')).toContain('Device Lab')
  })

  it('matches a keyword that appears nowhere in the visible copy', () => {
    // 'udid' is only in Device Lab's keywords.
    expect(titles('udid')).toEqual(['Device Lab'])
  })

  it('a title match outranks a description match', () => {
    // 'profile' is Profile's title and appears in no other title.
    expect(titles('profile')[0]).toBe('Profile')
  })

  it('matches a group name', () => {
    const result = titles('tools')
    expect(result).toContain('XConsole')
    expect(result).toContain('Device Lab')
  })

  it('is case-insensitive', () => {
    expect(titles('DEVICE')).toEqual(titles('device'))
  })

  it('returns nothing for a miss, rather than everything', () => {
    expect(titles('zzzzz')).toEqual([])
  })

  it('a filtered view is flat, not grouped', () => {
    expect(buildView(HOME_LINKS, 'dev').grouped).toBe(false)
    expect(buildView(HOME_LINKS, 'dev').rows.every((r) => r.group === null)).toBe(true)
  })

  it('ties keep the original order, so results do not reshuffle between keystrokes', () => {
    // Both XConsole and Device Lab match the group 'Tools' at the same rank; the data order
    // must decide, or the list would appear to jump for no reason.
    expect(titles('tool')).toEqual(['XConsole', 'Device Lab'])
  })
})

describe('normaliseQuery', () => {
  it('trims and lowercases', () => {
    expect(normaliseQuery('  DeViCe  ')).toBe('device')
  })
})

describe('moveActive wraps in both directions', () => {
  it('moves down', () => {
    expect(moveActive(0, 1, 3)).toBe(1)
  })

  it('wraps past the end', () => {
    expect(moveActive(2, 1, 3)).toBe(0)
  })

  it('wraps before the start', () => {
    expect(moveActive(0, -1, 3)).toBe(2)
  })

  it('is safe on an empty list', () => {
    expect(moveActive(0, 1, 0)).toBe(0)
    expect(moveActive(0, -1, 0)).toBe(0)
  })
})

describe('the data itself', () => {
  it('every group is one of LINK_GROUPS', () => {
    for (const link of HOME_LINKS) {
      expect(LINK_GROUPS).toContain(link.group)
    }
  })

  it('hrefs are unique — a duplicate would make two rows share a React key', () => {
    const hrefs = HOME_LINKS.map((l) => l.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('every external link is absolute, and every internal one is root-relative', () => {
    for (const link of HOME_LINKS) {
      if (link.external === true) expect(link.href).toMatch(/^https?:\/\//)
      else expect(link.href.startsWith('/')).toBe(true)
    }
  })
})
