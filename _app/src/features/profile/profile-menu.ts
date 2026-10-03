import type { MaterialIconName } from './components/material-icon'

/**
 * The profile's sections, in rail order.
 *
 * The paths are the ones the Flutter build wrote into the address bar (`/profile/about_me`,
 * snake case and all), so a link someone copied from the old profile still opens the same
 * section.
 */
export interface ProfileMenuItem {
  readonly title: string
  readonly to:
    | '/profile/about_me'
    | '/profile/portfolio'
    | '/profile/resume'
    | '/profile/relax'
    | '/profile/contact'
  readonly icon: MaterialIconName
}

export const PROFILE_MENU = [
  { title: 'About me', to: '/profile/about_me', icon: 'accountCircleOutlined' },
  { title: 'Portfolio', to: '/profile/portfolio', icon: 'personalVideoRounded' },
  { title: 'Resume', to: '/profile/resume', icon: 'list' },
  { title: 'Relax', to: '/profile/relax', icon: 'gamesSharp' },
  { title: 'Contact', to: '/profile/contact', icon: 'mailOutline' },
] as const satisfies readonly ProfileMenuItem[]

/** Where `/profile/` itself opens. The Flutter build started on Contact, so the port does. */
const LANDING: ProfileMenuItem = PROFILE_MENU[4]

/** The section a path shows; anything that is not a section's own path is the landing. */
export function menuItemFor(pathname: string): ProfileMenuItem {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return PROFILE_MENU.find((item) => item.to === path) ?? LANDING
}
