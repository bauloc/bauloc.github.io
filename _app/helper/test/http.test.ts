import { createHmac } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { beforeAll, describe, expect, it } from 'vitest'
import { toJson } from '../src/http'
import type { DoctorReport, ErrorBody, Health, Snapshot } from '../src/types'
import { IPHONE, PIXEL } from './fakes/devices'
import { fakeAndroidLane, fakeIosLane } from './fakes/lane'
import { request, startBridge, type Started } from './harness'

const SITE = 'https://bauloc.github.io'
const CHALLENGE = 'abcdefghijklmnopqrstuv'

let s: Started
let ios: ReturnType<typeof fakeIosLane>
beforeAll(async () => {
  ios = fakeIosLane({ rows: [IPHONE] })
  s = await startBridge({
    lanes: { ios: ios.factory, android: fakeAndroidLane({ rows: [PIXEL] }).factory },
  })
})

const get = (path: string, headers: Record<string, string> = {}) =>
  request(s.port, { path, headers })

describe('loopback only (T1)', () => {
  it('binds 127.0.0.1 and refuses this Mac’s LAN address', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (!lan) return
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect(s.port, lan, () => {
          socket.destroy()
          resolve('connected')
        })
        socket.on('error', reject)
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})

describe('1. Host (T2, DNS rebinding)', () => {
  it.each([
    ['evil.example', 'evil.example:PORT'],
    ['another port', '127.0.0.1:1'],
    ['no port', '127.0.0.1'],
    ['the LAN name', '192.168.1.2:PORT'],
  ])('answers 421 with no CORS header for %s', async (_name, host) => {
    const reply = await request(s.port, {
      path: '/api/health',
      host: host.replace('PORT', String(s.port)),
      headers: { Origin: SITE },
    })
    expect(reply.status).toBe(421)
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(reply.json<ErrorBody>().error.code).toBe('BAD_HOST')
  })
  it('accepts both loopback names, in any case', async () => {
    for (const host of [`127.0.0.1:${String(s.port)}`, `LocalHost:${String(s.port)}`]) {
      expect((await request(s.port, { path: '/api/health', host })).status).toBe(200)
    }
  })
})

describe('2. Origin (T3)', () => {
  it.each([
    'https://evil.example',
    'null',
    'http://bauloc.github.io',
    'https://bauloc.github.io.evil.example',
    'https://bauloc.github.io:443x',
  ])('refuses %s with 403 and no Access-Control-Allow-Origin', async (origin) => {
    const reply = await get('/api/health', { Origin: origin })
    expect(reply.status).toBe(403)
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(reply.json<ErrorBody>().error.code).toBe('BAD_ORIGIN')
  })
  it('echoes the allowed origins exactly, with Vary: Origin', async () => {
    for (const origin of [
      SITE,
      `http://127.0.0.1:${String(s.port)}`,
      `http://localhost:${String(s.port)}`,
    ]) {
      const reply = await get('/api/health', { Origin: origin })
      expect(reply.status).toBe(200)
      expect(reply.headers['access-control-allow-origin']).toBe(origin)
      expect(reply.headers.vary).toBe('Origin')
    }
  })
  it('allows the dev servers only with --dev', async () => {
    expect((await get('/api/health', { Origin: 'http://localhost:7360' })).status).toBe(403)
    const dev = await startBridge({ dev: true })
    for (const origin of [
      'http://localhost:7360',
      'http://127.0.0.1:4173',
      'http://localhost:8000',
    ]) {
      const reply = await request(dev.port, { path: '/api/health', headers: { Origin: origin } })
      expect(reply.headers['access-control-allow-origin']).toBe(origin)
    }
  })
})

describe('3. Fetch Metadata (T4)', () => {
  it.each(['cross-site', 'same-site'])('refuses a %s request without Origin', async (site) => {
    for (const path of ['/api/health', '/api/devices', '/assets/x.js', '/device/']) {
      const reply = await get(path, {
        'Sec-Fetch-Site': site,
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'image',
      })
      expect(reply.status).toBe(403)
    }
  })
  it('lets a top-level navigation to the page through, and nothing else', async () => {
    const navigate = {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    }
    expect((await get('/device', navigate)).status).toBe(302)
    expect((await get('/', navigate)).status).toBe(302)
    expect((await get('/api/devices', navigate)).status).toBe(403)
    expect((await get('/assets/i.svg', navigate)).status).toBe(403)
  })
  it('lets same-origin and typed-in requests through', async () => {
    expect((await get('/api/health', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    expect((await get('/api/health', { 'Sec-Fetch-Site': 'none' })).status).toBe(200)
  })
})

describe('4. CORS preflight', () => {
  const preflight = (headers: Record<string, string> = {}) =>
    request(s.port, {
      method: 'OPTIONS',
      path: '/api/devices',
      headers: {
        Origin: SITE,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
        ...headers,
      },
    })
  it('answers 204 without a token, listing Authorization by name', async () => {
    const reply = await preflight()
    expect(reply.status).toBe(204)
    expect(reply.headers['access-control-allow-origin']).toBe(SITE)
    expect(reply.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS')
    expect(reply.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, X-GitHub-Token',
    )
    expect(reply.headers['access-control-max-age']).toBe('600')
    expect(reply.headers['access-control-allow-private-network']).toBeUndefined()
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined()
  })
  it('answers the old Private Network Access preflight only when asked', async () => {
    const reply = await preflight({ 'Access-Control-Request-Private-Network': 'true' })
    expect(reply.headers['access-control-allow-private-network']).toBe('true')
    expect(reply.headers.vary).toContain('Access-Control-Request-Private-Network')
  })
})

describe('5. /api/health and the proof (§2.8, T7)', () => {
  it('is public, carries the tokenId and never the token', async () => {
    const reply = await get('/api/health', { Origin: SITE })
    const health = reply.json<Health>()
    expect(health).toMatchObject({
      name: 'bauloc-device-bridge',
      version: '1.4.0',
      protocol: 1,
      port: s.port,
      tokenId: s.bridge.tokenId,
      tokenPersistent: false,
      runId: s.bridge.runId,
      local: true,
      features: [
        'android.start-server',
        'android.connect',
        'android.discover',
        'android.adb',
        'local',
        'lan.discover',
        'github.upload',
      ],
    })
    expect(health.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(health.proof).toBeUndefined()
    expect(reply.text).not.toContain(s.token)
  })
  it('proves possession with an HMAC bound to the port', async () => {
    const health = (
      await get(`/api/health?challenge=${CHALLENGE}`, { Origin: SITE })
    ).json<Health>()
    const expected = (port: number) =>
      createHmac('sha256', s.token)
        .update(`bauloc-device-bridge proof v1|${String(port)}|${CHALLENGE}`)
        .digest('base64url')
    expect(health.proof).toBe(expected(s.port))
    expect(health.proof).not.toBe(expected(s.port + 1))
  })
  it.each([
    'short',
    'abcdefghijklmnopqrstuv!',
    'abcdefghijklmnopqrstu+',
    'abcdefghijklmnopqrstuvw',
  ])('gives no proof for the malformed challenge %s', async (challenge) => {
    const health = (
      await get(`/api/health?challenge=${encodeURIComponent(challenge)}`)
    ).json<Health>()
    expect(health.proof).toBeUndefined()
  })
})

describe('6. the bearer token', () => {
  it.each([
    ['missing', undefined],
    ['short', 'Bearer abc'],
    ['wrong', `Bearer ${'B'.repeat(43)}`],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
  ])('answers 401 (%s), readable by the page', async (_name, authorization) => {
    const reply = await get('/api/devices', {
      Origin: SITE,
      ...(authorization ? { Authorization: authorization } : {}),
    })
    expect(reply.status).toBe(401)
    expect(reply.headers['access-control-allow-origin']).toBe(SITE)
    expect(reply.headers['www-authenticate']).toBe('Bearer realm="device-bridge"')
    expect(reply.json<ErrorBody>().error).toMatchObject({
      code: 'UNAUTHORIZED',
      tokenId: s.bridge.tokenId,
    })
  })
  it('guards unknown /api paths too, so they reveal nothing', async () => {
    expect((await get('/api/nope')).status).toBe(401)
    expect((await get('/api/nope', s.auth)).status).toBe(404)
  })
  it('puts the security headers on every /api reply', async () => {
    for (const reply of [
      await get('/api/devices', s.auth),
      await get('/api/devices', { Origin: SITE }),
    ]) {
      expect(reply.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        vary: 'Origin',
        'access-control-expose-headers': 'X-Screenshot-Source',
      })
    }
  })
})

describe('limits and the router', () => {
  it('refuses a body over 1 KiB, and any chunked body, with 413', async () => {
    const big = await request(s.port, {
      method: 'POST',
      path: '/api/rescan',
      headers: { ...s.auth, 'Content-Length': '2048' },
      body: 'x'.repeat(2048),
    })
    expect(big.status).toBe(413)
    const chunked = await request(s.port, {
      method: 'POST',
      path: '/api/rescan',
      headers: { ...s.auth, 'Transfer-Encoding': 'chunked' },
      body: 'abc',
    })
    expect(chunked.status).toBe(413)
  })
  it('answers 405 with Allow for the wrong method', async () => {
    const post = await request(s.port, { method: 'POST', path: '/api/devices', headers: s.auth })
    expect([post.status, post.headers.allow]).toEqual([405, 'GET'])
    const get_ = await get('/api/rescan', s.auth)
    expect([get_.status, get_.headers.allow]).toEqual([405, 'POST'])
  })
  it('refuses every WebSocket upgrade but the adb tunnel’s (§4.10), and never switches', async () => {
    const answer = await new Promise<string>((resolve) => {
      let data = ''
      const socket = net.connect(s.port, '127.0.0.1', () => {
        socket.write(
          `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      socket.on('data', (chunk) => (data += chunk.toString()))
      socket.on('close', () => resolve(data))
    })
    /** No Origin: refused before anything else is looked at, with no CORS header. */
    expect(answer).toMatch(/^HTTP\/1\.1 403 /)
    expect(answer).not.toMatch(/Access-Control-Allow-Origin/i)
    expect(answer).not.toContain('101')
  })
  it('refuses an absolute-form request target', async () => {
    const answer = await new Promise<string>((resolve) => {
      let data = ''
      const socket = net.connect(s.port, '127.0.0.1', () => {
        socket.write(
          `GET http://evil.example/x HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\nConnection: close\r\n\r\n`,
        )
      })
      socket.on('data', (chunk) => (data += chunk.toString()))
      socket.on('close', () => resolve(data))
    })
    expect(answer).toMatch(/^HTTP\/1\.1 400/)
  })
})

describe('device ids (§2.2, T10)', () => {
  it.each([
    ['--help', 400],
    ['-u', 400],
    ['..', 400],
    ['%2e%2e', 400],
    ['a%20b', 400],
    ['%E0%A4%A', 400],
    ['%00', 400],
    ['', 400],
    ['00008101-000A1B2C3D4E5F09', 404],
  ])('refuses %s before any lane sees it', async (id, status) => {
    const before = ios.calls.length
    const reply = await get(`/api/devices/${id}/detail`, s.auth)
    expect(reply.status).toBe(status)
    expect(reply.json<ErrorBody>().error.code).toBe(status === 400 ? 'BAD_ID' : 'DEVICE_NOT_FOUND')
    expect(ios.calls.length).toBe(before)
  })
  it('routes a listed id to the lane that lists it, never by its shape', async () => {
    const reply = await get(`/api/devices/${encodeURIComponent(PIXEL.id)}/detail`, s.auth)
    expect(reply.status).toBe(200)
    expect(ios.calls.some((c) => c.id === PIXEL.id)).toBe(false)
  })
})

describe('GET /api/devices (§2.4)', () => {
  it('returns the snapshot with rev and runId', async () => {
    const snapshot = (await get('/api/devices', s.auth)).json<Snapshot>()
    expect(snapshot.runId).toBe(s.bridge.runId)
    expect(snapshot.devices.map((d) => d.id).sort()).toEqual([IPHONE.id, PIXEL.id].sort())
    expect(snapshot.lanes.ios.status).toBe('ok')
    const again = (await get('/api/devices', s.auth)).json<Snapshot>()
    expect(again.rev).toBe(snapshot.rev)
  })
})

describe('GET /api/doctor', () => {
  it('needs the token (paths name the user) and returns a report', async () => {
    expect((await get('/api/doctor')).status).toBe(401)
    const report = (await get('/api/doctor', s.auth)).json<DoctorReport>()
    expect(report.helper).toMatchObject({
      name: 'bauloc-device-bridge',
      version: '1.4.0',
      port: s.port,
      protocol: 1,
    })
    expect(report.lanes.android.status).toBe('ok')
    expect(Array.isArray(report.items)).toBe(true)
    expect(JSON.stringify(report)).not.toContain(s.token)
  })
})

describe('--verbose', () => {
  it('logs method, path, status and time, never a header, a query or the token', async () => {
    const v = await startBridge({ verbose: true })
    await request(v.port, { path: `/api/health?challenge=${CHALLENGE}`, headers: { Origin: SITE } })
    await request(v.port, { path: '/api/devices?secret=1', headers: v.auth })
    const text = v.logs.join('\n')
    expect(text).toMatch(/GET \/api\/health 200 \d+ ms/)
    expect(text).toMatch(/GET \/api\/devices 200 \d+ ms/)
    expect(text).not.toContain(v.token)
    expect(text).not.toContain(CHALLENGE)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('Bearer')
  })
})

describe('JSON', () => {
  it('turns a stray BigInt into a decimal string instead of throwing', () => {
    expect(toJson({ ecid: 18446744071562067970n, n: 1 })).toBe(
      '{"ecid":"18446744071562067970","n":1}',
    )
  })
})
