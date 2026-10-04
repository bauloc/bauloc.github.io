import type { Adb } from '@yume-chan/adb'

/*
  A scripted stand-in for a connected phone, for the android/*.test.ts files only: no USB and no
  adb. It records every command exactly as the phone would receive it (the shell protocol,
  `exec:`, or android-bin's `abb_exec:` socket) and answers from the test's script, so the tests
  check the bytes that would cross the cable, quoting included.
*/

export interface FakeAnswer {
  readonly stdout?: string | Uint8Array
  readonly stderr?: string
  readonly exitCode?: number
  /** Answer only once this many stdin bytes have arrived, as install-write -S does. */
  readonly readStdin?: number
  /** Never answer: the process runs until it is killed (for Cancel). */
  readonly hang?: boolean
}

export interface FakeCall {
  readonly via: 'shell' | 'exec' | 'abb_exec'
  /** The command line; for abb_exec, the arguments joined with spaces. */
  readonly command: string
  /** abb_exec only: the raw service string, NUL separators included. */
  readonly service: string
  stdin: Uint8Array
  killed: boolean
}

export interface FakeEntry {
  readonly name: string
  readonly size: number
  readonly dir?: boolean
  /** Seconds. */
  readonly mtime?: number
}

export interface FakePhone {
  /** Default: a modern phone, `shell_v2`, `cmd` and `abb_exec`. */
  readonly features?: readonly string[]
  /** The answer to one command; undefined answers nothing, successfully. */
  readonly answer?: (call: FakeCall) => FakeAnswer | undefined
  readonly files?: Readonly<Record<string, Uint8Array>>
  readonly dirs?: Readonly<Record<string, readonly FakeEntry[]>>
  /** Sync reads arrive in chunks of this size, a tick apart. */
  readonly chunkSize?: number
}

export interface FakeSync {
  disposed: boolean
  readonly reads: string[]
}

const encode = (text: string | Uint8Array) =>
  typeof text === 'string' ? new TextEncoder().encode(text) : text

function pipe() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push(bytes: Uint8Array) {
      if (open && bytes.byteLength > 0) controller.enqueue(bytes)
    },
    close() {
      if (!open) return
      open = false
      controller.close()
    },
  }
}

const join = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

/** One running process: stdout and stderr (merged when `merged`), stdin, an exit. */
function processFor(call: FakeCall, answer: FakeAnswer | undefined, merged: boolean) {
  const out = pipe()
  const err = merged ? out : pipe()
  let settle!: (code: number) => void
  let fail!: (reason: unknown) => void
  const exited = new Promise<number>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // Callers that never wait for the exit must not see an unhandled rejection.
  exited.catch(() => undefined)
  let done = false

  const finish = () => {
    if (done) return
    done = true
    out.push(encode(answer?.stdout ?? ''))
    err.push(encode(answer?.stderr ?? ''))
    out.close()
    err.close()
    settle(answer?.exitCode ?? 0)
  }
  const kill = (reason?: unknown) => {
    call.killed = true
    if (done) return
    done = true
    out.close()
    err.close()
    fail(reason ?? new Error('Socket ended without exit message'))
  }
  const ready = () => !answer?.hang && call.stdin.byteLength >= (answer?.readStdin ?? 0)

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      if (call.killed) throw new Error('Socket closed')
      call.stdin = join(call.stdin, chunk)
      if (ready()) finish()
    },
  })
  queueMicrotask(() => {
    if (ready()) finish()
  })
  return { stdout: out.stream, stderr: err.stream, stdin, exited, kill }
}

export function fakeAdb(phone: FakePhone = {}) {
  const features = phone.features ?? ['shell_v2', 'cmd', 'abb_exec']
  const calls: FakeCall[] = []
  const syncs: FakeSync[] = []

  const start = (via: FakeCall['via'], command: string, service = '') => {
    const call: FakeCall = { via, command, service, stdin: new Uint8Array(), killed: false }
    calls.push(call)
    return { call, answer: phone.answer?.(call) }
  }
  const text = (command: string | readonly string[]) =>
    typeof command === 'string' ? command : command.join(' ')
  const onAbort = (signal: AbortSignal | undefined, kill: (reason: unknown) => void) => {
    signal?.addEventListener('abort', () => {
      kill(signal.reason)
    })
  }

  const shellProtocol = {
    spawn(command: string | readonly string[], signal?: AbortSignal) {
      const { call, answer } = start('shell', text(command))
      const p = processFor(call, answer, false)
      onAbort(signal, p.kill)
      return Promise.resolve({
        stdout: p.stdout,
        stderr: p.stderr,
        stdin: p.stdin,
        exited: p.exited,
        kill: () => {
          p.kill()
        },
      })
    },
  }

  const noneProtocol = {
    spawn(command: string | readonly string[], signal?: AbortSignal) {
      const { call, answer } = start('exec', text(command))
      const p = processFor(call, answer, true)
      onAbort(signal, p.kill)
      return Promise.resolve({
        output: p.stdout,
        stdin: p.stdin,
        // exec: has no exit code; it ends when the socket closes.
        exited: p.exited.then(
          () => undefined,
          (reason: unknown) => {
            if (signal?.aborted) throw reason
          },
        ),
        kill: () => {
          p.kill()
        },
      })
    },
  }

  // android-bin opens `abb_exec:` sockets itself and wraps them in Tango's process class.
  const createSocket = (service: string) => {
    const args = service
      .replace(/^abb_exec:/, '')
      .split('\0')
      .filter(Boolean)
    const { call, answer } = start('abb_exec', args.join(' '), service)
    const p = processFor(call, answer, true)
    return Promise.resolve({
      service,
      readable: p.stdout,
      writable: p.stdin,
      closed: p.exited.then(
        () => undefined,
        () => undefined,
      ),
      close: () => {
        p.kill()
        return Promise.resolve()
      },
    })
  }

  const sync = () => {
    const state: FakeSync = { disposed: false, reads: [] }
    syncs.push(state)
    const entry = (e: FakeEntry) => ({
      name: e.name,
      size: BigInt(e.size),
      mtime: BigInt(e.mtime ?? 0),
      mode: e.dir ? 0o40755 : 0o100644,
      type: e.dir ? 0o04 : 0o10,
      permission: e.dir ? 0o755 : 0o644,
    })
    return Promise.resolve({
      readdir: (path: string) => {
        const entries = phone.dirs?.[path]
        // adbd answers a folder it cannot open with an empty list, not an error.
        if (!entries) return Promise.resolve([])
        const dots: FakeEntry[] = [
          { name: '.', size: 4096, dir: true },
          { name: '..', size: 4096, dir: true },
        ]
        return Promise.resolve([...dots, ...entries].map(entry))
      },
      lstat: (path: string) => {
        const file = phone.files?.[path]
        if (!file) return Promise.reject(new Error('lstat error'))
        return Promise.resolve(entry({ name: path, size: file.byteLength }))
      },
      read: (path: string) => {
        state.reads.push(path)
        const file = phone.files?.[path]
        const size = phone.chunkSize ?? 64 * 1024
        let at = 0
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (state.disposed) {
              controller.error(new Error('Socket closed'))
              return
            }
            if (!file) {
              controller.error(new Error('No such file or directory'))
              return
            }
            if (at >= file.byteLength) {
              controller.close()
              return
            }
            controller.enqueue(file.slice(at, at + size))
            at += size
          },
        })
      },
      dispose: () => {
        state.disposed = true
        return Promise.resolve()
      },
    })
  }

  const adb = {
    subprocess: {
      shellProtocol: features.includes('shell_v2') ? shellProtocol : undefined,
      noneProtocol,
    },
    canUseFeature: (feature: string) => features.includes(feature),
    createSocket,
    sync,
  } as unknown as Adb

  return { adb, calls, syncs }
}

/** A part whose bytes arrive in `chunks` pieces, for install tests. */
export function fakePart(bytes: Uint8Array, chunks = 3, size = bytes.byteLength) {
  return {
    size,
    open: () => {
      const step = Math.ceil(bytes.byteLength / chunks)
      let at = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.byteLength) {
            controller.close()
            return
          }
          controller.enqueue(bytes.slice(at, at + step))
          at += step
        },
      })
    },
  }
}
