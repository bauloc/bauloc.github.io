/*
  A fake local network for "every device on this network" (§4.9): no socket, no packet ever
  leaves this process. Each seam of BridgeOptions has two fakes here: a silent one, which every
  isolated bridge gets (harness.ts), and a scriptable one that answers like the owner's network
  as measured on 2026-10-04 (00-real-network: the TP-Link Deco router, an HP printer, iPhones,
  the Pixel), with made-up hardware addresses and ids.

  - fakePresence(): the presence check. An address listed in `refused` answers after its delay
    (ICMP port unreachable), every other one stays silent until the window ends; `sendError`
    plays a computer that refuses to send at all (EHOSTUNREACH: a VPN, or macOS keeping the
    helper off the local network). It counts the sockets open at once and when each closed.
  - fakeSsdpNetwork(): SSDP responders answering each M-SEARCH, decoRouter() the measured
    router; fakeDescriptions(): the one HTTP request, by URL.
  - lanInterfaces(): an interface list, as os.networkInterfaces() would give it.
*/
import type {
  DescriptionTarget,
  FetchDescription,
  LanInterface,
  OpenPresence,
  OpenSsdp,
  PresenceAnswer,
} from '../../src/lan-net'
import { errno } from './mdns'

/* ------------------------------------------------------------------ interfaces --- */

/** One IPv4 interface entry: `lanInterfaces(['en0', '192.168.68.113/24'])`. */
export function lanInterfaces(...entries: Array<[name: string, cidr: string]>): LanInterface[] {
  return entries.map(([name, cidr]) => {
    const [address = '', bits = '24'] = cidr.split('/')
    const prefix = Number(bits)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    const netmask = [mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.')
    return { name, address, netmask, family: 'IPv4', internal: false }
  })
}

/** The owner's Mac on its Wi-Fi: en0 192.168.68.113/24. */
export const OWNER_INTERFACES = lanInterfaces(['en0', '192.168.68.113/24'])

/* -------------------------------------------------------------------- presence --- */

export interface FakePresence {
  readonly open: OpenPresence
  /** Address → answer delay in ms: those that are there. */
  refused: Map<string, number>
  /** Every check rejects with this, at once (nothing leaves). */
  sendError: NodeJS.ErrnoException | null
  /** Addresses checked, in order, and how many datagrams each got (always one). */
  readonly checked: string[]
  readonly datagrams: Map<string, number>
  /** The most sockets open at once, and when the last one closed (ms after the first opened). */
  readonly most: () => number
  readonly lastClosedAt: () => number
  readonly open_: () => number
}

/** A presence check that answers like `refused` says, with real timing. */
export function fakePresence(refused: Record<string, number> = {}): FakePresence {
  let open = 0
  let most = 0
  let firstAt = 0
  let lastClosedAt = 0
  const fake: FakePresence = {
    refused: new Map(Object.entries(refused)),
    sendError: null,
    checked: [],
    datagrams: new Map(),
    most: () => most,
    lastClosedAt: () => lastClosedAt,
    open_: () => open,
    open: (address, o) =>
      new Promise<PresenceAnswer>((resolve, reject) => {
        if (fake.sendError) return reject(fake.sendError)
        firstAt ||= Date.now()
        open++
        most = Math.max(most, open)
        fake.checked.push(address)
        fake.datagrams.set(address, (fake.datagrams.get(address) ?? 0) + 1)
        const delay = fake.refused.get(address)
        const done = (answer: PresenceAnswer): void => {
          clearTimeout(answerTimer)
          clearTimeout(windowTimer)
          o.signal.removeEventListener('abort', aborted)
          open--
          lastClosedAt = Date.now() - firstAt
          resolve(answer)
        }
        const aborted = (): void => done('silent')
        const answerTimer =
          delay === undefined ? undefined : setTimeout(() => done('refused'), delay)
        const windowTimer = setTimeout(() => done('silent'), o.windowMs)
        if (o.signal.aborted) return done('silent')
        o.signal.addEventListener('abort', aborted, { once: true })
      }),
  }
  return fake
}

/** Nothing is there, and nothing is sent: every isolated bridge's presence check. */
export function silentPresence(): OpenPresence {
  return () => Promise.resolve('silent')
}

/* ------------------------------------------------------------------------ SSDP --- */

/** An SSDP answer as a device writes it (CRLF lines, `HTTP/1.1 200 OK`). */
export function ssdpResponse(headers: Record<string, string>): Buffer {
  return Buffer.from(
    [
      'HTTP/1.1 200 OK',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n'),
    'latin1',
  )
}

/** Answers one M-SEARCH (its ST), from `from`. */
export type SsdpResponder = ((st: string) => Buffer[]) & { from: string }

export function ssdpResponder(from: string, answer: (st: string) => Buffer[]): SsdpResponder {
  return Object.assign(answer, { from })
}

/**
 * The TP-Link Deco router as measured: a MiniUPnPd answering ssdp:all with one answer per
 * device and service type, and upnp:rootdevice once, every one pointing at its description.
 */
export function decoRouter(o: { from?: string; location?: string } = {}): SsdpResponder {
  const from = o.from ?? '192.168.68.1'
  const location = o.location ?? `http://${from}:1900/cmlgh/rootDesc.xml`
  const uuid = 'uuid:00000000-0000-4000-8000-000000000001'
  const answer = (st: string, usn: string): Buffer =>
    ssdpResponse({
      'CACHE-CONTROL': 'max-age=1800',
      EXT: '',
      LOCATION: location,
      SERVER: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
      ST: st,
      USN: usn,
    })
  const igd = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1'
  return ssdpResponder(from, (st) =>
    st === 'upnp:rootdevice'
      ? [answer('upnp:rootdevice', `${uuid}::upnp:rootdevice`)]
      : [
          answer('upnp:rootdevice', `${uuid}::upnp:rootdevice`),
          answer(igd, `${uuid}::${igd}`),
          answer(
            'urn:schemas-upnp-org:device:WANDevice:1',
            `${uuid}::urn:schemas-upnp-org:device:WANDevice:1`,
          ),
          answer(
            'urn:schemas-upnp-org:service:WANIPConnection:1',
            `${uuid}::urn:schemas-upnp-org:service:WANIPConnection:1`,
          ),
        ],
  )
}

/** The router's description document, as MiniUPnPd serves it (made-up serial and UDN). */
export const DECO_DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" configId="1">
<specVersion><major>1</major><minor>1</minor></specVersion>
<device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<friendlyName>Deco X20 &amp; mesh</friendlyName>
<manufacturer>TP-Link</manufacturer>
<manufacturerURL>https://www.tp-link.com</manufacturerURL>
<modelDescription>AX1800 Whole Home Mesh Wi-Fi 6 System</modelDescription>
<modelName>Deco X20</modelName>
<modelNumber>4.0</modelNumber>
<serialNumber>00000000</serialNumber>
<UDN>uuid:00000000-0000-4000-8000-000000000001</UDN>
<deviceList>
<device>
<deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
<friendlyName>WANDevice</friendlyName>
</device>
</deviceList>
</device>
</root>
`

export interface FakeSsdpNetwork {
  readonly open: OpenSsdp
  responders: SsdpResponder[]
  /** Every M-SEARCH sent: its ST and the interface it went out of. */
  readonly searches: Array<{ st: string; local: string }>
  sendError: NodeJS.ErrnoException | null
  openError: NodeJS.ErrnoException | null
  readonly opened: () => number
  readonly closed: () => number
}

/** A network of SSDP responders: each M-SEARCH is answered a few ms later, datagram by datagram. */
export function fakeSsdpNetwork(responders: SsdpResponder[] = [], delayMs = 5): FakeSsdpNetwork {
  let opened = 0
  let closed = 0
  const net: FakeSsdpNetwork = {
    responders,
    searches: [],
    sendError: null,
    openError: null,
    opened: () => opened,
    closed: () => closed,
    open(onPacket) {
      if (net.openError) return Promise.reject(net.openError)
      opened++
      let isClosed = false
      const timers = new Set<NodeJS.Timeout>()
      return Promise.resolve({
        send(packet, local) {
          if (net.sendError) return Promise.reject(net.sendError)
          const st = /\r\nST: ([^\r]*)\r\n/.exec(packet.toString('latin1'))?.[1] ?? ''
          net.searches.push({ st, local })
          for (const respond of net.responders) {
            for (const answer of respond(st)) {
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

/** M-SEARCHes go nowhere, nothing answers: every isolated bridge's SSDP. */
export function silentSsdp(): OpenSsdp {
  return () => Promise.resolve({ send: () => Promise.resolve(), close: () => undefined })
}

/* ---------------------------------------------------------------- descriptions --- */

export interface FakeDescriptions {
  readonly fetch: FetchDescription
  /** Every request made. */
  readonly fetched: DescriptionTarget[]
}

/** Descriptions by `http://host:port/path`; anything else is a refused connection. */
export function fakeDescriptions(byUrl: Record<string, string> = {}): FakeDescriptions {
  const fetched: DescriptionTarget[] = []
  return {
    fetched,
    fetch(target) {
      fetched.push(target)
      const body = byUrl[`http://${target.host}:${String(target.port)}${target.path}`]
      return body === undefined
        ? Promise.reject(errno('ECONNREFUSED', `connect ECONNREFUSED ${target.host}`))
        : Promise.resolve(body)
    },
  }
}

/** No description is ever fetched: every isolated bridge's. */
export const noDescription: FetchDescription = () =>
  Promise.reject(new Error('No description is fetched in a test that did not ask for one.'))
