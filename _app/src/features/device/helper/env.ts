import { DEFAULT_PORT, isPort } from './protocol'

/*
  Where the local helper is, and how this page may reach it (spec §6.1, §6.3), worked out from
  plain inputs so every case runs in Vitest's node environment.

  Two modes:
  - hosted: this page comes from bauloc.github.io (or a dev server) and talks to
    http://127.0.0.1:<port>, which Chrome, Edge and Firefox allow after one Local Network
    Access prompt. Safari never allows it.
  - local: the helper served this page itself and said so in window.DVC_BOOT, so the API is
    the page's own origin: no CORS, no prompt.

  An http loopback origin alone never means local: Vite on :7360 and `serve:site` on :8000
  are loopback too, and treating them as the helper misfired in the legacy page.
*/

/** What the helper's local page carries in window.DVC_BOOT. Never a token. */
export interface DvcBoot {
  readonly mode: 'local'
  readonly apiBase: string
  readonly protocol: number
  readonly version: string
}

export interface HelperEnv {
  readonly mode: 'hosted' | 'local'
  /** `http://127.0.0.1:<port>` (hosted), or this page's origin (local). */
  readonly apiBase: string
  readonly port: number
  /** Safari or another WebKit-only browser: it reorders guidance and skips hopeless probes. */
  readonly safariLike: boolean
  /** Vite, `vite preview` or `serve:site` on loopback: the helper needs --dev to answer it. */
  readonly devOrigin: boolean
}

/** Where a port can come from, in the order §6.1 trusts them. */
export interface StoredPorts {
  /** The pending #pair= fragment's port. */
  readonly pairPort?: number | null
  /** The port the stored token was paired on. */
  readonly tokenPort?: number | null
  /** localStorage.dvc_port: a successful pairing on a non-default port. */
  readonly port?: number | null
}

/** The parts of Location the resolver reads. */
export type LocationLike = Pick<Location, 'origin' | 'protocol' | 'hostname' | 'port'>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])
/** `npm run dev`, `vite preview`, `npm run serve:site`. */
const DEV_PORTS = new Set(['7360', '4173', '8000'])

/** Whether a value is a DvcBoot the helper could have written. Anything else is ignored. */
export function isDvcBoot(value: unknown): value is DvcBoot {
  if (typeof value !== 'object' || value === null) return false
  const boot: { readonly [key: string]: unknown } = { ...value }
  return (
    boot.mode === 'local' &&
    typeof boot.apiBase === 'string' &&
    typeof boot.protocol === 'number' &&
    typeof boot.version === 'string'
  )
}

/**
 * The legacy page's Safari rule (device/js dvcIsSafari): Apple's vendor string and a Safari
 * token, but none of the other browsers that also say "Safari" (Chrome and Edge everywhere,
 * Chrome and Firefox on iOS, Opera, Android's WebView).
 */
export function isSafariLike(ua: string, vendor: string): boolean {
  return (
    vendor === 'Apple Computer, Inc.' &&
    /safari/i.test(ua) &&
    !/chrome|chromium|android|crios|fxios|edg|opr|firefox/i.test(ua)
  )
}

/** A loopback dev server this repo runs, over http. */
export function isDevOrigin(loc: Pick<Location, 'protocol' | 'hostname' | 'port'>): boolean {
  return loc.protocol === 'http:' && LOOPBACK_HOSTS.has(loc.hostname) && DEV_PORTS.has(loc.port)
}

/** The first usable port of the pending fragment, the stored token, dvc_port, else 8787. */
export function resolvePort(stored: StoredPorts): number {
  for (const candidate of [stored.pairPort, stored.tokenPort, stored.port]) {
    if (isPort(candidate)) return candidate
  }
  return DEFAULT_PORT
}

/**
 * Mode, API base and port. `?api=` and `?port=` are never read: the legacy `?api=` sent a
 * stored token to whatever address a link named.
 */
export function resolveHelperEnv(
  loc: LocationLike,
  boot: unknown,
  stored: StoredPorts,
  ua: string,
  vendor: string,
): HelperEnv {
  const safariLike = isSafariLike(ua, vendor)
  const devOrigin = isDevOrigin(loc)
  if (isDvcBoot(boot) && loc.origin === boot.apiBase) {
    const port = Number(loc.port)
    return {
      mode: 'local',
      apiBase: loc.origin,
      port: isPort(port) ? port : DEFAULT_PORT,
      safariLike,
      devOrigin,
    }
  }
  const port = resolvePort(stored)
  return {
    mode: 'hosted',
    apiBase: `http://127.0.0.1:${String(port)}`,
    port,
    safariLike,
    devOrigin,
  }
}

/** The helper's own page, for Safari and for "Open the helper's page". */
export const localPageUrl = (port: number): string => `http://127.0.0.1:${String(port)}/device/`

/* ---------------------------------------------------------------- *
 * The Local Network Access permission
 * ---------------------------------------------------------------- */

export type LoopbackState = 'granted' | 'prompt' | 'denied' | 'unsupported'

/** What the connection reads and watches. A subset of PermissionStatus. */
export interface PermissionStatusLike {
  readonly state: string
  onchange: ((this: PermissionStatus, ev: Event) => unknown) | null
}

/** A subset of navigator.permissions, injectable for tests. */
export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>
}

const isAnswer = (state: string): state is 'granted' | 'prompt' | 'denied' =>
  state === 'granted' || state === 'prompt' || state === 'denied'

/**
 * The permission's state and its PermissionStatus (to watch for changes). Chrome 145+ and
 * Firefox know `loopback-network`; Chrome 142–144 only `local-network-access`, which answers
 * oddly where both exist, so it is asked only when the new name throws. Both throwing (Safari,
 * older browsers) is `unsupported`. Querying never prompts.
 */
export async function queryLoopback(
  permissions: PermissionsLike | null | undefined,
): Promise<{ state: LoopbackState; status: PermissionStatusLike | null }> {
  if (!permissions) return { state: 'unsupported', status: null }
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const status = await permissions.query({ name })
      return { state: isAnswer(status.state) ? status.state : 'unsupported', status }
    } catch {
      // This browser doesn't know the name: try the next one.
    }
  }
  return { state: 'unsupported', status: null }
}

/** Just the state, for checklists. */
export async function loopbackPermission(
  permissions: PermissionsLike | null | undefined,
): Promise<LoopbackState> {
  return (await queryLoopback(permissions)).state
}
