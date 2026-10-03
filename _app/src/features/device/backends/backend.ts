import type { BackendKind, Device, DeviceDetail, Platform } from '../model'

/*
  ONE interface, several lanes: WebUSB (Android in the browser, nothing to install), the
  local helper (iOS, plus Android where WebUSB cannot run — not built yet), and the mock
  (?mock=1, fixture devices, for building and demoing every state without a phone).

  Backends never render. They keep a cache and tell subscribers it changed; the UI reads
  list() and decides what to draw. A new backend can surface a new blocker code without the
  UI shipping first: the backend owns codes, the UI owns wording.
*/

/** One line of a device log, as it arrived. */
export interface LogLine {
  /** Monotonic per device, for React keys and for "N new lines" counts. */
  readonly seq: number
  readonly text: string
}

/**
 * A lane. Its operations are plain functions, never methods that lean on `this`: the store
 * picks them off the object and calls them later.
 */
export interface Backend {
  readonly kind: BackendKind
  /** The lane's name in the UI. */
  readonly label: string
  readonly platforms: readonly Platform[]
  /** Whether it has a device picker (requestDevice). */
  readonly canRequest: boolean

  /** Cheap and synchronous: can this lane run in this browser at all? */
  readonly isAvailable: () => boolean
  /** Idle → watching. Safe to call again; later calls are no-ops. */
  readonly start: () => Promise<void>
  /** Stop watching and release everything it holds. */
  readonly stop: () => void
  /** Called whenever list() may have changed. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
  /** The lane's devices, from its cache. Synchronous. */
  readonly list: () => Device[]

  /** USER GESTURE ONLY: opens the browser's picker. Resolves to the new device's id, or null if dismissed. */
  readonly requestDevice?: () => Promise<string | null>
  readonly detail: (id: string) => Promise<DeviceDetail>
  /** A PNG of the device's screen. */
  readonly screenshot: (id: string) => Promise<Blob>
  /** Try to (re)connect one device — clears a sticky `held`. */
  readonly retry?: (id: string) => Promise<void>
  /** Reclaim every device stuck in `held`: what the list's Refresh button means. */
  readonly retryHeld?: () => Promise<void>
  /** Re-poll for devices. */
  readonly refresh?: () => Promise<void>
  /** Drop the browser's permission for a device. */
  readonly forget?: (id: string) => Promise<void>
  /**
   * Stream the device log until `signal` aborts or the device goes away. Resolves when the
   * stream ends; rejects if it could not start.
   */
  readonly logs?: (
    id: string,
    onLines: (lines: string[]) => void,
    signal: AbortSignal,
  ) => Promise<void>
}

/** Errors a backend throws on purpose, mapped to wording by the UI. */
export const DEVICE_ERRORS = {
  DEVICE_NOT_READY: 'The device is not ready yet.',
  SCREENSHOT_NOT_PNG:
    'The device returned something that is not a PNG. Try again, or reconnect the cable.',
  WEBUSB_UNSUPPORTED: 'This browser does not implement WebUSB.',
} as const

export type DeviceErrorCode = keyof typeof DEVICE_ERRORS

export function deviceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message in DEVICE_ERRORS
      ? DEVICE_ERRORS[error.message as DeviceErrorCode]
      : error.message
  }
  return 'Unknown error'
}
