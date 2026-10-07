import type { Adb } from '@yume-chan/adb'

import { defineMessages, localized } from '@/lib/i18n'

import { HelperError } from '../helper/client'
import type { HelperConnection } from '../helper/connection'
import type { DetailResponse, HelperDevice, LogMsg } from '../helper/protocol'
import {
  MIN_INSTALL_SDK,
  normalizeDevice,
  type AndroidFacts,
  type Device,
  type DeviceDetail,
} from '../model'
import { androidDetail } from './android'
import type { Backend } from './backend'
import { iosDetail, iosModelName, simulatorDetail } from './ios'
import { parseSdk } from './webusb'
import { createAndroidOps } from './webusb-ops'

/*
  The local helper as a lane (spec §7.3): iPhones over usbmuxd and lockdown, booted simulators,
  and Android phones through Google's adb server, all from device-bridge.mjs on 127.0.0.1.

  This file only translates. The HelperConnection (helper/connection.ts) owns everything about
  reaching the helper — the permission prompt, the pairing and its proof, polling, backoff —
  and its list is [] unless it is connected. So this lane is always "available": the store
  subscribes only to lanes available at start(), and a helper started later must still appear.

  Three rules keep it honest:
  - start() never waits on the helper. The store starts lanes one after another, and WebUSB
    must not sit behind a probe of 127.0.0.1.
  - refresh() never probes a helper the tester hasn't asked for (phases off, denied, safari,
    dismissed): Refresh and the R key must never raise the browser's Local Network prompt.
  - Codes, not words: a failure rejects with HelperError, whose message is the code whenever
    DEVICE_ERRORS words it, so deviceErrorMessage() works unchanged. The connection already
    re-polls after any failed operation (§2.7), so a row whose state changed updates by itself.

  Android devices also get WebUSB's operations — installs, the Apps and Images tabs — through
  the helper's adb tunnel (§4.10, feature `android.adb`): an Adb whose every service is a
  WebSocket the helper pipes to Google's adb server (agent-adb.ts). That is what reaches an
  Android TV on the Wi‑Fi, or a phone the adb server holds. One such Adb per ready device,
  opened as soon as the device is ready (its API level gates installs) and closed when the
  row goes, stops being ready, or the helper restarts.
*/

/** What WebUSB reads at connect, read here through the tunnel (the helper has the model). */
const PROPS = [
  'ro.product.manufacturer',
  'ro.product.brand',
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.product.cpu.abilist',
] as const

/** A device whose tunnel couldn't open isn't tried again on its own for this long. */
const REOPEN_AFTER_MS = 15_000

/** One Android device's adb over the tunnel, while it lasts. */
interface AdbSession {
  readonly adb: Adb
  readonly serial: string
  readonly facts: AndroidFacts
}

/** The tunnel's part of a row: null when the device has none (not Android, or an older helper). */
export interface TunnelState {
  /** What connect read off the device; null until it has. */
  readonly facts: AndroidFacts | null
}

/**
 * The helper's row as the page's Device. The helper never knows an iPhone's marketing name.
 * `tunnel`: the adb tunnel's part, for an Android row of a helper that has one; installs,
 * apps and images need it.
 */
export function toDevice(d: HelperDevice, tunnel: TunnelState | null = null): Device {
  const model = d.model || (d.platform === 'ios' ? iosModelName(d.modelId) : '') || d.modelId
  const ready = d.state === 'ready'
  const sdk = tunnel?.facts?.sdk ?? null
  return normalizeDevice({
    id: d.id,
    backend: 'agent',
    platform: d.platform,
    connection: d.connection,
    state: d.state,
    name: d.name,
    model,
    osVersion: d.osVersion,
    blockers: [...d.blockers],
    capabilities: {
      screenshot: d.capabilities.screenshot,
      identifiers: d.capabilities.identifiers,
      logs: d.capabilities.logs,
      install: ready && sdk !== null && sdk >= MIN_INSTALL_SDK,
      ...(d.platform === 'android'
        ? { apps: ready && tunnel !== null, images: ready && tunnel !== null }
        : {}),
    },
    ...(tunnel?.facts ? { android: tunnel.facts } : {}),
  })
}

const AGENT_MESSAGES = defineMessages({
  en: {
    wifi: 'Wi‑Fi (local helper)',
    usb: 'USB (local helper)',
    logEnded: '— The log ended.',
  },
  vi: {
    wifi: 'Wi‑Fi (helper cục bộ)',
    usb: 'USB (helper cục bộ)',
    logEnded: '— Log đã kết thúc.',
  },
})

/** The lane's words, in the language on screen. */
const WORDS = localized(AGENT_MESSAGES)

/** What the Connection row says, per lane and transport. */
export function connectionLabel(r: DetailResponse): string {
  if (r.kind === 'simulator') return 'Simulator'
  if (r.kind === 'ios') {
    return r.facts.connection === 'network' ? WORDS.wifi : WORDS.usb
  }
  return r.connection === 'network'
    ? 'Wi‑Fi (adb server)'
    : r.connection === 'simulator'
      ? 'Emulator (adb server)'
      : 'USB (adb server)'
}

/** The detail pane for any of the helper's devices, with the formatter its kind needs. */
export function toDetail(r: DetailResponse): DeviceDetail {
  switch (r.kind) {
    case 'android':
      // The same six outputs WebUSB reads (the contract test holds the commands equal), so
      // only the Connection row differs.
      return androidDetail(r.outputs, r.serial, connectionLabel(r))
    case 'ios': {
      const detail = iosDetail(r.facts, connectionLabel(r))
      // The lane's name has words in it ("local helper"): read again at each access, like the
      // values iosDetail words, so the stored detail follows a language switch.
      Object.defineProperty(detail.status, 'Connection', { get: () => connectionLabel(r) })
      return detail
    }
    case 'simulator':
      return simulatorDetail(r.facts)
  }
}

/**
 * Printed in the console when the device closes its log: an iPhone over Wi‑Fi says only eof.
 * This is the English; the console gets it in the language on screen.
 */
export const LOG_ENDED_LINE = AGENT_MESSAGES.en.logEnded

type LogEnd = Extract<LogMsg, { t: 'end' }>

/**
 * How a stream's `end` record settles logs(): resolved when the log simply finished, rejected
 * with a code the console words otherwise. null: resolve.
 */
export function logEndError(end: LogEnd | null): HelperError | null {
  // The body closed without an `end`: the helper always writes one unless it went away.
  if (!end) return new HelperError('HELPER_UNREACHABLE', 'network')
  switch (end.reason) {
    case 'eof':
    case 'client-gone':
      return null
    case 'replaced':
      // Opened again elsewhere (this page aborts its own old stream before it could be replaced).
      return new HelperError('STREAM_REPLACED', 'http')
    case 'device-gone':
      return new HelperError('DEVICE_GONE', 'http')
    case 'shutdown':
      return new HelperError('HELPER_UNREACHABLE', 'network')
    case 'error': {
      const code = end.code ?? 'TOOL_FAILED'
      return new HelperError(code, 'http', { body: { code, message: end.message ?? '' } })
    }
  }
}

/**
 * Streams one device's log into `onLines` until the device or the helper ends it, or `signal`
 * aborts. Aborting resolves quietly, with no unhandled rejection (the PR #9 guarantee).
 */
export async function streamLogs(
  conn: HelperConnection,
  id: string,
  onLines: (lines: string[]) => void,
  signal: AbortSignal,
): Promise<void> {
  let end: LogEnd | null = null
  await conn.api.logs(
    id,
    (m) => {
      if (signal.aborted) return
      if (m.t === 'lines') onLines([...m.lines])
      else if (m.t === 'notice') onLines([`— ${m.text}`])
      else if (m.t === 'end') end = m
    },
    signal,
  )
  if (signal.aborted) return
  const error = logEndError(end)
  if (error) {
    // The row may have changed (gone, or the helper stopping): look at the list again now.
    conn.pollNow()
    throw error
  }
  // Said in the console, so a log that stops on its own doesn't look like a frozen one. Not for
  // a Wi‑Fi device: its log ends this way when the link drops, and the page's log says that
  // itself, and picks up again when the device is back (log-sessions.ts).
  const network = conn.getDevices().find((d) => d.id === id)?.connection === 'network'
  if (network) {
    conn.pollNow()
    return
  }
  onLines([WORDS.logEnded])
}

/** The local helper lane. `conn` is built once per page and started through this lane. */
export function createAgentBackend(conn: HelperConnection): Backend {
  const listeners = new Set<() => void>()
  const sessions = new Map<string, AdbSession>()
  const opening = new Map<string, Promise<AdbSession>>()
  /** When a device's tunnel last failed to open, so a poll doesn't retry it every 2 s. */
  const failedAt = new Map<string, number>()
  /** The helper run the sessions belong to: a restarted helper is a new adb client. */
  let runId: string | null = null
  let unsubscribe: (() => void) | null = null

  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  /** Whether the running helper has the tunnel, so its Android rows get the operations. */
  const tunnelReady = (): boolean => {
    const status = conn.getStatus()
    return status.phase === 'connected' && !!status.health?.features.includes('android.adb')
  }

  const isReadyAndroid = (d: HelperDevice | undefined): d is HelperDevice =>
    d?.platform === 'android' && d.state === 'ready'

  function drop(id: string) {
    opening.delete(id)
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    void session.adb.close()
    ops.reset(id)
    notify()
  }

  /** The device's adb over the tunnel: the one already open, or a new one. */
  function ensure(id: string): Promise<AdbSession> {
    const open = sessions.get(id)
    if (open) return Promise.resolve(open)
    const pending = opening.get(id)
    if (pending) return pending
    if (!tunnelReady()) return Promise.reject(new HelperError('ADB_UNSUPPORTED', 'http'))
    if (!isReadyAndroid(conn.getDevices().find((d) => d.id === id))) {
      return Promise.reject(new Error('DEVICE_NOT_READY'))
    }
    const attempt = (async (): Promise<AdbSession> => {
      const info = await conn.api.adbInfo(id)
      const { createTunnelAdb } = await import('./agent-adb')
      const adb = createTunnelAdb({
        serial: info.serial,
        features: info.features,
        open: (service) => conn.api.openAdb(id, service),
      })
      const read = await Promise.allSettled(PROPS.map((key) => adb.getProp(key)))
      if (read.every((r) => r.status === 'rejected')) {
        void adb.close()
        throw read[0]?.status === 'rejected' ? read[0].reason : new Error('DEVICE_NOT_READY')
      }
      const [manufacturer, brand, release, sdk, abilist] = read.map((r) =>
        r.status === 'fulfilled' ? r.value.trim() : '',
      )
      return {
        adb,
        serial: info.serial,
        facts: {
          sdk: parseSdk(sdk ?? ''),
          release: release ?? '',
          manufacturer: manufacturer ?? '',
          brand: brand ?? '',
          abis: (abilist ?? '')
            .split(',')
            .map((abi) => abi.trim())
            .filter(Boolean),
        },
      }
    })()
    opening.set(id, attempt)
    const settled = attempt.then(
      (session) => {
        // Dropped while it opened (the row went, or the helper restarted).
        if (opening.get(id) !== attempt) {
          void session.adb.close()
          throw new Error('DEVICE_NOT_READY')
        }
        opening.delete(id)
        failedAt.delete(id)
        sessions.set(id, session)
        notify()
        // An install a dropped connection left half-done is abandoned now, as over WebUSB.
        void ops.abandonLeftovers(id).catch(() => undefined)
        return session
      },
      (error: unknown) => {
        if (opening.get(id) === attempt) {
          opening.delete(id)
          failedAt.set(id, Date.now())
        }
        throw error
      },
    )
    // The poll that opened it doesn't wait; an operation that asked gets the error.
    settled.catch(() => undefined)
    return settled
  }

  /**
   * Keeps one adb session per ready Android row of a helper with the tunnel: opened when a
   * row turns ready, closed when it goes or stops being ready, all closed for a new helper.
   */
  function sync() {
    const usable = tunnelReady()
    const run = usable ? (conn.getStatus().health?.runId ?? null) : null
    if (run !== runId) {
      for (const id of [...sessions.keys(), ...opening.keys()]) drop(id)
      failedAt.clear()
      runId = run
    }
    const ready = new Set(
      usable
        ? conn
            .getDevices()
            .filter(isReadyAndroid)
            .map((d) => d.id)
        : [],
    )
    for (const id of [...sessions.keys(), ...opening.keys()]) {
      if (!ready.has(id)) drop(id)
    }
    const now = Date.now()
    for (const id of ready) {
      if (sessions.has(id) || opening.has(id)) continue
      if (now - (failedAt.get(id) ?? -Infinity) < REOPEN_AFTER_MS) continue
      void ensure(id).catch(() => undefined)
    }
  }

  const ops = createAndroidOps((id) => {
    const session = sessions.get(id)
    if (!session) throw new Error('DEVICE_NOT_READY')
    return {
      adb: session.adb,
      serial: session.serial,
      sdk: session.facts.sdk,
      alive: () => sessions.get(id) === session,
    }
  })

  /** An operation on the device's adb, opened first when it isn't yet. */
  const via =
    <A extends unknown[], R>(run: (id: string, ...rest: A) => Promise<R>) =>
    async (id: string, ...rest: A): Promise<R> => {
      await ensure(id)
      return run(id, ...rest)
    }

  const tunnelOf = (d: HelperDevice, usable: boolean): TunnelState | null =>
    usable && d.platform === 'android' ? { facts: sessions.get(d.id)?.facts ?? null } : null

  return {
    kind: 'agent',
    label: 'Local helper',
    platforms: ['ios', 'android'],
    canRequest: false,
    isAvailable: () => true,
    start: () => {
      if (!unsubscribe) {
        const offDevices = conn.subscribeDevices(sync)
        const offStatus = conn.subscribeStatus(sync)
        unsubscribe = () => {
          offDevices()
          offStatus()
        }
      }
      conn.start()
      sync()
      return Promise.resolve()
    },
    stop: () => {
      unsubscribe?.()
      unsubscribe = null
      for (const id of [...sessions.keys(), ...opening.keys()]) drop(id)
      runId = null
      conn.stop()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      const off = conn.subscribeDevices(listener)
      return () => {
        listeners.delete(listener)
        off()
      }
    },
    list: () => {
      const usable = tunnelReady()
      return conn.getDevices().map((d) => toDevice(d, tunnelOf(d, usable)))
    },
    detail: async (id) => toDetail(await conn.api.detail(id)),
    // The client checks the Content-Type and cuts the PNG at IEND, so this is a clean image/png.
    screenshot: (id) => conn.api.screenshot(id),
    // The connection polls once the read-only re-check answered.
    retry: async (id) => {
      await conn.api.retry(id)
    },
    refresh: () => {
      const { phase } = conn.getStatus()
      if (phase === 'connected') return conn.rescan()
      if (phase === 'absent' || phase === 'lost') conn.pollNow()
      return Promise.resolve()
    },
    logs: (id, onLines, signal) => streamLogs(conn, id, onLines, signal),

    install: via(ops.install),
    apps: via(ops.apps),
    app: via(ops.app),
    appAction: via(ops.appAction),
    images: via(ops.images),
    thumbnail: via(ops.thumbnail),
    pull: via(ops.pull),
    deviceSpec: via(ops.deviceSpec),
    installFacts: via(ops.installFacts),
    appBadge: via(ops.appBadge),
  }
}
