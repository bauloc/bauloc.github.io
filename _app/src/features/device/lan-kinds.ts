import { iosModelName } from './backends/ios'
import type { LanDevice } from './helper/protocol'
import { LAN_COPY } from './lan-copy'

/*
  What a device on this network is, and what to call it (the design's §4.2): pure functions
  over the facts the helper sent, so every rule is tested against the owner's own network. The
  helper never guesses (only `self` and `gateway` are its own); here each rule names its
  evidence, and the first that matches wins:

  1. the default gateway is the router, this computer a computer;
  2. an Apple model id (AirPlay `model`, AirPlay audio `am`, Continuity `rpMd`, `_device-info`);
  3. the services it announces;
  4. its UPnP device type;
  5. its host names;
  6. its maker's usual products, phones included (the vendor table, lan-vendors.ts);
  7. a private hardware address and nothing else: likely a phone, tablet or laptop.

  The name is the first that exists of: Android's given name, Cast's, Fire TV's, the instance
  name of a service that carries the device's own name, its UPnP friendly name, its host name
  made readable, its model, its maker and kind. The detail line says the model (or family) and
  the maker, never what the name already says.
*/

export type LanKind =
  | 'phone'
  | 'tablet'
  | 'tv'
  | 'computer'
  | 'printer'
  | 'speaker'
  | 'router'
  | 'camera'
  | 'console'
  | 'watch'
  | 'storage'
  | 'iot'
  | 'unknown'

export const LAN_KINDS: readonly LanKind[] = [
  'phone',
  'tablet',
  'tv',
  'computer',
  'printer',
  'speaker',
  'router',
  'camera',
  'console',
  'watch',
  'storage',
  'iot',
  'unknown',
]

/** The filter's groups: Phones & tablets · TVs · Computers · Other. */
export type LanGroup = 'phones' | 'tvs' | 'computers' | 'other'

export const LAN_GROUP: Readonly<Record<LanKind, LanGroup>> = {
  phone: 'phones',
  tablet: 'phones',
  watch: 'phones',
  tv: 'tvs',
  computer: 'computers',
  storage: 'computers',
  printer: 'other',
  speaker: 'other',
  router: 'other',
  camera: 'other',
  console: 'other',
  iot: 'other',
  unknown: 'other',
}

/** The badges: This computer, Router (the default gateway), Private address. */
export type LanLabel = 'self' | 'router' | 'private'

/** A maker's display name, and what it mostly makes (lan-vendors.ts). */
export interface VendorInfo {
  readonly name: string
  readonly hint?: LanKind
}

/** A maker by its 3-byte prefix ('A1B2C3'), or null when the table doesn't know it. */
export type VendorLookup = (prefix: string) => VendorInfo | null

export interface LanView {
  readonly kind: LanKind
  readonly name: string
  /** Model or family, then maker, whichever the name doesn't say already; may be ''. */
  readonly detail: string
  /** The device's system, when it says: what Device Lab can offer it. */
  readonly os?: 'ios' | 'android'
  readonly labels: readonly LanLabel[]
  /** Its maker, as the device or the vendor table says. */
  readonly maker?: string
  /** Its model, as the device says. */
  readonly model?: string
}

export interface LanContext {
  /** The vendor table once it has loaded; makers otherwise come only from the devices. */
  readonly vendor?: VendorLookup | null
}

/* ---------------------------------------------------------------- *
 * Tables
 * ---------------------------------------------------------------- */

/** Apple model ids, by prefix: the kind, and the family that names an unknown model. */
const APPLE_MODELS: readonly {
  test: RegExp
  kind: LanKind
  family: keyof typeof LAN_COPY.family
  os?: 'ios'
}[] = [
  { test: /^iPhone/, kind: 'phone', family: 'iphone', os: 'ios' },
  { test: /^iPad/, kind: 'tablet', family: 'ipad', os: 'ios' },
  { test: /^AppleTV/, kind: 'tv', family: 'appleTv' },
  { test: /^AudioAccessory/, kind: 'speaker', family: 'homePod' },
  { test: /^Watch/, kind: 'watch', family: 'watch' },
  { test: /^(?:Mac|MacBook|iMac|Macmini|MacPro)/, kind: 'computer', family: 'mac' },
]

/** An Apple model id: letters, then two numbers ('Mac16,1'); 'MacSamba' and the like aren't. */
const APPLE_ID = /^[A-Za-z]+\d+,\d+$/

/** Where an Apple device says its model id: service, then TXT key. */
const APPLE_MODEL_KEYS: readonly (readonly [string, string])[] = [
  ['_airplay', 'model'],
  ['_raop', 'am'],
  ['_companion-link', 'rpMd'],
  ['_device-info', 'model'],
]

/** Android's debugging: Network debugging, and Wireless debugging's connect and pairing. */
const ADB = ['_adb', '_adb-tls-connect', '_adb-tls-pairing']
const PRINTERS = ['_ipp', '_ipps', '_printer', '_pdl-datastream', '_privet']
const SCANNERS = ['_uscan', '_uscans', '_scanner']
const IOT = ['_hue', '_meshcop', '_esphomelib', '_shelly', '_miio', '_elg']
const SPEAKERS = ['_sonos', '_spotify-connect']
const COMPUTERS = [
  '_smb',
  '_afpovertcp',
  '_adisk',
  '_ssh',
  '_sftp-ssh',
  '_workstation',
  '_rdlink',
  '_nvstream',
]

/** A Cast device that is a speaker, by its model (`md`). */
const CAST_SPEAKER = /Speaker|Nest Mini|Nest Audio|Home Mini|Google Home/i

/** HomeKit's accessory category (`_hap` TXT `ci`) → kind; any other is a smart-home device. */
const HAP_KINDS: Readonly<Record<string, LanKind>> = {
  '17': 'camera',
  '18': 'camera',
  '26': 'speaker',
  '25': 'speaker',
  '31': 'tv',
  '24': 'tv',
  '35': 'tv',
  '36': 'tv',
  '33': 'router',
}

/** Makers of speakers, for a UPnP MediaRenderer that isn't a TV. */
const SPEAKER_MAKERS = /sonos|bose|denon|marantz|yamaha|harman|jbl|bang|libratone|bluesound/i

/** Host names, in order: the kind, the system and the family they give away. */
const HOST_RULES: readonly {
  test: RegExp
  kind: LanKind
  os?: 'ios' | 'android'
  family?: keyof typeof LAN_COPY.family
  apple?: true
}[] = [
  { test: /iphone/i, kind: 'phone', os: 'ios', family: 'iphone', apple: true },
  { test: /ipad/i, kind: 'tablet', os: 'ios', family: 'ipad', apple: true },
  { test: /macbook|imac|mac-?mini|mac-?pro|-mbp/i, kind: 'computer', family: 'mac', apple: true },
  { test: /^android[-_]/i, kind: 'phone', os: 'android', family: 'android' },
  {
    test: /^(?:galaxy|pixel|redmi|oneplus|xiaomi)/i,
    kind: 'phone',
    os: 'android',
    family: 'android',
  },
]

/** Services whose instance name is the device's own name, most telling first. */
const NAMING_SERVICES = [
  '_companion-link',
  '_airplay',
  '_raop',
  '_androidtvremote2',
  '_ipp',
  '_printer',
  '_privet',
  '_hap',
  '_spotify-connect',
  '_sonos',
  '_smb',
  '_workstation',
]

/* ---------------------------------------------------------------- *
 * Evidence
 * ---------------------------------------------------------------- */

/** '_ipp._tcp' → '_ipp'. */
const baseOf = (type: string) => type.toLowerCase().replace(/\._(?:tcp|udp)$/, '')

/** What the rules read from one device. */
function evidence(device: LanDevice) {
  const types = new Set(device.services.map((s) => baseOf(s.type)))
  const has = (...bases: string[]) => bases.some((b) => types.has(b))
  /** A TXT value of one service, or of any when `base` is null. */
  const txt = (base: string | null, key: string): string => {
    for (const s of device.services) {
      if (base !== null && baseOf(s.type) !== base) continue
      const value = s.txt?.[key]
      if (value) return value
    }
    return ''
  }
  const instance = (base: string): string =>
    device.services.find((s) => baseOf(s.type) === base && s.name)?.name ?? ''
  return { types, has, txt, instance }
}

type Evidence = ReturnType<typeof evidence>

interface Match {
  readonly kind: LanKind
  readonly os?: 'ios' | 'android'
  readonly family?: keyof typeof LAN_COPY.family
  /** Apple says so: Apple is the maker. */
  readonly apple?: boolean
  /** The model, as the evidence names it (an Apple model id's marketing name). */
  readonly model?: string
}

/** Rule 2: an Apple model id. */
function appleModel(e: Evidence): Match | null {
  for (const [base, key] of APPLE_MODEL_KEYS) {
    const id = e.txt(base, key)
    const rule = APPLE_ID.test(id) ? APPLE_MODELS.find((m) => m.test.test(id)) : undefined
    if (!rule) continue
    const family = LAN_COPY.family[rule.family]
    // iosModelName knows iPhones and iPads; anything else is named by its family.
    const model = rule.os === 'ios' ? iosModelName(id) || family : family
    return {
      kind: rule.kind,
      family: rule.family,
      apple: true,
      model,
      ...(rule.os ? { os: rule.os } : {}),
    }
  }
  return null
}

/** Rule 3: what it announces. */
function byServices(device: LanDevice, e: Evidence): Match | null {
  if (e.has('_apple-mobdev2', '_remotepairing')) {
    const ipad = device.hostnames.some((h) => /ipad/i.test(h))
    return ipad
      ? { kind: 'tablet', os: 'ios', family: 'ipad', apple: true }
      : { kind: 'phone', os: 'ios', family: 'iphone', apple: true }
  }
  const castVideo = e.has('_googlecast') && !CAST_SPEAKER.test(e.txt('_googlecast', 'md'))
  if (e.has(...ADB, '_androidtvremote2')) {
    return e.has('_androidtvremote2') || castVideo
      ? { kind: 'tv', os: 'android', family: 'androidTv' }
      : { kind: 'phone', os: 'android', family: 'android' }
  }
  if (e.has('_googlecast')) return { kind: castVideo ? 'tv' : 'speaker' }
  if (e.has('_amzn-wplay')) return { kind: 'tv', family: 'fireTv' }
  if (e.has(...PRINTERS)) return { kind: 'printer' }
  const alone = !e.has(...COMPUTERS)
  if (alone && e.has(...SCANNERS)) return { kind: 'printer' }
  if (e.has('_hap')) return { kind: HAP_KINDS[e.txt('_hap', 'ci')] ?? 'iot' }
  if (e.has(...IOT) || [...e.types].some((t) => t.startsWith('_matter'))) return { kind: 'iot' }
  if (alone && e.has(...SPEAKERS)) return { kind: 'speaker' }
  const computing = COMPUTERS.filter((t) => e.types.has(t))
  if (computing.length === 1 && computing[0] === '_adisk') return { kind: 'storage' }
  if (computing.length > 0) return { kind: 'computer' }
  return null
}

/** Rule 4: its UPnP device type (or SSDP's DIAL search target, in the same field). */
function byUpnp(device: LanDevice): Match | null {
  const type = device.upnp?.deviceType ?? ''
  if (!type) return null
  if (/InternetGatewayDevice|WANDevice/i.test(type)) return { kind: 'router' }
  if (/MediaRenderer/i.test(type)) {
    return { kind: SPEAKER_MAKERS.test(device.upnp?.manufacturer ?? '') ? 'speaker' : 'tv' }
  }
  if (/MediaServer/i.test(type)) return { kind: 'storage' }
  if (/Printer/i.test(type)) return { kind: 'printer' }
  if (/dial-multiscreen-org/i.test(type)) return { kind: 'tv' }
  return null
}

/** Rule 5: its host names. */
function byHostname(device: LanDevice): Match | null {
  for (const rule of HOST_RULES) {
    if (!device.hostnames.some((h) => rule.test.test(h))) continue
    return {
      kind: rule.kind,
      ...(rule.os ? { os: rule.os } : {}),
      ...(rule.family ? { family: rule.family } : {}),
      ...(rule.apple ? { apple: true } : {}),
    }
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Names
 * ---------------------------------------------------------------- */

/**
 * A host name as a person would write it: 'Baus-iPhone-12-Pro.local' → 'Baus iPhone 12 Pro'.
 * One that looks made by a machine ('Android_GWZJSA15.local', 'NPI9C4E21.local') stays as it
 * is, `.local` and all.
 */
export function readableHost(host: string): string {
  const parts = host.replace(/\.local$/i, '').split('-')
  const words = parts.every((p) => /^[A-Za-z]+$/.test(p) || /^[A-Za-z0-9]{1,4}$/.test(p))
  const someWord = parts.some((p) => /^[A-Za-z]{3,}$/.test(p))
  return words && someWord ? parts.join(' ') : host
}

/** The instance name of a naming service: AirPlay audio's is `<id>@<name>`. */
function ownName(e: Evidence): string {
  for (const base of NAMING_SERVICES) {
    let name = e.instance(base)
    if (base === '_raop') name = name.slice(name.indexOf('@') + 1)
    // avahi's workstation is `name [hardware address]`: the helper keeps the name.
    if (base === '_workstation') name = name.replace(/\s*\[[^\]]*\]$/, '')
    name = name.trim()
    if (name) return name
  }
  return ''
}

/** The model, as the device says it: Cast, a printer's, Android's, any `model`, UPnP's. */
function modelOf(device: LanDevice, e: Evidence, match: Match | null): string {
  const product = e.txt(null, 'product').replace(/^\((.*)\)$/, '$1')
  return (
    match?.model ||
    e.txt('_googlecast', 'md') ||
    e.txt(null, 'ty') ||
    product ||
    e.txt(null, 'usb_MDL') ||
    ADB.map((base) => e.txt(base, 'name')).find(Boolean) ||
    e.txt(null, 'model') ||
    e.txt(null, 'mdl') ||
    device.upnp?.modelName ||
    ''
  )
}

/** The maker, as the device says it, else Apple when Apple's evidence says so, else the table. */
function makerOf(
  device: LanDevice,
  e: Evidence,
  match: Match | null,
  vendor: VendorInfo | null,
): string {
  if (match?.apple) return LAN_COPY.family.apple
  return (
    e.txt(null, 'usb_MFG') ||
    e.txt(null, 'mfg') ||
    e.txt(null, 'manufacturer') ||
    device.upnp?.manufacturer ||
    vendor?.name ||
    ''
  )
}

/** `part` says nothing the other text doesn't already say. */
const repeats = (part: string, text: string) => text.toLowerCase().includes(part.toLowerCase())

/* ---------------------------------------------------------------- *
 * The view
 * ---------------------------------------------------------------- */

/** What a device is, what to call it, and the line under its name. */
export function describeLan(device: LanDevice, ctx: LanContext = {}): LanView {
  const e = evidence(device)
  const vendor = device.maker ? (ctx.vendor?.(device.maker) ?? null) : null

  const match = appleModel(e) ?? byServices(device, e) ?? byUpnp(device) ?? byHostname(device)
  // Rule 1 overrides the kind, never the evidence: a gateway or this computer keeps its model.
  let kind: LanKind = match?.kind ?? vendor?.hint ?? 'unknown'
  if (device.self) kind = 'computer'
  if (device.gateway) kind = 'router'

  const model = modelOf(device, e, match)
  const maker = makerOf(device, e, match, vendor)
  const family = match?.family ? LAN_COPY.family[match.family] : ''
  const host = device.hostnames[0] ?? ''
  // The router is known even when it names itself nowhere: "Router", not "Unknown device".
  const fallback = device.self
    ? LAN_COPY.name.self
    : device.gateway
      ? LAN_COPY.label.router
      : LAN_COPY.name.unknown
  const name =
    e.txt(null, 'given_name') ||
    e.txt('_googlecast', 'fn') ||
    e.txt('_amzn-wplay', 'n') ||
    ownName(e) ||
    device.names.find((n) => n.source === 'mdns')?.text ||
    device.upnp?.friendlyName ||
    device.names.find((n) => n.source === 'ssdp')?.text ||
    (host && readableHost(host)) ||
    model ||
    (maker && LAN_COPY.name.maker(maker, LAN_COPY.kind[kind])) ||
    fallback

  const first = [model, family].find((part) => part && !repeats(part, name)) ?? ''
  const second = maker && !repeats(maker, name) && !(first && repeats(maker, first)) ? maker : ''
  // Rule 7: nothing to go on but a private hardware address, which phones and laptops use.
  const privateOnly = kind === 'unknown' && device.privateAddress === true && !first && !second
  const detail = privateOnly
    ? LAN_COPY.name.privateOnly
    : [first, second].filter(Boolean).join(' · ')

  const labels: LanLabel[] = []
  if (device.self) labels.push('self')
  // A badge that only repeats the name says nothing.
  if (device.gateway && name !== LAN_COPY.label.router) labels.push('router')
  if (device.privateAddress === true && !privateOnly) labels.push('private')

  return {
    kind,
    name,
    detail,
    labels,
    ...(match?.os ? { os: match.os } : {}),
    ...(maker ? { maker } : {}),
    ...(model ? { model } : {}),
  }
}

/** The services a device announces, in plain words, once each; an unknown one as its type. */
export function serviceWords(device: LanDevice): string[] {
  const words = device.services.map((s) => LAN_COPY.service[s.type.toLowerCase()] ?? s.type)
  return [...new Set(words)]
}
