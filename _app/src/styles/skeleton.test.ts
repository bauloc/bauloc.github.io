import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
  The loading skeleton's shimmer (components/ui/skeleton.tsx), as the stylesheets declare it.
  Read as text, like overlays.test.ts and theme.test.ts: each question is "does the file
  still say this".

  - The sweep moves `transform` and nothing else, so the compositor runs it: a band moved by
    background-position, left or width, or one with a filter, restyles and repaints every
    skeleton on every frame, and a list of hundreds of them ties up the main thread (measured
    in Chrome: about 12,000 paints a second for 900 bands moved by `left`, none for these).
  - Reduced motion cuts every animation on the site to 0.01 ms, and must still let the
    skeleton's pulse, and only that, through: a still skeleton reads as a broken page.
*/

const HERE = path.dirname(fileURLToPath(import.meta.url))
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const globals = stripComments(readFileSync(path.join(HERE, 'globals.css'), 'utf8'))
const theme = stripComments(readFileSync(path.join(HERE, 'theme.css'), 'utf8'))

/** The text between the `{` that opens at `from` and the `}` that matches it. */
function block(css: string, from: number): string {
  const open = css.indexOf('{', from)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unbalanced braces')
}

/** Every `@theme` block's body in a stylesheet. */
function themeBlocks(css: string): string[] {
  return [...css.matchAll(/@theme\b[^{]*\{/g)].map((m) => block(css, m.index))
}

/** A keyframes rule's body, from whichever @theme block declares it. */
function keyframes(name: string): string {
  const owner = themeBlocks(globals).find((b) => b.includes(`@keyframes ${name} {`))
  expect(owner, `@keyframes ${name} in an @theme block of globals.css`).toBeDefined()
  const body = owner ?? ''
  return block(body, body.indexOf(`@keyframes ${name} {`))
}

/** The properties a keyframes body declares. */
function animatedProperties(body: string): string[] {
  return [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1] ?? ''))]
}

/** A theme animation token's value, e.g. `skeleton-sweep 2s ease-in-out infinite`. */
function token(name: string): string {
  for (const b of themeBlocks(globals)) {
    const m = new RegExp(`--animate-${name}:\\s*([^;]+);`).exec(b)
    if (m) return (m[1] ?? '').trim()
  }
  throw new Error(`--animate-${name} is not declared`)
}

const reducedMotion = (() => {
  const at = globals.indexOf('@media (prefers-reduced-motion: reduce)')
  expect(at).toBeGreaterThan(-1)
  return block(globals, at)
})()

/** The rules in a block: selector and declarations, nested blocks left out. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
    body: (m[2] ?? '').trim().replace(/\s+/g, ' '),
  }))
}

describe('the skeleton sweep', () => {
  it('moves the band by transform only: no background-position, left, width or filter', () => {
    const body = keyframes('skeleton-sweep')
    expect(animatedProperties(body)).toEqual(['transform'])
    // Across the skeleton and off the far side: from fully left of it to fully right of it.
    expect(body).toMatch(/from\s*\{\s*transform: translateX\(-100%\);\s*\}/)
    expect(body).toMatch(/80%,\s*to\s*\{\s*transform: translateX\(100%\);\s*\}/)
    expect(body).not.toMatch(/background|left|right|width|filter|opacity/)
  })

  it('is calm: about 1.6 s across, eased, then a short rest, forever', () => {
    const [name, duration, easing, count] = token('skeleton-sweep').split(/\s+/)
    expect(name).toBe('skeleton-sweep')
    expect(easing).toBe('ease-in-out')
    expect(count).toBe('infinite')
    const total = Number.parseFloat(duration ?? '')
    expect(duration).toMatch(/^\d+(\.\d+)?s$/)
    // The band crosses in the first 80% of each cycle and rests for the rest.
    const across = total * 0.8
    expect(across).toBeGreaterThanOrEqual(1.4)
    expect(across).toBeLessThanOrEqual(1.8)
    expect(total - across).toBeLessThanOrEqual(0.6)
  })

  it('is declared in @theme like the overlay keyframes, not as a top-level @keyframes', () => {
    const topLevel = themeBlocks(globals).reduce((css, b) => css.replace(b, ''), globals)
    expect(topLevel).not.toMatch(/@keyframes skeleton-/)
    expect(theme).not.toMatch(/@keyframes skeleton-/)
  })
})

describe('the reduced-motion pulse', () => {
  it('fades the skeleton’s opacity and moves nothing', () => {
    const body = keyframes('skeleton-pulse')
    expect(animatedProperties(body)).toEqual(['opacity'])
    const [name, , easing, count] = token('skeleton-pulse').split(/\s+/)
    expect([name, easing, count]).toEqual(['skeleton-pulse', 'ease-in-out', 'infinite'])
  })

  it('still cuts every other animation and transition to 0.01 ms', () => {
    const all = rules(reducedMotion)
    expect(all[0]).toEqual({
      selector: '*, *::before, *::after',
      body: 'animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important;',
    })
  })

  it('lets exactly the pulse through, on skeletons only', () => {
    const all = rules(reducedMotion)
    expect(all).toHaveLength(2)
    expect(all[1]).toEqual({
      selector: "[data-slot='skeleton']",
      body: 'animation: --theme(--animate-skeleton-pulse) !important;',
    })
    // Nothing else in the file names the skeleton, so the exception cannot widen elsewhere.
    expect(globals.match(/data-slot='skeleton'/g)).toHaveLength(1)
  })
})

describe('the skeleton colours', () => {
  const themeInline = themeBlocks(theme).join('\n')

  it('are theme tokens, with a neutral fallback off the console pages', () => {
    // A tint of the text wherever --skeleton isn't set, never the site's saturated --accent.
    expect(themeInline).toContain(
      '--color-skeleton: var(--skeleton, color-mix(in oklab, currentColor 10%, transparent));',
    )
    expect(themeInline).toContain(
      '--color-skeleton-highlight: var(--skeleton-highlight, transparent);',
    )
  })

  /** A console palette block's declarations of the skeleton tokens. */
  function consoleBlock(selector: string): string {
    const at = theme.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return block(theme, at)
  }

  it('derive from the console palette, in light and in dark, with no colour of their own', () => {
    // The site header wears the same palette on every page (components/site-header.tsx).
    const light = consoleBlock("html:has([data-shell='console']),\n[data-site-header]")
    const dark = consoleBlock("html.dark:has([data-shell='console']),\n.dark [data-site-header]")
    // A base a little stronger than the accent tint shadcn's skeleton used.
    expect(light).toContain('--skeleton: color-mix(in oklab, var(--accent), var(--foreground) 7%);')
    // The band is lighter than the base in both modes: the background in light, the text in dark.
    expect(light).toMatch(
      /--skeleton-highlight: color-mix\(in oklab, var\(--background\) \d+%, transparent\);/,
    )
    expect(dark).toMatch(
      /--skeleton-highlight: color-mix\(in oklab, var\(--foreground\) \d+%, transparent\);/,
    )
    for (const css of [light, dark]) {
      for (const m of css.matchAll(/--skeleton[a-z-]*:\s*([^;]+);/g)) {
        expect(m[1]).not.toMatch(/#|oklch|rgb|hsl/)
      }
    }
  })
})
