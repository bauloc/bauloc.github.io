import { pbFields, pbMsg, pbMsgs, pbNum, pbStr, type PbFields } from './toc'

/*
  Android's compiled XML: the AndroidManifest.xml inside every APK, and drawable XML such as an
  adaptive icon. Read into plain elements and attributes, then summarised into what an
  installer needs from a manifest: package, versions, SDK levels, what kind of split it is,
  test-only and debuggable, and where the label and icon live.

  An .aab keeps its manifest as protobuf instead (aapt2's Resources.proto XmlNode); that is read
  into the same elements, so one summary serves both.

  Ported from the bundle-install prototype (proto/axml.mjs) and the APK badge probe
  (pixel-probes/apk.ts), which matched `aapt2 dump badging` on nine APKs.
*/

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android'
export const DIST_NS = 'http://schemas.android.com/apk/distribution'

/** android.R.attr ids. Shrinkers rename or blank attribute name strings, never these ids. */
export const ATTR = {
  label: 0x01010001,
  icon: 0x01010002,
  name: 0x01010003,
  hasCode: 0x0101000c,
  debuggable: 0x0101000f,
  value: 0x01010024,
  drawable: 0x01010199,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  testOnly: 0x0101026c,
  targetSdkVersion: 0x01010270,
  roundIcon: 0x0101052c,
  isFeatureSplit: 0x0101055b,
  versionCodeMajor: 0x01010576,
  isSplitRequired: 0x01010591,
  requiredSplitTypes: 0x0101064e,
  splitTypes: 0x0101064f,
} as const

/** Res_value data types. */
export const TYPE = {
  REFERENCE: 0x01,
  STRING: 0x03,
  INT_DEC: 0x10,
  INT_HEX: 0x11,
  BOOLEAN: 0x12,
  COLOR_ARGB8: 0x1c,
  COLOR_RGB8: 0x1d,
  COLOR_ARGB4: 0x1e,
  COLOR_RGB4: 0x1f,
} as const

export interface XmlAttribute {
  /** Namespace URI; '' for none. */
  readonly ns: string
  readonly name: string
  /** The android.R.attr id from the resource map; 0 when it has none. */
  readonly resId: number
  /** A Res_value type from TYPE. */
  readonly type: number
  readonly data: number
  /** The text form: the string itself for strings, otherwise the raw value aapt kept, if any. */
  readonly raw: string | null
}

export interface XmlElement {
  readonly ns: string
  readonly name: string
  readonly depth: number
  readonly attrs: readonly XmlAttribute[]
}

/* ---------------------------------------------------------------- *
 * The string pool, shared with resources.arsc
 * ---------------------------------------------------------------- */

export interface StringPool {
  readonly size: number
  /** Decoded on first use: a resource table's pool can hold tens of thousands of strings. */
  readonly get: (index: number) => string | undefined
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const utf8 = new TextDecoder('utf-8')
const utf16 = new TextDecoder('utf-16le')

/** Reads the ResStringPool chunk that starts at `at`. */
export function stringPool(bytes: Uint8Array, at: number): StringPool {
  const v = view(bytes)
  const headerSize = v.getUint16(at + 2, true)
  const count = v.getUint32(at + 8, true)
  const isUtf8 = (v.getUint32(at + 16, true) & 0x100) !== 0
  const stringsStart = at + v.getUint32(at + 20, true)
  const cache = new Map<number, string>()

  function decode(index: number): string {
    let p = stringsStart + v.getUint32(at + headerSize + index * 4, true)
    if (isUtf8) {
      // The length in characters, then in bytes, each in one byte or two (high bit set).
      p += v.getUint8(p) & 0x80 ? 2 : 1
      let n = v.getUint8(p)
      if (n & 0x80) {
        n = ((n & 0x7f) << 8) | v.getUint8(p + 1)
        p += 2
      } else p += 1
      if (p + n > bytes.length) throw new RangeError('string past the pool')
      return utf8.decode(bytes.subarray(p, p + n))
    }
    let n = v.getUint16(p, true)
    if (n & 0x8000) {
      n = ((n & 0x7fff) << 16) | v.getUint16(p + 2, true)
      p += 4
    } else p += 2
    if (p + n * 2 > bytes.length) throw new RangeError('string past the pool')
    return utf16.decode(bytes.subarray(p, p + n * 2))
  }

  return {
    size: count,
    get(index) {
      if (index < 0 || index >= count) return undefined
      let s = cache.get(index)
      if (s === undefined) {
        s = decode(index)
        cache.set(index, s)
      }
      return s
    },
  }
}

/* ---------------------------------------------------------------- *
 * Binary XML
 * ---------------------------------------------------------------- */

const RES_XML = 0x0003
const RES_STRING_POOL = 0x0001
const RES_XML_RESOURCE_MAP = 0x0180
const RES_XML_START_ELEMENT = 0x0102
const RES_XML_END_ELEMENT = 0x0103
const NO_INDEX = 0xffffffff

/** Whether the bytes are compiled binary XML (a text or protobuf manifest is not). */
export function isBinaryXml(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && view(bytes).getUint16(0, true) === RES_XML
}

/**
 * The elements of a binary XML document, in document order. Throws AXML_NOT_BINARY for
 * anything that is not compiled XML, and AXML_CORRUPT for a damaged document.
 */
export function parseAxml(bytes: Uint8Array): XmlElement[] {
  if (!isBinaryXml(bytes)) throw new Error('AXML_NOT_BINARY')
  try {
    return walk(bytes)
  } catch (error) {
    if (error instanceof RangeError) throw new Error('AXML_CORRUPT', { cause: error })
    throw error
  }
}

function walk(bytes: Uint8Array): XmlElement[] {
  const v = view(bytes)
  let strings: StringPool = { size: 0, get: () => undefined }
  let resIds: number[] = []
  const elements: XmlElement[] = []
  let depth = 0
  const str = (i: number) => (i === NO_INDEX ? '' : (strings.get(i) ?? ''))

  for (let p = v.getUint16(2, true); p + 8 <= bytes.length;) {
    const type = v.getUint16(p, true)
    const headerSize = v.getUint16(p + 2, true)
    const size = v.getUint32(p + 4, true)
    if (size < 8 || p + size > bytes.length) throw new Error('AXML_CORRUPT')

    if (type === RES_STRING_POOL) strings = stringPool(bytes, p)
    else if (type === RES_XML_RESOURCE_MAP) {
      resIds = []
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resIds.push(v.getUint32(q, true))
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize
      const attrStart = v.getUint16(ext + 8, true)
      const attrSize = v.getUint16(ext + 10, true)
      const attrCount = v.getUint16(ext + 12, true)
      const attrs: XmlAttribute[] = []
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize
        const nameIndex = v.getUint32(a + 4, true)
        const rawIndex = v.getUint32(a + 8, true)
        const type = v.getUint8(a + 15)
        const data = v.getUint32(a + 16, true)
        attrs.push({
          ns: str(v.getUint32(a, true)),
          name: str(nameIndex),
          resId: resIds[nameIndex] ?? 0,
          type,
          data,
          raw: type === TYPE.STRING ? str(data) : rawIndex === NO_INDEX ? null : str(rawIndex),
        })
      }
      elements.push({
        ns: str(v.getUint32(ext, true)),
        name: str(v.getUint32(ext + 4, true)),
        depth,
        attrs,
      })
      depth++
    } else if (type === RES_XML_END_ELEMENT) depth--
    p += size
  }
  return elements
}

/* ---------------------------------------------------------------- *
 * Protobuf XML (an .aab's manifest)
 * ---------------------------------------------------------------- */

/** aapt2's XmlNode as the same elements parseAxml gives. Throws PROTOBUF_CORRUPT when damaged. */
export function parseProtoXml(bytes: Uint8Array): XmlElement[] {
  const elements: XmlElement[] = []
  const visit = (node: PbFields, depth: number) => {
    const el = pbMsg(node, 1)
    if (el.size === 0) return
    elements.push({
      ns: pbStr(el, 2),
      name: pbStr(el, 3),
      depth,
      attrs: pbMsgs(el, 4).map(protoAttribute),
    })
    for (const child of pbMsgs(el, 5)) visit(child, depth + 1)
  }
  visit(pbFields(bytes), 0)
  return elements
}

function protoAttribute(a: PbFields): XmlAttribute {
  const base = { ns: pbStr(a, 1), name: pbStr(a, 2), resId: pbNum(a, 5) }
  const value = pbStr(a, 3)
  const item = pbMsg(a, 6)
  if (item.has(1)) {
    return { ...base, type: TYPE.REFERENCE, data: pbNum(pbMsg(item, 1), 2), raw: value }
  }
  if (item.has(7)) {
    const prim = pbMsg(item, 7)
    if (prim.has(8)) return { ...base, type: TYPE.BOOLEAN, data: pbNum(prim, 8), raw: value }
    if (prim.has(6)) return { ...base, type: TYPE.INT_DEC, data: pbNum(prim, 6), raw: value }
    if (prim.has(7)) return { ...base, type: TYPE.INT_HEX, data: pbNum(prim, 7), raw: value }
  }
  return { ...base, type: TYPE.STRING, data: 0, raw: value }
}

/* ---------------------------------------------------------------- *
 * Reading attributes
 * ---------------------------------------------------------------- */

/** An attribute by android.R.attr id, or by name for the un-namespaced ones (package, split). */
export function attribute(
  el: XmlElement | undefined,
  key: number | string,
): XmlAttribute | undefined {
  if (!el) return undefined
  if (typeof key === 'number') {
    return (
      el.attrs.find((a) => a.resId === key) ??
      el.attrs.find((a) => a.ns === ANDROID_NS && a.name === nameOf(key))
    )
  }
  return el.attrs.find((a) => a.name === key && a.resId === 0 && a.ns === '')
}

const nameOf = (id: number) => Object.entries(ATTR).find(([, v]) => v === id)?.[0]

export function attrText(a: XmlAttribute | undefined): string | null {
  if (!a) return null
  if (a.type === TYPE.STRING) return a.raw
  if (a.type === TYPE.INT_DEC || a.type === TYPE.INT_HEX) return String(a.data | 0)
  return a.raw
}

export function attrInt(a: XmlAttribute | undefined): number | null {
  if (!a) return null
  if (a.type === TYPE.INT_DEC || a.type === TYPE.INT_HEX) return a.data | 0
  if (a.type === TYPE.STRING && a.raw !== null && /^-?\d+$/.test(a.raw.trim())) {
    return Number(a.raw.trim())
  }
  return null
}

export function attrBool(a: XmlAttribute | undefined): boolean | null {
  if (!a) return null
  if (a.type === TYPE.BOOLEAN || a.type === TYPE.INT_DEC) return a.data !== 0
  if (a.type === TYPE.STRING && (a.raw === 'true' || a.raw === 'false')) return a.raw === 'true'
  return null
}

/** The resource id an attribute points at (`@string/app_name`), or null for a literal. */
export function attrRef(a: XmlAttribute | undefined): number | null {
  if (!a || a.type !== TYPE.REFERENCE || a.data === 0) return null
  return a.data
}

/* ---------------------------------------------------------------- *
 * The manifest summary
 * ---------------------------------------------------------------- */

export type ModuleDelivery = '' | 'install-time' | 'on-demand' | 'fast-follow'

export interface ManifestInfo {
  readonly packageName: string
  /** The long version code: versionCodeMajor in the high 32 bits, as Android compares them. */
  readonly versionCode: number
  readonly versionName: string
  /** '' for a base APK; 'config.arm64_v8a', 'maps' or 'maps.config.en' for a split. */
  readonly split: string
  /** The feature module a config split configures; '' when it configures the base. */
  readonly configForSplit: string
  readonly isFeatureSplit: boolean
  readonly minSdk: number
  /** A preview codename in place of a number (minSdkVersion="Baklava"); '' when released. */
  readonly minSdkCodename: string
  readonly targetSdk: number
  readonly testOnly: boolean
  readonly debuggable: boolean
  readonly hasCode: boolean
  readonly isSplitRequired: boolean
  readonly requiredSplitTypes: readonly string[]
  readonly splitTypes: readonly string[]
  /** `<dist:module>` delivery, which bundletool keeps in feature and asset-pack splits. */
  readonly delivery: ModuleDelivery
  /** A Play Asset Delivery pack rather than code. */
  readonly assetPack: boolean
  /** The application label when it is literal text. */
  readonly label: string | null
  /** The application label's string resource, when it is one. */
  readonly labelId: number | null
  readonly iconId: number | null
  readonly roundIconId: number | null
}

/** An SDK level attribute: a number, or a preview's codename, which stands for 10000. */
const sdkLevel = (a: XmlAttribute | undefined) => attrInt(a) ?? (attrText(a) ? 10000 : null)

const list = (a: XmlAttribute | undefined) =>
  (attrText(a) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** The installer's view of a manifest. Throws AXML_NO_MANIFEST when there is no <manifest>. */
export function manifestFromXml(elements: readonly XmlElement[]): ManifestInfo {
  const manifest = elements.find((e) => e.name === 'manifest' && e.depth === 0)
  if (!manifest) throw new Error('AXML_NO_MANIFEST')
  const top = (name: string) => elements.find((e) => e.name === name && e.depth === 1 && !e.ns)
  const sdk = top('uses-sdk')
  const app = top('application')
  const module = elements.find((e) => e.name === 'module' && e.ns === DIST_NS)

  const minAttr = attribute(sdk, ATTR.minSdkVersion)
  const min = attrInt(minAttr)
  const codename = min === null ? (attrText(minAttr) ?? '') : ''
  const minSdk = min ?? (codename ? 10000 : 1)
  const versionCode = attrInt(attribute(manifest, ATTR.versionCode)) ?? 0
  const major = attrInt(attribute(manifest, ATTR.versionCodeMajor)) ?? 0

  let delivery: ModuleDelivery = ''
  if (module) {
    const kinds = elements.filter((e) => e.ns === DIST_NS).map((e) => e.name)
    delivery = kinds.includes('on-demand')
      ? 'on-demand'
      : kinds.includes('fast-follow')
        ? 'fast-follow'
        : 'install-time'
    // Before <dist:delivery>, on-demand was an attribute of the module.
    const legacy = module.attrs.find((a) => a.ns === DIST_NS && a.name === 'onDemand')
    if (!kinds.includes('delivery') && attrBool(legacy)) delivery = 'on-demand'
  }
  const labelAttr = attribute(app, ATTR.label)

  return {
    packageName: attrText(attribute(manifest, 'package')) ?? '',
    versionCode: major * 2 ** 32 + (versionCode >>> 0),
    versionName: attrText(attribute(manifest, ATTR.versionName)) ?? '',
    split: attrText(attribute(manifest, 'split')) ?? '',
    configForSplit: attrText(attribute(manifest, 'configForSplit')) ?? '',
    isFeatureSplit: attrBool(attribute(manifest, ATTR.isFeatureSplit)) ?? false,
    minSdk,
    minSdkCodename: codename,
    targetSdk: sdkLevel(attribute(sdk, ATTR.targetSdkVersion)) ?? minSdk,
    testOnly: attrBool(attribute(app, ATTR.testOnly)) ?? false,
    debuggable: attrBool(attribute(app, ATTR.debuggable)) ?? false,
    hasCode: attrBool(attribute(app, ATTR.hasCode)) ?? true,
    isSplitRequired: attrBool(attribute(manifest, ATTR.isSplitRequired)) ?? false,
    requiredSplitTypes: list(attribute(manifest, ATTR.requiredSplitTypes)),
    splitTypes: list(attribute(manifest, ATTR.splitTypes)),
    delivery,
    assetPack: module?.attrs.some((a) => a.name === 'type' && a.raw === 'asset-pack') ?? false,
    label: labelAttr && labelAttr.type === TYPE.STRING ? labelAttr.raw : null,
    labelId: attrRef(labelAttr),
    iconId: attrRef(attribute(app, ATTR.icon)),
    roundIconId: attrRef(attribute(app, ATTR.roundIcon)),
  }
}

/** The summary of an APK's binary AndroidManifest.xml. */
export function manifestInfo(bytes: Uint8Array): ManifestInfo {
  return manifestFromXml(parseAxml(bytes))
}
