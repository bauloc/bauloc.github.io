/*
  Android devices on the network (§4.8): what a scan offers (only local addresses), how it
  is named and compared with what adb lists, the terminal's lines, and GET
  /api/android/nearby through the real bridge, the real Android lane, the fake adb server
  and the fake mDNS network of fakes/mdns.ts. No adb, no real server, no real network.
*/
import { describe, expect, it } from 'vitest'
import {
  ADB_HOST_SERVICES,
  assertAdbService,
  createAdbClient,
  createAndroidLane,
  mergeNearby,
  nearbyFailureLines,
  nearbyFromBrowse,
  nearbyLines,
  nearbySummary,
  offerableAddress,
  parseAdbMdnsServices,
  parseDevicesL,
  serialOfInstance,
  type AndroidCadence,
  type DevicesLRow,
  type FoundService,
} from '../src/android-lane'
import { createBridge } from '../src/bridge'
import { TIMEOUTS } from '../src/constants'
import { browse } from '../src/mdns'
import type {
  AndroidNearbyDevice,
  AndroidNearbyResult,
  ErrorBody,
  Health,
  Timeouts,
} from '../src/types'
import { createFakeAdbServer, shield, type FakeAdbServer } from './fakes/adb-server'
import { fakeAndroidLane } from './fakes/lane'
import {
  BRAVIA,
  PIXEL9,
  braviaTv,
  errno,
  fakeMdnsNetwork,
  pixel9,
  zoneResponder,
  type FakeMdnsNetwork,
  type ZoneOptions,
} from './fakes/mdns'
import { freePort, isolation, onCleanup, request, startBridge, toolbox, until } from './harness'

const ALL_SERVICES = [
  '_adb._tcp.local',
  '_adb-tls-connect._tcp.local',
  '_adb-tls-pairing._tcp.local',
  '_androidtvremote2._tcp.local',
  '_googlecast._tcp.local',
]

async function scan(network: FakeMdnsNetwork): Promise<ReturnType<typeof nearbyFromBrowse>> {
  const { instances } = await browse({ services: ALL_SERVICES, open: network.open, windowMs: 120 })
  return nearbyFromBrowse(instances)
}

const row = (serial: string, state = 'device', props = ''): DevicesLRow =>
  parseDevicesL(`${serial} ${state}${props}\n`)[0] as DevicesLRow

const TV: AndroidNearbyDevice = {
  id: 'adb:192.168.68.101:5555',
  host: '192.168.68.101',
  port: 5555,
  kind: 'adb',
  instance: BRAVIA.adb,
  name: 'SONY KD-43X8050H',
  serial: 'b120be004010859',
  tv: true,
  connected: false,
}

const PHONE: AndroidNearbyDevice = {
  id: 'wireless:192.168.68.114:39601',
  host: '192.168.68.114',
  port: 39601,
  kind: 'wireless',
  instance: PIXEL9.instance,
  name: '',
  serial: '55090DLAQ0026D',
  tv: false,
  connected: false,
  paired: false,
}

describe('what a scan offers (§4.8)', () => {
  it('the TV and the Pixel, named, with the serial their instance names carry', async () => {
    const { found, names } = await scan(fakeMdnsNetwork([braviaTv(), pixel9({ pairing: true })]))
    expect(mergeNearby(found, names, [])).toEqual([
      TV,
      PHONE,
      {
        ...PHONE,
        id: 'pairing:192.168.68.114:37123',
        port: 37123,
        kind: 'pairing',
      },
    ])
  })

  /** A TV whose adbd and TV Remote both call it `Android.local`, as the BRAVIA does. */
  const androidLocalTv = (serial: string, address: string, model: string, o: ZoneOptions = {}) => {
    const adb = `adb-${serial}._adb._tcp.local`
    const remote = `${model}._androidtvremote2._tcp.local`
    return zoneResponder(
      [
        { name: '_adb._tcp.local', type: 'PTR', target: adb },
        { name: adb, type: 'SRV', target: 'Android.local', port: 5555 },
        { name: adb, type: 'TXT', strings: [] },
        { name: '_androidtvremote2._tcp.local', type: 'PTR', target: remote },
        { name: remote, type: 'SRV', target: 'Android.local', port: 6466 },
        { name: remote, type: 'TXT', strings: [] },
        { name: 'Android.local', type: 'A', address },
      ],
      o,
    )
  }
  const twoTvs = (devices: AndroidNearbyDevice[]): string[] =>
    devices.map((d) => `${d.instance} ${d.host} ${d.name}`)

  it.each([
    ['their answers carry the address', {}, {}],
    [
      'each answers from its own address, with the PTR alone',
      { additionals: false, from: '192.168.68.101' },
      { additionals: false, from: '192.168.68.102' },
    ],
  ])(
    'two TVs that both call themselves Android.local are two devices, each at its own address: %s',
    async (_, one: ZoneOptions, two: ZoneOptions) => {
      for (const order of [0, 1]) {
        const tvs = [
          androidLocalTv('aaaa1111', '192.168.68.101', 'SONY KD-43X8050H', one),
          androidLocalTv('bbbb2222', '192.168.68.102', 'TCL 55C735', two),
        ]
        const { found, names } = await scan(fakeMdnsNetwork(order ? tvs.reverse() : tvs))
        expect(twoTvs(mergeNearby(found, names, []))).toEqual([
          'adb-aaaa1111 192.168.68.101 SONY KD-43X8050H',
          'adb-bbbb2222 192.168.68.102 TCL 55C735',
        ])
      }
    },
  )

  it('names a TV by its Cast name (the owner’s) before its Remote name (the model)', async () => {
    const own = await scan(fakeMdnsNetwork([braviaTv({ fn: 'Living Room TV' })]))
    expect(mergeNearby(own.found, own.names, [])[0]?.name).toBe('Living Room TV')
    const blank = await scan(fakeMdnsNetwork([braviaTv({ fn: '' })]))
    expect(mergeNearby(blank.found, blank.names, [])[0]?.name).toBe('SONY KD-43X8050H')
  })

  it.each([
    ['8.8.8.8', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.251', false],
    ['192.168.68.101', true],
    ['10.1.2.3', true],
    ['172.20.0.9', true],
    ['169.254.10.20', true],
    ['100.100.1.1', true],
  ])('offers an adb service at %s: %s', async (address, offered) => {
    const { found } = await scan(fakeMdnsNetwork([braviaTv({ adbAddress: address })]))
    expect(found.map((f) => f.host)).toEqual(offered ? [address] : [])
  })

  it('offers IPv6 only in fc00::/7, never link-local (no zone travels in an answer) or a name', () => {
    expect(offerableAddress('fd00::1')).toBe('fd00::1')
    expect(offerableAddress('FD12:3456::9')).toBe('fd12:3456::9')
    expect(offerableAddress('fe80::1')).toBeNull()
    expect(offerableAddress('fe80::1%en0')).toBeNull()
    expect(offerableAddress('2001:db8::1')).toBeNull()
    expect(offerableAddress('::ffff:192.168.1.2')).toBeNull()
    expect(offerableAddress('Android.local')).toBeNull()
    expect(offerableAddress('192.168.068.1')).toBeNull()
  })

  it('reads adb’s own mDNS list, whatever its version writes', () => {
    const text = [
      'List of discovered mdns services',
      `${PIXEL9.instance}\t_adb-tls-connect._tcp\t192.168.68.114:39601`,
      `${PIXEL9.instance}\t_adb-tls-pairing._tcp.\t192.168.68.114:37123`,
      `${BRAVIA.adb}  _adb._tcp  192.168.68.101:5555`,
      'adb-PUBLIC\t_adb._tcp\t8.8.8.8:5555',
      'adb-LOOP\t_adb._tcp\t127.0.0.1:5555',
      'adb-ULA\t_adb._tcp\t[fd00::5]:5555',
      'adb-PORT\t_adb._tcp\t192.168.1.9:70000',
      'adb-OTHER\t_ipp._tcp\t192.168.1.9:631',
      'garbage',
      '',
    ].join('\n')
    expect(parseAdbMdnsServices(text)).toEqual([
      {
        kind: 'wireless',
        host: '192.168.68.114',
        port: 39601,
        instance: PIXEL9.instance,
        fromAdb: true,
      },
      {
        kind: 'pairing',
        host: '192.168.68.114',
        port: 37123,
        instance: PIXEL9.instance,
        fromAdb: true,
      },
      { kind: 'adb', host: '192.168.68.101', port: 5555, instance: BRAVIA.adb, fromAdb: true },
      { kind: 'adb', host: 'fd00::5', port: 5555, instance: 'adb-ULA', fromAdb: true },
    ] satisfies FoundService[])
  })

  it('takes the serial from adbd’s instance names only', () => {
    expect(serialOfInstance('adb-b120be004010859')).toBe('b120be004010859')
    expect(serialOfInstance('adb-55090DLAQ0026D-nK25Qn')).toBe('55090DLAQ0026D')
    expect(serialOfInstance('SONY KD-43X8050H')).toBeUndefined()
    expect(serialOfInstance('adb-a b')).toBeUndefined()
    expect(serialOfInstance('adb-x')).toBeUndefined()
  })
})

describe('compared with what adb lists', () => {
  const tv: FoundService = { kind: 'adb', host: '192.168.68.101', port: 5555, instance: BRAVIA.adb }
  const phone: FoundService = {
    kind: 'wireless',
    host: '192.168.68.114',
    port: 39601,
    instance: PIXEL9.instance,
  }
  const pairing: FoundService = { ...phone, kind: 'pairing', port: 37123 }
  const none = new Map()

  it('connected by its host:port, unauthorized or not', () => {
    const [device] = mergeNearby([tv], none, [row('192.168.68.101:5555', 'unauthorized')])
    expect(device).toMatchObject({ connected: true, deviceId: '192.168.68.101:5555' })
    expect(device).not.toHaveProperty('paired')
  })

  it('a Wireless-debugging phone adb connected by its mDNS name is connected and paired', () => {
    const listed = [row(`${PIXEL9.instance}._adb-tls-connect._tcp`, 'device', ' product:tokay')]
    const devices = mergeNearby([phone, pairing], none, listed)
    expect(devices.map((d) => [d.kind, d.connected, d.paired, d.deviceId])).toEqual([
      ['wireless', true, true, `${PIXEL9.instance}._adb-tls-connect._tcp`],
      ['pairing', true, true, `${PIXEL9.instance}._adb-tls-connect._tcp`],
    ])
  })

  it('a phone connected by its address is paired; its pairing port matches by host', () => {
    const devices = mergeNearby([phone, pairing], none, [row('192.168.68.114:39601')])
    expect(devices.map((d) => [d.connected, d.paired, d.deviceId])).toEqual([
      [true, true, '192.168.68.114:39601'],
      [true, true, '192.168.68.114:39601'],
    ])
  })

  it('on a cable it is connected (its row is named) but not known to be paired', () => {
    const devices = mergeNearby([phone], none, [row('55090DLAQ0026D', 'device', ' usb:1-1')])
    expect(devices[0]).toMatchObject({ connected: true, paired: false, deviceId: '55090DLAQ0026D' })
  })

  it('a TV on 5555 does not match another device on its host; nothing matches nothing', () => {
    const devices = mergeNearby([tv, phone], none, [
      row('192.168.68.101:41000'),
      row('emulator-5554'),
      row('????????????', 'no permissions'),
    ])
    expect(devices.map((d) => d.connected)).toEqual([false, false])
  })

  it('once each (by kind and instance, then address), ordered by address, at most 64', () => {
    const found: FoundService[] = [
      phone,
      tv,
      { ...tv },
      { ...tv, host: 'fd00::1' },
      { ...tv, instance: 'adb-OTHER' },
      ...Array.from({ length: 80 }, (_, i) => ({
        kind: 'adb' as const,
        host: `10.0.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
        port: 5555,
        instance: `adb-DEV${String(i).padStart(3, '0')}`,
      })),
    ]
    const devices = mergeNearby(found, none, [])
    expect(devices).toHaveLength(64)
    expect(devices[0]?.host).toBe('10.0.0.1')
    expect(devices[1]?.host).toBe('10.0.0.2')
    expect(devices[9]?.host).toBe('10.0.0.10')
    const few = mergeNearby(found.slice(0, 5), none, [])
    expect(few.map((d) => d.id)).toEqual([
      'adb:192.168.68.101:5555',
      'wireless:192.168.68.114:39601',
    ])
  })
})

describe('the terminal’s lines', () => {
  it('one line for what a scan found, one device per address', () => {
    expect(nearbySummary([])).toBe(
      'Wi-Fi: no Android device on this network advertises Network or Wireless debugging',
    )
    const pairing = { ...PHONE, id: 'pairing:x', kind: 'pairing' as const, port: 37123 }
    expect(nearbySummary([TV, PHONE, pairing])).toBe(
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging)',
    )
    expect(
      nearbySummary([
        { ...TV, connected: true },
        { ...TV, host: '192.168.1.7', tv: false },
      ]),
    ).toBe(
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Network debugging), 1 already connected',
    )
  })

  it('--doctor lists each one by its model or instance, never by its own name (T18)', () => {
    expect(
      nearbyLines([
        { ...TV, connected: true, deviceId: '192.168.68.101:5555' },
        { ...PHONE, name: 'Jane’s Pixel', model: 'Pixel 9' },
      ]),
    ).toEqual([
      `  ${BRAVIA.adb} · 192.168.68.101:5555 · Network debugging · listed as 192.168.68.101:5555`,
      '  Pixel 9 · 192.168.68.114:39601 · Wireless debugging · not connected',
    ])
  })

  it('blocked names both causes and fixes; the macOS one only on a Mac', () => {
    const blocked = {
      reason: 'blocked' as const,
      message: '',
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    }
    const mac = nearbyFailureLines(blocked, 'darwin')
    expect(mac[0]).toBe(
      "Wi-Fi: could not look for Android devices on the network: no route to host, so this computer can't reach the local network",
    )
    expect(mac[1]).toContain('Cloudflare WARP')
    expect(mac[2]).toContain('start the helper from Terminal.app and choose Allow')
    expect(nearbyFailureLines(blocked, 'linux')).toHaveLength(2)
    expect(
      nearbyFailureLines({ ...blocked, detail: 'send EPERM 224.0.0.251:5353' }, 'linux')[0],
    ).toContain(': not permitted, so')
    expect(nearbyFailureLines({ reason: 'no-network', message: '', detail: '' }, 'darwin')).toEqual(
      [
        'Wi-Fi: could not look for Android devices on the network: this computer is not on a network',
      ],
    )
  })
})

/* --------------------------------------------------------- through the bridge --- */

const FAST: Partial<Timeouts> = { adbConnect: 1_000, adbRequest: 1_000, mdnsWindow: 150 }
const CADENCE: Partial<AndroidCadence> = {
  presenceMs: 100,
  pollMs: 100,
  identityGraceMs: 300,
  retryWaitMs: 1_000,
  nearbyCacheMs: 1_500,
  nearbyGapMs: 600,
}

interface Run {
  port: number
  auth: Record<string, string>
  logs: string[]
  calls: () => Array<{ name: string; argv: string[] }>
  nearby: (refresh?: boolean) => Promise<{ status: number; body: AndroidNearbyResult }>
}

async function fakeServer(): Promise<FakeAdbServer> {
  const server = await createFakeAdbServer({ port: await freePort() })
  onCleanup(() => server.close())
  return server
}

async function startNearby(opts: {
  network: FakeMdnsNetwork
  adbPort: number
  platform?: NodeJS.Platform
}): Promise<Run> {
  const iso = await isolation({ adbPort: opts.adbPort, timeouts: FAST })
  const bridge = createBridge({
    ...iso.input,
    mdns: opts.network.open,
    platform: opts.platform ?? 'darwin',
    lanes: {
      ios: null,
      simulators: null,
      android: (ctx) =>
        createAndroidLane(ctx, {
          ...CADENCE,
          lookup: () => Promise.reject(new Error('no names in tests')),
        }),
    },
    resolveTools: () =>
      Promise.resolve(toolbox((t) => (t.adb = { path: '/nowhere/adb', version: '36.0.0' }))),
  })
  const { port } = await bridge.listen()
  onCleanup(() => bridge.close())
  const auth = { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' }
  return {
    port,
    auth,
    logs: iso.logs,
    calls: () => iso.bin.calls(),
    async nearby(refresh = false) {
      const reply = await request(port, {
        path: `/api/android/nearby${refresh ? '?refresh=1' : ''}`,
        headers: auth,
      })
      return { status: reply.status, body: reply.json<AndroidNearbyResult>() }
    },
  }
}

/** The scan's terminal lines, without their timestamps. */
const wifiLines = (run: Run): string[] =>
  run.logs
    .map((line) => line.replace(/^\S+ {2}/, ''))
    .filter((line) => /^(?:Wi-Fi: | {2}If a VPN| {2}macOS may not)/.test(line))

describe('GET /api/android/nearby', () => {
  it('lists the TV and the phone, marks what adb lists, and starts nothing', async () => {
    const server = await fakeServer()
    server.setDevices([
      { serial: '192.168.68.101:5555', state: 'unauthorized', props: ' transport_id:5' },
    ])
    /** adb found the phone's pairing port by itself; the helper's own scan did not. */
    server.mdnsServices = `${PIXEL9.instance}\t_adb-tls-pairing._tcp\t192.168.68.114:37123\n`
    const network = fakeMdnsNetwork([braviaTv(), pixel9()])
    const run = await startNearby({ network, adbPort: server.port })
    await until(() => server.services.includes('host:track-devices-l'))

    const { status, body } = await run.nearby()
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    expect(body.scannedAt).toEqual(expect.any(Number))
    expect(body.devices).toEqual([
      { ...TV, connected: true, deviceId: '192.168.68.101:5555' },
      PHONE,
      { ...PHONE, id: 'pairing:192.168.68.114:37123', kind: 'pairing', port: 37123 },
    ])
    expect(server.services).toContain('host:mdns:services')
    expect(server.services.filter((s) => /^host:(?:connect|pair|disconnect|kill)/.test(s))).toEqual(
      [],
    )
    expect(run.calls()).toEqual([])
    expect(wifiLines(run)).toEqual([
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging), 1 already connected',
    ])
  })

  it('without a server: its own scan only, and no adb request at all', async () => {
    const adbPort = await freePort()
    const network = fakeMdnsNetwork([braviaTv()])
    const run = await startNearby({ network, adbPort })
    const { body } = await run.nearby()
    expect(body.devices).toEqual([TV])
    expect(run.calls()).toEqual([])
  })

  it('caches a scan; ?refresh=1 rescans, never two at once, never within the gap', async () => {
    const server = await fakeServer()
    const network = fakeMdnsNetwork([braviaTv()])
    const run = await startNearby({ network, adbPort: server.port })
    await run.nearby()
    expect(network.scans()).toBe(1)
    await run.nearby()
    await run.nearby(true)
    /** Within the 600 ms gap a refresh answers the last scan. */
    expect(network.scans()).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 650))
    const [a, b, c] = await Promise.all([run.nearby(true), run.nearby(true), run.nearby()])
    expect(network.scans()).toBe(2)
    expect(a.body.scannedAt).toBe(b.body.scannedAt)
    expect(c.body.scannedAt).toBe(a.body.scannedAt)
    /** After the cache time a plain GET scans again. */
    await new Promise((resolve) => setTimeout(resolve, 1_550))
    await run.nearby()
    expect(network.scans()).toBe(3)
    expect([network.opened(), network.closed()]).toEqual([3, 3])
  })

  it('compares with adb’s list as it is now, not as it was when the scan ran', async () => {
    const server = await fakeServer()
    server.addNetworkDevice({ ...shield('192.168.68.101'), allowed: true })
    const network = fakeMdnsNetwork([braviaTv()])
    const run = await startNearby({ network, adbPort: server.port })
    expect((await run.nearby()).body.devices[0]?.connected).toBe(false)
    const body = JSON.stringify({ host: '192.168.68.101' })
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/android/connect',
      headers: {
        ...run.auth,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    })
    expect(reply.status).toBe(200)
    const after = await run.nearby()
    expect(after.body.devices[0]).toMatchObject({
      connected: true,
      deviceId: '192.168.68.101:5555',
    })
    expect(network.scans()).toBe(1)
  })

  it('blocked: the reason and its fixes, adb’s own finds still listed, printed once', async () => {
    const server = await fakeServer()
    server.mdnsServices = `${BRAVIA.adb}\t_adb._tcp\t192.168.68.101:5555\n`
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    const run = await startNearby({ network, adbPort: server.port })
    await until(() => server.services.includes('host:track-devices-l'))
    const { status, body } = await run.nearby()
    expect(status).toBe(200)
    expect(body.error).toEqual({
      reason: 'blocked',
      message: expect.stringMatching(
        /^Could not look for devices on the network\. Something on this computer is blocking the local network\. If a VPN is on \(Cloudflare WARP.*start the helper from Terminal\.app and choose Allow/,
      ) as unknown,
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    })
    /** Found by adb, so no Cast or Remote name: the page shows the address. */
    expect(body.devices).toEqual([{ ...TV, name: '', tv: false }])
    await new Promise((resolve) => setTimeout(resolve, 650))
    await run.nearby(true)
    const lines = wifiLines(run)
    expect(lines).toEqual([
      "Wi-Fi: could not look for Android devices on the network: no route to host, so this computer can't reach the local network",
      expect.stringContaining('If a VPN is on (Cloudflare WARP') as unknown,
      expect.stringContaining('macOS may not let the app that started the helper') as unknown,
      'Wi-Fi: 1 Android device on this network (1 with Network debugging)',
    ])
  })

  it('needs the bearer token and the allowed Origin, like every route', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    const run = await startNearby({ network, adbPort: await freePort() })
    const anonymous = await request(run.port, { path: '/api/android/nearby' })
    expect([anonymous.status, anonymous.json<ErrorBody>().error.code]).toEqual([
      401,
      'UNAUTHORIZED',
    ])
    const elsewhere = await request(run.port, {
      path: '/api/android/nearby',
      headers: { ...run.auth, Origin: 'https://evil.example' },
    })
    expect(elsewhere.status).toBe(403)
    const posted = await request(run.port, {
      method: 'POST',
      path: '/api/android/nearby',
      headers: run.auth,
    })
    expect(posted.status).toBe(405)
    expect(network.scans()).toBe(0)
  })

  it('goes to the lane with ?refresh=1 as asked; 409 ANDROID_OFF with --no-android', async () => {
    const lane = fakeAndroidLane({
      nearby: (refresh) => Promise.resolve({ devices: refresh ? [TV] : [], scannedAt: 1 }),
    })
    const s = await startBridge({ lanes: { android: lane.factory } })
    const get = (path: string) => request(s.port, { path, headers: s.auth })
    expect((await get('/api/android/nearby')).json<AndroidNearbyResult>().devices).toEqual([])
    expect(
      (await get('/api/android/nearby?refresh=1')).json<AndroidNearbyResult>().devices,
    ).toEqual([TV])
    expect(lane.calls.map((c) => c.op)).toEqual(['start', 'nearby', 'nearby refresh'])
    const health = (await request(s.port, { path: '/api/health' })).json<Health>()
    expect(health.features).toContain('android.discover')

    const off = await startBridge({ android: false })
    const refused = await request(off.port, { path: '/api/android/nearby', headers: off.auth })
    expect([refused.status, refused.json<ErrorBody>().error.code]).toEqual([409, 'ANDROID_OFF'])
    const offHealth = (await request(off.port, { path: '/api/health' })).json<Health>()
    expect(offHealth.features).not.toContain('android.discover')
  })
})

describe('host:mdns:services', () => {
  it('is on the allowlist, and the client reads it', async () => {
    expect(ADB_HOST_SERVICES).toContain('host:mdns:services')
    expect(() => assertAdbService('host:mdns:services')).not.toThrow()
    expect(() => assertAdbService('host:mdns:check')).toThrow()
    const server = await fakeServer()
    server.mdnsServices = `${BRAVIA.adb}\t_adb._tcp\t192.168.68.101:5555\n`
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS })
    expect(await client.mdnsServices()).toBe(server.mdnsServices)
    server.mdnsServices = { fail: 'unknown host service' }
    await expect(client.mdnsServices()).rejects.toMatchObject({ code: 'TOOL_FAILED' })
    client.close()
  })
})

describe('--doctor (§1.9)', () => {
  async function doctorLines(network: FakeMdnsNetwork, adbPort: number): Promise<string[]> {
    const iso = await isolation({ adbPort, timeouts: FAST, mdns: network.open, platform: 'darwin' })
    const bridge = createBridge({
      ...iso.input,
      lanes: { ios: null, simulators: null, android: createAndroidLane },
    })
    const lines: string[] = []
    await bridge.lanes.android?.probeForDoctor?.((line) => lines.push(line))
    return lines
  }

  it('one line for what the scan found, then each device, without the names owners gave them', async () => {
    const lines = await doctorLines(
      fakeMdnsNetwork([braviaTv({ fn: 'Jane Doe bedroom TV' }), pixel9({ pairing: true })]),
      await freePort(),
    )
    expect(lines.join('\n')).not.toContain('Jane Doe')
    expect(lines.slice(1)).toEqual([
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging)',
      `  ${BRAVIA.adb} · 192.168.68.101:5555 · Network debugging · not connected`,
      `  ${PIXEL9.instance} · 192.168.68.114:39601 · Wireless debugging · not connected`,
      `  ${PIXEL9.instance} · 192.168.68.114:37123 · pairing screen open · not connected`,
    ])
  })

  it('blocked: the reason and both fixes, and no summary when nothing was found', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    const lines = await doctorLines(network, await freePort())
    expect(lines.slice(1)).toEqual([
      "Wi-Fi: could not look for Android devices on the network: no route to host, so this computer can't reach the local network",
      expect.stringContaining('Cloudflare WARP') as unknown,
      expect.stringContaining('Terminal.app') as unknown,
    ])
  })
})
