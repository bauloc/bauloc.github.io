import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createHelperConnection, type HelperConnection } from '../helper/connection'
import { stashPendingPair } from '../helper/pair-fragment'
import {
  DVC_MAX_AGENT,
  DVC_MIN_AGENT,
  TUNNEL_PROTOCOL,
  type HelperDevice,
} from '../helper/protocol'
import {
  IPHONE,
  PIXEL,
  SIMULATOR,
  startRealHelper,
  tinyPng,
  type RealHelper,
} from '../helper/testing/real-helper'
import { memoryStores } from '../helper/token'
import { DEVICE_HINTS } from '../model'
import { nearbyRows } from '../nearby'
import { createDeviceLab, type DeviceLab } from '../store'
import { LOG_ENDED_LINE, createAgentBackend } from './agent'
import { DETAIL_COMMANDS, androidDetail } from './android'
import { DEVICE_ERRORS, deviceErrorMessage, type Backend } from './backend'
import { DETAIL_FIXTURES } from './fixtures'

/*
  The page's agent lane against the REAL helper: device/agent/device-bridge.mjs, the file
  testers download, run in this process with the helper suite's fake lanes (helper/testing/
  real-helper.ts). Two halves:

  1. The contract, read from the built file: the Android detail commands, the protocol
     range, a hint for every blocker the helper can emit, wording for every error code it can
     send, and the shared Pixel 9 fixture. A helper change that breaks one fails here, before
     a tester sees a raw code.
  2. The lane end to end through the store: proof → devices → detail → screenshot → logs →
     the helper stopping → lost, with nothing on this Mac run.
*/

const at = (path: string) => new URL(path, import.meta.url)
const BUILT = at('../../../../../device/agent/device-bridge.mjs')

/** What the built file exports for this contract (its sources are typed against Node). */
interface BuiltHelper {
  readonly ADB_DETAIL: readonly (readonly [string, string])[]
  readonly EMITTED_BLOCKERS: readonly string[]
  readonly PROTOCOL: number
}
const built = (await import(/* @vite-ignore */ BUILT.href)) as BuiltHelper
const builtText = readFileSync(fileURLToPath(BUILT), 'utf8')

/** Codes that never reach the page as an error to word (no CORS headers, or not the API). */
const NEVER_WORDED = new Set([
  'BAD_HOST', // 421 without CORS: the page sees a TypeError
  'BAD_ORIGIN', // 403 without CORS, likewise
  'UPSTREAM_UNREACHABLE', // local mode's proxied page, not the API
  'UPSTREAM_STATUS',
  'UPSTREAM_REDIRECT',
  'UPSTREAM_TOO_LARGE',
])

describe('the contract with the built helper', () => {
  it('runs the same Android detail commands as WebUSB, in the same order', () => {
    expect(built.ADB_DETAIL.map(([, command]) => command)).toEqual(
      DETAIL_COMMANDS.map((c) => c.join(' ')),
    )
  })

  it('speaks a protocol this page accepts', () => {
    expect(built.PROTOCOL).toBeGreaterThanOrEqual(DVC_MIN_AGENT)
    expect(built.PROTOCOL).toBeLessThanOrEqual(DVC_MAX_AGENT)
  })

  it('opens the adb tunnel with the subprotocol the helper answers (§4.10)', () => {
    expect(builtText).toContain(`const TUNNEL_PROTOCOL = "${TUNNEL_PROTOCOL}";`)
  })

  it('has a hint for every blocker the helper can put on a row', () => {
    expect(built.EMITTED_BLOCKERS.length).toBeGreaterThan(5)
    expect(built.EMITTED_BLOCKERS.filter((code) => !DEVICE_HINTS[code])).toEqual([])
  })

  it('has words for every error code the helper can send', () => {
    const codes = new Set(
      [...builtText.matchAll(/\b(?:new HelperError|errorBody)\("([A-Z0-9_]+)"/g)].map((m) => m[1]),
    )
    expect(codes.size).toBeGreaterThan(20)
    const unworded = [...codes].filter(
      (code) => code !== undefined && !NEVER_WORDED.has(code) && !(code in DEVICE_ERRORS),
    )
    expect(unworded).toEqual([])
  })

  it('shares the Pixel 9 fixture with the helper suite', () => {
    const shared: unknown = JSON.parse(
      readFileSync(fileURLToPath(at('../../../../helper/test/fixtures/pixel-9.json')), 'utf8'),
    )
    expect(shared).toEqual(DETAIL_FIXTURES['pixel-9'])
  })
})

/* ------------------------------------------------------------------------- end to end --- */

const pixelFixture = DETAIL_FIXTURES['pixel-9']!

const helpers: RealHelper[] = []
const stops: (() => void)[] = []

// Node has URL.createObjectURL, so the store's screenshot blob URLs work as in a browser.
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const helper of helpers.splice(0)) await helper.close()
})

async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The page as device-lab-page builds it, minus WebUSB: one connection, its lane, the store. */
async function pageAgainst(helper: RealHelper): Promise<{
  conn: HelperConnection
  lane: Backend
  lab: DeviceLab
}> {
  const stores = memoryStores()
  stashPendingPair({ token: helper.token, port: helper.port }, stores)
  const conn = createHelperConnection(
    {
      mode: 'hosted',
      apiBase: helper.apiBase,
      port: helper.port,
      safariLike: false,
      devOrigin: false,
    },
    {
      fetch: helper.fetch,
      webSocket: helper.webSocket,
      stores,
      permissions: { query: () => Promise.resolve({ state: 'granted', onchange: null }) },
      document: null,
      window: null,
    },
  )
  const lane = createAgentBackend(conn)
  const lab = createDeviceLab([lane])
  stops.push(() => {
    lab.stop()
  })
  await lab.start()
  return { conn, lane, lab }
}

describe('the agent lane end to end', () => {
  it('pairs, lists, details, captures, streams, and goes lost when the helper stops', async () => {
    const helper = await startRealHelper({
      ios: {
        rows: [IPHONE],
        screenshot: () => Promise.resolve({ png: tinyPng(), source: 'devicectl' }),
        async logs(_id, sink, signal) {
          sink.hello('syslog_relay')
          while (!signal.aborted) {
            sink.push(['Oct  4 09:53:23 iPhone locationd[275] <Error>: tick'])
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        },
      },
      android: {
        rows: [PIXEL],
        detail: (id) =>
          Promise.resolve({
            platform: 'android',
            kind: 'android',
            serial: id,
            connection: 'usb',
            outputs: pixelFixture.outputs,
          }),
      },
      simulators: { rows: [SIMULATOR] },
    })
    helpers.push(helper)
    const { conn, lane, lab } = await pageAgainst(helper)
    await until(() => lab.getSnapshot().devices.length === 3, 'three devices')

    // Never a token before the proof.
    expect(helper.requests[0]).toMatchObject({ authorization: null })

    const byId = (id: string) => lab.getSnapshot().devices.find((d) => d.id === id)
    expect(byId(IPHONE.id)).toMatchObject({ backend: 'agent', model: 'iPhone 12 Pro' })
    expect(byId(SIMULATOR.id)).toMatchObject({ connection: 'simulator', platform: 'ios' })
    // Through the adb tunnel (§4.10) the Pixel gets WebUSB's operations: its API level and
    // ABIs are read with getprop, each a WebSocket the helper pipes to the device.
    await until(() => byId(PIXEL.id)?.capabilities.install === true, 'the Pixel installable')
    expect(byId(PIXEL.id)).toMatchObject({
      capabilities: { install: true, apps: true, images: true },
      android: { sdk: 37, release: '17', manufacturer: 'Google', abis: ['arm64-v8a'] },
    })
    expect(helper.calls('android')).toContainEqual({ op: 'adbInfo', id: PIXEL.id })
    expect(helper.calls('android')).toContainEqual({
      op: 'openTunnel exec:getprop',
      id: PIXEL.id,
    })

    // Android detail through the helper equals WebUSB's, Connection aside.
    const webusb = androidDetail(pixelFixture.outputs, pixelFixture.serial)
    expect(await lane.detail(PIXEL.id)).toEqual({
      ...webusb,
      status: { ...webusb.status, Connection: 'USB (adb server)' },
    })
    const iphone = await lane.detail(IPHONE.id)
    expect(iphone.identity).toMatchObject({ Model: 'iPhone 12 Pro', Identifier: IPHONE.id })
    expect(iphone.status.Connection).toBe('USB (local helper)')
    expect((await lane.detail(SIMULATOR.id)).status.Connection).toBe('Simulator')

    // A screenshot is a clean PNG Blob, and the store keeps it.
    const blob = await lane.screenshot(IPHONE.id)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.from(tinyPng()))
    expect(await lab.capture(IPHONE.id)).toBeNull()
    expect(lab.getSnapshot().shots).toHaveLength(1)

    // Android's default fake log: two lines, then eof.
    const pixelLines: string[] = []
    await lane.logs?.(PIXEL.id, (l) => pixelLines.push(...l), new AbortController().signal)
    expect(pixelLines).toEqual(['first line', 'second line', LOG_ENDED_LINE])

    // The iPhone's log streams until Stop, then resolves quietly.
    const stop = new AbortController()
    const iosLines: string[] = []
    const streaming = lane.logs?.(IPHONE.id, (l) => iosLines.push(...l), stop.signal)
    await until(() => iosLines.length > 0, 'a syslog batch')
    stop.abort()
    await expect(streaming).resolves.toBeUndefined()
    expect(iosLines[0]).toMatch(/<Error>: tick$/)

    // Refresh while connected asks the helper to re-list.
    await lab.refresh()
    expect(helper.requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/rescan'))).toBe(
      true,
    )

    // The helper stops: the list empties, and a request now says so in words.
    await helper.close()
    helpers.splice(0)
    conn.pollNow()
    await until(() => conn.getStatus().phase === 'lost', 'lost')
    expect(lane.list()).toEqual([])
    await until(() => lab.getSnapshot().devices.length === 0, 'an empty list')
    expect(deviceErrorMessage(await lane.detail(IPHONE.id).catch((e: unknown) => e))).toMatch(
      /local helper stopped answering/,
    )
  })

  it('ends a log as DEVICE_GONE when the phone is unplugged mid-stream', async () => {
    const helper = await startRealHelper({
      ios: {
        rows: [IPHONE],
        async logs(_id, sink, signal) {
          sink.hello('syslog_relay')
          sink.push(['Oct  4 09:53:23 iPhone kernel[0] <Notice>: hello'])
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve()
            })
          })
        },
      },
    })
    helpers.push(helper)
    const { lane, lab } = await pageAgainst(helper)
    await until(() => lab.getSnapshot().devices.length === 1, 'the iPhone')

    const got: string[] = []
    const streaming = lane.logs?.(IPHONE.id, (l) => got.push(...l), new AbortController().signal)
    await until(() => got.length > 0, 'the first line')
    helper.publish('ios', [])
    const error = await streaming?.catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'DEVICE_GONE' })
    expect(deviceErrorMessage(error)).toBe('The device is no longer connected.')
    await until(() => lab.getSnapshot().devices.length === 0, 'the row gone')
  })

  it('words the helper’s refusals: a locked iPhone, and a capture already running', async () => {
    const locked: HelperDevice = { ...IPHONE, state: 'locked', blockers: ['IOS_LOCKED'] }
    let release: () => void = () => undefined
    const helper = await startRealHelper({
      ios: { rows: [locked] },
      android: {
        rows: [PIXEL],
        screenshot: () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ png: tinyPng(), source: 'adb' })
            }
          }),
      },
    })
    helpers.push(helper)
    const { lane, lab } = await pageAgainst(helper)
    await until(() => lab.getSnapshot().devices.length === 2, 'two devices')
    expect(lab.getSnapshot().devices.find((d) => d.id === IPHONE.id)).toMatchObject({
      state: 'locked',
      blockers: ['IOS_LOCKED'],
    })

    const notReady = await lane.detail(IPHONE.id).catch((e: unknown) => e)
    expect(deviceErrorMessage(notReady)).toBe('The device is not ready yet.')

    const first = lane.screenshot(PIXEL.id)
    await until(() => helper.calls('android').some((c) => c.op === 'screenshot'), 'a capture')
    const second = await lane.screenshot(PIXEL.id).catch((e: unknown) => e)
    expect(deviceErrorMessage(second)).toBe('A screenshot of this device is already being taken.')
    release()
    expect((await first).type).toBe('image/png')
  })
})

/* ---------------------------------------------------------------------- discovery --- */

/** The helper's own discovery code and fake network (typed against Node: computed URLs). */
interface HelperDiscovery {
  readonly lane: {
    readonly NEARBY_SERVICES: readonly string[]
    readonly nearbyFromBrowse: (instances: unknown[]) => { found: unknown[]; names: unknown }
    readonly mergeNearby: (found: unknown[], names: unknown, listed: unknown[]) => unknown[]
    readonly parseDevicesL: (text: string) => unknown[]
  }
  readonly mdns: {
    readonly browse: (o: object) => Promise<{ instances: unknown[] }>
  }
  readonly fakes: {
    readonly fakeMdnsNetwork: (responders: unknown[]) => { open: unknown }
    readonly braviaTv: () => unknown
    readonly pixel9: (o: { pairing: boolean }) => unknown
  }
}
const discovery: HelperDiscovery = {
  lane: (await import(
    /* @vite-ignore */ at('../../../../helper/src/android-lane.ts').href
  )) as HelperDiscovery['lane'],
  mdns: (await import(
    /* @vite-ignore */ at('../../../../helper/src/mdns.ts').href
  )) as HelperDiscovery['mdns'],
  fakes: (await import(
    /* @vite-ignore */ at('../../../../helper/test/fakes/mdns.ts').href
  )) as HelperDiscovery['fakes'],
}

// Each test starts the built helper and pairs a page with it: over 5 s on a loaded machine.
describe('discovery against the built helper', { timeout: 20_000 }, () => {
  it('reads what the helper builds from the TV and the Pixel, and offers Connect and Pair…', async () => {
    const { lane, mdns, fakes } = discovery
    const network = fakes.fakeMdnsNetwork([fakes.braviaTv(), fakes.pixel9({ pairing: true })])
    const { instances } = await mdns.browse({
      services: lane.NEARBY_SERVICES,
      open: network.open,
      windowMs: 120,
    })
    const { found, names } = lane.nearbyFromBrowse(instances)
    const devices = lane.mergeNearby(found, names, lane.parseDevicesL('R5CT40ABCDE device\n'))
    const helper = await startRealHelper({
      android: {
        nearby: () => Promise.resolve({ devices, scannedAt: 1_759_000_000_000 }),
      },
    })
    helpers.push(helper)
    const { conn } = await pageAgainst(helper)
    await until(
      () =>
        conn.getStatus().phase === 'connected' &&
        conn.getStatus().health?.features.includes('android.discover') === true,
      'android.discover',
    )

    const reply = await conn.nearby(true)
    expect(helper.requests.at(-1)?.url).toMatch(/\/api\/android\/nearby\?refresh=1$/)
    expect(reply.scannedAt).toBe(1_759_000_000_000)
    expect(reply.devices.map((d) => [d.kind, d.host, d.port, d.serial, d.tv])).toEqual([
      ['adb', '192.168.68.101', 5555, 'b120be004010859', true],
      ['wireless', '192.168.68.114', 39601, '55090DLAQ0026D', false],
      ['pairing', '192.168.68.114', 37123, '55090DLAQ0026D', false],
    ])

    const rows = nearbyRows(reply.devices, [])
    expect(rows.map((r) => [r.name, r.action])).toEqual([
      [
        '55090DLAQ0026D',
        {
          kind: 'pair',
          host: '192.168.68.114',
          pair: { host: '192.168.68.114', port: 37123 },
          connect: { host: '192.168.68.114', port: 39601 },
        },
      ],
      ['SONY KD-43X8050H', { kind: 'connect', target: { host: '192.168.68.101', port: 5555 } }],
    ])
  })

  it('a blocked look: the reason and the system’s words, and what adb lists still shown', async () => {
    const helper = await startRealHelper({
      android: {
        nearby: () =>
          Promise.resolve({
            devices: [],
            scannedAt: 1,
            error: {
              reason: 'blocked',
              message: 'Could not look for devices on the network.',
              detail: 'send EHOSTUNREACH 224.0.0.251:5353',
            },
          }),
      },
    })
    helpers.push(helper)
    const { conn } = await pageAgainst(helper)
    await until(
      () =>
        conn.getStatus().phase === 'connected' &&
        conn.getStatus().health?.features.includes('android.discover') === true,
      'android.discover',
    )
    expect((await conn.nearby()).error).toEqual({
      reason: 'blocked',
      message: 'Could not look for devices on the network.',
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    })
  })
})
