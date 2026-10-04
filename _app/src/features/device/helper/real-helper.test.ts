import { afterEach, describe, expect, it } from 'vitest'

import { createHelperClient, HelperError } from './client'
import { createHelperConnection, type HelperConnection, type HelperStatus } from './connection'
import type { HelperEnv } from './env'
import { stashPendingPair } from './pair-fragment'
import { parseDoctor, type LogMsg } from './protocol'
import {
  HELPER_PROTOCOL,
  HELPER_VERSION,
  IPHONE,
  PIXEL,
  SIMULATOR,
  helperProofOf,
  startRealHelper,
  type RealHelper,
} from './testing/real-helper'
import { memoryStores, newChallenge, proofOf, saveToken, tokenIdOf } from './token'

/*
  The page's client and connection against the REAL built helper (device/agent/
  device-bridge.mjs), started in this process with fake lanes: the proof, the token rules, the
  device list, detail, a screenshot, a log stream, the doctor, and the helper stopping.
*/

const helpers: RealHelper[] = []
const connections: HelperConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) c.stop()
  for (const h of helpers.splice(0)) await h.close()
})

async function start(opts: Parameters<typeof startRealHelper>[0] = {}) {
  const helper = await startRealHelper(opts)
  helpers.push(helper)
  return helper
}

const envFor = (helper: RealHelper): HelperEnv => ({
  mode: 'hosted',
  apiBase: helper.apiBase,
  port: helper.port,
  safariLike: false,
  devOrigin: false,
})

/** A connection to `helper` whose browser already allowed loopback access. */
function connect(helper: RealHelper, stores = memoryStores()) {
  const conn = createHelperConnection(envFor(helper), {
    fetch: helper.fetch,
    stores,
    permissions: { query: () => Promise.resolve({ state: 'granted', onchange: null }) },
    document: null,
    window: null,
  })
  connections.push(conn)
  return conn
}

async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const phase = (conn: HelperConnection) => conn.getStatus().phase

describe('the client against the real helper', () => {
  it('reads health, and the proof matches the page’s own HMAC over this port', async () => {
    const helper = await start()
    const client = createHelperClient(helper.apiBase, () => null, { fetch: helper.fetch })
    const challenge = newChallenge()
    const health = await client.health(challenge)
    expect(health).toMatchObject({
      name: 'bauloc-device-bridge',
      version: HELPER_VERSION,
      protocol: HELPER_PROTOCOL,
      port: helper.port,
      tokenId: helper.tokenId,
    })
    expect(await tokenIdOf(helper.token)).toBe(health.tokenId)
    expect(health.proof).toBe(await proofOf(helper.token, helper.port, challenge))
    expect(health.proof).toBe(helperProofOf(helper.token, helper.port, challenge))
    // Bound to the port: the same challenge over another port is another proof.
    expect(health.proof).not.toBe(await proofOf(helper.token, helper.port + 1, challenge))
    expect(JSON.stringify(health)).not.toContain(helper.token)
  })

  it('reads a 401 as HELPER_UNAUTHORIZED with the helper’s fingerprint', async () => {
    const helper = await start()
    const client = createHelperClient(helper.apiBase, () => 'x'.repeat(43), {
      fetch: helper.fetch,
    })
    const error = await client.devices().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HelperError)
    expect(error).toMatchObject({ code: 'HELPER_UNAUTHORIZED', status: 401, kind: 'http' })
    expect((error as HelperError).body?.tokenId).toBe(helper.tokenId)
  })

  it('lists, details, captures and streams with the token', async () => {
    const helper = await start({ ios: { rows: [IPHONE] }, android: { rows: [PIXEL] } })
    const client = createHelperClient(helper.apiBase, () => helper.token, { fetch: helper.fetch })
    const snapshot = await client.devices()
    expect(snapshot.devices.map((d) => d.id).sort()).toEqual([IPHONE.id, PIXEL.id].sort())
    expect(snapshot.lanes.android.status).toBe('ok')

    const detail = await client.detail(IPHONE.id)
    expect(detail.kind).toBe('ios')
    if (detail.kind === 'ios') {
      expect(detail.facts.device.ProductType).toBe('iPhone13,3')
      expect(detail.facts.device.UniqueChipID).toBe('18446744073709550001')
    }

    const shot = await client.screenshot(PIXEL.id)
    expect(shot.blob.type).toBe('image/png')
    expect(shot.source).toBe('adb')

    const messages: LogMsg[] = []
    await client.logs(PIXEL.id, (m) => messages.push(m), new AbortController().signal)
    expect(messages.map((m) => m.t)).toEqual(['hello', 'lines', 'end'])
    expect(messages[2]).toEqual({ t: 'end', reason: 'eof' })

    const doctor = parseDoctor(
      await (
        await helper.fetch(`${helper.apiBase}/api/doctor`, {
          headers: { Authorization: `Bearer ${helper.token}` },
        })
      ).json(),
    )
    expect(doctor?.helper.version).toBe(HELPER_VERSION)
    expect(await client.doctor(false)).toMatchObject({ helper: { port: helper.port } })
  })

  it('maps a 409 with its state and blockers', async () => {
    const locked = { ...IPHONE, state: 'locked' as const, blockers: ['IOS_LOCKED'] }
    const helper = await start({ ios: { rows: [locked] } })
    const client = createHelperClient(helper.apiBase, () => helper.token, { fetch: helper.fetch })
    const error = await client.detail(IPHONE.id).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'DEVICE_NOT_READY', status: 409 })
    expect((error as HelperError).body).toMatchObject({ state: 'locked', blockers: ['IOS_LOCKED'] })
    // DEVICE_ERRORS words DEVICE_NOT_READY: the message is the code, for deviceErrorMessage.
    expect((error as HelperError).message).toBe('DEVICE_NOT_READY')
  })
})

describe('the connection against the real helper', () => {
  it('pairs through the #pair= candidate, sending no token before the proof', async () => {
    const helper = await start({
      ios: { rows: [IPHONE] },
      android: { rows: [PIXEL] },
      simulators: { rows: [SIMULATOR] },
    })
    const stores = memoryStores()
    stashPendingPair({ token: helper.token, port: helper.port }, stores)
    const conn = connect(helper, stores)
    conn.start()
    await until(() => conn.getDevices().length === 3, 'three devices')

    const status: HelperStatus = conn.getStatus()
    expect(status.phase).toBe('connected')
    expect(status.pairing).toMatchObject({ tokenId: helper.tokenId, remembered: false })
    expect(status.lanes?.simulators.booted).toBe(1)
    // First a proof probe without the token, then the authenticated list.
    expect(helper.requests[0]).toMatchObject({ authorization: null })
    expect(helper.requests[0]?.url).toMatch(/\/api\/health\?challenge=[\w-]{22}$/)
    expect(helper.requests[1]).toMatchObject({ authorization: `Bearer ${helper.token}` })

    const detail = await conn.api.detail(SIMULATOR.id)
    expect(detail.kind).toBe('simulator')
    const blob = await conn.api.screenshot(IPHONE.id)
    expect(blob.size).toBeGreaterThan(50)

    // A hot-plug reaches the list through polling.
    helper.publish('android', [])
    conn.pollNow()
    await until(() => conn.getDevices().length === 2, 'the Pixel gone')

    // The helper stops: two failures in a row → lost, and the list empties.
    await helper.close()
    helpers.splice(0)
    conn.pollNow()
    await until(() => phase(conn) === 'lost', 'lost')
    expect(conn.getDevices()).toEqual([])
  })

  it('a token from another run reads stale and is never sent', async () => {
    const helper = await start({ ios: { rows: [IPHONE] } })
    const stores = memoryStores()
    const old = 'A'.repeat(43)
    saveToken({ v: 1, token: old, port: helper.port, tokenId: await tokenIdOf(old) }, false, stores)
    const conn = connect(helper, stores)
    conn.start()
    await until(() => phase(conn) === 'stale', 'stale')
    expect(helper.requests.every((r) => r.authorization === null)).toBe(true)
    expect(conn.getDevices()).toEqual([])

    // Pasting the right token pairs it.
    expect(await conn.pair('nonsense', false)).toEqual({ ok: false, reason: 'format' })
    expect(await conn.pair(old, false)).toEqual({
      ok: false,
      reason: 'stale',
      tokenId: helper.tokenId,
    })
    expect(
      await conn.pair(
        `http://127.0.0.1:${String(helper.port)}/device/#pair=${helper.token}&port=${String(helper.port)}`,
        true,
      ),
    ).toEqual({ ok: true })
    await until(() => conn.getDevices().length === 1, 'the iPhone')
    expect(conn.getStatus().pairing).toMatchObject({ remembered: true })
  })

  it('streams a log through the connection and ends quietly on abort', async () => {
    const helper = await start({
      android: {
        rows: [PIXEL],
        async logs(_id, sink, signal) {
          sink.hello('logcat')
          while (!signal.aborted) {
            sink.push(['10-04 08:41:02.000  1234  5678 I Test: tick'])
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        },
      },
    })
    const stores = memoryStores()
    stashPendingPair({ token: helper.token, port: helper.port }, stores)
    const conn = connect(helper, stores)
    conn.start()
    await until(() => conn.getDevices().length === 1, 'the Pixel')

    const controller = new AbortController()
    const messages: LogMsg[] = []
    const done = conn.api.logs(PIXEL.id, (m) => messages.push(m), controller.signal)
    await until(() => messages.some((m) => m.t === 'lines'), 'a batch of lines')
    controller.abort()
    await expect(done).resolves.toBeUndefined()
    expect(messages[0]).toMatchObject({ t: 'hello', source: 'logcat', device: PIXEL.id })
  })
})
