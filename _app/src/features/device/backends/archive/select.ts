import type {
  ApkTargeting,
  Delivery,
  ModuleTargeting,
  Targeting,
  Toc,
  TocApk,
  TocVariant,
} from './toc'

/*
  Which APKs a phone gets, two ways.

  1. From an .apks: a port of what `bundletool extract-apks --device-spec` picks (bundletool
     1.18.3's ApkMatcher, VariantMatcher, ModuleMatcher and the dimension matchers, read from its
     bytecode), down to the defaults extract-apks fills into a device spec. select.test.ts holds
     it to bundletool's own answers on the probe APK sets.

  2. From split names, where there is no toc.pb (.xapk, .apkm, a folder of split APKs): the
     same rules applied to the `config.<abi|density|language>` names bundletool gives splits.

  A dimension the device spec says nothing about counts as a match for a variant or for a
  module's conditions, but not for an APK, as in bundletool: a spec without GL extensions gets
  no texture-format split at all (bar ETC2 when the OpenGL ES version implies it), and the
  caller is told. The device-spec builder should collect them.
*/

/** bundletool's DeviceSpec JSON (devices.proto), as `get-device-spec` would write it. */
export interface DeviceSpec {
  /** Most preferred first, e.g. ["arm64-v8a"] on a Pixel 9. */
  readonly supportedAbis: readonly string[]
  /** BCP-47 tags, e.g. ["en-US", "vi-VN"]. */
  readonly supportedLocales: readonly string[]
  /** dpi */
  readonly screenDensity: number
  readonly sdkVersion: number
  /** ro.build.version.codename, only on preview builds. */
  readonly codename?: string
  /** `pm list features`, including the `reqGlEsVersion=0x30002` line. */
  readonly deviceFeatures?: readonly string[]
  readonly glExtensions?: readonly string[]
  readonly deviceTier?: number
  readonly deviceGroups?: readonly string[]
  readonly countrySet?: string
  readonly sdkRuntime?: { readonly supported: boolean }
  readonly ramBytes?: number
  readonly buildBrand?: string
  readonly buildDevice?: string
  readonly socManufacturer?: string
  readonly socModel?: string
}

/* ---------------------------------------------------------------- *
 * Dimension rules shared by both ways
 * ---------------------------------------------------------------- */

/** Resource folders (so split names and toc languages) keep Java's legacy language codes. */
const LEGACY_LANGUAGE: Readonly<Record<string, string>> = { he: 'iw', id: 'in', yi: 'ji' }

/** 'he-IL' → 'iw', 'pt_BR' → 'pt': the language as bundletool compares it. */
export function languageOf(locale: string): string {
  const language = (locale.split(/[-_]/)[0] ?? '').toLowerCase()
  return LEGACY_LANGUAGE[language] ?? language
}

/** Screen density by bucket name, as split names spell them. */
export const DENSITY_BY_NAME: Readonly<Record<string, number>> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640,
}

/** 480 → 'xxhdpi'; a density with no bucket name reads as '420dpi'. */
export function densityName(dpi: number): string {
  const name = Object.entries(DENSITY_BY_NAME).find(([, d]) => d === dpi)?.[0]
  return name ?? `${String(dpi)}dpi`
}

const DENSITY_ANY = 0xfffe
const DENSITY_NONE = 0xffff

/**
 * Android's density rule (ResTable_config::isBetterThan, which bundletool's
 * ScreenDensitySelector copies): positive when `a` serves `want` better than `b`. Both below the
 * screen: the higher wins. Both above: the lower wins. One on each side: scaling down is taken
 * to be twice as good as scaling up.
 */
function compareDensity(a: number, b: number, want: number): number {
  if (a === b) return 0
  if (a === DENSITY_ANY) return 1
  if (b === DENSITY_ANY) return -1
  const ordered = (lo: number, hi: number) => {
    if (want >= hi) return -1
    if (want <= lo) return 1
    return (2 * lo - want) * hi > want * want ? 1 : -1
  }
  return a > b ? -ordered(b, a) : ordered(a, b)
}

/** The density Android would take from `candidates` for a `deviceDpi` screen. */
export function bestDensity(candidates: readonly number[], deviceDpi: number): number {
  const want =
    deviceDpi === 0 || deviceDpi === DENSITY_ANY || deviceDpi === DENSITY_NONE ? 160 : deviceDpi
  let best = candidates[0] ?? 0
  for (const c of candidates.slice(1)) if (compareDensity(c, best, want) > 0) best = c
  return best
}

/* ---------------------------------------------------------------- *
 * 1. From toc.pb
 * ---------------------------------------------------------------- */

/** GL extension → the texture format it means (bundletool's TextureCompressionUtils). */
const TEXTURE_BY_EXTENSION: Readonly<Record<string, string>> = {
  GL_KHR_texture_compression_astc_ldr: 'astc',
  GL_AMD_compressed_ATC_texture: 'atc',
  GL_EXT_texture_compression_dxt1: 'dxt1',
  GL_OES_compressed_ETC1_RGB8_texture: 'etc1',
  GL_EXT_texture_compression_latc: 'latc',
  GL_OES_compressed_paletted_texture: 'paletted',
  GL_IMG_texture_compression_pvrtc: 'pvrtc',
  GL_EXT_texture_compression_s3tc: 's3tc',
  GL_AMD_compressed_3DC_texture: '3dc',
}
/** Most preferred first: bundletool's TEXTURE_COMPRESSION_FORMAT_ORDERING, reversed. */
const TEXTURE_PREFERENCE = [
  'astc',
  'pvrtc',
  's3tc',
  'dxt1',
  'latc',
  'atc',
  '3dc',
  'etc2',
  'etc1',
  'paletted',
]
const GLES_3_0 = 0x30000

/** A device spec with extract-apks' defaults filled in, in the shapes the matchers compare. */
interface Device {
  sdk: number
  preRelease: boolean
  abis: readonly string[]
  density: number
  languages: ReadonlySet<string>
  /** Texture formats the GPU decodes, most preferred first: from its GL extensions and GL ES. */
  textures: readonly string[]
  /** Whether the spec lists GL extensions at all, which is what bundletool calls present. */
  hasExtensions: boolean
  features: ReadonlySet<string>
  glEs: number
  tier: number
  countrySet: string
  groups: readonly string[]
  sdkRuntime: boolean
}

function glEsVersion(features: readonly string[]): number {
  for (const f of features) {
    if (!f.startsWith('reqGlEsVersion=')) continue
    const n = Number(f.slice('reqGlEsVersion='.length))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function device(spec: DeviceSpec, toc: Toc): Device {
  const features = spec.deviceFeatures ?? []
  const extensions = spec.glExtensions ?? []
  const glEs = glEsVersion(features)
  const supported = new Set(extensions.map((e) => TEXTURE_BY_EXTENSION[e]).filter(Boolean))
  if (glEs >= GLES_3_0) supported.add('etc2')
  return {
    sdk: spec.sdkVersion,
    preRelease: !!spec.codename && spec.codename !== 'REL',
    abis: spec.supportedAbis,
    density: spec.screenDensity,
    languages: new Set(spec.supportedLocales.map(languageOf)),
    textures: TEXTURE_PREFERENCE.filter((t) => supported.has(t)),
    hasExtensions: extensions.length > 0,
    features: new Set(features),
    glEs,
    // What extract-apks' applyDefaultsToDeviceSpec fills in from the toc's default suffixes.
    tier: spec.deviceTier ?? (Number(toc.defaults.deviceTier ?? 0) || 0),
    countrySet: spec.countrySet ?? toc.defaults.countrySet ?? '',
    groups: spec.deviceGroups?.length ? spec.deviceGroups : [toc.defaults.deviceGroup ?? ''],
    sdkRuntime: spec.sdkRuntime ? spec.sdkRuntime.supported : spec.sdkVersion >= 34,
  }
}

/*
  The matchers below are bundletool's matchesTargeting, one per dimension. For an APK they apply
  as they are; for a variant or a module's conditions bundletool first asks whether the spec has
  the dimension at all, and treats a missing one as a match (variantMatches, conditionsHold).
  That asymmetry is real: with no GL extensions in the spec, every variant still matches, but
  no texture-format split does.
*/

const isDefault = <T>(t: Targeting<T>) => t.value.length === 0 && t.alternatives.length === 0

function fitsSdk(min: number, d: Device): boolean {
  // A preview build runs apps built against the next, unreleased SDK (min 10000).
  if (d.preRelease && min === 10000) return true
  return min <= d.sdk
}

function sdkMatches(t: Targeting<number>, d: Device): boolean {
  if (t.value.length > 1) return false
  const value = t.value[0] ?? 0
  if (!fitsSdk(value, d)) return false
  // A sibling that also fits and needs a newer SDK serves the device better.
  return !t.alternatives.some((alt) => fitsSdk(alt, d) && alt > value)
}

function abiMatches(t: Targeting<string>, d: Device): boolean {
  if (isDefault(t)) return true
  for (const abi of d.abis) {
    if (t.value.includes(abi)) return true
    if (t.alternatives.includes(abi)) return false
  }
  return t.value.length === 0
}

function densityMatches(t: Targeting<number>, d: Device): boolean {
  const all = [...t.value, ...t.alternatives]
  if (all.length === 0) return true
  return t.value.includes(bestDensity(all, d.density))
}

function languageMatches(t: Targeting<string>, d: Device): boolean {
  if (isDefault(t)) return true
  if (t.value.length > 0) return t.value.some((v) => d.languages.has(v))
  // The fallback split (no value) serves a device whose languages the others do not all cover.
  return ![...d.languages].every((l) => t.alternatives.includes(l))
}

function textureMatches(t: Targeting<string>, d: Device): boolean {
  if (isDefault(t)) return true
  for (const format of d.textures) {
    if (t.value.includes(format)) return true
    if (t.alternatives.includes(format)) return false
  }
  return t.value.length === 0 && t.alternatives.length > 0
}

const tierMatches = (t: Targeting<number>, d: Device) => isDefault(t) || t.value.includes(d.tier)

function countryMatches(t: Targeting<string>, d: Device): boolean {
  if (isDefault(t)) return true
  if (!d.countrySet) return t.value.length === 0 && t.alternatives.length > 0
  return t.value.includes(d.countrySet)
}

const groupMatches = (t: Targeting<string>, d: Device) =>
  isDefault(t) || t.value.some((g) => d.groups.includes(g))

function apkMatches(t: ApkTargeting, d: Device): boolean {
  return (
    sdkMatches(t.sdk, d) &&
    abiMatches(t.abi, d) &&
    densityMatches(t.density, d) &&
    languageMatches(t.language, d) &&
    textureMatches(t.textureFormat, d) &&
    groupMatches(t.deviceGroup, d) &&
    tierMatches(t.deviceTier, d) &&
    countryMatches(t.countrySet, d)
  )
}

function variantMatches(v: TocVariant, d: Device): boolean {
  const t = v.targeting
  return (
    (d.sdk === 0 || sdkMatches(t.sdk, d)) &&
    (d.abis.length === 0 || abiMatches(t.abi, d)) &&
    (d.density === 0 || densityMatches(t.density, d)) &&
    (!d.hasExtensions || textureMatches(t.textureFormat, d)) &&
    (!t.requiresSdkRuntime || d.sdkRuntime)
  )
}

/** Why no APK set fits the phone. */
export type Incompatible =
  /** The app's lowest supported SDK is above the phone's. */
  | { readonly code: 'SDK'; readonly deviceSdk: number; readonly minSdk: number }
  | {
      readonly code: 'ABI'
      readonly deviceAbis: readonly string[]
      readonly appAbis: readonly string[]
    }
  | {
      readonly code: 'TEXTURE'
      readonly deviceFormats: readonly string[]
      readonly appFormats: readonly string[]
    }
  /** A module has APKs per CPU or screen, and none of them is for this phone. */
  | { readonly code: 'MISSING'; readonly module: string; readonly dimensions: readonly string[] }
  | { readonly code: 'NO_MATCH' }

/** Something extract-apks decided that the person installing should know about. */
export type SelectionNote =
  /**
   * The app has parts per GPU texture format, and the spec has no GL extensions: only what the
   * OpenGL ES version implies (ETC2 from 3.0) could be matched, as in bundletool.
   */
  | { readonly code: 'TEXTURES_UNCHECKED' }
  /** Device tiers are targeted; the bundle's default tier was assumed. */
  | { readonly code: 'DEVICE_TIER'; readonly tier: number }
  | { readonly code: 'COUNTRY_SET'; readonly countrySet: string }
  | { readonly code: 'DEVICE_GROUP' }
  /**
   * A conditional module whose conditions could not all be checked (countries, or device
   * features the spec does not list), and whether it was included all the same.
   */
  | {
      readonly code: 'CONDITIONAL_MODULE'
      readonly module: string
      readonly included: boolean
    }
  /** Built with --local-testing: on-demand parts are meant to be pushed later, not installed. */
  | { readonly code: 'LOCAL_TESTING' }

export interface SelectedApk extends TocApk {
  readonly module: string
  readonly delivery: Delivery
  /** A slice of a Play Asset Delivery pack rather than one of the app's own modules. */
  readonly assetPack: boolean
}

export type TocSelection =
  | {
      readonly ok: true
      readonly variant: number
      readonly apks: readonly SelectedApk[]
      readonly notes: readonly SelectionNote[]
    }
  | { readonly ok: false; readonly incompatible: Incompatible }

const values = <T>(t: Targeting<T>) => [...t.value, ...t.alternatives]
const unique = <T>(list: readonly T[]) => [...new Set(list)]

/** bundletool's checkDeviceCompatible, per dimension: null when the device can use some sibling. */
function incompatibility(
  t: { sdk: Targeting<number>; abi: Targeting<string>; textureFormat: Targeting<string> },
  d: Device,
): Incompatible | null {
  if (d.sdk !== 0) {
    const mins = [t.sdk.value[0] ?? 0, ...t.sdk.alternatives]
    if (!mins.some((m) => fitsSdk(m, d))) {
      return { code: 'SDK', deviceSdk: d.sdk, minSdk: Math.min(...mins) }
    }
  }
  if (d.abis.length > 0 && !isDefault(t.abi)) {
    const appAbis = values(t.abi)
    if (!appAbis.some((a) => d.abis.includes(a))) {
      return { code: 'ABI', deviceAbis: d.abis, appAbis: unique(appAbis) }
    }
  }
  const tcf = t.textureFormat
  if (d.hasExtensions && !isDefault(tcf) && tcf.value.length > 0) {
    const appFormats = values(tcf)
    if (!appFormats.some((f) => d.textures.includes(f))) {
      return { code: 'TEXTURE', deviceFormats: d.textures, appFormats: unique(appFormats) }
    }
  }
  return null
}

/**
 * bundletool's version guard for the delivery_type field (NEW_DELIVERY_TYPE_MANIFEST_TAG, from
 * 0.10.2 on). Null when the toc does not say which bundletool wrote it.
 */
function readsDeliveryType(version: string): boolean | null {
  const parts = version
    .split(/[.-]/)
    .slice(0, 3)
    .map((p) => parseInt(p, 10))
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  const [major = 0, minor = 0, patch = 0] = parts
  return major > 0 || minor > 10 || (minor === 10 && patch >= 2)
}

function conditionsHold(t: ModuleTargeting, d: Device): boolean {
  if (d.sdk !== 0 && !sdkMatches(t.sdk, d)) return false
  // Feature and OpenGL conditions count only when the spec lists features at all.
  if (d.features.size > 0) {
    const GL = 'android.hardware.opengles.version'
    const needs = t.deviceFeatures.filter((f) => f.name !== GL)
    if (!needs.every((f) => d.features.has(f.name))) return false
    const gl = t.deviceFeatures.find((f) => f.name === GL)
    if (gl && d.glEs < gl.version) return false
  }
  return t.deviceGroups.length === 0 || t.deviceGroups.some((g) => d.groups.includes(g))
}

/** The modules extract-apks installs: install-time ones whose conditions hold, with dependencies. */
function installTimeModules(variant: TocVariant, toc: Toc, d: Device, notes: SelectionNote[]) {
  const byType = readsDeliveryType(toc.bundletoolVersion)
  const wanted = new Set<string>()
  for (const m of variant.modules) {
    const typed = byType ?? m.delivery !== 'unknown'
    const installTime = typed ? m.delivery === 'install-time' : !m.onDemandDeprecated
    if (!installTime) continue
    if (!m.targeting) {
      wanted.add(m.name)
      continue
    }
    const holds = conditionsHold(m.targeting, d)
    if (holds) wanted.add(m.name)
    const checked =
      !m.targeting.userCountries && (d.features.size > 0 || m.targeting.deviceFeatures.length === 0)
    if (!checked) notes.push({ code: 'CONDITIONAL_MODULE', module: m.name, included: holds })
  }
  const deps = new Map(variant.modules.map((m) => [m.name, m.dependencies]))
  const add = (name: string) => {
    for (const dep of deps.get(name) ?? []) {
      if (wanted.has(dep)) continue
      wanted.add(dep)
      add(dep)
    }
  }
  for (const name of [...wanted]) add(name)
  return wanted
}

/** Dimensions a module's APKs are split by that the person installing should hear about. */
function noteTargeting(apks: readonly TocApk[], d: Device, notes: SelectionNote[]) {
  const has = (pick: (t: ApkTargeting) => Targeting<unknown>) =>
    apks.some((a) => !isDefault(pick(a.targeting)))
  if (!d.hasExtensions && has((t) => t.textureFormat)) notes.push({ code: 'TEXTURES_UNCHECKED' })
  if (has((t) => t.deviceTier)) notes.push({ code: 'DEVICE_TIER', tier: d.tier })
  if (has((t) => t.countrySet)) notes.push({ code: 'COUNTRY_SET', countrySet: d.countrySet })
  if (has((t) => t.deviceGroup)) notes.push({ code: 'DEVICE_GROUP' })
}

/** The variants left once the SDK Runtime is accounted for (bundletool's VariantMatcher). */
function matchingVariants(toc: Toc, d: Device): TocVariant[] {
  // Instant-app variants hold only instant APKs; a normal install never uses them.
  const candidates = toc.variants.filter(
    (v) => !v.modules.every((m) => m.apks.every((a) => a.kind === 'instant')),
  )
  if (d.sdkRuntime) {
    const withRuntime = candidates.filter(
      (v) => v.targeting.requiresSdkRuntime && variantMatches(v, d),
    )
    if (withRuntime.length > 0) return withRuntime
  }
  return candidates.filter((v) => !v.targeting.requiresSdkRuntime && variantMatches(v, d))
}

/** What `bundletool extract-apks --device-spec` would extract from this toc for this phone. */
export function selectFromToc(toc: Toc, spec: DeviceSpec): TocSelection {
  const d = device(spec, toc)
  const notes: SelectionNote[] = []
  if (toc.localTesting.enabled) notes.push({ code: 'LOCAL_TESTING' })

  const variants = matchingVariants(toc, d)
  const variant = variants.reduce<TocVariant | null>(
    (best, v) => (!best || v.number > best.number ? v : best),
    null,
  )
  if (!variant) {
    const first = toc.variants[0]
    return {
      ok: false,
      incompatible: (first && incompatibility(first.targeting, d)) ?? { code: 'NO_MATCH' },
    }
  }

  const modules = installTimeModules(variant, toc, d, notes)
  const picked: SelectedApk[] = []
  for (const m of variant.modules) {
    if (!modules.has(m.name)) continue
    for (const apk of m.apks) {
      const reason = incompatibility(apk.targeting, d)
      if (reason) return { ok: false, incompatible: reason }
    }
    const matched = m.apks.filter((a) => apkMatches(a.targeting, d))
    // A module split by CPU or screen must keep a split for that dimension (extract-apks'
    // ensureDensityAndAbiApksMatched), or the install would fail with MISSING_SPLIT.
    const dims = (list: readonly TocApk[]) =>
      new Set(
        list.flatMap((a) => [
          ...(isDefault(a.targeting.abi) ? [] : ['abi']),
          ...(isDefault(a.targeting.density) ? [] : ['density']),
        ]),
      )
    const missing = [...dims(m.apks)].filter((x) => !dims(matched).has(x))
    if (missing.length > 0) {
      return { ok: false, incompatible: { code: 'MISSING', module: m.name, dimensions: missing } }
    }
    noteTargeting(m.apks, d, notes)
    picked.push(
      ...matched.map((a) => ({ ...a, module: m.name, delivery: m.delivery, assetPack: false })),
    )
  }

  // Install-time asset packs ride along with the app, as with install-apks.
  for (const pack of toc.assetPacks) {
    if (pack.delivery !== 'install-time') continue
    const matched = pack.apks.filter((a) => apkMatches(a.targeting, d))
    noteTargeting(pack.apks, d, notes)
    picked.push(
      ...matched.map((a) => ({
        ...a,
        module: pack.name,
        delivery: pack.delivery,
        assetPack: true,
      })),
    )
  }

  const seen = new Set<string>()
  return {
    ok: true,
    variant: variant.number,
    apks: picked,
    notes: notes.filter((n) => {
      const key = JSON.stringify(n)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}

/* ---------------------------------------------------------------- *
 * 2. From split names
 * ---------------------------------------------------------------- */

/** Split names write ABIs with '_' (arm64_v8a); x86_64 keeps its own underscore. */
const ABI_BY_SPLIT: Readonly<Record<string, string>> = {
  armeabi: 'armeabi',
  armeabi_v7a: 'armeabi-v7a',
  arm64_v8a: 'arm64-v8a',
  x86: 'x86',
  x86_64: 'x86_64',
  mips: 'mips',
  mips64: 'mips64',
  riscv64: 'riscv64',
}

export interface SplitRole {
  /** 'base', or the feature module the split belongs to. */
  readonly module: string
  readonly kind: 'base' | 'feature' | 'abi' | 'density' | 'language' | 'other'
  /** The ABI ('arm64-v8a'), density in dpi ('480'), or language ('vi'); '' for the others. */
  readonly value: string
}

/**
 * What a split is for, from its name: '' (the base), 'config.arm64_v8a', 'config.xxhdpi',
 * 'config.vi', a feature module 'maps', or one of its config splits 'maps.config.en'.
 */
export function splitRole(split: string): SplitRole {
  if (split === '') return { module: 'base', kind: 'base', value: '' }
  const m = /^(?:(.+)\.)?config\.(.+)$/.exec(split)
  if (!m) return { module: split, kind: 'feature', value: '' }
  const module = m[1] ?? 'base'
  const config = m[2] ?? ''
  const abi = ABI_BY_SPLIT[config]
  if (abi) return { module, kind: 'abi', value: abi }
  const dpi = DENSITY_BY_NAME[config]
  if (dpi) return { module, kind: 'density', value: String(dpi) }
  if (/^[a-z]{2,3}$/.test(config)) return { module, kind: 'language', value: config }
  return { module, kind: 'other', value: config }
}

export interface NamedSplit<T> {
  /** The split name, as in splitRole. */
  readonly split: string
  readonly item: T
}

export type NamedSelection<T> =
  | {
      readonly ok: true
      readonly picked: readonly NamedSplit<T>[]
      /** Left out, and why: not this phone's CPU, screen or language, or an unknown config. */
      readonly skipped: readonly (NamedSplit<T> & { readonly reason: SplitRole['kind'] })[]
    }
  | { readonly ok: false; readonly incompatible: Incompatible }

/**
 * Play's choice among named splits: per module, the phone's first ABI that has a split, the
 * best density, every language the phone has, and the module itself. A config this code does
 * not know (a texture format, a device tier) is left out and reported.
 */
export function selectByName<T>(
  splits: readonly NamedSplit<T>[],
  spec: DeviceSpec,
): NamedSelection<T> {
  const languages = new Set(spec.supportedLocales.map(languageOf))
  const picked: NamedSplit<T>[] = []
  const skipped: (NamedSplit<T> & { reason: SplitRole['kind'] })[] = []
  const byModule = new Map<string, (NamedSplit<T> & { role: SplitRole })[]>()
  for (const s of splits) {
    const role = splitRole(s.split)
    let list = byModule.get(role.module)
    if (!list) byModule.set(role.module, (list = []))
    list.push({ ...s, role })
  }

  for (const list of byModule.values()) {
    const abis = list.filter((s) => s.role.kind === 'abi')
    if (abis.length > 0) {
      const best = spec.supportedAbis
        .map((abi) => abis.find((s) => s.role.value === abi))
        .find((s) => s !== undefined)
      if (!best) {
        return {
          ok: false,
          incompatible: {
            code: 'ABI',
            deviceAbis: spec.supportedAbis,
            appAbis: unique(abis.map((s) => s.role.value)),
          },
        }
      }
      picked.push(best)
      skipped.push(...abis.filter((s) => s !== best).map((s) => ({ ...s, reason: s.role.kind })))
    }
    const densities = list.filter((s) => s.role.kind === 'density')
    if (densities.length > 0) {
      const dpi = bestDensity(
        densities.map((s) => Number(s.role.value)),
        spec.screenDensity,
      )
      const chosen = densities.find((s) => Number(s.role.value) === dpi)
      for (const s of densities) {
        if (s === chosen) picked.push(s)
        else skipped.push({ ...s, reason: s.role.kind })
      }
    }
    for (const s of list.filter((x) => x.role.kind === 'language')) {
      if (languages.has(languageOf(s.role.value))) picked.push(s)
      else skipped.push({ ...s, reason: s.role.kind })
    }
    picked.push(...list.filter((s) => s.role.kind === 'base' || s.role.kind === 'feature'))
    skipped.push(
      ...list.filter((s) => s.role.kind === 'other').map((s) => ({ ...s, reason: s.role.kind })),
    )
  }

  const strip = ({ split, item }: NamedSplit<T>) => ({ split, item })
  return {
    ok: true,
    picked: picked.map(strip),
    skipped: skipped.map((s) => ({ ...strip(s), reason: s.reason })),
  }
}
