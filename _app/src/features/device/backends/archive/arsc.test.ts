import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { argbOf, parseArsc, pickValue, type ResValue } from './arsc'
import { manifestInfo } from './axml'
import { openZip } from './zip'

/*
  On aapt2's own tables (badge*.apk, built for these tests; see axml.test.ts): every expected
  string is what `aapt2 dump resources` printed for the same file.
*/

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
async function tableOf(name: string) {
  const zip = await openZip(new Blob([fixture(name)]))
  const info = manifestInfo(await zip.bytes(zip.get('AndroidManifest.xml')!))
  return { info, table: parseArsc(await zip.bytes(zip.get('resources.arsc')!)) }
}

const LABEL = 0x7f020000
const ICON = 0x7f010000

describe('parseArsc', () => {
  it('lists a string in every configuration the table holds, three-letter languages included', async () => {
    const { table, info } = await tableOf('badge.apk')
    expect(info.labelId).toBe(LABEL)
    expect(table.typeName(LABEL)).toBe('string')
    expect(table.values(LABEL).map((v) => [v.config.language, v.config.region, v.str])).toEqual([
      ['', '', 'Badge Probe'],
      ['fil', '', 'Tsapa'],
      ['fr', '', 'Insigne'],
      ['iw', '', 'תג בדיקה'],
      ['en', 'GB', 'Badge Probe UK'],
    ])
  })

  it('finds the values a split took with it in the split’s own table', async () => {
    const vi = await tableOf('badge-config.vi.apk')
    expect(vi.table.values(LABEL).map((v) => [v.config.language, v.str])).toEqual([
      ['vi', 'Huy hiệu'],
    ])
    const xxhdpi = await tableOf('badge-config.xxhdpi.apk')
    expect(xxhdpi.table.values(ICON).map((v) => [v.config.density, v.str])).toEqual([
      [480, 'res/drawable-xxhdpi-v4/ic_launcher.png'],
    ])
    // aapt2 drops version qualifiers the app's minSdk (26) implies: "-v4" stays in the path only.
    const base = await tableOf('badge.apk')
    expect(base.table.values(ICON).map((v) => [v.config.density, v.config.sdk])).toEqual([
      [160, 0],
      [320, 0],
    ])
  })

  it('reads colours, references and anydpi files', async () => {
    const { table, info } = await tableOf('badge-adaptive.apk')
    const [alias] = table.values(info.labelId!)
    expect(alias).toMatchObject({ type: 0x01, data: 0x7f030001 })
    expect(table.values(0x7f030001)[0]?.str).toBe('Adaptive Probe')
    expect(table.values(info.iconId!)).toMatchObject([
      { str: 'res/mipmap-anydpi-v26/ic_launcher.xml', config: { density: 0xfffe } },
    ])
    expect(argbOf(table.values(0x7f010000)[0]!)).toBe(0xff447aee)
    expect(table.typeName(0x7f010000)).toBe('color')
  })

  it('has nothing for an id outside the table', async () => {
    const { table } = await tableOf('badge.apk')
    expect(table.values(0x7f7f0000)).toEqual([])
    expect(table.values(0x01040000)).toEqual([]) // the framework's, not the app's
    expect(table.typeName(0x7f7f0000)).toBe('')
  })

  it('refuses what is not a table, and a damaged one', async () => {
    expect(() => parseArsc(new Uint8Array(64))).toThrow('ARSC_NOT_A_TABLE')
    const zip = await openZip(new Blob([fixture('badge.apk')]))
    const bytes = await zip.bytes(zip.get('resources.arsc')!)
    const damaged = bytes.slice()
    new DataView(damaged.buffer).setUint32(4, bytes.length * 4, true) // the table claims more
    expect(() => parseArsc(damaged).values(LABEL)).toThrow('ARSC_CORRUPT')
  })
})

describe('pickValue', () => {
  const label = async () => {
    const base = (await tableOf('badge.apk')).table.values(LABEL)
    const vi = (await tableOf('badge-config.vi.apk')).table.values(LABEL)
    return [...base, ...vi]
  }
  const text = (v: ResValue | null) => v?.str

  it('takes the first of the phone’s languages the app has, an exact region first', async () => {
    const values = await label()
    expect(text(pickValue(values, { locales: ['vi-VN'] }))).toBe('Huy hiệu')
    expect(text(pickValue(values, { locales: ['en-GB'] }))).toBe('Badge Probe UK')
    expect(text(pickValue(values, { locales: ['en-US'] }))).toBe('Badge Probe')
    expect(text(pickValue(values, { locales: ['fr-CA'] }))).toBe('Insigne')
    expect(text(pickValue(values, { locales: ['he-IL'] }))).toBe('תג בדיקה')
    expect(text(pickValue(values, { locales: ['fil-PH'] }))).toBe('Tsapa')
    expect(text(pickValue(values, { locales: ['de-DE', 'fr-FR'] }))).toBe('Insigne')
  })

  it('falls back to the default, then to English', async () => {
    const values = await label()
    expect(text(pickValue(values, { locales: ['de-DE'] }))).toBe('Badge Probe')
    expect(text(pickValue(values))).toBe('Badge Probe')
    const noDefault = values.filter((v) => v.config.language !== '')
    expect(text(pickValue(noDefault, { locales: ['de-DE'] }))).toBe('Badge Probe UK')
  })

  it('picks the density Android would, and passes over values for newer Android versions', async () => {
    const base = (await tableOf('badge.apk')).table.values(ICON)
    const split = (await tableOf('badge-config.xxhdpi.apk')).table.values(ICON)
    const all = [...base, ...split]
    expect(text(pickValue(all, { density: 420 }))).toBe('res/drawable-xxhdpi-v4/ic_launcher.png')
    expect(text(pickValue(all, { density: 320 }))).toBe('res/drawable-xhdpi-v4/ic_launcher.png')
    expect(text(pickValue(all, { density: 120 }))).toBe('res/drawable-mdpi-v4/ic_launcher.png')
  })

  it('passes over values for newer Android versions, and night-only or device-class ones', () => {
    const config = { language: '', region: '', density: 0, sdk: 0, night: 0, other: false }
    const value = (str: string, extra: Partial<ResValue['config']> = {}): ResValue => ({
      type: 0x03,
      data: 0,
      str,
      config: { ...config, ...extra },
    })
    const values = [
      value('plain'),
      value('android-12', { sdk: 31 }),
      value('night', { night: 2 }),
      value('television', { other: true }),
    ]
    expect(text(pickValue(values, { sdk: 30 }))).toBe('plain')
    expect(text(pickValue(values, { sdk: 33 }))).toBe('android-12')
    expect(text(pickValue([values[3]!], { sdk: 33 }))).toBe('television')
    expect(pickValue([values[2]!])).toBeNull()
  })
})

describe('argbOf', () => {
  it('expands every colour encoding to 0xAARRGGBB', () => {
    expect(argbOf({ type: 0x1c, data: 0x80112233 })).toBe(0x80112233)
    expect(argbOf({ type: 0x1d, data: 0x112233 })).toBe(0xff112233)
    expect(argbOf({ type: 0x1e, data: 0x8123 })).toBe(0x88112233)
    expect(argbOf({ type: 0x1f, data: 0x123 })).toBe(0xff112233)
    expect(argbOf({ type: 0x03, data: 1 })).toBeNull()
  })
})
