import type { BadgeIcon } from '@/features/device/backends/archive/apk-badge'

/*
  The Builds module's shared shapes: what data/build/db.json holds for each build, and what
  reading an .apk or .ipa in the browser finds out about it (inspect/). The install page, the iOS
  manifest and the console all work from a BuildEntry, so it carries everything they show.
*/

export type BuildPlatform = 'android' | 'ios'

/** How an IPA is signed, from its embedded provisioning profile. */
export type ProfileKind = 'development' | 'ad-hoc' | 'enterprise' | 'app-store' | 'unknown'

export type AppleDevice = 'iphone' | 'ipad'

export interface ProfileInfo {
  readonly kind: ProfileKind
  /** The profile's own name, as Xcode or the developer portal shows it. */
  readonly name: string
  /** TeamName: who an Enterprise build asks the tester to trust in Settings. */
  readonly team: string
  /** ExpirationDate as ISO 8601: after it the app no longer opens. '' when unknown. */
  readonly expires: string
  /** How many devices may install it (ProvisionedDevices); null when any device may. */
  readonly device_count: number | null
}

export interface AndroidFacts {
  readonly target_sdk: number
  readonly debuggable: boolean
  /** Native code's ABIs (`lib/<abi>/`); empty for a pure-JVM app. */
  readonly abis: readonly string[]
}

export interface IosFacts {
  readonly devices: readonly AppleDevice[]
  readonly profile: ProfileInfo | null
}

/**
 * Where a binary of 100 MiB or more lives: an asset of a GitHub Release, since the repo takes no
 * file that large. The install page, its icon and the iOS manifest stay in build/<id>/ all the
 * same; only the binary's address changes (paths.ts's binaryUrl).
 */
export interface ReleaseInfo {
  /** The release's id: what deleting the build deletes. */
  readonly id: number
  /** `build-<id>-<yyyyMMddHHmmss>` (RELEASE_TAG_PATTERN): the download address names it. */
  readonly tag: string
  /** The binary's asset in that release. */
  readonly asset_id: number
}

/** One build, as data/build/db.json keeps it. Keys in this order in the file. */
export interface BuildEntry {
  readonly id: string
  readonly platform: BuildPlatform
  /** The name the install page shows; editable, read from the app first. */
  readonly name: string
  /** Package name (Android) or CFBundleIdentifier (iOS). */
  readonly bundle_id: string
  /** versionName / CFBundleShortVersionString. */
  readonly version: string
  /** versionCode / CFBundleVersion, as text. */
  readonly build: string
  /** The binary's file name under build/<id>/. */
  readonly file: string
  readonly size: number
  /** SHA-256 of the binary, lowercase hex. */
  readonly sha256: string
  /** 'icon.png' when the app's icon could be drawn, '' otherwise. */
  readonly icon: string
  /** Android: the minimum API level ('24'); iOS: MinimumOSVersion ('15.0'); '' when unknown. */
  readonly min_os: string
  /** Release notes as typed; '' for none. */
  readonly notes: string
  readonly android: AndroidFacts | null
  readonly ios: IosFacts | null
  /** The GitHub Release that holds the binary; null when it is in build/<id>/ (most builds). */
  readonly release: ReleaseInfo | null
  /**
   * When this binary went up: what the install page calls "Uploaded". A new version under the
   * same link moves it; an edit of the name or notes does not (that moves `updated_at`).
   */
  readonly uploaded_at: string
  /** When the link was first published; a new version under it keeps this. */
  readonly created_at: string
  readonly updated_at: string
}

export interface BuildDb {
  readonly version: number
  readonly updated_at?: string
  readonly entries: readonly BuildEntry[]
}

/** Why a file cannot be offered from a link (a problem), or what a tester should know (a warning). */
export type InspectCode =
  /** Neither an .apk nor an .ipa, by name and by content. */
  | 'NOT_A_BUILD'
  /** 2 GiB or more: GitHub refuses the file, even as a release's. */
  | 'TOO_LARGE'
  /** 100 MiB or more (and under 2 GiB): too large for the repo, so it goes to a GitHub Release. */
  | 'VIA_RELEASE'
  /** 50 MiB or more, in the repo: it works, but stays in the repo's history for good. */
  | 'LARGE'
  /** This browser cannot inflate a zip (no DecompressionStream). */
  | 'NO_INFLATE'
  | 'APK_INVALID'
  /** A split APK, or a base that needs its splits: Android installs neither on its own. */
  | 'APK_SPLIT'
  /** android:testOnly — the package installer refuses it (Android Studio's Run output). */
  | 'APK_TEST_ONLY'
  /** No v1 or v2+ signature: the installer refuses it (AGP's app-release-unsigned.apk). */
  | 'APK_UNSIGNED'
  /** Signed with v1 (JAR) only while targeting API 30+: Android 11 and later refuse it. */
  | 'APK_V1_ONLY'
  | 'APK_DEBUGGABLE'
  | 'IPA_INVALID'
  /** No embedded.mobileprovision: unsigned, or a simulator build. */
  | 'IPA_NO_PROFILE'
  /** Signed for the App Store / TestFlight: no device installs it from a link. */
  | 'IPA_APP_STORE'
  | 'IPA_EXPIRED'
  /** Development-signed: iOS 16+ needs Developer Mode on. */
  | 'IPA_DEVELOPMENT'
  | 'IPA_EXPIRES_SOON'

export interface InspectProblem {
  readonly code: InspectCode
  /** A value the wording may use: a date, a split's name. */
  readonly detail?: string
}

/** What the app's icon was found as, before icon.ts draws it into icon.png. */
export type IconSource =
  | {
      readonly kind: 'image'
      readonly mime: 'image/png' | 'image/webp' | 'image/jpeg'
      readonly bytes: Uint8Array<ArrayBuffer>
    }
  /** Decoded pixels, straight (not premultiplied) RGBA: what an Apple "CgBI" PNG becomes. */
  | {
      readonly kind: 'rgba'
      readonly width: number
      readonly height: number
      readonly rgba: Uint8ClampedArray<ArrayBuffer>
    }
  /** Device Lab's reading of an APK's launcher icon: a bitmap, or an adaptive icon's layers. */
  | { readonly kind: 'badge'; readonly icon: BadgeIcon }

export interface BuildInspection {
  readonly platform: BuildPlatform
  readonly name: string
  readonly bundleId: string
  readonly version: string
  readonly build: string
  readonly minOs: string
  readonly android: AndroidFacts | null
  readonly ios: IosFacts | null
  readonly icon: IconSource | null
  /** Blocking: publishing is refused while any is present. */
  readonly problems: readonly InspectProblem[]
  readonly warnings: readonly InspectProblem[]
}
