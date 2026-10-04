import { DEFAULT_PORT, isPort } from './protocol'

/*
  The pairing token, where the page keeps it, and the two hashes that let the page check a
  helper before trusting it (spec §2.8, §6.5). Modelled on xconsole/repo/token.ts, but kept
  well apart from `xconsole_pat`: a different key, and sessionStorage unless the tester asks
  for "Remember on this computer".

  | Key              | Where                         | Value                               |
  | dvc_token        | sessionStorage, always        | {"v":1,"token","port","tokenId"}    |
  | dvc_token        | localStorage, with Remember   | the same                            |
  | dvc_remember     | localStorage                  | "1": the tester's Remember choice   |
  | dvc_port         | localStorage                  | the port, after pairing on non-8787 |
  | dvc_pair_pending | sessionStorage                | pair-fragment.ts's candidate        |

  The Remember choice has its own key, apart from the token: a token the helper no longer
  holds (it restarted) is dropped, and the choice stays, so the next pairing is remembered too.
  Only the tester turns it off.

  Storage can be missing or throw (blocked site data, private windows). Then each store falls
  back to memory for the rest of this page view, which is enough to keep a pairing working
  until the tab closes.

  Hashing uses crypto.subtle, which exists in secure contexts: https, and the helper's own
  http://127.0.0.1 page.
*/

/** 32 random bytes in base64url, as the helper generates it. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_PATTERN.test(value)

export const TOKEN_KEY = 'dvc_token'
export const PORT_KEY = 'dvc_port'
export const REMEMBER_KEY = 'dvc_remember'

/** What is stored under dvc_token. `tokenId` is kept so the UI can show it without hashing. */
export interface StoredToken {
  readonly v: 1
  readonly token: string
  readonly port: number
  readonly tokenId: string
}

/** The parts of Storage this module uses. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The two stores, injectable for tests; null when the browser has none. */
export interface TokenStores {
  readonly session: StorageLike | null
  readonly local: StorageLike | null
}

/**
 * A store that falls back to memory once the real one throws, and stays there: mixing the two
 * would let a stale stored value resurface after a failed write.
 */
function resilient(get: () => StorageLike | null): StorageLike {
  const memory = new Map<string, string>()
  let failed = false
  const real = (): StorageLike | null => {
    if (failed) return null
    try {
      return get()
    } catch {
      failed = true
      return null
    }
  }
  return {
    getItem(key) {
      const store = real()
      if (!store) return memory.get(key) ?? null
      try {
        return store.getItem(key)
      } catch {
        failed = true
        return memory.get(key) ?? null
      }
    },
    setItem(key, value) {
      const store = real()
      if (store) {
        try {
          store.setItem(key, value)
          return
        } catch {
          failed = true
        }
      }
      memory.set(key, value)
    },
    removeItem(key) {
      memory.delete(key)
      const store = real()
      if (!store) return
      try {
        store.removeItem(key)
      } catch {
        failed = true
      }
    },
  }
}

let browser: TokenStores | null = null

/** The page's real stores, each with its memory fallback. One pair per page load. */
export function browserStores(): TokenStores {
  browser ??= {
    session: resilient(() => window.sessionStorage),
    local: resilient(() => window.localStorage),
  }
  return browser
}

/** Stores with no browser behind them: memory only (tests, and SSR-safe defaults). */
export function memoryStores(): TokenStores {
  return { session: resilient(() => null), local: resilient(() => null) }
}

function parseStored(text: string | null): StoredToken | null {
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const entry: { readonly [key: string]: unknown } = { ...value }
  if (
    entry.v !== 1 ||
    !isToken(entry.token) ||
    !isPort(entry.port) ||
    typeof entry.tokenId !== 'string' ||
    !/^[0-9a-f]{8}$/.test(entry.tokenId)
  ) {
    return null
  }
  return { v: 1, token: entry.token, port: entry.port, tokenId: entry.tokenId }
}

/**
 * Each store's entry on its own. A tab's session entry and the remembered one can differ: after
 * a helper restart another tab may have remembered the new token while this tab still holds
 * the old one.
 */
export function readTokenEntries(stores: TokenStores = browserStores()): {
  readonly session: StoredToken | null
  readonly local: StoredToken | null
} {
  return {
    session: parseStored(stores.session?.getItem(TOKEN_KEY) ?? null),
    local: parseStored(stores.local?.getItem(TOKEN_KEY) ?? null),
  }
}

/**
 * The tester's "Remember on this computer" choice. Before it had its own key, a remembered token
 * was the choice, so one stored by an earlier build still reads as on.
 */
export function readRemember(stores: TokenStores = browserStores()): boolean {
  const choice = stores.local?.getItem(REMEMBER_KEY) ?? null
  if (choice !== null) return choice === '1'
  return parseStored(stores.local?.getItem(TOKEN_KEY) ?? null) !== null
}

/** The stored token, session first; `remembered` when localStorage holds one too. */
export function readStoredToken(
  stores: TokenStores = browserStores(),
): (StoredToken & { readonly remembered: boolean }) | null {
  const session = parseStored(stores.session?.getItem(TOKEN_KEY) ?? null)
  const local = parseStored(stores.local?.getItem(TOKEN_KEY) ?? null)
  const entry = session ?? local
  return entry ? { ...entry, remembered: local !== null } : null
}

/**
 * Saves a verified token: always for this tab, and on this computer when `remember` is on or the
 * tester chose Remember earlier (a newly paired tab updates it, and other tabs follow).
 */
export function saveToken(
  entry: StoredToken,
  remember: boolean,
  stores: TokenStores = browserStores(),
): void {
  const text = JSON.stringify({
    v: 1,
    token: entry.token,
    port: entry.port,
    tokenId: entry.tokenId,
  })
  stores.session?.setItem(TOKEN_KEY, text)
  if (!remember && !readRemember(stores)) return
  stores.local?.setItem(TOKEN_KEY, text)
  stores.local?.setItem(REMEMBER_KEY, '1')
}

/**
 * "Remember on this computer" switched (or chosen in the pair dialog): the choice, and the
 * tab's token copied there or removed.
 */
export function setRemembered(on: boolean, stores: TokenStores = browserStores()): void {
  if (!on) {
    stores.local?.removeItem(REMEMBER_KEY)
    stores.local?.removeItem(TOKEN_KEY)
    return
  }
  stores.local?.setItem(REMEMBER_KEY, '1')
  const session = parseStored(stores.session?.getItem(TOKEN_KEY) ?? null)
  if (session) stores.local?.setItem(TOKEN_KEY, JSON.stringify(session))
}

/**
 * A token the helper no longer holds: removed from each store that still holds THAT token, and
 * nowhere else. A newer one another tab just saved in localStorage stays for this tab to try.
 * The Remember choice stays: the helper restarting is no reason to stop remembering.
 */
export function dropToken(token: string, stores: TokenStores = browserStores()): void {
  // Remembered by an earlier build, before the choice had its key: keep it as a choice now.
  if (stores.local?.getItem(REMEMBER_KEY) === null && readRemember(stores)) {
    stores.local.setItem(REMEMBER_KEY, '1')
  }
  for (const store of [stores.session, stores.local]) {
    if (parseStored(store?.getItem(TOKEN_KEY) ?? null)?.token === token)
      store?.removeItem(TOKEN_KEY)
  }
}

/** The token out of both stores. The Remember choice is the tester's, and stays as it is. */
export function clearToken(stores: TokenStores = browserStores()): void {
  stores.session?.removeItem(TOKEN_KEY)
  stores.local?.removeItem(TOKEN_KEY)
}

/**
 * Forget pairing, the tester's own button: the token AND the Remember choice. Asking to be
 * forgotten means this computer keeps nothing, not just until the next pairing.
 */
export function forgetPairing(stores: TokenStores = browserStores()): void {
  clearToken(stores)
  stores.local?.removeItem(REMEMBER_KEY)
}

/** localStorage.dvc_port, or null. */
export function readStoredPort(stores: TokenStores = browserStores()): number | null {
  const port = Number(stores.local?.getItem(PORT_KEY) ?? '')
  return isPort(port) ? port : null
}

/** Written only after a successful pairing on a non-default port; 8787 clears it. */
export function saveStoredPort(port: number, stores: TokenStores = browserStores()): void {
  if (port === DEFAULT_PORT) stores.local?.removeItem(PORT_KEY)
  else if (isPort(port)) stores.local?.setItem(PORT_KEY, String(port))
}

/**
 * Calls `listener` when another tab changes the token (the `storage` event fires in the OTHER
 * tabs only), so this tab re-checks. Returns the unsubscribe.
 */
export function subscribeToken(
  listener: () => void,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null = typeof window ===
  'undefined'
    ? null
    : window,
): () => void {
  if (!target) return () => undefined
  const onStorage = (event: Event) => {
    // A null key is a clear() of the whole store, which includes the token.
    const key: unknown = Reflect.get(event, 'key')
    if (key === null || key === undefined || key === TOKEN_KEY || key === REMEMBER_KEY) listener()
  }
  target.addEventListener('storage', onStorage)
  return () => {
    target.removeEventListener('storage', onStorage)
  }
}

/* ---------------------------------------------------------------- *
 * Hashes
 * ---------------------------------------------------------------- */

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The token's public fingerprint: 8 hex of SHA-256(utf8(token)), as health.tokenId. */
export async function tokenIdOf(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token))).slice(0, 8)
}

/**
 * What a helper holding `token` answers to `challenge` on `port` (§2.8). The page computes it
 * over the port IT talks to: a squatter on another port that relays the challenge to the real
 * helper gets a proof over the real port, which then fails here.
 */
export async function proofOf(token: string, port: number, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = `bauloc-device-bridge proof v1|${String(port)}|${challenge}`
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))))
}

/** 16 random bytes in base64url: the 22-character challenge the helper accepts. */
export function newChallenge(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) =>
    crypto.getRandomValues(b),
): string {
  return base64url(random(new Uint8Array(16)))
}

/** Equal strings, compared without an early exit. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
