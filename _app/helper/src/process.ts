import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LIMITS, TIMEOUTS } from './constants'
import { sleep, splitLines } from './util'

/**
 * Every child still holding a pipe, across the process. The synchronous `exit` hook
 * SIGKILLs whatever is left in here, so no tool outlives the helper however it ends.
 */
export const liveChildren = new Set<ChildProcess>()

/**
 * Variables that would silently point a device tool at another device or tunnel than the
 * one the page asked for. A tester's shell may have them set from earlier work.
 */
const REDIRECTING_ENV = [
  'PYMOBILEDEVICE3_UDID',
  'PYMOBILEDEVICE3_TUNNEL',
  'PYMOBILEDEVICE3_USBMUX',
  'ANDROID_SERIAL',
] as const

/** The environment every tool runs with: `base` minus REDIRECTING_ENV, plus NO_COLOR and `extra`. */
export function childEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of REDIRECTING_ENV) delete env[name]
  return { ...env, NO_COLOR: '1', ...extra }
}

/**
 * Signal the child's whole process group. Tools run detached, so each leads its own group:
 * a grandchild (simctl's log, a Python tool's helper) dies with it, and the terminal's
 * Ctrl+C, which only reaches the foreground group, never reaches them; the helper must.
 */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already gone.
  }
}

export type ToolFailure =
  'not-found' | 'spawn-failed' | 'timeout' | 'aborted' | 'too-large' | 'exit'

/** Why a tool run failed, with what it printed. The HTTP layer maps `reason` to a code. */
export class ToolError extends Error {
  readonly reason: ToolFailure
  readonly file: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string | Buffer
  readonly stderr: string
  constructor(
    reason: ToolFailure,
    file: string,
    detail: {
      code?: number | null
      signal?: NodeJS.Signals | null
      stdout?: string | Buffer
      stderr?: string
      cause?: unknown
    } = {},
  ) {
    super(`${path.basename(file)}: ${reason}`, { cause: detail.cause })
    this.name = 'ToolError'
    this.reason = reason
    this.file = file
    this.code = detail.code ?? null
    this.signal = detail.signal ?? null
    this.stdout = detail.stdout ?? ''
    this.stderr = detail.stderr ?? ''
  }
}

export interface RunOptions {
  /** Our own deadline: SIGTERM to the group, SIGKILL after killGraceMs. */
  timeoutMs?: number
  /** stdout cap; over it the tool is stopped with 'too-large'. */
  maxBytes?: number
  maxStderr?: number
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
  /** Also track the child here (a bridge's own set), besides liveChildren. */
  track?: Set<ChildProcess>
}

export interface RunResult<T> {
  code: number
  stdout: T
  stderr: string
}

/**
 * Run `file` with `argv` and collect its output. Never a shell (an argument is never parsed
 * by one), never a PATH lookup (the file must be absolute: a planted ./adb cannot run),
 * no stdin (a tool that prompts gets EOF instead of hanging), its own process group.
 *
 * Settles on 'close', when stdout is complete. A grandchild that keeps the pipe open would
 * hold 'close' back forever, so 1 s after the tool itself exits the group is killed and the
 * run settles with what arrived.
 */
export function runTool(
  file: string,
  argv: readonly string[],
  opts: RunOptions & { encoding: 'buffer' },
): Promise<RunResult<Buffer>>
export function runTool(
  file: string,
  argv: readonly string[],
  opts?: RunOptions & { encoding?: 'utf8' },
): Promise<RunResult<string>>
export function runTool(
  file: string,
  argv: readonly string[],
  opts: RunOptions & { encoding?: 'utf8' | 'buffer' } = {},
): Promise<RunResult<string | Buffer>> {
  const {
    timeoutMs = 15_000,
    /** Text output (JSON, getprop) is capped at 8 MiB, binary (a PNG) at 32 MiB. */
    maxBytes = opts.encoding === 'buffer' ? LIMITS.png : LIMITS.text,
    maxStderr = LIMITS.stderr,
    signal,
    cwd = os.tmpdir(),
    env = childEnv(),
    killGraceMs = TIMEOUTS.killGrace,
    encoding = 'utf8',
    track,
  } = opts
  return new Promise((resolve, reject) => {
    if (!path.isAbsolute(file)) return reject(new ToolError('not-found', file))
    if (signal?.aborted) return reject(new ToolError('aborted', file))
    let child: ChildProcess
    try {
      child = spawn(file, argv, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env,
      })
    } catch (error) {
      return reject(new ToolError('spawn-failed', file, { cause: error }))
    }
    liveChildren.add(child)
    track?.add(child)
    const out: Buffer[] = []
    let outLength = 0
    const err: Buffer[] = []
    let errLength = 0
    let stopped: ToolFailure | null = null
    let spawnError: NodeJS.ErrnoException | null = null
    let settled = false
    let escalate: NodeJS.Timeout | undefined
    let lingering: NodeJS.Timeout | undefined

    const stop = (why: ToolFailure): void => {
      if (stopped) return
      stopped = why
      signalTree(child, 'SIGTERM')
      escalate = setTimeout(() => signalTree(child, 'SIGKILL'), killGraceMs)
      escalate.unref()
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = (): void => stop('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      outLength += chunk.length
      if (outLength > maxBytes) stop('too-large')
      else out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err.push(chunk)
      errLength += chunk.length
      while (errLength - (err[0]?.length ?? 0) >= maxStderr && err.length > 1) {
        errLength -= err.shift()?.length ?? 0
      }
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error
    })

    const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(lingering)
      signal?.removeEventListener('abort', onAbort)
      /** A tool we stopped may have left members in its group; finish them. */
      if (stopped) signalTree(child, 'SIGKILL')
      if (escalate) clearTimeout(escalate)
      const stdoutBuffer = Buffer.concat(out)
      const detail = {
        code,
        signal: sig,
        stdout: encoding === 'buffer' ? stdoutBuffer : stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').slice(-maxStderr),
      }
      if (spawnError) {
        const reason = spawnError.code === 'ENOENT' ? 'not-found' : 'spawn-failed'
        return reject(new ToolError(reason, file, { ...detail, cause: spawnError }))
      }
      if (stopped) return reject(new ToolError(stopped, file, detail))
      if (code !== 0) return reject(new ToolError('exit', file, detail))
      resolve({ code, stdout: detail.stdout, stderr: detail.stderr })
    }

    child.on('exit', (code, sig) => {
      lingering = setTimeout(() => {
        /**
         * The tool is gone but something it started still holds stdout: kill the group,
         * stop waiting for the pipe, and settle with what arrived.
         */
        signalTree(child, 'SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(code, sig)
      }, 1_000)
      lingering.unref()
    })
    child.on('close', (code, sig) => {
      liveChildren.delete(child)
      track?.delete(child)
      settle(code, sig)
    })
  })
}

export interface StreamOptions {
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Complete, cleaned lines from stdout, a batch per chunk. */
  onLines: (lines: string[]) => void
  /** Complete, cleaned lines from stderr; without it stderr is drained and only its tail kept. */
  onStderrLines?: (lines: string[]) => void
  maxLine?: number
  killGraceMs?: number
  track?: Set<ChildProcess>
}

export interface StreamResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** The last 64 KiB of stderr (empty when onStderrLines took it). */
  stderr: string
  /** We ended it: kill(), the signal, or shutdown. */
  stopped: boolean
}

export interface StreamHandle {
  readonly pid: number | undefined
  /** Back-pressure: stop reading stdout until resume(). */
  readonly pause: () => void
  readonly resume: () => void
  /** SIGTERM the group, SIGKILL after the grace period. */
  readonly kill: () => void
  /** Resolves when the tool's pipes close (or 1 s after it exits); rejects only if it never started. */
  readonly done: Promise<StreamResult>
}

/**
 * A long-running tool (a log stream) under the same rules as runTool, read line by line.
 * The caller owns the lifetime: abort the signal or call kill(), and the group dies.
 */
export function streamTool(
  file: string,
  argv: readonly string[],
  opts: StreamOptions,
): StreamHandle {
  const { signal, cwd = os.tmpdir(), env = childEnv(), onLines, onStderrLines, track } = opts
  const maxLine = opts.maxLine ?? LIMITS.line
  const killGraceMs = opts.killGraceMs ?? TIMEOUTS.killGrace
  if (!path.isAbsolute(file)) return idleHandle(new ToolError('not-found', file))
  let child: ChildProcess
  try {
    child = spawn(file, argv, {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    })
  } catch (error) {
    return idleHandle(new ToolError('spawn-failed', file, { cause: error }))
  }
  liveChildren.add(child)
  track?.add(child)
  let stopped = false
  let escalate: NodeJS.Timeout | undefined
  const kill = (): void => {
    if (stopped) return
    stopped = true
    signalTree(child, 'SIGTERM')
    escalate = setTimeout(() => signalTree(child, 'SIGKILL'), killGraceMs)
    escalate.unref()
  }
  const onAbort = (): void => kill()
  if (signal?.aborted) kill()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const stdoutLines = splitLines(onLines, maxLine)
  child.stdout?.on('data', (chunk: Buffer) => stdoutLines.write(chunk))
  child.stdout?.on('end', () => stdoutLines.end())
  let stderrTail = ''
  const stderrLines = onStderrLines ? splitLines(onStderrLines, maxLine) : null
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrLines) stderrLines.write(chunk)
    else stderrTail = (stderrTail + chunk.toString('utf8')).slice(-LIMITS.stderr)
  })
  child.stderr?.on('end', () => stderrLines?.end())

  const done = new Promise<StreamResult>((resolve, reject) => {
    let spawnError: NodeJS.ErrnoException | null = null
    let settled = false
    let lingering: NodeJS.Timeout | undefined
    const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(lingering)
      if (escalate) clearTimeout(escalate)
      signal?.removeEventListener('abort', onAbort)
      if (stopped) signalTree(child, 'SIGKILL')
      if (spawnError) {
        const reason = spawnError.code === 'ENOENT' ? 'not-found' : 'spawn-failed'
        return reject(new ToolError(reason, file, { stderr: stderrTail, cause: spawnError }))
      }
      resolve({ code, signal: sig, stderr: stderrTail, stopped })
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error
    })
    child.on('exit', (code, sig) => {
      lingering = setTimeout(() => {
        signalTree(child, 'SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(code, sig)
      }, 1_000)
      lingering.unref()
    })
    child.on('close', (code, sig) => {
      liveChildren.delete(child)
      track?.delete(child)
      settle(code, sig)
    })
  })
  /** A lane that never awaits `done` must not turn a failed start into a crash of the helper. */
  done.catch(() => undefined)
  return {
    pid: child.pid,
    pause: () => child.stdout?.pause(),
    resume: () => child.stdout?.resume(),
    kill,
    done,
  }
}

/** A handle for a tool that never started: nothing to pause or kill. */
function idleHandle(error: ToolError): StreamHandle {
  const done = Promise.reject(error)
  done.catch(() => undefined)
  return { pid: undefined, pause() {}, resume() {}, kill() {}, done }
}

export type RunTool = typeof runTool
export type StreamTool = typeof streamTool

/**
 * TERM every group in `children`, wait until they are gone or the grace period ends, then
 * KILL what is left. Shutdown uses it on its own children; the exit hook is the backstop.
 */
export async function killAll(
  graceMs: number = TIMEOUTS.killGrace,
  children: Set<ChildProcess> = liveChildren,
): Promise<void> {
  for (const child of children) signalTree(child, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (children.size > 0 && Date.now() < deadline) await sleep(25)
  for (const child of children) signalTree(child, 'SIGKILL')
}

const exitDirs = new Set<string>()
let exitHooked = false

/**
 * The last line of defence, synchronous because nothing async runs in an `exit` handler:
 * however the process ends (a return, process.exit, an uncaught exception), every tool
 * group still alive is SIGKILLed and every registered work directory is removed.
 * Returns the function that unregisters `dir`.
 */
export function cleanUpOnExit(dir?: string): () => void {
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => {
      for (const child of liveChildren) signalTree(child, 'SIGKILL')
      for (const each of exitDirs) {
        try {
          rmSync(each, { recursive: true, force: true })
        } catch {
          // Best effort: the process is ending either way.
        }
      }
    })
  }
  if (dir) exitDirs.add(dir)
  return () => {
    if (dir) exitDirs.delete(dir)
  }
}
