#!/usr/bin/env node
/*
  Writes src/features/device/lan-vendors.data.ts: who made a network device, by the 3-byte prefix of
  its hardware address (Device Lab's helper sends only that prefix, never the address itself).

  Source: the IEEE MA-L registry (public, refreshed daily upstream), kept to the curated makers found
  in homes and small offices (scripts/oui-brands.mjs), each under the short name people know and, when
  its addresses mostly sit on one kind of device, a kind hint. lan-vendors.ts reads the output.

    node scripts/oui.mjs                 # downloads https://standards-oui.ieee.org/oui/oui.csv
    node scripts/oui.mjs --csv oui.csv   # a copy you already have
    node scripts/oui.mjs --list          # also print the IEEE names each brand matched

  It refuses to write when an IEEE name matches two brands or a pattern matches nothing, so a registry
  change that breaks a brand shows up here, not as a wrong name on the page. Rerun it now and then.
*/
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { BRANDS, HINTS } from './oui-brands.mjs'

const SOURCE = 'https://standards-oui.ieee.org/oui/oui.csv'
const OUT = fileURLToPath(new URL('../src/features/device/lan-vendors.data.ts', import.meta.url))

/** The varints' digits, base64url's alphabet (must match lan-vendors.ts). */
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 00:00:00 belongs to Xerox, but an all-zero address is a placeholder, not a Xerox device. */
const SKIP_PREFIXES = new Set(['000000'])

/** RFC 4180: quoted fields, "" escapes, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** IEEE names hold double and no-break spaces; the patterns use plain single spaces. */
const normalizeName = (name) => name.replace(/\s+/g, ' ').trim()

function readRegistry(text) {
  const [header, ...rows] = parseCsv(text)
  if (header?.[1] !== 'Assignment' || header?.[2] !== 'Organization Name') {
    throw new Error(`unexpected header ${JSON.stringify(header)}`)
  }
  return rows
    .filter((r) => r[0] === 'MA-L')
    .map((r) => {
      if (!/^[0-9A-F]{6}$/.test(r[1])) throw new Error(`bad assignment ${JSON.stringify(r)}`)
      return { prefix: r[1], name: normalizeName(r[2]) }
    })
}

function checkBrands() {
  const problems = []
  BRANDS.forEach((b, i) => {
    const where = `BRANDS[${i}] ${b.name}`
    if (!b.name || typeof b.name !== 'string') problems.push(`${where}: bad name`)
    if (!Array.isArray(b.match) || !b.match.length) problems.push(`${where}: match must be a non-empty array`)
    for (const re of b.match ?? []) {
      if (!(re instanceof RegExp) || !re.flags.includes('i') || re.global || re.sticky) {
        problems.push(`${where}: ${re} must be a RegExp with the i flag only`)
      }
    }
    if (b.hint !== undefined && !HINTS.includes(b.hint)) problems.push(`${where}: unknown hint ${b.hint}`)
  })
  return problems
}

/** Every distinct IEEE name against the patterns: a brand per name, and what went wrong. */
function classify(rows) {
  const names = new Set(rows.map((r) => r.name))
  const brandOf = new Map()
  const conflicts = []
  const used = new Set()
  for (const name of names) {
    const hits = new Set()
    BRANDS.forEach((b, i) =>
      b.match.forEach((re, j) => {
        if (re.test(name)) {
          hits.add(i)
          used.add(`${i}/${j}`)
        }
      }),
    )
    if (hits.size > 1) conflicts.push(`"${name}" matches ${[...hits].map((i) => BRANDS[i].name).join(' + ')}`)
    if (hits.size) brandOf.set(name, [...hits][0])
  }
  const dead = []
  BRANDS.forEach((b, i) =>
    b.match.forEach((re, j) => {
      if (!used.has(`${i}/${j}`)) dead.push(`${b.name}: ${re} matches no IEEE name`)
    }),
  )
  return { brandOf, conflicts, dead }
}

/** base-32 varint over DIGITS; a digit in 0–31 means "more follow", 32–63 ends the number. */
function encodeVarint(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`cannot encode ${n}`)
  let s = DIGITS[32 + (n % 32)]
  for (n = Math.floor(n / 32); n > 0; n = Math.floor(n / 32)) s = DIGITS[n % 32] + s
  return s
}

async function main(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const csvPath = at('--csv')
  const text = csvPath
    ? readFileSync(csvPath, 'utf8')
    : await fetch(SOURCE).then((r) => {
        if (!r.ok) throw new Error(`${SOURCE}: HTTP ${r.status}`)
        return r.text()
      })
  const date = csvPath
    ? statSync(csvPath).mtime.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  const problems = checkBrands()
  const rows = readRegistry(text)
  const { brandOf, conflicts, dead } = classify(rows)
  problems.push(...conflicts, ...dead)
  if (problems.length) {
    for (const p of problems) console.error(p)
    process.exit(1)
  }

  const entries = rows
    .filter((r) => brandOf.has(r.name) && !SKIP_PREFIXES.has(r.prefix))
    .map((r) => ({ key: parseInt(r.prefix, 16), brand: brandOf.get(r.name) }))
    .sort((a, b) => a.key - b.key)
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].key === entries[i - 1].key) throw new Error(`duplicate prefix ${entries[i].key.toString(16)}`)
  }

  // One BRANDS slot per (name, hint), the busiest first so the common ones get one-digit indexes.
  const keyOf = (i) => `${BRANDS[i].name}\u0000${BRANDS[i].hint ?? ''}`
  const count = new Map()
  for (const e of entries) count.set(keyOf(e.brand), (count.get(keyOf(e.brand)) ?? 0) + 1)
  const order = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b))
  const position = new Map(order.map((k, i) => [k, i]))
  const brandByKey = new Map(entries.map((e) => [keyOf(e.brand), e.brand]))

  let prefixes = ''
  let index = ''
  let prev = -1
  for (const e of entries) {
    prefixes += encodeVarint(e.key - prev - 1) // gap to the previous prefix, minus 1
    index += encodeVarint(position.get(keyOf(e.brand)))
    prev = e.key
  }
  const brands = order.map((k) => {
    const b = BRANDS[brandByKey.get(k)]
    return b.hint ? { n: b.name, h: b.hint } : { n: b.name }
  })
  const distinct = new Set(brands.map((b) => b.n)).size

  if (argv.includes('--list')) {
    for (const [name, i] of [...brandOf].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
      console.log(`${BRANDS[i].name.padEnd(24)} ${name}`)
    }
  }

  writeFileSync(
    OUT,
    [
      `// Generated by scripts/oui.mjs from the IEEE MA-L registry (${date}). Do not edit by hand:`,
      '// change scripts/oui-brands.mjs and run `node scripts/oui.mjs` again. lan-vendors.ts reads this.',
      `// ${entries.length} prefixes, ${distinct} makers. Source: ${SOURCE} (IEEE public listing, no copyright asserted).`,
      '',
      `export const COUNT = ${entries.length}`,
      '',
      '/** "Name" and an optional kind hint, the busiest maker first. */',
      `export const BRANDS: readonly { readonly n: string; readonly h?: string }[] = ${JSON.stringify(brands)}`,
      '',
      '/** The sorted 24-bit prefixes, each a base-32 varint of its gap to the one before, minus 1. */',
      `export const PREFIXES = '${prefixes}'`,
      '',
      '/** One base-32 varint per prefix: its maker in BRANDS. */',
      `export const INDEX = '${index}'`,
      '',
    ].join('\n'),
  )
  const bytes = Buffer.byteLength(prefixes) + Buffer.byteLength(index)
  console.log(`${entries.length} prefixes, ${order.length} brand slots, ${distinct} makers; data ${(bytes / 1024).toFixed(1)} KB → ${OUT}`)
}

await main(process.argv.slice(2))
