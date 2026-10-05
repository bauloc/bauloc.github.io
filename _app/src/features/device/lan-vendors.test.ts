import { describe, expect, it } from 'vitest'

import * as VENDORS from './lan-vendors.data'
import { loadVendors, vendorLookup, type VendorTable } from './lan-vendors'

/*
  The vendor table: its compact format read back (gap-coded prefixes and maker indexes in
  base-32 varints, makers with the kind they mostly make), a table that doesn't read refused,
  and the lazy load the dialog uses. What is asserted of the shipped table holds for the
  generated one as well as for its placeholder.
*/

/** The generator's encoding, for building tables here: base64url digits, the last one high. */
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function varint(n: number): string {
  let s = DIGITS[32 + (n % 32)] ?? ''
  for (let rest = Math.floor(n / 32); rest > 0; rest = Math.floor(rest / 32)) {
    s = (DIGITS[rest % 32] ?? '') + s
  }
  return s
}
function encode(entries: readonly (readonly [number, number])[], brands: VendorTable['BRANDS']) {
  let previous = -1
  let prefixes = ''
  let index = ''
  for (const [key, brand] of entries) {
    prefixes += varint(key - previous - 1)
    index += varint(brand)
    previous = key
  }
  return { COUNT: entries.length, BRANDS: brands, PREFIXES: prefixes, INDEX: index }
}

describe('vendorLookup', () => {
  const lookup = vendorLookup(VENDORS)

  it('finds each maker of the table by its prefix, with the kind it mostly makes', () => {
    expect(lookup('14EBB6')).toEqual({ name: 'TP-Link', hint: 'router' })
    expect(lookup('24A160')).toEqual({ name: 'Espressif', hint: 'iot' })
    expect(lookup('AC1C26')).toEqual({ name: 'EZVIZ', hint: 'camera' })
    expect(lookup('B827EB')).toEqual({ name: 'Raspberry Pi', hint: 'computer' })
    // A maker too broad for one kind is named without a hint.
    expect(lookup('6C02E0')).toEqual({ name: 'HP' })
  })

  it('keeps a phone hint: §4.2 rule 6 here includes makers whose universal MACs are mostly phones', () => {
    const table = encode([[0x001122, 0]], [{ n: 'Huawei Device', h: 'phone' }])
    expect(vendorLookup(table)('001122')).toEqual({ name: 'Huawei Device', hint: 'phone' })
  })

  it('knows nothing of another prefix, nor of anything that isn’t one', () => {
    for (const prefix of [
      '000000',
      '14EBB5',
      '14EBB7',
      'FFFFFF',
      '14ebb6',
      '14EBB',
      '',
      '14:EB:B6',
    ]) {
      expect(lookup(prefix)).toBeNull()
    }
  })

  it('reads a large table: numbers of one to five digits, the first and the last prefix', () => {
    const entries = Array.from(
      { length: 2_000 },
      (_, i) => [i * 4_099 + (i % 7) * 3, i % 3] as const,
    )
    const table = encode(
      [...entries, [0xffffff, 1] as const],
      [
        { n: 'Sonos', h: 'speaker' },
        { n: 'Synology', h: 'storage' },
        { n: 'Acme', h: 'blender' },
      ],
    )
    const big = vendorLookup(table)
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(6, '0')
    expect(big(hex(0))).toEqual({ name: 'Sonos', hint: 'speaker' })
    expect(big(hex(1_000 * 4_099 + (1_000 % 7) * 3))).toEqual({ name: 'Synology', hint: 'storage' })
    // A kind the page doesn't know is no hint.
    expect(big(hex(1_997 * 4_099 + (1_997 % 7) * 3))).toEqual({ name: 'Acme' })
    expect(big('FFFFFF')).toEqual({ name: 'Synology', hint: 'storage' })
    expect(big(hex(4_099 + 1))).toBeNull()
    expect(big(hex(1_999 * 4_099 + 1))).toBeNull()
  })

  it('refuses a table that doesn’t read, rather than naming the wrong maker', () => {
    const good = encode(
      [
        [0x14ebb6, 0],
        [0x6c02e0, 1],
      ],
      [{ n: 'TP-Link' }, { n: 'HP' }],
    )
    expect(vendorLookup(good)('6C02E0')).toEqual({ name: 'HP' })
    for (const bad of [
      { ...good, PREFIXES: `${good.PREFIXES}*` },
      { ...good, COUNT: 3 },
      { ...good, COUNT: 1 },
      // A number left unfinished.
      { ...good, INDEX: `${good.INDEX}B` },
      { ...good, INDEX: `${varint(0)}${varint(2)}` },
      { ...good, PREFIXES: `${varint(0xffffff)}${varint(0)}` },
    ]) {
      expect(() => vendorLookup(bad)).toThrow(/unreadable table/)
    }
  })
})

describe('loadVendors', () => {
  it('fetches the table once, and looks makers up in it', async () => {
    const first = loadVendors()
    expect(loadVendors()).toBe(first)
    const lookup = await first
    expect(lookup('6C02E0')?.name).toBe('HP')
  })
})
