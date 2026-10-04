import type { NetworkTarget } from './client'

/*
  Android over Wi‑Fi, the page's half (§4.7): what the tester types (an address, a port, a
  pairing code), checked before anything is sent, and the devices this browser connected to
  before, for a one-click reconnect.

  The helper checks everything again (it must: the page is only one of its clients) and is the
  authority on what it accepts: an address on the local network (10.x, 172.16–31.x, 192.168.x,
  169.254.x, 100.64–127.x, fc00::/7, fe80::/10) or a `.local`, `.lan` or `.home.arpa` name,
  never loopback, never a public address. These checks mirror that, so "that isn't an address
  on your network" shows at once, in plain words, instead of after a round trip.

  Pure functions; storage is injected and every access may throw.
*/

/** adb's port for network debugging (Network debugging on a TV, `adb tcpip 5555`). */
export const DEFAULT_ADB_PORT = 5555

/** Remembered devices, per browser: localStorage, never sessionStorage (they outlive a tab). */
export const RECENT_KEY = 'dvc_wifi_recent'
/** How many remembered devices are kept, newest first. */
export const RECENT_MAX = 6

/**
 * Why an address can't be used. `public`: a valid address that isn't on a local network;
 * `loopback`: this computer itself; `name`: a host name that isn't a local one.
 */
export type HostProblem = 'empty' | 'invalid' | 'public' | 'loopback' | 'name'
export type PortProblem = 'empty' | 'invalid'
export type CodeProblem = 'empty' | 'invalid'

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const LOCAL_SUFFIXES = ['.home.arpa', '.local', '.lan'] as const
const ZONE = /^[A-Za-z0-9_-]{1,32}$/
/** The helper's limit for a name (its serial, `name:65535`, must stay a valid device id). */
const HOST_NAME_MAX = 100

/** 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local) and 100.64/10 (carrier-grade NAT). */
function isLocalIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** A plausible IPv6 literal: hex groups, one `::` at most, no dotted tail. */
function isIpv6(address: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(address) || !address.includes(':')) return false
  const halves = address.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((h) => (h === '' ? [] : h.split(':')))
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false
  return halves.length === 2 ? groups.length < 8 : groups.length === 8
}

/** fc00::/7 (unique local) and fe80::/10 (link-local). */
function isLocalIpv6(address: string): boolean {
  if (address.startsWith(':')) return false
  const first = parseInt(address.split(':')[0] ?? '', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

/**
 * The host of a Wi‑Fi device, normalised (lower case, IPv6 without brackets), or why not. The
 * same rules as the helper's parseNetworkHost, so what passes here passes there.
 */
export function checkHost(
  input: string,
): { ok: true; host: string } | { ok: false; problem: HostProblem } {
  let host = input.trim()
  if (host === '') return { ok: false, problem: 'empty' }
  if (host.length > 253) return { ok: false, problem: 'invalid' }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.includes(':')) {
    const at = host.indexOf('%')
    const address = (at < 0 ? host : host.slice(0, at)).toLowerCase()
    const zone = at < 0 ? null : host.slice(at + 1)
    if (!isIpv6(address) || (zone !== null && !ZONE.test(zone))) {
      return { ok: false, problem: 'invalid' }
    }
    if (address === '::1') return { ok: false, problem: 'loopback' }
    if (!isLocalIpv6(address)) return { ok: false, problem: 'public' }
    return { ok: true, host: address + (zone === null ? '' : `%${zone}`) }
  }
  if (/^[\d.]+$/.test(host)) {
    // Only digits and dots: an IPv4 address, or a typo of one, never a name.
    if (!IPV4.test(host)) return { ok: false, problem: 'invalid' }
    if (host.startsWith('127.')) return { ok: false, problem: 'loopback' }
    if (!isLocalIpv4(host)) return { ok: false, problem: 'public' }
    return { ok: true, host }
  }
  const name = host.toLowerCase().replace(/\.$/, '')
  if (!name.split('.').every((label) => LABEL.test(label))) {
    return { ok: false, problem: 'invalid' }
  }
  const suffix = LOCAL_SUFFIXES.find((s) => name.endsWith(s))
  if (name === 'localhost') return { ok: false, problem: 'loopback' }
  if (!suffix || name.length === suffix.length || name.length > HOST_NAME_MAX) {
    return { ok: false, problem: 'name' }
  }
  return { ok: true, host: name }
}

export const isHost = (text: string): boolean => checkHost(text).ok

export const isNetworkPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535

/**
 * What the address field holds: a host, and a port when one was pasted with it
 * ("192.168.1.20:41235", as the Wireless debugging screen writes it, or "[fe80::1]:5555").
 * Spaces around are ignored.
 */
export function parseAddress(
  input: string,
): { ok: true; host: string; port: number | null } | { ok: false; problem: HostProblem } {
  const text = input.trim()
  if (text === '') return { ok: false, problem: 'empty' }
  // "host:port" with one colon, or "[v6]:port"; a bare IPv6 address has several colons.
  const withPort = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(text)
  const port = withPort?.[2] === undefined ? null : Number(withPort[2])
  if (port !== null && !isNetworkPort(port)) return { ok: false, problem: 'invalid' }
  const host = checkHost(withPort?.[1] ?? text)
  return host.ok ? { ok: true, host: host.host, port } : host
}

/** The port field: digits only; empty means `fallback` (or a problem without one). */
export function parsePort(
  input: string,
  fallback: number | null = DEFAULT_ADB_PORT,
): { ok: true; port: number } | { ok: false; problem: PortProblem } {
  const text = input.trim()
  if (text === '')
    return fallback === null ? { ok: false, problem: 'empty' } : { ok: true, port: fallback }
  if (!/^\d{1,5}$/.test(text) || !isNetworkPort(Number(text))) {
    return { ok: false, problem: 'invalid' }
  }
  return { ok: true, port: Number(text) }
}

/** The six digits Wireless debugging shows; spaces and dashes typed between them are dropped. */
export function parsePairingCode(
  input: string,
): { ok: true; code: string } | { ok: false; problem: CodeProblem } {
  const code = input.replace(/[\s-]/g, '')
  if (code === '') return { ok: false, problem: 'empty' }
  return /^\d{6}$/.test(code) ? { ok: true, code } : { ok: false, problem: 'invalid' }
}

/** "192.168.1.20:5555", or "[fe80::1%en0]:5555": as adb writes a network serial. */
export const addressOf = (target: NetworkTarget): string =>
  `${target.host.includes(':') ? `[${target.host}]` : target.host}:${String(target.port)}`

/**
 * The host and port in an adb serial that came from a connect ("192.168.1.20:5555"); null for
 * any other serial, mDNS ones included (adb-…._adb-tls-connect._tcp), which the page doesn't
 * remember by address.
 */
export function targetOfSerial(serial: string): NetworkTarget | null {
  const parsed = parseAddress(serial)
  return parsed.ok && parsed.port !== null ? { host: parsed.host, port: parsed.port } : null
}

/* ---------------------------------------------------------------- *
 * Remembered devices
 * ---------------------------------------------------------------- */

export interface RecentDevice {
  readonly host: string
  readonly port: number
  /** The device's name once it was listed ("SHIELD Android TV"); '' until then. */
  readonly name: string
  /** When it was last connected (ms since the epoch). */
  readonly at: number
}

/** localStorage's part; every call may throw (private mode, blocked storage). */
export type RecentStore = Pick<Storage, 'getItem' | 'setItem'>

export function defaultRecentStore(): RecentStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export const sameTarget = (a: NetworkTarget, b: NetworkTarget) =>
  a.host === b.host && a.port === b.port

const NAME_MAX = 200

function isRecent(value: unknown): value is RecentDevice {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.host === 'string' &&
    checkHost(r.host).ok &&
    typeof r.port === 'number' &&
    isNetworkPort(r.port) &&
    typeof r.name === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  )
}

/** The remembered devices, newest first; [] when nothing (readable) is stored. */
export function readRecent(store: RecentStore | null = defaultRecentStore()): RecentDevice[] {
  try {
    const raw = store?.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('items' in parsed)) return []
    const items = parsed.items
    if (!Array.isArray(items)) return []
    return items
      .filter(isRecent)
      .map((r) => ({ host: r.host, port: r.port, name: r.name.slice(0, NAME_MAX), at: r.at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

function writeRecent(items: readonly RecentDevice[], store: RecentStore | null) {
  try {
    store?.setItem(RECENT_KEY, JSON.stringify({ v: 1, items: items.slice(0, RECENT_MAX) }))
  } catch {
    // Storage full or blocked: the list is a convenience, never needed.
  }
}

/**
 * Remembers a device that connected (it goes first). A name already known is kept when the new
 * one is empty: the row may not be listed yet when the connect answers.
 */
export function rememberRecent(
  target: NetworkTarget & { readonly name?: string },
  at: number,
  store: RecentStore | null = defaultRecentStore(),
): RecentDevice[] {
  const current = readRecent(store)
  const known = current.find((r) => sameTarget(r, target))
  const entry: RecentDevice = {
    host: target.host,
    port: target.port,
    name: (target.name ?? '').slice(0, NAME_MAX) || known?.name || '',
    at,
  }
  const next = [entry, ...current.filter((r) => !sameTarget(r, target))].slice(0, RECENT_MAX)
  writeRecent(next, store)
  return next
}

/** Names a remembered device once it is listed, keeping its place in the list. */
export function renameRecent(
  target: NetworkTarget,
  name: string,
  store: RecentStore | null = defaultRecentStore(),
): RecentDevice[] {
  const current = readRecent(store)
  const clean = name.slice(0, NAME_MAX)
  if (!clean || !current.some((r) => sameTarget(r, target) && r.name !== clean)) return current
  const next = current.map((r) => (sameTarget(r, target) ? { ...r, name: clean } : r))
  writeRecent(next, store)
  return next
}

export function forgetRecent(
  target: NetworkTarget,
  store: RecentStore | null = defaultRecentStore(),
): RecentDevice[] {
  const next = readRecent(store).filter((r) => !sameTarget(r, target))
  writeRecent(next, store)
  return next
}

/** "Living room TV · 192.168.1.20:5555", or the address alone before a name is known. */
export const recentLabel = (r: RecentDevice): string =>
  r.name ? `${r.name} · ${addressOf(r)}` : addressOf(r)
