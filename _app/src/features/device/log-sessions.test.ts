import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Backend } from './backends/backend'
import { HelperError } from './helper/client'
import {
  createLogSessions,
  LOG_LIMIT,
  LOG_NOTES,
  RESUME_WINDOW_MS,
  RESUME_WINDOW_TEXT,
  spanText,
  type LogEvent,
} from './log-sessions'
import { normalizeDevice, type Device } from './model'

/*
  A log outlives its console (decision 1): a device that drops says so in its log, and the log
  picks up again if the device is back while its row is still listed, for as long as the helper
  holds a dropped Wi‑Fi iPhone (2 min). A row that leaves the list ends the log. Each stream
  here is one the test opens, feeds and ends by hand.
*/

interface Stream {
  readonly id: string
  readonly push: (lines: string[]) => void
  readonly end: (error?: Error) => void
  readonly signal: AbortSignal
}

function lane() {
  const streams: Stream[] = []
  const backend = {
    kind: 'agent',
    logs: (id: string, onLines: (lines: string[]) => void, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        streams.push({
          id,
          push: onLines,
          end: (error?: Error) => {
            if (error === undefined) resolve()
            else reject(error)
          },
          signal,
        })
      }),
  } as unknown as Backend
  return { backend, streams, last: () => streams.at(-1) }
}

const device = (patch: Partial<Device> = {}): Device =>
  normalizeDevice({
    id: '192.168.1.42:5555',
    backend: 'agent',
    platform: 'android',
    connection: 'network',
    state: 'ready',
    name: 'Living Room TV',
    capabilities: { logs: true, screenshot: true, identifiers: true },
    ...patch,
  })

const NOW = new Date('2026-10-04T15:00:00').getTime()

function setup() {
  const events: LogEvent[] = []
  const logs = createLogSessions({ now: () => Date.now(), onEvent: (e) => events.push(e) })
  const l = lane()
  const sync = (devices: Device[]) => {
    logs.sync(devices, () => l.backend)
  }
  return { logs, events, ...l, sync }
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const texts = (logs: ReturnType<typeof createLogSessions>, id = device().id) =>
  logs.view(id).lines.map((l) => l.text)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createLogSessions', () => {
  it('streams lines, coloured by level, up to the limit', () => {
    const { logs, sync, backend, last } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    expect(logs.view(tv.id).phase).toBe('running')
    last()?.push(['10-04 15:00:00.000  1  2 E Shop: boom'])
    expect(logs.view(tv.id).lines[0]).toMatchObject({ level: 'E' })
    last()?.push(Array.from({ length: LOG_LIMIT + 5 }, (_, i) => `line ${String(i)}`))
    expect(logs.view(tv.id).lines).toHaveLength(LOG_LIMIT)
  })

  it('waits for the window the helper holds a dropped Wi‑Fi iPhone, and says it in words', () => {
    const ios = readFileSync(
      fileURLToPath(new URL('../../../helper/src/ios-lane.ts', import.meta.url)),
      'utf8',
    )
    const hold = /wifiHoldMs: ([\d_]+),/.exec(ios)?.[1]
    expect(Number(hold?.replace(/_/g, ''))).toBe(RESUME_WINDOW_MS)
    expect(RESUME_WINDOW_TEXT).toBe('2 minutes')
    expect([spanText(30_000), spanText(60_000), spanText(1_000)]).toEqual([
      '30 seconds',
      '1 minute',
      '1 second',
    ])
  })

  it('a device no longer ready waits, and resumes when it is back in time', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.push(['before'])
    sync([device({ state: 'offline', capabilities: {} })])
    expect(streams[0]?.signal.aborted).toBe(true)
    expect(logs.view(tv.id)).toMatchObject({ phase: 'waiting', until: NOW + RESUME_WINDOW_MS })
    expect(logs.waitingId()).toBe(tv.id)
    expect(texts(logs).at(-1)).toBe(LOG_NOTES.dropped('Living Room TV', NOW))
    expect(texts(logs).at(-1)).toContain('within 2 minutes')
    expect(events.map((e) => e.kind)).toEqual(['dropped'])

    await vi.advanceTimersByTimeAsync(80_000)
    sync([tv])
    expect(streams).toHaveLength(2)
    // Back only once it says something: a reopened stream may still fail.
    expect(logs.view(tv.id).phase).toBe('waiting')
    streams[1]?.push(['after'])
    expect(logs.view(tv.id).phase).toBe('running')
    expect(texts(logs)).toEqual([
      'before',
      LOG_NOTES.dropped('Living Room TV', NOW),
      LOG_NOTES.resumed('Living Room TV', NOW + 80_000),
      'after',
    ])
    expect(events.map((e) => e.kind)).toEqual(['dropped', 'resumed'])
    expect(logs.view(tv.id).lines.filter((l) => l.note)).toHaveLength(2)
  })

  it('a row that leaves the list ends the log at once, and says so', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.push(['before'])
    vi.setSystemTime(NOW + 5_000)
    sync([])
    expect(streams[0]?.signal.aborted).toBe(true)
    expect(logs.view(tv.id)).toMatchObject({ phase: 'idle', until: null })
    expect(logs.waitingId()).toBeNull()
    expect(texts(logs)).toEqual(['before', LOG_NOTES.unlisted('Living Room TV', NOW + 5_000)])
    expect(events).toMatchObject([{ kind: 'gave-up', reason: 'unlisted' }])
    // Back later: Start is the tester's.
    sync([tv])
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS)
    expect(streams).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a log waiting on a listed row gives up when the row leaves the list', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.end(new HelperError('IOS_UNREACHABLE', 'http'))
    await flush()
    expect(logs.view(tv.id).phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(streams).toHaveLength(2)
    // The helper's hold ran out: the row goes, and the reopen in flight with it.
    sync([])
    expect(streams[1]?.signal.aborted).toBe(true)
    expect(logs.view(tv.id).phase).toBe('idle')
    expect(texts(logs).at(-1)).toBe(LOG_NOTES.unlisted('Living Room TV', NOW + 1_000))
    expect(events.map((e) => e.kind)).toEqual(['dropped', 'gave-up'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a stream that ends after its row left the list ends the log, without waiting', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    // The list moved on before the stream's own end arrived.
    logs.sync([], () => backend)
    streams[0]?.end(new HelperError('DEVICE_GONE', 'http'))
    await flush()
    expect(logs.view(tv.id).phase).toBe('idle')
    expect(events.map((e) => e.kind)).toEqual(['gave-up'])
  })

  it('gives up after the hold, says so, and leaves Start to the tester', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    sync([device({ state: 'offline', capabilities: {} })])
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS - 1)
    expect(logs.view(tv.id).phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(logs.view(tv.id).phase).toBe('idle')
    expect(texts(logs).at(-1)).toBe(LOG_NOTES.gaveUp('Living Room TV'))
    expect(events).toMatchObject([{ kind: 'dropped' }, { kind: 'gave-up', reason: 'window' }])
    // Back too late: nothing starts by itself.
    sync([tv])
    expect(streams).toHaveLength(1)
  })

  it('a stream that ends with a drop code waits, and retries while the row stays listed', async () => {
    const { logs, sync, backend, streams } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.end(new HelperError('DEVICE_GONE', 'http'))
    await flush()
    expect(logs.view(tv.id).phase).toBe('waiting')
    // Still listed and ready (a Wi‑Fi iPhone held by the helper): tried again after 1 s.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(streams).toHaveLength(2)
    streams[1]?.end(new HelperError('IOS_UNREACHABLE', 'http'))
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(streams).toHaveLength(3)
    streams[2]?.push(['back'])
    expect(logs.view(tv.id).phase).toBe('running')
  })

  it('a device held as ready is tried all through the hold, the last just before it ends', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.end(new HelperError('DEVICE_GONE', 'http'))
    await flush()
    const opened: number[] = []
    // Every reopen fails as the helper answers a held row: IOS_UNREACHABLE, until 118 s.
    for (let i = 1; Date.now() - NOW < RESUME_WINDOW_MS; i++) {
      await vi.advanceTimersByTimeAsync(100)
      const stream = streams[i]
      if (!stream) {
        i--
        continue
      }
      opened.push(Date.now() - NOW)
      if (Date.now() - NOW < 118_000) stream.end(new HelperError('IOS_UNREACHABLE', 'http'))
      else stream.push(['back'])
      await flush()
    }
    // 1, 2, 4, then every 8 s, the last moved to 1 s before the window ends.
    expect(opened).toEqual([
      1_000, 3_000, 7_000, 15_000, 23_000, 31_000, 39_000, 47_000, 55_000, 63_000, 71_000, 79_000,
      87_000, 95_000, 103_000, 111_000, 119_000,
    ])
    expect(logs.view(tv.id).phase).toBe('running')
    expect(events.map((e) => e.kind)).toEqual(['dropped', 'resumed'])
  })

  it('a reopened stream that is quiet until the window ends counts as back, not as gone', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    sync([device({ state: 'offline', capabilities: {} })])
    sync([tv])
    expect(streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS)
    expect(logs.view(tv.id).phase).toBe('running')
    expect(streams[1]?.signal.aborted).toBe(false)
    expect(events.map((e) => e.kind)).toEqual(['dropped', 'resumed'])
  })

  it('a Wi‑Fi log that simply ends is a drop; a cable’s log that ends is over', async () => {
    const { logs, sync, backend, streams } = setup()
    const tv = device()
    const pixel = device({ id: '55090DLAQ0026D', connection: 'usb', name: 'Pixel 9' })
    sync([tv, pixel])
    logs.start(tv, backend)
    streams[0]?.end()
    await flush()
    expect(logs.view(tv.id).phase).toBe('waiting')
    logs.start(pixel, backend)
    streams.at(-1)?.end()
    await flush()
    expect(logs.view(pixel.id).phase).toBe('idle')
  })

  it('a failure that isn’t a drop stops the log and is reported once', async () => {
    const { logs, sync, backend, streams, events } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    streams[0]?.end(new HelperError('LOG_STREAMS_EXHAUSTED', 'http'))
    await flush()
    expect(logs.view(tv.id).phase).toBe('idle')
    expect(events).toMatchObject([{ kind: 'failed', device: { id: tv.id } }])
  })

  it('Stop is the tester’s: it ends a wait too, and nothing comes back by itself', async () => {
    const { logs, sync, backend, streams } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    sync([device({ state: 'offline', capabilities: {} })])
    logs.stop(tv.id)
    expect(logs.view(tv.id).phase).toBe('idle')
    expect(logs.waitingId()).toBeNull()
    sync([tv])
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS)
    expect(streams).toHaveLength(1)
    // Lines a stopped stream still delivers belong to a log that is over.
    streams[0]?.push(['late'])
    expect(texts(logs)).not.toContain('late')
  })

  it('a device that stops being ready drops its log too', () => {
    const { logs, sync, backend } = setup()
    const tv = device()
    sync([tv])
    logs.start(tv, backend)
    sync([device({ state: 'offline', capabilities: {} })])
    expect(logs.view(tv.id).phase).toBe('waiting')
  })

  it('keeps one log per tab, and clears without stopping', () => {
    const { logs, sync, backend, streams } = setup()
    const tv = device()
    const pixel = device({ id: '55090DLAQ0026D', connection: 'usb', name: 'Pixel 9' })
    sync([tv, pixel])
    logs.start(tv, backend)
    streams[0]?.push(['a'])
    logs.clear(tv.id)
    expect(logs.view(tv.id)).toMatchObject({ phase: 'running', lines: [] })
    logs.start(pixel, backend)
    logs.keepOnly(pixel.id)
    expect(streams[0]?.signal.aborted).toBe(true)
    expect(logs.view(tv.id).phase).toBe('idle')
    const view = logs.view(pixel.id)
    logs.keepOnly(pixel.id)
    expect(logs.view(pixel.id)).toBe(view)
    logs.dispose()
    expect(streams[1]?.signal.aborted).toBe(true)
  })
})
