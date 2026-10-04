import { describe, expect, it, vi } from 'vitest'

import { createHelperClient, HelperError } from '../helper/client'
import type { HelperConnection, HelperPhase, HelperStatus } from '../helper/connection'
import type { HelperDevice, LogMsg } from '../helper/protocol'
import { androidDetail } from './android'
import {
  LOG_ENDED_LINE,
  createAgentBackend,
  logEndError,
  streamLogs,
  toDetail,
  toDevice,
} from './agent'
import { deviceErrorMessage } from './backend'
import { DETAIL_FIXTURES } from './fixtures'

/*
  The helper lane on a scripted HelperConnection: how its rows become Devices, which formatter
  each detail goes through, how a log stream's end settles, and that Refresh never probes a
  helper the tester hasn't asked for. agent.contract.test.ts runs the same lane against the
  real built helper.
*/

const ALL = { screenshot: true, identifiers: true, logs: true, install: false } as const

const IPHONE: HelperDevice = {
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone 12 Pro',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: ALL,
}

const status = (phase: HelperPhase): HelperStatus => ({
  phase,
  promptLikely: false,
  env: {
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:8787',
    port: 8787,
    safariLike: false,
    devOrigin: false,
  },
  permission: 'granted',
  health: null,
  lanes: null,
  pairing: null,
  remember: false,
  intent: false,
  since: 0,
  error: null,
})

/** A HelperConnection whose phase, rows and log stream the test decides. */
function fakeConnection(opts: { phase?: HelperPhase; devices?: HelperDevice[] } = {}) {
  let phase = opts.phase ?? 'connected'
  let messages: LogMsg[] = []
  const conn = {
    getStatus: vi.fn(() => status(phase)),
    subscribeStatus: vi.fn(() => () => undefined),
    getDevices: vi.fn(() => opts.devices ?? []),
    subscribeDevices: vi.fn<HelperConnection['subscribeDevices']>(() => () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
    connect: vi.fn(),
    pair: vi.fn(() => Promise.resolve({ ok: true } as const)),
    forget: vi.fn(),
    setRemember: vi.fn(),
    rescan: vi.fn(() => Promise.resolve()),
    pollNow: vi.fn(),
    doctor: vi.fn(() => Promise.resolve(null)),
    startAdb: vi.fn(() => Promise.resolve()),
    connectNetwork: vi.fn(() => Promise.reject(new Error('unset'))),
    pairNetwork: vi.fn(() => Promise.reject(new Error('unset'))),
    disconnectNetwork: vi.fn(() => Promise.reject(new Error('unset'))),
    api: {
      detail: vi.fn<HelperConnection['api']['detail']>(() => Promise.reject(new Error('unset'))),
      screenshot: vi.fn<HelperConnection['api']['screenshot']>(() =>
        Promise.resolve(new Blob(['png'], { type: 'image/png' })),
      ),
      capture: vi.fn(() => Promise.resolve({ blob: new Blob(), source: null })),
      retry: vi.fn(() => Promise.resolve(null)),
      /** Plays `messages`, stopping early when the signal aborts, as the client does. */
      logs: vi.fn((_id: string, onMsg: (m: LogMsg) => void, signal: AbortSignal) => {
        for (const m of messages) {
          if (signal.aborted) break
          onMsg(m)
        }
        return Promise.resolve()
      }),
    },
  } satisfies HelperConnection
  return {
    conn,
    setPhase(next: HelperPhase) {
      phase = next
    },
    play(next: LogMsg[]) {
      messages = next
    },
  }
}

describe('toDevice', () => {
  it('names an iPhone from its ProductType: the helper never knows the marketing name', () => {
    expect(toDevice(IPHONE)).toEqual({
      id: IPHONE.id,
      backend: 'agent',
      platform: 'ios',
      connection: 'usb',
      state: 'ready',
      name: 'Ngọc’s iPhone 12 Pro',
      model: 'iPhone 12 Pro',
      osVersion: '27.0',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
  })

  it('falls back to the identifier, and to it again for the name when the phone has none', () => {
    const d = toDevice({ ...IPHONE, name: '', modelId: 'iPhone99,1' })
    expect(d.model).toBe('iPhone99,1')
    expect(d.name).toBe('iPhone99,1')
  })

  it('keeps the helper’s own model for Android, and never maps an Android codename', () => {
    const pixel: HelperDevice = {
      ...IPHONE,
      id: '55090DLAQ0026D',
      platform: 'android',
      model: 'Pixel 9',
      modelId: 'tokay',
    }
    expect(toDevice(pixel).model).toBe('Pixel 9')
    // An Android phone whose codename happens to look like an Apple identifier stays as it is.
    expect(toDevice({ ...pixel, model: '', modelId: 'iPhone13,3' }).model).toBe('iPhone13,3')
  })

  it('keeps a simulator a simulator, and copies blockers rather than sharing them', () => {
    const blockers = ['XCODE_REQUIRED']
    const sim = toDevice({
      ...IPHONE,
      id: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
      connection: 'simulator',
      blockers,
    })
    expect(sim.connection).toBe('simulator')
    expect(sim.blockers).toEqual(blockers)
    expect(sim.blockers).not.toBe(blockers)
  })
})

describe('toDetail', () => {
  const pixel = DETAIL_FIXTURES['pixel-9']!

  it.each([
    ['usb', 'USB (adb server)'],
    ['network', 'Wi‑Fi (adb server)'],
    ['simulator', 'Emulator (adb server)'],
  ] as const)(
    'reads an Android phone over %s exactly as WebUSB does, Connection aside',
    (connection, label) => {
      const detail = toDetail({
        platform: 'android',
        kind: 'android',
        serial: pixel.serial,
        connection,
        outputs: pixel.outputs,
      })
      const webusb = androidDetail(pixel.outputs, pixel.serial)
      expect(detail).toEqual({ ...webusb, status: { ...webusb.status, Connection: label } })
    },
  )

  it('labels an iPhone by its transport, and formats a simulator as one', () => {
    const facts = {
      udid: IPHONE.id,
      connection: 'network' as const,
      source: 'lockdown' as const,
      device: { ProductType: 'iPhone13,3' },
      developerMode: true,
      locked: false,
      withheld: [],
    }
    const wifi = toDetail({ platform: 'ios', kind: 'ios', facts })
    expect(wifi.status.Connection).toBe('Wi‑Fi (local helper)')
    expect(wifi.identity.Model).toBe('iPhone 12 Pro')
    const usb = toDetail({ platform: 'ios', kind: 'ios', facts: { ...facts, connection: 'usb' } })
    expect(usb.status.Connection).toBe('USB (local helper)')

    const sim = toDetail({
      platform: 'ios',
      kind: 'simulator',
      facts: {
        udid: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
        name: 'iPhone 17 Pro',
        deviceType: { name: 'iPhone 17 Pro', modelIdentifier: 'iPhone18,1' },
        runtime: { name: 'iOS 27.0', version: '27.0', build: '24A5300a' },
        state: 'Booted',
      },
    })
    expect(sim.status.Connection).toBe('Simulator')
  })
})

describe('the agent lane', () => {
  it('starts the connection without waiting for the helper, and stops it', async () => {
    const { conn } = fakeConnection({ phase: 'off' })
    const lane = createAgentBackend(conn)
    expect(lane).toMatchObject({ kind: 'agent', canRequest: false, platforms: ['ios', 'android'] })
    expect(lane.isAvailable()).toBe(true)
    await expect(lane.start()).resolves.toBeUndefined()
    expect(conn.start).toHaveBeenCalledOnce()
    lane.stop()
    expect(conn.stop).toHaveBeenCalledOnce()
  })

  it('lists the connection’s rows, and subscribes through it', () => {
    const { conn } = fakeConnection({ devices: [IPHONE] })
    const lane = createAgentBackend(conn)
    expect(lane.list().map((d) => [d.id, d.backend, d.model])).toEqual([
      [IPHONE.id, 'agent', 'iPhone 12 Pro'],
    ])
    const listener = () => undefined
    lane.subscribe(listener)
    expect(conn.subscribeDevices).toHaveBeenCalledWith(listener)
  })

  it('formats detail, and passes screenshot and retry through', async () => {
    const { conn } = fakeConnection()
    conn.api.detail.mockResolvedValueOnce({
      platform: 'ios',
      kind: 'ios',
      facts: {
        udid: IPHONE.id,
        connection: 'usb',
        source: 'lockdown',
        device: { DeviceName: 'Ngọc’s iPhone 12 Pro', ProductType: 'iPhone13,3' },
        developerMode: true,
        locked: false,
        withheld: [],
      },
    })
    const lane = createAgentBackend(conn)
    expect((await lane.detail(IPHONE.id)).identity['Device name']).toBe('Ngọc’s iPhone 12 Pro')
    expect((await lane.screenshot(IPHONE.id)).type).toBe('image/png')
    await lane.retry?.(IPHONE.id)
    expect(conn.api.retry).toHaveBeenCalledWith(IPHONE.id)
  })

  it('rescans when connected and looks again when absent or lost', async () => {
    const fake = fakeConnection({ phase: 'connected' })
    const lane = createAgentBackend(fake.conn)
    await lane.refresh?.()
    expect(fake.conn.rescan).toHaveBeenCalledOnce()
    for (const phase of ['absent', 'lost'] as const) {
      fake.setPhase(phase)
      await lane.refresh?.()
    }
    expect(fake.conn.pollNow).toHaveBeenCalledTimes(2)
    expect(fake.conn.rescan).toHaveBeenCalledOnce()
  })

  it.each(['off', 'denied', 'safari', 'dismissed', 'checking'] as const)(
    'never probes on Refresh in %s, so R can’t raise the browser’s prompt',
    async (phase) => {
      const { conn } = fakeConnection({ phase })
      await createAgentBackend(conn).refresh?.()
      expect(conn.pollNow).not.toHaveBeenCalled()
      expect(conn.rescan).not.toHaveBeenCalled()
      expect(conn.connect).not.toHaveBeenCalled()
    },
  )
})

describe('screenshots through the client', () => {
  const pngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
    0x60, 0x82,
  ])

  /** The lane over a real client whose fetch answers `res`. */
  function laneAnswering(res: () => Response) {
    const client = createHelperClient('http://127.0.0.1:8787', () => 'x'.repeat(43), {
      fetch: () => Promise.resolve(res()),
    })
    const { conn } = fakeConnection()
    conn.api.screenshot.mockImplementation(async (id: string) => (await client.screenshot(id)).blob)
    conn.api.detail.mockImplementation((id: string) => client.detail(id))
    return createAgentBackend(conn)
  }

  it('hands on a clean PNG, cut at IEND', async () => {
    const lane = laneAnswering(
      () =>
        new Response(new Blob([pngBytes, 'trailing text']), {
          headers: { 'Content-Type': 'image/png', 'X-Screenshot-Source': 'devicectl' },
        }),
    )
    const blob = await lane.screenshot(IPHONE.id)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pngBytes)
  })

  it('refuses anything that isn’t a PNG, in the words the page already has', async () => {
    const lane = laneAnswering(
      () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    )
    const error = await lane.screenshot(IPHONE.id).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'SCREENSHOT_NOT_PNG' })
    expect(deviceErrorMessage(error)).toMatch(/not a PNG/)
  })

  it('words the helper’s 409 for a device in the middle of another capture', async () => {
    const lane = laneAnswering(() =>
      Response.json(
        { error: { code: 'BUSY', message: 'A screenshot of this device is already being taken.' } },
        { status: 409 },
      ),
    )
    const error = await lane.screenshot(IPHONE.id).catch((e: unknown) => e)
    expect(deviceErrorMessage(error)).toBe('A screenshot of this device is already being taken.')
  })

  it('words a Wi‑Fi iPhone’s 502 IOS_UNREACHABLE on detail as a “try again”, cable or Wi‑Fi', async () => {
    const lane = laneAnswering(() =>
      Response.json(
        { error: { code: 'IOS_UNREACHABLE', message: 'The iPhone is not reachable right now.' } },
        { status: 502 },
      ),
    )
    const error = await lane.detail(IPHONE.id).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'IOS_UNREACHABLE' })
    expect(deviceErrorMessage(error)).toBe(
      'The device isn’t reachable right now. Unlock it, keep it on the cable (or the same Wi‑Fi), and try again.',
    )
  })
})

describe('logs', () => {
  const hello: LogMsg = { t: 'hello', device: IPHONE.id, source: 'syslog_relay', at: 1 }
  const lines: LogMsg = { t: 'lines', lines: ['Oct  4 09:53:23 iPhone kernel[0] <Notice>: one'] }

  async function run(messages: LogMsg[], signal = new AbortController().signal) {
    const fake = fakeConnection()
    fake.play(messages)
    const got: string[] = []
    const result = await streamLogs(fake.conn, IPHONE.id, (l) => got.push(...l), signal).then(
      () => null,
      (e: unknown) => e,
    )
    return { got, error: result, pollNow: fake.conn.pollNow }
  }

  it('passes lines and notices on, and says when the log simply ended', async () => {
    const { got, error } = await run([
      hello,
      lines,
      { t: 'ping', at: 2 },
      { t: 'notice', text: 'Connected through idevicesyslog' },
      { t: 'end', reason: 'eof' },
    ])
    expect(error).toBeNull()
    expect(got).toEqual([
      'Oct  4 09:53:23 iPhone kernel[0] <Notice>: one',
      '— Connected through idevicesyslog',
      LOG_ENDED_LINE,
    ])
  })

  it('leaves a Wi‑Fi device’s ending to the page’s log, which says it dropped', async () => {
    const fake = fakeConnection({
      devices: [{ ...IPHONE, id: '192.168.1.42:5555', platform: 'android', connection: 'network' }],
    })
    fake.play([hello, lines, { t: 'end', reason: 'eof' }])
    const got: string[] = []
    await streamLogs(
      fake.conn,
      '192.168.1.42:5555',
      (l) => got.push(...l),
      new AbortController().signal,
    )
    expect(got).toEqual(['Oct  4 09:53:23 iPhone kernel[0] <Notice>: one'])
    expect(fake.conn.pollNow).toHaveBeenCalled()
  })

  it.each([
    ['device-gone', undefined, 'DEVICE_GONE', 'The device is no longer connected.'],
    ['shutdown', undefined, 'HELPER_UNREACHABLE', /local helper stopped answering/],
    ['replaced', undefined, 'STREAM_REPLACED', /another tab or window/],
    ['error', 'LOGS_UNAVAILABLE', 'LOGS_UNAVAILABLE', 'No log source works for this device.'],
    ['error', undefined, 'TOOL_FAILED', /tool failed/],
  ] as const)(
    'ends %s (%s) as %s, and looks at the list again',
    async (reason, code, want, words) => {
      const { error, pollNow } = await run([hello, { t: 'end', reason, ...(code ? { code } : {}) }])
      expect(error).toBeInstanceOf(HelperError)
      expect(error).toMatchObject({ code: want })
      if (typeof words === 'string') expect(deviceErrorMessage(error)).toBe(words)
      else expect(deviceErrorMessage(error)).toMatch(words)
      expect(pollNow).toHaveBeenCalledOnce()
    },
  )

  it('says the helper’s own words for an error code this page doesn’t know', async () => {
    const { error } = await run([
      hello,
      { t: 'end', reason: 'error', code: 'SOMETHING_NEW', message: 'The phone said no.' },
    ])
    expect(deviceErrorMessage(error)).toBe('The phone said no.')
  })

  it('reads a stream cut off without its end as the helper gone', async () => {
    const { error } = await run([hello, lines])
    expect(error).toMatchObject({ code: 'HELPER_UNREACHABLE' })
  })

  it('resolves quietly on abort, and drops what arrives after it', async () => {
    const controller = new AbortController()
    const fake = fakeConnection()
    const got: string[] = []
    fake.conn.api.logs.mockImplementationOnce((_id, onMsg) => {
      onMsg(lines)
      controller.abort()
      onMsg(lines)
      onMsg({ t: 'end', reason: 'device-gone' })
      return Promise.resolve()
    })
    await expect(
      streamLogs(fake.conn, IPHONE.id, (l) => got.push(...l), controller.signal),
    ).resolves.toBeUndefined()
    expect(got).toHaveLength(1)
    expect(fake.conn.pollNow).not.toHaveBeenCalled()
  })

  it('rejects with the client’s code when the stream can’t open', async () => {
    const fake = fakeConnection()
    fake.conn.api.logs.mockRejectedValueOnce(new HelperError('TOO_MANY_STREAMS', 'http'))
    const lane = createAgentBackend(fake.conn)
    const error = await lane
      .logs?.(IPHONE.id, () => undefined, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(deviceErrorMessage(error)).toBe('Too many logs are open. Stop one, then start this one.')
  })

  it('maps every end reason', () => {
    expect(logEndError({ t: 'end', reason: 'eof' })).toBeNull()
    expect(logEndError({ t: 'end', reason: 'client-gone' })).toBeNull()
    expect(logEndError(null)?.code).toBe('HELPER_UNREACHABLE')
  })
})
