/*
  Fake tool binaries: `#!/bin/sh` scripts in a private directory, handed to the helper as its
  whole PATH (createBridge({ searchPath: bin.dir, extraDirs: [] })), so no real tool can ever
  run in a test.

  Every script appends one line to <state>/calls.log first: its PID, its name and its
  arguments, tab-separated. Tests assert both what ran and what NEVER ran (a wrapper, `adb
  start-server`, /usr/bin/java). Scripts get PATH=/usr/bin:/bin for their own `sleep` and
  `cat`, and an `arg_after` shell function: `out=$(arg_after --json-output "$@")`.

  For the lane suites: `tool()` takes any body; `file()` places a script at an absolute path
  (a fake Xcode tree, a fake CoreDevice devicectl); `fixture()` stores bytes a script can
  `cat` without shell quoting.

  Timing: macOS scans an executable the first time it runs, so a freshly written script can
  take 100–300 ms to start. Give fake tools timeouts of a second or more unless the test is
  about the timeout itself.
*/
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface FakeCall {
  pid: number
  name: string
  argv: string[]
}

export interface FakeBin {
  /** The directory to pass as searchPath. */
  readonly dir: string
  /** calls.log, PID files and fixtures live here. */
  readonly state: string
  /** A tool `name` in `dir` running `body` (POSIX sh). Returns its absolute path. */
  readonly tool: (name: string, body: string) => string
  /** A tool at an absolute path anywhere, logged under `name`. */
  readonly file: (absolutePath: string, body: string, name?: string) => string
  /** A tool that prints `stdout`, `stderr` and exits with `exit`, after `sleep` seconds. */
  readonly simple: (
    name: string,
    opts?: { stdout?: string | Buffer; stderr?: string; exit?: number; sleep?: number },
  ) => string
  /**
   * A tool that writes its PID to <state>/<name>.pid, starts a grandchild that keeps stdout
   * open (PID in <name>.gpid) and prints `line N` every `intervalMs` until killed: the trap
   * that keeps 'close' from firing unless the whole process group dies.
   */
  readonly sleeper: (name: string, opts?: { intervalMs?: number; silent?: boolean }) => string
  /** Bytes a script can read as "$FAKE_STATE/fixtures/<name>". */
  readonly fixture: (name: string, content: string | Buffer) => string
  readonly calls: () => FakeCall[]
  readonly pid: (name: string) => number | null
  readonly gpid: (name: string) => number | null
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export function createFakeBin(root: string): FakeBin {
  const dir = path.join(root, 'bin')
  const state = path.join(root, 'state')
  mkdirSync(dir, { recursive: true })
  mkdirSync(path.join(state, 'fixtures'), { recursive: true })
  appendFileSync(path.join(state, 'calls.log'), '')

  const preamble = (name: string): string => `#!/bin/sh
export PATH=/usr/bin:/bin
FAKE_STATE=${quote(state)}
# One write per call: tools that run at the same time must not interleave their lines.
_t=$(printf '\\t'); _line="$$$_t"${quote(name)}; for a in "$@"; do _line="$_line$_t$a"; done
printf '%s\\n' "$_line" >> "$FAKE_STATE/calls.log"
arg_after() { want="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$want" ]; then printf '%s' "$2"; return 0; fi; shift; done; return 1; }
`
  const file = (absolutePath: string, body: string, name = path.basename(absolutePath)): string => {
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, preamble(name) + body + '\n')
    chmodSync(absolutePath, 0o755)
    return absolutePath
  }
  const fixture = (name: string, content: string | Buffer): string => {
    const target = path.join(state, 'fixtures', name)
    writeFileSync(target, content)
    return target
  }
  const readPid = (file: string): number | null => {
    const target = path.join(state, file)
    if (!existsSync(target)) return null
    const pid = Number(readFileSync(target, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  return {
    dir,
    state,
    tool: (name, body) => file(path.join(dir, name), body, name),
    file,
    simple(name, opts = {}) {
      const lines: string[] = []
      if (opts.sleep) lines.push(`sleep ${String(opts.sleep)}`)
      if (opts.stdout !== undefined) {
        fixture(`${name}.stdout`, opts.stdout)
        lines.push(`cat "$FAKE_STATE/fixtures/${name}.stdout"`)
      }
      if (opts.stderr !== undefined) {
        fixture(`${name}.stderr`, opts.stderr)
        lines.push(`cat "$FAKE_STATE/fixtures/${name}.stderr" >&2`)
      }
      lines.push(`exit ${String(opts.exit ?? 0)}`)
      return file(path.join(dir, name), lines.join('\n'), name)
    },
    sleeper(name, opts = {}) {
      const interval = ((opts.intervalMs ?? 50) / 1000).toFixed(3)
      return file(
        path.join(dir, name),
        `echo $$ > "$FAKE_STATE/${name}.pid"
sleep 60 &
echo $! > "$FAKE_STATE/${name}.gpid"
i=0
while :; do
  i=$((i+1))
  ${opts.silent ? ':' : 'echo "line $i"'}
  sleep ${interval}
done`,
        name,
      )
    },
    fixture,
    calls() {
      return readFileSync(path.join(state, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [pid = '0', name = '', ...argv] = line.split('\t')
          return { pid: Number(pid), name, argv }
        })
    },
    pid: (name) => readPid(`${name}.pid`),
    gpid: (name) => readPid(`${name}.gpid`),
  }
}

/** Whether a process exists (signal 0 checks without touching it). */
export function alive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
