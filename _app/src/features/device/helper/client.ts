import { localized } from '@/lib/i18n'

import { DEVICE_ERRORS } from '../backends/backend'
import {
  TUNNEL_PROTOCOL,
  parseAdbInfo,
  parseDetail,
  parseDoctor,
  parseErrorBody,
  parseHealth,
  parseLan,
  parseLogMsg,
  parseConnectReply,
  parseDisconnectReply,
  parseNearby,
  parsePairReply,
  parseRetry,
  parseSnapshot,
  parseStartServer,
  parseTunnelReply,
  type AdbInfo,
  type AndroidLaneState,
  type DetailResponse,
  type DoctorReport,
  type ErrorBody,
  type Health,
  type HelperDevice,
  type LanResult,
  type LogMsg,
  type ConnectReply,
  type DisconnectReply,
  type NearbyReply,
  type PairReply,
  type ScreenshotSource,
  type Snapshot,
} from './protocol'
import { checkHost } from './network'

/*
  HTTP to the local helper (spec §2): one function per endpoint, each with its own deadline
  (§6.7), every reply narrowed by protocol.ts before anyone sees it, and every failure turned
  into a HelperError whose `message` the existing deviceErrorMessage() can word.

  The token goes in `Authorization: Bearer` and nowhere else, and only on the authenticated
  endpoints: health never carries it. Whether the token may be sent at all is the
  connection's decision (the port-bound proof, §2.8); getToken() returning null means "not
  now", and the request is refused here without touching the network.

  fetch options: no cache (the helper says no-store too), no cookies (credentials: 'omit'; the
  helper never sets any), and no Referer (the page's address could carry a fragment).
*/

/** How a request failed, for the connection's phase rules (§6.6). */
export type HelperErrorKind =
  /** fetch rejected: nothing listening, a blocked request, CORS refused (a 403 without CORS). */
  | 'network'
  /** Our own deadline (§6.7). */
  | 'timeout'
  /** The helper answered with an error status and (usually) an ErrorBody. */
  | 'http'
  /** The helper answered something this page can't read. */
  | 'protocol'
  /**
   * An adb tunnel's WebSocket closed before it opened (§4.10). Never read as the helper being
   * gone: a page can't see why a WebSocket was refused, so the connection's next poll decides.
   */
  | 'tunnel'

/** Words for the codes this module raises itself, until DEVICE_ERRORS has its own. */
const OWN_WORDS = localized<Readonly<Record<string, string>>>({
  en: {
    HELPER_UNREACHABLE:
      'The local helper stopped answering. Start it again; this page reconnects by itself.',
    HELPER_UNAUTHORIZED:
      'The helper restarted. Open the new link it printed to pair this page again.',
    HELPER_STREAM_STALLED: 'The helper stopped sending the log. Start it again.',
    HELPER_BAD_REPLY:
      'The helper answered something this page can’t read. Reload the page, or update the helper.',
    HELPER_FOREIGN: 'Something else answers on the helper’s port.',
    TOOL_TIMEOUT: 'The device took too long to answer. Try again.',
  },
  vi: {
    HELPER_UNREACHABLE:
      'Helper cục bộ không còn phản hồi. Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
    HELPER_UNAUTHORIZED:
      'Helper đã khởi động lại. Hãy mở liên kết mới mà helper đã in ra để ghép nối lại trang này.',
    // "Start it again" is the log's Start ("Bắt đầu"), as DEVICE_ERRORS words it.
    HELPER_STREAM_STALLED: 'Helper đã ngừng gửi log. Hãy bắt đầu lại log.',
    HELPER_BAD_REPLY:
      'Helper trả về nội dung mà trang này không đọc được. Hãy tải lại trang, hoặc cập nhật helper.',
    HELPER_FOREIGN: 'Một chương trình khác đang phản hồi trên cổng của helper.',
    TOOL_TIMEOUT: 'Thiết bị phản hồi quá lâu. Hãy thử lại.',
  },
})

/**
 * A failed helper request. `message` is the code when DEVICE_ERRORS words it (so
 * deviceErrorMessage() shows the page's sentence), else the helper's own plain-English
 * message, else this module's.
 */
export class HelperError extends Error {
  readonly code: string
  readonly kind: HelperErrorKind
  /** The HTTP status; 0 when there was no reply. */
  readonly status: number
  /** The helper's error body (tool, install, state, blockers…), when it sent one. */
  readonly body: ErrorBody['error'] | null

  constructor(
    code: string,
    kind: HelperErrorKind,
    opts: { status?: number; body?: ErrorBody['error'] | null } = {},
  ) {
    const helperWords = opts.body?.message ?? ''
    super(code in DEVICE_ERRORS ? code : helperWords || OWN_WORDS[code] || code)
    this.name = 'HelperError'
    this.code = code
    this.kind = kind
    this.status = opts.status ?? 0
    this.body = opts.body ?? null
  }
}

/** An abort the caller asked for: never an error worth showing. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

const abortError = () => new DOMException('The request was aborted.', 'AbortError')

/** The page's deadlines, in ms (§6.7). */
export const TIMEOUTS = {
  health: 3_000,
  devices: 5_000,
  rescan: 8_000,
  detail: 20_000,
  screenshot: 60_000,
  retry: 15_000,
  doctor: 20_000,
  startServer: 15_000,
  /**
   * The helper may take 5 s to resolve a name, gives adb 20 s to connect (more than adb's own
   * 10 s handshake wait) and 15 s to pair, then waits up to 3 s for the row.
   */
  connectNetwork: 35_000,
  pairNetwork: 25_000,
  disconnectNetwork: 10_000,
  /** The helper listens to mDNS for a few seconds on a fresh look; a cached answer is instant. */
  nearby: 12_000,
  /** A look takes the helper up to 7 s, a little more when it joins one already running. */
  lan: 20_000,
  /** No message on a log stream for this long: HELPER_STREAM_STALLED. */
  logWatchdog: 45_000,
  /** GET /api/devices/:id/adb: one `host:features` through the adb server. */
  adbInfo: 10_000,
  /** An adb tunnel's "ok": the helper gives the adb server 5 s per step. */
  adbOpen: 15_000,
} as const

/** fetch options every request shares. */
const BASE_INIT: RequestInit = {
  cache: 'no-store',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
}

export interface HelperClient {
  readonly apiBase: string
  /**
   * GET /api/health, public. With a challenge the reply carries the proof. `timeoutMs` null:
   * no deadline (the first probe while the browser may be showing its permission prompt).
   * Rejects with HELPER_FOREIGN when what answered isn't a helper.
   */
  readonly health: (
    challenge: string | null,
    opts?: { signal?: AbortSignal; timeoutMs?: number | null },
  ) => Promise<Health>
  readonly devices: (signal?: AbortSignal) => Promise<Snapshot>
  readonly rescan: (signal?: AbortSignal) => Promise<Snapshot>
  readonly detail: (id: string, signal?: AbortSignal) => Promise<DetailResponse>
  /** A PNG, checked and cut at IEND, with the tool the helper used (X-Screenshot-Source). */
  readonly screenshot: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<{ blob: Blob; source: ScreenshotSource | null }>
  /** The row after the read-only re-check; null when it has gone. */
  readonly retry: (id: string, signal?: AbortSignal) => Promise<HelperDevice | null>
  /**
   * Streams a device log until it ends or `signal` aborts. Resolves on EOF and on abort (never
   * an unhandled rejection); rejects when it could not open, or with HELPER_STREAM_STALLED.
   * Interpreting `end` is the caller's.
   */
  readonly logs: (
    id: string,
    onMsg: (message: LogMsg) => void,
    signal: AbortSignal,
    opts?: { watchdogMs?: number },
  ) => Promise<void>
  readonly doctor: (refresh: boolean, signal?: AbortSignal) => Promise<DoctorReport>
  readonly startServer: (signal?: AbortSignal) => Promise<AndroidLaneState>
  /**
   * Android over Wi‑Fi (feature `android.connect`, §4.7): adb's connect, pair and disconnect,
   * asked of Google's adb server by the helper. The address and the code travel in a JSON
   * body, never in the URL.
   */
  readonly connectNetwork: (target: NetworkTarget, signal?: AbortSignal) => Promise<ConnectReply>
  readonly pairNetwork: (target: PairTarget, signal?: AbortSignal) => Promise<PairReply>
  /** `serial`: the network serial the helper lists ("192.168.1.20:5555"). */
  readonly disconnectNetwork: (serial: string, signal?: AbortSignal) => Promise<DisconnectReply>
  /**
   * GET /api/android/nearby (feature `android.discover`): the Android devices advertising
   * debugging on the local network. `refresh`: look again now rather than answer from the
   * helper's last look. Only local addresses survive (checkHost), whatever the helper sent.
   */
  readonly nearby: (refresh: boolean, signal?: AbortSignal) => Promise<NearbyReply>
  /**
   * GET /api/lan/devices (feature `lan.discover`): every device on this computer's network.
   * `refresh` as for nearby. Only IPv4 addresses on a local network survive (checkHost).
   */
  readonly lanDevices: (refresh: boolean, signal?: AbortSignal) => Promise<LanResult>
  /** GET /api/devices/:id/adb (feature `android.adb`): what the adb transport needs first. */
  readonly adbInfo: (id: string, signal?: AbortSignal) => Promise<AdbInfo>
  /**
   * The adb tunnel (feature `android.adb`, §4.10): a WebSocket to one service of an Android
   * device the helper lists, open once the helper said "ok". Rejects with the helper's code
   * when it couldn't open (DEVICE_NOT_READY, BAD_REQUEST, TUNNEL_LIMIT, ANDROID_OFFLINE…).
   */
  readonly openAdb: (id: string, service: string, signal?: AbortSignal) => Promise<AdbTunnel>
}

/**
 * One open adb tunnel: a device service after the helper's "ok". What arrives is held until
 * read() takes it, so nothing is lost between the opening and the reader.
 */
export interface AdbTunnel {
  /** Every byte the service sends, in order; `onEnd` once, when either side closed it. */
  readonly read: (onData: (bytes: Uint8Array) => void, onEnd: () => void) => void
  /**
   * Sends `bytes` in pieces, waiting while the browser still holds much of it unsent (a
   * WebSocket has no back-pressure of its own). Rejects once the tunnel is closed.
   */
  readonly write: (bytes: Uint8Array) => Promise<void>
  readonly close: () => void
  /** Settles once the tunnel is closed, by either side. */
  readonly closed: Promise<void>
}

/** How the client opens a WebSocket; tests pass one that sets Origin, as a browser does. */
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocket

/** The page sends at most this much per frame, and waits while more than this is unsent. */
const TUNNEL_CHUNK = 256 * 1024
const TUNNEL_HIGH_WATER = 1024 * 1024

/** A device on the network, as adb names it: an address or a local name, and a port. */
export interface NetworkTarget {
  readonly host: string
  readonly port: number
}

/** Wireless debugging's pairing address and the six digits the device shows. */
export interface PairTarget extends NetworkTarget {
  readonly code: string
}

/**
 * A signal that aborts when `outer` does or `ms` passes, and says which. `dispose()` clears the
 * timer and the listener. Hand-rolled because AbortSignal.any is newer than some browsers this
 * page still answers.
 */
function deadline(outer: AbortSignal | undefined, ms: number | null) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => {
    controller.abort(outer?.reason)
  }
  if (outer?.aborted) controller.abort(outer.reason)
  else outer?.addEventListener('abort', onAbort, { once: true })
  const timer =
    ms === null
      ? undefined
      : setTimeout(() => {
          timedOut = true
          controller.abort(new DOMException('The helper took too long.', 'TimeoutError'))
        }, ms)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

/** A reply's JSON, or undefined when it isn't JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    const value: unknown = await res.json()
    return value
  } catch {
    return undefined
  }
}

/** The page's code for the helper's: a 401 means the pairing ended, whatever the run. */
function pageCode(code: string): string {
  return code === 'UNAUTHORIZED' ? 'HELPER_UNAUTHORIZED' : code
}

async function httpError(res: Response): Promise<HelperError> {
  const body = parseErrorBody(await readJson(res))
  if (!body) {
    const code = res.status === 401 ? 'HELPER_UNAUTHORIZED' : 'HELPER_BAD_REPLY'
    return new HelperError(code, res.status === 401 ? 'http' : 'protocol', { status: res.status })
  }
  return new HelperError(pageCode(body.error.code), 'http', {
    status: res.status,
    body: body.error,
  })
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** IEND's type, and its CRC: fixed, since the chunk carries no data. */
const IEND_TYPE = 0x49454e44
const IEND_CRC = 0xae426082
/** A chunk type is four ASCII letters (PNG §5.4). */
const isChunkType = (bytes: Uint8Array, at: number) =>
  [0, 1, 2, 3].every((k) => {
    const b = bytes[at + k] ?? 0
    return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
  })

/**
 * The PNG in `bytes`: it must start with the signature, and is cut after the IEND chunk, so
 * trailing noise from a tool never reaches an <img>. The chunks are walked by their lengths
 * (length, type, data, CRC): the bytes "IEND" can turn up inside compressed image data, and a
 * search for them would cut a good screenshot short. Null when it isn't a whole PNG.
 */
export function extractPng(bytes: Uint8Array): Uint8Array | null {
  if (PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = PNG_SIGNATURE.length
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at)
    if (length > 0x7fffffff || !isChunkType(bytes, at + 4)) return null
    const end = at + 12 + length
    if (end > bytes.length) return null
    if (view.getUint32(at + 4) === IEND_TYPE) {
      return length === 0 && view.getUint32(at + 8) === IEND_CRC ? bytes.subarray(0, end) : null
    }
    at = end
  }
  return null
}

const SOURCES: readonly ScreenshotSource[] = ['devicectl', 'idevicescreenshot', 'simctl', 'adb']

/** Longest NDJSON line kept; a longer one is skipped whole, up to its newline. */
export const MAX_NDJSON_LINE = 1_048_576

/**
 * Reads an NDJSON body into messages: split across chunks and mid-UTF-8 alike, a line that
 * isn't a known message skipped, a line over 1 MiB skipped whole. Resolves at the end of the
 * body, and quietly when `signal` aborts; rejects with HELPER_STREAM_STALLED when no message
 * arrives for `watchdogMs`, and with HELPER_UNREACHABLE when the connection breaks.
 */
export function readNdjson(
  body: ReadableStream<Uint8Array> | null,
  onMsg: (message: LogMsg) => void,
  opts: { watchdogMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (!body) return Promise.resolve()
  const { signal } = opts
  const watchdogMs = opts.watchdogMs ?? TIMEOUTS.logWatchdog
  const reader = body.getReader()
  const decoder = new TextDecoder()

  return new Promise<void>((resolve, reject) => {
    let carry = ''
    let skipping = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reader.cancel().catch(() => undefined)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => {
      finish()
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        finish(new HelperError('HELPER_STREAM_STALLED', 'timeout'))
      }, watchdogMs)
    }
    const line = (text: string) => {
      if (!text.trim()) return
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return
      }
      const message = parseLogMsg(value)
      if (!message) return
      arm()
      onMsg(message)
    }
    const take = (text: string) => {
      carry += text
      let nl = carry.indexOf('\n')
      while (nl >= 0 && !settled) {
        const one = carry.slice(0, nl)
        carry = carry.slice(nl + 1)
        // The tail of a line already over the cap, or a whole one that arrived at once.
        if (skipping) skipping = false
        else if (one.length <= MAX_NDJSON_LINE) line(one)
        nl = carry.indexOf('\n')
      }
      if (carry.length > MAX_NDJSON_LINE) {
        carry = ''
        skipping = true
      }
    }

    if (signal?.aborted) {
      finish()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    arm()

    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (settled) return
        if (done) {
          take(decoder.decode())
          if (!skipping && carry.length <= MAX_NDJSON_LINE) line(carry)
          finish()
          return
        }
        take(decoder.decode(value, { stream: true }))
      }
    }
    pump().catch(() => {
      finish(signal?.aborted ? undefined : new HelperError('HELPER_UNREACHABLE', 'network'))
    })
  })
}

/**
 * The client for one helper address. `getToken` is read per request, so a pairing made or
 * forgotten in between applies at once.
 */
export function createHelperClient(
  apiBase: string,
  getToken: () => string | null,
  deps: { fetch?: typeof fetch; webSocket?: WebSocketFactory } = {},
): HelperClient {
  // Called unbound: window.fetch throws "Illegal invocation" when called as a method of another object.
  const doFetch =
    deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const newWebSocket: WebSocketFactory =
    deps.webSocket ?? ((url, protocols) => new WebSocket(url, protocols))
  const url = (path: string) => apiBase + path
  const devicePath = (id: string, action: string) =>
    `/api/devices/${encodeURIComponent(id)}/${action}`

  /**
   * One request. Network failures, our deadline and the caller's abort come out as a
   * HelperError (network, timeout) or the AbortError; the reply is returned as it is.
   */
  async function send(
    path: string,
    init: {
      method?: 'GET' | 'POST'
      auth: boolean
      signal?: AbortSignal
      timeoutMs: number | null
      /** Sent as application/json. */
      json?: unknown
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    if (init.auth) {
      const token = getToken()
      // Never a request without the proof having passed: the connection withholds the token.
      if (!token) throw new HelperError('HELPER_UNAUTHORIZED', 'http', { status: 401 })
      headers.Authorization = `Bearer ${token}`
    }
    const d = deadline(init.signal, init.timeoutMs)
    try {
      return await doFetch(url(path), {
        ...BASE_INIT,
        method: init.method ?? 'GET',
        headers,
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        signal: d.signal,
      })
    } catch (error) {
      if (init.signal?.aborted) throw abortError()
      if (d.timedOut()) throw new HelperError('TOOL_TIMEOUT', 'timeout')
      if (isAbortError(error)) throw abortError()
      throw new HelperError('HELPER_UNREACHABLE', 'network')
    } finally {
      d.dispose()
    }
  }

  /** An authenticated JSON call, narrowed by `parse`. */
  async function call<T>(
    path: string,
    parse: (value: unknown) => T | null,
    opts: { method?: 'GET' | 'POST'; signal?: AbortSignal; timeoutMs: number; json?: unknown },
  ): Promise<T> {
    const res = await send(path, { ...opts, auth: true })
    if (!res.ok) throw await httpError(res)
    const value = parse(await readJson(res))
    if (value === null)
      throw new HelperError('HELPER_BAD_REPLY', 'protocol', { status: res.status })
    return value
  }

  return {
    apiBase,

    async health(challenge, opts = {}) {
      const query = challenge === null ? '' : `?challenge=${encodeURIComponent(challenge)}`
      const res = await send(`/api/health${query}`, {
        auth: false,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs === undefined ? TIMEOUTS.health : opts.timeoutMs,
      })
      // A readable non-helper reply: another program owns the port.
      if (!res.ok) throw new HelperError('HELPER_FOREIGN', 'protocol', { status: res.status })
      const health = parseHealth(await readJson(res))
      if (!health) throw new HelperError('HELPER_FOREIGN', 'protocol', { status: res.status })
      return health
    },

    devices: (signal) =>
      call('/api/devices', parseSnapshot, { signal, timeoutMs: TIMEOUTS.devices }),

    rescan: (signal) =>
      call('/api/rescan', parseSnapshot, { method: 'POST', signal, timeoutMs: TIMEOUTS.rescan }),

    detail: (id, signal) =>
      call(devicePath(id, 'detail'), parseDetail, { signal, timeoutMs: TIMEOUTS.detail }),

    async screenshot(id, signal) {
      const res = await send(devicePath(id, 'screenshot'), {
        method: 'POST',
        auth: true,
        signal,
        timeoutMs: TIMEOUTS.screenshot,
      })
      if (!res.ok) throw await httpError(res)
      const type = res.headers.get('Content-Type') ?? ''
      const png = /^image\/png\b/i.test(type)
        ? extractPng(new Uint8Array(await res.arrayBuffer()))
        : null
      if (!png) throw new HelperError('SCREENSHOT_NOT_PNG', 'protocol', { status: res.status })
      const said = res.headers.get('X-Screenshot-Source')
      return {
        blob: new Blob([png.slice()], { type: 'image/png' }),
        source: SOURCES.find((s) => s === said) ?? null,
      }
    },

    async retry(id, signal) {
      const reply = await call(devicePath(id, 'retry'), parseRetry, {
        method: 'POST',
        signal,
        timeoutMs: TIMEOUTS.retry,
      })
      return reply.device
    },

    async logs(id, onMsg, signal, opts = {}) {
      let res: Response
      try {
        res = await send(devicePath(id, 'logs'), { auth: true, signal, timeoutMs: null })
      } catch (error) {
        // Stop pressed while the stream was opening: nothing to report.
        if (signal.aborted && isAbortError(error)) return
        throw error
      }
      if (!res.ok) throw await httpError(res)
      if (!/^application\/x-ndjson\b/i.test(res.headers.get('Content-Type') ?? '')) {
        await res.body?.cancel().catch(() => undefined)
        throw new HelperError('HELPER_BAD_REPLY', 'protocol', { status: res.status })
      }
      await readNdjson(res.body, onMsg, { signal, watchdogMs: opts.watchdogMs })
    },

    doctor: (refresh, signal) =>
      call(refresh ? '/api/doctor?refresh=1' : '/api/doctor', parseDoctor, {
        signal,
        timeoutMs: TIMEOUTS.doctor,
      }),

    async startServer(signal) {
      const reply = await call('/api/android/start-server', parseStartServer, {
        method: 'POST',
        signal,
        timeoutMs: TIMEOUTS.startServer,
      })
      return reply.android
    },

    connectNetwork: (target, signal) =>
      call('/api/android/connect', parseConnectReply, {
        method: 'POST',
        signal,
        timeoutMs: TIMEOUTS.connectNetwork,
        json: { host: target.host, port: target.port },
      }),

    pairNetwork: (target, signal) =>
      call('/api/android/pair', parsePairReply, {
        method: 'POST',
        signal,
        timeoutMs: TIMEOUTS.pairNetwork,
        json: { host: target.host, port: target.port, code: target.code },
      }),

    disconnectNetwork: (serial, signal) =>
      call('/api/android/disconnect', parseDisconnectReply, {
        method: 'POST',
        signal,
        timeoutMs: TIMEOUTS.disconnectNetwork,
        json: { serial },
      }),

    nearby: (refresh, signal) =>
      call(
        refresh ? '/api/android/nearby?refresh=1' : '/api/android/nearby',
        (value) => parseNearby(value, localHostOf),
        { signal, timeoutMs: TIMEOUTS.nearby },
      ),

    lanDevices: (refresh, signal) =>
      call(
        refresh ? '/api/lan/devices?refresh=1' : '/api/lan/devices',
        (value) => parseLan(value, localHostOf),
        { signal, timeoutMs: TIMEOUTS.lan },
      ),

    adbInfo: (id, signal) =>
      call(devicePath(id, 'adb'), parseAdbInfo, { signal, timeoutMs: TIMEOUTS.adbInfo }),

    openAdb(id, service, signal) {
      const token = getToken()
      if (!token) {
        return Promise.reject(new HelperError('HELPER_UNAUTHORIZED', 'http', { status: 401 }))
      }
      const ws = newWebSocket(apiBase.replace(/^http/, 'ws') + devicePath(id, 'adb'), [
        TUNNEL_PROTOCOL,
        `bearer.${token}`,
      ])
      ws.binaryType = 'arraybuffer'
      return openTunnel(ws, service, signal)
    },
  }
}

/**
 * Names the service, waits for the helper's answer, and wraps the open WebSocket. A refusal
 * before the WebSocket opened (a stopped helper, a wrong token) can't be read by a page: it is
 * ADB_TUNNEL_FAILED of kind `tunnel`, and the connection's next poll says what changed.
 */
function openTunnel(ws: WebSocket, service: string, signal?: AbortSignal): Promise<AdbTunnel> {
  const d = deadline(signal, TIMEOUTS.adbOpen)
  const pending: Uint8Array[] = []
  let reader: { onData: (bytes: Uint8Array) => void; onEnd: () => void } | null = null
  let ended = false
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const end = () => {
    if (ended) return
    ended = true
    resolveClosed()
    reader?.onEnd()
  }

  const tunnel: AdbTunnel = {
    read(onData, onEnd) {
      reader = { onData, onEnd }
      for (const bytes of pending.splice(0)) onData(bytes)
      if (ended) onEnd()
    },
    async write(bytes) {
      for (let at = 0; at < bytes.length; at += TUNNEL_CHUNK) {
        if (ended || ws.readyState !== WebSocket.OPEN) throw new HelperError('DEVICE_GONE', 'http')
        // A copy per piece: send() wants an ArrayBuffer-backed view, and copies it anyway.
        ws.send(bytes.slice(at, at + TUNNEL_CHUNK))
        while (ws.bufferedAmount > TUNNEL_HIGH_WATER && !ended) {
          await new Promise((resolve) => setTimeout(resolve, 4))
        }
      }
    },
    close() {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(1000)
      }
      end()
    },
    closed,
  }

  return new Promise<AdbTunnel>((resolve, reject) => {
    let opened = false
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      d.dispose()
      tunnel.close()
      reject(error)
    }
    const onAbort = () => {
      fail(
        signal?.aborted || !d.timedOut()
          ? abortError()
          : new HelperError('TOOL_TIMEOUT', 'timeout'),
      )
    }
    if (d.signal.aborted) onAbort()
    else d.signal.addEventListener('abort', onAbort, { once: true })

    ws.addEventListener('open', () => {
      opened = true
      ws.send(JSON.stringify({ service }))
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data
      if (settled) {
        // After "ok", bytes only: the helper closes the tunnel on anything else.
        if (!(data instanceof ArrayBuffer) || ended) return
        const bytes = new Uint8Array(data)
        if (reader) reader.onData(bytes)
        else pending.push(bytes)
        return
      }
      const reply = typeof data === 'string' ? parseTunnelReply(data) : null
      if (!reply) {
        fail(new HelperError('HELPER_BAD_REPLY', 'protocol'))
      } else if (reply.t === 'error') {
        const code = pageCode(reply.code)
        fail(
          new HelperError(code, 'http', {
            body: { code: reply.code, message: reply.message },
          }),
        )
      } else {
        settled = true
        d.signal.removeEventListener('abort', onAbort)
        d.dispose()
        resolve(tunnel)
      }
    })
    ws.addEventListener('close', () => {
      end()
      if (!settled) {
        fail(
          opened
            ? new HelperError('HELPER_BAD_REPLY', 'protocol')
            : new HelperError('ADB_TUNNEL_FAILED', 'tunnel'),
        )
      }
    })
  })
}

/** checkHost's normalised host, or null: what parseNearby keeps. */
const localHostOf = (host: string): string | null => {
  const checked = checkHost(host)
  return checked.ok ? checked.host : null
}
