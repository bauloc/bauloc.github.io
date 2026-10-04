import type { Adb } from '@yume-chan/adb'

import { parseGetprop } from '../android'
import { run, shellCmd } from './shell'

/*
  bundletool's DeviceSpec, built over WebUSB so the helper can turn an .aab into this phone's
  APKs without ever running adb (an adb server would take the phone away from the browser).

  It reads what `bundletool get-device-spec` reads, and falls back the way it does. Every rule
  below was read out of bundletool 1.18.3's own classes (DeviceAnalyzer, DdmlibDevice,
  ActivityManagerRunner, LocaleParser, GlExtensionsParser, DeviceFeaturesParser, DeviceSpecParser),
  so the spec matches what bundletool would have produced, and validates where it would.
  The field names are DeviceSpec's proto3 JSON names.
*/

export interface DeviceSpec {
  supportedAbis: string[]
  /** BCP-47, as bundletool writes them: `en-US`. */
  supportedLocales: string[]
  deviceFeatures: string[]
  glExtensions: string[]
  screenDensity: number
  /** The feature level: the API level, plus one on a preview build. */
  sdkVersion: number
  /** Only on preview builds (codename other than REL). */
  codename?: string
  ramBytes?: number
  buildBrand?: string
  buildDevice?: string
  socManufacturer?: string
  socModel?: string
  sdkRuntime?: { supported: boolean }
}

/** The commands' outputs, in the shapes the phone prints them. */
export interface DeviceSpecOutputs {
  getprop: string
  amConfig: string
  features: string
  /** `dumpsys SurfaceFlinger`, whole or through the grep below. */
  surfaceFlinger: string
  meminfo: string
  wmDensity: string
  /** `service check sdk_sandbox`. */
  sdkSandbox: string
}

/** Constant commands: nothing in them comes from outside. */
export const DEVICE_SPEC_COMMANDS = {
  getprop: shellCmd`getprop`,
  amConfig: shellCmd`am get-config`,
  features: shellCmd`pm list features`,
  // The dump runs to hundreds of KB; only its header and the GLES line plus the next one count.
  surfaceFlinger: shellCmd`dumpsys SurfaceFlinger | grep -A 1 -e '^SurfaceFlinger global state:' -e '^GLES:'`,
  meminfo: shellCmd`cat /proc/meminfo`,
  wmDensity: shellCmd`wm density`,
  sdkSandbox: shellCmd`service check sdk_sandbox`,
} as const satisfies Record<keyof DeviceSpecOutputs, unknown>

/** The ABIs bundletool knows (AbiName); it drops any other name `am get-config` lists. */
export const KNOWN_ABIS = [
  'armeabi',
  'armeabi-v7a',
  'arm64-v8a',
  'x86',
  'x86_64',
  'mips',
  'mips64',
  'riscv64',
] as const

const lineAfter = (text: string, prefix: string) =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)

/** `abi: arm64-v8a,armeabi-v7a` from `am get-config`, known ABIs only. */
export function abisFromConfig(amConfig: string): string[] {
  const line = lineAfter(amConfig, 'abi:')
  if (line === undefined) return []
  return line
    .split(',')
    .map((abi) => abi.trim())
    .filter((abi) => (KNOWN_ABIS as readonly string[]).includes(abi))
}

const LANGUAGE = /^(?!car)[A-Za-z]{2,3}$/
const LANGUAGE_REGION = /^([A-Za-z]{2,3})(?:-r([A-Za-z]{2}))?$/

/** `b+sr+Latn+RS` → `sr-RS`: bundletool keeps the language and a 2-letter or 3-digit region. */
function bcp47Locale(tag: string): string {
  const parts = tag.split('+')
  const region = parts.slice(1, 3).find((p) => p.length === 2 || p.length === 3)
  return region === undefined ? (parts[0] ?? '') : `${parts[0] ?? ''}-${region}`
}

/**
 * The locales of `am get-config`'s `config:` line, the way bundletool's LocaleParser reads it.
 * The line is resource qualifiers joined by `-`: an optional `mccNNN` and `mncNN`, then the
 * locale list (`en-rUS,vi-rVN`, or `b+sr+Latn` for anything else), then the rest (`ldltr-…`).
 * One unreadable locale makes bundletool drop them all and fall back to properties; so does this.
 */
export function localesFromConfig(amConfig: string): string[] {
  const line = lineAfter(amConfig, 'config: ')
  if (line === undefined) return []
  const qualifiers = line.split('-')
  let at = 0
  if (/^mcc\d\d\d?$/.test(qualifiers[at] ?? '')) at++
  if (/^mnc\d{1,3}$/.test(qualifiers[at] ?? '')) at++
  const first = qualifiers[at] ?? ''
  if (!(first.includes(',') || LANGUAGE.test(first) || first.startsWith('b+'))) return []
  // The list goes on in later qualifiers that carry a region (`rUS,vi`) or the next locale.
  const segments = [
    first,
    ...qualifiers.slice(at + 1).filter((q) => /^r[A-Z]{2}($|,.+)/.test(q) || q.includes(',')),
  ]
  const locales: string[] = []
  for (const locale of segments.join('-').split(',')) {
    if (locale.startsWith('b+')) {
      locales.push(bcp47Locale(locale.slice(2)))
      continue
    }
    const m = LANGUAGE_REGION.exec(locale)
    if (!m?.[1]) return []
    locales.push(m[2] ? `${m[1]}-${m[2]}` : m[1])
  }
  return locales
}

/** `pm list features`: each `feature:` line, `reqGlEsVersion=0x30002` included, as bundletool does. */
export function parseFeatures(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('feature:'))
    .map((line) => line.slice('feature:'.length))
}

/**
 * GL extensions: the line AFTER `GLES:`, itself after the `SurfaceFlinger global state:` header,
 * split on spaces. (The `GLES:` line names the GPU; the extensions follow it.)
 */
export function parseGlExtensions(text: string): string[] {
  let state: 'header' | 'gles' | 'extensions' = 'header'
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line === '') continue
    if (state === 'header' && line.startsWith('SurfaceFlinger global state:')) state = 'gles'
    else if (state === 'gles' && line.startsWith('GLES:')) state = 'extensions'
    else if (state === 'extensions') return line.trim().split(' ').filter(Boolean)
  }
  return []
}

/** `MemTotal:  11765412 kB` → bytes. */
export function parseMemTotalBytes(meminfo: string): number | null {
  const kb = /^MemTotal:\s*(\d+)/im.exec(meminfo)?.[1]
  return kb === undefined ? null : Number(kb) * 1024
}

/** The spec bundletool would build from the same outputs. validateDeviceSpec says if it is usable. */
export function buildDeviceSpec(o: DeviceSpecOutputs): DeviceSpec {
  const props = parseGetprop(o.getprop)
  const prop = (key: string) => props[key]?.trim() ?? ''
  const api = Number(prop('ro.build.version.sdk')) || 0
  const codename = prop('ro.build.version.codename')
  const preview = codename !== '' && codename !== 'REL'

  // ddmlib: ro.sf.lcd_density, then the emulator's qemu.sf.lcd_density, then `wm density`'s
  // PHYSICAL density. An override set with `wm density` does not count, as for Play.
  const density =
    Number(prop('ro.sf.lcd_density')) ||
    Number(prop('qemu.sf.lcd_density')) ||
    Number(/Physical density:\s*(\d+)/.exec(o.wmDensity)?.[1]) ||
    0

  let abis = api >= 21 ? abisFromConfig(o.amConfig) : []
  if (abis.length === 0) {
    const list = prop('ro.product.cpu.abilist')
    abis = (list || [prop('ro.product.cpu.abi'), prop('ro.product.cpu.abi2')].join(','))
      .split(',')
      .map((abi) => abi.trim())
      .filter(Boolean)
  }

  let locales = api >= 21 ? localesFromConfig(o.amConfig) : []
  if (locales.length === 0) {
    const legacy =
      api < 23 && prop('ro.product.locale.language') && prop('ro.product.locale.region')
        ? `${prop('ro.product.locale.language')}-${prop('ro.product.locale.region')}`
        : ''
    // bundletool's last resort, with a warning: "Can't detect device locale, will use 'en-US'."
    locales = [legacy || prop('persist.sys.locale') || prop('ro.product.locale') || 'en-US']
  }

  // GL extensions are skipped only on Android 7.1 watches, as in bundletool.
  const watch = api === 25 && prop('ro.build.characteristics').includes('watch')

  const spec: DeviceSpec = {
    supportedAbis: abis,
    supportedLocales: locales,
    deviceFeatures: parseFeatures(o.features),
    glExtensions: watch ? [] : parseGlExtensions(o.surfaceFlinger),
    screenDensity: density,
    sdkVersion: preview ? api + 1 : api,
    sdkRuntime: { supported: api >= 34 && /:\s*found\b/.test(o.sdkSandbox) },
  }
  if (preview) spec.codename = codename
  const ram = parseMemTotalBytes(o.meminfo)
  if (ram !== null) spec.ramBytes = ram
  const optional = [
    ['buildBrand', 'ro.product.brand'],
    ['buildDevice', 'ro.product.device'],
    ['socManufacturer', 'ro.soc.manufacturer'],
    ['socModel', 'ro.soc.model'],
  ] as const
  for (const [field, key] of optional) {
    if (prop(key)) spec[field] = prop(key)
  }
  return spec
}

/**
 * What bundletool's DeviceSpecParser would refuse, in its own words. Empty means bundletool
 * accepts the spec.
 */
export function validateDeviceSpec(spec: DeviceSpec): string[] {
  const problems: string[] = []
  if (!(spec.sdkVersion > 0)) {
    problems.push(
      `Device spec SDK version (${String(spec.sdkVersion)}) should be set to a strictly positive number.`,
    )
  }
  if (!(spec.screenDensity > 0)) {
    problems.push(
      `Device spec screen density (${String(spec.screenDensity)}) should be set to a strictly positive number.`,
    )
  }
  if (spec.supportedAbis.length === 0) problems.push('Device spec supported ABI list is empty.')
  if (spec.supportedLocales.length === 0)
    problems.push('Device spec supported locales list is empty.')
  return problems
}

/**
 * Gathers the spec from a connected phone: read-only commands, run side by side. A command that
 * fails counts as empty output, and bundletool's fallbacks take over.
 */
export async function collectDeviceSpec(
  adb: Adb,
): Promise<{ spec: DeviceSpec; problems: string[] }> {
  const keys = Object.keys(DEVICE_SPEC_COMMANDS) as (keyof DeviceSpecOutputs)[]
  const texts = await Promise.all(
    keys.map((key) =>
      run(adb, DEVICE_SPEC_COMMANDS[key]).then(
        (result) => result.stdout,
        () => '',
      ),
    ),
  )
  const outputs = Object.fromEntries(keys.map((key, i) => [key, texts[i] ?? ''])) as Record<
    keyof DeviceSpecOutputs,
    string
  >
  const spec = buildDeviceSpec(outputs)
  return { spec, problems: validateDeviceSpec(spec) }
}
