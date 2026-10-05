/*
  The LAN sources (§4.9, lan-net.ts): which networks are looked at, the presence check (pool,
  pace, one datagram each, every socket closed, blocked and no network), the neighbour tables
  and gateways of macOS, Linux and Windows as they print them, SSDP answers and searches, the
  UPnP description's fetch rules and its tag scanner, and the hardware-address facts. Real
  sockets only on 127.0.0.1 (a closed port answers port unreachable; 127.0.0.2 is silent on a
  Mac); every other test uses the fakes of fakes/lan.ts. No packet leaves this computer.
*/
import dgram from 'node:dgram'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { LIMITS, LAN_SSDP_TARGETS } from '../src/constants'
import {
  DESCRIPTION_FIELDS,
  MAX_DESCRIPTION,
  checkPresence,
  descriptionTarget,
  deviceTypeOf,
  fetchDescription,
  lanNetworks,
  macFacts,
  mSearch,
  normalizeMac,
  onLan,
  parseArpDarwin,
  parseArpWindows,
  parseDescription,
  parseProcNetArp,
  parseProcNetRoute,
  parseRouteGetDefault,
  parseRouteWindows,
  parseSsdpResponse,
  presenceTransport,
  readGateway,
  readNeighbours,
  searchSsdp,
  ssdpTransport,
  unicastMac,
  type LanInterface,
  type TableOptions,
} from '../src/lan-net'
import { runTool } from '../src/process'
import { createFakeBin } from './fakes/bin'
import {
  DECO_DESCRIPTION,
  decoRouter,
  fakePresence,
  fakeSsdpNetwork,
  lanInterfaces,
  ssdpResponder,
  ssdpResponse,
} from './fakes/lan'
import { errno } from './fakes/mdns'
import { listenerWarnings, onCleanup, tempDir, until } from './harness'

const OWN = '192.168.68.113'

/* ------------------------------------------------------------------ networks --- */

describe('the networks looked at', () => {
  it('this computer’s /24: every other address, never its network, broadcast or own', () => {
    const plan = lanNetworks(lanInterfaces(['en0', `${OWN}/24`]))
    expect(plan.networks).toEqual([
      { interface: 'en0', address: OWN, prefix: 24, size: 254, scanned: 254 },
    ])
    expect(plan.targets).toHaveLength(253)
    expect(plan.targets[0]).toBe('192.168.68.1')
    expect(plan.targets.at(-1)).toBe('192.168.68.254')
    expect(plan.targets).not.toContain(OWN)
    expect(plan.targets).not.toContain('192.168.68.0')
    expect(plan.targets).not.toContain('192.168.68.255')
    expect([...plan.own]).toEqual([[OWN, 'en0']])
  })

  it('never a tunnel, a bridge, AirDrop, loopback, link-local, CGNAT, IPv6 or a public address', () => {
    const interfaces: LanInterface[] = [
      ...lanInterfaces(
        ['utun3', '10.8.0.2/24'],
        ['wg0', '10.9.0.2/24'],
        ['tailscale0', '100.101.1.2/32'],
        ['bridge100', '192.168.64.1/24'],
        ['docker0', '172.17.0.1/16'],
        ['vmnet8', '172.16.5.1/24'],
        ['awdl0', '192.168.70.2/24'],
        ['lo0', '127.0.0.1/8'],
        ['en5', '169.254.3.4/16'],
        ['en6', '100.64.0.5/10'],
        ['en7', '8.8.4.4/24'],
      ),
      {
        name: 'en0',
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        internal: false,
      },
      {
        name: 'en0',
        address: '10.0.0.5',
        netmask: '255.255.255.0',
        family: 'IPv4',
        internal: true,
      },
    ]
    expect(lanNetworks(interfaces)).toEqual({
      networks: [],
      targets: [],
      own: new Map(),
      ranges: [],
    })
  })

  it('a larger network: only the /24 around this computer, and it says so', () => {
    const plan = lanNetworks(lanInterfaces(['en0', '10.1.5.7/16']))
    expect(plan.networks).toEqual([
      { interface: 'en0', address: '10.1.5.7', prefix: 16, size: 65534, scanned: 256 },
    ])
    /** In a /16, x.y.5.0 and x.y.5.255 are hosts like any other. */
    expect(plan.targets).toHaveLength(255)
    expect(plan.targets[0]).toBe('10.1.5.0')
    expect(plan.targets.at(-1)).toBe('10.1.5.255')
    expect(onLan('10.1.200.9', plan.ranges)).toBe(true)
    expect(onLan('10.1.0.0', plan.ranges)).toBe(false)
    expect(onLan('10.1.255.255', plan.ranges)).toBe(false)
  })

  it('two /24s fit in 512 addresses; a third is listed, not checked', () => {
    const plan = lanNetworks(
      lanInterfaces(['en0', `${OWN}/24`], ['en7', '10.0.0.2/24'], ['en8', '172.20.1.3/24']),
    )
    expect(plan.targets).toHaveLength(506)
    expect(plan.networks.map((n) => [n.interface, n.scanned])).toEqual([
      ['en0', 254],
      ['en7', 254],
      ['en8', 0],
    ])
    expect(plan.targets.length).toBeLessThanOrEqual(LIMITS.lanTargets)
  })

  it('one network on two interfaces is checked once, and neither of this computer’s addresses', () => {
    const plan = lanNetworks(lanInterfaces(['en0', `${OWN}/24`], ['en7', '192.168.68.120/24']))
    expect(plan.targets).toHaveLength(252)
    expect(plan.targets).not.toContain('192.168.68.120')
    expect(plan.networks.map((n) => n.scanned)).toEqual([254, 254])
  })

  it('Node 18.0’s family 4 counts; a mask that is not contiguous, /31 and /32 do not', () => {
    const plan = lanNetworks([
      { name: 'en0', address: OWN, netmask: '255.255.255.0', family: 4, internal: false },
      { name: 'en1', address: '10.2.0.3', netmask: '255.0.255.0', family: 'IPv4', internal: false },
      ...lanInterfaces(['en2', '10.3.0.1/31'], ['en3', '10.4.0.1/32']),
    ])
    expect(plan.networks.map((n) => n.interface)).toEqual(['en0'])
  })
})

/* ------------------------------------------------------------------- presence --- */

describe('the presence check (§4.9)', () => {
  const targets = lanNetworks(lanInterfaces(['en0', `${OWN}/24`])).targets
  /** The owner's network: who answered port unreachable, and after how long [V 2026-10-04]. */
  const OWNER = {
    '192.168.68.1': 15,
    '192.168.68.105': 40,
    '192.168.68.106': 60,
    '192.168.68.109': 120,
    '192.168.68.110': 90,
    '192.168.68.112': 300,
    '192.168.68.114': 572,
    '192.168.68.125': 20,
  }

  it('finds who answered, one datagram each, on a /24 with the real window: all closed by about 1.7 s', async () => {
    const fake = fakePresence(OWNER)
    const started = Date.now()
    const result = await checkPresence(targets, {
      open: fake.open,
      port: 9,
      windowMs: 1_000,
      pool: LIMITS.lanSockets,
      signal: new AbortController().signal,
    })
    const took = Date.now() - started
    expect([...result.present].sort()).toEqual(Object.keys(OWNER).sort())
    expect(result.sent).toBe(253)
    expect(result.failure).toBeUndefined()
    expect(fake.checked).toHaveLength(253)
    expect([...fake.datagrams.values()].every((n) => n === 1)).toBe(true)
    expect(fake.most()).toBeLessThanOrEqual(LIMITS.lanSockets)
    expect(fake.open_()).toBe(0)
    /** 64 ticks of 4 at 10 ms, then the last window of 1 s. */
    expect(took).toBeGreaterThan(1_000)
    expect(took).toBeLessThan(2_500)
  })

  it('two /24s: never more than 256 sockets, all closed by about 2.7 s', async () => {
    const two = lanNetworks(lanInterfaces(['en0', `${OWN}/24`], ['en7', '10.0.0.2/24'])).targets
    const fake = fakePresence()
    const started = Date.now()
    await checkPresence(two, {
      open: fake.open,
      port: 9,
      windowMs: 1_000,
      pool: LIMITS.lanSockets,
      signal: new AbortController().signal,
    })
    expect(fake.most()).toBe(LIMITS.lanSockets)
    expect(fake.checked).toHaveLength(506)
    expect(Date.now() - started).toBeLessThan(3_600)
  })

  it('keeps to its pool, and opens at most 4 sockets every 10 ms', async () => {
    const fake = fakePresence()
    const started = Date.now()
    await checkPresence(targets.slice(0, 40), {
      open: fake.open,
      port: 9,
      windowMs: 60,
      pool: 8,
      signal: new AbortController().signal,
    })
    expect(fake.most()).toBeLessThanOrEqual(8)
    /** 40 sockets of 60 ms, 8 at a time: at least 5 windows. */
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
  })

  it.each([
    ['EHOSTUNREACH', 'blocked'],
    ['EPERM', 'blocked'],
    ['ENETUNREACH', 'no-network'],
  ])('a computer that refuses every send (%s) is "%s"', async (code, reason) => {
    const fake = fakePresence(OWNER)
    fake.sendError = errno(code, `send ${code} 192.168.68.1:9`)
    const result = await checkPresence(targets.slice(0, 12), {
      open: fake.open,
      port: 9,
      windowMs: 200,
      pool: 64,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      present: new Set(),
      sent: 0,
      failure: { reason, code, detail: `send ${code} 192.168.68.1:9` },
    })
  })

  it('stops at once when its signal aborts: no new socket, every open one closed', async () => {
    const fake = fakePresence()
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 50)
    const started = Date.now()
    await checkPresence(targets, {
      open: fake.open,
      port: 9,
      windowMs: 5_000,
      pool: 256,
      signal: stop.signal,
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect(fake.checked.length).toBeLessThan(253)
    expect(fake.open_()).toBe(0)
  })

  it('256 sockets on one signal: no abort-listener warning on Node 18 or 20', async () => {
    const fake = fakePresence()
    const warnings = await listenerWarnings(() =>
      checkPresence(targets, {
        open: fake.open,
        port: 9,
        windowMs: 50,
        pool: LIMITS.lanSockets,
        signal: new AbortController().signal,
      }),
    )
    expect(warnings).toEqual([])
    expect(fake.most()).toBeGreaterThan(10)
  })

  it('a check that throws instead of rejecting is a failure, not a crash', async () => {
    const result = await checkPresence(['192.168.68.1'], {
      open: () => {
        throw errno('EPERM', 'connect EPERM 192.168.68.1:9')
      },
      port: 9,
      windowMs: 50,
      pool: 4,
      signal: new AbortController().signal,
    })
    expect(result.failure?.reason).toBe('blocked')
  })
})

/** A UDP port nobody listens on, on 127.0.0.1: bound, read, closed. */
async function freeUdpPort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

const udpHandles = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === 'UDPWrap').length

/** The UDP handles left once every close that was asked for has happened. */
async function settledUdpHandles(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  return udpHandles()
}

/** Every bind of a dgram socket fails at once (an address on no interface): nothing is sent. */
async function withFailingBind<T>(run: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the socket as `this`
  const original = dgram.Socket.prototype.bind
  dgram.Socket.prototype.bind = function (this: dgram.Socket) {
    return original.call(this, { port: 0, address: '203.0.113.1' })
  }
  try {
    return await run()
  } finally {
    dgram.Socket.prototype.bind = original
  }
}

describe('presenceTransport(), on 127.0.0.1 only', () => {
  it('a closed port answers port unreachable: refused', async () => {
    const open = presenceTransport()
    const port = await freeUdpPort()
    const started = Date.now()
    const answer = await open('127.0.0.1', {
      port,
      windowMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(answer).toBe('refused')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('a port that listens and never answers: silent after the window, one byte in one datagram', async () => {
    const listener = dgram.createSocket('udp4')
    const received: Buffer[] = []
    listener.on('message', (packet) => received.push(packet))
    await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve))
    onCleanup(() => new Promise<void>((resolve) => listener.close(() => resolve())))
    const before = await settledUdpHandles()
    const answer = await presenceTransport()('127.0.0.1', {
      port: listener.address().port,
      windowMs: 150,
      signal: new AbortController().signal,
    })
    expect(answer).toBe('silent')
    await until(() => received.length > 0, 1_000, 'the datagram')
    expect(await settledUdpHandles()).toBe(before)
    expect(received).toEqual([Buffer.from([0])])
  })

  it.runIf(process.platform === 'darwin')(
    'an address nobody holds (127.0.0.2 on a Mac): silent',
    async () => {
      const answer = await presenceTransport()('127.0.0.2', {
        port: 9,
        windowMs: 150,
        signal: new AbortController().signal,
      })
      expect(answer).toBe('silent')
    },
  )

  it('an abort ends it at once, its socket closed', async () => {
    const listener = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve))
    onCleanup(() => new Promise<void>((resolve) => listener.close(() => resolve())))
    const before = await settledUdpHandles()
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 30)
    const started = Date.now()
    const answer = await presenceTransport()('127.0.0.1', {
      port: listener.address().port,
      windowMs: 5_000,
      signal: stop.signal,
    })
    expect(answer).toBe('silent')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await settledUdpHandles()).toBe(before)
  })

  it('a socket that cannot bind rejects, and is closed', async () => {
    const before = await settledUdpHandles()
    await expect(
      withFailingBind(() =>
        presenceTransport()('127.0.0.1', {
          port: 9,
          windowMs: 500,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' })
    expect(await settledUdpHandles()).toBe(before)
  })
})

/* ----------------------------------------------------------- hardware addresses --- */

describe('hardware addresses become two facts', () => {
  it('pads what macOS prints, reads hyphens, refuses anything else', () => {
    expect(normalizeMac('6c:2:e0:aa:b:cc')).toBe('6c:02:e0:aa:0b:cc')
    expect(normalizeMac('6C-02-E0-AA-BB-CC')).toBe('6c:02:e0:aa:bb:cc')
    for (const bad of [
      '',
      '(incomplete)',
      '6c:02:e0:aa:bb',
      '6c:02:e0:aa:bb:cc:dd',
      'zz:02:e0:aa:bb:cc',
    ]) {
      expect(normalizeMac(bad), bad).toBeNull()
    }
  })

  it('all zeros, multicast and broadcast name no device', () => {
    expect(unicastMac('6c:02:e0:aa:bb:cc')).toBe(true)
    expect(unicastMac('00:00:00:00:00:00')).toBe(false)
    expect(unicastMac('01:00:5e:00:00:fb')).toBe(false)
    expect(unicastMac('ff:ff:ff:ff:ff:ff')).toBe(false)
  })

  it('a private address says only that; a maker’s address says its 3-byte prefix', () => {
    expect(macFacts('36:a1:b2:c3:d4:e5')).toEqual({ privateAddress: true })
    expect(macFacts('6c:02:e0:aa:bb:cc')).toEqual({ privateAddress: false, maker: '6C02E0' })
  })
})

/* -------------------------------------------------------------- neighbour tables --- */

describe('neighbour tables, as each system prints them', () => {
  it('macOS arp -an: unpadded octets read, incomplete and multicast entries skipped', () => {
    const text = [
      '? (192.168.68.1) at 14:eb:b6:aa:bb:cc on en0 ifscope [ethernet]',
      '? (192.168.68.113) at 52:1f:60:aa:bb:cc on en0 ifscope permanent [ethernet]',
      '? (192.168.68.125) at 6c:2:e0:aa:b:cc on en0 ifscope [ethernet]',
      '? (169.254.169.254) at (incomplete) on en0 [ethernet]',
      '? (192.168.68.2) at (incomplete) on en0 ifscope [ethernet]',
      '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]',
      'garbage (1.2.3.4) at nothing',
    ].join('\n')
    expect(parseArpDarwin(text)).toEqual([
      { address: '192.168.68.1', mac: '14:eb:b6:aa:bb:cc' },
      { address: '192.168.68.113', mac: '52:1f:60:aa:bb:cc' },
      { address: '192.168.68.125', mac: '6c:02:e0:aa:0b:cc' },
    ])
  })

  it('Linux /proc/net/arp: complete (0x2) and permanent (0x6) entries only', () => {
    const text = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      '192.168.0.50     0x1         0x2         00:50:bf:aa:bb:cc     *        eth0',
      '192.168.0.250    0x1         0x0         00:00:00:00:00:00     *        eth0',
      '192.168.0.251    0x1         0xc         00:00:00:00:00:00     *        eth0',
      '192.168.0.7      0x1         0x6         24:a1:60:aa:bb:cc     *        eth0',
    ].join('\n')
    expect(parseProcNetArp(text)).toEqual([
      { address: '192.168.0.50', mac: '00:50:bf:aa:bb:cc' },
      { address: '192.168.0.7', mac: '24:a1:60:aa:bb:cc' },
    ])
  })

  it('Windows ARP.EXE -a, in German: rows by shape; broadcast, multicast and empty rows are no device', () => {
    const text = [
      '',
      'Schnittstelle: 192.168.1.100 --- 0x4',
      '  Internetadresse       Physische Adresse     Typ',
      '  192.168.1.1           14-eb-b6-aa-bb-cc     dynamisch',
      '  192.168.1.20          00-00-00-00-00-00     ungültig',
      '  192.168.1.255         ff-ff-ff-ff-ff-ff     statisch',
      '  224.0.0.22            01-00-5e-00-00-16     statisch',
      '  239.255.255.250       01-00-5e-7f-ff-fa     statisch',
    ].join('\r\n')
    expect(parseArpWindows(text)).toEqual([{ address: '192.168.1.1', mac: '14:eb:b6:aa:bb:cc' }])
  })

  function tables(o: Partial<TableOptions> & { platform: NodeJS.Platform }): TableOptions {
    const root = tempDir('lan-tables-')
    return {
      arpPath: `${root}/nowhere/arp`,
      procNetArpPath: `${root}/nowhere/arp-file`,
      procNetRoutePath: `${root}/nowhere/route-file`,
      routePath: `${root}/nowhere/route`,
      runTool,
      signal: new AbortController().signal,
      ...o,
    }
  }

  it('reads the table: ok, hidden (macOS 27 prints nothing), none (no tool)', async () => {
    const bin = createFakeBin(tempDir('lan-arp-'))
    const full = bin.simple('arp', {
      stdout: '? (192.168.68.1) at 14:eb:b6:aa:bb:cc on en0 ifscope [ethernet]\n',
    })
    expect(await readNeighbours(tables({ platform: 'darwin', arpPath: full }))).toEqual({
      entries: [{ address: '192.168.68.1', mac: '14:eb:b6:aa:bb:cc' }],
      state: 'ok',
    })
    const empty = createFakeBin(tempDir('lan-arp-')).simple('arp', { stdout: '' })
    expect(await readNeighbours(tables({ platform: 'darwin', arpPath: empty }))).toEqual({
      entries: [],
      state: 'hidden',
    })
    expect(await readNeighbours(tables({ platform: 'darwin' }))).toEqual({
      entries: [],
      state: 'none',
    })
    const failing = createFakeBin(tempDir('lan-arp-')).simple('arp', { exit: 1, stderr: 'no' })
    expect((await readNeighbours(tables({ platform: 'darwin', arpPath: failing }))).state).toBe(
      'none',
    )
    expect(bin.calls().map((c) => c.argv)).toEqual([['-an']])
  })

  it('Linux reads /proc/net/arp as a file, Windows runs ARP.EXE -a', async () => {
    const root = tempDir('lan-proc-')
    const bin = createFakeBin(root)
    const file = bin.fixture('arp', '192.168.0.50 0x1 0x2 00:50:bf:aa:bb:cc * eth0\n')
    expect(await readNeighbours(tables({ platform: 'linux', procNetArpPath: file }))).toEqual({
      entries: [{ address: '192.168.0.50', mac: '00:50:bf:aa:bb:cc' }],
      state: 'ok',
    })
    const arp = bin.simple('ARP.EXE', { stdout: '  192.168.1.1   14-eb-b6-aa-bb-cc   dynamic\r\n' })
    expect(await readNeighbours(tables({ platform: 'win32', arpPath: arp }))).toEqual({
      entries: [{ address: '192.168.1.1', mac: '14:eb:b6:aa:bb:cc' }],
      state: 'ok',
    })
    expect(bin.calls().map((c) => c.argv)).toEqual([['-a']])
    expect((await readNeighbours(tables({ platform: 'freebsd' }))).state).toBe('none')
  })
})

/* ------------------------------------------------------------- default gateway --- */

describe('the default gateway', () => {
  it('macOS route -n get default', () => {
    const text = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 192.168.68.1',
      '  interface: en0',
      '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
    ].join('\n')
    expect(parseRouteGetDefault(text)).toBe('192.168.68.1')
    expect(parseRouteGetDefault('    gateway: link#14\n')).toBeNull()
    expect(parseRouteGetDefault('route: writing to routing socket: not in table\n')).toBeNull()
  })

  it('Linux /proc/net/route: the default route with the lowest metric, read little-endian', () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t0000000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
      'tun0\t00000000\t00000000\t0001\t0\t0\t50\t00000000\t0\t0\t0',
    ].join('\n')
    expect(parseProcNetRoute(text)).toBe('10.0.0.1')
    expect(parseProcNetRoute(text.split('\n').slice(0, 2).join('\n'))).toBe('192.168.2.1')
  })

  it('Windows ROUTE.EXE print -4 0.0.0.0, in German: columns by position', () => {
    const text = [
      '===========================================================================',
      'Schnittstellenliste',
      '  4...00 15 5d aa bb cc ......Intel(R) Wi-Fi 6 AX201 160MHz',
      '===========================================================================',
      '',
      'IPv4-Routentabelle',
      'Aktive Routen:',
      '     Netzwerkziel    Netzwerkmaske          Gateway    Schnittstelle Metrik',
      '          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.100     35',
      '          0.0.0.0          0.0.0.0       10.0.0.254        10.0.0.17     25',
      'Ständige Routen:',
      '  Netzwerkadresse          Netzmaske  Gatewayadresse  Metrik',
      '          0.0.0.0          0.0.0.0     192.168.1.9  Standard',
    ].join('\r\n')
    expect(parseRouteWindows(text)).toBe('10.0.0.254')
  })

  it('reads it through the system’s own tool, or file', async () => {
    const bin = createFakeBin(tempDir('lan-route-'))
    const route = bin.simple('route', { stdout: '    gateway: 192.168.68.1\n' })
    const o = {
      arpPath: '/nowhere/arp',
      procNetArpPath: '/nowhere/arp',
      procNetRoutePath: bin.fixture(
        'route-file',
        'h\nwlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n',
      ),
      routePath: route,
      runTool,
      signal: new AbortController().signal,
    }
    expect(await readGateway({ ...o, platform: 'darwin' })).toBe('192.168.68.1')
    expect(await readGateway({ ...o, platform: 'linux' })).toBe('192.168.2.1')
    expect(await readGateway({ ...o, platform: 'darwin', routePath: '/nowhere/route' })).toBeNull()
    expect(bin.calls().map((c) => c.argv)).toEqual([['-n', 'get', 'default']])
  })
})

/* ------------------------------------------------------------------------ SSDP --- */

describe('SSDP answers', () => {
  it('reads the router’s answer, headers in any case, the first of each kept', () => {
    const answer = parseSsdpResponse(
      Buffer.from(
        'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nlocation: http://192.168.68.1:1900/cmlgh/rootDesc.xml\r\nServer: TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8\r\nST: upnp:rootdevice\r\nUSN: uuid:00000000-0000-4000-8000-000000000001::upnp:rootdevice\r\nLOCATION: http://evil.example/\r\n\r\n',
      ),
    )
    expect(answer).toEqual({
      location: 'http://192.168.68.1:1900/cmlgh/rootDesc.xml',
      server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
      st: 'upnp:rootdevice',
      usn: 'uuid:00000000-0000-4000-8000-000000000001::upnp:rootdevice',
    })
  })

  it('refuses what is not an answer, and anything over 2 KiB', () => {
    expect(
      parseSsdpResponse(Buffer.from('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\n\r\n')),
    ).toBeNull()
    expect(parseSsdpResponse(Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n'))).toBeNull()
    expect(parseSsdpResponse(Buffer.alloc(3_000, 0x41))).toBeNull()
    expect(parseSsdpResponse(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]))).toBeNull()
    const big = ssdpResponse({ SERVER: 'x'.repeat(2_100) })
    expect(parseSsdpResponse(big)).toBeNull()
  })

  it('cleans what a header carries: no escape, no control character, capped', () => {
    const answer = parseSsdpResponse(
      ssdpResponse({ SERVER: 'Evil\u001b[2J\u0007 TV', ST: 'upnp:rootdevice' }),
    )
    expect(answer?.server).toBe('Evil TV')
  })

  it('takes device types from ST and USN, never a service type but DIAL’s', () => {
    expect(deviceTypeOf('urn:schemas-upnp-org:device:InternetGatewayDevice:1')).toBe(
      'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    )
    expect(deviceTypeOf('uuid:x::urn:schemas-upnp-org:device:MediaRenderer:1')).toBe(
      'urn:schemas-upnp-org:device:MediaRenderer:1',
    )
    expect(deviceTypeOf('urn:dial-multiscreen-org:service:dial:1')).toBe(
      'urn:dial-multiscreen-org:service:dial:1',
    )
    expect(deviceTypeOf('urn:schemas-upnp-org:service:WANIPConnection:1')).toBeNull()
    expect(deviceTypeOf('uuid:x::upnp:rootdevice')).toBeNull()
  })

  it('an M-SEARCH as UDA 2.0 writes it', () => {
    expect(mSearch('ssdp:all').toString('latin1')).toBe(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n',
    )
  })
})

describe('searchSsdp()', () => {
  const search = (
    net: ReturnType<typeof fakeSsdpNetwork>,
    o: { windowMs?: number; signal?: AbortSignal } = {},
  ) =>
    searchSsdp({
      open: net.open,
      interfaces: [OWN],
      targets: LAN_SSDP_TARGETS,
      windowMs: o.windowMs ?? 700,
      signal: o.signal ?? new AbortController().signal,
    })

  it('the router: its types, SERVER and first LOCATION; each search twice, then closed', async () => {
    const net = fakeSsdpNetwork([decoRouter()])
    const { devices, failure } = await search(net)
    expect(failure).toBeUndefined()
    expect([...devices]).toEqual([
      [
        '192.168.68.1',
        {
          server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
          location: 'http://192.168.68.1:1900/cmlgh/rootDesc.xml',
          types: [
            'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
            'urn:schemas-upnp-org:device:WANDevice:1',
          ],
        },
      ],
    ])
    expect(net.searches).toEqual([
      { st: 'ssdp:all', local: OWN },
      { st: 'upnp:rootdevice', local: OWN },
      { st: 'ssdp:all', local: OWN },
      { st: 'upnp:rootdevice', local: OWN },
    ])
    expect([net.opened(), net.closed()]).toEqual([1, 1])
  })

  it('only answers from the local network, at most 256 of them', async () => {
    const flood = ssdpResponder('192.168.68.66', () =>
      Array.from({ length: 300 }, (_, i) =>
        ssdpResponse({ ST: 'upnp:rootdevice', USN: `uuid:${String(i)}` }),
      ),
    )
    const outsider = ssdpResponder('8.8.8.8', () => [ssdpResponse({ ST: 'upnp:rootdevice' })])
    const own = ssdpResponder('127.0.0.1', () => [ssdpResponse({ ST: 'upnp:rootdevice' })])
    const { devices } = await search(fakeSsdpNetwork([flood, outsider, own]), { windowMs: 300 })
    expect([...devices.keys()]).toEqual(['192.168.68.66'])
  })

  it.each([
    ['EHOSTUNREACH', 'blocked'],
    ['ENETDOWN', 'no-network'],
  ])(
    'an M-SEARCH that cannot leave (%s) is "%s", and the socket is closed',
    async (code, reason) => {
      const net = fakeSsdpNetwork([decoRouter()])
      net.sendError = errno(code, `send ${code} 239.255.255.250:1900`)
      const result = await search(net)
      expect(result.failure).toMatchObject({ reason, code })
      expect([net.opened(), net.closed()]).toEqual([1, 1])
    },
  )

  it('a socket that cannot open is a failure too; an abort ends the window', async () => {
    const net = fakeSsdpNetwork()
    net.openError = errno('EPERM', 'bind EPERM 0.0.0.0')
    expect((await search(net)).failure?.reason).toBe('blocked')
    const quiet = fakeSsdpNetwork([decoRouter()])
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 30)
    const started = Date.now()
    await search(quiet, { windowMs: 5_000, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(quiet.closed()).toBe(1)
  })
})

describe('ssdpTransport(), on 127.0.0.1 only', () => {
  it('sends the M-SEARCH from an ephemeral port and reads the answer sent back to it', async () => {
    const responder = dgram.createSocket('udp4')
    const asked: string[] = []
    responder.on('message', (packet, from) => {
      asked.push(packet.toString('latin1'))
      responder.send(
        ssdpResponse({ ST: 'upnp:rootdevice', SERVER: 'Loopback' }),
        from.port,
        from.address,
      )
    })
    await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve))
    onCleanup(() => new Promise<void>((resolve) => responder.close(() => resolve())))
    const open = ssdpTransport({ address: '127.0.0.1', port: responder.address().port })
    const heard: Array<[string, string]> = []
    const transport = await open((packet, from) => heard.push([packet.toString('latin1'), from]))
    onCleanup(() => transport.close())
    await transport.send(mSearch('upnp:rootdevice'), '127.0.0.1')
    await until(() => heard.length > 0)
    expect(asked[0]).toBe(mSearch('upnp:rootdevice').toString('latin1'))
    expect(heard[0]?.[1]).toBe('127.0.0.1')
    expect(parseSsdpResponse(Buffer.from(heard[0]?.[0] ?? ''))?.server).toBe('Loopback')
  })

  it('a socket that cannot bind rejects, and is closed', async () => {
    const before = await settledUdpHandles()
    await expect(withFailingBind(() => ssdpTransport()(() => undefined))).rejects.toMatchObject({
      code: 'EADDRNOTAVAIL',
    })
    expect(await settledUdpHandles()).toBe(before)
  })
})

/* ------------------------------------------------------- the UPnP description --- */

describe('where a description may be fetched from', () => {
  const from = '192.168.68.1'
  it('the device’s own address only, over plain HTTP', () => {
    expect(descriptionTarget('http://192.168.68.1:1900/cmlgh/rootDesc.xml?x=1', from)).toEqual({
      host: from,
      port: 1900,
      path: '/cmlgh/rootDesc.xml?x=1',
    })
    expect(descriptionTarget('http://192.168.68.1/desc.xml', from)).toEqual({
      host: from,
      port: 80,
      path: '/desc.xml',
    })
  })

  it.each([
    ['another device', 'http://192.168.68.125/desc.xml'],
    ['this computer', 'http://127.0.0.1:8787/api/devices'],
    ['the internet', 'http://203.0.113.9/desc.xml'],
    ['a name', 'http://router.local/desc.xml'],
    ['https', 'https://192.168.68.1/desc.xml'],
    ['another scheme', 'file:///etc/passwd'],
    ['a user and password', 'http://admin:admin@192.168.68.1/desc.xml'],
    ['a port out of range', 'http://192.168.68.1:99999/desc.xml'],
    ['IPv6', 'http://[fe80::1]/desc.xml'],
    ['junk', 'not a url'],
  ])('never %s', (_, location) => {
    expect(descriptionTarget(location, from)).toBeNull()
  })

  it('never at a responder that is not on the local network', () => {
    expect(descriptionTarget('http://8.8.8.8/desc.xml', '8.8.8.8')).toBeNull()
    expect(descriptionTarget('http://127.0.0.1/desc.xml', '127.0.0.1')).toBeNull()
  })
})

describe('the description’s tag scanner', () => {
  it('reads the root device’s fields, entities decoded, never an embedded device’s', () => {
    expect(parseDescription(DECO_DESCRIPTION)).toEqual({
      deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      friendlyName: 'Deco X20 & mesh',
      manufacturer: 'TP-Link',
      modelName: 'Deco X20',
      modelNumber: '4.0',
    })
    expect(DESCRIPTION_FIELDS).not.toContain('serialNumber')
  })

  it('refuses a DOCTYPE or an ENTITY whole: no entity is ever expanded', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><root><device><friendlyName>&lol2;</friendlyName></device></root>`
    expect(parseDescription(bomb)).toEqual({})
    expect(
      parseDescription('<root><!ENTITY x "y"><device><modelName>M</modelName></device></root>'),
    ).toEqual({})
  })

  it('skips a field holding markup or CDATA, and fields after the device’s own list', () => {
    const xml =
      '<root><device><friendlyName><![CDATA[Hidden]]></friendlyName><modelName>A<b>B</b></modelName>' +
      '<deviceList><device><manufacturer>Inner</manufacturer></device></deviceList>' +
      '<manufacturer>After</manufacturer></device></root>'
    expect(parseDescription(xml)).toEqual({})
  })

  it('cleans and caps every field; ignores a document over 64 KiB', () => {
    const xml = `<root><device><friendlyName>Bad\u0007\u001b[31m name ${'x'.repeat(200)}</friendlyName></device></root>`
    const name = parseDescription(xml).friendlyName ?? ''
    expect(name.startsWith('Bad name xxx')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(LIMITS.field)
    expect(
      parseDescription(
        `<root><device><modelName>M</modelName>${' '.repeat(MAX_DESCRIPTION)}</device></root>`,
      ),
    ).toEqual({})
    expect(parseDescription('no xml at all')).toEqual({})
    expect(parseDescription('<deviceType>urn:x</deviceType>')).toEqual({})
  })
})

describe('fetchDescription(), against a server on 127.0.0.1', () => {
  async function serve(handler: http.RequestListener): Promise<{ port: number; paths: string[] }> {
    const paths: string[] = []
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? '')
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    onCleanup(() => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { port: (server.address() as AddressInfo).port, paths }
  }
  const options = (o: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({
    timeoutMs: o.timeoutMs ?? 1_000,
    maxBytes: MAX_DESCRIPTION,
    signal: o.signal ?? new AbortController().signal,
  })

  it('a 200 in XML: its body, asked for with Accept: text/xml', async () => {
    let accept = ''
    const { port } = await serve((req, res) => {
      accept = req.headers.accept ?? ''
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' })
      res.end(DECO_DESCRIPTION)
    })
    expect(
      await fetchDescription({ host: '127.0.0.1', port, path: '/rootDesc.xml' }, options()),
    ).toBe(DECO_DESCRIPTION)
    expect(accept).toBe('text/xml')
  })

  it('never follows a redirect', async () => {
    const { port, paths } = await serve((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' })
      res.end()
    })
    await expect(
      fetchDescription({ host: '127.0.0.1', port, path: '/d.xml' }, options()),
    ).rejects.toThrow()
    expect(paths).toEqual(['/d.xml'])
  })

  it('refuses a body over 64 KiB, said or not, and anything that is not XML', async () => {
    const { port } = await serve((req, res) => {
      if (req.url === '/said') {
        res.writeHead(200, {
          'Content-Type': 'text/xml',
          'Content-Length': String(MAX_DESCRIPTION + 1),
        })
        res.end('x'.repeat(MAX_DESCRIPTION + 1))
      } else if (req.url === '/unsaid') {
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.write('x'.repeat(40_000))
        res.end('x'.repeat(40_000))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html></html>')
      }
    })
    for (const path of ['/said', '/unsaid', '/html']) {
      await expect(
        fetchDescription({ host: '127.0.0.1', port, path }, options()),
        path,
      ).rejects.toThrow()
    }
  })

  it('gives up at its deadline, and when its signal aborts', async () => {
    const { port } = await serve(() => undefined)
    const started = Date.now()
    await expect(
      fetchDescription({ host: '127.0.0.1', port, path: '/slow' }, options({ timeoutMs: 150 })),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1_000)
    const stop = new AbortController()
    stop.abort()
    await expect(
      fetchDescription(
        { host: '127.0.0.1', port, path: '/slow' },
        options({ signal: stop.signal }),
      ),
    ).rejects.toThrow()
  })
})
