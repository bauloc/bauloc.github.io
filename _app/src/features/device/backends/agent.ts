import { defineMessages, localized } from '@/lib/i18n'

import { HelperError } from '../helper/client'
import type { HelperConnection } from '../helper/connection'
import type { DetailResponse, HelperDevice, LogMsg } from '../helper/protocol'
import { normalizeDevice, type Device, type DeviceDetail } from '../model'
import { androidDetail } from './android'
import type { Backend } from './backend'
import { iosDetail, iosModelName, simulatorDetail } from './ios'

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
*/

/** The helper's row as the page's Device. The helper never knows an iPhone's marketing name. */
export function toDevice(d: HelperDevice): Device {
  const model = d.model || (d.platform === 'ios' ? iosModelName(d.modelId) : '') || d.modelId
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
    // Installs, apps and images are the WebUSB lane's, for now.
    capabilities: {
      screenshot: d.capabilities.screenshot,
      identifiers: d.capabilities.identifiers,
      logs: d.capabilities.logs,
      install: false,
    },
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
  return {
    kind: 'agent',
    label: 'Local helper',
    platforms: ['ios', 'android'],
    canRequest: false,
    isAvailable: () => true,
    start: () => {
      conn.start()
      return Promise.resolve()
    },
    stop: () => {
      conn.stop()
    },
    subscribe: (listener) => conn.subscribeDevices(listener),
    list: () => conn.getDevices().map(toDevice),
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
  }
}
