import path from 'node:path'
import { DEFAULT_PORT } from './constants'

/** What the command line asks for (§1.9). */
export interface CliOptions {
  port: number
  open: boolean
  keepToken: boolean
  newToken: boolean
  wifi: boolean
  simulators: boolean
  android: boolean
  local: boolean
  dev: boolean
  verbose: boolean
  doctor: boolean
  help: boolean
  version: boolean
}

/** A bad command line, worded for the terminal; exit 64. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Boolean flags. There is deliberately no --host, --api or --token: no flag may widen who can
 * reach the helper, and no secret is ever passed on a command line (other users can read
 * process arguments).
 */
const FLAGS: Readonly<Record<string, (o: CliOptions) => void>> = {
  '--no-open': (o) => {
    o.open = false
  },
  '--keep-token': (o) => {
    o.keepToken = true
  },
  '--new-token': (o) => {
    o.newToken = true
  },
  '--wifi': (o) => {
    o.wifi = true
  },
  '--simulators': (o) => {
    o.simulators = true
  },
  '--no-android': (o) => {
    o.android = false
  },
  '--no-local': (o) => {
    o.local = false
  },
  '--dev': (o) => {
    o.dev = true
  },
  '--verbose': (o) => {
    o.verbose = true
  },
  '--doctor': (o) => {
    o.doctor = true
  },
  '--version': (o) => {
    o.version = true
  },
  '--help': (o) => {
    o.help = true
  },
  '-h': (o) => {
    o.help = true
  },
}

/**
 * How to show this file in a command the tester can paste back: `~/device-bridge.mjs` when
 * it lives under the home folder, otherwise the path as it was typed, quoted for the shell
 * when it needs to be.
 */
export function scriptHint(scriptPath: string | undefined, home: string, cwd: string): string {
  if (!scriptPath) return '~/device-bridge.mjs'
  const absolute = path.resolve(cwd, scriptPath)
  const inHome = path.relative(home, absolute)
  const plain = (text: string): boolean => /^[\w@%+=:,./-]+$/.test(text)
  const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
  if (home && inHome && !inHome.startsWith('..') && !path.isAbsolute(inHome)) {
    return plain(inHome) ? `~/${inHome}` : `~/${quote(inHome)}`
  }
  // Node hands us an absolute argv[1]; from the same folder, the relative form is what was typed.
  const relative = path.relative(cwd, absolute)
  const shown = relative && relative.length < absolute.length ? relative : absolute
  return plain(shown) ? shown : quote(shown)
}

function parsePort(value: string | undefined, script: string): number {
  const port = value !== undefined && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN
  if (!(port >= 1024 && port <= 65535)) {
    throw new UsageError(
      `--port needs a whole number from 1024 to 65535${value === undefined ? '' : ` (got "${value}")`}. ` +
        `Run: node ${script} --help`,
    )
  }
  return port
}

/** Parse argv (without node and the script). Throws UsageError for anything unknown. */
export function parseCli(argv: readonly string[], script = 'device-bridge.mjs'): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    open: true,
    keepToken: false,
    newToken: false,
    wifi: false,
    simulators: false,
    android: true,
    local: true,
    dev: false,
    verbose: false,
    doctor: false,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--port') {
      options.port = parsePort(argv[++i], script)
      continue
    }
    if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length), script)
      continue
    }
    const flag = FLAGS[arg]
    if (!flag) throw new UsageError(`Unknown option ${arg}. Run: node ${script} --help`)
    flag(options)
  }
  if (options.newToken && !options.keepToken) {
    throw new UsageError(`--new-token works only with --keep-token. Run: node ${script} --help`)
  }
  return options
}

export function helpText(script: string): string {
  return `node ${script} [options]

  --port <n>       Port on 127.0.0.1 (1024–65535, default 8787)
  --no-open        Don't open Device Lab in the browser at start
  --keep-token     Keep one token across restarts (stored 0600); pairs well with
                   "Remember on this computer" on the page
  --new-token      With --keep-token: replace the stored token
  --wifi           Also list iPhones that are only reachable over Wi-Fi
  --simulators     Also list booted iOS Simulators
  --no-android     Never connect to Google's adb server
  --no-local       Don't serve the Device Lab page at http://127.0.0.1:<port>/device/ (Safari needs it)
  --dev            Also allow http://localhost:7360, :4173, :8000 (and 127.0.0.1) for development
  --verbose        One line per request (method, path, status, ms) and per tool run; never headers or tokens
  --doctor         Print the checklist and a read-only probe of each attached device, then exit
  --version        Print the version
  -h, --help       Show this help
`
}
