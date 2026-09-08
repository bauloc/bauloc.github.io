/**
 * Everything the site root links to, as data.
 *
 * This file is the one place a new destination is added. The landing page is a launcher, so
 * it needs no layout change to absorb more entries — which is the whole reason it was built
 * that way rather than as a card grid capped at three across.
 *
 * None of these is a SPA route, and that is not an oversight:
 *   /profile/  is a prebuilt Flutter bundle served as static files
 *   /iptv      is a raw M3U playlist read directly by player apps
 *   /xconsole/ and /device/ are separate areas, not yet ported
 * So they are plain anchors and a full document load — which is also what keeps middle-click
 * and ⌘-click working for free.
 */

/** Ordered. The launcher renders groups in this order when there is no query. */
export const LINK_GROUPS = ['Tools', 'Site', 'Data'] as const
export type LinkGroup = (typeof LINK_GROUPS)[number]

/**
 * `wip` is load-bearing, not decoration: Device Lab is half-built, and a launcher that
 * presents it identically to a finished tool sends you into a dead end.
 */
export type LinkStatus = 'live' | 'wip' | 'internal'

export interface HomeLink {
  readonly href: string
  readonly icon: string
  readonly title: string
  readonly description: string
  readonly group: LinkGroup
  readonly status: LinkStatus
  /** Extra search terms that do not belong in the visible copy. */
  readonly keywords?: readonly string[]
  /** Opens in a new tab, and gets an affordance saying so. */
  readonly external?: boolean
}

export const HOME_LINKS: readonly HomeLink[] = [
  {
    href: '/xconsole/',
    icon: '⚙️',
    title: 'XConsole',
    description: 'Publish app Terms & Privacy pages straight to this repo.',
    group: 'Tools',
    status: 'internal',
    keywords: ['terms', 'privacy', 'legal', 'github', 'admin', 'iptv sync'],
  },
  {
    href: '/device/',
    icon: '📱',
    title: 'Device Lab',
    description: 'Connected iOS & Android devices — identifiers, screenshots, bug reports.',
    group: 'Tools',
    status: 'wip',
    keywords: ['adb', 'usb', 'android', 'ios', 'udid', 'screenshot', 'qa', 'webusb'],
  },
  {
    href: '/profile/',
    icon: '👤',
    title: 'Profile',
    description: 'Personal portfolio — projects, skills & contact. Built with Flutter.',
    group: 'Site',
    status: 'live',
    keywords: ['about', 'cv', 'resume', 'contact', 'portfolio', 'flutter'],
  },
  {
    href: '/iptv',
    icon: '📺',
    title: 'IPTV playlist',
    description: 'M3U playlist, synced from upstream. Open in any IPTV player.',
    group: 'Data',
    status: 'live',
    keywords: ['m3u', 'playlist', 'tv', 'channels', 'stream'],
  },
  {
    href: 'https://github.com/bauloc',
    icon: '🐙',
    title: 'GitHub',
    description: 'Source for this site and everything on it.',
    group: 'Site',
    status: 'live',
    external: true,
    keywords: ['source', 'code', 'repo', 'git'],
  },
]
