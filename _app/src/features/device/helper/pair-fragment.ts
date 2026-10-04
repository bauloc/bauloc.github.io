import { isSafariLike, isDvcBoot } from './env'
import { DEFAULT_PORT, isPort } from './protocol'
import { browserStores, isToken, TOKEN_PATTERN, type TokenStores } from './token'

/*
  The pairing link the helper opens, `…/device/#pair=<token>&port=<port>`, read once before
  the router exists (spec §6.2): src/main.tsx calls capturePairFragment() right after it folds
  /index.html away and before createRouter, so the token never reaches the router, the
  history state or a component.

  The fragment is never sent to a server. Taking it out of the address bar at once keeps it
  out of bookmarks, screenshots and "Copy link". The candidate waits in sessionStorage until
  the connection has checked it against the helper (token.ts, connection.ts): an unverified
  token is never stored as THE token, and StrictMode's double start can't lose it.
*/

export const PENDING_KEY = 'dvc_pair_pending'

export interface PendingPair {
  readonly token: string
  /**
   * The helper's port. A link always has one: the helper leaves `&port` out only for 8787, so a
   * link without it means 8787, never "whatever port this page used last". Null only for a
   * bare token pasted on its own, which is for the helper this page already talks to.
   */
  readonly port: number | null
}

/** The window parts capturePairFragment touches, injectable for tests. */
export interface FragmentWindow {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash' | 'origin' | 'replace'>
  readonly history: Pick<History, 'state' | 'replaceState'>
  readonly navigator: Pick<Navigator, 'userAgent' | 'vendor'>
  readonly DVC_BOOT?: unknown
}

const DEVICE_PATHS = new Set(['/device', '/device/'])

/**
 * `pair` and `port` from a fragment (`#pair=…&port=…`, the leading # optional). Null unless the
 * token has the helper's exact shape and the port, when given, is a usable one. No `port` is
 * 8787: the helper's link leaves it out only there, and a port remembered from an earlier
 * pairing on 8788 must not win over the link (it would probe a helper that is gone).
 */
export function parsePairFragment(hash: string): PendingPair | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const token = params.get('pair')
  if (!isToken(token)) return null
  const rawPort = params.get('port')
  if (rawPort === null) return { token, port: DEFAULT_PORT }
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN
  return isPort(port) ? { token, port } : null
}

/**
 * What the tester pasted into the pair dialog: the 43-character token on its own, or the whole
 * link the helper printed (its `#pair=…&port=…` is read). Null for anything else.
 */
export function parsePairInput(input: string): PendingPair | null {
  const text = input.trim()
  if (TOKEN_PATTERN.test(text)) return { token: text, port: null }
  const hash = text.indexOf('#')
  return hash < 0 ? null : parsePairFragment(text.slice(hash))
}

/** Whether the fragment carries a `pair` key at all, valid or not: either way it comes out. */
const hasPairKey = (hash: string) =>
  new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).has('pair')

/**
 * Reads, stashes and strips the pairing fragment on /device and /device/. In Safari on the
 * hosted page it forwards to the helper's own page instead: Safari can never reach the helper
 * from https, and the helper's copy of the page can. Safe to call twice: the second call finds
 * no fragment.
 */
export function capturePairFragment(
  win: FragmentWindow = window,
  stores: TokenStores = browserStores(),
): CaptureResult {
  const { pathname, search, hash } = win.location
  if (!DEVICE_PATHS.has(pathname) || !hash || !hasPairKey(hash)) return 'none'
  const pair = parsePairFragment(hash)
  const local = isDvcBoot(win.DVC_BOOT) && win.location.origin === win.DVC_BOOT.apiBase
  if (pair && !local && isSafariLike(win.navigator.userAgent, win.navigator.vendor)) {
    const port = pair.port ?? DEFAULT_PORT
    win.location.replace(
      `http://127.0.0.1:${String(port)}/device/#pair=${pair.token}&port=${String(port)}`,
    )
    return 'forwarded'
  }
  if (pair) stashPendingPair(pair, stores)
  win.history.replaceState(win.history.state, '', pathname + search)
  return pair ? 'stashed' : 'stripped'
}

/** What capturePairFragment did: nothing, sent Safari to the helper's page, kept or dropped it. */
export type CaptureResult = 'none' | 'forwarded' | 'stashed' | 'stripped'

/**
 * The pairing link opened in a tab that already shows /device/: only the fragment changed, so
 * the document (and capturePairFragment in main.tsx) didn't run again. Takes the fragment out of
 * the address the same way and hands it back for the connection to check now, or null when there
 * is none. In Safari on the hosted page it forwards to the helper's page instead, as on load.
 */
export function takePairFragment(
  win: FragmentWindow = window,
  stores: TokenStores = browserStores(),
): PendingPair | null {
  if (capturePairFragment(win, stores) !== 'stashed') return null
  const pair = readPendingPair(stores)
  clearPendingPair(stores)
  return pair
}

export function stashPendingPair(pair: PendingPair, stores: TokenStores = browserStores()): void {
  stores.session?.setItem(PENDING_KEY, JSON.stringify({ v: 1, token: pair.token, port: pair.port }))
}

/** The candidate waiting to be checked, or null. */
export function readPendingPair(stores: TokenStores = browserStores()): PendingPair | null {
  const text = stores.session?.getItem(PENDING_KEY) ?? null
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const entry: { readonly [key: string]: unknown } = { ...value }
  if (entry.v !== 1 || !isToken(entry.token)) return null
  // Only a link is ever stashed, and a link without a port is for 8787.
  return { token: entry.token, port: isPort(entry.port) ? entry.port : DEFAULT_PORT }
}

/**
 * Only a COMPLETED check clears the candidate, or a probe that found nothing on its port: a
 * stop() mid-check, or a permission prompt closed unanswered, leaves it for the next start.
 */
export function clearPendingPair(stores: TokenStores = browserStores()): void {
  stores.session?.removeItem(PENDING_KEY)
}
