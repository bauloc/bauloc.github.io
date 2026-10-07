import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  apk,
  axml,
  makeZip,
  manifest,
  type ManifestSpec,
} from '@/features/device/backends/archive/__fixtures__/synth'
import { openZip } from '@/features/device/backends/archive/zip'

import type { IconSource } from '../types'
import { signed } from './__fixtures__/signed'
import { inspectApk } from './apk'

/*
  The real APKs are Device Lab's fixtures, which aapt2 and bundletool wrote (see
  device/backends/archive/__fixtures__/make-badges.sh for what each holds). The cases no tool
  writes on purpose, such as a manifest cut short or native code beside other files, are built
  in memory with the same fixtures' builders.

  Those fixtures are unsigned, and an unsigned APK is refused: every helper below signs its APK
  (see __fixtures__/signed.ts) except where a test is about the signature itself.
*/

const fixtureBytes = (name: string) =>
  readFileSync(new URL(`../../../device/backends/archive/__fixtures__/${name}`, import.meta.url))
const fixture = (name: string) => new Blob([signed(fixtureBytes(name))])

/** An APK inside bundletool's .apks, as a tester might unpack one and upload it. */
async function fromApks(path: string): Promise<Blob> {
  const apks = await openZip(new Blob([fixtureBytes('probe-unsigned.apks')]))
  const apk = (await apks.blob(apks.get(path)!))!
  return new Blob([signed(new Uint8Array(await apk.arrayBuffer()))])
}

/** Width and height from a PNG's IHDR. */
function pngSize(bytes: Uint8Array): [number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return [v.getUint32(16), v.getUint32(20)]
}

const bitmapOf = (icon: IconSource | null) =>
  icon?.kind === 'badge' && icon.icon.kind === 'bitmap' ? icon.icon : null

const blob = (bytes: Uint8Array<ArrayBuffer>) => new Blob([signed(bytes)])
const unsigned = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes])

/** A v1 JAR signature's block file: its name is all inspectApk looks at. */
const JAR_SIGNATURE = { name: 'META-INF/CERT.RSA', data: 'pkcs7' }

/**
 * Binary XML of `count` START_ELEMENT chunks of 36 bytes, each claiming 65,535 attributes of
 * 0 bytes: a few kilobytes, a few hundred bytes deflated, that would make millions of objects.
 */
function attributeBomb(count: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + 36 * count)
  const v = new DataView(bytes.buffer)
  v.setUint16(0, 0x0003, true) // the document: type, header size, size
  v.setUint16(2, 8, true)
  v.setUint32(4, bytes.length, true)
  for (let at = 8; at < bytes.length; at += 36) {
    v.setUint16(at, 0x0102, true) // START_ELEMENT, a 16-byte header, 36 bytes in all
    v.setUint16(at + 2, 16, true)
    v.setUint32(at + 4, 36, true)
    v.setUint16(at + 28, 0xffff, true) // attributeCount; attributeStart and attributeSize stay 0
  }
  return bytes
}

/**
 * A good manifest, then a second string pool and an element whose `count` attributes are named
 * by strings made to overlap: one UTF-16 run of 0x8010s, each of which also reads as the start
 * of a length of 1,081,360 characters, entered one unit further along by each index. Two
 * megabytes, a few kilobytes deflated, that would decode index by index to `count` million
 * characters, and then read as a good APK.
 */
function stringBomb(count: number): Uint8Array<ArrayBuffer> {
  const good = manifest({ package: 'com.example.app', minSdk: 24, targetSdk: 34 })
  const unit = 0x8010
  const run = count + 2 + (((unit & 0x7fff) << 16) | unit)
  const stringsStart = 28 + count * 4
  const poolSize = Math.ceil((stringsStart + run * 2) / 4) * 4
  const bytes = new Uint8Array(good.length + poolSize + 36 + count * 20)
  bytes.set(good)
  const v = new DataView(bytes.buffer)
  v.setUint32(4, bytes.length, true) // the document, grown by what follows
  const pool = good.length // the second pool: UTF-16, `count` strings, all inside the run
  v.setUint16(pool, 0x0001, true)
  v.setUint16(pool + 2, 28, true)
  v.setUint32(pool + 4, poolSize, true)
  v.setUint32(pool + 8, count, true)
  v.setUint32(pool + 20, stringsStart, true)
  for (let i = 0; i < count; i++) v.setUint32(pool + 28 + i * 4, i * 2, true)
  for (let i = 0; i < run; i++) v.setUint16(pool + stringsStart + i * 2, unit, true)
  const at = pool + poolSize // one element, no name of its own, an attribute named by each index
  v.setUint16(at, 0x0102, true)
  v.setUint16(at + 2, 16, true)
  v.setUint32(at + 4, 36 + count * 20, true)
  v.setUint32(at + 16, 0xffffffff, true)
  v.setUint32(at + 20, 0xffffffff, true)
  v.setUint16(at + 24, 20, true)
  v.setUint16(at + 26, 20, true)
  v.setUint16(at + 28, count, true)
  for (let i = 0; i < count; i++) {
    const a = at + 36 + i * 20
    v.setUint32(a, 0xffffffff, true) // no namespace, the name, no raw value, an integer
    v.setUint32(a + 4, i, true)
    v.setUint32(a + 8, 0xffffffff, true)
    v.setUint16(a + 12, 8, true)
    v.setUint8(a + 15, 0x10)
  }
  return bytes
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inspectApk on APKs the build tools wrote', () => {
  it('reads the name, versions and SDK levels, and the sharpest icon the APK holds', async () => {
    const inspection = await inspectApk(fixture('badge.apk'))
    expect(inspection).toMatchObject({
      platform: 'android',
      name: 'Badge Probe',
      bundleId: 'com.bauloc.badgeprobe',
      version: '1.4.0',
      build: '812',
      minOs: '26',
      android: { target_sdk: 35, debuggable: true, abis: [] },
      ios: null,
    })
    const icon = bitmapOf(inspection.icon)
    expect(icon?.mime).toBe('image/png')
    // The xhdpi one: the base's sharpest, since its xxhdpi icon was moved out to a split.
    expect(pngSize(icon!.bytes)).toEqual([96, 96])
  })

  it('refuses Android Studio’s Run output, and warns that it is debuggable', async () => {
    const inspection = await inspectApk(fixture('badge.apk'))
    expect(inspection.problems).toEqual([{ code: 'APK_TEST_ONLY' }])
    expect(inspection.warnings).toEqual([{ code: 'APK_DEBUGGABLE' }])
  })

  it('keeps an adaptive icon’s layers for the renderer, and follows a label to its string', async () => {
    expect(await inspectApk(fixture('badge-adaptive.apk'))).toEqual({
      platform: 'android',
      name: 'Adaptive Probe',
      bundleId: 'com.bauloc.badgeadaptive',
      version: '2.0',
      build: '7',
      minOs: '26',
      android: { target_sdk: 34, debuggable: false, abis: [] },
      ios: null,
      icon: {
        kind: 'badge',
        icon: {
          kind: 'adaptive',
          foreground: { mime: 'image/png', bytes: expect.any(Uint8Array) },
          background: { argb: 0xff447aee },
        },
      },
      problems: [],
      warnings: [],
    })
  })

  it('has no icon when the launcher’s is a vector, and keeps a literal label', async () => {
    expect(await inspectApk(fixture('badge-vector.apk'))).toMatchObject({
      name: 'Vector Probe',
      bundleId: 'com.bauloc.badgevector',
      icon: null,
      problems: [],
      warnings: [],
    })
  })

  it('refuses a split APK, naming the split', async () => {
    expect((await inspectApk(fixture('badge-config.vi.apk'))).problems).toEqual([
      { code: 'APK_SPLIT', detail: 'config.vi' },
    ])
    const abi = await inspectApk(await fromApks('splits/base-arm64_v8a.apk'))
    expect(abi.problems).toEqual([{ code: 'APK_SPLIT', detail: 'config.arm64_v8a' }])
    expect(abi.android?.abis).toEqual(['arm64-v8a'])
  })

  it('refuses bundletool’s base APK, which requires its ABI and density splits', async () => {
    const base = await inspectApk(await fromApks('splits/base-master.apk'))
    expect(base).toMatchObject({ bundleId: 'com.bauloc.bundleprobe', version: '1.0', build: '1' })
    expect(base.problems).toEqual([{ code: 'APK_SPLIT' }])
  })

  it('refuses an App Bundle renamed .apk', async () => {
    expect(await inspectApk(fixture('probe.aab'))).toMatchObject({
      platform: 'android',
      name: '',
      android: null,
      icon: null,
      problems: [{ code: 'APK_INVALID' }],
      warnings: [],
    })
  })
})

describe('inspectApk on APKs made here', () => {
  it('lists the ABIs of native code once each, sorted, from shared libraries only', async () => {
    const bytes = apk(
      {
        package: 'com.example.game',
        versionCode: 45,
        versionName: '1.2.0',
        minSdk: 24,
        targetSdk: 35,
        label: 'Game',
      },
      {
        abis: ['x86_64', 'arm64-v8a', 'armeabi-v7a'],
        extra: [
          { name: 'lib/arm64-v8a/libextra.so', data: 'more native code' },
          { name: 'lib/x86/wrap.sh', data: 'a wrap script, not a library' },
          { name: 'assets/lib/mips/libbundled.so', data: 'an asset, not native code' },
        ],
      },
    )
    expect(await inspectApk(blob(bytes))).toEqual({
      platform: 'android',
      name: 'Game',
      bundleId: 'com.example.game',
      version: '1.2.0',
      build: '45',
      minOs: '24',
      android: { target_sdk: 35, debuggable: false, abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'] },
      ios: null,
      icon: null,
      problems: [],
      warnings: [],
    })
  })

  it('refuses a test-only build, and only warns about a debuggable one', async () => {
    const testOnly = await inspectApk(blob(apk({ package: 'com.example.app', testOnly: true })))
    expect(testOnly.problems).toEqual([{ code: 'APK_TEST_ONLY' }])
    expect(testOnly.warnings).toEqual([])
    const debuggable = await inspectApk(blob(apk({ package: 'com.example.app', debuggable: true })))
    expect(debuggable.problems).toEqual([])
    expect(debuggable.warnings).toEqual([{ code: 'APK_DEBUGGABLE' }])
  })

  it('refuses a feature split, and a base flagged isSplitRequired by older tools', async () => {
    const feature = apk({ package: 'com.example.app', split: 'maps', isFeatureSplit: true })
    expect((await inspectApk(blob(feature))).problems).toEqual([
      { code: 'APK_SPLIT', detail: 'maps' },
    ])
    const required = makeZip([
      {
        name: 'AndroidManifest.xml',
        data: axml({
          name: 'manifest',
          attrs: { package: 'com.example.app', 'android:isSplitRequired': true },
          children: [{ name: 'application' }],
        }),
      },
    ])
    expect((await inspectApk(blob(required))).problems).toEqual([{ code: 'APK_SPLIT' }])
  })

  it('names the app by its package without a label, and its version by its code', async () => {
    expect(
      await inspectApk(blob(apk({ package: 'com.example.bare', versionCode: 3 }))),
    ).toMatchObject({
      name: 'com.example.bare',
      version: '3',
      build: '3',
      // What Android assumes when the manifest has no <uses-sdk>.
      minOs: '1',
      android: { target_sdk: 1 },
    })
    const spaced = await inspectApk(blob(apk({ package: 'com.example.app', label: '  Spaced  ' })))
    expect(spaced.name).toBe('Spaced')
  })

  it('writes a preview SDK by its codename', async () => {
    const preview = makeZip([
      {
        name: 'AndroidManifest.xml',
        data: axml({
          name: 'manifest',
          attrs: { package: 'com.example.preview', 'android:versionCode': 1 },
          children: [
            { name: 'uses-sdk', attrs: { 'android:minSdkVersion': 'Baklava' } },
            { name: 'application' },
          ],
        }),
      },
    ])
    expect((await inspectApk(blob(preview))).minOs).toBe('Baklava')
  })

  it('still reads an APK whose resources cannot be, with no name or icon from them', async () => {
    const bytes = apk(
      { package: 'com.example.app', label: { ref: 0x7f010000 }, icon: { ref: 0x7f020000 } },
      { extra: [{ name: 'resources.arsc', data: 'not a resource table' }] },
    )
    expect(await inspectApk(blob(bytes))).toMatchObject({
      name: 'com.example.app',
      icon: null,
      problems: [],
    })
  })
})

describe('inspectApk on files that are not APKs', () => {
  it('says so instead of throwing', async () => {
    const good = manifest({ package: 'com.example.app', versionCode: 1 })
    const notApks = {
      'an error page saved as .apk': new Blob(['<!doctype html><title>404</title>']),
      'a zip without a manifest': blob(makeZip([{ name: 'classes.dex', data: 'dex\n035' }])),
      'a text manifest': blob(
        makeZip([{ name: 'AndroidManifest.xml', data: '<manifest package="com.example.app"/>' }]),
      ),
      'a manifest cut short': blob(
        makeZip([{ name: 'AndroidManifest.xml', data: good.slice(0, 60) }]),
      ),
      'a download cut short': new Blob([fixtureBytes('badge.apk').subarray(0, 1500)]),
    }
    for (const [what, file] of Object.entries(notApks)) {
      expect(await inspectApk(file), what).toMatchObject({
        platform: 'android',
        android: null,
        problems: [{ code: 'APK_INVALID' }],
      })
    }
  })

  it('refuses a manifest without a package name, keeping what it read', async () => {
    const nameless = makeZip([
      {
        name: 'AndroidManifest.xml',
        data: axml({
          name: 'manifest',
          attrs: { 'android:versionCode': 9, 'android:versionName': '9.0' },
          children: [{ name: 'application' }],
        }),
      },
    ])
    expect(await inspectApk(blob(nameless))).toMatchObject({
      version: '9.0',
      problems: [{ code: 'APK_INVALID' }],
    })
  })

  it('refuses a manifest claiming more attributes than its elements hold, at once', async () => {
    const bomb = makeZip([{ name: 'AndroidManifest.xml', data: attributeBomb(600), method: 8 }])
    expect(bomb.length).toBeLessThan(512)
    const started = performance.now()
    expect((await inspectApk(blob(bomb))).problems).toEqual([{ code: 'APK_INVALID' }])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('refuses a manifest whose strings overlap, before decoding gigabytes of them', async () => {
    const bomb = makeZip([{ name: 'AndroidManifest.xml', data: stringBomb(1000), method: 8 }])
    expect(bomb.length).toBeLessThan(16 * 1024)
    const started = performance.now()
    expect((await inspectApk(blob(bomb))).problems).toEqual([{ code: 'APK_INVALID' }])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('refuses a file the browser can no longer read', async () => {
    const gone = new Blob([fixtureBytes('badge.apk')])
    Object.defineProperty(gone, 'slice', {
      value: () => ({
        arrayBuffer: () =>
          Promise.reject(new DOMException('The file changed.', 'NotReadableError')),
      }),
    })
    expect((await inspectApk(gone)).problems).toEqual([{ code: 'APK_INVALID' }])
  })

  it('says when this browser cannot unpack the compressed manifest', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    expect(await inspectApk(blob(apk({ package: 'com.example.app' })))).toMatchObject({
      platform: 'android',
      problems: [{ code: 'NO_INFLATE' }],
    })
  })
})

describe('inspectApk and signatures', () => {
  it('refuses an APK with no signature, as the installer would', async () => {
    const bare = apk({ package: 'com.example.app', label: 'App' })
    const inspection = await inspectApk(unsigned(bare))
    expect(inspection.problems).toEqual([{ code: 'APK_UNSIGNED' }])
    // Everything else is still read, so the sheet can say which app it is.
    expect(inspection).toMatchObject({ name: 'App', bundleId: 'com.example.app' })
    expect((await inspectApk(new Blob([fixtureBytes('badge-vector.apk')]))).problems).toEqual([
      { code: 'APK_UNSIGNED' },
    ])
    // Unsigned, whatever it targets: never also called v1-only.
    const recent = apk({ package: 'com.example.app', minSdk: 24, targetSdk: 34 })
    expect((await inspectApk(unsigned(recent))).problems).toEqual([{ code: 'APK_UNSIGNED' }])
  })

  it('takes a v2+ signing block in front of the central directory', async () => {
    const bare = apk({ package: 'com.example.app' })
    expect((await inspectApk(new Blob([signed(bare)]))).problems).toEqual([])
  })

  it('takes v2+ at any target, alone or beside a v1 signature', async () => {
    const recent = { package: 'com.example.app', minSdk: 24, targetSdk: 34 }
    expect((await inspectApk(blob(apk(recent)))).problems).toEqual([])
    expect((await inspectApk(blob(apk(recent, { extra: [JAR_SIGNATURE] })))).problems).toEqual([])
  })

  it('takes a v1 JAR signature, whatever the case of its name', async () => {
    for (const name of ['META-INF/CERT.RSA', 'META-INF/release.ec', 'META-INF/KEY.DSA']) {
      const v1 = apk({ package: 'com.example.app' }, { extra: [{ name, data: 'pkcs7' }] })
      expect((await inspectApk(unsigned(v1))).problems, name).toEqual([])
    }
  })

  it('refuses a v1 signature alone once the app targets API 30, as Android 11 does', async () => {
    const v1Only = (spec: Partial<ManifestSpec>) =>
      unsigned(apk({ package: 'com.example.app', minSdk: 24, ...spec }, { extra: [JAR_SIGNATURE] }))
    expect((await inspectApk(v1Only({ targetSdk: 29 }))).problems).toEqual([])
    for (const targetSdk of [30, 34]) {
      expect((await inspectApk(v1Only({ targetSdk }))).problems, String(targetSdk)).toEqual([
        { code: 'APK_V1_ONLY' },
      ])
    }
    // Without targetSdkVersion, Android takes the minimum for the target.
    expect((await inspectApk(v1Only({ minSdk: 30 }))).problems).toEqual([{ code: 'APK_V1_ONLY' }])
  })

  it('counts a preview SDK as newer than any release, so it needs v2 too', async () => {
    const preview = makeZip([
      {
        name: 'AndroidManifest.xml',
        data: axml({
          name: 'manifest',
          attrs: { package: 'com.example.preview' },
          children: [
            {
              name: 'uses-sdk',
              attrs: { 'android:minSdkVersion': 24, 'android:targetSdkVersion': 'Baklava' },
            },
            { name: 'application' },
          ],
        }),
      },
      JAR_SIGNATURE,
    ])
    expect((await inspectApk(unsigned(preview))).problems).toEqual([{ code: 'APK_V1_ONLY' }])
  })

  it('gives the benefit of the doubt when it cannot tell where the block would be', async () => {
    // A ZIP64 end record leaves the central directory's offset to a record of its own, and the
    // v2+ block ends where that directory starts.
    const spec = { package: 'com.example.app', minSdk: 24, targetSdk: 34 }
    const entries = [{ name: 'AndroidManifest.xml', data: manifest(spec), method: 8 }]
    for (const zip of [entries, [...entries, JAR_SIGNATURE]]) {
      expect((await inspectApk(unsigned(makeZip(zip, { zip64: true })))).problems).toEqual([])
    }
  })

  it('is not fooled by a signature file elsewhere, or by the magic at the wrong place', async () => {
    const elsewhere = apk(
      { package: 'com.example.app' },
      {
        extra: [
          { name: 'assets/META-INF/CERT.RSA', data: 'x' },
          { name: 'x.txt', data: 'APK Sig Block 42' },
        ],
      },
    )
    expect((await inspectApk(unsigned(elsewhere))).problems).toEqual([{ code: 'APK_UNSIGNED' }])
  })
})
