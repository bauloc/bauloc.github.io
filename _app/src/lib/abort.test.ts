import { describe, expect, it } from 'vitest'

import { untilAborted } from './abort'

describe('untilAborted', () => {
  it('passes the work’s result and failure through', async () => {
    const signal = new AbortController().signal
    await expect(untilAborted(Promise.resolve(7), signal)).resolves.toBe(7)
    await expect(untilAborted(Promise.reject(new Error('no')), signal)).rejects.toThrow('no')
  })

  it('rejects as soon as the signal aborts, without waiting for the work', async () => {
    const controller = new AbortController()
    const waiting = untilAborted(new Promise<number>(() => undefined), controller.signal)
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(waiting).rejects.toThrow('Cancelled')
  })

  it('rejects at once on a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(untilAborted(Promise.resolve(1), controller.signal)).rejects.toThrow('Cancelled')
  })
})
