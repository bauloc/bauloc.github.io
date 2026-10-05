import type { ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAndroidLane } from './android-lane'
import {
  CHALLENGE_PATTERN,
  createBearerCheck,
  createPageLog,
  generateToken,
  loadKeptToken,
  proofOf,
  tokenIdOf,
} from './auth'
import { DEFAULT_PORT, LIMITS, NAME, PROTOCOL, SITE, TIMEOUTS, VERSION } from './constants'
import { bugText, createApi } from './http'
import { createIosLane } from './ios-lane'
import { createLanScanner, scanLan } from './lan'
import { fetchDescription, presenceTransport, ssdpTransport, systemInterfaces } from './lan-net'
import { createLocalMode } from './local-mode'
import { udpTransport } from './mdns'
import { collectPreflight, doctorReport, printDoctor } from './preflight'
import {
  childEnv,
  cleanUpOnExit,
  killAll,
  runTool,
  streamTool,
  type RunOptions,
  type RunTool,
  type StreamOptions,
  type StreamTool,
} from './process'
import { createRegistry, initialLanes, type Registry } from './registry'
import { createSimulatorLane } from './simulator-lane'
import { emptyToolbox, resolveTools, toolOptionsFrom, type Toolbox } from './tools'
import type {
  BridgeInput,
  BridgeOptions,
  DoctorReport,
  Health,
  HelperAbout,
  Lane,
  LaneContext,
  LaneSet,
  PreflightContext,
  PreflightItem,
  ToolsCache,
} from './types'
import { createLimiter, errorText, seconds, sleep, timeOfDay } from './util'

export interface Bridge {
  /** Bind 127.0.0.1, start the lanes, begin the background preflight. */
  readonly listen: () => Promise<{ port: number }>
  /** §1.8 steps 2–7: idempotent. */
  readonly close: () => Promise<void>
  /** The bound port (0 until listen). */
  readonly port: number
  readonly token: string
  readonly tokenId: string
  readonly runId: string
  readonly registry: Registry
  readonly lanes: LaneSet
  readonly options: BridgeOptions
  readonly health: (challenge?: string | null) => Health
  /** The first preflight collection (started by listen), or a fresh one. */
  readonly preflight: (opts?: { refresh?: boolean }) => Promise<PreflightItem[]>
  readonly toolbox: () => Promise<Toolbox>
  /** --doctor: the checklist and each lane's read-only probe, printed. No server, no lanes. */
  readonly doctor: (write: (line: string) => void) => Promise<void>
}

/** ANDROID_ADB_SERVER_PORT when it is a valid port, as adb itself reads it; else 5037. */
function adbPortFrom(env: NodeJS.ProcessEnv): number {
  const port = Number(env.ANDROID_ADB_SERVER_PORT)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5037
}

/** `%SystemRoot%\System32\<file>`: where Windows keeps ARP.EXE and ROUTE.EXE. */
function system32(env: NodeJS.ProcessEnv, file: string): string {
  return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', file)
}

/** §1.6: every option filled. Tests replace the paths and ports so no real tool leaks in. */
export function resolveOptions(input: BridgeInput = {}): BridgeOptions {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  return {
    port: input.port ?? DEFAULT_PORT,
    token: input.token,
    keepToken: input.keepToken ?? false,
    newToken: input.newToken ?? false,
    home: input.home ?? os.homedir(),
    searchPath: input.searchPath ?? env.PATH ?? '',
    extraDirs: input.extraDirs,
    platform,
    arch: input.arch ?? process.arch,
    nodeVersion: input.nodeVersion ?? process.versions.node,
    opensslVersion: input.opensslVersion ?? process.versions.openssl,
    getuid: 'getuid' in input ? input.getuid : process.getuid?.bind(process),
    usbmuxdSocket: input.usbmuxdSocket ?? '/var/run/usbmuxd',
    adbPort: input.adbPort ?? adbPortFrom(env),
    tunneldPort: input.tunneldPort ?? 49151,
    upstream: input.upstream ?? SITE,
    xcodeSelectPath: input.xcodeSelectPath ?? '/usr/bin/xcode-select',
    plistBuddyPath: input.plistBuddyPath ?? '/usr/libexec/PlistBuddy',
    javaHomePath: input.javaHomePath ?? '/usr/libexec/java_home',
    openPath: input.openPath ?? '/usr/bin/open',
    swVersPath: input.swVersPath ?? '/usr/bin/sw_vers',
    applicationsDir: input.applicationsDir ?? '/Applications',
    coreDeviceDir:
      input.coreDeviceDir ?? '/Library/Developer/PrivateFrameworks/CoreDevice.framework',
    coreSimulatorDir:
      input.coreSimulatorDir ?? '/Library/Developer/PrivateFrameworks/CoreSimulator.framework',
    systemVersionPlist:
      input.systemVersionPlist ?? '/System/Library/CoreServices/SystemVersion.plist',
    open: input.open ?? true,
    wifi: input.wifi ?? false,
    simulators: input.simulators ?? false,
    android: input.android ?? true,
    local: input.local ?? true,
    dev: input.dev ?? false,
    verbose: input.verbose ?? false,
    timeouts: { ...TIMEOUTS, ...input.timeouts },
    heartbeatMs: input.heartbeatMs ?? 15_000,
    now: input.now ?? Date.now,
    log: input.log ?? ((line) => void process.stdout.write(line + '\n')),
    errorLog: input.errorLog ?? ((line) => void process.stderr.write(line + '\n')),
    env,
    tmpDir: input.tmpDir ?? os.tmpdir(),
    selfPath: input.selfPath,
    lanes: input.lanes ?? {},
    resolveTools: input.resolveTools ?? resolveTools,
    /**
     * Resolved on first use: Node 18 warns once when fetch is first called, and only local
     * mode ever calls it.
     */
    fetch: input.fetch ?? ((url, init) => fetch(url, init)),
    mdns: input.mdns ?? udpTransport(),
    dnsSdPath: input.dnsSdPath ?? '/usr/bin/dns-sd',
    avahiBrowsePath: input.avahiBrowsePath,
    lanInterfaces: input.lanInterfaces ?? systemInterfaces,
    lanPresence: input.lanPresence ?? presenceTransport(),
    lanSsdp: input.lanSsdp ?? ssdpTransport(),
    lanDescription: input.lanDescription ?? fetchDescription,
    arpPath: input.arpPath ?? (platform === 'win32' ? system32(env, 'ARP.EXE') : '/usr/sbin/arp'),
    procNetArpPath: input.procNetArpPath ?? '/proc/net/arp',
    procNetRoutePath: input.procNetRoutePath ?? '/proc/net/route',
    routePath:
      input.routePath ?? (platform === 'win32' ? system32(env, 'ROUTE.EXE') : '/sbin/route'),
    avahiResolvePath: input.avahiResolvePath,
    lanScan: input.lanScan ?? scanLan,
  }
}

/** The flags a run was started with, for the doctor report; never a token. */
function flagsOf(o: BridgeOptions): string[] {
  const flags: string[] = []
  if (o.port !== DEFAULT_PORT && o.port !== 0) flags.push(`--port ${String(o.port)}`)
  if (!o.open) flags.push('--no-open')
  if (o.keepToken) flags.push('--keep-token')
  if (o.wifi) flags.push('--wifi')
  if (o.simulators) flags.push('--simulators')
  if (!o.android) flags.push('--no-android')
  if (!o.local) flags.push('--no-local')
  if (o.dev) flags.push('--dev')
  if (o.verbose) flags.push('--verbose')
  return flags
}

/**
 * The helper, assembled (§1.6). Nothing happens until listen() (or doctor()): no socket, no
 * file, no child process, so tests can build one with every path pointed at fakes.
 */
export function createBridge(input: BridgeInput = {}): Bridge {
  const options = resolveOptions(input)
  const { timeouts } = options
  const token =
    options.token ??
    (options.keepToken
      ? loadKeptToken({
          home: options.home,
          platform: options.platform,
          env: options.env,
          getuid: options.getuid,
          newToken: options.newToken,
        }).token
      : generateToken())
  const tokenId = tokenIdOf(token)
  const runId = randomBytes(4).toString('hex')
  const shutdown = new AbortController()
  /** This bridge's own children, so closing one bridge never kills another's (tests run many). */
  const children = new Set<ChildProcess>()
  const limit = createLimiter(LIMITS.tools)
  let boundPort = 0
  let startedAt = 0
  let workDir = ''
  let workDirReady: Promise<string> | null = null
  let unregisterExit: () => void = () => undefined
  let server: http.Server | null = null
  let closing: Promise<void> | null = null
  let selfHash: string | null = null

  const logLine = (text: string): void => options.log(`${timeOfDay(options.now())}  ${text}`)
  const bug = (error: unknown): void =>
    options.errorLog(`Device Lab helper hit a bug: ${bugText(error)}`)

  const factories = {
    ios:
      options.lanes.ios !== undefined
        ? options.lanes.ios
        : options.platform === 'darwin'
          ? createIosLane
          : null,
    android:
      options.lanes.android !== undefined
        ? options.lanes.android
        : options.android
          ? createAndroidLane
          : null,
    simulators:
      options.lanes.simulators !== undefined
        ? options.lanes.simulators
        : options.simulators && options.platform === 'darwin'
          ? createSimulatorLane
          : null,
  }

  const registry = createRegistry({
    runId,
    lanes: initialLanes({
      platform: options.platform,
      wifi: options.wifi,
      android: factories.android !== null,
      simulators: factories.simulators !== null || options.simulators,
    }),
    now: options.now,
    activeMs: timeouts.active,
    log: logLine,
    bug: (line) => options.errorLog(line),
  })

  /** This run's private directory: mkdtemp (0700), removed at close and by the exit hook. */
  const ensureWorkDir = (): Promise<string> => {
    workDirReady ??= mkdtemp(path.join(options.tmpDir, 'device-bridge-')).then((dir) => {
      workDir = dir
      unregisterExit = cleanUpOnExit(dir)
      return dir
    })
    return workDirReady
  }

  const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(path.join(await ensureWorkDir(), 'op-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** --verbose: one line per tool run, its name and outcome only. */
  const timed = <T>(file: string, run: Promise<T>): Promise<T> => {
    if (!options.verbose) return run
    const started = Date.now()
    const report = (outcome: string): void =>
      logLine(`tool ${path.basename(file)} ${outcome} ${seconds(Date.now() - started)} s`)
    run.then(
      () => report('ok'),
      (error: unknown) =>
        report(error instanceof Error && 'reason' in error ? String(error.reason) : 'failed'),
    )
    return run
  }

  /**
   * Every one-shot tool a lane or preflight runs: in this run's private folder, with the
   * cleaned environment, tracked for shutdown, and through the 4-at-a-time limiter (§1.3),
   * so a page hammering Refresh cannot fork forty devicectl processes.
   */
  const boundRunTool = ((
    file: string,
    argv: readonly string[],
    opts: RunOptions & { encoding?: 'utf8' | 'buffer' } = {},
  ) =>
    limit(() =>
      timed(
        file,
        runTool(file, argv, {
          cwd: workDir || options.tmpDir,
          env: childEnv({}, options.env),
          killGraceMs: timeouts.killGrace,
          track: children,
          ...opts,
        } as RunOptions & { encoding: 'buffer' }),
      ),
    )) as RunTool

  const boundStreamTool = ((file: string, argv: readonly string[], opts: StreamOptions) => {
    if (options.verbose) logLine(`tool ${path.basename(file)} streaming`)
    return streamTool(file, argv, {
      cwd: workDir || options.tmpDir,
      env: childEnv({}, options.env),
      killGraceMs: timeouts.killGrace,
      track: children,
      ...opts,
    })
  }) as StreamTool

  let toolsAt = 0
  let toolsPromise: Promise<Toolbox> | null = null
  const resolveFresh = (): Promise<Toolbox> => {
    toolsAt = options.now()
    toolsPromise = options
      .resolveTools(toolOptionsFrom({ ...options, timeouts }, boundRunTool))
      .catch((error: unknown) => {
        bug(error)
        return emptyToolbox(options.now())
      })
    return toolsPromise
  }
  const tools: ToolsCache = {
    get: () =>
      toolsPromise && options.now() - toolsAt < timeouts.toolsCache ? toolsPromise : resolveFresh(),
    refresh: resolveFresh,
  }

  const laneContext: LaneContext = {
    publish: (lane, rows, departures) => registry.publish(lane, rows, departures),
    setLane: (lane, patch) => registry.setLane(lane, patch),
    tools,
    runTool: boundRunTool,
    streamTool: boundStreamTool,
    limit,
    isActive: () => registry.isActive(),
    log: logLine,
    timeouts,
    get workDir() {
      return workDir
    },
    withTempDir,
    signal: shutdown.signal,
    options,
    now: options.now,
    childEnv: (extra) => childEnv(extra, options.env),
  }

  /** Every device on this network (§4.9): the bridge's own, whichever lanes run. */
  const lan = createLanScanner({
    options,
    timeouts,
    runTool: boundRunTool,
    streamTool: boundStreamTool,
    signal: shutdown.signal,
    now: options.now,
    log: logLine,
  })

  const lanes: LaneSet = {}
  if (factories.ios) lanes.ios = factories.ios(laneContext)
  if (factories.android) lanes.android = factories.android(laneContext)
  if (factories.simulators) lanes.simulators = factories.simulators(laneContext)
  const laneList = (): Lane[] =>
    [lanes.ios, lanes.android, lanes.simulators].filter(
      (lane): lane is NonNullable<typeof lane> => !!lane,
    )

  const sha256 = (): string => {
    if (selfHash === null) {
      try {
        const file = options.selfPath ?? fileURLToPath(import.meta.url)
        selfHash = createHash('sha256').update(readFileSync(file)).digest('hex')
      } catch {
        selfHash = ''
      }
    }
    return selfHash
  }

  const about = (): HelperAbout => ({
    name: NAME,
    version: VERSION,
    protocol: PROTOCOL,
    node: options.nodeVersion,
    openssl: options.opensslVersion,
    platform: options.platform,
    arch: options.arch,
    port: boundPort,
    startedAt,
    local: options.local,
    tokenPersistent: options.keepToken,
    flags: flagsOf(options),
    sha256: sha256(),
  })

  const health = (challenge: string | null = null): Health => {
    const features = [
      lanes.android ? 'android.start-server' : null,
      lanes.android ? 'android.connect' : null,
      lanes.android ? 'android.discover' : null,
      options.local ? 'local' : null,
      lanes.simulators ? 'simulators' : null,
      options.wifi ? 'wifi' : null,
      'lan.discover',
    ].filter((feature): feature is string => feature !== null)
    return {
      name: NAME,
      version: VERSION,
      protocol: PROTOCOL,
      features,
      port: boundPort,
      tokenId,
      tokenPersistent: options.keepToken,
      runId,
      startedAt,
      local: options.local,
      platform: `${options.platform}-${options.arch}`,
      sha256: sha256(),
      ...(challenge !== null && CHALLENGE_PATTERN.test(challenge)
        ? { proof: proofOf(token, boundPort, challenge) }
        : {}),
    }
  }

  const preflightContext: PreflightContext = {
    options,
    tools,
    lanes,
    lanesState: () => registry.lanes(),
    devices: () => registry.devices(),
    runTool: boundRunTool,
    timeouts,
    get workDir() {
      return workDir
    },
    signal: shutdown.signal,
    now: options.now,
    about,
    lan,
  }

  let preflightPromise: Promise<PreflightItem[]> | null = null
  const preflight = (opts: { refresh?: boolean } = {}): Promise<PreflightItem[]> => {
    if (opts.refresh || !preflightPromise) {
      preflightPromise = collectPreflight(preflightContext, {
        refresh: opts.refresh === true,
      }).catch((error: unknown) => {
        bug(error)
        return []
      })
    }
    return preflightPromise
  }

  /** GET /api/doctor, cached 30 s; ?refresh=1 starts over. */
  let doctorAt = 0
  let doctorPromise: Promise<DoctorReport> | null = null
  const doctor = (refresh: boolean): Promise<DoctorReport> => {
    if (!refresh && doctorPromise && options.now() - doctorAt < timeouts.doctorCache)
      return doctorPromise
    doctorAt = options.now()
    const report = doctorReport(preflightContext, { refresh })
    doctorPromise = report
    report.catch(() => {
      if (doctorPromise === report) doctorPromise = null
    })
    return report
  }

  const api = createApi({
    options,
    registry,
    lanes,
    tools,
    tokenId,
    bearer: createBearerCheck(token),
    health,
    doctor,
    local: options.local
      ? createLocalMode({
          upstream: options.upstream,
          timeouts,
          now: options.now,
          fetch: options.fetch,
        })
      : null,
    port: () => boundPort,
    pageConnected: createPageLog(logLine),
    log: logLine,
    bug,
    signal: shutdown.signal,
    lan,
  })

  async function listen(): Promise<{ port: number }> {
    if (server) throw new Error('This bridge is already listening.')
    await ensureWorkDir()
    const s = http.createServer((req, res) => api.handle(req, res))
    s.requestTimeout = timeouts.requestTimeout
    s.headersTimeout = timeouts.headersTimeout
    s.maxConnections = LIMITS.maxConnections
    /** No WebSocket, no CONNECT tunnel: an upgrade could otherwise outlive every check above. */
    s.on('upgrade', (_req, socket) => socket.destroy())
    s.on('connect', (_req, socket) => socket.destroy())
    s.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      /**
       * 127.0.0.1 only: never ::, never the LAN. The port is never switched silently: it is
       * part of the local page's origin and of every remembered pairing.
       */
      s.listen(options.port, '127.0.0.1', () => {
        s.off('error', reject)
        resolve()
      })
    })
    server = s
    boundPort = (s.address() as AddressInfo).port
    startedAt = options.now()
    for (const lane of laneList()) {
      try {
        lane.start()
      } catch (error) {
        bug(error)
      }
    }
    void preflight()
    return { port: boundPort }
  }

  /**
   * §1.8 in order: stop accepting, end every log stream with `shutdown`, abort the lanes'
   * work and let them close their sockets, TERM then KILL every tool group, close the
   * remaining connections, and remove the private folder. Idempotent.
   */
  function close(): Promise<void> {
    closing ??= (async () => {
      server?.close()
      api.endStreams('shutdown')
      shutdown.abort()
      lan.stop()
      await Promise.race([
        Promise.allSettled(laneList().map((lane) => Promise.resolve().then(() => lane.stop()))),
        sleep(timeouts.killGrace),
      ])
      await killAll(timeouts.killGrace, children)
      if (server && typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      await sleep(100)
      if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections()
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      unregisterExit()
    })()
    return closing
  }

  async function doctorCommand(write: (line: string) => void): Promise<void> {
    await ensureWorkDir()
    try {
      await printDoctor(preflightContext, write)
    } catch (error) {
      write(`The doctor stopped early: ${errorText(error)}`)
    } finally {
      shutdown.abort()
      await killAll(timeouts.killGrace, children)
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      unregisterExit()
    }
  }

  return {
    listen,
    close,
    get port() {
      return boundPort
    },
    token,
    tokenId,
    runId,
    registry,
    lanes,
    options,
    health,
    preflight,
    toolbox: () => tools.get(),
    doctor: doctorCommand,
  }
}
