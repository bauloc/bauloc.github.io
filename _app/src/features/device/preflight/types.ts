import type { DeviceState } from '../model'

/*
  The preflight checklist, as data: what Device Lab checks before a phone can be used and
  before each feature runs, and what the tester can do about every answer (PLAN §3).

  Nothing in this folder renders or talks to a phone. env.ts and usb-diagnose.ts read the
  browser once into plain objects, checks.ts turns those into rows, copy.ts holds every word.
  Because the inputs are injected, every path — the missing prerequisites above all — runs
  in Vitest's node environment.
*/

/**
 * One answer. `unchecked` is honest ignorance — nothing to look at yet, or the helper that
 * would know does not exist — never a softer warning: the Gate shows it as a neutral step.
 */
export type CheckStatus = 'ok' | 'warning' | 'blocking' | 'unchecked'

/** The Environment check's sections: This browser · Phone: {name} · Helper · Features. */
export type CheckGroup = 'browser' | 'phone' | 'helper' | 'feature'

export type CheckId =
  | 'browser.secure'
  | 'browser.webusb'
  | 'app.current'
  | 'phone.usbDebugging'
  | 'phone.cable'
  | 'phone.permission'
  | 'phone.authorized'
  | 'phone.notHeld'
  | 'phone.osAccess'
  | 'helper.running'
  | 'helper.lna'
  | 'helper.paired'
  | 'helper.version'
  | 'helper.adbServer'
  | 'aab.java'
  | 'aab.bundletool'
  | 'aab.key'
  | 'aab.build'
  | 'aab.manual'
  | 'install.android'
  | 'install.oem'
  | 'install.verify'
  | 'install.unzip'
  | 'install.apkmEncrypted'
  | 'images.mediastore'
  | 'images.heic'

/**
 * A button the page wires up. `retry` reconnects the phone, as in DEVICE_HINTS; the rest are
 * the checklist's own.
 */
export type FixAction =
  | 'retry'
  | 'doctor'
  | 'add-device'
  | 'find-phone'
  | 'reload'
  | 'release-other-tab'
  | 'pair-helper'
  | 'check-helper'
  | 'get-bundletool'
  | 'create-key'
  | 'retry-images'
  | 'save-image'

/**
 * What the tester can do about a row: copy a command, open a link, follow a settings path on
 * the phone, or press a button. A superset of model.ts's Fix, so a device hint's fixes are
 * fixes here too.
 */
export type Fix =
  | { readonly label: string; readonly copy: string; readonly primary?: boolean }
  | { readonly label: string; readonly href: string; readonly primary?: boolean }
  | { readonly label: string; readonly path: string; readonly primary?: boolean }
  | { readonly label: string; readonly action: FixAction; readonly primary?: boolean }

export interface CheckItem {
  readonly id: CheckId
  readonly group: CheckGroup
  readonly label: string
  readonly status: CheckStatus
  /** What is true now and what to do about it, in plain words. */
  readonly sentence: string
  readonly fixes?: readonly Fix[]
  /** A quieter second line: background, or what to try when the fixes don't help. */
  readonly detail?: string
}

/* ---------------------------------------------------------------- *
 * Inputs
 * ---------------------------------------------------------------- */

export type Os = 'mac' | 'windows' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other'
export type BrowserName = 'chrome' | 'edge' | 'opera' | 'firefox' | 'safari' | 'other'

/**
 * Chrome's Local Network Access permission for reaching 127.0.0.1 (`loopback-network`, or
 * `local-network-access` in Chrome 142–144). `unsupported`: the browser knows neither name.
 */
export type LnaPermission = 'granted' | 'prompt' | 'denied' | 'unsupported'

/** The browser, as env.ts read it. */
export interface BrowserEnv {
  /** window.isSecureContext: https, or a page on localhost. */
  readonly secure: boolean
  /** Opened over https:, as opposed to a secure http://localhost. */
  readonly https: boolean
  /** The page's address without its fragment, which can carry the helper's pairing token. */
  readonly href: string
  /** `'usb' in navigator`; the API only exists in secure contexts. */
  readonly webusb: boolean
  /** Whether the embedding page's permissions policy allows USB; null when the browser can't say. */
  readonly usbPolicy: boolean | null
  /** `new DecompressionStream('deflate-raw')` works: .xapk and .apkm can be unpacked. */
  readonly inflate: boolean
  readonly lna: LnaPermission
  readonly os: Os
  readonly browser: BrowserName
  /** The build this tab runs (__APP_VERSION__). */
  readonly version: string
  /** A lazy chunk failed to load since the tab opened: a deploy replaced the build under it. */
  readonly appUpdated: boolean
}

/** How the last Add device picker ended. */
export type PickerOutcome = 'none' | 'dismissed' | 'picked'

/**
 * What a look at the raw USB devices found (usb-diagnose.ts). Add device only lists devices
 * with the ADB interface, so a phone with USB debugging off is invisible there; this is how it
 * is told apart from a phone that isn't on the bus at all.
 */
export type UsbFinding =
  /** Nothing looked at yet, or nothing worth saying. */
  | { readonly kind: 'unknown' }
  /** "Find my phone…" was closed without a pick. */
  | { readonly kind: 'not-listed' }
  /** A device with the ADB interface: USB debugging is on. */
  | { readonly kind: 'adb'; readonly name: string }
  /** An Android maker's device without the ADB interface. */
  | { readonly kind: 'debugging-off'; readonly name: string }
  /** An Android device that is in its bootloader (fastboot), not running Android. */
  | { readonly kind: 'bootloader'; readonly name: string }
  /** Anything else. `sure`: its maker makes no Android phones (Apple). */
  | { readonly kind: 'not-android'; readonly name: string; readonly sure: boolean }

/** A process holding a phone's USB interface, as the helper's doctor saw it (macOS ioreg). */
export interface UsbHolder {
  readonly serial?: string
  readonly pid: number
  /** The process name: `adb`, `Google Chrome`… */
  readonly process: string
}

/** The phone side of the checklist. */
export interface PhoneInput {
  /** The Android phone the rows are about (the selected one, else the first), or null for none. */
  readonly device: {
    readonly name: string
    readonly state: DeviceState
    readonly blockers: readonly string[]
  } | null
  readonly picker: PickerOutcome
  readonly usb: UsbFinding
  /** When the phone started waiting on "Allow USB debugging?" (ms since the epoch). */
  readonly authorizingSince: number | null
  readonly now: number
  readonly os: Os
  readonly browser: BrowserName
  /** Another Device Lab tab answered that it holds this phone. */
  readonly otherTab: boolean
  /** Who holds this phone's USB interface, when the helper knows. */
  readonly holder: UsbHolder | null
}

/** GET /api/health, as the helper design has it. */
export interface HelperHealth {
  readonly version: string
  readonly protocol: number
  /** The first 8 hex digits of SHA-256(token): never the token itself. */
  readonly tokenId: string
  readonly capabilities?: readonly string[]
  /** process.platform of the helper's computer: darwin, linux, win32. */
  readonly platform?: string
}

/** One look for the helper, made only on the tester's intent (PLAN §3.1). */
export interface HelperProbe {
  readonly lna: LnaPermission
  readonly browser: BrowserName
  /** /api/health's answer, or null when nothing answered. */
  readonly health: HelperHealth | null
  /** The tokenId of the pairing token this page holds; null when it holds none. */
  readonly tokenId: string | null
}

/** The Android part of GET /api/doctor (PLAN §4.3). */
export interface AndroidDoctor {
  readonly java:
    | { readonly found: false }
    | { readonly found: true; readonly version: string; readonly vendor?: string }
  readonly bundletool:
    { readonly found: false } | { readonly found: true; readonly version: string }
  readonly keystore: { readonly found: boolean }
  readonly adbServer:
    | { readonly running: false }
    | {
        readonly running: true
        /** `host:devices-l`: the phones the adb server holds. */
        readonly devices: readonly { readonly serial: string; readonly model?: string }[]
      }
  readonly usbHolders: readonly UsbHolder[]
}

/**
 * What a feature row is about: `install` covers .apk, .apks and several APKs; `viewer` is one
 * open image; `summary` is what the Environment check lists under Features.
 */
export type Feature = 'install' | 'xapk' | 'apkm' | 'aab' | 'images' | 'viewer' | 'summary'

/** What connect read off the phone, for the install rows. */
export interface InstallPhone {
  readonly name: string
  /** ro.build.version.sdk; null when it couldn't be read. */
  readonly sdk: number | null
  readonly release: string
  readonly brand: string
  readonly manufacturer: string
}

/** How the Images tab's first MediaStore query went. */
export type ImagesOutcome =
  | { readonly status: 'loading' }
  | { readonly status: 'listed' }
  /** MediaStore failed, so the tab fell back to reading folders. */
  | { readonly status: 'fallback' }
  | { readonly status: 'failed'; readonly stderr: string }

/** Everything a feature row may need; each feature reads only its own fields. */
export interface FeatureContext {
  readonly phone?: InstallPhone | null
  /** `settings get global verifier_verify_adb_installs`, trimmed; null when unread. */
  readonly verifyAdbInstalls?: string | null
  /** The last install on this phone failed with INSTALL_FAILED_USER_RESTRICTED. */
  readonly userRestricted?: boolean
  /** BrowserEnv.inflate. */
  readonly inflate?: boolean
  /** .apkm: the file doesn't start with `PK`. Undefined until the file is read. */
  readonly apkmEncrypted?: boolean
  /** .aab: the file's name, for the bundletool command. */
  readonly fileName?: string
  /** .aab: the helper, as helperChecks() takes it. Null or absent: no helper. */
  readonly probe?: HelperProbe | null
  readonly doctor?: AndroidDoctor | null
  readonly images?: ImagesOutcome
  /** Viewer: the open image's MIME type. */
  readonly mime?: string
  readonly browser?: BrowserName
}

/**
 * The blocker code for "the system refused to let the browser open the phone" (Linux udev
 * rules, a Windows driver). Today classifyUsbError reports that as `held`.
 */
export const USB_ACCESS_DENIED = 'USB_ACCESS_DENIED'
