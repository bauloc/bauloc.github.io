import { HelperError, type NetworkTarget, type PairTarget } from './helper/client'
import type { HelperConnection } from './helper/connection'
import {
  defaultRecentStore,
  forgetRecent,
  readRecent,
  rememberRecent,
  renameRecent,
  sameTarget,
  targetOfSerial,
  type RecentDevice,
  type RecentStore,
} from './helper/network'
import type { HelperDevice } from './helper/protocol'
import type { WifiAttempt } from './preflight/types'

/*
  Android over Wi‑Fi, as state (§4.7): the tester's last connect or pairing, and the devices this
  browser connected to before. The Wi‑Fi dialog drives it and shows it; the Environment check
  reads the same attempt for its Wi‑Fi rows (checks.ts wifiChecks).

  Every operation is the tester's click, through the helper (HelperConnection): the page never
  connects, pairs or disconnects anything by itself, not even a remembered device on load.

  Plain functions over a snapshot, with subscribe(), for useSyncExternalStore, like store.ts.
*/

export interface WifiSnapshot {
  /** The last connect or pairing, until the next one. */
  readonly attempt: WifiAttempt | null
  /** The remembered devices, newest first. */
  readonly recent: readonly RecentDevice[]
  /** The serial a Disconnect is in flight for. */
  readonly disconnecting: string | null
}

export interface Wifi {
  readonly getSnapshot: () => WifiSnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** Resolves with the serial the device is listed under, or null when it failed (see attempt). */
  readonly connect: (target: NetworkTarget) => Promise<string | null>
  /** Resolves true once paired; the tester connects next, on the port the device shows. */
  readonly pair: (target: PairTarget) => Promise<boolean>
  /** Resolves with the failure's code, or null once disconnected (or already gone). */
  readonly disconnect: (serial: string) => Promise<string | null>
  readonly forget: (target: NetworkTarget) => void
  /**
   * The helper's list changed: remembered devices take the names they are listed under, and
   * Disconnect knows which devices are still there.
   */
  readonly sync: (devices: readonly HelperDevice[]) => void
}

export interface WifiDeps {
  readonly connection: Pick<
    HelperConnection,
    'connectNetwork' | 'pairNetwork' | 'disconnectNetwork'
  >
  readonly store?: RecentStore | null
  readonly now?: () => number
}

/** A failed attempt's facts, from the helper's error (or the page's own). */
export function failureOf(
  error: unknown,
): Pick<WifiAttempt, 'code' | 'reason' | 'message' | 'detail'> {
  if (!(error instanceof HelperError)) {
    return { code: 'INTERNAL', message: error instanceof Error ? error.message : '' }
  }
  // Our own deadline: the helper may still be waiting on adb, but this page stopped waiting.
  const code = error.kind === 'timeout' ? 'HELPER_TIMEOUT' : error.code
  const body = error.body
  return {
    code,
    ...(body?.reason ? { reason: body.reason } : {}),
    // The helper's own sentence when it sent one, else the page's words for the code.
    message: body?.message || error.message,
    ...(body?.detail ? { detail: body.detail } : {}),
  }
}

export function createWifi(deps: WifiDeps): Wifi {
  const store = deps.store === undefined ? defaultRecentStore() : deps.store
  const now = deps.now ?? Date.now
  const listeners = new Set<() => void>()
  let snap: WifiSnapshot = { attempt: null, recent: readRecent(store), disconnecting: null }
  /** Only the newest attempt may settle: a slow connect must not overwrite a later one. */
  let seq = 0
  /** The Wi‑Fi devices the helper listed last (sync), to tell "gone already" from a refusal. */
  let listed = new Set<string>()

  function set(next: Partial<WifiSnapshot>) {
    snap = { ...snap, ...next }
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => snap,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async connect(target) {
      const mine = ++seq
      const base = { kind: 'connect', host: target.host, port: target.port } as const
      set({ attempt: { ...base, state: 'running' } })
      try {
        const reply = await deps.connection.connectNetwork(target)
        if (mine === seq) {
          set({
            attempt: { ...base, state: 'ok', serial: reply.serial },
            recent: rememberRecent({ ...target, name: reply.device?.name ?? '' }, now(), store),
          })
        }
        return reply.serial
      } catch (error) {
        if (mine === seq) set({ attempt: { ...base, state: 'failed', ...failureOf(error) } })
        return null
      }
    },

    async pair(target) {
      const mine = ++seq
      const base = { kind: 'pair', host: target.host, port: target.port } as const
      set({ attempt: { ...base, state: 'running' } })
      try {
        await deps.connection.pairNetwork(target)
        if (mine === seq) set({ attempt: { ...base, state: 'ok' } })
        return true
      } catch (error) {
        if (mine === seq) set({ attempt: { ...base, state: 'failed', ...failureOf(error) } })
        return false
      }
    },

    async disconnect(serial) {
      if (snap.disconnecting !== null) return 'BUSY'
      set({ disconnecting: serial })
      try {
        await deps.connection.disconnectNetwork(serial)
        return null
      } catch (error) {
        const code = failureOf(error).code ?? 'INTERNAL'
        // Gone already: what the tester wanted. But only if the list agrees: adb says "no such
        // device" too for a serial it can't drop, and then the device is still there.
        return code === 'DEVICE_NOT_FOUND' && !listed.has(serial) ? null : code
      } finally {
        set({ disconnecting: null })
      }
    },

    forget(target) {
      set({ recent: forgetRecent(target, store) })
    },

    sync(devices) {
      listed = new Set(
        devices
          .filter((d) => d.platform === 'android' && d.connection === 'network')
          .map((d) => d.id),
      )
      let recent: readonly RecentDevice[] | null = null
      for (const d of devices) {
        if (d.platform !== 'android' || d.connection !== 'network' || !d.name) continue
        const target = targetOfSerial(d.id)
        const known = target && (recent ?? snap.recent).find((r) => sameTarget(r, target))
        if (target && known && known.name !== d.name) recent = renameRecent(target, d.name, store)
      }
      if (recent) set({ recent })
    },
  }
}
