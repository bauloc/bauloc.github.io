import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMockStore, isWritable } from './xconsole-mock-store'

describe('isWritable', () => {
  it('allows the paths the console publishes', () => {
    for (const rel of [
      'iptv',
      'data/build/db.json',
      'build/a1b2c3d4/index.html',
      'build/a1b2c3d4/my-app-1.0-1.apk',
      'artifact/x.html',
      'terms/app/index.html',
      'privacy/app/index.html',
    ]) {
      expect(isWritable(rel), rel).toBe(true)
    }
  })

  it('refuses everything else, and every way out', () => {
    for (const rel of [
      '',
      'index.html',
      '404.html',
      'assets/index.js',
      'device/agent/device-bridge.mjs',
      '_app/package.json',
      'build',
      '/build/x/index.html',
      'build/../_app/package.json',
      'build/./x',
      'build//x',
      'build\\..\\x',
      'build/x\0.html',
      'iptv/x',
      'builds/x',
    ]) {
      expect(isWritable(rel), rel).toBe(false)
    }
  })
})

/** The media type the console sends with each write. */
const AS_JSON = { 'Content-Type': 'application/json' }
const AS_BYTES = { 'Content-Type': 'application/octet-stream' }

/**
 * A store over a small repo of its own, served over HTTP the way the dev server serves it:
 * `origin` is the server's address, the rest the mock's requests as the console makes them.
 */
async function serveStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'xconsole-mock-'))
  mkdirSync(path.join(root, 'data', 'build'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'build', 'db.json'), '{"version":1,"entries":[]}')
  mkdirSync(path.join(root, 'build', 'old1'), { recursive: true })
  writeFileSync(path.join(root, 'build', 'old1', 'index.html'), '<p>old</p>')
  writeFileSync(path.join(root, 'secret.txt'), 'no')

  const store = createMockStore(root)
  const server = createServer((req, res) => {
    void store.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 418
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const api = `${origin}/__xconsole-mock`

  return {
    origin,
    api,
    file: (rel: string, init?: RequestInit) =>
      fetch(`${api}/file?path=${encodeURIComponent(rel)}`, init),
    list: async (rel: string) => {
      const response = await fetch(`${api}/list?path=${encodeURIComponent(rel)}`)
      return response.ok ? ((await response.json()) as { name: string; type: string }[]) : null
    },
    head: async () => ((await (await fetch(`${api}/head`)).json()) as { sha: string }).sha,
    commit: (plan: object, headers: Record<string, string> = AS_JSON) =>
      fetch(`${api}/commit`, { method: 'POST', headers, body: JSON.stringify(plan) }),
    upload: (body: BodyInit, headers: Record<string, string> = AS_BYTES) =>
      fetch(`${api}/blob`, { method: 'POST', headers, body }),
    /** A JSON write to one of the release routes, as mock-repo.ts sends it. */
    post: (action: string, body: object, headers: Record<string, string> = AS_JSON) =>
      fetch(`${api}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    asset: (release: string, name: string, body: BodyInit, headers = AS_BYTES) =>
      fetch(
        `${api}/release/asset?release=${encodeURIComponent(release)}&name=${encodeURIComponent(name)}`,
        { method: 'POST', headers, body },
      ),
    store,
    close: () => {
      server.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Served = Awaited<ReturnType<typeof serveStore>>

describe('the mock store over HTTP', () => {
  let store: Served
  beforeAll(async () => {
    store = await serveStore()
  })
  afterAll(() => {
    store.close()
  })

  it('reads the repo on disk, but only the console’s paths', async () => {
    expect(await (await store.file('data/build/db.json')).text()).toBe('{"version":1,"entries":[]}')
    expect((await store.file('secret.txt')).status).toBe(404)
    expect((await store.file('data/../secret.txt')).status).toBe(404)
    expect((await store.file('data/build/none.json')).status).toBe(404)
  })

  it('applies an upload and a commit, and serves the result', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255])
    const uploaded = await store.upload(bytes)
    expect(uploaded.status).toBe(201)
    const { sha } = (await uploaded.json()) as { sha: string }

    const committed = await store.commit({
      message: 'Add build: new1',
      writes: [
        { path: 'build/new1/app.apk', sha },
        { path: 'build/new1/index.html', content: '<h1>Cài đặt</h1>' },
      ],
      deletes: ['build/old1/index.html'],
      parent: await store.head(),
    })
    expect(committed.status).toBe(200)

    expect(new Uint8Array(await (await store.file('build/new1/app.apk')).arrayBuffer())).toEqual(
      bytes,
    )
    expect(await (await store.file('build/new1/index.html')).text()).toBe('<h1>Cài đặt</h1>')
    expect((await store.file('build/old1/index.html')).status).toBe(404)
    // old1 lost its only file, so it is gone from the listing, as on GitHub.
    expect((await store.list('build'))?.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:new1'])
    expect((await store.list('build/new1'))?.map((e) => e.name).sort()).toEqual([
      'app.apk',
      'index.html',
    ])
    expect(await store.list('artifact')).toBeNull()
  })

  it('refuses a commit that reaches outside the console’s paths, and applies none of it', async () => {
    const response = await store.commit({
      message: 'evil',
      writes: [
        { path: 'artifact/fine.html', content: 'x' },
        { path: '_app/vite.config.ts', content: 'x' },
      ],
      parent: await store.head(),
    })
    expect(response.status).toBe(400)
    expect((await store.file('artifact/fine.html')).status).toBe(404)
  })

  it('moves the head with each commit, and refuses one built on an old head as GitHub would', async () => {
    const first = await store.head()
    const one = { message: 'one', writes: [{ path: 'artifact/rv-one.html', content: '1' }] }
    expect((await store.commit({ ...one, parent: first })).status).toBe(200)
    const second = await store.head()
    expect(second).not.toBe(first)

    // A second tab, which read the head before the first one's commit landed.
    const two = { message: 'two', writes: [{ path: 'artifact/rv-two.html', content: '2' }] }
    const late = await store.commit({ ...two, parent: first })
    expect(late.status).toBe(422)
    expect(await late.json()).toEqual({ message: 'Update is not a fast forward' })
    // A commit that names no parent is not built on the head either.
    expect((await store.commit(two)).status).toBe(422)
    expect((await store.file('artifact/rv-two.html')).status).toBe(404)
    expect(await store.head()).toBe(second)

    // Read the head again, as a retry does, and the same change goes through.
    expect((await store.commit({ ...two, parent: second })).status).toBe(200)
    expect(await (await store.file('artifact/rv-two.html')).text()).toBe('2')
    expect(await (await store.file('artifact/rv-one.html')).text()).toBe('1')
  })

  it('starts each store on a head of its own, so one read before a restart matches nothing', async () => {
    const restarted = await serveStore()
    try {
      expect(await restarted.head()).not.toBe(await store.head())
    } finally {
      restarted.close()
    }
  })
})

describe('GitHub Releases in the mock store', () => {
  let store: Served
  beforeAll(async () => {
    store = await serveStore()
  })
  afterAll(() => {
    store.close()
  })

  const create = async (tag: string) => {
    const response = await store.post('release', { tag, name: 'My App 1.2.0 (45)', body: 'b' })
    return { status: response.status, body: (await response.json()) as { id: number } }
  }

  it('creates a release with its tag, refuses a tag in use, and deletes both apart', async () => {
    const made = await create('build-big1-20261007081530')
    expect(made.status).toBe(201)
    expect(store.store.releases.get(made.body.id)).toMatchObject({
      tag: 'build-big1-20261007081530',
      name: 'My App 1.2.0 (45)',
      assets: [],
    })
    // GitHub's answer for a tag that already exists.
    const again = await store.post('release', {
      tag: 'build-big1-20261007081530',
      name: '',
      body: '',
    })
    expect(again.status).toBe(422)
    expect(await again.json()).toMatchObject({ errors: [{ code: 'already_exists' }] })

    expect((await store.post('release/delete', { id: made.body.id })).status).toBe(200)
    expect(store.store.releases.has(made.body.id)).toBe(false)
    // As on GitHub, the tag outlives its release until it is deleted too.
    expect(store.store.tags.has('build-big1-20261007081530')).toBe(true)
    expect((await store.post('tag/delete', { tag: 'build-big1-20261007081530' })).status).toBe(200)
    expect(store.store.tags.has('build-big1-20261007081530')).toBe(false)

    // Already gone: 404 for the release and 422 for the tag, GitHub's answers.
    expect((await store.post('release/delete', { id: made.body.id })).status).toBe(404)
    expect((await store.post('tag/delete', { tag: 'build-big1-20261007081530' })).status).toBe(422)
  })

  it('takes an asset by counting it, keeps none of its bytes, and answers its github.com address', async () => {
    const { body } = await create('build-big2-20261007081530')
    const bytes = new Uint8Array(300_000).fill(7)
    const uploaded = await store.asset(String(body.id), 'big-app-1.0-1.apk', bytes, {
      'Content-Type': 'application/vnd.android.package-archive',
    })
    expect(uploaded.status).toBe(201)
    const asset = (await uploaded.json()) as { id: number; name: string; size: number; url: string }
    expect(asset).toEqual({
      id: expect.any(Number) as unknown,
      name: 'big-app-1.0-1.apk',
      size: 300_000,
      url: 'https://github.com/bauloc/bauloc.github.io/releases/download/build-big2-20261007081530/big-app-1.0-1.apk',
    })
    expect(store.store.releases.get(body.id)?.assets).toEqual([
      { id: asset.id, name: 'big-app-1.0-1.apk', size: 300_000 },
    ])
    // Nothing of it reached the files the dev server serves.
    expect([...store.store.overlay.keys()].some((k) => k.endsWith('.apk'))).toBe(false)

    // A second asset of the same name, as GitHub refuses it.
    expect((await store.asset(String(body.id), 'big-app-1.0-1.apk', bytes)).status).toBe(422)
  })

  it('refuses an asset for no release, under a name no build has, as anything but bytes, or empty', async () => {
    const { body } = await create('build-big3-20261007081530')
    const id = String(body.id)
    expect((await store.asset('999999999', 'a.apk', 'x')).status).toBe(404)
    expect((await store.asset('../1', 'a.apk', 'x')).status).toBe(404)
    for (const name of ['../a.apk', 'a.exe', '.a.apk', 'A.apk']) {
      expect((await store.asset(id, name, 'x')).status, name).toBe(400)
    }
    expect((await store.asset(id, 'a.apk', 'x', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await store.asset(id, 'a.apk', new Uint8Array(0))).status).toBe(400)
    expect(store.store.releases.get(body.id)?.assets).toEqual([])
  })

  it('refuses a release write from another page, or not as JSON', async () => {
    const evil = { Origin: 'https://evil.example', ...AS_JSON }
    expect((await store.post('release', { tag: 'x', name: '', body: '' }, evil)).status).toBe(403)
    expect(
      (
        await store.post(
          'release',
          { tag: 'x', name: '', body: '' },
          { 'Content-Type': 'text/plain' },
        )
      ).status,
    ).toBe(415)
    expect(
      (await store.post('release', { tag: '../heads/master', name: '', body: '' })).status,
    ).toBe(400)
    expect(store.store.tags.has('x')).toBe(false)
  })
})

describe('who may use the mock store', () => {
  let store: Served
  beforeAll(async () => {
    store = await serveStore()
  })
  afterAll(() => {
    store.close()
  })

  /** A write that would put a script on the console's origin: what another page is after. */
  const evil = async () => ({
    message: 'evil',
    writes: [{ path: 'artifact/rv-evil.html', content: '<script>steal()</script>' }],
    parent: await store.head(),
  })

  it('refuses a page of another site, whatever it sends, before reading it', async () => {
    const plan = await evil()
    const attempts: Record<string, string>[] = [
      // A form post or a no-cors fetch: a simple request, which the browser sends unasked.
      {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'text/plain',
      },
      // The console's own media type does not help, whichever header gives the page away.
      { Origin: 'https://evil.example', ...AS_JSON },
      { 'Sec-Fetch-Site': 'cross-site', ...AS_JSON },
      // Another page on this machine, which Vite's default CORS lets through a preflight.
      { Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'same-site', ...AS_JSON },
      // A sandboxed frame, such as an artifact's own page, has an opaque origin.
      { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', ...AS_JSON },
    ]
    for (const headers of attempts) {
      const response = await store.commit(plan, headers)
      expect(response.status, JSON.stringify(headers)).toBe(403)
    }
    const upload = await store.upload('<script>steal()</script>', {
      Origin: 'https://evil.example',
      ...AS_BYTES,
    })
    expect(upload.status).toBe(403)
    expect((await store.file('artifact/rv-evil.html')).status).toBe(404)

    // Reads too: nothing in the store is for another page.
    const crossSite = { headers: { 'Sec-Fetch-Site': 'cross-site' } }
    expect((await store.file('data/build/db.json', crossSite)).status).toBe(403)
    expect((await fetch(`${store.api}/head`, crossSite)).status).toBe(403)
    expect(
      (await store.file('data/build/db.json', { headers: { Origin: 'https://evil.example' } }))
        .status,
    ).toBe(403)
  })

  it('takes what the console sends from its own page', async () => {
    const own = { Origin: store.origin, 'Sec-Fetch-Site': 'same-origin' }
    const read = await store.file('data/build/db.json', { headers: own })
    expect(read.status).toBe(200)
    // An address typed in the bar.
    const typed = await store.file('data/build/db.json', { headers: { 'Sec-Fetch-Site': 'none' } })
    expect(typed.status).toBe(200)

    const uploaded = await store.upload(new Uint8Array([1, 2, 3]), { ...own, ...AS_BYTES })
    expect(uploaded.status).toBe(201)
    const committed = await store.commit(
      {
        message: 'own',
        writes: [{ path: 'artifact/rv-own.html', content: 'mine' }],
        parent: await store.head(),
      },
      { ...own, 'Content-Type': 'application/json; charset=utf-8' },
    )
    expect(committed.status).toBe(200)
    expect(await (await store.file('artifact/rv-own.html')).text()).toBe('mine')
  })

  it('takes a commit only as JSON and an upload only as bytes', async () => {
    const plan = await evil()
    for (const type of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      // What a browser reads as text/plain, so it asks no one before sending it.
      'text/plain; application/json',
      'application/json, text/plain',
    ]) {
      expect((await store.commit(plan, { 'Content-Type': type })).status, type).toBe(415)
    }
    // What a form sends: a URL-encoded or multipart body, the plan inside a field.
    const form = new FormData()
    form.set('plan', JSON.stringify(plan))
    for (const body of [new URLSearchParams({ [JSON.stringify(plan)]: '' }), form]) {
      const response = await fetch(`${store.api}/commit`, { method: 'POST', body })
      expect(response.status).toBe(415)
    }
    // And a body that says nothing of what it is.
    const untyped = await fetch(`${store.api}/commit`, {
      method: 'POST',
      body: new TextEncoder().encode(JSON.stringify(plan)),
    })
    expect(untyped.status).toBe(415)
    expect((await store.file('artifact/rv-evil.html')).status).toBe(404)

    expect((await store.upload('x', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await store.upload(new Uint8Array([1]), {})).status).toBe(415)
  })
})
