import type {
  DetailResponse,
  HelperDevice,
  IosFacts,
  Lanes,
  LogSource,
  ScreenshotSource,
  SimFacts,
} from '../protocol'

/*
  The REAL helper, in this process, for the page's tests: device/agent/device-bridge.mjs (the
  built file testers download and run) started with createBridge() on port 0. Its three lanes
  are the helper suite's own scriptable fakes (_app/helper/test/fakes/lane.ts), and every
  other path is pointed at nothing by the suite's isolation() (_app/helper/test/harness.ts):
  no usbmuxd, no adb server, no Xcode, no network, no tool from this Mac. So a page test
  drives the helper's real HTTP pipeline (Host, Origin, token, proof, NDJSON, PNG checks)
  while deciding exactly which devices exist and what they answer.

  Test files only: importing this module registers the harness's afterAll cleanup in the
  importing test file (temporary folders), and it needs Node.

    const helper = await startRealHelper({ ios: { rows: [IPHONE] } })
    const client = createHelperClient(helper.apiBase, () => helper.token, { fetch: helper.fetch })
    …
    await helper.close()

  The modules are imported through computed URLs, so the page's typecheck never follows them
  into the helper's sources (which are typed against Node, not the DOM).
*/

/** What the built file exports that this needs. */
interface HelperModule {
  readonly createBridge: (input: object) => BridgeLike
  readonly tokenIdOf: (token: string) => string
  readonly proofOf: (token: string, port: number, challenge: string) => string
  readonly VERSION: string
  readonly PROTOCOL: number
}

interface BridgeLike {
  readonly listen: () => Promise<{ port: number }>
  readonly close: () => Promise<void>
  readonly token: string
  readonly tokenId: string
}

/** The LogSink a fake lane writes to (helper/src/types.ts). */
export interface LogSinkLike {
  readonly hello: (source: LogSource) => void
  readonly push: (lines: string[]) => boolean
  readonly drain: () => Promise<void>
  readonly notice: (text: string) => void
}

/** What the bridge hands a lane: enough to change rows and lane state at any time. */
export interface LaneContextLike {
  readonly publish: (lane: LaneName, rows: HelperDevice[]) => void
  readonly setLane: <K extends LaneName>(lane: K, patch: Partial<Lanes[K]>) => void
}

export type LaneName = 'ios' | 'android' | 'simulators'

/** A fake lane's script (helper/test/fakes/lane.ts): every operation optional. */
export interface LaneScript<K extends LaneName = LaneName> {
  /** Published at start. */
  readonly rows?: HelperDevice[]
  readonly state?: Partial<Lanes[K]>
  readonly detail?: (id: string, signal: AbortSignal) => Promise<DetailResponse>
  readonly screenshot?: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ png: Uint8Array; source: ScreenshotSource }>
  readonly logs?: (id: string, sink: LogSinkLike, signal: AbortSignal) => Promise<void>
  readonly retry?: (id: string, signal: AbortSignal) => Promise<void>
  readonly rescan?: (signal: AbortSignal | undefined) => Promise<void>
  readonly startServer?: (signal: AbortSignal) => Promise<void>
}

interface FakeLane {
  readonly factory: unknown
  readonly ctx: () => LaneContextLike
  readonly calls: Array<{ op: string; id?: string }>
}

interface LaneModule {
  readonly fakeIosLane: (script: object) => FakeLane
  readonly fakeAndroidLane: (script: object) => FakeLane
  readonly fakeSimulatorLane: (script: object) => FakeLane
}

interface HarnessModule {
  readonly isolation: (input: object) => Promise<{ input: object }>
  readonly toolbox: () => object
  readonly tinyPng: () => Uint8Array
}

interface DevicesModule {
  readonly IPHONE: HelperDevice
  readonly PIXEL: HelperDevice
  readonly SIMULATOR: HelperDevice
}

const at = (path: string) => new URL(path, import.meta.url).href

/* The shapes of modules this file deliberately keeps out of the page's typecheck (see
   above), written out by hand. */
const helper = (await import(
  /* @vite-ignore */ at('../../../../../../device/agent/device-bridge.mjs')
)) as HelperModule
const lanes = (await import(
  /* @vite-ignore */ at('../../../../../helper/test/fakes/lane.ts')
)) as LaneModule
const harness = (await import(
  /* @vite-ignore */ at('../../../../../helper/test/harness.ts')
)) as HarnessModule
const fakeDevices = (await import(
  /* @vite-ignore */ at('../../../../../helper/test/fakes/devices.ts')
)) as DevicesModule

/** The rows of the spec's real-device checklist: an iPhone 12 Pro, a Pixel 9, a simulator. */
export const IPHONE: HelperDevice = fakeDevices.IPHONE
export const PIXEL: HelperDevice = fakeDevices.PIXEL
export const SIMULATOR: HelperDevice = fakeDevices.SIMULATOR

/** The built helper's version and protocol, for assertions. */
export const HELPER_VERSION = helper.VERSION
export const HELPER_PROTOCOL = helper.PROTOCOL
/** The helper's own tokenIdOf and proofOf (node:crypto), to check the page's against. */
export const helperTokenIdOf = helper.tokenIdOf
export const helperProofOf = helper.proofOf

/** The origin the hosted page sends; the helper allows it. */
export const SITE_ORIGIN = 'https://bauloc.github.io'

/** IosFacts for a row, as a trusted iPhone over lockdown answers (whitelisted keys only). */
export function iosFactsFor(device: HelperDevice): IosFacts {
  return {
    udid: device.id,
    connection: device.connection === 'network' ? 'network' : 'usb',
    source: 'lockdown',
    device: {
      DeviceName: device.name,
      DeviceClass: 'iPhone',
      ProductType: device.modelId,
      ProductVersion: device.osVersion,
      BuildVersion: '24A437',
      SerialNumber: 'F2LZZ0FAKE01',
      HardwareModel: 'D53pAP',
      ModelNumber: 'MGLQ3',
      RegionInfo: 'LL/A',
      CPUArchitecture: 'arm64e',
      TimeZone: 'Asia/Ho_Chi_Minh',
      UniqueChipID: '18446744073709550001',
    },
    battery: { BatteryCurrentCapacity: 87, BatteryIsCharging: true, ExternalConnected: true },
    disk: { TotalDiskCapacity: 256_000_000_000, TotalDataAvailable: 98_765_432_100 },
    international: { Language: 'en', Locale: 'en_VN' },
    developerMode: true,
    locked: false,
    withheld: [],
  }
}

/** SimFacts for a simulator row. */
export function simFactsFor(device: HelperDevice): SimFacts {
  return {
    udid: device.id,
    name: device.name,
    deviceType: { name: device.model || device.name, modelIdentifier: device.modelId },
    runtime: { name: `iOS ${device.osVersion}`, version: device.osVersion, build: '24A5300a' },
    state: 'Booted',
    dataPathSize: 1_234_567_890,
  }
}

const EMPTY_OUTPUTS = { getprop: '', wmSize: '', wmDensity: '', battery: '', df: '', androidId: '' }

/** Detail as each kind of row answers it, unless a script says otherwise. */
function defaultDetail(rows: () => HelperDevice[]) {
  return (id: string): Promise<DetailResponse> => {
    const row = rows().find((d) => d.id === id)
    if (row?.platform === 'ios' && row.connection === 'simulator') {
      return Promise.resolve({ platform: 'ios', kind: 'simulator', facts: simFactsFor(row) })
    }
    if (row?.platform === 'ios') {
      return Promise.resolve({ platform: 'ios', kind: 'ios', facts: iosFactsFor(row) })
    }
    return Promise.resolve({
      platform: 'android',
      kind: 'android',
      serial: id,
      connection: row?.connection ?? 'usb',
      outputs: EMPTY_OUTPUTS,
    })
  }
}

export interface RealHelperOptions {
  readonly ios?: LaneScript<'ios'>
  readonly android?: LaneScript<'android'>
  /** null: the helper runs without --simulators. */
  readonly simulators?: LaneScript<'simulators'> | null
  /** Allow the dev origins (localhost:7360…), as `--dev` does. */
  readonly dev?: boolean
  /** A fixed token instead of a fresh one. */
  readonly token?: string
}

export interface RealHelper {
  readonly port: number
  readonly token: string
  readonly tokenId: string
  /** `http://127.0.0.1:<port>` */
  readonly apiBase: string
  /** fetch with the hosted page's Origin, as a browser on bauloc.github.io sends it. */
  readonly fetch: typeof fetch
  /** Every request this fetch made: url and the Authorization header (null when absent). */
  readonly requests: Array<{ url: string; method: string; authorization: string | null }>
  /** Replace a lane's rows, as a hot-plug does; the helper bumps `rev`. */
  readonly publish: (lane: LaneName, rows: HelperDevice[]) => void
  readonly setLane: <K extends LaneName>(lane: K, patch: Partial<Lanes[K]>) => void
  /** Which lane operations the helper called, in order. */
  readonly calls: (lane: LaneName) => Array<{ op: string; id?: string }>
  /** Stop the helper (Ctrl+C): open log streams end with `shutdown`, the port closes. */
  readonly close: () => Promise<void>
}

/** Starts the built helper on a free port with fake lanes. Close it in afterEach/afterAll. */
export async function startRealHelper(opts: RealHelperOptions = {}): Promise<RealHelper> {
  const rows: Record<LaneName, HelperDevice[]> = {
    ios: opts.ios?.rows ?? [],
    android: opts.android?.rows ?? [],
    simulators: opts.simulators?.rows ?? [],
  }
  const all = () => [...rows.ios, ...rows.android, ...rows.simulators]
  const withDefaults = (script: LaneScript | undefined) => {
    const shot = script?.screenshot
    return {
      detail: defaultDetail(all),
      ...script,
      // The helper's PNG checks use Buffer methods.
      ...(shot
        ? {
            screenshot: async (id: string, signal: AbortSignal) => {
              const { png, source } = await shot(id, signal)
              return { png: Buffer.from(png), source }
            },
          }
        : {}),
    }
  }
  const ios = lanes.fakeIosLane(withDefaults(opts.ios))
  const android = lanes.fakeAndroidLane(withDefaults(opts.android))
  const simulators =
    opts.simulators === null ? null : lanes.fakeSimulatorLane(withDefaults(opts.simulators))
  const fakes: Record<LaneName, FakeLane | null> = { ios, android, simulators }

  const { input } = await harness.isolation({
    ...(opts.token ? { token: opts.token } : {}),
    dev: opts.dev ?? false,
    // Hosted mode: the helper doesn't serve /device/ (its upstream is unreachable here anyway).
    local: false,
    simulators: simulators !== null,
    // A fixed, empty toolbox: discovery never runs a tool, even a fake one.
    resolveTools: () => Promise.resolve(harness.toolbox()),
    lanes: { ios: ios.factory, android: android.factory, simulators: simulators?.factory ?? null },
  })
  const bridge = helper.createBridge(input)
  const { port } = await bridge.listen()
  const apiBase = `http://127.0.0.1:${String(port)}`

  const requests: RealHelper['requests'] = []
  const hostedFetch: typeof fetch = (resource, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Origin', SITE_ORIGIN)
    const url =
      typeof resource === 'string'
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url
    requests.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
    })
    return fetch(resource, { ...init, headers })
  }

  const lane = (name: LaneName): FakeLane => {
    const fake = fakes[name]
    if (!fake) throw new Error(`The ${name} lane is off in this helper.`)
    return fake
  }

  return {
    port,
    token: bridge.token,
    tokenId: bridge.tokenId,
    apiBase,
    fetch: hostedFetch,
    requests,
    publish(name, next) {
      rows[name] = next
      lane(name).ctx().publish(name, next)
    },
    setLane(name, patch) {
      lane(name).ctx().setLane(name, patch)
    },
    calls: (name) => lane(name).calls,
    close: () => bridge.close(),
  }
}

/** A valid 1×1 PNG, what every fake screenshot returns. */
export const tinyPng = (): Uint8Array => harness.tinyPng()
