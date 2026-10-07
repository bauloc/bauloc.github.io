import { currentLocale, INTL_LOCALE, type Locale } from '@/lib/locale'

import { isId } from '../ids'
import {
  isGitHubId,
  type ReleaseInput,
  type Releases,
  type Repo,
  type RepoEntry,
  type RepoWrite,
} from '../repo/github'
import { BUILD_MESSAGES } from './messages'
import {
  BUILD_DB_PATH,
  BUILD_DIR,
  FILE_NAME_PATTERN,
  ICON_FILE,
  MANIFEST_FILE,
  RELEASE_MAX_BYTES,
  RELEASE_TAG_PATTERN,
  WARN_BUILD_BYTES,
  buildFilePath,
  buildFiles,
  buildPagePath,
  buildUrl,
  needsRelease,
  releaseTag,
} from './paths'
import { qrSvg } from './qr'
import { installPageHtml } from './templates/install-page'
import { manifestPlist } from './templates/manifest'
import type {
  AndroidFacts,
  AppleDevice,
  BuildDb,
  BuildEntry,
  BuildInspection,
  BuildPlatform,
  InspectCode,
  IosFacts,
  ProfileInfo,
  ProfileKind,
  ReleaseInfo,
} from './types'

/*
  Builds, as data and pure functions: what data/build/db.json holds, and exactly which files a
  publish, an edit or a delete writes and removes. No React and no network beyond what a caller
  hands in, so all of it is tested (model.test.ts), and the page and the sheet only render and
  wire. Where the files live is paths.ts; what a build is, types.ts.

  One commit per change, as Term & Privacy does: the binary, its icon, its install page, the iOS
  manifest and the index can never disagree, because they only ever change together.
*/

/** A build index with nothing in it: what the console starts from before the first upload. */
export const EMPTY_BUILD_DB: BuildDb = { version: 1, entries: [] }

/** The install page's title line has room for a name, not a paragraph. */
export const NAME_MAX = 100
/** Release notes are a few lines for testers; a changelog this long belongs somewhere else. */
export const NOTES_MAX = 5000

/** What the sheet finds itself when a new version replaces a build, beside what inspect/ finds. */
export type ReplaceCode = 'REPLACE_PLATFORM' | 'REPLACE_BUNDLE'
export type FindingCode = InspectCode | ReplaceCode

export interface Finding {
  readonly code: FindingCode
  readonly detail?: string
}

export interface Findings {
  /** Blocking: publishing stays off while any is present. */
  readonly problems: readonly Finding[]
  readonly warnings: readonly Finding[]
}

/* ---------------------------------------------------------------- *
 * Parsing — an index edited by hand, or written by an older console, is not trusted.
 * ---------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
/** A count of something: a whole number, never negative; 0 for anything else. */
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PROFILE_KINDS: readonly ProfileKind[] = [
  'development',
  'ad-hoc',
  'enterprise',
  'app-store',
  'unknown',
]
const isProfileKind = (value: unknown): value is ProfileKind =>
  PROFILE_KINDS.some((kind) => kind === value)
const isAppleDevice = (value: string): value is AppleDevice =>
  value === 'iphone' || value === 'ipad'

function androidFacts(value: unknown): AndroidFacts | null {
  if (!isRecord(value)) return null
  return {
    target_sdk: count(value.target_sdk),
    debuggable: value.debuggable === true,
    abis: strings(value.abis),
  }
}

function profileInfo(value: unknown): ProfileInfo | null {
  if (!isRecord(value)) return null
  return {
    kind: isProfileKind(value.kind) ? value.kind : 'unknown',
    name: str(value.name),
    team: str(value.team),
    expires: str(value.expires),
    device_count:
      typeof value.device_count === 'number' &&
      Number.isSafeInteger(value.device_count) &&
      value.device_count >= 0
        ? value.device_count
        : null,
  }
}

function iosFacts(value: unknown): IosFacts | null {
  if (!isRecord(value)) return null
  return {
    devices: strings(value.devices).filter(isAppleDevice),
    profile: profileInfo(value.profile),
  }
}

/**
 * Where an entry's binary is: null for one in the repo (no `release`, or null: every entry
 * from before releases), the release otherwise — or undefined when it is there and cannot be
 * trusted. Its tag forms the binary's address and its ids are what a delete deletes, so, like
 * the other fields that do, a bad one drops the whole entry. The tag must also be this build's
 * own (`build-<id>-…`): another build's would point this install page at that build's file,
 * and deleting this build would delete it.
 */
function releaseOf(value: unknown, id: string): ReleaseInfo | null | undefined {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) return undefined
  const { id: release, tag, asset_id } = value
  if (!isGitHubId(release) || !isGitHubId(asset_id) || typeof tag !== 'string') return undefined
  if (!RELEASE_TAG_PATTERN.test(tag) || /^build-(.+)-\d{14}$/.exec(tag)?.[1] !== id) {
    return undefined
  }
  return { id: release, tag, asset_id }
}

/**
 * One entry of the index, or null when it cannot be trusted. Its id, platform, file name and
 * release make up every path and address the console builds for it, and a delete removes what
 * they name — so an entry that fails any of them is dropped rather than repaired. So is the
 * icon's name: anything but icon.png is read as no icon.
 */
function parseEntry(raw: unknown): BuildEntry | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const platform: BuildPlatform | null =
    raw.platform === 'android' || raw.platform === 'ios' ? raw.platform : null
  const file = str(raw.file)
  if (!isId(id) || platform === null || !FILE_NAME_PATTERN.test(file)) return null
  // An .ipa behind an Android Install button downloads a file no phone can use, and the reverse.
  if (!file.endsWith(platform === 'android' ? '.apk' : '.ipa')) return null
  const release = releaseOf(raw.release, id)
  if (release === undefined) return null
  const sha256 = str(raw.sha256)
  return {
    id,
    platform,
    name: str(raw.name).trim() || id,
    bundle_id: str(raw.bundle_id),
    version: str(raw.version),
    build: str(raw.build),
    file,
    size: count(raw.size),
    sha256: SHA256_PATTERN.test(sha256) ? sha256 : '',
    icon: raw.icon === ICON_FILE ? ICON_FILE : '',
    min_os: str(raw.min_os),
    notes: str(raw.notes),
    android: platform === 'android' ? androidFacts(raw.android) : null,
    ios: platform === 'ios' ? iosFacts(raw.ios) : null,
    release,
    // A hand-written entry without it was uploaded when it was created, as far as anyone knows.
    uploaded_at: str(raw.uploaded_at) || str(raw.created_at),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  }
}

/**
 * data/build/db.json, narrowed from whatever it holds. A file without an `entries` list is
 * refused outright: shown as an empty list, the next upload would write that list back over
 * the real one. Within the list, malformed entries are dropped, and a second entry for an id
 * already seen is too — two entries cannot both own build/<id>/.
 */
export function parseBuildDb(text: string): BuildDb {
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error(BUILD_MESSAGES[currentLocale()].problems.notAnIndex(BUILD_DB_PATH))
  }
  const seen = new Set<string>()
  const entries: BuildEntry[] = []
  for (const raw of data.entries) {
    const entry = parseEntry(raw)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    ...(typeof data.updated_at === 'string' ? { updated_at: data.updated_at } : {}),
    entries,
  }
}

/**
 * The index at `ref` (default: the published branch): as committed; empty when there has never
 * been a build; null when it is missing although build/ is not empty. That last case is never
 * shown as an empty list, for the reason parseBuildDb refuses a file without entries: the next
 * upload would replace the real list with a list of one.
 */
export async function readBuildDb(
  repo: Pick<Repo, 'read' | 'list'>,
  ref?: string,
): Promise<BuildDb | null> {
  const text = await repo.read(BUILD_DB_PATH, ref)
  if (text !== null) return parseBuildDb(text)
  const listing = await repo.list(BUILD_DIR, ref)
  return listing === null || listing.length === 0 ? EMPTY_BUILD_DB : null
}

/**
 * Deletes a build's GitHub Release, then its tag — each on its own, best effort — and says
 * whether both are gone (or already were). The release goes first: GitHub leaves a release's
 * tag behind when the release goes, while a tag deleted first would leave the release behind
 * as a draft. Never rejects: a release that stays is reported by the caller, once the change
 * it belonged to is done, and never undoes that change.
 */
export async function deleteBuildRelease(
  repo: Pick<Releases, 'deleteRelease' | 'deleteTag'>,
  release: Pick<ReleaseInfo, 'id' | 'tag'>,
): Promise<boolean> {
  const released = await repo.deleteRelease(release.id).then(
    () => true,
    () => false,
  )
  const untagged = await repo.deleteTag(release.tag).then(
    () => true,
    () => false,
  )
  return released && untagged
}

/* ---------------------------------------------------------------- *
 * Wording and figures the list shows
 * ---------------------------------------------------------------- */

/** `1.2.0 (45)`, `1.2.0` or `(45)`: a version as the console, the commits and the page name it. */
export function versionLabel(entry: Pick<BuildEntry, 'version' | 'build'>): string {
  return [entry.version.trim(), entry.build.trim() ? `(${entry.build.trim()})` : '']
    .filter(Boolean)
    .join(' ')
}

/**
 * What the builds take up on the site, binaries only: pages and icons are a rounding error. A
 * binary in a GitHub Release is not part of the site, so it does not count against the Pages
 * limit the figure is shown beside.
 */
export const storageUsed = (db: BuildDb) =>
  db.entries.reduce((sum, e) => (e.release ? sum : sum + e.size), 0)

/** Lowercase, accents folded (đ by hand): so `cai luong` finds "Cải Lương". */
const folded = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()

/** Whether the search box's text finds a build, by name, bundle id, version, build or link. */
export function matchesBuild(entry: BuildEntry, query: string): boolean {
  const words = folded(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = folded(
    [entry.name, entry.bundle_id, entry.version, entry.build, entry.id, entry.file].join(' '),
  )
  return words.every((word) => haystack.includes(word))
}

/**
 * How far an upload has got, in the total's own unit so the two read as one figure:
 * `{ sent: '12.3', total: '45.6 MB' }` → "Uploading 12.3 of 45.6 MB". 1024-based, one decimal
 * below 100, as formatBytes writes sizes everywhere else in the console.
 */
export function uploadedOf(
  sent: number,
  total: number,
  locale: Locale,
): { sent: string; total: string } {
  const UNITS = ['B', 'KB', 'MB', 'GB'] as const
  let unit = 0
  let scaled = Math.max(0, total)
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024
    unit++
  }
  const digits = unit === 0 || scaled >= 100 ? 0 : 1
  const number = new Intl.NumberFormat(INTL_LOCALE[locale], {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
  const shown = Math.min(Math.max(0, sent), Math.max(0, total)) / 1024 ** unit
  return { sent: number.format(shown), total: `${number.format(scaled)} ${UNITS[unit] ?? ''}` }
}

/** SHA-256 of a file, lowercase hex: what the install page shows testers to check a download. */
export async function sha256Hex(data: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await data.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/* ---------------------------------------------------------------- *
 * Findings — what the sheet shows under a build before it may be published
 * ---------------------------------------------------------------- */

/**
 * What the size alone says: GitHub refuses a file of 2 GiB or more even as a release's; from
 * 100 MiB the binary goes to a release instead of the repo; from 50 MiB in the repo, it stays
 * in the repo's history for good (a release file does not grow the repo, so never both).
 */
export function sizeFindings(size: number): Findings {
  if (size > RELEASE_MAX_BYTES) return { problems: [{ code: 'TOO_LARGE' }], warnings: [] }
  if (needsRelease(size)) return { problems: [], warnings: [{ code: 'VIA_RELEASE' }] }
  if (size >= WARN_BUILD_BYTES) return { problems: [], warnings: [{ code: 'LARGE' }] }
  return { problems: [], warnings: [] }
}

/**
 * Whether a new version is another app than the one the link holds: the same platform under
 * another bundle id. A bundle id either side could not read says nothing, so it is not one.
 */
function otherApp(current: BuildEntry, inspection: BuildInspection): boolean {
  const before = current.bundle_id.trim()
  const after = inspection.bundleId.trim()
  return (
    inspection.platform === current.platform && before !== '' && after !== '' && before !== after
  )
}

/**
 * What changes when a new version goes in under a link testers already hold. Another platform
 * is refused — the page would turn from an iPhone's into an Android phone's under the testers'
 * feet — and another app is worth a warning: it may be a mistake, or a renamed bundle id.
 */
export function replaceFindings(current: BuildEntry, inspection: BuildInspection): Findings {
  if (inspection.platform !== current.platform) {
    return { problems: [{ code: 'REPLACE_PLATFORM' }], warnings: [] }
  }
  if (otherApp(current, inspection)) {
    return {
      problems: [],
      warnings: [{ code: 'REPLACE_BUNDLE', detail: current.bundle_id.trim() }],
    }
  }
  return { problems: [], warnings: [] }
}

/** Several findings as one, each code once (inspect/ may report the size too), problems first. */
export function mergeFindings(...all: readonly Findings[]): Findings {
  const once = (list: readonly Finding[]) => {
    const seen = new Set<FindingCode>()
    return list.filter((finding) => {
      if (seen.has(finding.code)) return false
      seen.add(finding.code)
      return true
    })
  }
  const problems = once(all.flatMap((f) => f.problems))
  const blocking = new Set(problems.map((p) => p.code))
  const warnings = once(all.flatMap((f) => f.warnings))
  // A release file does not grow the repo: its history warning would only mislead.
  const viaRelease = warnings.some((w) => w.code === 'VIA_RELEASE')
  return {
    problems,
    // A code that blocks is not repeated as a warning.
    warnings: warnings.filter((w) => !blocking.has(w.code) && !(viaRelease && w.code === 'LARGE')),
  }
}

/**
 * Everything the sheet shows under a file it has read: what inspect/ found, what the size says,
 * and, when it is a new version under a link (`replacing`), what that says. A file that is not a
 * build at all gets its own finding alone: advice on shrinking a build, or on the platform the
 * link holds, would be about a build it is not — its platform is only what its name says, or,
 * for a name that says none, inspect/'s guess of Android.
 */
export function fileFindings(
  inspection: BuildInspection,
  size: number,
  replacing: BuildEntry | null,
): Findings {
  const own: Findings = { problems: inspection.problems, warnings: inspection.warnings }
  if (own.problems.some((p) => p.code === 'NOT_A_BUILD')) return mergeFindings(own)
  return mergeFindings(
    own,
    sizeFindings(size),
    replacing === null ? { problems: [], warnings: [] } : replaceFindings(replacing, inspection),
  )
}

/**
 * The App name a file fills in, while the owner has not typed one in the sheet. A new link takes
 * the app's own name. A new version keeps the name the link has — the owner may have renamed it,
 * and testers know the build by it — unless it is another app, whose install page the old name
 * would only misstate.
 */
export function suggestedName(inspection: BuildInspection, replacing: BuildEntry | null): string {
  if (replacing === null || otherApp(replacing, inspection)) return inspection.name
  return replacing.name
}

/* ---------------------------------------------------------------- *
 * The form
 * ---------------------------------------------------------------- */

/** What the sheet edits: the link (for a new build only), the name and the notes. */
export interface BuildDraft {
  readonly id: string
  readonly name: string
  readonly notes: string
}

/** A name on one line: the install page's title and the commit message hold nothing else. */
export const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim()
/** Notes as typed, with Windows line ends made plain and blank lines at either end dropped. */
export const cleanNotes = (notes: string) => notes.replace(/\r\n?/g, '\n').trim()

/** What is missing or wrong in a draft, worded in `locale`; empty when it may be published. */
export function validateBuildDraft(draft: BuildDraft, locale: Locale = currentLocale()): string[] {
  const t = BUILD_MESSAGES[locale].problems
  const problems: string[] = []
  const id = draft.id.trim()
  if (!id) problems.push(t.idRequired)
  else if (!isId(id)) problems.push(t.idPattern)
  const name = cleanName(draft.name)
  if (!name) problems.push(t.nameRequired)
  else if (name.length > NAME_MAX) problems.push(t.nameTooLong(NAME_MAX))
  if (cleanNotes(draft.notes).length > NOTES_MAX) problems.push(t.notesTooLong(NOTES_MAX))
  return problems
}

/**
 * Whether a new build may not take `id`: an entry has it, or build/<id>/ already holds files
 * (`listing`, read at the same commit) that no entry claims — left by hand, or by a delete that
 * never finished. Publishing there would mix the new build's files with someone else's.
 */
export function idTaken(id: string, db: BuildDb, listing: readonly RepoEntry[] | null): boolean {
  return db.entries.some((e) => e.id === id) || (listing !== null && listing.length > 0)
}

/**
 * Why a new version or an edit must not be published over what is on GitHub now, or null when
 * it may be. `loaded` is the build as the sheet opened it; `db` is read at the commit the change
 * will be built on. Without this, a sheet opened before another tab or device deleted the build
 * would bring it back, and one opened before another upload would quietly undo it.
 */
export function buildConflict(
  loaded: BuildEntry,
  db: BuildDb,
  locale: Locale = currentLocale(),
): string | null {
  const t = BUILD_MESSAGES[locale].problems
  const current = db.entries.find((e) => e.id === loaded.id)
  if (current === undefined) return t.deleted(loaded.name)
  // Both sides are spelled the same way (parseBuildDb, or a plan's), so text equality is
  // equality of every field.
  if (JSON.stringify(spelled(current)) !== JSON.stringify(spelled(loaded))) {
    return t.changed(loaded.name)
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Publishing — exactly which files change, in one commit
 * ---------------------------------------------------------------- */

/**
 * An entry with its keys in the file's order (types.ts), nested ones included. Spelled out
 * rather than spread: the order is the file's, so a diff of db.json shows what changed and not
 * how an object happened to be built.
 */
function spelled(entry: BuildEntry): BuildEntry {
  const { android, ios } = entry
  return {
    id: entry.id,
    platform: entry.platform,
    name: entry.name,
    bundle_id: entry.bundle_id,
    version: entry.version,
    build: entry.build,
    file: entry.file,
    size: entry.size,
    sha256: entry.sha256,
    icon: entry.icon,
    min_os: entry.min_os,
    notes: entry.notes,
    android: android && {
      target_sdk: android.target_sdk,
      debuggable: android.debuggable,
      abis: [...android.abis],
    },
    ios: ios && {
      devices: [...ios.devices],
      profile: ios.profile && {
        kind: ios.profile.kind,
        name: ios.profile.name,
        team: ios.profile.team,
        expires: ios.profile.expires,
        device_count: ios.profile.device_count,
      },
    },
    release: entry.release && {
      id: entry.release.id,
      tag: entry.release.tag,
      asset_id: entry.release.asset_id,
    },
    uploaded_at: entry.uploaded_at,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
}

export interface EntryInput {
  readonly inspection: BuildInspection
  readonly id: string
  readonly name: string
  readonly notes: string
  /** The binary's name under build/<id>/, as binaryFileName writes it. */
  readonly file: string
  readonly size: number
  readonly sha256: string
  /** Whether icon.png goes up with this build. */
  readonly icon: boolean
  /**
   * The release the binary went up to, for one of 100 MiB or more; null or left out when the
   * binary goes into the repo.
   */
  readonly release?: ReleaseInfo | null
  /** ISO time of the publish. */
  readonly now: string
  /** The build this one replaces under the same link, or null for a new link. */
  readonly existing: BuildEntry | null
}

/**
 * A build's entry from what reading the file found and what the sheet says. A new version keeps
 * the link's `created_at`: it is when testers were first given the link.
 */
export function entryFromInspection(input: EntryInput): BuildEntry {
  const { inspection } = input
  return spelled({
    id: input.id.trim(),
    platform: inspection.platform,
    name: cleanName(input.name),
    bundle_id: inspection.bundleId,
    version: inspection.version,
    build: inspection.build,
    file: input.file,
    size: input.size,
    sha256: input.sha256,
    icon: input.icon ? ICON_FILE : '',
    min_os: inspection.minOs,
    notes: cleanNotes(input.notes),
    android: inspection.platform === 'android' ? inspection.android : null,
    ios: inspection.platform === 'ios' ? inspection.ios : null,
    release: input.release ?? null,
    uploaded_at: input.now,
    created_at: input.existing?.created_at || input.now,
    updated_at: input.now,
  })
}

/**
 * The GitHub Release a binary of 100 MiB or more goes up to, for build `id`: tagged with the
 * link and the time (paths.ts's releaseTag), titled `My App 1.2.0 (45)`, and described by its
 * install page's link, so GitHub's list of releases says what each one is for.
 */
export function releaseFor(
  build: {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly build: string
  },
  now: Date,
): ReleaseInput {
  return {
    tag: releaseTag(build.id, now),
    name: [cleanName(build.name), versionLabel(build)].filter(Boolean).join(' ') || build.id,
    body: `Install page: ${buildUrl(build.id)}`,
  }
}

export interface BuildPlan {
  readonly writes: RepoWrite[]
  readonly deletes: string[]
  readonly message: string
  /** The index after the commit, so the list re-renders without a re-read. */
  readonly db: BuildDb
}

/** How a commit names a build: `my-link (My App 1.2.0 (45))`. */
const commitName = (entry: BuildEntry) =>
  `${entry.id} (${[entry.name, versionLabel(entry)].filter(Boolean).join(' ')})`

/** The index as JSON, the way every data file here is written: two spaces and a final newline. */
const dbFile = (db: BuildDb) => `${JSON.stringify(db, null, 2)}\n`

/** The index with `entry` in it: in its old place when it was there, else first. */
function withEntry(db: BuildDb, entry: BuildEntry, now: string): BuildDb {
  const at = db.entries.findIndex((e) => e.id === entry.id)
  const entries =
    at >= 0 ? db.entries.map((e, i) => (i === at ? entry : e)) : [entry, ...db.entries]
  return { version: db.version, updated_at: now, entries }
}

/**
 * Every path a plan touches is built from the entry's id and file name, so both are checked
 * again here, whatever the caller checked: one that could leave build/<id>/ (`..`, a slash, a
 * name Jekyll would hide) would have a commit write over the site itself. A bug, not a problem
 * to word, so it throws.
 */
function assertOwnPaths(entry: Pick<BuildEntry, 'id' | 'platform' | 'file'>) {
  const extension = entry.platform === 'android' ? '.apk' : '.ipa'
  if (!isId(entry.id) || !FILE_NAME_PATTERN.test(entry.file) || !entry.file.endsWith(extension)) {
    throw new Error(`Refusing to plan files for build "${entry.id}" (${entry.file})`)
  }
}

/** The files generated from an entry: the install page, and the manifest iOS installs from. */
function generated(entry: BuildEntry): RepoWrite[] {
  return [
    {
      path: buildPagePath(entry.id),
      // The page carries a QR code of its own live link: a laptop shows it, a phone scans it.
      content: installPageHtml(entry, { qrSvg: qrSvg(buildUrl(entry.id)) }),
    },
    ...(entry.platform === 'ios'
      ? [{ path: buildFilePath(entry.id, MANIFEST_FILE), content: manifestPlist(entry) }]
      : []),
  ]
}

/**
 * Publishing a build writes its binary and icon (already uploaded, placed by sha), its install
 * page, the iOS manifest and the index, in one commit. A binary of 100 MiB or more is not
 * written at all: it is already a release's asset (`entry.release`), and `shas.binary` is null.
 *
 * A new version under the same link (`existing`) also removes the replaced build's files that
 * the new one no longer uses: a binary named for the old version, or any binary in the repo
 * when the new one is a release's, an icon the new build lacks, a manifest. `found`, when
 * given, is what build/<id>/ holds at the commit this builds on, and only what is there is
 * removed — GitHub refuses a tree that deletes a path it does not have. A release the replaced
 * build had is no file of the repo: the caller deletes it once this commit is in.
 */
export function planBuildPublish(
  {
    entry,
    shas,
    found,
  }: {
    entry: BuildEntry
    shas: { readonly binary: string | null; readonly icon: string | null }
    found?: readonly string[]
  },
  db: BuildDb,
  existing: BuildEntry | null,
  now: string,
): BuildPlan {
  assertOwnPaths(entry)
  if (Boolean(entry.icon) !== (shas.icon !== null)) {
    throw new Error('planBuildPublish: the entry and the uploaded icon disagree')
  }
  if ((entry.release === null) !== (shas.binary !== null)) {
    throw new Error('planBuildPublish: the binary must be in the repo or in a release, not both')
  }
  const next = withEntry(db, entry, now)
  const writes: RepoWrite[] = [
    ...(shas.binary !== null
      ? [{ path: buildFilePath(entry.id, entry.file), sha: shas.binary }]
      : []),
    ...(shas.icon !== null ? [{ path: buildFilePath(entry.id, ICON_FILE), sha: shas.icon }] : []),
    ...generated(entry),
    { path: BUILD_DB_PATH, content: dbFile(next) },
  ]
  const written = new Set(writes.map((w) => w.path))
  const present = found === undefined ? null : new Set(found)
  const deletes = existing
    ? buildFiles(existing).filter((p) => !written.has(p) && (present === null || present.has(p)))
    : []
  return {
    writes,
    deletes,
    message: `${existing ? 'Update' : 'Add'} build: ${commitName(entry)}`,
    db: next,
  }
}

/**
 * Saving a new name or notes regenerates what shows them — the install page, and the iOS
 * manifest, whose title is the name — and the index. The binary keeps its file name: it is
 * what testers may already have downloaded.
 */
export function planBuildEdit(entry: BuildEntry, db: BuildDb, now: string): BuildPlan {
  assertOwnPaths(entry)
  if (!db.entries.some((e) => e.id === entry.id)) {
    throw new Error(`planBuildEdit: ${entry.id} is not in the index`)
  }
  const edited = spelled({
    ...entry,
    name: cleanName(entry.name),
    notes: cleanNotes(entry.notes),
    updated_at: now,
  })
  const next = withEntry(db, edited, now)
  return {
    writes: [...generated(edited), { path: BUILD_DB_PATH, content: dbFile(next) }],
    deletes: [],
    message: `Edit build: ${edited.id}`,
    db: next,
  }
}

/**
 * Deleting a build removes its index entry and every file under build/<id>/, in one commit.
 *
 * `found` is what a listing of build/<id>/ returned at the commit the delete builds on: all of
 * it goes, the files the entry names and anything else left there, because a directory left
 * with a stray file and no index.html is one `npm run publish` refuses. Nothing else goes:
 * GitHub refuses a tree that deletes a path it does not have, so a build whose files were
 * already removed by hand can still leave the list. Only direct children of build/<id>/ are
 * taken, whatever the listing says.
 */
export function planBuildDelete(
  entry: BuildEntry,
  found: readonly string[],
  db: BuildDb,
  now: string,
): BuildPlan {
  assertOwnPaths(entry)
  const dir = `${BUILD_DIR}/${entry.id}/`
  const own = (path: string) => path.startsWith(dir) && /^[^/]+$/.test(path.slice(dir.length))
  // The entry's own files first, in buildFiles' order, then whatever else was there.
  const named = buildFiles(entry)
  const rank = (path: string) => {
    const at = named.indexOf(path)
    return at < 0 ? named.length : at
  }
  const deletes = [...new Set(found.filter(own))].sort((a, b) => rank(a) - rank(b))
  const next: BuildDb = {
    version: db.version,
    updated_at: now,
    entries: db.entries.filter((e) => e.id !== entry.id),
  }
  return {
    writes: [{ path: BUILD_DB_PATH, content: dbFile(next) }],
    deletes,
    message: `Delete build: ${entry.id}`,
    db: next,
  }
}
