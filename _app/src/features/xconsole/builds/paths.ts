import { MAX_FILE_BYTES, REPO } from '../repo/github'
import { SITE } from '../site'
import type { BuildEntry, BuildPlatform } from './types'

/*
  Where a build lives in the repo and on the site:

    data/build/db.json                 the index the console lists
    build/<id>/index.html              the install page testers open
    build/<id>/<file>.apk|.ipa         the binary, under 100 MiB
    build/<id>/icon.png                the app's icon, when it could be drawn
    build/<id>/manifest.plist          iOS: what itms-services reads

  A binary of 100 MiB or more is not in the repo at all: GitHub refuses the file there, so it is
  an asset of a GitHub Release (tag `build-<id>-<yyyyMMddHHmmss>`), and only its address changes.
*/

export const BUILD_DB_PATH = 'data/build/db.json'
export const BUILD_DIR = 'build'
export const ICON_FILE = 'icon.png'
export const MANIFEST_FILE = 'manifest.plist'

/** GitHub's own limit on a file in the repo: a binary this large goes to a release instead. */
export const MAX_BUILD_BYTES = MAX_FILE_BYTES
/**
 * The largest release asset GitHub takes: every asset must be under 2 GiB. The Device Lab
 * helper's own cap on what it forwards is the same number (2_147_483_647).
 */
export const RELEASE_MAX_BYTES = 2 * 1024 ** 3 - 1
/** GitHub warns about files this big; every upload also stays in the repo's history for good. */
export const WARN_BUILD_BYTES = 50 * 1024 * 1024
/** A Pages site may be at most 1 GB: the builds share it with the rest of the site. */
export const SITE_BUDGET_BYTES = 1024 ** 3

export const buildDir = (id: string) => `${BUILD_DIR}/${id}`
export const buildPagePath = (id: string) => `${BUILD_DIR}/${id}/index.html`
export const buildFilePath = (id: string, file: string) => `${BUILD_DIR}/${id}/${file}`

/** The link testers get. The trailing slash spares them Pages' redirect from /build/<id>. */
export const buildUrl = (id: string, origin = SITE) => `${origin}/${BUILD_DIR}/${id}/`
export const buildFileUrl = (id: string, file: string, origin = SITE) =>
  `${origin}/${BUILD_DIR}/${id}/${file}`

/** Always the live site: iOS installs only from https with a trusted certificate. */
export const manifestUrl = (id: string) => buildFileUrl(id, MANIFEST_FILE)

/**
 * What the iOS Install button opens. The manifest URL goes in unencoded, as Apple's own example
 * writes it: an id and a file name are letters, digits, '.', '-' and '/' only.
 */
export const itmsUrl = (id: string) =>
  `itms-services://?action=download-manifest&url=${manifestUrl(id)}`

/** A binary's file name as binaryFileName writes it; checked again wherever one is read back. */
export const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,78}\.(?:apk|ipa)$/

/* ---------------------------------------------------------------- *
 * Binaries of 100 MiB or more: a GitHub Release's asset
 * ---------------------------------------------------------------- */

/** Whether a binary of `size` bytes is too large for the repo, so it goes to a release. */
export const needsRelease = (size: number) => size >= MAX_BUILD_BYTES

/**
 * A large build's release tag: `build-<id>-<yyyyMMddHHmmss>` in UTC. The time keeps a new version
 * under the same link from colliding with the tag of the release it replaces, which is deleted
 * only after the new one is published.
 */
export const RELEASE_TAG_PATTERN = /^build-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-\d{14}$/

/** The tag for a release of build `id`, made at `now`. */
export function releaseTag(id: string, now: Date): string {
  // 2026-10-07T08:15:30.123Z → 20261007081530
  return `build-${id}-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`
}

/** Where every release asset of this repo downloads from; the helper checks its answer by it. */
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download/`

/**
 * A release asset's address. GitHub answers it with a redirect to its file storage, which sends
 * the file as an attachment: what an Android phone downloads and iOS installs from.
 */
export const releaseDownloadUrl = (tag: string, file: string) =>
  `${RELEASE_DOWNLOAD_BASE}${tag}/${file}`

/**
 * Where a build's binary downloads from: its release asset when it has one (always absolute, on
 * github.com), else build/<id>/<file> on `origin` ('' for an address relative to the site's
 * root). Every part goes in percent-encoded: encoding leaves a valid id, tag and file name as
 * they are, and a hand-edited index cannot point the address anywhere else.
 */
export function binaryUrl(
  entry: Pick<BuildEntry, 'id' | 'file' | 'release'>,
  origin = SITE,
): string {
  const file = encodeURIComponent(entry.file)
  return entry.release
    ? releaseDownloadUrl(encodeURIComponent(entry.release.tag), file)
    : buildFileUrl(encodeURIComponent(entry.id), file, origin)
}

/** Accents folded (đ by hand: it has no decomposition), lowercase, then only a–z 0–9 and '.'. */
function part(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * The binary's name on the site — what an Android phone saves the download as, so a tester can
 * tell builds apart in their Downloads: `My App` 1.2.0 (45) → `my-app-1.2.0-45.apk`. It never
 * starts with '.', '_' or '-' (Jekyll drops files whose names start with '.' or '_').
 */
export function binaryFileName(
  name: string,
  version: string,
  build: string,
  platform: BuildPlatform,
): string {
  const stem = [part(name) || 'app', part(version), part(build)]
    .filter(Boolean)
    .join('-')
    .slice(0, 75)
    .replace(/[-.]+$/, '')
  return `${stem || 'app'}.${platform === 'android' ? 'apk' : 'ipa'}`
}

/**
 * Every file a build owns on the site: the binary too, unless it is a release's asset (`release`
 * set), which is not in the repo.
 */
export function buildFiles(
  entry: Pick<BuildEntry, 'id' | 'platform' | 'file' | 'icon'> & {
    readonly release?: BuildEntry['release']
  },
): string[] {
  return [
    buildPagePath(entry.id),
    ...(entry.release ? [] : [buildFilePath(entry.id, entry.file)]),
    ...(entry.icon ? [buildFilePath(entry.id, entry.icon)] : []),
    ...(entry.platform === 'ios' ? [buildFilePath(entry.id, MANIFEST_FILE)] : []),
  ]
}
