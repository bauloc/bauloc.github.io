import { describe, expect, it } from 'vitest'
import { HelperError, aborted, sleep } from '../src/util'
import type { ErrorBody, LogMsg } from '../src/types'
import { alive } from './fakes/bin'
import { IPHONE, PIXEL, SIMULATOR } from './fakes/devices'
import { fakeAndroidLane, fakeIosLane, fakeSimulatorLane, type FakeLaneScript } from './fakes/lane'
import { isStream, openStream, startBridge, until, type Stream } from './harness'

const logsOf = (id: string) => `/api/devices/${encodeURIComponent(id)}/logs`

async function streaming(port: number, id: string, auth: Record<string, string>): Promise<Stream> {
  const opened = await openStream(port, logsOf(id), auth)
  if (!isStream(opened))
    throw new Error(`Expected a stream, got ${String(opened.status)} ${opened.text}`)
  return opened
}

/** A lane whose log runs until its signal aborts, saying hello first. */
const endless: FakeLaneScript<'ios'>['logs'] = async (_id, sink, signal) => {
  sink.hello('syslog_relay')
  sink.push(['started'])
  await aborted(signal)
}

describe('order: hello, lines, pings, one end', () => {
  it('streams NDJSON with the hello first and an eof end', async () => {
    const s = await startBridge({
      heartbeatMs: 100,
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          logs: async (_id, sink) => {
            sink.hello('logcat')
            sink.push(['10-04 08:19:52.123  1234  1234 I Tag: hello \x1b[31mred\x1b[0m'])
            await sleep(250)
            sink.notice('Switched to idevicesyslog')
            sink.push(['after the notice'])
          },
        }).factory,
      },
    })
    const stream = await streaming(s.port, PIXEL.id, s.auth)
    expect(stream.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect(stream.headers['access-control-allow-origin']).toBe('https://bauloc.github.io')
    await stream.waitFor((m) => m.t === 'end')
    const kinds = stream.messages.map((m) => m.t)
    expect(kinds[0]).toBe('hello')
    expect(stream.messages[0]).toMatchObject({ t: 'hello', device: PIXEL.id, source: 'logcat' })
    expect(kinds.filter((t) => t === 'ping').length).toBeGreaterThanOrEqual(1)
    expect(kinds.filter((t) => t === 'end')).toHaveLength(1)
    expect(kinds[kinds.length - 1]).toBe('end')
    expect(stream.messages.at(-1)).toEqual({ t: 'end', reason: 'eof' })
    const lines = stream.messages.flatMap((m) => (m.t === 'lines' ? m.lines : []))
    expect(lines).toEqual(['10-04 08:19:52.123  1234  1234 I Tag: hello red', 'after the notice'])
    const notice = stream.messages.findIndex((m) => m.t === 'notice')
    expect(stream.messages[notice]).toEqual({ t: 'notice', text: 'Switched to idevicesyslog' })
    expect(notice).toBeLessThan(
      stream.messages.findIndex((m) => m.t === 'lines' && m.lines[0] === 'after the notice'),
    )
  })

  it('batches at most 200 lines per record and caps each line at 8 KiB', async () => {
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          logs: (_id, sink) => {
            sink.hello('logcat')
            sink.push(Array.from({ length: 450 }, (_, i) => `line ${String(i)}`))
            sink.push(['z'.repeat(20_000)])
            return Promise.resolve()
          },
        }).factory,
      },
    })
    const stream = await streaming(s.port, PIXEL.id, s.auth)
    await stream.waitFor((m) => m.t === 'end')
    const batches = stream.messages.filter(
      (m): m is Extract<LogMsg, { t: 'lines' }> => m.t === 'lines',
    )
    expect(batches.every((b) => b.lines.length <= 200)).toBe(true)
    const lines = batches.flatMap((b) => b.lines)
    expect(lines).toHaveLength(451)
    expect(lines[449]).toBe('line 449')
    expect(lines[450]?.length).toBe(8 * 1024)
  })
})

describe('caps (§1.3, G20)', () => {
  it('allows one stream per device: a new one replaces the old', async () => {
    const s = await startBridge({
      lanes: { ios: fakeIosLane({ rows: [IPHONE], logs: endless }).factory },
    })
    const first = await streaming(s.port, IPHONE.id, s.auth)
    await first.waitFor((m) => m.t === 'hello')
    const second = await streaming(s.port, IPHONE.id, s.auth)
    await second.waitFor((m) => m.t === 'hello')
    expect(await first.waitFor((m) => m.t === 'end')).toEqual({ t: 'end', reason: 'replaced' })
    expect(second.messages.some((m) => m.t === 'end')).toBe(false)
    second.abort()
  })
  it('allows three in total: the fourth gets 429 TOO_MANY_STREAMS', async () => {
    const fourth = { ...IPHONE, id: '00008101-000A1B2C3D4E5F09' }
    const s = await startBridge({
      lanes: {
        ios: fakeIosLane({ rows: [IPHONE, fourth], logs: endless }).factory,
        android: fakeAndroidLane({ rows: [PIXEL], logs: endless }).factory,
        simulators: fakeSimulatorLane({ rows: [SIMULATOR], logs: endless }).factory,
      },
    })
    const open = await Promise.all(
      [IPHONE.id, PIXEL.id, SIMULATOR.id].map((id) => streaming(s.port, id, s.auth)),
    )
    const refused = await openStream(s.port, logsOf(fourth.id), s.auth)
    expect(isStream(refused)).toBe(false)
    if (!isStream(refused)) {
      expect(refused.status).toBe(429)
      expect(refused.json<ErrorBody>().error.code).toBe('TOO_MANY_STREAMS')
      expect(refused.headers['access-control-allow-origin']).toBe('https://bauloc.github.io')
    }
    open[0]?.abort()
    await until(
      async () => {
        const retry = await openStream(s.port, logsOf(fourth.id), s.auth)
        if (isStream(retry)) retry.abort()
        return isStream(retry)
      },
      3_000,
      'a free slot after one stream closed',
    )
    for (const stream of open) stream.abort()
  })
})

describe('back-pressure and the client leaving', () => {
  it('pauses the source while the client does not read, and resumes on drain', async () => {
    // The first `false` drains as soon as the kernel's socket buffers take the data; real
    // back-pressure shows once those are full too, so wait for the source to be stuck.
    const progress = { pushes: 0, waiting: false }
    const s = await startBridge({
      lanes: {
        android: fakeAndroidLane({
          rows: [PIXEL],
          logs: async (_id, sink, signal) => {
            sink.hello('logcat')
            const big = 'x'.repeat(4_000)
            while (!signal.aborted) {
              progress.pushes++
              if (!sink.push(Array.from({ length: 50 }, () => big))) {
                progress.waiting = true
                await sink.drain()
                progress.waiting = false
              }
              await new Promise((resolve) => setImmediate(resolve))
            }
          },
        }).factory,
      },
    })
    const stream = await streaming(s.port, PIXEL.id, s.auth)
    stream.pause()
    await until(
      async () => {
        if (!progress.waiting) return false
        const before = progress.pushes
        await sleep(300)
        return progress.waiting && progress.pushes === before
      },
      10_000,
      'the source to stay paused',
    )
    stream.resume()
    const before = progress.pushes
    await until(() => progress.pushes > before + 5, 5_000, 'the source to resume')
    stream.abort()
  })
  it('kills the log tool’s group, grandchild included, when the client goes away', async () => {
    let stopped = false
    const s = await startBridge({
      lanes: {
        ios: fakeIosLane({
          rows: [IPHONE],
          logs: async (_id, sink, signal, ctx) => {
            const tool = ctx.streamTool(`${s.bin.dir}/syslog`, [], {
              signal,
              onLines: (lines) => {
                sink.push(lines)
              },
            })
            sink.hello('idevicesyslog')
            const result = await tool.done
            stopped = result.stopped
          },
        }).factory,
      },
    })
    s.bin.sleeper('syslog')
    const stream = await streaming(s.port, IPHONE.id, s.auth)
    await stream.waitFor((m) => m.t === 'lines')
    await until(() => alive(s.bin.gpid('syslog')), 3_000, 'the grandchild')
    stream.abort()
    await until(
      () => !alive(s.bin.pid('syslog')) && !alive(s.bin.gpid('syslog')),
      3_000,
      'the group to die',
    )
    await until(() => stopped, 3_000, 'the lane to see its tool stopped')
  })
})

describe('endings', () => {
  it('ends with device-gone when the device leaves the list', async () => {
    const lane = fakeIosLane({ rows: [IPHONE], logs: endless })
    const s = await startBridge({ lanes: { ios: lane.factory } })
    const stream = await streaming(s.port, IPHONE.id, s.auth)
    await stream.waitFor((m) => m.t === 'hello')
    lane.ctx().publish('ios', [])
    expect(await stream.waitFor((m) => m.t === 'end')).toEqual({ t: 'end', reason: 'device-gone' })
  })
  it('ends with error, code and message when the lane fails mid-stream', async () => {
    const s = await startBridge({
      lanes: {
        ios: fakeIosLane({
          rows: [IPHONE],
          logs: async (_id, sink) => {
            sink.hello('syslog_relay')
            await sleep(20)
            throw new HelperError('IOS_LOCKED', 409, 'Unlock the device, then try again.')
          },
        }).factory,
      },
    })
    const stream = await streaming(s.port, IPHONE.id, s.auth)
    expect(await stream.waitFor((m) => m.t === 'end')).toEqual({
      t: 'end',
      reason: 'error',
      code: 'IOS_LOCKED',
      message: 'Unlock the device, then try again.',
    })
  })
  it('ends every stream with shutdown when the helper stops', async () => {
    const s = await startBridge({
      lanes: { ios: fakeIosLane({ rows: [IPHONE], logs: endless }).factory },
    })
    const stream = await streaming(s.port, IPHONE.id, s.auth)
    await stream.waitFor((m) => m.t === 'hello')
    await s.bridge.close()
    expect(stream.messages.at(-1)).toEqual({ t: 'end', reason: 'shutdown' })
  })
})

describe('errors before hello are ordinary JSON errors (§2.5)', () => {
  const opening = async (logs: FakeLaneScript<'ios'>['logs'], timeouts = {}) => {
    const s = await startBridge({
      lanes: { ios: fakeIosLane({ rows: [IPHONE], logs }).factory },
      timeouts,
    })
    const reply = await openStream(s.port, logsOf(IPHONE.id), s.auth)
    if (isStream(reply)) throw new Error('Expected a JSON error')
    return { status: reply.status, code: reply.json<ErrorBody>().error.code }
  }
  it('passes a lane refusal through', async () => {
    expect(
      await opening(() =>
        Promise.reject(new HelperError('IOS_UNTRUSTED', 409, 'Tap Trust on the iPhone first.')),
      ),
    ).toEqual({ status: 409, code: 'IOS_UNTRUSTED' })
  })
  it('says LOGS_UNAVAILABLE when the lane ends without a source', async () => {
    expect(await opening(() => Promise.resolve())).toEqual({
      status: 503,
      code: 'LOGS_UNAVAILABLE',
    })
  })
  it('gives up with TOOL_TIMEOUT when no source says hello in time', async () => {
    expect(await opening((_id, _sink, signal) => aborted(signal), { logHello: 200 })).toEqual({
      status: 504,
      code: 'TOOL_TIMEOUT',
    })
  })
  it('survives a lane that throws synchronously', async () => {
    expect(
      await opening(() => {
        throw new HelperError('LOGS_UNAVAILABLE', 503, 'No log source works for this device.')
      }),
    ).toEqual({ status: 503, code: 'LOGS_UNAVAILABLE' })
  })
})
