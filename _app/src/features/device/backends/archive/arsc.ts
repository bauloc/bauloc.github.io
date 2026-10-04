import { stringPool, TYPE, type StringPool } from './axml'
import { bestDensity, languageOf } from './select'

/*
  resources.arsc, the compiled resource table of an APK: just enough to turn the resource ids a
  manifest names (the app's label, its icon) into a string or a file path, for every
  configuration the table holds, and to pick the one Android would show on a given phone.

  The table is indexed once (which chunks hold which type) and values are read only for the
  ids asked about, so a 2 MB table costs a few milliseconds. Sparse, 16-bit-offset and compact
  entries (aapt2's newer encodings) are read; styles and other bags are skipped, as a label or
  an icon is never one.

  Ported from the APK badge probe (pixel-probes/apk.ts), which matched `aapt2 dump badging`.
*/

/** The qualifiers a value is for. Only the ones that decide a label or an icon are modelled. */
export interface ResConfig {
  /** '' for the default; legacy codes as resource folders keep them ('iw', 'in'). */
  readonly language: string
  readonly region: string
  /** dpi; 0 when unqualified, 0xfffe for anydpi, 0xffff for nodpi. */
  readonly density: number
  /** The minimum API level (`-v26`); 0 when unqualified. */
  readonly sdk: number
  /** 0 either, 1 not night, 2 night only. */
  readonly night: number
  /** Qualified by anything else (screen size, orientation, car, carrier, …). */
  readonly other: boolean
}

export interface ResValue {
  /** A Res_value type (axml TYPE). */
  readonly type: number
  readonly data: number
  /** The text of a string, which for a drawable is its file's path in the APK. */
  readonly str?: string
  readonly config: ResConfig
}

export interface ResourceTable {
  /** Every value the table holds for `id`, one per configuration. */
  readonly values: (id: number) => readonly ResValue[]
  /** The resource's type ('string', 'drawable', 'mipmap', 'color'…); '' when not in the table. */
  readonly typeName: (id: number) => string
}

const RES_TABLE = 0x0002
const RES_STRING_POOL = 0x0001
const RES_TABLE_PACKAGE = 0x0200
const RES_TABLE_TYPE = 0x0201

const FLAG_SPARSE = 0x01
const FLAG_OFFSET16 = 0x02
const ENTRY_COMPLEX = 0x0001
const ENTRY_COMPACT = 0x0008
const NO_ENTRY_16 = 0xffff
const NO_ENTRY_32 = 0xffffffff

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

/** A two-byte language or region, or three letters packed into 15 bits (e.g. 'fil'). */
function unpack(b0: number, b1: number, base: number): string {
  if (b0 & 0x80) {
    const first = b1 & 0x1f
    const second = ((b1 & 0xe0) >> 5) + ((b0 & 0x03) << 3)
    const third = (b0 & 0x7c) >> 2
    return String.fromCharCode(first + base, second + base, third + base)
  }
  return b0 ? String.fromCharCode(b0, b1) : ''
}

function readConfig(v: DataView, at: number): ResConfig {
  const size = v.getUint32(at, true)
  const u8 = (o: number) => (o < size ? v.getUint8(at + o) : 0)
  const u16 = (o: number) => (o + 2 <= size ? v.getUint16(at + o, true) : 0)
  const uiMode = u8(29)
  let other =
    u16(4) !== 0 || // mcc
    u16(6) !== 0 || // mnc
    [12, 13, 16, 17, 18, 28].some((o) => u8(o) !== 0) || // orientation, touch, keys, layout
    [20, 22, 30, 32, 34].some((o) => u16(o) !== 0) || // screen sizes
    (uiMode & 0x0f) !== 0 // car, desk, television, watch…
  for (let o = 48; o < Math.min(size, 50); o++) if (u8(o) !== 0) other = true // layout2, colour
  return {
    language: unpack(u8(8), u8(9), 0x61),
    region: unpack(u8(10), u8(11), 0x30),
    density: u16(14),
    sdk: u16(24),
    night: (uiMode & 0x30) >> 4,
    other,
  }
}

/** Indexes a resources.arsc. Throws ARSC_NOT_A_TABLE or ARSC_CORRUPT. */
export function parseArsc(bytes: Uint8Array): ResourceTable {
  const v = view(bytes)
  if (bytes.length < 12 || v.getUint16(0, true) !== RES_TABLE) throw new Error('ARSC_NOT_A_TABLE')
  // A table cut short (a partial read from the phone) claims more than it has.
  if (v.getUint32(4, true) > bytes.length) throw new Error('ARSC_CORRUPT')

  let globals: StringPool = { size: 0, get: () => undefined }
  /** (package id << 8 | type id) → offsets of the type chunks for it, one per configuration. */
  const chunks = new Map<number, number[]>()
  const typeNames = new Map<number, string>()

  try {
    for (let p = v.getUint16(2, true); p + 8 <= bytes.length;) {
      const type = v.getUint16(p, true)
      const size = v.getUint32(p + 4, true)
      if (size < 8 || p + size > bytes.length) throw new Error('ARSC_CORRUPT')
      if (type === RES_STRING_POOL) globals = stringPool(bytes, p)
      else if (type === RES_TABLE_PACKAGE) indexPackage(p, size)
      p += size
    }
  } catch (error) {
    if (error instanceof RangeError) throw new Error('ARSC_CORRUPT', { cause: error })
    throw error
  }

  function indexPackage(p: number, size: number) {
    const headerSize = v.getUint16(p + 2, true)
    const pkg = v.getUint32(p + 8, true)
    const typeStringsAt = p + v.getUint32(p + 268, true)
    // Type ids count from 1, offset by typeIdOffset in tables built for API 28+.
    const typeIdOffset = headerSize >= 288 ? v.getUint32(p + 284, true) : 0
    let typeStrings: StringPool | null = null
    for (let q = p + headerSize; q + 8 <= p + size;) {
      const t = v.getUint16(q, true)
      const tSize = v.getUint32(q + 4, true)
      if (tSize < 8 || q + tSize > p + size) throw new Error('ARSC_CORRUPT')
      if (t === RES_STRING_POOL && q === typeStringsAt) typeStrings = stringPool(bytes, q)
      else if (t === RES_TABLE_TYPE) {
        const typeId = v.getUint8(q + 8)
        const key = (pkg << 8) | typeId
        let list = chunks.get(key)
        if (!list) chunks.set(key, (list = []))
        list.push(q)
        if (!typeNames.has(key)) {
          typeNames.set(key, typeStrings?.get(typeId - 1 - typeIdOffset) ?? '')
        }
      }
      q += tSize
    }
  }

  /** The value of entry `index` in the type chunk at `q`, or null when the chunk lacks it. */
  function entry(q: number, index: number): ResValue | null {
    const headerSize = v.getUint16(q + 2, true)
    const flags = v.getUint8(q + 9)
    const count = v.getUint32(q + 12, true)
    const entriesStart = q + v.getUint32(q + 16, true)
    let offset = -1
    if (flags & FLAG_SPARSE) {
      // Sorted {u16 index, u16 offset / 4} pairs.
      let lo = 0
      let hi = count - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const at = q + headerSize + mid * 4
        const idx = v.getUint16(at, true)
        if (idx === index) {
          offset = v.getUint16(at + 2, true) * 4
          break
        }
        if (idx < index) lo = mid + 1
        else hi = mid - 1
      }
    } else if (index < count) {
      if (flags & FLAG_OFFSET16) {
        const o = v.getUint16(q + headerSize + index * 2, true)
        offset = o === NO_ENTRY_16 ? -1 : o * 4
      } else {
        const o = v.getUint32(q + headerSize + index * 4, true)
        offset = o === NO_ENTRY_32 ? -1 : o
      }
    }
    if (offset < 0) return null
    const e = entriesStart + offset
    const entryFlags = v.getUint16(e + 2, true)
    let type: number
    let data: number
    if (entryFlags & ENTRY_COMPACT) {
      // {u16 key, u16 flags with the value type in the high byte, u32 data}
      type = entryFlags >> 8
      data = v.getUint32(e + 4, true)
    } else if (entryFlags & ENTRY_COMPLEX) {
      return null
    } else {
      const value = e + v.getUint16(e, true)
      type = v.getUint8(value + 3)
      data = v.getUint32(value + 4, true)
    }
    const config = readConfig(v, q + 20)
    return type === TYPE.STRING
      ? { type, data, str: globals.get(data) ?? '', config }
      : { type, data, config }
  }

  return {
    values(id) {
      const list = chunks.get((id >>> 24) * 256 + ((id >>> 16) & 0xff)) ?? []
      try {
        return list.map((q) => entry(q, id & 0xffff)).filter((x): x is ResValue => x !== null)
      } catch (error) {
        if (error instanceof RangeError) throw new Error('ARSC_CORRUPT', { cause: error })
        throw error
      }
    },
    typeName: (id) => typeNames.get((id >>> 24) * 256 + ((id >>> 16) & 0xff)) ?? '',
  }
}

/* ---------------------------------------------------------------- *
 * Choosing a value
 * ---------------------------------------------------------------- */

export interface ResPreferences {
  /** The phone's locales, most preferred first ('vi-VN', 'en-US'). */
  readonly locales?: readonly string[]
  /** dpi; for drawables. */
  readonly density?: number
  /** The phone's API level: values for newer Android versions are left out. */
  readonly sdk?: number
}

/**
 * The value Android would pick for a phone like this, by the qualifiers that matter for a label
 * or an icon: the first of the phone's languages the app has (an exact region beating a
 * language-only value), then density, then the newest SDK level that applies. Night-only,
 * carrier and device-class values are passed over while anything else fits. A simplification
 * of ResTable_config::isBetterThan, not a copy of it.
 */
export function pickValue(
  values: readonly ResValue[],
  prefs: ResPreferences = {},
): ResValue | null {
  const sdk = prefs.sdk ?? Number.MAX_SAFE_INTEGER
  let fits = values.filter((x) => x.config.sdk <= sdk && x.config.night !== 2)
  const plain = fits.filter((x) => !x.config.other)
  if (plain.length > 0) fits = plain
  if (fits.length === 0) return null

  // Language: the first of the phone's locales the app has, by an exact region or a value for
  // the language alone (another region of the language does not count: an en-US phone shows
  // the default, not values-en-rGB); else the default; else English; else anything.
  let pool: ResValue[] = []
  for (const locale of prefs.locales ?? []) {
    const language = languageOf(locale)
    const region = locale.split(/[-_]/).find((part, i) => i > 0 && /^[A-Z]{2}$|^\d{3}$/.test(part))
    const same = fits.filter((x) => languageOf(x.config.language) === language)
    const exact = same.filter((x) => x.config.region === region)
    pool = exact.length > 0 ? exact : same.filter((x) => x.config.region === '')
    if (pool.length > 0) break
  }
  if (pool.length === 0) pool = fits.filter((x) => x.config.language === '')
  if (pool.length === 0) pool = fits.filter((x) => x.config.language === 'en')
  if (pool.length === 0) pool = fits

  // Density: Android's rule among the densities on offer; unqualified counts as mdpi.
  const densities = [...new Set(pool.map((x) => x.config.density || 160))]
  if (densities.length > 1) {
    const best = bestDensity(densities, prefs.density ?? 160)
    pool = pool.filter((x) => (x.config.density || 160) === best)
  }
  // The most specific SDK qualifier that still applies.
  return pool.reduce((a, b) => (b.config.sdk > a.config.sdk ? b : a))
}

/** A colour value as 0xAARRGGBB, or null when the value is not a colour. */
export function argbOf(value: Pick<ResValue, 'type' | 'data'>): number | null {
  const d = value.data
  const nibbles = (n: number) => ((n & 0xf) * 0x11) >>> 0
  switch (value.type) {
    case TYPE.COLOR_ARGB8:
      return d >>> 0
    case TYPE.COLOR_RGB8:
      return (0xff000000 | d) >>> 0
    case TYPE.COLOR_ARGB4:
      return (
        ((nibbles(d >> 12) << 24) |
          (nibbles(d >> 8) << 16) |
          (nibbles(d >> 4) << 8) |
          nibbles(d)) >>>
        0
      )
    case TYPE.COLOR_RGB4:
      return ((0xff << 24) | (nibbles(d >> 8) << 16) | (nibbles(d >> 4) << 8) | nibbles(d)) >>> 0
    default:
      return null
  }
}
