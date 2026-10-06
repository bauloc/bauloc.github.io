import type { Localized } from '@/lib/i18n'
import type { Locale } from '@/lib/locale'

/**
 * Everything the site root links to, as data.
 *
 * This file is the one place a new destination is added. Each entry becomes one sheet in the
 * index's strip, in the order listed here, so adding an entry needs no layout change — and
 * with no `art` it still gets a finished sheet: its own title, set as large as fits.
 *
 * They are plain anchors and a full document load, not router links, and that is not an
 * oversight: /profile/, /xconsole/ and /device/ gain nothing from a client-side jump off a
 * full-screen camera, and a plain anchor keeps middle-click and ⌘-click working.
 *
 * /iptv is deliberately not here. It is a raw M3U playlist that player apps read directly
 * (XConsole keeps it in sync), not a page anyone browses to.
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
 * What a sheet shows. A small closed vocabulary, all of it type, flat shapes and pixel
 * drawings in the reference's few colours — no photographs or illustrations to lean on, and
 * the reference shows none are needed. Each comes alive a little while its sheet is in front
 * of the camera, or hovered.
 *
 *   word          — the title (or `text`), as large as fits the sheet whole. The default.
 *   monogram      — two letters with a flat circle behind the second, which warms on focus.
 *   badge         — a name badge: a portrait on yellow that warms on focus, and a CV's lines.
 *   terminal      — a console window whose prompt's caret blinks on focus.
 *   pixelPhone    — a phone, plugged in, whose screen lights up on focus.
 *   contributions — GitHub's graph of squares with `text` written in its busy days.
 *   testCard      — television colour bars.
 */
export type SheetArt =
  | { readonly kind: 'word'; readonly text?: string }
  | { readonly kind: 'monogram'; readonly letters: string }
  | { readonly kind: 'badge' }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'pixelPhone' }
  | { readonly kind: 'contributions'; readonly text: string }
  | { readonly kind: 'testCard' }

/** A link as a sheet shows it: its words in the language on screen. */
export interface HomeLink {
  readonly href: string
  readonly title: string
  readonly description: string
  readonly group: LinkGroup
  readonly status: LinkStatus
  /** Defaults to `{ kind: 'word' }`. */
  readonly art?: SheetArt
  /**
   * Extra search terms that do not belong in the visible copy, in either language. Typed
   * without diacritics, as the launcher compares them (`gioi thieu`, not `giới thiệu`).
   */
  readonly keywords?: readonly string[]
  /** Opens in a new tab, and gets an affordance saying so. */
  readonly external?: boolean
}

/** A link as written here: its title and description in both languages. */
interface HomeLinkSource extends Omit<HomeLink, 'title' | 'description'> {
  readonly title: Localized<string>
  readonly description: Localized<string>
}

const SOURCES: readonly HomeLinkSource[] = [
  {
    href: '/profile/',
    title: { en: 'Profile', vi: 'Hồ sơ' },
    description: {
      en: 'Software developer — about, portfolio, resume & contact.',
      vi: 'Lập trình viên phần mềm — giới thiệu, dự án, lý lịch và liên hệ.',
    },
    group: 'Site',
    status: 'live',
    art: { kind: 'badge' },
    keywords: [
      'profile',
      'about',
      'cv',
      'resume',
      'contact',
      'portfolio',
      'games',
      'relax',
      'gioi thieu',
      'ly lich',
      'lien he',
      'du an',
    ],
  },
  {
    href: '/xconsole/',
    title: { en: 'XConsole', vi: 'XConsole' },
    description: {
      en: 'Publish app Terms & Privacy pages straight to this repo.',
      vi: 'Đăng trang Điều khoản và Quyền riêng tư của ứng dụng thẳng lên repo này.',
    },
    group: 'Tools',
    status: 'internal',
    art: { kind: 'terminal' },
    keywords: ['terms', 'privacy', 'legal', 'github', 'admin', 'iptv sync', 'dieu khoan'],
  },
  {
    href: '/device/',
    title: { en: 'Device Lab', vi: 'Device Lab' },
    description: {
      en: 'Connected iOS & Android devices — identifiers, screenshots, logs.',
      vi: 'Thiết bị iOS và Android đang cắm vào máy — định danh, ảnh chụp màn hình, log.',
    },
    group: 'Tools',
    status: 'wip',
    art: { kind: 'pixelPhone' },
    keywords: [
      'adb',
      'usb',
      'android',
      'ios',
      'udid',
      'screenshot',
      'qa',
      'webusb',
      'thiet bi',
      'dien thoai',
    ],
  },
  {
    href: 'https://github.com/bauloc',
    title: { en: 'GitHub', vi: 'GitHub' },
    description: {
      en: 'Source for this site and everything on it.',
      vi: 'Mã nguồn của trang này và mọi thứ trên đó.',
    },
    group: 'Site',
    status: 'live',
    art: { kind: 'contributions', text: 'BAULOC' },
    external: true,
    keywords: ['source', 'code', 'repo', 'git', 'ma nguon'],
  },
]

function inLocale(locale: Locale): readonly HomeLink[] {
  return SOURCES.map(({ title, description, ...link }) => ({
    ...link,
    title: title[locale],
    description: description[locale],
  }))
}

/** Every link, worded for each language. Same entries, same order, in both. */
export const HOME_LINKS: Localized<readonly HomeLink[]> = { en: inLocale('en'), vi: inLocale('vi') }
