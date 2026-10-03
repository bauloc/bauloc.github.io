import { useLayoutEffect, useSyncExternalStore } from 'react'

/*
  Light / dark, as one class on <html> — `.dark`, the class theme.css already keys its dark
  tokens on, so every token in the app flips together.

  Applied twice on purpose: by a few lines of inline script in index.html BEFORE the bundle
  loads (so a dark-mode visitor never sees a light frame), and here, which keeps it in step
  afterwards — a toggle, the system setting changing, another tab choosing.
*/

export type Theme = 'light' | 'dark'

/** Also read by the inline script in index.html — keep the two in step. */
export const THEME_STORAGE_KEY = 'bauloc:theme'
const SYSTEM_DARK = '(prefers-color-scheme: dark)'

/** A saved choice wins; with none, follow the system. Anything else saved is ignored. */
export function resolveTheme(saved: string | null, systemDark: boolean): Theme {
  if (saved === 'light' || saved === 'dark') return saved
  return systemDark ? 'dark' : 'light'
}

/** Where storage is blocked, a choice still holds for the rest of this page view. */
let unsaved: Theme | null = null

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) ?? unsaved
  } catch {
    return unsaved
  }
}

const listeners = new Set<() => void>()

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  const system = window.matchMedia(SYSTEM_DARK)
  system.addEventListener('change', onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    system.removeEventListener('change', onChange)
    window.removeEventListener('storage', onChange)
  }
}

function currentTheme(): Theme {
  return resolveTheme(readSaved(), window.matchMedia(SYSTEM_DARK).matches)
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/** Choose a theme, remember it, and apply it synchronously (a view transition depends on that). */
export function setTheme(theme: Theme) {
  unsaved = theme
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage blocked: `unsaved` carries the choice.
  }
  apply(theme)
  for (const listener of listeners) listener()
}

export function useTheme(): Theme {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => 'light')
  useLayoutEffect(() => {
    apply(theme)
  }, [theme])
  return theme
}
