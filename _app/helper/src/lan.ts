import { NETWORK_HINT, blockedLines, offerableAddress } from './android-lane'
import {
  LAN_PRESENCE_PORT,
  LAN_SSDP_TARGETS,
  LAN_STATIC_TYPES,
  LAN_TXT_KEYS,
  LIMITS,
} from './constants'
import {
  MAX_DESCRIPTION,
  checkPresence,
  descriptionTarget,
  lanNetworks,
  macFacts,
  normalizeMac,
  onLan,
  parseDescription,
  readGateway,
  readNeighbours,
  searchSsdp,
  type Description,
  type LanPlan,
  type Neighbour,
  type PresenceResult,
  type SsdpResult,
  type TableOptions,
} from './lan-net'
import {
  browse,
  browseServiceTypes,
  reverseNames,
  reverseTools,
  serviceType,
  systemBrowseAll,
  systemMdnsTools,
  usableHost,
  type BrowseResult,
  type OpenMdnsTransport,
  type ServiceInstance,
  type SystemBrowseResult,
} from './mdns'
import type { RunTool, StreamTool } from './process'
import type {
  BridgeOptions,
  LanDevice,
  LanName,
  LanNetwork,
  LanResult,
  LanScanContext,
  LanScanner,
  LanService,
  LanSource,
  LanUpnp,
  NearbyFailure,
  Timeouts,
} from './types'
import {
  abortError,
  aborted,
  clean,
  createLimiter,
  errorText,
  linkSignals,
  plural,
  singleFlight,
} from './util'

/**
 * §16 Every device on this network (§4.9): one look at this computer's own network, merged
 * device by device, for "Devices on this network" on the page. It answers the owner's "list
 * ALL the devices currently on the local network": the router, phones, tablets, TVs,
 * computers, printers, speakers, smart-home things.
 *
 * A look runs only when the page asks (GET /api/lan/devices, and --doctor): never at startup,
 * never on a timer. It gathers, at once and each bounded on its own (lan-net.ts, mdns.ts):
 * the presence check of this computer's own subnets, the neighbour table and the default
 * gateway, every mDNS service through the system's daemon and the helper's own socket, SSDP and
 * the UPnP descriptions it points to, then the reverse names of what is there but still
 * unnamed. The whole look is cut at `lanScan` (7 s); what arrived by then is the answer.
 *
 * The helper says what each device is called and announces, never what it is: kinds and names
 * are the page's (lan-kinds.ts). And it never passes on a hardware address. One it reads (the
 * neighbour table, an iPhone's `_apple-mobdev2` instance, a printer's TXT `mac=`, avahi's
 * `_workstation`) becomes two facts, a private address or not and the maker's prefix of one
 * that is not, and every text sent beside them loses whatever carries that address or a part
 * of it (a printer's `(F25F81)`, its host `NPIF25F81`), as well as any UUID, run of 12 hex
 * digits or written-out hardware address: with the maker's prefix in the same row, the last
 * three bytes would give the whole address away.
 */

/* --------------------------------------------------------------- what is kept --- */

/** Per device, as the wire caps them (§4.9, mirrored by the page). */
const KEEP = { hostnames: 4, names: 8, services: 24, txt: 8 }
/** UPnP descriptions fetched in one look, and at once. */
const DESCRIPTIONS = { max: 16, slots: 4 }
/** Addresses asked for a reverse name in one look. */
const MAX_REVERSE = 64

/** Instance names that are the device's own name (the page names a device by them first). */
const NAME_TYPES: ReadonlySet<string> = new Set([
  '_companion-link._tcp',
  '_airplay._tcp',
  '_raop._tcp',
  '_androidtvremote2._tcp',
  '_ipp._tcp',
  '_ipps._tcp',
  '_printer._tcp',
  '_privet._tcp',
  '_hap._tcp',
  '_spotify-connect._tcp',
  '_sonos._tcp',
  '_smb._tcp',
  '_workstation._tcp',
])

/** adbd names its services `adb-<serial>`: a serial, never passed on. */
const ADB_TYPES: ReadonlySet<string> = new Set([
  '_adb._tcp',
  '_adb-tls-connect._tcp',
  '_adb-tls-pairing._tcp',
])

/** LAN_TXT_KEYS by lower case: TXT keys compare case-insensitively (RFC 6763 §6.4). */
const TXT_KEYS = new Map<string, string>(LAN_TXT_KEYS.map((key) => [key.toLowerCase(), key]))

/* ------------------------------------------------------ hardware addresses, ids --- */

/** A UUID, a hardware address written out, a run of 12 hex digits: ids, never names. */
const UUID_TEXT = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g
const MAC_TEXT = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{1,2}(?:[:-][0-9A-Fa-f]{1,2}){5}(?![0-9A-Fa-f])/g
const HEX_RUN = /[0-9A-Fa-f]{12,}/g

/** `6c02e0f25f81`'s whole and its last three bytes, as patterns, with or without `:`/`-`. */
function idPatterns(id: string): RegExp[] {
  const bytes = (hex: string): string => (hex.match(/../g) ?? []).join('[:-]?')
  return [new RegExp(bytes(id), 'gi'), new RegExp(bytes(id.slice(6)), 'gi')]
}

/**
 * `text` without anything that carries a hardware address or an id (§4.9): UUIDs, written-out
 * hardware addresses, runs of 12 hex digits, and every one of `hidden` (12 hex digits each,
 * the addresses read for this device) whole or by its last three bytes. Brackets left empty
 * and separators left dangling go too: `HP Neverstop Laser MFP 1200w (F25F81)` → `HP
 * Neverstop Laser MFP 1200w`.
 */
export function scrub(text: string, hidden: ReadonlySet<string> = new Set()): string {
  let out = text.replace(UUID_TEXT, ' ').replace(MAC_TEXT, ' ').replace(HEX_RUN, ' ')
  for (const id of hidden) for (const pattern of idPatterns(id)) out = out.replace(pattern, ' ')
  return out
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_.:@,;]+|[\s\-_.:@,;]+$/g, '')
}

/** Whether `text` holds anything scrub() would take out. */
export function carriesId(text: string, hidden: ReadonlySet<string> = new Set()): boolean {
  const found = (pattern: RegExp): boolean => {
    pattern.lastIndex = 0
    return pattern.test(text)
  }
  return (
    found(UUID_TEXT) ||
    found(MAC_TEXT) ||
    found(HEX_RUN) ||
    [...hidden].some((id) => idPatterns(id).some(found))
  )
}

/** A hardware address (or AirPlay's device id, written like one) as 12 lower-case hex digits. */
function idOf(text: string): string | null {
  const mac = normalizeMac(text)
  if (mac) return mac.replace(/:/g, '')
  return /^[0-9A-Fa-f]{12}$/.test(text.trim()) ? text.trim().toLowerCase() : null
}

/* -------------------------------------------------------------------- the merge --- */

/** A device while the sources are merged: raw texts, and the addresses to keep out of them. */
interface Draft {
  address: string
  self: boolean
  gateway: boolean
  found: Set<LanSource>
  hostnames: string[]
  names: LanName[]
  /** `instance` is the raw instance name, for telling services apart only: never sent. */
  services: Array<{ type: string; instance: string; port?: number; name?: string; txt: string[] }>
  upnp?: Description & { server?: string; types: string[] }
  /** Hardware addresses read for it, in the order of trust: the neighbour table first. */
  macs: string[]
  /** Everything that may carry one: those, and AirPlay's ids. 12 hex digits each. */
  hidden: Set<string>
}

/** The fixed order of LanSource, the order `found` lists them in. */
const SOURCES: readonly LanSource[] = [
  'reply',
  'neighbors',
  'mdns',
  'ssdp',
  'reverse',
  'gateway',
  'self',
]

function createDrafts(): {
  at: (address: string) => Draft
  get: (address: string) => Draft | undefined
  all: () => Draft[]
} {
  const drafts = new Map<string, Draft>()
  return {
    at(address) {
      let draft = drafts.get(address)
      if (!draft) {
        draft = {
          address,
          self: false,
          gateway: false,
          found: new Set(),
          hostnames: [],
          names: [],
          services: [],
          macs: [],
          hidden: new Set(),
        }
        drafts.set(address, draft)
      }
      return draft
    },
    get: (address) => drafts.get(address),
    all: () => [...drafts.values()],
  }
}

/** A hardware address read for `draft`: a fact source, and something to keep out of its texts. */
function readMac(draft: Draft, mac: string): void {
  const id = idOf(mac)
  if (!id) return
  draft.hidden.add(id)
  const normal = normalizeMac(mac)
  if (normal && !draft.macs.includes(normal)) draft.macs.push(normal)
}

/** A `.local` name for `draft` (an SRV target, a reverse name), without its root dot. */
function addHostname(draft: Draft, host: string): void {
  const name = host.replace(/\.$/, '')
  if (!usableHost(name) || name.length > 253) return
  if (draft.hostnames.some((h) => h.toLowerCase() === name.toLowerCase())) return
  draft.hostnames.push(name)
}

/**
 * What an instance name may say (§4.9): `_apple-mobdev2`'s is `<hardware address>@<IPv6>…`
 * (read, never passed on), `_raop`'s `<AirPlay id>@<name>` (the name only), avahi's
 * `_workstation` `<name> [<hardware address>]` (the name only), and adbd's `adb-<serial>`
 * nothing at all.
 */
function instanceName(type: string, instance: string, draft: Draft): string | undefined {
  const key = type.toLowerCase()
  if (ADB_TYPES.has(key)) return undefined
  if (key === '_apple-mobdev2._tcp') {
    const at = instance.indexOf('@')
    if (at > 0) readMac(draft, instance.slice(0, at))
    return undefined
  }
  let name = instance
  if (key === '_raop._tcp') {
    const at = instance.indexOf('@')
    if (at > 0) {
      const id = idOf(instance.slice(0, at))
      if (id) draft.hidden.add(id)
      name = instance.slice(at + 1)
    }
  }
  if (key === '_workstation._tcp') {
    const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(instance)
    if (m) {
      readMac(draft, m[2] ?? '')
      name = m[1] ?? ''
    }
  }
  return name
}

/** One mDNS service on `draft`: its type, port, instance name and TXT, as raw as they came. */
function addService(draft: Draft, instance: ServiceInstance): void {
  const type = serviceType(instance.service)
  if (!type) return
  const name = instanceName(type, instance.instance, draft)
  for (const text of instance.txt) {
    const eq = text.indexOf('=')
    const key = eq < 0 ? '' : text.slice(0, eq).toLowerCase()
    /** A printer's `mac=` is its hardware address; AirPlay's `deviceid=` reads like one. */
    if (key === 'mac') readMac(draft, text.slice(eq + 1))
    if (key === 'deviceid') {
      const id = idOf(text.slice(eq + 1))
      if (id) draft.hidden.add(id)
    }
  }
  if (name !== undefined && NAME_TYPES.has(type.toLowerCase())) {
    draft.names.push({ text: name, source: 'mdns' })
  }
  /** The daemon's and the helper's own browse often find the same instance: once. */
  const same = draft.services.find(
    (s) =>
      s.type.toLowerCase() === type.toLowerCase() &&
      s.instance.toLowerCase() === instance.instance.toLowerCase(),
  )
  if (same) {
    if (!same.txt.length) same.txt = instance.txt
    return
  }
  draft.services.push({
    type,
    instance: instance.instance,
    ...(instance.port !== null ? { port: instance.port } : {}),
    ...(name !== undefined ? { name } : {}),
    txt: instance.txt,
  })
}

/** An IPv4 address a device may be listed at: a local one, as offerableAddress() writes it. */
function lanAddress(address: string): string | null {
  const offered = offerableAddress(address)
  return offered && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(offered) ? offered : null
}

/**
 * The addresses mDNS ties `instance` to (§4.9). Its IPv4 addresses on the local network, those
 * on the networks looked at when it has some. A host name that resolves to more than one of
 * them, or `Android.local` (adbd's and Android TV's name on many devices at once), ties nothing
 * by itself: only the helper's own browse, which heard the answer come from the device
 * (`from`), still ties those.
 */
function tiedAddresses(
  instance: ServiceInstance,
  plan: Pick<LanPlan, 'ranges'>,
  shared: (host: string) => boolean,
): string[] {
  const local = instance.addresses
    .map(lanAddress)
    .filter((a): a is string => a !== null)
    .filter((a, i, all) => all.indexOf(a) === i)
  const onOurs = local.filter((a) => onLan(a, plan.ranges))
  const addresses = onOurs.length ? onOurs : local
  const from = instance.from === undefined ? null : lanAddress(instance.from)
  /** An answer that brought only IPv6 addresses still came from the device's IPv4 one. */
  if (from) return addresses.length ? addresses : [from]
  if (!instance.target || shared(instance.target)) return []
  return addresses.length === 1 ? addresses : []
}

/** The fields a page may get from one draft, every text cleaned, scrubbed and capped. */
function finish(draft: Draft): LanDevice {
  const text = (value: string, max: number = LIMITS.field): string =>
    scrub(clean(value, 4 * max), draft.hidden)
      .slice(0, max)
      .trim()
  const hostnames = draft.hostnames
    .filter((h) => !carriesId(h, draft.hidden))
    .slice(0, KEEP.hostnames)
  const names: LanName[] = []
  for (const name of draft.names) {
    const cleaned = text(name.text)
    if (!cleaned || names.some((n) => n.text.toLowerCase() === cleaned.toLowerCase())) continue
    names.push({ text: cleaned, source: name.source })
    if (names.length >= KEEP.names) break
  }
  const services: LanService[] = []
  for (const s of draft.services) {
    const name = s.name === undefined ? '' : text(s.name)
    const txt: Record<string, string> = {}
    let keys = 0
    for (const entry of s.txt) {
      const eq = entry.indexOf('=')
      const key = eq < 0 ? undefined : TXT_KEYS.get(entry.slice(0, eq).toLowerCase())
      if (!key || key in txt || keys >= KEEP.txt) continue
      const value = text(entry.slice(eq + 1))
      if (!value) continue
      txt[key] = value
      keys++
    }
    services.push({
      type: s.type,
      ...(s.port !== undefined ? { port: s.port } : {}),
      ...(name ? { name } : {}),
      ...(keys ? { txt } : {}),
    })
    if (services.length >= KEEP.services) break
  }
  let upnp: LanUpnp | undefined
  if (draft.upnp) {
    const u = draft.upnp
    const fields: LanUpnp = {}
    const deviceType = u.deviceType ?? u.types.find((t) => /:device:/i.test(t)) ?? u.types[0]
    const pairs: Array<[keyof LanUpnp, string | undefined]> = [
      ['deviceType', deviceType],
      ['friendlyName', u.friendlyName],
      ['manufacturer', u.manufacturer],
      ['modelName', u.modelName],
      ['modelNumber', u.modelNumber],
      ['server', u.server],
    ]
    for (const [key, value] of pairs) {
      const cleaned = value === undefined ? '' : text(value)
      if (cleaned) fields[key] = cleaned
    }
    if (Object.keys(fields).length) upnp = fields
  }
  const mac = draft.macs[0]
  const facts = mac ? macFacts(mac) : null
  return {
    address: draft.address,
    self: draft.self,
    gateway: draft.gateway,
    hostnames,
    names,
    services,
    ...(upnp ? { upnp } : {}),
    ...(facts?.maker ? { maker: facts.maker } : {}),
    ...(facts ? { privateAddress: facts.privateAddress } : {}),
    found: SOURCES.filter((source) => draft.found.has(source)),
  }
}

/** 192.168.68.2 before 192.168.68.10: addresses as numbers. */
function addressOrder(a: string, b: string): number {
  const n = (address: string): number =>
    address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
  return n(a) - n(b)
}

/** What every source of one look found (§4.9), before the merge. */
export interface LanSourcesRead {
  plan: LanPlan
  /** null: no presence check (Windows, or nothing to check). */
  presence: PresenceResult | null
  neighbours: { entries: Neighbour[]; state: 'ok' | 'hidden' | 'none' }
  gateway: string | null
  system: SystemBrowseResult
  own: BrowseResult
  ssdp: SsdpResult
  descriptions: Map<string, Description>
  reverse: Map<string, string>
}

/**
 * Every source's finds, merged by IPv4 address (§4.9). A device exists where any source puts
 * one: this computer's own addresses, the gateway, an address that answered the presence
 * check, a complete neighbour entry, an mDNS service tied to an address, an SSDP answer. A
 * reverse name only names one that exists. The gateway comes first, then by address; at most
 * LIMITS.lanDevices. `unnamed`: what is there on the networks looked at with no `.local` name
 * yet, at most 64, for the reverse names.
 */
export function mergeLan(read: LanSourcesRead): {
  devices: LanDevice[]
  truncated: boolean
  unnamed: string[]
} {
  const { plan } = read
  const drafts = createDrafts()
  for (const address of plan.own.keys()) {
    const draft = drafts.at(address)
    draft.self = true
    draft.found.add('self')
  }
  if (read.gateway && onLan(read.gateway, plan.ranges)) {
    const draft = drafts.at(read.gateway)
    draft.gateway = true
    draft.found.add('gateway')
  }
  for (const address of read.presence?.present ?? []) {
    if (lanAddress(address)) drafts.at(address).found.add('reply')
  }
  for (const entry of read.neighbours.entries) {
    if (!onLan(entry.address, plan.ranges) || plan.own.has(entry.address)) continue
    if (!lanAddress(entry.address)) continue
    const draft = drafts.at(entry.address)
    draft.found.add('neighbors')
    readMac(draft, entry.mac)
  }
  /** Host names that tie nothing (§4.9): Android.local, and a name with several addresses. */
  const byHost = new Map<string, Set<string>>()
  for (const instance of [...read.system.instances, ...read.own.instances]) {
    if (!instance.target) continue
    const key = instance.target.toLowerCase().replace(/\.$/, '')
    const set = byHost.get(key) ?? new Set<string>()
    for (const a of instance.addresses) {
      const local = lanAddress(a)
      if (local && onLan(local, plan.ranges)) set.add(local)
    }
    byHost.set(key, set)
  }
  const shared = (host: string): boolean => {
    const key = host.toLowerCase().replace(/\.$/, '')
    return key === 'android.local' || (byHost.get(key)?.size ?? 0) > 1
  }
  for (const instance of [...read.system.instances, ...read.own.instances]) {
    for (const address of tiedAddresses(instance, plan, shared)) {
      const draft = drafts.at(address)
      draft.found.add('mdns')
      if (instance.target) addHostname(draft, instance.target)
      addService(draft, instance)
    }
  }
  for (const [address, device] of read.ssdp.devices) {
    if (!lanAddress(address)) continue
    const draft = drafts.at(address)
    draft.found.add('ssdp')
    const description = read.descriptions.get(address) ?? {}
    draft.upnp = { ...description, server: device.server, types: device.types }
    if (description.friendlyName) {
      draft.names.push({ text: description.friendlyName, source: 'ssdp' })
    }
  }
  for (const [address, host] of read.reverse) {
    const draft = drafts.get(address)
    /** A name that carries its hardware address (`ESP_AABBCC.local`) names nothing here. */
    if (!draft || carriesId(host, draft.hidden)) continue
    draft.found.add('reverse')
    addHostname(draft, host)
  }
  const all = drafts
    .all()
    .sort((a, b) => Number(b.gateway) - Number(a.gateway) || addressOrder(a.address, b.address))
  const unnamed = all
    .filter((d) => !d.hostnames.length && onLan(d.address, plan.ranges))
    .map((d) => d.address)
    .slice(0, MAX_REVERSE)
  return {
    devices: all.slice(0, LIMITS.lanDevices).map(finish),
    truncated: all.length > LIMITS.lanDevices,
    unnamed,
  }
}

/* --------------------------------------------------------------- one look --- */

/** The page's wording, for a page with none of its own. */
const LAN_MESSAGE: Record<NearbyFailure, string> = {
  blocked: `Could not look for devices on this network. ${NETWORK_HINT.blocked}`,
  'no-network':
    'Could not look for devices: this computer is not on a network. Turn on Wi-Fi, or plug in a network cable.',
  failed: 'Could not look for devices on this network.',
}

const LAN_NOTE =
  "Listed through this computer's own resolver: the helper's own packets could not reach the network, so only devices that announce themselves are here."

const NO_SYSTEM: SystemBrowseResult = { tool: null, looked: false, instances: [] }

/**
 * The helper's own mDNS (§4.9): the types the network lists (half of `windowMs`), then every
 * one of them and of LAN_STATIC_TYPES in one browse() (`windowMs`, 256 instances).
 */
async function ownBrowse(
  open: OpenMdnsTransport,
  windowMs: number,
  signal: AbortSignal,
): Promise<BrowseResult> {
  const listed = await browseServiceTypes({ open, windowMs: Math.floor(windowMs / 2), signal })
  if (listed.failure) return { instances: [], failure: listed.failure }
  if (signal.aborted) return { instances: [] }
  const types = new Map<string, string>()
  for (const type of [...LAN_STATIC_TYPES, ...listed.types]) types.set(type.toLowerCase(), type)
  return browse({
    services: [...types.values()].map((type) => `${type}.local`),
    open,
    windowMs,
    signal,
    max: LIMITS.lanDevices,
  })
}

/** Up to 16 UPnP descriptions, 4 at a time, each only where descriptionTarget() allows it. */
async function describe(
  ssdp: SsdpResult,
  o: Pick<BridgeOptions, 'lanDescription'> & { timeoutMs: number; signal: AbortSignal },
): Promise<Map<string, Description>> {
  const out = new Map<string, Description>()
  const jobs: Array<[string, NonNullable<ReturnType<typeof descriptionTarget>>]> = []
  for (const [address, device] of ssdp.devices) {
    const target = device.location ? descriptionTarget(device.location, address) : null
    if (target && jobs.length < DESCRIPTIONS.max) jobs.push([address, target])
  }
  const slot = createLimiter(DESCRIPTIONS.slots)
  await Promise.all(
    jobs.map(([address, target]) =>
      slot(async () => {
        if (o.signal.aborted) return
        try {
          const xml = await o.lanDescription(target, {
            timeoutMs: o.timeoutMs,
            maxBytes: MAX_DESCRIPTION,
            signal: o.signal,
          })
          out.set(address, parseDescription(xml))
        } catch {
          /** No description: the SSDP answer still lists the device. */
        }
      }),
    ),
  )
  return out
}

/** `lanInterfaces()`, or none when it throws. */
function interfacesOf(options: BridgeOptions): ReturnType<BridgeOptions['lanInterfaces']> {
  try {
    return options.lanInterfaces()
  } catch {
    return []
  }
}

/**
 * One look at this computer's network (§4.9): BridgeOptions.lanScan's default. Every source
 * starts at once, except the neighbour table (after the presence check, which fills it), the
 * UPnP descriptions (after SSDP) and the reverse names (after the presence check, the table,
 * mDNS and SSDP, for what is there but unnamed). The look is cut at `lanScan`: sockets closed,
 * tools killed, and what arrived is the answer. Never rejects: a source that fails says so in
 * `sources`, `error` or `note`.
 */
export async function scanLan(ctx: LanScanContext): Promise<LanResult> {
  const { options: o, timeouts } = ctx
  const scannedAt = ctx.now()
  const plan = lanNetworks(interfacesOf(o))
  if (!plan.networks.length) {
    return {
      devices: [],
      networks: [],
      sources: { presence: 'off', neighbors: 'none', resolver: 'none', ssdp: 'ok' },
      scannedAt,
      durationMs: Math.max(0, ctx.now() - scannedAt),
      error: {
        reason: 'no-network',
        message: LAN_MESSAGE['no-network'],
        detail: 'no network interface has a private IPv4 address',
      },
    }
  }
  const look = linkSignals([ctx.signal], timeouts.lanScan)
  try {
    const signal = look.signal
    const tables: TableOptions = {
      platform: o.platform,
      arpPath: o.arpPath,
      procNetArpPath: o.procNetArpPath,
      procNetRoutePath: o.procNetRoutePath,
      routePath: o.routePath,
      runTool: ctx.runTool,
      signal,
    }
    const presence =
      o.platform === 'win32' || !plan.targets.length
        ? Promise.resolve(null)
        : checkPresence(plan.targets, {
            open: o.lanPresence,
            port: LAN_PRESENCE_PORT,
            windowMs: timeouts.lanPresence,
            pool: LIMITS.lanSockets,
            signal,
          }).catch(() => null)
    const neighbours = presence.then(() => readNeighbours(tables))
    const gateway = readGateway(tables)
    const system = systemBrowseAll({
      services: LAN_STATIC_TYPES,
      tools: systemMdnsTools(o),
      streamTool: ctx.streamTool,
      browseMs: timeouts.systemBrowse,
      resolveMs: timeouts.systemResolve,
      signal,
    }).catch(() => NO_SYSTEM)
    const own = ownBrowse(o.mdns, timeouts.mdnsWindow, signal).catch(
      (error: unknown): BrowseResult => ({
        instances: [],
        failure: { reason: 'failed', code: '', detail: clean(errorText(error), 200) },
      }),
    )
    const ssdp = searchSsdp({
      open: o.lanSsdp,
      interfaces: [...plan.own.keys()],
      targets: LAN_SSDP_TARGETS,
      windowMs: timeouts.lanSsdp,
      signal,
    }).catch((): SsdpResult => ({ devices: new Map() }))
    const descriptions = ssdp.then((found) =>
      describe(found, {
        lanDescription: o.lanDescription,
        timeoutMs: timeouts.lanDescription,
        signal,
      }),
    )
    const [p, n, g, s, m, ss] = await Promise.all([
      presence,
      neighbours,
      gateway,
      system,
      own,
      ssdp,
    ])
    const sources = { plan, presence: p, neighbours: n, gateway: g, system: s, own: m, ssdp: ss }
    const reverse = await reverseNames({
      addresses: mergeLan({ ...sources, descriptions: new Map(), reverse: new Map() }).unnamed,
      tools: reverseTools(o),
      streamTool: ctx.streamTool,
      open: o.mdns,
      timeoutMs: timeouts.lanReverse,
      signal,
    }).catch(() => new Map<string, string>())
    const read: LanSourcesRead = { ...sources, descriptions: await descriptions, reverse }
    const merged = mergeLan(read)
    return {
      devices: merged.devices,
      networks: plan.networks,
      sources: sourcesOf(read, o.platform),
      scannedAt,
      durationMs: Math.max(0, ctx.now() - scannedAt),
      ...(merged.truncated ? { truncated: true } : {}),
      ...problemOf(read),
    }
  } finally {
    look.dispose()
  }
}

function sourcesOf(read: LanSourcesRead, platform: NodeJS.Platform): LanResult['sources'] {
  const { presence } = read
  return {
    presence:
      platform === 'win32' || !presence || !read.plan.targets.length
        ? 'off'
        : presence.sent === 0 && presence.failure
          ? 'blocked'
          : 'ok',
    neighbors: read.neighbours.state,
    resolver: !read.system.looked
      ? 'none'
      : read.system.tool === 'avahi-browse'
        ? 'avahi'
        : 'dns-sd',
    ssdp: read.ssdp.failure ? 'blocked' : 'ok',
  }
}

/**
 * `error` only when nothing could look (§4.9): not one of the helper's own packets left (the
 * presence check, its mDNS question, its M-SEARCH) and the system's resolver did not look
 * either. When the resolver looked, `note` instead, with the same reason and detail: what it
 * found is listed, and what announces nothing is missing.
 */
function problemOf(read: LanSourcesRead): Pick<LanResult, 'error' | 'note'> {
  const presenceSent = (read.presence?.sent ?? 0) > 0
  if (presenceSent || !read.own.failure || !read.ssdp.failure) return {}
  const failure = read.presence?.failure ?? read.own.failure
  const said = { reason: failure.reason, detail: failure.detail }
  if (read.system.looked) return { note: { ...said, message: LAN_NOTE } }
  return {
    error: {
      ...said,
      message: LAN_MESSAGE[failure.reason],
      detail: read.system.detail ? `${said.detail}; ${read.system.detail}` : said.detail,
    },
  }
}

/* ----------------------------------------------------------- terminal, doctor --- */

/** `192.168.68.0/24`: a network as people write it. */
function networkName(network: LanNetwork): string {
  const parts = network.address.split('.').map(Number)
  const n = parts.reduce((sum, part) => sum * 256 + part, 0)
  const block = 2 ** (32 - network.prefix)
  const base = n - (n % block)
  return `${[base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join('.')}/${String(network.prefix)}`
}

/** `Network: 11 devices on 192.168.68.0/24 (en0)`: counts and networks, never a name. */
export function lanSummary(result: LanResult): string {
  const networks = result.networks.map(
    (n) =>
      `${networkName(n)} (${n.interface}${n.scanned < n.size ? `, ${String(n.scanned)} of ${String(n.size)} addresses checked` : ''})`,
  )
  const count = `${plural(result.devices.length, 'device')}${result.truncated ? ' or more' : ''}`
  return clean(`Network: ${count}${networks.length ? ` on ${networks.join(', ')}` : ''}`, 300)
}

/**
 * The terminal's lines for a look (§4.9), printed only when they differ from the last ones:
 * the summary, after a note's quiet line; or why it could not look, `blocked` with its causes
 * and fixes (the macOS one only on a Mac), and the summary only when something was found.
 */
export function lanLines(result: LanResult, platform: NodeJS.Platform): string[] {
  const head = 'Network: could not look for devices'
  if (result.error) {
    const { reason, detail } = result.error
    const lines =
      reason === 'blocked'
        ? blockedLines(
            head,
            /EPERM|EACCES/.test(detail) ? 'not permitted' : 'no route to host',
            platform,
          )
        : reason === 'no-network'
          ? [`${head}: this computer is not on a network`]
          : [clean(`${head}: ${detail}`, 300)]
    return result.devices.length ? [...lines, lanSummary(result)] : lines
  }
  if (result.note) {
    const tool =
      result.sources.resolver === 'none' ? 'the system resolver' : result.sources.resolver
    return [
      clean(
        `Network: listed through ${tool} only; the helper's own packets could not leave (${result.note.detail})`,
        300,
      ),
      lanSummary(result),
    ]
  }
  return [lanSummary(result)]
}

const FOUND_WORDS: Record<LanSource, string> = {
  reply: 'reply',
  neighbors: 'neighbour table',
  mdns: 'mDNS',
  ssdp: 'SSDP',
  reverse: 'reverse name',
  gateway: 'gateway',
  self: 'this computer',
}

/**
 * --doctor's Network section (§1.9, T18): the terminal's lines, what could look, then one line
 * per device with its address, how it was found and the service types it announces. Never a
 * name, a host name, a model or a hardware address: this output is pasted into PRs.
 */
export function lanDoctorLines(result: LanResult, platform: NodeJS.Platform): string[] {
  const s = result.sources
  const sources = [
    `presence ${s.presence === 'off' && platform === 'win32' ? 'off (Windows)' : s.presence}`,
    s.neighbors === 'ok'
      ? 'neighbour table ok'
      : s.neighbors === 'hidden'
        ? platform === 'darwin'
          ? 'neighbour table hidden by macOS'
          : 'neighbour table empty'
        : 'no neighbour table',
    s.resolver === 'none' ? 'no resolver' : `resolver ${s.resolver}`,
    `SSDP ${s.ssdp}`,
  ].join(' · ')
  return [
    ...lanLines(result, platform),
    sources,
    ...result.devices.map((d) =>
      clean(
        [
          d.address,
          `found by ${d.found.map((source) => FOUND_WORDS[source]).join(', ')}`,
          ...(d.services.length
            ? [[...new Set(d.services.map((service) => service.type))].join(', ')]
            : []),
        ].join(' · '),
        300,
      ),
    ),
  ]
}

/* ---------------------------------------------------------------- the scanner --- */

export interface LanScannerContext {
  readonly options: BridgeOptions
  readonly timeouts: Timeouts
  readonly runTool: RunTool
  readonly streamTool: StreamTool
  /** Aborts on shutdown: every look runs on it. */
  readonly signal: AbortSignal
  readonly now: () => number
  /** One timestamped terminal line. */
  readonly log: (line: string) => void
}

/**
 * The bridge's LAN scanner (§4.9), built always (it needs no lane, and `--no-android` leaves
 * it on). One look at a time, a second caller joins it; a look answers for `lanCache` (30 s,
 * from its start), and `?refresh=1` starts a new one only `lanGap` (3 s) after the last one
 * started. A look runs on the helper's shutdown signal, never a request's: a page that leaves
 * stops waiting, the look goes on for whoever else waits. Nothing runs before a request, and
 * nothing starts once the helper is stopping.
 */
export function createLanScanner(ctx: LanScannerContext): LanScanner {
  const flights = singleFlight()
  const scanContext: LanScanContext = {
    options: ctx.options,
    timeouts: ctx.timeouts,
    runTool: ctx.runTool,
    streamTool: ctx.streamTool,
    signal: ctx.signal,
    now: ctx.now,
  }
  let last: { result: LanResult; startedAt: number } | null = null
  let reported = ''
  let stopped = false

  const scanNow = (): Promise<LanResult> =>
    flights.run('lan', async () => {
      const startedAt = ctx.now()
      const result = await ctx.options.lanScan(scanContext)
      if (!stopped) last = { result, startedAt }
      return result
    })

  /** The look's lines in the terminal, when they differ from the last ones printed. */
  const report = (result: LanResult): void => {
    const lines = lanLines(result, ctx.options.platform)
    const key = lines.join('\n')
    if (key === reported) return
    reported = key
    for (const line of lines) ctx.log(line)
  }

  return {
    async devices(refresh, signal) {
      if (stopped || ctx.signal.aborted) throw abortError()
      const age = last ? ctx.now() - last.startedAt : Infinity
      const stale = age >= ctx.timeouts.lanCache || (refresh && age >= ctx.timeouts.lanGap)
      if (flights.has('lan') || stale) {
        await Promise.race([scanNow(), aborted(signal)])
        if (signal.aborted) throw abortError()
      }
      const result = last?.result
      if (!result) throw abortError()
      report(result)
      return result
    },
    async probeForDoctor(write) {
      const result = await ctx.options.lanScan(scanContext)
      for (const line of lanDoctorLines(result, ctx.options.platform)) write(line)
    },
    stop() {
      stopped = true
    },
  }
}
