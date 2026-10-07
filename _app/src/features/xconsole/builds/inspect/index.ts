import { canInflate } from '@/features/device/backends/archive/zip'

import { RELEASE_MAX_BYTES, WARN_BUILD_BYTES, needsRelease } from '../paths'
import type { BuildInspection, BuildPlatform, InspectCode, InspectProblem } from '../types'
import { inspectApk } from './apk'
import { inspectIpa } from './ipa'

/*
  The one way in: what the Upload sheet calls with the file that was dropped. The checks that
  need no parsing come first, so a photo, an error page saved as .apk or a 3 GB build is
  answered at once, and only a file that could be published is read for what it is.

  A build of any size GitHub takes is read, up to its 2 GiB limit on a release file: the readers
  open the zip from its end and inflate only a few small entries (the manifest, Info.plist, the
  profile, the icon), so a 1.5 GB build costs no more to read than a 15 MB one.

  It never rejects. Whatever is wrong with a file, down to one the browser can no longer read,
  comes back as a problem the sheet words, with the file's name to show.
*/

/** The platform a file's name says it is for; null for anything but .apk and .ipa. */
export function platformOf(fileName: string): BuildPlatform | null {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase()
  if (extension === 'apk') return 'android'
  if (extension === 'ipa') return 'ios'
  return null
}

/** The file's name without its extension: what a build is called until it has been read. */
const stemOf = (fileName: string) => fileName.replace(/\.[^.]*$/, '')

/** A zip's first local header: every APK and IPA starts with one, whatever its name says. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

async function startsLikeZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, ZIP_MAGIC.length).arrayBuffer())
  return ZIP_MAGIC.every((byte, i) => head[i] === byte)
}

/**
 * What the size alone says of a build GitHub takes: from 100 MiB it goes to a release instead of
 * the repo; from 50 MiB in the repo, it stays in the repo's history for good. Only one of the
 * two: a release file does not grow the repo at all.
 */
function sizeWarnings(size: number): InspectProblem[] {
  if (needsRelease(size)) return [{ code: 'VIA_RELEASE' }]
  return size >= WARN_BUILD_BYTES ? [{ code: 'LARGE' }] : []
}

/** A file that was not read: its name, and why. */
function refused(platform: BuildPlatform, name: string, code: InspectCode): BuildInspection {
  return {
    platform,
    name,
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

/**
 * Reads an .apk or .ipa in the browser: what it is, and whether a tester can install it from a
 * link. Never rejects; see the problems and warnings.
 */
export async function inspectBuild(file: File, now: Date = new Date()): Promise<BuildInspection> {
  const name = stemOf(file.name)
  const platform = platformOf(file.name)
  if (!platform) return refused('android', name, 'NOT_A_BUILD')
  try {
    if (!(await startsLikeZip(file))) return refused(platform, name, 'NOT_A_BUILD')
    // GitHub refuses the file whatever it holds, even as a release's, so there is nothing to
    // read it for.
    if (file.size > RELEASE_MAX_BYTES) return refused(platform, name, 'TOO_LARGE')
    const size = sizeWarnings(file.size)
    // An APK keeps its manifest compressed, and an IPA its Info.plist: without an inflater
    // neither can be read at all.
    if (!canInflate()) return { ...refused(platform, name, 'NO_INFLATE'), warnings: size }
    const read = platform === 'android' ? await inspectApk(file) : await inspectIpa(file, now)
    return { ...read, name: read.name || name, warnings: [...read.warnings, ...size] }
  } catch {
    return refused(platform, name, platform === 'android' ? 'APK_INVALID' : 'IPA_INVALID')
  }
}
