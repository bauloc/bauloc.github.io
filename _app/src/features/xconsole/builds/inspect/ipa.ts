import {
  openZip,
  ZipError,
  type ZipArchive,
  type ZipEntry,
} from '@/features/device/backends/archive/zip'

import type {
  AppleDevice,
  BuildInspection,
  IconSource,
  InspectProblem,
  ProfileInfo,
} from '../types'
import {
  asDict,
  dictDict,
  dictString,
  dictStrings,
  dictValue,
  parsePlist,
  type PlistDict,
} from './plist'
import { decodeCgbi, isCgbi, pngSize } from './png'
import { parseProvision } from './provision'

/*
  An IPA: a zip whose Payload/ folder holds the app, Payload/<Name>.app/. Everything a link
  install depends on is in that bundle's root: Info.plist (what the app is),
  embedded.mobileprovision (which devices may install it, and until when) and the icon PNGs.
  A watch app or an extension nested deeper has an Info.plist of its own, and is not what a
  tester installs. Only the zip's directory and those few entries are read: never the
  executable or the assets, which are nearly all of a 100 MB IPA.

  Nothing here throws for a bad file: an IPA that cannot be read comes back as an inspection
  with IPA_INVALID (or NO_INFLATE, when it is this browser that cannot read it).
*/

/** The app's own Info.plist; group 1 is the bundle's folder name. */
const APP_PLIST = /^Payload\/([^/]+\.app)\/Info\.plist$/

/** Generous for files that are kilobytes: an Info.plist, a profile listing 100 devices. */
const PLIST_LIMIT = 8 * 1024 * 1024
const PROFILE_LIMIT = 4 * 1024 * 1024
/** Generous too: the icons iOS loads from the bundle's root are at most 180 pixels wide. */
const ICON_LIMIT = 8 * 1024 * 1024
/** Icon files sized up at most: the names an app lists match a handful. */
const MAX_ICON_FILES = 24
/**
 * Icon names tried at most. An app lists a handful, and each is tried against every PNG in the
 * bundle's root: thousands of names beside thousands of PNGs, which only a crafted file has,
 * would keep the tab busy for minutes.
 */
const MAX_ICON_NAMES = 64
/** PNG signature, a CgBI chunk and IHDR: where every icon's size can be read. */
const ICON_HEAD = 64

/** How long before the profile expires a tester is warned that the build stops opening soon. */
const EXPIRES_SOON_MS = 14 * 24 * 60 * 60 * 1000

/** A profile is there, but nothing in it could be read: who may install it is not known. */
const UNKNOWN_PROFILE: ProfileInfo = {
  kind: 'unknown',
  name: '',
  team: '',
  expires: '',
  device_count: null,
}

/** What comes back for a file that could not be read: every fact empty, and why. */
function unreadable(error: unknown): BuildInspection {
  const code =
    error instanceof ZipError && error.code === 'ZIP_NO_INFLATE' ? 'NO_INFLATE' : 'IPA_INVALID'
  return {
    platform: 'ios',
    name: '',
    bundleId: '',
    version: '',
    build: '',
    minOs: '',
    android: null,
    ios: null,
    icon: null,
    problems: [{ code }],
    warnings: [],
  }
}

const text = (dict: PlistDict, key: string) => dictString(dict, key)?.trim() ?? ''

/**
 * UIDeviceFamily: 1 is iPhone (and iPod touch), 2 is iPad; Xcode writes an array of them. An
 * app that names neither runs on iPhone.
 */
function devicesOf(info: PlistDict): AppleDevice[] {
  const raw = dictValue(info, 'UIDeviceFamily')
  const families = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((family) =>
    typeof family === 'string' ? Number(family.trim()) : family,
  )
  const devices: AppleDevice[] = []
  if (families.includes(1)) devices.push('iphone')
  if (families.includes(2)) devices.push('ipad')
  return devices.length > 0 ? devices : ['iphone']
}

/** Names lowercased and without '.png', each once: the start of the files they name. */
const stems = (names: readonly string[]) => [
  ...new Set(
    names
      .map((name) =>
        name
          .trim()
          .replace(/\.png$/i, '')
          .toLowerCase(),
      )
      .filter(Boolean),
  ),
]

/**
 * The names the app gives its primary icon. `files` start the names of its icon files, to
 * which iOS adds only a scale and an idiom (`AppIcon60x60` → `AppIcon60x60@2x.png`,
 * `AppIcon76x76@2x~ipad.png`). `sets` are the asset catalog's names for it
 * (CFBundleIconName), to which actool also adds a size first (`AppIcon` →
 * `AppIcon60x60@2x.png`). An alternate icon has names of its own, under
 * CFBundleAlternateIcons, which are not read.
 */
function iconNames(info: PlistDict): { files: string[]; sets: string[] } {
  const files: string[] = []
  const sets: string[] = []
  for (const key of ['CFBundleIcons', 'CFBundleIcons~ipad']) {
    const primary = dictDict(dictDict(info, key), 'CFBundlePrimaryIcon')
    files.push(...dictStrings(primary, 'CFBundleIconFiles'))
    sets.push(dictString(primary, 'CFBundleIconName') ?? '')
  }
  // Apps from before CFBundleIcons list their files at the top level.
  files.push(...dictStrings(info, 'CFBundleIconFiles'), dictString(info, 'CFBundleIconFile') ?? '')
  return { files: stems(files).slice(0, MAX_ICON_NAMES), sets: stems(sets) }
}

/** What iOS adds to a listed icon file's name: a scale and an idiom (`@2x~ipad.png`). */
const FILE_SUFFIX = /^(?:@\dx)?(?:~[a-z]+)?\.png$/i

/** What actool adds to an icon set's name: a size in points first (`83.5x83.5@2x~ipad.png`). */
const SET_SUFFIX = /^(?:\d+(?:\.\d+)?x\d+(?:\.\d+)?)?(?:@\dx)?(?:~[a-z]+)?\.png$/i

/** Up to `length` bytes from the start of an entry, inflating no more than that needs. */
async function head(zip: ZipArchive, entry: ZipEntry, length: number): Promise<Uint8Array> {
  const reader = (await zip.stream(entry)).getReader()
  const out = new Uint8Array(length)
  let at = 0
  try {
    while (at < length) {
      const step = await reader.read()
      if (step.done) break
      const piece = step.value.subarray(0, length - at)
      out.set(piece, at)
      at += piece.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return out.subarray(0, at)
}

/**
 * The app's icon: of the PNGs in the bundle's root named after the files its primary icon
 * lists (or, failing those, after its icon set, or "AppIcon", and a size), the widest. Names
 * are matched whole, not by their start: actool writes an alternate icon's files, such as
 * `AppIcon-Dark60x60@2x.png` or `AppIcon260x60@2x.png` for a set named AppIcon2, beside
 * `AppIcon60x60@2x.png` at the same sizes, and "AppIcon" starts them all. A CgBI file comes
 * back as pixels, any other PNG as its bytes for the browser to decode. Null when there is
 * none that reads; an icon never makes an IPA unreadable.
 */
async function iconOf(zip: ZipArchive, app: string, info: PlistDict): Promise<IconSource | null> {
  const fileName = (entry: ZipEntry) => entry.name.slice(app.length).toLowerCase()
  const pngs = zip.entries.filter((entry) => {
    const name = fileName(entry)
    return entry.name.startsWith(app) && !name.includes('/') && name.endsWith('.png')
  })
  /** The PNGs named by one of `starts`, followed by what `suffix` allows. */
  const named = (starts: readonly string[], suffix: RegExp) =>
    pngs.filter((entry) => {
      const name = fileName(entry)
      return starts.some((start) => name.startsWith(start) && suffix.test(name.slice(start.length)))
    })
  const { files, sets } = iconNames(info)
  const listed = named(files, FILE_SUFFIX)
  const candidates = listed.length > 0 ? listed : named([...sets, 'appicon'], SET_SUFFIX)

  const sized: { entry: ZipEntry; width: number }[] = []
  for (const entry of candidates.slice(0, MAX_ICON_FILES)) {
    const size = await head(zip, entry, ICON_HEAD).then(pngSize, () => null)
    if (size) sized.push({ entry, width: size.width })
  }
  sized.sort((a, b) => b.width - a.width)

  for (const { entry } of sized) {
    try {
      const bytes = await zip.bytes(entry, ICON_LIMIT)
      if (!isCgbi(bytes)) return { kind: 'image', mime: 'image/png', bytes }
      const { width, height, rgba } = await decodeCgbi(bytes)
      return { kind: 'rgba', width, height, rgba }
    } catch {
      // A damaged icon: the next widest may still read.
    }
  }
  return null
}

/**
 * An IPA's facts and problems: what the app is, and whether a tester can install it from a
 * link. `now` decides whether its profile has expired or soon will. Never rejects.
 */
export async function inspectIpa(file: Blob, now: Date = new Date()): Promise<BuildInspection> {
  try {
    const zip = await openZip(file)
    const apps = zip.entries.flatMap((entry) => {
      const match = APP_PLIST.exec(entry.name)
      return match ? [{ entry, bundle: match[1] ?? '' }] : []
    })
    const [app] = apps
    if (!app || apps.length > 1) return unreadable(null)
    const root = `Payload/${app.bundle}/`

    const info = asDict(parsePlist(await zip.bytes(app.entry, PLIST_LIMIT)))
    const bundleId = info ? text(info, 'CFBundleIdentifier') : ''
    // iOS installs nothing without a bundle identifier, and the OTA manifest needs one.
    if (!info || !bundleId) return unreadable(null)

    const profileEntry = zip.get(`${root}embedded.mobileprovision`)
    const profile = profileEntry
      ? (parseProvision(await zip.bytes(profileEntry, PROFILE_LIMIT)) ?? UNKNOWN_PROFILE)
      : null

    const problems: InspectProblem[] = []
    const warnings: InspectProblem[] = []
    if (!profile) problems.push({ code: 'IPA_NO_PROFILE' })
    else if (profile.kind === 'app-store') problems.push({ code: 'IPA_APP_STORE' })
    if (profile?.kind === 'development') warnings.push({ code: 'IPA_DEVELOPMENT' })
    if (profile?.expires) {
      const left = Date.parse(profile.expires) - now.getTime()
      if (left <= 0) problems.push({ code: 'IPA_EXPIRED', detail: profile.expires })
      else if (left < EXPIRES_SOON_MS) {
        warnings.push({ code: 'IPA_EXPIRES_SOON', detail: profile.expires })
      }
    }

    return {
      platform: 'ios',
      name:
        text(info, 'CFBundleDisplayName') ||
        text(info, 'CFBundleName') ||
        text(info, 'CFBundleExecutable') ||
        app.bundle.replace(/\.app$/, ''),
      bundleId,
      version: text(info, 'CFBundleShortVersionString'),
      build: text(info, 'CFBundleVersion'),
      minOs: text(info, 'MinimumOSVersion'),
      android: null,
      ios: { devices: devicesOf(info), profile },
      icon: await iconOf(zip, root, info).catch(() => null),
      problems,
      warnings,
    }
  } catch (error) {
    return unreadable(error)
  }
}
