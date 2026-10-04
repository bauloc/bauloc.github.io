import type { BackendKind, Device, DeviceDetail, Platform } from '../model'
import type { AppDetail } from './android/pm'
import type { InstallFailure, InstallOutcome } from './android/pm-output'
import type { AppRow, AppScope } from './android/packages'
import type { Album, ImageRow } from './android/media'
import type { DeviceSpec } from './android/device-spec'
import type { AndroidErrorCode } from './android/shell'
import type { BadgeIcon } from './archive/apk-badge'
import type { InstallPlan, PhoneFacts } from './archive/plan'
import type { ZipErrorCode } from './archive/zip'

export type { AppDetail } from './android/pm'
export type { InstallErrorCode, InstallFailure, InstallOutcome } from './android/pm-output'
export type { AppRow, AppScope } from './android/packages'
export type { Album, ImageRow } from './android/media'
export type { DeviceSpec } from './android/device-spec'
export type { InstallPlan } from './archive/plan'

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

/* ---------------------------------------------------------------- *
 * The Android operations' types (PLAN §2)
 * ---------------------------------------------------------------- */

/** What the tester picked in the Install dialog. `-t` follows the plan (a test-only build). */
export interface InstallOptions {
  /** `-g`: grant every runtime permission (Android 6+). Off by default. */
  readonly grantPermissions?: boolean
  /** `-d`: put an older version over a debuggable installed one. */
  readonly allowDowngrade?: boolean
  /** "Install anyway" for an app that targets an old Android (Android 14+). */
  readonly bypassLowTargetSdkBlock?: boolean
}

/**
 * Where an install is. `sending`: bytes going over USB, and Cancel works. `installing`: the
 * phone verifies and installs, and nothing can stop it.
 */
export interface InstallProgress {
  readonly phase: 'sending' | 'installing'
  readonly sent: number
  readonly total: number
}

export type AppAction = 'launch' | 'stop' | 'clear' | 'uninstall' | 'info'

/** One page of an album. */
export interface ImageQuery {
  readonly album: Album
  readonly offset: number
  readonly limit: number
  /**
   * List the album's usual folders instead of asking MediaStore: the fallback once MediaStore
   * failed. Rows then have no id, file times only, and are paged in the browser.
   */
  readonly folders?: boolean
}

/**
 * How thumbnail() names an image: its MediaStore id, or for a row listed from a folder (no
 * id), its path. Also a stable React key.
 */
export const imageKey = (row: Pick<ImageRow, 'id' | 'path'>): string => row.id || row.path

/** The phone's side of the install checks, read when the Install dialog opens. */
export interface InstallFacts {
  /** The phone's API level; null when connect couldn't read it. */
  readonly sdk: number | null
  /** Free bytes on /data; null when df didn't say. */
  readonly freeBytes: number | null
  /** The installed copy of the app: null when not installed, undefined when unknown. */
  readonly installed:
    | { readonly versionCode: number; readonly versionName: string; readonly debuggable: boolean }
    | null
    | undefined
  /** `settings get global verifier_verify_adb_installs`; null when unset or unread. */
  readonly verifyAdbInstalls: string | null
}

/** InstallFacts as archive/plan's checkPhone takes them; null when the API level is unknown. */
export function phoneFactsOf(facts: InstallFacts): PhoneFacts | null {
  if (facts.sdk === null) return null
  return {
    sdk: facts.sdk,
    ...(facts.freeBytes === null ? {} : { freeBytes: facts.freeBytes }),
    ...(facts.installed === undefined ? {} : { installed: facts.installed }),
  }
}

/** An installed app's name and icon, read out of its APK. Null fields: show the fallback. */
export interface AppBadge {
  /** In the phone's language when the app has it. */
  readonly label: string | null
  /** Null for a vector icon, or one that couldn't be read: show the initial. */
  readonly icon: BadgeIcon | null
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

  /*
    Android operations, each gated by a capability and mirrored in mock.ts. Failures reject
    with an Error whose message is a code from DEVICE_ERRORS, or the phone's own words.
  */

  /**
   * One install session for the plan's parts: all or nothing. Resolves with the outcome
   * whenever the phone answered (refusals included, worded by INSTALL_ERRORS); rejects with the
   * signal's reason on abort, after abandoning the session.
   */
  readonly install?: (
    id: string,
    plan: InstallPlan,
    opts: InstallOptions,
    onProgress: (p: InstallProgress) => void,
    signal: AbortSignal,
  ) => Promise<InstallOutcome>
  /** The installed apps, unsorted (android/packages sortApps). */
  readonly apps?: (id: string, scope: AppScope) => Promise<AppRow[]>
  /** One app's details, for the App details sheet. */
  readonly app?: (id: string, pkg: string) => Promise<AppDetail>
  /** Clear and uninstall go behind a confirmation in the UI. */
  readonly appAction?: (id: string, pkg: string, action: AppAction) => Promise<void>
  /** One page of an album, newest first. */
  readonly images?: (id: string, q: ImageQuery) => Promise<ImageRow[]>
  /**
   * A preview of an image images() listed (`mediaId` is its imageKey), WITHOUT writing to the
   * phone: a thumbnail Android already made, else the original when it is small enough. The
   * caller shrinks it (createImageBitmap) and asks for visible tiles only. Rejects with
   * PREVIEW_UNAVAILABLE when there is none (HEIC, too large, unknown type).
   */
  readonly thumbnail?: (id: string, mediaId: string, signal: AbortSignal) => Promise<Blob>
  /**
   * A whole file from the phone's shared storage, or one of the APKs app() listed. `total` is 0
   * while unknown.
   */
  readonly pull?: (
    id: string,
    devicePath: string,
    onProgress: (sent: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<Blob>
  /** bundletool's device spec, for planning which split APKs this phone needs. Cached. */
  readonly deviceSpec?: (id: string) => Promise<DeviceSpec>
  /** Free space, the installed copy of `pkg` and the Play Protect setting, for the checks. */
  readonly installFacts?: (id: string, pkg: string | null) => Promise<InstallFacts>
  /**
   * An installed app's label and icon, read from its APK: ask for visible rows only. Cached by
   * package, version and update time; the lane limits how many read at once.
   */
  readonly appBadge?: (id: string, pkg: string, signal?: AbortSignal) => Promise<AppBadge>
}

/** Errors a backend throws on purpose, mapped to wording by the UI. */
export const DEVICE_ERRORS = {
  DEVICE_NOT_READY: 'The device is not ready yet.',
  SCREENSHOT_NOT_PNG:
    'The device returned something that is not a PNG. Try again, or reconnect the cable.',
  WEBUSB_UNSUPPORTED: 'This browser does not implement WebUSB.',

  // Installs (the store and the lanes).
  INSTALL_IN_PROGRESS: 'An install is already running on this phone. Wait for it, or cancel it.',
  NOTHING_TO_INSTALL: 'There’s nothing to install yet. Fix the problems listed first.',
  INSTALL_UNSUPPORTED: 'Installing needs Android 7.0 or newer.',
  INSTALL_SIZE_MISMATCH: 'A file changed size while it was being sent. Pick it again and retry.',
  FILE_CHANGED:
    'A file changed or moved after it was picked, so it couldn’t be sent. Pick it again, then install.',

  // Refused before anything reached the phone (android/shell.ts).
  INVALID_PACKAGE_NAME: 'That isn’t a valid Android package name.',
  INVALID_MEDIA_ID: 'That image isn’t in the phone’s media list any more. Refresh the list.',
  INVALID_SESSION_ID: 'Android answered with an install session Device Lab can’t use. Try again.',
  INVALID_COMPONENT: 'Android named a screen Device Lab can’t open. Open the app on the phone.',
  INVALID_DEVICE_PATH: 'Device Lab won’t read that path on the phone.',
  INVALID_ARGUMENT: 'Device Lab refused to send an unsafe value to the phone.',

  // Apps.
  APP_NOT_INSTALLED: 'That app isn’t installed on the phone any more. Refresh the list.',
  APP_NOT_LAUNCHABLE: 'This app has no screen to open.',
  CLEAR_FAILED: 'Android didn’t clear the app’s data. Try again, or use App info on the phone.',
  APK_NO_MANIFEST: 'This APK has no manifest, so its name and icon can’t be read.',

  // Files and images.
  FILE_TOO_LARGE: 'This file is too large to read into the browser.',
  FILE_READ_FAILED: 'The phone didn’t let Device Lab read that file.',
  NOT_A_MEDIA_FILE:
    'Device Lab only reads photos and videos from the phone’s shared storage, and the APKs of apps it lists.',
  PREVIEW_UNAVAILABLE: 'There’s no preview for this image. Open it to see it in full.',
  PREVIEW_NOT_IMAGE: 'The phone sent something that isn’t an image.',

  // Archives (archive/zip.ts), while planning or streaming an install.
  ZIP_NOT_A_ZIP: 'This file isn’t a zip archive, or its download was cut short.',
  ZIP_CORRUPT: 'This file is damaged. Download it again.',
  ZIP_MULTIDISK: 'Multi-part zip archives aren’t supported. Zip the files again as one archive.',
  ZIP_ENCRYPTED: 'This archive is password-protected, so Device Lab can’t open it.',
  ZIP_METHOD:
    'This archive uses a compression Device Lab can’t unpack. Zip it again with standard settings.',
  ZIP_SIZE_MISMATCH: 'A file inside the archive is damaged. Download it again.',
  ZIP_TOO_LARGE: 'A file inside the archive is too large to read.',
  ZIP_NO_INFLATE: 'This browser can’t unpack compressed archives. Update Chrome or Edge.',
} as const satisfies Readonly<Record<AndroidErrorCode | ZipErrorCode, string>> &
  Readonly<Record<string, string>>

export type DeviceErrorCode = keyof typeof DEVICE_ERRORS

export function deviceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message in DEVICE_ERRORS
      ? DEVICE_ERRORS[error.message as DeviceErrorCode]
      : error.message
  }
  return 'Unknown error'
}

/**
 * Whether sending failed because a picked file is no longer what was picked: Chrome refuses a
 * File changed on disk since the pick (a Gradle rebuild, say) with NotReadableError and a
 * deleted or moved one with NotFoundError, and the senders and the zip reader see one that
 * changed size. Sending the same File again fails the same way; picking it again works.
 */
export function isFileChangedError(error: unknown): boolean {
  if (!(error instanceof Error) && !(error instanceof DOMException)) return false
  if (error.name === 'NotReadableError' || error.name === 'NotFoundError') return true
  return error.message === 'INSTALL_SIZE_MISMATCH' || error.message === 'ZIP_SIZE_MISMATCH'
}

/** Marks a local failure whose way past is picking the files again, never Retry. */
const FILE_CHANGED_CAUSE = 'FILE_CHANGED'

/** The install outcome for a file that changed or moved after it was picked. */
export function fileChangedFailure(): InstallFailure {
  return {
    ok: false,
    code: 'UNKNOWN',
    androidCode: null,
    message: DEVICE_ERRORS.FILE_CHANGED,
    params: { cause: FILE_CHANGED_CAUSE },
    output: '',
  }
}

export const isFileChangedFailure = (failure: InstallFailure): boolean =>
  failure.params.cause === FILE_CHANGED_CAUSE

/**
 * A failure from the browser's side rather than Android's: no code or output from pm, only a
 * sentence of its own, which is said as it is rather than as "Android refused the install".
 */
export const isLocalFailure = (failure: InstallFailure): boolean =>
  failure.code === 'UNKNOWN' && !failure.androidCode && !failure.output && failure.message !== ''
