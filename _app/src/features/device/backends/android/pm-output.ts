/*
  What `pm` printed, as something the UI can word. Pure: tested on the strings AOSP prints
  (PackageManagerShellCommand), since nothing here has run against a phone yet.

  An install ends one of three ways, and the third is a trap:
  - `Success`;
  - `Failure [INSTALL_FAILED_X: message]`. The code maps to a wording key below, and the UI's
    INSTALL_ERRORS table owns the words, exactly like DEVICE_HINTS;
  - `Warning: …` lines, then `Completed with warning(s)`. pm exits with an error and never says
    Success, but the app IS installed. android-bin 2.1.0 throws on exactly this.
*/

/** The wording keys, one per row of the plan's error table. */
export const INSTALL_ERROR_CODES = [
  'UPDATE_INCOMPATIBLE',
  'VERSION_DOWNGRADE',
  'MISSING_SPLIT',
  'NO_MATCHING_ABIS',
  'OLDER_SDK',
  'DEPRECATED_SDK_VERSION',
  'NO_CERTIFICATES',
  'INVALID_APK',
  'NOT_APK',
  'DUPLICATE_PERMISSION',
  'CONFLICTING_PROVIDER',
  'INSUFFICIENT_STORAGE',
  'USER_RESTRICTED',
  'ABORTED',
  'VERIFICATION_FAILURE',
  /** Never printed by pm: the store reports it when the phone goes away mid-install. */
  'CONNECTION_LOST',
  'UNKNOWN',
] as const

export type InstallErrorCode = (typeof INSTALL_ERROR_CODES)[number]

/**
 * Android's codes → wording keys. Several parse failures share NOT_APK: whatever the parser
 * tripped on, the file is not an installable APK. Anything missing here is UNKNOWN, with
 * Android's own code and text kept for the Details section.
 */
export const ANDROID_INSTALL_CODES: Readonly<Record<string, InstallErrorCode>> = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'UPDATE_INCOMPATIBLE',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'VERSION_DOWNGRADE',
  INSTALL_FAILED_MISSING_SPLIT: 'MISSING_SPLIT',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'NO_MATCHING_ABIS',
  INSTALL_FAILED_OLDER_SDK: 'OLDER_SDK',
  INSTALL_FAILED_DEPRECATED_SDK_VERSION: 'DEPRECATED_SDK_VERSION',
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'NO_CERTIFICATES',
  INSTALL_FAILED_INVALID_APK: 'INVALID_APK',
  // Splits signed with different keys: "These APKs don't belong together".
  INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: 'INVALID_APK',
  INSTALL_PARSE_FAILED_NOT_APK: 'NOT_APK',
  INSTALL_PARSE_FAILED_BAD_MANIFEST: 'NOT_APK',
  INSTALL_PARSE_FAILED_MANIFEST_MALFORMED: 'NOT_APK',
  INSTALL_PARSE_FAILED_MANIFEST_EMPTY: 'NOT_APK',
  INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION: 'NOT_APK',
  INSTALL_FAILED_DUPLICATE_PERMISSION: 'DUPLICATE_PERMISSION',
  INSTALL_FAILED_DUPLICATE_PERMISSION_GROUP: 'DUPLICATE_PERMISSION',
  INSTALL_FAILED_CONFLICTING_PROVIDER: 'CONFLICTING_PROVIDER',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'INSUFFICIENT_STORAGE',
  INSTALL_FAILED_USER_RESTRICTED: 'USER_RESTRICTED',
  INSTALL_FAILED_ABORTED: 'ABORTED',
  INSTALL_FAILED_VERIFICATION_FAILURE: 'VERIFICATION_FAILURE',
  INSTALL_FAILED_VERIFICATION_TIMEOUT: 'VERIFICATION_FAILURE',
}

export interface InstallSuccess {
  readonly ok: true
  /**
   * The `Warning:` lines, when pm printed "Completed with warning(s)". Empty for a plain
   * Success. Either way the app is installed.
   */
  readonly warnings: readonly string[]
  /** Everything the phone printed, for the copyable Details section. */
  readonly output: string
}

export interface InstallFailure {
  readonly ok: false
  readonly code: InstallErrorCode
  /** Android's own code, such as INSTALL_FAILED_VERSION_DOWNGRADE, when it printed one. */
  readonly androidCode: string | null
  /** Android's message after the code, or the most telling line it printed. */
  readonly message: string
  /**
   * Values the wording can fill in, when the message carried them:
   * VERSION_DOWNGRADE `installedVersionCode`, `fileVersionCode` · OLDER_SDK `requiredSdk`,
   * `deviceSdk` · DEPRECATED_SDK_VERSION `targetSdk`, `minimumSdk` · DUPLICATE_PERMISSION
   * `other`, `permission` · CONFLICTING_PROVIDER `other`, `provider`.
   */
  readonly params: Readonly<Record<string, string>>
  readonly output: string
}

export type InstallOutcome = InstallSuccess | InstallFailure

export function installFailure(
  code: InstallErrorCode,
  message = '',
  output = '',
  androidCode: string | null = null,
  params: Readonly<Record<string, string>> = {},
): InstallFailure {
  return { ok: false, code, androidCode, message, params, output }
}

/** Pulls the wording's values out of Android's message (formats from AOSP main). */
function paramsFor(code: InstallErrorCode, message: string): Record<string, string> {
  const pick = (re: RegExp, ...names: string[]) => {
    const m = re.exec(message)
    if (!m) return {}
    return Object.fromEntries(names.map((name, i) => [name, m[i + 1] ?? '']))
  }
  switch (code) {
    case 'VERSION_DOWNGRADE':
      // "Downgrade detected: Update version code 1 is older than current 2"
      return pick(
        /version code (\d+) is older than current (\d+)/i,
        'fileVersionCode',
        'installedVersionCode',
      )
    case 'OLDER_SDK':
      // "Requires newer sdk version #34 (current version is #30)"
      return pick(
        /sdk version #?(\d+)\s*\(current version is #?(\d+)\)/i,
        'requiredSdk',
        'deviceSdk',
      )
    case 'DEPRECATED_SDK_VERSION':
      // "App package must target at least SDK version 24, but found 22"
      return pick(/at least SDK version (\d+), but found (\d+)/i, 'minimumSdk', 'targetSdk')
    case 'DUPLICATE_PERMISSION':
      // "Package com.b attempting to redeclare permission com.x.P already owned by com.a"
      return pick(/permission (\S+) already owned by ([\w.]+)/, 'permission', 'other')
    case 'CONFLICTING_PROVIDER':
      // "Can't install because provider name com.x.files (in package com.b) is already used by com.a"
      return pick(/provider name (\S+) .*already used by ([\w.]+)/, 'provider', 'other')
    default:
      return {}
  }
}

/**
 * The `Failure [...]` part of pm's output: Android's code and its message, or null when there
 * is no Failure line. The message runs to the LAST `]`, because messages carry brackets
 * ("splits=[base, …]") and the occasional newline.
 */
export function pmFailure(output: string): { androidCode: string | null; message: string } | null {
  const start = output.indexOf('Failure [')
  if (start < 0) return null
  let inner = output.slice(start + 'Failure ['.length)
  const end = inner.lastIndexOf(']')
  if (end >= 0) inner = inner.slice(0, end)
  inner = inner.trim()
  const m = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(inner)
  if (m?.[1] === undefined) return { androidCode: null, message: inner }
  return { androidCode: m[1], message: (m[2] ?? '').trim() }
}

/** The line that says most about an error that did not come as `Failure [...]`. */
function tellingLine(lines: readonly string[]): string {
  // "Exception occurred while executing 'install-commit':" is followed by the exception itself.
  const exception = lines.find((line) => /^[\w.$]+(Exception|Error)\b.*:/.test(line))
  return exception ?? lines.find((line) => line.startsWith('Error')) ?? lines[0] ?? ''
}

/** Turns what install-create, install-write or install-commit printed into an outcome. */
export function classifyPmOutput(output: string): InstallOutcome {
  const text = output.replace(/\r/g, '').trim()
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const failure = pmFailure(text)
  if (failure) {
    const code =
      (failure.androidCode !== null ? ANDROID_INSTALL_CODES[failure.androidCode] : undefined) ??
      'UNKNOWN'
    return installFailure(
      code,
      failure.message,
      text,
      failure.androidCode,
      paramsFor(code, failure.message),
    )
  }

  // AOSP: "Don't start the output string with 'Success' because that will make adb treat this
  // as a success." The app is installed all the same.
  if (lines.includes('Completed with warning(s)')) {
    const warnings = lines.flatMap((line) => {
      const m = /^Warning:\s*(.*)$/.exec(line)
      return m?.[1] ? [m[1]] : []
    })
    return { ok: true, warnings, output: text }
  }

  // A "Warning [Could not validate the dex paths: …]" line can come before a plain Success.
  if (lines.some((line) => /^Success\b/.test(line))) return { ok: true, warnings: [], output: text }

  const message = tellingLine(lines)
  // install-write: "Error: failed to write; … No space left on device".
  const code = /no space left|ENOSPC/i.test(text) ? 'INSUFFICIENT_STORAGE' : 'UNKNOWN'
  return installFailure(code, message, text)
}

/** `Success: created install session [1234567]` → 1234567; null for anything else. */
export function parseSessionId(output: string): number | null {
  const m = /^Success\b[^\n]*?\[(\d+)\]/m.exec(output)
  if (m?.[1] === undefined) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff ? id : null
}

/** install-write's `Success: streamed N bytes`. */
export function isWriteSuccess(output: string): boolean {
  return /^Success\b/m.test(output) && pmFailure(output) === null
}
