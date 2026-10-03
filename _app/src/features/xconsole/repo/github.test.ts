import { describe, expect, it, vi } from 'vitest'

import { AuthError, GitHubError, decodeBase64Utf8, gitHubRepo } from './github'

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
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ content: contentsBase64('{"ok":true}') })),
    )
    await expect(gitHubRepo('tkn', fetchImpl).read('data/x.json')).resolves.toBe('{"ok":true}')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'https://api.github.com/repos/bauloc/bauloc.github.io/contents/data/x.json?ref=master',
    )
    expect(init?.cache).toBe('no-store')
    expect((init?.headers as Record<string, string>).Authorization).toBe('token tkn')
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
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ content: contentsBase64('x') })),
    )
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
