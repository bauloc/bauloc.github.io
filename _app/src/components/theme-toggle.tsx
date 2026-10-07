import { Moon, Sun } from 'lucide-react'
import { flushSync } from 'react-dom'

import { Button } from '@/components/ui/button'
import { useMessages } from '@/lib/i18n'
import { setTheme, useTheme, type Theme } from '@/lib/theme'

import { SITE_MESSAGES } from './messages'

/**
 * Reveal the new theme as a circle growing from the button, through a view transition — the
 * home page's switch did this before the site header took its place. Falls back to an instant
 * switch where view transitions are missing or motion is reduced.
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

/** Light ⇄ dark, shadcn's mode toggle, in the site header on every page. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme()
  const t = useMessages(SITE_MESSAGES)
  const next = theme === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? t.darkMode : t.lightMode
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      title={label}
      onClick={(event) => {
        switchTo(next, event.currentTarget)
      }}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  )
}
