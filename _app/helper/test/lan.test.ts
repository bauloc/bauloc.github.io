/*
  Every device on this network (§4.9, lan.ts): one look at the owner's network as measured on
  2026-10-04, built from in-process fakes (fakes/lan.ts, fakes/mdns.ts) with made-up hardware
  addresses and ids; what is merged and how; what is never passed on (a hardware address or any
  part of one, ids, serials, UUIDs, TXT keys off the allowlist); when a look is an error, a note
  or neither; the cache, the gap and one look at a time; the terminal's lines; --doctor without
  a name; and GET /api/lan/devices through the real bridge. No packet leaves this computer.
*/
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBridge, resolveOptions } from '../src/bridge'
import { LIMITS } from '../src/constants'
import {
  carriesId,
  createLanScanner,
  lanLines,
  mergeLan,
  scanLan,
  scrub,
  type LanSourcesRead,
} from '../src/lan'
import { lanNetworks } from '../src/lan-net'
import { runTool, streamTool } from '../src/process'
import type { ServiceInstance } from '../src/mdns'
import type { BridgeInput, ErrorBody, Health, LanResult, ScanLan } from '../src/types'
import { fakeDnsSd, typesOutput } from './fakes/dns-sd'
import {
  DECO_DESCRIPTION,
  OWNER_INTERFACES,
  decoRouter,
  fakeDescriptions,
  fakePresence,
  fakeSsdpNetwork,
  type FakePresence,
  type FakeSsdpNetwork,
} from './fakes/lan'
import { fakeAndroidLane } from './fakes/lane'
import {
  errno,
  fakeMdnsNetwork,
  zoneResponder,
  type FakeMdnsNetwork,
  type FakeRecord,
} from './fakes/mdns'
import { isolation, listenerWarnings, request, startBridge, tempDir } from './harness'

/* ----------------------------------------------------------- the owner's network --- */

/** Made-up hardware addresses: real makers' prefixes, invented last three bytes. */
const MAC = {
  router: '14:eb:b6:aa:bb:01',
  esp: '24:a1:60:aa:bb:06',
  phone: '76:73:76:aa:bb:09',
  printer: '6c:02:e0:aa:bb:cc',
  iphone: '36:a1:b2:c3:d4:e5',
}
/** AirPlay's device id (not a hardware address, but written as one), and an adb serial. */
const AIRPLAY_ID = '5A:53:17:AA:BB:CD'
const SERIAL = '55090DLAQ0026D'
const PRINTER = 'HP Neverstop Laser MFP 1200w (AABBCC)'
const META = '_services._dns-sd._udp.local'
const meta = (...types: string[]): FakeRecord[] =>
  types.map((type) => ({ name: META, type: 'PTR', target: `${type}.local` }))

/** The HP printer: its instance and host carry the last three bytes of its `mac=`. */
const printer = zoneResponder(
  [
    ...meta('_ipp._tcp'),
    { name: '_ipp._tcp.local', type: 'PTR', target: `${PRINTER}._ipp._tcp.local` },
    { name: `${PRINTER}._ipp._tcp.local`, type: 'SRV', target: 'NPIAABBCC.local', port: 631 },
    {
      name: `${PRINTER}._ipp._tcp.local`,
      type: 'TXT',
      strings: [
        'txtvers=1',
        'ty=HP Neverstop Laser MFP 120x',
        'USB_MFG=HP',
        'usb_MDL=HP Neverstop Laser MFP 120x',
        `mac=${MAC.printer}`,
        'UUID=434e4252-5031-5943-444b-6c02e0aabbcc',
        'adminurl=http://NPIAABBCC.local./hp/device/info_config_AirPrint.html',
        'note=Office (AABBCC)',
      ],
    },
    { name: 'NPIAABBCC.local', type: 'A', address: '192.168.68.125' },
  ],
  { from: '192.168.68.125' },
)

/** The owner's iPhone 12 Pro: Wi-Fi sync and remote pairing, both on its own host name. */
const iphone = zoneResponder(
  [
    ...meta('_apple-mobdev2._tcp', '_remotepairing._tcp'),
    {
      name: '_apple-mobdev2._tcp.local',
      type: 'PTR',
      target: `${MAC.iphone}@fe80::34a1:b2ff:fec3:d4e5-supportsRP-26._apple-mobdev2._tcp.local`,
    },
    {
      name: `${MAC.iphone}@fe80::34a1:b2ff:fec3:d4e5-supportsRP-26._apple-mobdev2._tcp.local`,
      type: 'SRV',
      target: 'Baus-iPhone-12-Pro.local',
      port: 32498,
    },
    {
      name: `${MAC.iphone}@fe80::34a1:b2ff:fec3:d4e5-supportsRP-26._apple-mobdev2._tcp.local`,
      type: 'TXT',
      strings: ['identifier=00000000-0000-4000-8000-000000000002', 'authTag=AAAAAAAA'],
    },
    {
      name: '_remotepairing._tcp.local',
      type: 'PTR',
      target: '00000000-0000-4000-8000-000000000003._remotepairing._tcp.local',
    },
    {
      name: '00000000-0000-4000-8000-000000000003._remotepairing._tcp.local',
      type: 'SRV',
      target: 'Baus-iPhone-12-Pro.local',
      port: 64806,
    },
    { name: 'Baus-iPhone-12-Pro.local', type: 'A', address: '192.168.68.110' },
  ],
  { from: '192.168.68.110' },
)

/** This Mac: AirPlay (its `deviceid`) and AirPlay audio (`<id>@<name>`). */
const thisMac = zoneResponder(
  [
    ...meta('_airplay._tcp', '_raop._tcp'),
    {
      name: '_airplay._tcp.local',
      type: 'PTR',
      target: 'BAULOC’s MacBook Pro._airplay._tcp.local',
    },
    {
      name: 'BAULOC’s MacBook Pro._airplay._tcp.local',
      type: 'SRV',
      target: 'BAULOCs-MacBook-Pro.local',
      port: 7000,
    },
    {
      name: 'BAULOC’s MacBook Pro._airplay._tcp.local',
      type: 'TXT',
      strings: [
        `deviceid=${AIRPLAY_ID}`,
        'model=Mac16,1',
        'pk=00112233445566778899aabbccddeeff',
        'srcvers=980.77.5',
      ],
    },
    {
      name: '_raop._tcp.local',
      type: 'PTR',
      target: '5A5317AABBCD@BAULOC’s MacBook Pro._raop._tcp.local',
    },
    {
      name: '5A5317AABBCD@BAULOC’s MacBook Pro._raop._tcp.local',
      type: 'SRV',
      target: 'BAULOCs-MacBook-Pro.local',
      port: 7000,
    },
    {
      name: '5A5317AABBCD@BAULOC’s MacBook Pro._raop._tcp.local',
      type: 'TXT',
      strings: ['am=Mac16,1', 'vs=980.77.5'],
    },
    { name: 'BAULOCs-MacBook-Pro.local', type: 'A', address: '192.168.68.113' },
  ],
  { from: '192.168.68.113' },
)

/** The Pixel 9, Wireless debugging on: adbd names its service after its serial. */
const pixel = zoneResponder(
  [
    {
      name: '_adb-tls-connect._tcp.local',
      type: 'PTR',
      target: `adb-${SERIAL}-nK25Qn._adb-tls-connect._tcp.local`,
    },
    {
      name: `adb-${SERIAL}-nK25Qn._adb-tls-connect._tcp.local`,
      type: 'SRV',
      target: 'Android_GWZJSA15.local',
      port: 43141,
    },
    {
      name: `adb-${SERIAL}-nK25Qn._adb-tls-connect._tcp.local`,
      type: 'TXT',
      strings: [
        'given_name=BAULOC Pixel 9',
        `serial=${SERIAL}`,
        'v=2.1',
        'api=37.1',
        'name=Pixel 9',
      ],
    },
    { name: 'Android_GWZJSA15.local', type: 'A', address: '192.168.68.114' },
  ],
  { from: '192.168.68.114' },
)

/** What mDNSResponder and the phones answer for an address's reverse name. */
const reverse = zoneResponder([
  { name: '109.68.168.192.in-addr.arpa', type: 'PTR', target: 'BAUs-iPhone.local' },
  { name: '106.68.168.192.in-addr.arpa', type: 'PTR', target: 'ESP_AABB06.local' },
])

/** Who answered the presence check, and after how long [V 2026-10-04]. */
const PRESENT = {
  '192.168.68.1': 15,
  '192.168.68.106': 30,
  '192.168.68.109': 50,
  '192.168.68.110': 40,
  '192.168.68.112': 60,
  '192.168.68.114': 80,
  '192.168.68.125': 20,
}

/** Linux's tables as files: the neighbours (with Windows-like junk rows) and the routes. */
function linuxTables(dir: string): Pick<BridgeInput, 'procNetArpPath' | 'procNetRoutePath'> {
  const arp = path.join(dir, 'arp')
  const route = path.join(dir, 'route')
  writeFileSync(
    arp,
    [
      'IP address       HW type     Flags       HW address            Mask     Device',
      `192.168.68.1     0x1         0x2         ${MAC.router}     *        wlan0`,
      `192.168.68.106   0x1         0x2         ${MAC.esp}     *        wlan0`,
      `192.168.68.109   0x1         0x2         ${MAC.phone}     *        wlan0`,
      `192.168.68.125   0x1         0x2         ${MAC.printer}     *        wlan0`,
      '192.168.68.200   0x1         0x0         00:00:00:00:00:00     *        wlan0',
      '192.168.68.255   0x1         0x6         ff:ff:ff:ff:ff:ff     *        wlan0',
      '10.99.0.4        0x1         0x2         00:50:bf:aa:bb:04     *        tun0',
    ].join('\n') + '\n',
  )
  writeFileSync(
    route,
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
      'wlan0\t00000000\t0144A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n',
  )
  return { procNetArpPath: arp, procNetRoutePath: route }
}

interface World {
  input: BridgeInput
  presence: FakePresence
  mdns: FakeMdnsNetwork
  ssdp: FakeSsdpNetwork
  descriptions: ReturnType<typeof fakeDescriptions>
}

/** The owner's network, as a Linux computer at 192.168.68.113 would see it. */
async function ownerWorld(extra: BridgeInput = {}): Promise<World> {
  const presence = fakePresence(PRESENT)
  const mdns = fakeMdnsNetwork([printer, iphone, thisMac, pixel, reverse])
  const ssdp = fakeSsdpNetwork([decoRouter()])
  const descriptions = fakeDescriptions({
    'http://192.168.68.1:1900/cmlgh/rootDesc.xml': DECO_DESCRIPTION,
  })
  const iso = await isolation({
    platform: 'linux',
    lanInterfaces: () => OWNER_INTERFACES,
    lanPresence: presence.open,
    mdns: mdns.open,
    lanSsdp: ssdp.open,
    lanDescription: descriptions.fetch,
    ...linuxTables(tempDir('lan-tables-')),
    ...extra,
  })
  return { input: iso.input, presence, mdns, ssdp, descriptions }
}

/** One look with the bridge's own option defaults over `input`. */
function look(input: BridgeInput, signal = new AbortController().signal): Promise<LanResult> {
  const options = resolveOptions(input)
  return scanLan({
    options,
    timeouts: options.timeouts,
    runTool,
    streamTool,
    signal,
    now: Date.now,
  })
}

/** Every way a hardware address, or its last three bytes, could be written. */
function spellings(mac: string): string[] {
  const hex = mac.replace(/[:-]/g, '').toLowerCase()
  const tail = hex.slice(6)
  const forms = (h: string): string[] => {
    const pairs = h.match(/../g) ?? []
    return [h, pairs.join(':'), pairs.join('-')]
  }
  return [...forms(hex), ...forms(tail)].flatMap((s) => [s, s.toUpperCase()])
}

describe('one look at the owner’s network (§4.9)', () => {
  it('every device once, the router first, each with what found it and what it announces', async () => {
    const world = await ownerWorld()
    const result = await look(world.input)
    expect(result.error).toBeUndefined()
    expect(result.note).toBeUndefined()
    expect(result.networks).toEqual([
      { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
    ])
    expect(result.sources).toEqual({
      presence: 'ok',
      neighbors: 'ok',
      resolver: 'none',
      ssdp: 'ok',
    })
    expect(result.devices.map((d) => [d.address, d.found])).toEqual([
      ['192.168.68.1', ['reply', 'neighbors', 'ssdp', 'gateway']],
      ['192.168.68.106', ['reply', 'neighbors']],
      ['192.168.68.109', ['reply', 'neighbors', 'reverse']],
      ['192.168.68.110', ['reply', 'mdns']],
      ['192.168.68.112', ['reply']],
      ['192.168.68.113', ['mdns', 'self']],
      ['192.168.68.114', ['reply', 'mdns']],
      ['192.168.68.125', ['reply', 'neighbors', 'mdns']],
    ])
    const at = (address: string) => result.devices.find((d) => d.address === address)
    expect(at('192.168.68.1')).toEqual({
      address: '192.168.68.1',
      self: false,
      gateway: true,
      hostnames: [],
      names: [{ text: 'Deco X20 & mesh', source: 'ssdp' }],
      services: [],
      upnp: {
        deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        friendlyName: 'Deco X20 & mesh',
        manufacturer: 'TP-Link',
        modelName: 'Deco X20',
        modelNumber: '4.0',
        server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
      },
      maker: '14EBB6',
      privateAddress: false,
      found: ['reply', 'neighbors', 'ssdp', 'gateway'],
    })
    expect(at('192.168.68.125')).toEqual({
      address: '192.168.68.125',
      self: false,
      gateway: false,
      hostnames: [],
      names: [{ text: 'HP Neverstop Laser MFP 1200w', source: 'mdns' }],
      services: [
        {
          type: '_ipp._tcp',
          port: 631,
          name: 'HP Neverstop Laser MFP 1200w',
          txt: {
            ty: 'HP Neverstop Laser MFP 120x',
            usb_MFG: 'HP',
            usb_MDL: 'HP Neverstop Laser MFP 120x',
          },
        },
      ],
      maker: '6C02E0',
      privateAddress: false,
      found: ['reply', 'neighbors', 'mdns'],
    })
    expect(at('192.168.68.110')).toEqual({
      address: '192.168.68.110',
      self: false,
      gateway: false,
      hostnames: ['Baus-iPhone-12-Pro.local'],
      names: [],
      services: [
        { type: '_apple-mobdev2._tcp', port: 32498 },
        { type: '_remotepairing._tcp', port: 64806 },
      ],
      privateAddress: true,
      found: ['reply', 'mdns'],
    })
    expect(at('192.168.68.113')).toMatchObject({
      self: true,
      hostnames: ['BAULOCs-MacBook-Pro.local'],
      names: [{ text: 'BAULOC’s MacBook Pro', source: 'mdns' }],
      services: [
        {
          type: '_airplay._tcp',
          port: 7000,
          name: 'BAULOC’s MacBook Pro',
          txt: { model: 'Mac16,1' },
        },
        { type: '_raop._tcp', port: 7000, name: 'BAULOC’s MacBook Pro', txt: { am: 'Mac16,1' } },
      ],
    })
    expect(at('192.168.68.114')).toMatchObject({
      hostnames: ['Android_GWZJSA15.local'],
      services: [
        {
          type: '_adb-tls-connect._tcp',
          port: 43141,
          txt: { given_name: 'BAULOC Pixel 9', api: '37.1', name: 'Pixel 9' },
        },
      ],
    })
    expect(at('192.168.68.109')).toMatchObject({
      hostnames: ['BAUs-iPhone.local'],
      privateAddress: true,
    })
    expect(at('192.168.68.106')).toMatchObject({
      hostnames: [],
      maker: '24A160',
      privateAddress: false,
    })
    expect(result.scannedAt).toEqual(expect.any(Number))
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('never passes on a hardware address, any part of one, an id, a serial or a UUID', async () => {
    const world = await ownerWorld()
    const json = JSON.stringify(await look(world.input))
    for (const mac of [...Object.values(MAC), AIRPLAY_ID]) {
      for (const spelling of spellings(mac)) expect(json, spelling).not.toContain(spelling)
    }
    for (const id of [
      SERIAL,
      '00000000-0000-4000',
      'fe80',
      'authTag',
      'identifier',
      'deviceid',
      'adminurl',
      'UUID',
      'NPIAABBCC',
      'ESP_AABB06',
      '5A5317',
    ]) {
      expect(json, id).not.toContain(id)
    }
    /** Only the first three bytes of a maker's address: what the page names the maker by. */
    expect(json).toContain('"maker":"6C02E0"')
  })

  it('opens and closes every socket; one datagram an address; the description fetched from the router only', async () => {
    const world = await ownerWorld()
    await look(world.input)
    expect(world.presence.checked).toHaveLength(253)
    expect([...world.presence.datagrams.values()].every((n) => n === 1)).toBe(true)
    expect(world.presence.open_()).toBe(0)
    expect([world.mdns.opened(), world.mdns.closed()]).toEqual([3, 3])
    expect([world.ssdp.opened(), world.ssdp.closed()]).toEqual([1, 1])
    expect(world.descriptions.fetched).toEqual([
      { host: '192.168.68.1', port: 1900, path: '/cmlgh/rootDesc.xml' },
    ])
  })

  it('a description that points elsewhere is never fetched', async () => {
    const world = await ownerWorld()
    world.ssdp.responders = [
      decoRouter({ location: 'http://192.168.68.125:80/steal' }),
      decoRouter({ from: '192.168.68.66', location: 'http://127.0.0.1:8787/api/devices' }),
    ]
    const result = await look(world.input)
    expect(world.descriptions.fetched).toEqual([])
    expect(result.devices.find((d) => d.address === '192.168.68.66')?.upnp).toEqual({
      deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
    })
  })

  it('on Windows: no presence check (Windows hides port unreachable from Node), the rest as usual', async () => {
    const world = await ownerWorld({ platform: 'win32' })
    const result = await look(world.input)
    expect(world.presence.checked).toEqual([])
    expect(result.sources.presence).toBe('off')
    expect(result.devices.map((d) => d.address)).toEqual(
      expect.arrayContaining([
        '192.168.68.1',
        '192.168.68.110',
        '192.168.68.113',
        '192.168.68.125',
      ]),
    )
  })
})

/* ------------------------------------------------------------------- the merge --- */

const PLAN = lanNetworks(OWNER_INTERFACES)
const NOTHING: Omit<LanSourcesRead, 'plan'> = {
  presence: null,
  neighbours: { entries: [], state: 'none' },
  gateway: null,
  system: { tool: null, looked: false, instances: [] },
  own: { instances: [] },
  ssdp: { devices: new Map() },
  descriptions: new Map(),
  reverse: new Map(),
}
const instance = (
  o: Partial<ServiceInstance> & Pick<ServiceInstance, 'service' | 'instance'>,
): ServiceInstance => ({
  target: null,
  port: 9,
  addresses: [],
  txt: [],
  ...o,
})

describe('the merge (§4.9)', () => {
  it('a host name two devices share ties nothing, unless the helper heard each device answer', () => {
    const tv = (address: string, from?: string) =>
      instance({
        service: '_adb._tcp.local',
        instance: `adb-${address}`,
        target: 'Android.local',
        addresses: [address],
        ...(from ? { from } : {}),
      })
    const system = mergeLan({
      plan: PLAN,
      ...NOTHING,
      system: {
        tool: 'dns-sd',
        looked: true,
        instances: [tv('192.168.68.101'), tv('192.168.68.102')],
      },
    })
    expect(system.devices.map((d) => d.address)).toEqual(['192.168.68.113'])
    const own = mergeLan({
      plan: PLAN,
      ...NOTHING,
      own: {
        instances: [tv('192.168.68.101', '192.168.68.101'), tv('192.168.68.102', '192.168.68.102')],
      },
    })
    expect(own.devices.map((d) => d.address)).toEqual([
      '192.168.68.101',
      '192.168.68.102',
      '192.168.68.113',
    ])
  })

  it('a host name with two addresses on the network ties nothing: no guessing', () => {
    const both = instance({
      service: '_ssh._tcp.local',
      instance: 'nas',
      target: 'nas.local',
      addresses: ['192.168.68.30', '192.168.68.31'],
    })
    const result = mergeLan({
      plan: PLAN,
      ...NOTHING,
      system: { tool: 'dns-sd', looked: true, instances: [both] },
    })
    expect(result.devices.map((d) => d.address)).toEqual(['192.168.68.113'])
  })

  it('names: AirPlay audio’s after its id, avahi’s workstation without its address, never a UUID or a serial', () => {
    const result = mergeLan({
      plan: PLAN,
      ...NOTHING,
      own: {
        instances: [
          instance({
            service: '_workstation._tcp.local',
            instance: 'pi [b8:27:eb:aa:bb:50]',
            target: 'pi.local',
            addresses: ['192.168.68.50'],
            from: '192.168.68.50',
          }),
          instance({
            service: '_raop._tcp.local',
            instance: '0011AABBCC50@Kitchen',
            target: 'pi.local',
            addresses: ['192.168.68.50'],
            from: '192.168.68.50',
          }),
          instance({
            service: '_googlecast._tcp.local',
            instance: 'Chromecast-208b30c617f370775350bf056804e1d5',
            target: '208b30c6-17f3-7077-5350-bf056804e1d5.local',
            addresses: ['192.168.68.50'],
            from: '192.168.68.50',
            txt: [
              'id=208b30c617f370775350bf056804e1d5',
              'fn=Kitchen speaker',
              'md=Google Home Mini',
              'bs=FA8F28BDCF73',
            ],
          }),
        ],
      },
    })
    const pi = result.devices.find((d) => d.address === '192.168.68.50')
    expect(pi).toEqual({
      address: '192.168.68.50',
      self: false,
      gateway: false,
      hostnames: ['pi.local'],
      names: [
        { text: 'pi', source: 'mdns' },
        { text: 'Kitchen', source: 'mdns' },
      ],
      services: [
        { type: '_workstation._tcp', port: 9, name: 'pi' },
        { type: '_raop._tcp', port: 9, name: 'Kitchen' },
        {
          type: '_googlecast._tcp',
          port: 9,
          name: 'Chromecast',
          txt: { fn: 'Kitchen speaker', md: 'Google Home Mini' },
        },
      ],
      maker: 'B827EB',
      privateAddress: false,
      found: ['mdns'],
    })
    const json = JSON.stringify(result)
    for (const spelling of [...spellings('b8:27:eb:aa:bb:50'), ...spellings('00:11:aa:bb:cc:50')]) {
      expect(json, spelling).not.toContain(spelling)
    }
    expect(json).not.toContain('208b30c6')
  })

  it('a host name that carries a hardware address is dropped (Brother’s BRW + 12 hex digits)', () => {
    const result = mergeLan({
      plan: PLAN,
      ...NOTHING,
      own: {
        instances: [
          instance({
            service: '_ipp._tcp.local',
            instance: 'Brother HL-L2350DW series',
            target: 'BRW0080927ABCDE.local',
            addresses: ['192.168.68.60'],
            from: '192.168.68.60',
          }),
        ],
      },
    })
    expect(result.devices.find((d) => d.address === '192.168.68.60')?.hostnames).toEqual([])
    expect(JSON.stringify(result)).not.toContain('0080927ABCDE')
  })

  it('TXT: allowlisted keys only, in the allowlist’s spelling, 8 a service, 100 characters a value', () => {
    const txt = [
      'MODEL=X1',
      'pk=0011',
      'id=abc',
      'deviceid=11:22:33:44:55:66',
      'md=M',
      'fn=F',
      'ty=T',
      'product=P',
      'mfg=G',
      'mdl=D',
      'am=A',
      'ci=17',
      `n=${'x'.repeat(300)}`,
      'novalue',
      'given_name=',
    ]
    const result = mergeLan({
      plan: PLAN,
      ...NOTHING,
      own: {
        instances: [
          instance({
            service: '_hap._tcp.local',
            instance: 'Lamp',
            addresses: ['192.168.68.70'],
            from: '192.168.68.70',
            txt,
          }),
        ],
      },
    })
    const service = result.devices.find((d) => d.address === '192.168.68.70')?.services[0]
    expect(service?.txt).toEqual({
      model: 'X1',
      md: 'M',
      fn: 'F',
      ty: 'T',
      product: 'P',
      mfg: 'G',
      mdl: 'D',
      am: 'A',
    })
  })

  it('caps: 256 devices (truncated), 4 host names, 8 names, 24 services', () => {
    const present = new Set<string>()
    for (let i = 1; i <= 300; i++)
      present.add(`192.168.${String(68 + Math.floor(i / 250))}.${String(i % 250)}`)
    const many = mergeLan({ plan: PLAN, ...NOTHING, presence: { present, sent: 300 } })
    expect(many.devices).toHaveLength(LIMITS.lanDevices)
    expect(many.truncated).toBe(true)
    const busy = Array.from({ length: 30 }, (_, i) =>
      instance({
        service: `_t${String(i)}._tcp.local`,
        instance: `Name ${String(i)}`,
        target: `host${String(i)}.local`,
        addresses: ['192.168.68.80'],
        from: '192.168.68.80',
      }),
    )
    const one = mergeLan({ plan: PLAN, ...NOTHING, own: { instances: busy } }).devices.find(
      (d) => d.address === '192.168.68.80',
    )
    expect(one?.hostnames).toHaveLength(4)
    expect(one?.services).toHaveLength(24)
    const named = busy.map((i) => ({ ...i, service: '_smb._tcp.local' }))
    const two = mergeLan({ plan: PLAN, ...NOTHING, own: { instances: named } }).devices.find(
      (d) => d.address === '192.168.68.80',
    )
    expect(two?.names).toHaveLength(8)
  })

  it('a neighbour entry off the networks looked at, or for this computer, makes no device', () => {
    const result = mergeLan({
      plan: PLAN,
      ...NOTHING,
      neighbours: {
        state: 'ok',
        entries: [
          { address: '10.99.0.4', mac: '00:50:bf:aa:bb:04' },
          { address: '192.168.68.113', mac: '52:1f:60:aa:bb:13' },
          { address: '192.168.68.255', mac: '14:eb:b6:aa:bb:ff' },
          { address: '192.168.68.0', mac: '14:eb:b6:aa:bb:00' },
        ],
      },
    })
    expect(result.devices.map((d) => [d.address, d.found])).toEqual([['192.168.68.113', ['self']]])
    expect(result.devices[0]?.privateAddress).toBeUndefined()
  })
})

describe('scrubbing what a device chose to call itself', () => {
  it('takes out a hardware address, its last three bytes, a UUID and a long run of hex digits', () => {
    const hidden = new Set(['6c02e0aabbcc'])
    expect(scrub('HP Neverstop Laser MFP 1200w (AABBCC)', hidden)).toBe(
      'HP Neverstop Laser MFP 1200w',
    )
    expect(scrub('Printer [aa:bb:cc]', hidden)).toBe('Printer')
    expect(scrub('Box 6C-02-E0-AA-BB-CC', hidden)).toBe('Box')
    expect(scrub('Hue Bridge (001788AABBCC)')).toBe('Hue Bridge')
    expect(scrub('BF8E7736-7B4B-4416-9ACC-69900BA18328')).toBe('')
    expect(scrub('TV 11:22:33:44:55:66 living room')).toBe('TV living room')
    expect(scrub('Living Room TV')).toBe('Living Room TV')
    expect(carriesId('NPIAABBCC.local', hidden)).toBe(true)
    expect(carriesId('Baus-iPhone-12-Pro.local', hidden)).toBe(false)
  })
})

/* ---------------------------------------------------------- error, note, neither --- */

describe('when a look could not look (§4.9)', () => {
  it('no network interface: no-network, nothing sent', async () => {
    const world = await ownerWorld({ lanInterfaces: () => [] })
    const result = await look(world.input)
    expect(result.error).toEqual({
      reason: 'no-network',
      message: expect.stringContaining('not on a network') as unknown,
      detail: 'no network interface has a private IPv4 address',
    })
    expect([world.presence.checked.length, world.mdns.opened(), world.ssdp.opened()]).toEqual([
      0, 0, 0,
    ])
    expect(lanLines(result, 'darwin')).toEqual([
      'Network: could not look for devices: this computer is not on a network',
    ])
  })

  it('blocked, with no resolver: the error, its fixes, and what was known anyway', async () => {
    const world = await ownerWorld()
    world.presence.sendError = errno('EHOSTUNREACH', 'send EHOSTUNREACH 192.168.68.1:9')
    world.mdns.sendError = errno('EHOSTUNREACH')
    world.ssdp.sendError = errno('EHOSTUNREACH', 'send EHOSTUNREACH 239.255.255.250:1900')
    const result = await look(world.input)
    expect(result.error).toEqual({
      reason: 'blocked',
      message: expect.stringMatching(
        /^Could not look for devices on this network\. Something on this computer is blocking/,
      ) as unknown,
      detail: 'send EHOSTUNREACH 192.168.68.1:9',
    })
    expect(result.note).toBeUndefined()
    expect(result.sources).toMatchObject({ presence: 'blocked', ssdp: 'blocked', resolver: 'none' })
    /** The tables still say what is there: this computer, the router, the neighbours. */
    expect(result.devices[0]).toMatchObject({ address: '192.168.68.1', gateway: true })
    const lines = lanLines(result, 'darwin')
    expect(lines[0]).toBe(
      "Network: could not look for devices: no route to host, so this computer can't reach the local network",
    )
    expect(lines[1]).toContain('Cloudflare WARP')
    expect(lines[2]).toContain('Terminal.app')
    expect(lines.at(-1)).toMatch(/^Network: 5 devices on 192\.168\.68\.0\/24 \(en0\)$/)
  })

  it('blocked, but dns-sd looked: a note, and what it listed', async () => {
    const world = await ownerWorld({ platform: 'darwin' })
    const iso = await isolation()
    const dnsSd = fakeDnsSd(iso.bin, {
      browse: { '_services._dns-sd._udp': typesOutput([]) },
    })
    world.presence.sendError = errno('EHOSTUNREACH', 'send EHOSTUNREACH 192.168.68.1:9')
    world.mdns.sendError = errno('EHOSTUNREACH')
    world.ssdp.sendError = errno('EHOSTUNREACH', 'send EHOSTUNREACH 239.255.255.250:1900')
    const result = await look({
      ...world.input,
      dnsSdPath: dnsSd,
      timeouts: { ...world.input.timeouts, systemBrowse: 300, systemResolve: 300 },
    })
    expect(result.error).toBeUndefined()
    expect(result.note).toEqual({
      reason: 'blocked',
      message: expect.stringContaining("Listed through this computer's own resolver") as unknown,
      detail: 'send EHOSTUNREACH 192.168.68.1:9',
    })
    expect(result.sources.resolver).toBe('dns-sd')
    expect(lanLines(result, 'darwin')[0]).toBe(
      "Network: listed through dns-sd only; the helper's own packets could not leave (send EHOSTUNREACH 192.168.68.1:9)",
    )
  })

  it('one source refused, the others not: neither an error nor a note', async () => {
    const world = await ownerWorld()
    world.ssdp.sendError = errno('EHOSTUNREACH', 'send EHOSTUNREACH 239.255.255.250:1900')
    const result = await look(world.input)
    expect([result.error, result.note]).toEqual([undefined, undefined])
    expect(result.sources).toMatchObject({ presence: 'ok', ssdp: 'blocked' })
  })

  it('no abort-listener warning on Node 18 and 20, with 256 presence sockets on one signal', async () => {
    const world = await ownerWorld()
    const warnings = await listenerWarnings(() => look(world.input))
    expect(warnings).toEqual([])
    expect(world.presence.most()).toBeGreaterThan(10)
  })

  it('cut at lanScan whatever a source does; every socket closed', async () => {
    const world = await ownerWorld({
      timeouts: { lanScan: 300, lanPresence: 5_000, lanSsdp: 5_000 },
    })
    const started = Date.now()
    const result = await look(world.input)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(world.presence.open_()).toBe(0)
    expect(world.ssdp.closed()).toBe(world.ssdp.opened())
    expect(result.devices.some((d) => d.self)).toBe(true)
  })
})

/* ------------------------------------------------------- the scanner and the route --- */

/** A look that counts itself and returns `devices` at once. */
function countingLook(devices = 1): ScanLan & { count: () => number } {
  let count = 0
  const fn: ScanLan = (ctx) => {
    count++
    return Promise.resolve({
      devices: Array.from({ length: devices }, (_, i) => ({
        address: `192.168.68.${String(i + 1)}`,
        self: false,
        gateway: false,
        hostnames: [],
        names: [],
        services: [],
        found: ['reply' as const],
      })),
      networks: [
        { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
      ],
      sources: { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' },
      scannedAt: ctx.now(),
      durationMs: 1,
    })
  }
  return Object.assign(fn, { count: () => count })
}

describe('GET /api/lan/devices', () => {
  const get = async (port: number, auth: Record<string, string>, refresh = false) => {
    const reply = await request(port, {
      path: `/api/lan/devices${refresh ? '?refresh=1' : ''}`,
      headers: auth,
    })
    return { status: reply.status, body: reply.json<LanResult>() }
  }

  it('answers the look; caches it; ?refresh=1 rescans, never two at once, never within the gap', async () => {
    const lanScan = countingLook()
    const s = await startBridge({ lanScan, timeouts: { lanCache: 1_500, lanGap: 600 } })
    const first = await get(s.port, s.auth)
    expect(first.status).toBe(200)
    expect(first.body.devices).toHaveLength(1)
    expect(lanScan.count()).toBe(1)
    await get(s.port, s.auth)
    await get(s.port, s.auth, true)
    expect(lanScan.count()).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 650))
    const [a, b, c] = await Promise.all([
      get(s.port, s.auth, true),
      get(s.port, s.auth, true),
      get(s.port, s.auth),
    ])
    expect(lanScan.count()).toBe(2)
    expect(a.body.scannedAt).toBe(b.body.scannedAt)
    expect(c.body.scannedAt).toBe(a.body.scannedAt)
    await new Promise((resolve) => setTimeout(resolve, 1_550))
    await get(s.port, s.auth)
    expect(lanScan.count()).toBe(3)
  })

  it('prints its line once, and again only when it changes', async () => {
    let devices = 2
    const lanScan: ScanLan = (ctx) => countingLook(devices)(ctx)
    const s = await startBridge({ lanScan, timeouts: { lanCache: 0, lanGap: 0 } })
    await get(s.port, s.auth)
    await get(s.port, s.auth)
    devices = 3
    await get(s.port, s.auth)
    const lines = s.logs
      .map((l) => l.replace(/^\S+ {2}/, ''))
      .filter((l) => l.startsWith('Network'))
    expect(lines).toEqual([
      'Network: 2 devices on 192.168.68.0/24 (en0)',
      'Network: 3 devices on 192.168.68.0/24 (en0)',
    ])
  })

  it('needs the bearer token and the allowed Origin, GET only', async () => {
    const lanScan = countingLook()
    const s = await startBridge({ lanScan })
    const anonymous = await request(s.port, { path: '/api/lan/devices' })
    expect([anonymous.status, anonymous.json<ErrorBody>().error.code]).toEqual([
      401,
      'UNAUTHORIZED',
    ])
    const elsewhere = await request(s.port, {
      path: '/api/lan/devices',
      headers: { ...s.auth, Origin: 'https://evil.example' },
    })
    expect(elsewhere.status).toBe(403)
    const posted = await request(s.port, {
      method: 'POST',
      path: '/api/lan/devices',
      headers: s.auth,
    })
    expect([posted.status, posted.headers.allow]).toEqual([405, 'GET'])
    expect(lanScan.count()).toBe(0)
  })

  it('works with --no-android, is always in the features, and never reaches the adb server', async () => {
    const lane = fakeAndroidLane()
    const on = await startBridge({ lanScan: countingLook(), lanes: { android: lane.factory } })
    expect((await get(on.port, on.auth)).status).toBe(200)
    expect(lane.calls.map((c) => c.op)).toEqual(['start'])
    const off = await startBridge({ android: false, lanScan: countingLook() })
    expect((await get(off.port, off.auth)).status).toBe(200)
    const health = (await request(off.port, { path: '/api/health' })).json<Health>()
    expect(health.features).toContain('lan.discover')
    expect(health.features).not.toContain('android.discover')
  })

  it('a client that leaves stops waiting; the look goes on for the next one', async () => {
    let release: () => void = () => undefined
    let count = 0
    const lanScan: ScanLan = (ctx) => {
      count++
      return new Promise((resolve) => {
        release = () => void countingLook()(ctx).then(resolve)
      })
    }
    const s = await startBridge({ lanScan })
    const controller = new AbortController()
    const leaving = fetch(`http://127.0.0.1:${String(s.port)}/api/lan/devices`, {
      headers: s.auth,
      signal: controller.signal,
    }).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await leaving
    const waiting = get(s.port, s.auth)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    expect((await waiting).status).toBe(200)
    expect(count).toBe(1)
  })
})

describe('shutdown during a look', () => {
  it('ends the look at once, closes every socket, and keeps nothing', async () => {
    const world = await ownerWorld({
      timeouts: { lanPresence: 10_000, lanSsdp: 10_000, lanScan: 20_000 },
    })
    const bridge = createBridge(world.input)
    const { port } = await bridge.listen()
    const auth = { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' }
    const pending = request(port, { path: '/api/lan/devices', headers: auth }).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const started = Date.now()
    await bridge.close()
    await pending
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(world.presence.open_()).toBe(0)
    expect(world.ssdp.closed()).toBe(world.ssdp.opened())
    expect(world.mdns.closed()).toBe(world.mdns.opened())
  })
})

describe('--doctor (§1.9, T18)', () => {
  it('a Network section: what could look, then each device by address, sources and service types, never a name', async () => {
    const world = await ownerWorld()
    const bridge = createBridge(world.input)
    const lines: string[] = []
    await bridge.doctor((line) => lines.push(line))
    const network = lines.slice(lines.indexOf('Network'))
    expect(network).toEqual([
      'Network',
      '  Network: 8 devices on 192.168.68.0/24 (en0)',
      '  presence ok · neighbour table ok · no resolver · SSDP ok',
      '  192.168.68.1 · found by reply, neighbour table, SSDP, gateway',
      '  192.168.68.106 · found by reply, neighbour table',
      '  192.168.68.109 · found by reply, neighbour table, reverse name',
      '  192.168.68.110 · found by reply, mDNS · _apple-mobdev2._tcp, _remotepairing._tcp',
      '  192.168.68.112 · found by reply',
      '  192.168.68.113 · found by mDNS, this computer · _airplay._tcp, _raop._tcp',
      '  192.168.68.114 · found by reply, mDNS · _adb-tls-connect._tcp',
      '  192.168.68.125 · found by reply, neighbour table, mDNS · _ipp._tcp',
    ])
    const section = network.join('\n')
    for (const name of [
      'BAULOC',
      'MacBook',
      'Pixel',
      'Neverstop',
      'Deco',
      'iPhone',
      'Android_',
      'TP-Link',
      '.local',
    ]) {
      expect(section, name).not.toContain(name)
    }
    const text = lines.join('\n')
    for (const mac of Object.values(MAC)) {
      for (const spelling of spellings(mac)) expect(text, spelling).not.toContain(spelling)
    }
  })

  it('the scanner’s own probe: one look, the same lines', async () => {
    const lanScan = countingLook(1)
    const options = resolveOptions((await isolation({ lanScan })).input)
    const scanner = createLanScanner({
      options,
      timeouts: options.timeouts,
      runTool,
      streamTool,
      signal: new AbortController().signal,
      now: Date.now,
      log: () => undefined,
    })
    const lines: string[] = []
    await scanner.probeForDoctor((line) => lines.push(line))
    expect(lines).toEqual(
      [
        'Network: 1 device on 192.168.68.0/24 (en0)',
        'presence ok · neighbour table hidden by macOS · resolver dns-sd · SSDP ok',
        '192.168.68.1 · found by reply',
      ].map((line, i) =>
        i === 1 && options.platform !== 'darwin' ? line.replace('hidden by macOS', 'empty') : line,
      ),
    )
    expect(lanScan.count()).toBe(1)
  })
})

describe('the scanner after stop()', () => {
  it('answers nothing and keeps nothing', async () => {
    const options = resolveOptions((await isolation({ lanScan: countingLook() })).input)
    const scanner = createLanScanner({
      options,
      timeouts: options.timeouts,
      runTool,
      streamTool,
      signal: new AbortController().signal,
      now: Date.now,
      log: () => undefined,
    })
    scanner.stop()
    await expect(scanner.devices(false, new AbortController().signal)).rejects.toThrow('aborted')
  })
})
