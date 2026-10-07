import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  crc32,
  makeZip,
  PNG_1PX,
  type SynthEntry,
} from '@/features/device/backends/archive/__fixtures__/synth'

import { inspectIpa } from './ipa'
import { decodeCgbi } from './png'

/*
  IPAs made in memory, every entry DEFLATE as Xcode's export writes them, from the fixtures
  Apple's tools made (__fixtures__/make-fixtures.sh): the Info.plist in both forms, actool's
  CgBI icon, and a synthetic Ad Hoc profile. Other Info.plists and profiles are written here.
*/

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))

/** When the tests run: the fixture profile expires on 2027-09-01. */
const NOW = new Date('2026-10-07T08:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ipa(files: Readonly<Record<string, Uint8Array | string>>): Blob {
  const entries: SynthEntry[] = Object.entries(files).map(([name, data]) => ({
    name,
    data,
    method: 8,
  }))
  return new Blob([makeZip(entries)])
}

type Value = string | number | boolean | Date | Value[] | { [key: string]: Value }

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function encode(value: Value): string {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`
  if (typeof value === 'number') return `<integer>${String(value)}</integer>`
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (value instanceof Date) return `<date>${iso(value.getTime())}</date>`
  if (Array.isArray(value)) return `<array>${value.map(encode).join('')}</array>`
  const entries = Object.entries(value).map(([k, v]) => `<key>${escapeXml(k)}</key>${encode(v)}`)
  return `<dict>${entries.join('')}</dict>`
}

const plist = (value: Value) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${encode(value)}\n</plist>\n`

const INFO = {
  CFBundleExecutable: 'Probe',
  CFBundleIdentifier: 'com.bauloc.probe',
  CFBundleShortVersionString: '2.0',
  CFBundleVersion: '7',
  MinimumOSVersion: '16.0',
}

/** A profile in an envelope of junk; ad hoc for two devices unless `fields` say otherwise. */
const profile = (fields: { [key: string]: Value }) =>
  Uint8Array.from([
    0x30,
    0x82,
    0xff,
    0x00,
    ...new TextEncoder().encode(
      plist({
        Entitlements: { 'get-task-allow': false },
        ExpirationDate: new Date(NOW.getTime() + 300 * DAY),
        Name: 'Probe Profile',
        ProvisionedDevices: ['00000000-0000000000000001', '00000000-0000000000000002'],
        TeamName: 'Probe Team',
        ...fields,
      }),
    ),
    0xa0,
    0x80,
  ])

/** An app with this Info.plist, the Ad Hoc profile, and the given extra files in its folder. */
const app = (info: { [key: string]: Value }, files: Record<string, Uint8Array | string> = {}) =>
  ipa({
    'Payload/Probe.app/Info.plist': plist({ ...INFO, ...info }),
    'Payload/Probe.app/embedded.mobileprovision': profile({}),
    ...Object.fromEntries(
      Object.entries(files).map(([name, data]) => [`Payload/Probe.app/${name}`, data]),
    ),
  })

/** A PNG of `side` × `side` transparent pixels, `label` in a tEXt chunk telling it apart. */
function squarePng(side: number, label: string): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data])
    const out = new Uint8Array(8 + body.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(body, 4)
    view.setUint32(4 + body.length, crc32(body))
    return out
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, side)
  new DataView(header.buffer).setUint32(4, side)
  header.set([8, 6], 8) // 8 bits per channel, RGBA
  // Each row: filter 0, then its pixels, all zero.
  const rows = new Uint8Array((1 + side * 4) * side)
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', new TextEncoder().encode(`Comment\0${label}`)),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    png.set(part, at)
    at += part.length
  }
  return png
}

const INVALID = {
  platform: 'ios',
  name: '',
  bundleId: '',
  version: '',
  build: '',
  minOs: '',
  android: null,
  ios: null,
  icon: null,
  problems: [{ code: 'IPA_INVALID' }],
  warnings: [],
}

describe('inspectIpa', () => {
  it('reads an app as Xcode exports it for Ad Hoc', async () => {
    const icon = fixture('appicon-cgbi.png')
    const executable = new Uint8Array(1024 * 1024).map((_, i) => (i * 2654435761) >>> 24)
    const file = ipa({
      'Payload/Probe.app/_CodeSignature/CodeResources': plist({ files: {} }),
      'Payload/Probe.app/AppIcon60x60@2x.png': icon,
      'Payload/Probe.app/Assets.car': 'compiled assets',
      'Payload/Probe.app/embedded.mobileprovision': fixture('adhoc.mobileprovision'),
      'Payload/Probe.app/Frameworks/Kit.framework/Info.plist': plist({ CFBundleName: 'Kit' }),
      'Payload/Probe.app/Info.plist': fixture('info.binary.plist'),
      'Payload/Probe.app/LaunchScreen.png': PNG_1PX,
      'Payload/Probe.app/PlugIns/Widget.appex/Info.plist': plist({ CFBundleName: 'Widget' }),
      'Payload/Probe.app/Probe': executable,
      'Payload/Probe.app/Watch/Probe Watch.app/Info.plist': plist({ CFBundleName: 'Watch' }),
      '__MACOSX/Payload/Probe.app/Info.plist': 'resource fork',
      'Symbols/Probe.symbols': 'symbols',
    })
    const slice = vi.spyOn(Blob.prototype, 'slice')

    const inspection = await inspectIpa(file, NOW)

    expect(inspection).toMatchObject({
      platform: 'ios',
      name: 'Thử Nghiệm',
      bundleId: 'com.bauloc.probe',
      version: '1.2.0',
      build: '45',
      minOs: '15.0',
      android: null,
      ios: {
        devices: ['iphone', 'ipad'],
        profile: {
          kind: 'ad-hoc',
          name: 'Probe Ad Hoc',
          team: 'Probe Team & Co.',
          expires: '2027-09-01T10:00:00Z',
          device_count: 3,
        },
      },
      problems: [],
      warnings: [],
    })
    expect(inspection.icon).toEqual({ kind: 'rgba', ...(await decodeCgbi(icon)) })
    // The directory and the entries it needs; never the megabyte of executable.
    const read = slice.mock.calls.reduce((sum, [start = 0, end = 0]) => sum + (end - start), 0)
    expect(read).toBeLessThan(256 * 1024)
  })

  it('reads an XML Info.plist the same', async () => {
    const file = ipa({
      'Payload/Probe.app/Info.plist': fixture('info.xml.plist'),
      'Payload/Probe.app/embedded.mobileprovision': fixture('adhoc.mobileprovision'),
    })
    expect(await inspectIpa(file, NOW)).toMatchObject({
      name: 'Thử Nghiệm',
      bundleId: 'com.bauloc.probe',
      version: '1.2.0',
      build: '45',
      ios: { devices: ['iphone', 'ipad'], profile: { kind: 'ad-hoc' } },
      icon: null,
      problems: [],
    })
  })

  it('names the app as its home screen does, down to its folder', async () => {
    const named = async (info: { [key: string]: Value }) => (await inspectIpa(app(info), NOW)).name
    expect(await named({ CFBundleDisplayName: ' Probe Display ', CFBundleName: 'Name' })).toBe(
      'Probe Display',
    )
    expect(await named({ CFBundleDisplayName: '  ', CFBundleName: 'Probe Name' })).toBe(
      'Probe Name',
    )
    expect(await named({})).toBe('Probe')
    const bare = ipa({ 'Payload/Bare App.app/Info.plist': plist({ CFBundleIdentifier: 'x.y' }) })
    expect(await inspectIpa(bare, NOW)).toMatchObject({
      name: 'Bare App',
      version: '',
      build: '',
      minOs: '',
    })
  })

  it('reads the devices from UIDeviceFamily, iPhone when it names none', async () => {
    const devices = async (family?: Value) =>
      (await inspectIpa(app(family === undefined ? {} : { UIDeviceFamily: family }), NOW)).ios
        ?.devices
    expect(await devices()).toEqual(['iphone'])
    expect(await devices([1])).toEqual(['iphone'])
    expect(await devices([2])).toEqual(['ipad'])
    expect(await devices([2, 1])).toEqual(['iphone', 'ipad'])
    expect(await devices(['2'])).toEqual(['ipad'])
    expect(await devices(2)).toEqual(['ipad'])
    expect(await devices([6])).toEqual(['iphone'])
  })

  it('tells who may install it, from the profile', async () => {
    const read = (fields: { [key: string]: Value } | null) =>
      inspectIpa(
        ipa({
          'Payload/Probe.app/Info.plist': plist(INFO),
          ...(fields ? { 'Payload/Probe.app/embedded.mobileprovision': profile(fields) } : {}),
        }),
        NOW,
      )
    expect(await read({ Entitlements: { 'get-task-allow': true } })).toMatchObject({
      ios: { profile: { kind: 'development', device_count: 2 } },
      problems: [],
      warnings: [{ code: 'IPA_DEVELOPMENT' }],
    })
    expect(await read({ ProvisionsAllDevices: true })).toMatchObject({
      ios: { profile: { kind: 'enterprise', team: 'Probe Team', device_count: null } },
      problems: [],
      warnings: [],
    })
    // Not a list of devices is as good as none: an App Store profile lists none.
    const appStore = { ProvisionedDevices: false }
    expect(await read(appStore)).toMatchObject({
      ios: { profile: { kind: 'app-store' } },
      problems: [{ code: 'IPA_APP_STORE' }],
    })
    expect(await read(null)).toMatchObject({
      ios: { profile: null },
      problems: [{ code: 'IPA_NO_PROFILE' }],
      warnings: [],
    })
  })

  it('does not block a profile it cannot read', async () => {
    const file = ipa({
      'Payload/Probe.app/Info.plist': plist(INFO),
      'Payload/Probe.app/embedded.mobileprovision': Uint8Array.from([0x30, 0x82, 1, 2, 3]),
    })
    expect(await inspectIpa(file, NOW)).toMatchObject({
      ios: {
        profile: { kind: 'unknown', name: '', team: '', expires: '', device_count: null },
      },
      problems: [],
      warnings: [],
    })
  })

  it('measures the profile’s expiry against now', async () => {
    const expiring = async (days: number, fields: { [key: string]: Value } = {}) => {
      const expires = new Date(NOW.getTime() + days * DAY)
      const file = ipa({
        'Payload/Probe.app/Info.plist': plist(INFO),
        'Payload/Probe.app/embedded.mobileprovision': profile({
          ExpirationDate: expires,
          ...fields,
        }),
      })
      const { problems, warnings } = await inspectIpa(file, NOW)
      return { problems, warnings }
    }
    const at = (days: number) => iso(NOW.getTime() + days * DAY)
    expect(await expiring(-1)).toEqual({
      problems: [{ code: 'IPA_EXPIRED', detail: at(-1) }],
      warnings: [],
    })
    expect(await expiring(0)).toEqual({
      problems: [{ code: 'IPA_EXPIRED', detail: at(0) }],
      warnings: [],
    })
    expect(await expiring(10)).toEqual({
      problems: [],
      warnings: [{ code: 'IPA_EXPIRES_SOON', detail: at(10) }],
    })
    expect(await expiring(13.9)).toMatchObject({ warnings: [{ code: 'IPA_EXPIRES_SOON' }] })
    expect(await expiring(14)).toEqual({ problems: [], warnings: [] })
    expect(await expiring(5, { Entitlements: { 'get-task-allow': true } })).toEqual({
      problems: [],
      warnings: [{ code: 'IPA_DEVELOPMENT' }, { code: 'IPA_EXPIRES_SOON', detail: at(5) }],
    })
    expect(await expiring(-30, { ProvisionedDevices: false })).toEqual({
      problems: [{ code: 'IPA_APP_STORE' }, { code: 'IPA_EXPIRED', detail: at(-30) }],
      warnings: [],
    })
  })

  it('measures against the present by default', async () => {
    const file = ipa({
      'Payload/Probe.app/Info.plist': plist(INFO),
      'Payload/Probe.app/embedded.mobileprovision': profile({
        ExpirationDate: new Date('2000-01-01T00:00:00Z'),
      }),
    })
    expect((await inspectIpa(file)).problems).toEqual([
      { code: 'IPA_EXPIRED', detail: '2000-01-01T00:00:00Z' },
    ])
  })
})

describe('inspectIpa, the icon', () => {
  const icons = { CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60'] } } }
  const ipadIcons = {
    'CFBundleIcons~ipad': {
      CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60', 'AppIcon76x76'] },
    },
  }
  const iconOf = async (info: { [key: string]: Value }, files: Record<string, Uint8Array>) =>
    (await inspectIpa(app(info, files), NOW)).icon
  const plain = fixture('icon.png')

  it('takes the widest of the files the app names, a plain PNG as its bytes', async () => {
    expect(
      await iconOf(
        { ...icons, ...ipadIcons },
        {
          'AppIcon60x60@2x.png': PNG_1PX,
          'AppIcon76x76@2x~ipad.png': plain,
          'Other@3x.png': fixture('appicon.png'),
        },
      ),
    ).toEqual({ kind: 'image', mime: 'image/png', bytes: plain })
  })

  it('finds the names of older apps, in any case', async () => {
    const infos: { [key: string]: Value }[] = [
      { CFBundleIconFile: 'Icon.png' },
      { CFBundleIconFiles: ['icon'] },
      { CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'ICON' } } },
    ]
    for (const info of infos) {
      expect(await iconOf(info, { 'Icon@2x.PNG': plain, 'Default.png': PNG_1PX })).toEqual({
        kind: 'image',
        mime: 'image/png',
        bytes: plain,
      })
    }
  })

  it('falls back on AppIcon files in the bundle’s root, and nowhere else', async () => {
    const found = await iconOf({}, { 'AppIcon60x60@2x.png': plain, 'Default.png': PNG_1PX })
    expect(found).toMatchObject({ kind: 'image', bytes: plain })
    expect(await iconOf({}, { 'Sub/AppIcon.png': plain, 'Icon.png': plain })).toBeNull()
    expect(await iconOf(icons, {})).toBeNull()
    // Only a size, a scale and an idiom may follow the set's name: no alternate's files match.
    const alternate = await iconOf(
      { CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } } },
      { 'AppIcon-Dark60x60@3x.png': squarePng(180, 'dark'), 'AppIcon60x60@2x.png': plain },
    )
    expect(alternate).toMatchObject({ kind: 'image', bytes: plain })
  })

  /**
   * An app with alternate icons named AppIcon-Dark, AppIconHoliday and AppIcon2, as actool
   * lays them out for a deployment target of iOS 14 or earlier: each set's files in the
   * bundle's root at the same sizes, CFBundleIcons listing them apart. Below iOS 11 a
   * 1024-pixel file joins each set, and the primary's list. "AppIcon" starts every name; the
   * alternates come first in the zip.
   */
  function withAlternates(below11: boolean) {
    const sizes = { '60x60@2x.png': 120, '76x76@2x~ipad.png': 152, '1024x1024.png': 1024 }
    const files: Record<string, Uint8Array> = {}
    const alternates: { [key: string]: Value } = {}
    for (const set of ['AppIcon-Dark', 'AppIconHoliday', 'AppIcon2', 'AppIcon']) {
      for (const [rest, side] of Object.entries(sizes)) {
        if (side < 1024 || below11) files[set + rest] = squarePng(side, set)
      }
      if (set !== 'AppIcon') {
        alternates[set] = {
          CFBundleIconFiles: [`${set}60x60`, `${set}76x76`],
          CFBundleIconName: set,
        }
      }
    }
    /** One idiom's CFBundleIcons, its primary icon listing `names`. */
    const idiom = (names: string[]) => ({
      CFBundleAlternateIcons: alternates,
      CFBundlePrimaryIcon: { CFBundleIconFiles: names, CFBundleIconName: 'AppIcon' },
    })
    const info = {
      CFBundleIcons: idiom(below11 ? ['AppIcon60x60', 'AppIcon1024x1024'] : ['AppIcon60x60']),
      'CFBundleIcons~ipad': idiom(['AppIcon60x60', 'AppIcon76x76']),
    }
    return { info, files }
  }

  it('tries at most 64 of the names an app lists', async () => {
    // Each name is tried against every PNG in the bundle's root, and a real app lists a
    // handful: thousands of names beside thousands of PNGs would hang the tab.
    const decoys = Array.from({ length: 64 }, (_, i) => `Decoy${String(i)}`)
    const listing = (names: string[]) => ({ CFBundleIconFiles: [...names, 'Icon-60'] })
    const files = { 'Icon-60@2x.png': plain }
    expect(await iconOf(listing(decoys.slice(1)), files)).toMatchObject({ bytes: plain })
    expect(await iconOf(listing(decoys), files)).toBeNull()
  })

  it('keeps to the primary icon’s files, though actool names alternates after it', async () => {
    for (const [below11, primary] of [
      [false, 'AppIcon76x76@2x~ipad.png'],
      [true, 'AppIcon1024x1024.png'],
    ] as const) {
      const { info, files } = withAlternates(below11)
      expect(await iconOf(info, files), primary).toEqual({
        kind: 'image',
        mime: 'image/png',
        bytes: files[primary],
      })
    }
  })

  it('passes over a file that is no PNG, and a damaged one, for the next widest', async () => {
    const cgbi = fixture('appicon-cgbi.png')
    // IHDR promising 512 × 512 (its width and height start at byte 32), then the data cut off.
    const damaged = cgbi.slice(0, 200)
    damaged.set([0, 0, 2, 0, 0, 0, 2, 0], 32)
    const icon = await iconOf(icons, {
      'AppIcon60x60@3x.png': damaged,
      'AppIcon60x60@2x.png': cgbi,
      'AppIcon60x60.png': new TextEncoder().encode('not an image'),
    })
    expect(icon).toMatchObject({ kind: 'rgba', width: 120, height: 120 })
  })
})

describe('inspectIpa, files it cannot read', () => {
  it('answers IPA_INVALID, never throwing', async () => {
    const info = plist(INFO)
    for (const [what, file] of [
      ['not a zip', new Blob(['PK\x03\x04 but nothing more'])],
      ['an empty file', new Blob([])],
      ['no app', ipa({ 'Payload/readme.txt': 'hello' })],
      ['an app without Info.plist', ipa({ 'Payload/Probe.app/Probe': 'code' })],
      ['only nested apps', ipa({ 'Payload/Probe.app/PlugIns/X.appex/Info.plist': info })],
      ['an app outside Payload', ipa({ 'Probe.app/Info.plist': info })],
      ['two apps', ipa({ 'Payload/One.app/Info.plist': info, 'Payload/Two.app/Info.plist': info })],
      ['an Info.plist that is no plist', ipa({ 'Payload/Probe.app/Info.plist': 'not a plist' })],
      ['an Info.plist that is no dictionary', ipa({ 'Payload/Probe.app/Info.plist': plist([]) })],
      [
        'no bundle identifier',
        ipa({ 'Payload/Probe.app/Info.plist': plist({ ...INFO, CFBundleIdentifier: ' ' }) }),
      ],
    ] as const) {
      expect(await inspectIpa(file, NOW), what).toEqual(INVALID)
    }
  })

  it('answers NO_INFLATE when it is this browser that cannot read the app', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    expect(await inspectIpa(app({}), NOW)).toEqual({
      ...INVALID,
      problems: [{ code: 'NO_INFLATE' }],
    })
  })
})
