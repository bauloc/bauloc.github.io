import { defineMessages, localized } from '@/lib/i18n'
import { currentLocale, type Locale } from '@/lib/locale'

import type { Backend } from './backends/backend'
import { logLevel, type LogLevel } from './components/log-level'
import type { Device } from './model'

/*
  The device logs this page streams, kept apart from the console that shows them.

  A log used to live inside its LogConsole, so a device that dropped off for a moment (a Wi‑Fi
  iPhone or TV, a loose cable, the helper restarting) unmounted the console and took the log
  with it: the tester came back to "Press Start" and no word of what happened. Here a session
  outlives its console, and a drop is part of the log:

  - The stream ends because the device went (it stopped being ready, or the lane said so:
    DEVICE_GONE, IOS_UNREACHABLE…) while its row is still listed: the log says when, and waits.
    The helper keeps a Wi‑Fi iPhone that dropped listed, as ready, for its whole hold (2 min;
    real gaps measured 6–90 s), so the wait is as long as that hold.
  - While the row is listed the log is tried again on a short backoff, since a Wi‑Fi link can
    come back without the row ever changing; once it streams, the log says so.
  - The row leaves the list (the helper gave up on it, or a cable was pulled) or the hold
    passes: the log says it stopped, and Start is the tester's again.

  Stop is always the tester's: a stopped log never comes back on its own. One log per tab, as
  before: selecting another device ends the others (keepOnly).

  Plain functions over a mutable table, with an immutable view per device for
  useSyncExternalStore, like store.ts.
*/

/**
 * How long a log waits for its device to come back before it gives up: the helper's hold on a
 * Wi‑Fi iPhone that dropped (IOS_TUNING.wifiHoldMs in helper/src/ios-lane.ts). Longer would
 * wait on a row the helper has dropped; shorter gives up on a phone still listed as ready.
 */
export const RESUME_WINDOW_MS = 120_000
/** While the device is still listed, the next attempts to reopen its log: 1, 2, 4, then 8 s. */
export const RESUME_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000]
/**
 * The last attempt lands this long before the window ends, whatever the backoff says: a
 * device back at 115 s is still tried before the log gives up at 120 s.
 */
export const LAST_TRY_LEAD_MS = 1_000
/** The log keeps this many lines; older ones scroll away for good. */
export const LOG_LIMIT = 2000

/**
 * The lanes' ways of saying the device went away mid-stream. Anything else (too many logs, no
 * log source, a replaced stream) is a failure the tester has to see, not a drop to wait out.
 */
export const DROP_CODES: ReadonlySet<string> = new Set([
  'DEVICE_GONE',
  'DEVICE_DROPPED',
  'DEVICE_NOT_FOUND',
  'DEVICE_NOT_READY',
  'DEVICE_DISCONNECTED',
  'IOS_UNREACHABLE',
  'IOS_LOCKDOWN_FAILED',
  'ANDROID_OFFLINE',
  'ADB_SERVER_STOPPED',
  'HELPER_UNREACHABLE',
  'HELPER_STREAM_STALLED',
])

export interface LogLine {
  readonly seq: number
  readonly text: string
  /** Read once as the line arrives, not on every render of up to LOG_LIMIT lines. */
  readonly level: LogLevel
  /** Said by this page (a drop, a resume), not by the device. */
  readonly note?: true
}

/** What a log knows of its device, kept while the device is away. */
export type LogDevice = Pick<Device, 'id' | 'name' | 'platform' | 'connection'>

export type LogPhase =
  /** Not streaming: never started, stopped, or given up on. */
  | 'idle'
  | 'running'
  /** The device dropped while the log ran: it resumes if the device is back in time. */
  | 'waiting'

export interface LogView {
  readonly lines: readonly LogLine[]
  readonly phase: LogPhase
  /** waiting: when the log gives up (ms since the epoch). */
  readonly until: number | null
  /** The device as last seen; null for a log never started. */
  readonly device: LogDevice | null
}

/** Something the tester should hear about: the page toasts and announces these. */
export type LogEvent =
  | { readonly kind: 'failed'; readonly device: LogDevice; readonly error: unknown }
  | { readonly kind: 'dropped'; readonly device: LogDevice }
  | { readonly kind: 'resumed'; readonly device: LogDevice }
  | {
      readonly kind: 'gave-up'
      readonly device: LogDevice
      /** `window`: the hold passed; `unlisted`: the row left the list. */
      readonly reason: 'window' | 'unlisted'
    }

export interface LogSessions {
  /** The view for one device; the same object until something in it changes. */
  readonly view: (deviceId: string) => LogView
  /** The device whose log waits for it to come back, if any (one log per tab). */
  readonly waitingId: () => string | null
  readonly subscribe: (listener: () => void) => () => void
  /** Start (or restart) a device's log; the tester's Start. */
  readonly start: (device: Device, backend: Backend) => void
  /** The tester's Stop: also ends a wait, so the log never comes back by itself. */
  readonly stop: (deviceId: string) => void
  /** Empties a log's lines; a running log keeps running. */
  readonly clear: (deviceId: string) => void
  /** The page's device list, each time it changes: notices drops and returns. */
  readonly sync: (
    devices: readonly Device[],
    backendOf: (device: Device) => Backend | undefined,
  ) => void
  /** Ends and forgets every log but this device's (another device was selected). */
  readonly keepOnly: (deviceId: string) => void
  /** Ends every log and forgets them (the page unmounts); subscribers stay subscribed. */
  readonly dispose: () => void
}

export interface LogSessionDeps {
  readonly now?: () => number
  readonly onEvent?: (event: LogEvent) => void
}

const EMPTY: LogView = { lines: [], phase: 'idle', until: null, device: null }

interface Session {
  view: LogView
  /** The stream in flight, if any. */
  controller: AbortController | null
  /** The next attempt to reopen it, or the end of the wait. */
  retryTimer: ReturnType<typeof setTimeout> | undefined
  giveUpTimer: ReturnType<typeof setTimeout> | undefined
  /** Attempts made in this wait, for the backoff. */
  attempt: number
}

/** "14:05:09", in local time. */
export function clockSeconds(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const SPANS = defineMessages({
  en: {
    minutes: (n: number) => (n === 1 ? '1 minute' : `${String(n)} minutes`),
    seconds: (n: number) => (n === 1 ? '1 second' : `${String(n)} seconds`),
  },
  vi: {
    minutes: (n: number) => `${String(n)} phút`,
    seconds: (n: number) => `${String(n)} giây`,
  },
})

function span(ms: number, locale: Locale): string {
  const s = Math.round(ms / 1000)
  return s % 60 === 0 ? SPANS[locale].minutes(s / 60) : SPANS[locale].seconds(s)
}

/** "2 minutes", "30 seconds": a span as the page says it, in the language on screen. */
export function spanText(ms: number): string {
  return span(ms, currentLocale())
}

/**
 * The wait, in words: the page's announcements say it too. In English only, since a string read
 * once can't follow a language switch; words on screen say `spanText(RESUME_WINDOW_MS)`.
 */
export const RESUME_WINDOW_TEXT = span(RESUME_WINDOW_MS, 'en')

/** The page's own lines in a log, in the console's "— " voice and the language on screen. */
export const LOG_NOTES = localized({
  en: {
    dropped: (name: string, at: number) =>
      `— Lost the connection to ${name} at ${clockSeconds(at)}. While it’s still listed, the log picks up again by itself if it’s back within ${RESUME_WINDOW_TEXT}.`,
    resumed: (name: string, at: number) =>
      `— ${name} is back (${clockSeconds(at)}). The log resumed.`,
    gaveUp: (name: string) =>
      `— ${name} didn’t come back within ${RESUME_WINDOW_TEXT}, so the log stopped. Press Start once it’s connected again.`,
    unlisted: (name: string, at: number) =>
      `— ${name} left the device list at ${clockSeconds(at)}, so the log stopped. Press Start once it’s connected again.`,
  } as const,
  vi: {
    dropped: (name: string, at: number) =>
      `— Mất kết nối với ${name} lúc ${clockSeconds(at)}. Nếu thiết bị vẫn còn trong danh sách và kết nối lại trong vòng ${span(RESUME_WINDOW_MS, 'vi')}, log sẽ tự chạy tiếp.`,
    resumed: (name: string, at: number) =>
      `— ${name} đã kết nối lại (${clockSeconds(at)}). Log đã chạy tiếp.`,
    gaveUp: (name: string) =>
      `— ${name} không kết nối lại trong vòng ${span(RESUME_WINDOW_MS, 'vi')}, nên log đã dừng. Hãy bấm Bắt đầu khi thiết bị đã kết nối lại.`,
    unlisted: (name: string, at: number) =>
      `— ${name} đã rời danh sách thiết bị lúc ${clockSeconds(at)}, nên log đã dừng. Hãy bấm Bắt đầu khi thiết bị đã kết nối lại.`,
  },
})

/** The error's code, as the lanes reject: Error.message (HelperError's is the code it words). */
function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return error instanceof Error ? error.message : ''
}

/** Whether the listed device can stream a log right now. */
function canStream(device: Device | undefined, backend: Backend | undefined): boolean {
  return (
    device !== undefined &&
    device.state === 'ready' &&
    device.capabilities.logs === true &&
    backend?.logs !== undefined
  )
}

const asLogDevice = (d: LogDevice): LogDevice => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  connection: d.connection,
})

export function createLogSessions(deps: LogSessionDeps = {}): LogSessions {
  const now = deps.now ?? Date.now
  const sessions = new Map<string, Session>()
  const listeners = new Set<() => void>()
  /** The last list sync() saw, and how to reach each device. */
  let listed = new Map<string, Device>()
  let backendOf: (device: Device) => Backend | undefined = () => undefined
  let seq = 0

  const emit = (event: LogEvent) => {
    deps.onEvent?.(event)
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  function session(id: string): Session {
    let s = sessions.get(id)
    if (!s) {
      s = {
        view: EMPTY,
        controller: null,
        retryTimer: undefined,
        giveUpTimer: undefined,
        attempt: 0,
      }
      sessions.set(id, s)
    }
    return s
  }

  function patch(s: Session, next: Partial<LogView>) {
    s.view = { ...s.view, ...next }
    notify()
  }

  function append(s: Session, texts: readonly string[], note = false) {
    if (texts.length === 0) return
    const added = texts.map((text): LogLine => ({
      seq: ++seq,
      text,
      level: note ? '' : logLevel(text),
      ...(note ? { note: true as const } : {}),
    }))
    const lines = s.view.lines.concat(added)
    patch(s, { lines: lines.length > LOG_LIMIT ? lines.slice(lines.length - LOG_LIMIT) : lines })
  }

  function clearTimers(s: Session) {
    clearTimeout(s.retryTimer)
    clearTimeout(s.giveUpTimer)
    s.retryTimer = undefined
    s.giveUpTimer = undefined
  }

  /** Ends the stream in flight, if any; its late lines and its ending change nothing. */
  function abort(s: Session) {
    s.controller?.abort()
    s.controller = null
  }

  /** Opens the stream. `resuming`: the first lines say the device is back. */
  function open(s: Session, device: Device, backend: Backend, resuming: boolean) {
    const logs = backend.logs
    if (!logs) return
    abort(s)
    const controller = new AbortController()
    s.controller = controller
    let back = !resuming
    logs(
      device.id,
      (incoming) => {
        // Lines already in flight when Stop was pressed belong to a stream that is over.
        if (controller.signal.aborted) return
        if (!back) {
          back = true
          resumed(s)
        }
        append(s, incoming)
      },
      controller.signal,
    ).then(
      () => {
        ended(s, controller, null)
      },
      (error: unknown) => {
        ended(s, controller, error)
      },
    )
  }

  function resumed(s: Session) {
    const device = s.view.device
    clearTimers(s)
    s.attempt = 0
    patch(s, { phase: 'running', until: null })
    if (device) {
      append(s, [LOG_NOTES.resumed(device.name, now())], true)
      emit({ kind: 'resumed', device })
    }
  }

  /** How a stream ended, when nobody here asked it to. */
  function ended(s: Session, controller: AbortController, error: unknown) {
    if (controller.signal.aborted || s.controller !== controller) return
    s.controller = null
    const device = s.view.device
    if (!device) return
    const current = listed.get(device.id)
    if (!current) {
      unlisted(s)
      return
    }
    const gone = !canStream(current, backendOf(current))
    const dropped =
      gone ||
      (error !== null
        ? DROP_CODES.has(codeOf(error))
        : // A network link ends its log with a plain end of file when it drops (an iPhone over
          // Wi‑Fi does): only a cable's log that ends is a log that ended.
          device.connection === 'network')
    if (dropped) {
      if (s.view.phase === 'waiting') retryLater(s)
      else wait(s)
      return
    }
    clearTimers(s)
    patch(s, { phase: 'idle', until: null })
    if (error !== null) emit({ kind: 'failed', device, error })
  }

  /** The device dropped: say so, and wait for it. */
  function wait(s: Session) {
    const device = s.view.device
    if (!device) return
    abort(s)
    clearTimers(s)
    s.attempt = 0
    const at = now()
    patch(s, { phase: 'waiting', until: at + RESUME_WINDOW_MS })
    append(s, [LOG_NOTES.dropped(device.name, at)], true)
    emit({ kind: 'dropped', device })
    s.giveUpTimer = setTimeout(() => {
      giveUp(s)
    }, RESUME_WINDOW_MS)
    retryLater(s)
  }

  /** The row left the list: the helper (or the cable) gave up on the device, and so does the log. */
  function unlisted(s: Session) {
    const device = s.view.device
    abort(s)
    clearTimers(s)
    patch(s, { phase: 'idle', until: null })
    if (device) {
      append(s, [LOG_NOTES.unlisted(device.name, now())], true)
      emit({ kind: 'gave-up', device, reason: 'unlisted' })
    }
  }

  function giveUp(s: Session) {
    const device = s.view.device
    // Reopened and streaming, but the device had nothing to say yet: it is back after all.
    const current = device ? listed.get(device.id) : undefined
    if (s.controller && current && canStream(current, backendOf(current))) {
      resumed(s)
      return
    }
    abort(s)
    clearTimers(s)
    patch(s, { phase: 'idle', until: null })
    if (device) {
      append(s, [LOG_NOTES.gaveUp(device.name)], true)
      emit({ kind: 'gave-up', device, reason: 'window' })
    }
  }

  /** The next attempt while waiting, if the device is listed and ready by then. */
  function retryLater(s: Session) {
    clearTimeout(s.retryTimer)
    const until = s.view.until
    if (s.view.phase !== 'waiting' || until === null) return
    const step = RESUME_RETRY_MS[Math.min(s.attempt, RESUME_RETRY_MS.length - 1)] ?? 1_000
    s.attempt++
    // Clamped so one attempt always lands just before the window ends; none after it.
    const last = until - LAST_TRY_LEAD_MS - now()
    if (last <= 0) return
    const delay = Math.min(step, last)
    s.retryTimer = setTimeout(() => {
      s.retryTimer = undefined
      tryResume(s)
    }, delay)
  }

  /** Reopens a waiting log if its device can stream again; else sync() will. */
  function tryResume(s: Session) {
    const device = s.view.device
    if (s.view.phase !== 'waiting' || s.controller || !device) return
    const current = listed.get(device.id)
    const backend = current ? backendOf(current) : undefined
    if (!current || !backend || !canStream(current, backend)) return
    patch(s, { device: asLogDevice(current) })
    open(s, current, backend, true)
  }

  return {
    view: (deviceId) => sessions.get(deviceId)?.view ?? EMPTY,

    waitingId() {
      for (const [id, s] of sessions) if (s.view.phase === 'waiting') return id
      return null
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    start(device, backend) {
      const s = session(device.id)
      clearTimers(s)
      s.attempt = 0
      patch(s, { phase: 'running', until: null, device: asLogDevice(device) })
      open(s, device, backend, false)
    },

    stop(deviceId) {
      const s = sessions.get(deviceId)
      if (!s) return
      abort(s)
      clearTimers(s)
      if (s.view.phase !== 'idle') patch(s, { phase: 'idle', until: null })
    },

    clear(deviceId) {
      const s = sessions.get(deviceId)
      if (s && s.view.lines.length > 0) patch(s, { lines: [] })
    },

    sync(devices, lookup) {
      listed = new Map(devices.map((d) => [d.id, d]))
      backendOf = lookup
      for (const s of sessions.values()) {
        const device = s.view.device
        if (!device) continue
        const current = listed.get(device.id)
        const ready = canStream(current, current ? lookup(current) : undefined)
        if (s.view.phase !== 'idle' && !current) {
          // Gone from the list: nothing is held for it, so nothing comes back to resume.
          unlisted(s)
        } else if (s.view.phase === 'running' && !ready) {
          // Listed but no longer ready: its stream is over whatever it says next.
          wait(s)
        } else if (s.view.phase === 'waiting' && ready && !s.controller) {
          tryResume(s)
        } else if (current && current.name !== device.name && s.view.phase !== 'idle') {
          patch(s, { device: asLogDevice(current) })
        }
      }
    },

    keepOnly(deviceId) {
      let dropped = false
      for (const [id, s] of sessions) {
        if (id === deviceId) continue
        abort(s)
        clearTimers(s)
        sessions.delete(id)
        dropped = true
      }
      if (dropped) notify()
    },

    dispose() {
      for (const s of sessions.values()) {
        abort(s)
        clearTimers(s)
      }
      sessions.clear()
      notify()
    },
  }
}
