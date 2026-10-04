import { describe, expect, it } from 'vitest'

import type { IosFacts, SimFacts } from '../helper/protocol'
import { detailMarkdown } from '../model'
import {
  fmtDecimalBytes,
  fmtEcid,
  iosAvailable,
  iosDetail,
  iosModelName,
  simulatorDetail,
} from './ios'
import models from './ios-models.json'

/*
  The iOS detail pane, on facts shaped as the helper sends them: a trusted iPhone 12 Pro over
  lockdown (the real phone’s values, its name, UDID, serial and ECID made up), the same phone
  locked so iOS withheld battery and storage, one this Mac isn't paired with (plaintext), an
  iOS 15 phone without Developer Mode, and a simulator.
*/

const FULL: IosFacts = {
  udid: '00008101-000A1B2C3D4E5F02',
  connection: 'usb',
  source: 'lockdown',
  device: {
    DeviceName: 'Ngọc’s iPhone 12 Pro',
    DeviceClass: 'iPhone',
    ProductType: 'iPhone13,3',
    ProductVersion: '27.0',
    BuildVersion: '24A437',
    SerialNumber: 'F2LZZ0FAKE01',
    HardwareModel: 'D53pAP',
    ModelNumber: 'MGLQ3',
    RegionInfo: 'LL/A',
    CPUArchitecture: 'arm64e',
    TimeZone: 'Asia/Ho_Chi_Minh',
    UniqueChipID: '2844626588163842',
  },
  battery: {
    BatteryCurrentCapacity: 87,
    BatteryIsCharging: true,
    ExternalConnected: true,
    FullyCharged: false,
  },
  disk: {
    TotalDiskCapacity: 256_000_000_000,
    TotalDataCapacity: 247_531_839_488,
    TotalDataAvailable: 160_951_455_744,
    AmountDataAvailable: 40_063_803_392,
  },
  international: { Language: 'en', Locale: 'en_VN' },
  developerMode: true,
  locked: false,
  withheld: [],
}

describe('iosDetail', () => {
  it('reads a trusted iPhone in Apple’s own words', () => {
    expect(iosDetail(FULL, 'USB (local helper)')).toEqual({
      platform: 'ios',
      identity: {
        'Device name': 'Ngọc’s iPhone 12 Pro',
        Model: 'iPhone 12 Pro',
        'Model identifier': 'iPhone13,3',
        'Model number': 'MGLQ3LL/A',
        Serial: 'F2LZZ0FAKE01',
        Identifier: '00008101-000A1B2C3D4E5F02',
        // The UDID's second half, as Apple's tools print an ECID.
        ECID: '0x000A1B2C3D4E5F02',
      },
      software: { iOS: '27.0', Build: '24A437', 'Developer Mode': 'On', Pairing: 'Paired' },
      hardware: {
        'Hardware model': 'D53pAP',
        'CPU architecture': 'arm64e',
        Capacity: '256 GB',
        Language: 'en',
        Locale: 'en_VN',
        'Time zone': 'Asia/Ho_Chi_Minh',
      },
      status: {
        Battery: '87% · charging',
        // Free now, and what iOS can clear: Settings shows neither, so both are said.
        Available: '40.1 GB free · up to 161 GB as iOS clears caches',
        Lock: 'Unlocked',
        Connection: 'USB (local helper)',
        'Details note': '',
      },
    })
  })

  it('copies no note and no empty field into a ticket', () => {
    const md = detailMarkdown(iosDetail(FULL, 'Wi‑Fi (local helper)'), new Date())
    expect(md).toContain('| Connection | `Wi‑Fi (local helper)` |')
    expect(md).toContain('| Capacity | `256 GB` |')
    expect(md).not.toMatch(/note/i)
  })

  it('says to unlock when iOS withheld battery and storage, and leaves them empty', () => {
    const locked: IosFacts = {
      ...FULL,
      battery: undefined,
      disk: undefined,
      international: undefined,
      developerMode: null,
      locked: true,
      withheld: ['battery', 'disk', 'international', 'developerMode'],
    }
    const d = iosDetail(locked, 'USB (local helper)')
    expect(d.status).toEqual({
      Battery: '',
      Available: '',
      Lock: 'Locked',
      Connection: 'USB (local helper)',
      'Details note': 'Unlock the device to read battery and storage.',
    })
    expect(d.hardware.Capacity).toBe('')
    expect(d.software['Developer Mode']).toBe('')
  })

  it('reads a phone this Mac isn’t paired with as basic identifiers only', () => {
    const plaintext: IosFacts = {
      udid: FULL.udid,
      connection: 'usb',
      source: 'plaintext',
      device: {
        DeviceName: 'iPhone',
        ProductType: 'iPhone13,3',
        ProductVersion: '27.0',
        BuildVersion: '24A437',
      },
      developerMode: null,
      locked: null,
      withheld: ['battery', 'disk', 'international', 'developerMode'],
    }
    const d = iosDetail(plaintext, 'USB (local helper)')
    expect(d.software).toEqual({
      iOS: '27.0',
      Build: '24A437',
      'Developer Mode': '',
      Pairing: 'Not paired',
    })
    expect(d.identity).toMatchObject({
      Serial: '',
      ECID: '',
      'Model number': '',
      Model: 'iPhone 12 Pro',
    })
    expect(d.status.Lock).toBe('')
    expect(d.status['Details note']).toBe(
      'Only the basic identifiers are available; the environment check says why.',
    )
  })

  it('leaves Developer Mode empty on iOS 15, which has none', () => {
    const ios15: IosFacts = {
      ...FULL,
      device: { ...FULL.device, ProductType: 'iPhone12,8', ProductVersion: '15.8.3' },
      developerMode: null,
    }
    const d = iosDetail(ios15, 'USB (local helper)')
    expect(d.software['Developer Mode']).toBe('')
    expect(d.identity.Model).toBe('iPhone SE (2nd generation)')
    expect(iosDetail({ ...FULL, developerMode: false }, '').software['Developer Mode']).toBe('Off')
  })

  it('falls back to the identifier for a phone newer than the table', () => {
    const d = iosDetail({ ...FULL, device: { ...FULL.device, ProductType: 'iPhone99,1' } }, '')
    expect(d.identity.Model).toBe('iPhone99,1')
  })

  it('says one figure when only one came, or both round the same', () => {
    const available = (disk: IosFacts['disk']) => iosDetail({ ...FULL, disk }, '').status.Available
    expect(available({ AmountDataAvailable: 40_063_803_392 })).toBe('40.1 GB free')
    expect(available({ TotalDataAvailable: 160_951_455_744 })).toBe('161 GB free')
    expect(
      available({ AmountDataAvailable: 40_301_000_000, TotalDataAvailable: 40_304_000_000 }),
    ).toBe('40.3 GB free')
    expect(available({ TotalDiskCapacity: 256_000_000_000 })).toBe('')
  })

  it('reads the iPhone the lead measured as Settings would explain it', () => {
    // Settings said 74.41 GB; lockdown: 40.30 GB free now, 161.04 GB with what iOS can clear.
    expect(
      iosAvailable({ AmountDataAvailable: 40_300_000_000, TotalDataAvailable: 161_040_000_000 }),
    ).toBe('40.3 GB free · up to 161 GB as iOS clears caches')
  })
})

describe('simulatorDetail', () => {
  const sim: SimFacts = {
    udid: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
    name: 'iPhone 17 Pro',
    deviceType: { name: 'iPhone 17 Pro', modelIdentifier: 'iPhone18,1' },
    runtime: { name: 'iOS 27.0', version: '27.0', build: '24A5300a' },
    state: 'Booted',
    dataPathSize: 1_234_567_890,
  }

  it('reads a booted simulator', () => {
    expect(simulatorDetail(sim)).toEqual({
      platform: 'ios',
      identity: {
        'Device name': 'iPhone 17 Pro',
        Model: 'iPhone 17 Pro',
        'Model identifier': 'iPhone18,1',
        Identifier: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
      },
      software: { iOS: '27.0', Build: '24A5300a' },
      hardware: {},
      status: { Storage: '1.1 GB used', Connection: 'Simulator' },
    })
  })

  it('leaves Storage empty when simctl didn’t say', () => {
    expect(simulatorDetail({ ...sim, dataPathSize: undefined }).status.Storage).toBe('')
  })
})

describe('fmtDecimalBytes', () => {
  it('counts as Apple does, in 1000s, three significant figures at most', () => {
    expect(fmtDecimalBytes(256_000_000_000)).toBe('256 GB')
    expect(fmtDecimalBytes(64_000_000_000)).toBe('64 GB')
    expect(fmtDecimalBytes(1_000_000_000_000)).toBe('1 TB')
    expect(fmtDecimalBytes(98_765_432_100)).toBe('98.8 GB')
    expect(fmtDecimalBytes(1_234_567_890)).toBe('1.23 GB')
    expect(fmtDecimalBytes(512)).toBe('512 B')
    expect(fmtDecimalBytes(0)).toBe('0 B')
  })

  it('says nothing for a value that isn’t one', () => {
    expect(fmtDecimalBytes(undefined)).toBe('')
    expect(fmtDecimalBytes(null)).toBe('')
    expect(fmtDecimalBytes(Number.NaN)).toBe('')
    expect(fmtDecimalBytes(-1)).toBe('')
  })
})

describe('fmtEcid', () => {
  it('prints the decimal string as 16 hex digits, past 2^53 without rounding', () => {
    expect(fmtEcid('2844626588163842')).toBe('0x000A1B2C3D4E5F02')
    expect(fmtEcid('18446744073709550001')).toBe('0xFFFFFFFFFFFFF9B1')
  })

  it('shows anything else as it came', () => {
    expect(fmtEcid(undefined)).toBe('')
    expect(fmtEcid('')).toBe('')
    expect(fmtEcid('0x1E')).toBe('0x1E')
    expect(fmtEcid('99999999999999999999')).toBe('99999999999999999999')
  })
})

describe('iosModelName', () => {
  it('names the phones testers use, from Xcode’s own table', () => {
    expect(iosModelName('iPhone13,3')).toBe('iPhone 12 Pro')
    expect(iosModelName('iPhone18,1')).toBe('iPhone 17 Pro')
    expect(iosModelName('iPad13,1')).toBe('iPad Air (4th generation)')
  })

  it('is empty for an unknown identifier, and never reads the object’s prototype', () => {
    expect(iosModelName('iPhone99,1')).toBe('')
    expect(iosModelName('')).toBe('')
    expect(iosModelName('toString')).toBe('')
    expect(iosModelName('__proto__')).toBe('')
  })

  it('is sorted, deduplicated and complete', () => {
    const ids = Object.keys(models)
    expect(ids.length).toBeGreaterThanOrEqual(182)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))).toEqual(ids)
    for (const name of Object.values(models)) expect(name.trim()).toBe(name)
  })
})
