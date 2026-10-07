/*
  Property lists, as an IPA holds them: the app's Info.plist (binary, the form Xcode writes for
  a device build) and the plist inside embedded.mobileprovision (XML). Read in the browser
  from bytes, with no Buffer and no DOM, into plain values:

    strings (ASCII, UTF-16, XML)    string
    <integer>                       number; a bigint beyond 2^53, so 2^64 - 1 stays exact
    <real>                          number
    <true/> <false/>                boolean
    <date>                          ISO 8601 text, as Apple writes it: '2026-10-07T08:15:00Z'
    <data>                          Uint8Array
    <array>, and a binary set       array
    <dict>                          an object with no prototype

  The two forms of one plist read the same: plutil's binary1 and xml1 of a file are deep-equal
  (plist.test.ts). Refused with a code, never guessed at: offsets, lengths and references that
  point outside the file, containers nested deeper than 64 or holding themselves, and markup
  that does not balance. An upload is untrusted input, so every count is checked against the
  bytes that would have to hold it before anything is allocated, and no input makes the reader
  loop or recurse without bound.

  Ported from the Device Lab helper's XML reader (helper/src/plist.ts), which reads what
  usbmuxd and lockdownd send.
*/

export type PlistValue = string | number | bigint | boolean | Uint8Array | PlistValue[] | PlistDict

/**
 * A dictionary. Made with no prototype, so "__proto__" and "constructor" are keys like any
 * other, and a key the file does not have reads as undefined, never as an Object method.
 */
export interface PlistDict {
  [key: string]: PlistValue
}

export type PlistErrorCode =
  /** Neither a binary plist ('bplist00') nor XML. */
  | 'PLIST_FORMAT'
  /** Offsets, lengths, references or markup that do not add up: a damaged file. */
  | 'PLIST_CORRUPT'
  /** Containers nested deeper than MAX_DEPTH. */
  | 'PLIST_DEPTH'
  /** A binary container that holds itself, directly or further down. */
  | 'PLIST_CYCLE'

/** A refusal. Its message is the code, as with Device Lab's ZipError; callers own the wording. */
export class PlistError extends Error {
  readonly code: PlistErrorCode

  constructor(code: PlistErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'PlistError'
    this.code = code
  }
}

/** Containers inside containers, the outermost counted: an Info.plist nests five or six. */
export const MAX_DEPTH = 64

const corrupt = (cause?: unknown) =>
  new PlistError('PLIST_CORRUPT', cause === undefined ? undefined : { cause })

const newDict = () => Object.create(null) as PlistDict

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** A whole number as a number when it is exactly one, else as a bigint: the same in both forms. */
const exact = (value: bigint): number | bigint =>
  value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value

/**
 * A time as ISO 8601, without the milliseconds when there are none, as Apple's XML writer
 * spells dates. A time a Date cannot hold (beyond ±275,000 years) is a damaged file.
 */
function isoOf(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw corrupt()
  return new Date(ms).toISOString().replace('.000Z', 'Z')
}

/** Character codes to text, in slices that stay inside every engine's limit on arguments. */
function fromCodes(codes: Uint8Array | Uint16Array): string {
  let text = ''
  for (let at = 0; at < codes.length; at += 0x8000) {
    text += String.fromCharCode(...codes.subarray(at, at + 0x8000))
  }
  return text
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0))
const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte)

const BPLIST = ascii('bplist')
const BPLIST00 = ascii('bplist00')

/**
 * A property list from its bytes, binary or XML. Throws PlistError: PLIST_FORMAT for anything
 * else (bplist15 and bplist16, private formats of Apple's, included), PLIST_CORRUPT,
 * PLIST_DEPTH or PLIST_CYCLE for a plist that cannot be read.
 */
export function parsePlist(bytes: Uint8Array): PlistValue {
  if (startsWith(bytes, BPLIST00)) return parseBinary(bytes)
  if (startsWith(bytes, BPLIST)) throw new PlistError('PLIST_FORMAT')
  return parseXml(decodeText(bytes))
}

/* ---------------------------------------------------------------- *
 * Binary: 'bplist00', objects, an offset table, and a 32-byte trailer that locates the rest.
 * Every object is reached through the offset table by its index (a reference), so one object
 * can be shared, and a damaged or crafted file can point anywhere, itself included.
 * ---------------------------------------------------------------- */

const TRAILER_SIZE = 32
/** Seconds from 1970-01-01 to 2001-01-01, the epoch binary dates count from. */
const EPOCH_2001 = 978_307_200

function parseBinary(bytes: Uint8Array): PlistValue {
  try {
    return readBinary(bytes)
  } catch (error) {
    // Every offset is checked before it is read, so a DataView past its end means a check was
    // missed: the file is still only damaged, never a reason to crash.
    if (error instanceof RangeError) throw corrupt(error)
    throw error
  }
}

function readBinary(bytes: Uint8Array): PlistValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  /**
   * An unsigned big-endian integer. Past 2^53 it is no longer exact, but by then it is far
   * larger than any file, which is all the checks below ask of it.
   */
  const uint = (at: number, size: number) => {
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + (bytes[at + i] ?? 0)
    return value
  }

  // The header, one object of one byte, and the trailer: nothing shorter is a plist.
  if (bytes.length < BPLIST00.length + 1 + TRAILER_SIZE) throw corrupt()
  const trailer = bytes.length - TRAILER_SIZE
  const offsetSize = bytes[trailer + 6] ?? 0
  const refSize = bytes[trailer + 7] ?? 0
  const count = uint(trailer + 8, 8)
  const top = uint(trailer + 16, 8)
  const table = uint(trailer + 24, 8)
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw corrupt()
  if (count < 1 || top >= count) throw corrupt()
  // Objects lie between the header and the offset table; the table ends before the trailer.
  if (table <= BPLIST00.length || table + count * offsetSize > trailer) throw corrupt()
  const end = table

  /** `items` items of `size` bytes from `start` fit inside the objects. */
  const fits = (start: number, items: number, size: number) => {
    if (start + items * size > end) throw corrupt()
  }

  /** A length kept in the marker's low nibble, or after it as an integer when that reads 0xF. */
  const lengthAt = (offset: number, info: number): [length: number, start: number] => {
    if (info !== 0x0f) return [info, offset + 1]
    fits(offset + 1, 1, 1)
    const marker = bytes[offset + 1] ?? 0
    if (marker >> 4 !== 0x1 || (marker & 0x0f) > 3) throw corrupt()
    const size = 1 << (marker & 0x0f)
    fits(offset + 2, size, 1)
    return [uint(offset + 2, size), offset + 2 + size]
  }

  /** Integers of 1, 2 and 4 bytes are unsigned, of 8 and 16 signed: CoreFoundation's rule. */
  const integerAt = (at: number, size: number): number | bigint => {
    if (size <= 4) return uint(at, size)
    if (size === 8) return exact(view.getBigInt64(at))
    return exact((view.getBigInt64(at) << 64n) | view.getBigUint64(at + 8))
  }

  const bigUint = (at: number, size: number) => {
    let value = 0n
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(bytes[at + i] ?? 0)
    return value
  }

  /** Objects already read, by reference: a shared object is read once, however often it is used. */
  const done = new Map<number, PlistValue | null>()
  /** Containers being read: meeting one again on the way down means it holds itself. */
  const open = new Set<number>()

  /** The object behind a reference; null for the null and fill markers, which hold no value. */
  function read(ref: number, depth: number): PlistValue | null {
    if (ref >= count) throw corrupt()
    const known = done.get(ref)
    if (known !== undefined) return known
    if (open.has(ref)) throw new PlistError('PLIST_CYCLE')

    const offset = uint(table + ref * offsetSize, offsetSize)
    if (offset < BPLIST00.length || offset >= end) throw corrupt()
    const marker = bytes[offset] ?? 0
    const info = marker & 0x0f
    let value: PlistValue | null

    switch (marker >> 4) {
      case 0x0:
        if (marker === 0x08 || marker === 0x09) value = marker === 0x09
        else if (marker === 0x00 || marker === 0x0f) value = null
        else throw corrupt() // URL and UUID objects: not in format 00
        break
      case 0x1: {
        if (info > 4) throw corrupt()
        fits(offset + 1, 1 << info, 1)
        value = integerAt(offset + 1, 1 << info)
        break
      }
      case 0x2:
        if (info !== 2 && info !== 3) throw corrupt()
        fits(offset + 1, 1 << info, 1)
        value = info === 2 ? view.getFloat32(offset + 1) : view.getFloat64(offset + 1)
        break
      case 0x3:
        if (info !== 3) throw corrupt()
        fits(offset + 1, 8, 1)
        value = isoOf((view.getFloat64(offset + 1) + EPOCH_2001) * 1000)
        break
      case 0x4: {
        const [length, start] = lengthAt(offset, info)
        fits(start, length, 1)
        value = new Uint8Array(bytes.subarray(start, start + length))
        break
      }
      case 0x5: {
        // ASCII. A byte above 0x7f is not CoreFoundation's doing; it is read as Latin-1.
        const [length, start] = lengthAt(offset, info)
        fits(start, length, 1)
        value = fromCodes(bytes.subarray(start, start + length))
        break
      }
      case 0x6: {
        // UTF-16 big-endian, its length in code units; unpaired surrogates are kept as they are.
        const [length, start] = lengthAt(offset, info)
        fits(start, length, 2)
        const units = new Uint16Array(length)
        for (let i = 0; i < length; i++) units[i] = view.getUint16(start + 2 * i)
        value = fromCodes(units)
        break
      }
      case 0x8: {
        // A UID: NSKeyedArchiver's reference to another object, read as its number.
        fits(offset + 1, info + 1, 1)
        value = exact(bigUint(offset + 1, info + 1))
        break
      }
      case 0xa:
      case 0xb:
      case 0xc: {
        // An array; an ordered set and a set read as arrays too.
        if (depth > MAX_DEPTH) throw new PlistError('PLIST_DEPTH')
        const [length, start] = lengthAt(offset, info)
        fits(start, length, refSize)
        open.add(ref)
        const items: PlistValue[] = []
        for (let i = 0; i < length; i++) {
          const item = read(uint(start + i * refSize, refSize), depth + 1)
          if (item !== null) items.push(item)
        }
        open.delete(ref)
        value = items
        break
      }
      case 0xd: {
        // A dictionary: every key's reference, then every value's.
        if (depth > MAX_DEPTH) throw new PlistError('PLIST_DEPTH')
        const [length, start] = lengthAt(offset, info)
        fits(start, 2 * length, refSize)
        open.add(ref)
        const dict = newDict()
        for (let i = 0; i < length; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1)
          if (typeof key !== 'string') throw corrupt()
          const item = read(uint(start + (length + i) * refSize, refSize), depth + 1)
          if (item !== null) dict[key] = item
        }
        open.delete(ref)
        value = dict
        break
      }
      default:
        throw corrupt()
    }
    done.set(ref, value)
    return value
  }

  const root = read(top, 1)
  if (root === null) throw corrupt()
  return root
}

/* ---------------------------------------------------------------- *
 * XML: a tag scanner rather than a DOM, so it runs anywhere (a Worker, a Node test). It skips
 * the prologue, the DOCTYPE, comments and processing instructions, reads CDATA as text, and
 * accepts only the plist elements, balanced.
 * ---------------------------------------------------------------- */

/** UTF-8 unless a byte-order mark says UTF-16, as CoreFoundation reads XML plists. */
function decodeText(bytes: Uint8Array): string {
  const label =
    bytes[0] === 0xfe && bytes[1] === 0xff
      ? 'utf-16be'
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : 'utf-8'
  return new TextDecoder(label).decode(bytes)
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

function unescapeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES.get(entity) ?? match
  })
}

/**
 * `<integer>`: decimal, or hexadecimal after 0x as CoreFoundation also reads it. Exact as a
 * bigint beyond 2^53. Empty reads as 0, as the helper reads `<integer/>`.
 */
function parseInteger(raw: string): number | bigint {
  const text = raw.trim()
  if (text === '') return 0
  const match = /^([+-]?)(?:0x([0-9a-f]{1,32})|(\d{1,40}))$/i.exec(text)
  if (!match) throw corrupt()
  const [, sign, hex, decimal] = match
  const magnitude = hex !== undefined ? BigInt(`0x${hex}`) : BigInt(decimal ?? '0')
  return exact(sign === '-' ? -magnitude : magnitude)
}

const SPECIAL_REALS = new Map([
  ['nan', NaN],
  ['inf', Infinity],
  ['+inf', Infinity],
  ['-inf', -Infinity],
  ['infinity', Infinity],
  ['+infinity', Infinity],
  ['-infinity', -Infinity],
])

/**
 * A decimal number: `5`, `5.`, `.5`, `1.5e-3`. Each digit can be matched one way only, so a
 * long run of digits that fails at its end is given up in linear time; with an optional point
 * between `\d+` and `\d*`, every split of the run was tried, quadratic in its length.
 */
const REAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** `<real>`: a decimal number, or the words CoreFoundation writes for NaN and the infinities. */
function parseReal(raw: string): number {
  const text = raw.trim()
  if (text === '') return 0
  const special = SPECIAL_REALS.get(text.toLowerCase())
  if (special !== undefined) return special
  if (!REAL.test(text)) throw corrupt()
  return Number(text)
}

/** `<date>`: UTC to the second, as Apple writes it; fractions of a second are kept if present. */
function parseDate(raw: string): string {
  const text = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) throw corrupt()
  return isoOf(Date.parse(text))
}

/** `<data>`: base64, wrapped and indented in any way. */
function parseData(raw: string): Uint8Array<ArrayBuffer> {
  let binary: string
  try {
    binary = atob(raw.replace(/\s+/g, ''))
  } catch (error) {
    throw corrupt(error)
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Elements whose content is text: a dictionary key, or a value. */
const LEAVES = new Set(['key', 'string', 'integer', 'real', 'date', 'data', 'true', 'false'])

/**
 * A tag between `<` and `>`: an end tag's slash, the name, any attributes (skipped), and a
 * self-closing slash. The lazy attribute group takes trailing whitespace too; a `\s*` after it
 * would rescan the whitespace at every step, quadratic in a long run of it.
 */
const TAG = /^(\/?)([A-Za-z][\w.:-]*)(?:\s[\s\S]*?)?(\/?)$/

type Frame =
  | { readonly kind: 'array'; readonly value: PlistValue[] }
  | { readonly kind: 'dict'; readonly value: PlistDict; key: string | null }

function scalar(name: string, text: string): PlistValue {
  switch (name) {
    case 'integer':
      return parseInteger(text)
    case 'real':
      return parseReal(text)
    case 'date':
      return parseDate(text)
    case 'data':
      return parseData(text)
    case 'true':
    case 'false':
      if (/\S/.test(text)) throw corrupt()
      return name === 'true'
    default:
      return text
  }
}

/** The end of a `<!…>` declaration, past a DOCTYPE's internal subset `[…]` if it has one. */
function declarationEnd(text: string, from: number): number {
  let inSubset = false
  for (let at = from; at < text.length; at++) {
    const char = text[at]
    if (char === '[') inSubset = true
    else if (char === ']') inSubset = false
    else if (char === '>' && !inSubset) return at + 1
  }
  throw corrupt()
}

/** Where `marker` ends, searching from `from`; a construct left open is a damaged file. */
function endOf(text: string, marker: string, from: number): number {
  const at = text.indexOf(marker, from)
  if (at < 0) throw corrupt()
  return at + marker.length
}

function parseXml(text: string): PlistValue {
  const first = text.search(/\S/)
  if (first < 0 || text[first] !== '<') throw new PlistError('PLIST_FORMAT')

  const stack: Frame[] = []
  let root: PlistValue | undefined
  /** The key or scalar whose text is being gathered. */
  let leaf: { readonly name: string; text: string } | null = null

  const put = (value: PlistValue) => {
    const top = stack.at(-1)
    if (!top) {
      if (root !== undefined) throw corrupt()
      root = value
    } else if (top.kind === 'array') {
      top.value.push(value)
    } else {
      if (top.key === null) throw corrupt()
      top.value[top.key] = value
      top.key = null
    }
  }

  const finish = (name: string, content: string) => {
    if (name !== 'key') {
      put(scalar(name, content))
      return
    }
    const top = stack.at(-1)
    if (top?.kind !== 'dict' || top.key !== null) throw corrupt()
    top.key = content
  }

  /** Text for the open key or scalar; CDATA is `literal`. Outside one, only whitespace. */
  const gather = (chars: string, literal: boolean) => {
    if (leaf) leaf.text += literal ? chars : unescapeXml(chars)
    else if (/\S/.test(chars)) throw corrupt()
  }

  let at = first
  for (;;) {
    const open = text.indexOf('<', at)
    gather(text.slice(at, open < 0 ? text.length : open), false)
    if (open < 0) break

    if (text.startsWith('<!--', open)) {
      at = endOf(text, '-->', open + 4)
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      at = endOf(text, ']]>', open + 9)
      gather(text.slice(open + 9, at - 3), true)
      continue
    }
    if (text.startsWith('<?', open)) {
      at = endOf(text, '?>', open + 2)
      continue
    }
    if (text.startsWith('<!', open)) {
      at = declarationEnd(text, open + 2)
      continue
    }

    at = endOf(text, '>', open + 1)
    const tag = TAG.exec(text.slice(open + 1, at - 1))
    if (!tag) throw corrupt()
    const [, slash, name = '', selfClosing] = tag
    const closing = slash === '/'
    const empty = selfClosing === '/'
    if (closing && empty) throw corrupt()

    if (leaf) {
      // Inside a key or a scalar, only its own end tag may follow.
      if (!closing || name !== leaf.name) throw corrupt()
      finish(leaf.name, leaf.text)
      leaf = null
    } else if (name === 'plist') {
      // The wrapper adds nothing, and is optional: a bare <dict> is a plist too.
      if (stack.length > 0) throw corrupt()
    } else if (name === 'dict' || name === 'array') {
      if (closing) {
        const top = stack.pop()
        if (top?.kind !== name || (top.kind === 'dict' && top.key !== null)) throw corrupt()
        put(top.value)
      } else if (empty) {
        put(name === 'dict' ? newDict() : [])
      } else {
        if (stack.length >= MAX_DEPTH) throw new PlistError('PLIST_DEPTH')
        stack.push(
          name === 'dict'
            ? { kind: 'dict', value: newDict(), key: null }
            : { kind: 'array', value: [] },
        )
      }
    } else if (LEAVES.has(name) && !closing) {
      if (empty) finish(name, '')
      else leaf = { name, text: '' }
    } else {
      throw corrupt()
    }
  }

  if (leaf || stack.length > 0 || root === undefined) throw corrupt()
  return root
}

/* ---------------------------------------------------------------- *
 * Reading values out: each helper answers undefined (or null, or []) for a key that is missing
 * or holds something else, so a malformed Info.plist reads as one with fewer facts.
 * ---------------------------------------------------------------- */

/** A dictionary, or null. */
export function asDict(value: PlistValue | undefined): PlistDict | null {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value
    : null
}

/** The value under `key`: the dictionary's own, never one inherited from Object. */
export function dictValue(dict: PlistDict | null, key: string): PlistValue | undefined {
  return dict && Object.hasOwn(dict, key) ? dict[key] : undefined
}

export function dictString(dict: PlistDict | null, key: string): string | undefined {
  const value = dictValue(dict, key)
  return typeof value === 'string' ? value : undefined
}

export function dictBoolean(dict: PlistDict | null, key: string): boolean | undefined {
  const value = dictValue(dict, key)
  return typeof value === 'boolean' ? value : undefined
}

export function dictDict(dict: PlistDict | null, key: string): PlistDict | null {
  return asDict(dictValue(dict, key))
}

export function dictArray(dict: PlistDict | null, key: string): readonly PlistValue[] | null {
  const value = dictValue(dict, key)
  return Array.isArray(value) ? value : null
}

/** The strings of an array, anything else in it skipped; [] when there is no array. */
export function dictStrings(dict: PlistDict | null, key: string): string[] {
  return (dictArray(dict, key) ?? []).filter((item): item is string => typeof item === 'string')
}
