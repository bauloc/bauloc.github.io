import { spawn } from 'node:child_process'
import dns from 'node:dns/promises'
import net, { type Socket } from 'node:net'
import { ADB_DETAIL, ADB_EXEC, ID, INSTALL, LIMITS } from './constants'
import type { Toolbox } from './tools'
import {
  browse,
  systemBrowse,
  systemMdnsTools,
  type OpenMdnsTransport,
  type ServiceInstance,
  type SystemBrowseResult,
} from './mdns'
import type {
  AndroidLane,
  AndroidNearbyDevice,
  AndroidNearbyResult,
  Connection,
  DetailOutputs,
  HelperDevice,
  HelperState,
  LaneContext,
  NearbyFailure,
  NearbyKind,
  Timeouts,
} from './types'
import {
  HelperError,
  abortError,
  aborted,
  clean,
  errorText,
  extractPng,
  linkSignals,
  plural,
  seconds,
  singleFlight,
  sleep,
  splitLines,
} from './util'

/**
 * §9 Android lane: Google's adb server, attach-only, over its host protocol (§4).
 *
 * The helper never runs an adb command to reach a phone. The adb CLI starts a server whenever
 * none runs, and a running server claims every phone's USB interface, which takes the phones
 * away from Chrome's WebUSB lane: the tester's working setup would break because the helper
 * looked. So the helper only TALKS to a server that is already there, on 127.0.0.1:5037, and
 * starts one solely when the tester clicks "Start adb server" (§4.5). It never stops one:
 * the tester's IDE may be using it, and `adb kill-server` is one command away.
 *
 * Coexistence with WebUSB (§4.6) follows from that, with the page's merge rule doing the rest:
 * - no server: this lane reports `stopped` and lists nothing, so WebUSB rows stand alone;
 * - a server (an IDE's, or one started here): this lane lists what the server holds, and the
 *   page prefers those rows to WebUSB's `held` ones;
 * - a phone WebUSB still holds shows up here as `offline` or `unknown`, and loses to WebUSB.
 *
 * Every exchange is a fresh socket with its own deadline, except the hot-plug tracker, which
 * is one long-lived socket while a server exists. What may be sent is an allowlist (T10, T11):
 * four host services, `host:transport:<serial>` with a serial of the listed shape, and the
 * constant `exec:` strings in ADB_EXEC. No page input ever reaches a device command.
 *
 * The one exception is Wi-Fi (§4.7): `host:connect:`, `host:pair:` and `host:disconnect:`
 * carry an address, a code or a serial the tester typed. They never pass assertAdbService;
 * each has its own sender and its own exact-format check, and is sent only on a click.
 */

/* ------------------------------------------------------------ the allowlist (T11) --- */

/**
 * The host services the client may send, besides `host:transport:<serial>`. All read-only
 * except `host:reconnect-offline`, which resets transports the server already has.
 * `host:mdns:services` is the server's own mDNS list (`adb mdns services`), read for §4.8.
 */
export const ADB_HOST_SERVICES = [
  'host:version',
  'host:track-devices-l',
  'host:devices-l',
  'host:reconnect-offline',
  'host:mdns:services',
] as const

/**
 * Host services that stop the server or change what it serves: assertAdbService refuses every
 * one of them, and a test proves it, not merely that nothing calls them. `host:kill` and
 * `host:reconnect` are never sent at all. The Wi-Fi three are sent only by connectNetwork,
 * pairNetwork and disconnectNetwork, each through its own exact check (§4.7).
 */
export const ADB_HOST_NEVER = [
  'host:kill',
  'host:disconnect:',
  'host:connect:',
  'host:pair:',
  'host:reconnect',
] as const

const TRANSPORT = 'host:transport:'
const EXEC = 'exec:'

/** Throws unless `service` is on the allowlist. The one gate every request passes. */
export function assertAdbService(service: string): void {
  if ((ADB_HOST_SERVICES as readonly string[]).includes(service)) return
  if (service.startsWith(TRANSPORT) && ID.android.test(service.slice(TRANSPORT.length))) return
  if (service.startsWith(EXEC) && ADB_EXEC.includes(service.slice(EXEC.length))) return
  throw new HelperError('INTERNAL', 500, `Refusing to send "${service}" to the adb server.`)
}

/* ---------------------------------------------------------------- wire and errors --- */

/** A request: four lowercase hex digits of length, then the ASCII payload. */
export function encodeAdbRequest(service: string): Buffer {
  const body = Buffer.from(service, 'utf8')
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body])
}

function serverStopped(): HelperError {
  return new HelperError('ADB_SERVER_STOPPED', 503, "Google's adb server isn't running.")
}

function garbled(): HelperError {
  return new HelperError('TOOL_FAILED', 502, 'The adb server answered something unexpected.')
}

/**
 * A `FAIL` reply as the page's error codes (§4.2). adbd's texts are stable across versions:
 * "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set…", "device offline",
 * "device 'X' not found", "device still authorizing", "device still connecting".
 */
export function adbFailError(message: string): HelperError {
  const text = message.trim()
  if (/^device (?:unauthorized|still authorizing)/i.test(text)) {
    return new HelperError(
      'ANDROID_UNAUTHORIZED',
      409,
      'The phone is waiting for you to allow USB debugging.',
    )
  }
  if (/^device offline/i.test(text)) {
    return new HelperError('ANDROID_OFFLINE', 409, 'The phone is not answering adb.')
  }
  if (/^device (?:'.*' )?not found/i.test(text)) {
    return new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.')
  }
  if (/^device still connecting/i.test(text)) {
    return new HelperError('DEVICE_NOT_READY', 409, 'The phone is still connecting.', {
      state: 'connecting',
      blockers: [],
    })
  }
  return new HelperError('TOOL_FAILED', 502, `adb: ${clean(text, 500) || 'request refused'}`)
}

interface Reader {
  /** Exactly `n` bytes; rejects when the socket ends first. */
  readonly read: (n: number) => Promise<Buffer>
  /** Stop reading and hand back what arrived but was not read (the socket is left paused). */
  readonly detach: () => Buffer
}

/**
 * Length-prefixed reads over a socket, for the handshake part of every exchange. The socket
 * flows only while a read is waiting: between reads it is paused, so the bytes after the
 * handshake (and the end of the stream) stay in the socket for whoever takes it over, and
 * cannot slip past before that code has attached its listeners.
 */
function createReader(socket: Socket): Reader {
  let buffered: Buffer = Buffer.alloc(0)
  let ended: Error | null = null
  let waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  const settle = (): void => {
    if (!waiter) return
    if (buffered.length >= waiter.n) {
      const { n, resolve } = waiter
      waiter = null
      socket.pause()
      const out = buffered.subarray(0, n)
      buffered = buffered.subarray(n)
      resolve(out)
    } else if (ended) {
      const { reject } = waiter
      waiter = null
      reject(ended)
    }
  }
  const onData = (chunk: Buffer): void => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
    settle()
  }
  const onEnd = (): void => {
    ended ??= garbled()
    settle()
  }
  const onError = (error: Error): void => {
    ended = error
    settle()
  }
  socket.pause()
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('close', onEnd)
  socket.on('error', onError)
  return {
    read(n) {
      return new Promise<Buffer>((resolve, reject) => {
        waiter = { n, resolve, reject }
        settle()
        if (waiter) socket.resume()
      })
    },
    detach() {
      socket.pause()
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', onError)
      const rest = buffered
      buffered = Buffer.alloc(0)
      return rest
    },
  }
}

const HEX4 = /^[0-9a-fA-F]{4}$/

async function readLength(reader: Reader): Promise<number> {
  const text = (await reader.read(4)).toString('latin1')
  if (!HEX4.test(text)) throw garbled()
  return parseInt(text, 16)
}

/** Errors made from a FAIL reply, as opposed to a socket that broke: the tracker needs to know. */
const refusals = new WeakSet<Error>()

/** The server answered FAIL (it refused), rather than going away or talking nonsense. */
export function isAdbRefusal(error: unknown): boolean {
  return error instanceof Error && refusals.has(error)
}

/** `OKAY`, or the `FAIL` message as an error. */
async function readStatus(reader: Reader): Promise<void> {
  const status = (await reader.read(4)).toString('latin1')
  if (status === 'OKAY') return
  if (status === 'FAIL') {
    const message = (await reader.read(await readLength(reader))).toString('utf8')
    const error = adbFailError(message)
    refusals.add(error)
    throw error
  }
  throw garbled()
}

/* ------------------------------------------ Wi-Fi: connect, pair, disconnect (§4.7) --- */

/**
 * An Android TV across the room has no cable, and a browser cannot open TCP: only the adb
 * server can reach a device on the network. Three host services do it, and they are exactly
 * the ones ADB_HOST_NEVER lists, because they change what the server serves. They are sent
 * for one purpose only, on the tester's explicit click: never through assertAdbService (which
 * still refuses them), only through the three senders of createAdbClient below, each with its
 * own exact-format check of the one string it may send.
 *
 * What the page may name is narrow: an address on the local network (private, link-local or
 * carrier-grade NAT IPv4, unique-local or link-local IPv6, or a `.local`, `.lan` or
 * `.home.arpa` name), a port, and a six-digit pairing code. Never a public address, never
 * loopback (that is where emulators and the adb server itself listen), never anything adb
 * would read as a second argument. Anything else is 400 BAD_REQUEST before a socket opens.
 */

/** adb's default port for `adb connect` (`adb tcpip 5555`, most TVs' "network debugging"). */
export const ADB_NETWORK_PORT = 5555

function badRequest(message: string): HelperError {
  return new HelperError('BAD_REQUEST', 400, message)
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local) and 100.64/10 (carrier-grade NAT). */
function isLocalIpv4(address: string): boolean {
  if (!IPV4.test(address)) return false
  const [a = 0, b = 0] = address.split('.').map(Number)
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** fc00::/7 (unique local) and fe80::/10 (link-local), written out or compressed. */
function isLocalIpv6(address: string): boolean {
  /** Never `::…` (unspecified, mapped IPv4) and never dotted (adb's serial could not carry it). */
  if (!net.isIPv6(address) || address.startsWith(':') || address.includes('.')) return false
  const first = parseInt(address.split(':')[0] ?? '', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

const ZONE = /^[A-Za-z0-9_-]{1,32}$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const LOCAL_SUFFIXES = ['.home.arpa', '.local', '.lan'] as const
/** A name this long still makes a serial (`name:65535`) that ID.android accepts. */
const NAME_MAX = 100

const NOT_LOCAL =
  'Only devices on your local network: an address like 192.168.1.20, or a name ending in .local, .lan or .home.arpa.'

/**
 * The host of a Wi-Fi device as the page typed it, normalised, or 400. IPv6 may come with
 * or without brackets and with a zone (`fe80::1%en0`); names are lower-cased.
 */
export function parseNetworkHost(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('Enter the device’s address.')
  let host = value.trim()
  if (host.length > 253) throw badRequest('That address is too long.')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  /** `192.168.1.20:5555` or `tv.local:5555` in the address field: the port goes on its own. */
  const withPort = /^([^:[\]]+):\d{1,5}$/.exec(host)
  if (withPort?.[1]) {
    throw badRequest(`Enter the port on its own: the address is just ${clean(withPort[1], 60)}.`)
  }
  if (host.includes(':')) {
    const at = host.indexOf('%')
    const address = at < 0 ? host : host.slice(0, at)
    const zone = at < 0 ? null : host.slice(at + 1)
    if (zone !== null && !ZONE.test(zone)) throw badRequest('That IPv6 zone is not valid.')
    if (!isLocalIpv6(address)) {
      throw badRequest(
        'Only devices on your local network: an IPv6 address in fc00::/7 or fe80::/10.',
      )
    }
    return address.toLowerCase() + (zone === null ? '' : `%${zone}`)
  }
  if (/^[\d.]+$/.test(host)) {
    if (!isLocalIpv4(host)) {
      throw badRequest(
        IPV4.test(host)
          ? 'Only devices on your local network: 10.x, 172.16–31.x, 192.168.x, 169.254.x or 100.64–127.x.'
          : 'That is not an IP address.',
      )
    }
    return host
  }
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name.length > NAME_MAX) throw badRequest('That name is too long; use the IP address.')
  const suffix = LOCAL_SUFFIXES.find((s) => name.endsWith(s))
  const labels = suffix ? name.slice(0, -suffix.length).split('.') : []
  if (!suffix || !labels.length || !labels.every((label) => LABEL.test(label))) {
    throw badRequest(NOT_LOCAL)
  }
  return name
}

/** An integer port, 1–65535, as a JSON number; `fallback` when the page sent none. */
export function parseNetworkPort(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw badRequest('The port must be a whole number from 1 to 65535.')
  }
  return value
}

/** The six digits Android's "Pair device with pairing code" shows. */
export function parsePairingCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    throw badRequest('The pairing code is the six digits the device shows.')
  }
  return value
}

/** How the lane looks a name up: every address it has (dns.lookup with `all`). */
export type HostLookup = (name: string) => Promise<readonly string[]>

const systemLookup: HostLookup = async (name) =>
  (await dns.lookup(name, { all: true, verbatim: true })).map((a) => a.address)

/**
 * adb resolves a `.local`, `.lan` or `.home.arpa` name itself, so "never public, never
 * loopback" holds for a name only if the helper looks first: a router's DNS (or /etc/hosts)
 * that maps `tv.lan` to 127.0.0.1 would otherwise send adb to an emulator's port. Every
 * address the name has must be one parseNetworkHost would take. A name that does not resolve
 * here would not resolve for adb either: `unresolved` at once, nothing sent.
 */
export async function checkResolvedName(
  host: string,
  lookup: HostLookup,
  timeoutMs: number,
  fail: (reason: NetworkFailure) => HelperError,
): Promise<void> {
  if (IPV4.test(host) || host.includes(':')) return
  let addresses: readonly string[]
  const deadline = new AbortController()
  try {
    addresses = await Promise.race([
      lookup(host),
      sleep(timeoutMs, deadline.signal).then(() => Promise.reject(new Error('lookup timed out'))),
    ])
  } catch {
    throw fail('unresolved')
  } finally {
    deadline.abort()
  }
  if (!addresses.length) throw fail('unresolved')
  for (const address of addresses) {
    const bare = address.split('%')[0] ?? ''
    if (!isLocalIpv4(bare) && !isLocalIpv6(bare)) {
      throw badRequest(
        `${host} points to ${clean(address, 60)}, which is not on your local network. Use the device’s IP address instead.`,
      )
    }
  }
}

/** `host:port` as adb writes a network serial: IPv6 in brackets (`[fe80::1%en0]:5555`). */
export function networkSerial(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${String(port)}`
}

/** A serial the server lists for a device it reaches over the network (§4.3). */
export function isNetworkSerial(serial: string): boolean {
  return ID.android.test(serial) && adbConnection(serial) === 'network'
}

/** `<host>:<port>` with a host parseNetworkHost keeps unchanged and a valid port, or null. */
function exactAddress(text: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(text)
  if (!match?.[1] || !match[2]) return null
  const raw = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1]
  try {
    const host = parseNetworkHost(raw)
    const port = parseNetworkPort(Number(match[2]))
    /** Only the canonical spelling: brackets exactly when IPv6, nothing normalised away. */
    return networkSerial(host, port) === text ? { host, port } : null
  } catch {
    return null
  }
}

function refuseToSend(service: string): HelperError {
  return new HelperError('INTERNAL', 500, `Refusing to send "${service}" to the adb server.`)
}

/** `host:connect:<host>:<port>`, and nothing else, or it throws. */
export function assertConnectService(service: string): void {
  const prefix = 'host:connect:'
  if (service.startsWith(prefix) && exactAddress(service.slice(prefix.length))) return
  throw refuseToSend(service)
}

/** `host:pair:<6 digits>:<host>:<port>`, and nothing else, or it throws. */
export function assertPairService(service: string): void {
  const match = /^host:pair:(\d{6}):(.+)$/.exec(service)
  if (match?.[2] && exactAddress(match[2])) return
  throw refuseToSend(service)
}

/**
 * A serial `host:disconnect:` can drop: `<host>:<port>` exactly as connect writes it. Not an
 * mDNS serial (`adb-…._adb-tls-connect._tcp`): adb reads that as a host on port 5555 and
 * answers "no such device", so the device would stay while the page said it went. Not
 * loopback either (`127.0.0.1:5555` is an emulator), which connect never reaches.
 */
export function isDisconnectableSerial(serial: string): boolean {
  return isNetworkSerial(serial) && exactAddress(serial) !== null
}

/**
 * `host:disconnect:<host>:<port>`, and nothing else, or it throws. An empty serial would make
 * the server drop every network device at once; a USB serial is not adb's to drop.
 */
export function assertDisconnectService(service: string): void {
  const prefix = 'host:disconnect:'
  if (service.startsWith(prefix) && isDisconnectableSerial(service.slice(prefix.length))) return
  throw refuseToSend(service)
}

/** Why a connect or a pairing failed, for the page's wording (`reason` in the error body). */
export type NetworkFailure =
  | 'refused'
  | 'blocked'
  | 'unreachable'
  | 'timeout'
  | 'unresolved'
  | 'unpaired'
  | 'wrong-code'
  | 'unsupported'
  | 'failed'

function failureOf(text: string): NetworkFailure {
  if (/failed to authenticate/i.test(text)) return 'unpaired'
  if (/refused/i.test(text)) return 'refused'
  /**
   * EHOSTUNREACH to a local address, at once: this computer never sent a packet. A VPN that
   * takes all traffic (Cloudflare WARP) answers that way, and so does macOS for a process
   * whose app has no local-network access (one started from VS Code). The address can be
   * right and the device awake: it is not `unreachable`, and "same network?" misleads.
   */
  if (/no route to host/i.test(text)) return 'blocked'
  if (/no route|unreachable|host is down|network is down/i.test(text)) return 'unreachable'
  if (/timed? ?out/i.test(text)) return 'timeout'
  if (/resolve|nodename nor servname|name or service not known/i.test(text)) return 'unresolved'
  return 'failed'
}

/**
 * adb 36 answers "failed to authenticate to X" when the device has not allowed this Mac yet:
 * the transport is registered, but unauthorized. A TV with Network debugging is then listed
 * `unauthorized` and shows "Allow debugging?"; a phone with Wireless debugging that never
 * paired drops the link instead, and is not listed.
 */
export function isAuthenticateReply(reply: HostReply): boolean {
  return /^failed to authenticate to /i.test(reply.text.trim())
}

/** One plain sentence each: what to do about it. */
const NETWORK_HINT: Record<NetworkFailure, string> = {
  refused:
    'Nothing accepted the connection there. On the device, turn on Network debugging (TV) or Wireless debugging (phone), and check the address and port.',
  blocked:
    'Something on this computer is blocking the local network. If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it. On a Mac, start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network.',
  unreachable:
    'That address cannot be reached from this Mac. Check that the device and this Mac are on the same network.',
  timeout: 'The device did not answer in time. Check that it is on, awake and on the same network.',
  unresolved: 'That name was not found on your network. Use the device’s IP address instead.',
  unpaired:
    'The device uses Wireless debugging and has not paired with this Mac yet. Pair it first with the code from “Pair device with pairing code”.',
  'wrong-code':
    'The pairing code was wrong, or the device closed the pairing screen. Try a new code.',
  unsupported:
    'This adb is too old for Wireless debugging. Update it: brew upgrade --cask android-platform-tools',
  failed: 'adb could not reach the device.',
}

export function connectFailed(target: string, reason: NetworkFailure, said = ''): HelperError {
  return new HelperError(
    'ANDROID_CONNECT_FAILED',
    502,
    `Could not connect to ${target}. ${NETWORK_HINT[reason]}`,
    { reason, ...(said ? { detail: clean(said, 300) } : {}) },
  )
}

export function pairFailed(target: string, reason: NetworkFailure, said = ''): HelperError {
  return new HelperError(
    'ANDROID_PAIR_FAILED',
    502,
    `Could not pair with ${target}. ${NETWORK_HINT[reason]}`,
    { reason, ...(said ? { detail: clean(said, 300) } : {}) },
  )
}

/**
 * The terminal lines for a failed connect or pairing: `head` alone, except for `blocked`,
 * whose two likely causes each get an indented line with its fix, the way a blocker does.
 * The macOS one only on a Mac.
 */
export function networkFailureLines(
  head: string,
  error: HelperError,
  platform: NodeJS.Platform,
): string[] {
  if (error.extra.reason !== 'blocked') return [head]
  return blockedLines(head, 'no route to host', platform)
}

/**
 * `head`, what the socket said (`cause`), and the two likely culprits with their fixes, each
 * on an indented line: shared by a connect or pairing that was refused at once (§4.7) and a
 * scan whose queries could not leave (§4.8).
 */
export function blockedLines(head: string, cause: string, platform: NodeJS.Platform): string[] {
  return [
    `${head}: ${cause}, so this computer can't reach the local network`,
    '  If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it',
    ...(platform === 'darwin'
      ? [
          '  macOS may not let the app that started the helper (VS Code, some terminals) use the local network: start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network',
        ]
      : []),
  ]
}

/** A host service's answer as text: `ok` is false when it came as FAIL. */
export interface HostReply {
  ok: boolean
  text: string
}

/**
 * The server's answer to `host:connect:` (adb 30–36): "connected to X", "already connected to
 * X", or a failure in one of several spellings ("failed to connect to 'X': Connection refused",
 * "cannot connect to X: No route to host (65)", "unable to connect to X", "failed to
 * authenticate to X", "failed to resolve host…"). Failures arrive as OKAY with that text, or
 * as FAIL; both mean the same here.
 */
export function parseConnectReply(
  reply: HostReply,
  target: string,
): { result: 'connected' | 'already-connected'; serial: string; message: string } {
  const said = reply.text.trim()
  const ok = reply.ok ? /^(already )?connected to (\S+)$/.exec(said) : null
  if (ok?.[2]) {
    const serial = ID.android.test(ok[2]) ? ok[2] : target
    return { result: ok[1] ? 'already-connected' : 'connected', serial, message: clean(said, 300) }
  }
  throw connectFailed(target, failureOf(said), said)
}

/**
 * The answer to `host:pair:` (adb 30+): "Successfully paired to X [guid=adb-…]", or
 * "Failed: Wrong password or connection was dropped." and other "Failed: …" texts. A server
 * older than Wireless debugging answers FAIL "unknown host service".
 */
export function parsePairReply(reply: HostReply, target: string): { message: string } {
  const said = reply.text.trim()
  if (reply.ok && /^Successfully paired to /.test(said)) return { message: clean(said, 300) }
  if (/wrong password|connection was dropped/i.test(said)) {
    throw pairFailed(target, 'wrong-code', said)
  }
  if (/unknown host service|invalid pairing request/i.test(said)) {
    throw pairFailed(target, 'unsupported', said)
  }
  throw pairFailed(target, failureOf(said), said)
}

/** The answer to `host:disconnect:`: OKAY "disconnected X", or FAIL "no such device 'X'". */
export function parseDisconnectReply(reply: HostReply): { message: string } {
  const said = reply.text.trim()
  if (reply.ok && /^disconnected /.test(said)) return { message: clean(said, 300) }
  if (/^no such device/i.test(said)) {
    throw new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.')
  }
  throw new HelperError('TOOL_FAILED', 502, `adb: ${clean(said, 500) || 'request refused'}`)
}

/* -------------------------------------------------------------------- the client --- */

export interface AdbClientOptions {
  port: number
  timeouts: Timeouts
}

export interface ExecOptions {
  signal?: AbortSignal
  maxBytes?: number
  timeoutMs?: number
}

export interface AdbClient {
  /** `host:version` → the server's protocol, or null when nothing listens. */
  readonly version: (signal?: AbortSignal) => Promise<number | null>
  /**
   * `host:track-devices-l`: `onList` gets the full `devices -l` text at once and on every
   * change; `onEnd` once, when the socket ends (a FAIL reply comes as its HelperError).
   * Returns the function that closes it.
   */
  readonly track: (
    onList: (text: string) => void,
    onEnd: (error: Error | null) => void,
  ) => () => void
  readonly devicesL: (signal?: AbortSignal) => Promise<string>
  /** `host:transport:<serial>`, then `exec:<cmd>` (cmd in ADB_EXEC): every byte until EOF. */
  readonly exec: (serial: string, cmd: string, opts?: ExecOptions) => Promise<Buffer>
  /**
   * The same handshake, then the socket itself, paused, for a stream the caller reads and
   * destroys (logcat). The abort signal destroys it too.
   */
  readonly execStream: (serial: string, cmd: string, signal: AbortSignal) => Promise<Socket>
  readonly reconnectOffline: (signal?: AbortSignal) => Promise<void>
  /** `host:mdns:services`: the server's own mDNS list, as text (§4.8). */
  readonly mdnsServices: (signal?: AbortSignal) => Promise<string>
  /**
   * §4.7, on an explicit click only. Each sends one exact string (assertConnectService,
   * assertPairService, assertDisconnectService) and returns adb's text, whether it came with
   * OKAY or FAIL: the server reports most failures as OKAY plus a sentence.
   */
  readonly connectNetwork: (
    host: string,
    port: number,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ) => Promise<HostReply>
  readonly pairNetwork: (
    code: string,
    host: string,
    port: number,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ) => Promise<HostReply>
  readonly disconnectNetwork: (serial: string, signal?: AbortSignal) => Promise<HostReply>
  /** Destroy every socket still open: shutdown. */
  readonly close: () => void
}

/**
 * The adb host protocol (§4.2). Each call opens its own socket: the server answers one host
 * service per connection, and a transport switch binds the socket to one device for good.
 */
export function createAdbClient(opts: AdbClientOptions): AdbClient {
  const { port, timeouts } = opts
  const open = new Set<Socket>()

  /**
   * One exchange on a fresh socket, under a deadline and the caller's signal. The socket is
   * destroyed afterwards unless `talk` hands it over (`keep`). A refused connect means no
   * server: ADB_SERVER_STOPPED, which version() turns into null.
   */
  function exchange<T>(
    talk: (socket: Socket, reader: Reader, keep: () => void) => Promise<T>,
    o: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<T> {
    const deadline = linkSignals([o.signal], o.timeoutMs)
    const socket = net.connect({ host: '127.0.0.1', port })
    open.add(socket)
    socket.once('close', () => open.delete(socket))
    let kept = false
    const failure = (): Error =>
      o.signal?.aborted
        ? abortError()
        : new HelperError('TOOL_TIMEOUT', 504, 'The adb server took too long to answer.')
    const connectTimer = setTimeout(() => {
      if (socket.connecting) socket.destroy(failure())
    }, timeouts.adbConnect)
    const onAbort = (): void => {
      socket.destroy(failure())
    }
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    /** The handshake is done and the socket lives on (tracker, logcat): no deadline any more. */
    const keep = (): void => {
      kept = true
      clearTimeout(connectTimer)
      deadline.signal.removeEventListener('abort', onAbort)
      deadline.dispose()
    }
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        clearTimeout(connectTimer)
        resolve()
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ECONNREFUSED' ? serverStopped() : error)
      })
    })
    connected.catch(() => undefined)
    const reader = createReader(socket)
    if (deadline.signal.aborted) onAbort()
    return connected
      .then(() => talk(socket, reader, keep))
      .catch((error: unknown) => {
        /** A destroyed socket rejects with the reason it was destroyed for, or a plain close. */
        if (deadline.signal.aborted) throw failure()
        if (error instanceof HelperError || (error instanceof Error && error.name === 'AbortError'))
          throw error
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE')
          throw serverStopped()
        throw new HelperError('TOOL_FAILED', 502, `adb server: ${errorText(error)}`)
      })
      .finally(() => {
        clearTimeout(connectTimer)
        deadline.signal.removeEventListener('abort', onAbort)
        deadline.dispose()
        if (!kept) socket.destroy()
      })
  }

  const send = (socket: Socket, service: string): void => {
    assertAdbService(service)
    socket.write(encodeAdbRequest(service))
  }

  /** A host service whose OKAY carries one length-prefixed payload. */
  const query = (service: string, signal?: AbortSignal): Promise<string> =>
    exchange(
      async (socket, reader) => {
        send(socket, service)
        await readStatus(reader)
        return (await reader.read(await readLength(reader))).toString('utf8')
      },
      { signal, timeoutMs: timeouts.adbRequest },
    )

  /**
   * One of the three Wi-Fi services (§4.7): checked by its own assert, never by
   * assertAdbService, and answered with a length-prefixed text after OKAY or FAIL alike.
   */
  const hostText = (
    service: string,
    check: (service: string) => void,
    o: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<HostReply> => {
    try {
      check(service)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return exchange(async (socket, reader) => {
      socket.write(encodeAdbRequest(service))
      const status = (await reader.read(4)).toString('latin1')
      if (status !== 'OKAY' && status !== 'FAIL') throw garbled()
      const text = (await reader.read(await readLength(reader))).toString('utf8')
      return { ok: status === 'OKAY', text }
    }, o)
  }

  /** `host:transport:<serial>` then `exec:<cmd>`, both answered OKAY. */
  const handshake = async (
    socket: Socket,
    reader: Reader,
    serial: string,
    cmd: string,
  ): Promise<void> => {
    send(socket, TRANSPORT + serial)
    await readStatus(reader)
    send(socket, EXEC + cmd)
    await readStatus(reader)
  }

  return {
    async version(signal) {
      try {
        const payload = await query('host:version', signal)
        if (!HEX4.test(payload)) throw garbled()
        return parseInt(payload, 16)
      } catch (error) {
        if (error instanceof HelperError && error.code === 'ADB_SERVER_STOPPED') return null
        throw error
      }
    },

    track(onList, onEnd) {
      const stop = new AbortController()
      let ended = false
      const finish = (error: Error | null): void => {
        if (ended) return
        ended = true
        onEnd(error)
      }
      exchange(
        async (socket, reader, keep) => {
          send(socket, 'host:track-devices-l')
          await readStatus(reader)
          /** From here on the socket lives as long as the server, or until close(). */
          keep()
          stop.signal.addEventListener('abort', () => socket.destroy(), { once: true })
          try {
            for (;;) {
              const text = (await reader.read(await readLength(reader))).toString('utf8')
              if (stop.signal.aborted) return
              onList(text)
            }
          } catch {
            /** However it ended (the server stopped, or sent garbage), the tracker is over. */
          } finally {
            socket.destroy()
          }
        },
        { timeoutMs: timeouts.adbRequest },
      ).then(
        () => finish(null),
        (error: unknown) => {
          if (stop.signal.aborted) return finish(null)
          finish(error instanceof Error ? error : new Error(String(error)))
        },
      )
      return () => {
        stop.abort()
        finish(null)
      }
    },

    devicesL: (signal) => query('host:devices-l', signal),

    exec(serial, cmd, o = {}) {
      const maxBytes = o.maxBytes ?? LIMITS.text
      /** Refused before any socket opens: an off-list command never reaches the server. */
      try {
        assertAdbService(TRANSPORT + serial)
        assertAdbService(EXEC + cmd)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return exchange(
        async (socket, reader) => {
          await handshake(socket, reader, serial, cmd)
          const chunks: Buffer[] = []
          let length = 0
          return new Promise<Buffer>((resolve, reject) => {
            const take = (chunk: Buffer): void => {
              length += chunk.length
              if (length > maxBytes) {
                socket.destroy(
                  new HelperError(
                    'TOOL_FAILED',
                    502,
                    'The phone sent more than the helper accepts.',
                  ),
                )
              } else chunks.push(chunk)
            }
            /** Bytes that came with the handshake's last packet count against the cap too. */
            take(reader.detach())
            socket.on('data', take)
            socket.on('end', () => resolve(Buffer.concat(chunks)))
            socket.on('error', reject)
            socket.on('close', () => reject(garbled()))
            socket.resume()
          })
        },
        { signal: o.signal, timeoutMs: o.timeoutMs ?? timeouts.adbExec },
      )
    },

    execStream(serial, cmd, signal) {
      try {
        assertAdbService(TRANSPORT + serial)
        assertAdbService(EXEC + cmd)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return exchange(
        async (socket, reader, keep) => {
          await handshake(socket, reader, serial, cmd)
          const rest = reader.detach()
          if (rest.length) socket.unshift(rest)
          /** Until the caller listens, an error must not become an uncaught exception. */
          socket.on('error', () => undefined)
          keep()
          if (signal.aborted) socket.destroy()
          else signal.addEventListener('abort', () => socket.destroy(), { once: true })
          return socket
        },
        { signal, timeoutMs: timeouts.adbRequest },
      )
    },

    reconnectOffline(signal) {
      return exchange(
        async (socket, reader) => {
          send(socket, 'host:reconnect-offline')
          await readStatus(reader)
        },
        { signal, timeoutMs: timeouts.adbRequest },
      )
    },

    mdnsServices: (signal) => query('host:mdns:services', signal),

    connectNetwork: (host, port, o) =>
      hostText(`host:connect:${networkSerial(host, port)}`, assertConnectService, o),

    pairNetwork: (code, host, port, o) =>
      hostText(`host:pair:${code}:${networkSerial(host, port)}`, assertPairService, o),

    disconnectNetwork: (serial, signal) =>
      hostText(`host:disconnect:${serial}`, assertDisconnectService, {
        signal,
        timeoutMs: timeouts.adbRequest,
      }),

    close() {
      for (const socket of open) socket.destroy()
      open.clear()
    },
  }
}

/* ------------------------------------------------------------------ devices -l text --- */

export interface DevicesLRow {
  serial: string
  /** adb's state word, or the whole `no permissions (…)` sentence. */
  state: string
  props: Record<string, string>
}

/** Longest first, so `no permissions` wins over a shorter word it might start with. */
const ADB_STATES = [
  'no permissions',
  'unauthorized',
  'authorizing',
  'connecting',
  'bootloader',
  'recovery',
  'sideload',
  'detached',
  'offline',
  'unknown',
  'rescue',
  'device',
  'host',
]

/** Where the `key:value` properties begin after a state with spaces in it. */
const FIRST_PROP = /\s(?:usb|product|model|device|transport_id|features):/

/**
 * `adb devices -l` text, as the server sends it (no "List of devices attached" header):
 * `<serial padded to 22> <state> usb:1-1 product:tokay model:Pixel_9 device:tokay transport_id:3`.
 * The state is the longest known one the rest starts with: `no permissions (…); see […]`
 * has spaces, parentheses and even a URL in it, and is cut where the properties begin.
 */
export function parseDevicesL(text: string): DevicesLRow[] {
  const rows: DevicesLRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('*') || line.startsWith('List of devices')) continue
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const serial = match[1] ?? ''
    const rest = match[2] ?? ''
    const known = ADB_STATES.find((s) => rest === s || rest.startsWith(s + ' '))
    let state: string
    let props: string
    if (known === 'no permissions') {
      const at = rest.search(FIRST_PROP)
      state = (at < 0 ? rest : rest.slice(0, at)).trim()
      props = at < 0 ? '' : rest.slice(at)
    } else if (known) {
      state = known
      props = rest.slice(known.length)
    } else {
      /** A state this helper does not know yet: its first word, mapped to `unknown`. */
      state = rest.split(/\s+/)[0] ?? ''
      props = rest.slice(state.length)
    }
    const record: Record<string, string> = {}
    for (const token of props.trim().split(/\s+/)) {
      const colon = token.indexOf(':')
      if (colon > 0) record[token.slice(0, colon)] = token.slice(colon + 1)
    }
    rows.push({ serial, state, props: record })
  }
  return rows
}

/** §4.3: adb's state → the row's state and its blockers. */
export function mapAdbState(state: string): { state: HelperState; blockers: string[] } {
  switch (state) {
    case 'device':
      return { state: 'ready', blockers: [] }
    case 'unauthorized':
      return { state: 'unauthorized', blockers: ['ANDROID_UNAUTHORIZED'] }
    case 'authorizing':
      return { state: 'authorizing', blockers: ['ANDROID_UNAUTHORIZED'] }
    case 'connecting':
      return { state: 'connecting', blockers: [] }
    case 'offline':
      return { state: 'offline', blockers: ['ANDROID_OFFLINE'] }
    case 'recovery':
    case 'rescue':
    case 'sideload':
    case 'bootloader':
      return { state: 'recovery', blockers: ['ANDROID_RECOVERY'] }
    default:
      return { state: 'unknown', blockers: [] }
  }
}

/** §4.3: emulators are the Android side of `simulator`; `ip:port` and mDNS serials are Wi-Fi. */
export function adbConnection(serial: string): Connection {
  if (/^emulator-\d+$/.test(serial)) return 'simulator'
  if (/:\d+$/.test(serial) || /\._adb(?:-tls-connect)?\._tcp/.test(serial)) return 'network'
  return 'usb'
}

/** What three getprop calls say about a phone; '' where one failed. */
export interface AdbIdentity {
  model: string
  device: string
  release: string
}

/** One devices -l row as the page sees it. */
export function androidRow(entry: DevicesLRow, identity: AdbIdentity | null): HelperDevice {
  const { state, blockers } = mapAdbState(entry.state)
  const ready = state === 'ready'
  /** The tracker's `model:` has spaces turned into underscores (adb sanitises it). */
  const listed = (entry.props.model ?? '').replace(/_/g, ' ')
  const model = identity?.model || listed
  return {
    id: entry.serial,
    platform: 'android',
    connection: adbConnection(entry.serial),
    state,
    name: model,
    model,
    modelId: identity?.device || entry.props.device || '',
    osVersion: identity?.release ?? '',
    blockers,
    capabilities: { screenshot: ready, identifiers: ready, logs: ready, install: false },
  }
}

/* ------------------------------------------------------ Wi-Fi: discovery (§4.8) --- */

/**
 * Which Android devices on this network offer adb, before anything connects to them: the
 * answer to "have you listed every Android device on the Wi-Fi?". adb lists only what it is
 * connected to, so the helper asks the network itself (mdns.ts, read-only queries) and adds
 * what the adb server found on its own (`host:mdns:services`), then marks each one adb
 * already lists. It never connects, pairs or starts a server for this: the page offers those
 * as the tester's own clicks (§4.7).
 *
 * What is offered goes through the same rules as POST /api/android/connect: an address on
 * the local network (parseNetworkHost), never a name (adbd advertises `Android.local` on
 * many devices at once), never public or loopback, and never a link-local IPv6 address,
 * which adb could not reach without the interface the answer came in on.
 */

/** The services that offer adb, by the kind the page shows (§4.8). */
export const ADB_SERVICES: Readonly<Record<NearbyKind, string>> = {
  adb: '_adb._tcp.local',
  wireless: '_adb-tls-connect._tcp.local',
  pairing: '_adb-tls-pairing._tcp.local',
}

/**
 * Browsed only to put a name on an address: Android TV Remote's instance name is the TV's
 * name ("SONY KD-43X8050H"), and Cast's TXT `fn=` is the name the owner gave it.
 */
export const NAME_SERVICES = {
  remote: '_androidtvremote2._tcp.local',
  cast: '_googlecast._tcp.local',
} as const

/** Everything one scan asks for. */
export const NEARBY_SERVICES: readonly string[] = [
  ...Object.values(ADB_SERVICES),
  NAME_SERVICES.remote,
  NAME_SERVICES.cast,
]

/** One adb service found on the network, before it is compared with what adb lists. */
export interface FoundService {
  kind: NearbyKind
  host: string
  port: number
  instance: string
  /** From its TXT record, when it has one (adbd 13+): `given_name=`, `name=`, `serial=`, `api=`. */
  name?: string
  model?: string
  serial?: string
  osVersion?: string
  /** From adb's own mDNS list (`host:mdns:services`), which may still hold an old address. */
  fromAdb?: true
}

/** A name for an address, and whether a TV service (Remote or Cast) is there. */
export interface NearbyName {
  name: string
  tv: boolean
}

const KIND_OF_SERVICE = new Map<string, NearbyKind>(
  (Object.entries(ADB_SERVICES) as Array<[NearbyKind, string]>).map(([kind, s]) => [s, kind]),
)

/** `_adb-tls-connect._tcp`, with or without `.local` and a trailing dot, as a kind. */
function kindOfService(service: string): NearbyKind | undefined {
  let name = service.trim().toLowerCase().replace(/\.$/, '')
  if (!name.endsWith('.local')) name += '.local'
  return KIND_OF_SERVICE.get(name)
}

/**
 * An address a device may be offered at: an IP address parseNetworkHost takes, minus
 * link-local IPv6 (no zone travels in an mDNS answer). Normalised, or null.
 */
export function offerableAddress(address: string): string | null {
  if (!IPV4.test(address) && !net.isIPv6(address)) return null
  if (/^fe[89ab]/i.test(address)) return null
  try {
    return parseNetworkHost(address)
  } catch {
    return null
  }
}

const validPort = (port: number | null): port is number =>
  port !== null && Number.isInteger(port) && port >= 1 && port <= 65535

const cleanInstance = (instance: string): string => clean(instance, LIMITS.field).trim()

const nameOf = (service: string): string => service.toLowerCase().replace(/\.$/, '')

/** Android's version names by API level, before the version became the level minus 20 (33 → 13). */
const ANDROID_RELEASE: Readonly<Record<number, string>> = {
  21: '5.0',
  22: '5.1',
  23: '6.0',
  24: '7.0',
  25: '7.1',
  26: '8.0',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12L',
}

/** TXT `api=37.1` (adbd's SDK level and minor) as the Android version: "17". */
export function androidVersionOfApi(api: string): string | undefined {
  const m = /^(\d{2})(?:\.\d{1,3})?$/.exec(api.trim())
  const level = Number(m?.[1])
  if (!m || level < 21 || level > 60) return undefined
  return ANDROID_RELEASE[level] ?? String(level - 20)
}

/**
 * What an adb service's TXT says about the device. adbd 13+ advertises Wireless debugging
 * with `given_name=BAULOC Pixel 9 serial=55090DLAQ0026D v=2.1 api=37.1 name=Pixel 9`: the
 * name its owner gave it, the serial, and the model.
 */
export function adbTxtDetails(
  txt: readonly string[],
): Pick<FoundService, 'name' | 'model' | 'serial' | 'osVersion'> {
  const value = (key: string): string => {
    const entry = txt.find((t) => t.slice(0, key.length + 1).toLowerCase() === `${key}=`)
    return entry === undefined ? '' : clean(entry.slice(key.length + 1), LIMITS.name).trim()
  }
  const name = value('given_name')
  const model = value('name')
  const serial = value('serial')
  const osVersion = androidVersionOfApi(value('api'))
  return {
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(/^[A-Za-z0-9._-]{1,64}$/.test(serial) ? { serial } : {}),
    ...(osVersion ? { osVersion } : {}),
  }
}

/** The adb services a browse found, with an address to offer, and names by address. */
export function nearbyFromBrowse(instances: readonly ServiceInstance[]): {
  found: FoundService[]
  names: Map<string, NearbyName>
} {
  const found: FoundService[] = []
  const names = new Map<string, NearbyName>()
  for (const entry of instances) {
    const service = nameOf(entry.service)
    if (service === NAME_SERVICES.cast || service === NAME_SERVICES.remote) {
      const fn = entry.txt.find((t) => /^fn=/i.test(t))?.slice(3)
      const name = clean(service === NAME_SERVICES.cast ? (fn ?? '') : entry.instance, LIMITS.name)
      for (const address of entry.addresses) {
        const host = offerableAddress(address)
        if (!host) continue
        const known = names.get(host)?.name ?? ''
        /** Cast's fn= is the owner's own name for it: it wins over the Remote's model name. */
        const better = !known || (service === NAME_SERVICES.cast && !!name.trim())
        names.set(host, { name: better ? name.trim() : known, tv: true })
      }
      continue
    }
    const kind = KIND_OF_SERVICE.get(service)
    const instance = cleanInstance(entry.instance)
    const host = entry.addresses.map(offerableAddress).find((a): a is string => a !== null)
    if (!kind || !instance || !host || !validPort(entry.port)) continue
    found.push({ kind, host, port: entry.port, instance, ...adbTxtDetails(entry.txt) })
  }
  return { found, names }
}

/**
 * `adb mdns services` as the server sends it, after OKAY and the length: one service per
 * line, `<instance>\t<service type>\t<address>:<port>` (adb 30–36; some versions end the
 * type with a dot). Only the adb services, at an address offerableAddress() takes.
 */
export function parseAdbMdnsServices(text: string): FoundService[] {
  const found: FoundService[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^List of/i.test(line)) continue
    const tabbed = line.split('\t')
    const parts = tabbed.length >= 3 ? tabbed : line.split(/\s+/)
    const instance = cleanInstance(parts[0] ?? '')
    const kind = kindOfService(parts[1] ?? '')
    const match = /^(\[[^\]]+\]|[^\s[\]]+):(\d{1,5})$/.exec((parts[parts.length - 1] ?? '').trim())
    if (!kind || !instance || parts.length < 3 || !match?.[1] || !match[2]) continue
    const raw6 = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1]
    const host = offerableAddress(raw6)
    const port = Number(match[2])
    if (host && validPort(port)) found.push({ kind, host, port, instance, fromAdb: true })
  }
  return found
}

/**
 * The serial an adb instance name carries: adbd names its services `adb-<ro.serialno>`,
 * with `-<6 random characters>` for Wireless debugging (`adb-55090DLAQ0026D-nK25Qn`).
 */
export function serialOfInstance(instance: string): string | undefined {
  return /^adb-([A-Za-z0-9]{4,64})(?:-[A-Za-z0-9]{6})?$/.exec(instance)?.[1]
}

/**
 * Serials many devices share, so they tell nothing apart: the placeholder ro.serialno cheap
 * TV boxes ship with, and what a build without one reports.
 */
const JUNK_SERIALS: ReadonlySet<string> = new Set([
  '0123456789abcdef',
  '0000000000000000',
  'unknown',
])

/** A serial that names one device (lower case), else undefined. */
function distinctSerial(serial: string | undefined): string | undefined {
  const key = serial?.trim().toLowerCase()
  return key && !JUNK_SERIALS.has(key) ? key : undefined
}

/** The instance in an mDNS serial adb lists (`adb-…._adb-tls-connect._tcp`), else null. */
function instanceOfSerial(serial: string): string | null {
  return /^(.+?)\._adb(?:-tls-connect)?\._tcp\.?$/i.exec(serial)?.[1] ?? null
}

/** The host of a `host:port` network serial (IPv6 without its brackets), else null. */
function hostOfSerial(serial: string): string | null {
  const match = /^(\[[^\]]+\]|[^:[\]]+):\d{1,5}$/.exec(serial)
  if (!match?.[1]) return null
  return match[1].startsWith('[') ? match[1].slice(1, -1).toLowerCase() : match[1].toLowerCase()
}

const KIND_ORDER: Record<NearbyKind, number> = { adb: 0, wireless: 1, pairing: 2 }

/** IPv4 by number, then IPv6 as text: the order a tester reads a network in. */
function hostOrder(host: string): string {
  if (!IPV4.test(host)) return `1${host}`
  return `0${host
    .split('.')
    .map((n) => n.padStart(3, '0'))
    .join('.')}`
}

/**
 * Each service once, the first source's entry winning: by kind and address, by kind and
 * instance, and by kind and serial (Wireless debugging renames its instance each time it is
 * turned on, and adb may still list the old one). The serial counts only on the same host,
 * or when one of the two comes from adb's own list (which may keep an old address too):
 * two cheap TV boxes at different addresses may share one ro.serialno, and a junk serial
 * (`0123456789ABCDEF`, `unknown`) never counts. What a later duplicate adds (a TXT name the
 * first source lacked) fills in what the first one left empty.
 */
export function uniqueServices(found: readonly FoundService[]): FoundService[] {
  const out: FoundService[] = []
  const byKey = new Map<string, FoundService>()
  /** kind#serial → the first entry with it from any source / from adb's list. */
  const anySerial = new Map<string, FoundService>()
  const adbSerial = new Map<string, FoundService>()
  for (const f of found) {
    const serial = distinctSerial(serialOfInstance(f.instance) ?? f.serial)
    const wide = serial ? `${f.kind}#${serial}` : null
    const keys = [
      `${f.kind}@${networkSerial(f.host, f.port)}`,
      `${f.kind}|${f.instance.toLowerCase()}`,
      ...(wide ? [`${wide}@${f.host.toLowerCase()}`] : []),
    ]
    const kept =
      keys.map((key) => byKey.get(key)).find((k) => k !== undefined) ??
      (wide ? (f.fromAdb ? anySerial : adbSerial).get(wide) : undefined)
    const entry = kept ?? { ...f }
    if (kept) {
      kept.name ||= f.name
      kept.model ||= f.model
      kept.serial ||= f.serial
      kept.osVersion ||= f.osVersion
    } else out.push(entry)
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, entry)
    if (wide && !anySerial.has(wide)) anySerial.set(wide, entry)
    if (wide && f.fromAdb && !adbSerial.has(wide)) adbSerial.set(wide, entry)
  }
  /** `||=` may have written `undefined` or '' into an optional field. */
  for (const f of out) {
    for (const key of ['name', 'model', 'serial', 'osVersion'] as const) if (!f[key]) delete f[key]
    delete f.fromAdb
  }
  return out
}

/**
 * What the page gets: each found service once (uniqueServices), named, and compared with
 * the rows adb lists now. A row matches by this host:port, by its mDNS name, by the serial
 * (a phone on a cable is "connected" too, and its row is named), or, for Wireless debugging,
 * by a network row on the same host (the pairing port is not the connect port). Ordered by
 * address, at most `max`.
 */
export function mergeNearby(
  found: readonly FoundService[],
  names: ReadonlyMap<string, NearbyName>,
  listed: readonly DevicesLRow[],
  max: number = LIMITS.nearby,
): AndroidNearbyDevice[] {
  const rows = listed.filter((row) => ID.android.test(row.serial))
  const out: AndroidNearbyDevice[] = []
  for (const f of uniqueServices(found)) {
    const address = networkSerial(f.host, f.port)
    const id = `${f.kind}:${address}`
    const serial = serialOfInstance(f.instance) ?? f.serial
    /** A junk serial (shared by many boxes) never matches a row. */
    const matchSerial = distinctSerial(serial) ? serial : undefined
    const network = rows.filter((row) => adbConnection(row.serial) === 'network')
    const mdnsMatch = (row: DevicesLRow): boolean => {
      const instance = instanceOfSerial(row.serial)
      if (!instance) return false
      return (
        instance.toLowerCase() === f.instance.toLowerCase() ||
        (!!matchSerial && serialOfInstance(instance) === matchSerial)
      )
    }
    const overNetwork =
      network.find((row) => row.serial === address) ??
      network.find(mdnsMatch) ??
      (f.kind === 'adb' ? undefined : network.find((row) => hostOfSerial(row.serial) === f.host))
    const row =
      overNetwork ?? (matchSerial ? rows.find((r) => r.serial === matchSerial) : undefined)
    const named = names.get(f.host)
    out.push({
      id,
      host: f.host,
      port: f.port,
      kind: f.kind,
      instance: f.instance,
      /** The device's own name (TXT given_name) first: Cast's fn= is for a TV without one. */
      name: f.name || (named?.name ?? ''),
      ...(f.model ? { model: f.model } : {}),
      ...(f.osVersion ? { osVersion: f.osVersion } : {}),
      ...(serial ? { serial } : {}),
      tv: named?.tv ?? false,
      connected: !!row,
      ...(row ? { deviceId: row.serial } : {}),
      ...(f.kind === 'adb' ? {} : { paired: !!overNetwork }),
    })
  }
  out.sort(
    (a, b) =>
      hostOrder(a.host).localeCompare(hostOrder(b.host)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.port - b.port,
  )
  return out.slice(0, max)
}

/** The page's wording for a scan that could not run, when it has none of its own. */
const NEARBY_MESSAGE: Record<NearbyFailure, string> = {
  blocked: `Could not look for devices on the network. ${NETWORK_HINT.blocked}`,
  'no-network':
    'Could not look for devices on the network: this computer is not connected to one. Turn on Wi-Fi, or plug in a network cable, on the same network as the device.',
  failed: 'Could not look for devices on the network.',
}

/** The page's wording for a scan the system resolver did instead of the helper's own queries. */
const NEARBY_NOTE =
  "Looked through this computer's own resolver: the helper's own queries could not reach the network. Connecting may be refused for the same reason; if it is, the helper says how to fix it."

/** One scan: the network's answers and adb's own list, as found. */
export interface NearbyScan {
  startedAt: number
  found: FoundService[]
  names: Map<string, NearbyName>
  error?: AndroidNearbyResult['error']
  note?: AndroidNearbyResult['note']
  /** The system resolver's tool, when it looked: for --doctor. */
  system: SystemBrowseResult['tool'] | null
  /**
   * Why the system resolver could not look either, beside an `error` ("dns-sd exited with
   * code 1: DNSServiceBrowse failed -65563"); `error.detail` ends with it too.
   */
  systemDetail?: string
}

export interface ScanOptions {
  open: OpenMdnsTransport
  windowMs: number
  signal?: AbortSignal
  now: () => number
  /** `host:mdns:services` when a server runs, else ''. Never starts one. */
  adbList: () => Promise<string>
  /** The system resolver's browse (mdns.ts systemBrowse()); absent: none. */
  system?: (signal?: AbortSignal) => Promise<SystemBrowseResult>
}

const NO_SYSTEM: SystemBrowseResult = { tool: null, looked: false, instances: [] }

/**
 * Three sources at once: the helper's own queries (mdns.ts), the system's resolver
 * (mdns.ts systemBrowse(): dns-sd, avahi-browse) and adb's own mDNS list, merged in that order
 * (mergeNearby keeps the first of each service and fills in names from the others).
 *
 * `error` only when no source could look: neither the helper's queries left nor the system
 * resolver reached its daemon. adb's list does not count: whether its own mDNS works says
 * nothing that can be checked from here. When the resolver looked although the helper's
 * queries could not leave, the scan is complete and `note` says that connecting may still be
 * refused; a connect that is says so itself, with the `blocked` wording (§4.7).
 */
export async function scanNearby(o: ScanOptions): Promise<NearbyScan> {
  const startedAt = o.now()
  const [browsed, system, adbText] = await Promise.all([
    browse({
      services: NEARBY_SERVICES,
      open: o.open,
      windowMs: o.windowMs,
      signal: o.signal,
    }),
    (o.system?.(o.signal) ?? Promise.resolve(NO_SYSTEM)).catch(() => NO_SYSTEM),
    o.adbList().catch(() => ''),
  ])
  const { found, names } = nearbyFromBrowse([...browsed.instances, ...system.instances])
  const failure = browsed.failure
  const said = failure
    ? {
        reason: failure.reason,
        message: system.looked ? NEARBY_NOTE : NEARBY_MESSAGE[failure.reason],
        detail: failure.detail,
      }
    : null
  /** Both sources failed: the resolver's own words go beside the socket's. */
  const systemDetail = said && !system.looked && system.detail ? system.detail : undefined
  return {
    startedAt,
    found: [...found, ...parseAdbMdnsServices(adbText)],
    names,
    system: system.looked ? system.tool : null,
    ...(said && !system.looked
      ? {
          error: systemDetail ? { ...said, detail: `${said.detail}; ${systemDetail}` } : said,
        }
      : {}),
    ...(systemDetail ? { systemDetail } : {}),
    ...(said && system.looked ? { note: said } : {}),
  }
}

/** The system resolver for a lane: the tool this computer has, through the bridge's runner. */
export function systemResolver(
  ctx: Pick<LaneContext, 'options' | 'streamTool' | 'timeouts'>,
): (signal?: AbortSignal) => Promise<SystemBrowseResult> {
  return (signal) =>
    systemBrowse({
      services: NEARBY_SERVICES,
      tools: systemMdnsTools(ctx.options),
      streamTool: ctx.streamTool,
      browseMs: ctx.timeouts.systemBrowse,
      resolveMs: ctx.timeouts.systemResolve,
      signal,
    })
}

/** The terminal's one line for what a scan found: one device per address. */
export function nearbySummary(devices: readonly AndroidNearbyDevice[]): string {
  const hosts = new Map<string, { tv: boolean; wireless: boolean; connected: boolean }>()
  for (const d of devices) {
    const entry = hosts.get(d.host) ?? { tv: false, wireless: false, connected: false }
    entry.tv ||= d.tv
    entry.wireless ||= d.kind !== 'adb'
    entry.connected ||= d.connected
    hosts.set(d.host, entry)
  }
  if (!hosts.size) {
    return 'Wi-Fi: no Android device on this network advertises Network or Wireless debugging'
  }
  const all = [...hosts.values()]
  const tvs = all.filter((h) => h.tv).length
  const wireless = all.filter((h) => !h.tv && h.wireless).length
  const network = all.length - tvs - wireless
  const parts = [
    tvs ? plural(tvs, 'TV') : '',
    wireless ? `${String(wireless)} with Wireless debugging` : '',
    network ? `${String(network)} with Network debugging` : '',
  ].filter(Boolean)
  const connected = all.filter((h) => h.connected).length
  return `Wi-Fi: ${plural(hosts.size, 'Android device')} on this network (${parts.join(', ')})${
    connected ? `, ${String(connected)} already connected` : ''
  }`
}

const KIND_LABEL: Record<NearbyKind, string> = {
  adb: 'Network debugging',
  wireless: 'Wireless debugging',
  pairing: 'pairing screen open',
}

/** --doctor: one indented line per found service. */
export function nearbyLines(devices: readonly AndroidNearbyDevice[]): string[] {
  return devices.map((d) =>
    clean(
      `  ${[
        d.name || d.model || d.instance,
        networkSerial(d.host, d.port),
        KIND_LABEL[d.kind],
        ...(d.osVersion ? [`Android ${d.osVersion}`] : []),
        d.connected ? `listed as ${String(d.deviceId)}` : 'not connected',
      ].join(' · ')}`,
      300,
    ),
  )
}

/**
 * The terminal's line when the system resolver looked although the helper's own queries could
 * not leave: not an error, and not the blocked wording, which waits for a connect that fails.
 */
export function nearbyNoteLine(
  note: NonNullable<AndroidNearbyResult['note']>,
  tool: SystemBrowseResult['tool'] | null,
): string {
  return clean(
    `Wi-Fi: looked through ${tool ?? 'the system resolver'}; the helper's own mDNS queries could not leave (${note.detail}), so connecting may be refused too`,
    300,
  )
}

/**
 * The terminal lines for a scan that could not run: `blocked` names its causes and fixes.
 * `systemDetail` (NearbyScan): why the system resolver could not look either, on its own line.
 */
export function nearbyFailureLines(
  error: NonNullable<AndroidNearbyResult['error']>,
  platform: NodeJS.Platform,
  systemDetail?: string,
): string[] {
  const head = 'Wi-Fi: could not look for Android devices on the network'
  /** What the socket said, without the resolver's words that scanNearby appended. */
  const tail = systemDetail ? `; ${systemDetail}` : ''
  const socket =
    tail && error.detail.endsWith(tail) ? error.detail.slice(0, -tail.length) : error.detail
  const resolver = systemDetail
    ? [clean(`  The system resolver could not look either: ${systemDetail}`, 300)]
    : []
  if (error.reason === 'blocked') {
    const cause = /EPERM|EACCES/.test(socket) ? 'not permitted' : 'no route to host'
    return [...blockedLines(head, cause, platform), ...resolver]
  }
  if (error.reason === 'no-network') {
    return [`${head}: this computer is not on a network`, ...resolver]
  }
  return [`${head}: ${socket}`, ...resolver]
}

/* ---------------------------------------------------------------- starting a server --- */

export interface StartServerOptions {
  port: number
  timeouts: Timeouts
  /** The tool's environment; ANDROID_ADB_SERVER_PORT is set to `port` on top of it. */
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Called once the CLI is running: from then on, any server that appears is ours. */
  onSpawned?: () => void
  /** Between `host:version` probes. */
  pollMs?: number
}

/**
 * §4.5, on an explicit click only: `adb start-server`, then wait for `host:version`.
 *
 * The CLI forks the server as a daemon and exits. It runs detached, with stdio ignored and
 * without being tracked, on purpose: the daemon must not inherit our pipes (it would hold
 * them open for its whole life) and must never be in a process group the helper kills at
 * exit. The server outlives the helper, as the exit message tells the tester.
 */
export async function startAdbServer(adbPath: string, opts: StartServerOptions): Promise<void> {
  const { port, timeouts, signal } = opts
  let spawnError: NodeJS.ErrnoException | null = null
  const child = spawn(adbPath, ['start-server'], {
    stdio: 'ignore',
    detached: true,
    env: { ...opts.env, ANDROID_ADB_SERVER_PORT: String(port) },
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnError = error
  })
  child.unref()
  opts.onSpawned?.()
  const client = createAdbClient({ port, timeouts })
  const deadline = Date.now() + timeouts.adbStartPoll
  for (;;) {
    if (spawnError !== null) {
      const error: NodeJS.ErrnoException = spawnError
      if (error.code === 'ENOENT') {
        throw new HelperError('TOOL_MISSING', 503, 'adb is not installed.', {
          tool: 'adb',
          install: INSTALL.adb,
        })
      }
      throw new HelperError('TOOL_FAILED', 502, `adb could not be started: ${error.message}`)
    }
    if ((await client.version(signal).catch(() => null)) !== null) return
    if (signal?.aborted) throw abortError()
    if (Date.now() >= deadline) break
    await sleep(Math.min(opts.pollMs ?? 250, Math.max(0, deadline - Date.now())), signal)
  }
  throw new HelperError(
    'ADB_START_FAILED',
    502,
    `adb start-server ran, but no adb server answered within ${seconds(timeouts.adbStartPoll)} s.`,
  )
}

/* ------------------------------------------------------------------------ the lane --- */

/** What preflight (§12) reads from the Android lane. */
export interface AndroidLaneFacts {
  adb: string | null
  version: string | null
  server: 'running' | 'stopped'
  serverProtocol: number | null
  devices: Array<{ serial: string; state: string; model: string }>
  startedByHelper: boolean
}

/** Cadences of §1.3 and §4; tests shorten them. */
export interface AndroidCadence {
  /** Presence probe while no server answers (about 1 ms per refused connect). */
  presenceMs: number
  /** `host:devices-l` polling when the server refuses the tracker. */
  pollMs: number
  /** A ready phone waits this long for its identity before it is listed with the tracker's. */
  identityGraceMs: number
  /** After Retry, how long to wait for the tracker to report the phone again. */
  retryWaitMs: number
  /** After logcat ends, how long to wait for the tracker to tell an unplug from an EOF. */
  goneWaitMs: number
  /** start-server's `host:version` polling. */
  startPollMs: number
  /** How long a Wi-Fi device's name may take to resolve (mDNS on a quiet network: seconds). */
  lookupMs: number
  /** How long a device the tester disconnected may stay listed `offline`, unshown. */
  leavingMs: number
  /** How long a Wi-Fi scan (§4.8) answers GET /api/android/nearby without ?refresh=1. */
  nearbyCacheMs: number
  /** ?refresh=1 starts a new scan only this long after the last one started. */
  nearbyGapMs: number
}

export const ANDROID_CADENCE: AndroidCadence = {
  presenceMs: 5_000,
  pollMs: 2_000,
  identityGraceMs: 1_500,
  retryWaitMs: 3_000,
  goneWaitMs: 1_000,
  startPollMs: 250,
  lookupMs: 5_000,
  leavingMs: 10_000,
  nearbyCacheMs: 20_000,
  nearbyGapMs: 3_000,
}

/** What a test swaps in: the cadence, and how names resolve. */
export type AndroidLaneOptions = Partial<AndroidCadence> & { lookup?: HostLookup }

const LOGCAT = 'logcat -v threadtime -T 200'
const IDENTITY_PROPS = {
  model: 'getprop ro.product.model',
  device: 'getprop ro.product.device',
  release: 'getprop ro.build.version.release',
} as const

type IdentitySlot =
  | { status: 'pending'; since: number }
  | { status: 'done'; identity: AdbIdentity }
  | { status: 'failed' }

/**
 * The Android lane (§4): presence probe, hot-plug tracker, identity cache, and the four
 * operations, all over the host protocol. `cadence` exists for tests.
 */
export function createAndroidLane(ctx: LaneContext, options: AndroidLaneOptions = {}): AndroidLane {
  const { lookup = systemLookup, ...cadence } = options
  const pace: AndroidCadence = { ...ANDROID_CADENCE, ...cadence }
  const { timeouts } = ctx
  const port = ctx.options.adbPort
  const client = createAdbClient({ port, timeouts })
  const flights = singleFlight()

  let running = false
  let protocol: number | null = null
  let startedByHelper = false
  /** We ran `adb start-server`: a server that appears from now on is the helper's doing. */
  let spawned = false
  let toolbox: Toolbox | null = null
  let entries: DevicesLRow[] = []
  let closeTracker: (() => void) | null = null
  /** The server refused `track-devices-l`: poll `devices-l` instead. */
  let polling = false
  let timer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let stopped = false
  /** The serials of the rows published last. */
  let published = new Set<string>()
  /** Keyed by serial + transport_id: a phone that reconnects gets a new id and a fresh look. */
  const identities = new Map<string, IdentitySlot>()
  /**
   * Network serials the tester disconnected (POST /api/android/disconnect), each until when.
   * adb lists such a device `offline` for a moment before it lets go: that is not a device
   * that stopped answering, so its row goes at once, and its line says "disconnected".
   */
  const leaving = new Map<string, number>()
  let leavingTimer: NodeJS.Timeout | undefined

  /** The last Wi-Fi scan (§4.8), and the terminal lines last printed for one. */
  let lastScan: NearbyScan | null = null
  let scanReported = ''

  /** Called after every list the lane takes in: open streams watch their device's state. */
  const watchers = new Set<() => void>()
  const watch = (watcher: () => void): (() => void) => {
    watchers.add(watcher)
    return () => watchers.delete(watcher)
  }

  const identityKey = (entry: DevicesLRow): string =>
    `${entry.serial}#${entry.props.transport_id ?? ''}`

  const identityOf = (entry: DevicesLRow): AdbIdentity | null => {
    const slot = identities.get(identityKey(entry))
    return slot?.status === 'done' ? slot.identity : null
  }

  /** Three getprop calls, 10 s each; any that fails leaves its field to the tracker's value. */
  const fetchIdentity = async (entry: DevicesLRow): Promise<void> => {
    const key = identityKey(entry)
    identities.set(key, { status: 'pending', since: ctx.now() })
    const read = (cmd: string): Promise<string> =>
      client
        .exec(entry.serial, cmd, { signal: ctx.signal, timeoutMs: timeouts.adbExec })
        .then((bytes) => clean(bytes.toString('utf8').trim(), LIMITS.field))
    const [model, device, release] = await Promise.allSettled([
      read(IDENTITY_PROPS.model),
      read(IDENTITY_PROPS.device),
      read(IDENTITY_PROPS.release),
    ])
    const value = (r: PromiseSettledResult<string>): string =>
      r.status === 'fulfilled' ? r.value : ''
    const identity = { model: value(model), device: value(device), release: value(release) }
    if (stopped || !identities.has(key)) return
    identities.set(
      key,
      identity.model || identity.device || identity.release
        ? { status: 'done', identity }
        : { status: 'failed' },
    )
    render()
  }

  /**
   * Publish what the server lists. A phone that just became ready is held back until its
   * identity arrives (or the grace period ends), so its one arrival line reads
   * "+ Pixel 9 (…) · Android 17 · USB · ready via adb" instead of the tracker's "Pixel_9".
   * Only one not listed yet: a row already shown (a TV that was `unauthorized` until the
   * tester chose Allow) stays, rather than vanishing for the grace period and coming back.
   */
  function render(): void {
    if (stopped) return
    const listed = new Set(entries.map(identityKey))
    for (const key of [...identities.keys()]) if (!listed.has(key)) identities.delete(key)
    for (const [serial, until] of leaving) if (until <= ctx.now()) leaving.delete(serial)
    const rows: HelperDevice[] = []
    let waitMs = Infinity
    for (const entry of entries) {
      /** Ids no request could address (Linux's `????????????` for a phone without permission). */
      if (!ID.android.test(entry.serial)) continue
      if (leaving.has(entry.serial) && entry.state !== 'device') continue
      if (entry.state === 'device') {
        const shown = published.has(entry.serial)
        const slot = identities.get(identityKey(entry))
        if (!slot) {
          void fetchIdentity(entry)
          if (!shown) {
            waitMs = Math.min(waitMs, pace.identityGraceMs)
            continue
          }
        } else if (slot.status === 'pending' && !shown) {
          const left = slot.since + pace.identityGraceMs - ctx.now()
          if (left > 0) {
            waitMs = Math.min(waitMs, left)
            continue
          }
        }
      }
      rows.push(androidRow(entry, identityOf(entry)))
    }
    const shown = new Set(rows.map((row) => row.id))
    const departures: Record<string, string> = {}
    for (const serial of published) {
      if (!shown.has(serial) && leaving.has(serial)) departures[serial] = 'disconnected'
    }
    published = shown
    /** adb let go of it: a later connect to the same address is a new device. */
    for (const serial of leaving.keys()) {
      if (!entries.some((e) => e.serial === serial)) leaving.delete(serial)
    }
    clearTimeout(graceTimer)
    if (waitMs !== Infinity) {
      graceTimer = setTimeout(render, waitMs + 5)
      graceTimer.unref()
    }
    ctx.publish('android', rows, departures)
    for (const watcher of [...watchers]) watcher()
  }

  const adbState = (): { adb: 'found' | 'missing' } => ({ adb: toolbox?.adb ? 'found' : 'missing' })

  const loadTools = (): Promise<void> =>
    ctx.tools.get().then(
      (t) => {
        toolbox = t
      },
      () => undefined,
    )

  /**
   * The tools again (cached 30 s by the bridge): adb installed or removed since tells the page
   * at once, rather than when the tester next presses Refresh or restarts the helper.
   */
  const syncTools = async (): Promise<void> => {
    const before = adbState().adb
    await loadTools()
    if (!stopped && adbState().adb !== before) ctx.setLane('android', adbState())
  }

  function serverUp(version: number): void {
    running = true
    protocol = version
    if (spawned) startedByHelper = true
    if (!closeTracker && !polling) openTracker()
    ctx.setLane('android', {
      status: 'ok',
      serverProtocol: version,
      startedByHelper,
      reason: undefined,
      ...adbState(),
    })
  }

  function serverGone(): void {
    closeTracker?.()
    closeTracker = null
    polling = false
    running = false
    protocol = null
    startedByHelper = false
    spawned = false
    entries = []
    render()
    ctx.setLane('android', {
      status: 'stopped',
      serverProtocol: undefined,
      startedByHelper: false,
      reason: undefined,
      ...adbState(),
    })
  }

  function serverOdd(error: unknown): void {
    closeTracker?.()
    closeTracker = null
    running = false
    protocol = null
    entries = []
    render()
    ctx.setLane('android', {
      status: 'error',
      serverProtocol: undefined,
      reason: `something on port ${String(port)} answers, but not as an adb server (${errorText(error)})`,
      ...adbState(),
    })
  }

  function openTracker(): void {
    let opened = true
    const openedAt = Date.now()
    closeTracker = client.track(
      (text) => {
        entries = parseDevicesL(text)
        render()
      },
      (error) => {
        if (!opened) return
        opened = false
        closeTracker = null
        if (stopped) return
        /** FAIL: an old or odd server without the tracker; poll devices-l every 2 s instead. */
        if (isAdbRefusal(error) && running) {
          polling = true
          void relist()
          return
        }
        /**
         * The socket ended: most likely the server stopped, so find out now rather than in
         * 5 s. A tracker that died at once is left to the presence probe, so a server that
         * keeps dropping it cannot spin this lane in a loop.
         */
        if (Date.now() - openedAt > 1_000) void probe()
      },
    )
  }

  /** `host:version`: is a server there, and what speaks on the port. */
  const probe = (): Promise<void> =>
    flights.run('probe', async () => {
      if (stopped) return
      let version: number | null
      try {
        /** Never a request's signal: a page that leaves must not make the server look odd. */
        version = await client.version(ctx.signal)
      } catch (error) {
        if (!stopped && !ctx.signal.aborted) serverOdd(error)
        return
      }
      if (stopped) return
      if (version === null) {
        if (running || entries.length) serverGone()
        else if (protocol === null) ctx.setLane('android', { status: 'stopped', ...adbState() })
        return
      }
      serverUp(version)
    })

  /** `host:devices-l` now: Refresh, Retry, and the tracker-less fallback. */
  const relist = (): Promise<void> =>
    flights.run('relist', async () => {
      if (stopped) return
      try {
        entries = parseDevicesL(await client.devicesL(ctx.signal))
        render()
      } catch (error) {
        if (error instanceof HelperError && error.code === 'ADB_SERVER_STOPPED') serverGone()
      }
    })

  function schedule(): void {
    if (stopped) return
    const ms = polling && running ? pace.pollMs : pace.presenceMs
    timer = setTimeout(() => {
      /**
       * A live tracker needs nothing; otherwise poll the list, or look for a server. Every
       * tick also re-reads the tools, so `adb` follows an install.
       */
      const work = closeTracker ? Promise.resolve() : polling && running ? relist() : probe()
      void Promise.all([work, syncTools()]).finally(schedule)
    }, ms)
    timer.unref()
  }

  /** An operation that found the server gone makes the lane find out at once. */
  const noticeServer = (error: unknown): never => {
    if (error instanceof HelperError && error.code === 'ADB_SERVER_STOPPED') void probe()
    throw error
  }

  const entryOf = (id: string): DevicesLRow => {
    const entry = entries.find((e) => e.serial === id)
    if (!entry) throw new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.')
    return entry
  }

  /** Resolves once `check` holds, or after `ms`, or when `signal` aborts. */
  const waitFor = async (check: () => boolean, ms: number, signal?: AbortSignal): Promise<void> => {
    const until = Date.now() + ms
    while (!check() && Date.now() < until && !signal?.aborted && !stopped) {
      await sleep(25, signal).catch(() => undefined)
    }
  }

  /** Listed by the tracker and, when ready, published (its identity settled or given up). */
  const settledRow = (serial: string): boolean => {
    const now = entries.find((e) => e.serial === serial)
    if (!now) return false
    return now.state !== 'device' || identities.get(identityKey(now))?.status !== 'pending'
  }

  /** The tracker reports changes by itself; without one (polling), ask now. */
  const freshList = async (): Promise<void> => {
    if (!closeTracker) await relist()
  }

  /**
   * The Wi-Fi services go only to a server this lane knows: never a guess at whatever answers
   * on the port, and never one started for them (starting one is the tester's own click).
   */
  const requireServer = async (): Promise<void> => {
    if (!running) await probe()
    if (running) return
    throw new HelperError(
      'ADB_SERVER_STOPPED',
      503,
      "Google's adb server isn't running, and Wi-Fi devices go through it. Start it with Start adb server.",
    )
  }

  /**
   * "failed to authenticate to X" on a first connect: a TV with Network debugging is listed
   * `unauthorized` and asks "Allow debugging?" — connected, as far as the tester is concerned,
   * and the page shows the Allow step. Only a device the server does not list (Wireless
   * debugging, never paired with this Mac) needs a pairing code first.
   */
  const awaitingAllow = async (
    reply: HostReply,
    target: string,
  ): Promise<ReturnType<typeof parseConnectReply>> => {
    const said = reply.text.trim()
    const named = /^failed to authenticate to (\S+)$/i.exec(said)?.[1]
    const serial = named && ID.android.test(named) ? named : target
    await relist()
    if (!entries.some((e) => e.serial === serial)) throw connectFailed(target, 'unpaired', said)
    return { result: 'connected', serial, message: clean(said, 300) }
  }

  /** One connect or pairing per host at a time (§4.7); a second one is refused, not queued. */
  const dialling = new Set<string>()
  const dial = async <T>(host: string, fn: () => Promise<T>): Promise<T> => {
    const key = host.toLowerCase()
    if (dialling.has(key)) {
      throw new HelperError('BUSY', 409, `The helper is already connecting to ${host}.`)
    }
    dialling.add(key)
    try {
      return await fn()
    } finally {
      dialling.delete(key)
    }
  }

  /**
   * One scan at a time (a second caller joins it). Never a request's signal: a page that
   * leaves must not cut short the scan another request is waiting for.
   */
  const scanNow = (): Promise<NearbyScan> =>
    flights.run('nearby', async () => {
      const scan = await scanNearby({
        open: ctx.options.mdns,
        windowMs: timeouts.mdnsWindow,
        signal: ctx.signal,
        now: ctx.now,
        adbList: () => (running ? client.mdnsServices(ctx.signal) : Promise.resolve('')),
        system: systemResolver(ctx),
      })
      if (!stopped) lastScan = scan
      return scan
    })

  /** The scan's lines in the terminal, when they differ from the last ones printed. */
  const reportScan = (result: AndroidNearbyResult, scan: NearbyScan): void => {
    const lines = result.error
      ? [
          ...nearbyFailureLines(result.error, ctx.options.platform, scan.systemDetail),
          ...(result.devices.length ? [nearbySummary(result.devices)] : []),
        ]
      : [
          ...(result.note ? [nearbyNoteLine(result.note, scan.system)] : []),
          nearbySummary(result.devices),
        ]
    const key = lines.join('\n')
    if (key === scanReported) return
    scanReported = key
    for (const line of lines) ctx.log(line)
  }

  return {
    name: 'android',

    start() {
      /**
       * One combined first report: the registry prints nothing for a lane's first state, so
       * a server already running at startup is described by the banner, not a log line.
       */
      void Promise.all([loadTools(), client.version(ctx.signal).catch((error: unknown) => error)])
        .then(([, version]) => {
          if (stopped) return
          if (typeof version === 'number') serverUp(version)
          else if (version === null) ctx.setLane('android', { status: 'stopped', ...adbState() })
          else serverOdd(version)
        })
        .finally(schedule)
    },

    async stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      clearTimeout(leavingTimer)
      closeTracker?.()
      closeTracker = null
      client.close()
      await Promise.resolve()
    },

    async rescan() {
      await loadTools()
      if (running) {
        ctx.setLane('android', adbState())
        await relist()
      } else await probe()
    },

    async detail(id, signal) {
      const entry = entryOf(id)
      /** Six constant commands in parallel; one that fails reads as '', exactly as on WebUSB. */
      const results = await Promise.allSettled(
        ADB_DETAIL.map(([, cmd]) =>
          client
            .exec(id, cmd, { signal, timeoutMs: timeouts.adbExec })
            .then((b) => b.toString('utf8')),
        ),
      )
      if (signal.aborted) throw abortError()
      if (results.every((r) => r.status === 'rejected')) {
        /** Nothing answered: say why (unplugged, unauthorized, no server) instead of a blank pane. */
        const first = results[0]
        if (first?.status === 'rejected') noticeServer(first.reason)
      }
      const outputs = Object.fromEntries(
        ADB_DETAIL.map(([key], i) => {
          const r = results[i]
          return [key, r?.status === 'fulfilled' ? r.value : '']
        }),
      ) as unknown as DetailOutputs
      return {
        platform: 'android',
        kind: 'android',
        serial: id,
        connection: adbConnection(entry.serial),
        outputs,
      }
    },

    async screenshot(id, signal) {
      entryOf(id)
      const bytes = await client
        .exec(id, 'screencap -p', {
          signal,
          maxBytes: LIMITS.png,
          timeoutMs: timeouts.adbScreencap,
        })
        .catch(noticeServer)
      /** screencap warns about phones with two displays before the image: cut it out. */
      const png = extractPng(bytes)
      if (!png) {
        throw new HelperError(
          'SCREENSHOT_NOT_PNG',
          502,
          'The phone returned something that is not a PNG.',
        )
      }
      return { png, source: 'adb' }
    },

    async logs(id, sink, signal) {
      entryOf(id)
      const socket = await client.execStream(id, LOGCAT, signal).catch(noticeServer)
      sink.hello('logcat')
      const listedReady = (): boolean => entries.find((e) => e.serial === id)?.state === 'device'
      /**
       * A TV that leaves the Wi-Fi goes `offline` first, and its logcat socket can stay open,
       * silent, until adb gives up on it. End the stream as soon as the tracker says so.
       */
      const unwatch = watch(() => {
        if (!listedReady()) socket.destroy()
      })
      try {
        await new Promise<void>((resolve) => {
          let waiting = false
          const lines = splitLines((batch) => {
            if (sink.push(batch) || waiting) return
            /** Back-pressure: stop reading the phone until the page has taken what it has. */
            waiting = true
            socket.pause()
            void sink.drain().then(() => {
              waiting = false
              if (!socket.destroyed) socket.resume()
            })
          })
          socket.on('data', (chunk: Buffer) => lines.write(chunk))
          socket.on('end', () => lines.end())
          socket.on('error', () => undefined)
          socket.on('close', () => resolve())
          socket.resume()
        })
      } finally {
        unwatch()
      }
      if (signal.aborted) return
      /**
       * adbd ends logcat when the phone goes away, a moment before the tracker says so. Wait
       * for the tracker, so the stream ends as `device-gone` (the registry tells the HTTP
       * layer) rather than a plain `eof`.
       */
      await waitFor(() => !listedReady(), pace.goneWaitMs, signal)
      const now = entries.find((e) => e.serial === id)
      /**
       * Still listed, but no longer ready: a device that dropped off the network (or stopped
       * answering on its cable) before the server lets go of it. That is a drop too, and
       * the page words it as one, not as a log that simply ended.
       */
      if (now && now.state !== 'device' && !leaving.has(id) && !signal.aborted) {
        throw new HelperError(
          'DEVICE_DROPPED',
          503,
          adbConnection(id) === 'network'
            ? 'The device dropped off the network.'
            : 'The phone stopped answering.',
        )
      }
    },

    async retry(id, signal) {
      const entry = entries.find((e) => e.serial === id)
      if (!running) return probe()
      /** A phone whose identity failed gets a fresh look on Retry. */
      for (const [key, slot] of identities) {
        if (key.startsWith(`${id}#`) && slot.status === 'failed') identities.delete(key)
      }
      if (entry && ['offline', 'unauthorized', 'authorizing'].includes(entry.state)) {
        /** Resets offline and unauthorized transports: the phone asks "Allow USB debugging?" again. */
        await client.reconnectOffline(signal).catch(noticeServer)
      } else await relist()
      render()
      /** Until the tracker lists the phone as ready and published (its identity settled). */
      const settled = (): boolean => {
        const now = entries.find((e) => e.serial === id)
        if (now?.state !== 'device') return false
        return identities.get(identityKey(now))?.status !== 'pending'
      }
      await waitFor(settled, pace.retryWaitMs, signal)
    },

    async connectNetwork({ host, port }, signal) {
      const target = networkSerial(host, port)
      return dial(host, async () => {
        await requireServer()
        leaving.delete(target)
        let outcome: ReturnType<typeof parseConnectReply>
        try {
          await checkResolvedName(host, lookup, pace.lookupMs, (reason) =>
            connectFailed(target, reason),
          )
          const reply = await client
            .connectNetwork(host, port, { signal, timeoutMs: timeouts.adbNetworkConnect })
            .catch((error: unknown) => {
              if (error instanceof HelperError && error.code === 'TOOL_TIMEOUT') {
                throw connectFailed(target, 'timeout')
              }
              return noticeServer(error)
            })
          outcome = isAuthenticateReply(reply)
            ? await awaitingAllow(reply, target)
            : parseConnectReply(reply, target)
        } catch (error) {
          if (error instanceof HelperError && error.code === 'ANDROID_CONNECT_FAILED') {
            const head = `Wi-Fi: could not connect to ${target}`
            for (const line of networkFailureLines(head, error, ctx.options.platform)) ctx.log(line)
          }
          throw error
        }
        ctx.log(
          `Wi-Fi: ${outcome.result === 'connected' ? 'connected to' : 'already connected to'} ${outcome.serial}`,
        )
        /** The tracker lists it a moment later, usually `unauthorized` until the TV allows it. */
        await freshList()
        await waitFor(() => settledRow(outcome.serial), pace.retryWaitMs, signal)
        return outcome
      })
    },

    async pairNetwork({ host, port, code }, signal) {
      const target = networkSerial(host, port)
      return dial(host, async () => {
        await requireServer()
        let outcome: ReturnType<typeof parsePairReply>
        try {
          await checkResolvedName(host, lookup, pace.lookupMs, (reason) =>
            pairFailed(target, reason),
          )
          const reply = await client
            .pairNetwork(code, host, port, { signal, timeoutMs: timeouts.adbPair })
            .catch((error: unknown) => {
              if (error instanceof HelperError && error.code === 'TOOL_TIMEOUT') {
                throw pairFailed(target, 'timeout')
              }
              return noticeServer(error)
            })
          outcome = parsePairReply(reply, target)
        } catch (error) {
          /** Never the code: it is a one-time secret, and the terminal is pasted into bug reports. */
          if (error instanceof HelperError && error.code === 'ANDROID_PAIR_FAILED') {
            const head = `Wi-Fi: could not pair with ${target}`
            for (const line of networkFailureLines(head, error, ctx.options.platform)) ctx.log(line)
          }
          throw error
        }
        ctx.log(`Wi-Fi: paired with ${target}`)
        return outcome
      })
    },

    async disconnectNetwork(serial, signal) {
      if (!isNetworkSerial(serial)) {
        throw badRequest('Only a device connected over Wi-Fi can be disconnected here.')
      }
      if (!isDisconnectableSerial(serial)) {
        throw badRequest(
          'Only a device connected by its address (like 192.168.1.20:5555) can be disconnected here.',
        )
      }
      await requireServer()
      if (!entries.some((e) => e.serial === serial)) {
        throw badRequest('That device isn’t connected over Wi-Fi any more.')
      }
      /** Before it is sent: the tracker may say `offline` before the answer arrives. */
      leaving.set(serial, ctx.now() + pace.leavingMs)
      let outcome: ReturnType<typeof parseDisconnectReply>
      try {
        const reply = await client.disconnectNetwork(serial, signal).catch(noticeServer)
        outcome = parseDisconnectReply(reply)
      } catch (error) {
        leaving.delete(serial)
        render()
        throw error
      }
      ctx.log(`Wi-Fi: disconnected ${serial}`)
      /** A device adb still lists `offline` when the time is up is shown again, as it is. */
      clearTimeout(leavingTimer)
      leavingTimer = setTimeout(render, pace.leavingMs + 5)
      leavingTimer.unref()
      await freshList()
      await waitFor(() => !entries.some((e) => e.serial === serial), pace.retryWaitMs, signal)
      return outcome
    },

    async nearby(refresh, signal) {
      const age = lastScan ? ctx.now() - lastScan.startedAt : Infinity
      const stale = age >= pace.nearbyCacheMs || (refresh && age >= pace.nearbyGapMs)
      if (flights.has('nearby') || stale) {
        await Promise.race([scanNow(), aborted(signal)])
        if (signal.aborted) throw abortError()
      }
      const scan = lastScan
      if (!scan) throw abortError()
      /** Compared with what adb lists now, not when the scan ran: a connect shows at once. */
      const result: AndroidNearbyResult = {
        devices: mergeNearby(scan.found, scan.names, entries),
        scannedAt: scan.startedAt,
        ...(scan.error ? { error: scan.error } : {}),
        ...(scan.note ? { note: scan.note } : {}),
      }
      reportScan(result, scan)
      return result
    },

    async startServer(signal) {
      await loadTools()
      const adb = toolbox?.adb?.path
      if (!adb) {
        throw new HelperError('TOOL_MISSING', 503, 'adb is not installed.', {
          tool: 'adb',
          install: INSTALL.adb,
        })
      }
      /** Already there (an IDE started one meanwhile): share it, start nothing. */
      if ((await client.version(signal)) !== null) return probe()
      await startAdbServer(adb, {
        port,
        timeouts,
        env: ctx.childEnv(),
        signal,
        pollMs: pace.startPollMs,
        onSpawned: () => {
          spawned = true
        },
      })
      await probe()
    },

    /**
     * --doctor (§1.9): the server's state and its `devices -l` rows, asked directly, since
     * the lane is not running in that mode. Read-only: two host services, nothing started.
     */
    async probeForDoctor(write) {
      const where = `127.0.0.1:${String(port)}`
      const deadline = linkSignals([ctx.signal], timeouts.doctorTotal)
      /** Its own client: closing it must never touch a running lane's tracker. */
      const doctor = createAdbClient({ port, timeouts })
      let rows: DevicesLRow[] = []
      let server = false
      try {
        const version = await doctor.version(deadline.signal).catch((error: unknown) => error)
        if (version === null) {
          write(`Android: no adb server on ${where} (the doctor never starts one)`)
        } else if (typeof version !== 'number') {
          write(`Android: something on ${where} answers, but not as an adb server`)
        } else {
          server = true
          write(`Android: adb server on ${where}, protocol ${String(version)}`)
          rows = parseDevicesL(await doctor.devicesL(deadline.signal))
          write(`Android: ${String(rows.length)} device(s) listed by the adb server`)
          for (const row of rows) {
            const props = Object.entries(row.props).map(([key, value]) => `${key}:${value}`)
            write(clean(`  ${[row.serial, row.state, ...props].join(' · ')}`, 300))
          }
        }
        /** §4.8: what advertises adb on the network, with or without a server. */
        const scan = await scanNearby({
          open: ctx.options.mdns,
          windowMs: timeouts.mdnsWindow,
          signal: deadline.signal,
          now: ctx.now,
          adbList: () => (server ? doctor.mdnsServices(deadline.signal) : Promise.resolve('')),
          system: systemResolver(ctx),
        })
        const devices = mergeNearby(scan.found, scan.names, rows)
        if (scan.error) {
          for (const line of nearbyFailureLines(
            scan.error,
            ctx.options.platform,
            scan.systemDetail,
          )) {
            write(line)
          }
        }
        if (scan.note) write(nearbyNoteLine(scan.note, scan.system))
        if (!scan.error || devices.length) {
          write(nearbySummary(devices))
          for (const line of nearbyLines(devices)) write(line)
        }
      } finally {
        deadline.dispose()
        doctor.close()
      }
    },

    facts: () => ({
      adb: toolbox?.adb?.path ?? null,
      version: toolbox?.adb?.version ?? null,
      server: running ? 'running' : 'stopped',
      serverProtocol: protocol,
      devices: entries.map((entry) => ({
        serial: entry.serial,
        state: entry.state,
        model: androidRow(entry, identityOf(entry)).model,
      })),
      startedByHelper,
    }),
  }
}
