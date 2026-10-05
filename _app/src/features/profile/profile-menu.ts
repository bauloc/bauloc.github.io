/**
 * The profile's sections, in page order.
 *
 * The paths are the ones the Flutter build wrote into the address bar (`/profile/about_me`,
 * snake case and all), so a link someone copied from the old profile still opens the same
 * section: the one-page profile scrolls to it.
 */
export interface ProfileMenuItem {
  /** Names the section in PROFILE_MESSAGES.section, where its title is in both languages. */
  readonly id: 'about' | 'portfolio' | 'resume' | 'relax' | 'contact'
  readonly to:
    | '/profile/about_me'
    | '/profile/portfolio'
    | '/profile/resume'
    | '/profile/relax'
    | '/profile/contact'
}

export const PROFILE_MENU = [
  { id: 'about', to: '/profile/about_me' },
  { id: 'portfolio', to: '/profile/portfolio' },
  { id: 'resume', to: '/profile/resume' },
  { id: 'relax', to: '/profile/relax' },
  { id: 'contact', to: '/profile/contact' },
] as const satisfies readonly ProfileMenuItem[]

/** The section's element id on the page: the last part of its path (`about_me`). */
export function sectionId(item: ProfileMenuItem): string {
  return item.to.slice('/profile/'.length)
}

/** The section a path names; null for `/profile/` itself, which opens at the top. */
export function menuItemFor(pathname: string): ProfileMenuItem | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return PROFILE_MENU.find((item) => item.to === path) ?? null
}
