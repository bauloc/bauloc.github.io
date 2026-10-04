import { describe, expect, it } from 'vitest'

import { PM_OUTPUT } from './fixtures'
import {
  ANDROID_INSTALL_CODES,
  INSTALL_ERROR_CODES,
  classifyPmOutput,
  isWriteSuccess,
  parseSessionId,
  pmFailure,
  type InstallErrorCode,
} from './pm-output'

describe('classifyPmOutput', () => {
  it('reads Success as installed', () => {
    expect(classifyPmOutput(PM_OUTPUT.success)).toEqual({
      ok: true,
      warnings: [],
      output: 'Success',
    })
  })

  it('reads Success after the dex-path warning as installed, with no warnings to show', () => {
    expect(classifyPmOutput(PM_OUTPUT.dexWarningThenSuccess)).toMatchObject({
      ok: true,
      warnings: [],
    })
  })

  it('reads "Completed with warning(s)" as INSTALLED, with the warnings listed', () => {
    expect(classifyPmOutput(PM_OUTPUT.warnings)).toEqual({
      ok: true,
      warnings: [
        'Package com.example.notes uses a deprecated API.',
        'Package com.example.notes was installed for user 0 only.',
      ],
      output: PM_OUTPUT.warnings.trim(),
    })
  })

  it.each<[keyof typeof PM_OUTPUT, InstallErrorCode, string]>([
    ['updateIncompatible', 'UPDATE_INCOMPATIBLE', 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'],
    ['downgrade', 'VERSION_DOWNGRADE', 'INSTALL_FAILED_VERSION_DOWNGRADE'],
    ['missingSplit', 'MISSING_SPLIT', 'INSTALL_FAILED_MISSING_SPLIT'],
    ['noMatchingAbis', 'NO_MATCHING_ABIS', 'INSTALL_FAILED_NO_MATCHING_ABIS'],
    ['olderSdk', 'OLDER_SDK', 'INSTALL_FAILED_OLDER_SDK'],
    ['deprecatedSdk', 'DEPRECATED_SDK_VERSION', 'INSTALL_FAILED_DEPRECATED_SDK_VERSION'],
    ['noCertificates', 'NO_CERTIFICATES', 'INSTALL_PARSE_FAILED_NO_CERTIFICATES'],
    ['invalidApk', 'INVALID_APK', 'INSTALL_FAILED_INVALID_APK'],
    ['inconsistentCertificates', 'INVALID_APK', 'INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES'],
    ['notApk', 'NOT_APK', 'INSTALL_PARSE_FAILED_NOT_APK'],
    ['duplicatePermission', 'DUPLICATE_PERMISSION', 'INSTALL_FAILED_DUPLICATE_PERMISSION'],
    ['conflictingProvider', 'CONFLICTING_PROVIDER', 'INSTALL_FAILED_CONFLICTING_PROVIDER'],
    ['insufficientStorage', 'INSUFFICIENT_STORAGE', 'INSTALL_FAILED_INSUFFICIENT_STORAGE'],
    ['userRestricted', 'USER_RESTRICTED', 'INSTALL_FAILED_USER_RESTRICTED'],
    ['aborted', 'ABORTED', 'INSTALL_FAILED_ABORTED'],
    ['verificationFailure', 'VERIFICATION_FAILURE', 'INSTALL_FAILED_VERIFICATION_FAILURE'],
    ['verificationTimeout', 'VERIFICATION_FAILURE', 'INSTALL_FAILED_VERIFICATION_TIMEOUT'],
    ['testOnly', 'UNKNOWN', 'INSTALL_FAILED_TEST_ONLY'],
  ])('maps %s to the %s wording, keeping %s', (fixture, code, androidCode) => {
    const outcome = classifyPmOutput(PM_OUTPUT[fixture])
    expect(outcome).toMatchObject({
      ok: false,
      code,
      androidCode,
      output: PM_OUTPUT[fixture].trim(),
    })
  })

  it('keeps the message after the code, brackets and all', () => {
    expect(classifyPmOutput(PM_OUTPUT.bracketsInMessage)).toMatchObject({
      code: 'INVALID_APK',
      message: 'Full install must include a base package: splits=[config.en]',
    })
    expect(classifyPmOutput(PM_OUTPUT.insufficientStorage)).toMatchObject({ message: '' })
  })

  it('pulls out the values the wording fills in', () => {
    const params = (key: keyof typeof PM_OUTPUT) => {
      const outcome = classifyPmOutput(PM_OUTPUT[key])
      return outcome.ok ? null : outcome.params
    }
    expect(params('downgrade')).toEqual({ fileVersionCode: '7', installedVersionCode: '9' })
    expect(params('olderSdk')).toEqual({ requiredSdk: '38', deviceSdk: '37' })
    expect(params('deprecatedSdk')).toEqual({ minimumSdk: '24', targetSdk: '22' })
    expect(params('duplicatePermission')).toEqual({
      permission: 'com.example.notes.permission.C2D_MESSAGE',
      other: 'com.example.notes',
    })
    expect(params('conflictingProvider')).toEqual({
      provider: 'com.example.notes.files',
      other: 'com.example.notes',
    })
    expect(params('missingSplit')).toEqual({})
  })

  it("reads install-write's out-of-space error as INSUFFICIENT_STORAGE", () => {
    expect(classifyPmOutput(PM_OUTPUT.writeFailed)).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_STORAGE',
      androidCode: null,
      message: 'Error: failed to write; write failed: ENOSPC (No space left on device)',
    })
  })

  it('reads a shell exception as UNKNOWN, with the exception as its message', () => {
    expect(classifyPmOutput(PM_OUTPUT.exception)).toMatchObject({
      ok: false,
      code: 'UNKNOWN',
      message: 'java.lang.IllegalArgumentException: Unknown option --bypass-low-target-sdk-block',
    })
  })

  it('reads silence, and anything unrecognised, as UNKNOWN', () => {
    expect(classifyPmOutput('')).toMatchObject({ ok: false, code: 'UNKNOWN', message: '' })
    expect(classifyPmOutput('Failure [INSTALL_FAILED_SOMETHING_NEW: later Android]')).toMatchObject(
      {
        code: 'UNKNOWN',
        androidCode: 'INSTALL_FAILED_SOMETHING_NEW',
        message: 'later Android',
      },
    )
    expect(classifyPmOutput("cmd: Can't find service: package")).toMatchObject({
      code: 'UNKNOWN',
      message: "cmd: Can't find service: package",
    })
  })

  it('maps every Android code to a wording key the UI has', () => {
    for (const key of Object.values(ANDROID_INSTALL_CODES)) {
      expect(INSTALL_ERROR_CODES).toContain(key)
    }
  })
})

describe('pmFailure', () => {
  it('reads an uninstall refusal without a code too', () => {
    expect(pmFailure(PM_OUTPUT.notInstalled)).toEqual({
      androidCode: null,
      message: 'not installed for 0',
    })
    expect(pmFailure(PM_OUTPUT.deleteFailed)).toEqual({
      androidCode: 'DELETE_FAILED_INTERNAL_ERROR',
      message: '',
    })
    expect(pmFailure('Success')).toBeNull()
  })
})

describe('parseSessionId', () => {
  it('reads the id install-create prints', () => {
    expect(parseSessionId(PM_OUTPUT.created)).toBe(1234567)
  })

  it('refuses everything else', () => {
    expect(parseSessionId(PM_OUTPUT.exception)).toBeNull()
    expect(parseSessionId('Failure [INSTALL_FAILED_INTERNAL_ERROR: [12]]')).toBeNull()
    expect(parseSessionId('Success: created install session [99999999999]')).toBeNull()
    expect(parseSessionId('')).toBeNull()
  })
})

describe('isWriteSuccess', () => {
  it("accepts install-write's report and nothing else", () => {
    expect(isWriteSuccess(PM_OUTPUT.streamed)).toBe(true)
    expect(isWriteSuccess(PM_OUTPUT.writeFailed)).toBe(false)
    expect(isWriteSuccess('')).toBe(false)
  })
})
