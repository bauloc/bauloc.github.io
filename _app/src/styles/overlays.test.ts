import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
  Guards for what made dialogs, sheets and menus lag on a long page (Device Lab's Apps tab with
  hundreds of apps), each measured in Chrome before it was fixed:

  - a `:has()` followed by a descendant (`html:has(…) *`, or Tailwind's `group-has-*`, which
    compiles to `:is(.group:has(…) *)`) makes Chrome restyle every element on the page whenever
    an element is added or removed anywhere: three to four full-page style passes per open
    and close;
  - tw-animate-css's keyframes animate `filter: blur(…)`, which keeps every overlay animation
    off the compositor;
  - an overlay that finished fading before its content let go of the scroll lock early, and
    the page's scrollbar came back under a dialog that was still on screen.

  Read as text, like theme.test.ts: each question is "does the file still say this".
*/

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..')
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every selector in a stylesheet's text, split on commas, with at-rule preludes left out. */
function selectors(css: string): string[] {
  const out: string[] = []
  for (const match of stripComments(css).matchAll(/([^{};]+)\{/g)) {
    const head = (match[1] ?? '').trim()
    if (head.startsWith('@') || head === '' || /^(from|to|\d+%)$/.test(head)) continue
    out.push(...head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')))
  }
  return out
}

/** What follows each `:has(...)` in a selector, its parentheses matched. */
function afterHas(selector: string): string[] {
  const tails: string[] = []
  let from = selector.indexOf(':has(')
  while (from !== -1) {
    let depth = 0
    let i = from + ':has'.length
    for (; i < selector.length; i++) {
      if (selector[i] === '(') depth++
      else if (selector[i] === ')' && --depth === 0) break
    }
    tails.push(selector.slice(i + 1))
    from = selector.indexOf(':has(', i)
  }
  return tails
}

/** Source files under src/, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('no :has() that restyles the whole page', () => {
  it('lets a :has() in the global CSS reach only <html> itself, <body> or its scrollbar', () => {
    for (const file of ['styles/globals.css', 'styles/theme.css']) {
      for (const selector of selectors(read(file))) {
        for (const tail of afterHas(selector)) {
          expect(['', ' body', '::-webkit-scrollbar'], `${file}: ${selector}`).toContain(tail)
        }
      }
    }
  })

  it('finds the selector tails it is looking for', () => {
    expect(afterHas("html:has([data-shell='console']) *")).toEqual([' *'])
    expect(afterHas('html:has(main:has(> a)) body')).toEqual([' body'])
    expect(selectors('a:has(b) *, c { x: y }')).toEqual(['a:has(b) *', 'c'])
  })

  it('uses no group-has-* or peer-has-* variants anywhere', () => {
    const offenders = sources(SRC)
      .filter((file) => /\b(group|peer)-has-/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    expect(offenders).toEqual([])
  })
})

describe('the consoles’ border and outline colours', () => {
  const globals = stripComments(read('styles/globals.css'))

  it('come from custom properties that only a console’s <html> and the site header define', () => {
    // A `*` rule reads them, so a value anywhere else (`:root`, a page) would leak site-wide.
    // The site header is one element: they reach only what is inside it.
    const everywhere = stripComments(read('styles/theme.css')) + globals
    const blocks = [
      ...everywhere.matchAll(/([^{};]+)\{([^{}]*--shell-(?:border|outline)\s*:[^{}]*)\}/g),
    ]
    expect(blocks.map((m) => (m[1] ?? '').split(',').map((selector) => selector.trim()))).toEqual([
      ["html:has([data-shell='console'])", '[data-site-header]'],
    ])
    expect(globals).toMatch(
      /\*,\s*\*::before,\s*\*::after\s*\{\s*border-color: var\(--shell-border\);\s*outline-color: var\(--shell-outline\);\s*\}/,
    )
  })

  it('keep the console focus ring, which used to win over :focus-visible by specificity', () => {
    expect(globals).toMatch(
      /:focus-visible\s*\{\s*outline: 2px solid var\(--shell-outline, var\(--color-accent\)\);/,
    )
  })
})

describe('overlay keyframes', () => {
  it('replace tw-animate-css’s enter and exit with ones that animate no filter', () => {
    const globals = stripComments(read('styles/globals.css'))
    const theme = globals.slice(globals.indexOf('@theme inline {'))
    for (const name of ['enter', 'exit']) {
      const at = theme.indexOf(`@keyframes ${name} {`)
      expect(at, name).toBeGreaterThan(-1)
      const body = theme.slice(at, theme.indexOf('}\n  }', at))
      expect(body).toContain('opacity:')
      expect(body).toContain('transform:')
      expect(body).not.toContain('filter')
    }
  })

  it('still have something to replace: the library’s own keyframes blur', () => {
    // If tw-animate-css drops the filter, the override in globals.css can go.
    const lib = readFileSync(
      path.join(SRC, '../node_modules/tw-animate-css/dist/tw-animate.css'),
      'utf8',
    )
    expect(lib).toMatch(/@keyframes enter\s*\{[^}]*filter:\s*blur/)
  })
})

describe('overlay motion', () => {
  /** The ms of a `data-[state=…]:duration-N` class in a class string, or of a bare `duration-N`. */
  function duration(classes: string, state: 'open' | 'closed'): number {
    const scoped = new RegExp(`data-\\[state=${state}\\]:duration-(\\d+)`).exec(classes)
    const bare = /(?:^|\s)duration-(\d+)/.exec(classes)
    return Number((scoped ?? bare)?.[1] ?? 150) // tw-animate-css's default
  }

  /** The class strings of a component file, in order. */
  function classStrings(rel: string): string[] {
    return [...read(rel).matchAll(/"([^"]*(?:animate-in|animate-out)[^"]*)"/g)].map(
      (m) => m[1] ?? '',
    )
  }

  it.each([
    ['components/ui/dialog.tsx', 150, 100],
    ['components/ui/alert-dialog.tsx', 150, 100],
    ['components/ui/sheet.tsx', 200, 150],
  ])('%s: overlay and content fade in %i ms and out in %i ms, together', (file, open, closed) => {
    const [overlay, content] = classStrings(file)
    for (const classes of [overlay ?? '', content ?? '']) {
      expect(duration(classes, 'open')).toBe(open)
      expect(duration(classes, 'closed')).toBe(closed)
      expect(classes).toContain('data-[state=open]:ease-out')
      expect(classes).toContain('data-[state=closed]:ease-in')
      expect(classes).not.toMatch(/zoom-(in|out)-95|duration-(300|500)/)
    }
  })

  it.each(['components/ui/dropdown-menu.tsx', 'components/ui/tooltip.tsx'])(
    '%s: in 150 ms, out 100 ms, a 2% scale and a 4px slide at most',
    (file) => {
      const strings = classStrings(file)
      expect(strings.length).toBeGreaterThan(0)
      for (const classes of strings) {
        expect(duration(classes, 'open')).toBe(150)
        expect(duration(classes, 'closed')).toBe(100)
        expect(classes).toContain('zoom-in-98')
        expect(classes).not.toMatch(/zoom-(in|out)-95|slide-in-from-\w+-2\b/)
      }
    },
  )
})

describe('toasts while a modal overlay holds the scroll lock', () => {
  const globals = stripComments(read('styles/globals.css'))

  it('keep their right edge on a wide window (Sonner places them by a right offset)', () => {
    expect(globals).toMatch(
      /body\[data-scroll-locked\] \[data-sonner-toaster\]\[data-x-position='right'\] \{\s*margin-right: var\(--removed-body-scroll-bar-size, 0px\);/,
    )
  })

  it('keep it at 600 px and narrower too, where Sonner stretches the toaster instead', () => {
    expect(globals).toMatch(
      /@media \(max-width: 600px\) \{\s*body\[data-scroll-locked\] \[data-sonner-toaster\] \{\s*width: calc\(100% - var\(--removed-body-scroll-bar-size, 0px\)\);/,
    )
    // What that answers: Sonner's own narrow layout, a left offset and the full width.
    const sonner = readFileSync(path.join(SRC, '../node_modules/sonner/dist/index.mjs'), 'utf8')
    expect(sonner).toMatch(
      /@media \(max-width:600px\)\{\[data-sonner-toaster\]\{position:fixed;right:var\(--mobile-offset-right\);left:var\(--mobile-offset-left\);width:100%\}/,
    )
  })
})
