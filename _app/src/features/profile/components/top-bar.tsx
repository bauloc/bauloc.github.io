import { useEffect, useState } from 'react'

import { SITE_MESSAGES } from '@/components/messages'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { LANGUAGES, setLocale, useLocale } from '@/lib/locale'
import { setTheme, useTheme } from '@/lib/theme'

import { MaterialIcon } from './material-icon'

/** Material 3's state layer: on-surface at 8% under the pointer, 10% pressed. */
const STATE_LAYER =
  'transition-colors hover:bg-profile-on-surface/[0.08] active:bg-profile-on-surface/10 focus-visible:-outline-offset-2'

/** True once the page has scrolled, which is when M3 draws the bar's edge. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const update = () => {
      setScrolled(window.scrollY > 0)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => {
      window.removeEventListener('scroll', update)
    }
  }, [])
  return scrolled
}

/**
 * EN · VI: two pills on a tonal track, the current one filled with the scheme's secondary
 * container. 40 px tall, the height of the theme button beside it, and no outline, so the
 * pair reads as one quiet group rather than a form control.
 */
export function LanguageSegments() {
  const locale = useLocale()
  const t = useMessages(SITE_MESSAGES)
  return (
    <div
      role="group"
      aria-label={t.language}
      className="bg-profile-surface-container-low flex h-10 shrink-0 items-center gap-0.5 rounded-full p-1"
    >
      {LANGUAGES.map((language) => (
        <button
          key={language.value}
          type="button"
          lang={language.value}
          aria-label={language.name}
          title={language.name}
          aria-pressed={language.value === locale}
          onClick={() => {
            setLocale(language.value)
          }}
          className={cn(
            'text-profile-on-surface-variant h-8 min-w-10 cursor-pointer rounded-full px-3 text-[13px] leading-5 font-medium tracking-[0.1px]',
            'aria-pressed:bg-profile-secondary-container aria-pressed:text-profile-on-surface aria-pressed:hover:bg-profile-secondary-container',
            STATE_LAYER,
          )}
        >
          {language.short}
        </button>
      ))}
    </div>
  )
}

/** Light ⇄ dark as an M3 icon button: the icon shows the mode it switches to. */
export function ThemeButton() {
  const theme = useTheme()
  const t = useMessages(SITE_MESSAGES)
  const next = theme === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? t.darkMode : t.lightMode
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(next)
      }}
      className={cn(
        'text-profile-on-surface-variant grid size-10 shrink-0 cursor-pointer place-items-center rounded-full',
        STATE_LAYER,
      )}
    >
      <MaterialIcon name={next === 'dark' ? 'darkMode' : 'lightMode'} />
    </button>
  )
}

/**
 * The bar above each section: the way back to the site's home page on the left, the
 * language and the theme on the right, both lined up with the section's own edges (its
 * padding: 12 px, then 32 px at `wide`). Nothing in between — the rail already says which
 * section this is, so a title here only repeated it.
 *
 * It sticks to the top on the page's own colour and, as Material 3 does, draws its edge
 * only once content scrolls beneath it.
 */
export function TopBar() {
  const t = useMessages(SITE_MESSAGES)
  const scrolled = useScrolled()
  return (
    <header
      className={cn(
        'bg-profile-page wide:px-8 sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b px-3 transition-colors',
        scrolled ? 'border-profile-outline/30' : 'border-transparent',
      )}
    >
      {/* Pulled left by its own padding, so the arrow, not the pill, meets the edge. */}
      <a
        href="/"
        title={t.homeTitle}
        className={cn(
          'text-profile-on-surface -ml-3 inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-[14px] leading-5 font-medium tracking-[0.1px] no-underline sm:pr-4',
          STATE_LAYER,
        )}
      >
        <MaterialIcon name="arrowBack" />
        <span className="max-sm:sr-only">{t.home}</span>
      </a>
      <div className="-mr-1 flex items-center gap-1">
        <LanguageSegments />
        <ThemeButton />
      </div>
    </header>
  )
}
