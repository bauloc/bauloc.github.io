import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  asDict,
  dictArray,
  dictBoolean,
  dictDict,
  dictString,
  dictStrings,
  dictValue,
  MAX_DEPTH,
  parsePlist,
  PlistError,
  type PlistDict,
} from './plist'

/*
  The reader against Apple's own writers: values.*.plist and info.*.plist are one source each,
  turned into XML and binary by plutil (__fixtures__/make-fixtures.sh), so both forms must read
  the same. Damaged and hostile files are written here, byte by byte.
*/

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))
const utf8 = (text: string) => new TextEncoder().encode(text)
/** U+FEFF, the byte-order mark, written as a code so no editor drops it. */
const BOM = String.fromCharCode(0xfeff)
const xml = (body: string) =>
  utf8(`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${body}\n</plist>\n`)
const dict = (value: unknown) => value as PlistDict

function codeOf(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    return error instanceof PlistError ? error.code : `not a PlistError: ${String(error)}`
  }
  return 'parsed'
}

/** `value` as `size` big-endian bytes. */
const be = (value: number, size: number) =>
  Array.from({ length: size }, (_, i) => Math.floor(value / 256 ** (size - 1 - i)) % 256)

const float64 = (value: number) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value)
  return [...bytes]
}

/** An ASCII string object. */
const str = (text: string) => [0x50 + text.length, ...utf8(text)]

interface Trailer {
  offsetSize?: number
  refSize?: number
  count?: number
  top?: number
  table?: number
}

/**
 * A binary plist around objects already encoded, marker byte and all. The offset table and the
 * trailer are worked out from them; `trailer` overrides any field, to damage it.
 */
function bplist(objects: readonly (readonly number[])[], trailer: Trailer = {}): Uint8Array {
  const out = [...utf8('bplist00')]
  const offsets = objects.map((object) => {
    const at = out.length
    out.push(...object)
    return at
  })
  const offsetSize = trailer.offsetSize ?? 2
  const table = out.length
  for (const offset of offsets) out.push(...be(offset, offsetSize))
  out.push(0, 0, 0, 0, 0, 0, offsetSize, trailer.refSize ?? 1)
  out.push(...be(trailer.count ?? objects.length, 8), ...be(trailer.top ?? 0, 8))
  out.push(...be(trailer.table ?? table, 8))
  return Uint8Array.from(out)
}

/** `levels` arrays, each holding the next; the innermost is empty. */
const nestedArrays = (levels: number) =>
  Array.from({ length: levels }, (_, i) => (i < levels - 1 ? [0xa1, i + 1] : [0xa0]))

describe('parsePlist, both forms', () => {
  it('reads plutil’s binary and XML of one file as the same values', () => {
    for (const name of ['values', 'info']) {
      const binary = parsePlist(fixture(`${name}.binary.plist`))
      expect(binary, name).toEqual(parsePlist(fixture(`${name}.xml.plist`)))
    }
  })

  it('reads every kind of value', () => {
    for (const form of ['binary', 'xml']) {
      const values = dict(parsePlist(fixture(`values.${form}.plist`)))
      expect(values, form).toEqual({
        ascii: 'plain',
        'long ascii': 'A string longer than fifteen characters',
        entities: 'Tom & Jerry <3 "quoted" \'apos\'',
        unicode: 'Tiếng Việt — 日本語 😀',
        'empty string': '',
        zero: 0,
        byte: 255,
        short: 65535,
        int: 4294967295,
        long: 4294967296,
        'minus one': -1,
        'max safe': Number.MAX_SAFE_INTEGER,
        'beyond safe': 9007199254740993n,
        'below safe': -9007199254740993n,
        'int64 max': 9223372036854775807n,
        'uint64 max': 18446744073709551615n,
        half: 0.5,
        'negative real': -2.25,
        'huge real': 1e300,
        yes: true,
        no: false,
        date: '2026-10-07T08:15:00Z',
        'old date': '1999-12-31T23:59:59Z',
        data: Uint8Array.from([0, 1, 2, 255]),
        'empty data': new Uint8Array(0),
        'empty array': [],
        'empty dict': {},
        sixteen: Array.from({ length: 16 }, (_, i) => i + 1),
        nested: [{ name: 'plain', list: ['plain', true] }],
        // Computed: a literal `__proto__:` would set the prototype instead of making a key.
        ['__proto__']: 'an own key',
        constructor: 7,
      })
    }
  })

  it('makes dictionaries without a prototype, so no key reaches Object', () => {
    const values = dict(parsePlist(fixture('values.binary.plist')))
    expect(Object.getPrototypeOf(values)).toBeNull()
    expect(Object.hasOwn(values, '__proto__')).toBe(true)
    expect('toString' in values).toBe(false)
    const fromXml = dict(parsePlist(xml('<dict><key>__proto__</key><dict/></dict>')))
    expect(Object.keys(fromXml)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(fromXml)).toBeNull()
  })

  it('refuses what is neither form', () => {
    for (const bytes of [
      new Uint8Array(0),
      utf8('   '),
      utf8('plain text'),
      Uint8Array.from([0x00, 0x01, 0x02]),
      utf8('bplist15 is a private Apple format'),
      utf8('bplist16'),
    ]) {
      expect(codeOf(() => parsePlist(bytes))).toBe('PLIST_FORMAT')
    }
  })
})

describe('parsePlist, binary', () => {
  it('reads the markers CoreFoundation writes, sets, UIDs and 4-byte reals', () => {
    const plist = bplist([
      [0xab, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      [0x22, 0x3f, 0xc0, 0x00, 0x00], // a float: 1.5
      [0xc2, 12, 13], // a set
      [0x80, 0x07], // a UID
      [0x14, ...new Array<number>(15).fill(0), 5], // 16 bytes, small
      [0x14, ...new Array<number>(16).fill(0xff)], // 16 bytes: -1
      [0x13, 0x80, 0, 0, 0, 0, 0, 0, 0], // the smallest 8-byte integer
      [0x62, 0xd8, 0x3d, 0xde, 0x00], // UTF-16: one emoji, two code units
      [0x00], // null
      [0x0f], // fill
      [0x33, ...float64(-31_622_400)], // a leap year before 2001
      [0x52, 0xe9, 0x74], // ASCII with a Latin-1 byte
      str('a'),
      str('b'),
    ])
    expect(parsePlist(plist)).toEqual([
      1.5,
      ['a', 'b'],
      7,
      5,
      -1,
      -9223372036854775808n,
      '😀',
      '2000-01-01T00:00:00Z',
      'ét',
    ])
  })

  it('reads counts past 15, offsets and references wider than a byte', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${String(i)}`)
    const objects = [
      [0xaf, 0x11, ...be(300, 2), ...words.flatMap((_, i) => be(i + 1, 2))],
      ...words.map(str),
    ]
    expect(parsePlist(bplist(objects, { refSize: 2, offsetSize: 4 }))).toEqual(words)
  })

  it('leaves null values out of a dictionary', () => {
    const plist = bplist([[0xd2, 1, 2, 3, 4], str('gone'), str('kept'), [0x00], [0x10, 0x01]])
    expect(parsePlist(plist)).toEqual({ kept: 1 })
  })

  it('reads a shared object once: forty levels of [x, x] stay instant', () => {
    const objects = Array.from({ length: 40 }, (_, i) => [0xa2, i + 1, i + 1])
    objects.push(str('x'))
    let value = parsePlist(bplist(objects))
    for (let level = 0; level < 40; level++) {
      expect(Array.isArray(value) && value.length === 2 && value[0] === value[1]).toBe(true)
      value = (value as unknown[])[0] as typeof value
    }
    expect(value).toBe('x')
  })

  it(`nests containers ${String(MAX_DEPTH)} deep, and refuses one more`, () => {
    let value = parsePlist(bplist(nestedArrays(MAX_DEPTH)))
    for (let level = 1; level < MAX_DEPTH; level++) value = (value as unknown[])[0] as typeof value
    expect(value).toEqual([])
    expect(codeOf(() => parsePlist(bplist(nestedArrays(MAX_DEPTH + 1))))).toBe('PLIST_DEPTH')
  })

  it('refuses a container that holds itself', () => {
    expect(codeOf(() => parsePlist(bplist([[0xa1, 0]])))).toBe('PLIST_CYCLE')
    expect(
      codeOf(() =>
        parsePlist(
          bplist([
            [0xa1, 1],
            [0xa1, 0],
          ]),
        ),
      ),
    ).toBe('PLIST_CYCLE')
    expect(codeOf(() => parsePlist(bplist([[0xd1, 1, 0], str('self')])))).toBe('PLIST_CYCLE')
  })

  it('refuses a trailer that does not add up', () => {
    const ok = [[0xa1, 1], str('a')]
    expect(codeOf(() => parsePlist(bplist(ok)))).toBe('parsed')
    for (const trailer of [
      { offsetSize: 0 },
      { offsetSize: 9 },
      { refSize: 0 },
      { refSize: 9 },
      { count: 0 },
      { count: 2 ** 62 },
      { top: 2 },
      { table: 4 },
      { table: 2 ** 60 },
    ]) {
      expect(
        codeOf(() => parsePlist(bplist(ok, trailer))),
        JSON.stringify(trailer),
      ).toBe('PLIST_CORRUPT')
    }
    expect(codeOf(() => parsePlist(utf8('bplist00')))).toBe('PLIST_CORRUPT')
    const cut = bplist(ok)
    expect(codeOf(() => parsePlist(cut.subarray(0, cut.length - 1)))).toBe('PLIST_CORRUPT')
  })

  it('refuses offsets, lengths and references that point outside the objects', () => {
    const corrupt = (objects: readonly (readonly number[])[], trailer?: Trailer) =>
      codeOf(() => parsePlist(bplist(objects, trailer)))
    // A reference past the last object.
    expect(corrupt([[0xa1, 5], str('a')])).toBe('PLIST_CORRUPT')
    // A string, data, an integer and an array longer than what follows them.
    expect(corrupt([[0x5a, 0x61]])).toBe('PLIST_CORRUPT')
    expect(corrupt([[0x6a, 0x00, 0x61]])).toBe('PLIST_CORRUPT')
    expect(corrupt([[0x4f, 0x10, 0x30, 1, 2]])).toBe('PLIST_CORRUPT')
    expect(corrupt([[0x13, 0x00, 0x01]])).toBe('PLIST_CORRUPT')
    expect(corrupt([[0xa3, 1], str('a')])).toBe('PLIST_CORRUPT')
    // A count after the marker that is not an integer, or one no file could hold.
    expect(corrupt([[0xaf, 0x51, 0x61]])).toBe('PLIST_CORRUPT')
    expect(corrupt([[0xaf, 0x13, 0x3f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]])).toBe(
      'PLIST_CORRUPT',
    )
    expect(corrupt([[0x6f, 0x13, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]])).toBe(
      'PLIST_CORRUPT',
    )
    // An offset that points into the header or into the offset table.
    const plist = bplist([str('a')])
    plist[plist.length - 32 - 1] = 2
    expect(codeOf(() => parsePlist(plist))).toBe('PLIST_CORRUPT')
    plist[plist.length - 32 - 1] = plist.length - 32 - 2
    expect(codeOf(() => parsePlist(plist))).toBe('PLIST_CORRUPT')
  })

  it('refuses markers format 00 does not have, keys that are not strings, and no value', () => {
    for (const object of [
      [0x70], // a UTF-8 string
      [0x0c], // a URL
      [0x0e], // a UUID
      [0x90],
      [0xe0],
      [0xf0],
      [0x15, ...new Array<number>(32).fill(0)], // a 32-byte integer
      [0x21, 0, 0], // a 2-byte real
      [0x32, 0, 0, 0, 0], // a date of 4 bytes
      [0x33, ...float64(1e300)], // a date no Date can hold
      [0x00], // null, alone
    ]) {
      expect(
        codeOf(() => parsePlist(bplist([object]))),
        object.join(' '),
      ).toBe('PLIST_CORRUPT')
    }
    expect(
      codeOf(() =>
        parsePlist(
          bplist([
            [0xd1, 1, 1],
            [0x10, 0x01],
          ]),
        ),
      ),
    ).toBe('PLIST_CORRUPT')
  })
})

describe('parsePlist, XML', () => {
  it('skips the prologue, a DOCTYPE with a subset, comments and processing instructions', () => {
    const text = `${BOM}<?xml version="1.0"?>
      <!DOCTYPE plist [ <!ELEMENT plist ANY> <!-- > --> ]>
      <!-- <string>not a value</string> -->
      <?editor note?>
      <plist version="1.0"><dict>
        <key>a<!-- inside --></key><string>x<![CDATA[<b>&amp;</b>]]>y</string>
      </dict></plist>`
    expect(parsePlist(utf8(text))).toEqual({ a: 'x<b>&amp;</b>y' })
  })

  it('reads a value without the <plist> wrapper', () => {
    expect(parsePlist(utf8('<array><true/><false></false></array>'))).toEqual([true, false])
  })

  it('decodes entities, and keeps any it does not know', () => {
    // Decimal references stay under three digits: the palette lint reads `#233` as a colour.
    const entities =
      '&amp;&lt;&gt;&quot;&apos; &#65;&#xE9;&#x1F600; &nbsp; &#x110000; &constructor;'
    expect(parsePlist(xml(`<string>${entities}</string>`))).toBe(
      '&<>"\' Aé😀 &nbsp; &#x110000; &constructor;',
    )
  })

  it('reads empty elements and every way of writing a number', () => {
    expect(
      parsePlist(
        xml(`<array>
          <string/><data/><integer/><real/><dict/><array/>
          <integer>0x1F</integer><integer>-0x10</integer><integer> +5 </integer>
          <integer>18446744073709551616</integer><integer>-9007199254740991</integer>
          <real>nan</real><real>-Infinity</real><real>1e-3</real><real>.5</real><real>5.</real>
          <real>+1.5E+2</real><real>-.25</real>
        </array>`),
      ),
    ).toEqual([
      '',
      new Uint8Array(0),
      0,
      0,
      {},
      [],
      31,
      -16,
      5,
      18446744073709551616n,
      -9007199254740991,
      NaN,
      -Infinity,
      0.001,
      0.5,
      5,
      150,
      -0.25,
    ])
  })

  it('reads a self-closing slash after whitespace, and not one inside an attribute', () => {
    const tags = '<array><true /><false\n\t/><string id="a/">x</string><dict  /></array>'
    expect(parsePlist(utf8(tags))).toEqual([true, false, 'x', {}])
  })

  it('reads dates as ISO 8601 and data wrapped over lines', () => {
    expect(
      parsePlist(
        xml(`<array>
          <date> 2026-10-07T08:15:00Z </date><date>2026-10-07T08:15:00.250Z</date>
          <data>
            AAEC
            /w==
          </data>
        </array>`),
      ),
    ).toEqual(['2026-10-07T08:15:00Z', '2026-10-07T08:15:00.250Z', Uint8Array.from([0, 1, 2, 255])])
  })

  it('reads UTF-16 when a byte-order mark says so', () => {
    const text = '<plist><string>Thử Nghiệm 😀</string></plist>'
    /** The text in UTF-16, code unit by code unit, behind its byte-order mark. */
    const encode = (bigEndian: boolean) => {
      const bytes: number[] = bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]
      for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        bytes.push(...(bigEndian ? [unit >> 8, unit & 0xff] : [unit & 0xff, unit >> 8]))
      }
      return Uint8Array.from(bytes)
    }
    expect(parsePlist(encode(false))).toBe('Thử Nghiệm 😀')
    expect(parsePlist(encode(true))).toBe('Thử Nghiệm 😀')
  })

  it('reads long runs of whitespace in a tag and of digits in a <real> in linear time', () => {
    // A megabyte deflates to a kilobyte inside an IPA. The smaller run goes first, so a pattern
    // that backtracks again fails in seconds instead of hanging for the minutes a megabyte takes.
    for (const size of [64 * 1024, 1024 * 1024]) {
      const spaces = ' '.repeat(size)
      const started = performance.now()
      // Whitespace before a tag's end is allowed, with or without a self-closing slash.
      expect(parsePlist(utf8(`<plist${spaces}x><true/></plist>`))).toBe(true)
      expect(parsePlist(utf8(`<array${spaces}/>`))).toEqual([])
      // Digits that turn out not to be a number only at their very end.
      expect(codeOf(() => parsePlist(xml(`<real>${'1'.repeat(size)}x</real>`)))).toBe(
        'PLIST_CORRUPT',
      )
      expect(performance.now() - started, `${String(size)} characters`).toBeLessThan(500)
    }
  })

  it(`nests containers ${String(MAX_DEPTH)} deep, and refuses one more`, () => {
    const nested = (levels: number) => xml('<array>'.repeat(levels) + '</array>'.repeat(levels))
    expect(parsePlist(nested(MAX_DEPTH))).toEqual(parsePlist(bplist(nestedArrays(MAX_DEPTH))))
    expect(codeOf(() => parsePlist(nested(MAX_DEPTH + 1)))).toBe('PLIST_DEPTH')
  })

  it('refuses markup that does not balance or is not a plist’s', () => {
    for (const body of [
      '',
      '<dict>',
      '<dict></array>',
      '</dict>',
      '<dict><key>a</key></dict>',
      '<dict><key>a</key><key>b</key><string/></dict>',
      '<dict><string>no key</string></dict>',
      '<array><key>a</key></array>',
      '<string>one</string><string>two</string>',
      '<html/>',
      '<array>loose text</array>',
      '<string>a<b/></string>',
      '<string>a</integer>',
      '<string>a',
      '</string/>',
      '<true>yes</true>',
      '<dict><plist/></dict>',
      '<integer>12abc</integer>',
      '<integer>1.5</integer>',
      '<real>one</real>',
      '<real>1.2.3</real>',
      '<real>1e</real>',
      '<real>e5</real>',
      '<real>.</real>',
      '<date>2026-10-07</date>',
      '<date>yesterday</date>',
      '<data>@@@</data>',
      '<!-- never closed',
      '<array',
    ]) {
      expect(
        codeOf(() => parsePlist(xml(body))),
        body,
      ).toBe('PLIST_CORRUPT')
    }
  })
})

describe('reading values out', () => {
  const values = dict(parsePlist(fixture('values.binary.plist')))

  it('narrows to a dictionary', () => {
    expect(asDict(values)).toBe(values)
    for (const other of ['x', 1, true, [], new Uint8Array(1), undefined]) {
      expect(asDict(other)).toBeNull()
    }
  })

  it('answers each kind, and nothing for a missing key or the wrong kind', () => {
    expect(dictString(values, 'ascii')).toBe('plain')
    expect(dictString(values, 'zero')).toBeUndefined()
    expect(dictBoolean(values, 'yes')).toBe(true)
    expect(dictBoolean(values, 'ascii')).toBeUndefined()
    expect(dictDict(values, 'empty dict')).toEqual({})
    expect(dictDict(values, 'nested')).toBeNull()
    expect(dictArray(values, 'sixteen')).toHaveLength(16)
    expect(dictArray(values, 'empty dict')).toBeNull()
    expect(dictStrings(dictDict(values, 'missing'), 'list')).toEqual([])
    const nested = asDict(dictArray(values, 'nested')?.[0])
    expect(dictStrings(nested, 'list')).toEqual(['plain'])
    expect(dictValue(null, 'ascii')).toBeUndefined()
  })

  it('never answers with something inherited from Object', () => {
    const plain: PlistDict = { own: 'yes' }
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(dictValue(plain, key), key).toBeUndefined()
    }
    expect(dictValue(plain, 'own')).toBe('yes')
  })
})
