import dgram from 'node:dgram'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ToolError, type StreamResult, type StreamTool } from './process'
import { clean, errorText, linkSignals, sleep } from './util'

/**
 * §9 mDNS: a small one-shot DNS-SD browser (RFC 6762, RFC 6763), for finding the Android
 * devices on the local network (§4.8). No dependency: node:dgram, and a codec of its own.
 *
 * Why a codec here at all: a browser cannot see the network, and the adb server lists only
 * the devices it already knows, so "which TVs and phones on this Wi-Fi have debugging on"
 * needs someone to ask the network. A TV with Network debugging advertises `_adb._tcp`, a
 * phone with Wireless debugging `_adb-tls-connect._tcp` (and `_adb-tls-pairing._tcp` while
 * its pairing screen is open). Asking is read-only: queries, never an announcement, and
 * nothing here ever opens a connection to a device.
 *
 * How it asks, so it never competes with the system's own responder (mDNSResponder,
 * avahi) for port 5353: one UDP socket on an ephemeral port, queries sent to
 * 224.0.0.251:5353 on every IPv4 interface. RFC 6762 §6.7 calls that a legacy unicast query:
 * responders answer it straight to the asking port, with the query's id. The questions also
 * carry the QU bit (§5.4), which asks for a unicast answer where a responder would otherwise
 * multicast one. Answers whose id is 0 are taken too: a responder that multicasts anyway is
 * still answering.
 *
 * Everything that arrives is untrusted: every length, count and compression pointer is
 * checked against the packet before it is read (a pointer may only go backwards, and the
 * hops are counted), names are capped at 255 bytes and must be UTF-8, what is kept is
 * capped too, and nothing an answer carries can throw out of a socket event or a timer.
 *
 * The second half, systemBrowse(), asks the same question of the computer's own mDNS daemon
 * through its tool (dns-sd on macOS, avahi-browse on Linux): see "system resolver" below.
 */

export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353

/** The record types this browser reads; every other type is skipped by its length. */
export const RR = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const
type RrName = keyof typeof RR

const CLASS_IN = 1
/** The question's "unicast response wanted" bit, and the answer's "cache flush" bit. */
const TOP_BIT = 0x8000

/** A UDP payload larger than this is not an mDNS answer (RFC 6762 §17: 9000 bytes). */
export const MAX_PACKET = 9000
/** Records read from one packet, whatever its counts claim. */
const MAX_RECORDS = 256
/** Compression pointers followed in one name. */
const MAX_HOPS = 32
/** Questions in one query packet, so a query stays far below 512 bytes. */
const MAX_QUESTIONS = 12

/* ----------------------------------------------------------------------- names --- */

/**
 * A name as text: labels joined by dots, a dot or a backslash inside a label escaped with a
 * backslash (RFC 6763 §4.3: an instance name may hold both, "Living Room TV v2.0"). Compared
 * case-insensitively, through nameKey().
 */
export function joinName(labels: readonly string[]): string {
  return labels.map((label) => label.replace(/\\/g, '\\\\').replace(/\./g, '\\.')).join('.')
}

/** The labels of a name joinName() wrote. */
export function splitName(name: string): string[] {
  const labels: string[] = []
  let label = ''
  for (let i = 0; i < name.length; i++) {
    const char = name[i]
    if (char === '\\' && i + 1 < name.length) label += name[++i]
    else if (char === '.') {
      labels.push(label)
      label = ''
    } else label += char
  }
  if (label || labels.length) labels.push(label)
  return labels
}

/** DNS names compare case-insensitively (ASCII). */
export function nameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** The wire form of a name; throws for an empty label, a label over 63 bytes or a name over 255. */
export function encodeName(name: string): Buffer {
  const parts: Buffer[] = []
  let total = 1
  for (const label of splitName(name)) {
    const bytes = Buffer.from(label, 'utf8')
    if (!bytes.length || bytes.length > 63) throw new Error(`Bad DNS label in ${name}.`)
    total += bytes.length + 1
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  if (total > 255) throw new Error(`DNS name too long: ${name}.`)
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

/**
 * Whether buf[start, end) is UTF-8 (RFC 3629), byte by byte as table 3-7 of the Unicode
 * Standard lists it: no overlong form, surrogate, code point past U+10FFFF or cut-short
 * sequence. UTF-8, and nothing else, decodes and encodes back as it was. Checked where the
 * bytes lie, with no copy: one packet can make readName() read 185,000 labels (1,455
 * questions about one name of 127), and writing each label back to compare would double the
 * time such a packet takes to read.
 */
function isUtf8(buf: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const lead = buf[i] ?? 0
    if (lead < 0x80) continue
    /**
     * How many bytes follow the lead (0x80 to 0xC1 and 0xF5 to 0xFF lead none), and the range
     * of the next one: after 0xE0 and 0xF0 it refuses overlong forms, after 0xED surrogates,
     * after 0xF4 code points past U+10FFFF.
     */
    const more = lead < 0xc2 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf5 ? 3 : 0
    const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80
    const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf
    const second = buf[i + 1] ?? 0
    if (!more || i + more >= end || second < low || second > high) return false
    for (let k = i + 2; k <= i + more; k++) {
      if (((buf[k] ?? 0) & 0xc0) !== 0x80) return false
    }
    i += more
  }
  return true
}

/**
 * A name at `offset`, following compression pointers, or null when the packet is malformed:
 * a label or pointer past the end, a reserved label type, a pointer that does not go back
 * before every place this name was already read from (so no loop is possible), more than
 * 32 hops, or more than 255 bytes. `next` is where the record goes on after the name.
 *
 * A label must be UTF-8, as mDNS names are (RFC 6762 §16). Any other byte would read as
 * U+FFFD, three bytes where it was one, and encodeName() could not write the name back as
 * it came, or at all once a label passes 63 bytes (22 bytes of 0xFF come back as 66). So a
 * name this returns can always be asked about again: the follow-ups never meet one that
 * encodeName() refuses.
 */
export function readName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = []
  let pos = offset
  let lowest = offset
  let next = -1
  let hops = 0
  let length = 1
  for (;;) {
    if (pos >= buf.length) return null
    const byte = buf[pos] ?? 0
    if ((byte & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null
      const target = ((byte & 0x3f) << 8) | (buf[pos + 1] ?? 0)
      if (target >= lowest || ++hops > MAX_HOPS) return null
      if (next < 0) next = pos + 2
      lowest = target
      pos = target
      continue
    }
    if (byte & 0xc0) return null
    if (byte === 0) {
      if (next < 0) next = pos + 1
      break
    }
    const end = pos + 1 + byte
    if (end > buf.length) return null
    length += byte + 1
    if (length > 255) return null
    if (!isUtf8(buf, pos + 1, end)) return null
    labels.push(buf.toString('utf8', pos + 1, end))
    pos = end
  }
  return { name: joinName(labels), next }
}

/* --------------------------------------------------------------------- messages --- */

export type MdnsRecord =
  | { name: string; type: 'PTR'; ttl: number; target: string }
  | {
      name: string
      type: 'SRV'
      ttl: number
      priority: number
      weight: number
      port: number
      target: string
    }
  | { name: string; type: 'TXT'; ttl: number; strings: string[] }
  | { name: string; type: 'A' | 'AAAA'; ttl: number; address: string }

export interface MdnsQuestion {
  name: string
  type: RrName
}

export interface MdnsMessage {
  id: number
  response: boolean
  questions: MdnsQuestion[]
  /** Answers, authority and additional records alike, in packet order; only the types in RR. */
  records: MdnsRecord[]
}

const TYPE_NAMES = new Map<number, RrName>(
  Object.entries(RR).map(([name, code]) => [code, name as RrName]),
)

/** An IPv6 address from 16 bytes, in its compressed text form (RFC 5952). */
function ipv6Text(bytes: Buffer): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i))
  let best = -1
  let bestLength = 1
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLength) {
      best = i
      bestLength = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (best < 0) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLength).join(':')}`
}

/** One record's data, or null when it does not fit its length (the record is skipped). */
function readRdata(
  buf: Buffer,
  type: RrName,
  start: number,
  end: number,
): Omit<MdnsRecord, 'name' | 'ttl' | 'type'> | null {
  switch (type) {
    case 'A':
      return end - start === 4 ? { address: [...buf.subarray(start, end)].join('.') } : null
    case 'AAAA':
      return end - start === 16 ? { address: ipv6Text(buf.subarray(start, end)) } : null
    case 'PTR': {
      const target = readName(buf, start)
      return target && target.next <= end ? { target: target.name } : null
    }
    case 'SRV': {
      if (end - start < 7) return null
      const target = readName(buf, start + 6)
      if (!target || target.next > end) return null
      return {
        priority: buf.readUInt16BE(start),
        weight: buf.readUInt16BE(start + 2),
        port: buf.readUInt16BE(start + 4),
        target: target.name,
      }
    }
    case 'TXT': {
      const strings: string[] = []
      for (let pos = start; pos < end && strings.length < 64;) {
        const length = buf[pos] ?? 0
        if (pos + 1 + length > end) return null
        strings.push(buf.toString('utf8', pos + 1, pos + 1 + length))
        pos += 1 + length
      }
      return { strings }
    }
  }
}

/**
 * A DNS message, or null when even its header or questions are malformed. Records are read
 * one by one, each bounds-checked; the first one that does not fit ends the reading, and
 * the records before it are kept. Only class IN; the cache-flush bit is ignored.
 */
export function parseMessage(buf: Buffer): MdnsMessage | null {
  if (buf.length < 12 || buf.length > MAX_PACKET) return null
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  /** Opcode 0 (QUERY) only, in a question or an answer. */
  if (flags & 0x7800) return null
  const qdcount = buf.readUInt16BE(4)
  const rrcount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
  const questions: MdnsQuestion[] = []
  let pos = 12
  for (let i = 0; i < qdcount; i++) {
    const name = readName(buf, pos)
    if (!name || name.next + 4 > buf.length) return null
    const type = TYPE_NAMES.get(buf.readUInt16BE(name.next))
    if (type && questions.length < MAX_QUESTIONS * 2) questions.push({ name: name.name, type })
    pos = name.next + 4
  }
  const records: MdnsRecord[] = []
  for (let i = 0; i < Math.min(rrcount, MAX_RECORDS); i++) {
    const name = readName(buf, pos)
    if (!name || name.next + 10 > buf.length) break
    const code = buf.readUInt16BE(name.next)
    const rrclass = buf.readUInt16BE(name.next + 2) & ~TOP_BIT
    const ttl = buf.readUInt32BE(name.next + 4)
    const start = name.next + 10
    const end = start + buf.readUInt16BE(name.next + 8)
    if (end > buf.length) break
    pos = end
    const type = TYPE_NAMES.get(code)
    if (!type || rrclass !== CLASS_IN) continue
    const data = readRdata(buf, type, start, end)
    if (data) records.push({ name: name.name, type, ttl, ...data } as MdnsRecord)
  }
  return { id, response: (flags & 0x8000) !== 0, questions, records }
}

/** A query: `id`, no flags, each question with the QU bit set (RFC 6762 §5.4). */
export function encodeQuery(id: number, questions: readonly MdnsQuestion[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(questions.length, 4)
  const parts: Buffer[] = [header]
  for (const question of questions) {
    const tail = Buffer.alloc(4)
    tail.writeUInt16BE(RR[question.type], 0)
    tail.writeUInt16BE(CLASS_IN | TOP_BIT, 2)
    parts.push(encodeName(question.name), tail)
  }
  return Buffer.concat(parts)
}

/* -------------------------------------------------------------------- transport --- */

/**
 * Where queries go and answers come from. The real one is a UDP socket (udpTransport);
 * tests hand the browser a fake that answers with recorded packets, so no test needs a
 * network, or ever sends to one.
 */
export interface MdnsTransport {
  /** Sends one query. Rejects only when it could leave on no interface at all. */
  readonly send: (packet: Buffer) => Promise<void>
  readonly close: () => void
}

/**
 * Opens a transport that hands every packet it receives to `onPacket`, with the address it
 * came from when the transport knows it (a device answering a legacy query answers from its
 * own address).
 */
export type OpenMdnsTransport = (
  onPacket: (packet: Buffer, from?: string) => void,
) => Promise<MdnsTransport>

/** Every non-internal IPv4 address of this computer: one query goes out on each. */
function ipv4Interfaces(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      /** Node 18.0–18.3 says 4 rather than 'IPv4'. */
      const family = entry.family as string | number
      if ((family === 'IPv4' || family === 4) && !entry.internal) out.push(entry.address)
    }
  }
  return [...new Set(out)]
}

export interface UdpTransportOptions {
  /** 224.0.0.251:5353; tests point it at a fake responder on 127.0.0.1. */
  address?: string
  port?: number
  /** The interfaces to send a multicast query on, by address. */
  interfaces?: () => string[]
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/**
 * The real transport: a udp4 socket on an ephemeral port (never 5353, which the system's
 * responder holds), TTL 255 as RFC 6762 §11 asks. A multicast query goes out once per
 * interface, waiting for each send before choosing the next interface; it fails only when it
 * left on none, with the first interface's error. With no interface at all it fails with
 * ENETDOWN: this computer is on no network.
 */
export function udpTransport(o: UdpTransportOptions = {}): OpenMdnsTransport {
  const address = o.address ?? MDNS_ADDRESS
  const port = o.port ?? MDNS_PORT
  const multicast = /^2(?:2[4-9]|3\d)\./.test(address)
  return (onPacket) =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4' })
      let closed = false
      socket.on('message', (packet: Buffer, from: dgram.RemoteInfo) => {
        if (!closed && packet.length <= MAX_PACKET) onPacket(packet, from.address)
      })
      socket.once('error', reject)
      const sendOnce = (packet: Buffer): Promise<void> =>
        new Promise((done, failed) => {
          socket.send(packet, port, address, (error) => (error ? failed(error) : done()))
        })
      socket.bind(0, () => {
        socket.off('error', reject)
        /** From here on a socket error is a send that failed: send() reports it. */
        socket.on('error', () => undefined)
        if (multicast) socket.setMulticastTTL(255)
        resolve({
          async send(packet) {
            if (closed) return
            if (!multicast) return sendOnce(packet)
            const interfaces = (o.interfaces ?? ipv4Interfaces)()
            if (!interfaces.length) {
              throw errnoError('ENETDOWN', 'no network interface has an IPv4 address')
            }
            let first: unknown = null
            let sent = 0
            for (const local of interfaces) {
              try {
                socket.setMulticastInterface(local)
                await sendOnce(packet)
                sent++
              } catch (error) {
                first ??= error
              }
            }
            if (!sent) throw first
          },
          close() {
            if (closed) return
            closed = true
            socket.close()
          },
        })
      })
    })
}

/* ---------------------------------------------------------------------- failure --- */

/**
 * Why no query could leave. `blocked`: this computer refused it, at once (EHOSTUNREACH or
 * EPERM): a VPN that takes all traffic, or, on macOS, an app without local-network access
 * (§4.7). `no-network`: no interface is on a network. `failed`: anything else.
 */
export type MdnsFailure = 'blocked' | 'no-network' | 'failed'

export function mdnsFailure(error: unknown): { reason: MdnsFailure; code: string; detail: string } {
  const code = String((error as NodeJS.ErrnoException | null)?.code ?? '')
  const reason: MdnsFailure = ['EHOSTUNREACH', 'EPERM', 'EACCES'].includes(code)
    ? 'blocked'
    : ['ENETDOWN', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code)
      ? 'no-network'
      : 'failed'
  return { reason, code, detail: clean(errorText(error), 200) }
}

/* ---------------------------------------------------------------------- browsing --- */

/** One DNS-SD service instance, as complete as the answers made it. */
export interface ServiceInstance {
  /** The service type browsed, as given (`_adb._tcp.local`). */
  service: string
  /** The instance label, unescaped: `adb-b120be004010859`, `SONY KD-43X8050H`. */
  instance: string
  /** From its SRV record; null when no SRV arrived. */
  target: string | null
  port: number | null
  /**
   * Its addresses, IPv4 first: the SRV target's A and AAAA records that came in the same
   * packet as the SRV; else those that came from the address the SRV came from; else that
   * address itself; else, only when nothing ties one to this instance, every address any
   * answer gave for the target. A host name says nothing on its own: adbd calls itself
   * `Android.local` on many devices at once.
   */
  addresses: string[]
  /** Its TXT strings (`fn=Living Room TV`). */
  txt: string[]
}

export interface BrowseOptions {
  /**
   * Service types to browse: `_adb._tcp.local`. One that encodeName() refuses rejects the
   * browse before a socket opens.
   */
  services: readonly string[]
  open: OpenMdnsTransport
  /** How long answers are collected. The PTR query is sent again halfway. */
  windowMs: number
  signal?: AbortSignal
  /** Instances kept, at most. */
  max?: number
}

export interface BrowseResult {
  instances: ServiceInstance[]
  /** Set when not one query could be sent. */
  failure?: ReturnType<typeof mdnsFailure>
}

/** Caps on what one browse keeps, whatever the network sends. */
const KEEP = { instances: 256, names: 512, addresses: 8, txt: 32, sources: 8 }

/**
 * One browse: PTR questions for `services`, sent again halfway through the window; as
 * answers arrive, SRV and TXT questions for instances whose SRV is missing, and A and AAAA
 * questions for SRV targets without an address, each name asked once. After `windowMs` the
 * socket is closed and what was learnt is returned. A record with TTL 0 (a goodbye) removes
 * what it names.
 */
export async function browse(o: BrowseOptions): Promise<BrowseResult> {
  const wanted = new Map(o.services.map((service) => [nameKey(service), service]))
  /** service key → instance name key → instance name */
  const pointers = new Map<string, Map<string, string>>()
  const srv = new Map<string, { target: string; port: number; priority: number }>()
  const txt = new Map<string, string[]>()
  const addresses = new Map<string, string[]>()
  /** host name key → the address a packet came from → the addresses it gave for the name */
  const sourced = new Map<string, Map<string, string[]>>()
  /** instance name key → the addresses that came with its SRV, and where the SRV came from */
  const bound = new Map<string, { addresses: string[]; from?: string }>()
  const asked = new Set<string>()
  const id = 1 + Math.floor(Math.random() * 0xfffe)
  let transport: MdnsTransport | null = null
  let followTimer: NodeJS.Timeout | undefined
  let done = false

  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    if (map.has(key) || map.size < KEEP.names) map.set(key, value)
  }

  /** `list` with `address` added (within the cap) or, for a goodbye, removed. */
  const withAddress = (list: string[], address: string, gone: boolean): string[] =>
    gone
      ? list.filter((a) => a !== address)
      : list.includes(address) || list.length >= KEEP.addresses
        ? list
        : [...list, address]

  const take = (record: MdnsRecord, from?: string): void => {
    const key = nameKey(record.name)
    const gone = record.ttl === 0
    switch (record.type) {
      case 'PTR': {
        const service = wanted.get(key)
        const labels = splitName(record.target)
        /** Only `<one label>.<the service browsed>`. */
        if (!service || labels.length < 2 || !labels[0]) return
        if (nameKey(joinName(labels.slice(1))) !== key) return
        let set = pointers.get(key)
        if (!set) pointers.set(key, (set = new Map<string, string>()))
        const target = nameKey(record.target)
        if (gone) set.delete(target)
        else if (set.has(target) || set.size < KEEP.instances) set.set(target, record.target)
        return
      }
      case 'SRV': {
        if (gone) {
          srv.delete(key)
          bound.delete(key)
          return
        }
        const known = srv.get(key)
        /** Lowest priority wins (RFC 2782); a device lists one anyway. */
        if (known && known.priority < record.priority) return
        remember(srv, key, { target: record.target, port: record.port, priority: record.priority })
        return
      }
      case 'TXT':
        if (gone) return void txt.delete(key)
        remember(txt, key, record.strings.slice(0, KEEP.txt))
        return
      case 'A':
      case 'AAAA': {
        const next = withAddress(addresses.get(key) ?? [], record.address, gone)
        if (next.length) remember(addresses, key, next)
        else addresses.delete(key)
        if (from === undefined) return
        let bySource = sourced.get(key)
        if (!bySource) {
          if (gone || sourced.size >= KEEP.names) return
          sourced.set(key, (bySource = new Map<string, string[]>()))
        }
        const mine = withAddress(bySource.get(from) ?? [], record.address, gone)
        if (mine.length && (bySource.has(from) || bySource.size < KEEP.sources)) {
          bySource.set(from, mine)
        } else if (!mine.length) bySource.delete(from)
        return
      }
    }
  }

  /**
   * SRV and TXT for instances without an SRV, A and AAAA for targets without an address. It
   * runs in a timer, where a throw would stop the helper, so a packet that cannot be written
   * or sent is dropped (readName() returns no name encodeName() would refuse).
   */
  const followUp = (): void => {
    if (done || !transport) return
    const questions: MdnsQuestion[] = []
    const ask = (name: string, type: RrName): void => {
      const tag = `${type} ${nameKey(name)}`
      if (asked.has(tag) || asked.size >= KEEP.names) return
      asked.add(tag)
      questions.push({ name, type })
    }
    for (const set of pointers.values()) {
      for (const [key, name] of set) {
        const record = srv.get(key)
        if (!record) {
          ask(name, 'SRV')
          if (!txt.has(key)) ask(name, 'TXT')
        } else if (!addresses.has(nameKey(record.target))) {
          ask(record.target, 'A')
          ask(record.target, 'AAAA')
        }
      }
    }
    for (let i = 0; i < questions.length; i += MAX_QUESTIONS) {
      try {
        const packet = encodeQuery(id, questions.slice(i, i + MAX_QUESTIONS))
        void transport.send(packet).catch(() => undefined)
      } catch {
        /** Those questions go unasked; the window still ends with what was learnt. */
      }
    }
  }

  /**
   * Ties each SRV in a packet to the addresses that came with it: the A and AAAA records for
   * its target in the same packet, and the address the packet came from. Two devices may both
   * call themselves `Android.local`; their answers are still two packets.
   */
  const bind = (records: readonly MdnsRecord[], from?: string): void => {
    const here = new Map<string, string[]>()
    for (const r of records) {
      if ((r.type !== 'A' && r.type !== 'AAAA') || r.ttl === 0) continue
      const key = nameKey(r.name)
      here.set(key, withAddress(here.get(key) ?? [], r.address, false))
    }
    for (const r of records) {
      if (r.type !== 'SRV' || r.ttl === 0) continue
      const key = nameKey(r.name)
      const kept = srv.get(key)
      /** Only the SRV take() kept (the lowest priority). */
      if (!kept || nameKey(kept.target) !== nameKey(r.target) || kept.port !== r.port) continue
      const known = bound.get(key)
      const came = here.get(nameKey(r.target)) ?? []
      /** Addresses that came with the SRV win over a later packet that brought none. */
      const next = came.length
        ? { addresses: came, from }
        : { addresses: known?.addresses ?? [], from: known?.from ?? from }
      if (bound.has(key) || bound.size < KEEP.names) bound.set(key, next)
    }
  }

  /** An instance's addresses, by what ties them to it (ServiceInstance.addresses). */
  const addressesOf = (key: string, target: string): string[] => {
    const tied = bound.get(key)
    if (tied?.addresses.length) return tied.addresses
    if (tied?.from !== undefined) {
      return sourced.get(nameKey(target))?.get(tied.from) ?? [tied.from]
    }
    return addresses.get(nameKey(target)) ?? []
  }

  /**
   * Every answer, from the transport's message event, where a throw would stop the helper: a
   * packet that makes anything here throw is dropped, as a malformed one is.
   */
  const onPacket = (packet: Buffer, from?: string): void => {
    if (done) return
    try {
      const message = parseMessage(packet)
      /** Ours (legacy unicast echoes the id) or a multicast answer (id 0). */
      if (!message?.response || (message.id !== id && message.id !== 0)) return
      for (const record of message.records) take(record, from)
      bind(message.records, from)
    } catch {
      return
    }
    clearTimeout(followTimer)
    followTimer = setTimeout(followUp, 30)
  }

  /** Written before the socket opens: a type encodeName() refuses throws with nothing open. */
  const browseQuery = encodeQuery(
    id,
    o.services.map((name) => ({ name, type: 'PTR' })),
  )
  try {
    transport = await o.open(onPacket)
  } catch (error) {
    return { instances: [], failure: mdnsFailure(error) }
  }
  const window = new AbortController()
  const stop = (): void => window.abort()
  o.signal?.addEventListener('abort', stop, { once: true })
  try {
    try {
      await transport.send(browseQuery)
    } catch (error) {
      return { instances: [], failure: mdnsFailure(error) }
    }
    const half = Math.floor(o.windowMs / 2)
    await sleep(half, window.signal).catch(() => undefined)
    if (!window.signal.aborted) {
      void transport.send(browseQuery).catch(() => undefined)
      await sleep(o.windowMs - half, window.signal).catch(() => undefined)
    }
  } finally {
    done = true
    clearTimeout(followTimer)
    o.signal?.removeEventListener('abort', stop)
    transport.close()
  }

  const instances: ServiceInstance[] = []
  const max = o.max ?? KEEP.instances
  for (const [serviceKey, service] of wanted) {
    for (const [key, name] of pointers.get(serviceKey) ?? []) {
      if (instances.length >= max) break
      const record = srv.get(key)
      const found = record ? addressesOf(key, record.target) : []
      instances.push({
        service,
        instance: splitName(name)[0] ?? '',
        target: record?.target ?? null,
        port: record?.port ?? null,
        addresses: [
          ...found.filter((a) => !a.includes(':')),
          ...found.filter((a) => a.includes(':')),
        ],
        txt: txt.get(key) ?? [],
      })
    }
  }
  return { instances }
}

/* ------------------------------------------------------------- system resolver --- */

/**
 * The system resolver: the same DNS-SD browse as above, asked of the computer's own mDNS
 * daemon instead of the network (§4.8). On macOS that is mDNSResponder through
 * /usr/bin/dns-sd, on Linux avahi-daemon through `avahi-browse`, elsewhere nothing.
 *
 * Why both: the helper's own queries (mdns.ts) leave from its own socket, which macOS keeps
 * off the local network for an app without local-network access (an IDE, say), and a phone
 * that dozes stops answering queries at all while the daemon still remembers its last
 * announcement. The daemon does its own networking, so `dns-sd` answers even inside such an
 * app, and it answers from its cache for a device that announced itself and went quiet.
 * browse() stays: Windows has neither tool, and the daemon may lack what a query finds.
 *
 * Everything runs through streamTool (absolute path, no shell, its own process group, killed
 * on our deadline) and is read-only: browse, resolve and address lookups, never a register.
 * What the tools print comes from devices and is untrusted: every line is matched against
 * the exact format, names are length-checked, only IPv4 addresses are kept, and what is kept
 * is capped. An instance or host name that starts with `-` is never passed as an argument.
 *
 * dns-sd flow, per service type, all at once: `dns-sd -B <type> local.` for `browseMs`
 * (dns-sd never exits by itself), each instance it adds resolved at once with
 * `dns-sd -L <instance> <type> local.` and its host with `dns-sd -G v4 <host>`, at most
 * `concurrency` of those at a time (the adb services and the lookups first; the name-only
 * services in at most `nameSlots()` of them), each killed as soon as it answered or after
 * `resolveMs`. The whole run ends by `browseMs + 2 × resolveMs` whatever happens: nothing
 * waits for a killed process to exit.
 *
 * avahi flow, per service type, all at once: `avahi-browse -r -p -t -k <type>`, which
 * resolves by itself and exits once its cache is dumped; killed after `browseMs + resolveMs`.
 */

/** The tools this computer has for asking its mDNS daemon, by absolute path. */
export interface SystemMdnsTools {
  /** macOS: /usr/bin/dns-sd. */
  dnsSd: string | null
  /** Linux: avahi-browse (avahi-utils), when installed. */
  avahiBrowse: string | null
}

export type SystemMdnsTool = 'dns-sd' | 'avahi-browse'

export interface SystemBrowseOptions {
  /** Service types, as mdns.ts takes them: `_adb._tcp.local`. */
  services: readonly string[]
  tools: SystemMdnsTools
  /** The bridge's streamTool: its cwd, environment and shutdown tracking. */
  streamTool: StreamTool
  /** How long each `dns-sd -B` collects. */
  browseMs: number
  /** How long one resolve or address lookup may take. */
  resolveMs: number
  signal?: AbortSignal
  /**
   * Instances kept, at most, in each group: the adb services, and the name-only ones (Cast,
   * TV Remote), so a network full of TVs cannot crowd out the adb devices.
   */
  max?: number
  /**
   * dns-sd -L and -G processes at a time. The adb services' resolves and every address lookup
   * go first; the name-only services' resolves take at most `nameSlots(concurrency)` of them.
   */
  concurrency?: number
}

export interface SystemBrowseResult {
  /** Which tool asked; null when this computer has none. */
  tool: SystemMdnsTool | null
  /**
   * The daemon was reached: at least one browse ran its course or found something. False
   * when there is no tool, or every browse failed at once (no daemon, a tool that crashes).
   */
  looked: boolean
  instances: ServiceInstance[]
  /** Why it could not look, when it could not: the tool's own words, cleaned. */
  detail?: string
}

/** Caps on what one run keeps, whatever the tools print (instances: per group). */
const SYSTEM_KEEP = { instances: 128, txt: 32, addresses: 8 }

/** The service types that advertise adb itself; the others only name an address. */
const ADB_TYPES: ReadonlySet<string> = new Set([
  '_adb._tcp',
  '_adb-tls-connect._tcp',
  '_adb-tls-pairing._tcp',
])

/**
 * How many of `concurrency` slots the name-only services' resolves may hold at once: one in
 * four (one of the default four), at least one. macOS keeps listing a Cast or TV Remote service
 * whose device went to sleep, and its `-L` then never answers: each such entry holds its slot
 * for the whole resolve deadline, so these must never take the slots the adb devices need.
 */
function nameSlots(concurrency: number): number {
  return Math.max(1, Math.floor(concurrency / 4))
}

type Priority = 'first' | 'names'

/**
 * A limiter with two queues: `first` tasks (adb resolves, address lookups) always run before
 * queued `names` tasks, and at most `nameCap` `names` tasks run at once. FIFO within a queue.
 */
function priorityLimiter(
  n: number,
  nameCap: number,
): <T>(priority: Priority, fn: () => Promise<T>) => Promise<T> {
  let active = 0
  let activeNames = 0
  const queues: Record<Priority, Array<() => void>> = { first: [], names: [] }
  const next = (): void => {
    while (active < n) {
      const priority: Priority | null = queues.first.length
        ? 'first'
        : queues.names.length && activeNames < nameCap
          ? 'names'
          : null
      if (!priority) return
      const run = queues[priority].shift()
      if (!run) return
      active++
      if (priority === 'names') activeNames++
      run()
    }
  }
  return <T>(priority: Priority, fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queues[priority].push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--
            if (priority === 'names') activeNames--
            next()
          })
      })
      next()
    })
}
/** After a resolve's answer, how long its TXT line (or a second address) may take. */
const AFTER_ANSWER_MS = 150

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The tools to ask on `platform`: dns-sd at its fixed path on macOS (never looked up: a
 * planted `dns-sd` on PATH must not run), avahi-browse on Linux from `avahiBrowsePath` or,
 * when that is undefined, the first absolute PATH entry or extra directory that has it.
 */
export function systemMdnsTools(o: {
  platform: NodeJS.Platform
  dnsSdPath: string
  avahiBrowsePath: string | undefined
  searchPath: string
  extraDirs: readonly string[] | undefined
}): SystemMdnsTools {
  if (o.platform === 'darwin') {
    const ok = path.isAbsolute(o.dnsSdPath) && isExecutable(o.dnsSdPath)
    return { dnsSd: ok ? o.dnsSdPath : null, avahiBrowse: null }
  }
  if (o.platform !== 'linux') return { dnsSd: null, avahiBrowse: null }
  if (o.avahiBrowsePath !== undefined) {
    const ok = path.isAbsolute(o.avahiBrowsePath) && isExecutable(o.avahiBrowsePath)
    return { dnsSd: null, avahiBrowse: ok ? o.avahiBrowsePath : null }
  }
  const dirs = [
    ...o.searchPath.split(path.delimiter),
    ...(o.extraDirs ?? ['/usr/bin', '/usr/local/bin']),
  ]
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, 'avahi-browse')
    if (isExecutable(file)) return { dnsSd: null, avahiBrowse: file }
  }
  return { dnsSd: null, avahiBrowse: null }
}

/* ------------------------------------------------------------------ text formats --- */

/**
 * A name in DNS presentation form (`SONY\032KD-43X8050H._androidtvremote2._tcp.local.`, as
 * dns-sd -L and avahi-browse print them) as labels: `\DDD` is the byte DDD (decimal), `\X`
 * is X, and raw bytes above 0x7F are UTF-8. Null for a malformed escape.
 */
export function presentationLabels(text: string): string[] | null {
  const labels: string[] = []
  let bytes: number[] = []
  const raw = Buffer.from(text, 'utf8')
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i] ?? 0
    if (byte === 0x5c) {
      const digits = raw.toString('latin1', i + 1, i + 4)
      if (/^\d{3}$/.test(digits)) {
        const value = Number(digits)
        if (value > 255) return null
        bytes.push(value)
        i += 3
      } else if (i + 1 < raw.length) {
        bytes.push(raw[++i] ?? 0)
      } else return null
    } else if (byte === 0x2e) {
      labels.push(Buffer.from(bytes).toString('utf8'))
      bytes = []
    } else bytes.push(byte)
  }
  if (bytes.length || !labels.length) labels.push(Buffer.from(bytes).toString('utf8'))
  /** `name.local.` ends with an empty root label. */
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop()
  return labels
}

/**
 * dns-sd's TXT line (ShowTXTRecord): a space before each string, shell metacharacters and
 * spaces escaped with one backslash, a backslash written as four, and bytes below 0x20 as
 * `\\xHH`. ` given_name=BAULOC\ Pixel\ 9 serial=55090DLAQ0026D` → two strings.
 */
export function parseDnsSdTxt(line: string): string[] {
  const out: string[] = []
  let current: string | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? ''
    if (char === ' ') {
      if (current !== null) out.push(current)
      current = null
      continue
    }
    current ??= ''
    if (char !== '\\') {
      current += char
      continue
    }
    if (line.startsWith('\\\\\\\\', i)) {
      current += '\\'
      i += 3
    } else if (/^\\\\x[0-9A-Fa-f]{2}/.test(line.slice(i, i + 5))) {
      current += String.fromCharCode(parseInt(line.slice(i + 3, i + 5), 16))
      i += 4
    } else if (i + 1 < line.length) {
      current += line[++i] ?? ''
    }
  }
  if (current !== null) out.push(current)
  return out.slice(0, SYSTEM_KEEP.txt)
}

/**
 * avahi-browse's TXT field (avahi_string_list_to_string): each string in double quotes,
 * separated by spaces, `"` and `\` escaped with a backslash, other bytes as `\DDD`.
 */
export function parseAvahiTxt(field: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < field.length && out.length < SYSTEM_KEEP.txt) {
    if (field[i] !== '"') {
      i++
      continue
    }
    const bytes: number[] = []
    i++
    let closed = false
    while (i < field.length) {
      const char = field[i] ?? ''
      if (char === '"') {
        closed = true
        i++
        break
      }
      if (char === '\\' && /^\d{3}$/.test(field.slice(i + 1, i + 4))) {
        bytes.push(Number(field.slice(i + 1, i + 4)) & 0xff)
        i += 4
        continue
      }
      if (char === '\\' && i + 1 < field.length) i++
      bytes.push(...Buffer.from(field[i] ?? '', 'utf8'))
      i++
    }
    if (!closed) break
    out.push(Buffer.from(bytes).toString('utf8'))
  }
  return out
}

/** `_adb._tcp.local` → `_adb._tcp`, lower case: how the tools write a type. */
function bareType(service: string): string {
  return service
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/\.local$/, '')
}

const sameName = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '')

/** An instance label the tools may be asked about: 1–63 bytes, not an option. */
function usableInstance(instance: string): boolean {
  const bytes = Buffer.byteLength(instance, 'utf8')
  return bytes >= 1 && bytes <= 63 && !instance.startsWith('-')
}

/** A host to look up: a `.local` name in presentation form, no spaces, not an option. */
function usableHost(host: string): boolean {
  return host.length <= 1_009 && /^[^\s-][^\s]*\.local\.?$/i.test(host)
}

/** `HH:MM:SS.mmm  Add  2  14 local.  _adb._tcp.  adb-b120be004010859` (dns-sd -B). */
const BROWSE_LINE =
  /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+-?\d+\s+(\S+)\s+(\S+)\s+(.+)$/

export interface DnsSdBrowseLine {
  op: 'Add' | 'Rmv'
  domain: string
  type: string
  instance: string
}

export function parseDnsSdBrowseLine(line: string): DnsSdBrowseLine | null {
  const m = BROWSE_LINE.exec(line)
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null
  return { op: m[1] as 'Add' | 'Rmv', domain: m[2], type: m[3], instance: m[4].trimEnd() }
}

/**
 * `HH:MM:SS.mmm  <full name> can be reached at <host>:<port> (interface 14)` (dns-sd -L),
 * optionally followed by ` Flags: 1`. The full name is in presentation form, so a space in
 * it is `\032` and the phrase cannot occur inside it.
 */
const REACHED_LINE =
  /^(?:\d{1,2}:\d{2}:\d{2}\.\d{3}\s+)?(\S.*?) can be reached at (\S+):(\d{1,5})(?: \(interface -?\d+\))?(?: Flags: [0-9A-Fa-f]+)?\s*$/

export interface DnsSdReached {
  /** The first label of the full name, unescaped: the instance. */
  instance: string
  /** The host as printed (presentation form), for `dns-sd -G`. */
  host: string
  port: number
}

export function parseDnsSdReached(line: string): DnsSdReached | null {
  const m = REACHED_LINE.exec(line)
  if (!m?.[1] || !m[2] || !m[3]) return null
  const labels = presentationLabels(m[1])
  const port = Number(m[3])
  if (!labels?.[0] || port < 1 || port > 65535) return null
  return { instance: labels[0], host: m[2], port }
}

/** `HH:MM:SS.mmm  Add  40000002  14  Android_GWZJSA15.local.  192.168.68.114  120` (dns-sd -G). */
const ADDRESS_LINE =
  /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+-?\d+\s+(\S+)\s+(\S+)(?:\s+\d+)?\s*$/

export function parseDnsSdAddressLine(
  line: string,
): { op: 'Add' | 'Rmv'; host: string; address: string } | null {
  const m = ADDRESS_LINE.exec(line)
  if (!m?.[1] || !m[2] || !m[3] || !net.isIPv4(m[3])) return null
  return { op: m[1] as 'Add' | 'Rmv', host: m[2], address: m[3] }
}

export interface AvahiLine {
  op: '+' | '-' | '='
  protocol: string
  instance: string
  type: string
  /** `=` lines only. */
  host?: string
  address?: string
  port?: number
  txt?: string[]
}

/**
 * One `avahi-browse -p` line for `type`: `+;eth0;IPv4;<name>;<type>;local`, the same with
 * `-`, or `=;…;local;<host>;<address>;<port>;<txt>` once resolved. The name may hold a `;`
 * (only `.`, `\` and control bytes are escaped), so the fields after it are found from the
 * type, which is known.
 */
export function parseAvahiLine(line: string, type: string): AvahiLine | null {
  const op = line[0]
  if ((op !== '+' && op !== '-' && op !== '=') || line[1] !== ';') return null
  const second = line.indexOf(';', 2)
  const third = second < 0 ? -1 : line.indexOf(';', second + 1)
  if (third < 0) return null
  const protocol = line.slice(second + 1, third)
  /**
   * Found as text, never as a pattern (a type holding `(` or `+` would be one), and in ASCII
   * case only, as DNS compares names: nameKey() keeps the line's length, so positions in it
   * stay valid.
   */
  const marker = `;${nameKey(type)};local`
  const at = nameKey(line).indexOf(marker, third)
  if (at < 0) return null
  const labels = presentationLabels(line.slice(third + 1, at))
  const instance = labels?.length === 1 ? labels[0] : undefined
  if (!instance) return null
  const rest = line.slice(at + marker.length)
  if (op !== '=') return rest === '' ? { op, protocol, instance, type } : null
  const m = /^;([^;]*);([^;]*);(\d{1,5});(.*)$/.exec(rest)
  if (!m?.[1] || !m[2] || !m[3]) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return {
    op,
    protocol,
    instance,
    type,
    host: m[1],
    address: m[2],
    port,
    txt: parseAvahiTxt(m[4] ?? ''),
  }
}

/* --------------------------------------------------------------------- running --- */

interface Collected {
  /** We ended it: it answered, or its time ran out. */
  stopped: boolean
  /** It exited by itself, with this code. */
  code: number | null
  stderr: string
  /** It never started. */
  error?: unknown
}

/**
 * How long a dns-sd or avahi-browse that ignores SIGTERM may linger before SIGKILL. collect()
 * does not wait for it: the run's deadline holds whatever the process does with the signal.
 */
const SYSTEM_KILL_GRACE_MS = 250

/**
 * Run `file argv` until `finish()` (called from `onLine`), `ms`, or `signal`; every stdout
 * line goes to `onLine` as it arrives. Never rejects.
 *
 * Returns as soon as it ends the process, without waiting for it to exit: a tool that ignores
 * SIGTERM must not hold a resolve slot, or the whole run, past its deadline. The runner still
 * SIGKILLs the group `SYSTEM_KILL_GRACE_MS` later, and tracks it for shutdown meanwhile.
 */
async function collect(
  streamTool: StreamTool,
  file: string,
  argv: readonly string[],
  ms: number,
  signal: AbortSignal,
  onLine: (line: string, finish: () => void) => void,
): Promise<Collected> {
  if (signal.aborted) return { stopped: true, code: null, stderr: '' }
  let finished = false
  let kill = (): void => undefined
  let ended = (): void => undefined
  const stoppedByUs = new Promise<Collected>((resolve) => {
    ended = () => resolve({ stopped: true, code: null, stderr: '' })
  })
  const finish = (): void => {
    if (finished) return
    finished = true
    kill()
    ended()
  }
  const handle = streamTool(file, argv, {
    signal,
    killGraceMs: SYSTEM_KILL_GRACE_MS,
    onLines: (lines) => {
      for (const line of lines) {
        if (finished) return
        onLine(line, finish)
      }
    },
  })
  kill = handle.kill
  if (finished) handle.kill()
  const timer = setTimeout(finish, ms)
  signal.addEventListener('abort', finish, { once: true })
  const exited = handle.done.then(
    (result: StreamResult): Collected => ({
      stopped: result.stopped || finished,
      code: result.code,
      stderr: result.stderr,
    }),
    (error: unknown): Collected => ({ stopped: false, code: null, stderr: '', error }),
  )
  try {
    return await Promise.race([exited, stoppedByUs])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', finish)
  }
}

/** Why a tool could not look, in one line. */
function whyNot(tool: string, run: Collected): string {
  if (run.error instanceof ToolError) return `${tool}: ${run.error.reason}`
  if (run.error) return clean(`${tool}: ${errorText(run.error)}`, 200)
  const said = run.stderr
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return clean(`${tool} exited with code ${String(run.code)}${said ? `: ${said}` : ''}`, 200)
}

/** In the order of `services`, then as found: the same answer whatever process spoke first. */
function inServiceOrder(
  instances: ServiceInstance[],
  services: readonly string[],
): ServiceInstance[] {
  const rank = (i: ServiceInstance): number => services.indexOf(i.service)
  return instances
    .map((instance, index) => ({ instance, index }))
    .sort((a, b) => rank(a.instance) - rank(b.instance) || a.index - b.index)
    .map(({ instance }) => instance)
}

/**
 * Instances whose host another instance of the SAME service type also points at lose their
 * addresses: adbd calls itself `Android.local` on many devices at once, and a lookup of that
 * name answers with whichever device spoke first. The helper's own browser (browse()) ties
 * addresses to the packet that carried them and still finds those devices.
 */
function dropSharedHosts(instances: ServiceInstance[]): ServiceInstance[] {
  const users = new Map<string, Set<string>>()
  for (const i of instances) {
    if (!i.target) continue
    const key = `${i.service.toLowerCase()}|${i.target.toLowerCase().replace(/\.$/, '')}`
    const set = users.get(key) ?? new Set<string>()
    set.add(i.instance.toLowerCase())
    users.set(key, set)
  }
  const shared = new Set<string>()
  for (const [key, set] of users) {
    if (set.size > 1) shared.add(key.slice(key.indexOf('|') + 1))
  }
  return instances.map((i) =>
    i.target && shared.has(i.target.toLowerCase().replace(/\.$/, '')) ? { ...i, addresses: [] } : i,
  )
}

async function dnsSdBrowse(o: SystemBrowseOptions, file: string): Promise<SystemBrowseResult> {
  const max = o.max ?? SYSTEM_KEEP.instances
  const run = linkSignals([o.signal], o.browseMs + 2 * o.resolveMs)
  const concurrency = o.concurrency ?? 4
  const pool = priorityLimiter(concurrency, nameSlots(concurrency))
  /** service|instance key → what was learnt, in the order browses added them. */
  const found = new Map<string, { service: string; instance: string; gone: boolean }>()
  /** Instances taken per group (adb, names): each capped at `max` on its own. */
  const taken = { adb: 0, names: 0 }
  const resolved = new Map<string, ServiceInstance>()
  const lookups = new Map<string, Promise<string[]>>()
  const pending: Array<Promise<void>> = []

  /** `dns-sd -G v4 <host>`: its IPv4 addresses, once per host per run. */
  const lookUp = (host: string): Promise<string[]> => {
    const key = host.toLowerCase().replace(/\.$/, '')
    let promise = lookups.get(key)
    if (!promise) {
      promise = pool('first', async () => {
        const addresses: string[] = []
        let grace: NodeJS.Timeout | undefined
        await collect(
          o.streamTool,
          file,
          ['-G', 'v4', host],
          o.resolveMs,
          run.signal,
          (line, finish) => {
            const answer = parseDnsSdAddressLine(line)
            if (!answer || !sameName(answer.host, host)) return
            if (answer.op === 'Rmv') {
              const at = addresses.indexOf(answer.address)
              if (at >= 0) addresses.splice(at, 1)
              return
            }
            if (!addresses.includes(answer.address) && addresses.length < SYSTEM_KEEP.addresses) {
              addresses.push(answer.address)
            }
            grace ??= setTimeout(finish, AFTER_ANSWER_MS)
          },
        )
        clearTimeout(grace)
        return addresses
      })
      lookups.set(key, promise)
    }
    return promise
  }

  /** `dns-sd -L <instance> <type> local.`, then its host's addresses. */
  const resolve = (key: string, service: string, instance: string): Promise<void> =>
    pool(ADB_TYPES.has(bareType(service)) ? 'first' : 'names', async () => {
      let reached: DnsSdReached | null = null
      let txt: string[] = []
      let grace: NodeJS.Timeout | undefined
      await collect(
        o.streamTool,
        file,
        ['-L', instance, bareType(service), 'local.'],
        o.resolveMs,
        run.signal,
        (line, finish) => {
          if (!reached) {
            const answer = parseDnsSdReached(line)
            /** Only the instance asked about; the first answer (one per interface) wins. */
            if (!answer || answer.instance.toLowerCase() !== instance.toLowerCase()) return
            reached = answer
            grace = setTimeout(finish, AFTER_ANSWER_MS)
            return
          }
          /** The TXT line follows its answer, starting with a space; absent when empty. */
          if (line.startsWith(' ')) txt = parseDnsSdTxt(line)
          finish()
        },
      )
      clearTimeout(grace)
      return { reached: reached as DnsSdReached | null, txt }
    }).then(async ({ reached, txt }) => {
      if (!reached || !usableHost(reached.host) || run.signal.aborted) return
      const addresses = await lookUp(reached.host)
      const labels = presentationLabels(reached.host) ?? [reached.host]
      resolved.set(key, {
        service,
        instance,
        target: labels.join('.'),
        port: reached.port,
        addresses,
        txt,
      })
    })

  const browses = o.services.map((service) =>
    collect(
      o.streamTool,
      file,
      ['-B', bareType(service), 'local.'],
      o.browseMs,
      run.signal,
      (line) => {
        const entry = parseDnsSdBrowseLine(line)
        if (!entry || !sameName(entry.domain, 'local') || !sameName(entry.type, bareType(service)))
          return
        const key = `${bareType(service)}|${entry.instance.toLowerCase()}`
        const known = found.get(key)
        if (entry.op === 'Rmv') {
          if (known) known.gone = true
          return
        }
        if (known) {
          known.gone = false
          return
        }
        const group = ADB_TYPES.has(bareType(service)) ? 'adb' : 'names'
        if (taken[group] >= max || !usableInstance(entry.instance)) return
        taken[group]++
        found.set(key, { service, instance: entry.instance, gone: false })
        pending.push(resolve(key, service, entry.instance))
      },
    ).then((outcome) => ({
      outcome,
      adds: [...found.keys()].some((k) => k.startsWith(`${bareType(service)}|`)),
    })),
  )

  try {
    const outcomes = await Promise.all(browses)
    /** Resolves may still be starting from the last lines; wait for every one. */
    let waited = 0
    while (waited < pending.length) {
      const batch = pending.slice(waited)
      waited = pending.length
      await Promise.all(batch)
    }
    const looked = outcomes.some(({ outcome, adds }) => adds || (outcome.stopped && !outcome.error))
    const instances: ServiceInstance[] = []
    for (const [key, entry] of found) {
      const instance = resolved.get(key)
      if (instance && !entry.gone) instances.push(instance)
    }
    const failed = outcomes.find(({ outcome }) => !outcome.stopped)
    return {
      tool: 'dns-sd',
      looked,
      instances: dropSharedHosts(inServiceOrder(instances, o.services)),
      ...(looked || !failed ? {} : { detail: whyNot('dns-sd', failed.outcome) }),
    }
  } finally {
    run.dispose()
  }
}

async function avahiBrowse(o: SystemBrowseOptions, file: string): Promise<SystemBrowseResult> {
  const max = o.max ?? SYSTEM_KEEP.instances
  const run = linkSignals([o.signal], o.browseMs + o.resolveMs)
  const byKey = new Map<string, ServiceInstance>()
  const gone = new Set<string>()
  /** Instances kept per group (adb, names): each capped at `max` on its own. */
  const taken = { adb: 0, names: 0 }
  try {
    const outcomes = await Promise.all(
      o.services.map(async (service) => {
        const type = bareType(service)
        let lines = 0
        const outcome = await collect(
          o.streamTool,
          file,
          ['-r', '-p', '-t', '-k', type],
          o.browseMs + o.resolveMs,
          run.signal,
          (line) => {
            const entry = parseAvahiLine(line, type)
            if (!entry) return
            lines++
            const key = `${type}|${entry.instance.toLowerCase()}`
            if (entry.op === '-') return void gone.add(key)
            if (entry.op === '+') return void gone.delete(key)
            /** IPv4 answers only: a link-local IPv6 one carries no interface adb could use. */
            if (entry.protocol !== 'IPv4' || !entry.address || !net.isIPv4(entry.address)) return
            if (!usableInstance(entry.instance) || entry.port === undefined) return
            const known = byKey.get(key)
            if (known) {
              if (
                !known.addresses.includes(entry.address) &&
                known.addresses.length < SYSTEM_KEEP.addresses
              ) {
                known.addresses.push(entry.address)
              }
              return
            }
            const group = ADB_TYPES.has(type) ? 'adb' : 'names'
            if (taken[group] >= max) return
            taken[group]++
            const labels = presentationLabels(entry.host ?? '') ?? []
            byKey.set(key, {
              service,
              instance: entry.instance,
              target: labels.join('.') || null,
              port: entry.port,
              addresses: [entry.address],
              txt: entry.txt ?? [],
            })
          },
        )
        return { outcome, lines }
      }),
    )
    const looked = outcomes.some(
      ({ outcome, lines }) =>
        lines > 0 || (!outcome.error && !outcome.stopped && outcome.code === 0),
    )
    const instances = [...byKey.entries()].filter(([key]) => !gone.has(key)).map(([, i]) => i)
    const failed = outcomes.find(({ outcome }) => outcome.error || outcome.code !== 0)
    return {
      tool: 'avahi-browse',
      looked,
      instances: dropSharedHosts(inServiceOrder(instances, o.services)),
      ...(looked || !failed ? {} : { detail: whyNot('avahi-browse', failed.outcome) }),
    }
  } finally {
    run.dispose()
  }
}

/** One browse through the system's daemon, with whichever tool this computer has. */
export async function systemBrowse(o: SystemBrowseOptions): Promise<SystemBrowseResult> {
  if (o.tools.dnsSd) return dnsSdBrowse(o, o.tools.dnsSd)
  if (o.tools.avahiBrowse) return avahiBrowse(o, o.tools.avahiBrowse)
  return { tool: null, looked: false, instances: [] }
}
