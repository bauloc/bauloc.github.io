import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ID, LIMITS } from './constants'
import { ToolError } from './process'
import type { SimctlInfo } from './tools'
import type { HelperDevice, Lane, LaneContext, SimFacts } from './types'
import { HelperError, clean, errorText, singleFlight } from './util'

/**
 * §8 Simulator lane: booted iOS Simulators through simctl, only with --simulators (§5).
 *
 * Why it exists: it is the whole path (list → detail → screenshot → logs) on a Mac with no
 * phone at hand. Why it is off by default: a Mac often has several simulators booted, and
 * listing them would defeat the page's "one ready device" auto-select.
 *
 * Read-only by construction. The lane lists, screenshots and streams the log of simulators
 * that are ALREADY booted; it never boots, shuts down, erases or installs anything, and the
 * only simctl subcommands it runs are `list`, `io <udid> screenshot` and `spawn <udid> log
 * stream` (SIMCTL_COMMANDS). It runs the real simctl binary that resolveSimctl() found behind
 * its first-launch gate (§1.5), never the `xcrun`/Xcode wrapper that could start a first
 * launch, with DEVELOPER_DIR pointing at the same Xcode.
 *
 * The traps from the research, each handled where it bites:
 * - `io screenshot` on a simulator that is not booted hangs forever: a fresh `Booted` check
 *   first, and a hard timeout anyway;
 * - `io screenshot -` writes a file literally named `-` (and /dev/stdout is refused): always a
 *   file in a private temp folder, which is also the tool's working directory;
 * - `log stream` prints a column header first and `getpwuid_r…` noise on stderr: both dropped;
 * - simctl's own exit codes: 148 is an unknown device, 149 one that is not booted.
 */

/** Every simctl subcommand this lane runs (the argv prefix before any udid or path). */
export const SIMCTL_COMMANDS = [
  ['list', '-j', 'devices', 'booted'],
  ['list', '-j', 'runtimes'],
  ['list', '-j', 'devicetypes'],
  ['io', '<udid>', 'screenshot'],
  ['spawn', '<udid>', 'log', 'stream'],
] as const

/** Only iOS simulators: watchOS, tvOS and visionOS ones are not phones the page can show. */
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/

/** The column header `log stream --style compact` prints before the first line. */
const LOG_HEADER = /^Timestamp\s+Ty\s+Process\[PID:TID\]\s*$/

/** One booted (or booting) simulator, joined with its runtime and device type. */
export interface SimEntry {
  udid: string
  name: string
  state: 'Booted' | 'Booting'
  runtime: { identifier: string; name: string; version: string; build: string }
  deviceType: { identifier: string; name: string; modelIdentifier: string }
  dataPathSize?: number
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number = LIMITS.field): string =>
  typeof value === 'string' ? clean(value, max) : ''

/** `{runtimes:[…]}` or `{devicetypes:[…]}` → identifier → entry. */
function byIdentifier(list: unknown, key: string): Map<string, Json> {
  const out = new Map<string, Json>()
  const items = isObject(list) ? list[key] : undefined
  if (!Array.isArray(items)) return out
  for (const item of items) {
    if (isObject(item) && typeof item.identifier === 'string') out.set(item.identifier, item)
  }
  return out
}

/**
 * `simctl list -j devices` joined with `list -j runtimes` and `list -j devicetypes`: the
 * booted and booting iOS simulators. Runtimes or device types it cannot find (a stale cache,
 * a runtime being deleted) leave their fields to what the identifiers say. Only the fields
 * in SimEntry are read: dataPath and logPath carry the user's name and are never kept.
 */
export function simEntries(devices: unknown, runtimes: unknown, devicetypes: unknown): SimEntry[] {
  const runtimeIndex = byIdentifier(runtimes, 'runtimes')
  const typeIndex = byIdentifier(devicetypes, 'devicetypes')
  const groups = isObject(devices) && isObject(devices.devices) ? devices.devices : {}
  const out: SimEntry[] = []
  for (const [identifier, list] of Object.entries(groups)) {
    const match = IOS_RUNTIME.exec(identifier)
    if (!match || !Array.isArray(list)) continue
    const runtime = runtimeIndex.get(identifier)
    if (runtime && typeof runtime.platform === 'string' && runtime.platform !== 'iOS') continue
    const fromId = [match[1], match[2], match[3]].filter((part) => part !== undefined).join('.')
    for (const device of list) {
      if (!isObject(device)) continue
      const state = device.state
      if (state !== 'Booted' && state !== 'Booting') continue
      const udid = typeof device.udid === 'string' ? device.udid : ''
      if (!ID.sim.test(udid)) continue
      const typeId = text(device.deviceTypeIdentifier, 200)
      const type = typeIndex.get(typeId)
      const size = device.dataPathSize
      out.push({
        udid,
        name: text(device.name, LIMITS.name),
        state,
        runtime: {
          identifier,
          name: text(runtime?.name) || `iOS ${fromId}`,
          version: text(runtime?.version) || fromId,
          build: text(runtime?.buildversion),
        },
        deviceType: {
          identifier: typeId,
          name: text(type?.name),
          modelIdentifier: text(type?.modelIdentifier),
        },
        ...(typeof size === 'number' && Number.isFinite(size) && size >= 0
          ? { dataPathSize: size }
          : {}),
      })
    }
  }
  return out
}

/** One simulator as the page sees it (§5 Row). */
export function simulatorRow(entry: SimEntry): HelperDevice {
  const ready = entry.state === 'Booted'
  return {
    id: entry.udid,
    platform: 'ios',
    connection: 'simulator',
    state: ready ? 'ready' : 'connecting',
    name: entry.name,
    model: entry.deviceType.name,
    modelId: entry.deviceType.modelIdentifier,
    osVersion: entry.runtime.version,
    blockers: [],
    capabilities: { screenshot: ready, identifiers: ready, logs: ready, install: false },
  }
}

/** §5: the three lists → rows. */
export function parseSimctlList(
  devices: unknown,
  runtimes: unknown,
  devicetypes: unknown,
): HelperDevice[] {
  return simEntries(devices, runtimes, devicetypes).map(simulatorRow)
}

/** The facts the detail pane shows; nothing that names the Mac's user. */
export function simFacts(entry: SimEntry): SimFacts {
  return {
    udid: entry.udid,
    name: entry.name,
    deviceType: { name: entry.deviceType.name, modelIdentifier: entry.deviceType.modelIdentifier },
    runtime: {
      name: entry.runtime.name,
      version: entry.runtime.version,
      build: entry.runtime.build,
    },
    state: entry.state,
    ...(entry.dataPathSize !== undefined ? { dataPathSize: entry.dataPathSize } : {}),
  }
}

/** Why the lane cannot run, in words that follow "Simulators  unavailable · " in the banner. */
export function simctlReason(info: SimctlInfo): string {
  switch (info.state) {
    case 'needs-first-launch':
      return 'Xcode must finish setting up before simulators work: open Xcode once'
    case 'not-selected':
      return 'simulators need the Xcode app selected (see --doctor)'
    default:
      return 'simulators need Xcode'
  }
}

/** simctl's own exit codes for "no such device" and "not booted" [V]. */
function simctlError(error: unknown): unknown {
  if (error instanceof ToolError && error.reason === 'exit') {
    if (error.code === 148) {
      return new HelperError('DEVICE_NOT_FOUND', 404, 'The simulator is no longer there.')
    }
    if (error.code === 149) {
      return new HelperError('DEVICE_NOT_READY', 409, 'The simulator is not booted.', {
        state: 'offline',
        blockers: [],
      })
    }
  }
  return error
}

/** What preflight (§12) reads from the simulator lane. */
export interface SimulatorLaneFacts {
  simctl: string | null
  booted: number
}

/** Cadences of §5; tests shorten them. */
export interface SimulatorCadence {
  /** `list -j devices booted` while the page is active. */
  listMs: number
  /** How long runtimes and device types are reused (rescan refreshes them). */
  catalogMs: number
}

export const SIMULATOR_CADENCE: SimulatorCadence = { listMs: 5_000, catalogMs: 10 * 60_000 }

/** The lane (§5). `cadence` exists for tests. */
export function createSimulatorLane(
  ctx: LaneContext,
  cadence: Partial<SimulatorCadence> = {},
): Lane<SimulatorLaneFacts> {
  const pace: SimulatorCadence = { ...SIMULATOR_CADENCE, ...cadence }
  const { timeouts } = ctx
  const flights = singleFlight()
  let entries: SimEntry[] = []
  let simctl: SimctlInfo | null = null
  let catalog: { runtimes: unknown; devicetypes: unknown; at: number } | null = null
  let failing = false
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  /** The real binary and its environment, or null (the lane is unavailable, and says why). */
  const binary = async (): Promise<{ file: string; env: NodeJS.ProcessEnv } | null> => {
    const toolbox = await ctx.tools.get()
    simctl = toolbox.simctl
    if (simctl.state !== 'ready' || !simctl.simctl) return null
    return {
      file: simctl.simctl,
      env: ctx.childEnv(simctl.devDir ? { DEVELOPER_DIR: simctl.devDir } : {}),
    }
  }

  const requireBinary = async (): Promise<{ file: string; env: NodeJS.ProcessEnv }> => {
    const bin = await binary()
    if (bin) return bin
    throw new HelperError('DEVICE_NOT_FOUND', 404, 'Simulators are unavailable right now.')
  }

  const json = async (
    bin: { file: string; env: NodeJS.ProcessEnv },
    argv: readonly string[],
  ): Promise<unknown> => {
    const { stdout } = await ctx.runTool(bin.file, argv, {
      timeoutMs: timeouts.simctlList,
      env: bin.env,
      signal: ctx.signal,
    })
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new HelperError('TOOL_FAILED', 502, 'simctl printed something that is not JSON.')
    }
  }

  const unavailable = (reason: string): void => {
    entries = []
    ctx.publish('simulators', [])
    ctx.setLane('simulators', { status: 'unavailable', booted: 0, reason })
  }

  /**
   * Re-list (single-flight, under the lane's own signal: one caller leaving must not cancel
   * the list another is waiting for). A failure keeps the rows as they are, so one slow
   * simctl does not end every log stream, and says so once in the terminal.
   */
  const list = (refreshCatalog = false): Promise<void> =>
    flights.run(refreshCatalog ? 'list+catalog' : 'list', async () => {
      if (stopped) return
      const bin = await binary()
      if (stopped) return
      if (!bin) return unavailable(simctl ? simctlReason(simctl) : 'simulators need Xcode')
      try {
        const stale = !catalog || refreshCatalog || ctx.now() - catalog.at > pace.catalogMs
        const [devices, runtimes, devicetypes] = await Promise.all([
          json(bin, SIMCTL_COMMANDS[0]),
          stale ? json(bin, SIMCTL_COMMANDS[1]) : Promise.resolve(catalog?.runtimes),
          stale ? json(bin, SIMCTL_COMMANDS[2]) : Promise.resolve(catalog?.devicetypes),
        ])
        if (stale) catalog = { runtimes, devicetypes, at: ctx.now() }
        if (stopped) return
        entries = simEntries(devices, runtimes, devicetypes)
        failing = false
        ctx.publish('simulators', entries.map(simulatorRow))
        ctx.setLane('simulators', {
          status: 'ok',
          booted: entries.filter((e) => e.state === 'Booted').length,
          reason: undefined,
        })
      } catch (error) {
        if (stopped || ctx.signal.aborted) return
        if (error instanceof ToolError && error.reason === 'not-found') {
          return unavailable('simctl is missing from the selected Xcode')
        }
        if (!failing) ctx.log(`simctl list failed: ${clean(errorText(error), 200)}`)
        failing = true
      }
    })

  const entryOf = (id: string): SimEntry => {
    const entry = entries.find((e) => e.udid === id)
    if (!entry) throw new HelperError('DEVICE_NOT_FOUND', 404, 'The simulator is no longer there.')
    return entry
  }

  /** Booted right now, by a fresh list: `io screenshot` on any other state hangs forever. */
  const requireBooted = async (id: string): Promise<SimEntry> => {
    await list()
    const entry = entryOf(id)
    if (entry.state !== 'Booted') {
      throw new HelperError('DEVICE_NOT_READY', 409, 'The simulator is still booting.', {
        state: 'connecting',
        blockers: [],
      })
    }
    return entry
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      /** Only while a page is looking: an idle helper forks nothing. */
      void (ctx.isActive() ? list() : Promise.resolve()).finally(schedule)
    }, pace.listMs)
    timer.unref()
  }

  return {
    name: 'simulators',

    start() {
      void list(true).finally(schedule)
    },

    async stop() {
      stopped = true
      clearTimeout(timer)
      await Promise.resolve()
    },

    rescan: () => list(true),

    detail(id) {
      /** From the last list: the row is ready (the HTTP layer checked), so it is fresh enough. */
      return Promise.resolve().then(() => ({
        platform: 'ios' as const,
        kind: 'simulator' as const,
        facts: simFacts(entryOf(id)),
      }))
    },

    async screenshot(id, signal) {
      const bin = await requireBinary()
      const entry = await requireBooted(id)
      return ctx.withTempDir(async (dir) => {
        /** Never `-`: simctl writes a file named `-` instead of stdout. */
        const file = path.join(dir, 'shot.png')
        await ctx
          .runTool(bin.file, ['io', entry.udid, 'screenshot', '--type=png', file], {
            timeoutMs: timeouts.simctlScreenshot,
            cwd: dir,
            env: bin.env,
            signal,
          })
          .catch((error: unknown) => {
            throw simctlError(error)
          })
        const size = await stat(file).then(
          (s) => s.size,
          () => -1,
        )
        if (size < 0) throw new HelperError('TOOL_FAILED', 502, 'simctl saved no screenshot.')
        if (size > LIMITS.png) {
          throw new HelperError(
            'TOOL_FAILED',
            502,
            'The screenshot is larger than the helper accepts.',
          )
        }
        return { png: await readFile(file), source: 'simctl' as const }
      })
    },

    async logs(id, sink, signal) {
      const bin = await requireBinary()
      const entry = entryOf(id)
      if (entry.state !== 'Booted') {
        throw new HelperError('DEVICE_NOT_READY', 409, 'The simulator is still booting.', {
          state: 'connecting',
          blockers: [],
        })
      }
      let said = false
      let waiting = false
      let silent = false
      const handle = ctx.streamTool(
        bin.file,
        ['spawn', entry.udid, 'log', 'stream', '--style', 'compact', '--level', 'info'],
        {
          signal,
          env: bin.env,
          onLines(lines) {
            if (!said) {
              said = true
              clearTimeout(firstByte)
              sink.hello('simctl')
            }
            const kept = lines.filter((line) => !LOG_HEADER.test(line))
            if (!kept.length || sink.push(kept) || waiting) return
            /** Back-pressure: stop reading the tool until the page has taken what it has. */
            waiting = true
            handle.pause()
            void sink.drain().then(() => {
              waiting = false
              handle.resume()
            })
          },
          /** No onStderrLines: stderr (`getpwuid_r did not find…`) never reaches the page. */
        },
      )
      /** The header arrives at once; total silence means the stream never started. */
      const firstByte = setTimeout(() => {
        silent = true
        handle.kill()
      }, timeouts.logFirstByte)
      let result
      try {
        result = await handle.done
      } finally {
        clearTimeout(firstByte)
      }
      if (signal.aborted) return
      if (!said) {
        if (silent) {
          throw new HelperError('LOGS_UNAVAILABLE', 503, 'The simulator log did not start.')
        }
        const known = simctlError(
          new ToolError('exit', bin.file, { code: result.code, stderr: result.stderr }),
        )
        if (known instanceof HelperError) throw known
        const why = clean(
          result.stderr
            .split('\n')
            .filter((line) => line && !line.startsWith('getpwuid_r'))
            .join(' '),
          500,
        )
        throw new HelperError('TOOL_FAILED', 502, why || 'simctl could not start the log stream.')
      }
      /**
       * The stream ended by itself: the simulator most likely shut down. Re-list now, so its
       * row goes and the stream ends as `device-gone` rather than a plain `eof`.
       */
      await list()
    },

    async retry() {
      await list()
    },

    facts: () => ({
      simctl: simctl?.simctl ?? null,
      booted: entries.filter((e) => e.state === 'Booted').length,
    }),
  }
}
