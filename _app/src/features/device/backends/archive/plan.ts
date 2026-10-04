import { fmtBytes } from '../../model'
import { imageMime, readApkBadge, splitNameOf, type BadgeIcon, type BadgeSplit } from './apk-badge'
import {
  isBinaryXml,
  manifestFromXml,
  manifestInfo,
  parseProtoXml,
  type ManifestInfo,
} from './axml'
import {
  densityName,
  selectByName,
  selectFromToc,
  splitRole,
  type DeviceSpec,
  type Incompatible,
  type NamedSplit,
  type SelectedApk,
  type SelectionNote,
  type SplitRole,
} from './select'
import { parseToc, type Toc } from './toc'
import {
  blobSource,
  canInflate,
  openZip,
  scanZipStream,
  ZipError,
  type ByteSource,
  type ZipArchive,
  type ZipEntry,
} from './zip'

/*
  What to install, from whatever was dropped: one .apk, several, a bundletool .apks, an .xapk
  (APKPure), an .apkm (APKMirror), a zip of APKs, or an .aab. Every file is recognised by its
  contents, never its extension, and the result is one plan: the APKs to stream into a single
  install session, in order, with their exact sizes; what the app is; and what stands in the
  way, as blocking problems, warnings and notes, each with its sentence.

  Nothing is sent and nothing is read whole: a part is streamed when the session asks for it,
  straight from the dropped file (a zero-copy slice for an APK stored inside an .apks, an
  inflating stream for one compressed inside an .xapk). Reading the plan itself costs the
  central directories, the manifests and, for the dialog's icon and name, one resource table.

  Checks that need more than the device spec (free space, the installed version) are in
  checkPhone, which runs once the package name is known.

  Ported from the bundle-install prototype (proto/plan.mjs).
*/

export type InputKind =
  | 'apk'
  | 'split'
  | 'apks'
  | 'xapk'
  | 'apkm'
  /** A zip of APKs with no table of contents (SAI's .apks, a compressed folder). */
  | 'zip'
  | 'aab'
  /** An old APKMirror file, encrypted: not a zip at all. */
  | 'apkm-encrypted'
  /** A zip that could not be read, or an APK whose manifest could not. */
  | 'damaged'
  /** Not an app file. */
  | 'other'

export interface PlanInput {
  readonly name: string
  readonly size: number
  /** What the file is, by its contents. */
  readonly kind: InputKind
  /** Whether the plan uses it; a stray file dropped along with a folder is left out. */
  readonly used: boolean
}

/** Why a part was chosen, for "Why these?". */
export interface PartRole {
  /** 'base', a feature module, or an asset pack. */
  readonly module: string
  readonly kind: SplitRole['kind'] | 'asset-pack'
  /** The ABI, density in dpi, language or other config value; '' for base, feature and pack. */
  readonly value: string
}

export interface InstallPart {
  /** The name inside the install session: 0.apk, 1.apk… (safe on Android 7–9's `cmd` route). */
  readonly name: string
  /** Where it comes from: the dropped file's name, or its path inside the archive. */
  readonly source: string
  /** Its split name; '' for the base APK. */
  readonly split: string
  readonly role: PartRole
  /** Exact bytes, which `pm install-write -S` is promised. */
  readonly size: number
  /** A fresh stream of exactly `size` bytes on every call, inflated when stored compressed. */
  readonly open: () => Promise<ReadableStream<Uint8Array>>
}

export interface AppFacts {
  readonly packageName: string
  readonly versionCode: number
  readonly versionName: string
  readonly minSdk: number
  readonly targetSdk: number
  /** A test-only build: the install needs `-t`. */
  readonly testOnly: boolean
  readonly debuggable: boolean
  /** Every ABI the app has native code for, in any part; empty when it has none. */
  readonly nativeAbis: readonly string[]
  /** The name the launcher shows, in the phone's language when the app has it. */
  readonly label: string | null
  readonly icon: BadgeIcon | null
}

export type PlanIssueCode =
  // Blocking
  | 'NOTHING_TO_INSTALL'
  | 'APKM_ENCRYPTED'
  | 'DAMAGED'
  | 'ENCRYPTED_ZIP'
  | 'UNSUPPORTED_ZIP'
  | 'READ_FAILED'
  | 'NOT_APK'
  | 'AAB_NEEDS_HELPER'
  | 'MIXED_INPUTS'
  | 'DIFFERENT_APPS'
  | 'DIFFERENT_VERSIONS'
  | 'LONE_SPLIT'
  | 'NO_BASE'
  | 'TWO_BASES'
  | 'DUPLICATE_SPLIT'
  | 'OLDER_SDK'
  | 'NO_MATCHING_ABIS'
  | 'NO_MATCHING_TEXTURES'
  | 'MISSING_SPLIT'
  | 'UNZIP_UNSUPPORTED'
  | 'APKS_MODE_UNSUPPORTED'
  | 'INSUFFICIENT_SPACE'
  | 'VERSION_DOWNGRADE'
  // Warnings
  | 'DEPRECATED_SDK_VERSION'
  | 'LOW_SPACE'
  | 'XAPK_OBB'
  | 'TEXTURES_UNCHECKED'
  | 'CONDITION_UNCHECKED'
  | 'LOCAL_TESTING'
  | 'SPLITS_SKIPPED'
  | 'FILES_SKIPPED'
  | 'UNVERIFIED_PARTS'
  // Notes
  | 'TEST_ONLY'
  | 'ABI_PICKED'
  | 'DEVICE_TIER'
  | 'TARGETING_ASSUMED'
  | 'UPDATE'
  | 'REINSTALL'

export interface PlanIssue {
  readonly code: PlanIssueCode
  /** Plain, actionable English for the dialog. */
  readonly message: string
  /** The dropped file it concerns, when it concerns one. */
  readonly file?: string
  /** A way past it the dialog can offer. */
  readonly action?: 'install-anyway' | 'allow-downgrade' | 'uninstall-first'
}

export type PlanKind = 'apk' | 'apk-set' | 'apks' | 'xapk' | 'apkm' | 'zip' | 'aab' | 'none'

export interface InstallPlan {
  /** What was dropped, as a whole. */
  readonly kind: PlanKind
  /** Each dropped file, in the order given. */
  readonly inputs: readonly PlanInput[]
  readonly app: AppFacts | null
  /** The APKs to stream into one session, base first. Empty when there is a problem. */
  readonly parts: readonly InstallPart[]
  readonly totalBytes: number
  /** For a set: how many APKs were on offer, and the CPU, screen and languages they were picked for. */
  readonly selection: {
    readonly offered: number
    readonly abi: string
    readonly density: string
    readonly languages: readonly string[]
  } | null
  /** OBB data an .xapk carries, which Device Lab does not copy yet. */
  readonly expansions: readonly { readonly path: string; readonly size: number }[]
  /** Blocking: nothing may be sent while any is present. */
  readonly problems: readonly PlanIssue[]
  readonly warnings: readonly PlanIssue[]
  /** Worth knowing, nothing to act on. */
  readonly notes: readonly PlanIssue[]
}

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

const ANDROID_RELEASE: Readonly<Record<number, string>> = {
  21: '5.0',
  22: '5.1',
  23: '6.0',
  24: '7.0',
  25: '7.1',
  26: '8.0',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12L',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
  37: '17',
}

/** 26 → 'Android 8.0 (API 26)'; a level this table does not know reads as 'API 40'. */
export function androidName(api: number): string {
  const release = ANDROID_RELEASE[api]
  return release ? `Android ${release} (API ${String(api)})` : `API ${String(api)}`
}

const listOf = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
const version = (name: string, code: number) => (name ? `${name} (${String(code)})` : String(code))
/** A 32-bit ABI in a phone's list means it can still run 32-bit apps. */
const runs32Bit = (abis: readonly string[]) =>
  abis.some((a) => a === 'armeabi-v7a' || a === 'armeabi' || a === 'x86' || a === 'mips')

const issue = (
  code: PlanIssueCode,
  message: string,
  extra: Partial<Pick<PlanIssue, 'file' | 'action'>> = {},
): PlanIssue => ({ code, message, ...extra })

const APP_FILES = 'Device Lab installs .apk, .apks, .xapk, .apkm and .aab files.'

/** The sentence for a refused selection. */
function incompatibleIssue(why: Incompatible, spec: DeviceSpec): PlanIssue {
  switch (why.code) {
    case 'SDK':
      return issue(
        'OLDER_SDK',
        `This app needs ${androidName(why.minSdk)} or newer. This phone runs ${androidName(spec.sdkVersion)}.`,
      )
    case 'ABI':
      return abiIssue(why.appAbis, spec.supportedAbis)
    case 'TEXTURE':
      return issue(
        'NO_MATCHING_TEXTURES',
        `This app has no graphics this phone’s GPU can use (it ships ${listOf(why.appFormats.map((f) => f.toUpperCase()))}).`,
      )
    case 'MISSING':
      return missingSplit()
    case 'NO_MATCH':
      return issue(
        'MISSING_SPLIT',
        'This .apks was built for a different phone (its Android version, CPU or screen). Use the full .apks or the .aab.',
      )
  }
}

function abiIssue(appAbis: readonly string[], phoneAbis: readonly string[]): PlanIssue {
  const tail = runs32Bit(phoneAbis)
    ? `This phone runs ${listOf(phoneAbis)}.`
    : 'This phone runs 64-bit apps only.'
  return issue('NO_MATCHING_ABIS', `The app has native code only for ${listOf(appAbis)}. ${tail}`)
}

const missingSplit = () =>
  issue(
    'MISSING_SPLIT',
    'Parts of the app for this phone’s CPU, screen or language are missing. Use the full .apks or .aab.',
  )

function noteIssue(note: SelectionNote): PlanIssue {
  switch (note.code) {
    case 'TEXTURES_UNCHECKED':
      return issue(
        'TEXTURES_UNCHECKED',
        'This app picks graphics by GPU texture format, and this phone’s formats could not be read, so its graphics may be missing. If it looks wrong, install a universal .apks instead.',
      )
    case 'DEVICE_TIER':
      return issue(
        'DEVICE_TIER',
        `This app has parts per device tier; the app’s default tier (${String(note.tier)}) was used.`,
      )
    case 'COUNTRY_SET':
      return issue(
        'TARGETING_ASSUMED',
        'This app has parts per country; the parts for no particular country were used.',
      )
    case 'DEVICE_GROUP':
      return issue(
        'TARGETING_ASSUMED',
        'This app has parts per device group; this phone was taken to be in no group.',
      )
    case 'CONDITIONAL_MODULE':
      return issue(
        'CONDITION_UNCHECKED',
        `Not every condition of the module “${note.module}” could be checked on this phone; it was ${note.included ? 'included' : 'left out'}, as bundletool would.`,
      )
    case 'LOCAL_TESTING':
      return issue(
        'LOCAL_TESTING',
        'This set was built with --local-testing: its on-demand parts are meant to be copied separately and will not be available.',
      )
  }
}

/** The command a tester can run themselves to turn an .aab into something Device Lab installs. */
export function bundletoolCommand(aabName: string): string {
  const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  const apks = aabName.replace(/\.aab$/i, '') + '.apks'
  return `bundletool build-apks --bundle=${quote(aabName)} --output=${quote(apks)} --mode=universal`
}

/* ---------------------------------------------------------------- *
 * Reading what was dropped
 * ---------------------------------------------------------------- */

const MANIFEST_LIMIT = 4 * 1024 * 1024
const META_LIMIT = 1024 * 1024
const TOC_LIMIT = 16 * 1024 * 1024
/** How far into a compressed APK to look for its manifest, which is normally its first entry. */
const MANIFEST_SCAN_LIMIT = 8 * 1024 * 1024

/** One APK the plan could install. */
interface Candidate {
  /** For "Why these?": the file's name, or its path inside the archive. */
  readonly source: string
  /** From the manifest when it could be read, else from the name. */
  readonly split: string
  readonly manifest: ManifestInfo | null
  /** `lib/<abi>/` in this APK, when its directory could be read. */
  readonly abis: readonly string[]
  readonly size: number
  readonly open: () => Promise<ReadableStream<Uint8Array>>
  /** Random access to it (a dropped file, an entry stored uncompressed), for the badge. */
  readonly bytes: ByteSource | null
  /** The dropped file it is, when it is one rather than an entry of one. */
  readonly file?: File
}

type Inspected =
  | { readonly file: File; readonly kind: 'apk' | 'split'; readonly apk: Candidate }
  | {
      readonly file: File
      readonly kind: 'apks' | 'xapk' | 'apkm' | 'zip' | 'aab'
      readonly zip: ZipArchive
    }
  | { readonly file: File; readonly kind: 'apkm-encrypted' | 'other' }
  | { readonly file: File; readonly kind: 'damaged'; readonly problem: PlanIssue }

/** Why a file could not be read, as the sentence the dialog shows. */
function readProblem(file: string, error: unknown): PlanIssue {
  const code = error instanceof ZipError ? error.code : ''
  const message = error instanceof Error ? error.message : ''
  if (code === 'ZIP_ENCRYPTED') {
    return issue(
      'ENCRYPTED_ZIP',
      `${file} is password-protected. Unpack it with its password, then drop the APKs.`,
      { file },
    )
  }
  if (code === 'ZIP_METHOD' || code === 'ZIP_MULTIDISK') {
    return issue(
      'UNSUPPORTED_ZIP',
      `${file} is packed in a way a browser cannot unpack. Re-create it as a normal zip.`,
      { file },
    )
  }
  if (code === 'ZIP_NO_INFLATE') return unzipUnsupported()
  if (code) {
    return issue('DAMAGED', `${file} is damaged or incomplete. Download or copy it again.`, {
      file,
    })
  }
  if (/^AXML_|^PROTOBUF_/.test(message)) {
    return issue(
      'NOT_APK',
      `${file} isn’t a valid APK. It may be an .aab, or a download that was cut short.`,
      { file },
    )
  }
  return issue(
    'READ_FAILED',
    `Couldn’t read ${file}. It may have changed or moved since it was picked: pick it again.`,
    { file },
  )
}

const unzipUnsupported = () =>
  issue(
    'UNZIP_UNSUPPORTED',
    'This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer).',
  )

/** `lib/<abi>/` directories of an APK. */
const abisOf = (zip: ZipArchive) => [
  ...new Set(
    zip.entries
      .map((e) => /^lib\/([^/]+)\/[^/]+$/.exec(e.name)?.[1])
      .filter((a) => a !== undefined),
  ),
]

/** The APKs inside an archive, without the AppleDouble shadows macOS adds to zips it makes. */
const apkEntries = (zip: ZipArchive) =>
  zip.entries.filter((e) => {
    const base = e.name.split('/').pop() ?? ''
    return /\.apk$/i.test(base) && !base.startsWith('._') && !e.name.startsWith('__MACOSX/')
  })

async function inspect(file: File): Promise<Inspected> {
  let zip: ZipArchive
  try {
    const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer())
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      if (/\.apkm$/i.test(file.name)) return { file, kind: 'apkm-encrypted' }
      // Named like an app but not a zip: often an error page saved under the app's name.
      if (/\.(apk|apks|xapk|aab)$/i.test(file.name)) {
        const problem = issue(
          'NOT_APK',
          `${file.name} isn’t an app file inside: it may be a download that went wrong. Download it again.`,
          { file: file.name },
        )
        return { file, kind: 'damaged', problem }
      }
      return { file, kind: 'other' }
    }
    zip = await openZip(file)
  } catch (error) {
    return { file, kind: 'damaged', problem: readProblem(file.name, error) }
  }
  if (zip.get('BundleConfig.pb') && zip.get('base/manifest/AndroidManifest.xml')) {
    return { file, kind: 'aab', zip }
  }
  const manifestEntry = zip.get('AndroidManifest.xml')
  if (manifestEntry) {
    try {
      const bytes = await zip.bytes(manifestEntry, MANIFEST_LIMIT)
      if (!isBinaryXml(bytes)) throw new Error('AXML_NOT_BINARY')
      const manifest = manifestInfo(bytes)
      const apk: Candidate = {
        source: file.name,
        split: manifest.split,
        manifest,
        abis: abisOf(zip),
        size: file.size,
        open: () => Promise.resolve(file.stream()),
        bytes: blobSource(file),
        file,
      }
      return { file, kind: manifest.split ? 'split' : 'apk', apk }
    } catch (error) {
      return { file, kind: 'damaged', problem: readProblem(file.name, error) }
    }
  }
  if (zip.get('toc.pb')) return { file, kind: 'apks', zip }
  if (apkEntries(zip).length === 0) return { file, kind: 'other' }
  if (zip.get('manifest.json')) return { file, kind: 'xapk', zip }
  if (zip.get('info.json')) return { file, kind: 'apkm', zip }
  return { file, kind: 'zip', zip }
}

/** An APK inside an archive, with its manifest when it can be read without inflating it all. */
async function entryCandidate(
  zip: ZipArchive,
  entry: ZipEntry,
  splitHint: string | null,
): Promise<Candidate> {
  const base = { source: entry.name, size: entry.uncompressedSize, open: () => zip.stream(entry) }
  const fallback = splitHint ?? splitNameOf(entry.name)
  // Stored: the APK is a zero-copy slice that opens as a zip of its own.
  const blob = await zip.blob(entry)
  if (blob) {
    const inner = await openZip(blob)
    const m = inner.get('AndroidManifest.xml')
    const manifest = m ? manifestInfo(await inner.bytes(m, MANIFEST_LIMIT)) : null
    return {
      ...base,
      split: manifest?.split ?? fallback,
      manifest,
      abis: abisOf(inner),
      bytes: blobSource(blob),
    }
  }
  // Compressed: its manifest is its first entry, a few kilobytes into the inflated stream.
  const found = await scanZipStream(
    await zip.stream(entry),
    ['AndroidManifest.xml'],
    MANIFEST_SCAN_LIMIT,
  )
  const bytes = found.get('AndroidManifest.xml')
  const manifest = bytes && isBinaryXml(bytes) ? manifestInfo(bytes) : null
  return { ...base, split: manifest?.split ?? fallback, manifest, abis: [], bytes: null }
}

/* ---------------------------------------------------------------- *
 * Assembling a set
 * ---------------------------------------------------------------- */

interface Draft {
  kind: PlanKind
  app: AppFacts | null
  parts: InstallPart[]
  /** The dropped files the parts come from. */
  used: Set<File>
  selection: InstallPlan['selection']
  expansions: InstallPlan['expansions']
  problems: PlanIssue[]
  warnings: PlanIssue[]
  notes: PlanIssue[]
}

const emptyDraft = (kind: PlanKind): Draft => ({
  kind,
  app: null,
  parts: [],
  used: new Set(),
  selection: null,
  expansions: [],
  problems: [],
  warnings: [],
  notes: [],
})

/** Container metadata (.xapk's manifest.json, .apkm's info.json) the facts fall back to. */
interface Metadata {
  packageName: string
  versionCode: number
  versionName: string
  minSdk: number
  targetSdk: number
  label: string | null
  iconPath: string | null
}

function factsFrom(
  base: Candidate | null,
  others: readonly Candidate[],
  meta: Metadata | null,
): AppFacts | null {
  const m = base?.manifest
  if (!m && !meta) return null
  const abis = new Set(base?.abis ?? [])
  for (const c of others) {
    for (const abi of c.abis) abis.add(abi)
    const role = splitRole(c.split)
    if (role.kind === 'abi') abis.add(role.value)
  }
  const minSdk = m?.minSdk ?? meta?.minSdk ?? 1
  return {
    packageName: m?.packageName ?? meta?.packageName ?? '',
    versionCode: m?.versionCode ?? meta?.versionCode ?? 0,
    versionName: m?.versionName ?? meta?.versionName ?? '',
    minSdk,
    targetSdk: m?.targetSdk ?? meta?.targetSdk ?? minSdk,
    testOnly: m?.testOnly ?? false,
    debuggable: m?.debuggable ?? false,
    nativeAbis: [...abis],
    label: m?.label ?? meta?.label ?? null,
    icon: null,
  }
}

/** Parts in install order: the base, then everything else as chosen. */
function toParts(chosen: readonly { candidate: Candidate; role: PartRole }[]): InstallPart[] {
  const ordered = [
    ...chosen.filter((c) => c.role.kind === 'base'),
    ...chosen.filter((c) => c.role.kind !== 'base'),
  ]
  return ordered.map(({ candidate, role }, i) => ({
    name: `${String(i)}.apk`,
    source: candidate.source,
    split: candidate.split,
    role,
    size: candidate.size,
    open: candidate.open,
  }))
}

function selectionOf(parts: readonly InstallPart[], offered: number): InstallPlan['selection'] {
  const of = (kind: PartRole['kind']) =>
    parts.filter((p) => p.role.kind === kind && p.role.module === 'base').map((p) => p.role.value)
  const density = of('density')[0]
  return {
    offered,
    abi: of('abi')[0] ?? '',
    density: density ? densityName(Number(density)) : '',
    languages: of('language'),
  }
}

/**
 * Whether several complete APKs are one app built once per ABI (Flutter's --split-per-abi): each
 * has native code, and no ABI is in two of them. Universal builds overlap (every one carries
 * arm64-v8a and the rest), so a debug and a release APK dropped together are not mistaken for it.
 */
function perAbiBuilds(bases: readonly { readonly abis: readonly string[] }[]): boolean {
  const seen = new Set<string>()
  for (const b of bases) {
    if (b.abis.length === 0) return false
    for (const abi of b.abis) {
      if (seen.has(abi)) return false
      seen.add(abi)
    }
  }
  return true
}

/** The parts picked for the phone, and which of them is the base. */
interface Picked {
  base: Candidate
  chosen: { candidate: Candidate; role: PartRole }[]
}

/**
 * Loose APKs, or the APKs of a zip, .xapk or .apkm, as one app: they must agree on the package
 * and version, have one base and no part twice; then the parts for this phone are picked by
 * split name, as Play would. Null when they cannot be installed together (the reason is in
 * draft.problems).
 */
function assembleSet(
  candidates: readonly Candidate[],
  spec: DeviceSpec,
  draft: Draft,
  meta: Metadata | null = null,
): Picked | null {
  const known = candidates.filter((c) => c.manifest)
  const packages = [...new Set(known.map((c) => c.manifest?.packageName ?? ''))]
  if (packages.length > 1) {
    draft.problems.push(
      issue(
        'DIFFERENT_APPS',
        `These APKs are from different apps (${listOf(packages)}). Install one app at a time.`,
      ),
    )
    return null
  }

  let pool = [...candidates]
  let bases = pool.filter((c) => c.split === '')
  if (bases.length === 0) {
    draft.problems.push(
      candidates.length === 1
        ? issue(
            'LONE_SPLIT',
            'This is one part of a split app. Pick it together with its base APK.',
            { file: candidates[0]?.source },
          )
        : issue(
            'NO_BASE',
            'These are parts of a split app without its base APK. Add the base APK (usually base.apk).',
          ),
    )
    return null
  }
  if (bases.length > 1 && perAbiBuilds(bases)) {
    // Builds per ABI (Flutter's --split-per-abi) are whole APKs, not splits: take the one for
    // this phone's CPU, and never two in one session. They can differ in versionCode (Flutter
    // adds an offset per ABI), so the others are left out before versions are compared.
    const pick = spec.supportedAbis
      .map((abi) => bases.find((b) => b.abis.includes(abi)))
      .find(Boolean)
    if (!pick) {
      draft.problems.push(abiIssue([...new Set(bases.flatMap((b) => b.abis))], spec.supportedAbis))
      return null
    }
    const left = bases.filter((b) => b !== pick)
    draft.notes.push(
      issue(
        'ABI_PICKED',
        `Picked ${pick.source} for this phone’s CPU; left out ${listOf(left.map((b) => b.source))}.`,
      ),
    )
    pool = pool.filter((c) => !left.includes(c))
    bases = [pick]
  }

  const versions = [...new Set(pool.flatMap((c) => (c.manifest ? [c.manifest.versionCode] : [])))]
  if (versions.length > 1) {
    draft.problems.push(
      issue(
        'DIFFERENT_VERSIONS',
        `These APKs are from different versions of ${packages[0] ?? 'the app'} (${listOf(versions.map(String))}). Use the files of one build.`,
      ),
    )
    return null
  }
  if (bases.length > 1) {
    // Two whole builds of one version (a debug and a release APK, say): which one is meant
    // cannot be told from the files, so the tester picks.
    draft.problems.push(
      issue(
        'TWO_BASES',
        `There is more than one complete APK here (${listOf(bases.map((b) => b.source))}). Pick one of them.`,
      ),
    )
    return null
  }
  const seen = new Set<string>()
  for (const c of pool) {
    if (seen.has(c.split)) {
      draft.problems.push(
        issue(
          'DUPLICATE_SPLIT',
          `Two of these APKs are the same part (${c.split || 'the base'}). Keep one of each.`,
        ),
      )
      return null
    }
    seen.add(c.split)
  }

  const picked = selectByName(
    pool.map((c): NamedSplit<Candidate> => ({ split: c.split, item: c })),
    spec,
  )
  if (!picked.ok) {
    draft.problems.push(incompatibleIssue(picked.incompatible, spec))
    return null
  }
  const others = picked.skipped.filter((s) => s.reason === 'other').map((s) => s.item.source)
  if (others.length > 0) {
    draft.warnings.push(
      issue(
        'SPLITS_SKIPPED',
        `Left out ${listOf(others)}: Device Lab can’t tell which phones ${others.length > 1 ? 'they are' : 'it is'} for. If the install then fails, use the .apks or .aab.`,
      ),
    )
  }

  const chosen = picked.picked.map(({ split, item }) => ({
    candidate: item,
    role: { ...splitRole(split) } satisfies PartRole,
  }))
  const base = bases[0]
  if (!base) return null
  checkRequiredSplits(
    chosen.map((c) => c.candidate),
    draft,
  )
  if (chosen.some((c) => !c.candidate.manifest)) {
    draft.warnings.push(
      issue(
        'UNVERIFIED_PARTS',
        'Some parts could not be checked against the base APK before sending; the phone will refuse them if they don’t belong together.',
      ),
    )
  }
  draft.parts = toParts(chosen)
  for (const { candidate } of chosen) if (candidate.file) draft.used.add(candidate.file)
  draft.selection = candidates.length > 1 ? selectionOf(draft.parts, candidates.length) : null
  // The app's native code as the whole set offers it, not just the part for this phone.
  draft.app = factsFrom(
    base,
    pool.filter((c) => c !== base),
    meta,
  )
  return { base, chosen }
}

/**
 * Split types (Android 12L+): the base says which kinds of split it cannot run without
 * (`base__abi,base__density`), each split says which it provides. Sending a set that leaves
 * one out would only fail on the phone with MISSING_SPLIT.
 */
function checkRequiredSplits(parts: readonly Candidate[], draft: Draft) {
  const manifests = parts.flatMap((p) => (p.manifest ? [p.manifest] : []))
  if (manifests.length < parts.length) return
  const provided = new Set(manifests.flatMap((m) => m.splitTypes))
  const missing = manifests.flatMap((m) => m.requiredSplitTypes).filter((t) => !provided.has(t))
  if (missing.length > 0) draft.problems.push(missingSplit())
}

/* ---------------------------------------------------------------- *
 * One plan per kind of input
 * ---------------------------------------------------------------- */

async function planApks(zip: ZipArchive, spec: DeviceSpec, draft: Draft) {
  const tocEntry = zip.get('toc.pb')
  if (!tocEntry) return
  const toc = parseToc(await zip.bytes(tocEntry, TOC_LIMIT))
  const kinds = new Set(
    toc.variants.flatMap((v) => v.modules.flatMap((m) => m.apks.map((a) => a.kind))),
  )
  const mode = (['system', 'apex', 'archived'] as const).find((k) => kinds.has(k))
  if (mode) {
    draft.problems.push(
      issue(
        'APKS_MODE_UNSUPPORTED',
        `This .apks was built for ${mode === 'system' ? 'a system image' : mode === 'apex' ? 'an APEX module' : 'archived apps'}, which can’t be installed over USB. Build it again without --mode.`,
      ),
    )
    return
  }
  const result = selectFromToc(toc, spec)
  if (!result.ok) {
    draft.problems.push(tocRefusal(result.incompatible, toc, spec))
    return
  }
  for (const note of result.notes) {
    const quiet =
      note.code === 'DEVICE_TIER' || note.code === 'COUNTRY_SET' || note.code === 'DEVICE_GROUP'
    ;(quiet ? draft.notes : draft.warnings).push(noteIssue(note))
  }

  const missing = result.apks.find((apk) => !zip.get(apk.path))
  if (missing) {
    draft.problems.push(
      issue('DAMAGED', `This .apks is missing ${missing.path}. Build or download it again.`),
    )
    return
  }
  const chosen = await Promise.all(
    result.apks.map(async (apk) => {
      const entry = zip.get(apk.path)
      if (!entry) throw new ZipError('ZIP_CORRUPT', apk.path)
      return { candidate: await entryCandidate(zip, entry, apk.splitId), role: tocRole(apk) }
    }),
  )
  checkRequiredSplits(
    chosen.map((c) => c.candidate),
    draft,
  )
  const base = chosen.find((c) => c.role.kind === 'base')?.candidate ?? null
  draft.parts = toParts([...chosen])
  draft.selection = selectionOf(draft.parts, apkEntries(zip).length)
  draft.app = factsFrom(
    base,
    chosen.map((c) => c.candidate).filter((c) => c !== base),
    null,
  )
  if (draft.app) {
    // The app's native code, as the whole set offers it (only the phone's ABI was picked).
    const offered = toc.variants.flatMap((v) =>
      v.modules.flatMap((m) => m.apks.flatMap((a) => a.targeting.abi.value)),
    )
    draft.app = { ...draft.app, nativeAbis: [...new Set([...draft.app.nativeAbis, ...offered])] }
  }
  await addBadge(draft, base && { base, chosen }, spec)
}

/**
 * A refused .apks, in terms of this file. bundletool names the ABIs of the whole bundle, and
 * for a set built for one phone it only says "no compatible APKs": both are put in terms of
 * what the set holds.
 */
function tocRefusal(why: Incompatible, toc: Toc, spec: DeviceSpec): PlanIssue {
  const apks = toc.variants.flatMap((v) => v.modules.flatMap((m) => m.apks))
  const held = [...new Set(apks.flatMap((a) => a.targeting.abi.value))]
  if (why.code === 'ABI' && held.length > 0) return abiIssue(held, spec.supportedAbis)
  if (why.code === 'NO_MATCH') {
    const lowest = Math.min(...toc.variants.map((v) => v.targeting.sdk.value[0] ?? 0))
    if (lowest > spec.sdkVersion) {
      return incompatibleIssue({ code: 'SDK', deviceSdk: spec.sdkVersion, minSdk: lowest }, spec)
    }
  }
  return incompatibleIssue(why, spec)
}

function tocRole(apk: SelectedApk): PartRole {
  const t = apk.targeting
  const module = apk.module
  if (apk.assetPack) return { module, kind: 'asset-pack', value: '' }
  if (t.abi.value[0]) return { module, kind: 'abi', value: t.abi.value[0] }
  if (t.density.value[0]) return { module, kind: 'density', value: String(t.density.value[0]) }
  if (t.language.value[0]) return { module, kind: 'language', value: t.language.value[0] }
  if (t.textureFormat.value[0]) return { module, kind: 'other', value: t.textureFormat.value[0] }
  const tier = t.deviceTier.value[0]
  if (tier !== undefined) return { module, kind: 'other', value: `tier ${String(tier)}` }
  if (apk.kind === 'standalone' || (module === 'base' && apk.isMasterSplit)) {
    return { module, kind: 'base', value: '' }
  }
  return { module, kind: apk.isMasterSplit ? 'feature' : 'other', value: '' }
}

/** The dialog's name and icon, from the base APK and the splits that hold them. */
async function addBadge(draft: Draft, picked: Picked | null, spec: DeviceSpec) {
  const bytes = picked?.base.bytes
  if (!draft.app || !picked || !bytes) return
  const { base, chosen } = picked
  const splits: BadgeSplit[] = chosen.flatMap(({ candidate }) => {
    const bytes = candidate.bytes
    return candidate !== base && bytes
      ? [{ name: candidate.split, open: () => Promise.resolve(bytes) }]
      : []
  })
  try {
    const badge = await readApkBadge(bytes, splits, {
      locales: spec.supportedLocales,
      density: spec.screenDensity,
      sdk: spec.sdkVersion,
    })
    draft.app = {
      ...draft.app,
      label: badge.label ?? draft.app.label,
      icon: badge.icon ?? draft.app.icon,
    }
  } catch {
    // The name and icon are a courtesy: the plan stands without them.
  }
}

/** A JSON object's fields, read defensively: these files come from third-party tools. */
async function readJson(zip: ZipArchive, name: string): Promise<Record<string, unknown>> {
  const entry = zip.get(name)
  if (!entry) return {}
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await zip.bytes(entry, META_LIMIT)))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const number = (v: unknown) => {
  const n = Number(text(v))
  return Number.isFinite(n) ? n : 0
}

async function planNamed(
  zip: ZipArchive,
  kind: 'xapk' | 'apkm' | 'zip',
  spec: DeviceSpec,
  draft: Draft,
) {
  let meta: Metadata | null = null
  let hints = new Map<string, string>()
  let entries = apkEntries(zip)
  if (kind === 'xapk') {
    const m = await readJson(zip, 'manifest.json')
    meta = {
      packageName: text(m.package_name),
      versionCode: number(m.version_code),
      versionName: text(m.version_name),
      minSdk: number(m.min_sdk_version) || 1,
      targetSdk: number(m.target_sdk_version),
      label: text(m.name) || null,
      iconPath: text(m.icon) || null,
    }
    // The split list names each file and its split ("base" is the base APK).
    const listed = Array.isArray(m.split_apks) ? (m.split_apks as unknown[]) : []
    for (const s of listed) {
      if (!s || typeof s !== 'object') continue
      const { file, id } = s as Record<string, unknown>
      if (text(file)) hints.set(text(file), text(id) === 'base' ? '' : text(id))
    }
    if (hints.size > 0) entries = entries.filter((e) => hints.has(e.name))
    else {
      const pkg = meta.packageName
      hints = new Map(
        entries.map((e) => [e.name, e.name === `${pkg}.apk` ? '' : splitNameOf(e.name)]),
      )
    }
    const obbs = Array.isArray(m.expansions) ? (m.expansions as unknown[]) : []
    const expansions = obbs.flatMap((x) => {
      const entry =
        x && typeof x === 'object' ? zip.get(text((x as Record<string, unknown>).file)) : undefined
      const path =
        x && typeof x === 'object' ? text((x as Record<string, unknown>).install_path) : ''
      return entry && path ? [{ path: `/sdcard/${path}`, size: entry.uncompressedSize }] : []
    })
    if (expansions.length > 0) {
      draft.expansions = expansions
      const size = expansions.reduce((n, x) => n + x.size, 0)
      draft.warnings.push(
        issue(
          'XAPK_OBB',
          `This .xapk carries ${String(expansions.length)} game data file${expansions.length > 1 ? 's' : ''} (OBB, ${fmtBytes(size)}) that Device Lab doesn’t copy yet. The app may download ${expansions.length > 1 ? 'them' : 'it'} again, or not start.`,
        ),
      )
    }
  } else if (kind === 'apkm') {
    const i = await readJson(zip, 'info.json')
    meta = {
      packageName: text(i.pname),
      versionCode: number(i.versioncode),
      versionName: text(i.release_version),
      minSdk: number(i.min_api) || 1,
      targetSdk: 0,
      label: text(i.app_name) || null,
      iconPath: zip.get('icon.png') ? 'icon.png' : null,
    }
  }

  if (!canInflate() && entries.some((e) => e.method !== 0)) {
    draft.problems.push(unzipUnsupported())
    return
  }
  const candidates = await Promise.all(
    entries.map((e) => entryCandidate(zip, e, hints.get(e.name) ?? null)),
  )
  const picked = assembleSet(candidates, spec, draft, meta)
  if (!draft.app) return
  if (meta?.iconPath) {
    const entry = zip.get(meta.iconPath)
    const bytes = entry ? await zip.bytes(entry, META_LIMIT).catch(() => null) : null
    const mime = bytes && imageMime(bytes)
    if (bytes && mime) draft.app = { ...draft.app, icon: { kind: 'bitmap', mime, bytes } }
  }
  await addBadge(draft, picked, spec)
}

async function planAab(zip: ZipArchive, file: File, draft: Draft) {
  const entry = zip.get('base/manifest/AndroidManifest.xml')
  try {
    if (entry) {
      const m = manifestFromXml(parseProtoXml(await zip.bytes(entry, MANIFEST_LIMIT)))
      draft.app = {
        packageName: m.packageName,
        versionCode: m.versionCode,
        versionName: m.versionName,
        minSdk: m.minSdk,
        targetSdk: m.targetSdk,
        testOnly: m.testOnly,
        debuggable: m.debuggable,
        nativeAbis: [
          ...new Set(
            zip.entries
              .map((e) => /^base\/lib\/([^/]+)\//.exec(e.name)?.[1])
              .filter((a) => a !== undefined),
          ),
        ],
        label: m.label,
        icon: null,
      }
    }
  } catch {
    // An unreadable bundle manifest only costs the summary line.
  }
  draft.problems.push(
    issue(
      'AAB_NEEDS_HELPER',
      `${file.name} is an app bundle: it has to be built into APKs before a phone can install it, which needs the Device Lab helper. Until then, build an .apks with bundletool and drop that here.`,
      { file: file.name },
    ),
  )
}

/* ---------------------------------------------------------------- *
 * Checks against the device spec
 * ---------------------------------------------------------------- */

/** The target SDK below which this Android version blocks installs (AOSP MIN_INSTALLABLE_TARGET_SDK). */
function minInstallableTarget(sdk: number): number {
  if (sdk >= 35) return 24
  if (sdk === 34) return 23
  return 0
}

function checkApp(draft: Draft, spec: DeviceSpec) {
  const app = draft.app
  if (!app || draft.kind === 'aab') return
  const has = (code: PlanIssueCode) => draft.problems.some((p) => p.code === code)
  if (app.minSdk > spec.sdkVersion && !has('OLDER_SDK')) {
    draft.problems.push(
      issue(
        'OLDER_SDK',
        `This app needs ${androidName(app.minSdk)} or newer. This phone runs ${androidName(spec.sdkVersion)}.`,
      ),
    )
  }
  // A single APK carries its native code itself: it must have some for this phone's CPU.
  const own = draft.parts.length === 1 ? app.nativeAbis : []
  if (
    own.length > 0 &&
    !own.some((abi) => spec.supportedAbis.includes(abi)) &&
    !has('NO_MATCHING_ABIS')
  ) {
    draft.problems.push(abiIssue(own, spec.supportedAbis))
  }
  const floor = minInstallableTarget(spec.sdkVersion)
  if (app.targetSdk > 0 && app.targetSdk < floor) {
    draft.warnings.push(
      issue(
        'DEPRECATED_SDK_VERSION',
        `This app targets an old Android (API ${String(app.targetSdk)}). ${androidName(spec.sdkVersion)} blocks it unless you allow it.`,
        { action: 'install-anyway' },
      ),
    )
  }
  if (app.testOnly) {
    draft.notes.push(issue('TEST_ONLY', 'A test-only build: Device Lab adds -t to install it.'))
  }
}

/* ---------------------------------------------------------------- *
 * The entry point
 * ---------------------------------------------------------------- */

/**
 * The install plan for what was dropped, for a phone described by `spec`. Never throws for a
 * bad file: every refusal is a problem in the plan, with its sentence.
 */
export async function planInstall(files: readonly File[], spec: DeviceSpec): Promise<InstallPlan> {
  const inspected = await Promise.all(files.map(inspect))
  const containers = inspected.flatMap((i) => ('zip' in i ? [i] : []))
  const loose = inspected.flatMap((i) => ('apk' in i ? [i] : []))

  const draft = emptyDraft('none')
  for (const i of inspected) {
    if (i.kind === 'damaged') draft.problems.push(i.problem)
    if (i.kind === 'apkm-encrypted') {
      draft.problems.push(
        issue(
          'APKM_ENCRYPTED',
          `${i.file.name} is encrypted (an old APKMirror format). Download it again from APKMirror.`,
          { file: i.file.name },
        ),
      )
    }
  }
  const strays = inspected.filter((i) => i.kind === 'other').map((i) => i.file.name)

  if (containers.length > 1 || (containers.length === 1 && loose.length > 0)) {
    draft.problems.push(
      issue(
        'MIXED_INPUTS',
        'Install one app at a time: drop one .apks, .xapk, .apkm or .aab file, or the APK files of one app.',
      ),
    )
  } else if (draft.problems.length === 0) {
    const container = containers[0]
    try {
      if (container) {
        draft.kind = container.kind
        if (container.kind === 'aab') await planAab(container.zip, container.file, draft)
        else if (container.kind === 'apks') await planApks(container.zip, spec, draft)
        else await planNamed(container.zip, container.kind, spec, draft)
        draft.used.add(container.file)
      } else if (loose.length > 0) {
        draft.kind = loose.length === 1 ? 'apk' : 'apk-set'
        const picked = assembleSet(
          loose.map((l) => l.apk),
          spec,
          draft,
        )
        await addBadge(draft, picked, spec)
      }
    } catch (error) {
      draft.problems.push(readProblem(container?.file.name ?? 'This file', error))
    }
    checkApp(draft, spec)
  }

  if (draft.problems.length === 0 && draft.kind === 'none') {
    draft.problems.push(issue('NOTHING_TO_INSTALL', APP_FILES))
  } else if (strays.length > 0 && containers.length + loose.length > 0) {
    draft.warnings.push(issue('FILES_SKIPPED', `Skipped ${listOf(strays)}: ${APP_FILES}`))
  }
  if (draft.problems.length > 0) {
    draft.parts = []
    draft.used.clear()
  }

  return {
    kind: draft.kind,
    inputs: inspected.map((i) => ({
      name: i.file.name,
      size: i.file.size,
      kind: i.kind,
      used: draft.used.has(i.file),
    })),
    app: draft.app,
    parts: draft.parts,
    totalBytes: draft.parts.reduce((n, p) => n + p.size, 0),
    selection: draft.selection,
    expansions: draft.expansions,
    problems: draft.problems,
    warnings: draft.warnings,
    notes: draft.notes,
  }
}

/* ---------------------------------------------------------------- *
 * Checks against the phone, once the package is known
 * ---------------------------------------------------------------- */

export interface PhoneFacts {
  /** The phone's API level. */
  readonly sdk: number
  /** Free bytes on /data, from `df /data`; leave out when unknown. */
  readonly freeBytes?: number
  /** The installed copy, from `dumpsys package`: null when not installed, left out when unknown. */
  readonly installed?: {
    readonly versionCode: number
    readonly versionName: string
    readonly debuggable: boolean
  } | null
}

export interface PhoneCheck {
  readonly problems: readonly PlanIssue[]
  readonly warnings: readonly PlanIssue[]
  readonly notes: readonly PlanIssue[]
}

/**
 * What the phone's state means for this plan: room for the app (Android needs about twice its
 * size while installing), and how it relates to the copy already installed. A downgrade is
 * possible only when the installed copy is debuggable; otherwise it has to be uninstalled first.
 */
export function checkPhone(plan: InstallPlan, phone: PhoneFacts): PhoneCheck {
  const problems: PlanIssue[] = []
  const warnings: PlanIssue[] = []
  const notes: PlanIssue[] = []
  const need = plan.totalBytes
  if (phone.freeBytes !== undefined && need > 0) {
    const sizes = `needs about ${fmtBytes(need)}, ${fmtBytes(phone.freeBytes)} free`
    if (phone.freeBytes < need) {
      problems.push(issue('INSUFFICIENT_SPACE', `Not enough space on the phone: ${sizes}.`))
    } else if (phone.freeBytes < need * 2) {
      warnings.push(
        issue(
          'LOW_SPACE',
          `Space is tight: ${sizes}. Android needs room to unpack the app too; free some up if the install fails.`,
        ),
      )
    }
  }
  const app = plan.app
  const installed = phone.installed
  if (app && installed) {
    const theirs = version(installed.versionName, installed.versionCode)
    const ours = version(app.versionName, app.versionCode)
    if (installed.versionCode > app.versionCode) {
      if (installed.debuggable) {
        warnings.push(
          issue(
            'VERSION_DOWNGRADE',
            `A newer version is installed (${theirs}). Allow downgrade to put ${ours} over it.`,
            { action: 'allow-downgrade' },
          ),
        )
      } else {
        problems.push(
          issue(
            'VERSION_DOWNGRADE',
            `A newer version is installed (${theirs}). Android won’t put an older one over it; uninstalling it first deletes its data.`,
            { action: 'uninstall-first' },
          ),
        )
      }
    } else if (installed.versionCode < app.versionCode) {
      notes.push(issue('UPDATE', `Updates the installed ${theirs} to ${ours}, keeping its data.`))
    } else {
      notes.push(issue('REINSTALL', `Reinstalls ${ours} over the same version, keeping its data.`))
    }
  }
  return { problems, warnings, notes }
}
