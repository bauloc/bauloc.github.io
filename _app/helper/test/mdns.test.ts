/*
  The mDNS browser (§4.8, mdns.ts): the DNS codec against hand-written and hostile packets,
  one-shot browsing against the fake network of fakes/mdns.ts (the TV and the Pixel measured
  on the owner's network), why a scan could not run, and the real UDP transport against a
  responder on 127.0.0.1. No test sends a packet to a real network.
*/
import dgram from 'node:dgram'
import { describe, expect, it } from 'vitest'
import { streamTool } from '../src/process'
import {
  MAX_PACKET,
  MAX_SERVICE_TYPES,
  SERVICE_TYPES_NAME,
  avahiLineType,
  browse,
  browseServiceTypes,
  encodeName,
  encodeQuery,
  joinName,
  mdnsFailure,
  parseAvahiResolveLine,
  parseDnsSdQueryLine,
  parseDnsSdTypeLine,
  parseDnsSdZoneLine,
  parseMessage,
  readName,
  reverseName,
  reverseNames,
  serviceType,
  splitName,
  udpTransport,
  type MdnsMessage,
  type OpenMdnsTransport,
  type ServiceInstance,
} from '../src/mdns'
import {
  BRAVIA,
  PIXEL9,
  braviaTv,
  encodeMessage,
  errno,
  fakeMdnsNetwork,
  pixel9,
  zoneResponder,
} from './fakes/mdns'
import { onCleanup, until } from './harness'

const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')]

/**
 * The TV's answer to a legacy-unicast `_adb._tcp.local` PTR query, written out byte by byte
 * (not by the fake's encoder), compressed the way responders compress: the question echoed,
 * the PTR, then SRV, TXT and A as additionals, every name after the first a pointer.
 */
const TV_ADB_ANSWER = Buffer.from([
  /** 0: id 0x1234, QR + AA, 1 question, 1 answer, 0 authority, 3 additional */
  0x12,
  0x34,
  0x84,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x03,
  /** 12: _adb._tcp.local PTR IN (22 is where `local` starts) */
  0x04,
  ...ascii('_adb'),
  0x04,
  ...ascii('_tcp'),
  0x05,
  ...ascii('local'),
  0x00,
  0x00,
  0x0c,
  0x00,
  0x01,
  /** 33: answer: → 12, PTR, IN, TTL 10, 22 bytes */
  0xc0,
  0x0c,
  0x00,
  0x0c,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x00,
  0x16,
  /** 45: adb-b120be004010859 → 12 */
  0x13,
  ...ascii('adb-b120be004010859'),
  0xc0,
  0x0c,
  /** 67: SRV: → 45, SRV, IN, TTL 10, 16 bytes: priority 0, weight 0, port 5555, Android → 22 */
  0xc0,
  0x2d,
  0x00,
  0x21,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x00,
  0x10,
  0x00,
  0x00,
  0x00,
  0x00,
  0x15,
  0xb3,
  0x07,
  ...ascii('Android'),
  0xc0,
  0x16,
  /** 95: TXT: → 45, one empty string */
  0xc0,
  0x2d,
  0x00,
  0x10,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x00,
  0x01,
  0x00,
  /** 108: A: → 85 (Android.local), 192.168.68.101 */
  0xc0,
  0x55,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x00,
  0x04,
  0xc0,
  0xa8,
  0x44,
  0x65,
])

/** A header, then `body`: `an` records claimed. */
function packet(body: number[], an = 1, qd = 0): Buffer {
  return Buffer.from([0, 0, 0x84, 0, 0, qd, 0, an, 0, 0, 0, 0, ...body])
}

/** One record by hand: `name`, the type, class IN, TTL 120, then `data` with its length. */
function record(name: string, type: number, data: number[]): number[] {
  const length = [data.length >> 8, data.length & 0xff]
  return [...encodeName(name), 0, type, 0, 1, 0, 0, 0, 120, ...length, ...data]
}

/** What was thrown, uncaught, out of a timer or an event while `run` ran: it stops the helper. */
async function uncaughtDuring(run: () => Promise<void>): Promise<unknown[]> {
  const thrown: unknown[] = []
  const listener = (error: unknown): void => void thrown.push(error)
  process.on('uncaughtException', listener)
  try {
    await run()
  } finally {
    process.off('uncaughtException', listener)
  }
  return thrown
}

describe('the codec', () => {
  it('reads the TV’s answer, byte for byte, pointers and all', () => {
    const message = parseMessage(TV_ADB_ANSWER)
    expect(message).toEqual({
      id: 0x1234,
      response: true,
      questions: [{ name: '_adb._tcp.local', type: 'PTR' }],
      records: [
        {
          name: '_adb._tcp.local',
          type: 'PTR',
          ttl: 10,
          target: 'adb-b120be004010859._adb._tcp.local',
        },
        {
          name: 'adb-b120be004010859._adb._tcp.local',
          type: 'SRV',
          ttl: 10,
          priority: 0,
          weight: 0,
          port: 5555,
          target: 'Android.local',
        },
        { name: 'adb-b120be004010859._adb._tcp.local', type: 'TXT', ttl: 10, strings: [''] },
        { name: 'Android.local', type: 'A', ttl: 10, address: '192.168.68.101' },
      ],
    } satisfies MdnsMessage)
  })

  it('writes a query with the QU bit, and reads its own query back', () => {
    const query = encodeQuery(0xbeef, [
      { name: '_adb._tcp.local', type: 'PTR' },
      { name: 'Android_ZDKLKP74.local', type: 'A' },
    ])
    expect(query.subarray(0, 12)).toEqual(Buffer.from([0xbe, 0xef, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]))
    /** _adb._tcp.local (17 bytes), then type 12 and class IN with the top bit. */
    expect(query.subarray(29, 33)).toEqual(Buffer.from([0x00, 0x0c, 0x80, 0x01]))
    expect(parseMessage(query)).toEqual({
      id: 0xbeef,
      response: false,
      questions: [
        { name: '_adb._tcp.local', type: 'PTR' },
        { name: 'Android_ZDKLKP74.local', type: 'A' },
      ],
      records: [],
    })
  })

  it('escapes dots and backslashes inside a label, and checks label and name lengths', () => {
    const name = joinName(['Living Room TV v2.0', '_googlecast', '_tcp', 'local'])
    expect(name).toBe('Living Room TV v2\\.0._googlecast._tcp.local')
    expect(splitName(name)).toEqual(['Living Room TV v2.0', '_googlecast', '_tcp', 'local'])
    expect(splitName(joinName(['a\\b', 'local']))).toEqual(['a\\b', 'local'])
    const wire = encodeName(name)
    expect(readName(wire, 0)).toEqual({ name, next: wire.length })
    expect(() => encodeName(`${'x'.repeat(64)}.local`)).toThrow()
    expect(() => encodeName(Array(5).fill('y'.repeat(60)).join('.'))).toThrow()
    expect(() => encodeName('a..local')).toThrow()
  })

  it('writes IPv6 addresses compressed (RFC 5952)', () => {
    const aaaa = (address: string): string => {
      const records = parseMessage(
        encodeMessage({ id: 0, answers: [{ name: 'h.local', type: 'AAAA', address }] }),
      )?.records
      return records?.[0]?.type === 'AAAA' ? records[0].address : ''
    }
    expect(aaaa('fe80::a2b1:c2ff:fed3:e4f5')).toBe('fe80::a2b1:c2ff:fed3:e4f5')
    expect(aaaa('fd00:0:0:0:0:0:0:1')).toBe('fd00::1')
    expect(aaaa('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1')
    expect(aaaa('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8')
    expect(aaaa('fd12:0:3:4:5:6:7:8')).toBe('fd12:0:3:4:5:6:7:8')
  })

  it('refuses hostile names: loops, forward pointers, overruns, reserved labels, 256 bytes', () => {
    /** 14: y z w x, then at 22 a pointer back to 14: a loop for a "pointer < here" rule. */
    const loop = Buffer.from([
      ...Array<number>(14).fill(0),
      1,
      ...ascii('y'),
      1,
      ...ascii('z'),
      1,
      ...ascii('w'),
      1,
      ...ascii('x'),
      0xc0,
      14,
    ])
    expect(readName(loop, 14)).toBeNull()
    expect(readName(loop, 20)).toBeNull()
    expect(readName(Buffer.from([0xc0, 0x00]), 0)).toBeNull()
    expect(readName(Buffer.from([0, 0, 0xc0, 0x04, 0]), 2)).toBeNull()
    expect(readName(Buffer.from([0x05, ...ascii('abc')]), 0)).toBeNull()
    expect(readName(Buffer.from([0x40, 0]), 0)).toBeNull()
    expect(readName(Buffer.from([0x80, 0]), 0)).toBeNull()
    expect(readName(Buffer.from([0x01, ...ascii('a'), 0xc0]), 0)).toBeNull()
    expect(readName(Buffer.from([]), 0)).toBeNull()
    const long = Buffer.from([
      ...Array.from({ length: 5 }, () => [63, ...Array<number>(63).fill(0x61)]).flat(),
      0,
    ])
    expect(readName(long, 0)).toBeNull()
    /** Four 63-byte labels are 257 bytes on the wire: one too many. */
    expect(readName(long.subarray(0, 256), 0)).toBeNull()
    /** Back, and back again: fine. */
    const chain = Buffer.from([
      1,
      ...ascii('a'),
      0,
      1,
      ...ascii('b'),
      0xc0,
      0,
      1,
      ...ascii('c'),
      0xc0,
      3,
    ])
    expect(readName(chain, 7)).toEqual({ name: 'c.b.a', next: 11 })
  })

  it('refuses a label that is not UTF-8: no name it reads is one it could not ask about', () => {
    /** 22 bytes of 0xFF read as 22 U+FFFD, 66 bytes when written back: past a label's 63. */
    const bad = Buffer.from([22, ...Array<number>(22).fill(0xff), 5, ...ascii('local'), 0])
    expect(readName(bad, 0)).toBeNull()
    /** One bad byte is enough, and a cut-short sequence (it would come back as U+FFFD). */
    expect(readName(Buffer.from([3, 0x61, 0xff, 0x62, 0]), 0)).toBeNull()
    expect(readName(Buffer.from([3, 0xf0, 0x9f, 0x98, 0]), 0)).toBeNull()
    /** UTF-8 is read as it is, and written back byte for byte. */
    const name = joinName(['Phòng khách 📺', 'local'])
    const wire = encodeName(name)
    expect(readName(wire, 0)).toEqual({ name, next: wire.length })
  })

  it('keeps the records before one that does not fit, and never trusts the counts', () => {
    const a = (address: number[]): number[] => [
      1,
      ...ascii('h'),
      0,
      0x00,
      0x01,
      0x80,
      0x01,
      0,
      0,
      0,
      120,
      0,
      4,
      ...address,
    ]
    /** 0xffff answers claimed, two present, the second cut short. */
    const cut = packet([...a([192, 168, 1, 2]), ...a([192, 168, 1, 3]).slice(0, -2)], 0xff)
    expect(parseMessage(cut)?.records).toEqual([
      { name: 'h', type: 'A', ttl: 120, address: '192.168.1.2' },
    ])
    /** An A record of five bytes, a PTR whose name runs past its length: skipped, not read. */
    const odd = packet(
      [
        1,
        ...ascii('h'),
        0,
        0x00,
        0x01,
        0x00,
        0x01,
        0,
        0,
        0,
        1,
        0,
        5,
        1,
        2,
        3,
        4,
        5,
        1,
        ...ascii('p'),
        0,
        0x00,
        0x0c,
        0x00,
        0x01,
        0,
        0,
        0,
        1,
        0,
        5,
        5,
        ...ascii('abc'),
        0,
        ...a([10, 0, 0, 7]),
      ],
      3,
    )
    expect(parseMessage(odd)?.records).toEqual([
      { name: 'h', type: 'A', ttl: 120, address: '10.0.0.7' },
    ])
    /** Class CH, an opcode other than QUERY, a short header, a giant packet. */
    expect(
      parseMessage(packet([1, ...ascii('h'), 0, 0, 1, 0, 3, 0, 0, 0, 1, 0, 4, 1, 2, 3, 4]))
        ?.records,
    ).toEqual([])
    expect(parseMessage(Buffer.from([0, 0, 0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(parseMessage(Buffer.alloc(11))).toBeNull()
    expect(parseMessage(Buffer.alloc(MAX_PACKET + 1))).toBeNull()
  })

  it('survives every truncation and thousands of corrupted packets without throwing', () => {
    const samples = [
      TV_ADB_ANSWER,
      ...pixel9({ pairing: true })(
        parseMessage(encodeQuery(7, [{ name: '_adb-tls-connect._tcp.local', type: 'PTR' }]))!,
      ),
    ]
    let seed = 0x2545f491
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed % n
    }
    for (const sample of samples) {
      for (let i = 0; i <= sample.length; i++) parseMessage(sample.subarray(0, i))
      for (let round = 0; round < 3000; round++) {
        const copy = Buffer.from(sample)
        for (let flips = 1 + random(4); flips > 0; flips--) copy[random(copy.length)] = random(256)
        const message = parseMessage(copy)
        for (const record of message?.records ?? []) {
          expect(['A', 'AAAA', 'PTR', 'SRV', 'TXT']).toContain(record.type)
          expect(Buffer.byteLength(record.name)).toBeLessThan(1024)
        }
      }
    }
  })
})

const ADB = '_adb._tcp.local'
const CONNECT = '_adb-tls-connect._tcp.local'
const PAIRING = '_adb-tls-pairing._tcp.local'
const REMOTE = '_androidtvremote2._tcp.local'
const CAST = '_googlecast._tcp.local'
const ALL = [ADB, CONNECT, PAIRING, REMOTE, CAST]

describe('browse()', () => {
  it('finds the TV and the Pixel with their hosts, ports, addresses and TXT, then closes', async () => {
    const network = fakeMdnsNetwork([braviaTv(), pixel9({ pairing: true })])
    const { instances, failure } = await browse({
      services: ALL,
      open: network.open,
      windowMs: 150,
    })
    expect(failure).toBeUndefined()
    expect(instances).toEqual(
      expect.arrayContaining([
        {
          service: ADB,
          instance: BRAVIA.adb,
          target: 'Android.local',
          port: 5555,
          addresses: ['192.168.68.101', 'fe80::a2b1:c2ff:fed3:e4f5'],
          txt: [''],
          from: BRAVIA.address,
        },
        {
          service: CONNECT,
          instance: PIXEL9.instance,
          target: PIXEL9.host,
          port: 39601,
          addresses: ['192.168.68.114', 'fe80::1c2d:3eff:fe4f:5a6b'],
          txt: ['v=ADB_SECURE_SERVICE_VERSION=1'],
          from: PIXEL9.address,
        },
        expect.objectContaining({ service: PAIRING, instance: PIXEL9.instance, port: 37123 }),
        expect.objectContaining({ service: REMOTE, instance: 'SONY KD-43X8050H', port: 6466 }),
        expect.objectContaining({
          service: CAST,
          instance: BRAVIA.cast,
          addresses: ['192.168.68.101'],
          txt: expect.arrayContaining(['fn=SONY KD-43X8050H']) as unknown,
        }),
      ]),
    )
    expect(instances).toHaveLength(5)
    /** The browse query, and once more halfway; nothing was missing, so nothing else. */
    expect(network.queries).toHaveLength(2)
    expect(network.queries[0]?.questions).toEqual(ALL.map((name) => ({ name, type: 'PTR' })))
    expect([network.opened(), network.closed()]).toEqual([1, 1])
  })

  it('asks for SRV and TXT, then the address, when a device answers with the PTR alone', async () => {
    const network = fakeMdnsNetwork([pixel9({ additionals: false })])
    const { instances } = await browse({ services: [CONNECT], open: network.open, windowMs: 300 })
    expect(instances).toEqual([
      expect.objectContaining({
        instance: PIXEL9.instance,
        port: 39601,
        addresses: ['192.168.68.114', 'fe80::1c2d:3eff:fe4f:5a6b'],
      }),
    ])
    const asked = network.queries.flatMap((q) => q.questions.map((x) => `${x.type} ${x.name}`))
    expect(asked).toEqual(
      expect.arrayContaining([
        `SRV ${PIXEL9.instance}._adb-tls-connect._tcp.local`,
        `TXT ${PIXEL9.instance}._adb-tls-connect._tcp.local`,
        `A ${PIXEL9.host}`,
        `AAAA ${PIXEL9.host}`,
      ]),
    )
    /** Each name asked once, however many answers arrived. */
    expect(asked.filter((q) => q.startsWith('SRV '))).toHaveLength(1)
    /** Every query of one browse carries the same id, which legacy unicast answers echo. */
    expect(new Set(network.queries.map((q) => q.id)).size).toBe(1)
  })

  it('takes multicast-style answers (id 0, cache-flush bits, NSEC) and ignores other ids', async () => {
    const stranger = (): Buffer[] => [
      encodeMessage({
        id: 4242,
        answers: [{ name: ADB, type: 'PTR', target: `adb-STRANGER._adb._tcp.local` }],
      }),
    ]
    const network = fakeMdnsNetwork([braviaTv({ style: 'multicast' }), stranger])
    const { instances } = await browse({ services: [ADB], open: network.open, windowMs: 150 })
    expect(instances.map((i) => [i.instance, i.port, i.addresses[0]])).toEqual([
      [BRAVIA.adb, 5555, '192.168.68.101'],
    ])
  })

  it('takes only `<label>.<service>` pointers, and forgets what a goodbye (TTL 0) removes', async () => {
    let bye = false
    const tricky = (query: MdnsMessage): Buffer[] => [
      encodeMessage({
        id: query.id,
        answers: [
          { name: ADB, type: 'PTR', target: 'evil._googlecast._tcp.local' },
          { name: ADB, type: 'PTR', target: 'two.labels._adb._tcp.local' },
          { name: ADB, type: 'PTR', target: 'adb-GONE._adb._tcp.local', ttl: bye ? 0 : 120 },
        ],
      }),
    ]
    const network = fakeMdnsNetwork([tricky], 1)
    setTimeout(() => (bye = true), 60)
    const { instances } = await browse({ services: [ADB], open: network.open, windowMs: 200 })
    expect(instances).toEqual([])
  })

  it('drops an answer naming an instance or host it could not ask about, never throwing', async () => {
    /**
     * Anyone on the network may answer (id 0 is taken). 30 bytes of 0xFF read as 30 U+FFFD,
     * 90 bytes when written back: the follow-up's question for that name could not be
     * written, and the throw, in a timer, stopped the helper.
     */
    const bad = [30, ...Array<number>(30).fill(0xff)]
    const hostile = (): Buffer[] => [
      /** A PTR alone, to such an instance: its SRV and TXT would be asked next. */
      packet(record(ADB, 12, [...bad, ...encodeName(ADB)])),
      /** An instance whose SRV names such a host: its A and AAAA would be asked next. */
      packet(
        [
          ...record(ADB, 12, [...encodeName(`adb-HOSTILE.${ADB}`)]),
          ...record(`adb-HOSTILE.${ADB}`, 33, [0, 0, 0, 0, 0x15, 0xb3, ...bad, 0]),
        ],
        2,
      ),
    ]
    const network = fakeMdnsNetwork([braviaTv(), hostile])
    let instances: ServiceInstance[] = []
    const thrown = await uncaughtDuring(async () => {
      instances = (await browse({ services: [ADB], open: network.open, windowMs: 150 })).instances
    })
    expect(thrown).toEqual([])
    expect(instances.map((i) => [i.instance, i.port])).toEqual([
      [BRAVIA.adb, 5555],
      ['adb-HOSTILE', null],
    ])
    const asked = network.queries.flatMap((q) => q.questions.map((x) => `${x.type} ${x.name}`))
    expect(asked.filter((q) => !q.startsWith('PTR '))).toEqual([
      `SRV adb-HOSTILE.${ADB}`,
      `TXT adb-HOSTILE.${ADB}`,
    ])
  })

  it('nothing a transport does throws out of its packet handler or its follow-up timer', async () => {
    const open: OpenMdnsTransport = (onPacket) =>
      Promise.resolve({
        send(packet) {
          /** The follow-up's send throws at once, where a transport should reject. */
          if (parseMessage(packet)?.questions.some((q) => q.type === 'SRV')) {
            throw new Error('send threw')
          }
          setTimeout(() => {
            /** Not a packet at all, then a PTR alone, which calls for that follow-up. */
            onPacket(undefined as unknown as Buffer)
            onPacket(
              encodeMessage({
                id: 0,
                answers: [{ name: ADB, type: 'PTR', target: `adb-X.${ADB}` }],
              }),
            )
          }, 5)
          return Promise.resolve()
        },
        close: () => undefined,
      })
    let instances: ServiceInstance[] = []
    const thrown = await uncaughtDuring(async () => {
      instances = (await browse({ services: [ADB], open, windowMs: 150 })).instances
    })
    expect(thrown).toEqual([])
    expect(instances).toEqual([
      { service: ADB, instance: 'adb-X', target: null, port: null, addresses: [], txt: [] },
    ])
  })

  it('keeps at most `max` instances', async () => {
    const many = zoneResponder(
      Array.from({ length: 30 }, (_, i) => ({
        name: ADB,
        type: 'PTR' as const,
        target: `adb-DEVICE${String(i).padStart(2, '0')}._adb._tcp.local`,
      })),
    )
    const network = fakeMdnsNetwork([many])
    const { instances } = await browse({
      services: [ADB],
      open: network.open,
      windowMs: 100,
      max: 8,
    })
    expect(instances).toHaveLength(8)
  })

  it('stops when its signal aborts', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    const stop = new AbortController()
    const started = Date.now()
    setTimeout(() => stop.abort(), 50)
    await browse({ services: [ADB], open: network.open, windowMs: 5_000, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(network.closed()).toBe(1)
  })

  it.each([
    ['EHOSTUNREACH', 'blocked'],
    ['EPERM', 'blocked'],
    ['EACCES', 'blocked'],
    ['ENETDOWN', 'no-network'],
    ['ENETUNREACH', 'no-network'],
    ['EADDRNOTAVAIL', 'no-network'],
    ['EMSGSIZE', 'failed'],
  ])('a query that cannot leave (%s) is "%s", and the socket is closed', async (code, reason) => {
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno(code)
    const result = await browse({ services: [ADB], open: network.open, windowMs: 100 })
    expect(result).toEqual({
      instances: [],
      failure: { reason, code, detail: `send ${code} 224.0.0.251:5353` },
    })
    expect(network.closed()).toBe(1)
  })

  it('a socket that cannot even open is a failure too', async () => {
    const network = fakeMdnsNetwork()
    network.openError = errno('EPERM', 'bind EPERM 0.0.0.0')
    const result = await browse({ services: [ADB], open: network.open, windowMs: 100 })
    expect(result.failure).toMatchObject({ reason: 'blocked', code: 'EPERM' })
    expect(mdnsFailure(new Error('odd'))).toEqual({ reason: 'failed', code: '', detail: 'odd' })
  })

  it('a service type it cannot ask about is refused before a socket opens', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    const services = [ADB, `_${'x'.repeat(63)}._tcp.local`]
    await expect(browse({ services, open: network.open, windowMs: 100 })).rejects.toThrow(
      'Bad DNS label',
    )
    expect([network.opened(), network.closed()]).toEqual([0, 0])
  })
})

describe('udpTransport()', () => {
  /** A responder on 127.0.0.1 that answers each query, as a device answers a legacy query. */
  async function localResponder(
    respond: (query: MdnsMessage) => Buffer[],
  ): Promise<{ port: number; received: () => number }> {
    const socket = dgram.createSocket('udp4')
    let received = 0
    socket.on('message', (packet, from) => {
      received++
      const query = parseMessage(packet)
      if (!query) return
      for (const answer of respond(query)) socket.send(answer, from.port, from.address)
    })
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
    onCleanup(() => new Promise<void>((resolve) => socket.close(() => resolve())))
    return { port: socket.address().port, received: () => received }
  }

  it('asks from an ephemeral port and reads the answers sent back to it', async () => {
    const responder = await localResponder(braviaTv())
    const open = udpTransport({ address: '127.0.0.1', port: responder.port })
    const { instances, failure } = await browse({ services: [ADB, REMOTE], open, windowMs: 200 })
    expect(failure).toBeUndefined()
    expect(instances.map((i) => [i.instance, i.port, i.addresses[0]])).toEqual([
      [BRAVIA.adb, 5555, '192.168.68.101'],
      ['SONY KD-43X8050H', 6466, '192.168.68.101'],
    ])
    expect(responder.received()).toBeGreaterThanOrEqual(2)
  })

  it('hands each answer over with the address it came from', async () => {
    const responder = await localResponder(braviaTv())
    const open = udpTransport({ address: '127.0.0.1', port: responder.port })
    const from: Array<string | undefined> = []
    const transport = await open((_, address) => from.push(address))
    onCleanup(() => transport.close())
    await transport.send(encodeQuery(7, [{ name: ADB, type: 'PTR' }]))
    await until(() => from.length > 0)
    expect(from[0]).toBe('127.0.0.1')
  })

  it('with no interface on a network, fails as ENETDOWN and sends nothing', async () => {
    const open = udpTransport({ interfaces: () => [] })
    const result = await browse({ services: [ADB], open, windowMs: 100 })
    expect(result.failure).toMatchObject({ reason: 'no-network', code: 'ENETDOWN' })
  })

  it('fails only when the query left on no interface (an address not on this computer)', async () => {
    const open = udpTransport({ interfaces: () => ['203.0.113.1', '198.51.100.1'] })
    const result = await browse({ services: [ADB], open, windowMs: 100 })
    expect(result.failure).toMatchObject({ reason: 'no-network', code: 'EADDRNOTAVAIL' })
  })
})

/* -------------------------------------------- every device on this network (§4.9) --- */

const udpHandles = async (): Promise<number> => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  return process.getActiveResourcesInfo().filter((r) => r === 'UDPWrap').length
}

describe('udpTransport() when its socket cannot bind', () => {
  it('rejects, and closes the socket it made', async () => {
    const before = await udpHandles()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the socket as `this`
    const original = dgram.Socket.prototype.bind
    /** An address on no interface: the bind fails at once, and nothing is sent. */
    dgram.Socket.prototype.bind = function (this: dgram.Socket) {
      return original.call(this, { port: 0, address: '203.0.113.1' })
    }
    try {
      const result = await browse({
        services: [ADB],
        open: udpTransport({ address: '127.0.0.1', port: 9 }),
        windowMs: 100,
      })
      expect(result.failure).toMatchObject({ reason: 'no-network', code: 'EADDRNOTAVAIL' })
    } finally {
      dgram.Socket.prototype.bind = original
    }
    expect(await udpHandles()).toBe(before)
  })
})

describe('browse() and an abort that came first', () => {
  /** A transport that counts its sends and says when it was closed; opening takes `openMs`. */
  function counting(openMs: number): {
    open: OpenMdnsTransport
    sends: () => number
    closed: () => boolean
    opened: () => boolean
  } {
    let sends = 0
    let closed = false
    let opened = false
    return {
      sends: () => sends,
      closed: () => closed,
      opened: () => opened,
      open: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            opened = true
            resolve({
              send: () => {
                sends++
                return Promise.resolve()
              },
              close: () => {
                closed = true
              },
            })
          }, openMs),
        ),
    }
  }

  it('a signal aborted before the call: no socket, nothing sent', async () => {
    const t = counting(0)
    const stop = new AbortController()
    stop.abort()
    const started = Date.now()
    expect(
      await browse({ services: [ADB], open: t.open, windowMs: 2_000, signal: stop.signal }),
    ).toEqual({
      instances: [],
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect([t.opened(), t.sends()]).toEqual([false, 0])
  })

  it('an abort while the socket opens (shutdown during bind): nothing sent, the socket closed', async () => {
    const t = counting(30)
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 10)
    const started = Date.now()
    await browse({ services: [ADB], open: t.open, windowMs: 2_000, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(500)
    expect([t.opened(), t.sends(), t.closed()]).toEqual([true, 0, true])
  })
})

describe('browse() for many types (§4.9)', () => {
  it('asks at most 12 types to a packet, every packet again halfway, one id', async () => {
    const types = Array.from({ length: 30 }, (_, i) => `_t${String(i)}._tcp.local`)
    const network = fakeMdnsNetwork([braviaTv()])
    await browse({ services: [...types, ADB], open: network.open, windowMs: 150 })
    const sizes = network.queries.map((q) => q.questions.length)
    expect(sizes).toEqual([12, 12, 7, 12, 12, 7])
    expect(network.queries.flatMap((q) => q.questions).filter((q) => q.name === ADB)).toHaveLength(
      2,
    )
    expect(new Set(network.queries.map((q) => q.id)).size).toBe(1)
  })

  it('says which address each instance’s SRV came from', async () => {
    const network = fakeMdnsNetwork([braviaTv(), pixel9()])
    const { instances } = await browse({
      services: [ADB, CONNECT],
      open: network.open,
      windowMs: 120,
    })
    expect(instances.map((i) => [i.instance, i.from])).toEqual([
      [BRAVIA.adb, BRAVIA.address],
      [PIXEL9.instance, PIXEL9.address],
    ])
  })
})

describe('the service types the network lists (§4.9)', () => {
  const META = SERVICE_TYPES_NAME

  it('a type is `_name._tcp` or `_name._udp`, never one that reads like a hardware address', () => {
    expect(serviceType('_ipp._tcp.local.')).toBe('_ipp._tcp')
    expect(serviceType('_asquic._udp')).toBe('_asquic._udp')
    expect(serviceType('_Adb-TLS-connect._tcp')).toBe('_Adb-TLS-connect._tcp')
    for (const bad of [
      '_FC9F5ED42C8A._tcp',
      '_a(b._tcp',
      '-x._tcp',
      'ipp._tcp',
      '_ipp._sctp',
      `_${'x'.repeat(63)}._tcp`,
      '_ipp._tcp.example',
      '',
    ]) {
      expect(serviceType(bad), bad).toBeNull()
    }
  })

  it('reads every type, once, from any responder; nothing else counts', async () => {
    const printer = zoneResponder(
      [
        { name: META, type: 'PTR', target: '_ipp._tcp.local' },
        { name: META, type: 'PTR', target: '_uscan._tcp.local' },
        { name: META, type: 'PTR', target: '_IPP._tcp.local' },
        { name: META, type: 'PTR', target: 'evil.local' },
        { name: META, type: 'PTR', target: '_x._tcp.example' },
        { name: META, type: 'PTR', target: '_FC9F5ED42C8A._tcp.local' },
        { name: META, type: 'PTR', target: '_a(b._tcp.local' },
        { name: '_ipp._tcp.local', type: 'PTR', target: 'HP._ipp._tcp.local' },
      ],
      { from: '192.168.68.125' },
    )
    const mac = zoneResponder([{ name: META, type: 'PTR', target: '_asquic._udp.local' }], {
      style: 'multicast',
    })
    const network = fakeMdnsNetwork([printer, mac])
    const result = await browseServiceTypes({ open: network.open, windowMs: 120 })
    expect(result).toEqual({ types: ['_ipp._tcp', '_uscan._tcp', '_asquic._udp'] })
    /** The question, and once more halfway; nothing is asked next. */
    expect(network.queries.map((q) => q.questions)).toEqual([
      [{ name: META, type: 'PTR' }],
      [{ name: META, type: 'PTR' }],
    ])
    expect([network.opened(), network.closed()]).toEqual([1, 1])
  })

  it('keeps at most `max`; a question that cannot leave is a failure; an early abort sends nothing', async () => {
    const many = zoneResponder(
      Array.from({ length: 60 }, (_, i) => ({
        name: META,
        type: 'PTR' as const,
        target: `_t${String(i)}._tcp.local`,
      })),
    )
    expect(
      (await browseServiceTypes({ open: fakeMdnsNetwork([many]).open, windowMs: 80 })).types,
    ).toHaveLength(MAX_SERVICE_TYPES)
    const blocked = fakeMdnsNetwork([many])
    blocked.sendError = errno('EHOSTUNREACH')
    expect(await browseServiceTypes({ open: blocked.open, windowMs: 80 })).toEqual({
      types: [],
      failure: {
        reason: 'blocked',
        code: 'EHOSTUNREACH',
        detail: 'send EHOSTUNREACH 224.0.0.251:5353',
      },
    })
    expect(blocked.closed()).toBe(1)
    const quiet = fakeMdnsNetwork([many])
    const stop = new AbortController()
    stop.abort()
    expect(
      await browseServiceTypes({ open: quiet.open, windowMs: 80, signal: stop.signal }),
    ).toEqual({ types: [] })
    expect([quiet.opened(), quiet.queries.length]).toEqual([0, 0])
  })
})

describe('the formats of the whole-network look (§4.9)', () => {
  it('dns-sd’s list of types, as the owner’s Mac printed it', () => {
    const lines = [
      'Browsing for _services._dns-sd._udp.local.',
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '22:56:04.523  Add        3   1 .                    _tcp.local.          _airplay',
      '22:56:04.523  Add        3  14 .                    _tcp.local.          _FC9F5ED42C8A',
      '22:56:04.523  Add        3  14 .                    _tcp.local.          _ipp',
      '22:56:04.523  Add        2  14 .                    _udp.local.          _asquic',
      '22:56:04.523  Rmv        2  14 .                    _tcp.local.          _gone',
      '22:56:04.523  Add        2  14 local.               _ipp._tcp.           HP printer',
    ]
    expect(lines.map(parseDnsSdTypeLine)).toEqual([
      null,
      null,
      '_airplay._tcp',
      null,
      '_ipp._tcp',
      '_asquic._udp',
      null,
      null,
    ])
  })

  it('dns-sd -Z: the PTR, SRV and TXT of each instance, as the owner’s Mac printed them (ids made up)', () => {
    const type = '_ipp._tcp'
    const name = 'HP\\032Neverstop\\032Laser\\032MFP\\0321200w\\032(AABBCC)._ipp._tcp'
    const instance = 'HP Neverstop Laser MFP 1200w (AABBCC)'
    expect(
      parseDnsSdZoneLine(`${type}                                       PTR     ${name}`, type),
    ).toEqual({
      instance,
      type: 'PTR',
    })
    expect(
      parseDnsSdZoneLine(
        `${name} SRV     0 0 631 NPIAABBCC.local. ; Replace with unicast FQDN of target host`,
        type,
      ),
    ).toEqual({ instance, type: 'SRV', host: 'NPIAABBCC.local.', port: 631 })
    expect(
      parseDnsSdZoneLine(
        `${name} TXT     "txtvers=1" "ty=HP Neverstop Laser MFP 120x" "note=" "say \\"hi\\""`,
        type,
      ),
    ).toEqual({
      instance,
      type: 'TXT',
      txt: ['txtvers=1', 'ty=HP Neverstop Laser MFP 120x', 'note=', 'say "hi"'],
    })
    /** UTF-8 raw, as dns-sd prints it. */
    expect(
      parseDnsSdZoneLine(
        `BAULOC’s\\032MacBook\\032Pro._airplay._tcp      SRV     0 0 7000 BAULOCs-MacBook-Pro.local. ; x`,
        '_airplay._tcp',
      ),
    ).toEqual({
      instance: 'BAULOC’s MacBook Pro',
      type: 'SRV',
      host: 'BAULOCs-MacBook-Pro.local.',
      port: 7000,
    })
  })

  it('dns-sd -Z: headers, comments, another type, bad ports and bad escapes are nothing', () => {
    const type = '_ipp._tcp'
    for (const line of [
      'Browsing for _ipp._tcp.local.',
      "; To direct clients to browse a different domain, substitute that domain in place of '@'",
      'lb._dns-sd._udp                                 PTR     @',
      'x._ipps._tcp SRV     0 0 631 h.local.',
      'x._ipp._tcp SRV     0 0 70000 h.local.',
      'x._ipp._tcp SRV     0 0 0 h.local.',
      'x.y._ipp._tcp SRV     0 0 631 h.local.',
      'x\\999._ipp._tcp SRV     0 0 631 h.local.',
      '_ipp._tcp PTR     x._ipps._tcp',
      '',
    ]) {
      expect(parseDnsSdZoneLine(line, type), line).toBeNull()
    }
  })

  it('dns-sd -q: the reverse name’s answer, or none', () => {
    expect(
      parseDnsSdQueryLine(
        '23:56:38.928  Add  40000002      14  113.68.168.192.in-addr.arpa.  PTR    IN     BAULOCs-MacBook-Pro.local.',
      ),
    ).toEqual({
      op: 'Add',
      name: '113.68.168.192.in-addr.arpa.',
      answer: 'BAULOCs-MacBook-Pro.local.',
    })
    expect(
      parseDnsSdQueryLine(
        '23:56:38.928  Add  40000002      14  200.68.168.192.in-addr.arpa.  PTR    IN     0.0.0.0    No Such Record',
      ),
    ).toEqual({ op: 'Add', name: '200.68.168.192.in-addr.arpa.', answer: null })
    expect(
      parseDnsSdQueryLine('Timestamp     A/R  Flags         IF  Name  Type   Class  Rdata'),
    ).toBeNull()
    expect(parseDnsSdQueryLine('23:56:38.928  Add  40000002  14  x.  A  IN  1.2.3.4')).toBeNull()
  })

  it('avahi: the type of a browse line; avahi-resolve’s answer for the address asked', () => {
    expect(avahiLineType('+;eth0;IPv4;HP\\032Printer;_ipp._tcp;local')).toBe('_ipp._tcp')
    expect(avahiLineType('-;eth0;IPv4;a;b;c;_uscan._tcp;local')).toBe('_uscan._tcp')
    expect(avahiLineType('=;eth0;IPv4;x;_ipp._tcp;local;h.local;192.168.1.5;631;""')).toBeNull()
    expect(avahiLineType('+;eth0;IPv4;x;_a(b._tcp;local')).toBeNull()
    expect(parseAvahiResolveLine('192.168.1.5\tpi.local', '192.168.1.5')).toBe('pi.local')
    expect(parseAvahiResolveLine('192.168.1.6\tpi.local', '192.168.1.5')).toBeNull()
    expect(parseAvahiResolveLine('192.168.1.5\t-rf.local', '192.168.1.5')).toBeNull()
    expect(parseAvahiResolveLine('192.168.1.5\tpi.example', '192.168.1.5')).toBeNull()
  })
})

describe('reverse names from the helper’s own socket (§4.9)', () => {
  it('asks each address’s reverse name, and takes only a `.local` answer for one it asked', async () => {
    const responder = zoneResponder([
      { name: '113.68.168.192.in-addr.arpa', type: 'PTR', target: 'BAULOCs-MacBook-Pro.local' },
      { name: '110.68.168.192.in-addr.arpa', type: 'PTR', target: 'router.example' },
      { name: '99.68.168.192.in-addr.arpa', type: 'PTR', target: 'never-asked.local' },
    ])
    const network = fakeMdnsNetwork([responder])
    const names = await reverseNames({
      addresses: ['192.168.68.113', '192.168.68.110', '192.168.68.7'],
      tools: { dnsSd: null, avahiResolve: null },
      streamTool,
      open: network.open,
      timeoutMs: 100,
    })
    expect([...names]).toEqual([['192.168.68.113', 'BAULOCs-MacBook-Pro.local']])
    expect(network.queries[0]?.questions).toEqual([
      { name: reverseName('192.168.68.113'), type: 'PTR' },
      { name: reverseName('192.168.68.110'), type: 'PTR' },
      { name: reverseName('192.168.68.7'), type: 'PTR' },
    ])
    expect([network.opened(), network.closed()]).toEqual([1, 1])
  })
})
