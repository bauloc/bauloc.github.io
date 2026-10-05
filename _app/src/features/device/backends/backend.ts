import { localized } from '@/lib/i18n'

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
  local helper (agent.ts: iPhones, simulators, and Android through Google's adb server where
  WebUSB cannot claim the phone), and the mock (?mock=1, fixture devices, for building and
  demoing every state without a phone).

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

/** The English wording; its keys are the codes. */
const DEVICE_ERRORS_EN = {
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

  // The local helper (agent.ts, spec §7.5). The page raises the HELPER_* codes itself
  // (helper/client.ts); the rest are the helper's own error codes, as it sends them.
  HELPER_UNREACHABLE:
    'The local helper stopped answering. Start it again; this page reconnects by itself.',
  HELPER_UNAUTHORIZED:
    'The helper restarted. Open the new link it printed to pair this page again.',
  HELPER_STREAM_STALLED: 'The helper stopped sending the log. Start it again.',
  HELPER_BAD_REPLY:
    'The helper answered something this page can’t read. Reload the page, or update the helper.',
  HELPER_FOREIGN:
    'Something else answers on the helper’s port. Start the helper on another port with --port.',
  HELPER_STOPPING: 'The local helper is stopping. Start it again; this page reconnects by itself.',
  UNAUTHORIZED: 'The helper restarted. Open the new link it printed to pair this page again.',
  DEVICE_NOT_FOUND: 'The device is no longer connected.',
  DEVICE_GONE: 'The device is no longer connected.',
  BUSY: 'A screenshot of this device is already being taken.',
  TOO_MANY_STREAMS: 'Too many logs are open. Stop one, then start this one.',
  STREAM_REPLACED: 'This log was opened again in another tab or window, so it stopped here.',
  TOOL_MISSING: 'A required tool is missing. Open the environment check for the install command.',
  TOOL_TIMEOUT: 'The device took too long to answer. Try again.',
  TOOL_FAILED: 'The helper’s tool failed. Try again, or reconnect the cable.',
  IOS_UNTRUSTED: 'Tap Trust on the iPhone first.',
  IOS_LOCKED: 'Unlock the device, then try again.',
  IOS_DEVELOPER_MODE_OFF: 'Developer Mode is off on this device.',
  IOS_DDI_REQUIRED: 'Mount the developer disk image first — see the note above.',
  // Raised by lockdown (detail, logs) as well as devicectl, and often over a Wi‑Fi link that
  // comes and goes: the row can stay ready, so this is a "try again", not a broken device.
  IOS_UNREACHABLE:
    'The device isn’t reachable right now. Unlock it, keep it on the cable (or the same Wi‑Fi), and try again.',
  IOS_LOCKDOWN_FAILED: 'The device isn’t answering.',
  XCODE_REQUIRED: 'Screenshots on iOS 17 and newer need Xcode on this Mac.',
  XCODE_SETUP_REQUIRED: 'Xcode needs to finish setting up. Open it once.',
  SCREENSHOT_UNSUPPORTED: 'This device cannot take screenshots.',
  ANDROID_UNAUTHORIZED: 'Allow USB debugging on the phone first.',
  ANDROID_OFFLINE: 'The phone is not answering adb. Reseat the cable.',
  ANDROID_OFF:
    'This helper was started with --no-android, so it leaves Android alone. Start it without that option.',
  ADB_SERVER_STOPPED: 'Google’s adb server stopped.',
  ADB_START_FAILED: 'The adb server did not start. Open the environment check.',
  LOGS_UNAVAILABLE: 'No log source works for this device.',
  // Android over Wi‑Fi (§4.7). The Wi‑Fi dialog words each failure by its reason; these are
  // for anywhere else (a toast, a log).
  DEVICE_DROPPED:
    'The device stopped answering. Over Wi‑Fi, check it is still on the same network.',
  ANDROID_CONNECT_FAILED:
    'Couldn’t connect over Wi‑Fi. Check the address, and that network debugging is on.',
  ANDROID_PAIR_FAILED: 'Couldn’t pair. Check the code and the pairing port; both change each time.',
  NETWORK_UNSUPPORTED:
    'This helper can’t connect to Wi‑Fi devices. Download it again; the command replaces it.',
  DISCOVER_UNSUPPORTED:
    'This helper can’t look for devices on the network. Download it again; the command replaces it.',
  HELPER_TIMEOUT: 'The helper took too long to answer. Try again.',
  // The helper's router: a page newer than the helper, or a bug. Updating the helper is the fix.
  BAD_ID: 'The helper can’t use this device’s id. Refresh the list.',
  BAD_REQUEST: 'The helper refused the request. Reload the page, or update the helper.',
  NOT_FOUND: 'This helper doesn’t know that request. Update the helper.',
  METHOD_NOT_ALLOWED: 'This helper doesn’t know that request. Update the helper.',
  PAYLOAD_TOO_LARGE: 'The request was too large for the helper.',
  INTERNAL:
    'Something went wrong inside the helper. Try again; its Terminal window has the details.',
} as const satisfies Readonly<Record<AndroidErrorCode | ZipErrorCode, string>> &
  Readonly<Record<string, string>>

export type DeviceErrorCode = keyof typeof DEVICE_ERRORS_EN

/** Errors a backend throws on purpose, mapped to wording by the UI, in the language on screen. */
export const DEVICE_ERRORS = localized<Readonly<Record<DeviceErrorCode, string>>>({
  en: DEVICE_ERRORS_EN,
  vi: {
    DEVICE_NOT_READY: 'Thiết bị chưa sẵn sàng.',
    SCREENSHOT_NOT_PNG: 'Thiết bị trả về dữ liệu không phải PNG. Hãy thử lại, hoặc cắm lại cáp.',
    WEBUSB_UNSUPPORTED: 'Trình duyệt này không hỗ trợ WebUSB.',

    INSTALL_IN_PROGRESS:
      'Điện thoại này đang có một lượt cài đặt khác. Hãy chờ xong, hoặc hủy lượt đó.',
    NOTHING_TO_INSTALL: 'Chưa có gì để cài. Hãy xử lý trước các vấn đề đã liệt kê.',
    INSTALL_UNSUPPORTED: 'Cần Android 7.0 trở lên để cài đặt.',
    INSTALL_SIZE_MISMATCH:
      'Một tệp đã thay đổi kích thước trong lúc gửi. Hãy chọn lại tệp rồi thử lại.',
    FILE_CHANGED:
      'Một tệp đã thay đổi hoặc bị di chuyển sau khi chọn, nên không gửi được. Hãy chọn lại tệp, rồi cài.',

    INVALID_PACKAGE_NAME: 'Đó không phải tên gói Android hợp lệ.',
    INVALID_MEDIA_ID:
      'Ảnh đó không còn trong danh sách ảnh và video của điện thoại. Hãy làm mới danh sách.',
    INVALID_SESSION_ID:
      'Android trả về một phiên cài đặt mà Device Lab không dùng được. Hãy thử lại.',
    INVALID_COMPONENT:
      'Android chỉ ra một màn hình mà Device Lab không mở được. Hãy mở ứng dụng trên điện thoại.',
    INVALID_DEVICE_PATH: 'Device Lab không đọc đường dẫn đó trên điện thoại.',
    INVALID_ARGUMENT: 'Device Lab đã từ chối gửi một giá trị không an toàn tới điện thoại.',

    APP_NOT_INSTALLED: 'Ứng dụng đó không còn được cài trên điện thoại. Hãy làm mới danh sách.',
    APP_NOT_LAUNCHABLE: 'Ứng dụng này không có màn hình nào để mở.',
    CLEAR_FAILED:
      'Android không xóa được dữ liệu của ứng dụng. Hãy thử lại, hoặc dùng Thông tin ứng dụng trên điện thoại.',
    APK_NO_MANIFEST: 'APK này không có manifest nên không đọc được tên và biểu tượng.',

    FILE_TOO_LARGE: 'Tệp này quá lớn để đọc vào trình duyệt.',
    FILE_READ_FAILED: 'Điện thoại không cho Device Lab đọc tệp đó.',
    NOT_A_MEDIA_FILE:
      'Device Lab chỉ đọc ảnh và video trong bộ nhớ dùng chung của điện thoại, và APK của các ứng dụng mà Device Lab liệt kê.',
    PREVIEW_UNAVAILABLE: 'Ảnh này không có bản xem trước. Hãy mở để xem đầy đủ.',
    PREVIEW_NOT_IMAGE: 'Điện thoại gửi về dữ liệu không phải ảnh.',

    ZIP_NOT_A_ZIP: 'Tệp này không phải tệp zip, hoặc chưa được tải xuống hết.',
    ZIP_CORRUPT: 'Tệp này bị hỏng. Hãy tải xuống lại.',
    ZIP_MULTIDISK: 'Không hỗ trợ tệp zip chia nhiều phần. Hãy nén lại các tệp thành một tệp zip.',
    ZIP_ENCRYPTED: 'Tệp nén này có mật khẩu nên Device Lab không mở được.',
    ZIP_METHOD:
      'Tệp nén này dùng kiểu nén mà Device Lab không giải nén được. Hãy nén lại với thiết lập chuẩn.',
    ZIP_SIZE_MISMATCH: 'Một tệp bên trong tệp nén bị hỏng. Hãy tải xuống lại.',
    ZIP_TOO_LARGE: 'Một tệp bên trong tệp nén quá lớn để đọc.',
    ZIP_NO_INFLATE: 'Trình duyệt này không giải nén được tệp nén. Hãy cập nhật Chrome hoặc Edge.',

    HELPER_UNREACHABLE:
      'Helper cục bộ không còn phản hồi. Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
    HELPER_UNAUTHORIZED:
      'Helper đã khởi động lại. Hãy mở liên kết mới mà helper đã in ra để ghép nối lại trang này.',
    HELPER_STREAM_STALLED: 'Helper đã ngừng gửi log. Hãy bắt đầu lại log.',
    HELPER_BAD_REPLY:
      'Helper trả về nội dung mà trang này không đọc được. Hãy tải lại trang, hoặc cập nhật helper.',
    HELPER_FOREIGN:
      'Một chương trình khác đang phản hồi trên cổng của helper. Hãy chạy helper trên cổng khác bằng --port.',
    HELPER_STOPPING: 'Helper cục bộ đang dừng. Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
    UNAUTHORIZED:
      'Helper đã khởi động lại. Hãy mở liên kết mới mà helper đã in ra để ghép nối lại trang này.',
    DEVICE_NOT_FOUND: 'Thiết bị không còn kết nối.',
    DEVICE_GONE: 'Thiết bị không còn kết nối.',
    BUSY: 'Đang chụp màn hình thiết bị này rồi.',
    TOO_MANY_STREAMS: 'Đang mở quá nhiều log. Hãy dừng một log, rồi bắt đầu log này.',
    STREAM_REPLACED: 'Log này đã được mở lại ở thẻ hoặc cửa sổ khác, nên đã dừng ở đây.',
    TOOL_MISSING: 'Thiếu một công cụ cần thiết. Hãy mở Kiểm tra môi trường để xem lệnh cài đặt.',
    TOOL_TIMEOUT: 'Thiết bị phản hồi quá lâu. Hãy thử lại.',
    TOOL_FAILED: 'Công cụ của helper bị lỗi. Hãy thử lại, hoặc cắm lại cáp.',
    IOS_UNTRUSTED: 'Hãy chạm Tin cậy trên iPhone trước.',
    IOS_LOCKED: 'Hãy mở khóa thiết bị, rồi thử lại.',
    IOS_DEVELOPER_MODE_OFF: 'Chế độ nhà phát triển đang tắt trên thiết bị này.',
    IOS_DDI_REQUIRED: 'Hãy gắn developer disk image trước — xem ghi chú ở trên.',
    IOS_UNREACHABLE:
      'Hiện không kết nối được tới thiết bị. Hãy mở khóa, giữ thiết bị cắm cáp (hoặc ở cùng mạng Wi‑Fi), rồi thử lại.',
    IOS_LOCKDOWN_FAILED: 'Thiết bị không phản hồi.',
    XCODE_REQUIRED: 'Chụp màn hình trên iOS 17 trở lên cần Xcode trên máy Mac này.',
    XCODE_SETUP_REQUIRED: 'Xcode cần hoàn tất cài đặt. Hãy mở Xcode một lần.',
    SCREENSHOT_UNSUPPORTED: 'Thiết bị này không chụp màn hình được.',
    ANDROID_UNAUTHORIZED: 'Hãy cho phép gỡ lỗi qua USB trên điện thoại trước.',
    ANDROID_OFFLINE: 'Điện thoại không phản hồi adb. Hãy cắm lại cáp cho chắc.',
    ANDROID_OFF:
      'Helper này được chạy với --no-android nên không đụng tới Android. Hãy chạy lại mà không có tùy chọn đó.',
    ADB_SERVER_STOPPED: 'adb server của Google đã dừng.',
    ADB_START_FAILED: 'adb server không khởi động được. Hãy mở Kiểm tra môi trường.',
    LOGS_UNAVAILABLE: 'Không có nguồn log nào dùng được cho thiết bị này.',
    DEVICE_DROPPED:
      'Thiết bị không còn phản hồi. Nếu dùng Wi‑Fi, hãy kiểm tra xem thiết bị có còn ở cùng mạng không.',
    ANDROID_CONNECT_FAILED:
      'Không kết nối được qua Wi‑Fi. Hãy kiểm tra địa chỉ, và xem gỡ lỗi qua mạng đã bật chưa.',
    ANDROID_PAIR_FAILED:
      'Không ghép nối được. Hãy kiểm tra mã và cổng ghép nối; cả hai đều đổi sau mỗi lần.',
    NETWORK_UNSUPPORTED:
      'Helper này không hỗ trợ kết nối với thiết bị Wi‑Fi. Hãy tải lại tệp helper; lệnh tải sẽ thay bản cũ.',
    DISCOVER_UNSUPPORTED:
      'Helper này không hỗ trợ tìm thiết bị trên mạng. Hãy tải lại tệp helper; lệnh tải sẽ thay bản cũ.',
    HELPER_TIMEOUT: 'Helper phản hồi quá lâu. Hãy thử lại.',
    BAD_ID: 'Helper không dùng được ID của thiết bị này. Hãy làm mới danh sách.',
    BAD_REQUEST: 'Helper đã từ chối yêu cầu. Hãy tải lại trang, hoặc cập nhật helper.',
    NOT_FOUND: 'Helper này không hiểu yêu cầu đó. Hãy cập nhật helper.',
    METHOD_NOT_ALLOWED: 'Helper này không hiểu yêu cầu đó. Hãy cập nhật helper.',
    PAYLOAD_TOO_LARGE: 'Yêu cầu quá lớn đối với helper.',
    INTERNAL: 'Helper gặp lỗi nội bộ. Hãy thử lại; chi tiết có trong cửa sổ Terminal của helper.',
  },
})

const UNKNOWN_ERROR = localized({
  en: { text: 'Unknown error' },
  vi: { text: 'Lỗi không xác định' },
})

export function deviceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message in DEVICE_ERRORS
      ? DEVICE_ERRORS[error.message as DeviceErrorCode]
      : error.message
  }
  return UNKNOWN_ERROR.text
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

/**
 * The install outcome for a file that changed or moved after it was picked. Its message is read
 * from DEVICE_ERRORS at each access: a job keeps the outcome on screen across a language switch.
 */
export function fileChangedFailure(): InstallFailure {
  return {
    ok: false,
    code: 'UNKNOWN',
    androidCode: null,
    get message() {
      return DEVICE_ERRORS.FILE_CHANGED
    },
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
