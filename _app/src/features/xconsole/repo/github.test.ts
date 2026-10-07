import { describe, expect, it, vi } from 'vitest'

import {
  AuthError,
  GitHubError,
  decodeBase64Utf8,
  gitHubRepo,
  hasReleases,
  isPlainTag,
  type Repo,
  type SendRequest,
  type SendResponse,
} from './github'

/** base64 of UTF-8 text, wrapped at 60 columns the way the Contents API wraps it. */
function contentsBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/(.{60})/g, '$1\n')
}

describe('decodeBase64Utf8', () => {
  it('decodes wrapped base64 as UTF-8, not Latin-1', () => {
    expect(decodeBase64Utf8(contentsBase64('Cải Lương — 2026'))).toBe('Cải Lương — 2026')
  })
})

describe('gitHubRepo.read', () => {
  it('reads a file from master with the token and without the HTTP cache', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"ok":true}')))
    await expect(gitHubRepo('tkn', fetchImpl).read('data/x.json')).resolves.toBe('{"ok":true}')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'https://api.github.com/repos/bauloc/bauloc.github.io/contents/data/x.json?ref=master',
    )
    expect(init?.cache).toBe('no-store')
    const sent = init?.headers as Record<string, string>
    expect(sent.Authorization).toBe('token tkn')
    // Raw, not the JSON envelope: the envelope stops at 1 MB, and an artifact can be larger.
    expect(sent.Accept).toBe('application/vnd.github.raw+json')
  })

  it('reads UTF-8 text as UTF-8', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new TextEncoder().encode('Cải Lương — 2026'))),
    )
    await expect(gitHubRepo('t', fetchImpl).read('a.html')).resolves.toBe('Cải Lương — 2026')
  })

  it('answers null for a missing file, so the caller decides what missing means', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 404 })))
    await expect(gitHubRepo('t', fetchImpl).read('nope.json')).resolves.toBeNull()
  })

  it('turns a refused token into an AuthError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 401 })))
    await expect(gitHubRepo('bad', fetchImpl).read('x')).rejects.toBeInstanceOf(AuthError)
  })

  it('reads at a given commit, with every path segment encoded', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('x')))
    await gitHubRepo('t', fetchImpl).read('data/a b/ả.json', 'abc123')
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/bauloc/bauloc.github.io/contents/data/a%20b/%E1%BA%A3.json?ref=abc123',
    )
  })
})

describe('gitHubRepo.head', () => {
  it("is the published branch's current commit", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ object: { sha: 'head9' } })),
    )
    await expect(gitHubRepo('t', fetchImpl).head()).resolves.toBe('head9')
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/bauloc/bauloc.github.io/git/ref/heads/master',
    )
  })
})

describe('gitHubRepo.commit', () => {
  /** A scripted GitHub: answers each call in order and records what was sent. */
  function scripted(responses: Response[]) {
    const calls: { url: string; method: string; body: unknown }[] = []
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return Promise.resolve(responses.shift() ?? new Response('', { status: 500 }))
    })
    return { calls, fetchImpl }
  }

  const happyPath = () => [
    Response.json({ tree: { sha: 'tree0' } }),
    Response.json({ sha: 'tree1' }),
    Response.json({ sha: 'commit1' }),
    Response.json({}),
  ]

  it('writes and deletes in one commit, built on the commit the change was computed from', async () => {
    const { calls, fetchImpl } = scripted(happyPath())
    await gitHubRepo('t', fetchImpl).commit({
      writes: [{ path: 'terms/a/index.html', content: '<p>é</p>' }],
      deletes: ['data/term-privacy/pages/old.json'],
      message: 'Add term & privacy: a',
      parent: 'read-at',
    })

    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*bauloc\.github\.io/, '')}`)).toEqual([
      'GET /git/commits/read-at',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/master',
    ])
    expect(calls[1]!.body).toEqual({
      base_tree: 'tree0',
      tree: [
        { path: 'terms/a/index.html', mode: '100644', type: 'blob', content: '<p>é</p>' },
        { path: 'data/term-privacy/pages/old.json', mode: '100644', type: 'blob', sha: null },
      ],
    })
    expect(calls[2]!.body).toEqual({
      message: 'Add term & privacy: a',
      tree: 'tree1',
      parents: ['read-at'],
    })
    // Never forced: a branch that moved past `parent` must be refused.
    expect(calls[3]!.body).toEqual({ sha: 'commit1' })
  })

  it('refuses to report success when the branch moved underneath it', async () => {
    const responses = happyPath()
    responses[3] = Response.json({ message: 'Update is not a fast forward' }, { status: 422 })
    const { fetchImpl } = scripted(responses)
    const commit = gitHubRepo('t', fetchImpl).commit({ message: 'm', parent: 'old' })
    await expect(commit).rejects.toThrow(GitHubError)
    await expect(commit).rejects.toThrow(/nothing was saved\. Try again\./)
  })

  it('passes on any other refusal in GitHub’s words, since a retry would not help', async () => {
    const responses = happyPath()
    responses[3] = Response.json({ message: 'Protected branch update failed' }, { status: 422 })
    const { fetchImpl } = scripted(responses)
    await expect(
      gitHubRepo('t', fetchImpl).commit({ message: 'm', parent: 'old' }),
    ).rejects.toThrow('GitHub refused to update the branch: Protected branch update failed')
  })

  it('fails loudly on an unexpected response shape', async () => {
    const { fetchImpl } = scripted([Response.json({ object: {} }), Response.json({ tree: {} })])
    const repo = gitHubRepo('t', fetchImpl)
    await expect(repo.head()).rejects.toThrow(/branch head/)
    await expect(repo.commit({ message: 'm', parent: 'p' })).rejects.toThrow(/base tree/)
  })
})

describe('gitHubRepo.list', () => {
  it('lists a directory, narrowed to names, paths, kinds and sizes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json([
          { name: 'a1b2c3d4', path: 'build/a1b2c3d4', type: 'dir', size: 0 },
          { name: 'x.html', path: 'artifact/x.html', type: 'file', size: 120 },
          { name: 'weird', path: 'build/weird', type: 'symlink' },
          'not an entry',
        ]),
      ),
    )
    await expect(gitHubRepo('t', fetchImpl).list('build', 'h1')).resolves.toEqual([
      { name: 'a1b2c3d4', path: 'build/a1b2c3d4', type: 'dir', size: 0 },
      { name: 'x.html', path: 'artifact/x.html', type: 'file', size: 120 },
      { name: 'weird', path: 'build/weird', type: 'file', size: 0 },
    ])
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/bauloc/bauloc.github.io/contents/build?ref=h1',
    )
  })

  it('answers null when there is no such directory, or when it is a file', async () => {
    const missing = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 404 })))
    await expect(gitHubRepo('t', missing).list('build')).resolves.toBeNull()
    const file = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ type: 'file' })))
    await expect(gitHubRepo('t', file).list('iptv')).resolves.toBeNull()
  })
})

describe('gitHubRepo.upload', () => {
  /** A Sender that records the request and answers as told. */
  function sender(answer: SendResponse) {
    const requests: SendRequest[] = []
    const send = vi.fn((request: SendRequest) => {
      requests.push(request)
      request.onProgress?.(0.5)
      request.onProgress?.(1)
      return Promise.resolve(answer)
    })
    return { requests, send }
  }

  it('posts the bytes as one base64 blob and resolves to its sha', async () => {
    const bytes = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 7) % 256)
    const { requests, send } = sender({ status: 201, body: JSON.stringify({ sha: 'blob1' }) })
    const progress: number[] = []
    const sha = await gitHubRepo('tkn', fetch, send).upload(new Blob([bytes]), {
      onProgress: (f) => progress.push(f),
    })
    expect(sha).toBe('blob1')
    expect(progress).toEqual([0.5, 1])

    const request = requests[0]!
    expect(request.url).toBe('https://api.github.com/repos/bauloc/bauloc.github.io/git/blobs')
    expect(request.headers.Authorization).toBe('token tkn')
    expect(request.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(await request.body.text()) as { encoding: string; content: string }
    expect(body.encoding).toBe('base64')
    expect(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))).toEqual(bytes)
  })

  it('joins pieces of a large file without padding in the middle', async () => {
    // Over one 3 MiB piece, and not a multiple of 3, so only the very end may pad.
    const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 5 }, (_, i) => i % 251)
    const { requests, send } = sender({ status: 201, body: '{"sha":"big"}' })
    await gitHubRepo('t', fetch, send).upload(new Blob([bytes]))
    const { content } = JSON.parse(await requests[0]!.body.text()) as { content: string }
    expect(content.indexOf('=')).toBeGreaterThan(content.length - 3)
    expect(atob(content).length).toBe(bytes.length)
  })

  it('turns a refused token into an AuthError, and any other refusal into GitHub’s words', async () => {
    const refused = sender({ status: 401, body: '' })
    await expect(
      gitHubRepo('bad', fetch, refused.send).upload(new Blob(['x'])),
    ).rejects.toBeInstanceOf(AuthError)
    const tooBig = sender({ status: 422, body: JSON.stringify({ message: 'too large' }) })
    await expect(gitHubRepo('t', fetch, tooBig.send).upload(new Blob(['x']))).rejects.toThrow(
      'Could not upload the file: too large (HTTP 422)',
    )
  })

  it('does not start when it was already cancelled', async () => {
    const { send } = sender({ status: 201, body: '{"sha":"x"}' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      gitHubRepo('t', fetch, send).upload(new Blob(['x']), { signal: controller.signal }),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('gitHubRepo.commit with uploaded files', () => {
  it('places blobs by sha, and sends a large text through the blob API first', async () => {
    const calls: { url: string; body: unknown }[] = []
    const responses = [
      Response.json({ tree: { sha: 'tree0' } }),
      Response.json({ sha: 'tree1' }),
      Response.json({ sha: 'commit1' }),
      Response.json({}),
    ]
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return Promise.resolve(responses.shift() ?? new Response('', { status: 500 }))
    })
    const send = vi.fn(() => Promise.resolve({ status: 201, body: '{"sha":"bigtext"}' }))
    const large = 'x'.repeat(600 * 1024)
    await gitHubRepo('t', fetchImpl, send).commit({
      writes: [
        { path: 'build/a/app.apk', sha: 'apk1' },
        { path: 'artifact/big.html', content: large },
        { path: 'data/build/db.json', content: '{}' },
      ],
      message: 'Add build: a',
      parent: 'p',
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(calls[1]!.body).toEqual({
      base_tree: 'tree0',
      tree: [
        { path: 'data/build/db.json', mode: '100644', type: 'blob', content: '{}' },
        { path: 'build/a/app.apk', mode: '100644', type: 'blob', sha: 'apk1' },
        { path: 'artifact/big.html', mode: '100644', type: 'blob', sha: 'bigtext' },
      ],
    })
  })
})

describe('gitHubRepo releases', () => {
  /** A scripted GitHub for one call: records it and answers as told. */
  function answering(response: Response) {
    const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
      []
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: init?.headers as Record<string, string>,
      })
      return Promise.resolve(response)
    })
    return { calls, fetchImpl }
  }

  const API = 'https://api.github.com/repos/bauloc/bauloc.github.io'

  it('creates a prerelease that is never Latest, tagged from master, and narrows its id', async () => {
    const { calls, fetchImpl } = answering(
      Response.json(
        { id: 182736455, upload_url: 'https://uploads.github.com/…{?name,label}' },
        { status: 201 },
      ),
    )
    await expect(
      gitHubRepo('tkn', fetchImpl).createRelease({
        tag: 'build-k3x9q2mf-20261007081530',
        name: 'My App 1.2.0 (45)',
        body: 'Install page: https://bauloc.github.io/build/k3x9q2mf/',
      }),
    ).resolves.toEqual({ id: 182736455 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/releases`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.Authorization).toBe('token tkn')
    expect(calls[0]!.headers['Content-Type']).toBe('application/json')
    expect(calls[0]!.body).toEqual({
      tag_name: 'build-k3x9q2mf-20261007081530',
      target_commitish: 'master',
      name: 'My App 1.2.0 (45)',
      body: 'Install page: https://bauloc.github.io/build/k3x9q2mf/',
      draft: false,
      prerelease: true,
      make_latest: 'false',
    })
  })

  it('says why a release could not be made, in GitHub’s words, and asks for a token on 401', async () => {
    const taken = answering(
      Response.json(
        {
          message: 'Validation Failed',
          errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }],
        },
        { status: 422 },
      ),
    )
    const input = { tag: 't', name: 'n', body: 'b' }
    await expect(gitHubRepo('t', taken.fetchImpl).createRelease(input)).rejects.toThrow(
      'Could not create the release: Validation Failed (already_exists) (HTTP 422)',
    )
    const refused = answering(new Response('', { status: 401 }))
    await expect(gitHubRepo('t', refused.fetchImpl).createRelease(input)).rejects.toBeInstanceOf(
      AuthError,
    )
    // A 201 without a usable id is not a release this console can clean up after.
    for (const body of [{}, { id: '5' }, { id: 0 }, { id: 1.5 }, null]) {
      const odd = answering(Response.json(body, { status: 201 }))
      await expect(gitHubRepo('t', odd.fetchImpl).createRelease(input)).rejects.toThrow(
        'Unexpected GitHub response: no release id',
      )
    }
  })

  it('deletes a release, and takes one already gone as deleted', async () => {
    const done = answering(new Response(null, { status: 204 }))
    await gitHubRepo('t', done.fetchImpl).deleteRelease(182736455)
    expect(done.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${API}/releases/182736455`,
    ])
    const gone = answering(new Response('', { status: 404 }))
    await expect(gitHubRepo('t', gone.fetchImpl).deleteRelease(1)).resolves.toBeUndefined()
    const broken = answering(new Response('', { status: 500 }))
    await expect(gitHubRepo('t', broken.fetchImpl).deleteRelease(1)).rejects.toThrow(GitHubError)
    const refused = answering(new Response('', { status: 401 }))
    await expect(gitHubRepo('t', refused.fetchImpl).deleteRelease(1)).rejects.toBeInstanceOf(
      AuthError,
    )
  })

  it('deletes a tag, and takes one already gone as deleted', async () => {
    const done = answering(new Response(null, { status: 204 }))
    await gitHubRepo('t', done.fetchImpl).deleteTag('build-k3x9q2mf-20261007081530')
    expect(done.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${API}/git/refs/tags/build-k3x9q2mf-20261007081530`,
    ])
    for (const status of [404, 422]) {
      const gone = answering(Response.json({ message: 'Reference does not exist' }, { status }))
      await expect(gitHubRepo('t', gone.fetchImpl).deleteTag('v1')).resolves.toBeUndefined()
    }
    const broken = answering(new Response('', { status: 503 }))
    await expect(gitHubRepo('t', broken.fetchImpl).deleteTag('v1')).rejects.toThrow(
      'Could not delete tag v1 (HTTP 503)',
    )
  })

  it('never sends a delete for an id or a tag that could name something else', async () => {
    const { fetchImpl } = answering(new Response(null, { status: 204 }))
    const repo = gitHubRepo('t', fetchImpl)
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      await expect(repo.deleteRelease(id)).rejects.toThrow(/Refusing/)
    }
    for (const tag of [
      '',
      '../heads/master',
      'heads/master',
      'a/b',
      '..',
      '.hidden',
      '-x',
      'a b',
    ]) {
      expect(isPlainTag(tag), tag).toBe(false)
      await expect(repo.deleteTag(tag)).rejects.toThrow(/Refusing/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is a repository with releases; a repository without them is told apart', () => {
    expect(hasReleases(gitHubRepo('t'))).toBe(true)
    const plain: Repo = {
      head: () => Promise.resolve('h'),
      read: () => Promise.resolve(null),
      list: () => Promise.resolve(null),
      upload: () => Promise.resolve('s'),
      commit: () => Promise.resolve(),
    }
    expect(hasReleases(plain)).toBe(false)
  })
})
