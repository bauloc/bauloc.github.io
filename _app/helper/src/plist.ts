/**
 * XML property lists: what usbmuxd and lockdownd speak, and what `ideviceinfo -x` prints.
 * Only the XML form: both daemons answer in the form they are asked in, and binary plists
 * reach the helper nowhere it parses one (CoreDevice's Info.plist is read by PlistBuddy).
 */
import { HelperError } from './util'

export type PlistValue =
  string | number | bigint | boolean | Buffer | PlistValue[] | { [key: string]: PlistValue }

/**
 * What buildPlist() accepts: plist values, plus Date for <date>, and `undefined` dictionary
 * entries, which are left out, so an optional field can be written inline.
 */
export type PlistInput =
  | string
  | number
  | bigint
  | boolean
  | Buffer
  | Date
  | PlistInput[]
  | { [key: string]: PlistInput | undefined }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity] ?? match
  })
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A plist the helper cannot read: a protocol error, never a crash. */
function malformed(why: string): HelperError {
  return new HelperError('INTERNAL', 500, `A device sent a malformed property list (${why}).`)
}

/** `<integer>`: exact as a BigInt beyond 2^53 (ECIDs reach 2^64), a number otherwise. */
function parseInteger(raw: string): number | bigint {
  const text = raw.trim()
  if (!/^[+-]?\d{1,40}$/.test(text)) throw malformed(`integer ${JSON.stringify(text.slice(0, 20))}`)
  const big = BigInt(text)
  const safe = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
  return safe ? Number(big) : big
}

/**
 * An XML plist as plain values. Integers beyond 2^53 stay exact as BigInt, <data> becomes a
 * Buffer, <date> stays an ISO string, <real> a number. Returns undefined when there is no
 * root value; throws HelperError on an integer or nesting it cannot read.
 *
 * It scans tags rather than building a DOM: plists from devices are small, flat and
 * well-formed, and every value is escaped, so a `<` never appears inside a string.
 */
export function parsePlist(xml: string): PlistValue | undefined {
  const tags = /<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\s*\/)?>/g
  const stack: Array<PlistValue[] | { [key: string]: PlistValue }> = []
  let root: PlistValue | undefined
  let key: string | null = null
  let textStart = 0
  const put = (value: PlistValue): void => {
    const top = stack[stack.length - 1]
    if (!top) {
      if (root === undefined) root = value
      return
    }
    if (Array.isArray(top)) top.push(value)
    else if (key !== null) {
      top[key] = value
      key = null
    }
  }
  for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
    const [, close, tag, selfClose] = m
    if (!close && (tag === 'dict' || tag === 'array')) {
      const value: PlistValue[] | { [key: string]: PlistValue } = tag === 'dict' ? {} : []
      put(value)
      if (!selfClose) {
        /** A hostile depth would only cost recursion elsewhere; nothing real nests this deep. */
        if (stack.length >= 64) throw malformed('nested too deeply')
        stack.push(value)
      }
    } else if (close && (tag === 'dict' || tag === 'array')) {
      stack.pop()
    } else if (tag === 'true' || tag === 'false') {
      put(tag === 'true')
    } else if (!close) {
      if (selfClose) {
        if (tag === 'key') key = ''
        else put(tag === 'data' ? Buffer.alloc(0) : tag === 'integer' ? 0 : tag === 'real' ? 0 : '')
        continue
      }
      textStart = tags.lastIndex
    } else {
      const raw = xml.slice(textStart, m.index)
      if (tag === 'key') key = unescapeXml(raw)
      else if (tag === 'string') put(unescapeXml(raw))
      else if (tag === 'integer') put(parseInteger(raw))
      else if (tag === 'real') put(parseFloat(raw.trim()))
      else if (tag === 'data') put(Buffer.from(raw.replace(/\s+/g, ''), 'base64'))
      else if (tag === 'date') put(raw.trim())
    }
  }
  return root
}

/** One value as XML. Dictionary keys keep their insertion order, as Apple's writers do. */
function encode(value: PlistInput): string {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'bigint') return `<integer>${value.toString()}</integer>`
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('A plist cannot hold NaN or Infinity.')
    return Number.isInteger(value)
      ? `<integer>${String(value)}</integer>`
      : `<real>${String(value)}</real>`
  }
  if (Buffer.isBuffer(value)) return `<data>${value.toString('base64')}</data>`
  if (value instanceof Date) {
    return `<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`
  }
  if (Array.isArray(value)) return `<array>${value.map(encode).join('')}</array>`
  const entries = Object.entries(value).filter(
    (entry): entry is [string, PlistInput] => entry[1] !== undefined,
  )
  return `<dict>${entries.map(([k, v]) => `<key>${escapeXml(k)}</key>${encode(v)}`).join('')}</dict>`
}

/**
 * An XML plist document for `value`, in the shape usbmuxd and lockdownd expect (the same
 * prologue and DOCTYPE libimobiledevice sends). Numbers that are whole become <integer>,
 * others <real>; a BigInt is always an <integer>.
 */
export function buildPlist(value: PlistInput): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">${encode(value)}</plist>\n`
  )
}

/** A dictionary, or null: replies are only ever read through this guard. */
export function asDict(value: PlistValue | undefined): { [key: string]: PlistValue } | null {
  return value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
    ? value
    : null
}
