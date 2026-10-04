/*
  A fake local network for the mDNS browser (§4.8): no socket, no packet ever leaves this
  process. fakeMdnsNetwork() is an OpenMdnsTransport whose send() hands each query to the
  fake devices, which answer with real DNS packets, encoded here with name compression the
  way device responders write them: legacy-unicast answers echo the query's id and question,
  with TTLs capped at 10 s and no cache-flush bit (RFC 6762 §6.7); multicast-style answers
  have id 0, the cache-flush bit and full TTLs, plus NSEC records the browser must skip.

  braviaTv() and pixel9() are the two devices measured on the owner's network with dns-sd on
  2026-10-04 (a Sony BRAVIA Android TV with Network debugging, and a Pixel 9 with Wireless
  debugging), down to their instance names, hosts, ports and addresses.

  silentMdns() is what every isolated bridge gets (harness.ts): queries go nowhere and
  nothing answers, so no test can reach a real network by accident.
*/
import {
  encodeName,
  nameKey,
  parseMessage,
  splitName,
  type MdnsMessage,
  type OpenMdnsTransport,
} from '../../src/mdns'

/* ------------------------------------------------------------------- the encoder --- */

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47 } as const

export type FakeRecord =
  | { name: string; type: 'PTR'; target: string; ttl?: number }
  | { name: string; type: 'SRV'; target: string; port: number; priority?: number; ttl?: number }
  | { name: string; type: 'TXT'; strings: string[]; ttl?: number }
  | { name: string; type: 'A' | 'AAAA'; address: string; ttl?: number }
  | { name: string; type: 'NSEC'; types: number[]; ttl?: number }

export interface FakeMessage {
  id: number
  questions?: Array<{ name: string; type: keyof typeof TYPE }>
  answers: FakeRecord[]
  additionals?: FakeRecord[]
  /** Set the cache-flush bit on unique records (SRV, TXT, A, AAAA, NSEC). */
  flush?: boolean
  /** Cap every TTL (a legacy-unicast answer: 10 s). */
  maxTtl?: number
}

function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number)
}

function ipv6Bytes(address: string): number[] {
  const [head = '', tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = address.includes('::') && tail ? tail.split(':') : []
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.flatMap((g) => {
    const n = parseInt(g, 16)
    return [n >> 8, n & 0xff]
  })
}

/** A DNS message with name compression, as a device's responder writes it. */
export function encodeMessage(m: FakeMessage): Buffer {
  const out: number[] = []
  const offsets = new Map<string, number>()
  const u16 = (n: number): void => void out.push((n >> 8) & 0xff, n & 0xff)
  const u32 = (n: number): void => {
    u16(Math.floor(n / 0x10000))
    u16(n % 0x10000)
  }
  const name = (text: string): void => {
    const labels = splitName(text)
    for (let i = 0; i < labels.length; i++) {
      const key = nameKey(labels.slice(i).join('\u0000'))
      const at = offsets.get(key)
      if (at !== undefined) return u16(0xc000 | at)
      if (out.length < 0x3fff) offsets.set(key, out.length)
      const bytes = Buffer.from(labels[i] ?? '', 'utf8')
      out.push(bytes.length, ...bytes)
    }
    out.push(0)
  }
  const record = (r: FakeRecord): void => {
    name(r.name)
    u16(TYPE[r.type])
    const unique = r.type !== 'PTR'
    u16(1 | (m.flush && unique ? 0x8000 : 0))
    const ttl = r.ttl ?? (r.type === 'PTR' || r.type === 'TXT' ? 4500 : 120)
    u32(Math.min(ttl, m.maxTtl ?? ttl))
    const lengthAt = out.length
    u16(0)
    const start = out.length
    switch (r.type) {
      case 'PTR':
        name(r.target)
        break
      case 'SRV':
        u16(r.priority ?? 0)
        u16(0)
        u16(r.port)
        name(r.target)
        break
      case 'TXT':
        if (!r.strings.length) out.push(0)
        for (const s of r.strings) {
          const bytes = Buffer.from(s, 'utf8')
          out.push(bytes.length, ...bytes)
        }
        break
      case 'A':
        out.push(...ipv4Bytes(r.address))
        break
      case 'AAAA':
        out.push(...ipv6Bytes(r.address))
        break
      case 'NSEC': {
        name(r.name)
        const bitmap = Array<number>(6).fill(0)
        for (const t of r.types) bitmap[t >> 3] = (bitmap[t >> 3] ?? 0) | (0x80 >> (t & 7))
        out.push(0, bitmap.length, ...bitmap)
        break
      }
    }
    const length = out.length - start
    out[lengthAt] = length >> 8
    out[lengthAt + 1] = length & 0xff
  }
  u16(m.id)
  u16(0x8400)
  u16(m.questions?.length ?? 0)
  u16(m.answers.length)
  u16(0)
  u16(m.additionals?.length ?? 0)
  for (const q of m.questions ?? []) {
    name(q.name)
    u16(TYPE[q.type])
    u16(1)
  }
  for (const r of m.answers) record(r)
  for (const r of m.additionals ?? []) record(r)
  return Buffer.from(out)
}

/* --------------------------------------------------------------------- devices --- */

/**
 * Answers one query, or returns no packet. `from` is the address its packets come from (a
 * device answers from its own address); unset, the transport says nothing about it.
 */
export type FakeResponder = ((query: MdnsMessage) => Buffer[]) & { from?: string }

export interface ZoneOptions {
  /** 'legacy' (default): our id, the question echoed, TTL ≤ 10 s. 'multicast': id 0, flush bits. */
  style?: 'legacy' | 'multicast'
  /** Send a PTR answer's SRV, TXT and addresses along (most responders do); false: PTR alone. */
  additionals?: boolean
  /** The address its answers come from (FakeResponder.from). */
  from?: string
}

/**
 * A device as its responder sees itself: a set of records. A query is answered with the
 * records it asks for and, like real responders, what the asker needs next as additionals.
 */
export function zoneResponder(records: FakeRecord[], o: ZoneOptions = {}): FakeResponder {
  const find = (n: string, type: FakeRecord['type']): FakeRecord[] =>
    records.filter((r) => r.type === type && nameKey(r.name) === nameKey(n))
  const respond: FakeResponder = (query) => {
    const answers: FakeRecord[] = []
    const extra: FakeRecord[] = []
    const addHost = (host: string): void => {
      extra.push(...find(host, 'A'), ...find(host, 'AAAA'), ...find(host, 'NSEC'))
    }
    for (const q of query.questions) {
      const found = find(q.name, q.type)
      answers.push(...found)
      if (o.additionals === false) continue
      for (const r of found) {
        if (r.type === 'PTR') {
          for (const s of find(r.target, 'SRV')) {
            extra.push(s)
            if (s.type === 'SRV') addHost(s.target)
          }
          extra.push(...find(r.target, 'TXT'), ...find(r.target, 'NSEC'))
        }
        if (r.type === 'SRV') addHost(r.target)
      }
    }
    if (!answers.length) return []
    const legacy = o.style !== 'multicast'
    return [
      encodeMessage({
        id: legacy ? query.id : 0,
        questions: legacy
          ? query.questions.map((q) => ({ name: q.name, type: q.type }))
          : undefined,
        answers,
        additionals: extra.filter((r) => !answers.includes(r)),
        flush: !legacy,
        maxTtl: legacy ? 10 : undefined,
      }),
    ]
  }
  if (o.from !== undefined) respond.from = o.from
  return respond
}

/** The Sony BRAVIA Android TV (Network debugging on), as dns-sd showed it on 2026-10-04. */
export const BRAVIA = {
  address: '192.168.68.101',
  adb: 'adb-b120be004010859',
  host: 'Android.local',
  remote: 'SONY KD-43X8050H',
  cast: 'BRAVIA-4K-UR3-3f6e0c2b8a41d5e9f07c6b2a1d4e8f90',
  castHost: '3f6e0c2b-8a41-d5e9-f07c-6b2a1d4e8f90.local',
} as const

export function braviaTv(
  o: ZoneOptions & { fn?: string; address?: string; adbAddress?: string } = {},
): FakeResponder {
  const address = o.address ?? BRAVIA.address
  const adbName = `${BRAVIA.adb}._adb._tcp.local`
  const remoteName = `${BRAVIA.remote}._androidtvremote2._tcp.local`
  const castName = `${BRAVIA.cast}._googlecast._tcp.local`
  return zoneResponder(
    [
      { name: '_adb._tcp.local', type: 'PTR', target: adbName },
      { name: adbName, type: 'SRV', target: BRAVIA.host, port: 5555 },
      { name: adbName, type: 'TXT', strings: [] },
      { name: adbName, type: 'NSEC', types: [16, 33] },
      { name: '_androidtvremote2._tcp.local', type: 'PTR', target: remoteName },
      { name: remoteName, type: 'SRV', target: BRAVIA.host, port: 6466 },
      { name: remoteName, type: 'TXT', strings: ['bt=A0:B1:C2:D3:E4:F5'] },
      { name: '_googlecast._tcp.local', type: 'PTR', target: castName },
      { name: castName, type: 'SRV', target: BRAVIA.castHost, port: 8009 },
      {
        name: castName,
        type: 'TXT',
        strings: [
          'id=3f6e0c2b8a41d5e9f07c6b2a1d4e8f90',
          've=05',
          'md=BRAVIA 4K UR3',
          'ic=/setup/icon.png',
          `fn=${o.fn ?? 'SONY KD-43X8050H'}`,
          'ca=465413',
          'st=0',
          'rs=',
        ],
      },
      { name: BRAVIA.host, type: 'A', address: o.adbAddress ?? address },
      { name: BRAVIA.host, type: 'AAAA', address: 'fe80::a2b1:c2ff:fed3:e4f5' },
      { name: BRAVIA.host, type: 'NSEC', types: [1, 28] },
      { name: BRAVIA.castHost, type: 'A', address },
    ],
    { from: address, ...o },
  )
}

/** The Pixel 9 with Wireless debugging on, as dns-sd showed it on 2026-10-04. */
export const PIXEL9 = {
  address: '192.168.68.114',
  instance: 'adb-55090DLAQ0026D-nK25Qn',
  host: 'Android_ZDKLKP74.local',
  port: 39601,
  pairingPort: 37123,
} as const

export function pixel9(
  o: ZoneOptions & { pairing?: boolean; address?: string } = {},
): FakeResponder {
  const address = o.address ?? PIXEL9.address
  const connect = `${PIXEL9.instance}._adb-tls-connect._tcp.local`
  const pairing = `${PIXEL9.instance}._adb-tls-pairing._tcp.local`
  return zoneResponder(
    [
      { name: '_adb-tls-connect._tcp.local', type: 'PTR', target: connect },
      { name: connect, type: 'SRV', target: PIXEL9.host, port: PIXEL9.port },
      { name: connect, type: 'TXT', strings: ['v=ADB_SECURE_SERVICE_VERSION=1'] },
      ...(o.pairing
        ? ([
            { name: '_adb-tls-pairing._tcp.local', type: 'PTR', target: pairing },
            { name: pairing, type: 'SRV', target: PIXEL9.host, port: PIXEL9.pairingPort },
            { name: pairing, type: 'TXT', strings: [] },
          ] satisfies FakeRecord[])
        : []),
      { name: PIXEL9.host, type: 'A', address },
      { name: PIXEL9.host, type: 'AAAA', address: 'fe80::1c2d:3eff:fe4f:5a6b' },
    ],
    { from: address, ...o },
  )
}

/* --------------------------------------------------------------------- network --- */

export interface FakeMdnsNetwork {
  readonly open: OpenMdnsTransport
  /** Every query sent, parsed. */
  readonly queries: MdnsMessage[]
  /** The devices answering; a test may change them between scans. */
  responders: FakeResponder[]
  /** Every send rejects with this (EHOSTUNREACH: a VPN, or macOS local network privacy). */
  sendError: NodeJS.ErrnoException | null
  /** open() rejects with this. */
  openError: NodeJS.ErrnoException | null
  /** Transports opened, and closed. */
  readonly opened: () => number
  readonly closed: () => number
  /** Scans started: queries carrying a PTR question for `_adb._tcp.local`. */
  readonly scans: () => number
}

export function errno(
  code: string,
  message = `send ${code} 224.0.0.251:5353`,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -1, syscall: 'send' })
}

/** A network of fake devices: each query is answered a few ms later, packet by packet. */
export function fakeMdnsNetwork(responders: FakeResponder[] = [], delayMs = 5): FakeMdnsNetwork {
  let opened = 0
  let closed = 0
  const net: FakeMdnsNetwork = {
    queries: [],
    responders,
    sendError: null,
    openError: null,
    opened: () => opened,
    closed: () => closed,
    scans: () =>
      new Set(
        net.queries
          .filter((q) => q.questions.some((x) => x.type === 'PTR' && x.name === '_adb._tcp.local'))
          .map((q) => q.id),
      ).size,
    open(onPacket) {
      if (net.openError) return Promise.reject(net.openError)
      opened++
      let isClosed = false
      const timers = new Set<NodeJS.Timeout>()
      return Promise.resolve({
        send(packet) {
          if (net.sendError) return Promise.reject(net.sendError)
          const query = parseMessage(packet)
          if (!query) throw new Error('The browser sent a malformed query.')
          net.queries.push(query)
          for (const respond of net.responders) {
            for (const answer of respond(query)) {
              const timer = setTimeout(() => {
                timers.delete(timer)
                if (!isClosed) onPacket(answer, respond.from)
              }, delayMs)
              timers.add(timer)
            }
          }
          return Promise.resolve()
        },
        close() {
          if (isClosed) return
          isClosed = true
          closed++
          for (const timer of timers) clearTimeout(timer)
        },
      })
    },
  }
  return net
}

/** Queries go nowhere, nothing answers: every isolated bridge's network (harness.ts). */
export function silentMdns(): OpenMdnsTransport {
  return () =>
    Promise.resolve({
      send: () => Promise.resolve(),
      close: () => undefined,
    })
}

/** encodeName is the browser's own; re-exported so a test can build hostile packets by hand. */
export { encodeName }
