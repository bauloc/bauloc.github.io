import { createHash, createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CADENCE,
  createHelperConnection,
  type HelperConnection,
  type HelperConnectionDeps,
  type HelperPhase,
  type VisibilityLike,
} from './connection'
import type { HelperEnv, PermissionsLike, PermissionStatusLike } from './env'
import { readPendingPair, stashPendingPair } from './pair-fragment'
import type { HelperDevice, Lanes } from './protocol'
import { memoryStores, readStoredToken, saveToken, type TokenStores } from './token'

/*
  HelperConnection against a scripted helper (a fake fetch that answers like
  device-bridge.mjs, with node:crypto for the proof) and fake timers, permissions and
  visibility. What it pins down (spec §6.3–§6.7, §9.1):
  - no request at all for a `prompt` permission without intent, Safari or `denied`;
  - one probe at a time, no deadline while the prompt may be up, the 1 s "dismissed" rule;
  - the token is never sent before the proof, nor after a failure until the proof again;
  - a candidate never overwrites a working token; 401 → stale; two failures → lost;
  - every backoff and polling cadence, hidden tabs, rev/runId gating, StrictMode restarts.
*/

const TOKEN = 'abcdefghijABCDEFGHIJ0123456789_-abcdefghijk'
const OTHER = 'ZYXWVUTSRQzyxwvutsrq9876543210-_zyxwvutsrqp'
const tokenIdOf = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8)

const IPHONE: HelperDevice = {
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'iPhone',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
}

const LANES = {
  ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: false, wifiHidden: 0 },
  android: { status: 'stopped', adb: 'found', startedByHelper: false },
  simulators: { status: 'off', booted: 0 },
}

interface Seen {
  readonly path: string
  readonly method: string
  readonly authorization: string | null
  readonly at: number
  /** A JSON body, as sent (the Wi‑Fi routes). */
  readonly body?: string
}

/** A helper on 127.0.0.1:<port>, scripted per test. */
function fakeHelper(port = 8787) {
  const state = {
    up: true,
    token: TOKEN,
    protocol: 1,
    name: 'bauloc-device-bridge',
    /** Answer health with a page that isn't JSON. */
    html: false,
    /** A squatter: right tokenId, proof over another port. */
    proofPort: port,
    /** Reject with a TypeError after this many ms (simulates a closed prompt or a slow fail). */
    failAfterMs: 0,
    /** Never answer (a prompt the tester hasn't answered yet). */
    hang: false,
    devices: [IPHONE] as HelperDevice[],
    rev: 1,
    runId: 'run00001',
    features: ['android.start-server'],
    lanes: LANES as Lanes,
    /** Started with --keep-token. */
    tokenPersistent: false,
  }
  const seen: Seen[] = []
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const authorization = new Headers(init.headers).get('Authorization')
    seen.push({
      path: url.pathname + url.search,
      method: init.method ?? 'GET',
      authorization,
      at: Date.now(),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    })
    if (url.port !== String(port)) return Promise.reject(new TypeError('Failed to fetch'))
    if (state.hang || state.failAfterMs > 0) {
      return new Promise((resolve, reject) => {
        const fail = () => {
          reject(new DOMException('aborted', 'AbortError'))
        }
        init.signal?.addEventListener('abort', fail)
        if (!state.hang) {
          setTimeout(() => {
            reject(new TypeError('Failed to fetch'))
          }, state.failAfterMs)
        }
        void resolve
      })
    }
    if (!state.up) return Promise.reject(new TypeError('Failed to fetch'))
    if (url.pathname === '/api/health') {
      if (state.html) return Promise.resolve(new Response('<html>', { status: 200 }))
      const challenge = url.searchParams.get('challenge')
      return Promise.resolve(
        json({
          name: state.name,
          version: state.protocol === 1 ? '1.0.0' : '0.9.0',
          protocol: state.protocol,
          features: state.features,
          port,
          tokenId: tokenIdOf(state.token),
          tokenPersistent: state.tokenPersistent,
          runId: state.runId,
          startedAt: 1,
          local: false,
          platform: 'darwin-arm64',
          sha256: 'a'.repeat(64),
          ...(challenge
            ? {
                proof: createHmac('sha256', Buffer.from(state.token, 'utf8'))
                  .update(`bauloc-device-bridge proof v1|${String(state.proofPort)}|${challenge}`)
                  .digest('base64url'),
              }
            : {}),
        }),
      )
    }
    if (authorization !== `Bearer ${state.token}`) {
      return Promise.resolve(
        json(
          { error: { code: 'UNAUTHORIZED', message: 'm', tokenId: tokenIdOf(state.token) } },
          401,
        ),
      )
    }
    if (url.pathname === '/api/devices' || url.pathname === '/api/rescan') {
      return Promise.resolve(
        json({ rev: state.rev, runId: state.runId, devices: state.devices, lanes: state.lanes }),
      )
    }
    if (url.pathname === '/api/doctor') {
      return Promise.resolve(
        json({ helper: { version: '1.0.0' }, lanes: LANES, items: [], checkedAt: Date.now() }),
      )
    }
    if (url.pathname === '/api/android/connect') {
      return Promise.resolve(
        json({ result: 'connected', serial: '192.168.1.42:5555', message: 'm', device: null }),
      )
    }
    if (url.pathname === '/api/android/pair') {
      return Promise.resolve(
        json(
          {
            error: {
              code: 'ANDROID_PAIR_FAILED',
              message: 'Could not pair.',
              reason: 'wrong-code',
              detail: 'Failed: Wrong password or connection was dropped.',
            },
          },
          502,
        ),
      )
    }
    if (url.pathname === '/api/android/disconnect') {
      return Promise.resolve(
        json({ result: 'disconnected', serial: '192.168.1.42:5555', message: 'm' }),
      )
    }
    if (url.pathname === '/api/android/start-server') {
      return Promise.resolve(
        json({ android: { status: 'ok', adb: 'found', startedByHelper: true } }),
      )
    }
    if (url.pathname.endsWith('/detail')) {
      return Promise.resolve(
        json({ error: { code: 'DEVICE_NOT_READY', message: 'Not ready.' } }, 409),
      )
    }
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'm' } }, 404))
  }
  return { state, seen, fetch }
}

/** navigator.permissions with a state the test changes, firing onchange like Chrome. */
function fakePermissions(initial: string | null) {
  let current = initial
  const status: PermissionStatusLike = { state: initial ?? 'prompt', onchange: null }
  const permissions: PermissionsLike = {
    query: ({ name }) =>
      current === null || name !== 'loopback-network'
        ? Promise.reject(new TypeError('unknown'))
        : Promise.resolve(status),
  }
  return {
    permissions,
    set(next: string) {
      current = next
      Object.assign(status, { state: next })
      status.onchange?.call(status as unknown as PermissionStatus, new Event('change'))
    },
  }
}

function fakeDocument() {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }
  return {
    doc: doc satisfies VisibilityLike,
    listeners,
    setHidden(hidden: boolean) {
      doc.visibilityState = hidden ? 'hidden' : 'visible'
      for (const l of listeners) l()
    },
  }
}

const HOSTED: HelperEnv = {
  mode: 'hosted',
  apiBase: 'http://127.0.0.1:8787',
  port: 8787,
  safariLike: false,
  devOrigin: false,
}

const connections: HelperConnection[] = []

function setup(
  opts: {
    permission?: string | null
    env?: Partial<HelperEnv>
    stores?: TokenStores
    port?: number
  } = {},
) {
  const helper = fakeHelper(opts.port)
  const perms = fakePermissions(opts.permission === undefined ? 'granted' : opts.permission)
  const visibility = fakeDocument()
  const win = new EventTarget()
  const stores = opts.stores ?? memoryStores()
  const deps: HelperConnectionDeps = {
    fetch: helper.fetch,
    stores,
    permissions: perms.permissions,
    document: visibility.doc,
    window: win,
  }
  const conn = createHelperConnection({ ...HOSTED, ...opts.env }, deps)
  connections.push(conn)
  return { conn, helper, perms, visibility, win, stores }
}

/**
 * Lets promises, crypto.subtle (which completes off the main thread) and due fake timers run,
 * without moving the clock.
 */
async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Flushes until the connection reaches `want`, or gives up after `rounds`. Pairing hashes the
 * token with WebCrypto, which answers off the event loop: a fixed number of rounds is enough
 * on an idle machine and not always under a full parallel test run.
 */
async function untilPhase(conn: HelperConnection, want: string, rounds = 2000) {
  for (let i = 0; i < rounds && phase(conn) !== want; i++) await flush(1)
}

/** Moves the clock by `ms`, flushing on the way. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

const phase = (conn: HelperConnection): HelperPhase => conn.getStatus().phase

function paired(stores = memoryStores(), token = TOKEN) {
  saveToken({ v: 1, token, port: 8787, tokenId: tokenIdOf(token) }, false, stores)
  return stores
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
})

afterEach(() => {
  for (const c of connections.splice(0)) c.stop()
  vi.useRealTimers()
})

describe('when to look (§6.3)', () => {
  it('constructing does nothing at all', async () => {
    const { helper } = setup()
    await flush()
    expect(helper.seen).toEqual([])
  })

  it('a prompt permission with no intent stays off and sends nothing', async () => {
    const { conn, helper } = setup({ permission: 'prompt' })
    conn.start()
    await advance(60_000)
    expect(phase(conn)).toBe('off')
    expect(helper.seen).toEqual([])
    // Refresh and polling never prompt either.
    conn.pollNow()
    await flush()
    expect(helper.seen).toEqual([])
  })

  it('denied: nothing is sent', async () => {
    const { conn, helper } = setup({ permission: 'denied' })
    conn.start()
    await advance(60_000)
    expect(phase(conn)).toBe('denied')
    conn.connect()
    await flush()
    expect(helper.seen).toEqual([])
  })

  it('hosted Safari: phase safari, nothing is sent, not even on Connect', async () => {
    const { conn, helper } = setup({ permission: null, env: { safariLike: true } })
    expect(phase(conn)).toBe('safari')
    conn.start()
    conn.connect()
    await advance(30_000)
    expect(phase(conn)).toBe('safari')
    expect(helper.seen).toEqual([])
  })

  it('granted: looks on its own', async () => {
    const { conn, helper } = setup({ permission: 'granted' })
    conn.start()
    await flush()
    expect(helper.seen[0]?.path).toMatch(/^\/api\/health\?challenge=[\w-]{22}$/)
    expect(phase(conn)).toBe('unpaired')
  })

  it('unsupported, outside Safari (no prompt can appear): looks on its own', async () => {
    const { conn, helper } = setup({ permission: null })
    conn.start()
    await flush()
    expect(helper.seen).toHaveLength(1)
    expect(conn.getStatus().permission).toBe('unsupported')
  })

  it('a stored token or a pending #pair= link is intent enough, even with a prompt', async () => {
    const one = setup({ permission: 'prompt', stores: paired() })
    one.conn.start()
    await untilPhase(one.conn, 'connected')
    expect(phase(one.conn)).toBe('connected')

    const stores = memoryStores()
    stashPendingPair({ token: TOKEN, port: 8787 }, stores)
    const two = setup({ permission: 'prompt', stores })
    two.conn.start()
    await untilPhase(two.conn, 'connected')
    expect(phase(two.conn)).toBe('connected')
  })

  it('local mode looks at once, with no permission to ask', async () => {
    const { conn, helper } = setup({
      permission: null,
      env: { mode: 'local', apiBase: 'http://127.0.0.1:8787' },
    })
    conn.start()
    await flush()
    expect(conn.getStatus().permission).toBe('not-needed')
    expect(helper.seen).toHaveLength(1)
  })

  it('a permission granted later starts looking', async () => {
    const { conn, helper, perms } = setup({ permission: 'prompt' })
    conn.start()
    await flush()
    expect(helper.seen).toEqual([])
    perms.set('granted')
    await flush()
    expect(helper.seen).toHaveLength(1)
  })
})

describe('probing (§6.6)', () => {
  it('Connect with a prompt: checking + promptLikely, and no deadline while it waits', async () => {
    const { conn, helper } = setup({ permission: 'prompt' })
    helper.state.hang = true
    conn.start()
    await flush()
    conn.connect()
    await flush()
    expect(conn.getStatus()).toMatchObject({ phase: 'checking', promptLikely: true })
    await advance(5 * 60_000)
    expect(phase(conn)).toBe('checking')
    expect(helper.seen).toHaveLength(1)
  })

  it('one probe at a time', async () => {
    const { conn, helper } = setup({ permission: 'prompt' })
    helper.state.hang = true
    conn.start()
    await flush()
    conn.connect()
    conn.connect()
    conn.pollNow()
    await flush()
    expect(helper.seen).toHaveLength(1)
  })

  it('a TypeError after ≥ 1 s with the prompt still up is a dismissed prompt', async () => {
    const { conn, helper, win } = setup({ permission: 'prompt' })
    helper.state.failAfterMs = 1_500
    conn.start()
    await flush()
    conn.connect()
    await advance(1_500)
    expect(phase(conn)).toBe('dismissed')
    // Only Connect shows it again: no timer, and focus doesn't probe.
    win.dispatchEvent(new Event('focus'))
    await advance(60_000)
    expect(helper.seen).toHaveLength(1)
    conn.connect()
    await flush()
    expect(helper.seen).toHaveLength(2)
  })

  it('a fast TypeError is absent', async () => {
    const { conn, helper } = setup({ permission: 'prompt' })
    helper.state.up = false
    conn.start()
    await flush()
    conn.connect()
    await flush()
    expect(phase(conn)).toBe('absent')
  })

  it('Block in the prompt is denied, whichever arrives first', async () => {
    const { conn, helper, perms } = setup({ permission: 'prompt' })
    helper.state.failAfterMs = 1_200
    conn.start()
    await flush()
    conn.connect()
    await advance(1_000)
    perms.set('denied')
    await advance(500)
    expect(phase(conn)).toBe('denied')
  })

  it('a reply that isn’t the helper is foreign', async () => {
    const { conn, helper } = setup()
    helper.state.html = true
    conn.start()
    await flush()
    expect(phase(conn)).toBe('foreign')
    helper.state.html = false
    helper.state.name = 'something-else'
    await advance(CADENCE.waiting)
    expect(phase(conn)).toBe('foreign')
  })

  it('protocol out of range: outdated or newer, keeping the helper’s version', async () => {
    const { conn, helper } = setup()
    helper.state.protocol = 0
    conn.start()
    await flush()
    expect(conn.getStatus()).toMatchObject({ phase: 'outdated', health: { version: '0.9.0' } })
    helper.state.protocol = 2
    await advance(CADENCE.waiting)
    expect(phase(conn)).toBe('newer')
  })
})

describe('the token and the proof (§2.8, §6.5)', () => {
  it('pairs from the #pair= candidate: proof first, then the token', async () => {
    const stores = memoryStores()
    stashPendingPair({ token: TOKEN, port: 8787 }, stores)
    const { conn, helper } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(helper.seen[0]).toMatchObject({ authorization: null })
    expect(helper.seen[1]).toMatchObject({ path: '/api/devices', authorization: `Bearer ${TOKEN}` })
    expect(conn.getDevices()).toEqual([IPHONE])
    expect(readStoredToken(stores)).toMatchObject({ token: TOKEN, remembered: false })
    expect(readPendingPair(stores)).toBeNull()
  })

  it('a stored token from another run is stale, cleared, and never sent', async () => {
    const stores = paired(memoryStores(), OTHER)
    const { conn, helper } = setup({ stores })
    conn.start()
    await advance(60_000)
    expect(phase(conn)).toBe('stale')
    expect(helper.seen.every((s) => s.authorization === null)).toBe(true)
    expect(readStoredToken(stores)).toBeNull()
  })

  it('a candidate from another run with nothing stored is unpaired', async () => {
    const stores = memoryStores()
    stashPendingPair({ token: OTHER, port: 8787 }, stores)
    const { conn, helper } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('unpaired')
    expect(readPendingPair(stores)).toBeNull()
    expect(helper.seen.every((s) => s.authorization === null)).toBe(true)
  })

  it('a squatter that relays the challenge fails the proof: foreign, nothing sent', async () => {
    const stores = paired()
    const { conn, helper } = setup({ stores })
    helper.state.proofPort = 8788
    conn.start()
    await advance(30_000)
    expect(phase(conn)).toBe('foreign')
    expect(helper.seen.every((s) => s.authorization === null)).toBe(true)
    // The stored token is kept: it may well be right, for the real helper.
    expect(readStoredToken(stores)?.token).toBe(TOKEN)
  })

  it('a failed candidate never overwrites a working stored token', async () => {
    const stores = paired()
    stashPendingPair({ token: OTHER, port: 8787 }, stores)
    const { conn } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(readStoredToken(stores)?.token).toBe(TOKEN)
    expect(readPendingPair(stores)).toBeNull()
  })

  it('the candidate is checked once per page load, across StrictMode’s start → stop → start', async () => {
    const stores = memoryStores()
    stashPendingPair({ token: TOKEN, port: 8787 }, stores)
    const { conn, helper } = setup({ stores })
    conn.start()
    conn.stop()
    // The first check never completed, so the candidate is still there.
    expect(readPendingPair(stores)).not.toBeNull()
    conn.start()
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(readPendingPair(stores)).toBeNull()
    // Only the second start's probe went out (the first was aborted before it was sent, or ignored).
    expect(helper.seen.filter((s) => s.path.startsWith('/api/health')).length).toBeLessThanOrEqual(
      2,
    )
    conn.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop leaves no timers, in any phase', async () => {
    for (const setupState of ['absent', 'unpaired', 'connected'] as const) {
      const stores = setupState === 'connected' ? paired() : memoryStores()
      const { conn, helper } = setup({ stores })
      helper.state.up = setupState !== 'absent'
      conn.start()
      await flush()
      expect(phase(conn)).toBe(setupState)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      conn.stop()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('a 401 means the helper restarted: stale, and the old token is dropped', async () => {
    const stores = paired()
    const { conn, helper } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('connected')
    helper.state.token = OTHER
    helper.state.runId = 'run00002'
    await advance(CADENCE.devicesVisible)
    expect(phase(conn)).toBe('stale')
    expect(conn.getDevices()).toEqual([])
    expect(readStoredToken(stores)).toBeNull()
    // After the refused list only health went out: the old token was never sent again.
    const refused = helper.seen.map((s) => s.path).lastIndexOf('/api/devices')
    const after = helper.seen.slice(refused + 1)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((s) => s.path.startsWith('/api/health') && s.authorization === null)).toBe(
      true,
    )
    await advance(60_000)
    expect(helper.seen.slice(refused + 1).every((s) => s.authorization === null)).toBe(true)
  })
})

describe('stores shared between tabs, links and the helper’s own page (review fixes)', () => {
  /** One tab's stores: its own sessionStorage, and this computer's localStorage. */
  const tab = (shared: TokenStores): TokenStores => ({
    session: memoryStores().session,
    local: shared.local,
  })
  const storageEvent = () => Object.assign(new Event('storage'), { key: 'dvc_token' })

  it('a stale tab picks up the token another tab just remembered, and leaves it there', async () => {
    const computer = memoryStores()
    const a = tab(computer)
    saveToken({ v: 1, token: TOKEN, port: 8787, tokenId: tokenIdOf(TOKEN) }, true, a)
    // The helper restarted with a new per-run token; tab C opened its link and paired first.
    const { conn, helper, win } = setup({ stores: a })
    helper.state.token = OTHER
    const cStores = tab(computer)
    stashPendingPair({ token: OTHER, port: 8787 }, cStores)
    const c = setup({ stores: cStores })
    c.helper.state.token = OTHER
    c.conn.start()
    await flush()
    expect(phase(c.conn)).toBe('connected')
    expect(readStoredToken(computer)).toMatchObject({ token: OTHER })
    // Tab A still holds the old token in its session, and hears of the change.
    conn.start()
    win.dispatchEvent(storageEvent())
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(conn.getStatus().pairing).toMatchObject({ tokenId: tokenIdOf(OTHER), remembered: true })
    expect(readStoredToken(computer)?.token).toBe(OTHER)
    expect(readStoredToken(a)?.token).toBe(OTHER)
    expect(helper.seen.every((s) => s.authorization !== `Bearer ${TOKEN}`)).toBe(true)
  })

  it('a remembered token from an earlier run goes from both stores: stale', async () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: OTHER, port: 8787, tokenId: tokenIdOf(OTHER) }, true, stores)
    const { conn } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('stale')
    expect(stores.session?.getItem('dvc_token')).toBeNull()
    expect(stores.local?.getItem('dvc_token')).toBeNull()
  })

  it('a helper restart drops the remembered token, never Remember: the next pairing is kept', async () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: OTHER, port: 8787, tokenId: tokenIdOf(OTHER) }, true, stores)
    const { conn } = setup({ stores })
    expect(conn.getStatus().remember).toBe(true)
    conn.start()
    await flush()
    expect(phase(conn)).toBe('stale')
    expect(stores.local?.getItem('dvc_token')).toBeNull()
    // The switch the pair dialog starts from is still on.
    expect(conn.getStatus().remember).toBe(true)
    expect(await conn.pair(TOKEN, conn.getStatus().remember)).toEqual({ ok: true })
    await flush()
    expect(conn.getStatus().pairing).toMatchObject({ tokenId: tokenIdOf(TOKEN), remembered: true })
    // A new tab on this computer finds it.
    expect(readStoredToken({ session: memoryStores().session, local: stores.local })?.token).toBe(
      TOKEN,
    )
  })

  it('pairing with the switch off turns Remember off, and the next tab starts unpaired', async () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: OTHER, port: 8787, tokenId: tokenIdOf(OTHER) }, true, stores)
    const { conn } = setup({ stores })
    conn.start()
    await flush()
    expect(await conn.pair(TOKEN, false)).toEqual({ ok: true })
    await flush()
    expect(conn.getStatus()).toMatchObject({ remember: false, pairing: { remembered: false } })
    expect(stores.local?.getItem('dvc_token')).toBeNull()
  })

  it('pair: a pasted link without a port is for 8787, not the port of an earlier pairing', async () => {
    // Paired on 8788 once (dvc_port); the helper now runs on 8787 and prints a portless link.
    const stores = memoryStores()
    stores.local?.setItem('dvc_port', '8788')
    const { conn } = setup({ stores, env: { port: 8788, apiBase: 'http://127.0.0.1:8788' } })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('absent')
    expect(await conn.pair(`https://bauloc.github.io/device/#pair=${TOKEN}`, false)).toEqual({
      ok: true,
    })
    await flush()
    expect(conn.getStatus().env.port).toBe(8787)
    expect(phase(conn)).toBe('connected')
    expect(stores.local?.getItem('dvc_port')).toBeNull()
  })

  it('a #pair= link whose port answers nothing is spent: the tab goes back to its helper', async () => {
    // A crafted link: any token, a dead port. The page resolved its port from the link.
    const stores = paired()
    stashPendingPair({ token: OTHER, port: 9999 }, stores)
    const { conn, helper } = setup({
      stores,
      env: { port: 9999, apiBase: 'http://127.0.0.1:9999' },
    })
    conn.start()
    await flush()
    expect(readPendingPair(stores)).toBeNull()
    expect(conn.getStatus().env.port).toBe(8787)
    expect(phase(conn)).toBe('connected')
    // The stored token went to 8787 only after that helper proved itself.
    expect(helper.seen[0]?.path.startsWith('/api/health')).toBe(true)
    expect(helper.seen[0]?.authorization).toBeNull()
  })

  it('a #pair= link whose port holds something else is spent too', async () => {
    const stores = paired()
    stashPendingPair({ token: OTHER, port: 8787 }, stores)
    const { conn, helper } = setup({ stores, env: { port: 8787 } })
    helper.state.name = 'something-else'
    conn.start()
    await flush()
    expect(readPendingPair(stores)).toBeNull()
    expect(phase(conn)).toBe('foreign')
  })

  it('a prompt closed unanswered keeps the link for Connect', async () => {
    const stores = memoryStores()
    stashPendingPair({ token: TOKEN, port: 8787 }, stores)
    const { conn, helper } = setup({ stores, permission: 'prompt' })
    helper.state.failAfterMs = 1_500
    conn.start()
    await advance(1_500)
    expect(phase(conn)).toBe('dismissed')
    expect(readPendingPair(stores)).not.toBeNull()
  })

  it('the helper’s own page never remembers, and drops what an earlier build remembered', async () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: OTHER, port: 8787, tokenId: tokenIdOf(OTHER) }, true, stores)
    const { conn } = setup({
      stores,
      permission: null,
      env: { mode: 'local', apiBase: 'http://127.0.0.1:8787' },
    })
    conn.start()
    expect(stores.local?.getItem('dvc_token')).toBeNull()
    expect(await conn.pair(TOKEN, true)).toEqual({ ok: true })
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(stores.local?.getItem('dvc_token')).toBeNull()
    expect(conn.getStatus().pairing?.remembered).toBe(false)
    conn.setRemember(true)
    expect(stores.local?.getItem('dvc_token')).toBeNull()
    expect(conn.getStatus().pairing?.remembered).toBe(false)
    // A per-run token dies with its helper: this tab may keep it for a reload.
    expect(stores.session?.getItem('dvc_token')).toContain(TOKEN)
  })

  it('the helper’s own page keeps a kept token (--keep-token) in memory only', async () => {
    const stores = memoryStores()
    // Left from a per-run pairing before the helper restarted with --keep-token.
    saveToken({ v: 1, token: OTHER, port: 8787, tokenId: tokenIdOf(OTHER) }, false, stores)
    const { conn, helper } = setup({
      stores,
      permission: null,
      env: { mode: 'local', apiBase: 'http://127.0.0.1:8787' },
    })
    helper.state.tokenPersistent = true
    conn.start()
    await flush()
    expect(await conn.pair(TOKEN, true)).toEqual({ ok: true })
    await flush()
    expect(phase(conn)).toBe('connected')
    expect(stores.session?.getItem('dvc_token')).toBeNull()
    expect(stores.local?.getItem('dvc_token')).toBeNull()
    // Still paired in this page view: a dropped connection proves the helper and carries on.
    helper.state.up = false
    await advance(CADENCE.devicesVisible * 3)
    helper.state.up = true
    await advance(CADENCE.lost.at(-1) ?? 10_000)
    expect(phase(conn)).toBe('connected')
  })
})

describe('connected (§6.6, §6.7)', () => {
  it('polls every 2 s, and every 10 s while hidden', async () => {
    const { conn, helper, visibility } = setup({ stores: paired() })
    conn.start()
    await flush()
    const lists = () => helper.seen.filter((s) => s.path === '/api/devices').length
    expect(lists()).toBe(1)
    await advance(2_000)
    expect(lists()).toBe(2)
    await advance(2_000)
    expect(lists()).toBe(3)
    visibility.setHidden(true)
    await advance(2_000)
    // The poll already scheduled runs, then the hidden cadence takes over.
    const hiddenStart = lists()
    await advance(9_000)
    expect(lists()).toBe(hiddenStart)
    await advance(1_000)
    expect(lists()).toBe(hiddenStart + 1)
    // Becoming visible polls at once.
    visibility.setHidden(false)
    await flush()
    expect(lists()).toBe(hiddenStart + 2)
  })

  it('notifies only when rev or runId changes', async () => {
    const { conn, helper } = setup({ stores: paired() })
    const listener = vi.fn()
    conn.subscribeDevices(listener)
    conn.start()
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    await advance(2_000)
    await advance(2_000)
    expect(listener).toHaveBeenCalledTimes(1)
    helper.state.rev = 2
    helper.state.devices = []
    await advance(2_000)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(conn.getDevices()).toEqual([])
    // --keep-token restart: same token, new run, rev back to 1.
    helper.state.runId = 'run00002'
    helper.state.rev = 1
    helper.state.devices = [IPHONE]
    await advance(2_000)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(phase(conn)).toBe('connected')
  })

  it('status listeners hear nothing when a poll changes nothing', async () => {
    const { conn } = setup({ stores: paired() })
    conn.start()
    await flush()
    const listener = vi.fn()
    conn.subscribeStatus(listener)
    await advance(2_000)
    await advance(2_000)
    expect(listener).not.toHaveBeenCalled()
    expect(conn.getStatus().lanes?.android.status).toBe('stopped')
  })

  it('one failure re-probes (proof first); a second in a row is lost, and the list empties', async () => {
    const { conn, helper } = setup({ stores: paired() })
    conn.start()
    await flush()
    helper.state.up = false
    const before = helper.seen.length
    await advance(2_000)
    // The failed list, then a proof probe (no token), then lost.
    expect(helper.seen.slice(before).map((s) => [s.path.split('?')[0], s.authorization])).toEqual([
      ['/api/devices', `Bearer ${TOKEN}`],
      ['/api/health', null],
    ])
    expect(phase(conn)).toBe('lost')
    expect(conn.getDevices()).toEqual([])
  })

  it('lost: retries at 1, 2, 4, 8, then every 10 s, and comes back after the proof', async () => {
    const { conn, helper } = setup({ stores: paired() })
    conn.start()
    await flush()
    helper.state.up = false
    await advance(2_000)
    expect(phase(conn)).toBe('lost')
    const probes = () => helper.seen.filter((s) => s.path.startsWith('/api/health')).length
    const start = probes()
    for (const gap of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
      await advance(gap - 1)
      const n = probes()
      await advance(1)
      expect(probes()).toBe(n + 1)
    }
    expect(probes()).toBe(start + 6)
    helper.state.up = true
    await advance(10_000)
    expect(phase(conn)).toBe('connected')
    expect(conn.getDevices()).toEqual([IPHONE])
  })
})

describe('absent and waiting cadences (§6.7)', () => {
  it('absent: 2, 4, 8, then 10 s; 60 s while hidden; at once on becoming visible or focus', async () => {
    const { conn, helper, visibility, win } = setup()
    helper.state.up = false
    conn.start()
    await flush()
    expect(phase(conn)).toBe('absent')
    const probes = () => helper.seen.length
    for (const gap of [2_000, 4_000, 8_000, 10_000, 10_000]) {
      await advance(gap - 1)
      const n = probes()
      await advance(1)
      expect(probes()).toBe(n + 1)
    }
    visibility.setHidden(true)
    const n = probes()
    // The look already scheduled while visible still happens; then 60 s apart.
    await advance(10_000)
    expect(probes()).toBe(n + 1)
    await advance(59_999)
    expect(probes()).toBe(n + 1)
    await advance(1)
    expect(probes()).toBe(n + 2)
    const m = probes()
    visibility.setHidden(false)
    await flush()
    expect(probes()).toBe(m + 1)
    win.dispatchEvent(new Event('focus'))
    await flush()
    expect(probes()).toBe(m + 2)
  })

  it('unpaired: health every 10 s while visible, nothing while hidden', async () => {
    const { conn, helper, visibility } = setup()
    conn.start()
    await flush()
    expect(phase(conn)).toBe('unpaired')
    await advance(10_000)
    expect(helper.seen).toHaveLength(2)
    visibility.setHidden(true)
    await advance(120_000)
    expect(helper.seen).toHaveLength(2)
    visibility.setHidden(false)
    await flush()
    expect(helper.seen).toHaveLength(3)
  })

  it('another tab’s pairing is picked up through the storage event', async () => {
    const { conn, win, stores } = setup()
    conn.start()
    await flush()
    expect(phase(conn)).toBe('unpaired')
    paired(stores)
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'dvc_token' }))
    await flush()
    expect(phase(conn)).toBe('connected')
  })
})

describe('pair, forget, doctor, startAdb', () => {
  it('pair: format, stale (with the fingerprint), then ok and remembered', async () => {
    const { conn, stores } = setup()
    conn.start()
    await flush()
    expect(await conn.pair('not a token', false)).toEqual({ ok: false, reason: 'format' })
    expect(await conn.pair(OTHER, false)).toEqual({
      ok: false,
      reason: 'stale',
      tokenId: tokenIdOf(TOKEN),
    })
    expect(readStoredToken(stores)).toBeNull()
    const result = await conn.pair(`https://bauloc.github.io/device/#pair=${TOKEN}`, true)
    await flush()
    expect(result).toEqual({ ok: true })
    expect(phase(conn)).toBe('connected')
    expect(conn.getStatus().pairing).toMatchObject({ tokenId: tokenIdOf(TOKEN), remembered: true })
  })

  it('pair: a squatter is foreign, a stopped helper unreachable; neither replaces the token', async () => {
    const stores = paired()
    const { conn, helper } = setup({ stores })
    conn.start()
    await flush()
    helper.state.proofPort = 1
    expect(await conn.pair(TOKEN, false)).toEqual({ ok: false, reason: 'foreign', port: 8787 })
    helper.state.up = false
    expect(await conn.pair(OTHER, false)).toEqual({ ok: false, reason: 'unreachable', port: 8787 })
    expect(readStoredToken(stores)?.token).toBe(TOKEN)
  })

  it('pair: a link for another port switches only once that helper proved itself', async () => {
    const { conn, stores } = setup({ port: 8788 })
    conn.start()
    await flush()
    // 8787 has nothing: absent.
    expect(phase(conn)).toBe('absent')
    // The failure names the port the link asked for, not the page's (pair errors say it).
    expect(await conn.pair(`http://127.0.0.1:8789/device/#pair=${TOKEN}&port=8789`, false)).toEqual(
      { ok: false, reason: 'unreachable', port: 8789 },
    )
    expect(conn.getStatus().env.port).toBe(8787)
    expect(await conn.pair(`http://127.0.0.1:8788/device/#pair=${TOKEN}&port=8788`, false)).toEqual(
      { ok: true },
    )
    await flush()
    expect(conn.getStatus().env).toMatchObject({ port: 8788, apiBase: 'http://127.0.0.1:8788' })
    expect(phase(conn)).toBe('connected')
    expect(stores.local?.getItem('dvc_port')).toBe('8788')
  })

  it('forget clears both stores and the list', async () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: TOKEN, port: 8787, tokenId: tokenIdOf(TOKEN) }, true, stores)
    const { conn } = setup({ stores })
    conn.start()
    await flush()
    expect(phase(conn)).toBe('connected')
    conn.forget()
    expect(phase(conn)).toBe('unpaired')
    expect(conn.getDevices()).toEqual([])
    expect(readStoredToken(stores)).toBeNull()
    expect(conn.getStatus().pairing).toBeNull()
    // Forgetting is asking this computer to keep nothing: the Remember choice goes too.
    expect(stores.local?.getItem('dvc_remember')).toBeNull()
    expect(conn.getStatus().remember).toBe(false)
  })

  it('setRemember copies the pairing to this computer, or takes it off', async () => {
    const { conn, stores } = setup({ stores: paired() })
    conn.start()
    await flush()
    expect(conn.getStatus().pairing?.remembered).toBe(false)
    conn.setRemember(true)
    expect(conn.getStatus().pairing?.remembered).toBe(true)
    expect(stores.local?.getItem('dvc_token')).toContain(TOKEN)
    expect(conn.getStatus().remember).toBe(true)
    conn.setRemember(false)
    expect(conn.getStatus().pairing?.remembered).toBe(false)
    expect(conn.getStatus().remember).toBe(false)
    expect(stores.local?.getItem('dvc_token')).toBeNull()
  })

  it('doctor: null unless connected, cached 30 s, refreshed on Re-check', async () => {
    const { conn, helper } = setup({ stores: paired() })
    expect(await conn.doctor()).toBeNull()
    conn.start()
    await flush()
    const doctors = () =>
      helper.seen.filter((s) => s.path.startsWith('/api/doctor')).map((s) => s.path)
    await conn.doctor()
    await conn.doctor()
    expect(doctors()).toEqual(['/api/doctor'])
    await advance(30_000)
    await conn.doctor()
    await conn.doctor(true)
    expect(doctors()).toEqual(['/api/doctor', '/api/doctor', '/api/doctor?refresh=1'])
  })

  it('doctor: a lane that changed drops the cached report', async () => {
    const { conn, helper } = setup({ stores: paired() })
    conn.start()
    await flush()
    const doctors = () => helper.seen.filter((s) => s.path.startsWith('/api/doctor')).length
    await conn.doctor()
    // Same lanes, newer list: the report still holds.
    helper.state.rev++
    conn.pollNow()
    await flush()
    await conn.doctor()
    expect(doctors()).toBe(1)
    // The adb server stopped: the tools report is read again.
    helper.state.lanes = {
      ...LANES,
      android: { status: 'ok', adb: 'found', startedByHelper: false },
    } as Lanes
    helper.state.rev++
    conn.pollNow()
    await flush()
    await conn.doctor()
    expect(doctors()).toBe(2)
  })

  it('startAdb: only when the helper has the feature, then the lane updates', async () => {
    const { conn, helper } = setup({ stores: paired() })
    conn.start()
    await flush()
    await conn.startAdb()
    expect(conn.getStatus().lanes?.android).toMatchObject({ status: 'ok', startedByHelper: true })
    expect(
      helper.seen.some((s) => s.path === '/api/android/start-server' && s.method === 'POST'),
    ).toBe(true)

    const other = setup({ stores: paired() })
    other.helper.state.features = []
    other.conn.start()
    await flush()
    await expect(other.conn.startAdb()).rejects.toMatchObject({ code: 'ANDROID_OFF' })
    expect(other.helper.seen.some((s) => s.path.includes('start-server'))).toBe(false)
  })

  it('Wi‑Fi: only when the helper lists android.connect; JSON bodies; the list is polled after', async () => {
    const { conn, helper } = setup({ stores: paired() })
    await expect(conn.connectNetwork({ host: '192.168.1.42', port: 5555 })).rejects.toMatchObject({
      code: 'HELPER_UNREACHABLE',
    })
    helper.state.features = ['android.start-server', 'android.connect']
    conn.start()
    await flush()
    const lists = () => helper.seen.filter((s) => s.path === '/api/devices').length
    const before = lists()
    await expect(conn.connectNetwork({ host: '192.168.1.42', port: 5555 })).resolves.toEqual({
      result: 'connected',
      serial: '192.168.1.42:5555',
      device: null,
    })
    await flush()
    expect(lists()).toBe(before + 1)
    const sent = helper.seen.find((s) => s.path === '/api/android/connect')
    expect(sent).toMatchObject({ method: 'POST', authorization: `Bearer ${TOKEN}` })
    expect(JSON.parse(sent?.body ?? '')).toEqual({ host: '192.168.1.42', port: 5555 })

    // A failure keeps the helper's reason and adb's words, and the connection stays up.
    await expect(
      conn.pairNetwork({ host: '192.168.1.42', port: 37099, code: '123456' }),
    ).rejects.toMatchObject({
      code: 'ANDROID_PAIR_FAILED',
      body: { reason: 'wrong-code', detail: 'Failed: Wrong password or connection was dropped.' },
    })
    expect(conn.getStatus().phase).toBe('connected')

    await expect(conn.disconnectNetwork('192.168.1.42:5555')).resolves.toEqual({
      result: 'disconnected',
      serial: '192.168.1.42:5555',
    })
    const gone = helper.seen.find((s) => s.path === '/api/android/disconnect')
    expect(JSON.parse(gone?.body ?? '')).toEqual({ serial: '192.168.1.42:5555' })
  })

  it('Wi‑Fi: a helper without android.connect is never asked', async () => {
    const { conn, helper } = setup({ stores: paired() })
    conn.start()
    await flush()
    await expect(conn.connectNetwork({ host: '192.168.1.42', port: 5555 })).rejects.toMatchObject({
      code: 'NETWORK_UNSUPPORTED',
    })
    await expect(conn.disconnectNetwork('192.168.1.42:5555')).rejects.toMatchObject({
      code: 'NETWORK_UNSUPPORTED',
    })
    expect(helper.seen.some((s) => s.path.startsWith('/api/android/'))).toBe(false)
  })

  it('a failed operation polls the list at once; operations need a connection', async () => {
    const { conn, helper } = setup({ stores: paired() })
    await expect(conn.api.detail(IPHONE.id)).rejects.toMatchObject({ code: 'HELPER_UNREACHABLE' })
    conn.start()
    await flush()
    const lists = () => helper.seen.filter((s) => s.path === '/api/devices').length
    const before = lists()
    await expect(conn.api.detail(IPHONE.id)).rejects.toMatchObject({ code: 'DEVICE_NOT_READY' })
    await flush()
    expect(lists()).toBe(before + 1)
  })

  it('refresh never probes in off, denied or safari', async () => {
    const { conn, helper } = setup({ permission: 'prompt' })
    conn.start()
    await flush()
    await conn.rescan()
    conn.pollNow()
    await flush()
    expect(helper.seen).toEqual([])
  })
})
