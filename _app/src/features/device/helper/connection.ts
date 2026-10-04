import {
  createHelperClient,
  HelperError,
  isAbortError,
  TIMEOUTS,
  type HelperClient,
  type NetworkTarget,
  type PairTarget,
} from './client'
import {
  queryLoopback,
  resolvePort,
  type HelperEnv,
  type LoopbackState,
  type PermissionsLike,
  type PermissionStatusLike,
} from './env'
import { clearPendingPair, parsePairInput, readPendingPair } from './pair-fragment'
import {
  DVC_MAX_AGENT,
  DVC_MIN_AGENT,
  HELPER_NAME,
  type DetailResponse,
  type DoctorReport,
  type Health,
  type HelperDevice,
  type Lanes,
  type LogMsg,
  type ConnectReply,
  type DisconnectReply,
  type NearbyReply,
  type PairReply,
  type ScreenshotSource,
  type Snapshot,
} from './protocol'
import {
  browserStores,
  clearToken,
  dropToken,
  memoryStores,
  newChallenge,
  proofOf,
  readRemember,
  readStoredPort,
  readStoredToken,
  readTokenEntries,
  saveStoredPort,
  saveToken,
  sameText,
  setRemembered,
  forgetPairing,
  subscribeToken,
  tokenIdOf,
  type TokenStores,
} from './token'

/*
  The page's link to the local helper (spec §6.5–§6.7, §7.2): which phase it is in, when it
  looks, what it may send, and the device list it polls.

  The rules that matter most:
  - Nothing reaches 127.0.0.1 without a reason (§6.3). A hosted page whose Local Network
    Access permission is still `prompt` stays `off` until the tester clicks Connect, holds a
    stored token, or arrived through the helper's #pair= link: the browser's prompt is never
    shown out of the blue.
  - The token is sent only after the helper has proved it holds it (§2.8): its tokenId
    matches, and its HMAC over THIS port and a fresh challenge is right. After any connection
    failure the next request is that proof probe again, never an authenticated call.
  - A candidate token (the #pair= link, or one pasted) never overwrites a stored token that
    works, and the link's candidate is checked at most once per page load. A link whose port
    answers nothing is spent too, so a crafted one can't hold the tab on a dead port (T7).
  - On the helper's own page (local mode) the origin is http://127.0.0.1:<port>: whatever
    listens on that port after the helper stops serves the same origin and can read its
    storage. Nothing is remembered there, and a kept token (--keep-token) stays in memory.
  - One request of each kind in flight (Firefox), short polling only, no held connection.

  Plain functions, never methods (the store's convention), and a constructor with no side
  effects: StrictMode builds it twice and runs start → stop → start.
*/

export type HelperPhase =
  | 'off'
  | 'checking'
  | 'absent'
  | 'dismissed'
  | 'denied'
  | 'safari'
  | 'foreign'
  | 'outdated'
  | 'newer'
  | 'unpaired'
  | 'stale'
  | 'connected'
  | 'lost'

/** The browser's Local Network Access answer; `not-needed` on the helper's own page. */
export type HelperPermission = LoopbackState | 'not-needed'

export interface HelperStatus {
  readonly phase: HelperPhase
  /** A probe is waiting on what is probably the browser's permission prompt. */
  readonly promptLikely: boolean
  readonly env: HelperEnv
  readonly permission: HelperPermission
  /** The last health reply from a helper (also kept for outdated and newer, for its version). */
  readonly health: Health | null
  readonly lanes: Lanes | null
  /**
   * The tester's "Remember on this computer" choice (token.ts readRemember), apart from any
   * token: the pair dialog starts from it, and a helper restart never turns it off. Always false
   * on the helper's own page, which never remembers.
   */
  readonly remember: boolean
  /** The pairing this page holds and has verified. */
  readonly pairing: {
    readonly tokenId: string
    readonly remembered: boolean
    readonly tokenPersistent: boolean
  } | null
  /**
   * The tester showed they want the helper in this page view: a stored token, a pairing, a
   * Connect click, or a connection earlier. Notices and toasts appear only then.
   */
  readonly intent: boolean
  /** When this phase began (ms since the epoch). */
  readonly since: number
  /** The last error code, for the Environment check. */
  readonly error: string | null
}

export type PairResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'format' | 'stale' | 'foreign' | 'unreachable' | 'outdated' | 'newer'
      /** stale: the running helper's fingerprint, for "This helper's fingerprint is …". */
      readonly tokenId?: string
      /**
       * The port the attempt tried, for "isn't answering on 127.0.0.1:…": a pasted link may
       * name another port than the one this page talks to.
       */
      readonly port?: number
    }

export interface HelperConnection {
  readonly getStatus: () => HelperStatus
  readonly subscribeStatus: (listener: () => void) => () => void
  /** The helper's rows: always [] unless connected. */
  readonly getDevices: () => readonly HelperDevice[]
  readonly subscribeDevices: (listener: () => void) => () => void
  /** Non-blocking and idempotent; consumes the pending #pair= candidate once. */
  readonly start: () => void
  /** Aborts everything and clears every timer; start() may follow (StrictMode). */
  readonly stop: () => void
  /** USER GESTURE ONLY: may show the browser's permission prompt. */
  readonly connect: () => void
  /**
   * The pair dialog: a token or the helper's link. Never overwrites a working token on failure.
   * `remember` is ignored on the helper's own page, which never remembers.
   */
  readonly pair: (input: string, remember: boolean) => Promise<PairResult>
  /** "Forget pairing": the token in both stores, the Remember choice, and the list. */
  readonly forget: () => void
  /**
   * "Remember on this computer", switched in the Environment check: the stores and the status.
   * A no-op on the helper's own page (local mode), where nothing is remembered.
   */
  readonly setRemember: (on: boolean) => void
  /** POST /api/rescan (Refresh, R). Quiet on failure: the next poll says what happened. */
  readonly rescan: () => Promise<void>
  /** Poll at once when connected, probe at once when waiting; never prompts. */
  readonly pollNow: () => void
  /** GET /api/doctor, cached 30 s; null unless connected or when it fails. */
  readonly doctor: (refresh?: boolean) => Promise<DoctorReport | null>
  /** POST /api/android/start-server, only when the helper lists the feature. */
  readonly startAdb: () => Promise<void>
  /**
   * Android over Wi‑Fi, only when the helper lists `android.connect` (else NETWORK_UNSUPPORTED,
   * without a request); each is the tester's click, and each polls the list once it answers.
   * Rejects with a HelperError that helper/network.ts words.
   */
  readonly connectNetwork: (target: NetworkTarget) => Promise<ConnectReply>
  readonly pairNetwork: (target: PairTarget) => Promise<PairReply>
  readonly disconnectNetwork: (serial: string) => Promise<DisconnectReply>
  /**
   * GET /api/android/nearby, only when the helper lists `android.discover` (else
   * DISCOVER_UNSUPPORTED, without a request): what advertises debugging on the network. It
   * only looks; connecting stays the tester's click (connectNetwork, pairNetwork).
   */
  readonly nearby: (refresh?: boolean, signal?: AbortSignal) => Promise<NearbyReply>
  readonly api: {
    readonly detail: (id: string, signal?: AbortSignal) => Promise<DetailResponse>
    readonly screenshot: (id: string, signal?: AbortSignal) => Promise<Blob>
    /** The same, with the tool the helper used. */
    readonly capture: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<{ blob: Blob; source: ScreenshotSource | null }>
    readonly retry: (id: string) => Promise<HelperDevice | null>
    readonly logs: (id: string, onMsg: (m: LogMsg) => void, signal: AbortSignal) => Promise<void>
  }
}

/** document's part: visibility. */
export interface VisibilityLike {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** window's part: focus (and `storage`, through subscribeToken). */
export type WindowLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export interface HelperConnectionDeps {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly stores?: TokenStores
  readonly permissions?: PermissionsLike | null
  readonly document?: VisibilityLike | null
  readonly window?: WindowLike | null
  /** crypto.getRandomValues, for the challenge. */
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

/* ---------------------------------------------------------------- *
 * Cadence (§6.7), in ms
 * ---------------------------------------------------------------- */

export const CADENCE = {
  /** Connected: the device list. */
  devicesVisible: 2_000,
  devicesHidden: 10_000,
  /** Absent: 2, 4, 8 s, then 10 s; 60 s while hidden. */
  absent: [2_000, 4_000, 8_000, 10_000],
  absentHidden: 60_000,
  /** Lost: 1, 2, 4, 8 s, then 10 s. */
  lost: [1_000, 2_000, 4_000, 8_000, 10_000],
  /** Unpaired, stale, outdated, newer, foreign: 10 s while visible, nothing while hidden. */
  waiting: 10_000,
  /** A TypeError this late, while the permission is still `prompt`, was a dismissed prompt. */
  dismissedAfter: 1_000,
  doctorCache: 30_000,
} as const

/** Phases that look again on their own, with health. */
const WAITING: ReadonlySet<HelperPhase> = new Set([
  'unpaired',
  'stale',
  'outdated',
  'newer',
  'foreign',
])

/** Phases a probe may announce itself in ("Looking for the helper…"). */
const QUIET: ReadonlySet<HelperPhase> = new Set(['off', 'dismissed', 'denied', 'checking'])

type Verdict = 'ok' | 'stale' | 'foreign'

const STATUS_KEYS: readonly (keyof HelperStatus)[] = [
  'phase',
  'promptLikely',
  'env',
  'permission',
  'health',
  'lanes',
  'pairing',
  'remember',
  'intent',
  'since',
  'error',
]
/** Compared by value: each poll brings a new lanes object that usually says the same. */
const DEEP_KEYS: ReadonlySet<keyof HelperStatus> = new Set(['health', 'lanes', 'pairing'])

/** A signal that aborts when either does; dispose() unhooks it. */
function linkSignals(a: AbortSignal | undefined, b: AbortSignal | undefined) {
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }
  for (const s of [a, b]) {
    if (s?.aborted) controller.abort()
    else s?.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      a?.removeEventListener('abort', abort)
      b?.removeEventListener('abort', abort)
    },
  }
}

export function createHelperConnection(
  initialEnv: HelperEnv,
  deps: HelperConnectionDeps = {},
): HelperConnection {
  const now = deps.now ?? Date.now
  const stores = deps.stores ?? browserStores()
  const random = deps.random ?? ((bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes))
  const hasWindow = typeof window !== 'undefined'
  const permissions =
    deps.permissions !== undefined
      ? deps.permissions
      : hasWindow
        ? ((navigator.permissions as PermissionsLike | undefined) ?? null)
        : null
  const doc = deps.document !== undefined ? deps.document : hasWindow ? document : null
  const win = deps.window !== undefined ? deps.window : hasWindow ? window : null

  let env = initialEnv
  /** The token in use: set only after its proof passed, cleared at the first failure. */
  let authToken: string | null = null
  let client: HelperClient = createHelperClient(env.apiBase, () => authToken, {
    fetch: deps.fetch,
  })

  let status: HelperStatus = {
    phase: env.mode === 'hosted' && env.safariLike ? 'safari' : 'off',
    promptLikely: false,
    env,
    permission: env.mode === 'local' ? 'not-needed' : 'unsupported',
    health: null,
    lanes: null,
    pairing: null,
    remember: env.mode === 'hosted' && readRemember(stores),
    intent: false,
    since: now(),
    error: null,
  }
  let devices: readonly HelperDevice[] = []
  let snapshotKey = ''
  const statusListeners = new Set<() => void>()
  const deviceListeners = new Set<() => void>()

  let started = false
  /** Bumped by stop(): work from an older generation changes nothing. */
  let gen = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let step = 0
  let probing = false
  let polling = false
  /** Consecutive failed requests while connected; two make `lost`. */
  let failures = 0
  /** The #pair= candidate was checked in this page load. */
  let pendingChecked = false
  /** A pairing ended in this page view: a missing token reads `stale`, not `unpaired`. */
  let wasPaired = false
  /** The prompt was dismissed: no automatic probe may show it again until Connect. */
  let promptBlocked = false
  let permissionStatus: PermissionStatusLike | null = null
  let doctorCache: { at: number; report: DoctorReport } | null = null
  let doctorInflight: Promise<DoctorReport | null> | null = null
  const unlisten: (() => void)[] = []
  /** Local mode with a kept token: the tab's pairing, in memory only. */
  const keptMemory = memoryStores()

  /**
   * Where this page keeps dvc_token. Hosted: the browser's stores (§6.5). Local: never
   * localStorage, and sessionStorage only for a per-run token, which dies with the helper that
   * issued it; a kept one would still drive the phones once the real helper is back.
   */
  function tokenStores(): TokenStores {
    if (env.mode === 'hosted') return stores
    return {
      session: status.health?.tokenPersistent ? keptMemory.session : stores.session,
      local: null,
    }
  }

  /* -------------------------------------------------------- state --- */

  function setStatus(patch: Partial<HelperStatus>) {
    const moved = patch.phase !== undefined && patch.phase !== status.phase
    if (moved) step = 0
    const next: HelperStatus = {
      ...status,
      ...patch,
      since: moved ? now() : status.since,
      // Only `checking` may wait on the prompt; any other phase clears it.
      promptLikely:
        (patch.phase ?? status.phase) === 'checking'
          ? (patch.promptLikely ?? status.promptLikely)
          : false,
    }
    const changed = STATUS_KEYS.some((key) =>
      DEEP_KEYS.has(key)
        ? JSON.stringify(next[key]) !== JSON.stringify(status[key])
        : next[key] !== status[key],
    )
    if (!changed) return
    status = next
    for (const listener of statusListeners) listener()
  }

  function setDevices(list: readonly HelperDevice[]) {
    if (list === devices || (list.length === 0 && devices.length === 0)) return
    devices = list
    for (const listener of deviceListeners) listener()
  }

  /** Leave `connected` (or never reach it): the list empties and the token is withheld. */
  function enter(phase: Exclude<HelperPhase, 'connected'>, patch: Partial<HelperStatus> = {}) {
    authToken = null
    snapshotKey = ''
    setDevices([])
    setStatus({ ...patch, phase })
  }

  const hidden = () => doc?.visibilityState === 'hidden'
  const signal = () => controller?.signal

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function later(g: number, delay: number, run: (g: number) => void) {
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      if (g === gen) run(g)
    }, delay)
  }

  /** The next automatic look for the phase just entered (§6.7). */
  function schedule(g: number) {
    const { phase } = status
    if (phase === 'connected') {
      later(g, hidden() ? CADENCE.devicesHidden : CADENCE.devicesVisible, pollDevices)
    } else if (phase === 'absent') {
      const delay = hidden()
        ? CADENCE.absentHidden
        : CADENCE.absent[Math.min(step, CADENCE.absent.length - 1)]
      step++
      later(g, delay ?? CADENCE.waiting, probe)
    } else if (phase === 'lost') {
      const delay = CADENCE.lost[Math.min(step, CADENCE.lost.length - 1)]
      step++
      later(g, delay ?? CADENCE.waiting, probe)
    } else if (WAITING.has(phase) && !hidden()) {
      later(g, CADENCE.waiting, probe)
    } else {
      clearTimer()
    }
  }

  function pairingOf(health: Health | null, tokenId: string) {
    const stored = readStoredToken(tokenStores())
    return {
      tokenId,
      remembered: stored?.tokenId === tokenId && stored.remembered && readRemember(tokenStores()),
      tokenPersistent: health?.tokenPersistent ?? false,
    }
  }

  /* -------------------------------------------------------- deciding --- */

  /** §6.3: whether to look on our own, from the permission and what the page holds. */
  function decide(g: number) {
    if (g !== gen) return
    if (env.mode === 'hosted' && env.safariLike) {
      enter('safari')
      clearTimer()
      return
    }
    const { permission } = status
    if (permission === 'denied') {
      enter('denied')
      clearTimer()
      return
    }
    const pending = !pendingChecked && readPendingPair(stores) !== null
    const stored = readStoredToken(tokenStores()) !== null
    const blocked = promptBlocked && permission === 'prompt'
    const auto =
      env.mode === 'local' ||
      pending ||
      permission === 'granted' ||
      (permission === 'unsupported' && !env.safariLike) ||
      ((stored || status.intent) && !blocked)
    if (stored && !status.intent) setStatus({ intent: true })
    if (!auto) {
      if (status.phase === 'connected' || status.phase === 'lost') return
      enter(status.phase === 'dismissed' ? 'dismissed' : 'off')
      clearTimer()
      return
    }
    probe(g)
  }

  /** §2.8: the helper's fingerprint, then its proof over the port WE talk to. */
  async function verify(
    token: string,
    health: Health,
    challenge: string,
    port = env.port,
  ): Promise<Verdict> {
    if (!health.tokenId || (await tokenIdOf(token)) !== health.tokenId) return 'stale'
    if (!health.proof) return 'foreign'
    return sameText(await proofOf(token, port, challenge), health.proof) ? 'ok' : 'foreign'
  }

  /** One health probe with a fresh challenge, then the phase it shows (§6.6). */
  function probe(g: number) {
    if (g !== gen || probing) return
    probing = true
    clearTimer()
    const prompting = env.mode === 'hosted' && status.permission === 'prompt'
    if (QUIET.has(status.phase)) setStatus({ phase: 'checking', promptLikely: prompting })
    const challenge = newChallenge(random)
    const began = now()
    client
      .health(challenge, { signal: signal(), timeoutMs: prompting ? null : TIMEOUTS.health })
      .then(
        (health) => onHealth(g, health, challenge),
        (error: unknown) => {
          onProbeFailure(g, error, now() - began, prompting)
        },
      )
      .catch((error: unknown) => {
        // A bug in the handlers above, never a network failure: keep looking.
        if (g === gen) console.warn('[device] helper probe failed', error)
      })
      .finally(() => {
        if (g === gen) probing = false
      })
  }

  function onProbeFailure(g: number, error: unknown, elapsed: number, prompting: boolean) {
    if (g !== gen || isAbortError(error)) return
    const code = error instanceof HelperError ? error.code : 'HELPER_UNREACHABLE'
    probing = false
    if (status.permission === 'denied') {
      // "Block" in the prompt: the request fails and the permission changes, in either order.
      enter('denied', { error: code })
      clearTimer()
      return
    }
    const dismissed =
      prompting && status.permission === 'prompt' && elapsed >= CADENCE.dismissedAfter
    // The prompt closed unanswered never reached the port: the link waits for Connect.
    if (!dismissed && spendPendingPair()) {
      // Its port gave way to the one this page would use without it: look there, as §6.3 allows.
      later(g, 0, decide)
      return
    }
    if (code === 'HELPER_FOREIGN') {
      enter('foreign', { error: code, health: null })
    } else if (status.phase === 'connected' || status.phase === 'lost') {
      // The second failure in a row (the first was the request that sent us here).
      failures++
      enter('lost', { error: code })
    } else if (dismissed) {
      // The prompt was closed without an answer. Only Connect may show it again.
      promptBlocked = true
      enter('dismissed', { error: code })
    } else {
      enter('absent', { error: code })
    }
    schedule(g)
  }

  /**
   * The #pair= candidate's port answered nothing (or not as the helper): the candidate is spent,
   * so a crafted link with a dead port can't keep this tab, across reloads, away from the helper
   * it was paired with (T7). True when the port changed back to the one the page would use
   * without the link: the stored token's, dvc_port, else 8787.
   */
  function spendPendingPair(): boolean {
    if (pendingChecked || readPendingPair(stores) === null) return false
    pendingChecked = true
    clearPendingPair(stores)
    if (env.mode !== 'hosted') return false
    const port = resolvePort({
      tokenPort: readStoredToken(stores)?.port ?? null,
      port: readStoredPort(stores),
    })
    if (port === env.port) return false
    switchPort(port)
    return true
  }

  async function onHealth(g: number, health: Health, challenge: string) {
    if (g !== gen) return
    if (health.name !== HELPER_NAME) {
      if (spendPendingPair()) {
        later(g, 0, decide)
        return
      }
      enter('foreign', { health: null, error: 'HELPER_FOREIGN' })
      schedule(g)
      return
    }
    if (health.protocol < DVC_MIN_AGENT || health.protocol > DVC_MAX_AGENT) {
      enter(health.protocol < DVC_MIN_AGENT ? 'outdated' : 'newer', { health })
      schedule(g)
      return
    }
    setStatus({ health })

    // 1. The #pair= candidate, once per page load. It never replaces a working stored token.
    const pending = pendingChecked ? null : readPendingPair(stores)
    if (pending) {
      const verdict = await verify(pending.token, health, challenge)
      if (g !== gen) return
      pendingChecked = true
      clearPendingPair(stores)
      if (verdict === 'ok') {
        adopt(g, pending.token, health, false)
        return
      }
      if (verdict === 'foreign') {
        enter('foreign', { error: 'HELPER_PROOF_FAILED' })
        schedule(g)
        return
      }
      // From another run: dropped, and the stored token (if any) is checked as usual.
    }

    // 2. The stored tokens, for the port they were paired on: this tab's, then the one remembered
    //    on this computer. They differ when another tab paired with a restarted helper first and
    //    remembered its new token, which this tab then picks up (§6.5).
    const ts = tokenStores()
    const { session, local } = readTokenEntries(ts)
    const tries = [session, local].filter(
      (entry, i): entry is NonNullable<typeof entry> =>
        entry !== null && entry.port === env.port && (i === 0 || entry.token !== session?.token),
    )
    for (const entry of tries) {
      const verdict = await verify(entry.token, health, challenge)
      if (g !== gen) return
      if (verdict === 'ok') {
        adopt(g, entry.token, health, readRemember(ts))
        return
      }
      if (verdict === 'foreign') {
        enter('foreign', { error: 'HELPER_PROOF_FAILED' })
        schedule(g)
        return
      }
      // From an earlier run of the helper: this token can never work again. Only it goes, never
      // a newer one another tab saved meanwhile.
      dropToken(entry.token, ts)
    }
    if (tries.length > 0) {
      wasPaired = true
      enter('stale', { pairing: null, error: 'HELPER_UNAUTHORIZED' })
      schedule(g)
      return
    }

    // 3. Nothing usable: a pairing that ended in this page view reads as a restart.
    enter(wasPaired ? 'stale' : 'unpaired', { pairing: null })
    schedule(g)
  }

  /** A verified token: store it, use it, poll. */
  function adopt(g: number, token: string, health: Health, remember: boolean) {
    if (g !== gen) return
    void tokenIdOf(token).then((tokenId) => {
      if (g !== gen) return
      const ts = tokenStores()
      // Local mode, kept token: nothing of it on the origin's storage, not even from earlier.
      if (ts.session !== stores.session) clearToken(stores)
      saveToken({ v: 1, token, port: env.port, tokenId }, remember && env.mode === 'hosted', ts)
      saveStoredPort(env.port, stores)
      authToken = token
      wasPaired = true
      promptBlocked = false
      failures = 0
      setStatus({
        phase: 'connected',
        health,
        pairing: pairingOf(health, tokenId),
        intent: true,
        error: null,
      })
      pollDevices(g)
    })
  }

  /* -------------------------------------------------------- polling --- */

  function applySnapshot(snapshot: Snapshot) {
    // A lane that changed (adb server stopped, Xcode found) makes the tools report stale.
    if (status.lanes && JSON.stringify(snapshot.lanes) !== JSON.stringify(status.lanes))
      doctorCache = null
    setStatus({ lanes: snapshot.lanes })
    const key = `${snapshot.runId}:${String(snapshot.rev)}`
    if (key === snapshotKey) return
    snapshotKey = key
    setDevices(snapshot.devices)
  }

  function pollDevices(g: number) {
    if (g !== gen || status.phase !== 'connected' || polling) return
    clearTimer()
    polling = true
    client
      .devices(signal())
      .then(
        (snapshot) => {
          if (g !== gen || status.phase !== 'connected') return
          failures = 0
          applySnapshot(snapshot)
          schedule(g)
        },
        (error: unknown) => {
          if (g !== gen || isAbortError(error)) return
          onRequestFailure(g, error, true)
        },
      )
      .finally(() => {
        if (g === gen) polling = false
      })
  }

  /**
   * After a failed request while connected (§6.6): a 401 ends the pairing, a network failure
   * (or a list that timed out) withholds the token and re-probes at once, so a second one in a
   * row is `lost`. Anything else is the device's business: look at the list again.
   */
  function onRequestFailure(g: number, error: unknown, isPoll: boolean) {
    if (g !== gen || !(error instanceof HelperError)) return
    if (error.code === 'HELPER_UNAUTHORIZED') {
      authToken = null
      setStatus({ error: error.code })
      probe(g)
      return
    }
    const broken = error.kind === 'network' || (isPoll && error.kind === 'timeout')
    if (broken && (status.phase === 'connected' || status.phase === 'lost')) {
      failures++
      authToken = null
      setStatus({ error: error.code })
      if (failures >= 2) {
        enter('lost', { error: error.code })
        schedule(g)
      } else {
        probe(g)
      }
      return
    }
    setStatus({ error: error.code })
    if (isPoll) schedule(g)
    else pollNow()
  }

  /* -------------------------------------------------------- events --- */

  function onVisibility() {
    const g = gen
    if (hidden()) {
      // Takes effect at the next schedule; waiting phases stop looking while hidden.
      if (WAITING.has(status.phase)) clearTimer()
      return
    }
    if (g === gen) pollNow()
  }

  function onFocus() {
    const g = gen
    if (['off', 'dismissed', 'denied'].includes(status.phase)) {
      void refreshPermission(g)
      return
    }
    if (status.phase === 'absent' || status.phase === 'lost') probe(g)
  }

  /** Another tab paired or forgot: check again with what is stored now. */
  function onTokenChanged() {
    const g = gen
    // Another tab switched Remember (or paired with it on): this tab's switch follows.
    if (env.mode === 'hosted') setStatus({ remember: readRemember(stores) })
    if (status.phase === 'off' || status.phase === 'dismissed') decide(g)
    else if (status.phase !== 'safari' && status.phase !== 'denied') probe(g)
  }

  function onPermission(state: string) {
    const g = gen
    const permission: LoopbackState =
      state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unsupported'
    if (permission === status.permission) return
    setStatus({ permission })
    if (permission === 'granted') promptBlocked = false
    if (status.phase !== 'connected' || permission === 'denied') decide(g)
  }

  async function refreshPermission(g: number) {
    if (env.mode === 'local') return
    const { state, status: watched } = await queryLoopback(permissions)
    if (g !== gen) return
    watch(watched)
    if (state !== status.permission) onPermission(state)
    else decide(g)
  }

  function watch(watched: PermissionStatusLike | null) {
    if (watched === permissionStatus) return
    if (permissionStatus) permissionStatus.onchange = null
    permissionStatus = watched
    if (watched) {
      watched.onchange = () => {
        onPermission(watched.state)
      }
    }
  }

  /* -------------------------------------------------------- operations --- */

  /** An authenticated operation: aborted by stop() too, and followed by the §2.7 re-poll. */
  async function operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const g = gen
    if (status.phase !== 'connected' || !authToken) {
      throw new HelperError('HELPER_UNREACHABLE', 'network')
    }
    const link = linkSignals(callerSignal, signal())
    try {
      return await run(link.signal)
    } catch (error) {
      if (!isAbortError(error)) onRequestFailure(g, error, false)
      throw error
    } finally {
      link.dispose()
    }
  }

  /** A Wi‑Fi operation: refused without the feature, and the list polled once it answers. */
  async function networkOperation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (status.phase === 'connected' && !status.health?.features.includes('android.connect')) {
      throw new HelperError('NETWORK_UNSUPPORTED', 'http')
    }
    const g = gen
    const reply = await operation(run)
    if (g === gen) {
      // The adb server's own list moved (a device added or removed): show it now.
      doctorCache = null
      pollNow()
    }
    return reply
  }

  function pollNow() {
    const g = gen
    if (!started) return
    if (status.phase === 'connected') pollDevices(g)
    else if (status.phase === 'absent' || status.phase === 'lost' || WAITING.has(status.phase))
      probe(g)
  }

  function switchPort(port: number) {
    env = { ...env, port, apiBase: `http://127.0.0.1:${String(port)}` }
    authToken = null
    client = createHelperClient(env.apiBase, () => authToken, { fetch: deps.fetch })
    setStatus({ env, health: null, lanes: null })
  }

  return {
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => {
        statusListeners.delete(listener)
      }
    },
    getDevices: () => devices,
    subscribeDevices(listener) {
      deviceListeners.add(listener)
      return () => {
        deviceListeners.delete(listener)
      }
    },

    start() {
      if (started) return
      started = true
      const g = ++gen
      controller = new AbortController()
      if (doc) {
        doc.addEventListener('visibilitychange', onVisibility)
        unlisten.push(() => {
          doc.removeEventListener('visibilitychange', onVisibility)
        })
      }
      if (win) {
        win.addEventListener('focus', onFocus)
        unlisten.push(() => {
          win.removeEventListener('focus', onFocus)
        })
        unlisten.push(subscribeToken(onTokenChanged, win))
      }
      if (env.mode === 'hosted' && env.safariLike) {
        decide(g)
        return
      }
      if (env.mode === 'local') {
        // Remembered on this origin by an earlier build: it never should have been.
        setRemembered(false, stores)
        setStatus({ permission: 'not-needed' })
        decide(g)
        return
      }
      void queryLoopback(permissions).then(({ state, status: watched }) => {
        if (g !== gen) return
        watch(watched)
        setStatus({ permission: state })
        decide(g)
      })
    },

    stop() {
      if (!started) return
      started = false
      gen++
      controller?.abort()
      controller = null
      clearTimer()
      for (const off of unlisten.splice(0)) off()
      watch(null)
      probing = false
      polling = false
      doctorInflight = null
      // The next start proves the helper again before anything is sent.
      authToken = null
      failures = 0
    },

    connect() {
      if (!started) return
      const g = gen
      promptBlocked = false
      setStatus({ intent: true })
      if (env.mode === 'hosted' && env.safariLike) return
      if (status.permission === 'denied') {
        enter('denied')
        return
      }
      if (status.phase === 'connected') pollDevices(g)
      else probe(g)
    },

    async pair(input, remember) {
      const candidate = parsePairInput(input)
      if (!candidate) return { ok: false, reason: 'format' }
      const g = gen
      promptBlocked = false
      setStatus({ intent: true })
      // A link may name another port. On the helper's own page only that helper counts.
      const port = env.mode === 'hosted' && candidate.port !== null ? candidate.port : env.port
      const target =
        port === env.port
          ? client
          : createHelperClient(`http://127.0.0.1:${String(port)}`, () => null, {
              fetch: deps.fetch,
            })
      const challenge = newChallenge(random)
      const prompting = env.mode === 'hosted' && status.permission === 'prompt'
      let health: Health
      try {
        health = await target.health(challenge, {
          signal: signal(),
          timeoutMs: prompting ? null : TIMEOUTS.health,
        })
      } catch (error) {
        const foreign = error instanceof HelperError && error.code === 'HELPER_FOREIGN'
        return { ok: false, reason: foreign ? 'foreign' : 'unreachable', port }
      }
      if (health.name !== HELPER_NAME) return { ok: false, reason: 'foreign', port }
      if (health.protocol < DVC_MIN_AGENT || health.protocol > DVC_MAX_AGENT) {
        return { ok: false, reason: health.protocol < DVC_MIN_AGENT ? 'outdated' : 'newer' }
      }
      const verdict = await verify(candidate.token, health, challenge, port)
      if (verdict === 'stale') return { ok: false, reason: 'stale', tokenId: health.tokenId }
      if (verdict === 'foreign') return { ok: false, reason: 'foreign', port }
      // Verified: only now may this pairing replace what the page had, port included, and the
      // switch in the dialog become the tester's Remember choice.
      if (port !== env.port) switchPort(port)
      if (env.mode === 'hosted') {
        setRemembered(remember, stores)
        setStatus({ remember })
      }
      const tokenId = await tokenIdOf(candidate.token)
      if (g !== gen || !started) {
        // Stopped meanwhile: keep the verified token for the next start.
        saveToken(
          { v: 1, token: candidate.token, port, tokenId },
          remember && env.mode === 'hosted',
          tokenStores(),
        )
        saveStoredPort(port, stores)
        return { ok: true }
      }
      adopt(g, candidate.token, health, remember)
      return { ok: true }
    },

    forget() {
      forgetPairing(stores)
      clearToken(keptMemory)
      wasPaired = false
      doctorCache = null
      if (['connected', 'lost', 'stale'].includes(status.phase)) {
        enter('unpaired', { pairing: null, remember: false })
        if (started) schedule(gen)
      } else {
        authToken = null
        setStatus({ pairing: null, remember: false })
      }
    },

    setRemember(on) {
      // Never on the helper's own page (see tokenStores).
      if (env.mode !== 'hosted') return
      setRemembered(on, stores)
      setStatus({
        remember: on,
        ...(status.pairing ? { pairing: { ...status.pairing, remembered: on } } : {}),
      })
    },

    async rescan() {
      if (status.phase !== 'connected') return
      const g = gen
      try {
        const snapshot = await operation((s) => client.rescan(s))
        if (g === gen && status.phase === 'connected') applySnapshot(snapshot)
      } catch {
        // operation() already re-polled or re-probed.
      }
    },

    pollNow,

    async doctor(refresh = false) {
      if (status.phase !== 'connected') return null
      if (!refresh && doctorCache && now() - doctorCache.at < CADENCE.doctorCache) {
        return doctorCache.report
      }
      if (doctorInflight && !refresh) return doctorInflight
      const g = gen
      const run = operation((s) => client.doctor(refresh, s)).then(
        (report) => {
          if (g === gen) doctorCache = { at: now(), report }
          return report
        },
        () => null,
      )
      doctorInflight = run
      void run.finally(() => {
        if (doctorInflight === run) doctorInflight = null
      })
      return run
    },

    async startAdb() {
      if (!status.health?.features.includes('android.start-server')) {
        throw new HelperError('ANDROID_OFF', 'http', {
          status: 409,
          body: {
            code: 'ANDROID_OFF',
            message: 'This helper can’t start Google’s adb server: it runs with --no-android.',
          },
        })
      }
      const g = gen
      const android = await operation((s) => client.startServer(s))
      if (g !== gen) return
      doctorCache = null
      if (status.lanes) setStatus({ lanes: { ...status.lanes, android } })
      pollNow()
    },

    connectNetwork: (target) => networkOperation((linked) => client.connectNetwork(target, linked)),
    pairNetwork: (target) => networkOperation((linked) => client.pairNetwork(target, linked)),
    disconnectNetwork: (serial) =>
      networkOperation((linked) => client.disconnectNetwork(serial, linked)),

    async nearby(refresh = false, s) {
      if (status.phase === 'connected' && !status.health?.features.includes('android.discover')) {
        throw new HelperError('DISCOVER_UNSUPPORTED', 'http')
      }
      return operation((linked) => client.nearby(refresh, linked), s)
    },

    api: {
      detail: (id, s) => operation((linked) => client.detail(id, linked), s),
      async screenshot(id, s) {
        return (await operation((linked) => client.screenshot(id, linked), s)).blob
      },
      capture: (id, s) => operation((linked) => client.screenshot(id, linked), s),
      async retry(id) {
        const device = await operation((linked) => client.retry(id, linked))
        pollNow()
        return device
      },
      logs: (id, onMsg, s) => operation((linked) => client.logs(id, onMsg, linked), s),
    },
  }
}
