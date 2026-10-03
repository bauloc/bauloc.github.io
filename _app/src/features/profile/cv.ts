/**
 * The CV behind the side panel's DOWNLOAD button (`/profile/cv`, and the PDF made from it by
 * `npm run cv`).
 *
 * Same sources as the rest of the profile — the Resume timeline, the 2016 CV, live App Store
 * listings — and nothing beyond them: no figures, no tools the evidence does not name. The
 * projects come from portfolio.ts, so the two cannot disagree.
 */

export const CV_NAME = 'Nguyen Phuoc Loc'
/** What a downloaded CV is called, rather than its hashed asset name. */
export const CV_FILE_NAME = 'Nguyen-Phuoc-Loc-CV.pdf'
export const CV_TITLE = 'Mobile Developer'

export const CV_CONTACT = [
  { label: 'bauloc79@gmail.com', href: 'mailto:bauloc79@gmail.com' },
  { label: '+84 973 989 634 (Zalo)', href: 'https://zalo.me/+84973989634' },
  { label: 't.me/bauloc', href: 'https://t.me/bauloc' },
  { label: 'bauloc.github.io/profile', href: 'https://bauloc.github.io/profile/' },
  { label: 'github.com/bauloc', href: 'https://github.com/bauloc' },
] as const

export const CV_SUMMARY =
  "Mobile developer with more than ten years of shipping iOS, Apple TV, Android and Flutter apps, from FPT Telecom's FPT Play streaming service to apps I publish on my own developer account. Trained as an electrical and electronic engineer: systematic, careful with details, and used to owning an app from the first idea to the store release and the updates after it."

export const CV_SKILLS = [
  {
    area: 'iOS',
    items: 'Swift, Objective-C, Apple TV (tvOS), app extensions, push notifications (APNs)',
  },
  { area: 'Cross-platform', items: 'Flutter, Dart' },
  { area: 'Android', items: 'Native Android apps' },
  { area: 'Media', items: 'Live TV and video on demand, DRM-protected playback, Chromecast' },
  {
    area: 'Libraries',
    items:
      'CocoaPods, Alamofire, AFNetworking, Kingfisher, SDWebImage, Realm, Facebook and Google SDKs',
  },
  { area: 'Shipping', items: 'App Store Connect, TestFlight, Google Play Console, Crashlytics' },
] as const

export interface CvRole {
  readonly role: string
  readonly company: string
  readonly period: string
  readonly points: readonly string[]
}

export const CV_EXPERIENCE: readonly CvRole[] = [
  {
    role: 'Software Developer',
    company: 'Tevi',
    period: '04/2022 – Present',
    points: [
      'Software developer on Tevi, a platform where content creators earn directly from their fans through livestreams, interactive games, memberships and paid posts.',
    ],
  },
  {
    role: 'Software Developer, FPT Play',
    company: 'FPT Telecom',
    period: '09/2015 – 04/2022',
    points: [
      'Built and developed the FPT Play apps for iOS and Apple TV: live TV with program guides, video on demand, DRM-protected playback and Chromecast.',
      "Developed ABC Play, FPT Telecom's entertainment and learning app for children on iOS and tvOS.",
      'Released through TestFlight and App Store Connect, with Crashlytics crash reporting and push notifications.',
    ],
  },
  {
    role: 'Electrical & Automation Engineer',
    company: 'V.T.E.C.H Electrical Technology Co',
    period: '04/2014 – 08/2015',
    points: [
      'Power quality testing of transformer equipment.',
      'Embedded programming for microcontrollers, and PLC programming.',
    ],
  },
]

export const CV_EDUCATION = [
  {
    school: 'Ho Chi Minh City University of Technology',
    detail: "Engineer's degree, Electrical & Electronic Engineering (Automatic Control)",
    period: '2009 – 2014',
  },
  {
    school: 'Informatics Center, University of Science, Ho Chi Minh City',
    detail: 'Android Developer and iOS Developer programs',
    period: '2014 – 2015',
  },
] as const
