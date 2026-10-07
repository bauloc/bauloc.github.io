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
  stringPool,
} from './axml'
import { openZip, type ZipArchive } from './zip'

/*
  The fixtures are real: bundletool 1.18.3's split APKs of the research probe app
  (probe-unsigned.apks, probe.aab) and aapt2 36's APKs built for these tests (badge*.apk). Each
  expected value is what `aapt2 dump badging` / `aapt2 dump xmltree` printed for the same file.
*/

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))

interface ElementLayout {
  /** Where the attributes start, counted from the attribute extension. */
  readonly attrStart?: number
  /** From one attribute to the next. */
  readonly attrSize?: number
  readonly attrCount: number
  /** The chunk's size, 36 at least; by default just enough for the attributes. */
  readonly size?: number
}

/**
 * Binary XML of START_ELEMENT chunks laid out by hand, their attribute records left zero. By
 * default each is laid out as aapt2 writes one: attributes from 20 bytes past the extension,
 * 20 bytes apart.
 */
function elements(layouts: readonly ElementLayout[]): Uint8Array<ArrayBuffer> {
  const chunks = layouts.map(({ attrStart = 20, attrSize = 20, attrCount, size }) => {
    const chunk = new Uint8Array(size ?? 16 + attrStart + attrCount * attrSize)
    const v = new DataView(chunk.buffer)
    v.setUint16(0, 0x0102, true)
    v.setUint16(2, 16, true)
    v.setUint32(4, chunk.length, true)
    v.setUint16(24, attrStart, true)
    v.setUint16(26, attrSize, true)
    v.setUint16(28, attrCount, true)
    return chunk
  })
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 8))
  const v = new DataView(out.buffer)
  v.setUint16(0, 0x0003, true)
  v.setUint16(2, 8, true)
  v.setUint32(4, out.length, true)
  let at = 8
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Where pooled() puts its string pool. */
const POOL_AT = 8

/**
 * Binary XML whose UTF-16 string pool is laid out by hand: `offsets` (in characters) into
 * `data`, then one element with an attribute named by each index in turn, so reading the
 * element decodes every string.
 */
function pooled(offsets: readonly number[], data: Uint16Array): Uint8Array<ArrayBuffer> {
  const stringsStart = 28 + offsets.length * 4
  const poolSize = Math.ceil((stringsStart + data.length * 2) / 4) * 4
  const elementSize = 16 + 20 + offsets.length * 20
  const out = new Uint8Array(POOL_AT + poolSize + elementSize)
  const v = new DataView(out.buffer)
  v.setUint16(0, 0x0003, true)
  v.setUint16(2, 8, true)
  v.setUint32(4, out.length, true)
  // The pool: its header (UTF-16, no styles), the offsets in bytes, then the strings.
  v.setUint16(POOL_AT, 0x0001, true)
  v.setUint16(POOL_AT + 2, 28, true)
  v.setUint32(POOL_AT + 4, poolSize, true)
  v.setUint32(POOL_AT + 8, offsets.length, true)
  v.setUint32(POOL_AT + 20, stringsStart, true)
  offsets.forEach((offset, i) => v.setUint32(POOL_AT + 28 + i * 4, offset * 2, true))
  data.forEach((unit, i) => v.setUint16(POOL_AT + stringsStart + i * 2, unit, true))
  // The element: no namespace or name of its own, and integer attributes named by the pool.
  const at = POOL_AT + poolSize
  v.setUint16(at, 0x0102, true)
  v.setUint16(at + 2, 16, true)
  v.setUint32(at + 4, elementSize, true)
  v.setUint32(at + 16, 0xffffffff, true)
  v.setUint32(at + 20, 0xffffffff, true)
  v.setUint16(at + 24, 20, true)
  v.setUint16(at + 26, 20, true)
  v.setUint16(at + 28, offsets.length, true)
  offsets.forEach((_, i) => {
    const a = at + 36 + i * 20
    v.setUint32(a, 0xffffffff, true)
    v.setUint32(a + 4, i, true)
    v.setUint32(a + 8, 0xffffffff, true)
    v.setUint16(a + 12, 8, true)
    v.setUint8(a + 15, 0x10)
  })
  return out
}

/** One UTF-16 string as a pool stores it: its length, its code units, then 0. */
function utf16String(text: string): Uint16Array {
  const units = new Uint16Array(text.length + 2)
  units[0] = text.length
  for (let i = 0; i < text.length; i++) units[i + 1] = text.charCodeAt(i)
  return units
}

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

  it('refuses elements that claim more attributes than their chunks hold', () => {
    // 36 bytes each, claiming 65,535 attributes of 0 bytes: a span Android's own check passes.
    // Unchecked, these 32 made two million attribute objects; 600 exhaust a tab's memory.
    const bomb = Array.from({ length: 32 }, () => ({
      attrStart: 0,
      attrSize: 0,
      attrCount: 0xffff,
      size: 36,
    }))
    expect(() => parseAxml(elements(bomb))).toThrow('AXML_CORRUPT')
    // Records that overlap, and attributes one byte longer than their chunk. Each is followed
    // by an element, so reading past its chunk would not run off the end of the bytes.
    for (const layout of [
      { attrSize: 8, attrCount: 3, size: 16 + 20 + 3 * 8 },
      { attrSize: 24, attrCount: 2, size: 16 + 20 + 2 * 24 - 1 },
    ]) {
      expect(() => parseAxml(elements([layout, { attrCount: 0 }])), JSON.stringify(layout)).toThrow(
        'AXML_CORRUPT',
      )
    }
  })

  it('reads attributes spaced wider than a record, as long as they fit', () => {
    const read = parseAxml(elements([{ attrSize: 24, attrCount: 2 }, { attrCount: 0 }]))
    expect(read.map((element) => element.attrs.length)).toEqual([2, 0])
  })

  it('decodes a string once for all the indexes that point at it', () => {
    // A pool may give one string several indexes. Charged once each, ten of these 1,000
    // characters would come to nearly five times the pool's size.
    const text = 'A'.repeat(1000)
    const read = parseAxml(pooled(new Array<number>(10).fill(0), utf16String(text)))
    expect(read[0]?.attrs.map((a) => a.name)).toEqual(new Array<string>(10).fill(text))
  })

  it('refuses strings made to overlap, which would decode to far more than their pool', () => {
    // A run of 30,672 characters, each 0x7000, which also reads as a length: every index enters
    // the run one character further along and finds 28,672 characters there. Decoded index by
    // index, these 2,000 strings in a pool of 69,372 bytes would come to 57 million characters,
    // and a longer run with more indexes to gigabytes.
    const count = 2000
    const length = 0x7000
    const bytes = pooled(
      Array.from({ length: count }, (_, i) => i),
      new Uint16Array(count + length).fill(length),
    )
    expect(() => parseAxml(bytes)).toThrow('AXML_CORRUPT')
    // Device Lab reads resources.arsc's pools with the same reader, a string at a time.
    const pool = stringPool(bytes, POOL_AT)
    expect(() => {
      for (let i = 0; i < count; i++) pool.get(i)
    }).toThrow(RangeError)
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
