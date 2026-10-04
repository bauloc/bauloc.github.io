import { afterEach, describe, expect, it, vi } from 'vitest'

import { deviceErrorMessage } from '../backends/backend'
import {
  createHelperClient,
  extractPng,
  HelperError,
  isAbortError,
  MAX_NDJSON_LINE,
  readNdjson,
  TIMEOUTS,
} from './client'
import type { LogMsg } from './protocol'

/*
  The client on its own, against a scripted fetch: the NDJSON reader's edges (chunks split
  anywhere, mid-UTF-8, junk lines, a giant line, silence, abort), the PNG defence, and how
  each failure becomes a HelperError the page can word.
*/

afterEach(() => {
  vi.useRealTimers()
})

const encoder = new TextEncoder()

/** A body that delivers `chunks` (strings or bytes), then ends, or stays open. */
function body(chunks: (string | Uint8Array)[], opts: { open?: boolean } = {}) {
  let i = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        const chunk = chunks[i++]!
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      } else if (!opts.open) controller.close()
      else return new Promise(() => undefined)
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, cancelled: () => cancelled }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const line = (value: unknown) => JSON.stringify(value) + '\n'

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
])

describe('readNdjson', () => {
  it('reads messages split across chunks and in the middle of a UTF-8 character', async () => {
    const text =
      line({ t: 'hello', device: 'd', source: 'syslog_relay', at: 1 }) +
      line({ t: 'lines', lines: ['Ngọc’s iPhone: ✓ ok'] }) +
      line({ t: 'end', reason: 'eof' })
    const bytes = encoder.encode(text)
    // Cut every 3 bytes: through the JSON, the newlines and the multi-byte characters.
    const chunks: Uint8Array[] = []
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3))
    const messages: LogMsg[] = []
    await readNdjson(body(chunks).stream, (m) => messages.push(m))
    expect(messages).toEqual([
      { t: 'hello', device: 'd', source: 'syslog_relay', at: 1 },
      { t: 'lines', lines: ['Ngọc’s iPhone: ✓ ok'] },
      { t: 'end', reason: 'eof' },
    ])
  })

  it('skips lines that are not JSON or not a message, and reads a last line without newline', async () => {
    const messages: LogMsg[] = []
    await readNdjson(
      body(['{"t":"ping","at":1}\n', 'garbage\n', '\n', '{"t":"shout"}\n', '{"t":"ping","at":2}'])
        .stream,
      (m) => messages.push(m),
    )
    expect(messages).toEqual([
      { t: 'ping', at: 1 },
      { t: 'ping', at: 2 },
    ])
  })

  it('skips a line over 1 MiB whole, and carries on after it', async () => {
    const huge = '{"t":"lines","lines":["' + 'x'.repeat(MAX_NDJSON_LINE) + '"]}\n'
    const messages: LogMsg[] = []
    await readNdjson(
      body([huge.slice(0, 600_000), huge.slice(600_000), line({ t: 'ping', at: 3 })]).stream,
      (m) => messages.push(m),
    )
    expect(messages.map((m) => m.t)).toEqual(['ping'])
    // Arriving in one chunk changes nothing.
    const again: LogMsg[] = []
    await readNdjson(body([huge + line({ t: 'ping', at: 4 })]).stream, (m) => again.push(m))
    expect(again.map((m) => m.t)).toEqual(['ping'])
  })

  it('rejects with HELPER_STREAM_STALLED when nothing arrives', async () => {
    vi.useFakeTimers()
    const { stream, cancelled } = body([line({ t: 'ping', at: 1 })], { open: true })
    const done = readNdjson(stream, () => undefined, { watchdogMs: 45_000 })
    const outcome = done.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(44_000)
    await vi.advanceTimersByTimeAsync(2_000)
    const error = await outcome
    expect(error).toBeInstanceOf(HelperError)
    expect(error).toMatchObject({ code: 'HELPER_STREAM_STALLED' })
    expect(cancelled()).toBe(true)
  })

  it('resolves quietly on abort, with no unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const controller = new AbortController()
      const { stream, cancelled } = body([line({ t: 'ping', at: 1 })], { open: true })
      const messages: LogMsg[] = []
      const done = readNdjson(stream, (m) => messages.push(m), { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort()
      await expect(done).resolves.toBeUndefined()
      expect(messages).toHaveLength(1)
      expect(cancelled()).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('an already aborted signal reads nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const onMsg = vi.fn()
    await readNdjson(body([line({ t: 'ping', at: 1 })]).stream, onMsg, {
      signal: controller.signal,
    })
    expect(onMsg).not.toHaveBeenCalled()
  })

  it('a broken connection is HELPER_UNREACHABLE', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line({ t: 'ping', at: 1 })))
        controller.error(new TypeError('network error'))
      },
    })
    await expect(readNdjson(stream, () => undefined)).rejects.toMatchObject({
      code: 'HELPER_UNREACHABLE',
    })
  })
})

describe('extractPng', () => {
  it('cuts after IEND and refuses what is not a PNG', () => {
    const noisy = new Uint8Array([...PNG, 0x0a, 0x57, 0x41, 0x52, 0x4e])
    expect(Array.from(extractPng(noisy) ?? [])).toEqual(Array.from(PNG))
    expect(extractPng(encoder.encode('<html>not a png</html>'))).toBeNull()
    expect(extractPng(PNG.slice(0, 15))).toBeNull()
    expect(
      extractPng(new Uint8Array([...PNG.slice(0, 8), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
    ).toBeNull()
  })

  it('walks the chunks: the bytes "IEND" inside image data don’t cut a screenshot short', () => {
    // Compressed pixels may hold any bytes, the whole IEND chunk included.
    const data = [7, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, 9]
    const idat = [0, 0, 0, data.length, 0x49, 0x44, 0x41, 0x54, ...data, 1, 2, 3, 4]
    const shot = new Uint8Array([...PNG.slice(0, 8), ...idat, ...PNG.slice(8)])
    expect(Array.from(extractPng(new Uint8Array([...shot, 0x0a, 0x57])) ?? [])).toEqual(
      Array.from(shot),
    )
    // A chunk that runs past the end is a screenshot cut short, whatever follows inside it.
    expect(extractPng(shot.slice(0, 8 + idat.length - 2))).toBeNull()
    // Not a chunk at all where one should start.
    expect(
      extractPng(new Uint8Array([...PNG.slice(0, 8), 0, 0, 0, 0, 0x31, 0x32, 0x33, 0x34])),
    ).toBeNull()
  })

  it('reads a PNG that sits inside a larger buffer', () => {
    const buffer = new Uint8Array([0xff, 0xff, 0xff, ...PNG])
    expect(Array.from(extractPng(buffer.subarray(3)) ?? [])).toEqual(Array.from(PNG))
  })
})

describe('createHelperClient', () => {
  const API = 'http://127.0.0.1:8787'

  function scripted(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return Promise.resolve(reply(url, init))
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
  }

  const authHeader = (init: RequestInit) => new Headers(init.headers).get('Authorization')

  it('sends no-store, no cookies and no referrer, and never the token to health', async () => {
    const { fetch, calls } = scripted(() => json({ name: 'bauloc-device-bridge', protocol: 1 }))
    const client = createHelperClient(API, () => 'T'.repeat(43), { fetch })
    await client.health('C'.repeat(22))
    expect(calls[0]?.url).toBe(`${API}/api/health?challenge=${'C'.repeat(22)}`)
    expect(calls[0]?.init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      method: 'GET',
    })
    expect(authHeader(calls[0]!.init)).toBeNull()
  })

  it('sends the bearer token to authenticated endpoints, and ids URL-encoded', async () => {
    const { fetch, calls } = scripted(() =>
      json({
        platform: 'android',
        kind: 'android',
        serial: '10.0.0.5:5555',
        connection: 'network',
        outputs: {},
      }),
    )
    const client = createHelperClient(API, () => 'T'.repeat(43), { fetch })
    await client.detail('10.0.0.5:5555')
    expect(calls[0]?.url).toBe(`${API}/api/devices/10.0.0.5%3A5555/detail`)
    expect(authHeader(calls[0]!.init)).toBe(`Bearer ${'T'.repeat(43)}`)
  })

  it('refuses an authenticated call without a token, sending nothing', async () => {
    const { fetch } = scripted(() => json({}))
    const client = createHelperClient(API, () => null, { fetch })
    await expect(client.devices()).rejects.toMatchObject({ code: 'HELPER_UNAUTHORIZED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('health: a readable non-helper reply is HELPER_FOREIGN', async () => {
    for (const reply of [
      () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
      () => json({ hello: 'world' }),
      () => json({ error: { code: 'X', message: 'm' } }, 404),
    ]) {
      const client = createHelperClient(API, () => null, { fetch: scripted(reply).fetch })
      await expect(client.health(null)).rejects.toMatchObject({
        code: 'HELPER_FOREIGN',
        kind: 'protocol',
      })
    }
  })

  it('a network failure is HELPER_UNREACHABLE; our deadline is a timeout', async () => {
    const down = createHelperClient(API, () => null, {
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    })
    await expect(down.health(null)).rejects.toMatchObject({
      code: 'HELPER_UNREACHABLE',
      kind: 'network',
    })

    vi.useFakeTimers()
    const hung = createHelperClient(API, () => null, {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    })
    const outcome = hung.health(null).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(TIMEOUTS.health + 1)
    expect(await outcome).toMatchObject({ kind: 'timeout' })
  })

  it('health with timeoutMs null waits as long as it takes (the permission prompt)', async () => {
    vi.useFakeTimers()
    let release: (r: Response) => void = () => undefined
    const client = createHelperClient(API, () => null, {
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    const outcome = client.health(null, { timeoutMs: null })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    release(json({ name: 'bauloc-device-bridge', protocol: 1 }))
    await expect(outcome).resolves.toMatchObject({ protocol: 1 })
  })

  it('the caller’s abort comes out as an AbortError, never a HelperError', async () => {
    const controller = new AbortController()
    const client = createHelperClient(API, () => 'T'.repeat(43), {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    })
    const outcome = client.detail('55090DLAQ0026D', controller.signal).catch((e: unknown) => e)
    controller.abort()
    expect(isAbortError(await outcome)).toBe(true)
  })

  describe('error bodies', () => {
    const fails = (status: number, value: unknown) =>
      createHelperClient(API, () => 'T'.repeat(43), {
        fetch: scripted(() =>
          value === undefined ? new Response('oops', { status }) : json(value, status),
        ).fetch,
      })

    it('a code DEVICE_ERRORS words becomes the message, so deviceErrorMessage words it', async () => {
      const error = await fails(409, {
        error: {
          code: 'DEVICE_NOT_READY',
          message: 'Helper words.',
          state: 'locked',
          blockers: ['IOS_LOCKED'],
        },
      })
        .detail('55090DLAQ0026D')
        .catch((e: unknown) => e)
      expect(error).toMatchObject({
        code: 'DEVICE_NOT_READY',
        status: 409,
        message: 'DEVICE_NOT_READY',
      })
      expect((error as HelperError).body?.blockers).toEqual(['IOS_LOCKED'])
      expect(deviceErrorMessage(error)).toBe('The device is not ready yet.')
    })

    it('a code the page has no words for keeps the helper’s plain message', async () => {
      const error = await fails(502, {
        error: { code: 'TOOL_NEW_THING', message: 'devicectl said no.' },
      })
        .detail('55090DLAQ0026D')
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'TOOL_NEW_THING', message: 'devicectl said no.' })
    })

    it('UNAUTHORIZED is HELPER_UNAUTHORIZED, with the helper’s fingerprint', async () => {
      const error = await fails(401, {
        error: { code: 'UNAUTHORIZED', message: 'Missing or wrong token.', tokenId: '4d1566a1' },
      })
        .devices()
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'HELPER_UNAUTHORIZED', status: 401 })
      expect((error as HelperError).body?.tokenId).toBe('4d1566a1')
    })

    it('an unreadable error is HELPER_BAD_REPLY (or HELPER_UNAUTHORIZED for a 401)', async () => {
      await expect(fails(500, undefined).devices()).rejects.toMatchObject({
        code: 'HELPER_BAD_REPLY',
      })
      await expect(fails(401, undefined).devices()).rejects.toMatchObject({
        code: 'HELPER_UNAUTHORIZED',
      })
    })

    it('a 2xx the guard refuses is HELPER_BAD_REPLY', async () => {
      await expect(fails(200, { rev: 'x' }).devices()).rejects.toMatchObject({
        code: 'HELPER_BAD_REPLY',
      })
    })
  })

  describe('screenshot', () => {
    const shot = (res: () => Response) =>
      createHelperClient(API, () => 'T'.repeat(43), { fetch: scripted(res).fetch }).screenshot(
        '55090DLAQ0026D',
      )

    it('returns a PNG Blob and the tool the helper named', async () => {
      const result = await shot(
        () =>
          new Response(PNG, {
            headers: { 'Content-Type': 'image/png', 'X-Screenshot-Source': 'devicectl' },
          }),
      )
      expect(result.blob.type).toBe('image/png')
      expect(result.blob.size).toBe(PNG.length)
      expect(result.source).toBe('devicectl')
    })

    it('an unknown source reads as null', async () => {
      const result = await shot(
        () =>
          new Response(PNG, {
            headers: { 'Content-Type': 'image/png', 'X-Screenshot-Source': 'magic' },
          }),
      )
      expect(result.source).toBeNull()
    })

    it('anything that is not a PNG is SCREENSHOT_NOT_PNG', async () => {
      await expect(
        shot(() => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })),
      ).rejects.toMatchObject({ code: 'SCREENSHOT_NOT_PNG' })
      await expect(
        shot(() => new Response('not png', { headers: { 'Content-Type': 'image/png' } })),
      ).rejects.toMatchObject({ code: 'SCREENSHOT_NOT_PNG' })
    })
  })

  describe('logs', () => {
    it('streams messages and resolves at the end', async () => {
      const { stream } = body([
        line({ t: 'hello', device: 'd', source: 'logcat', at: 1 }),
        line({ t: 'end', reason: 'eof' }),
      ])
      const client = createHelperClient(API, () => 'T'.repeat(43), {
        fetch: scripted(
          () =>
            new Response(stream, {
              headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
            }),
        ).fetch,
      })
      const messages: LogMsg[] = []
      await client.logs('55090DLAQ0026D', (m) => messages.push(m), new AbortController().signal)
      expect(messages.map((m) => m.t)).toEqual(['hello', 'end'])
    })

    it('an error before hello rejects with its code', async () => {
      const client = createHelperClient(API, () => 'T'.repeat(43), {
        fetch: scripted(() => json({ error: { code: 'TOO_MANY_STREAMS', message: 'm' } }, 429))
          .fetch,
      })
      await expect(
        client.logs('55090DLAQ0026D', () => undefined, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'TOO_MANY_STREAMS', status: 429 })
    })

    it('Stop while the stream is opening resolves quietly', async () => {
      const controller = new AbortController()
      const client = createHelperClient(API, () => 'T'.repeat(43), {
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          }),
      })
      const done = client.logs('55090DLAQ0026D', () => undefined, controller.signal)
      controller.abort()
      await expect(done).resolves.toBeUndefined()
    })

    it('a 200 that is not NDJSON is HELPER_BAD_REPLY', async () => {
      const client = createHelperClient(API, () => 'T'.repeat(43), {
        fetch: scripted(() => json({ ok: true })).fetch,
      })
      await expect(
        client.logs('55090DLAQ0026D', () => undefined, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'HELPER_BAD_REPLY' })
    })
  })

  it('the Wi‑Fi routes POST JSON with the token, and nothing in the URL', async () => {
    const { fetch, calls } = scripted((url) =>
      url.endsWith('/connect')
        ? json({ result: 'connected', serial: '192.168.1.42:5555', device: null })
        : url.endsWith('/pair')
          ? json({ result: 'paired', host: '192.168.1.42', port: 37099 })
          : json({ result: 'disconnected', serial: '192.168.1.42:5555' }),
    )
    const client = createHelperClient(API, () => 'T'.repeat(43), { fetch })
    await client.connectNetwork({ host: '192.168.1.42', port: 5555 })
    await client.pairNetwork({ host: '192.168.1.42', port: 37099, code: '482913' })
    await client.disconnectNetwork('192.168.1.42:5555')
    expect(calls.map((c) => `${c.init.method ?? ''} ${c.url.replace(API, '')}`)).toEqual([
      'POST /api/android/connect',
      'POST /api/android/pair',
      'POST /api/android/disconnect',
    ])
    expect(calls.map((c) => JSON.parse(c.init.body as string) as unknown)).toEqual([
      { host: '192.168.1.42', port: 5555 },
      { host: '192.168.1.42', port: 37099, code: '482913' },
      { serial: '192.168.1.42:5555' },
    ])
    for (const { init } of calls) {
      const headers = new Headers(init.headers)
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(headers.get('Authorization')).toBe(`Bearer ${'T'.repeat(43)}`)
    }
  })

  it('a refused connect is a HelperError with the reason, and the helper’s sentence', async () => {
    const client = createHelperClient(API, () => 'T'.repeat(43), {
      fetch: scripted(() =>
        json(
          {
            error: {
              code: 'ANDROID_CONNECT_FAILED',
              message: 'Could not connect to 192.168.1.42:5556.',
              reason: 'refused',
              detail: 'Connection refused',
            },
          },
          502,
        ),
      ).fetch,
    })
    const error = await client
      .connectNetwork({ host: '192.168.1.42', port: 5556 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HelperError)
    expect(error).toMatchObject({
      code: 'ANDROID_CONNECT_FAILED',
      status: 502,
      body: {
        message: 'Could not connect to 192.168.1.42:5556.',
        reason: 'refused',
        detail: 'Connection refused',
      },
    })
    // Anywhere but the Wi‑Fi dialog (a toast), the page's own words.
    expect(deviceErrorMessage(error)).toBe(
      'Couldn’t connect over Wi‑Fi. Check the address, and that network debugging is on.',
    )
  })

  it('doctor asks ?refresh=1 only on Re-check; start-server is a POST', async () => {
    const { fetch, calls } = scripted((url) =>
      url.includes('start-server')
        ? json({ android: { status: 'ok', adb: 'found', startedByHelper: true } })
        : json({ helper: {}, lanes: {}, items: [], checkedAt: 1 }),
    )
    const client = createHelperClient(API, () => 'T'.repeat(43), { fetch })
    await client.doctor(false)
    await client.doctor(true)
    expect(await client.startServer()).toMatchObject({ status: 'ok', startedByHelper: true })
    expect(calls.map((c) => `${c.init.method ?? ''} ${c.url.replace(API, '')}`)).toEqual([
      'GET /api/doctor',
      'GET /api/doctor?refresh=1',
      'POST /api/android/start-server',
    ])
  })
})
