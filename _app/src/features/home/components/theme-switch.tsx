import { flushSync } from 'react-dom'

import { setTheme, useTheme, type Theme } from '@/lib/theme'

import { TextSwitch } from './text-switch'

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: Theme; label: string }[]

/**
 * Reveal the new theme as a circle growing from the switch, through a view transition. Falls
 * back to an instant switch where view transitions are missing or motion is reduced.
 */
function switchTo(next: Theme, from: HTMLElement) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || !('startViewTransition' in document)) {
    setTheme(next)
    return
  }
  const box = from.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  const transition = document.startViewTransition(() => {
    // The snapshot is taken when this returns, so React must have committed by then.
    flushSync(() => {
      setTheme(next)
    })
  })
  const at = `at ${String(x)}px ${String(y)}px`
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px ${at})`, `circle(${String(radius)}px ${at})`] },
      {
        duration: 650,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  })
}

/** "Light  Dark", bottom right. */
export function ThemeSwitch() {
  const theme = useTheme()
  return (
    <TextSwitch
      label="Colour theme"
      options={OPTIONS}
      value={theme}
      onSelect={switchTo}
      className="right-6"
    />
  )
}
