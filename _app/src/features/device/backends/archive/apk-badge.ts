import { argbOf, parseArsc, pickValue, type ResourceTable, type ResValue } from './arsc'
import { ATTR, attribute, manifestInfo, parseAxml, TYPE } from './axml'
import { bestDensity, languageOf, splitRole } from './select'
import { openZip, type ByteSource, type ZipArchive } from './zip'

/*
  An app's name and icon, read out of its APK files the way the launcher shows them: the
  manifest names two resources, resources.arsc says which string and which file each is for
  this phone's language and screen, and the icon file is read from whichever APK holds it.
  No shell command prints either, so this is how Device Lab gets them.

  Every read goes through a ByteSource, so the same code runs on a dropped File and on an app
  installed on the phone, where the core backs the reads with adb (base.apk is world-readable,
  but sync cannot seek, so a piece at a time is `dd` on whole blocks, files.ts readFileRange). On real apps that is
  about 0.7–1.9 MB per app, nearly all of it resources.arsc, in four to nine reads.

  Ported from the APK badge probe (pixel-probes/apk.ts), which matched `aapt2 dump badging` on
  nine APKs. Vector icons are not drawn: the caller shows its fallback (the initial).
*/

export interface BadgeSplit {
  /** The split's name, as `splitNameOf` reads it from the file name. */
  readonly name: string
  /** Opened only if needed: the phone's language split for the label, its density split for the icon. */
  readonly open: () => Promise<ByteSource>
}

export interface BadgeOptions {
  /** The phone's locales, most preferred first ('vi-VN', 'en-US'): the label's language. */
  readonly locales?: readonly string[]
  /** The screen density to pick the icon for, in dpi. 480 (xxhdpi) by default. */
  readonly density?: number
  /** The phone's API level, so resources for newer Android versions are passed over. */
  readonly sdk?: number
  /** Read the label only. */
  readonly skipIcon?: boolean
}

export interface IconImage {
  readonly mime: 'image/png' | 'image/webp' | 'image/jpeg'
  readonly bytes: Uint8Array<ArrayBuffer>
}

export type BadgeIcon =
  | ({ readonly kind: 'bitmap' } & IconImage)
  | {
      /**
       * An adaptive icon with a bitmap foreground. Both layers are 108 dp squares of which the
       * launcher shows the middle 72 dp: scale them up by half and clip to the avatar's shape.
       */
      readonly kind: 'adaptive'
      readonly foreground: IconImage
      /** A colour (0xAARRGGBB), a bitmap, or null when it is a vector Device Lab cannot draw. */
      readonly background: { readonly argb: number } | IconImage | null
    }

export interface ApkBadge {
  readonly packageName: string
  readonly versionCode: number
  readonly versionName: string
  /** In the phone's language when the app has it; null when there is no label to read. */
  readonly label: string | null
  /** Null when the icon is a vector, or when it could not be read. */
  readonly icon: BadgeIcon | null
  /** What it cost, to budget reads over USB. */
  readonly stats: { readonly reads: number; readonly bytes: number }
}

const MANIFEST_LIMIT = 4 * 1024 * 1024
const TABLE_LIMIT = 32 * 1024 * 1024
const ICON_LIMIT = 2 * 1024 * 1024
/** References are followed this many times at most: `@string/a` → `@string/b` → text. */
const MAX_HOPS = 5

/** 'split_config.vi.apk' → 'config.vi'; 'base.apk' (or any path to it) → ''. */
export function splitNameOf(fileName: string): string {
  const name = (fileName.split('/').pop() ?? '').replace(/\.apk$/i, '')
  if (name === 'base') return ''
  return name.replace(/^split_/, '')
}

/** PNG, WebP or JPEG by their first bytes; null for anything else. */
export function imageMime(bytes: Uint8Array): IconImage['mime'] | null {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  const tag = (i: number) => String.fromCharCode(at(i), at(i + 1), at(i + 2), at(i + 3))
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp'
  return null
}

/** A source that counts what is read through it. */
function counted(source: ByteSource, stats: { reads: number; bytes: number }): ByteSource {
  return {
    size: source.size,
    async read(offset, length) {
      const bytes = await source.read(offset, length)
      stats.reads++
      stats.bytes += bytes.length
      return bytes
    },
    ...(source.slice ? { slice: source.slice } : {}),
  }
}

interface Part {
  zip: ZipArchive
  table: ResourceTable | null
}

/** An APK's resource table; null when it has none, or one too damaged to read. */
async function tableOf(zip: ZipArchive): Promise<ResourceTable | null> {
  const entry = zip.get('resources.arsc')
  if (!entry) return null
  try {
    return parseArsc(await zip.bytes(entry, TABLE_LIMIT))
  } catch {
    return null
  }
}

/**
 * The label and icon of an app, from its base APK and, when given, its splits: the phone's
 * language split holds the label in that language, and an icon split by density lives in the
 * phone's density split. Throws when the base APK cannot be read at all; a label or icon that
 * cannot be resolved is null, never an error.
 */
export async function readApkBadge(
  base: ByteSource,
  splits: readonly BadgeSplit[] = [],
  options: BadgeOptions = {},
): Promise<ApkBadge> {
  const stats = { reads: 0, bytes: 0 }
  const baseZip = await openZip(counted(base, stats))
  const manifestEntry = baseZip.get('AndroidManifest.xml')
  if (!manifestEntry) throw new Error('APK_NO_MANIFEST')
  const manifest = manifestInfo(await baseZip.bytes(manifestEntry, MANIFEST_LIMIT))
  const prefs = { locales: options.locales, density: options.density ?? 480, sdk: options.sdk }

  const wantLabel = manifest.labelId !== null
  const wantIcon = manifest.iconId !== null && !options.skipIcon
  const parts: Part[] = []
  if (wantLabel || wantIcon) {
    parts.push({ zip: baseZip, table: await tableOf(baseZip) })
    for (const split of chooseSplits(splits, wantLabel, wantIcon, prefs)) {
      try {
        const zip = await openZip(counted(await split.open(), stats))
        parts.push({ zip, table: await tableOf(zip) })
      } catch {
        // A split that cannot be read only costs its language or its sharper icon.
      }
    }
  }

  const values = (id: number) =>
    parts.flatMap((p) => {
      try {
        return p.table?.values(id) ?? []
      } catch {
        return []
      }
    })
  const resolve = (id: number, filter: (v: ResValue) => boolean = () => true) => {
    let value: ResValue | null = null
    let next: number | null = id
    for (let hop = 0; next !== null && hop < MAX_HOPS; hop++) {
      value = pickValue(values(next).filter(filter), prefs)
      next = value?.type === TYPE.REFERENCE ? value.data : null
    }
    return value
  }

  let label = manifest.label
  if (manifest.labelId !== null) {
    const value = resolve(manifest.labelId)
    label = value?.type === TYPE.STRING ? (value.str ?? null) : null
  }

  let icon: BadgeIcon | null = null
  if (wantIcon && manifest.iconId !== null) {
    icon = await readIcon(manifest.iconId, parts, values, resolve).catch(() => null)
  }

  return {
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    label: label || null,
    icon,
    stats,
  }
}

/** The splits worth opening: the phone's first language the app has, and its density. */
function chooseSplits(
  splits: readonly BadgeSplit[],
  wantLabel: boolean,
  wantIcon: boolean,
  prefs: { locales?: readonly string[]; density: number },
): BadgeSplit[] {
  const chosen: BadgeSplit[] = []
  const configs = splits.map((s) => ({ split: s, role: splitRole(s.name) }))
  const ofBase = configs.filter((c) => c.role.module === 'base')
  if (wantLabel) {
    for (const locale of prefs.locales ?? []) {
      const hit = ofBase.find(
        (c) => c.role.kind === 'language' && languageOf(c.role.value) === languageOf(locale),
      )
      if (hit) {
        chosen.push(hit.split)
        break
      }
    }
  }
  if (wantIcon) {
    // A phone has one density split installed; a dropped set may offer several.
    const densities = ofBase.filter((c) => c.role.kind === 'density')
    const dpi = bestDensity(
      densities.map((c) => Number(c.role.value)),
      prefs.density,
    )
    const best = densities.find((c) => Number(c.role.value) === dpi)
    if (best) chosen.push(best.split)
  }
  return chosen
}

const BITMAP = /\.(png|webp|jpe?g)$/i

async function readIcon(
  iconId: number,
  parts: readonly Part[],
  values: (id: number) => ResValue[],
  resolve: (id: number, filter?: (v: ResValue) => boolean) => ResValue | null,
): Promise<BadgeIcon | null> {
  /** A file named by the table, from whichever APK holds it. */
  const file = async (path: string, limit: number) => {
    for (const p of parts) {
      const entry = p.zip.get(path)
      if (entry) return p.zip.bytes(entry, limit)
    }
    return null
  }
  const image = async (path: string): Promise<IconImage | null> => {
    const bytes = await file(path, ICON_LIMIT)
    const mime = bytes && imageMime(bytes)
    return bytes && mime ? { mime, bytes } : null
  }
  /** A drawable as a bitmap when it has one: legacy launcher icons ship next to adaptive ones. */
  const bitmapOf = async (id: number) => {
    const hasBitmap = values(id).some((v) => BITMAP.test(v.str ?? ''))
    const value = resolve(id, hasBitmap ? (v) => BITMAP.test(v.str ?? '') : undefined)
    return value?.str && BITMAP.test(value.str) ? image(value.str) : null
  }

  const bitmap = await bitmapOf(iconId)
  if (bitmap) return { kind: 'bitmap', ...bitmap }

  const xmlValue = resolve(iconId)
  if (!xmlValue?.str?.endsWith('.xml')) return null
  const xml = await file(xmlValue.str, MANIFEST_LIMIT)
  if (!xml) return null
  const elements = parseAxml(xml)
  if (elements[0]?.name !== 'adaptive-icon') return null
  const layer = (name: string) =>
    attribute(
      elements.find((e) => e.name === name && e.depth === 1),
      ATTR.drawable,
    )

  const fg = layer('foreground')
  const foreground = fg?.type === TYPE.REFERENCE ? await bitmapOf(fg.data) : null
  if (!foreground) return null

  const bg = layer('background')
  let background: { argb: number } | IconImage | null = null
  if (bg) {
    const literal = argbOf(bg)
    if (literal !== null) background = { argb: literal }
    else if (bg.type === TYPE.REFERENCE) {
      const value = resolve(bg.data)
      const colour = value ? argbOf(value) : null
      background = colour !== null ? { argb: colour } : await bitmapOf(bg.data)
    }
  }
  return { kind: 'adaptive', foreground, background }
}
