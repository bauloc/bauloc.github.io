/*
  Shared test plumbing for every helper suite (core, and the lane suites):

  - startBridge(): a listening bridge whose every path, port and tool points at a private
    temporary tree, so nothing real (usbmuxd, adb, Xcode, bauloc.github.io) is ever reached;
    closed after each test file.
  - request() / openStream(): raw node:http, because Node's fetch silently replaces a custom
    Host header [V], which would make the DNS-rebinding tests pass without testing anything.
  - openWebSocket(): a raw WebSocket client on node:net, for the adb tunnel (§4.10): any
    handshake header, and frames a browser would never send.
  - until(), tinyPng(), freePort(), tempDir(): the small things every suite needs.
  - listenerWarnings(): what Node 18 and 20 would warn about abort listeners, on Node 24.

  Lane suites run their REAL lane through the bridge by passing its factory and pointing the
  lane's endpoints at their fakes, for example:
    startBridge({ lanes: { ios: createIosLane }, usbmuxdSocket: fakeMux.path,
                  resolveTools: () => Promise.resolve(toolbox((t) => { t.xcode.state = 'ready' })) })
  Every lane is off unless a test turns it on, and nothing else is ever reachable.
*/
import { randomBytes } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import http, { type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll } from 'vitest'
import { createBridge, type Bridge } from '../src/bridge'
import { emptyToolbox, type Toolbox } from '../src/tools'
import type { BridgeInput, LogMsg, Timeouts } from '../src/types'
import { createFakeBin, type FakeBin } from './fakes/bin'
import { noDescription, silentPresence, silentSsdp } from './fakes/lan'
import { silentMdns } from './fakes/mdns'

const cleanups: Array<() => unknown> = []
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Run `cleanup` after the test file (bridges, servers, folders). */
export function onCleanup(cleanup: () => unknown): void {
  cleanups.push(cleanup)
}

/** A private directory, removed after the test file. */
export function tempDir(prefix = 'helper-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A port nothing listens on (bound, read, released). */
export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A Toolbox with nothing found, changed by `patch`: what `resolveTools` returns in lane tests. */
export function toolbox(patch: (t: Toolbox) => void = () => undefined): Toolbox {
  const t = emptyToolbox(Date.now())
  patch(t)
  return t
}

/** Timeouts short enough for a test, long enough not to flake. */
export const SHORT: Partial<Timeouts> = {
  killGrace: 300,
  rescan: 500,
  retry: 500,
  logHello: 1_000,
  logBatch: 20,
  banner: 500,
  portProbe: 500,
  upstream: 2_000,
  htmlRevalidate: 60_000,
  toolsCache: 30_000,
  doctorCache: 30_000,
  mdnsWindow: 200,
  systemBrowse: 600,
  systemResolve: 1_000,
  lanPresence: 200,
  lanSsdp: 300,
  lanDescription: 500,
  lanReverse: 1_000,
  lanScan: 4_000,
}

/** Polls `check` until it is truthy; fails after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * The MaxListenersExceededWarnings `run` causes on Node 18 and 20, which cap every
 * AbortSignal at 10 abort listeners and print the warning in the tester's terminal past it.
 * Node 24 has no cap, so while `run` runs every new AbortController gets 18 and 20's.
 */
export async function listenerWarnings(run: () => unknown): Promise<string[]> {
  const real = globalThis.AbortController
  class Node20AbortController extends real {
    constructor() {
      super()
      setMaxListeners(10, this.signal)
    }
  }
  const seen: string[] = []
  const listener = (warning: Error): void => {
    if (warning.name === 'MaxListenersExceededWarning') seen.push(warning.message)
  }
  globalThis.AbortController = Node20AbortController
  process.on('warning', listener)
  try {
    await run()
    /** process.emitWarning() emits on the next tick. */
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    globalThis.AbortController = real
    process.off('warning', listener)
  }
  return seen
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A valid 1×1 PNG (signature, IHDR, IDAT, IEND): what every fake screenshot returns. */
export function tinyPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0xff, 0x80, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export interface Started {
  readonly bridge: Bridge
  readonly port: number
  readonly token: string
  /** Terminal lines the bridge printed (timestamps included). */
  readonly logs: string[]
  /** stderr lines (bugs). */
  readonly errors: string[]
  readonly bin: FakeBin
  readonly home: string
  /** Authorization plus an allowed Origin, as the hosted page sends them. */
  readonly auth: Record<string, string>
}

export interface Isolation {
  /** createBridge options that keep everything real out of reach. */
  readonly input: BridgeInput
  readonly bin: FakeBin
  readonly home: string
  readonly logs: string[]
  readonly errors: string[]
}

/**
 * Options under which nothing real can be reached: an empty fake PATH, a usbmuxd socket and
 * an adb port nobody serves, a closed upstream, an mDNS transport that sends nothing, no
 * network interface and LAN sources that send nothing (§4.9), private home and temp folders,
 * no lanes unless the test adds fakes, and short timeouts. `input` wins over every default.
 */
export async function isolation(input: BridgeInput = {}): Promise<Isolation> {
  const root = tempDir()
  const bin = createFakeBin(root)
  const home = mkdtempSync(path.join(root, 'home-'))
  const tmpDir = mkdtempSync(path.join(root, 'tmp-'))
  const closed = await freePort()
  const logs: string[] = []
  const errors: string[] = []
  const fake = (name: string): string => path.join(root, 'nowhere', name)
  return {
    bin,
    home,
    logs,
    errors,
    input: {
      port: 0,
      open: false,
      searchPath: bin.dir,
      extraDirs: [],
      usbmuxdSocket: fake('usbmuxd'),
      adbPort: closed,
      upstream: `http://127.0.0.1:${String(closed)}`,
      xcodeSelectPath: fake('xcode-select'),
      plistBuddyPath: fake('PlistBuddy'),
      javaHomePath: fake('java_home'),
      openPath: fake('open'),
      swVersPath: fake('sw_vers'),
      applicationsDir: fake('Applications'),
      coreDeviceDir: fake('CoreDevice.framework'),
      coreSimulatorDir: fake('CoreSimulator.framework'),
      systemVersionPlist: fake('SystemVersion.plist'),
      home,
      tmpDir,
      heartbeatMs: 1_000,
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      env: { PATH: bin.dir, HOME: home },
      /** mDNS goes nowhere: a test that scans brings its own fake network (fakes/mdns.ts). */
      mdns: silentMdns(),
      /** No real dns-sd or avahi-browse: a test that wants one writes it into bin.dir. */
      dnsSdPath: path.join(bin.dir, 'dns-sd'),
      /**
       * Every device on this network (§4.9): no interface, so no network to look at; and
       * should a test give one, sources that send nothing (fakes/lan.ts) and tables and
       * tools that are not there unless the test writes them.
       */
      lanInterfaces: () => [],
      lanPresence: silentPresence(),
      lanSsdp: silentSsdp(),
      lanDescription: noDescription,
      arpPath: path.join(bin.dir, 'arp'),
      procNetArpPath: fake('proc-net-arp'),
      procNetRoutePath: fake('proc-net-route'),
      routePath: path.join(bin.dir, 'route'),
      avahiResolvePath: path.join(bin.dir, 'avahi-resolve'),
      ...input,
      timeouts: { ...SHORT, ...input.timeouts },
      lanes: { ios: null, android: null, simulators: null, ...input.lanes },
    },
  }
}

/** A listening bridge under isolation(), closed after the test file. */
export async function startBridge(input: BridgeInput = {}): Promise<Started> {
  const { input: options, bin, home: homeDir, logs, errors } = await isolation(input)
  const bridge = createBridge(options)
  const { port } = await bridge.listen()
  cleanups.push(() => bridge.close())
  return {
    bridge,
    port,
    token: bridge.token,
    logs,
    errors,
    bin,
    home: homeDir,
    auth: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' },
  }
}

export interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  text: string
  json: <T = unknown>() => T
}

export interface RequestOptions {
  method?: string
  path: string
  headers?: Record<string, string>
  /** Defaults to 127.0.0.1:<port>; set it to test the Host gate. */
  host?: string
  body?: string | Buffer
}

/** One request on its own connection, with exactly the headers given. */
export function request(port: number, opts: RequestOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        agent: false,
        headers: { Host: opts.host ?? `127.0.0.1:${String(port)}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (data: Buffer) => chunks.push(data))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          const text = body.toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text,
            json: <T>() => JSON.parse(text) as T,
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

export interface Stream {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly messages: LogMsg[]
  /** The first message (already received or still to come) that matches. */
  readonly waitFor: (match: (message: LogMsg) => boolean, timeoutMs?: number) => Promise<LogMsg>
  /** Leave without reading the rest: the helper sees the client go. */
  readonly abort: () => void
  readonly pause: () => void
  readonly resume: () => void
  /** Resolves when the response ends or the connection closes. */
  readonly closed: Promise<void>
}

/** A log stream (NDJSON), or the JSON error the helper answered instead. */
export function openStream(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<Stream | Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        headers: { Host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = []
          res.on('data', (data: Buffer) => chunks.push(data))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.from(text),
              text,
              json: <T>() => JSON.parse(text) as T,
            })
          })
          return
        }
        const messages: LogMsg[] = []
        const waiters: Array<() => void> = []
        let carry = ''
        res.setEncoding('utf8')
        res.on('data', (data: string) => {
          carry += data
          let nl = carry.indexOf('\n')
          while (nl >= 0) {
            const line = carry.slice(0, nl)
            carry = carry.slice(nl + 1)
            if (line) messages.push(JSON.parse(line) as LogMsg)
            nl = carry.indexOf('\n')
          }
          for (const wake of waiters.splice(0)) wake()
        })
        const closed = new Promise<void>((done) => {
          res.on('end', () => done())
          res.on('close', () => done())
          res.on('error', () => done())
        })
        resolve({
          status: 200,
          headers: res.headers,
          messages,
          waitFor(match, timeoutMs = 3_000) {
            return new Promise<LogMsg>((found, fail) => {
              const deadline = setTimeout(
                () => fail(new Error(`No matching message in ${JSON.stringify(messages)}`)),
                timeoutMs,
              )
              const check = (): void => {
                const hit = messages.find(match)
                if (hit) {
                  clearTimeout(deadline)
                  found(hit)
                } else waiters.push(check)
              }
              check()
            })
          },
          abort: () => req.destroy(),
          pause: () => res.pause(),
          resume: () => res.resume(),
          closed,
        })
      },
    )
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    req.end()
  })
}

export function isStream(value: Stream | Reply): value is Stream {
  return 'messages' in value
}

/* ------------------------------------------------------------ a raw WebSocket client --- */

export interface WsFrameIn {
  readonly opcode: number
  readonly payload: Buffer
}

export interface RawWebSocket {
  /** The handshake's status: 101 when the upgrade was accepted. */
  readonly status: number
  readonly headers: Record<string, string>
  /** The refusal's body, when the status isn't 101. */
  readonly body: string
  /** The next frame from the helper; rejects when the connection ends first. */
  readonly next: (timeoutMs?: number) => Promise<WsFrameIn>
  /** Every frame until the helper closes the connection. */
  readonly rest: () => Promise<WsFrameIn[]>
  /** One frame, masked unless `mask: false`, final unless `fin: false`, RSV bits as given. */
  readonly send: (
    opcode: number,
    payload?: Buffer | string,
    o?: { mask?: boolean; fin?: boolean; rsv?: number },
  ) => void
  /** `{"service": …}`, the tunnel's opening message. */
  readonly hello: (service: string) => void
  readonly raw: (bytes: Buffer) => void
  readonly close: () => void
  /** Resolves when the TCP connection is gone. */
  readonly closed: Promise<void>
}

/** A masked client frame (RFC 6455 §5.2). */
export function clientFrame(
  opcode: number,
  payload: Buffer,
  o: { mask?: boolean; fin?: boolean; rsv?: number } = {},
): Buffer {
  const mask = o.mask !== false
  const length = payload.length
  const head: number[] = [((o.fin === false ? 0 : 0x80) | ((o.rsv ?? 0) << 4) | opcode) & 0xff]
  const bit = mask ? 0x80 : 0
  let ext = Buffer.alloc(0)
  if (length < 126) head.push(bit | length)
  else if (length < 0x10000) {
    head.push(bit | 126)
    ext = Buffer.alloc(2)
    ext.writeUInt16BE(length)
  } else {
    head.push(bit | 127)
    ext = Buffer.alloc(8)
    ext.writeBigUInt64BE(BigInt(length))
  }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, payload])
  const key = randomBytes(4)
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (key[i & 3] ?? 0)
  return Buffer.concat([Buffer.from(head), ext, key, body])
}

/**
 * A WebSocket handshake with exactly the headers given (`undefined` leaves one out), then
 * frames. The defaults are what a browser sends for the adb tunnel, minus the token.
 */
export function openWebSocket(
  port: number,
  opts: { path: string; host?: string; headers?: Record<string, string | undefined> },
): Promise<RawWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const headers: Record<string, string | undefined> = {
      Host: opts.host ?? `127.0.0.1:${String(port)}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      ...opts.headers,
    }
    const lines = [`GET ${opts.path} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${name}: ${value}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)

    let buffered = Buffer.alloc(0)
    let handshake: { status: number; headers: Record<string, string> } | null = null
    const frames: WsFrameIn[] = []
    const waiters: Array<(frame: WsFrameIn | null) => void> = []
    let ended = false
    let resolveClosed: () => void = () => undefined
    const closed = new Promise<void>((r) => {
      resolveClosed = r
    })

    const deliver = (frame: WsFrameIn | null): void => {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else if (frame) frames.push(frame)
    }
    const parseFrames = (): void => {
      for (;;) {
        if (buffered.length < 2) return
        const b0 = buffered[0] ?? 0
        let length = (buffered[1] ?? 0) & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffered.length < 4) return
          length = buffered.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffered.length < 10) return
          length = Number(buffered.readBigUInt64BE(2))
          offset = 10
        }
        if (buffered.length < offset + length) return
        const payload = Buffer.from(buffered.subarray(offset, offset + length))
        buffered = buffered.subarray(offset + length)
        deliver({ opcode: b0 & 0x0f, payload })
      }
    }
    const api = (): RawWebSocket => ({
      status: handshake?.status ?? 0,
      headers: handshake?.headers ?? {},
      body: handshake && handshake.status !== 101 ? buffered.toString('utf8') : '',
      next: (timeoutMs = 3_000) =>
        new Promise((res, rej) => {
          const frame = frames.shift()
          if (frame) return res(frame)
          if (ended) return rej(new Error('The connection ended.'))
          const timer = setTimeout(() => rej(new Error('No frame in time.')), timeoutMs)
          waiters.push((f) => {
            clearTimeout(timer)
            if (f) res(f)
            else rej(new Error('The connection ended.'))
          })
        }),
      rest: async () => {
        await closed
        return frames.splice(0)
      },
      send: (opcode, payload = Buffer.alloc(0), o = {}) => {
        socket.write(clientFrame(opcode, Buffer.from(payload), o))
      },
      hello: (service) => {
        socket.write(clientFrame(0x1, Buffer.from(JSON.stringify({ service }), 'utf8')))
      },
      raw: (bytes) => {
        socket.write(bytes)
      },
      close: () => socket.destroy(),
      closed,
    })
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!handshake) {
        const end = buffered.indexOf('\r\n\r\n')
        if (end < 0) return
        const [statusLine = '', ...rest] = buffered
          .subarray(0, end)
          .toString('latin1')
          .split('\r\n')
        const parsed: Record<string, string> = {}
        for (const line of rest) {
          const colon = line.indexOf(':')
          if (colon > 0)
            parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        handshake = { status: Number(statusLine.split(' ')[1] ?? 0), headers: parsed }
        buffered = buffered.subarray(end + 4)
        if (handshake.status !== 101) {
          /** A refusal: its body follows, then the helper closes. */
          socket.on('close', () => resolve(api()))
          return
        }
        resolve(api())
      }
      if (handshake.status === 101) parseFrames()
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      ended = true
      while (waiters.length) deliver(null)
      resolveClosed()
      if (!handshake) reject(new Error('Closed before the handshake.'))
    })
  })
}
