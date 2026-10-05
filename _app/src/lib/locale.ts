import { useLayoutEffect, useSyncExternalStore } from 'react'

/*
  English or Vietnamese, one choice for every page of the site, kept the way the theme is
  (src/lib/theme.ts): a saved choice wins, otherwise the browser's own language preference
  decides. <html lang> follows it, so screen readers voice the page in the right language
  and the browser does not offer to translate a page that is already in yours.

  Applied twice, like the theme: by the inline script in index.html BEFORE the bundle loads,
  and here, which keeps it in step afterwards — a switch, another tab choosing, the
  browser's languages changing.
*/

export type Locale = 'en' | 'vi'

/**
 * The site's languages, each named in itself: a reader scans a switch for their own
 * language's name, never for its name in the language they cannot read.
 */
export const LANGUAGES = [
  { value: 'en', short: 'EN', name: 'English' },
  { value: 'vi', short: 'VI', name: 'Tiếng Việt' },
] as const satisfies readonly { value: Locale; short: string; name: string }[]

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'vi'
}

/** Also read by the inline script in index.html — keep the two in step. */
export const LOCALE_STORAGE_KEY = 'bauloc:locale'

/**
 * A saved choice wins. With none, the first of the browser's languages that the site speaks,
 * so a visitor who reads Vietnamese first gets Vietnamese; anyone else gets English.
 */
export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (isLocale(saved)) return saved
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0]
    if (isLocale(primary)) return primary
  }
  return 'en'
}

/** Where storage is blocked, a choice still holds for the rest of this page view. */
let unsaved: Locale | null = null

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) ?? unsaved
  } catch {
    return unsaved
  }
}

function browserLanguages(): readonly string[] {
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language]
}

/**
 * The language right now. For code outside React that words something on the spot — an
 * error, a toast — and is called again from a component that re-renders on a change.
 * English where there is no browser at all (a test in Node).
 */
export function currentLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  return resolveLocale(readSaved(), browserLanguages())
}

const listeners = new Set<() => void>()

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  window.addEventListener('languagechange', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
    window.removeEventListener('languagechange', onChange)
  }
}

function apply(locale: Locale) {
  document.documentElement.lang = locale
}

/** Choose a language, remember it, and apply it at once. */
export function setLocale(locale: Locale) {
  unsaved = locale
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage blocked: `unsaved` carries the choice.
  }
  apply(locale)
  for (const listener of listeners) listener()
}

export function useLocale(): Locale {
  const locale = useSyncExternalStore<Locale>(subscribe, currentLocale, () => 'en')
  useLayoutEffect(() => {
    apply(locale)
  }, [locale])
  return locale
}

/** The BCP 47 tag `Intl` formats numbers and dates with, for each language. */
export const INTL_LOCALE: Readonly<Record<Locale, string>> = { en: 'en-US', vi: 'vi-VN' }
