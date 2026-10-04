// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Skeleton } from './skeleton'

/*
  The skeleton is a shimmer, not shadcn's pulse: a base a little stronger than the accent
  tint, and a band (its ::after) that globals.css sweeps across it by transform. jsdom runs
  no CSS, so this pins the structure the stylesheet relies on; globals.css and theme.css are
  pinned by src/styles/skeleton.test.ts, and the motion itself was checked in Chrome.
*/

afterEach(cleanup)

const SHIMMER = [
  // The shape: its own base colour, and a clip for the band at the skeleton's own radius.
  'relative',
  'overflow-hidden',
  'bg-skeleton',
  // The band: the ::after, the skeleton's size, a soft highlight in the middle, swept.
  'after:absolute',
  'after:inset-0',
  'after:bg-linear-to-r',
  'after:from-transparent',
  'after:via-skeleton-highlight',
  'after:to-transparent',
  'after:animate-skeleton-sweep',
  // Reduced motion: no band, a pulse instead.
  'motion-reduce:after:hidden',
  'motion-reduce:animate-skeleton-pulse',
]

function skeleton(props: React.ComponentProps<typeof Skeleton> = {}): HTMLElement {
  const { container } = render(<Skeleton {...props} />)
  const el = container.querySelector<HTMLElement>('[data-slot="skeleton"]')
  if (!el) throw new Error('no skeleton rendered')
  return el
}

describe('Skeleton', () => {
  it('renders the shimmer: a clipped base and a swept band', () => {
    const el = skeleton()
    expect(el.tagName).toBe('DIV')
    for (const name of SHIMMER) expect(el, name).toHaveClass(name)
    expect(el).toHaveClass('rounded-md')
    // Not shadcn's pulse on the light accent tint any more, which read as a static colour.
    expect(el).not.toHaveClass('animate-pulse')
    expect(el).not.toHaveClass('bg-accent')
    expect(el).toBeEmptyDOMElement()
  })

  it('takes the size and radius a call site gives it, and keeps the shimmer', () => {
    // As the Apps tab's icon and line placeholders, and the Images tab's tiles, set them.
    for (const [className, radius] of [
      ['size-9 rounded-lg', 'rounded-lg'],
      ['h-4 w-1/3', 'rounded-md'],
      ['aspect-square w-full rounded-lg', 'rounded-lg'],
      ['size-full rounded-none', 'rounded-none'],
      ['h-44 rounded-xl', 'rounded-xl'],
    ] as const) {
      const el = skeleton({ className })
      for (const name of className.split(' ')) expect(el, className).toHaveClass(name)
      for (const name of SHIMMER) expect(el, `${className}: ${name}`).toHaveClass(name)
      const radii = [...el.classList].filter((c) => /^rounded(-|$)/.test(c))
      expect(radii, className).toEqual([radius])
      cleanup()
    }
  })

  it('adds no size, spacing or display of its own, so call sites lay it out', () => {
    const own = [...skeleton().classList].filter((c) => !c.includes(':'))
    expect(own.sort()).toEqual(['bg-skeleton', 'overflow-hidden', 'relative', 'rounded-md'])
  })

  it('passes attributes through: aria-hidden, a role, data-*, style', () => {
    const el = skeleton({
      'aria-hidden': true,
      role: 'presentation',
      // As the sidebar's menu skeleton passes them.
      ...({ 'data-sidebar': 'menu-skeleton-text' } as object),
      style: { '--skeleton-width': '70%' } as React.CSSProperties,
    })
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).toHaveAttribute('role', 'presentation')
    expect(el).toHaveAttribute('data-sidebar', 'menu-skeleton-text')
    expect(el.style.getPropertyValue('--skeleton-width')).toBe('70%')
  })
})
