import abcPlay from './assets/apps/abc-play.jpg'
import caiLuongNamBo from './assets/apps/cailuong-nam-bo.jpg'
import fptPlay from './assets/apps/fpt-play.jpg'
import selfiePuzzle from './assets/apps/selfie-puzzle.jpg'
import tevi from './assets/apps/tevi.jpg'
import webDien from './assets/apps/webdien.jpg'
import xoSo from './assets/apps/xoso.jpg'

/**
 * The apps on the Portfolio page.
 *
 * Sources: the Resume timeline, the 2016 CV (which listed these apps with their features and
 * store links), and the App Store itself. A `link` is set only where the listing was checked
 * and is still live; the older indie apps have left the stores and carry none.
 */
export interface Project {
  readonly title: string
  /** Who it was built for, and when, where that is known. */
  readonly context?: string
  readonly platforms: string
  readonly description: string
  readonly icon: string
  readonly link?: string
}

export const PROFESSIONAL_WORK: readonly Project[] = [
  {
    title: 'FPT Play',
    context: 'FPT Telecom · 2015 – 2022',
    platforms: 'iOS, tvOS',
    description:
      "FPT Telecom's streaming service for live TV, sports, films and shows. I built and developed its iOS and Apple TV apps: live channels with program guides, video on demand, DRM-protected content and casting to the TV.",
    icon: fptPlay,
    link: 'https://apps.apple.com/vn/app/id646297996',
  },
  {
    title: 'ABC Play',
    context: 'FPT Telecom',
    platforms: 'iOS, tvOS',
    description:
      'An entertainment and learning app for children, with cartoons, music and shows, and a separate area for parents.',
    icon: abcPlay,
    link: 'https://apps.apple.com/vn/app/id1059281751',
  },
  {
    title: 'Tevi',
    context: 'TEVI Corporation · 2022 – today',
    platforms: 'iOS',
    description:
      'A platform where content creators earn directly from their fans: livestreams, interactive games, memberships and paid posts. I work on it as a software developer.',
    icon: tevi,
    link: 'https://apps.apple.com/vn/app/id1613448814',
  },
]

export const OWN_APPS: readonly Project[] = [
  {
    title: 'Cải Lương Nam Bộ',
    platforms: 'iOS, Android',
    description:
      'For listening to cải lương, the traditional opera of Southern Vietnam. Its sister apps, Cải Lương 75 and Lời Vọng Cổ, are written in Flutter.',
    icon: caiLuongNamBo,
    link: 'https://apps.apple.com/vn/app/id1171018791',
  },
  {
    title: 'Xổ Số Ba Miền',
    platforms: 'iOS, Android',
    description:
      'Lottery results from all three regions of Vietnam: live draws, a ticket checker that adds up the prize, statistics by week, month and year, and sharing.',
    icon: xoSo,
  },
  {
    title: 'Web Điện',
    platforms: 'Android',
    description:
      'A native client for Webdien.com, a forum for electrical engineers: read, post, edit and quote, subscribe to threads and get notified of new replies.',
    icon: webDien,
  },
  {
    title: 'Selfie Puzzle',
    platforms: 'iOS',
    description:
      'A sliding-puzzle game made from your own photos, taken from the camera, the library or the cloud, in sizes from 3×3 to 6×6.',
    icon: selfiePuzzle,
  },
]
