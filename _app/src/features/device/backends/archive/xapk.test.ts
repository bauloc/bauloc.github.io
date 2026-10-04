import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PNG_1PX } from './__fixtures__/synth'
import { planInstall } from './plan'
import type { DeviceSpec } from './select'
import {
  APK_MIME,
  apkFileName,
  crc32,
  exportName,
  packApp,
  splitIdOf,
  storedZip,
  XAPK_MIME,
  xapkManifest,
  type PulledApk,
  type XapkApp,
} from './xapk'
import { openZip } from './zip'

const bytes = (text: string) => new TextEncoder().encode(text)
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const pixel9: DeviceSpec = {
  supportedAbis: ['arm64-v8a'],
  supportedLocales: ['en-US'],
  screenDensity: 420,
  sdkVersion: 37,
}

describe('crc32', () => {
  it('gives the standard check value', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('continues across pieces', () => {
    const whole = crc32(bytes('The quick brown fox jumps over the lazy dog'))
    expect(whole).toBe(0x414fa339)
    expect(crc32(bytes(' over the lazy dog'), crc32(bytes('The quick brown fox jumps')))).toBe(
      whole,
    )
  })
})

describe('storedZip', () => {
  it('writes a zip the archive reader opens, byte for byte, with the names kept', async () => {
    const base = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff)
    const split = bytes('split payload')
    const zip = await storedZip(
      [
        { name: 'base.apk', blob: new Blob([base]) },
        { name: 'split_config.xxhdpi.apk', blob: new Blob([split]) },
      ],
      { at: new Date(2026, 9, 4, 11, 30, 10) },
    )
    expect(zip.type).toBe('application/zip')
    expect(zip.size).toBe(30 * 2 + 46 * 2 + 22 + 2 * (8 + 23) + base.length + split.length)

    const archive = await openZip(zip)
    expect(archive.entries.map((e) => e.name)).toEqual(['base.apk', 'split_config.xxhdpi.apk'])
    expect(archive.entries.every((e) => e.method === 0)).toBe(true)
    const [first, second] = archive.entries
    if (!first || !second) throw new Error('entries missing')
    expect(await archive.bytes(first)).toEqual(base)
    expect(await archive.bytes(second)).toEqual(split)

    // The CRC in the local header is the data's.
    const head = new DataView(await zip.arrayBuffer())
    expect(head.getUint32(14, true)).toBe(crc32(base))
  })

  it('writes an empty archive as just the end record', async () => {
    const zip = await storedZip([])
    expect(zip.size).toBe(22)
    expect((await openZip(zip)).entries).toEqual([])
  })

  it('stops when the export is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      storedZip([{ name: 'a.apk', blob: new Blob([bytes('x')]) }], { signal: controller.signal }),
    ).rejects.toThrow()
  })

  it('reports the checksum a slice at a time, from 0 to every entry’s bytes', async () => {
    const MB = 1024 * 1024
    const seen: [number, number][] = []
    await storedZip(
      [
        { name: 'manifest.json', blob: new Blob([bytes('{}')]) },
        { name: 'base.apk', blob: new Blob([new Uint8Array(2.5 * MB)]) },
      ],
      { onProgress: (done, total) => seen.push([done, total]) },
    )
    const total = 2 + 2.5 * MB
    expect(seen).toEqual([
      [0, total],
      [2, total],
      [2 + MB, total],
      [2 + 2 * MB, total],
      [total, total],
    ])
  })

  it('stops between slices when cancelled partway', async () => {
    const controller = new AbortController()
    const seen: number[] = []
    const packing = storedZip(
      [{ name: 'a.apk', blob: new Blob([new Uint8Array(3 * 1024 * 1024)]) }],
      {
        signal: controller.signal,
        onProgress: (done) => {
          seen.push(done)
          if (done > 0) controller.abort()
        },
      },
    )
    await expect(packing).rejects.toThrow()
    expect(seen).toEqual([0, 1024 * 1024])
  })
})

describe('names', () => {
  it('takes the APK file name from a pm path', () => {
    expect(apkFileName('/data/app/~~ab==/com.example.shop-cd==/split_config.xxhdpi.apk')).toBe(
      'split_config.xxhdpi.apk',
    )
    expect(apkFileName('')).toBe('base.apk')
  })

  it('names the file safely: .apk for one APK, .xapk for a split app', () => {
    expect(exportName('com.example.shop', '1.4.0', 1)).toBe('com.example.shop-1.4.0.apk')
    expect(exportName('com.example.shop', '1.4 beta/2', 3)).toBe('com.example.shop-1.4_beta_2.xapk')
    expect(exportName('com.example.shop', '', 1)).toBe('com.example.shop.apk')
  })

  it('reads the split id from the name Android stores it under; the first APK is the base', () => {
    expect(splitIdOf('base.apk', true)).toBe('base')
    expect(splitIdOf('Chrome.apk', true)).toBe('base')
    expect(splitIdOf('split_config.arm64_v8a.apk', false)).toBe('config.arm64_v8a')
    expect(splitIdOf('split_feature_maps.apk', false)).toBe('feature_maps')
    expect(splitIdOf('odd.apk', false)).toBe('odd')
  })
})

const SHOP: XapkApp = {
  packageName: 'com.example.shop',
  name: 'Shop',
  versionCode: 812,
  versionName: '1.4.0',
  minSdk: 26,
  targetSdk: 35,
}

describe('xapkManifest', () => {
  it('writes APKPure’s v2 layout, numbers as strings as APKPure does', () => {
    const manifest = xapkManifest(
      SHOP,
      [
        { file: 'base.apk', size: 1000 },
        { file: 'split_config.arm64_v8a.apk', size: 300 },
        { file: 'split_config.xxhdpi.apk', size: 200 },
      ],
      true,
    )
    expect(manifest).toEqual({
      xapk_version: 2,
      package_name: 'com.example.shop',
      name: 'Shop',
      version_code: '812',
      version_name: '1.4.0',
      min_sdk_version: '26',
      target_sdk_version: '35',
      split_configs: ['config.arm64_v8a', 'config.xxhdpi'],
      split_apks: [
        { file: 'base.apk', id: 'base' },
        { file: 'split_config.arm64_v8a.apk', id: 'config.arm64_v8a' },
        { file: 'split_config.xxhdpi.apk', id: 'config.xxhdpi' },
      ],
      total_size: 1500,
      icon: 'icon.png',
    })
  })

  it('leaves out what the phone did not say, and the icon when there is none', () => {
    const manifest = xapkManifest(
      { ...SHOP, name: '', versionName: null, minSdk: null },
      [
        { file: 'base.apk', size: 1 },
        { file: 'split_config.vi.apk', size: 1 },
      ],
      false,
    )
    expect(manifest.name).toBe('com.example.shop')
    expect(manifest).not.toHaveProperty('version_name')
    expect(manifest).not.toHaveProperty('min_sdk_version')
    expect(manifest).not.toHaveProperty('icon')
    expect(manifest.version_code).toBe('812')
  })
})

/** The badge fixtures as the phone stores a split app: under /data/app, split_<name>.apk. */
const DIR = '/data/app/~~Qx==/com.bauloc.badgeprobe-Zy==/'
const badgeApks = (): PulledApk[] => [
  { path: `${DIR}base.apk`, blob: new Blob([fixture('badge.apk')]) },
  { path: `${DIR}split_config.vi.apk`, blob: new Blob([fixture('badge-config.vi.apk')]) },
  { path: `${DIR}split_config.xxhdpi.apk`, blob: new Blob([fixture('badge-config.xxhdpi.apk')]) },
]
const BADGE: XapkApp = {
  packageName: 'com.bauloc.badgeprobe',
  name: 'Badge Probe',
  versionCode: 812,
  versionName: '1.4.0',
  minSdk: 26,
  targetSdk: 35,
}

describe('packApp', () => {
  it('saves a single APK as it is', async () => {
    const [base] = badgeApks()
    if (!base) throw new Error('fixture missing')
    const packed = await packApp(BADGE, [base])
    expect(packed).toMatchObject({
      fileName: 'com.bauloc.badgeprobe-1.4.0.apk',
      kind: 'apk',
      apks: 1,
    })
    expect(packed.blob.type).toBe(APK_MIME)
    expect(new Uint8Array(await packed.blob.arrayBuffer())).toEqual(fixture('badge.apk'))
  })

  it('reports packing for a split app only: a single APK is saved without a checksum', async () => {
    const apks = badgeApks()
    const [base] = apks
    if (!base) throw new Error('fixture missing')
    const single: number[] = []
    await packApp(BADGE, [base], { onProgress: (done) => single.push(done) })
    expect(single).toEqual([])

    const split: [number, number][] = []
    await packApp(BADGE, apks, { onProgress: (done, total) => split.push([done, total]) })
    const last = split.at(-1)
    expect(split[0]?.[0]).toBe(0)
    // Every APK plus manifest.json.
    expect(last?.[1]).toBeGreaterThan(apks.reduce((n, a) => n + a.blob.size, 0))
    expect(last?.[0]).toBe(last?.[1])
  })

  it('refuses an app with no APKs', async () => {
    await expect(packApp(BADGE, [])).rejects.toThrow('Android listed no APK files')
  })

  it('packs a split app as a stored .xapk: manifest.json, icon.png, the APKs under their names', async () => {
    const packed = await packApp(BADGE, badgeApks(), { icon: new Blob([PNG_1PX]) })
    expect(packed).toMatchObject({
      fileName: 'com.bauloc.badgeprobe-1.4.0.xapk',
      kind: 'xapk',
      apks: 3,
    })
    expect(packed.blob.type).toBe(XAPK_MIME)

    const zip = await openZip(packed.blob)
    expect(zip.entries.map((e) => [e.name, e.method])).toEqual([
      ['manifest.json', 0],
      ['icon.png', 0],
      ['base.apk', 0],
      ['split_config.vi.apk', 0],
      ['split_config.xxhdpi.apk', 0],
    ])
    const manifest = zip.get('manifest.json')
    if (!manifest) throw new Error('manifest.json missing')
    const json: unknown = JSON.parse(new TextDecoder().decode(await zip.bytes(manifest)))
    expect(json).toMatchObject({
      xapk_version: 2,
      package_name: 'com.bauloc.badgeprobe',
      version_code: '812',
      split_configs: ['config.vi', 'config.xxhdpi'],
      split_apks: [
        { file: 'base.apk', id: 'base' },
        { file: 'split_config.vi.apk', id: 'config.vi' },
        { file: 'split_config.xxhdpi.apk', id: 'config.xxhdpi' },
      ],
      icon: 'icon.png',
    })
    const base = zip.get('base.apk')
    if (!base) throw new Error('base.apk missing')
    expect(await zip.bytes(base)).toEqual(fixture('badge.apk'))
  })

  it('round-trips: Device Lab’s own planInstall reads the .xapk back and picks the parts', async () => {
    const packed = await packApp(BADGE, badgeApks(), { icon: new Blob([PNG_1PX]) })
    const file = new File([packed.blob], packed.fileName)

    const vietnamese = await planInstall([file], { ...pixel9, supportedLocales: ['vi-VN'] })
    expect(vietnamese.kind).toBe('xapk')
    expect(vietnamese.problems).toEqual([])
    expect(vietnamese.warnings).toEqual([])
    expect(vietnamese.parts.map((p) => [p.source, p.split, p.role.kind])).toEqual([
      ['base.apk', '', 'base'],
      ['split_config.xxhdpi.apk', 'config.xxhdpi', 'density'],
      ['split_config.vi.apk', 'config.vi', 'language'],
    ])
    expect(vietnamese.selection).toEqual({
      offered: 3,
      abi: '',
      density: 'xxhdpi',
      languages: ['vi'],
    })
    expect(vietnamese.app).toMatchObject({
      packageName: 'com.bauloc.badgeprobe',
      versionCode: 812,
      versionName: '1.4.0',
      minSdk: 26,
      targetSdk: 35,
      label: 'Huy hiệu',
      icon: { kind: 'bitmap', mime: 'image/png' },
    })
    // Each part streams back exactly the APK that went in.
    const [base, density] = vietnamese.parts
    if (!base || !density) throw new Error('parts missing')
    expect(await drain(await base.open())).toEqual(fixture('badge.apk'))
    expect(await drain(await density.open())).toEqual(fixture('badge-config.xxhdpi.apk'))

    // An English phone leaves the Vietnamese split out.
    const english = await planInstall([file], pixel9)
    expect(english.kind).toBe('xapk')
    expect(english.problems).toEqual([])
    expect(english.parts.map((p) => p.split)).toEqual(['', 'config.xxhdpi'])
  })

  it('round-trips without an icon, from a system app whose base is not named base.apk', async () => {
    const [base, ...splits] = badgeApks()
    if (!base) throw new Error('fixture missing')
    const renamed = [{ ...base, path: '/product/app/BadgeProbe/BadgeProbe.apk' }, ...splits]
    const packed = await packApp(BADGE, renamed)
    const zip = await openZip(packed.blob)
    expect(zip.get('icon.png')).toBeUndefined()

    const plan = await planInstall([new File([packed.blob], packed.fileName)], pixel9)
    expect(plan.kind).toBe('xapk')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.source, p.role.kind])).toEqual([
      ['BadgeProbe.apk', 'base'],
      ['split_config.xxhdpi.apk', 'density'],
    ])
  })
})
