import { deflateRawSync } from 'node:zlib'

/*
  Test-only builders: ZIP archives and Android binary-XML manifests made in memory, so each
  test states the archive it needs (two apps, a split without its base, an encrypted entry, a
  ZIP64 directory) instead of committing a file per case. The readers are also checked against
  real files that aapt2 and bundletool wrote (see the fixtures beside this file), so these
  builders cannot hide a misreading of the formats.
*/

const utf8 = new TextEncoder()
const bytesOf = (data: Uint8Array | string) => (typeof data === 'string' ? utf8.encode(data) : data)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A growable little-endian byte writer. */
class Out {
  private buf = new Uint8Array(1024)
  length = 0

  private room(n: number) {
    if (this.length + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n))
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
  u8(n: number) {
    this.room(1)
    this.buf[this.length++] = n & 0xff
    return this
  }
  u16(n: number) {
    return this.u8(n).u8(n >>> 8)
  }
  u32(n: number) {
    return this.u16(n & 0xffff).u16(n >>> 16)
  }
  u64(n: number) {
    return this.u32(n % 2 ** 32).u32(Math.floor(n / 2 ** 32))
  }
  bytes(b: Uint8Array) {
    this.room(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
    return this
  }
  /** Overwrites a u32 already written, for sizes known only at the end of a chunk. */
  patch32(at: number, n: number) {
    this.buf[at] = n & 0xff
    this.buf[at + 1] = (n >>> 8) & 0xff
    this.buf[at + 2] = (n >>> 16) & 0xff
    this.buf[at + 3] = (n >>> 24) & 0xff
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length)
  }
}

export interface SynthEntry {
  name: string
  data: Uint8Array | string
  /** 0 = STORED (the default), 8 = DEFLATE. Any other value is written as given. */
  method?: number
  /** General-purpose flags, e.g. 1 to mark the entry encrypted. */
  flags?: number
  /** Extra bytes in the LOCAL header only, the way zipalign pads. */
  localExtra?: number
  /** Declare this uncompressed size instead of the real one. */
  declaredSize?: number
  /** Leave the sizes out of the local header and append a data descriptor. */
  descriptor?: boolean
}

export interface SynthZipOptions {
  /** Write every size and offset through ZIP64 records, as a >4 GB archive must. */
  zip64?: boolean
  comment?: string
}

export function makeZip(entries: readonly SynthEntry[], options: SynthZipOptions = {}) {
  const out = new Out()
  const central = new Out()
  for (const e of entries) {
    const raw = bytesOf(e.data)
    const method = e.method ?? 0
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
    const name = utf8.encode(e.name)
    const crc = crc32(raw)
    const size = e.declaredSize ?? raw.length
    const flags = (e.flags ?? 0) | (e.descriptor ? 0x0008 : 0) | 0x0800
    const offset = out.length
    const big = options.zip64 === true

    out.u32(0x04034b50).u16(45).u16(flags).u16(method).u16(0).u16(0)
    if (e.descriptor) out.u32(0).u32(0).u32(0)
    else if (big) out.u32(crc).u32(0xffffffff).u32(0xffffffff)
    else out.u32(crc).u32(data.length).u32(size)
    const localExtra = (big && !e.descriptor ? 20 : 0) + (e.localExtra ?? 0)
    out.u16(name.length).u16(localExtra).bytes(name)
    if (big && !e.descriptor) out.u16(0x0001).u16(16).u64(size).u64(data.length)
    for (let i = 0; i < (e.localExtra ?? 0); i++) out.u8(0)
    out.bytes(data)
    if (e.descriptor) out.u32(0x08074b50).u32(crc).u32(data.length).u32(size)

    central.u32(0x02014b50).u16(0x031e).u16(45).u16(flags).u16(method).u16(0).u16(0)
    if (big) central.u32(crc).u32(0xffffffff).u32(0xffffffff)
    else central.u32(crc).u32(data.length).u32(size)
    central
      .u16(name.length)
      .u16(big ? 28 : 0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
    central.u32(big ? 0xffffffff : offset).bytes(name)
    if (big) central.u16(0x0001).u16(24).u64(size).u64(data.length).u64(offset)
  }

  const cdOffset = out.length
  const cd = central.done()
  out.bytes(cd)
  const comment = utf8.encode(options.comment ?? '')
  if (options.zip64) {
    const eocd64 = out.length
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
    out.u64(entries.length).u64(entries.length).u64(cd.length).u64(cdOffset)
    out.u32(0x07064b50).u32(0).u64(eocd64).u32(1)
    out.u32(0x06054b50).u16(0).u16(0).u16(0xffff).u16(0xffff)
    out.u32(0xffffffff).u32(0xffffffff)
  } else {
    out.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length)
    out.u32(cd.length).u32(cdOffset)
  }
  out.u16(comment.length).bytes(comment)
  return out.done()
}

/*
  Android binary XML. The layout aapt2 writes: a string pool whose first strings are the
  attribute names that have android.R.attr ids (the resource map lists those ids in the same
  order), then namespace and element chunks.
*/

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android'
export const DIST_NS = 'http://schemas.android.com/apk/distribution'

/** android.R.attr ids for the attributes the tests use. */
const ATTR_IDS: Readonly<Record<string, number>> = {
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
  requiredSplitTypes: 0x0101064e,
  splitTypes: 0x0101064f,
}

export type XmlValue = string | number | boolean | { ref: number } | { color: number }

export interface XmlNode {
  name: string
  /** `android:x` and `dist:x` keys are namespaced; a bare key is not (e.g. `package`). */
  attrs?: Readonly<Record<string, XmlValue>>
  children?: readonly XmlNode[]
  /** The element's own namespace prefix, e.g. 'dist' for <dist:module>. */
  prefix?: 'dist'
}

const NAMESPACES = { android: ANDROID_NS, dist: DIST_NS } as const

/** A string pool in UTF-8 (aapt2's choice) or UTF-16 (what the original aapt wrote). */
function stringPool(strings: readonly string[], utf16: boolean): Uint8Array {
  const data = new Out()
  const offsets: number[] = []
  for (const s of strings) {
    offsets.push(data.length)
    if (utf16) {
      data.u16(s.length)
      for (let i = 0; i < s.length; i++) data.u16(s.charCodeAt(i))
      data.u16(0)
      continue
    }
    const b = utf8.encode(s)
    const chars = [...s].length
    if (chars > 0x7f) data.u8(0x80 | (chars >> 8)).u8(chars & 0xff)
    else data.u8(chars)
    if (b.length > 0x7f) data.u8(0x80 | (b.length >> 8)).u8(b.length & 0xff)
    else data.u8(b.length)
    data.bytes(b).u8(0)
  }
  while (data.length % 4) data.u8(0)
  const header = 28 + offsets.length * 4
  const out = new Out()
  out
    .u16(0x0001)
    .u16(28)
    .u32(header + data.length)
  out
    .u32(strings.length)
    .u32(0)
    .u32(utf16 ? 0 : 0x100)
    .u32(header)
    .u32(0)
  for (const o of offsets) out.u32(o)
  return out.bytes(data.done()).done()
}

/** One element tree as binary XML, the way aapt2 encodes an AndroidManifest.xml. */
export function axml(root: XmlNode, options: { utf16?: boolean } = {}): Uint8Array<ArrayBuffer> {
  // Attribute names with resource ids first (the resource map covers exactly those), then the rest.
  const withIds: string[] = []
  const others: string[] = []
  const add = (s: string, list: string[]) => {
    if (!withIds.includes(s) && !others.includes(s) && !list.includes(s)) list.push(s)
  }
  const walk = (node: XmlNode) => {
    for (const key of Object.keys(node.attrs ?? {})) {
      const [prefix, local] = key.includes(':') ? key.split(':') : ['', key]
      if (prefix === 'android' && local && ATTR_IDS[local] !== undefined) add(local, withIds)
    }
  }
  const visit = (node: XmlNode, fn: (n: XmlNode) => void) => {
    fn(node)
    for (const c of node.children ?? []) visit(c, fn)
  }
  visit(root, walk)
  visit(root, (node) => {
    add(node.name, others)
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      const local = key.includes(':') ? (key.split(':')[1] ?? key) : key
      add(local, others)
      if (typeof value === 'string') add(value, others)
    }
  })
  for (const [prefix, uri] of Object.entries(NAMESPACES)) {
    add(prefix, others)
    add(uri, others)
  }
  const strings = [...withIds, ...others]
  const idx = (s: string) => strings.indexOf(s)

  const body = new Out()
  body.bytes(stringPool(strings, options.utf16 === true))
  body
    .u16(0x0180)
    .u16(8)
    .u32(8 + withIds.length * 4)
  for (const s of withIds) body.u32(ATTR_IDS[s] ?? 0)
  for (const [prefix, uri] of Object.entries(NAMESPACES)) {
    body.u16(0x0100).u16(16).u32(24).u32(1).u32(0xffffffff).u32(idx(prefix)).u32(idx(uri))
  }
  const element = (node: XmlNode) => {
    const attrs = Object.entries(node.attrs ?? {})
    const ns = node.prefix ? idx(NAMESPACES[node.prefix]) : 0xffffffff
    body
      .u16(0x0102)
      .u16(16)
      .u32(36 + 20 * attrs.length)
      .u32(1)
      .u32(0xffffffff)
    body.u32(ns).u32(idx(node.name)).u16(20).u16(20).u16(attrs.length).u16(0).u16(0).u16(0)
    for (const [key, value] of attrs) {
      const [prefix, local] = key.includes(':') ? key.split(':') : ['', key]
      const attrNs =
        prefix === 'android' ? idx(ANDROID_NS) : prefix === 'dist' ? idx(DIST_NS) : 0xffffffff
      body.u32(attrNs).u32(idx(local ?? key))
      if (typeof value === 'string') body.u32(idx(value)).u16(8).u8(0).u8(0x03).u32(idx(value))
      else if (typeof value === 'number') body.u32(0xffffffff).u16(8).u8(0).u8(0x10).u32(value)
      else if (typeof value === 'boolean') {
        body
          .u32(0xffffffff)
          .u16(8)
          .u8(0)
          .u8(0x12)
          .u32(value ? 0xffffffff : 0)
      } else if ('ref' in value) body.u32(0xffffffff).u16(8).u8(0).u8(0x01).u32(value.ref)
      else body.u32(0xffffffff).u16(8).u8(0).u8(0x1c).u32(value.color)
    }
    for (const child of node.children ?? []) element(child)
    body.u16(0x0103).u16(16).u32(24).u32(1).u32(0xffffffff).u32(ns).u32(idx(node.name))
  }
  element(root)
  for (const [prefix, uri] of Object.entries(NAMESPACES)) {
    body.u16(0x0101).u16(16).u32(24).u32(1).u32(0xffffffff).u32(idx(prefix)).u32(idx(uri))
  }
  const b = body.done()
  return new Out()
    .u16(0x0003)
    .u16(8)
    .u32(8 + b.length)
    .bytes(b)
    .done()
}

export interface ManifestSpec {
  package: string
  versionCode?: number
  versionName?: string
  /** Split name; absent for a base APK. */
  split?: string
  configForSplit?: string
  isFeatureSplit?: boolean
  minSdk?: number
  targetSdk?: number
  testOnly?: boolean
  debuggable?: boolean
  label?: string | { ref: number }
  icon?: { ref: number }
  /** `<dist:module>` delivery, as bundletool writes it into feature and asset-pack splits. */
  delivery?: 'install-time' | 'on-demand' | 'fast-follow'
  requiredSplitTypes?: string
  splitTypes?: string
}

export function manifest(spec: ManifestSpec): Uint8Array<ArrayBuffer> {
  const attrs: Record<string, XmlValue> = { package: spec.package }
  if (spec.versionCode !== undefined) attrs['android:versionCode'] = spec.versionCode
  if (spec.versionName !== undefined) attrs['android:versionName'] = spec.versionName
  if (spec.split !== undefined) attrs.split = spec.split
  if (spec.configForSplit !== undefined) attrs.configForSplit = spec.configForSplit
  if (spec.isFeatureSplit) attrs['android:isFeatureSplit'] = true
  if (spec.requiredSplitTypes) attrs['android:requiredSplitTypes'] = spec.requiredSplitTypes
  if (spec.splitTypes) attrs['android:splitTypes'] = spec.splitTypes
  const children: XmlNode[] = []
  if (spec.delivery) {
    children.push({
      name: 'module',
      prefix: 'dist',
      children: [
        { name: 'delivery', prefix: 'dist', children: [{ name: spec.delivery, prefix: 'dist' }] },
      ],
    })
  }
  if (spec.minSdk !== undefined || spec.targetSdk !== undefined) {
    const sdk: Record<string, XmlValue> = {}
    if (spec.minSdk !== undefined) sdk['android:minSdkVersion'] = spec.minSdk
    if (spec.targetSdk !== undefined) sdk['android:targetSdkVersion'] = spec.targetSdk
    children.push({ name: 'uses-sdk', attrs: sdk })
  }
  const app: Record<string, XmlValue> = {}
  if (spec.label !== undefined) app['android:label'] = spec.label
  if (spec.icon !== undefined) app['android:icon'] = spec.icon
  if (spec.testOnly !== undefined) app['android:testOnly'] = spec.testOnly
  if (spec.debuggable !== undefined) app['android:debuggable'] = spec.debuggable
  children.push({ name: 'application', attrs: app })
  return axml({ name: 'manifest', attrs, children })
}

/** An APK: its manifest first (as every Android build tool writes it), then native libraries. */
export function apk(
  spec: ManifestSpec,
  options: { abis?: readonly string[]; extra?: readonly SynthEntry[]; method?: number } = {},
): Uint8Array<ArrayBuffer> {
  const entries: SynthEntry[] = [
    { name: 'AndroidManifest.xml', data: manifest(spec), method: options.method ?? 8 },
  ]
  for (const abi of options.abis ?? []) {
    entries.push({ name: `lib/${abi}/libapp.so`, data: `native code for ${abi}` })
  }
  entries.push(...(options.extra ?? []))
  return makeZip(entries)
}

export const fileOf = (bytes: Uint8Array<ArrayBuffer>, name: string) => new File([bytes], name)

/*
  Protobuf, for tables of contents bundletool would not write (a system-image set, say). Numbers
  are varints, strings and bytes are length-delimited, and an array is a nested message.
*/

export type PbValue = number | string | Uint8Array | PbMessage
export type PbMessage = readonly (readonly [number, PbValue])[]

export function pb(message: PbMessage): Uint8Array<ArrayBuffer> {
  const out = new Out()
  const varint = (n: number) => {
    let v = n
    while (v >= 0x80) {
      out.u8((v % 0x80) | 0x80)
      v = Math.floor(v / 0x80)
    }
    out.u8(v)
  }
  for (const [field, value] of message) {
    if (typeof value === 'number') {
      varint(field * 8)
      varint(value)
      continue
    }
    const bytes =
      typeof value === 'string'
        ? utf8.encode(value)
        : value instanceof Uint8Array
          ? value
          : pb(value)
    varint(field * 8 + 2)
    varint(bytes.length)
    out.bytes(bytes)
  }
  return out.done()
}

/** The smallest valid PNG: one transparent pixel. */
export const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)
