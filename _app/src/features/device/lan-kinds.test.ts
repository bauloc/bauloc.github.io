import { describe, expect, it } from 'vitest'

import type { LanDevice, LanService } from './helper/protocol'
import { describeLan, readableHost, serviceWords, type LanView } from './lan-kinds'
import * as VENDORS from './lan-vendors.data'
import { vendorLookup } from './lan-vendors'

/*
  What each device on the owner's network is, and what it is called, rule by rule (design
  §4.2). The network is the one measured on 2026-10-04 (lan-research/00-real-network.md and the
  dns-sd captures), in the helper's words; names the captures don't need are made up.
*/

const lan = (address: string, patch: Partial<LanDevice> = {}): LanDevice => ({
  address,
  self: false,
  gateway: false,
  hostnames: [],
  names: [],
  services: [],
  found: ['reply'],
  ...patch,
})
const svc = (type: string, patch: Partial<LanService> = {}): LanService => ({ type, ...patch })

const vendor = vendorLookup(VENDORS)

/** The owner's network: each device, and what the list says about it. */
const OWNERS_NETWORK: [
  string,
  LanDevice,
  Pick<LanView, 'kind' | 'name' | 'detail'> & Partial<LanView>,
][] = [
  [
    'the TP-Link Deco router, the default gateway, answering SSDP as an IGD',
    lan('192.168.68.1', {
      gateway: true,
      upnp: {
        deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        manufacturer: 'TP-Link',
        server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
      },
      found: ['reply', 'ssdp', 'gateway'],
    }),
    { kind: 'router', name: 'TP-Link router', detail: '', labels: ['router'] },
  ],
  [
    'Sony BRAVIA: Android TV Remote, Cast and Network debugging',
    lan('192.168.68.101', {
      hostnames: ['Android.local'],
      services: [
        svc('_androidtvremote2._tcp', { port: 6466, name: 'SONY KD-43X8050H' }),
        svc('_googlecast._tcp', {
          port: 8009,
          txt: { fn: 'Living Room TV', md: 'BRAVIA 4K VH2' },
        }),
        svc('_adb._tcp', { port: 5555, name: 'adb-b120be004010859' }),
      ],
      found: ['reply', 'mdns'],
    }),
    { kind: 'tv', name: 'Living Room TV', detail: 'BRAVIA 4K VH2', os: 'android' },
  ],
  [
    'a camera known only by its maker’s prefix',
    lan('192.168.68.105', { maker: 'AC1C26' }),
    { kind: 'camera', name: 'EZVIZ camera', detail: '', labels: [] },
  ],
  [
    'a smart-home chip known only by its maker’s prefix',
    lan('192.168.68.106', { maker: '24A160' }),
    { kind: 'iot', name: 'Espressif device', detail: '' },
  ],
  [
    'an iPhone that only answers, named by the reverse lookup',
    lan('192.168.68.109', { hostnames: ['BAUs-iPhone.local'], found: ['reply', 'reverse'] }),
    { kind: 'phone', name: 'BAUs iPhone', detail: 'Apple', os: 'ios' },
  ],
  [
    'the owner’s iPhone 12 Pro: Wi‑Fi sync and remote pairing',
    lan('192.168.68.110', {
      hostnames: ['Baus-iPhone-12-Pro.local'],
      services: [
        svc('_apple-mobdev2._tcp', { port: 32498 }),
        svc('_remotepairing._tcp', { port: 64806 }),
      ],
      found: ['reply', 'mdns'],
    }),
    { kind: 'phone', name: 'Baus iPhone 12 Pro', detail: 'Apple', os: 'ios' },
  ],
  [
    'a phone that says nothing but has a private Wi‑Fi address',
    lan('192.168.68.112', { privateAddress: true, found: ['reply', 'neighbors'] }),
    {
      kind: 'unknown',
      name: 'Unknown device',
      detail: 'Private address (likely a phone, tablet or laptop)',
      labels: [],
    },
  ],
  [
    'this Mac, by AirPlay',
    lan('192.168.68.113', {
      self: true,
      hostnames: ['BAULOCs-MacBook-Pro.local'],
      services: [
        svc('_airplay._tcp', {
          port: 7000,
          name: 'BAULOC’s MacBook Pro',
          txt: { model: 'Mac16,1' },
        }),
        svc('_companion-link._tcp', { name: 'BAULOC’s MacBook Pro', txt: { rpMd: 'Mac16,1' } }),
      ],
      found: ['self', 'mdns'],
    }),
    {
      kind: 'computer',
      name: 'BAULOC’s MacBook Pro',
      detail: 'Apple',
      labels: ['self'],
      maker: 'Apple',
      model: 'Mac',
    },
  ],
  [
    'the Pixel 9, Wireless debugging on',
    lan('192.168.68.114', {
      hostnames: ['Android_GWZJSA15.local'],
      services: [
        svc('_adb-tls-connect._tcp', {
          port: 43141,
          name: 'adb-55090DLAQ0026D-nK25Qn',
          txt: { given_name: 'BAULOC Pixel 9', name: 'Pixel 9', api: '37.1' },
        }),
      ],
      found: ['reply', 'mdns'],
    }),
    { kind: 'phone', name: 'BAULOC Pixel 9', detail: 'Android', os: 'android', model: 'Pixel 9' },
  ],
  [
    'the HP printer, by IPP',
    lan('192.168.68.125', {
      hostnames: ['NPI9C4E21.local'],
      maker: '6C02E0',
      services: [
        svc('_ipp._tcp', {
          port: 631,
          name: 'HP Neverstop Laser MFP 1200w (9C4E21)',
          txt: {
            ty: 'HP Neverstop Laser MFP 120x',
            product: '(HP Neverstop Laser MFP 120x)',
            usb_MFG: 'HP',
            usb_MDL: 'HP Neverstop Laser MFP 120x',
          },
        }),
        svc('_uscan._tcp', { port: 8080 }),
        svc('_http._tcp', { port: 80 }),
      ],
      found: ['reply', 'mdns'],
    }),
    {
      kind: 'printer',
      name: 'HP Neverstop Laser MFP 1200w (9C4E21)',
      detail: 'HP Neverstop Laser MFP 120x',
      maker: 'HP',
    },
  ],
]

describe('describeLan, on the owner’s network', () => {
  it.each(OWNERS_NETWORK)('%s', (_, device, want) => {
    expect(describeLan(device, { vendor })).toMatchObject(want)
  })

  it('names a device by its maker only once the vendor table has loaded', () => {
    expect(describeLan(lan('192.168.68.105', { maker: 'AC1C26' }))).toMatchObject({
      kind: 'unknown',
      name: 'Unknown device',
      detail: '',
    })
    expect(describeLan(lan('192.168.68.105', { maker: 'FFFFFF' }), { vendor })).toMatchObject({
      kind: 'unknown',
      name: 'Unknown device',
    })
  })

  it('says only what the device says: no system for a router, no labels it doesn’t have', () => {
    const [, router] = OWNERS_NETWORK[0] ?? []
    if (!router) throw new Error('no router')
    const view = describeLan(router, { vendor })
    expect(view.os).toBeUndefined()
    expect(view.labels).toEqual(['router'])
    expect(
      describeLan(lan('192.168.68.110', { privateAddress: true, hostnames: ['iPad.local'] })),
    ).toMatchObject({ kind: 'tablet', labels: ['private'] })
  })
})

describe('describeLan, rule by rule', () => {
  it('2. an Apple model id: the kind, and the model’s name where the page knows it', () => {
    const apple = (txt: Record<string, string>, type = '_airplay._tcp') =>
      describeLan(lan('10.0.0.2', { services: [svc(type, { name: 'Living room', txt })] }))
    expect(apple({ rpMd: 'iPhone13,3' }, '_companion-link._tcp')).toMatchObject({
      kind: 'phone',
      os: 'ios',
      name: 'Living room',
      model: 'iPhone 12 Pro',
      detail: 'iPhone 12 Pro · Apple',
    })
    // _device-info carries no name: the model names it, and the line under it says the rest.
    expect(apple({ model: 'iPhone13,3' }, '_device-info._tcp')).toMatchObject({
      name: 'iPhone 12 Pro',
      detail: 'Apple',
    })
    expect(apple({ rpMd: 'iPad8,1' }, '_companion-link._tcp')).toMatchObject({
      kind: 'tablet',
      os: 'ios',
    })
    // "Apple TV" says the maker already.
    expect(apple({ model: 'AppleTV6,2' })).toMatchObject({ kind: 'tv', detail: 'Apple TV' })
    expect(apple({ am: 'AudioAccessory5,1' }, '_raop._tcp')).toMatchObject({
      kind: 'speaker',
      detail: 'HomePod · Apple',
    })
    expect(apple({ model: 'Watch6,1' }, '_device-info._tcp')).toMatchObject({ kind: 'watch' })
    expect(apple({ model: 'MacBookPro18,3' })).toMatchObject({
      kind: 'computer',
      detail: 'Mac · Apple',
    })
    // A newer iPhone than the table: its family.
    expect(apple({ model: 'iPhone99,1' })).toMatchObject({ kind: 'phone', model: 'iPhone' })
    // Samba's "MacSamba" is no Mac, and a Samsung TV's AirPlay model is no Apple id.
    expect(apple({ model: 'MacSamba' }, '_device-info._tcp')).toMatchObject({ kind: 'unknown' })
    expect(apple({ model: 'UN55RU8000' })).toMatchObject({
      kind: 'unknown',
      detail: 'UN55RU8000',
    })
  })

  it('3. what it announces', () => {
    const by = (...services: LanService[]) => describeLan(lan('10.0.0.2', { services })).kind
    expect(by(svc('_googlecast._tcp', { txt: { md: 'Google Nest Mini' } }))).toBe('speaker')
    expect(by(svc('_googlecast._tcp', { txt: { md: 'Chromecast' } }))).toBe('tv')
    expect(by(svc('_amzn-wplay._tcp', { txt: { n: 'Bedroom Fire TV' } }))).toBe('tv')
    expect(by(svc('_adb-tls-connect._tcp'), svc('_googlecast._tcp'))).toBe('tv')
    expect(by(svc('_privet._tcp'))).toBe('printer')
    expect(by(svc('_uscan._tcp'))).toBe('printer')
    expect(by(svc('_hap._tcp', { txt: { ci: '17' } }))).toBe('camera')
    expect(by(svc('_hap._tcp', { txt: { ci: '31' } }))).toBe('tv')
    expect(by(svc('_hap._tcp', { txt: { ci: '33' } }))).toBe('router')
    expect(by(svc('_hap._tcp', { txt: { ci: '5' } }))).toBe('iot')
    expect(by(svc('_hue._tcp'))).toBe('iot')
    expect(by(svc('_matterc._udp'))).toBe('iot')
    expect(by(svc('_spotify-connect._tcp'))).toBe('speaker')
    expect(by(svc('_spotify-connect._tcp'), svc('_ssh._tcp'))).toBe('computer')
    expect(by(svc('_adisk._tcp'))).toBe('storage')
    expect(by(svc('_adisk._tcp'), svc('_smb._tcp'))).toBe('computer')
    expect(by(svc('_http._tcp'))).toBe('unknown')
  })

  it('4. its UPnP device type, and 5. its host name', () => {
    const upnp = (deviceType: string, manufacturer = '') =>
      describeLan(lan('10.0.0.2', { upnp: { deviceType, manufacturer } })).kind
    expect(upnp('urn:schemas-upnp-org:device:MediaRenderer:1', 'Sonos, Inc.')).toBe('speaker')
    expect(upnp('urn:schemas-upnp-org:device:MediaRenderer:1', 'Samsung')).toBe('tv')
    expect(upnp('urn:schemas-upnp-org:device:MediaServer:1')).toBe('storage')
    expect(upnp('urn:schemas-upnp-org:device:Printer:1')).toBe('printer')
    expect(upnp('urn:dial-multiscreen-org:device:dial:1')).toBe('tv')
    const host = (name: string) => describeLan(lan('10.0.0.2', { hostnames: [name] }))
    expect(host('Bau-iPad.local')).toMatchObject({ kind: 'tablet', os: 'ios' })
    expect(host('Studio-MacBook-Air.local')).toMatchObject({ kind: 'computer', detail: 'Apple' })
    expect(host('Galaxy-S23.local')).toMatchObject({ kind: 'phone', os: 'android' })
    expect(host('npi9c4e21.local')).toMatchObject({ kind: 'unknown', name: 'npi9c4e21.local' })
  })

  it('names a device by the first of what it says, in order', () => {
    const named = (patch: Partial<LanDevice>) => describeLan(lan('10.0.0.2', patch)).name
    const all = {
      hostnames: ['Living-Room.local'],
      upnp: { friendlyName: 'UPnP name', modelName: 'Model X' },
      services: [
        svc('_adb-tls-connect._tcp', { txt: { given_name: 'Given' } }),
        svc('_googlecast._tcp', { txt: { fn: 'Cast name' } }),
        svc('_amzn-wplay._tcp', { txt: { n: 'Fire name' } }),
        svc('_raop._tcp', { name: 'Speaker name' }),
      ],
    }
    expect(named(all)).toBe('Given')
    expect(named({ ...all, services: all.services.slice(1) })).toBe('Cast name')
    expect(named({ ...all, services: all.services.slice(2) })).toBe('Fire name')
    expect(named({ ...all, services: all.services.slice(3) })).toBe('Speaker name')
    expect(named({ ...all, services: [] })).toBe('UPnP name')
    expect(named({ hostnames: all.hostnames, upnp: { modelName: 'Model X' } })).toBe('Living Room')
    expect(named({ upnp: { modelName: 'Model X' } })).toBe('Model X')
    expect(named({ upnp: { manufacturer: 'Sonos' } })).toBe('Sonos device')
    expect(named({})).toBe('Unknown device')
    expect(named({ self: true })).toBe('This computer')
    // AirPlay audio's instance is `<id>@<name>`; a helper that left the id in is read past it.
    expect(named({ services: [svc('_raop._tcp', { name: 'A1B2C3@Kitchen' })] })).toBe('Kitchen')
  })

  it('calls a router that names itself nowhere “Router”, without repeating it as a badge', () => {
    // As macOS 27 sees an office router: the default route, no SSDP name, no maker prefix.
    expect(describeLan(lan('10.0.0.1', { gateway: true }))).toMatchObject({
      kind: 'router',
      name: 'Router',
      labels: [],
    })
    // Named by its own UPnP answer, it keeps the badge that says what it is.
    expect(
      describeLan(lan('10.0.0.1', { gateway: true, upnp: { friendlyName: 'Deco X20' } })),
    ).toMatchObject({ name: 'Deco X20', labels: ['router'] })
  })

  it('never repeats the name in the line under it', () => {
    const view = describeLan(
      lan('10.0.0.2', {
        upnp: { friendlyName: 'Sonos Arc', modelName: 'Arc', manufacturer: 'Sonos' },
      }),
    )
    expect(view).toMatchObject({ name: 'Sonos Arc', detail: '' })
  })
})

describe('readableHost', () => {
  it('reads a host name the way a person wrote it, and leaves a machine’s alone', () => {
    expect(readableHost('Baus-iPhone-12-Pro.local')).toBe('Baus iPhone 12 Pro')
    expect(readableHost('BAULOCs-MacBook-Pro.local')).toBe('BAULOCs MacBook Pro')
    expect(readableHost('Studio.local')).toBe('Studio')
    expect(readableHost('Android_ZDKLKP74.local')).toBe('Android_ZDKLKP74.local')
    expect(readableHost('NPI9C4E21.local')).toBe('NPI9C4E21.local')
    expect(readableHost('android-6a3f9c1d2e4b5a69.local')).toBe('android-6a3f9c1d2e4b5a69.local')
    expect(readableHost('DESKTOP-ABC1234.local')).toBe('DESKTOP-ABC1234.local')
  })
})

describe('serviceWords', () => {
  it('says what a device announces in plain words, once each, an unknown one as its type', () => {
    expect(
      serviceWords(
        lan('10.0.0.2', {
          services: [
            svc('_airplay._tcp'),
            svc('_ipp._tcp'),
            svc('_http._tcp'),
            svc('_http-alt._tcp'),
            svc('_adb-tls-connect._tcp'),
            svc('_FC9F5ED42C8A._tcp'),
          ],
        }),
      ),
    ).toEqual(['AirPlay', 'Printer (IPP)', 'Web page', 'Wireless debugging', '_FC9F5ED42C8A._tcp'])
  })
})
