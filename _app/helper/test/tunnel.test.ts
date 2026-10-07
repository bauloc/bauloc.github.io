/*
  The adb tunnel (§4.10): the WebSocket codec (websocket.ts), the service allowlist, and the
  tunnel through the HTTP layer with a fake Android lane — its gate (Host, Origin, the token
  as a subprotocol), the opening message, the bytes both ways, the caps and shutdown. The
  real Android lane's half (host:transport, then the service) is in android.test.ts.
*/
import { beforeAll, describe, expect, it } from 'vitest'
import { ADB_TUNNEL_NEVER, assertTunnelService } from '../src/android-lane'
import { LIMITS } from '../src/constants'
import type { AndroidAdbInfo, ErrorBody, HelperDevice } from '../src/types'
import {
  CLOSE,
  OPCODE,
  WsProtocolError,
  acceptKey,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  offeredProtocols,
} from '../src/websocket'
import { IPHONE, PIXEL } from './fakes/devices'
import { echoService, fakeAndroidLane, fakeIosLane } from './fakes/lane'
import {
  clientFrame,
  openWebSocket,
  request,
  startBridge,
  until,
  type RawWebSocket,
  type Started,
} from './harness'

const SITE = 'https://bauloc.github.io'
const PROTOCOL = 'device-bridge.adb.v1'

const TV: HelperDevice = {
  ...PIXEL,
  id: '192.168.1.20:5555',
  connection: 'network',
  name: 'BRAVIA 4K UR3',
  model: 'BRAVIA 4K UR3',
  modelId: 'BRAVIA_UR3',
  osVersion: '10',
}
const WAITING: HelperDevice = {
  ...PIXEL,
  id: 'R5CT30ABCDE',
  state: 'unauthorized',
  blockers: ['ANDROID_UNAUTHORIZED'],
  capabilities: { screenshot: false, identifiers: false, logs: false, install: false },
}

const decode = (frame: { payload: Buffer }): unknown => JSON.parse(frame.payload.toString('utf8'))
const closeCode = (frame: { opcode: number; payload: Buffer }): number | null =>
  frame.opcode === OPCODE.close && frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null

/* ------------------------------------------------------------------ the codec --- */

describe('§13a WebSocket frames', () => {
  it('computes RFC 6455’s own example accept key', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it.each([
    [0, 2],
    [125, 2],
    [126, 4],
    [65_535, 4],
    [65_536, 10],
  ])('writes a %i-byte payload with a %i-byte header, final and unmasked', (size, header) => {
    const frame = encodeFrame(OPCODE.binary, Buffer.alloc(size, 7))
    expect(frame.length).toBe(size + header)
    expect(frame[0]).toBe(0x82)
    expect((frame[1] ?? 0) & 0x80).toBe(0)
  })

  it('writes a close frame with its code and a short reason', () => {
    const frame = encodeClose(1001, 'x'.repeat(200))
    expect(frame[0]).toBe(0x88)
    expect(frame.readUInt16BE(2)).toBe(1001)
    expect(frame.length).toBe(2 + 2 + 123)
  })

  it('decodes masked frames, whole or one byte at a time', () => {
    const bytes = Buffer.concat([
      clientFrame(OPCODE.binary, Buffer.from('hello')),
      clientFrame(OPCODE.binary, Buffer.alloc(70_000, 3)),
      clientFrame(OPCODE.ping, Buffer.from('p')),
    ])
    const whole = createFrameDecoder(1 << 20).push(bytes)
    expect(whole.map((f) => f.kind)).toEqual(['data', 'data', 'ping'])
    expect(whole[0]).toMatchObject({ opcode: 2, fin: true, payload: Buffer.from('hello') })
    const slow = createFrameDecoder(1 << 20)
    const frames = []
    for (const byte of bytes) frames.push(...slow.push(Buffer.from([byte])))
    expect(frames).toEqual(whole)
  })

  it('keeps a fragmented message’s opcode across continuations, with a ping in between', () => {
    const frames = createFrameDecoder(1024).push(
      Buffer.concat([
        clientFrame(OPCODE.text, Buffer.from('{"serv'), { fin: false }),
        clientFrame(OPCODE.ping, Buffer.alloc(0)),
        clientFrame(OPCODE.continuation, Buffer.from('ice":"sync:"}')),
      ]),
    )
    expect(frames).toEqual([
      { kind: 'data', opcode: 1, fin: false, payload: Buffer.from('{"serv') },
      { kind: 'ping', payload: Buffer.alloc(0) },
      { kind: 'data', opcode: 1, fin: true, payload: Buffer.from('ice":"sync:"}') },
    ])
  })

  it('reads a close frame’s code, or none', () => {
    const decoder = createFrameDecoder(1024)
    const code = Buffer.alloc(2)
    code.writeUInt16BE(1000)
    expect(decoder.push(clientFrame(OPCODE.close, code))).toEqual([{ kind: 'close', code: 1000 }])
    expect(decoder.push(clientFrame(OPCODE.close, Buffer.alloc(0)))).toEqual([
      { kind: 'close', code: null },
    ])
  })

  it.each<[string, Buffer, number]>([
    ['an unmasked frame', clientFrame(OPCODE.binary, Buffer.from('x'), { mask: false }), 1002],
    [
      'an RSV bit (no extension was agreed)',
      clientFrame(OPCODE.binary, Buffer.from('x'), { rsv: 4 }),
      1002,
    ],
    ['a continuation of nothing', clientFrame(OPCODE.continuation, Buffer.from('x')), 1002],
    [
      'a new message inside a fragmented one',
      Buffer.concat([
        clientFrame(OPCODE.binary, Buffer.from('a'), { fin: false }),
        clientFrame(OPCODE.binary, Buffer.from('b')),
      ]),
      1002,
    ],
    ['a fragmented ping', clientFrame(OPCODE.ping, Buffer.from('x'), { fin: false }), 1002],
    ['a ping over 125 bytes', clientFrame(OPCODE.ping, Buffer.alloc(126)), 1002],
    ['an unknown opcode', clientFrame(0x3, Buffer.from('x')), 1002],
    ['a frame over the cap', clientFrame(OPCODE.binary, Buffer.alloc(2048)), 1009],
  ])('refuses %s', (_name, bytes, code) => {
    const decoder = createFrameDecoder(1024)
    let thrown: unknown
    try {
      decoder.push(bytes)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WsProtocolError)
    expect((thrown as WsProtocolError).code).toBe(code)
  })

  it('refuses a frame over the cap from its header, before the payload arrives', () => {
    const header = clientFrame(OPCODE.binary, Buffer.alloc(10_000)).subarray(0, 4)
    expect(() => createFrameDecoder(1024).push(header)).toThrow(WsProtocolError)
  })

  it('splits the subprotocol offer', () => {
    expect(offeredProtocols(' device-bridge.adb.v1 , bearer.abc,,')).toEqual([
      'device-bridge.adb.v1',
      'bearer.abc',
    ])
    expect(offeredProtocols(undefined)).toEqual([])
  })
})

/* ---------------------------------------------------------- the service allowlist --- */

describe('§4.10 the services a tunnel may open', () => {
  it.each([
    'sync:',
    'exec:cmd package list packages -3 -U',
    'shell,v2,raw:content query --uri content://media/external/images/media',
    'abb_exec:package\0install-create\0-S\x001234\0',
  ])('opens %j', (service) => {
    expect(() => assertTunnelService(service)).not.toThrow()
  })

  it.each([...ADB_TUNNEL_NEVER, 'exec:', 'shell,v2,raw:', 'abb_exec:', 'sync:x', 'SYNC:', ''])(
    'never opens %j',
    (service) => {
      expect(() => assertTunnelService(service)).toThrow(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      )
    },
  )

  it('refuses a service longer than the cap', () => {
    expect(() => assertTunnelService(`exec:${'x'.repeat(LIMITS.tunnelService)}`)).toThrow()
  })
})

/* ------------------------------------------------------- the tunnel through HTTP --- */

let s: Started
let android: ReturnType<typeof fakeAndroidLane>
/** The signal of every service the fake lane opened, by service, for the abort checks. */
const opened: Array<{ service: string; signal: AbortSignal }> = []

beforeAll(async () => {
  android = fakeAndroidLane({
    rows: [PIXEL, TV, WAITING],
    openTunnel: (_id, service, signal) => {
      opened.push({ service, signal })
      if (service === 'exec:hang') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return Promise.resolve(echoService(service, signal))
    },
  })
  s = await startBridge({
    lanes: { ios: fakeIosLane({ rows: [IPHONE] }).factory, android: android.factory },
    timeouts: { tunnelHello: 300 },
  })
})

const pathOf = (id: string) => `/api/devices/${encodeURIComponent(id)}/adb`

/** The browser's handshake: an allowed Origin and the token offered as a subprotocol. */
const tunnelHeaders = (token = s.token): Record<string, string> => ({
  Origin: SITE,
  'Sec-WebSocket-Protocol': `${PROTOCOL}, bearer.${token}`,
})

async function openTunnel(id: string, headers = tunnelHeaders()): Promise<RawWebSocket> {
  const ws = await openWebSocket(s.port, { path: pathOf(id), headers })
  expect(ws.status).toBe(101)
  return ws
}

async function expectError(ws: RawWebSocket, code: string): Promise<void> {
  const reply = await ws.next()
  expect(reply.opcode).toBe(OPCODE.text)
  expect(decode(reply)).toMatchObject({ t: 'error', code })
  expect(closeCode(await ws.next())).toBe(1000)
  await ws.closed
}

describe('§4.10 the tunnel’s gate', () => {
  it.each<[string, { host?: string; headers: Record<string, string | undefined> }, number, string]>(
    [
      ['a rebound Host', { host: 'evil.example:PORT', headers: {} }, 421, 'BAD_HOST'],
      [
        'no Origin (CORS never applies to a WebSocket)',
        { headers: { Origin: undefined } },
        403,
        'BAD_ORIGIN',
      ],
      ['another site', { headers: { Origin: 'https://evil.example' } }, 403, 'BAD_ORIGIN'],
      ['a bad key', { headers: { 'Sec-WebSocket-Key': 'short' } }, 400, 'BAD_REQUEST'],
      ['an old version', { headers: { 'Sec-WebSocket-Version': '8' } }, 426, 'BAD_REQUEST'],
      ['no token', { headers: { 'Sec-WebSocket-Protocol': PROTOCOL } }, 401, 'UNAUTHORIZED'],
      [
        'a wrong token',
        { headers: { 'Sec-WebSocket-Protocol': `${PROTOCOL}, bearer.${'A'.repeat(43)}` } },
        401,
        'UNAUTHORIZED',
      ],
      [
        'the token without the tunnel’s protocol',
        { headers: { 'Sec-WebSocket-Protocol': 'bearer.TOKEN' } },
        401,
        'UNAUTHORIZED',
      ],
    ],
  )('refuses %s with a bare %i', async (_name, o, status, code) => {
    const headers = Object.fromEntries(
      Object.entries({ ...tunnelHeaders(), ...o.headers }).map(([k, v]) => [
        k,
        v?.replace('TOKEN', s.token),
      ]),
    )
    const ws = await openWebSocket(s.port, {
      path: pathOf(PIXEL.id),
      ...(o.host ? { host: o.host.replace('PORT', String(s.port)) } : {}),
      headers,
    })
    expect(ws.status).toBe(status)
    expect(ws.headers['access-control-allow-origin']).toBeUndefined()
    expect(JSON.parse(ws.body)).toMatchObject({ error: { code } })
    expect(ws.body).not.toContain(s.token)
    if (status === 426) expect(ws.headers['sec-websocket-version']).toBe('13')
  })

  it.each(['/api/health', '/api/devices', `/api/devices/${PIXEL.id}/logs`, '/device/'])(
    'refuses an upgrade on %s, even with the token: one WebSocket only',
    async (path) => {
      const ws = await openWebSocket(s.port, { path, headers: tunnelHeaders() })
      expect(ws.status).toBe(404)
    },
  )

  it('accepts the tunnel’s protocol only, never echoing the token', async () => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    const ws = await openWebSocket(s.port, {
      path: pathOf(PIXEL.id),
      headers: { ...tunnelHeaders(), 'Sec-WebSocket-Key': key },
    })
    expect(ws.status).toBe(101)
    expect(ws.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    expect(ws.headers['sec-websocket-protocol']).toBe(PROTOCOL)
    expect(JSON.stringify(ws.headers)).not.toContain(s.token)
    ws.close()
  })
})

describe('§4.10 a tunnel', () => {
  it('opens the named service, says ok, then carries its bytes and ends with it', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('exec:echo hi')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    const data = await ws.next()
    expect(data.opcode).toBe(OPCODE.binary)
    expect(data.payload.toString()).toBe('hi\n')
    expect(closeCode(await ws.next())).toBe(1000)
    await ws.closed
    expect(android.calls).toContainEqual({ op: 'openTunnel exec:echo', id: PIXEL.id })
  })

  it('reaches a device over Wi‑Fi by its network serial', async () => {
    const ws = await openTunnel(TV.id)
    ws.hello('exec:echo tv')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    expect((await ws.next()).payload.toString()).toBe('tv\n')
    ws.close()
  })

  it('copies megabytes both ways, intact, in the page’s 256 KiB frames', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('sync:')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    const sent = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < sent.length; i++) sent[i] = (i * 31) & 0xff
    for (let at = 0; at < sent.length; at += 256 * 1024) {
      ws.send(OPCODE.binary, sent.subarray(at, at + 256 * 1024))
    }
    const got: Buffer[] = []
    let length = 0
    while (length < sent.length) {
      const frame = await ws.next(5_000)
      expect(frame.opcode).toBe(OPCODE.binary)
      got.push(frame.payload)
      length += frame.payload.length
    }
    expect(Buffer.concat(got).equals(sent)).toBe(true)
    ws.close()
  })

  it('answers a ping, and echoes the page’s close, ending the device’s service', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('exec:cat')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    const mine = opened.at(-1)
    ws.send(OPCODE.ping, 'are you there')
    const pong = await ws.next()
    expect([pong.opcode, pong.payload.toString()]).toEqual([OPCODE.pong, 'are you there'])
    const code = Buffer.alloc(2)
    code.writeUInt16BE(1000)
    ws.send(OPCODE.close, code)
    expect(closeCode(await ws.next())).toBe(1000)
    await ws.closed
    expect(mine?.signal.aborted).toBe(true)
  })

  it('ends the device’s service when the page simply goes away', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('exec:cat')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    const mine = opened.at(-1)
    ws.close()
    await until(() => mine?.signal.aborted === true, 2_000, 'the service aborted')
  })

  it.each<[string, string, string]>([
    ['a device no longer listed', 'ZY22ABCDEF', 'DEVICE_NOT_FOUND'],
    ['a malformed id', '-rf', 'BAD_ID'],
    ['an iPhone', IPHONE.id, 'BAD_REQUEST'],
    ['a phone still waiting for Allow', WAITING.id, 'DEVICE_NOT_READY'],
  ])('says why it can’t open for %s, in its first message', async (_name, id, code) => {
    const before = android.calls.length
    const ws = await openTunnel(id)
    ws.hello('exec:echo hi')
    await expectError(ws, code)
    expect(android.calls.slice(before).some((c) => c.op.startsWith('openTunnel'))).toBe(false)
  })

  it('refuses a service off the allowlist before the lane hears of it', async () => {
    const before = android.calls.length
    const ws = await openTunnel(PIXEL.id)
    ws.hello('reverse:forward:tcp:8787;tcp:8787')
    await expectError(ws, 'BAD_REQUEST')
    expect(android.calls.slice(before).some((c) => c.op.startsWith('openTunnel'))).toBe(false)
  })

  it.each<[string, (ws: RawWebSocket) => void, number]>([
    ['bytes before the service is named', (ws) => ws.send(OPCODE.binary, 'x'), 1003],
    ['an opening that isn’t JSON', (ws) => ws.send(OPCODE.text, 'sync:'), 1003],
    ['an opening without a service', (ws) => ws.send(OPCODE.text, '{"service":""}'), 1003],
    [
      'an opening over the cap',
      (ws) => ws.send(OPCODE.text, 'x'.repeat(LIMITS.tunnelHello + 1)),
      1009,
    ],
    ['an unmasked frame', (ws) => ws.send(OPCODE.binary, 'x', { mask: false }), 1002],
  ])('closes on %s', async (_name, act, code) => {
    const ws = await openTunnel(PIXEL.id)
    act(ws)
    expect(closeCode(await ws.next())).toBe(code)
    await ws.closed
  })

  it('closes a tunnel whose service is never named', async () => {
    const ws = await openTunnel(PIXEL.id)
    expect(closeCode(await ws.next(2_000))).toBe(CLOSE.policyViolation)
    await ws.closed
  })

  it('closes on text once open: after "ok" only bytes travel', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('exec:cat')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    ws.send(OPCODE.text, '{"service":"sync:"}')
    expect(closeCode(await ws.next())).toBe(1002)
  })

  it('aborts an opening the page gave up on', async () => {
    const ws = await openTunnel(PIXEL.id)
    ws.hello('exec:hang')
    await until(() => opened.at(-1)?.service === 'exec:hang', 2_000, 'the opening')
    const mine = opened.at(-1)
    ws.close()
    await until(() => mine?.signal.aborted === true, 2_000, 'the opening aborted')
  })

  it(`opens at most ${String(LIMITS.tunnelsPerDevice)} at once per device`, async () => {
    const open: RawWebSocket[] = []
    for (let i = 0; i < LIMITS.tunnelsPerDevice; i++) {
      const ws = await openTunnel(PIXEL.id)
      ws.hello('exec:cat')
      expect(decode(await ws.next())).toEqual({ t: 'ok' })
      open.push(ws)
    }
    const over = await openTunnel(PIXEL.id)
    over.hello('exec:cat')
    await expectError(over, 'TUNNEL_LIMIT')
    /** Another device still has room. */
    const tv = await openTunnel(TV.id)
    tv.hello('exec:echo ok')
    expect(decode(await tv.next())).toEqual({ t: 'ok' })
    tv.close()
    /** One closes: there is room again. */
    open.pop()?.close()
    let again: RawWebSocket | null = null
    await until(
      async () => {
        const ws = await openTunnel(PIXEL.id)
        ws.hello('exec:cat')
        const reply = decode(await ws.next()) as { t: string }
        if (reply.t === 'ok') again = ws
        else ws.close()
        return reply.t === 'ok'
      },
      2_000,
      'room again',
    )
    ;(again as RawWebSocket | null)?.close()
    for (const ws of open) ws.close()
  })
})

describe('GET /api/devices/:id/adb', () => {
  it('answers the serial and the device’s adb features', async () => {
    const reply = await request(s.port, { path: pathOf(TV.id), headers: s.auth })
    expect(reply.status).toBe(200)
    const info = reply.json<AndroidAdbInfo>()
    expect(info.serial).toBe(TV.id)
    expect(info.features).toContain('shell_v2')
    expect(info.features).toContain('abb_exec')
  })
  it('needs the token', async () => {
    const reply = await request(s.port, { path: pathOf(PIXEL.id), headers: { Origin: SITE } })
    expect(reply.status).toBe(401)
  })
  it.each<[string, string, number, string]>([
    ['an iPhone', IPHONE.id, 400, 'BAD_REQUEST'],
    ['a phone waiting for Allow', WAITING.id, 409, 'DEVICE_NOT_READY'],
    ['a device not listed', 'ZY22ABCDEF', 404, 'DEVICE_NOT_FOUND'],
  ])('refuses %s', async (_name, id, status, code) => {
    const reply = await request(s.port, { path: pathOf(id), headers: s.auth })
    expect(reply.status).toBe(status)
    expect(reply.json<ErrorBody>().error.code).toBe(code)
  })
})

describe('shutdown and --verbose', () => {
  it('closes every open tunnel with 1001 when the helper stops', async () => {
    const own = await startBridge({
      lanes: { android: fakeAndroidLane({ rows: [PIXEL] }).factory },
    })
    const ws = await openWebSocket(own.port, {
      path: pathOf(PIXEL.id),
      headers: { Origin: SITE, 'Sec-WebSocket-Protocol': `${PROTOCOL}, bearer.${own.token}` },
    })
    ws.hello('exec:cat')
    expect(decode(await ws.next())).toEqual({ t: 'ok' })
    await own.bridge.close()
    expect(closeCode(await ws.next())).toBe(CLOSE.goingAway)
    await ws.closed
  })

  it('logs the path and the time, never the service or the token', async () => {
    const own = await startBridge({
      verbose: true,
      lanes: { android: fakeAndroidLane({ rows: [PIXEL] }).factory },
    })
    const ws = await openWebSocket(own.port, {
      path: pathOf(PIXEL.id),
      headers: { Origin: SITE, 'Sec-WebSocket-Protocol': `${PROTOCOL}, bearer.${own.token}` },
    })
    ws.hello('exec:echo secret-command')
    await ws.rest()
    await until(() => own.logs.some((l) => l.includes('WS /api/devices/')), 2_000, 'the line')
    const text = own.logs.join('\n')
    expect(text).toMatch(/WS \/api\/devices\/55090DLAQ0026D\/adb \d+ ms/)
    expect(text).not.toContain('secret-command')
    expect(text).not.toContain(own.token)
  })
})
