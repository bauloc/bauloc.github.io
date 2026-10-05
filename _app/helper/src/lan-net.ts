import dgram from 'node:dgram'
import { open as openFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { offerableAddress } from './android-lane'
import { LIMITS } from './constants'
import { closeSocket, mdnsFailure } from './mdns'
import type { RunTool } from './process'
import type { LanNetwork } from './types'
import { abortError, clean, linkSignals } from './util'

/**
 * §15 LAN sources: what the helper may learn about this computer's own network (§4.9), each
 * source on its own, read-only, bounded, and fed only by what the helper derives itself. A
 * page names nothing here: no address, range or port ever comes from a request.
 *
 * - Interfaces: the networks looked at are this computer's own private IPv4 networks on real
 *   interfaces (never a VPN tunnel, a VM or container bridge, AirDrop or loopback), at most
 *   the /24 around this computer on a larger one, at most 512 addresses in all.
 * - Presence: one byte in one UDP datagram to port 9 of each of those addresses, from a
 *   connected socket. A host that is there answers with ICMP port unreachable, which the
 *   socket reports as ECONNREFUSED: the one sign of life that needs no privilege and no
 *   process, and that phones dropping TCP and ping still give [V 2026-10-04: 15–615 ms on
 *   the owner's network, the dozing Pixel included]. Silence says nothing.
 * - The neighbour (ARP) table, where the system shares it (macOS 27 shows the helper an empty
 *   one), and the default gateway, through fixed system paths or Linux's /proc files.
 * - SSDP: one M-SEARCH socket, and the UPnP description a device points to in its answer,
 *   fetched only from that device's own address: the one HTTP request the helper makes.
 *
 * Every answer is untrusted: tables and answers are matched line by line against their exact
 * shape, sizes are capped before anything is parsed, and a hardware address is only ever
 * turned into the two facts macFacts() allows, never passed on.
 */

/* ------------------------------------------------------------------ addresses --- */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

const toInt = (address: string): number =>
  address.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0)

const fromInt = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map(String).join('.')

/** 255.255.255.0 → 24; null for a mask whose ones are not contiguous. */
function prefixOf(netmask: string): number | null {
  if (!IPV4.test(netmask)) return null
  const mask = toInt(netmask)
  for (let prefix = 0; prefix <= 32; prefix++) {
    if ((prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0) === mask) return prefix
  }
  return null
}

/** 10/8, 172.16/12 and 192.168/16: the networks a home or an office is on. */
function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/* ----------------------------------------------------------------- interfaces --- */

/** One address of one of this computer's interfaces, as os.networkInterfaces() lists it. */
export interface LanInterface {
  /** `en0` */
  name: string
  address: string
  netmask: string
  /** `IPv4` (Node 18.0–18.3 says 4). */
  family: string | number
  internal: boolean
}

/** os.networkInterfaces(), flattened: BridgeOptions.lanInterfaces' default. */
export function systemInterfaces(): LanInterface[] {
  const out: LanInterface[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      out.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        family: entry.family,
        internal: entry.internal,
      })
    }
  }
  return out
}

/**
 * Interfaces that are not a local network of their own: VPN tunnels (utun, tun, tap, WireGuard,
 * Tailscale, ZeroTier, PPP, IPsec), VM and container bridges, AirDrop's, loopback.
 */
const VIRTUAL_INTERFACE =
  /^(?:utun|tun|tap|wg|tailscale|zt|ppp|ipsec|gif|stf|awdl|llw|bridge|vmnet|vboxnet|docker|br-|veth|virbr|lo)/i

/** At most this many networks are listed, whatever the interfaces say. */
const MAX_NETWORKS = 16

/** One network looked at: its range, and the part of it the presence check covers. */
export interface LanRange {
  /** Its network and broadcast addresses, as numbers: never targets, never devices. */
  network: number
  broadcast: number
}

export interface LanPlan {
  networks: LanNetwork[]
  /** The addresses the presence check covers, in order: never this computer's own. */
  targets: string[]
  /** This computer's own addresses on those networks → the interface. */
  own: Map<string, string>
  ranges: LanRange[]
}

/**
 * The networks to look at (§4.9): each non-internal IPv4 address in 10/8, 172.16/12 or
 * 192.168/16 on an interface that is not virtual (169.254/16 and 100.64/10 never are: link-local,
 * and carrier-grade NAT or Tailscale), with a prefix from 8 to 30. The presence check covers
 * the whole network when it is a /24 or smaller, else the /24 around this computer's address;
 * a network's own network and broadcast addresses, and this computer's, are never targets.
 * `scanned` counts the host addresses covered (this computer's included), so a whole /24 reads
 * 254 of 254. Once `maxTargets` addresses are planned, a network that does not fit is listed
 * with `scanned: 0`; one whose addresses another interface already covers adds none.
 */
export function lanNetworks(
  interfaces: readonly LanInterface[],
  maxTargets: number = LIMITS.lanTargets,
): LanPlan {
  const lan = interfaces
    .filter(
      (i) =>
        (i.family === 'IPv4' || i.family === 4) &&
        !i.internal &&
        IPV4.test(i.address) &&
        isPrivateIpv4(i.address) &&
        !VIRTUAL_INTERFACE.test(i.name),
    )
    .slice(0, MAX_NETWORKS)
  const own = new Map<string, string>()
  for (const i of lan) if (!own.has(i.address)) own.set(i.address, clean(i.name, 40))
  const networks: LanNetwork[] = []
  const targets: string[] = []
  const ranges: LanRange[] = []
  const planned = new Set<number>()
  for (const i of lan) {
    const prefix = prefixOf(i.netmask)
    if (prefix === null || prefix < 8 || prefix > 30) continue
    const self = toInt(i.address)
    const block = 2 ** (32 - prefix)
    const network = (self - (self % block)) >>> 0
    const broadcast = network + block - 1
    const start = prefix >= 24 ? network : self - (self % 256)
    const end = prefix >= 24 ? broadcast : start + 255
    const fresh: number[] = []
    let covered = 0
    for (let n = start; n <= end; n++) {
      if (n === network || n === broadcast) continue
      covered++
      if (!own.has(fromInt(n)) && !planned.has(n)) fresh.push(n)
    }
    ranges.push({ network, broadcast })
    const fits = targets.length + fresh.length <= maxTargets
    if (fits) {
      for (const n of fresh) {
        planned.add(n)
        targets.push(fromInt(n))
      }
    }
    networks.push({
      interface: clean(i.name, 40),
      address: i.address,
      prefix,
      size: block - 2,
      scanned: fits ? covered : 0,
    })
  }
  return { networks, targets, own, ranges }
}

/** On one of `ranges`, and neither its network nor its broadcast address. */
export function onLan(address: string, ranges: readonly LanRange[]): boolean {
  if (!IPV4.test(address)) return false
  const n = toInt(address)
  return ranges.some((r) => n > r.network && n < r.broadcast)
}

/* ------------------------------------------------------------------- presence --- */

/** What one presence check of an address saw. */
export type PresenceAnswer = 'refused' | 'silent'

/**
 * One presence check (§4.9): `address`:`port` through a udp4 socket connected to it, one 1-byte
 * datagram. Resolves `refused` when ICMP port unreachable came back (the socket's ECONNREFUSED:
 * something is at that address), `silent` when `windowMs` ends, the signal aborts or a later
 * error says nothing is there; rejects with the error that kept the byte from leaving
 * (EHOSTUNREACH at once: this computer refused to send it). Its socket is closed before it
 * settles, however it ends. One datagram suits the whole look's time budget (§4.9), and the
 * window still catches a dozing device [V 2026-10-04: every live host answered in 15–615 ms].
 */
export type OpenPresence = (
  address: string,
  o: { port: number; windowMs: number; signal: AbortSignal },
) => Promise<PresenceAnswer>

const PROBE = Buffer.from([0])

/** The real presence check: BridgeOptions.lanPresence's default. */
export function presenceTransport(): OpenPresence {
  return (address, o) =>
    new Promise((resolve, reject) => {
      if (o.signal.aborted) return resolve('silent')
      const socket = dgram.createSocket({ type: 'udp4' })
      let settled = false
      let sent = false
      const settle = (outcome: PresenceAnswer | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        o.signal.removeEventListener('abort', onAbort)
        closeSocket(socket)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      const onAbort = (): void => settle('silent')
      const timer = setTimeout(() => settle('silent'), o.windowMs)
      o.signal.addEventListener('abort', onAbort, { once: true })
      /** Port unreachable is the answer; after the byte left, any other error means nobody. */
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') settle('refused')
        else settle(sent ? 'silent' : error)
      })
      /** Node passes connect's error to its callback, though its types leave the argument out. */
      socket.connect(o.port, address, (error?: Error) => {
        if (error) return settle(error)
        if (settled) return
        socket.send(PROBE, (sendError) => {
          if (sendError) settle(sendError)
          else sent = true
        })
      })
    })
}

/** New sockets per tick, and the tick: at most 400 a second, so replies are not dropped. */
const PRESENCE_PACE = { perTick: 4, tickMs: 10 }

export interface PresenceOptions {
  open: OpenPresence
  port: number
  /** How long each socket waits for its answer (`lanPresence`). */
  windowMs: number
  /** Sockets open at once (LIMITS.lanSockets). */
  pool: number
  signal: AbortSignal
}

export interface PresenceResult {
  /** The addresses that answered. */
  present: Set<string>
  /** Checks whose byte left (or that the signal ended first). */
  sent: number
  /** Why not one byte left, when none did. */
  failure?: ReturnType<typeof mdnsFailure>
}

/**
 * The presence check of every target (§4.9): one socket each, at most `pool` open at once,
 * opened at most 4 every 10 ms, each closed at its answer or after `windowMs`. With the
 * defaults a /24 is done in about 1.7 s and two in about 2.7 s. When the signal aborts no
 * socket is opened any more and every open one is closed at once. The sockets wait on a signal
 * of its own, linked to `o.signal`, which takes their 256 abort listeners without Node 18 and
 * 20's warning, whatever signal the caller passed.
 */
export function checkPresence(
  targets: readonly string[],
  o: PresenceOptions,
): Promise<PresenceResult> {
  const run = linkSignals([o.signal])
  return new Promise<PresenceResult>((resolve) => {
    const present = new Set<string>()
    let sent = 0
    let first: unknown = null
    let next = 0
    let open = 0
    let timer: NodeJS.Timeout | undefined
    let ended = false
    const end = (): void => {
      if (ended || open > 0 || timer !== undefined) return
      if (next < targets.length && !run.signal.aborted) return
      ended = true
      run.signal.removeEventListener('abort', onAbort)
      resolve({
        present,
        sent,
        ...(sent === 0 && first !== null ? { failure: mdnsFailure(first) } : {}),
      })
    }
    const launch = (address: string): void => {
      open++
      Promise.resolve()
        .then(() => o.open(address, { port: o.port, windowMs: o.windowMs, signal: run.signal }))
        .then(
          (answer) => {
            sent++
            if (answer === 'refused') present.add(address)
          },
          (error: unknown) => {
            first ??= error
          },
        )
        .finally(() => {
          open--
          end()
        })
    }
    const tick = (): void => {
      timer = undefined
      if (!run.signal.aborted) {
        for (let n = 0; n < PRESENCE_PACE.perTick && open < o.pool; n++) {
          const address = targets[next]
          if (address === undefined) break
          next++
          launch(address)
        }
        if (next < targets.length) timer = setTimeout(tick, PRESENCE_PACE.tickMs)
      }
      end()
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      timer = undefined
      end()
    }
    run.signal.addEventListener('abort', onAbort, { once: true })
    tick()
  }).finally(() => run.dispose())
}

/* ------------------------------------------------------ hardware addresses --- */

/** `6c:2:e0:f2:5f:81` (macOS drops leading zeros), `6C-02-E0-F2-5F-81` → `6c:02:e0:f2:5f:81`. */
export function normalizeMac(text: string): string | null {
  const parts = text.trim().split(/[:-]/)
  if (parts.length !== 6 || !parts.every((p) => /^[0-9A-Fa-f]{1,2}$/.test(p))) return null
  return parts.map((p) => p.padStart(2, '0').toLowerCase()).join(':')
}

/** A hardware address of one device: not all zeros, not multicast, not broadcast. */
export function unicastMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 0x01) === 0 && mac !== '00:00:00:00:00:00'
}

/**
 * All a hardware address may tell (§4.9): whether it is a private one (the locally
 * administered bit: phones, tablets and laptops make one up per network), and, only when it
 * is not, its maker's 3-byte prefix. The address itself goes no further.
 */
export function macFacts(mac: string): { privateAddress: boolean; maker?: string } {
  const privateAddress = (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0
  return privateAddress
    ? { privateAddress }
    : { privateAddress, maker: mac.slice(0, 8).replace(/:/g, '').toUpperCase() }
}

/* ------------------------------------------------------- the neighbour table --- */

export interface Neighbour {
  address: string
  /** Normalised: `6c:02:e0:f2:5f:81`. */
  mac: string
}

/** Entries kept from one table, whatever it holds. */
const MAX_NEIGHBOURS = 1_024
/** A table or a route listing larger than this is not read past it. */
const MAX_TABLE = 256 * 1024

function neighbour(address: string | undefined, mac: string | undefined): Neighbour | null {
  const normal = normalizeMac(mac ?? '')
  return address && IPV4.test(address) && normal && unicastMac(normal)
    ? { address, mac: normal }
    : null
}

function neighbours(text: string, read: (line: string) => Neighbour | null): Neighbour[] {
  const out: Neighbour[] = []
  for (const line of text.split('\n')) {
    const entry = read(line)
    if (entry) out.push(entry)
    if (out.length >= MAX_NEIGHBOURS) break
  }
  return out
}

/**
 * macOS `arp -an`: `? (192.168.68.1) at 14:eb:b6:97:cd:50 on en0 ifscope [ethernet]`, octets
 * without leading zeros; `(incomplete)` and multicast entries are no device.
 */
export function parseArpDarwin(text: string): Neighbour[] {
  return neighbours(text, (line) => {
    const m = /^\S*\s*\((\S+)\) at ([0-9A-Fa-f]{1,2}(?::[0-9A-Fa-f]{1,2}){5}) on \S/.exec(line)
    return neighbour(m?.[1], m?.[2])
  })
}

/**
 * Linux /proc/net/arp: `IP address  HW type  Flags  HW address  Mask  Device` rows; only flags
 * 0x2 (complete) and 0x6 (permanent) carry an address that answered.
 */
export function parseProcNetArp(text: string): Neighbour[] {
  return neighbours(text, (line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6 || !/^0x[0-9A-Fa-f]+$/.test(fields[2] ?? '')) return null
    const flags = parseInt(fields[2] ?? '', 16)
    return flags === 0x2 || flags === 0x6 ? neighbour(fields[0], fields[3]) : null
  })
}

/**
 * Windows `ARP.EXE -a`: under each `Interface: … --- 0x4` header, rows of an address, a
 * hyphenated hardware address and a type word. The headers and the word are translated
 * (`dynamisch`), so neither is read: the row's shape and the address decide.
 */
export function parseArpWindows(text: string): Neighbour[] {
  return neighbours(text, (line) => {
    const m = /^\s*(\S+)\s+([0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})\s+\S+\s*$/.exec(line)
    return neighbour(m?.[1], m?.[2])
  })
}

/** At most `max` bytes of a file (a /proc file reports no size), or a rejection. */
async function readCapped(file: string, max: number): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error(`${file} is not an absolute path.`)
  const handle = await openFile(file, 'r')
  try {
    const buffer = Buffer.alloc(max)
    let length = 0
    while (length < max) {
      const { bytesRead } = await handle.read(buffer, length, max - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    return buffer.toString('utf8', 0, length)
  } finally {
    await handle.close()
  }
}

export interface TableOptions {
  platform: NodeJS.Platform
  arpPath: string
  procNetArpPath: string
  procNetRoutePath: string
  routePath: string
  /** The bridge's runTool: absolute paths only, its limiter, killed on shutdown. */
  runTool: RunTool
  signal: AbortSignal
}

/** How long the neighbour table's tool may take, and the route's. */
const TABLE_MS = 3_000
const ROUTE_MS = 2_000

/**
 * The neighbour table (§4.9): `ok` with its complete entries, `hidden` when it was read and
 * held none (what macOS 27 shows a process like the helper: `arp -an` prints nothing),
 * `none` when it could not be read. Never throws.
 */
export async function readNeighbours(
  o: TableOptions,
): Promise<{ entries: Neighbour[]; state: 'ok' | 'hidden' | 'none' }> {
  try {
    let entries: Neighbour[]
    if (o.platform === 'linux') {
      entries = parseProcNetArp(await readCapped(o.procNetArpPath, MAX_TABLE))
    } else if (o.platform === 'darwin' || o.platform === 'win32') {
      const { stdout } = await o.runTool(o.arpPath, o.platform === 'win32' ? ['-a'] : ['-an'], {
        timeoutMs: TABLE_MS,
        maxBytes: MAX_TABLE,
        signal: o.signal,
      })
      entries = o.platform === 'win32' ? parseArpWindows(stdout) : parseArpDarwin(stdout)
    } else return { entries: [], state: 'none' }
    return { entries, state: entries.length ? 'ok' : 'hidden' }
  } catch {
    return { entries: [], state: 'none' }
  }
}

/* ---------------------------------------------------------- the default gateway --- */

/** macOS `route -n get default`: its `gateway:` line, when that is an IPv4 address. */
export function parseRouteGetDefault(text: string): string | null {
  const m = /^\s*gateway:\s*(\S+)\s*$/m.exec(text)
  return m?.[1] && IPV4.test(m[1]) ? m[1] : null
}

/**
 * Linux /proc/net/route: of the default routes (Destination 00000000, flags RTF_UP and
 * RTF_GATEWAY), the gateway of the one with the lowest metric, written in hex in network
 * order read as a little-endian number: `0102A8C0` is 192.168.2.1.
 */
export function parseProcNetRoute(text: string): string | null {
  let best: { address: string; metric: number } | null = null
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 8 || f[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2] ?? '')) continue
    if ((parseInt(f[3] ?? '', 16) & 0x3) !== 0x3) continue
    const address = (f[2]?.match(/../g) ?? [])
      .reverse()
      .map((hex) => String(parseInt(hex, 16)))
      .join('.')
    const metric = Number(f[6])
    if (IPV4.test(address) && address !== '0.0.0.0' && (!best || metric < best.metric)) {
      best = { address, metric }
    }
  }
  return best?.address ?? null
}

/**
 * Windows `ROUTE.EXE print -4 0.0.0.0`: rows of `0.0.0.0  0.0.0.0  <gateway>  <interface>
 * <metric>`, the gateway of the lowest metric. Columns by position; no translated word read.
 */
export function parseRouteWindows(text: string): string | null {
  let best: { address: string; metric: number } | null = null
  for (const line of text.split('\n')) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d{1,9})\s*$/.exec(line)
    if (!m?.[1] || !IPV4.test(m[1]) || !IPV4.test(m[2] ?? '')) continue
    const metric = Number(m[3])
    if (!best || metric < best.metric) best = { address: m[1], metric }
  }
  return best?.address ?? null
}

/** The default gateway's IPv4 address, or null. Never throws. */
export async function readGateway(o: TableOptions): Promise<string | null> {
  try {
    if (o.platform === 'linux') {
      return parseProcNetRoute(await readCapped(o.procNetRoutePath, MAX_TABLE))
    }
    if (o.platform !== 'darwin' && o.platform !== 'win32') return null
    const argv = o.platform === 'win32' ? ['print', '-4', '0.0.0.0'] : ['-n', 'get', 'default']
    const { stdout } = await o.runTool(o.routePath, argv, {
      timeoutMs: ROUTE_MS,
      maxBytes: MAX_TABLE,
      signal: o.signal,
    })
    return o.platform === 'win32' ? parseRouteWindows(stdout) : parseRouteGetDefault(stdout)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------ SSDP --- */

export const SSDP_ADDRESS = '239.255.255.250'
export const SSDP_PORT = 1900

/** An SSDP answer is a few hundred bytes (UDA 2.0 §1.3.3); a larger datagram is dropped. */
const MAX_SSDP_PACKET = 2 * 1024
/** Header lines read from one answer. */
const MAX_SSDP_HEADERS = 32

/** Where M-SEARCHes go and answers come from; tests hand the step a fake (fakes/lan.ts). */
export interface SsdpTransport {
  /** Sends one M-SEARCH out of the interface with this address; rejects when it could not leave. */
  readonly send: (packet: Buffer, local: string) => Promise<void>
  readonly close: () => void
}

/** Opens a transport that hands every datagram it receives, and its sender, to `onPacket`. */
export type OpenSsdp = (onPacket: (packet: Buffer, from: string) => void) => Promise<SsdpTransport>

/**
 * The real SSDP socket: udp4, bound to 0.0.0.0 on an ephemeral port (never 1900, which the
 * system's own SSDP service may hold), multicast TTL 2 (UDA 2.0 §1.3.2). Answers come back
 * unicast to it. A socket whose bind fails is closed before the open rejects.
 */
export function ssdpTransport(o: { address?: string; port?: number } = {}): OpenSsdp {
  const address = o.address ?? SSDP_ADDRESS
  const port = o.port ?? SSDP_PORT
  const multicast = /^2(?:2[4-9]|3\d)\./.test(address)
  return (onPacket) =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4' })
      let closed = false
      socket.on('message', (packet: Buffer, from: dgram.RemoteInfo) => {
        if (!closed && packet.length <= MAX_SSDP_PACKET) onPacket(packet, from.address)
      })
      const unbound = (error: Error): void => {
        closed = true
        closeSocket(socket)
        reject(error)
      }
      socket.once('error', unbound)
      socket.bind(0, () => {
        socket.off('error', unbound)
        /** From here on a socket error is a send that failed: send() reports it. */
        socket.on('error', () => undefined)
        if (multicast) socket.setMulticastTTL(2)
        resolve({
          send: (packet, local) =>
            new Promise((done, failed) => {
              if (closed) return done()
              try {
                if (multicast) socket.setMulticastInterface(local)
              } catch (error) {
                return failed(error instanceof Error ? error : new Error(String(error)))
              }
              socket.send(packet, port, address, (error) => (error ? failed(error) : done()))
            }),
          close() {
            if (closed) return
            closed = true
            closeSocket(socket)
          },
        })
      })
    })
}

/** One M-SEARCH (UDA 2.0 §1.3.2): MX 2, the blank line that ends it. */
export function mSearch(target: string): Buffer {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${String(SSDP_PORT)}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`,
    'latin1',
  )
}

export interface SsdpAnswer {
  st?: string
  usn?: string
  server?: string
  location?: string
}

/**
 * An SSDP answer's headers (`HTTP/1.1 200 OK`, then `NAME: value` lines; names in any case),
 * or null for anything else. Each value is cleaned and capped; a line break cannot hide inside
 * one, as lines are split first. The first of each header stands.
 */
export function parseSsdpResponse(packet: Buffer): SsdpAnswer | null {
  if (packet.length > MAX_SSDP_PACKET) return null
  const lines = packet.toString('utf8').split(/\r?\n/)
  if (!/^HTTP\/1\.[01] 200(?: |$)/i.test(lines[0] ?? '')) return null
  const out: SsdpAnswer = {}
  for (const line of lines.slice(1, 1 + MAX_SSDP_HEADERS)) {
    if (!line.trim()) break
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = clean(line.slice(colon + 1), 512).trim()
    if (!value) continue
    if (name === 'st') out.st ??= value
    else if (name === 'usn') out.usn ??= value
    else if (name === 'server') out.server ??= value
    else if (name === 'location') out.location ??= value
  }
  return out
}

/** A UPnP device type (`urn:schemas-upnp-org:device:MediaRenderer:1`), or DIAL's service type. */
const DEVICE_URN =
  /^urn:[A-Za-z0-9.-]{1,64}:device:[A-Za-z0-9_.-]{1,64}:\d{1,4}$|^urn:dial-multiscreen-org:service:dial:\d{1,4}$/i

/** The device type an ST or USN names (`uuid:…::urn:…:device:…:1`), or null. */
export function deviceTypeOf(text: string): string | null {
  const urn = text.includes('::') ? text.slice(text.lastIndexOf('::') + 2) : text
  return DEVICE_URN.test(urn) ? urn : null
}

/** What one address said over SSDP, from every answer it sent. */
export interface SsdpDevice {
  server?: string
  /** Device types from its STs and USNs, at most 8: `urn:schemas-upnp-org:device:…:1`. */
  types: string[]
  /** Its first LOCATION. */
  location?: string
}

/** Answers taken from one search, whatever arrives. */
const MAX_SSDP_ANSWERS = 256
/** Device types kept per address. */
const MAX_SSDP_TYPES = 8

export interface SsdpOptions {
  open: OpenSsdp
  /** This computer's addresses on the networks looked at: one set of M-SEARCHes out of each. */
  interfaces: readonly string[]
  targets: readonly string[]
  /** How long answers are collected (`lanSsdp`); every M-SEARCH is sent again after 500 ms. */
  windowMs: number
  signal: AbortSignal
}

export interface SsdpResult {
  /** By the address each answer came from (on the local network only), in the order heard. */
  devices: Map<string, SsdpDevice>
  /** Set when not one M-SEARCH could leave. */
  failure?: ReturnType<typeof mdnsFailure>
}

/** After this long every M-SEARCH is sent once more (UDP is lossy; UDA asks for more than one). */
const SSDP_AGAIN_MS = 500

/**
 * One SSDP search (§4.9): each of `targets`, out of each interface, twice 500 ms apart, then
 * answers until `windowMs`. Only an answer from an address on the local network
 * (offerableAddress) is taken, at most 256 of them. The socket is closed when the window ends
 * or the signal aborts.
 */
export async function searchSsdp(o: SsdpOptions): Promise<SsdpResult> {
  const devices = new Map<string, SsdpDevice>()
  let answers = 0
  let done = false
  const onPacket = (packet: Buffer, from: string): void => {
    if (done || answers >= MAX_SSDP_ANSWERS) return
    try {
      const answer = parseSsdpResponse(packet)
      const address = offerableAddress(from)
      if (!answer || !address || !IPV4.test(address)) return
      answers++
      let device = devices.get(address)
      if (!device) {
        if (devices.size >= MAX_SSDP_ANSWERS) return
        devices.set(address, (device = { types: [] }))
      }
      if (answer.server && device.server === undefined) device.server = answer.server
      if (answer.location && device.location === undefined) device.location = answer.location
      for (const text of [answer.st, answer.usn]) {
        const type = text ? deviceTypeOf(text) : null
        if (type && !device.types.includes(type) && device.types.length < MAX_SSDP_TYPES) {
          device.types.push(type)
        }
      }
    } catch {
      return
    }
  }
  if (o.signal.aborted || !o.interfaces.length) return { devices }
  let transport: SsdpTransport
  try {
    transport = await o.open(onPacket)
  } catch (error) {
    return { devices, failure: mdnsFailure(error) }
  }
  const window = linkSignals([o.signal], o.windowMs)
  /** Every search out of every interface, in turn; the number that left. */
  const searchAll = async (): Promise<{ sent: number; first: unknown }> => {
    let sent = 0
    let first: unknown = null
    for (const local of o.interfaces) {
      for (const target of o.targets) {
        if (window.signal.aborted) return { sent, first }
        try {
          await transport.send(mSearch(target), local)
          sent++
        } catch (error) {
          first ??= error
        }
      }
    }
    return { sent, first }
  }
  try {
    const { sent, first } = await searchAll()
    if (!sent && !window.signal.aborted) return { devices, failure: mdnsFailure(first) }
    await sleepUntil(SSDP_AGAIN_MS, window.signal)
    if (!window.signal.aborted) await searchAll()
    await sleepUntil(o.windowMs, window.signal)
    return { devices }
  } finally {
    done = true
    window.dispose()
    transport.close()
  }
}

/** Waits `ms`, or less when `signal` aborts; never rejects. */
function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const stop = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/* ------------------------------------------------------- the UPnP description --- */

/** Where a UPnP description is fetched from: the device's own address. */
export interface DescriptionTarget {
  host: string
  port: number
  /** Path and query, as the LOCATION wrote them. */
  path: string
}

/**
 * The one HTTP request of a look (§4.9): GET `target`, `Accept: text/xml`, no redirect
 * followed, at most `maxBytes`, `timeoutMs` from connect to last byte. Resolves the body of a
 * 200 whose type (when it says one) is XML; rejects for anything else, and when the signal
 * aborts. Tests replace it: the suite never fetches from a real network.
 */
export type FetchDescription = (
  target: DescriptionTarget,
  o: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
) => Promise<string>

/** A description document larger than this is not read. */
export const MAX_DESCRIPTION = 64 * 1024

/**
 * Where an SSDP answer's LOCATION may be fetched from, or null (§4.9). Only `http:` (never
 * https or another scheme), no user or password, and a host that is an IPv4 address equal to
 * the address the answer came from and on the local network: a device may point at itself
 * only, never at this computer, another device or the internet. The port must be 1–65535.
 */
export function descriptionTarget(location: string, from: string): DescriptionTarget | null {
  let url: URL
  try {
    url = new URL(location)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username || url.password) return null
  if (url.hostname !== from || !IPV4.test(from) || offerableAddress(from) !== from) return null
  const port = url.port ? Number(url.port) : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: from, port, path: `${url.pathname}${url.search}` }
}

/** The real fetch: node:http, never fetch(), which follows redirects (and warns on Node 18). */
export const fetchDescription: FetchDescription = (target, o) =>
  new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(abortError())
    const deadline = linkSignals([o.signal], o.timeoutMs)
    let settled = false
    const settle = (error: Error | null, body = ''): void => {
      if (settled) return
      settled = true
      deadline.dispose()
      if (error) {
        request.destroy()
        reject(error)
      } else resolve(body)
    }
    const request = http.get(
      {
        host: target.host,
        port: target.port,
        path: target.path || '/',
        headers: { Accept: 'text/xml' },
        agent: false,
        signal: deadline.signal,
      },
      (res) => {
        const type = String(res.headers['content-type'] ?? '')
        const length = Number(res.headers['content-length'] ?? 0)
        if (res.statusCode !== 200 || (type && !/xml/i.test(type)) || length > o.maxBytes) {
          res.resume()
          return settle(new Error(`Not a description: ${String(res.statusCode)} ${type}`))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > o.maxBytes) settle(new Error('The description is too large.'))
          else chunks.push(chunk)
        })
        res.on('end', () => settle(null, Buffer.concat(chunks).toString('utf8')))
        res.on('error', (error) => settle(error))
        /** After 'end' this changes nothing; before it, the answer was cut short. */
        res.on('close', () => settle(new Error('The description was cut short.')))
      },
    )
    request.on('error', (error) => settle(error))
  })

/** The fields read from a description: the root device's own, nothing else. */
export const DESCRIPTION_FIELDS = [
  'deviceType',
  'friendlyName',
  'manufacturer',
  'modelName',
  'modelNumber',
] as const

export type Description = Partial<Record<(typeof DESCRIPTION_FIELDS)[number], string>>

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * The root device's fields from a UPnP description (§4.9), by a tag scanner, not an XML
 * parser: a document with a DOCTYPE or an ENTITY is refused whole (no entity is ever
 * expanded), the first `<device>` is found, and each field is read only up to that device's
 * own `<deviceList>` or end, as plain text (`&amp; &lt; &gt; &quot; &apos;` decoded, a field
 * holding markup or CDATA skipped), cleaned and capped.
 */
export function parseDescription(xml: string): Description {
  if (xml.length > MAX_DESCRIPTION || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) return {}
  const start = xml.search(/<device(?:\s[^>]*)?>/)
  if (start < 0) return {}
  const body = xml.slice(start)
  const stop = body.search(/<deviceList(?:\s[^>]*)?>|<\/device\s*>/)
  const own = stop < 0 ? body : body.slice(0, stop)
  const out: Description = {}
  for (const field of DESCRIPTION_FIELDS) {
    const m = new RegExp(`<${field}\\s*>([^<]*)</${field}\\s*>`).exec(own)
    if (!m) continue
    const text = clean(
      (m[1] ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? ''),
      LIMITS.field,
    ).trim()
    if (text) out[field] = text
  }
  return out
}
