import { readApkBadge } from '@/features/device/backends/archive/apk-badge'
import { manifestInfo, type ManifestInfo } from '@/features/device/backends/archive/axml'
import { blobSource, openZip, ZipError } from '@/features/device/backends/archive/zip'

import type { BuildInspection, InspectProblem } from '../types'

/*
  An APK, read in the browser by Device Lab's own readers, the ones that install apps on a
  phone over USB, so the console and Device Lab can never disagree about a file. The manifest
  says what the app is and whether a phone will take it on its own from a link; the app's
  resources give the name and the icon a launcher shows.

  Nothing here throws for a bad file. A file that is not an APK, or one Android would refuse,
  comes back as an inspection with a problem, which the Upload sheet words and will not publish.
*/

/** Device Lab's cap on a manifest. A real one is tens of kilobytes; this stops a zip bomb. */
const MANIFEST_LIMIT = 4 * 1024 * 1024

/**
 * The label an English-language phone shows (the app's English strings when it has them, else
 * its default ones), and the icon a launcher picks on an xxxhdpi screen: the sharpest the APK
 * holds, for a 256 px icon.png.
 */
const BADGE_OPTIONS = { locales: ['en-US'], density: 640 }

/** An APK that could not be read: only why. The dispatcher names it after its file. */
const refused = (code: 'APK_INVALID' | 'NO_INFLATE'): BuildInspection => ({
  platform: 'android',
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
})

/** The last 16 bytes of a v2+ APK Signing Block, which ends where the central directory starts. */
const SIGNING_BLOCK_MAGIC = 'APK Sig Block 42'

/**
 * Android 11 (API 30). An app that targets it or later must carry a v2+ signature; v1 alone is
 * no longer enough (ApkSignatureVerifier.getMinimumSignatureSchemeVersionForTargetSdk).
 */
const V2_SIGNING_SDK = 30

/**
 * Which of Android's signature schemes an APK carries: 'v2+' when it has an APK Signing Block
 * (v2, v3 and later all live in it, with or without v1 files beside it), 'v1' for a JAR
 * signature alone (a .RSA, .DSA or .EC file in META-INF/), 'none' for neither.
 */
type Signing = 'none' | 'v1' | 'v2+'

/**
 * Where the zip's central directory starts, from its end record; null when that cannot be told
 * (no end record, or a ZIP64 archive: under GitHub's 2 GB limit on a release file, every offset
 * fits the plain record, so only a tool that writes ZIP64 regardless makes one).
 */
async function centralDirectoryOffset(file: Blob): Promise<number | null> {
  const tailSize = Math.min(file.size, 22 + 0xffff)
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer())
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  for (let at = tail.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) !== 0x06054b50) continue
    // The record's comment must fit before the end, or these four bytes are just data.
    if (at + 22 + view.getUint16(at + 20, true) > tail.length) continue
    const offset = view.getUint32(at + 16, true)
    return offset === 0xffffffff ? null : offset
  }
  return null
}

/**
 * How the APK is signed. Each scheme is looked for on its own: an APK built for Android 7+
 * often has only the v2+ block, while one signed by jarsigner, or by Gradle with
 * v2SigningEnabled false, has only the v1 files, which Android 11 refuses for an app that
 * targets it. When the end of the zip cannot be read the APK is given the benefit of the doubt,
 * as if it had the block: the phone checks it anyway.
 */
async function signingOf(file: Blob, names: readonly string[]): Promise<Signing> {
  const directory = await centralDirectoryOffset(file).catch(() => null)
  if (directory === null || (await hasSigningBlock(file, directory).catch(() => false))) {
    return 'v2+'
  }
  return names.some((name) => /^META-INF\/[^/]+\.(?:RSA|DSA|EC)$/i.test(name)) ? 'v1' : 'none'
}

/**
 * The v2+ block, checked the way apksigner finds it: the magic, then the block's size, which it
 * writes twice — just before the magic and at the block's very start — and which must agree. The
 * magic alone could be the last 16 bytes of any stored file.
 */
async function hasSigningBlock(file: Blob, directory: number): Promise<boolean> {
  // The footer: the size (u64), then the magic.
  const footerSize = 8 + SIGNING_BLOCK_MAGIC.length
  if (directory < footerSize + 8) return false
  const footer = new Uint8Array(await file.slice(directory - footerSize, directory).arrayBuffer())
  if (new TextDecoder().decode(footer.subarray(8)) !== SIGNING_BLOCK_MAGIC) return false
  // Counts everything after the leading size: the signer blocks and the footer.
  const size = new DataView(footer.buffer, footer.byteOffset).getBigUint64(0, true)
  if (size < BigInt(footerSize) || size > BigInt(directory - 8)) return false
  const start = directory - Number(size) - 8
  const lead = new Uint8Array(await file.slice(start, start + 8).arrayBuffer())
  return new DataView(lead.buffer, lead.byteOffset).getBigUint64(0, true) === size
}

/** The ABIs the app has native code for: each `lib/<abi>/` that holds a shared library. */
function abisOf(names: readonly string[]): string[] {
  const abis = new Set<string>()
  for (const name of names) {
    const abi = /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1]
    if (abi) abis.add(abi)
  }
  return [...abis].sort()
}

/**
 * Why Android would refuse this APK as the one file a tester downloads, and what a tester
 * should know about it anyway.
 */
function verdict(manifest: ManifestInfo, signing: Signing) {
  const problems: InspectProblem[] = []
  // The package name is the app's identity: the installer rejects a manifest without one.
  if (!manifest.packageName) problems.push({ code: 'APK_INVALID' })
  // A split installs only beside its base. A base that requires splits is refused without
  // them too: bundletool marks it with requiredSplitTypes (Android 12L and later enforce it),
  // older tools with isSplitRequired. Either way it is not an APK that installs alone.
  if (manifest.split) problems.push({ code: 'APK_SPLIT', detail: manifest.split })
  else if (manifest.isSplitRequired || manifest.requiredSplitTypes.length > 0) {
    problems.push({ code: 'APK_SPLIT' })
  }
  // What Android Studio's Run button builds: the package installer refuses it outright.
  if (manifest.testOnly) problems.push({ code: 'APK_TEST_ONLY' })
  // Unsigned, the installer refuses it as "package appears to be invalid", and AGP names an
  // unsigned release build app-release-unsigned.apk, an easy file to send by mistake. Signed
  // with v1 alone, it is refused the same way once the app targets Android 11 or later; a
  // preview's codename reads as API 10000, so it needs v2 too.
  if (signing === 'none') problems.push({ code: 'APK_UNSIGNED' })
  else if (signing === 'v1' && manifest.targetSdk >= V2_SIGNING_SDK) {
    problems.push({ code: 'APK_V1_ONLY' })
  }
  const warnings: InspectProblem[] = manifest.debuggable ? [{ code: 'APK_DEBUGGABLE' }] : []
  return { problems, warnings }
}

/** An APK's facts and problems. Never rejects: a file Android would refuse says why instead. */
export async function inspectApk(file: Blob): Promise<BuildInspection> {
  let manifest: ManifestInfo
  let abis: string[]
  let signing: Signing
  try {
    const zip = await openZip(file)
    const entry = zip.get('AndroidManifest.xml')
    // An .aab, an .apks or a plain zip renamed .apk: a zip, but no app a phone can install.
    if (!entry) return refused('APK_INVALID')
    manifest = manifestInfo(await zip.bytes(entry, MANIFEST_LIMIT))
    const names = zip.entries.map((e) => e.name)
    abis = abisOf(names)
    signing = await signingOf(file, names)
  } catch (error) {
    // Without DecompressionStream no compressed entry can be read, whatever the file is. Any
    // other failure (not a zip, a download cut short, a manifest that is not Android's binary
    // XML) means it is not an APK a phone would install.
    const noInflate = error instanceof ZipError && error.code === 'ZIP_NO_INFLATE'
    return refused(noInflate ? 'NO_INFLATE' : 'APK_INVALID')
  }

  // The name and the icon are a nicety: an APK whose resources cannot be read still installs.
  const badge = await readApkBadge(blobSource(file), [], BADGE_OPTIONS).catch(() => null)
  const label = (badge?.label ?? manifest.label ?? '').trim()
  const { problems, warnings } = verdict(manifest, signing)
  return {
    platform: 'android',
    name: label || manifest.packageName,
    bundleId: manifest.packageName,
    version: manifest.versionName || String(manifest.versionCode),
    build: String(manifest.versionCode),
    minOs: manifest.minSdkCodename || String(manifest.minSdk),
    android: { target_sdk: manifest.targetSdk, debuggable: manifest.debuggable, abis },
    ios: null,
    icon: badge?.icon ? { kind: 'badge', icon: badge.icon } : null,
    problems,
    warnings,
  }
}
