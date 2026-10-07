import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createMockStore, type MockStore } from '../../../../dev/xconsole-mock-store'
import { GitHubError, gitHubRepo } from './github'
import { mockRepo } from './mock-repo'

/*
  The mock repo against the real mock store, over HTTP, as the dev server wires the two: what
  the console sees in ?mock when two tabs publish at the same moment.
*/

let root: string
let server: Server
let store: MockStore

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'xconsole-mock-repo-'))
  store = createMockStore(root)
  server = createServer((req, res) => {
    void store.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  // The console's requests are relative to its page; here, the page is on the test's server.
  const send = globalThis.fetch
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => send(new URL(input, origin), init))
  // Uploads go by XMLHttpRequest, for its progress events; Node has none, so this one sends
  // with fetch and reports the whole body sent once the answer is in.
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      status = 0
      responseText = ''
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      private request = { method: 'GET', url: '', headers: {} as Record<string, string> }
      open(method: string, url: string) {
        this.request = { ...this.request, method, url }
      }
      setRequestHeader(name: string, value: string) {
        this.request.headers[name] = value
      }
      abort() {
        this.onabort?.()
      }
      send(body: Blob) {
        void send(new URL(this.request.url, origin), {
          method: this.request.method,
          headers: this.request.headers,
          body,
        }).then(async (response) => {
          this.upload.onprogress?.({
            lengthComputable: true,
            loaded: body.size,
            total: body.size,
          } as ProgressEvent)
          this.status = response.status
          this.responseText = await response.text()
          this.onload?.()
        })
      }
    },
  )
})

afterAll(() => {
  vi.unstubAllGlobals()
  server.close()
  rmSync(root, { recursive: true, force: true })
})

/** What gitHubRepo throws when GitHub refuses to move the branch: not a fast-forward. */
async function gitHubsRefusal(): Promise<unknown> {
  const answers = [
    Response.json({ tree: { sha: 'tree0' } }),
    Response.json({ sha: 'tree1' }),
    Response.json({ sha: 'commit1' }),
    Response.json({ message: 'Update is not a fast forward' }, { status: 422 }),
  ]
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(answers.shift() ?? new Response('', { status: 500 })),
  )
  return gitHubRepo('t', fetchImpl)
    .commit({ message: 'm', parent: 'old' })
    .then(
      () => null,
      (error: unknown) => error,
    )
}

describe('mockRepo', () => {
  it('commits on the head it read, and refuses a commit built on an old one as GitHub does', async () => {
    const repo = mockRepo()
    const first = await repo.head()
    await repo.commit({
      message: 'Add artifact: rv-one',
      writes: [{ path: 'artifact/rv-one.html', content: '1' }],
      parent: first,
    })
    const second = await repo.head()
    expect(second).not.toBe(first)

    // A second tab, which read the head before the first one committed.
    const two = {
      message: 'Add artifact: rv-two',
      writes: [{ path: 'artifact/rv-two.html', content: '2' }],
    }
    const late: unknown = await repo.commit({ ...two, parent: first }).then(
      () => null,
      (error: unknown) => error,
    )
    const github = await gitHubsRefusal()
    expect(github).toBeInstanceOf(GitHubError)
    expect(late).toBeInstanceOf(GitHubError)
    // The same sentence, so the console's toast reads the same in ?mock as against GitHub.
    expect(late).toHaveProperty('message', (github as GitHubError).message)
    expect(late).toHaveProperty('status', 422)
    expect(await repo.read('artifact/rv-two.html')).toBeNull()
    expect(await repo.list('artifact')).toEqual([
      { name: 'rv-one.html', path: 'artifact/rv-one.html', type: 'file', size: 1 },
    ])

    // A retry reads the head again, and goes through.
    await repo.commit({ ...two, parent: await repo.head() })
    expect(await repo.read('artifact/rv-two.html')).toBe('2')
  })

  it('says what the store said for any other failure', async () => {
    const repo = mockRepo()
    const refused: unknown = await repo
      .commit({
        message: 'evil',
        writes: [{ path: '_app/vite.config.ts', content: 'x' }],
        parent: await repo.head(),
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refused).toBeInstanceOf(GitHubError)
    expect(refused).toHaveProperty(
      'message',
      'Mock could not commit: may not write _app/vite.config.ts (HTTP 400)',
    )
  })

  it('creates a release, stores its file as the helper would, and deletes both, as GitHub does', async () => {
    const repo = mockRepo()
    const { id } = await repo.createRelease({
      tag: 'build-rv-big-20261007081530',
      name: 'Big 1.0 (1)',
      body: 'Install page: https://bauloc.github.io/build/rv-big/',
    })
    expect(store.releases.get(id)).toMatchObject({ tag: 'build-rv-big-20261007081530' })

    const progress: number[] = []
    const asset = await repo.uploadReleaseAsset?.(
      id,
      'big-1.0-1.ipa',
      new Blob(['x'.repeat(4096)]),
      {
        onProgress: (fraction) => progress.push(fraction),
      },
    )
    expect(asset).toEqual({
      id: expect.any(Number) as unknown,
      name: 'big-1.0-1.ipa',
      size: 4096,
      url: 'https://github.com/bauloc/bauloc.github.io/releases/download/build-rv-big-20261007081530/big-1.0-1.ipa',
    })
    expect(progress).toEqual([1])

    // A second release on the same tag fails the way GitHub's does.
    const taken: unknown = await repo
      .createRelease({ tag: 'build-rv-big-20261007081530', name: '', body: '' })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(taken).toBeInstanceOf(GitHubError)
    expect(taken).toHaveProperty('status', 422)

    await repo.deleteRelease(id)
    await repo.deleteTag('build-rv-big-20261007081530')
    expect(store.releases.has(id)).toBe(false)
    expect(store.tags.has('build-rv-big-20261007081530')).toBe(false)
    // Deleting what is already gone is what a clean-up after a failure may do: it succeeds.
    await repo.deleteRelease(id)
    await repo.deleteTag('build-rv-big-20261007081530')
  })

  it('says what the store said when a release file is refused', async () => {
    const repo = mockRepo()
    const refused: unknown = await repo
      .uploadReleaseAsset?.(999_999_999, 'a.apk', new Blob(['x']))
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refused).toBeInstanceOf(GitHubError)
    expect(refused).toHaveProperty(
      'message',
      'Mock could not upload the release file: Not Found (HTTP 404)',
    )
  })
})
