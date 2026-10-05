import { LAN_KINDS, type VendorInfo, type VendorLookup } from './lan-kinds'

/*
  Who made a device on this network, by the 3-byte prefix the helper derived from its hardware
  address (never the address itself). The table (lan-vendors.data.ts, generated, its format
  described there) is fetched as its own chunk, and only once a device has a prefix: most
  lists on macOS have none, and the page never pays for it then.
*/

/** The generated module's shape. */
export interface VendorTable {
  readonly COUNT: number
  readonly BRANDS: readonly { readonly n: string; readonly h?: string }[]
  readonly PREFIXES: string
  readonly INDEX: string
}

/** The varints' digits, base64url's alphabet: 0–31 means more digits follow, 32–63 ends one. */
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const DIGIT_VALUE = new Map(
  Array.from(DIGITS, (char, i): [number, number] => [char.charCodeAt(0), i]),
)

/** Exactly `count` numbers out of `text`, or an error: a table that doesn't read is no table. */
function varints(text: string, count: number): Uint32Array {
  const out = new Uint32Array(count)
  let value = 0
  let read = 0
  for (let i = 0; i < text.length; i++) {
    const digit = DIGIT_VALUE.get(text.charCodeAt(i))
    if (digit === undefined || read === count) throw new Error('lan-vendors: unreadable table')
    value = value * 32 + (digit & 31)
    if (digit >= 32) {
      out[read++] = value
      value = 0
    }
  }
  if (read !== count || value !== 0) throw new Error('lan-vendors: unreadable table')
  return out
}

/**
 * A lookup over the table: its prefixes decoded once (some 16,000, a few milliseconds), then
 * a binary search for each. Throws on a table that doesn't read, which loadVendors passes on.
 */
export function vendorLookup(table: VendorTable): VendorLookup {
  const keys = varints(table.PREFIXES, table.COUNT)
  // Each is stored as its gap to the one before, minus 1.
  let previous = -1
  for (let i = 0; i < keys.length; i++) {
    previous += 1 + (keys[i] ?? 0)
    if (previous > 0xffffff) throw new Error('lan-vendors: unreadable table')
    keys[i] = previous
  }
  const makers = varints(table.INDEX, table.COUNT)
  const brands: VendorInfo[] = table.BRANDS.map(({ n, h }) => {
    // Every LanKind is a valid maker hint, `phone` among them: §4.2 rule 6 here covers makers
    // whose universal (non-random) addresses are mostly phones, which the curated brand list
    // marks deliberately (e.g. "Huawei Device", and desk IP-phone makers), while a maker whose
    // phones randomise their address carries no hint at all. A kind the page doesn't know (a
    // table newer than this build) is treated as no hint rather than trusted blindly.
    const hint = LAN_KINDS.find((kind) => kind === h)
    return hint ? { name: n, hint } : { name: n }
  })
  if (makers.some((maker) => maker >= brands.length)) {
    throw new Error('lan-vendors: unreadable table')
  }
  return (prefix) => {
    if (!/^[0-9A-F]{6}$/.test(prefix)) return null
    const key = parseInt(prefix, 16)
    let lo = 0
    let hi = keys.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const at = keys[mid] ?? 0
      if (at === key) return brands[makers[mid] ?? 0] ?? null
      if (at < key) lo = mid + 1
      else hi = mid - 1
    }
    return null
  }
}

let loading: Promise<VendorLookup> | null = null

/** The table, fetched once per page; after a failed fetch (offline), the next call tries again. */
export function loadVendors(): Promise<VendorLookup> {
  if (loading) return loading
  const load = import('./lan-vendors.data').then(vendorLookup)
  loading = load
  void load.catch(() => {
    if (loading === load) loading = null
  })
  return load
}
