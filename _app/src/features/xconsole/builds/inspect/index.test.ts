import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeZip } from '@/features/device/backends/archive/__fixtures__/synth'

import { MAX_BUILD_BYTES, RELEASE_MAX_BYTES, WARN_BUILD_BYTES } from '../paths'
import type { BuildInspection } from '../types'
import { signed } from './__fixtures__/signed'
import { inspectApk } from './apk'
import { inspectBuild, platformOf } from './index'
import { inspectIpa } from './ipa'

/*
  The dispatcher: what it refuses before reading anything, and that it hands the rest to the
  right reader. The APK reader is the real one, watched; the IPA reader is a stand-in, since
  ipa.test.ts covers it. Sizes come from Files that claim a size they do not hold: no test
  writes 2 GB to say a build is too large.
*/

vi.mock('./apk', { spy: true })
vi.mock('./ipa', () => ({ inspectIpa: vi.fn() }))

const ZIP_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])

/** A file that says it is `size` bytes long, whatever it holds. */
function sized(name: string, size: number, content: Uint8Array<ArrayBuffer> = ZIP_HEAD): File {
  const file = new File([content], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const fixture = (name: string) =>
  readFileSync(new URL(`../../../device/backends/archive/__fixtures__/${name}`, import.meta.url))

/** What an IPA reader found: the dispatcher passes it on as it is, but for its size. */
const IPA_READ: BuildInspection = {
  platform: 'ios',
  name: 'Demo',
  bundleId: 'com.example.demo',
  version: '1.0',
  build: '7',
  minOs: '15.0',
  android: null,
  ios: { devices: ['iphone'], profile: null },
  icon: null,
  problems: [],
  warnings: [{ code: 'IPA_DEVELOPMENT' }],
}

/** The inspection of a file that was not read: its name, and why. */
const refused = (platform: 'android' | 'ios', name: string, code: string) => ({
  platform,
  name,
  bundleId: '',
  version: '',
  build: '',
  minOs: '',
  android: null,
  ios: null,
  icon: null,
  problems: [{ code }],
  warnings: [],
})

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('platformOf', () => {
  it('reads the platform from the extension, in any case', () => {
    expect(['App.apk', 'APP.APK', 'my.app.Apk'].map(platformOf)).toEqual([
      'android',
      'android',
      'android',
    ])
    expect(['App.ipa', 'App.IPA'].map(platformOf)).toEqual(['ios', 'ios'])
  })

  it('knows nothing else, App Bundles and split sets included', () => {
    for (const name of ['app.aab', 'app.apks', 'app.xapk', 'app.apk.zip', 'apk', 'app.', '']) {
      expect(platformOf(name), name).toBeNull()
    }
  })
})

describe('inspectBuild: what it answers without reading the build', () => {
  it('refuses a file not named .apk or .ipa, without opening it', async () => {
    expect(await inspectBuild(new File([ZIP_HEAD], 'photo.jpg'))).toEqual(
      refused('android', 'photo', 'NOT_A_BUILD'),
    )
    expect(inspectApk).not.toHaveBeenCalled()
    expect(inspectIpa).not.toHaveBeenCalled()
  })

  it('refuses a file named like a build that is not a zip, such as a saved error page', async () => {
    const page = new File(['<!doctype html><title>Not Found</title>'], 'Game.apk')
    expect(await inspectBuild(page)).toEqual(refused('android', 'Game', 'NOT_A_BUILD'))
    expect(await inspectBuild(new File([], 'Game.ipa'))).toEqual(
      refused('ios', 'Game', 'NOT_A_BUILD'),
    )
    expect(inspectApk).not.toHaveBeenCalled()
    expect(inspectIpa).not.toHaveBeenCalled()
  })

  it('refuses a build of 2 GB or more, which GitHub takes not even as a release file, unread', async () => {
    expect(await inspectBuild(sized('Big.apk', RELEASE_MAX_BYTES + 1))).toEqual(
      refused('android', 'Big', 'TOO_LARGE'),
    )
    expect(await inspectBuild(sized('Big.ipa', 3 * 1024 ** 3))).toEqual(
      refused('ios', 'Big', 'TOO_LARGE'),
    )
    expect(inspectApk).not.toHaveBeenCalled()
    expect(inspectIpa).not.toHaveBeenCalled()
  })

  it('reads a build of 100 MB or more, and says it goes to a release instead of the repo', async () => {
    vi.mocked(inspectIpa).mockResolvedValue(IPA_READ)
    for (const size of [MAX_BUILD_BYTES, RELEASE_MAX_BYTES]) {
      // Not LARGE as well: a release file does not grow the repo's history.
      expect(await inspectBuild(sized('Demo.ipa', size))).toEqual({
        ...IPA_READ,
        warnings: [{ code: 'IPA_DEVELOPMENT' }, { code: 'VIA_RELEASE' }],
      })
    }
    expect(inspectIpa).toHaveBeenCalledTimes(2)
  })

  it('reads a build just under the limit, and adds that it is large to what the reader says', async () => {
    vi.mocked(inspectIpa).mockResolvedValue(IPA_READ)
    expect(await inspectBuild(sized('Demo.ipa', MAX_BUILD_BYTES - 1))).toEqual({
      ...IPA_READ,
      warnings: [{ code: 'IPA_DEVELOPMENT' }, { code: 'LARGE' }],
    })
  })

  it('calls a build large from 50 MB, not below', async () => {
    vi.mocked(inspectIpa).mockResolvedValue(IPA_READ)
    const codes = async (size: number) =>
      (await inspectBuild(sized('Demo.ipa', size))).warnings.map((w) => w.code)
    expect(await codes(WARN_BUILD_BYTES)).toEqual(['IPA_DEVELOPMENT', 'LARGE'])
    expect(await codes(WARN_BUILD_BYTES - 1)).toEqual(['IPA_DEVELOPMENT'])
  })

  it('says when this browser cannot unpack a build, still naming it', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    expect(await inspectBuild(sized('Shop.apk', 60 * 1024 * 1024))).toEqual({
      ...refused('android', 'Shop', 'NO_INFLATE'),
      warnings: [{ code: 'LARGE' }],
    })
    expect(await inspectBuild(sized('Shop.apk', MAX_BUILD_BYTES))).toEqual({
      ...refused('android', 'Shop', 'NO_INFLATE'),
      warnings: [{ code: 'VIA_RELEASE' }],
    })
    expect(inspectApk).not.toHaveBeenCalled()
  })
})

describe('inspectBuild: reading the build', () => {
  it('hands an .ipa to the IPA reader, with the time to judge its profile by', async () => {
    vi.mocked(inspectIpa).mockResolvedValue(IPA_READ)
    const now = new Date('2026-10-07T08:15:00Z')
    const file = new File([ZIP_HEAD], 'Demo.IPA')
    expect(await inspectBuild(file, now)).toEqual(IPA_READ)
    expect(inspectIpa).toHaveBeenCalledWith(file, now)
    expect(inspectApk).not.toHaveBeenCalled()
  })

  it('hands an .apk to the APK reader, which reads a real one', async () => {
    const file = new File([signed(fixture('badge-adaptive.apk'))], 'Adaptive.APK')
    expect(await inspectBuild(file)).toMatchObject({
      platform: 'android',
      name: 'Adaptive Probe',
      bundleId: 'com.bauloc.badgeadaptive',
      version: '2.0',
      build: '7',
      icon: { kind: 'badge', icon: { kind: 'adaptive' } },
      problems: [],
      warnings: [],
    })
    expect(inspectApk).toHaveBeenCalledWith(file)
    expect(inspectIpa).not.toHaveBeenCalled()
  })

  it('names a build it could not read after its file', async () => {
    const zip = makeZip([{ name: 'classes.dex', data: 'dex\n035' }])
    expect(await inspectBuild(new File([zip], 'Nightly build.apk'))).toEqual(
      refused('android', 'Nightly build', 'APK_INVALID'),
    )
  })

  it('never rejects: a reader that fails, or a file that can no longer be read, is invalid', async () => {
    vi.mocked(inspectIpa).mockRejectedValue(new Error('unexpected'))
    expect(await inspectBuild(new File([ZIP_HEAD], 'Demo.ipa'))).toEqual(
      refused('ios', 'Demo', 'IPA_INVALID'),
    )

    const gone = new File([ZIP_HEAD], 'Gone.apk')
    Object.defineProperty(gone, 'slice', {
      value: () => ({
        arrayBuffer: () =>
          Promise.reject(new DOMException('The file changed.', 'NotReadableError')),
      }),
    })
    expect(await inspectBuild(gone)).toEqual(refused('android', 'Gone', 'APK_INVALID'))
  })
})
