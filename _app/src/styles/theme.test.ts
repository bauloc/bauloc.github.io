import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import legacyPalette from './legacy-palette.json'

/*
  Drift guard for the unified palette.

  The same colours used to live in four hand-synced copies. `legacy-palette.json` was
  extracted programmatically from the real legacy files — `device/app.css`, whose values win
  because it is the newest fork, cross-checked against `xconsole/style.css` (all 12 shared
  colours matched exactly) and the landing page's inline `:root` (all 7 dark values matched
  the console palette). Nothing in it was typed by hand.

  These tests read theme.css as TEXT rather than through a browser. That is deliberate: the
  question is "does this file still declare that value", which is exactly a text question,
  and it costs no jsdom and no Tailwind build.

  The expected values live in JSON, not inline, because `no-restricted-syntax` bans hex
  colour literals in TypeScript and this file should not be the exception that erodes it.
*/

const THEME_DIR = path.dirname(fileURLToPath(import.meta.url))
const themeCss = readFileSync(path.join(THEME_DIR, 'theme.css'), 'utf8')

/** Strip comments first: prose about a colour is not a declaration of it. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every `--name: value;` declaration in a chunk of CSS, last one winning as CSS would. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  // `[^;}]` and an optional terminator: the generated pages are MINIFIED, so the last
  // declaration in a block ends at `}` with no semicolon. Matching only on `;` made the
  // value swallow the brace, and `#1e1b4b}` then failed every equality check silently.
  for (const match of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined) continue
    out.set(name, value.trim())
  }
  return out
}

/** Every top-level block matching a selector, merged. */
function blockDeclarations(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>()
  const bare = stripComments(css)
  const head = new RegExp(`(?:^|})\\s*${selector.replace('.', '\\.')}\\s*{`, 'g')
  for (const match of bare.matchAll(head)) {
    const open = match.index + match[0].length - 1
    const close = bare.indexOf('}', open)
    for (const [k, v] of declarations(bare.slice(open, close))) out.set(k, v)
  }
  return out
}

/*
  Mode-aware tokens are declared TWICE — light in `:root`, dark in `.dark` — so comparing
  against the whole file silently reads the dark value. There are three `:root` blocks
  (mode-aware, fixed chrome, status), all merged here; `.dark` is read separately.
*/
const root = blockDeclarations(themeCss, ':root')
const dark = blockDeclarations(themeCss, '.dark')
const themeBlock = declarations(themeCss.slice(themeCss.indexOf('@theme inline')))

/*
  `#fff` and `#ffffff` are the same colour. The legacy files used the short form in two
  places; theme.css uses the long one throughout. Normalising is the honest comparison —
  the test is looking for a changed COLOUR, not a changed spelling.
*/
function normaliseHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value.trim())
  if (short === null) return value.trim().toLowerCase()
  return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
}

describe('theme.css carries the legacy palette', () => {
  for (const [token, expected] of Object.entries(legacyPalette)) {
    it(`${token} is still ${expected}`, () => {
      const actual = root.get(token)
      expect(actual, `${token} is not declared in any :root block`).toBeDefined()
      expect(normaliseHex(actual ?? '')).toBe(normaliseHex(expected))
    })
  }
})

describe('the two measured identities that let the palettes merge', () => {
  /*
    The landing page is dark and the Device Lab's log console is dark, and they were
    measured to be the same five values. If someone re-shades one of them, this fails and
    names which.
  */
  it('the dark mode surface set equals the console palette', () => {
    expect(dark.get('--background')).toBe(root.get('--console'))
    expect(dark.get('--card')).toBe(root.get('--console-surface'))
    expect(dark.get('--border')).toBe(root.get('--console-border'))
    expect(dark.get('--foreground')).toBe(root.get('--console-foreground'))
    expect(dark.get('--muted-foreground')).toBe(root.get('--console-muted'))
  })

  it('the chrome tokens are NOT redefined under .dark', () => {
    // The top bar is dark in light mode by design. Flipping it with the mode would wash it
    // out, which is the bug a naive light/dark strategy introduces here.
    for (const token of ['--chrome', '--chrome-foreground', '--console', '--console-surface']) {
      expect(dark.has(token)).toBe(false)
    }
  })
})

describe('the semantic split the Device Lab depends on', () => {
  it('unauthorized is red and offline is grey, not the same tone', () => {
    // `unauthorized` is actionable right now (tap Allow on the phone); `offline` is inert
    // and usually a cable. Collapsing them into one colour loses the only signal that tells
    // a tester whether to do something.
    expect(root.get('--st-bad')).toBe(root.get('--destructive'))
    expect(root.get('--st-off')).not.toBe(root.get('--st-bad'))
    expect(root.get('--st-off')).not.toBe(root.get('--st-warn'))
  })

  it('iOS and Android identity colours stay distinguishable', () => {
    expect(root.get('--ios')).not.toBe(root.get('--android'))
    expect(root.get('--ios-surface')).not.toBe(root.get('--android-surface'))
  })
})

describe('load-bearing geometry', () => {
  // These are not styling preferences. Each one breaks something specific if changed.
  const geometry: Record<string, string> = {
    '--spacing-topbar': '52px',
    '--spacing-list': '380px',
    // Fixed, not min-content: change it and every identifier row rewraps.
    '--spacing-idlabel': '118px',
    '--spacing-card': '280px',
    // 3 x 280 + 2 x 16 — what caps the landing grid at three across.
    '--spacing-cards-max': '872px',
  }

  for (const [token, expected] of Object.entries(geometry)) {
    it(`${token} is ${expected}`, () => {
      expect(themeBlock.get(token)).toBe(expected)
    })
  }

  it('the cards grid maximum is exactly three cards plus two gaps', () => {
    const card = Number.parseInt(themeBlock.get('--spacing-card') ?? '', 10)
    const max = Number.parseInt(themeBlock.get('--spacing-cards-max') ?? '', 10)
    expect(max).toBe(card * 3 + 16 * 2)
  })
})

describe('the generator palette is deliberately absent', () => {
  /*
    The generated legal pages carry a fourth, independent palette. They are live URLs in App
    Store and Play Console submissions, a reviewer's crawler runs no JS and loads none of our
    CSS, and unifying them would change bytes that have already been reviewed.

    The expected values are read from the DEPLOYED page rather than written here. Two
    reasons: no hex literal has to be smuggled past the no-raw-hex lint rule, and the test
    keeps telling the truth if the generator's palette ever changes.
  */
  const generatedPages = ['terms', 'privacy'].map((kind) =>
    path.resolve(THEME_DIR, '../../..', kind, 'test-app-kaka', 'index.html'),
  )

  /*
    The brand accent RAMP is legitimately shared: the Terms page's blue theme was written
    from the same three values the site uses (--accent / --accent-hover / --accent-tint).
    Measured, not assumed — the Privacy page's green family overlaps nothing.

    Everything else must stay separate. The header gradients in particular
    (--hdr-a / --hdr-b, per page) are what would create pressure to "unify the palette",
    and unifying them rewrites bytes an app-store reviewer has already seen.
  */
  const brandRamp = new Set(
    ['--accent', '--accent-hover', '--accent-tint']
      .map((t) => root.get(t) ?? '')
      .map(normaliseHex),
  )

  it.each(generatedPages)('%s shares only the brand ramp with theme.css', (page) => {
    const html = readFileSync(page, 'utf8')
    const generatorColours = [...declarations(html).values()].filter((v) => v.startsWith('#'))

    // Sanity: if the page stopped declaring colours this test would pass vacuously.
    expect(generatorColours.length).toBeGreaterThanOrEqual(6)

    const siteColours = new Set(
      [...root.values(), ...dark.values(), ...themeBlock.values()]
        .filter((v) => v.startsWith('#'))
        .map(normaliseHex),
    )
    const leaked = generatorColours
      .map(normaliseHex)
      .filter((c) => !brandRamp.has(c) && siteColours.has(c))

    expect(leaked, 'only the brand ramp may be shared with the generator').toEqual([])
  })
})
