/*
  WP3, Android (§4, §9.2 android row): the adb host-protocol client and the lane, against the
  fake adb server in this process. No adb binary runs here except the fake `adb` script, and
  that only for start-server, so the tests also prove nothing else is ever executed.
*/
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  ADB_HOST_NEVER,
  ADB_HOST_SERVICES,
  ADB_NETWORK_PORT,
  adbConnection,
  adbFailError,
  androidRow,
  assertAdbService,
  assertConnectService,
  assertDisconnectService,
  assertPairService,
  createAdbClient,
  createAndroidLane,
  encodeAdbRequest,
  isAdbRefusal,
  isDisconnectableSerial,
  isNetworkSerial,
  type HostLookup,
  mapAdbState,
  networkFailureLines,
  networkSerial,
  parseConnectReply,
  parseDevicesL,
  parseDisconnectReply,
  parseNetworkHost,
  parseNetworkPort,
  parsePairReply,
  parsePairingCode,
  startAdbServer,
  type AndroidCadence,
} from '../src/android-lane'
import { createBridge } from '../src/bridge'
import { ADB_DETAIL, ADB_EXEC, TIMEOUTS, isDeviceId } from '../src/constants'
import { liveChildren } from '../src/process'
import type { DoctorReport, ErrorBody, HelperDevice, Snapshot, Timeouts } from '../src/types'
import { HelperError, sleep } from '../src/util'
import {
  createFakeAdbServer,
  endlessLogcat,
  pixel,
  shield,
  type FakeAdbDevice,
  type FakeAdbServer,
} from './fakes/adb-server'
import {
  freePort,
  isStream,
  isolation,
  onCleanup,
  openStream,
  request,
  startBridge,
  tinyPng,
  toolbox,
  until,
  type Stream,
} from './harness'

const PIXEL_9 = JSON.parse(
  readFileSync(new URL('./fixtures/pixel-9.json', import.meta.url), 'utf8'),
) as { serial: string; outputs: Record<string, string> }

const FAST: Partial<Timeouts> = {
  adbConnect: 1_000,
  adbRequest: 1_000,
  adbExec: 1_500,
  adbScreencap: 2_000,
  adbStartPoll: 3_000,
  adbNetworkConnect: 800,
  adbPair: 800,
  retry: 5_000,
  logHello: 2_000,
}
const TIMEOUTS_FAST: Timeouts = { ...TIMEOUTS, ...FAST }

/** No name resolves unless a test says so: the tests never ask the real network. */
const noNames: HostLookup = (name) => Promise.reject(new Error(`getaddrinfo ENOTFOUND ${name}`))

const CADENCE: Partial<AndroidCadence> = {
  presenceMs: 100,
  pollMs: 100,
  identityGraceMs: 600,
  retryWaitMs: 2_000,
  goneWaitMs: 500,
  startPollMs: 50,
}

/** What a Pixel 9 answers, as adbd does over exec: (stderr mixed in, no exit code). */
function pixelExec(server: FakeAdbServer, extra: Record<string, string> = {}): void {
  const byCommand: Record<string, string> = {
    ...Object.fromEntries(ADB_DETAIL.map(([key, cmd]) => [cmd, PIXEL_9.outputs[key] ?? ''])),
    'getprop ro.product.model': 'Pixel 9\n',
    'getprop ro.product.device': 'tokay\n',
    'getprop ro.build.version.release': '17\n',
    ...extra,
  }
  server.exec = (_serial, cmd) => {
    if (cmd === 'screencap -p') {
      return Buffer.concat([
        Buffer.from('[Warning] Multiple displays were found, but no display id was specified!\n'),
        tinyPng(),
        Buffer.from('trailing text\n'),
      ])
    }
    if (cmd === 'logcat -v threadtime -T 200') return endlessLogcat()
    return byCommand[cmd]
  }
}

async function fakeServer(port?: number): Promise<FakeAdbServer> {
  const server = await createFakeAdbServer({ port })
  onCleanup(() => server.close())
  return server
}

interface AndroidRun {
  port: number
  auth: Record<string, string>
  logs: string[]
  adbPort: number
  adbPath: string
  calls: () => Array<{ name: string; argv: string[] }>
  snapshot: () => Promise<Snapshot>
  bridge: ReturnType<typeof createBridge>
}

/** A bridge with the REAL Android lane, a fake `adb` on its PATH and `adbPort` as given. */
async function startAndroid(opts: {
  adbPort: number
  /** Whether the tools find adb; a function is asked on every resolve. */
  adb?: boolean | (() => boolean)
  lookup?: HostLookup
  timeouts?: Partial<Timeouts>
  platform?: NodeJS.Platform
}): Promise<AndroidRun> {
  const iso = await isolation({ adbPort: opts.adbPort, timeouts: { ...FAST, ...opts.timeouts } })
  const adbPath = iso.bin.tool(
    'adb',
    `case "$1" in
  version) printf 'Android Debug Bridge version 1.0.41\\nVersion 36.0.0-13206524\\n' ;;
  start-server) printf '%s' "$ANDROID_ADB_SERVER_PORT" > "$FAKE_STATE/adb-port" ;;
esac
exit 0`,
  )
  const bridge = createBridge({
    ...iso.input,
    ...(opts.platform ? { platform: opts.platform } : {}),
    lanes: {
      ios: null,
      simulators: null,
      android: (ctx) =>
        createAndroidLane(ctx, { ...CADENCE, lookupMs: 300, lookup: opts.lookup ?? noNames }),
    },
    resolveTools: () =>
      Promise.resolve(
        toolbox((t) => {
          const adb = typeof opts.adb === 'function' ? opts.adb() : opts.adb !== false
          if (adb) t.adb = { path: adbPath, version: '36.0.0' }
        }),
      ),
  })
  const { port } = await bridge.listen()
  onCleanup(() => bridge.close())
  const auth = { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' }
  return {
    port,
    auth,
    logs: iso.logs,
    adbPort: opts.adbPort,
    adbPath,
    calls: () => iso.bin.calls(),
    snapshot: async () => (await request(port, { path: '/api/devices', headers: auth })).json(),
    bridge,
  }
}

const rowOf = (snapshot: Snapshot, id: string): HelperDevice | undefined =>
  snapshot.devices.find((d) => d.id === id)

async function waitForRow(
  run: AndroidRun,
  id: string,
  check: (row: HelperDevice) => boolean = () => true,
): Promise<HelperDevice> {
  let found: HelperDevice | undefined
  await until(
    async () => {
      found = rowOf(await run.snapshot(), id)
      return !!found && check(found)
    },
    4_000,
    `row ${id}`,
  )
  return found as HelperDevice
}

/* --------------------------------------------------------------------- pure parts --- */

describe('parseDevicesL and the state table (§4.3)', () => {
  const text = [
    '55090DLAQ0026D         device usb:1-1 product:tokay model:Pixel_9 device:tokay transport_id:3',
    'R58MC0ABCDE            unauthorized usb:1-2 transport_id:4',
    'HT7A1B2C3D4E           authorizing usb:1-3 transport_id:5',
    '0123456789ABCDEF       offline usb:2-1 transport_id:6',
    'FA6AB0301234           recovery usb:2-2 transport_id:7',
    'FA6AB0305678           sideload transport_id:8',
    'FA6AB0309999           bootloader transport_id:9',
    'FA6AB030AAAA           rescue transport_id:10',
    '0B0B0B0B0B0B           no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-1 transport_id:11',
    'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:12',
    '192.168.1.20:5555      device product:tokay model:Pixel_9 device:tokay transport_id:13',
    'adb-55090DLAQ0026D-vWgJpq._adb-tls-connect._tcp device product:tokay model:Pixel_9 device:tokay transport_id:14',
    'ZZ12                   host transport_id:15',
    'ZZ13                   teleporting transport_id:16',
    '',
  ].join('\n')

  it('reads serial, state and properties, including states with spaces', () => {
    const rows = parseDevicesL(text)
    expect(rows).toHaveLength(14)
    expect(rows[0]).toEqual({
      serial: '55090DLAQ0026D',
      state: 'device',
      props: {
        usb: '1-1',
        product: 'tokay',
        model: 'Pixel_9',
        device: 'tokay',
        transport_id: '3',
      },
    })
    const noPerm = rows.find((r) => r.serial === '0B0B0B0B0B0B')
    expect(noPerm?.state).toBe(
      'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
    )
    expect(noPerm?.props).toEqual({ usb: '3-1', transport_id: '11' })
    expect(rows.find((r) => r.serial === 'ZZ13')?.state).toBe('teleporting')
  })

  it('ignores blank lines, the CLI header and daemon messages', () => {
    expect(parseDevicesL('List of devices attached\n* daemon started successfully\n\n')).toEqual([])
    expect(parseDevicesL('')).toEqual([])
  })

  it('maps every adb state to the row state and blockers', () => {
    const table = Object.fromEntries(
      parseDevicesL(text).map((r) => [r.serial, mapAdbState(r.state)]),
    )
    expect(table).toEqual({
      '55090DLAQ0026D': { state: 'ready', blockers: [] },
      R58MC0ABCDE: { state: 'unauthorized', blockers: ['ANDROID_UNAUTHORIZED'] },
      HT7A1B2C3D4E: { state: 'authorizing', blockers: ['ANDROID_UNAUTHORIZED'] },
      '0123456789ABCDEF': { state: 'offline', blockers: ['ANDROID_OFFLINE'] },
      FA6AB0301234: { state: 'recovery', blockers: ['ANDROID_RECOVERY'] },
      FA6AB0305678: { state: 'recovery', blockers: ['ANDROID_RECOVERY'] },
      FA6AB0309999: { state: 'recovery', blockers: ['ANDROID_RECOVERY'] },
      FA6AB030AAAA: { state: 'recovery', blockers: ['ANDROID_RECOVERY'] },
      '0B0B0B0B0B0B': { state: 'unknown', blockers: [] },
      'emulator-5554': { state: 'ready', blockers: [] },
      '192.168.1.20:5555': { state: 'ready', blockers: [] },
      'adb-55090DLAQ0026D-vWgJpq._adb-tls-connect._tcp': { state: 'ready', blockers: [] },
      ZZ12: { state: 'unknown', blockers: [] },
      ZZ13: { state: 'unknown', blockers: [] },
    })
    expect(mapAdbState('connecting')).toEqual({ state: 'connecting', blockers: [] })
  })

  it('tells USB, Wi-Fi and emulators apart', () => {
    expect(adbConnection('55090DLAQ0026D')).toBe('usb')
    expect(adbConnection('emulator-5554')).toBe('simulator')
    expect(adbConnection('192.168.1.20:5555')).toBe('network')
    expect(adbConnection('adb-55090DLAQ0026D-vWgJpq._adb-tls-connect._tcp')).toBe('network')
    expect(adbConnection('adb-55090DLAQ0026D-vWgJpq._adb._tcp')).toBe('network')
  })

  it('names a row from getprop, or from the tracker with underscores as spaces', () => {
    const [entry] = parseDevicesL(text)
    if (!entry) throw new Error('no row')
    expect(androidRow(entry, null)).toMatchObject({
      name: 'Pixel 9',
      model: 'Pixel 9',
      modelId: 'tokay',
      osVersion: '',
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
    expect(
      androidRow(entry, { model: 'Pixel 9 Pro', device: 'caiman', release: '17' }),
    ).toMatchObject({ name: 'Pixel 9 Pro', modelId: 'caiman', osVersion: '17' })
    const offline = parseDevicesL('X1 offline transport_id:2')[0]
    if (!offline) throw new Error('no row')
    expect(androidRow(offline, null).capabilities).toEqual({
      screenshot: false,
      identifiers: false,
      logs: false,
      install: false,
    })
  })
})

describe('the command tables (T10, T11)', () => {
  it('ADB_DETAIL equals the page’s DETAIL_COMMANDS, in order (contract)', async () => {
    const page = (await import(
      new URL('../../src/features/device/backends/android.ts', import.meta.url).href
    )) as { DETAIL_COMMANDS: ReadonlyArray<readonly string[]> }
    expect(ADB_DETAIL.map(([, cmd]) => cmd)).toEqual(
      page.DETAIL_COMMANDS.map((command) => command.join(' ')),
    )
  })

  it('fixtures/pixel-9.json is a copy of the page’s DETAIL_FIXTURES["pixel-9"]', async () => {
    const page = (await import(
      new URL('../../src/features/device/backends/fixtures.ts', import.meta.url).href
    )) as { DETAIL_FIXTURES: Record<string, unknown> }
    expect(PIXEL_9).toEqual(page.DETAIL_FIXTURES['pixel-9'])
  })

  it('ADB_EXEC holds constants only: the detail commands, three getprops, screencap, logcat', () => {
    expect(ADB_EXEC).toEqual([
      'getprop',
      'wm size',
      'wm density',
      'dumpsys battery',
      'df /data',
      'settings get secure android_id',
      'getprop ro.product.model',
      'getprop ro.product.device',
      'getprop ro.build.version.release',
      'screencap -p',
      'logcat -v threadtime -T 200',
    ])
    expect(Object.isFrozen(ADB_EXEC) || ADB_EXEC.every((c) => /^[\w ./-]+$/.test(c))).toBe(true)
  })

  it('the client sends nothing off the allowlist', () => {
    for (const service of ADB_HOST_SERVICES) expect(() => assertAdbService(service)).not.toThrow()
    for (const cmd of ADB_EXEC) expect(() => assertAdbService(`exec:${cmd}`)).not.toThrow()
    expect(() => assertAdbService('host:transport:55090DLAQ0026D')).not.toThrow()
    for (const refused of [
      ...ADB_HOST_NEVER,
      'host:kill',
      'host:transport:-s',
      'host:transport:a b',
      'exec:reboot',
      'exec:getprop; reboot',
      'exec:logcat -v threadtime -T 2000',
      'shell:getprop',
      'abb_exec:package\0install',
      'host:tport:any',
    ]) {
      expect(() => assertAdbService(refused), refused).toThrow(HelperError)
    }
  })

  it('ADB_HOST_NEVER: the generic gate refuses all of them; only the Wi-Fi senders’ own checks pass theirs', () => {
    const connect = 'host:connect:192.168.1.20:5555'
    const pair = 'host:pair:123456:192.168.1.20:37123'
    const disconnect = 'host:disconnect:192.168.1.20:5555'
    /** The real strings, not only the prefixes: assertAdbService never lets one through. */
    for (const service of [connect, pair, disconnect, 'host:kill', 'host:reconnect']) {
      expect(() => assertAdbService(service), service).toThrow(HelperError)
    }
    for (const prefix of ADB_HOST_NEVER) {
      expect(
        [connect, pair, disconnect].some((s) => s.startsWith(prefix)) ||
          ['host:kill', 'host:reconnect'].includes(prefix),
        prefix,
      ).toBe(true)
    }
    /** Each dedicated check passes exactly its own shape… */
    expect(() => assertConnectService(connect)).not.toThrow()
    expect(() => assertConnectService('host:connect:[fe80::1%en0]:5555')).not.toThrow()
    expect(() => assertConnectService('host:connect:living-room-tv.local:5555')).not.toThrow()
    expect(() => assertPairService(pair)).not.toThrow()
    expect(() => assertDisconnectService(disconnect)).not.toThrow()
    expect(() => assertDisconnectService('host:disconnect:[fe80::1%en0]:5555')).not.toThrow()
    /** …and nothing else: not each other's, not a public or loopback address, not extra text. */
    const refusedBy: Array<[(service: string) => void, string[]]> = [
      [
        assertConnectService,
        [
          pair,
          disconnect,
          'host:connect:8.8.8.8:5555',
          'host:connect:127.0.0.1:5555',
          'host:connect:192.168.1.20',
          'host:connect:192.168.1.20:0',
          'host:connect:192.168.1.20:05555',
          'host:connect:192.168.1.20:5555:5555',
          'host:connect:192.168.1.20:5555 -s x',
          'host:connect:fe80::1:5555',
          'host:connect:[192.168.1.20]:5555',
          'host:connect:[2001:db8::1]:5555',
          'host:connect:example.com:5555',
          'host:connect:LIVING-ROOM-TV.local:5555',
          'host:connect:',
        ],
      ],
      [
        assertPairService,
        [
          connect,
          'host:pair:12345:192.168.1.20:37123',
          'host:pair:1234567:192.168.1.20:37123',
          'host:pair:123456:8.8.8.8:37123',
          'host:pair:123456:192.168.1.20',
          'host:pair:abcdef:192.168.1.20:37123',
        ],
      ],
      [
        assertDisconnectService,
        [
          connect,
          'host:disconnect:',
          'host:disconnect:55090DLAQ0026D',
          'host:disconnect:emulator-5554',
          'host:disconnect:-a',
          'host:disconnect:192.168.1.20:5555 x',
          /** adb reads an mDNS serial as `<name>:5555` and answers "no such device". */
          'host:disconnect:adb-R5CT1-AbCdEf._adb-tls-connect._tcp',
          /** An emulator over loopback: connect never reaches it, so neither does disconnect. */
          'host:disconnect:127.0.0.1:5555',
        ],
      ],
    ]
    for (const [check, services] of refusedBy) {
      for (const service of services) expect(() => check(service), service).toThrow(HelperError)
    }
  })

  it('frames a request with four lowercase hex digits of length', () => {
    expect(encodeAdbRequest('host:version').toString()).toBe('000chost:version')
  })

  it('maps FAIL texts to the page’s codes (§4.2)', () => {
    const code = (text: string): string => adbFailError(text).code
    expect(code("device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set")).toBe(
      'ANDROID_UNAUTHORIZED',
    )
    expect(code('device still authorizing')).toBe('ANDROID_UNAUTHORIZED')
    expect(code('device offline')).toBe('ANDROID_OFFLINE')
    expect(code("device 'X1' not found")).toBe('DEVICE_NOT_FOUND')
    expect(code('device still connecting')).toBe('DEVICE_NOT_READY')
    expect(adbFailError('closed')).toMatchObject({ code: 'TOOL_FAILED', status: 502 })
  })
})

/* --------------------------------------------------------------------- the client --- */

describe('createAdbClient against the fake server', () => {
  it('reads the protocol from host:version, and null when nothing listens', async () => {
    const server = await fakeServer()
    expect(await createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST }).version()).toBe(41)
    const closed = await freePort()
    expect(await createAdbClient({ port: closed, timeouts: TIMEOUTS_FAST }).version()).toBeNull()
  })

  it('a hung server times out; something else on the port is not an adb server', async () => {
    const server = await fakeServer()
    server.hang.add('host:version')
    const client = createAdbClient({
      port: server.port,
      timeouts: { ...TIMEOUTS_FAST, adbRequest: 300 },
    })
    await expect(client.version()).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })

    /** It reads (and so sees the client leave), then answers like a web server would. */
    const junk = net.createServer((socket) => {
      socket.resume()
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    await new Promise<void>((resolve) => junk.listen(0, '127.0.0.1', resolve))
    onCleanup(() => new Promise<void>((resolve) => junk.close(() => resolve())))
    const port = (junk.address() as net.AddressInfo).port
    await expect(
      createAdbClient({ port, timeouts: TIMEOUTS_FAST }).version(),
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' })
  })

  it('exec: bytes until EOF; transport refusals become codes; caps and deadlines hold', async () => {
    const server = await fakeServer()
    server.setDevices([
      pixel(),
      { serial: 'R58MC0ABCDE', state: 'unauthorized', props: ' transport_id:4' },
      { serial: 'X0FF', state: 'offline', props: ' transport_id:5' },
    ])
    pixelExec(server, { 'wm size': 'x'.repeat(5_000) })
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST })
    expect((await client.exec('55090DLAQ0026D', 'getprop')).toString()).toBe(
      PIXEL_9.outputs.getprop,
    )
    expect(server.services.slice(-2)).toEqual(['host:transport:55090DLAQ0026D', 'exec:getprop'])
    await expect(client.exec('R58MC0ABCDE', 'getprop')).rejects.toMatchObject({
      code: 'ANDROID_UNAUTHORIZED',
      status: 409,
    })
    await expect(client.exec('X0FF', 'getprop')).rejects.toMatchObject({ code: 'ANDROID_OFFLINE' })
    await expect(client.exec('NOPE1', 'getprop')).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
      status: 404,
    })
    await expect(
      client.exec('55090DLAQ0026D', 'wm size', { maxBytes: 1_000 }),
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' })

    server.hang.add('exec:wm density')
    await expect(
      client.exec('55090DLAQ0026D', 'wm density', { timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT', status: 504 })
    const abort = new AbortController()
    const pending = client.exec('55090DLAQ0026D', 'wm density', { signal: abort.signal })
    setTimeout(() => abort.abort(), 50)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses a command off the allowlist without connecting', async () => {
    const server = await fakeServer()
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST })
    await expect(client.exec('55090DLAQ0026D', 'reboot')).rejects.toMatchObject({
      code: 'INTERNAL',
    })
    expect(server.services).not.toContain('exec:reboot')
  })

  it('no server: ADB_SERVER_STOPPED for an operation', async () => {
    const client = createAdbClient({ port: await freePort(), timeouts: TIMEOUTS_FAST })
    await expect(client.exec('55090DLAQ0026D', 'getprop')).rejects.toMatchObject({
      code: 'ADB_SERVER_STOPPED',
      status: 503,
    })
    await expect(client.devicesL()).rejects.toMatchObject({ code: 'ADB_SERVER_STOPPED' })
  })

  it('track: the list at once, then every change, then the end when the server dies', async () => {
    const server = await fakeServer()
    server.setDevices([pixel('offline')])
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST })
    const lists: string[] = []
    let ended: Error | null | undefined
    client.track(
      (text) => lists.push(text),
      (error) => (ended = error),
    )
    await until(() => lists.length === 1)
    expect(parseDevicesL(lists[0] ?? '')[0]?.state).toBe('offline')
    server.setDevices([pixel()])
    await until(() => lists.length === 2)
    expect(parseDevicesL(lists[1] ?? '')[0]?.state).toBe('device')
    /** Long after the request deadline the tracker is still open. */
    await sleep(TIMEOUTS_FAST.adbRequest + 200)
    expect(server.trackers()).toBe(1)
    await server.close()
    await until(() => ended !== undefined)
    expect(ended).toBeNull()
  })

  it('track: a FAIL reply ends it with the error', async () => {
    const server = await fakeServer()
    server.failTrack = true
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST })
    let ended: Error | null | undefined
    client.track(
      () => undefined,
      (error) => (ended = error),
    )
    await until(() => ended !== undefined)
    expect(ended).toBeInstanceOf(HelperError)
    expect(isAdbRefusal(ended)).toBe(true)
  })

  it('track: a server that dies before answering is not a refusal', async () => {
    const server = await fakeServer()
    server.hang.add('host:track-devices-l')
    const client = createAdbClient({ port: server.port, timeouts: TIMEOUTS_FAST })
    let ended: Error | null | undefined
    client.track(
      () => undefined,
      (error) => (ended = error),
    )
    await until(() => server.services.includes('host:track-devices-l'))
    await server.close()
    await until(() => ended !== undefined)
    expect(isAdbRefusal(ended)).toBe(false)
  })
})

/* ------------------------------------------------------------- the lane via HTTP --- */

describe('the Android lane through the bridge', () => {
  it('no server: the lane is stopped and nothing ran but adb version, if anything', async () => {
    const run = await startAndroid({ adbPort: await freePort() })
    await until(async () => (await run.snapshot()).lanes.android.status === 'stopped')
    await sleep(400)
    const snapshot = await run.snapshot()
    expect(snapshot.lanes.android).toMatchObject({
      status: 'stopped',
      adb: 'found',
      startedByHelper: false,
    })
    expect(snapshot.devices).toEqual([])
    for (const call of run.calls().filter((c) => c.name === 'adb')) {
      expect(call.argv).toEqual(['version'])
    }
  })

  it('lists what the tracker says, with identity, and prints one arrival line', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    const others: FakeAdbDevice[] = [
      { serial: 'R58MC0ABCDE', state: 'unauthorized', props: ' usb:1-2 transport_id:4' },
      { serial: 'emulator-5554', state: 'offline', props: ' transport_id:5' },
      { serial: '192.168.1.20:5555', state: 'recovery', props: ' transport_id:6' },
      {
        serial: '????????????',
        state: 'no permissions (user in plugdev group)',
        props: ' usb:3-1',
      },
    ]
    server.setDevices([pixel(), ...others])
    const run = await startAndroid({ adbPort })
    const row = await waitForRow(run, '55090DLAQ0026D')
    expect(row).toEqual({
      id: '55090DLAQ0026D',
      platform: 'android',
      connection: 'usb',
      state: 'ready',
      name: 'Pixel 9',
      model: 'Pixel 9',
      modelId: 'tokay',
      osVersion: '17',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
    const snapshot = await run.snapshot()
    expect(snapshot.lanes.android).toMatchObject({
      status: 'ok',
      adb: 'found',
      serverProtocol: 41,
      startedByHelper: false,
    })
    expect(rowOf(snapshot, 'R58MC0ABCDE')).toMatchObject({
      state: 'unauthorized',
      blockers: ['ANDROID_UNAUTHORIZED'],
    })
    expect(rowOf(snapshot, 'emulator-5554')).toMatchObject({
      state: 'offline',
      connection: 'simulator',
      blockers: ['ANDROID_OFFLINE'],
    })
    expect(rowOf(snapshot, '192.168.1.20:5555')).toMatchObject({
      state: 'recovery',
      connection: 'network',
    })
    /** An id no request could address is left out, not reported as a lane bug. */
    expect(snapshot.devices).toHaveLength(4)
    const arrivals = run.logs.filter((line) => line.includes('+ Pixel 9'))
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]).toMatch(/\+ Pixel 9 \(55090DLAQ0026D\) · Android 17 · USB · ready via adb$/)
    /** The server already ran at start: the banner says so, not a transition line. */
    expect(run.logs.some((line) => line.includes('adb server appeared'))).toBe(false)
  })

  it('a listed phone that turns ready (Allow) stays listed while its identity loads, and changes in place', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    const answers = server.exec
    /** A slow phone: every getprop answers after 400 ms, inside the 600 ms grace. */
    server.exec = (serial, cmd) => {
      const answer = answers(serial, cmd)
      if (!cmd.startsWith('getprop ') || typeof answer !== 'string') return answer
      return (socket) => {
        setTimeout(() => socket.end(answer), 400)
      }
    }
    server.setDevices([pixel('unauthorized', 3)])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D', (r) => r.state === 'unauthorized')

    server.setDevices([pixel('device', 3)])
    const seen: string[] = []
    await until(
      () => {
        const row = run.bridge.registry.devices().find((d) => d.id === '55090DLAQ0026D')
        seen.push(row ? row.state : 'missing')
        return row?.osVersion === '17'
      },
      4_000,
      'the identity',
    )
    expect(seen).not.toContain('missing')
    const lines = run.logs
      .map((line) => line.replace(/^\d\d:\d\d:\d\d {2}/, ''))
      .filter((line) => line.includes('55090DLAQ0026D') && /^[+~-] /.test(line))
    expect(lines).toEqual([
      '+ Pixel 9 (55090DLAQ0026D) · Android · USB · waiting for "Allow USB debugging?"',
      '~ Pixel 9 (55090DLAQ0026D) · ready via adb',
    ])
  })

  it('caches identity per transport_id: same list, no new getprop; a reconnect asks again', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel('device', 3)])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D', (r) => r.osVersion === '17')
    const getprops = (): number =>
      server.services.filter((s) => s === 'exec:getprop ro.product.model').length
    expect(getprops()).toBe(1)
    server.setDevices([pixel('device', 3)])
    await sleep(200)
    expect(getprops()).toBe(1)
    server.setDevices([pixel('device', 9)])
    await until(() => getprops() === 2)
  })

  it('detail: the six outputs byte-equal to the fixture, plus serial and connection', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const reply = await request(run.port, {
      path: '/api/devices/55090DLAQ0026D/detail',
      headers: run.auth,
    })
    expect(reply.status).toBe(200)
    expect(reply.json()).toEqual({
      platform: 'android',
      kind: 'android',
      serial: '55090DLAQ0026D',
      connection: 'usb',
      outputs: PIXEL_9.outputs,
    })
  })

  it('detail: one failing command reads as "", as on WebUSB', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    const answer = server.exec
    server.exec = (serial, cmd) =>
      cmd === 'settings get secure android_id' ? { fail: 'closed' } : answer(serial, cmd)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const reply = await request(run.port, {
      path: '/api/devices/55090DLAQ0026D/detail',
      headers: run.auth,
    })
    expect(reply.json<{ outputs: Record<string, string> }>().outputs).toEqual({
      ...PIXEL_9.outputs,
      androidId: '',
    })
  })

  it('screenshot: screencap’s warning and trailing text are cut away', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/devices/55090DLAQ0026D/screenshot',
      headers: run.auth,
    })
    expect(reply.status).toBe(200)
    expect(reply.headers['x-screenshot-source']).toBe('adb')
    expect(reply.body.equals(tinyPng())).toBe(true)
    expect(server.services).toContain('exec:screencap -p')
  })

  it('screenshot: a FAIL from the phone maps to its code', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.exec = () => ({ fail: 'device offline' })
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/devices/55090DLAQ0026D/screenshot',
      headers: run.auth,
    })
    expect(reply.status).toBe(409)
    expect(reply.json()).toMatchObject({ error: { code: 'ANDROID_OFFLINE' } })
  })

  it('logs: logcat streams; leaving closes the socket on the server', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const stream = await openStream(run.port, '/api/devices/55090DLAQ0026D/logs', run.auth)
    if (!isStream(stream)) throw new Error(`no stream: ${stream.text}`)
    expect(stream.messages[0]).toMatchObject({ t: 'hello', source: 'logcat' })
    await stream.waitFor((m) => m.t === 'lines' && m.lines.some((l) => l.includes('line 210')))
    expect(server.services).toContain('exec:logcat -v threadtime -T 200')
    expect(server.streams()).toBe(1)
    stream.abort()
    await until(() => server.streams() === 0, 2_000, 'logcat socket closed')
  })

  it('logs: an unplug ends the stream as device-gone', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    const answer = server.exec
    let logcat: net.Socket | null = null
    server.exec = (serial, cmd) => {
      if (cmd !== 'logcat -v threadtime -T 200') return answer(serial, cmd)
      return (socket) => {
        logcat = socket
        socket.write('10-04 08:41:02.000  1  1 I Tag: hello\n')
      }
    }
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const stream = (await openStream(
      run.port,
      '/api/devices/55090DLAQ0026D/logs',
      run.auth,
    )) as Stream
    await stream.waitFor((m) => m.t === 'lines')
    /** adbd ends logcat first; the tracker reports the unplug a moment later. */
    ;(logcat as net.Socket | null)?.end()
    setTimeout(() => server.setDevices([]), 100)
    const end = await stream.waitFor((m) => m.t === 'end')
    expect(end).toMatchObject({ t: 'end', reason: 'device-gone' })
  })

  it('logs: an unauthorized phone gets a JSON error, not a stream', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([{ serial: 'R58MC0ABCDE', state: 'unauthorized', props: ' transport_id:4' }])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, 'R58MC0ABCDE')
    const reply = await openStream(run.port, '/api/devices/R58MC0ABCDE/logs', run.auth)
    expect(isStream(reply)).toBe(false)
    expect(reply.status).toBe(409)
  })

  it('retry: offline sends host:reconnect-offline, then returns the ready row', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel('offline')])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D', (r) => r.state === 'offline')
    setTimeout(() => server.setDevices([pixel('device', 4)]), 150)
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/devices/55090DLAQ0026D/retry',
      headers: run.auth,
    })
    expect(server.services).toContain('host:reconnect-offline')
    expect(reply.json()).toMatchObject({
      device: { id: '55090DLAQ0026D', state: 'ready', name: 'Pixel 9', osVersion: '17' },
    })
  })

  it('retry: a ready phone is only re-listed (devices-l), never reconnected', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    await request(run.port, {
      method: 'POST',
      path: '/api/devices/55090DLAQ0026D/retry',
      headers: run.auth,
    })
    expect(server.services).toContain('host:devices-l')
    expect(server.services).not.toContain('host:reconnect-offline')
  })

  it('the server dies: rows go, the lane is stopped, one line says so; it comes back', async () => {
    const adbPort = await freePort()
    let server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    await server.close()
    await until(async () => (await run.snapshot()).lanes.android.status === 'stopped')
    expect((await run.snapshot()).devices).toEqual([])
    expect(
      run.logs.some((l) =>
        l.includes("adb server stopped: Android phones are back with Chrome's WebUSB"),
      ),
    ).toBe(true)
    expect(run.logs.some((l) => l.includes('- Pixel 9 (55090DLAQ0026D)'))).toBe(true)

    server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    await waitForRow(run, '55090DLAQ0026D')
    expect(run.logs.some((l) => l.includes('adb server appeared (protocol 41)'))).toBe(true)
  })

  it('adb installed while the helper runs: the lane says found by itself, and at once on Re-check', async () => {
    let installed = false
    const ticks = await startAndroid({
      adbPort: await freePort(),
      adb: () => installed,
      timeouts: { toolsCache: 150 },
    })
    await until(async () => (await ticks.snapshot()).lanes.android.status === 'stopped')
    expect((await ticks.snapshot()).lanes.android.adb).toBe('missing')
    installed = true
    /** Nothing pressed: the presence probe re-reads the tools once the cache is old. */
    await until(async () => (await ticks.snapshot()).lanes.android.adb === 'found', 3_000, 'found')

    installed = false
    const recheck = await startAndroid({ adbPort: await freePort(), adb: () => installed })
    await until(async () => (await recheck.snapshot()).lanes.android.status === 'stopped')
    installed = true
    /** Re-check (the page's ?refresh=1): the report's lane agrees with its own adb row. */
    const reply = await request(recheck.port, {
      path: '/api/doctor?refresh=1',
      headers: recheck.auth,
    })
    const doctor = reply.json<DoctorReport>()
    expect(doctor.items.find((i) => i.id === 'android.adb')?.status).toBe('ok')
    expect(doctor.lanes.android.adb).toBe('found')
    expect((await recheck.snapshot()).lanes.android.adb).toBe('found')
  })

  it('a server without the tracker is polled with devices-l', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    server.failTrack = true
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    server.setDevices([])
    await until(async () => (await run.snapshot()).devices.length === 0)
    expect(server.services.filter((s) => s === 'host:devices-l').length).toBeGreaterThan(1)
  })

  it('rescan re-lists through devices-l', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/rescan',
      headers: run.auth,
    })
    expect(reply.status).toBe(200)
    expect(server.services).toContain('host:devices-l')
  })

  it('every request the lane sent was on the allowlist', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    await request(run.port, { path: '/api/devices/55090DLAQ0026D/detail', headers: run.auth })
    for (const service of server.services) expect(() => assertAdbService(service)).not.toThrow()
  })
})

/* ------------------------------------------------------------------ Wi-Fi (§4.7) --- */

describe('Wi-Fi: what the page may name (§4.7)', () => {
  const host = (value: unknown): string => parseNetworkHost(value)
  const refusedHost = (value: unknown): string => {
    try {
      parseNetworkHost(value)
    } catch (error) {
      expect(error).toMatchObject({ code: 'BAD_REQUEST', status: 400 })
      return (error as HelperError).message
    }
    throw new Error(`accepted ${String(value)}`)
  }

  it('takes local IPv4, local IPv6 (with or without a zone) and .local, .lan, .home.arpa names', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '169.254.10.2',
      '100.64.0.1',
      '100.127.255.255',
    ]) {
      expect(host(ip)).toBe(ip)
    }
    expect(host(' 192.168.1.20 ')).toBe('192.168.1.20')
    expect(host('fe80::1')).toBe('fe80::1')
    expect(host('[fe80::1%en0]')).toBe('fe80::1%en0')
    expect(host('FD12:3456::1')).toBe('fd12:3456::1')
    expect(host('febf::1')).toBe('febf::1')
    expect(host('Living-Room-TV.local')).toBe('living-room-tv.local')
    expect(host('tv.local.')).toBe('tv.local')
    expect(host('shield.lan')).toBe('shield.lan')
    expect(host('shield.home.arpa')).toBe('shield.home.arpa')
  })

  it('refuses public, loopback and odd addresses, and anything adb could read as more', () => {
    for (const value of [
      '8.8.8.8',
      '127.0.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '192.169.1.1',
      '::1',
      '::',
      '::ffff:192.168.1.20',
      '2001:db8::1',
      'fec0::1',
      'fe80::1%en0;reboot',
      'fe80::1%',
      'example.com',
      'tv',
      'local',
      '.local',
      '-s.local',
      'a b.local',
      'tv.local -s',
      'tv.local:5555',
      'tv_box.local',
      `${'a'.repeat(101)}.local`,
    ]) {
      expect(refusedHost(value), value).not.toBe('')
    }
    expect(refusedHost('192.168.1.020')).toBe('That is not an IP address.')
    expect(refusedHost('1.2.3')).toBe('That is not an IP address.')
    expect(refusedHost('')).toBe('Enter the device’s address.')
    expect(refusedHost(42)).toBe('Enter the device’s address.')
    expect(refusedHost(null)).toBe('Enter the device’s address.')
    expect(refusedHost('8.8.8.8')).toMatch(/^Only devices on your local network/)
  })

  it('ports are whole JSON numbers 1–65535 (connect defaults to 5555); codes are six digits', () => {
    expect(parseNetworkPort(undefined, ADB_NETWORK_PORT)).toBe(5555)
    expect(parseNetworkPort(37123)).toBe(37123)
    expect(parseNetworkPort(1)).toBe(1)
    expect(parseNetworkPort(65535)).toBe(65535)
    for (const value of [undefined, 0, 65536, -1, 1.5, Number.NaN, '5555', null]) {
      expect(() => parseNetworkPort(value), String(value)).toThrow(
        'The port must be a whole number from 1 to 65535.',
      )
    }
    expect(parsePairingCode('123456')).toBe('123456')
    for (const value of ['12345', '1234567', '12 3456', 'abcdef', 123456, '', undefined]) {
      expect(() => parsePairingCode(value), String(value)).toThrow(
        'The pairing code is the six digits the device shows.',
      )
    }
  })

  it('serials: IPv6 in brackets, listed like any other id, and told apart from USB', () => {
    expect(networkSerial('192.168.1.20', 5555)).toBe('192.168.1.20:5555')
    expect(networkSerial('fe80::1%en0', 5555)).toBe('[fe80::1%en0]:5555')
    expect(isDeviceId('[fe80::1%en0]:5555')).toBe(true)
    expect(isDeviceId('[fe80::1%en0;x]:5555')).toBe(false)
    expect(isNetworkSerial('192.168.1.20:5555')).toBe(true)
    expect(isNetworkSerial('[fe80::1%en0]:5555')).toBe(true)
    expect(isNetworkSerial('adb-R5CT1-AbCdEf._adb-tls-connect._tcp')).toBe(true)
    expect(isNetworkSerial('55090DLAQ0026D')).toBe(false)
    expect(isNetworkSerial('emulator-5554')).toBe(false)
    /** Disconnect takes only what connect writes: no mDNS serial, no loopback. */
    expect(isDisconnectableSerial('192.168.1.20:5555')).toBe(true)
    expect(isDisconnectableSerial('[fe80::1%en0]:5555')).toBe(true)
    expect(isDisconnectableSerial('adb-R5CT1-AbCdEf._adb-tls-connect._tcp')).toBe(false)
    expect(isDisconnectableSerial('127.0.0.1:5555')).toBe(false)
    expect(isDisconnectableSerial('55090DLAQ0026D')).toBe(false)
  })

  it('reads adb’s answers: connected, already, refused, blocked, unreachable, timed out, unpaired', () => {
    const target = '192.168.1.20:5555'
    expect(parseConnectReply({ ok: true, text: 'connected to 192.168.1.20:5555' }, target)).toEqual(
      { result: 'connected', serial: target, message: 'connected to 192.168.1.20:5555' },
    )
    expect(
      parseConnectReply({ ok: true, text: 'already connected to 192.168.1.20:5555' }, target),
    ).toMatchObject({ result: 'already-connected', serial: target })
    const reason = (text: string, ok = true): unknown => {
      try {
        parseConnectReply({ ok, text }, target)
      } catch (error) {
        expect(error).toMatchObject({ code: 'ANDROID_CONNECT_FAILED', status: 502 })
        return (error as HelperError).extra
      }
      throw new Error('accepted')
    }
    expect(reason("failed to connect to '192.168.1.20:5555': Connection refused")).toEqual({
      reason: 'refused',
      detail: "failed to connect to '192.168.1.20:5555': Connection refused",
    })
    expect(reason('cannot connect to 192.168.1.20:5555: Connection refused (61)')).toMatchObject({
      reason: 'refused',
    })
    /** EHOSTUNREACH at once: a VPN, or macOS's local-network privacy, not the device. */
    expect(reason('cannot connect to 192.168.1.20:5555: No route to host (65)')).toEqual({
      reason: 'blocked',
      detail: 'cannot connect to 192.168.1.20:5555: No route to host (65)',
    })
    expect(reason('cannot connect to 192.168.1.20:5555: Host is down (64)')).toMatchObject({
      reason: 'unreachable',
    })
    expect(
      reason('cannot connect to 192.168.1.20:5555: Network is unreachable (51)'),
    ).toMatchObject({ reason: 'unreachable' })
    expect(reason('cannot connect to 192.168.1.20:5555: Operation timed out (60)')).toMatchObject({
      reason: 'timeout',
    })
    expect(reason('failed to authenticate to 192.168.1.20:5555')).toMatchObject({
      reason: 'unpaired',
    })
    expect(
      reason("failed to resolve host: 'tv.local': nodename nor servname provided, or not known"),
    ).toMatchObject({ reason: 'unresolved' })
    /** "connected to" on a FAIL is not a success. */
    expect(reason('connected to 192.168.1.20:5555', false)).toMatchObject({ reason: 'failed' })
  })

  it('reads adb’s answers to pair and disconnect', () => {
    const target = '192.168.1.20:37123'
    expect(
      parsePairReply(
        { ok: true, text: 'Successfully paired to 192.168.1.20:37123 [guid=adb-R5CT1-AbCdEf]' },
        target,
      ),
    ).toEqual({ message: 'Successfully paired to 192.168.1.20:37123 [guid=adb-R5CT1-AbCdEf]' })
    const pairReason = (text: string, ok = true): unknown => {
      try {
        parsePairReply({ ok, text }, target)
      } catch (error) {
        expect(error).toMatchObject({ code: 'ANDROID_PAIR_FAILED', status: 502 })
        return (error as HelperError).extra?.reason
      }
      throw new Error('accepted')
    }
    expect(pairReason('Failed: Wrong password or connection was dropped.')).toBe('wrong-code')
    expect(pairReason('unknown host service', false)).toBe('unsupported')
    expect(pairReason('Failed: Unable to start pairing client.')).toBe('failed')
    expect(parseDisconnectReply({ ok: true, text: 'disconnected 192.168.1.20:5555' })).toEqual({
      message: 'disconnected 192.168.1.20:5555',
    })
    expect(() =>
      parseDisconnectReply({ ok: false, text: "no such device '192.168.1.20:5555'" }),
    ).toThrow(expect.objectContaining({ code: 'DEVICE_NOT_FOUND', status: 404 }) as Error)
  })
})

/** What an NVIDIA SHIELD answers over exec:, as adbd does. */
function shieldExec(server: FakeAdbServer, logcat?: (socket: net.Socket) => void): void {
  pixelExec(server, {
    'getprop ro.product.model': 'SHIELD Android TV\n',
    'getprop ro.product.device': 'mdarcy\n',
    'getprop ro.build.version.release': '11\n',
  })
  const answer = server.exec
  server.exec = (serial, cmd) =>
    cmd === 'logcat -v threadtime -T 200' && logcat ? logcat : answer(serial, cmd)
}

/** A JSON POST as the page's fetch sends it: Content-Type and a Content-Length. */
function post(run: AndroidRun, path: string, body: unknown, extra: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return request(run.port, {
    method: 'POST',
    path,
    headers: {
      ...run.auth,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(text)),
      ...extra,
    },
    body: text,
  })
}

const wifiServices = (server: FakeAdbServer): string[] =>
  server.services.filter((s) => /^host:(?:connect|pair|disconnect):/.test(s))

describe('Wi-Fi through the bridge (§4.7)', () => {
  it('connect: unauthorized until the TV allows it, then ready by its name, with detail, screenshot and logs', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice(shield())
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')

    /** adb 36's answer while the TV asks "Allow debugging?": a failure in words, not in fact. */
    const reply = await post(run, '/api/android/connect', { host: '192.168.1.20' })
    expect(reply.status).toBe(200)
    expect(reply.json()).toEqual({
      result: 'connected',
      serial: '192.168.1.20:5555',
      message: 'failed to authenticate to 192.168.1.20:5555',
      device: expect.objectContaining({
        id: '192.168.1.20:5555',
        connection: 'network',
        state: 'unauthorized',
        blockers: ['ANDROID_UNAUTHORIZED'],
      }) as unknown,
    })
    expect(wifiServices(server)).toEqual(['host:connect:192.168.1.20:5555'])

    server.accept('192.168.1.20:5555')
    const row = await waitForRow(
      run,
      '192.168.1.20:5555',
      (r) => r.state === 'ready' && r.osVersion === '11',
    )
    expect(row).toEqual({
      id: '192.168.1.20:5555',
      platform: 'android',
      connection: 'network',
      state: 'ready',
      name: 'SHIELD Android TV',
      model: 'SHIELD Android TV',
      modelId: 'mdarcy',
      osVersion: '11',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
    expect(run.logs.some((l) => l.includes('Wi-Fi: connected to 192.168.1.20:5555'))).toBe(true)
    /** Listed once, then changed in place: Allow never makes the row vanish and come back. */
    const lines = run.logs
      .map((line) => line.replace(/^\d\d:\d\d:\d\d {2}/, ''))
      .filter((line) => line.includes('192.168.1.20:5555') && /^[+~-] /.test(line))
    expect(lines).toEqual([
      '+ Android device (192.168.1.20:5555) · Android · Wi-Fi · waiting for "Allow debugging?"',
      '~ SHIELD Android TV (192.168.1.20:5555) · ready via adb',
    ])
    expect(run.logs).toContainEqual(
      expect.stringContaining(
        'Choose Allow on "Allow debugging?" on the device (with the remote on a TV)',
      ),
    )

    const detail = await request(run.port, {
      path: '/api/devices/192.168.1.20%3A5555/detail',
      headers: run.auth,
    })
    expect(detail.json()).toMatchObject({ serial: '192.168.1.20:5555', connection: 'network' })
    const shot = await request(run.port, {
      method: 'POST',
      path: '/api/devices/192.168.1.20:5555/screenshot',
      headers: run.auth,
    })
    expect([shot.status, shot.headers['content-type']]).toEqual([200, 'image/png'])
    const stream = await openStream(run.port, '/api/devices/192.168.1.20:5555/logs', run.auth)
    if (!isStream(stream)) throw new Error(`no stream: ${stream.text}`)
    await stream.waitFor((m) => m.t === 'lines')
    stream.abort()

    const again = await post(run, '/api/android/connect', { host: '192.168.1.20', port: 5555 })
    expect(again.json()).toMatchObject({
      result: 'already-connected',
      serial: '192.168.1.20:5555',
      device: { state: 'ready', name: 'SHIELD Android TV' },
    })
    /** Everything else the lane sent stayed on the generic allowlist. */
    for (const service of server.services.filter((s) => !wifiServices(server).includes(s))) {
      expect(() => assertAdbService(service)).not.toThrow()
    }
  })

  it('connect failures: refused, blocked, unreachable, unpaired and a silent address, each with its reason', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    server.addNetworkDevice({
      ...shield('192.168.1.40'),
      pairing: { address: '192.168.1.40:37123', code: '482913' },
    })
    server.connectAnswer = (address) => {
      if (address === '192.168.1.30:5555')
        return 'cannot connect to 192.168.1.30:5555: No route to host (65)'
      if (address === '192.168.1.31:5555')
        return 'cannot connect to 192.168.1.31:5555: Host is down (64)'
      if (address === '192.168.1.50:5555') return { hang: true }
      return undefined
    }
    const run = await startAndroid({ adbPort, platform: 'darwin' })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')
    const failure = async (host: string): Promise<unknown> => {
      const reply = await post(run, '/api/android/connect', { host })
      expect(reply.status, host).toBe(502)
      return reply.json<ErrorBody>().error
    }
    expect(await failure('192.168.1.99')).toEqual({
      code: 'ANDROID_CONNECT_FAILED',
      message:
        'Could not connect to 192.168.1.99:5555. Nothing accepted the connection there. On the device, turn on Network debugging (TV) or Wireless debugging (phone), and check the address and port.',
      reason: 'refused',
      detail: "failed to connect to '192.168.1.99:5555': Connection refused",
    })
    expect(await failure('192.168.1.30')).toEqual({
      code: 'ANDROID_CONNECT_FAILED',
      message:
        'Could not connect to 192.168.1.30:5555. Something on this computer is blocking the local network. If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it. On a Mac, start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network.',
      reason: 'blocked',
      detail: 'cannot connect to 192.168.1.30:5555: No route to host (65)',
    })
    expect(await failure('192.168.1.31')).toMatchObject({ reason: 'unreachable' })
    expect(await failure('192.168.1.40')).toMatchObject({ reason: 'unpaired' })
    const started = Date.now()
    expect(await failure('192.168.1.50')).toMatchObject({ reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect((await run.snapshot()).devices).toEqual([])
    expect(run.logs.filter((l) => l.includes('Wi-Fi: could not connect to'))).toHaveLength(5)
    /** Blocked: both likely causes and their fixes under the line, in the terminal's words. */
    const plain = run.logs.map((line) => line.replace(/^\d\d:\d\d:\d\d {2}/, ''))
    const at = plain.findIndex((l) => l.startsWith('Wi-Fi: could not connect to 192.168.1.30'))
    expect(plain.slice(at, at + 3)).toEqual([
      "Wi-Fi: could not connect to 192.168.1.30:5555: no route to host, so this computer can't reach the local network",
      '  If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it',
      '  macOS may not let the app that started the helper (VS Code, some terminals) use the local network: start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network',
    ])
    expect(plain).toContain('Wi-Fi: could not connect to 192.168.1.31:5555')
  })

  it('a pairing blocked the same way says so; off a Mac, no macOS advice', () => {
    const blocked = new HelperError('ANDROID_PAIR_FAILED', 502, 'x', { reason: 'blocked' })
    const head = 'Wi-Fi: could not pair with 192.168.1.30:37123'
    expect(networkFailureLines(head, blocked, 'linux')).toEqual([
      "Wi-Fi: could not pair with 192.168.1.30:37123: no route to host, so this computer can't reach the local network",
      '  If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it',
    ])
    expect(networkFailureLines(head, blocked, 'darwin')).toHaveLength(3)
    const refused = new HelperError('ANDROID_PAIR_FAILED', 502, 'x', { reason: 'refused' })
    expect(networkFailureLines(head, refused, 'darwin')).toEqual([head])
    expect(() =>
      parsePairReply(
        { ok: true, text: "Failed: Unable to connect to '192.168.1.30:37123': No route to host" },
        '192.168.1.30:37123',
      ),
    ).toThrow(expect.objectContaining({ extra: expect.objectContaining({ reason: 'blocked' }) }))
  })

  it('pair: a wrong code, then the right one, then connect; the code is never printed', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice({
      address: '192.168.1.41:41235',
      props: ' product:panther model:Pixel_7 device:panther',
      pairing: { address: '192.168.1.41:37123', code: '482913' },
      allowed: true,
    })
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')
    const wrong = await post(run, '/api/android/pair', {
      host: '192.168.1.41',
      port: 37123,
      code: '111111',
    })
    expect(wrong.status).toBe(502)
    expect(wrong.json<ErrorBody>().error).toMatchObject({
      code: 'ANDROID_PAIR_FAILED',
      reason: 'wrong-code',
      detail: 'Failed: Wrong password or connection was dropped.',
    })
    const right = await post(run, '/api/android/pair', {
      host: '192.168.1.41',
      port: 37123,
      code: '482913',
    })
    expect(right.status).toBe(200)
    expect(right.json()).toEqual({
      result: 'paired',
      host: '192.168.1.41',
      port: 37123,
      message: expect.stringMatching(
        /^Successfully paired to 192\.168\.1\.41:37123 \[guid=/,
      ) as unknown,
    })
    const connect = await post(run, '/api/android/connect', { host: '192.168.1.41', port: 41235 })
    expect(connect.json()).toMatchObject({
      result: 'connected',
      device: { id: '192.168.1.41:41235', state: 'ready', connection: 'network' },
    })
    expect(wifiServices(server)).toEqual([
      'host:pair:111111:192.168.1.41:37123',
      'host:pair:482913:192.168.1.41:37123',
      'host:connect:192.168.1.41:41235',
    ])
    expect(run.logs.join('\n')).not.toMatch(/482913|111111/)
    expect(run.logs.some((l) => l.includes('Wi-Fi: paired with 192.168.1.41:37123'))).toBe(true)
  })

  it('disconnect: only a network serial the server lists; the row goes', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice({ ...shield(), allowed: true })
    /** A Wireless-debugging phone adb found by itself over mDNS, and an emulator on loopback. */
    const mdns = 'adb-55090DLAQ0026D-vWgJpq._adb-tls-connect._tcp'
    server.setDevices([
      pixel(),
      { serial: mdns, state: 'device', props: ' product:tokay model:Pixel_9 transport_id:7' },
      { serial: '127.0.0.1:5555', state: 'device', props: ' transport_id:8' },
    ])
    const run = await startAndroid({ adbPort })
    await post(run, '/api/android/connect', { host: '192.168.1.20' })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'ready')
    for (const [body, message] of [
      [
        { serial: '55090DLAQ0026D' },
        'Only a device connected over Wi-Fi can be disconnected here.',
      ],
      [
        { serial: mdns },
        'Only a device connected by its address (like 192.168.1.20:5555) can be disconnected here.',
      ],
      [{ serial: '192.168.1.21:5555' }, 'That device isn’t connected over Wi-Fi any more.'],
      [{ serial: '' }, 'Name the Wi-Fi device to disconnect.'],
      [{}, 'Name the Wi-Fi device to disconnect.'],
      [{ serial: '-a' }, 'That is not a device id.'],
      [{ serial: '192.168.1.20:5555', host: 'x' }, 'Only these fields are allowed: serial.'],
    ] as const) {
      const reply = await post(run, '/api/android/disconnect', body)
      expect([reply.status, reply.json<ErrorBody>().error], JSON.stringify(body)).toEqual([
        400,
        { code: 'BAD_REQUEST', message },
      ])
    }
    expect(wifiServices(server)).toEqual(['host:connect:192.168.1.20:5555'])
    const reply = await post(run, '/api/android/disconnect', { serial: '192.168.1.20:5555' })
    expect(reply.json()).toEqual({
      result: 'disconnected',
      serial: '192.168.1.20:5555',
      message: 'disconnected 192.168.1.20:5555',
    })
    expect(rowOf(await run.snapshot(), '192.168.1.20:5555')).toBeUndefined()
    expect(rowOf(await run.snapshot(), '55090DLAQ0026D')).toBeDefined()
    expect(wifiServices(server)).toEqual([
      'host:connect:192.168.1.20:5555',
      'host:disconnect:192.168.1.20:5555',
    ])
  })

  it('disconnect: adb lists it `offline` on the way out; the row goes at once and says "disconnected"', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice({ ...shield(), allowed: true })
    server.disconnectLingerMs = 400
    const run = await startAndroid({ adbPort })
    await post(run, '/api/android/connect', { host: '192.168.1.20' })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'ready')
    const reply = await post(run, '/api/android/disconnect', { serial: '192.168.1.20:5555' })
    expect(reply.status).toBe(200)
    /** Still listed by adb (`offline`), but not a device that stopped answering: no row. */
    expect(rowOf(await run.snapshot(), '192.168.1.20:5555')).toBeUndefined()
    /** …nor once adb has let go of it. */
    await sleep(600)
    expect(rowOf(await run.snapshot(), '192.168.1.20:5555')).toBeUndefined()
    const lines = run.logs.map((line) => line.replace(/^\d\d:\d\d:\d\d {2}/, ''))
    expect(lines.filter((l) => l.includes('192.168.1.20:5555') && /^[~-] /.test(l))).toEqual([
      '- SHIELD Android TV (192.168.1.20:5555) · disconnected',
    ])
    expect(lines).toContain('Wi-Fi: disconnected 192.168.1.20:5555')
    expect(lines.join('\n')).not.toMatch(/not answering/)

    /** Connected again: a new device, listed as usual; leaving the Wi-Fi is not a disconnect. */
    await post(run, '/api/android/connect', { host: '192.168.1.20' })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'ready')
    server.drop('192.168.1.20:5555', { awayMs: 300 })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'offline')
    expect(run.logs.join('\n')).toMatch(/not answering over Wi-Fi: wake it, or connect it again/)
  })

  it('a name is looked up first: one that points off the local network, or nowhere, is never sent', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice({ ...shield(), address: 'shield.local:5555', allowed: true })
    const names: Record<string, readonly string[] | 'hang'> = {
      'shield.local': ['192.168.1.20', 'fe80::1%en0'],
      'tv.lan': ['127.0.0.1'],
      'mixed.home.arpa': ['192.168.1.21', '8.8.8.8'],
      'slow.local': 'hang',
    }
    const lookup: HostLookup = (name) => {
      const found = names[name]
      if (found === 'hang') return new Promise(() => undefined)
      return found ? Promise.resolve(found) : Promise.reject(new Error('ENOTFOUND'))
    }
    const run = await startAndroid({ adbPort, lookup })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')

    const ok = await post(run, '/api/android/connect', { host: 'Shield.local' })
    expect(ok.json()).toMatchObject({ serial: 'shield.local:5555', device: { state: 'ready' } })
    for (const [host, address] of [
      ['tv.lan', '127.0.0.1'],
      ['mixed.home.arpa', '8.8.8.8'],
    ] as const) {
      const reply = await post(run, '/api/android/connect', { host })
      expect([reply.status, reply.json<ErrorBody>().error], host).toEqual([
        400,
        {
          code: 'BAD_REQUEST',
          message: `${host} points to ${address}, which is not on your local network. Use the device’s IP address instead.`,
        },
      ])
    }
    const pair = await post(run, '/api/android/pair', {
      host: 'tv.lan',
      port: 37123,
      code: '123456',
    })
    expect(pair.status).toBe(400)
    for (const host of ['gone.local', 'slow.local']) {
      const reply = await post(run, '/api/android/connect', { host })
      expect([reply.status, reply.json<ErrorBody>().error], host).toMatchObject([
        502,
        { code: 'ANDROID_CONNECT_FAILED', reason: 'unresolved' },
      ])
    }
    expect(wifiServices(server)).toEqual(['host:connect:shield.local:5555'])
  })

  it('IPv6 with a zone: the bracketed serial is listed and addressable', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server)
    server.addNetworkDevice({ ...shield(), address: '[fe80::1%en0]:5555', allowed: true })
    const run = await startAndroid({ adbPort })
    const reply = await post(run, '/api/android/connect', { host: 'FE80::1%en0' })
    expect(reply.json()).toMatchObject({ serial: '[fe80::1%en0]:5555', device: { state: 'ready' } })
    expect(wifiServices(server)).toEqual(['host:connect:[fe80::1%en0]:5555'])
    const detail = await request(run.port, {
      path: `/api/devices/${encodeURIComponent('[fe80::1%en0]:5555')}/detail`,
      headers: run.auth,
    })
    expect(detail.json()).toMatchObject({ serial: '[fe80::1%en0]:5555', connection: 'network' })
  })

  it('refuses bad input with 400 before anything reaches the adb server', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')
    const cases: Array<[string, unknown, string]> = [
      ['/api/android/connect', { host: '8.8.8.8' }, 'Only devices on your local network'],
      ['/api/android/connect', { host: '127.0.0.1' }, 'Only devices on your local network'],
      ['/api/android/connect', { host: 'tv.example.com' }, 'Only devices on your local network'],
      [
        '/api/android/connect',
        { host: '192.168.1.20:5555' },
        'Enter the port on its own: the address is just 192.168.1.20.',
      ],
      [
        '/api/android/connect',
        { host: 'tv.local:5555' },
        'Enter the port on its own: the address is just tv.local.',
      ],
      ['/api/android/connect', { host: '192.168.1.20', port: 0 }, 'The port must be'],
      ['/api/android/connect', { host: '192.168.1.20', port: '5555' }, 'The port must be'],
      ['/api/android/connect', { host: '192.168.1.20', serial: 'x' }, 'Only these fields'],
      ['/api/android/connect', [], 'The request must be a JSON object.'],
      ['/api/android/connect', '{"host":', 'The request is not valid JSON.'],
      ['/api/android/pair', { host: '192.168.1.20', port: 37123 }, 'The pairing code is'],
      ['/api/android/pair', { host: '192.168.1.20', code: '123456' }, 'The port must be'],
      [
        '/api/android/pair',
        { host: '192.168.1.20', port: 37123, code: 123456 },
        'The pairing code is',
      ],
    ]
    for (const [path, body, message] of cases) {
      const reply = await post(run, path, body)
      expect(reply.status, JSON.stringify(body)).toBe(400)
      expect(reply.json<ErrorBody>().error.message, JSON.stringify(body)).toContain(message)
    }
    const form = await post(run, '/api/android/connect', 'host=192.168.1.20', {
      'Content-Type': 'application/x-www-form-urlencoded',
    })
    expect([form.status, form.json<ErrorBody>().error.code]).toEqual([400, 'BAD_REQUEST'])
    const big = await post(run, '/api/android/connect', {
      host: '192.168.1.20',
      x: 'y'.repeat(2_000),
    })
    expect(big.status).toBe(413)
    const evil = await post(
      run,
      '/api/android/connect',
      { host: '192.168.1.20' },
      {
        Origin: 'https://evil.example',
      },
    )
    expect(evil.status).toBe(403)
    const anonymous = await request(run.port, {
      method: 'POST',
      path: '/api/android/connect',
      headers: {
        Origin: 'https://bauloc.github.io',
        'Content-Type': 'application/json',
        'Content-Length': '2',
      },
      body: '{}',
    })
    expect(anonymous.status).toBe(401)
    const get = await request(run.port, { path: '/api/android/connect', headers: run.auth })
    expect(get.status).toBe(405)
    expect(wifiServices(server)).toEqual([])
  })

  it('one connect per host at a time: a second one is BUSY, another host is not', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    server.connectAnswer = (address) =>
      address === '192.168.1.50:5555' ? { hang: true } : undefined
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')
    const first = post(run, '/api/android/connect', { host: '192.168.1.50' })
    await until(() => wifiServices(server).length === 1, 2_000, 'first connect sent')
    const second = await post(run, '/api/android/connect', { host: '192.168.1.50', port: 5556 })
    expect([second.status, second.json<ErrorBody>().error.code]).toEqual([409, 'BUSY'])
    const other = await post(run, '/api/android/connect', { host: '192.168.1.51' })
    expect(other.json<ErrorBody>().error).toMatchObject({ reason: 'refused' })
    expect((await first).json<ErrorBody>().error).toMatchObject({ reason: 'timeout' })
    expect(wifiServices(server)).toEqual([
      'host:connect:192.168.1.50:5555',
      'host:connect:192.168.1.51:5555',
    ])
  })

  it('no adb server: ADB_SERVER_STOPPED, and none is started', async () => {
    const run = await startAndroid({ adbPort: await freePort() })
    await until(async () => (await run.snapshot()).lanes.android.status === 'stopped')
    for (const [path, body] of [
      ['/api/android/connect', { host: '192.168.1.20' }],
      ['/api/android/pair', { host: '192.168.1.20', port: 37123, code: '123456' }],
      ['/api/android/disconnect', { serial: '192.168.1.20:5555' }],
    ] as const) {
      const reply = await post(run, path, body)
      expect([reply.status, reply.json<ErrorBody>().error.code], path).toEqual([
        503,
        'ADB_SERVER_STOPPED',
      ])
    }
    expect(run.calls().filter((c) => c.name === 'adb' && c.argv[0] !== 'version')).toEqual([])
  })

  it('--no-android: ANDROID_OFF', async () => {
    const s = await startBridge({ lanes: { android: null } })
    const text = JSON.stringify({ host: '192.168.1.20' })
    const reply = await request(s.port, {
      method: 'POST',
      path: '/api/android/connect',
      headers: {
        ...s.auth,
        'Content-Type': 'application/json',
        'Content-Length': String(text.length),
      },
      body: text,
    })
    expect([reply.status, reply.json<ErrorBody>().error.code]).toEqual([409, 'ANDROID_OFF'])
  })

  it('a TV that leaves the Wi-Fi: the log ends as a drop (offline first), then the row goes, nothing crashes', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    /** logcat that keeps quiet after its history, like a link that died without a FIN. */
    shieldExec(server, (socket) => {
      socket.write('10-04 08:41:02.000  1  1 I Tag: hello\n')
    })
    server.addNetworkDevice({ ...shield(), allowed: true })
    const run = await startAndroid({ adbPort })
    await post(run, '/api/android/connect', { host: '192.168.1.20' })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'ready')
    const stream = await openStream(run.port, '/api/devices/192.168.1.20:5555/logs', run.auth)
    if (!isStream(stream)) throw new Error(`no stream: ${stream.text}`)
    await stream.waitFor((m) => m.t === 'lines')
    server.drop('192.168.1.20:5555', { awayMs: 1_500 })
    const end = await stream.waitFor((m) => m.t === 'end')
    expect(end).toEqual({
      t: 'end',
      reason: 'device-gone',
      code: 'DEVICE_DROPPED',
      message: 'The device dropped off the network.',
    })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'offline')
    await until(async () => !rowOf(await run.snapshot(), '192.168.1.20:5555'), 4_000, 'row gone')
    await until(() => server.streams() === 0, 2_000, 'logcat socket closed')
    expect(run.logs.some((l) => l.includes('- SHIELD Android TV'))).toBe(true)
  })

  it('a TV that leaves while its log runs over a socket adb closes: still a drop, not an eof', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    shieldExec(server, (socket) => {
      socket.write('10-04 08:41:02.000  1  1 I Tag: hello\n')
    })
    server.addNetworkDevice({ ...shield(), allowed: true })
    const run = await startAndroid({ adbPort })
    await post(run, '/api/android/connect', { host: '192.168.1.20' })
    await waitForRow(run, '192.168.1.20:5555', (r) => r.state === 'ready')
    const stream = (await openStream(
      run.port,
      '/api/devices/192.168.1.20:5555/logs',
      run.auth,
    )) as Stream
    await stream.waitFor((m) => m.t === 'lines')
    server.drop('192.168.1.20:5555', { awayMs: 2_000, closeStreams: true })
    expect(await stream.waitFor((m) => m.t === 'end')).toMatchObject({
      reason: 'device-gone',
      code: 'DEVICE_DROPPED',
    })
  })
})

describe('starting the server (§4.5)', () => {
  it('spawns exactly `adb start-server`, untracked, and waits for host:version', async () => {
    const adbPort = await freePort()
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'stopped')
    let server: FakeAdbServer | null = null
    /** The fake CLI only records the call; the test plays the daemon it would fork. */
    const daemon = (async () => {
      await until(() => run.calls().some((c) => c.argv[0] === 'start-server'), 3_000)
      await sleep(150)
      server = await fakeServer(adbPort)
    })()
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: run.auth,
    })
    await daemon
    expect(reply.status).toBe(200)
    expect(reply.json()).toMatchObject({
      android: { status: 'ok', startedByHelper: true, serverProtocol: 41 },
    })
    const adbCalls = run.calls().filter((c) => c.name === 'adb')
    expect(adbCalls.filter((c) => c.argv[0] !== 'version').map((c) => c.argv)).toEqual([
      ['start-server'],
    ])
    expect(readFileSync(`${stateDir(run)}/adb-port`, 'utf8')).toBe(String(adbPort))
    expect([...liveChildren].some((child) => child.spawnfile === run.adbPath)).toBe(false)
    expect(server).not.toBeNull()
    expect(
      run.logs.some((l) => l.includes('adb server started from Device Lab (protocol 41)')),
    ).toBe(true)
  })

  it('ADB_START_FAILED when no server answers in time', async () => {
    const run = await startAndroid({ adbPort: await freePort() })
    await until(async () => (await run.snapshot()).lanes.android.status === 'stopped')
    const started = Date.now()
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: run.auth,
    })
    expect(reply.status).toBe(502)
    expect(reply.json()).toMatchObject({ error: { code: 'ADB_START_FAILED' } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.adbStartPoll ?? 0)
  })

  it('adb missing: TOOL_MISSING with the install command, nothing spawned', async () => {
    const run = await startAndroid({ adbPort: await freePort(), adb: false })
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: run.auth,
    })
    expect(reply.status).toBe(503)
    expect(reply.json()).toMatchObject({
      error: {
        code: 'TOOL_MISSING',
        tool: 'adb',
        install: 'brew install --cask android-platform-tools',
      },
    })
    expect(run.calls().filter((c) => c.argv[0] === 'start-server')).toEqual([])
  })

  it('a server already running is shared, not started again', async () => {
    const adbPort = await freePort()
    await fakeServer(adbPort)
    const run = await startAndroid({ adbPort })
    await until(async () => (await run.snapshot()).lanes.android.status === 'ok')
    const reply = await request(run.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: run.auth,
    })
    expect(reply.json()).toMatchObject({ android: { status: 'ok', startedByHelper: false } })
    expect(run.calls().filter((c) => c.argv[0] === 'start-server')).toEqual([])
  })

  it('startAdbServer on its own: a missing binary is TOOL_MISSING', async () => {
    await expect(
      startAdbServer('/nonexistent/adb', {
        port: await freePort(),
        timeouts: TIMEOUTS_FAST,
        env: { PATH: '/usr/bin:/bin' },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_MISSING' })
  })
})

describe('--doctor (§1.9)', () => {
  it('prints the server state and the devices -l rows, asked directly', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    server.setDevices([
      pixel(),
      { serial: 'R58MC0ABCDE', state: 'unauthorized', props: ' usb:1-2 transport_id:4' },
    ])
    const iso = await isolation({ adbPort, timeouts: FAST })
    const bridge = createBridge({
      ...iso.input,
      lanes: { ios: null, simulators: null, android: (ctx) => createAndroidLane(ctx, CADENCE) },
    })
    const lines: string[] = []
    await bridge.lanes.android?.probeForDoctor?.((line) => lines.push(line))
    expect(lines).toEqual([
      `Android: adb server on 127.0.0.1:${String(adbPort)}, protocol 41`,
      'Android: 2 device(s) listed by the adb server',
      '  55090DLAQ0026D · device · usb:1-1 · product:tokay · model:Pixel_9 · device:tokay · transport_id:3',
      '  R58MC0ABCDE · unauthorized · usb:1-2 · transport_id:4',
    ])
    expect(server.services).toEqual(['host:version', 'host:devices-l'])
  })

  it('says so when no server runs, and starts none', async () => {
    const adbPort = await freePort()
    const iso = await isolation({ adbPort })
    const bridge = createBridge({
      ...iso.input,
      lanes: { ios: null, simulators: null, android: createAndroidLane },
    })
    const lines: string[] = []
    await bridge.lanes.android?.probeForDoctor?.((line) => lines.push(line))
    expect(lines).toEqual([
      `Android: no adb server on 127.0.0.1:${String(adbPort)} (the doctor never starts one)`,
    ])
    expect(iso.bin.calls()).toEqual([])
  })
})

describe('facts for the checklist', () => {
  it('report the server, its protocol and the phones', async () => {
    const adbPort = await freePort()
    const server = await fakeServer(adbPort)
    pixelExec(server)
    server.setDevices([pixel()])
    const run = await startAndroid({ adbPort })
    await waitForRow(run, '55090DLAQ0026D')
    expect(run.bridge.lanes.android?.facts()).toMatchObject({
      adb: run.adbPath,
      version: '36.0.0',
      server: 'running',
      serverProtocol: 41,
      devices: [{ serial: '55090DLAQ0026D', state: 'device', model: 'Pixel 9' }],
      startedByHelper: false,
    })
  })
})

/** The fake bin's state folder, next to its bin folder. */
function stateDir(run: AndroidRun): string {
  return run.adbPath.replace(/\/bin\/adb$/, '/state')
}
