import type { MaterialIconName } from './components/material-icon'

/**
 * The profile's sections, in rail order.
 *
 * The paths are the ones the Flutter build wrote into the address bar (`/profile/about_me`,
 * snake case and all), so a link someone copied from the old profile still opens the same
 * section.
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
  readonly icon: MaterialIconName
}

export const PROFILE_MENU = [
  { id: 'about', to: '/profile/about_me', icon: 'accountCircleOutlined' },
  { id: 'portfolio', to: '/profile/portfolio', icon: 'personalVideoRounded' },
  { id: 'resume', to: '/profile/resume', icon: 'list' },
  { id: 'relax', to: '/profile/relax', icon: 'gamesSharp' },
  { id: 'contact', to: '/profile/contact', icon: 'mailOutline' },
] as const satisfies readonly ProfileMenuItem[]

/** Where `/profile/` itself opens. The Flutter build started on Contact, so the port does. */
const LANDING: ProfileMenuItem = PROFILE_MENU[4]

/** The section a path shows; anything that is not a section's own path is the landing. */
export function menuItemFor(pathname: string): ProfileMenuItem {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return PROFILE_MENU.find((item) => item.to === path) ?? LANDING
}
