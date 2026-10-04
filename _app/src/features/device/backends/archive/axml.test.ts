import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { axml, manifest } from './__fixtures__/synth'
import {
  ATTR,
  attribute,
  isBinaryXml,
  manifestFromXml,
  manifestInfo,
  parseAxml,
  parseProtoXml,
} from './axml'
import { openZip, type ZipArchive } from './zip'

/*
  The fixtures are real: bundletool 1.18.3's split APKs of the research probe app
  (probe-unsigned.apks, probe.aab) and aapt2 36's APKs built for these tests (badge*.apk). Each
  expected value is what `aapt2 dump badging` / `aapt2 dump xmltree` printed for the same file.
*/

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
const open = async (name: string) => openZip(new Blob([fixture(name)]))
async function manifestOf(zip: ZipArchive) {
  return manifestInfo(await zip.bytes(zip.get('AndroidManifest.xml')!))
}
async function splitOf(apks: ZipArchive, path: string) {
  return openZip((await apks.blob(apks.get(path)!))!)
}

describe('manifestInfo on bundletool splits', () => {
  it('reads the base split: versions, SDK levels, required split types, its icon and label', async () => {
    const apks = await open('probe-unsigned.apks')
    const base = await manifestOf(await splitOf(apks, 'splits/base-master.apk'))
    expect(base).toMatchObject({
      packageName: 'com.bauloc.bundleprobe',
      versionCode: 1,
      versionName: '1.0',
      split: '',
      isFeatureSplit: false,
      minSdk: 32,
      targetSdk: 35,
      requiredSplitTypes: ['base__abi', 'base__density'],
      splitTypes: [],
      delivery: 'install-time',
      testOnly: false,
    })
    expect(base.labelId).toBe(0x7f020000)
    expect(base.iconId).toBe(0x7f010000)
  })

  it('reads config splits and a feature module split', async () => {
    const apks = await open('probe-unsigned.apks')
    const abi = await manifestOf(await splitOf(apks, 'splits/base-arm64_v8a.apk'))
    expect(abi).toMatchObject({
      split: 'config.arm64_v8a',
      splitTypes: ['base__abi'],
      hasCode: false,
    })
    const dpi = await manifestOf(await splitOf(apks, 'splits/base-xxhdpi.apk'))
    expect(dpi).toMatchObject({ split: 'config.xxhdpi', splitTypes: ['base__density'] })
    const extras = await manifestOf(await splitOf(apks, 'splits/extras-master.apk'))
    expect(extras).toMatchObject({
      split: 'extras',
      isFeatureSplit: true,
      delivery: 'on-demand',
      splitTypes: ['extras__module'],
    })
  })
})

describe('manifestInfo on aapt2 APKs', () => {
  it('reads a test-only, debuggable build, and splits made with aapt2 --split', async () => {
    expect(await manifestOf(await open('badge.apk'))).toMatchObject({
      packageName: 'com.bauloc.badgeprobe',
      versionCode: 812,
      versionName: '1.4.0',
      minSdk: 26,
      targetSdk: 35,
      testOnly: true,
      debuggable: true,
      label: null,
      labelId: 0x7f020000,
      iconId: 0x7f010000,
    })
    expect(await manifestOf(await open('badge-config.vi.apk'))).toMatchObject({
      split: 'config.vi',
      versionCode: 812,
      minSdk: 1,
    })
  })

  it('keeps a literal label as text', async () => {
    expect(await manifestOf(await open('badge-vector.apk'))).toMatchObject({
      label: 'Vector Probe',
      labelId: null,
    })
  })

  it('reads an adaptive icon’s layers as references', async () => {
    const zip = await open('badge-adaptive.apk')
    const xml = parseAxml(await zip.bytes(zip.get('res/mipmap-anydpi-v26/ic_launcher.xml')!))
    expect(xml.map((e) => [e.name, e.depth])).toEqual([
      ['adaptive-icon', 0],
      ['background', 1],
      ['foreground', 1],
    ])
    expect(attribute(xml[1], ATTR.drawable)).toMatchObject({ type: 0x01, data: 0x7f010000 })
  })
})

describe('the .aab manifest (protobuf)', () => {
  it('reads to the same summary as a binary one', async () => {
    const aab = await open('probe.aab')
    const bytes = await aab.bytes(aab.get('base/manifest/AndroidManifest.xml')!)
    expect(isBinaryXml(bytes)).toBe(false)
    expect(manifestFromXml(parseProtoXml(bytes))).toMatchObject({
      packageName: 'com.bauloc.bundleprobe',
      versionCode: 1,
      versionName: '1.0',
      minSdk: 24,
      targetSdk: 35,
      labelId: 0x7f020000,
    })
    const extras = await aab.bytes(aab.get('extras/manifest/AndroidManifest.xml')!)
    expect(manifestFromXml(parseProtoXml(extras))).toMatchObject({
      split: 'extras',
      isFeatureSplit: true,
      delivery: 'on-demand',
    })
  })
})

describe('parseAxml', () => {
  it('reads UTF-16 string pools, which the original aapt wrote', () => {
    const bytes = axml(
      { name: 'manifest', attrs: { package: 'com.example.ütf16', 'android:versionCode': 3 } },
      { utf16: true },
    )
    expect(manifestInfo(bytes)).toMatchObject({ packageName: 'com.example.ütf16', versionCode: 3 })
  })

  it('combines versionCodeMajor into the long version code Android compares', () => {
    const bytes = axml({
      name: 'manifest',
      attrs: {
        package: 'com.example.app',
        'android:versionCode': 5,
        'android:versionCodeMajor': 2,
      },
    })
    expect(manifestInfo(bytes).versionCode).toBe(2 * 2 ** 32 + 5)
  })

  it('reads a preview SDK named by codename', () => {
    const bytes = axml({
      name: 'manifest',
      attrs: { package: 'com.example.app' },
      children: [{ name: 'uses-sdk', attrs: { 'android:minSdkVersion': 'Baklava' } }],
    })
    expect(manifestInfo(bytes)).toMatchObject({ minSdk: 10000, minSdkCodename: 'Baklava' })
  })

  it('reads the defaults Android assumes when uses-sdk is absent', () => {
    expect(manifestInfo(manifest({ package: 'com.example.app' }))).toMatchObject({
      minSdk: 1,
      targetSdk: 1,
      versionCode: 0,
      hasCode: true,
      testOnly: false,
    })
  })

  it('refuses text XML, a protobuf manifest, damaged bytes and a document without <manifest>', async () => {
    const throws = (bytes: Uint8Array) => {
      try {
        manifestInfo(bytes)
        return 'parsed'
      } catch (error) {
        return error instanceof Error ? error.message : 'odd'
      }
    }
    expect(throws(new TextEncoder().encode('<?xml version="1.0"?><manifest/>'))).toBe(
      'AXML_NOT_BINARY',
    )
    const aab = await open('probe.aab')
    expect(throws(await aab.bytes(aab.get('base/manifest/AndroidManifest.xml')!))).toBe(
      'AXML_NOT_BINARY',
    )
    const good = manifest({ package: 'com.example.app', versionCode: 1 })
    expect(throws(good.slice(0, 60))).toBe('AXML_CORRUPT')
    expect(throws(axml({ name: 'adaptive-icon' }))).toBe('AXML_NO_MANIFEST')
  })

  it('finds android attributes by id even when a shrinker renamed their strings', () => {
    const bytes = axml({ name: 'manifest', attrs: { package: 'p.q', 'android:versionCode': 9 } })
    const renamed = bytes.slice()
    // Overwrite the "versionCode" name string's bytes; the resource map still says 0x0101021b.
    const at = new TextDecoder('latin1').decode(renamed).indexOf('versionCode')
    renamed.set(new TextEncoder().encode('xxxxxxxxxxx'), at)
    expect(manifestInfo(renamed).versionCode).toBe(9)
  })
})
