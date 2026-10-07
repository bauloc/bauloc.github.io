import { setMaxListeners } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { LIMITS } from './constants'

/**
 * An error the helper raises on purpose. `code` is what the page maps to wording, `status`
 * the HTTP status, and `extra` lands next to them in the error body (tool, install, state,
 * blockers). Lanes throw these; anything else that reaches the HTTP layer is a bug (500).
 */
export class HelperError extends Error {
  readonly code: string
  readonly status: number
  readonly extra: Readonly<Record<string, unknown>>
  constructor(code: string, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HelperError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

/** The error an aborted wait rejects with, recognisable by isAbortError(). */
export function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * At most `n` tasks at once; the rest wait in order. One-shot tools go through one of these
 * (4), so a page hammering Refresh cannot fork forty devicectl processes.
 */
export function createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    if (active >= n) return
    const run = queue.shift()
    if (!run) return
    active++
    run()
  }
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
}

/**
 * One task at a time per key; later callers wait their turn. For work that must not overlap
 * on one device, such as two lockdown sessions racing each other.
 */
export function keyedMutex(): {
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T>
  busy: (key: string) => boolean
} {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(fn)
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
    busy: (key) => tails.has(key),
  }
}

/**
 * Concurrent callers for one key share the task in flight instead of starting another:
 * "probe and detail are single-flight per device" (§1.3).
 */
export function singleFlight(): {
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T>
  has: (key: string) => boolean
} {
  const inflight = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const current = inflight.get(key)
      if (current) return current as Promise<T>
      const task = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (inflight.get(key) === task) inflight.delete(key)
        })
      inflight.set(key, task)
      return task
    },
    has: (key) => inflight.has(key),
  }
}

/** Rejects with `onTimeout()` when `promise` has not settled within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Resolves after `ms`; rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolves (never rejects) once `signal` aborts: for racing work against a deadline. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export interface LinkedSignal {
  readonly signal: AbortSignal
  readonly abort: () => void
  /** Detach from the parents; call it when the work is done, or the parents keep a reference. */
  readonly dispose: () => void
}

/**
 * One AbortSignal that aborts when any parent does, after `timeoutMs`, or on abort().
 * AbortSignal.any() would do this, but it arrived in Node 20 and this file runs on 18.
 *
 * Neither it nor its parents cap their abort listeners, as no AbortSignal does on Node 24:
 * a parent holds one per signal linked to it (every request and adb exchange links to the
 * bridge's shutdown signal), and a linked signal one per process, socket or wait of its work
 * (a dns-sd run: two per process). Node 18 and 20 cap them at 10 and print a
 * MaxListenersExceededWarning, in the tester's terminal, past it.
 */
export function linkSignals(
  parents: ReadonlyArray<AbortSignal | undefined>,
  timeoutMs?: number,
): LinkedSignal {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const live = parents.filter((parent): parent is AbortSignal => parent !== undefined)
  setMaxListeners(0, controller.signal, ...live)
  let timer: NodeJS.Timeout | undefined
  const dispose = (): void => {
    for (const parent of live) parent.removeEventListener('abort', abort)
    if (timer) clearTimeout(timer)
  }
  for (const parent of live) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', abort, { once: true })
  }
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(abort, timeoutMs)
    timer.unref()
  }
  controller.signal.addEventListener('abort', dispose, { once: true })
  return { signal: controller.signal, abort, dispose }
}

/**
 * ANSI escape sequences (CSI, OSC, and two-character escapes), then every control character
 * but tab, including the C1 range a decoded byte stream can contain. Log lines and device
 * names come from devices and tools: they reach a terminal and a page, and must not be
 * able to move a cursor, ring a bell or hide text in either.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g

/** Strip escape sequences and control characters (tab survives), then cap at `max`. */
export function clean(text: string, max: number): string {
  const out = text.replace(ANSI, '').replace(CONTROL, '')
  return out.length > max ? out.slice(0, max) : out
}

export interface LineSplitter {
  readonly write: (chunk: Buffer | string) => void
  /** Flush a last line without a newline. */
  readonly end: () => void
}

/**
 * Bytes in, clean lines out, one callback per chunk. UTF-8 safe across chunk boundaries
 * (StringDecoder), CR stripped, escapes and control characters removed. A line longer than
 * `maxLine` is cut there with ` [truncated]` and the rest of it is dropped up to the next
 * newline, so one runaway line cannot become many.
 */
export function splitLines(
  onLines: (lines: string[]) => void,
  maxLine: number = LIMITS.line,
): LineSplitter {
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let skipping = false
  /** CR goes with the other control characters; the cap is judged on what is left. */
  const emit = (raw: string, out: string[], cut: boolean): void => {
    const text = clean(raw, Number.MAX_SAFE_INTEGER)
    out.push(text.length > maxLine || cut ? text.slice(0, maxLine) + ' [truncated]' : text)
  }
  const take = (text: string, out: string[]): void => {
    let start = 0
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      const piece = text.slice(start, nl)
      start = nl + 1
      if (skipping) skipping = false
      else emit(carry + piece, out, false)
      carry = ''
    }
    if (skipping) return
    carry += text.slice(start)
    /** Raw length bounds memory; four times the cap leaves room for escapes clean() drops. */
    if (carry.length > maxLine * 4) {
      emit(carry, out, true)
      carry = ''
      skipping = true
    }
  }
  return {
    write(chunk) {
      const out: string[] = []
      take(typeof chunk === 'string' ? chunk : decoder.write(chunk), out)
      if (out.length) onLines(out)
    },
    end() {
      const out: string[] = []
      take(decoder.end(), out)
      if (carry && !skipping) emit(carry, out, false)
      carry = ''
      skipping = false
      if (out.length) onLines(out)
    },
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** The IEND chunk every complete PNG ends with: zero length, the type, and its CRC. */
const PNG_END = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

/**
 * The PNG inside a tool's output, or null when there is none: the same rule as the page's
 * extractPng() in backends/android.ts. Text can come first (screencap warns about phones
 * with two displays) and after; an image cut short by a pulled cable has no IEND chunk and
 * is refused rather than served as a broken file.
 */
export function extractPng(bytes: Buffer): Buffer | null {
  const start = bytes.indexOf(PNG_SIGNATURE)
  if (start < 0) return null
  const end = bytes.lastIndexOf(PNG_END)
  if (end <= start) return null
  return bytes.subarray(start, end + PNG_END.length)
}

export function b64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** `08:41:02`, local time: the prefix of every terminal line. */
export function timeOfDay(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8)
}

/** `1.4` for 1 400 ms: how the terminal reports durations. */
export function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** `456.7 MB` for 478 884 659 bytes: how the terminal reports sizes, 1024-based as XConsole does. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${String(n)} ${n === 1 ? one : many}`
}
