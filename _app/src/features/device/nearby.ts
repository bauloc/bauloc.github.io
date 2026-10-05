import { deviceErrorMessage } from './backends/backend'
import { HelperError, isAbortError, type NetworkTarget } from './helper/client'
import type { HelperConnection, HelperStatus, VisibilityLike } from './helper/connection'
import { addressOf, sameTarget, targetOfSerial } from './helper/network'
import type { NearbyDevice, NearbyKind, NearbyReply } from './helper/protocol'
import { featureSupport, type FeatureSupport } from './helper/update'

/*
  "On this network" (feature `android.discover`): the Android devices the helper hears
  advertising debugging over mDNS, as the page offers them. Looking is all this does: a device
  found here is connected or paired only by the tester's click, through the Wi‑Fi flow
  (wifi.ts), never by itself, not even one connected before.

  It looks when something first shows it (the device list's section, the Wi‑Fi dialog's pick
  list), then every 30 s while the tab is visible and something still shows it; Refresh looks
  again at once. Plain functions over a snapshot, with subscribe(), for useSyncExternalStore.
*/

/** How often to look again while the section shows and the tab is visible. */
export const NEARBY_INTERVAL = 30_000

/**
 * Whether the helper can look now: `helper` while it isn't running and paired (the section is
 * then one line pointing at the helper's setup), `older` for a helper downloaded before
 * discovery shipped (the section says to update it), `off` for one started with --no-android.
 */
export function nearbyAvailability(
  status: Pick<HelperStatus, 'phase' | 'pairing' | 'health' | 'lanes'>,
): FeatureSupport {
  return featureSupport(status, 'android.discover')
}

export type NearbyState =
  /** Nothing asked yet. */
  | 'idle'
  /** The first look, with nothing heard yet. */
  | 'looking'
  | 'ok'
  /** This computer can't reach the local network: a VPN, or macOS local network privacy. */
  | 'blocked'
  /** The helper couldn't look (`message` says why: no network…), or the request failed (`code`). */
  | 'failed'
  /** The helper is older than discovery (no `android.discover`, or no such route). */
  | 'unsupported'

export interface NearbySnapshot {
  readonly state: NearbyState
  /**
   * What was heard last: kept while a later look runs. Blocked or failed, what adb lists
   * may still be here.
   */
  readonly devices: readonly NearbyDevice[]
  /** A look is in flight (the first shows "Looking…"; later ones only turn Refresh). */
  readonly busy: boolean
  /** When the last answer came (ms since the epoch), or null before one. */
  readonly at: number | null
  /** failed: the helper's sentence, or the page's for the code. */
  readonly message?: string
  readonly code?: string
  /** blocked, failed: what the system said, as the helper passed it on. */
  readonly detail?: string
}

export interface Nearby {
  readonly getSnapshot: () => NearbySnapshot
  readonly subscribe: (listener: () => void) => () => void
  /**
   * Something shows the list: look now (unless a look is recent) and every 30 s while visible.
   * Returns the release; looking stops once nothing shows it.
   */
  readonly watch: () => () => void
  /** Refresh: ask the helper to look again now, not answer from its last look. */
  readonly refresh: () => Promise<void>
}

export interface NearbyDeps {
  readonly connection: Pick<HelperConnection, 'nearby'>
  readonly document?: VisibilityLike | null
  readonly now?: () => number
  readonly intervalMs?: number
}

const INITIAL: NearbySnapshot = { state: 'idle', devices: [], busy: false, at: null }

/** A failed look's state, from the helper's error. */
function failure(error: unknown): Partial<NearbySnapshot> {
  if (error instanceof HelperError) {
    if (error.code === 'DISCOVER_UNSUPPORTED' || error.code === 'NOT_FOUND') {
      return { state: 'unsupported', code: error.code }
    }
    if (error.body?.reason === 'blocked') {
      return {
        state: 'blocked',
        devices: [],
        ...(error.body.detail ? { detail: error.body.detail } : {}),
      }
    }
    // Our own deadline: the helper may still be looking, but this page stopped waiting.
    const code = error.kind === 'timeout' ? 'HELPER_TIMEOUT' : error.code
    // The helper's own sentence when it sent one, else the page's words for the code: this
    // page raises HELPER_UNREACHABLE and HELPER_BAD_REPLY itself, and they carry no sentence.
    return {
      state: 'failed',
      code,
      message: error.body?.message || deviceErrorMessage(new Error(code)),
    }
  }
  return { state: 'failed', code: 'INTERNAL' }
}

function settled(reply: NearbyReply, at: number): Partial<NearbySnapshot> {
  const { error } = reply
  const words = {
    ...(error?.message ? { message: error.message } : {}),
    ...(error?.detail ? { detail: error.detail } : {}),
  }
  if (error?.reason === 'blocked') return { state: 'blocked', devices: reply.devices, at, ...words }
  if (error) return { state: 'failed', devices: reply.devices, at, code: error.reason, ...words }
  return { state: 'ok', devices: reply.devices, at }
}

export function createNearby(deps: NearbyDeps): Nearby {
  const now = deps.now ?? Date.now
  const interval = deps.intervalMs ?? NEARBY_INTERVAL
  const doc: VisibilityLike | null =
    deps.document !== undefined ? deps.document : typeof document === 'undefined' ? null : document
  const listeners = new Set<() => void>()
  let snap: NearbySnapshot = INITIAL
  let watchers = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: { refresh: boolean; done: Promise<void>; controller: AbortController } | null = null

  function set(next: Partial<NearbySnapshot>) {
    // A new state replaces the last one's words: they never outlive the state they explain.
    const base: NearbySnapshot =
      'state' in next
        ? { state: snap.state, devices: snap.devices, busy: snap.busy, at: snap.at }
        : snap
    snap = { ...base, ...next }
    for (const listener of listeners) listener()
  }

  const visible = () => !doc || doc.visibilityState === 'visible'

  function schedule() {
    clearTimeout(timer)
    timer = undefined
    if (watchers === 0 || !visible()) return
    const since = snap.at === null ? interval : now() - snap.at
    timer = setTimeout(
      () => {
        timer = undefined
        void look(false)
      },
      Math.max(0, interval - since),
    )
  }

  function look(refresh: boolean): Promise<void> {
    // A Refresh while an automatic look runs waits for it, then looks again; never two at once.
    if (inflight) {
      if (!refresh || inflight.refresh) return inflight.done
      const first = inflight.done
      return first.then(() => look(true))
    }
    clearTimeout(timer)
    timer = undefined
    const controller = new AbortController()
    set({ busy: true, ...(snap.state === 'idle' ? { state: 'looking' as const } : {}) })
    const done = deps.connection.nearby(refresh, controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) set({ ...settled(reply, now()), busy: false })
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        set({ ...failure(error), at: now(), busy: false })
      },
    )
    const mine = { refresh, done, controller }
    inflight = mine
    return done.finally(() => {
      if (inflight === mine) inflight = null
      if (controller.signal.aborted) return
      schedule()
    })
  }

  function onVisibility() {
    if (visible()) schedule()
    else {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    getSnapshot: () => snap,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    watch() {
      watchers++
      if (watchers === 1) {
        doc?.addEventListener('visibilitychange', onVisibility)
        // Looked moments ago (another view, a quick close and reopen): the answer stands.
        if (!inflight && visible()) {
          if (snap.at === null || now() - snap.at >= interval) void look(false)
          else schedule()
        }
      }
      let released = false
      return () => {
        if (released) return
        released = true
        watchers--
        if (watchers > 0) return
        doc?.removeEventListener('visibilitychange', onVisibility)
        clearTimeout(timer)
        timer = undefined
        if (inflight) {
          inflight.controller.abort()
          inflight = null
          set({ busy: false, ...(snap.state === 'looking' ? { state: 'idle' as const } : {}) })
        }
      }
    },

    refresh: () => look(true),
  }
}

/* ---------------------------------------------------------------- *
 * Rows: one per device, ready to show
 * ---------------------------------------------------------------- */

/** The one thing a found device offers. */
export type NearbyAction =
  /** Network debugging, or Wireless debugging this computer already paired with. */
  | { readonly kind: 'connect'; readonly target: NetworkTarget }
  /**
   * Wireless debugging not known to be paired: the Wi‑Fi dialog, with the pairing address when
   * the device's pairing screen is open (null: the tester reads it off that screen), and the
   * connect address to use once paired.
   */
  | {
      readonly kind: 'pair'
      readonly host: string
      readonly pair: NetworkTarget | null
      readonly connect: NetworkTarget | null
    }

export interface NearbyRow {
  readonly key: string
  /** Its friendly name, else its model, else its serial, else its address. */
  readonly name: string
  /** "192.168.68.101:5555": where Connect goes, or the pairing address. */
  readonly address: string
  /** For the badge: Network debugging (`adb`) or Wireless debugging. */
  readonly kind: NearbyKind
  /** It also advertises Android TV Remote or Google Cast. */
  readonly tv: boolean
  /** The pairing screen is open on it now. */
  readonly pairingOpen: boolean
  readonly action: NearbyAction
}

/** What the page lists already, to leave out what is connected (a USB serial counts too). */
export interface ListedDevice {
  readonly id: string
  readonly connection?: string
}

const target = (d: NearbyDevice): NetworkTarget => ({ host: d.host, port: d.port })

/**
 * The devices to offer, one row each, by name: what advertises the same serial (else the same
 * address) is one device. Left out: what the helper or the page lists already (connected by
 * its address, its mDNS name or its serial, on a cable too).
 */
export function nearbyRows(
  found: readonly NearbyDevice[],
  listed: readonly ListedDevice[],
): NearbyRow[] {
  const listedIds = new Set(listed.map((d) => d.id))
  const listedTargets = listed
    .filter((d) => d.connection === 'network')
    .flatMap((d) => targetOfSerial(d.id) ?? [])
  const isListed = (d: NearbyDevice) =>
    d.connected ||
    (d.serial !== '' && listedIds.has(d.serial)) ||
    // adb's own mDNS connections are listed as "<instance>._adb-tls-connect._tcp".
    (d.instance !== '' && listed.some((l) => l.id.startsWith(`${d.instance}.`))) ||
    (d.kind !== 'pairing' && listedTargets.some((t) => sameTarget(t, target(d))))

  const groups = new Map<string, NearbyDevice[]>()
  for (const d of found) {
    const key = d.serial ? `serial:${d.serial}` : `host:${d.host}`
    groups.set(key, [...(groups.get(key) ?? []), d])
  }

  const rows: NearbyRow[] = []
  for (const [key, all] of groups) {
    if (all.some(isListed)) continue
    const adb = all.find((d) => d.kind === 'adb')
    const wireless = all.find((d) => d.kind === 'wireless')
    const pairing = all.find((d) => d.kind === 'pairing')
    const any = adb ?? wireless ?? pairing
    if (!any) continue
    const name =
      all.find((d) => d.name)?.name || all.find((d) => d.model)?.model || any.serial || any.host
    let action: NearbyAction
    if (adb) action = { kind: 'connect', target: target(adb) }
    else if (wireless && all.some((d) => d.paired)) {
      action = { kind: 'connect', target: target(wireless) }
    } else {
      action = {
        kind: 'pair',
        host: (pairing ?? any).host,
        pair: pairing ? target(pairing) : null,
        connect: wireless ? target(wireless) : null,
      }
    }
    const shown = action.kind === 'connect' ? action.target : (action.connect ?? action.pair)
    rows.push({
      key,
      name,
      address: shown ? addressOf(shown) : any.host,
      kind: any.kind,
      tv: all.some((d) => d.tv),
      pairingOpen: pairing !== undefined,
      action,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}
