/*
  Packing an installed app back into one file, from the APKs `pm path` lists: a single APK is
  saved as it is (.apk); a split app becomes an .xapk, the format APKPure made and SAI, APKPure's
  installer and Device Lab's own planInstall read.

  An .xapk is a plain zip: manifest.json, an optional icon.png and the APKs at the root. Ours
  follows APKPure's v2 manifest (xapk_version 2; numbers other than total_size as strings, as
  APKPure writes them) and keeps each APK under the name Android gave it on the phone
  (base.apk, split_config.xxhdpi.apk). What the readers need from it:

    SAI          parses every *.apk's own manifest to pick the parts; reads package_name, name,
                 version_name and version_code from manifest.json, and the icon from a root
                 entry named exactly icon.png.
    APKPure      reads split_apks ({file, id}, id "base" for the base) to know the parts.
    planInstall  matches split_apks to entries by file name, and falls back on manifest.json
                 for the facts an APK's manifest does not give.

  Everything is STORED: APKs are compressed already, and a stored entry is what planInstall
  slices without inflating. The APK bytes are never copied: the result is a Blob made of the
  headers and the pulled Blobs. `adb install` cannot take an .xapk (it is not an APK); the
  toast says how to install one.
*/

export const APK_MIME = 'application/vnd.android.package-archive'
/** What APKPure serves .xapk files as; a type the browser has no extension of its own for. */
export const XAPK_MIME = 'application/xapk-package-archive'

/* ---------------------------------------------------------------- *
 * A stored zip
 * ---------------------------------------------------------------- */

let crcTable: Uint32Array | null = null

/** CRC-32 (ISO-HDLC, as zip uses), continued from `crc` for data that comes in pieces. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = ~crc >>> 0
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return ~c >>> 0
}

/** How much of a Blob is checksummed per read. */
const CRC_CHUNK = 1024 * 1024

/**
 * Read a slice at a time (Blob.slice works in every runtime, Blob.stream not in all), so a large
 * APK's checksum leaves the page room to draw between slices and can stop when cancelled.
 */
async function blobCrc(
  blob: Blob,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<number> {
  let crc = 0
  for (let at = 0; at < blob.size; at += CRC_CHUNK) {
    signal?.throwIfAborted()
    const chunk = new Uint8Array(await blob.slice(at, at + CRC_CHUNK).arrayBuffer())
    crc = crc32(chunk, crc)
    onBytes?.(chunk.length)
  }
  signal?.throwIfAborted()
  return crc
}

/** The 32-bit fields of a zip without ZIP64 stop just short of 4 GB. */
const ZIP_LIMIT = 0xffffffff
const TOO_BIG = 'These APKs add up to more than 4 GB, which a plain .zip can’t hold.'

/** MS-DOS date and time, the only kind a plain zip header holds (local time, 2-second steps). */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export interface ZipInput {
  readonly name: string
  readonly blob: Blob
}

export interface ZipOptions {
  /** The entries' modification time. */
  readonly at?: Date
  /** The result's MIME type. */
  readonly type?: string
  readonly signal?: AbortSignal
  /**
   * Bytes checksummed so far, of `total` (every entry's size): first with 0, then after each
   * slice. Checksumming is the slow part, about 50 MB/s on a slow machine, so a large app's
   * packing is shown as progress rather than a full bar that seems stuck.
   */
  readonly onProgress?: (done: number, total: number) => void
}

/**
 * A zip of `entries`, STORED, with UTF-8 names. The data is never copied: the result is a Blob
 * of the headers and the entries' own Blobs. Rejects past 4 GB, which needs ZIP64.
 */
export async function storedZip(
  entries: readonly ZipInput[],
  { at = new Date(), type = 'application/zip', signal, onProgress }: ZipOptions = {},
): Promise<Blob> {
  const total = entries.reduce((n, e) => n + e.blob.size, 0)
  let done = 0
  onProgress?.(0, total)
  const counted = (bytes: number) => {
    done += bytes
    onProgress?.(done, total)
  }
  const { time, date } = dosDateTime(at)
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const { name, blob } of entries) {
    const nameBytes = encoder.encode(name)
    if (offset + 30 + nameBytes.length + blob.size > ZIP_LIMIT) throw new Error(TOO_BIG)
    const crc = await blobCrc(blob, signal, counted)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed: 2.0
    lv.setUint16(6, 0x0800, true) // the name is UTF-8
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, blob.size, true)
    lv.setUint32(22, blob.size, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const entry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // made by: 2.0, MS-DOS attributes
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, blob.size, true)
    cv.setUint32(24, blob.size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    entry.set(nameBytes, 46)

    parts.push(local, blob)
    central.push(entry)
    offset += local.length + blob.size
  }
  const centralSize = central.reduce((n, e) => n + e.length, 0)
  if (offset + centralSize + 22 > ZIP_LIMIT || entries.length > 0xffff) throw new Error(TOO_BIG)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type })
}

/* ---------------------------------------------------------------- *
 * Names
 * ---------------------------------------------------------------- */

/** `/data/app/~~x==/com.example-y==/split_config.xxhdpi.apk` → `split_config.xxhdpi.apk`. */
export const apkFileName = (path: string) => path.split('/').pop() || 'base.apk'

/**
 * The split an installed APK is, from the name Android stores it under: `split_<name>.apk`.
 * The first APK `pm path` lists is the base whatever its name (a system app's is `Chrome.apk`).
 */
export function splitIdOf(fileName: string, isBase: boolean): string {
  if (isBase) return 'base'
  const stem = fileName.replace(/\.apk$/i, '')
  return stem.startsWith('split_') ? stem.slice('split_'.length) : stem
}

/** `com.example.shop-1.4.0.apk`, or `.xapk` for a split app: safe on every file system. */
export function exportName(packageName: string, version: string, files: number): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '')
  const stem = [packageName, version].map(safe).filter(Boolean).join('-')
  return `${stem || 'app'}.${files > 1 ? 'xapk' : 'apk'}`
}

/** Two APKs with one file name (never seen, but pm path does not forbid it) keep both. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.map((name) => {
    let out = name
    for (let n = 2; seen.has(out.toLowerCase()); n++)
      out = name.replace(/(\.apk)?$/i, `-${String(n)}$1`)
    seen.add(out.toLowerCase())
    return out
  })
}

/* ---------------------------------------------------------------- *
 * The manifest
 * ---------------------------------------------------------------- */

/** What the phone said about the app; null where it did not. */
export interface XapkApp {
  readonly packageName: string
  /** The label, as the launcher shows it; the package name when unknown. */
  readonly name: string
  readonly versionCode: number | null
  readonly versionName: string | null
  readonly minSdk: number | null
  readonly targetSdk: number | null
}

/** One pulled APK: `path` as `pm path` printed it, the base first. */
export interface PulledApk {
  readonly path: string
  readonly blob: Blob
}

export interface XapkManifest {
  readonly xapk_version: 2
  readonly package_name: string
  readonly name: string
  readonly version_code?: string
  readonly version_name?: string
  readonly min_sdk_version?: string
  readonly target_sdk_version?: string
  readonly split_configs: readonly string[]
  readonly split_apks: readonly { readonly file: string; readonly id: string }[]
  readonly total_size: number
  readonly icon?: string
}

/** The name readers look for: SAI takes the icon from `icon.png` only, and sniffs its bytes. */
export const XAPK_ICON = 'icon.png'

/**
 * manifest.json for `apks` (entry names at the root, the base first). Fields the phone did not
 * give are left out rather than guessed: every reader treats them as optional.
 */
export function xapkManifest(
  app: XapkApp,
  apks: readonly { readonly file: string; readonly size: number }[],
  hasIcon: boolean,
): XapkManifest {
  const ids = apks.map((a, i) => splitIdOf(a.file, i === 0))
  const optional = (key: string, value: number | string | null) =>
    value === null || value === '' ? {} : { [key]: String(value) }
  return {
    xapk_version: 2,
    package_name: app.packageName,
    name: app.name || app.packageName,
    ...optional('version_code', app.versionCode),
    ...optional('version_name', app.versionName),
    ...optional('min_sdk_version', app.minSdk),
    ...optional('target_sdk_version', app.targetSdk),
    split_configs: ids.filter((id) => id !== 'base'),
    split_apks: apks.map((a, i) => ({ file: a.file, id: ids[i] ?? a.file })),
    total_size: apks.reduce((n, a) => n + a.size, 0),
    ...(hasIcon ? { icon: XAPK_ICON } : {}),
  }
}

/* ---------------------------------------------------------------- *
 * The file
 * ---------------------------------------------------------------- */

export interface PackedApp {
  readonly blob: Blob
  readonly fileName: string
  readonly kind: 'apk' | 'xapk'
  /** How many APKs it holds. */
  readonly apks: number
}

/**
 * The file to save for an app pulled off the phone: its one APK as it is, or an .xapk of its
 * APKs (manifest.json first, then the icon when a bitmap one is known, then the APKs in `pm
 * path` order). Rejects when `apks` is empty, past 4 GB, or once `signal` aborts. `onProgress`
 * follows the checksum, as in storedZip; a single APK is not packed, so it never reports.
 */
export async function packApp(
  app: XapkApp,
  apks: readonly PulledApk[],
  {
    icon = null,
    at,
    signal,
    onProgress,
  }: Pick<ZipOptions, 'at' | 'signal' | 'onProgress'> & { icon?: Blob | null } = {},
): Promise<PackedApp> {
  const [first] = apks
  if (!first) throw new Error('Android listed no APK files for this app.')
  const version = app.versionName ?? (app.versionCode === null ? '' : String(app.versionCode))
  const fileName = exportName(app.packageName, version, apks.length)
  if (apks.length === 1) {
    return { blob: new Blob([first.blob], { type: APK_MIME }), fileName, kind: 'apk', apks: 1 }
  }
  const names = uniqueNames(apks.map((a) => apkFileName(a.path)))
  const files = apks.map((a, i) => ({ name: names[i] ?? apkFileName(a.path), blob: a.blob }))
  const manifest = xapkManifest(
    app,
    files.map((f) => ({ file: f.name, size: f.blob.size })),
    icon !== null,
  )
  const entries: ZipInput[] = [
    { name: 'manifest.json', blob: new Blob([JSON.stringify(manifest, null, 2)]) },
    ...(icon ? [{ name: XAPK_ICON, blob: icon }] : []),
    ...files,
  ]
  // An `at` left undefined takes storedZip's default, now.
  const blob = await storedZip(entries, { type: XAPK_MIME, at, signal, onProgress })
  return { blob, fileName, kind: 'xapk', apks: apks.length }
}
