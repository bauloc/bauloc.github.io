import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { HelperError, sleep } from '../src/util'
import type { ErrorBody, HelperDevice, Snapshot } from '../src/types'
import { alive } from './fakes/bin'
import { IPHONE, PIXEL, row } from './fakes/devices'
import { fakeAndroidLane, fakeIosLane } from './fakes/lane'
import { request, startBridge, tinyPng, until } from './harness'

const id = encodeURIComponent(IPHONE.id)

describe('detail', () => {
  it('returns what the lane returns, as JSON', async () => {
    const s = await startBridge({
      lanes: {
        ios: fakeIosLane({
          rows: [IPHONE],
          detail: (udid) =>
            Promise.resolve({
              platform: 'ios',
              kind: 'ios',
              facts: {
                udid,
                connection: 'usb',
                source: 'lockdown',
                device: { DeviceName: 'Ngọc’s iPhone 12 Pro', UniqueChipID: '2844626588163842' },
                developerMode: true,
                locked: false,
                withheld: [],
              },
            }),
        }).factory,
      },
    })
    const reply = await request(s.port, { path: `/api/devices/${id}/detail`, headers: s.auth })
    expect(reply.status).toBe(200)
    expect(reply.json()).toMatchObject({
      kind: 'ios',
      facts: { udid: IPHONE.id, device: { DeviceName: 'Ngọc’s iPhone 12 Pro' } },
    })
  })
  it('answers 409 DEVICE_NOT_READY with the state and blockers for a row that is not ready', async () => {
    const locked = row(IPHONE, { state: 'locked', blockers: ['IOS_LOCKED'] })
    const lane = fakeIosLane({ rows: [locked] })
    const s = await startBridge({ lanes: { ios: lane.factory } })
    for (const [method, action] of [
      ['GET', 'detail'],
      ['POST', 'screenshot'],
      ['GET', 'logs'],
    ] as const) {
      const reply = await request(s.port, {
        method,
        path: `/api/devices/${id}/${action}`,
        headers: s.auth,
      })
      expect(reply.status).toBe(409)
      expect(reply.json<ErrorBody>().error).toMatchObject({
        code: 'DEVICE_NOT_READY',
        state: 'locked',
        blockers: ['IOS_LOCKED'],
      })
    }
    expect(lane.calls.filter((c) => c.op !== 'start')).toEqual([])
  })
  it('maps lane errors and tool failures to the §2.7 codes', async () => {
    const cases: Array<[Error, number, string]> = [
      [new HelperError('IOS_LOCKED', 409, 'Unlock the device.'), 409, 'IOS_LOCKED'],
      [
        new HelperError('XCODE_REQUIRED', 503, 'Xcode.', { install: 'App Store' }),
        503,
        'XCODE_REQUIRED',
      ],
      [new Error('secret internals'), 500, 'INTERNAL'],
    ]
    for (const [error, status, code] of cases) {
      const s = await startBridge({
        lanes: {
          ios: fakeIosLane({ rows: [IPHONE], detail: () => Promise.reject(error) }).factory,
        },
      })
      const reply = await request(s.port, { path: `/api/devices/${id}/detail`, headers: s.auth })
      expect(reply.status).toBe(status)
      expect(reply.json<ErrorBody>().error.code).toBe(code)
      expect(reply.headers['access-control-allow-origin']).toBe('https://bauloc.github.io')
      if (code === 'INTERNAL') {
        expect(reply.text).not.toContain('secret internals')
        expect(s.errors.join('\n')).toContain('secret internals')
      }
    }
  })
  it('maps ToolError reasons from ctx.runTool: missing, exit, timeout', async () => {
    const s = await startBridge({
      lanes: {
        ios: fakeIosLane({
          rows: [IPHONE],
          detail: async (_udid, signal, ctx) => {
            await ctx.runTool(`${s.bin.dir}/${nextTool}`, [], {
              signal,
              timeoutMs: timeouts[nextTool] ?? 5_000,
            })
            throw new Error('unreachable')
          },
        }).factory,
      },
    })
    const timeouts: Record<string, number> = { slow: 1_000 }
    let nextTool = 'absent'
    const missing = await request(s.port, { path: `/api/devices/${id}/detail`, headers: s.auth })
    expect(missing.json<ErrorBody>().error).toMatchObject({ code: 'TOOL_MISSING', tool: 'absent' })
    s.bin.simple('broken', { stderr: '\x1b[31mERROR: device vanished\x1b[0m\n', exit: 1 })
    nextTool = 'broken'
    const failed = await request(s.port, { path: `/api/devices/${id}/detail`, headers: s.auth })
    expect(failed.status).toBe(502)
    expect(failed.json<ErrorBody>().error).toMatchObject({
      code: 'TOOL_FAILED',
      message: 'ERROR: device vanished',
    })
    s.bin.simple('slow', { sleep: 5 })
    nextTool = 'slow'
    const slow = await request(s.port, { path: `/api/devices/${id}/detail`, headers: s.auth })
    expect([slow.status, slow.json<ErrorBody>().error.code]).toEqual([504, 'TOOL_TIMEOUT'])
  })
})

describe('screenshot (§2.6)', () => {
  it('serves the PNG with its source, length and a safe filename', async () => {
    const png = tinyPng()
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          screenshot: () =>
            Promise.resolve({
              png: Buffer.concat([Buffer.from('WARNING: 2 displays\n'), png]),
              source: 'adb',
            }),
        }).factory,
      },
    })
    const reply = await request(s.port, {
      method: 'POST',
      path: `/api/devices/${PIXEL.id}/screenshot`,
      headers: s.auth,
    })
    expect(reply.status).toBe(200)
    expect(reply.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(png.length),
      'content-disposition': `inline; filename="${PIXEL.id}.png"`,
      'x-screenshot-source': 'adb',
      'access-control-expose-headers': 'X-Screenshot-Source',
    })
    expect(reply.body.equals(png)).toBe(true)
    expect(s.logs.some((line) => /screenshot \d+\.\d s \(adb\)$/.test(line))).toBe(true)
  })
  it('answers 502 SCREENSHOT_NOT_PNG for anything that is not a whole PNG', async () => {
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          screenshot: () =>
            Promise.resolve({ png: Buffer.from('screencap: not found'), source: 'adb' }),
        }).factory,
      },
    })
    const reply = await request(s.port, {
      method: 'POST',
      path: `/api/devices/${PIXEL.id}/screenshot`,
      headers: s.auth,
    })
    expect([reply.status, reply.json<ErrorBody>().error.code]).toEqual([502, 'SCREENSHOT_NOT_PNG'])
  })
  it('takes one screenshot per device at a time (409 BUSY)', async () => {
    let release: () => void = () => undefined
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          screenshot: () =>
            new Promise((resolve) => {
              release = () => resolve({ png: tinyPng(), source: 'adb' })
            }),
        }).factory,
      },
    })
    const first = request(s.port, {
      method: 'POST',
      path: `/api/devices/${PIXEL.id}/screenshot`,
      headers: s.auth,
    })
    await sleep(50)
    const second = await request(s.port, {
      method: 'POST',
      path: `/api/devices/${PIXEL.id}/screenshot`,
      headers: s.auth,
    })
    expect([second.status, second.json<ErrorBody>().error.code]).toEqual([409, 'BUSY'])
    release()
    expect((await first).status).toBe(200)
  })
  it('kills the tool’s whole group when the client goes away', async () => {
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          screenshot: async (_serial, signal, ctx) => {
            const { stdout } = await ctx.runTool(`${s.bin.dir}/shooter`, [], {
              signal,
              encoding: 'buffer',
              timeoutMs: 30_000,
            })
            return { png: stdout, source: 'adb' }
          },
        }).factory,
      },
    })
    s.bin.sleeper('shooter', { silent: true })
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      method: 'POST',
      path: `/api/devices/${PIXEL.id}/screenshot`,
      headers: { Host: `127.0.0.1:${String(s.port)}`, ...s.auth },
    })
    req.on('error', () => undefined)
    req.end()
    await until(() => alive(s.bin.gpid('shooter')), 3_000, 'the tool and its grandchild')
    req.destroy()
    await until(
      () => !alive(s.bin.pid('shooter')) && !alive(s.bin.gpid('shooter')),
      3_000,
      'the group to die',
    )
  })
})

describe('retry, rescan and start-server', () => {
  it('retry re-checks through the lane and returns the row as it is now', async () => {
    const untrusted = row(IPHONE, { state: 'untrusted', blockers: ['IOS_UNTRUSTED'] })
    const lane = fakeIosLane({
      rows: [untrusted],
      retry: (_udid, _signal, ctx) => {
        ctx.publish('ios', [IPHONE])
        return Promise.resolve()
      },
    })
    const s = await startBridge({ lanes: { ios: lane.factory } })
    const reply = await request(s.port, {
      method: 'POST',
      path: `/api/devices/${id}/retry`,
      headers: s.auth,
    })
    expect(reply.json<{ device: HelperDevice }>().device.state).toBe('ready')
  })
  it('retry is bounded: a lane that hangs still gets an answer', async () => {
    const lane = fakeIosLane({ rows: [IPHONE], retry: () => new Promise(() => undefined) })
    const s = await startBridge({ lanes: { ios: lane.factory }, timeouts: { retry: 200 } })
    const started = Date.now()
    const reply = await request(s.port, {
      method: 'POST',
      path: `/api/devices/${id}/retry`,
      headers: s.auth,
    })
    expect(reply.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
  it('rescan asks every lane, is bounded, and returns the fresh snapshot', async () => {
    let aborted = false
    const ios = fakeIosLane({
      rows: [],
      rescan: (_signal, ctx) => {
        ctx.publish('ios', [IPHONE])
        return Promise.resolve()
      },
    })
    const android = fakeAndroidLane({
      rescan: (signal) =>
        new Promise(() => signal?.addEventListener('abort', () => (aborted = true))),
    })
    const s = await startBridge({
      lanes: { ios: ios.factory, android: android.factory },
      timeouts: { rescan: 200 },
    })
    const reply = await request(s.port, { method: 'POST', path: '/api/rescan', headers: s.auth })
    expect(reply.json<Snapshot>().devices.map((d) => d.id)).toEqual([IPHONE.id])
    expect(aborted).toBe(true)
  })
  it('start-server goes to the Android lane and answers its state; off with --no-android', async () => {
    const android = fakeAndroidLane({
      state: { status: 'stopped', adb: 'found' },
      startServer: (_signal, ctx) => {
        ctx.setLane('android', { status: 'ok', startedByHelper: true, serverProtocol: 41 })
        return Promise.resolve()
      },
    })
    const s = await startBridge({ lanes: { android: android.factory } })
    const reply = await request(s.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: s.auth,
    })
    expect(reply.json()).toEqual({
      android: { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: true },
    })
    expect(
      s.logs.some((l) =>
        l.endsWith('adb server started from Device Lab (protocol 41): sharing it for Android'),
      ),
    ).toBe(true)
    const off = await startBridge({ android: false })
    const refused = await request(off.port, {
      method: 'POST',
      path: '/api/android/start-server',
      headers: off.auth,
    })
    expect([refused.status, refused.json<ErrorBody>().error.code]).toEqual([409, 'ANDROID_OFF'])
  })
})

describe('the terminal', () => {
  it('prints Page connected once per origin and browser, and device transitions', async () => {
    const lane = fakeIosLane({ rows: [IPHONE] })
    const s = await startBridge({ lanes: { ios: lane.factory } })
    const chrome = { ...s.auth, 'User-Agent': 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36' }
    await request(s.port, { path: '/api/devices', headers: chrome })
    await request(s.port, { path: '/api/devices', headers: chrome })
    lane.ctx().publish('ios', [])
    const text = s.logs.map((line) => line.replace(/^\d\d:\d\d:\d\d {2}/, '')).join('\n')
    expect(text).toBe(
      [
        '+ Ngọc’s iPhone 12 Pro · iOS 27.0 · USB · trusted',
        'Page connected: Chrome on https://bauloc.github.io',
        '- Ngọc’s iPhone 12 Pro',
      ].join('\n'),
    )
    expect(s.logs[0]).toMatch(/^\d\d:\d\d:\d\d {2}\+ /)
  })
})
