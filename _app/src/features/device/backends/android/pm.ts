import type { Adb } from '@yume-chan/adb'
import type { CmdNoneProtocolService } from '@yume-chan/android-bin'

import { fileSizes } from './files'
import {
  APP_COMMANDS,
  CHECKIN_COMMAND,
  hasUnknownOption,
  launcherFrom,
  listPackagesCommand,
  mergeApps,
  parseCheckin,
  parseDfAvailable,
  parseDumpsysPackage,
  parsePmList,
  parsePmPath,
  type AppRow,
  type AppScope,
  type CheckinPackage,
  type PackageDump,
} from './packages'
import {
  classifyPmOutput,
  installFailure,
  isWriteSuccess,
  parseSessionId,
  pmFailure,
  type InstallFailure,
  type InstallOutcome,
} from './pm-output'
import {
  androidError,
  assertCmdToken,
  assertPackageName,
  assertSessionId,
  decodeText,
  failed,
  phoneMessage,
  readAll,
  run,
  shellCmd,
  type RunResult,
} from './shell'

/*
  What the WebUSB lane runs for the Apps tab and for installs: plain functions over a connected
  Adb, so they are tested against a scripted fake (pm.test.ts) and the backend stays thin.

  Two routes reach the package manager:
  - the shell, through shellCmd (every argument quoted, every name validated first), for the
    list, the details and the app actions;
  - android-bin's CmdNoneProtocolService, for install sessions only: `abb_exec:` on Android 10+,
    `cmd package` on 7–9. It streams the APK into pm's stdin with no shell in between. It is
    used as a transport and nothing more: its own install helpers demand the exact text
    "Success" and throw on "Completed with warning(s)", when the app is installed. Only tokens
    assertCmdToken accepts go down it. android-bin loads on the first install, not before.
*/

/** Installs need streamed install sessions (`cmd`), so Android 7.0. Older phones are refused. */
export const MIN_INSTALL_SDK = 24

/* ---------------------------------------------------------------- *
 * The app list and one app's details
 * ---------------------------------------------------------------- */

async function listScope(
  adb: Adb,
  sdk: number,
  scope: Exclude<AppScope, 'all'>,
  signal?: AbortSignal,
) {
  let result = await run(adb, listPackagesCommand(sdk, scope), signal)
  let rows = parsePmList(result.stdout)
  // An OEM or older pm refuses the whole listing over one flag it does not know: ask again
  // with the flags every pm has.
  if (rows.length === 0 && hasUnknownOption(result.stdout + result.stderr)) {
    result = await run(adb, listPackagesCommand(sdk, scope, true), signal)
    rows = parsePmList(result.stdout)
  }
  if (rows.length === 0 && (failed(result) || /^(Error|Exception)/m.test(result.stdout))) {
    throw new Error(phoneMessage(result))
  }
  return { rows, system: scope === 'system' }
}

/**
 * The Apps tab's rows, unsorted (sortApps). All runs `-3` and `-s` side by side, so each row
 * knows whether it is a system app. Times come from one `dumpsys package --checkin`; if that
 * fails the rows still come, without times.
 */
export async function listApps(
  adb: Adb,
  sdk: number,
  scope: AppScope,
  signal?: AbortSignal,
): Promise<AppRow[]> {
  const scopes: Exclude<AppScope, 'all'>[] = scope === 'all' ? ['user', 'system'] : [scope]
  const [checkin, ...lists] = await Promise.all([
    run(adb, CHECKIN_COMMAND, signal).then(
      (result) => parseCheckin(result.stdout),
      () => new Map<string, CheckinPackage>(),
    ),
    ...scopes.map((s) => listScope(adb, sdk, s, signal)),
  ])
  return mergeApps(lists, checkin)
}

/** `pm path <pkg>`: every APK of the app, base first. Empty when it is not installed. */
export async function apkPaths(adb: Adb, pkg: string): Promise<string[]> {
  return parsePmPath((await run(adb, APP_COMMANDS.path(pkg))).stdout)
}

export interface AppDetail extends PackageDump {
  /** Base first, then the splits, with their sizes (null where the phone did not say). */
  readonly apks: readonly { readonly path: string; readonly size: number | null }[]
}

/** The App details sheet. Rejects with `APP_NOT_INSTALLED` when the phone has no such app. */
export async function appDetail(adb: Adb, pkg: string): Promise<AppDetail> {
  const [dump, paths] = await Promise.all([run(adb, APP_COMMANDS.dump(pkg)), apkPaths(adb, pkg)])
  const parsed = parseDumpsysPackage(dump.stdout, pkg)
  if (!parsed) throw androidError('APP_NOT_INSTALLED')
  const sizes = paths.length > 0 ? await fileSizes(adb, paths) : []
  return { ...parsed, apks: paths.map((path, i) => ({ path, size: sizes[i] ?? null })) }
}

/** The installed copy's facts for the install checks (version, debuggable), or null. */
export async function installedPackage(adb: Adb, pkg: string): Promise<PackageDump | null> {
  return parseDumpsysPackage((await run(adb, APP_COMMANDS.dump(pkg))).stdout, pkg)
}

/* ---------------------------------------------------------------- *
 * App actions
 * ---------------------------------------------------------------- */

/** Fails with the phone's own words when `am` answers with an `Error` line. */
function checkAm(result: RunResult) {
  const error = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(Error|Exception|java\.)/.test(line))
  if (error) throw new Error(error)
}

/**
 * The activity a launcher would open, as `pkg/.Activity`; null when the app has none. Android
 * 7+ only (`cmd package`); undefined below that, where only monkey can find it.
 */
export async function resolveLauncher(
  adb: Adb,
  sdk: number,
  pkg: string,
): Promise<string | null | undefined> {
  assertPackageName(pkg)
  if (sdk < 24) return undefined
  const resolved = await run(adb, APP_COMMANDS.resolveLauncher(pkg))
  if (/No activity found/.test(resolved.stdout)) return null
  const component = launcherFrom(resolved.stdout, pkg)
  if (component) return component
  if (failed(resolved)) return undefined
  // Two launcher activities: resolve-activity named Android's chooser. Take the app's first.
  const all = await run(adb, APP_COMMANDS.queryLaunchers(pkg))
  return (
    launcherFrom(all.stdout, pkg) ?? (/No activities found/.test(all.stdout) ? null : undefined)
  )
}

/** Open: the launcher activity, as a launcher would start it. No auto-launch after installs. */
export async function launchApp(adb: Adb, sdk: number, pkg: string): Promise<void> {
  const component = await resolveLauncher(adb, sdk, pkg)
  if (component === null) throw androidError('APP_NOT_LAUNCHABLE')
  if (component !== undefined) {
    checkAm(await run(adb, APP_COMMANDS.start(component)))
    return
  }
  // Older Android, or a resolver that could not name the activity: monkey finds it itself.
  const monkey = await run(adb, APP_COMMANDS.monkey(pkg))
  const text = `${monkey.stdout}\n${monkey.stderr}`
  if (/Events injected: 1/.test(text)) return
  if (/No activities found/.test(text)) throw androidError('APP_NOT_LAUNCHABLE')
  const said = phoneMessage(monkey)
  throw said ? new Error(said) : androidError('APP_NOT_LAUNCHABLE')
}

/** Stop: `am force-stop`. Prints nothing when it works. */
export async function stopApp(adb: Adb, pkg: string): Promise<void> {
  const result = await run(adb, APP_COMMANDS.stop(pkg))
  checkAm(result)
  if (failed(result)) throw new Error(phoneMessage(result))
}

/** App info on the phone: Settings opens the app's page, on the phone's screen. */
export async function openAppInfo(adb: Adb, pkg: string): Promise<void> {
  checkAm(await run(adb, APP_COMMANDS.info(pkg)))
}

/** Clear data (behind a confirmation in the UI): `pm clear`, which answers Success or Failed. */
export async function clearAppData(adb: Adb, pkg: string): Promise<void> {
  const result = await run(adb, APP_COMMANDS.clear(pkg))
  if (/^Success\b/m.test(result.stdout)) return
  const message = phoneMessage(result)
  throw !message || message === 'Failed' ? androidError('CLEAR_FAILED') : new Error(message)
}

/**
 * Uninstall (behind a confirmation in the UI): `pm uninstall`, for every user on the phone, as
 * `adb uninstall` does. Rejects with Android's reason, e.g. `DELETE_FAILED_INTERNAL_ERROR`.
 */
export async function uninstallApp(adb: Adb, pkg: string): Promise<void> {
  const result = await run(adb, APP_COMMANDS.uninstall(pkg))
  const text = `${result.stdout}\n${result.stderr}`
  if (/^Success\b/m.test(text.trim())) return
  const failure = pmFailure(text)
  throw new Error(
    failure
      ? [failure.androidCode, failure.message].filter(Boolean).join(': ')
      : phoneMessage(result),
  )
}

/** Bytes free on /data, for the install's space check; null when df did not say. */
export async function dataFreeBytes(adb: Adb): Promise<number | null> {
  return parseDfAvailable((await run(adb, APP_COMMANDS.df)).stdout)
}

/** One global setting, read-only; null when unset. */
export async function readGlobalSetting(adb: Adb, key: string): Promise<string | null> {
  const value = (await run(adb, APP_COMMANDS.globalSetting(key))).stdout.trim()
  return value === '' || value === 'null' ? null : value
}

/* ---------------------------------------------------------------- *
 * Install sessions: create, write each part, commit (or abandon)
 * ---------------------------------------------------------------- */

export interface InstallSessionOptions {
  /** `-t`: allow test-only builds (`android:testOnly`), as Android Studio's Run produces. */
  readonly allowTest?: boolean
  /** `-d`: allow an older version over a newer one. Android only honours it for debuggable apps. */
  readonly allowDowngrade?: boolean
  /** `-g`: grant every runtime permission (Android 6+). */
  readonly grantPermissions?: boolean
  /** `--bypass-low-target-sdk-block` (Android 14+): the "Install anyway" for old targetSdk. */
  readonly bypassLowTargetSdkBlock?: boolean
  /** `-S`: the whole set's size, so Android can refuse for space before any byte is sent. */
  readonly totalBytes?: number
}

/** The install-create arguments for this phone. Flags it is too old to know are left out. */
export function installCreateArgs(sdk: number, options: InstallSessionOptions = {}): string[] {
  // `-r` (replace) is ignored on modern pm and required on old: always sent, as adb does.
  const args = ['package', 'install-create', '-r']
  if (options.allowTest) args.push('-t')
  if (options.allowDowngrade) args.push('-d')
  if (options.grantPermissions && sdk >= 23) args.push('-g')
  if (options.bypassLowTargetSdkBlock && sdk >= 34) args.push('--bypass-low-target-sdk-block')
  if (options.totalBytes !== undefined && options.totalBytes > 0) {
    args.push('-S', String(Math.trunc(options.totalBytes)))
  }
  return args
}

/** A step of an install that the phone refused; `outcome` carries its words. */
export class InstallStepError extends Error {
  override readonly name = 'InstallStepError'
  readonly step: 'create' | 'write'
  readonly outcome: InstallFailure

  constructor(step: 'create' | 'write', outcome: InstallFailure) {
    super(outcome.message || outcome.code)
    this.step = step
    this.outcome = outcome
  }
}

/** What the phone printed, as a failure even when it oddly said Success without the goods. */
function asFailure(output: string): InstallFailure {
  const outcome = classifyPmOutput(output)
  return outcome.ok ? installFailure('UNKNOWN', output.trim(), output) : outcome
}

async function packageService(adb: Adb, sdk: number): Promise<CmdNoneProtocolService> {
  if (sdk < MIN_INSTALL_SDK) throw androidError('INSTALL_UNSUPPORTED')
  const bin = await import('@yume-chan/android-bin')
  // The fallback (`pm` over exec:) is never reached: every phone from Android 7 has `cmd`.
  const service = new bin.CmdNoneProtocolService(adb, 'pm')
  if (!service.isSupported) throw androidError('INSTALL_UNSUPPORTED')
  return service
}

/** Runs pm with bare tokens over the Cmd route and returns everything it printed. */
async function pmTokens(adb: Adb, sdk: number, tokens: readonly string[]): Promise<string> {
  const service = await packageService(adb, sdk)
  const process = await service.spawn(tokens.map(assertCmdToken))
  return decodeText(await readAll(process.output))
}

/** install-create → the session id. Rejects with an InstallStepError carrying pm's words. */
export async function createInstallSession(
  adb: Adb,
  sdk: number,
  options: InstallSessionOptions = {},
): Promise<number> {
  const output = await pmTokens(adb, sdk, installCreateArgs(sdk, options))
  const id = parseSessionId(output)
  if (id === null) throw new InstallStepError('create', asFailure(output))
  return id
}

/** One APK of a set: its exact size and a way to open its bytes. */
export interface InstallPart {
  /** Exact: install-write -S makes pm read exactly this many bytes, no more, no fewer. */
  readonly size: number
  /** A File's stream(), a zip entry's, … Opened only when its turn comes. */
  readonly open: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export interface WriteOptions {
  readonly signal?: AbortSignal
  /** Called after each chunk is handed to USB, with that chunk's size. */
  readonly onBytes?: (bytes: number) => void
}

/**
 * install-write -S <size> <session> <index>.apk -: streams one part into pm's stdin, while
 * draining pm's output so neither side stalls. The names `0.apk`, `1.apk`… are only file names
 * inside the session (pm reads the real split name from each manifest), and safe on the
 * Android 7–9 route, which passes them through sh.
 *
 * Abort kills the process (closing the socket ends pm's stdin); the caller then abandons the
 * session. A part that yields more or fewer bytes than its size is refused rather than sent:
 * pm would otherwise wait forever for the missing bytes, or stop reading early.
 */
export async function writeInstallPart(
  adb: Adb,
  sdk: number,
  sessionId: number,
  index: number,
  part: InstallPart,
  options: WriteOptions = {},
): Promise<void> {
  const { signal, onBytes } = options
  if (!Number.isSafeInteger(part.size) || part.size <= 0)
    throw androidError('INSTALL_SIZE_MISMATCH')
  signal?.throwIfAborted()
  const service = await packageService(adb, sdk)
  const source = await part.open()
  const process = await service.spawn(
    [
      'package',
      'install-write',
      '-S',
      String(part.size),
      String(assertSessionId(sessionId)),
      `${String(index)}.apk`,
      '-',
    ].map(assertCmdToken),
  )
  const output = readAll(process.output).then(decodeText)
  // Read even if the write fails first, so its rejection is never unhandled.
  output.catch(() => undefined)
  const kill = () => {
    void Promise.resolve(process.kill()).catch(() => undefined)
  }
  signal?.addEventListener('abort', kill, { once: true })
  const reader = source.getReader()
  const writer = process.stdin.getWriter()
  let sent = 0
  let complete = false
  let said: string
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (sent + value.byteLength > part.size) throw androidError('INSTALL_SIZE_MISMATCH')
      await writer.write(value)
      sent += value.byteLength
      onBytes?.(value.byteLength)
    }
    if (sent !== part.size) throw androidError('INSTALL_SIZE_MISMATCH')
    complete = true
    // Still cancellable while pm takes in the last bytes and answers.
    said = await output
    signal?.throwIfAborted()
  } catch (error) {
    kill()
    signal?.throwIfAborted()
    // pm may have refused first and closed the socket under the write: its words beat the
    // transport's. A Success it printed does not hide a part that was too long.
    const text = await output.catch(() => '')
    if (text.trim() && !isWriteSuccess(text)) throw new InstallStepError('write', asFailure(text))
    throw error
  } finally {
    signal?.removeEventListener('abort', kill)
    writer.releaseLock()
    if (complete) reader.releaseLock()
    else void reader.cancel().catch(() => undefined)
  }
  if (!isWriteSuccess(said)) throw new InstallStepError('write', asFailure(said))
}

/**
 * install-commit: the phone verifies and installs. Android can't stop this once it starts, so
 * it takes no signal. Android 7.0/7.1 printed the commit's Success to the wrong stream over
 * `cmd`, so there it goes through `pm` (as android-bin 3.0 does).
 */
export async function commitInstallSession(
  adb: Adb,
  sdk: number,
  sessionId: number,
): Promise<InstallOutcome> {
  assertSessionId(sessionId)
  if (sdk <= 25) {
    const result = await run(adb, shellCmd`pm install-commit ${sessionId}`)
    return classifyPmOutput(`${result.stdout}\n${result.stderr}`)
  }
  return classifyPmOutput(
    await pmTokens(adb, sdk, ['package', 'install-commit', String(sessionId)]),
  )
}

/** install-abandon: drops the session and its bytes now, rather than in Android's 3 days. */
export async function abandonInstallSession(
  adb: Adb,
  sdk: number,
  sessionId: number,
): Promise<boolean> {
  assertSessionId(sessionId)
  return /^Success\b/m.test(
    await pmTokens(adb, sdk, ['package', 'install-abandon', String(sessionId)]),
  )
}

export interface RunInstallOptions extends InstallSessionOptions {
  readonly sdk: number
  readonly signal?: AbortSignal
  readonly onProgress?: (sent: number, total: number) => void
  /** `sending` while bytes go over USB (Cancel works), `installing` once committed (it doesn't). */
  readonly onPhase?: (phase: 'sending' | 'installing') => void
  /**
   * The session id once created, and null once it is closed (committed or abandoned). An id
   * never followed by null was left open, by a pulled cable say: keep it, and abandon it when
   * the phone is back.
   */
  readonly onSession?: (sessionId: number | null) => void
}

/**
 * One install, of one APK or a split set, as a single PackageInstaller session: all or nothing.
 *
 * Resolves with the outcome whenever the PHONE answered, success or refusal. Rejects with the
 * signal's reason on Cancel (the session abandoned: nothing installed), and with the transport's
 * error when the phone stopped answering, which is the caller's CONNECTION_LOST.
 */
export async function runInstall(
  adb: Adb,
  parts: readonly InstallPart[],
  options: RunInstallOptions,
): Promise<InstallOutcome> {
  const { sdk, signal, onProgress, onPhase, onSession } = options
  if (parts.length === 0) throw new TypeError('An install needs at least one APK.')
  signal?.throwIfAborted()
  const total = parts.reduce((sum, part) => sum + part.size, 0)

  let sessionId: number
  try {
    sessionId = await createInstallSession(adb, sdk, { ...options, totalBytes: total })
  } catch (error) {
    if (error instanceof InstallStepError) return error.outcome
    throw error
  }
  onSession?.(sessionId)
  const abandon = async () => {
    if (await abandonInstallSession(adb, sdk, sessionId).catch(() => false)) onSession?.(null)
  }

  onPhase?.('sending')
  onProgress?.(0, total)
  let sent = 0
  try {
    for (const [index, part] of parts.entries()) {
      await writeInstallPart(adb, sdk, sessionId, index, part, {
        signal,
        onBytes: (bytes) => {
          sent += bytes
          onProgress?.(sent, total)
        },
      })
    }
    signal?.throwIfAborted()
  } catch (error) {
    // Nothing is installed before the commit: abandoning loses nothing.
    await abandon()
    signal?.throwIfAborted()
    if (error instanceof InstallStepError) return error.outcome
    throw error
  }

  onPhase?.('installing')
  try {
    const outcome = await commitInstallSession(adb, sdk, sessionId)
    onSession?.(null)
    return outcome
  } catch (error) {
    // No answer to the commit: if the phone is still there, the session may still be open.
    await abandon()
    throw error
  }
}
