/**
 * Everything the site root links to, as data.
 *
 * This file is the one place a new destination is added. Each entry becomes one sheet in the
 * index's strip, in the order listed here, so adding an entry needs no layout change — and
 * with no `art` it still gets a finished sheet: its own title, set as large as fits.
 *
 * They are plain anchors and a full document load, not router links, and that is not an
 * oversight: /iptv is not a route of this app but a raw M3U playlist read directly by player
 * apps, and /profile/, /xconsole/ and /device/, which are, gain nothing from a client-side
 * jump off a full-screen camera. A plain anchor also keeps middle-click and ⌘-click working.
 */

/** Used by the launcher's ranking (a group name is a search term), not for layout. */
export const LINK_GROUPS = ['Tools', 'Site', 'Data'] as const
export type LinkGroup = (typeof LINK_GROUPS)[number]

/**
 * `wip` is load-bearing, not decoration: Device Lab is half-built, and an index that
 * presents it identically to a finished tool sends you into a dead end. Same for `internal`,
 * which needs a GitHub token. The sheet's label says so before you click.
 */
export type LinkStatus = 'live' | 'wip' | 'internal'

/**
 * What a sheet shows. A small closed vocabulary, all of it type, flat shapes and one colour —
 * there are no illustrations to lean on, and the reference shows none are needed.
 *
 *   word       — the title (or `text`), as large as fits the sheet whole. The default.
 *   monogram   — two letters with a flat circle behind the second, which warms on focus.
 *   pixelPhone — a phone outline drawn on a pixel grid.
 *   testCard   — television colour bars.
 */
export type SheetArt =
  | { readonly kind: 'word'; readonly text?: string }
  | { readonly kind: 'monogram'; readonly letters: string }
  | { readonly kind: 'pixelPhone' }
  | { readonly kind: 'testCard' }

export interface HomeLink {
  readonly href: string
  readonly title: string
  readonly description: string
  readonly group: LinkGroup
  readonly status: LinkStatus
  /** Defaults to `{ kind: 'word' }`. */
  readonly art?: SheetArt
  /** Extra search terms that do not belong in the visible copy. */
  readonly keywords?: readonly string[]
  /** Opens in a new tab, and gets an affordance saying so. */
  readonly external?: boolean
}

export const HOME_LINKS: readonly HomeLink[] = [
  {
    href: '/profile/',
    title: 'Profile',
    description: 'Mobile developer — about, portfolio, resume & contact.',
    group: 'Site',
    status: 'live',
    art: { kind: 'monogram', letters: 'BL' },
    keywords: ['about', 'cv', 'resume', 'contact', 'portfolio', 'games', 'relax'],
  },
  {
    href: '/xconsole/',
    title: 'XConsole',
    description: 'Publish app Terms & Privacy pages straight to this repo.',
    group: 'Tools',
    status: 'internal',
    keywords: ['terms', 'privacy', 'legal', 'github', 'admin', 'iptv sync'],
  },
  {
    href: '/device/',
    title: 'Device Lab',
    description: 'Connected iOS & Android devices — identifiers, screenshots, logs.',
    group: 'Tools',
    status: 'wip',
    art: { kind: 'pixelPhone' },
    keywords: ['adb', 'usb', 'android', 'ios', 'udid', 'screenshot', 'qa', 'webusb'],
  },
  {
    href: '/iptv',
    title: 'IPTV playlist',
    description: 'M3U playlist, synced from upstream. Open in any IPTV player.',
    group: 'Data',
    status: 'live',
    art: { kind: 'testCard' },
    keywords: ['m3u', 'playlist', 'tv', 'channels', 'stream'],
  },
  {
    href: 'https://github.com/bauloc',
    title: 'GitHub',
    description: 'Source for this site and everything on it.',
    group: 'Site',
    status: 'live',
    external: true,
    keywords: ['source', 'code', 'repo', 'git'],
  },
]
