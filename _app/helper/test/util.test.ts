import { describe, expect, it } from 'vitest'
import {
  HelperError,
  clean,
  createLimiter,
  extractPng,
  keyedMutex,
  linkSignals,
  singleFlight,
  sleep,
  splitLines,
  withTimeout,
} from '../src/util'
import { nodeTooOld } from '../src/guard'
import { listenerWarnings, tinyPng } from './harness'

describe('clean', () => {
  it('strips ANSI escapes and control characters but keeps tab', () => {
    expect(clean('\x1b[31mred\x1b[0m\tok\x07\x00\x1b]0;title\x07!', 100)).toBe('red\tok!')
  })
  it('strips C1 controls and caps the length', () => {
    expect(clean('a\u0085b\u009bc', 100)).toBe('abc')
    expect(clean('abcdef', 3)).toBe('abc')
  })
})

describe('splitLines', () => {
  it('splits across chunk boundaries, including mid-UTF-8 and CRLF', () => {
    const out: string[] = []
    const lines = splitLines((batch) => out.push(...batch))
    const bytes = Buffer.from('Ngọc’s iPhone\r\nsecond\nthi', 'utf8')
    for (let i = 0; i < bytes.length; i++) lines.write(bytes.subarray(i, i + 1))
    expect(out).toEqual(['Ngọc’s iPhone', 'second'])
    lines.end()
    expect(out).toEqual(['Ngọc’s iPhone', 'second', 'thi'])
  })
  it('cuts a long line, marks it and drops its rest up to the next newline', () => {
    const out: string[] = []
    const lines = splitLines((batch) => out.push(...batch), 10)
    lines.write('x'.repeat(25) + '\nshort\n')
    expect(out).toEqual(['x'.repeat(10) + ' [truncated]', 'short'])
  })
  it('bounds memory for a line that never ends', () => {
    const out: string[] = []
    const lines = splitLines((batch) => out.push(...batch), 10)
    lines.write('y'.repeat(100))
    lines.write('y'.repeat(100))
    lines.write('tail\nnext\n')
    expect(out).toEqual(['y'.repeat(10) + ' [truncated]', 'next'])
  })
})

describe('extractPng', () => {
  it('finds the PNG between screencap warnings and trailing text', () => {
    const png = tinyPng()
    const mixed = Buffer.concat([
      Buffer.from('WARNING: two displays\n'),
      png,
      Buffer.from('\nmore'),
    ])
    expect(extractPng(mixed)?.equals(png)).toBe(true)
  })
  it('refuses a cut-short image and text', () => {
    expect(extractPng(tinyPng().subarray(0, 40))).toBeNull()
    expect(extractPng(Buffer.from('/system/bin/sh: screencap: not found\n'))).toBeNull()
    expect(extractPng(Buffer.alloc(0))).toBeNull()
  })
})

describe('concurrency helpers', () => {
  it('createLimiter runs at most n tasks at once, in order', async () => {
    const limit = createLimiter(2)
    let running = 0
    let peak = 0
    const order: number[] = []
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          running++
          peak = Math.max(peak, running)
          await sleep(10)
          order.push(n)
          running--
        }),
      ),
    )
    expect(peak).toBe(2)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })
  it('createLimiter survives a task that throws synchronously', async () => {
    const limit = createLimiter(1)
    await expect(
      limit(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(limit(() => Promise.resolve(7))).resolves.toBe(7)
  })
  it('keyedMutex serialises per key only', async () => {
    const mutex = keyedMutex()
    const events: string[] = []
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}+`)
      await sleep(ms)
      events.push(`${name}-`)
    }
    await Promise.all([
      mutex.run('a', task('a1', 20)),
      mutex.run('a', task('a2', 1)),
      mutex.run('b', task('b1', 1)),
    ])
    expect(events.indexOf('a1-')).toBeLessThan(events.indexOf('a2+'))
    expect(events.indexOf('b1+')).toBeLessThan(events.indexOf('a1-'))
    expect(mutex.busy('a')).toBe(false)
  })
  it('singleFlight shares the task in flight', async () => {
    const flight = singleFlight()
    let runs = 0
    const work = async (): Promise<number> => {
      runs++
      await sleep(5)
      return runs
    }
    const [a, b] = await Promise.all([flight.run('k', work), flight.run('k', work)])
    expect([a, b, runs]).toEqual([1, 1, 1])
    await flight.run('k', work)
    expect(runs).toBe(2)
  })
  it('withTimeout rejects with the given error', async () => {
    await expect(
      withTimeout(sleep(200), 10, () => new HelperError('TOOL_TIMEOUT', 504, 'late')),
    ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })
  })
  it('sleep rejects with an AbortError when its signal aborts', async () => {
    const controller = new AbortController()
    const waiting = sleep(1_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('linkSignals aborts with any parent or the deadline, and detaches on dispose', async () => {
    const parent = new AbortController()
    const linked = linkSignals([parent.signal, undefined])
    parent.abort()
    expect(linked.signal.aborted).toBe(true)
    const timed = linkSignals([], 10)
    await sleep(30)
    expect(timed.signal.aborted).toBe(true)
    const other = new AbortController()
    const detached = linkSignals([other.signal])
    detached.dispose()
    other.abort()
    expect(detached.signal.aborted).toBe(false)
  })
  it('linkSignals: no listener warning on Node 18 or 20, for a parent or the signal it makes', async () => {
    const warnings = await listenerWarnings(() => {
      // The bridge's shutdown signal: every request and adb exchange links to it.
      const shutdown = new AbortController()
      const ops = Array.from({ length: 12 }, () => linkSignals([shutdown.signal], 1_000))
      // A dns-sd run's signal: each of its processes listens to it.
      for (let i = 0; i < 12; i++) ops[0]?.signal.addEventListener('abort', () => undefined)
      for (const op of ops) op.dispose()
    })
    expect(warnings).toEqual([])
  })
})

describe('the Node guard', () => {
  it('words the refusal exactly (§1.10) and lets new or unreadable versions pass', () => {
    expect(nodeTooOld('v16.20.2')).toBe(
      'Device Lab helper needs Node 18 or newer (this is v16.20.2). Install the current LTS from https://nodejs.org, then run the same command again.',
    )
    expect(nodeTooOld('v18.0.0')).toBeNull()
    expect(nodeTooOld('v24.12.0')).toBeNull()
    expect(nodeTooOld('weird')).toBeNull()
  })
})
