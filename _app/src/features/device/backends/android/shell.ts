import type { Adb } from '@yume-chan/adb'

/*
  The one way a command reaches the phone's shell.

  Both of Tango's command services hand the phone ONE string: `exec:` and `shell,v2,raw:` send
  `command.join(" ")`, and adbd runs it with `sh -c`. So an argument is only an argument if it
  is quoted: a package name, a path or a sort clause that is not quoted is shell code, and a
  file named `a;reboot` would reboot the phone. The rules are enforced here, not by review:

  - commands are built only by the shellCmd tag. Its literal text is sent as written, and every
    `${…}` is single-quoted by escapeArg, numbers included;
  - run() and runBytes() accept nothing else: not a string, not a look-alike object;
  - names and ids are validated before they get that far (assertPackageName and the rest), so a
    bad one fails with a clear error instead of reaching the phone quoted but meaningless.

  android-bin's Cmd service is the other route (`abb_exec` on Android 10+, `cmd` through sh on
  7–9). abb runs no shell, so quoted text would arrive with its quotes still in it: that route
  takes bare tokens, and only ones assertCmdToken accepts, which are safe either way.
*/

/**
 * Every code the android/ modules throw on purpose, for the UI to word (backend.ts
 * DEVICE_ERRORS). Anything else they throw carries the phone's own words.
 */
export type AndroidErrorCode =
  // A name, id or path refused before it reached the phone.
  | 'INVALID_PACKAGE_NAME'
  | 'INVALID_MEDIA_ID'
  | 'INVALID_SESSION_ID'
  | 'INVALID_COMPONENT'
  | 'INVALID_DEVICE_PATH'
  | 'INVALID_ARGUMENT'
  // Apps (pm.ts).
  | 'APP_NOT_INSTALLED'
  | 'APP_NOT_LAUNCHABLE'
  | 'CLEAR_FAILED'
  | 'INSTALL_UNSUPPORTED'
  | 'INSTALL_SIZE_MISMATCH'
  // Files and images (files.ts, media.ts).
  | 'FILE_TOO_LARGE'
  | 'FILE_READ_FAILED'
  | 'PREVIEW_UNAVAILABLE'
  | 'PREVIEW_NOT_IMAGE'

/** The Error for a code, the way backends report one: the code is the message. */
export const androidError = (code: AndroidErrorCode) => new Error(code)

/** A command line for the phone's `sh -c`. Only shellCmd makes one. */
export interface ShellCommand {
  readonly text: string
}

/** What a `${…}` in shellCmd may hold. A list becomes several arguments. */
export type ShellValue = string | number | ShellCommand | readonly (string | number)[]

/**
 * Single-quotes one argument for `sh`: `it's` → `'it'\''s'`. The same bytes Tango's escapeArg
 * produces (shell.test.ts holds the two together); a copy, so this module and the pure ones
 * built on it load nothing until a phone is connected.
 */
export function escapeArg(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

const made = new WeakSet<ShellCommand>()

function command(text: string): ShellCommand {
  const cmd: ShellCommand = Object.freeze({ text })
  made.add(cmd)
  return cmd
}

export function isShellCommand(value: unknown): value is ShellCommand {
  return typeof value === 'object' && value !== null && made.has(value as ShellCommand)
}

function quote(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('A shell argument must be a finite number.')
    return escapeArg(String(value))
  }
  // adbd reads the service as a C string: a NUL would cut the command short mid-quote.
  if (value.includes('\0')) throw new TypeError('A shell argument cannot contain a NUL byte.')
  return escapeArg(value)
}

function render(value: ShellValue): string {
  if (typeof value === 'string' || typeof value === 'number') return quote(value)
  // Another shellCmd result is already quoted, so it is spliced in as written: that is how a
  // command is assembled from optional parts without ever touching a raw string.
  if (isShellCommand(value)) return value.text
  if (Array.isArray(value)) return value.map((item: string | number) => quote(item)).join(' ')
  throw new TypeError('Only strings, numbers, lists of them and shellCmd results go in shellCmd.')
}

/**
 * The shell-command tag: shellCmd`pm path ${pkg}` → `pm path 'com.example.app'`. Literal text
 * is trusted (it is source code); every interpolation is quoted.
 */
export function shellCmd(
  strings: TemplateStringsArray,
  ...values: readonly ShellValue[]
): ShellCommand {
  let text = strings[0] ?? ''
  values.forEach((value, i) => {
    text += render(value) + (strings[i + 1] ?? '')
  })
  return command(text)
}

/* ---------------------------------------------------------------- *
 * Validation, before anything reaches the phone
 * ---------------------------------------------------------------- */

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

/** A package name as Android writes one. `android` is the framework: the one name with no dot. */
export function isPackageName(value: string): boolean {
  return value === 'android' || (value.length <= 255 && PACKAGE_NAME.test(value))
}

export function assertPackageName(value: string): string {
  if (!isPackageName(value)) throw androidError('INVALID_PACKAGE_NAME')
  return value
}

/** A MediaStore `_id`: digits only, at most a Java long. */
export function assertMediaId(value: string): string {
  if (!/^\d{1,19}$/.test(value)) throw androidError('INVALID_MEDIA_ID')
  return value
}

/** A PackageInstaller session id: a positive Java int. */
export function assertSessionId(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw androidError('INVALID_SESSION_ID')
  }
  return value
}

/**
 * A bare token for android-bin's Cmd route: flags, numbers and names like `0.apk`. Nothing in
 * this set means anything to `sh`, so it is safe on the abb route (no shell) and the cmd route
 * (Android 7–9, through sh) alike.
 */
export function assertCmdToken(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw androidError('INVALID_ARGUMENT')
  return value
}

/**
 * An absolute path on the phone, as pm or MediaStore printed it. It is still quoted wherever a
 * shell sees it; this only refuses what no real path holds (control characters, `..`).
 */
export function assertDevicePath(value: string): string {
  const ok =
    value.startsWith('/') &&
    value.length <= 4096 &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 0x20) &&
    !value.split('/').includes('..')
  if (!ok) throw androidError('INVALID_DEVICE_PATH')
  return value
}

/* ---------------------------------------------------------------- *
 * Running a command
 * ---------------------------------------------------------------- */

export interface RunResult {
  readonly stdout: string
  /** Empty when the phone has no shell protocol: adbd then mixes stderr into stdout. */
  readonly stderr: string
  /** null when the phone has no shell protocol (Android 6 and older): no exit code comes back. */
  readonly exitCode: number | null
}

export interface RunBytesResult extends Omit<RunResult, 'stdout'> {
  readonly stdout: Uint8Array<ArrayBuffer>
}

/** Tango's and the DOM's byte streams, as far as reading one to the end needs. */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
    releaseLock(): void
  }
}

/** Reads a stream to its end. Every process's output is drained, or its socket stalls. */
export async function readAll(stream: ByteStream): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

export const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

function commandText(cmd: ShellCommand): string {
  if (!isShellCommand(cmd)) throw new TypeError('Commands for the phone are built with shellCmd.')
  return cmd.text
}

/**
 * Runs one command and returns its output as bytes. Over the shell protocol when the phone has
 * it (Android 7+): stdout clean, stderr apart, an exit code. Otherwise over `exec:`, where
 * stderr arrives inside stdout and the exit code is lost.
 *
 * The command goes as a ONE-element list, so Tango joins nothing and re-splits nothing: the
 * phone gets exactly the text shellCmd built.
 */
export async function runBytes(
  adb: Adb,
  cmd: ShellCommand,
  signal?: AbortSignal,
): Promise<RunBytesResult> {
  const text = commandText(cmd)
  signal?.throwIfAborted()
  const shell = adb.subprocess.shellProtocol
  if (shell) {
    // With a signal, an abort rejects `exited` and closes the socket, so this rejects too.
    const process = await shell.spawn([text], signal)
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(process.stdout),
      readAll(process.stderr),
      process.exited,
    ])
    return { stdout, stderr: decodeText(stderr), exitCode }
  }
  const process = await adb.subprocess.noneProtocol.spawn([text], signal)
  const [stdout] = await Promise.all([readAll(process.output), process.exited])
  return { stdout, stderr: '', exitCode: null }
}

/** Runs one command and returns its output as text. See runBytes. */
export async function run(adb: Adb, cmd: ShellCommand, signal?: AbortSignal): Promise<RunResult> {
  const result = await runBytes(adb, cmd, signal)
  return { stdout: decodeText(result.stdout), stderr: result.stderr, exitCode: result.exitCode }
}

/** True when the phone reported a failure through the exit code (shell protocol only). */
export function failed(result: RunResult): boolean {
  return result.exitCode !== null && result.exitCode !== 0
}

/**
 * The phone's own words for what went wrong: the first non-empty line of stderr, else of stdout.
 * Failures are reported in these words rather than the transport's.
 */
export function phoneMessage(result: Pick<RunResult, 'stdout' | 'stderr'>): string {
  const first = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  return first(result.stderr) || first(result.stdout)
}
