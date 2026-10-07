import { createHash, createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionsLike } from '@/features/device/helper/env'
import { downloadCommand } from '@/features/device/helper/status'
import {
  memoryStores,
  readStoredPort,
  readTokenEntries,
  saveStoredPort,
  saveToken,
  type TokenStores,
} from '@/features/device/helper/token'
import { currentLocale } from '@/lib/locale'
import type * as LocaleModule from '@/lib/locale'

import { AuthError } from '../repo/github'
import {
  GITHUB_UPLOAD,
  HelperUploadError,
  helperCommand,
  pairHelper,
  probeHelper,
  releaseContentType,
  uploadViaHelper,
  type HelperDeps,
  type HelperUpload,
} from './helper'

/*
  The console's side of the Device Lab helper, against a scripted helper: health answered the
  way device-bridge.mjs answers it (node:crypto for the proof), and the upload route's answers
  through a stand-in XMLHttpRequest. What it pins down: a token is never sent before the
  helper proved itself on the very port the page talks to, the pairing lands in Device Lab's
  own store, and every way an upload can fail comes back worded, or as what the console
  already answers (AuthError, AbortError).
*/

vi.mock('@/lib/locale', async (importOriginal) => ({
  ...(await importOriginal<typeof LocaleModule>()),
  currentLocale: vi.fn(() => 'en'),
}))

const TOKEN = 'abcdefghijABCDEFGHIJ0123456789_-abcdefghijk'
const OTHER = 'ZYXWVUTSRQzyxwvutsrq9876543210-_zyxwvutsrqp'
const PAT = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
const tokenIdOf = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8)

/** A helper on 127.0.0.1:<port>: what it answers to health, and every request it saw. */
function fakeHelper(port = 8787) {
  const state = {
    up: true,
    name: 'bauloc-device-bridge',
    version: '1.4.0',
    protocol: 1,
    features: ['lan.discover', GITHUB_UPLOAD] as string[],
    token: TOKEN,
    /** A squatter relaying to the real helper: the right fingerprint, a proof over its port. */
    proofPort: port,
    /** Answer with a page that is no helper's JSON. */
    html: false,
  }
  const seen: { url: string; authorization: string | null; signal: AbortSignal | null }[] = []
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    seen.push({
      url: url.href,
      authorization: new Headers(init.headers).get('Authorization'),
      signal: init.signal ?? null,
    })
    if (init.signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (!state.up || url.port !== String(port)) {
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    if (state.html) return Promise.resolve(new Response('<html>', { status: 200 }))
    const challenge = url.searchParams.get('challenge')
    return Promise.resolve(
      Response.json({
        name: state.name,
        version: state.version,
        protocol: state.protocol,
        features: state.features,
        port,
        tokenId: tokenIdOf(state.token),
        tokenPersistent: false,
        runId: 'run00001',
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
  })
  return { state, seen, fetch: fetch as unknown as typeof globalThis.fetch }
}

const CHROME = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
}
const SAFARI = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  vendor: 'Apple Computer, Inc.',
}

/** The loopback permission in a given state, as navigator.permissions answers it. */
const permission = (state: string): PermissionsLike => ({
  query: () => Promise.resolve({ state, onchange: null }),
})

let stores: TokenStores
let helper: ReturnType<typeof fakeHelper>

/** Everything the functions reach for, scripted; `more` replaces any of it. */
const deps = (more: Partial<HelperDeps> = {}): HelperDeps => ({
  fetch: helper.fetch,
  stores,
  permissions: permission('granted'),
  browser: CHROME,
  ...more,
})

/** A token this page holds for `port`, as Device Lab's pairing saves it. */
const hold = (token: string, port = 8787, remember = false) => {
  saveToken({ v: 1, token, port, tokenId: tokenIdOf(token) }, remember, stores)
}

beforeEach(() => {
  stores = memoryStores()
  helper = fakeHelper()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(currentLocale).mockReturnValue('en')
})

describe('helperCommand', () => {
  it('is Device Lab’s download command, for the port looked on, with --dev on a dev server', () => {
    expect(helperCommand(8787, false)).toBe(downloadCommand(8787))
    expect(helperCommand(8788, false)).toBe(downloadCommand(8788))
    expect(helperCommand(8787, true)).toBe(`${downloadCommand(8787)} --dev`)
    expect(helperCommand(8787, false)).toBe(
      'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
    )
  })
})

describe('probeHelper', () => {
  it('finds no helper where nothing answers', async () => {
    helper.state.up = false
    expect(await probeHelper(undefined, deps())).toEqual({
      state: 'missing',
      reason: 'absent',
      port: 8787,
    })
  })

  it('tells another program on the port from no helper at all', async () => {
    helper.state.name = 'something-else'
    expect(await probeHelper(undefined, deps())).toMatchObject({ reason: 'foreign' })
    helper.state.html = true
    expect(await probeHelper(undefined, deps())).toMatchObject({ reason: 'foreign' })
  })

  it('asks nothing where the browser cannot reach the helper: Safari, or a denied permission', async () => {
    expect(await probeHelper(undefined, deps({ browser: SAFARI }))).toEqual({
      state: 'missing',
      reason: 'safari',
      port: 8787,
    })
    expect(await probeHelper(undefined, deps({ permissions: permission('denied') }))).toEqual({
      state: 'missing',
      reason: 'blocked',
      port: 8787,
    })
    expect(helper.fetch).not.toHaveBeenCalled()
  })

  it('calls a helper without github.upload, or of another protocol, outdated', async () => {
    helper.state.features = ['lan.discover', 'android.adb']
    helper.state.version = '1.3.0'
    hold(TOKEN)
    expect(await probeHelper(undefined, deps())).toEqual({
      state: 'outdated',
      version: '1.3.0',
      port: 8787,
    })
    helper.state.features = [GITHUB_UPLOAD]
    helper.state.protocol = 2
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'outdated' })
  })

  it('is unpaired without a token, or with one the helper does not hold', async () => {
    expect(await probeHelper(undefined, deps())).toEqual({
      state: 'unpaired',
      version: '1.4.0',
      port: 8787,
    })
    // A token from another run of the helper: its fingerprint differs.
    hold(OTHER)
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'unpaired' })
  })

  it('is unpaired when the fingerprint matches but the proof is over another port', async () => {
    hold(TOKEN)
    helper.state.proofPort = 9999
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'unpaired' })
  })

  it('is ready once the token this page holds passed the proof, and never sent it', async () => {
    hold(TOKEN)
    expect(await probeHelper(undefined, deps())).toEqual({
      state: 'ready',
      version: '1.4.0',
      port: 8787,
      token: TOKEN,
    })
    expect(helper.seen.map((s) => s.authorization)).toEqual([null])
    expect(helper.seen[0]?.url).toMatch(
      /^http:\/\/127\.0\.0\.1:8787\/api\/health\?challenge=[A-Za-z0-9_-]{22}$/,
    )
  })

  it('takes the token remembered on this computer when this tab’s is from an older run', async () => {
    // Device Lab in another tab paired with the restarted helper and remembered it.
    hold(OTHER)
    stores.local?.setItem(
      'dvc_token',
      JSON.stringify({ v: 1, token: TOKEN, port: 8787, tokenId: tokenIdOf(TOKEN) }),
    )
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'ready', token: TOKEN })
  })

  it('looks on the port the token was paired on, else on the one Device Lab last used', async () => {
    helper = fakeHelper(8790)
    saveStoredPort(8790, stores)
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'unpaired', port: 8790 })
    hold(TOKEN, 8790)
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'ready', port: 8790 })
    // A token for another port than the one looked on is never tried there.
    stores = memoryStores()
    saveStoredPort(8790, stores)
    stores.local?.setItem(
      'dvc_token',
      JSON.stringify({ v: 1, token: TOKEN, port: 8788, tokenId: tokenIdOf(TOKEN) }),
    )
    expect(await probeHelper(undefined, deps())).toMatchObject({ port: 8788, state: 'missing' })
  })

  it('waits as long as the browser’s permission prompt may be up, and no longer otherwise', async () => {
    vi.useFakeTimers()
    let answer: (value: Response) => void = () => undefined
    // Never answers by itself; gives up when its signal does, as fetch does.
    const hanging = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          answer = resolve
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )
    const asking = probeHelper(
      undefined,
      deps({ fetch: hanging as unknown as typeof fetch, permissions: permission('prompt') }),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hanging.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    answer(new Response('', { status: 500 }))
    expect(await asking).toMatchObject({ reason: 'foreign' })

    const timed = probeHelper(undefined, deps({ fetch: hanging as unknown as typeof fetch }))
    await vi.advanceTimersByTimeAsync(3_100)
    expect(await timed).toMatchObject({ state: 'missing', reason: 'absent' })
  })

  it('rejects only when it is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(probeHelper(controller.signal, deps())).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('pairHelper', () => {
  const link = (token: string, port?: number) =>
    `https://bauloc.github.io/device/#pair=${token}${port ? `&port=${String(port)}` : ''}`

  it('pairs from the link the helper printed, in Device Lab’s store, after the proof', async () => {
    expect(await pairHelper(`  ${link(TOKEN)}  `, deps())).toEqual({
      ok: true,
      helper: { state: 'ready', version: '1.4.0', port: 8787, token: TOKEN },
    })
    expect(readTokenEntries(stores).session).toEqual({
      v: 1,
      token: TOKEN,
      port: 8787,
      tokenId: tokenIdOf(TOKEN),
    })
    // This tab only: remembering on this computer is the owner's choice, made in Device Lab.
    expect(readTokenEntries(stores).local).toBeNull()
    expect(helper.seen.every((s) => s.authorization === null)).toBe(true)
    // And the console finds it ready from then on.
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'ready' })
  })

  it('takes the token alone, for the port it looks on', async () => {
    expect(await pairHelper(TOKEN, deps())).toMatchObject({ ok: true, helper: { port: 8787 } })
  })

  it('checks a link’s own port, and remembers it as Device Lab does', async () => {
    helper = fakeHelper(8788)
    expect(await pairHelper(link(TOKEN, 8788), deps())).toMatchObject({
      ok: true,
      helper: { port: 8788 },
    })
    expect(readStoredPort(stores)).toBe(8788)
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'ready', port: 8788 })
  })

  it('keeps nothing it could not prove, and says why', async () => {
    expect(await pairHelper('not a link', deps())).toEqual({
      ok: false,
      reason: 'format',
      port: 8787,
    })
    expect(await pairHelper(link(OTHER), deps())).toEqual({
      ok: false,
      reason: 'stale',
      port: 8787,
      tokenId: tokenIdOf(TOKEN),
    })
    helper.state.proofPort = 9999
    expect(await pairHelper(link(TOKEN), deps())).toEqual({
      ok: false,
      reason: 'foreign',
      port: 8787,
    })
    helper.state.proofPort = 8787
    helper.state.features = []
    expect(await pairHelper(link(TOKEN), deps())).toMatchObject({ ok: false, reason: 'outdated' })
    helper.state.up = false
    expect(await pairHelper(link(TOKEN, 8790), deps())).toEqual({
      ok: false,
      reason: 'unreachable',
      port: 8790,
    })
    expect(readTokenEntries(stores)).toEqual({ session: null, local: null })
  })
})

/* ---------------------------------------------------------------- *
 * The upload
 * ---------------------------------------------------------------- */

/** A stand-in XMLHttpRequest: records the request; the test answers it. */
class FakeXhr {
  static made: FakeXhr[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  responseText = ''
  aborted = false
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXhr.made.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent)
  }
  answer(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }
}

describe('uploadViaHelper', () => {
  const FILE = new Blob([new Uint8Array(4096)])
  const ASSET = {
    id: 9081726,
    name: 'big-1.0-1.apk',
    size: 4096,
    url: 'https://github.com/bauloc/bauloc.github.io/releases/download/build-big-20261007011500/big-1.0-1.apk',
  }
  const upload = (more: Partial<HelperUpload> = {}): HelperUpload => ({
    port: 8787,
    token: TOKEN,
    pat: PAT,
    releaseId: 182736455,
    name: 'big-1.0-1.apk',
    file: FILE,
    contentType: releaseContentType('android'),
    ...more,
  })
  /** Starts an upload; the XHR it made is ready to be answered. */
  const start = (more: Partial<HelperUpload> = {}) => {
    const done = uploadViaHelper(upload(more)).then(
      (asset) => ({ asset, error: null }),
      (error: unknown) => ({ asset: null, error }),
    )
    const xhr = FakeXhr.made.at(-1)
    if (!xhr) throw new Error('no request')
    return { done, xhr }
  }

  beforeEach(() => {
    FakeXhr.made = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  it('posts the file to the helper’s release route with the headers it asks for', async () => {
    const progress: number[] = []
    const { done, xhr } = start({ onProgress: (f) => progress.push(f) })
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(
      'http://127.0.0.1:8787/api/github/release-asset?release=182736455&name=big-1.0-1.apk',
    )
    expect(xhr.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Token': PAT,
      'Content-Type': 'application/vnd.android.package-archive',
    })
    // The browser sets Content-Length from the file itself, never chunked.
    expect(xhr.body).toBe(FILE)
    xhr.progress(1024, 4096)
    xhr.progress(4096, 4096)
    xhr.answer(201, ASSET)
    expect(await done).toEqual({ asset: ASSET, error: null })
    expect(progress).toEqual([0.25, 1])
    expect(releaseContentType('ios')).toBe('application/octet-stream')
  })

  it('cancels: the request is aborted and the upload rejects as an AbortError', async () => {
    const controller = new AbortController()
    const { done, xhr } = start({ signal: controller.signal })
    controller.abort()
    expect(xhr.aborted).toBe(true)
    expect((await done).error).toMatchObject({ name: 'AbortError' })
  })

  it('says the helper stopped when the request got no answer at all', async () => {
    const { done, xhr } = start()
    xhr.onerror?.()
    const { error } = await done
    expect(error).toBeInstanceOf(HelperUploadError)
    expect(error).toMatchObject({ code: 'HELPER_UNREACHABLE' })
  })

  it('hands GitHub’s refusal of the owner’s token to the console as an AuthError', async () => {
    const { done, xhr } = start()
    xhr.answer(502, { error: { code: 'GITHUB_UNAUTHORIZED', message: 'Bad credentials' } })
    expect((await done).error).toBeInstanceOf(AuthError)
  })

  it('words every refusal by its code, the helper’s envelope or not', async () => {
    const cases: [number, unknown, string, RegExp][] = [
      [
        401,
        { error: { code: 'UNAUTHORIZED', message: 'm', tokenId: 'abcd1234' } },
        'HELPER_UNAUTHORIZED',
        /Pair it again/,
      ],
      [409, { error: { code: 'UPLOAD_BUSY', message: 'm' } }, 'UPLOAD_BUSY', /already uploading/],
      [400, { error: { code: 'BAD_REQUEST', message: 'm' } }, 'BAD_REQUEST', /malformed/],
      [413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'm' } }, 'PAYLOAD_TOO_LARGE', /2 GB/],
      [411, { error: { code: 'LENGTH_REQUIRED', message: 'm' } }, 'BAD_REQUEST', /malformed/],
      // Ctrl+C in the helper's window while the file was going up.
      [
        503,
        { error: { code: 'HELPER_STOPPING', message: 'The helper is stopping.' } },
        'HELPER_UNREACHABLE',
        /stopped answering/,
      ],
      [
        502,
        { error: { code: 'GITHUB_ASSET_EXISTS', message: 'already_exists' } },
        'GITHUB_ASSET_EXISTS',
        /same name|of that name/,
      ],
      [502, { code: 'GITHUB_UNREACHABLE' }, 'GITHUB_UNREACHABLE', /could not reach GitHub/],
      [404, { error: { code: 'NOT_FOUND', message: 'm' } }, 'HELPER_OUTDATED', /Update it first/],
      [500, '<html>', 'HELPER_BAD_REPLY', /can’t read/],
    ]
    for (const [status, body, code, words] of cases) {
      const { done, xhr } = start()
      xhr.answer(status, body)
      const { error } = await done
      expect(error, code).toBeInstanceOf(HelperUploadError)
      expect(error, code).toMatchObject({ code, status })
      expect((error as Error).message, code).toMatch(words)
    }
  })

  it('passes GitHub’s own status and words on when it refused the file', async () => {
    const { done, xhr } = start()
    xhr.answer(502, {
      error: { code: 'GITHUB_UPLOAD_FAILED', status: 422, message: 'name already exists' },
    })
    const { error } = await done
    expect(error).toMatchObject({ code: 'GITHUB_UPLOAD_FAILED', status: 422 })
    expect((error as Error).message).toBe(
      'GitHub refused the file: name already exists (HTTP 422).',
    )
  })

  it('words a refusal in the console’s language', async () => {
    vi.mocked(currentLocale).mockReturnValue('vi')
    const { done, xhr } = start()
    xhr.answer(409, { error: { code: 'UPLOAD_BUSY', message: 'm' } })
    expect(((await done).error as Error).message).toBe(
      'Helper đang tải lên một tệp khác. Hãy chờ tệp đó xong.',
    )
  })

  it('takes no answer it cannot check: another address, another name, a file cut short', async () => {
    for (const odd of [
      { ...ASSET, url: 'https://evil.example/releases/download/x/big-1.0-1.apk' },
      { ...ASSET, url: ASSET.url.replace('big-1.0-1.apk', 'other.apk') },
      { ...ASSET, name: 'big-1.0-1.apk.1' },
      { ...ASSET, size: 4095 },
      { ...ASSET, id: '9081726' },
      null,
    ]) {
      const { done, xhr } = start()
      xhr.answer(201, odd)
      expect((await done).error, JSON.stringify(odd)).toMatchObject({ code: 'HELPER_BAD_REPLY' })
    }
  })

  it('sends nothing that could break the request, nor a file GitHub would refuse', async () => {
    for (const bad of [
      { port: 80 },
      { token: 'short' },
      { pat: 'ghp_x\r\nX-Evil: 1' },
      { pat: 'short' },
      { releaseId: 0 },
      { releaseId: 1.5 },
      { releaseId: 1_000_000_000_000_000 },
      { name: '../big.apk' },
      { name: 'big.exe' },
      { file: new Blob([]) },
    ] satisfies Partial<HelperUpload>[]) {
      await expect(uploadViaHelper(upload(bad)), JSON.stringify(bad)).rejects.toThrow(/refusing/)
    }
    const huge = new Blob([])
    Object.defineProperty(huge, 'size', { value: 2 * 1024 ** 3 })
    await expect(uploadViaHelper(upload({ file: huge }))).rejects.toThrow(/refusing/)
    expect(FakeXhr.made).toEqual([])
  })
})
