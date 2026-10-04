import { describe, expect, it, vi } from 'vitest'

import { HelperError } from './helper/client'
import type { HelperConnection } from './helper/connection'
import type { RecentStore } from './helper/network'
import type { HelperDevice } from './helper/protocol'
import { createWifi, failureOf } from './wifi'

/*
  The Wi‑Fi state on its own: the last attempt as the checklist reads it, the remembered
  devices, and a slow answer never overwriting a newer attempt.
*/

const TV = { host: '192.168.1.42', port: 5555 }

function memory(): RecentStore {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

const refused = new HelperError('ANDROID_CONNECT_FAILED', 'http', {
  status: 502,
  body: {
    code: 'ANDROID_CONNECT_FAILED',
    message: 'Could not connect to 192.168.1.42:5556.',
    reason: 'refused',
    detail: "failed to connect to '192.168.1.42:5556': Connection refused",
  },
})

function setup(connection: Partial<WifiConnection> = {}) {
  const calls = {
    connectNetwork: vi.fn<WifiConnection['connectNetwork']>(
      connection.connectNetwork ??
        (() => Promise.resolve({ result: 'connected', serial: '192.168.1.42:5555', device: null })),
    ),
    pairNetwork: vi.fn<WifiConnection['pairNetwork']>(
      connection.pairNetwork ??
        (() => Promise.resolve({ result: 'paired', host: TV.host, port: 37099 })),
    ),
    disconnectNetwork: vi.fn<WifiConnection['disconnectNetwork']>(
      connection.disconnectNetwork ??
        (() => Promise.resolve({ result: 'disconnected', serial: '192.168.1.42:5555' })),
    ),
  }
  const store = memory()
  const wifi = createWifi({ connection: calls, store, now: () => 1000 })
  return { wifi, calls, store }
}

type WifiConnection = Pick<HelperConnection, 'connectNetwork' | 'pairNetwork' | 'disconnectNetwork'>

describe('createWifi', () => {
  it('connects: running, then ok with the serial, and the device is remembered', async () => {
    const { wifi } = setup()
    const seen: string[] = []
    wifi.subscribe(() => seen.push(wifi.getSnapshot().attempt?.state ?? 'none'))
    await expect(wifi.connect(TV)).resolves.toBe('192.168.1.42:5555')
    expect(seen).toEqual(['running', 'ok'])
    expect(wifi.getSnapshot().attempt).toEqual({
      kind: 'connect',
      ...TV,
      state: 'ok',
      serial: '192.168.1.42:5555',
    })
    expect(wifi.getSnapshot().recent).toEqual([{ ...TV, name: '', at: 1000 }])
  })

  it('a failed connect keeps the code, the reason and adb’s words, and remembers nothing', async () => {
    const { wifi } = setup({ connectNetwork: () => Promise.reject(refused) })
    await expect(wifi.connect({ ...TV, port: 5556 })).resolves.toBeNull()
    expect(wifi.getSnapshot().attempt).toEqual({
      kind: 'connect',
      host: TV.host,
      port: 5556,
      state: 'failed',
      code: 'ANDROID_CONNECT_FAILED',
      reason: 'refused',
      message: 'Could not connect to 192.168.1.42:5556.',
      detail: "failed to connect to '192.168.1.42:5556': Connection refused",
    })
    expect(wifi.getSnapshot().recent).toEqual([])
  })

  it('a slow answer never overwrites a newer attempt', async () => {
    let answer: (value: Awaited<ReturnType<WifiConnection['connectNetwork']>>) => void = () => {}
    const { wifi } = setup({
      connectNetwork: vi
        .fn<WifiConnection['connectNetwork']>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve
            }),
        )
        .mockRejectedValueOnce(refused),
    })
    const first = wifi.connect(TV)
    await wifi.connect({ ...TV, port: 5556 })
    answer({ result: 'connected', serial: '192.168.1.42:5555', device: null })
    await first
    expect(wifi.getSnapshot().attempt).toMatchObject({ port: 5556, state: 'failed' })
  })

  it('pairs, and says when the code was wrong', async () => {
    const wrong = new HelperError('ANDROID_PAIR_FAILED', 'http', {
      status: 502,
      body: { code: 'ANDROID_PAIR_FAILED', message: 'm', reason: 'wrong-code' },
    })
    const { wifi, calls } = setup()
    await expect(wifi.pair({ ...TV, port: 37099, code: '482913' })).resolves.toBe(true)
    expect(wifi.getSnapshot().attempt).toMatchObject({ kind: 'pair', port: 37099, state: 'ok' })
    calls.pairNetwork.mockRejectedValueOnce(wrong)
    await expect(wifi.pair({ ...TV, port: 37099, code: '000000' })).resolves.toBe(false)
    expect(wifi.getSnapshot().attempt).toMatchObject({ state: 'failed', reason: 'wrong-code' })
  })

  it('disconnects one at a time; a device already gone counts as disconnected', async () => {
    const gone = new HelperError('DEVICE_NOT_FOUND', 'http', { status: 404 })
    const { wifi, calls } = setup()
    const first = wifi.disconnect('192.168.1.42:5555')
    expect(wifi.getSnapshot().disconnecting).toBe('192.168.1.42:5555')
    await expect(wifi.disconnect('192.168.1.50:5555')).resolves.toBe('BUSY')
    await expect(first).resolves.toBeNull()
    expect(wifi.getSnapshot().disconnecting).toBeNull()
    calls.disconnectNetwork.mockRejectedValueOnce(gone)
    await expect(wifi.disconnect('192.168.1.42:5555')).resolves.toBeNull()
    calls.disconnectNetwork.mockRejectedValueOnce(new HelperError('ADB_SERVER_STOPPED', 'http'))
    await expect(wifi.disconnect('192.168.1.42:5555')).resolves.toBe('ADB_SERVER_STOPPED')
  })

  it('"no such device" for a device the helper still lists is a failure, not a disconnect', async () => {
    const gone = new HelperError('DEVICE_NOT_FOUND', 'http', { status: 404 })
    const { wifi, calls } = setup()
    const tv: HelperDevice = {
      id: '192.168.1.42:5555',
      platform: 'android',
      connection: 'network',
      state: 'ready',
      name: 'Living Room TV',
      model: '',
      modelId: '',
      osVersion: '11',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    }
    wifi.sync([tv])
    calls.disconnectNetwork.mockRejectedValueOnce(gone)
    await expect(wifi.disconnect(tv.id)).resolves.toBe('DEVICE_NOT_FOUND')
    wifi.sync([])
    calls.disconnectNetwork.mockRejectedValueOnce(gone)
    await expect(wifi.disconnect(tv.id)).resolves.toBeNull()
  })

  it('names a remembered device once the helper lists it, and only then notifies', async () => {
    const { wifi } = setup()
    await wifi.connect(TV)
    const listener = vi.fn()
    wifi.subscribe(listener)
    const row = (name: string): HelperDevice => ({
      id: '192.168.1.42:5555',
      platform: 'android',
      connection: 'network',
      state: 'ready',
      name,
      model: '',
      modelId: '',
      osVersion: '11',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
    wifi.sync([row('')])
    expect(listener).not.toHaveBeenCalled()
    wifi.sync([row('Living Room TV')])
    expect(wifi.getSnapshot().recent[0]?.name).toBe('Living Room TV')
    wifi.sync([row('Living Room TV')])
    expect(listener).toHaveBeenCalledTimes(1)
    wifi.forget(TV)
    expect(wifi.getSnapshot().recent).toEqual([])
  })
})

describe('failureOf', () => {
  it('names our own deadline, and anything that isn’t the helper’s', () => {
    expect(failureOf(new HelperError('HELPER_TIMEOUT', 'timeout'))).toMatchObject({
      code: 'HELPER_TIMEOUT',
    })
    expect(failureOf(new HelperError('TOOL_TIMEOUT', 'timeout'))).toMatchObject({
      code: 'HELPER_TIMEOUT',
    })
    expect(failureOf(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' })
  })
})
