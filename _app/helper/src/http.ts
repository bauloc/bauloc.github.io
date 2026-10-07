import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { serveTunnel, type Tunnel } from './adb-tunnel'
import {
  ADB_NETWORK_PORT,
  assertTunnelService,
  parseNetworkHost,
  parseNetworkPort,
  parsePairingCode,
} from './android-lane'
import { DEV_ORIGINS, LIMITS, SITE, isDeviceId } from './constants'
import type { LocalMode } from './local-mode'
import { ToolError } from './process'
import type { Registry } from './registry'
import type {
  AndroidConnectResult,
  AndroidDisconnectResult,
  AndroidLane,
  AndroidNearbyResult,
  AndroidPairResult,
  BridgeOptions,
  DoctorReport,
  ErrorBody,
  Health,
  HelperDevice,
  Lane,
  LaneSet,
  LanScanner,
  LogEndReason,
  LogMsg,
  LogSink,
  LogSource,
  ToolsCache,
} from './types'
import {
  HelperError,
  abortError,
  aborted,
  clean,
  errorText,
  extractPng,
  isAbortError,
  linkSignals,
  seconds,
} from './util'
import { CLOSE, WS_KEY, acceptKey, offeredProtocols } from './websocket'

/** Everything the HTTP layer needs from the bridge. */
export interface ApiDeps {
  readonly options: BridgeOptions
  readonly registry: Registry
  readonly lanes: LaneSet
  readonly tools: ToolsCache
  readonly tokenId: string
  readonly bearer: (header: string | undefined) => boolean
  readonly health: (challenge: string | null) => Health
  readonly doctor: (refresh: boolean) => Promise<DoctorReport>
  readonly local: LocalMode | null
  /** The bound port: Host and Origin are checked against it. */
  readonly port: () => number
  /** "Page connected" once per page and browser: `origin` is undefined for a client without one. */
  readonly pageConnected: (
    origin: string | undefined,
    host: string,
    userAgent: string | undefined,
  ) => void
  /** One timestamped terminal line. */
  readonly log: (line: string) => void
  /** An unexpected failure: stderr, never the page. */
  readonly bug: (error: unknown) => void
  /** Aborts on shutdown. */
  readonly signal: AbortSignal
  /** Every device on this network (§4.9): the bridge's, whichever lanes run. */
  readonly lan: LanScanner
}

export interface Api {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void
  /** The server's `upgrade` event: the adb tunnel's WebSocket (§4.10), and nothing else. */
  readonly upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Shutdown: every open log stream ends with this reason, and every adb tunnel closes. */
  readonly endStreams: (reason: 'shutdown') => void
  readonly openStreams: () => number
  readonly openTunnels: () => number
}

/** The adb tunnel's WebSocket subprotocol (§4.10); the helper answers with this one only. */
export const TUNNEL_PROTOCOL = 'device-bridge.adb.v1'
/** The page's token, offered as a second subprotocol: `bearer.<token>`. */
export const BEARER_PROTOCOL = 'bearer.'

type Headers = Record<string, string>

/* ----------------------------------------------------------------- JSON writers --- */

/** ECIDs and other identifiers can exceed 2^53; a stray BigInt must never crash a reply. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function toJson(body: unknown): string {
  return JSON.stringify(body, bigintReplacer)
}

/** A JSON reply with a Content-Length. Silently skipped when the client already left. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Headers,
): void {
  if (res.headersSent || res.destroyed) return
  const bytes = Buffer.from(toJson(body), 'utf8')
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): ErrorBody {
  return { error: { ...extra, code, message } }
}

/** What a failure looks like on the wire, or null when nobody is left to tell (an abort). */
export function describeError(error: unknown): { status: number; body: ErrorBody } | null {
  if (error instanceof HelperError) {
    return { status: error.status, body: errorBody(error.code, error.message, { ...error.extra }) }
  }
  if (error instanceof ToolError) {
    const tool = path.basename(error.file)
    switch (error.reason) {
      case 'aborted':
        return null
      case 'not-found':
        return {
          status: 503,
          body: errorBody('TOOL_MISSING', `${tool} is not installed.`, { tool }),
        }
      case 'timeout':
        return { status: 504, body: errorBody('TOOL_TIMEOUT', `${tool} took too long to answer.`) }
      case 'too-large':
        return {
          status: 502,
          body: errorBody('TOOL_FAILED', `${tool} printed more than the helper accepts.`),
        }
      case 'exit':
      case 'spawn-failed': {
        const said = clean(error.stderr.trim(), LIMITS.stderr).slice(-500)
        const fallback =
          error.reason === 'exit'
            ? `${tool} failed (exit code ${String(error.code)}).`
            : `${tool} could not be started.`
        return { status: 502, body: errorBody('TOOL_FAILED', said || fallback) }
      }
    }
  }
  if (isAbortError(error)) return null
  return {
    status: 500,
    body: errorBody('INTERNAL', 'The helper hit a bug. Its terminal window says more.'),
  }
}

/* --------------------------------------------------------------------- the gate --- */

const PAGE_PATHS = new Set(['/', '/device', '/device/', '/device/index.html'])

/** `/api/x?y` → ['/api/x', '?y'], without normalising: ids are checked exactly as sent. */
function splitTarget(target: string): { pathname: string; search: string } {
  const q = target.indexOf('?')
  return q < 0
    ? { pathname: target, search: '' }
    : { pathname: target.slice(0, q), search: target.slice(q) }
}

/** Headers on every /api/* reply, errors included, so the page can read a 401 or a 409. */
function apiHeaders(origin: string | undefined): Headers {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'X-Screenshot-Source',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  }
}

/** For refusals before the Origin is accepted: no CORS header, so no page can read them. */
const BARE: Headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Origin',
}

function bodyTooLarge(req: IncomingMessage): boolean {
  const length = req.headers['content-length']
  if (length !== undefined) return !/^\d+$/.test(length) || Number(length) > LIMITS.body
  /** A chunked body has no length to check; the Wi-Fi routes' JSON always comes with one. */
  return req.headers['transfer-encoding'] !== undefined
}

/** A top-level navigation to the local page: the one cross-site request without Origin let in. */
function isPageNavigation(req: IncomingMessage, pathname: string): boolean {
  return (
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document' &&
    PAGE_PATHS.has(pathname)
  )
}

const ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = {
  '/api/health': 'GET',
  '/api/devices': 'GET',
  '/api/rescan': 'POST',
  '/api/doctor': 'GET',
  '/api/android/start-server': 'POST',
  '/api/android/connect': 'POST',
  '/api/android/pair': 'POST',
  '/api/android/disconnect': 'POST',
  '/api/android/nearby': 'GET',
  '/api/lan/devices': 'GET',
}

const DEVICE_ROUTE = /^\/api\/devices\/([^/]*)\/(detail|screenshot|retry|logs|adb)$/
const DEVICE_ACTIONS = {
  detail: 'GET',
  screenshot: 'POST',
  retry: 'POST',
  logs: 'GET',
  adb: 'GET',
} as const
/** The adb tunnel's WebSocket (§4.10): the same path as its GET, upgraded. */
const TUNNEL_ROUTE = /^\/api\/devices\/([^/]*)\/adb$/
type DeviceAction = keyof typeof DEVICE_ACTIONS

/** A log stream that ends before hello answers with an ordinary JSON error (§2.5). */
const OPENING_ERRORS: Partial<Record<LogEndReason, () => HelperError>> = {
  'device-gone': () =>
    new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.'),
  replaced: () =>
    new HelperError(
      'STREAM_REPLACED',
      409,
      'A newer log stream for this device replaced this one.',
    ),
  shutdown: () => new HelperError('HELPER_STOPPING', 503, 'The helper is stopping.'),
}

/** A stream whose lane failed with one of these ends as device-gone: the device left or dropped. */
const DEVICE_GONE_CODES = new Set(['DEVICE_NOT_FOUND', 'DEVICE_DROPPED'])

/* ------------------------------------------------------------------------ the API --- */

/**
 * The HTTP API (§2): every request goes through the pipeline of §2.1 in its fixed order —
 * Host, Origin, Fetch Metadata, body cap, preflight, public health, bearer token — and
 * only then reaches a route. Device routes find their lane through the registry, never
 * through the shape of the id, and every operation gets a signal that aborts when the
 * client leaves or the helper stops, so no tool outlives the request that started it.
 */
export function createApi(deps: ApiDeps): Api {
  const { options, registry, lanes } = deps
  const shots = new Set<string>()
  const streams = new Map<string, { end: (reason: LogEndReason) => void }>()
  const tunnels = new Set<Tunnel>()
  /** Open adb tunnels per device id (§4.10). */
  const tunnelsOf = new Map<string, number>()
  let hostsFor = -1
  let hosts = new Set<string>()
  let origins = new Set<string>()

  /** Host and Origin allowlists, rebuilt when the port is known (listen) or changes (tests). */
  const allowlists = (): { hosts: Set<string>; origins: Set<string> } => {
    const port = deps.port()
    if (port !== hostsFor) {
      hostsFor = port
      hosts = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`])
      origins = new Set([
        SITE,
        `http://127.0.0.1:${String(port)}`,
        `http://localhost:${String(port)}`,
        ...(options.dev ? DEV_ORIGINS : []),
      ])
    }
    return { hosts, origins }
  }

  const fail = (res: ServerResponse, error: unknown, headers: Headers): void => {
    const described = describeError(error)
    if (!described) {
      if (!res.headersSent) res.destroy()
      return
    }
    if (described.status >= 500 && described.body.error.code === 'INTERNAL') deps.bug(error)
    if (described.body.error.code === 'TOOL_MISSING')
      void deps.tools.refresh().catch(() => undefined)
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, described.status, described.body, headers)
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const started = Date.now()
    const { pathname, search } = splitTarget(req.url ?? '/')
    if (options.verbose) {
      /** Method, path and status only: never a header, a query string or a token. */
      let logged = false
      const line = (): void => {
        if (logged) return
        logged = true
        deps.log(
          `${req.method ?? '?'} ${pathname} ${String(res.statusCode)} ${String(Date.now() - started)} ms`,
        )
      }
      res.on('finish', line)
      res.on('close', line)
    }
    pipeline(req, res, pathname, search).catch((error: unknown) => fail(res, error, BARE))
  }

  /** §2.1, in this order, every step tested. */
  async function pipeline(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    const { hosts, origins } = allowlists()
    /** 1. Host: a DNS-rebound evil.example still says `Host: evil.example:8787`. */
    const host = (req.headers.host ?? '').toLowerCase()
    if (!hosts.has(host)) {
      return sendJson(
        res,
        421,
        errorBody('BAD_HOST', 'This helper answers only to 127.0.0.1 and localhost.'),
        BARE,
      )
    }
    if (!pathname.startsWith('/')) {
      return sendJson(res, 400, errorBody('BAD_REQUEST', 'Only origin-form request targets.'), BARE)
    }
    /** 2. Origin, when sent: exact match, never echoed unless allowed. */
    const origin = req.headers.origin
    if (origin !== undefined && !origins.has(origin)) {
      return sendJson(res, 403, errorBody('BAD_ORIGIN', 'This page may not use the helper.'), BARE)
    }
    /** 3. Fetch Metadata: <img>, forms and no-cors requests from other sites carry no Origin. */
    const site = req.headers['sec-fetch-site']
    if (
      origin === undefined &&
      (site === 'cross-site' || site === 'same-site') &&
      !isPageNavigation(req, pathname)
    ) {
      return sendJson(
        res,
        403,
        errorBody('BAD_ORIGIN', 'Cross-site requests need an allowed Origin.'),
        BARE,
      )
    }
    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    const headers = isApi
      ? apiHeaders(origin)
      : {
          'X-Content-Type-Options': 'nosniff',
          Vary: 'Origin',
          ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        }
    if (bodyTooLarge(req)) {
      return sendJson(
        res,
        413,
        errorBody(
          'PAYLOAD_TOO_LARGE',
          'Request bodies are at most 1 KiB, sent with a Content-Length.',
        ),
        {
          ...headers,
          Connection: 'close',
        },
      )
    }
    /** 4. The CORS preflight: no token needed; Authorization is never covered by `*`. */
    if (req.method === 'OPTIONS') {
      if (!isApi) {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'GET only.'), {
          ...headers,
          Allow: 'GET, HEAD',
        })
      }
      const preflight: Headers = {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
      }
      /** Chromium 104–141's Private Network Access preflight; LNA (142+) asks the user instead. */
      if (req.headers['access-control-request-private-network'] === 'true') {
        preflight['Access-Control-Allow-Private-Network'] = 'true'
      }
      res.writeHead(204, preflight)
      res.end()
      return
    }
    if (!isApi) {
      if (!deps.local) return sendJson(res, 404, errorBody('NOT_FOUND', 'Nothing here.'), headers)
      return deps.local.handle(req, res, pathname, search, host)
    }
    /** 5. Health is public: it carries no device data and never the token. */
    if (pathname === '/api/health') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET', headers)
      const challenge = new URLSearchParams(search).get('challenge')
      return sendJson(res, 200, deps.health(challenge), headers)
    }
    /** 6. Every other /api/* needs the bearer token. */
    if (!deps.bearer(req.headers.authorization)) {
      return sendJson(
        res,
        401,
        errorBody('UNAUTHORIZED', 'Missing or wrong token. Open the link the helper printed.', {
          tokenId: deps.tokenId,
        }),
        { ...headers, 'WWW-Authenticate': 'Bearer realm="device-bridge"' },
      )
    }
    registry.touch()
    deps.pageConnected(origin, host, req.headers['user-agent'])
    /** 7. Route. */
    try {
      await route(req, res, pathname, search, headers)
    } catch (error) {
      fail(res, error, headers)
    }
  }

  function methodNotAllowed(res: ServerResponse, allow: string, headers: Headers): void {
    sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `${allow} only.`), {
      ...headers,
      Allow: allow,
    })
  }

  /** An AbortSignal for one operation: the client leaving, shutdown, or an optional deadline. */
  function operation(res: ServerResponse, timeoutMs?: number): ReturnType<typeof linkSignals> {
    const op = linkSignals([deps.signal], timeoutMs)
    /**
     * `res` 'close' before the response finished is the one reliable "client went away"
     * signal (req 'close' fires as soon as the request body is read).
     */
    res.on('close', () => {
      if (!res.writableFinished) op.abort()
    })
    return op
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
    headers: Headers,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const fixed = ROUTES[pathname]
    if (fixed) {
      if (method !== fixed) return methodNotAllowed(res, fixed, headers)
      if (pathname === '/api/devices') return sendJson(res, 200, registry.snapshot(), headers)
      if (pathname === '/api/rescan') return rescan(res, headers)
      if (pathname === '/api/doctor') {
        const refresh = new URLSearchParams(search).get('refresh') === '1'
        return sendJson(res, 200, await deps.doctor(refresh), headers)
      }
      if (pathname === '/api/android/connect') return connectNetwork(req, res, headers)
      if (pathname === '/api/android/pair') return pairNetwork(req, res, headers)
      if (pathname === '/api/android/disconnect') return disconnectNetwork(req, res, headers)
      if (pathname === '/api/android/nearby') return nearby(res, search, headers)
      if (pathname === '/api/lan/devices') return lanDevices(res, search, headers)
      /** The last fixed route: every one above has its own line, or it would land here. */
      return startAdbServer(res, headers)
    }
    const match = DEVICE_ROUTE.exec(pathname)
    if (!match) return sendJson(res, 404, errorBody('NOT_FOUND', 'No such endpoint.'), headers)
    const action = match[2] as DeviceAction
    if (method !== DEVICE_ACTIONS[action])
      return methodNotAllowed(res, DEVICE_ACTIONS[action], headers)
    const { id, lane, row } = resolveDevice(match[1] ?? '')
    if (action === 'retry') return retry(res, headers, id, lane)
    assertReady(row)
    if (action === 'adb') {
      const android = tunnelLane(id)
      const op = operation(res)
      try {
        return sendJson(res, 200, await android.adbInfo(id, op.signal), headers)
      } finally {
        op.dispose()
      }
    }
    if (action === 'detail') {
      const op = operation(res)
      try {
        return sendJson(res, 200, await lane.detail(id, op.signal), headers)
      } finally {
        op.dispose()
      }
    }
    if (action === 'screenshot') return screenshot(res, headers, id, lane)
    return openLogStream(res, headers, id, lane)
  }

  function assertReady(row: HelperDevice): void {
    if (row.state !== 'ready') {
      throw new HelperError('DEVICE_NOT_READY', 409, 'The device is not ready yet.', {
        state: row.state,
        blockers: row.blockers,
      })
    }
  }

  /** §4.10: only the Android lane's devices have an adb tunnel. */
  function tunnelLane(id: string): AndroidLane {
    if (registry.owner(id) !== 'android') {
      throw new HelperError('BAD_REQUEST', 400, 'Only an Android device has an adb tunnel.')
    }
    return androidLane()
  }

  /**
   * §4.10, the adb tunnel's WebSocket. The gate of §2.1, stricter where a WebSocket differs:
   * CORS never applies to one, so an allowed Origin is required (a browser always sends it),
   * and the token comes as a subprotocol, `bearer.<token>`, since a page can't set headers on
   * a WebSocket. Refusals until then are bare HTTP replies, which a page can't read. Once the
   * token is right the WebSocket opens, and a tunnel that can't open says why in its first
   * message, which the page can read.
   */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined)
    const started = Date.now()
    const { pathname } = splitTarget(req.url ?? '/')
    const refuse = (status: number, code: string, message: string, extra: Headers = {}): void => {
      const body = toJson(errorBody(code, message))
      const lines = [
        `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}`,
        'Connection: close',
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        ...Object.entries({ ...BARE, ...extra }).map(([name, value]) => `${name}: ${value}`),
      ]
      socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`)
      if (options.verbose) deps.log(`WS ${pathname} ${String(status)}`)
    }
    const { hosts, origins } = allowlists()
    const host = (req.headers.host ?? '').toLowerCase()
    if (!hosts.has(host)) {
      return refuse(421, 'BAD_HOST', 'This helper answers only to 127.0.0.1 and localhost.')
    }
    const origin = req.headers.origin
    if (origin === undefined || !origins.has(origin)) {
      return refuse(403, 'BAD_ORIGIN', 'This page may not use the helper.')
    }
    const match = TUNNEL_ROUTE.exec(pathname)
    if (!match || req.method !== 'GET') return refuse(404, 'NOT_FOUND', 'No such endpoint.')
    const key = req.headers['sec-websocket-key']
    if (
      (req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
      typeof key !== 'string' ||
      !WS_KEY.test(key)
    ) {
      return refuse(400, 'BAD_REQUEST', 'Not a WebSocket handshake.')
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      return refuse(426, 'BAD_REQUEST', 'WebSocket version 13 only.', {
        'Sec-WebSocket-Version': '13',
      })
    }
    const offered = offeredProtocols(req.headers['sec-websocket-protocol'])
    const bearer = offered.find((p) => p.startsWith(BEARER_PROTOCOL))
    if (
      !offered.includes(TUNNEL_PROTOCOL) ||
      !deps.bearer(bearer ? `Bearer ${bearer.slice(BEARER_PROTOCOL.length)}` : undefined)
    ) {
      return refuse(
        401,
        'UNAUTHORIZED',
        'Missing or wrong token. Open the link the helper printed.',
        {
          'WWW-Authenticate': 'Bearer realm="device-bridge"',
        },
      )
    }
    registry.touch()
    deps.pageConnected(origin, host, req.headers['user-agent'])
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        `Sec-WebSocket-Protocol: ${TUNNEL_PROTOCOL}`,
        '',
        '',
      ].join('\r\n'),
    )
    if (socket instanceof Socket) socket.setNoDelay(true)

    let counted: string | null = null
    const tunnel = serveTunnel(socket, head, {
      open: (service, signal) => {
        const { id, row } = resolveDevice(match[1] ?? '')
        const android = tunnelLane(id)
        assertReady(row)
        /** Refused here with a clear answer; the adb client checks it again before sending. */
        assertTunnelService(service)
        const mine = tunnelsOf.get(id) ?? 0
        if (tunnels.size > LIMITS.tunnels || mine >= LIMITS.tunnelsPerDevice) {
          throw new HelperError(
            'TUNNEL_LIMIT',
            429,
            'Too many operations are open on the helper at once. Try again in a moment.',
          )
        }
        counted = id
        tunnelsOf.set(id, mine + 1)
        return android.openTunnel(id, service, signal)
      },
      describe(error) {
        const described = describeError(error)
        if (!described) return null
        if (described.status >= 500 && described.body.error.code === 'INTERNAL') deps.bug(error)
        return { code: described.body.error.code, message: described.body.error.message }
      },
      helloMs: options.timeouts.tunnelHello,
      signal: deps.signal,
      bug: deps.bug,
    })
    tunnels.add(tunnel)
    void tunnel.done.then(() => {
      tunnels.delete(tunnel)
      if (counted !== null) {
        const left = (tunnelsOf.get(counted) ?? 1) - 1
        if (left > 0) tunnelsOf.set(counted, left)
        else tunnelsOf.delete(counted)
      }
      /** The path only: never the service, which is a command line. */
      if (options.verbose) deps.log(`WS ${pathname} ${String(Date.now() - started)} ms`)
    })
  }

  /** §2.2 `:id`: decoded, shape-checked, and listed right now; its lane comes from the registry. */
  function resolveDevice(raw: string): { id: string; lane: Lane; row: HelperDevice } {
    let id: string
    try {
      id = decodeURIComponent(raw)
    } catch {
      throw new HelperError('BAD_ID', 400, 'That device id is malformed.')
    }
    if (!isDeviceId(id)) throw new HelperError('BAD_ID', 400, 'That is not a device id.')
    const owner = registry.owner(id)
    const lane = owner ? lanes[owner] : undefined
    const row = registry.device(id)
    if (!lane || !row)
      throw new HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.')
    return { id, lane, row }
  }

  async function rescan(res: ServerResponse, headers: Headers): Promise<void> {
    const op = operation(res, options.timeouts.rescan)
    try {
      const all = Promise.allSettled(
        [lanes.ios, lanes.android, lanes.simulators].map((lane) =>
          Promise.resolve().then(() => lane?.rescan({ signal: op.signal })),
        ),
      )
      /** Bounded even if a lane ignores its signal: the page gets the snapshot as it stands. */
      await Promise.race([all, aborted(op.signal)])
    } finally {
      op.dispose()
    }
    sendJson(res, 200, registry.snapshot(), headers)
  }

  async function retry(
    res: ServerResponse,
    headers: Headers,
    id: string,
    lane: Lane,
  ): Promise<void> {
    const op = operation(res, options.timeouts.retry)
    try {
      await Promise.race([lane.retry(id, op.signal), aborted(op.signal)])
    } catch (error) {
      if (!op.signal.aborted) throw error
    } finally {
      op.dispose()
    }
    if (res.destroyed) return
    sendJson(res, 200, { device: registry.device(id) }, headers)
  }

  function androidLane(): AndroidLane {
    const android = lanes.android
    if (!android) {
      throw new HelperError('ANDROID_OFF', 409, 'The helper was started with --no-android.')
    }
    return android
  }

  async function startAdbServer(res: ServerResponse, headers: Headers): Promise<void> {
    const android = androidLane()
    const op = operation(res)
    try {
      await android.startServer(op.signal)
    } finally {
      op.dispose()
    }
    sendJson(res, 200, { android: registry.lanes().android }, headers)
  }

  /**
   * The JSON object a Wi-Fi route reads (§4.7): application/json, at most 1 KiB (the gate
   * checked the Content-Length), an object holding only the named fields. A request whose
   * client leaves mid-body is aborted quietly.
   */
  function readJson(
    req: IncomingMessage,
    fields: readonly string[],
  ): Promise<Record<string, unknown>> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') {
      return Promise.reject(
        new HelperError('BAD_REQUEST', 400, 'Send the request as JSON (application/json).'),
      )
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let length = 0
      req.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length <= LIMITS.body) chunks.push(chunk)
      })
      req.on('error', () => reject(abortError()))
      req.on('close', () => {
        if (!req.complete) reject(abortError())
      })
      req.on('end', () => {
        if (length > LIMITS.body) {
          return reject(new HelperError('PAYLOAD_TOO_LARGE', 413, 'The request is too large.'))
        }
        let value: unknown
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return reject(new HelperError('BAD_REQUEST', 400, 'The request is not valid JSON.'))
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return reject(new HelperError('BAD_REQUEST', 400, 'The request must be a JSON object.'))
        }
        if (Object.keys(value).some((key) => !fields.includes(key))) {
          return reject(
            new HelperError(
              'BAD_REQUEST',
              400,
              `Only these fields are allowed: ${fields.join(', ')}.`,
            ),
          )
        }
        resolve(value as Record<string, unknown>)
      })
    })
  }

  /** POST /api/android/connect {host, port?}: `host:connect:` on the tester's click (§4.7). */
  async function connectNetwork(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Headers,
  ): Promise<void> {
    const android = androidLane()
    const body = await readJson(req, ['host', 'port'])
    const host = parseNetworkHost(body.host)
    const port = parseNetworkPort(body.port, ADB_NETWORK_PORT)
    const op = operation(res)
    try {
      const outcome = await android.connectNetwork({ host, port }, op.signal)
      const reply: AndroidConnectResult = { ...outcome, device: registry.device(outcome.serial) }
      sendJson(res, 200, reply, headers)
    } finally {
      op.dispose()
    }
  }

  /** POST /api/android/pair {host, port, code}: Wireless debugging's pairing code (§4.7). */
  async function pairNetwork(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Headers,
  ): Promise<void> {
    const android = androidLane()
    const body = await readJson(req, ['host', 'port', 'code'])
    const host = parseNetworkHost(body.host)
    const port = parseNetworkPort(body.port)
    const code = parsePairingCode(body.code)
    const op = operation(res)
    try {
      const { message } = await android.pairNetwork({ host, port, code }, op.signal)
      const reply: AndroidPairResult = { result: 'paired', host, port, message }
      sendJson(res, 200, reply, headers)
    } finally {
      op.dispose()
    }
  }

  /** POST /api/android/disconnect {serial}: only a network serial the server lists (§4.7). */
  async function disconnectNetwork(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Headers,
  ): Promise<void> {
    const android = androidLane()
    const body = await readJson(req, ['serial'])
    const serial = body.serial
    if (typeof serial !== 'string' || !serial) {
      throw new HelperError('BAD_REQUEST', 400, 'Name the Wi-Fi device to disconnect.')
    }
    if (!isDeviceId(serial)) throw new HelperError('BAD_REQUEST', 400, 'That is not a device id.')
    const op = operation(res)
    try {
      const { message } = await android.disconnectNetwork(serial, op.signal)
      const reply: AndroidDisconnectResult = { result: 'disconnected', serial, message }
      sendJson(res, 200, reply, headers)
    } finally {
      op.dispose()
    }
  }

  /**
   * GET /api/android/nearby[?refresh=1]: the Android devices advertising adb on the local
   * network (§4.8). Read-only: nothing is connected, paired or started.
   */
  async function nearby(res: ServerResponse, search: string, headers: Headers): Promise<void> {
    const android = androidLane()
    const refresh = new URLSearchParams(search).get('refresh') === '1'
    const op = operation(res)
    try {
      const result: AndroidNearbyResult = await android.nearby(refresh, op.signal)
      sendJson(res, 200, result, headers)
    } finally {
      op.dispose()
    }
  }

  /**
   * GET /api/lan/devices[?refresh=1]: every device on this computer's network (§4.9). Read-only,
   * and the bridge's own: it needs no lane, so `--no-android` leaves it on. A look runs on the
   * helper's signal; this request only stops waiting when its client leaves.
   */
  async function lanDevices(res: ServerResponse, search: string, headers: Headers): Promise<void> {
    const refresh = new URLSearchParams(search).get('refresh') === '1'
    const op = operation(res)
    try {
      sendJson(res, 200, await deps.lan.devices(refresh, op.signal), headers)
    } finally {
      op.dispose()
    }
  }

  async function screenshot(
    res: ServerResponse,
    headers: Headers,
    id: string,
    lane: Lane,
  ): Promise<void> {
    if (shots.has(id)) {
      throw new HelperError('BUSY', 409, 'A screenshot of this device is already being taken.')
    }
    shots.add(id)
    const op = operation(res)
    const started = Date.now()
    try {
      const shot = await lane.screenshot(id, op.signal)
      const png = extractPng(shot.png)
      if (!png)
        throw new HelperError(
          'SCREENSHOT_NOT_PNG',
          502,
          'The device returned something that is not a PNG.',
        )
      if (res.destroyed) return
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Content-Disposition': `inline; filename="${id.replace(/[^\w.-]/g, '_')}.png"`,
        'X-Screenshot-Source': shot.source,
      })
      res.end(png)
      deps.log(`screenshot ${seconds(Date.now() - started)} s (${shot.source})`)
    } finally {
      shots.delete(id)
      op.dispose()
    }
  }

  /**
   * §2.5. The reply stays a plain JSON error until the lane says hello; from then on it is
   * NDJSON and ends with exactly one `end` record, unless the client went away first.
   */
  function openLogStream(
    res: ServerResponse,
    headers: Headers,
    id: string,
    lane: Lane,
  ): Promise<void> {
    const previous = streams.get(id)
    if (!previous && streams.size >= LIMITS.streamsTotal) {
      throw new HelperError(
        'TOO_MANY_STREAMS',
        429,
        'Too many logs are open. Stop one, then start this one.',
      )
    }
    /** One per device: the new stream replaces the old one, which frees the device's log source. */
    previous?.end('replaced')

    const op = linkSignals([deps.signal])
    const { batchLines, batchBytes, line: maxLine } = LIMITS
    let phase: 'opening' | 'streaming' | 'ended' = 'opening'
    let pending: string[] = []
    let pendingBytes = 0
    let flushTimer: NodeJS.Timeout | undefined
    let ping: NodeJS.Timeout | undefined
    let needDrain = false

    const write = (message: LogMsg): void => {
      if (res.destroyed || res.writableEnded) return
      if (!res.write(toJson(message) + '\n')) needDrain = true
    }
    res.on('drain', () => {
      needDrain = false
    })
    const flush = (): void => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      while (pending.length) {
        let count = 0
        let bytes = 0
        while (count < pending.length && count < batchLines && bytes < batchBytes) {
          bytes += (pending[count]?.length ?? 0) + 4
          count++
        }
        write({ t: 'lines', lines: pending.slice(0, count) })
        pending = pending.slice(count)
      }
      pendingBytes = 0
    }

    /** Settles once: when the lane says hello (no error), or with the error for a JSON reply. */
    let settleOpening: (outcome: { error: Error | null }) => void = () => undefined
    const opened = new Promise<{ error: Error | null }>((resolve) => {
      settleOpening = resolve
    })

    /**
     * The one way a stream ends. While streaming it writes the `end` record (unless the
     * client is gone); before hello it settles the request with `openingError`, or the
     * JSON error that matches `reason`.
     */
    const end = (
      reason: LogEndReason,
      extra: { code?: string; message?: string } = {},
      openingError?: unknown,
    ): void => {
      if (phase === 'ended') return
      const wasStreaming = phase === 'streaming'
      phase = 'ended'
      clearTimeout(flushTimer)
      clearInterval(ping)
      clearTimeout(helloTimer)
      if (streams.get(id) === stream) streams.delete(id)
      unsubscribe()
      op.abort()
      if (wasStreaming) {
        if (reason !== 'client-gone') {
          flush()
          write({ t: 'end', reason, ...extra })
          res.end()
        }
        return
      }
      const error = openingError ?? OPENING_ERRORS[reason]?.() ?? null
      settleOpening({
        error: error === null || error instanceof Error ? error : new Error(errorText(error)),
      })
    }
    const stream = { end }
    streams.set(id, stream)

    const unsubscribe = registry.subscribe(({ removed }) => {
      if (removed.includes(id)) end('device-gone')
    })
    res.on('close', () => {
      if (!res.writableFinished) end('client-gone')
    })
    const helloTimer = setTimeout(() => {
      end('error', {}, new HelperError('TOOL_TIMEOUT', 504, 'The log source did not start.'))
    }, options.timeouts.logHello)

    const sink: LogSink = {
      hello(source: LogSource) {
        if (phase !== 'opening') return
        phase = 'streaming'
        clearTimeout(helloTimer)
        res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' })
        write({ t: 'hello', device: id, source, at: Date.now() })
        ping = setInterval(() => write({ t: 'ping', at: Date.now() }), options.heartbeatMs)
        settleOpening({ error: null })
      },
      push(lines) {
        if (phase !== 'streaming') return phase !== 'ended'
        for (const raw of lines) {
          const text = clean(raw, maxLine)
          pending.push(text)
          pendingBytes += text.length + 4
        }
        if (pending.length >= batchLines || pendingBytes >= batchBytes) flush()
        else flushTimer ??= setTimeout(flush, options.timeouts.logBatch)
        return !needDrain
      },
      drain() {
        if (phase === 'ended' || !needDrain) return Promise.resolve()
        return new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            op.signal.removeEventListener('abort', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
          op.signal.addEventListener('abort', done, { once: true })
        })
      },
      notice(text) {
        if (phase !== 'streaming') return
        flush()
        write({ t: 'notice', text: clean(text, 500) })
      },
    }

    /** Promise.resolve().then: a lane that throws synchronously still ends this stream. */
    Promise.resolve()
      .then(() => lane.logs(id, sink, op.signal))
      .then(
        () => {
          if (phase === 'opening') {
            const none = new HelperError(
              'LOGS_UNAVAILABLE',
              503,
              'No log source works for this device.',
            )
            return end('error', {}, none)
          }
          end(registry.device(id) ? 'eof' : 'device-gone')
        },
        (error: unknown) => {
          if (phase === 'opening') return end('error', {}, error)
          const described = describeError(error)
          if (!described) return end('client-gone')
          const { code, message } = described.body.error
          if (code === 'INTERNAL') deps.bug(error)
          end(DEVICE_GONE_CODES.has(code) ? 'device-gone' : 'error', { code, message })
        },
      )

    return opened.then(({ error }) => {
      if (error) throw error
    })
  }

  return {
    handle,
    upgrade,
    endStreams(reason) {
      for (const stream of [...streams.values()]) stream.end(reason)
      for (const tunnel of [...tunnels]) tunnel.close(CLOSE.goingAway, 'The helper is stopping.')
    },
    openStreams: () => streams.size,
    openTunnels: () => tunnels.size,
  }
}

/** For INTERNAL errors: the stack on stderr, never in a reply. */
export function bugText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? errorText(error)) : errorText(error)
}
