import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { apk } from './__fixtures__/synth'
import { imageMime, readApkBadge, splitNameOf, type BadgeIcon, type BadgeSplit } from './apk-badge'
import { blobSource, bytesSource, openZip, type ByteSource } from './zip'

/*
  The reader as the core uses it on a phone: a base APK and its splits behind ByteSources
  (here over the fixture files; on a phone, adb reads), with splits opened only when needed.
  badge*.apk were built by aapt2 for these tests; probe-unsigned.apks is bundletool's.
*/

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
const source = (name: string): ByteSource => bytesSource(fixture(name))
function split(name: string, file: string) {
  const open = vi.fn(() => Promise.resolve(source(file)))
  return { split: { name, open } satisfies BadgeSplit, open }
}
/** Width and height from a PNG's IHDR. */
function pngSize(bytes: Uint8Array): [number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return [v.getUint32(16), v.getUint32(20)]
}
const bitmap = (icon: BadgeIcon | null) => (icon?.kind === 'bitmap' ? icon : null)

describe('readApkBadge', () => {
  it('reads the label in the phone’s language and the icon for its screen from the splits', async () => {
    const vi_ = split('config.vi', 'badge-config.vi.apk')
    const dpi = split('config.xxhdpi', 'badge-config.xxhdpi.apk')
    const badge = await readApkBadge(source('badge.apk'), [vi_.split, dpi.split], {
      locales: ['vi-VN', 'en-US'],
      density: 420,
    })
    expect(badge).toMatchObject({
      packageName: 'com.bauloc.badgeprobe',
      versionCode: 812,
      versionName: '1.4.0',
      label: 'Huy hiệu',
    })
    const icon = bitmap(badge.icon)
    expect(icon?.mime).toBe('image/png')
    expect(pngSize(icon!.bytes)).toEqual([144, 144]) // the xxhdpi one, from the split
    // Base: its directory, manifest and table. Each split: its directory and table; one, the icon.
    expect(badge.stats.reads).toBe(8)
  })

  it('opens only the splits it needs', async () => {
    const vi_ = split('config.vi', 'badge-config.vi.apk')
    const dpi = split('config.xxhdpi', 'badge-config.xxhdpi.apk')
    const badge = await readApkBadge(source('badge.apk'), [vi_.split, dpi.split], {
      locales: ['en-GB'],
      skipIcon: true,
    })
    expect(badge.label).toBe('Badge Probe UK')
    expect(badge.icon).toBeNull()
    expect(vi_.open).not.toHaveBeenCalled()
    expect(dpi.open).not.toHaveBeenCalled()
  })

  it('falls back to the default label, and to a base density when the screen is small', async () => {
    const dpi = split('config.xxhdpi', 'badge-config.xxhdpi.apk')
    const badge = await readApkBadge(source('badge.apk'), [dpi.split], {
      locales: ['de-DE'],
      density: 160,
    })
    expect(badge.label).toBe('Badge Probe')
    expect(pngSize(bitmap(badge.icon)!.bytes)).toEqual([48, 48])
  })

  it('follows a label that points at another string, and reads an adaptive icon', async () => {
    const badge = await readApkBadge(source('badge-adaptive.apk'))
    expect(badge.label).toBe('Adaptive Probe')
    expect(badge.icon).toMatchObject({
      kind: 'adaptive',
      foreground: { mime: 'image/png' },
      background: { argb: 0xff447aee },
    })
  })

  it('gives no icon for a vector one, and keeps a literal label', async () => {
    const badge = await readApkBadge(source('badge-vector.apk'))
    expect(badge).toMatchObject({ label: 'Vector Probe', icon: null })
  })

  it('reads bundletool’s splits out of an .apks without copying them', async () => {
    const apks = await openZip(new Blob([fixture('probe-unsigned.apks')]))
    const entry = async (path: string) => blobSource((await apks.blob(apks.get(path)!))!)
    const badge = await readApkBadge(
      await entry('splits/base-master.apk'),
      [{ name: 'config.xxhdpi', open: () => entry('splits/base-xxhdpi.apk') }],
      { locales: ['en-US'] },
    )
    expect(badge.label).toBe('Bundle Probe')
    expect(bitmap(badge.icon)?.mime).toBe('image/png')
  })

  it('still answers when a split cannot be read, or the APK has no resources', async () => {
    const broken: BadgeSplit = {
      name: 'config.vi',
      open: () => Promise.reject(new Error('unplugged')),
    }
    const badge = await readApkBadge(source('badge.apk'), [broken], { locales: ['vi-VN'] })
    expect(badge.label).toBe('Badge Probe')

    const bare = apk({ package: 'com.example.bare', versionCode: 3, label: { ref: 0x7f010000 } })
    expect(await readApkBadge(bytesSource(bare))).toMatchObject({
      packageName: 'com.example.bare',
      label: null,
      icon: null,
    })
  })

  it('refuses a file that is not an APK', async () => {
    await expect(readApkBadge(bytesSource(new Uint8Array(100)))).rejects.toThrow('ZIP_NOT_A_ZIP')
  })
})

describe('helpers', () => {
  it('reads split names from file names as pm path prints them', () => {
    expect(
      [
        '/data/app/~~x==/com.example-y==/base.apk',
        'split_config.vi.apk',
        'split_config.arm64_v8a.apk',
        'split_maps.apk',
        'split_maps.config.xxhdpi.apk',
      ].map(splitNameOf),
    ).toEqual(['', 'config.vi', 'config.arm64_v8a', 'maps', 'maps.config.xxhdpi'])
  })

  it('knows an image by its first bytes', () => {
    const riff = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect(imageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10]))).toBe('image/png')
    expect(imageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMime(riff)).toBe('image/webp')
    expect(imageMime(new TextEncoder().encode('<vector'))).toBeNull()
  })
})
