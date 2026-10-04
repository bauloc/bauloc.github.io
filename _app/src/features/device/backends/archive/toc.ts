/*
  bundletool's table of contents: the toc.pb at the root of every .apks (BuildApksResult in
  bundletool's commands.proto and targeting.proto, 1.18.3). A protobuf reader of a few dozen lines
  stands in for a protobuf library, and only the fields split selection needs are mapped, by their
  field numbers, which protobuf never reuses.

  Ported from the bundle-install prototype (proto/toc.mjs), extended with the targeting
  dimensions bundletool's extract-apks evaluates beyond SDK, ABI, density and language: texture
  compression, device tier, country set and device group, the SDK-runtime variants, and the
  conditions on conditional modules.
*/

/** A message's fields by number, in order: varints as numbers, length-delimited as bytes. */
export type PbFields = ReadonlyMap<number, readonly (number | Uint8Array)[]>

/** Decodes one protobuf message (wire format only; the schema is the caller's). */
export function pbFields(buf: Uint8Array): PbFields {
  const out = new Map<number, (number | Uint8Array)[]>()
  let p = 0
  const byte = () => {
    const b = buf[p++]
    if (b === undefined) throw new Error('PROTOBUF_CORRUPT')
    return b
  }
  const varint = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const b = byte()
      // Multiplying, not shifting: bit operations would truncate to 32 bits.
      value += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return value
      if (shift > 63) throw new Error('PROTOBUF_CORRUPT')
    }
  }
  const take = (n: number) => {
    if (p + n > buf.length) throw new Error('PROTOBUF_CORRUPT')
    const v = buf.subarray(p, p + n)
    p += n
    return v
  }
  while (p < buf.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    let value: number | Uint8Array
    if (wire === 0) value = varint()
    else if (wire === 2) value = take(varint())
    else if (wire === 1) value = take(8)
    else if (wire === 5) value = take(4)
    else throw new Error('PROTOBUF_CORRUPT')
    let list = out.get(field)
    if (!list) out.set(field, (list = []))
    list.push(value)
  }
  return out
}

const utf8 = new TextDecoder()
const all = (f: PbFields, n: number) => f.get(n) ?? []
const blobs = (f: PbFields, n: number) =>
  all(f, n).filter((v): v is Uint8Array => typeof v !== 'number')
export const pbStr = (f: PbFields, n: number) => {
  const v = blobs(f, n)[0]
  return v ? utf8.decode(v) : ''
}
export const pbStrs = (f: PbFields, n: number) => blobs(f, n).map((v) => utf8.decode(v))
export const pbNum = (f: PbFields, n: number) => {
  const v = all(f, n).find((x): x is number => typeof x === 'number')
  return v ?? 0
}
export const pbMsg = (f: PbFields, n: number): PbFields => {
  const v = blobs(f, n)[0]
  return v ? pbFields(v) : new Map()
}
export const pbMsgs = (f: PbFields, n: number) => blobs(f, n).map(pbFields)
/** Whether a message field is set to something other than its default (empty) value. */
const setAndNotEmpty = (f: PbFields, n: number) => blobs(f, n).some((v) => v.length > 0)

/** A targeting dimension: what this APK (or variant) is for, and what its siblings are for. */
export interface Targeting<T> {
  readonly value: readonly T[]
  readonly alternatives: readonly T[]
}

/** bundletool's Abi.AbiAlias, by number. */
export const ABI_ALIAS: Readonly<Record<number, string>> = {
  1: 'armeabi',
  2: 'armeabi-v7a',
  3: 'arm64-v8a',
  4: 'x86',
  5: 'x86_64',
  6: 'mips',
  7: 'mips64',
  8: 'riscv64',
}

/** ScreenDensity.DensityAlias → dpi, as bundletool's ResourcesUtils maps them (NODPI = 0xffff). */
const DENSITY_ALIAS: Readonly<Record<number, number>> = {
  0: 0,
  1: 0xffff,
  2: 120,
  3: 160,
  4: 213,
  5: 240,
  6: 320,
  7: 480,
  8: 640,
}

/** TextureCompressionFormat.TextureCompressionFormatAlias → the suffix bundletool uses. */
const TEXTURE_ALIAS: Readonly<Record<number, string>> = {
  1: 'etc1',
  2: 'paletted',
  3: '3dc',
  4: 'atc',
  5: 'latc',
  6: 'dxt1',
  7: 's3tc',
  8: 'pvrtc',
  9: 'astc',
  10: 'etc2',
}

export type Delivery = 'unknown' | 'install-time' | 'on-demand' | 'fast-follow'
const DELIVERY: readonly Delivery[] = ['unknown', 'install-time', 'on-demand', 'fast-follow']

export type ApkKind =
  'split' | 'standalone' | 'instant' | 'system' | 'asset-slice' | 'apex' | 'archived' | 'unknown'

export interface ApkTargeting {
  readonly sdk: Targeting<number>
  readonly abi: Targeting<string>
  readonly density: Targeting<number>
  readonly language: Targeting<string>
  readonly textureFormat: Targeting<string>
  readonly deviceTier: Targeting<number>
  readonly countrySet: Targeting<string>
  readonly deviceGroup: Targeting<string>
  /** Multi-ABI targeting, which only APEX and system images use. */
  readonly multiAbi: boolean
}

export interface VariantTargeting {
  readonly sdk: Targeting<number>
  readonly abi: Targeting<string>
  readonly density: Targeting<number>
  readonly textureFormat: Targeting<string>
  readonly multiAbi: boolean
  /** Built for phones that run SDKs in the SDK Runtime (Android 14+, privacy sandbox). */
  readonly requiresSdkRuntime: boolean
}

/** The conditions of a conditional module: every one must hold. */
export interface ModuleTargeting {
  readonly sdk: Targeting<number>
  readonly deviceFeatures: readonly { readonly name: string; readonly version: number }[]
  /** Country conditions, which nothing on a desk can evaluate (bundletool ignores them too). */
  readonly userCountries: boolean
  readonly deviceGroups: readonly string[]
}

export interface TocApk {
  /** Path inside the .apks, e.g. `splits/base-arm64_v8a.apk`. */
  readonly path: string
  readonly kind: ApkKind
  readonly splitId: string
  readonly isMasterSplit: boolean
  readonly targeting: ApkTargeting
}

export interface TocModule {
  readonly name: string
  readonly delivery: Delivery
  /** Pre-0.10.2 bundletool's way of saying on-demand. */
  readonly onDemandDeprecated: boolean
  readonly dependencies: readonly string[]
  /** Null for an unconditional module. */
  readonly targeting: ModuleTargeting | null
  readonly apks: readonly TocApk[]
}

export interface TocVariant {
  readonly number: number
  readonly targeting: VariantTargeting
  readonly modules: readonly TocModule[]
}

/** A Play Asset Delivery pack: its slices are installed as splits next to the app's own. */
export interface TocAssetPack {
  readonly name: string
  readonly delivery: Delivery
  readonly conditional: boolean
  readonly apks: readonly TocApk[]
}

export interface Toc {
  readonly packageName: string
  /** The bundletool that wrote it, e.g. "1.18.3"; it decides how module delivery is read. */
  readonly bundletoolVersion: string
  readonly variants: readonly TocVariant[]
  readonly assetPacks: readonly TocAssetPack[]
  /** Built with --local-testing: on-demand parts are meant to be pushed, not installed. */
  readonly localTesting: { readonly enabled: boolean; readonly path: string }
  /** The bundle's default suffix per dimension, which extract-apks assumes for the device. */
  readonly defaults: {
    readonly textureFormat?: string
    readonly deviceTier?: string
    readonly countrySet?: string
    readonly deviceGroup?: string
  }
}

function targeting<T>(f: PbFields, read: (item: PbFields) => T): Targeting<T> {
  return { value: pbMsgs(f, 1).map(read), alternatives: pbMsgs(f, 2).map(read) }
}
const abiName = (a: PbFields) => ABI_ALIAS[pbNum(a, 1)] ?? ''
const sdkMin = (s: PbFields) => pbNum(pbMsg(s, 1), 1)
const textureName = (t: PbFields) => TEXTURE_ALIAS[pbNum(t, 1)] ?? ''
function densityDpi(d: PbFields): number {
  if (d.has(1)) return DENSITY_ALIAS[pbNum(d, 1)] ?? 0
  return pbNum(d, 2)
}
const strings = (f: PbFields): Targeting<string> => ({
  value: pbStrs(f, 1),
  alternatives: pbStrs(f, 2),
})

function apkTargeting(t: PbFields): ApkTargeting {
  const tier = pbMsg(t, 9)
  return {
    abi: targeting(pbMsg(t, 1), abiName),
    language: strings(pbMsg(t, 3)),
    density: targeting(pbMsg(t, 4), densityDpi),
    sdk: targeting(pbMsg(t, 5), sdkMin),
    textureFormat: targeting(pbMsg(t, 6), textureName),
    multiAbi: setAndNotEmpty(t, 7),
    // Int32Value wrappers, in fields 3 and 4 (1 and 2 are reserved).
    deviceTier: {
      value: pbMsgs(tier, 3).map((v) => pbNum(v, 1)),
      alternatives: pbMsgs(tier, 4).map((v) => pbNum(v, 1)),
    },
    countrySet: strings(pbMsg(t, 10)),
    deviceGroup: strings(pbMsg(t, 11)),
  }
}

function variantTargeting(t: PbFields): VariantTargeting {
  return {
    sdk: targeting(pbMsg(t, 1), sdkMin),
    abi: targeting(pbMsg(t, 2), abiName),
    density: targeting(pbMsg(t, 3), densityDpi),
    multiAbi: setAndNotEmpty(t, 4),
    textureFormat: targeting(pbMsg(t, 5), textureName),
    requiresSdkRuntime: pbNum(pbMsg(t, 6), 1) === 1,
  }
}

function moduleTargeting(t: PbFields): ModuleTargeting | null {
  if (t.size === 0) return null
  return {
    sdk: targeting(pbMsg(t, 1), sdkMin),
    deviceFeatures: pbMsgs(t, 2).map((f) => {
      const feature = pbMsg(f, 1)
      return { name: pbStr(feature, 1), version: pbNum(feature, 2) }
    }),
    userCountries: setAndNotEmpty(t, 3),
    deviceGroups: pbStrs(pbMsg(t, 5), 1),
  }
}

const KIND_BY_FIELD: readonly [number, ApkKind][] = [
  [3, 'split'],
  [4, 'standalone'],
  [5, 'instant'],
  [6, 'system'],
  [7, 'asset-slice'],
  [8, 'apex'],
  [9, 'archived'],
]

function apkDescription(a: PbFields): TocApk {
  const kind = KIND_BY_FIELD.find(([n]) => a.has(n))?.[1] ?? 'unknown'
  const meta = pbMsg(
    a,
    kind === 'standalone' ? 4 : kind === 'instant' ? 5 : kind === 'asset-slice' ? 7 : 3,
  )
  return {
    path: pbStr(a, 2),
    kind,
    // StandaloneApkMetadata keeps its split id in field 3, the others in field 1.
    splitId: kind === 'standalone' ? pbStr(meta, 3) : pbStr(meta, 1),
    isMasterSplit: kind !== 'standalone' && pbNum(meta, 2) === 1,
    targeting: apkTargeting(pbMsg(a, 1)),
  }
}

/** SplitDimension.Value numbers of the defaults extract-apks applies. */
const DIMENSION = { textureFormat: 4, deviceTier: 6, countrySet: 7, deviceGroup: 9 } as const

/** Reads toc.pb. Throws PROTOBUF_CORRUPT on bytes that are not a protobuf message. */
export function parseToc(bytes: Uint8Array): Toc {
  const r = pbFields(bytes)
  const local = pbMsg(r, 5)
  const defaults: Record<string, string> = {}
  for (const d of pbMsgs(r, 7)) {
    const key = Object.entries(DIMENSION).find(([, n]) => n === pbNum(d, 1))?.[0]
    if (key) defaults[key] = pbStr(d, 2)
  }
  return {
    packageName: pbStr(r, 4),
    bundletoolVersion: pbStr(pbMsg(r, 2), 2),
    localTesting: { enabled: pbNum(local, 1) === 1, path: pbStr(local, 2) },
    defaults,
    variants: pbMsgs(r, 1).map((v) => ({
      number: pbNum(v, 3),
      targeting: variantTargeting(pbMsg(v, 1)),
      modules: pbMsgs(v, 2).map((set) => {
        const m = pbMsg(set, 1)
        return {
          name: pbStr(m, 1),
          delivery: DELIVERY[pbNum(m, 6)] ?? 'unknown',
          onDemandDeprecated: pbNum(m, 2) === 1,
          dependencies: pbStrs(m, 4),
          targeting: moduleTargeting(pbMsg(m, 5)),
          apks: pbMsgs(set, 2).map(apkDescription),
        }
      }),
    })),
    assetPacks: pbMsgs(r, 3).map((set) => {
      const m = pbMsg(set, 1)
      return {
        name: pbStr(m, 1),
        delivery: DELIVERY[pbNum(m, 4)] ?? 'unknown',
        conditional: setAndNotEmpty(m, 6),
        apks: pbMsgs(set, 2).map(apkDescription),
      }
    }),
  }
}
