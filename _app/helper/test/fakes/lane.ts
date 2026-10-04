/*
  Scriptable lanes for exercising the core (HTTP, registry, streams, lifecycle) without any
  platform code: createBridge({ lanes: { ios: fakeIosLane({...}).factory } }).

  Each operation defaults to something sensible (a detail, a tiny PNG, a short log), and a
  test overrides only what it is about. The context the bridge handed the lane is kept, so a
  test can publish rows or set lane state at any moment, exactly as a real lane would.
*/
import { networkSerial, type AndroidLaneFacts } from '../../src/android-lane'
import type { IosLaneFacts } from '../../src/ios-lane'
import type { SimulatorLaneFacts } from '../../src/simulator-lane'
import type {
  AndroidConnectResult,
  AndroidLane,
  DetailResponse,
  HelperDevice,
  Lane,
  LaneContext,
  LaneName,
  Lanes,
  LogSink,
  ScreenshotSource,
} from '../../src/types'
import { tinyPng } from '../harness'

export interface FakeLaneScript<K extends LaneName> {
  /** Published at start(). */
  rows?: HelperDevice[]
  /** Set at start(), as a real lane reports its state. */
  state?: Partial<Lanes[K]>
  detail?: (id: string, signal: AbortSignal, ctx: LaneContext) => Promise<DetailResponse>
  screenshot?: (
    id: string,
    signal: AbortSignal,
    ctx: LaneContext,
  ) => Promise<{ png: Buffer; source: ScreenshotSource }>
  logs?: (id: string, sink: LogSink, signal: AbortSignal, ctx: LaneContext) => Promise<void>
  retry?: (id: string, signal: AbortSignal, ctx: LaneContext) => Promise<void>
  rescan?: (signal: AbortSignal | undefined, ctx: LaneContext) => Promise<void>
  stop?: () => Promise<void>
  startServer?: (signal: AbortSignal, ctx: LaneContext) => Promise<void>
  /**
   * Wi-Fi (§4.7). By default a connect, a pairing and a disconnect succeed with adb's words
   * and publish nothing: a script that wants rows publishes them through `ctx`.
   */
  connectNetwork?: (
    target: { host: string; port: number },
    signal: AbortSignal,
    ctx: LaneContext,
  ) => Promise<Omit<AndroidConnectResult, 'device'>>
  pairNetwork?: (
    target: { host: string; port: number; code: string },
    signal: AbortSignal,
    ctx: LaneContext,
  ) => Promise<{ message: string }>
  disconnectNetwork?: (
    serial: string,
    signal: AbortSignal,
    ctx: LaneContext,
  ) => Promise<{ message: string }>
}

export interface FakeLane<L extends Lane> {
  readonly factory: (ctx: LaneContext) => L
  /** The context the bridge created the lane with (throws before createBridge). */
  readonly ctx: () => LaneContext
  /** Every operation the core called, in order. */
  readonly calls: Array<{ op: string; id?: string }>
}

function build<K extends LaneName, F>(
  name: K,
  script: FakeLaneScript<K>,
  facts: () => F,
): FakeLane<Lane<F> & Omit<AndroidLane, keyof Lane>> {
  let context: LaneContext | null = null
  const calls: Array<{ op: string; id?: string }> = []
  const ctx = (): LaneContext => {
    if (!context) throw new Error('The fake lane has not been created yet.')
    return context
  }
  return {
    calls,
    ctx,
    factory(created) {
      context = created
      return {
        name,
        start() {
          calls.push({ op: 'start' })
          if (script.state) created.setLane(name, script.state)
          if (script.rows) created.publish(name, script.rows)
        },
        stop() {
          calls.push({ op: 'stop' })
          return script.stop ? script.stop() : Promise.resolve()
        },
        rescan(opts) {
          calls.push({ op: 'rescan' })
          return script.rescan ? script.rescan(opts?.signal, created) : Promise.resolve()
        },
        detail(id, signal) {
          calls.push({ op: 'detail', id })
          if (script.detail) return script.detail(id, signal, created)
          return Promise.resolve({
            platform: 'android',
            kind: 'android',
            serial: id,
            connection: 'usb',
            outputs: { getprop: '', wmSize: '', wmDensity: '', battery: '', df: '', androidId: '' },
          })
        },
        screenshot(id, signal) {
          calls.push({ op: 'screenshot', id })
          if (script.screenshot) return script.screenshot(id, signal, created)
          return Promise.resolve({ png: tinyPng(), source: 'adb' })
        },
        logs(id, sink, signal) {
          calls.push({ op: 'logs', id })
          if (script.logs) return script.logs(id, sink, signal, created)
          sink.hello('logcat')
          sink.push(['first line', 'second line'])
          return Promise.resolve()
        },
        retry(id, signal) {
          calls.push({ op: 'retry', id })
          return script.retry ? script.retry(id, signal, created) : Promise.resolve()
        },
        startServer(signal) {
          calls.push({ op: 'startServer' })
          return script.startServer ? script.startServer(signal, created) : Promise.resolve()
        },
        connectNetwork(target, signal) {
          const serial = networkSerial(target.host, target.port)
          calls.push({ op: 'connectNetwork', id: serial })
          if (script.connectNetwork) return script.connectNetwork(target, signal, created)
          return Promise.resolve({
            result: 'connected',
            serial,
            message: `connected to ${serial}`,
          })
        },
        pairNetwork(target, signal) {
          const address = networkSerial(target.host, target.port)
          calls.push({ op: 'pairNetwork', id: address })
          if (script.pairNetwork) return script.pairNetwork(target, signal, created)
          return Promise.resolve({
            message: `Successfully paired to ${address} [guid=adb-FAKE0001-AbCdEf]`,
          })
        },
        disconnectNetwork(serial, signal) {
          calls.push({ op: 'disconnectNetwork', id: serial })
          if (script.disconnectNetwork) return script.disconnectNetwork(serial, signal, created)
          return Promise.resolve({ message: `disconnected ${serial}` })
        },
        facts,
      }
    },
  }
}

export function fakeIosLane(script: FakeLaneScript<'ios'> = {}): FakeLane<Lane<IosLaneFacts>> {
  const lane = build('ios', { state: { status: 'ok' }, ...script }, () => ({
    usbmuxd: 'ok' as const,
    tlsFailures: [],
    devices: script.rows?.length ?? 0,
  }))
  return lane
}

export function fakeAndroidLane(
  script: FakeLaneScript<'android'> = {},
  facts: Partial<AndroidLaneFacts> = {},
): FakeLane<AndroidLane> {
  return build(
    'android',
    { state: { status: 'ok', adb: 'found', serverProtocol: 41 }, ...script },
    (): AndroidLaneFacts => ({
      adb: null,
      version: null,
      server: 'running',
      serverProtocol: 41,
      devices: [],
      startedByHelper: false,
      ...facts,
    }),
  )
}

export function fakeSimulatorLane(
  script: FakeLaneScript<'simulators'> = {},
): FakeLane<Lane<SimulatorLaneFacts>> {
  return build(
    'simulators',
    { state: { status: 'ok', booted: script.rows?.length ?? 0 }, ...script },
    (): SimulatorLaneFacts => ({ simctl: null, booted: script.rows?.length ?? 0 }),
  )
}
