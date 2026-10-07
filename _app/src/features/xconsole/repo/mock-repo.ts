import {
  GitHubError,
  isBlobWrite,
  isGitHubId,
  xhrSend,
  type ReleaseAsset,
  type Releases,
  type Repo,
  type RepoEntry,
} from './github'

/*
  A stand-in for GitHub, for developing the console without a token and without committing
  anything: open /xconsole/?mock in `npm run dev`. It replaces the legacy console's dev.js.

  Reads, uploads and commits go to the dev server's mock store (dev/xconsole-mock-store.ts),
  which starts from the repo as it is on disk and keeps every change in the dev server's memory
  — never on disk, never on GitHub. The dev server also SERVES those changes at their real
  paths, so a build published here opens at /build/<id>/ and an artifact at /artifact/<id>.html
  on localhost, as they would on Pages. Restart `npm run dev` to start over.

  Releases too, for a build of 100 MiB or more: the store keeps them in memory, and takes the
  binary itself (uploadReleaseAsset) where, against GitHub, the Device Lab helper would upload
  it — the mock never uses the helper. The install page links the asset at its github.com
  address, which nothing serves for a mock release: the one link of a mock build that 404s.

  Dev only: the module is imported behind `import.meta.env.DEV`, so production builds drop it.
*/

const BASE = '/__xconsole-mock'

/**
 * github.ts's sentence for a commit that lost the race to another, word for word, so the mock
 * fails the way GitHub does and the console says the same thing (mock-repo.test.ts holds the
 * two together).
 */
const NOT_FAST_FORWARD =
  'Something else was published at the same moment, so nothing was saved. Try again.'

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The store's own error sentence, for a mock that fails the way GitHub would. */
async function failure(response: Response, what: string): Promise<GitHubError> {
  const body: unknown = await response.json().catch(() => null)
  const reason = isRecord(body) && typeof body.message === 'string' ? body.message : ''
  // The store refuses a commit built on an old head in GitHub's words, and gitHubRepo turns
  // those into its sentence: so does the mock.
  if (response.status === 422 && /fast.?forward/i.test(reason)) {
    return new GitHubError(NOT_FAST_FORWARD, 422)
  }
  return new GitHubError(
    `Mock could not ${what}${reason ? `: ${reason}` : ''} (HTTP ${String(response.status)})`,
    response.status,
  )
}

/** A JSON write to the store, as the console sends every one: refused by the store otherwise. */
const postJson = (action: string, body: object) =>
  fetch(`${BASE}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The asset the store answers with, narrowed as builds/helper.ts narrows the helper's. */
function assetOf(body: unknown): ReleaseAsset | null {
  if (!isRecord(body)) return null
  const { id, name, size, url } = body
  return isGitHubId(id) &&
    typeof name === 'string' &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    typeof url === 'string'
    ? { id, name, size, url }
    : null
}

export function mockRepo(): Repo & Releases {
  return {
    /*
      The store keeps a head that moves with every commit, and refuses a commit whose `parent` is
      not that head, as GitHub refuses a non-fast-forward: two tabs publishing at once fail here
      as they would on Pages. Reads ignore `ref`, since the store keeps no history, and see the
      newest state. That is safe for the read-modify-write rule: anything committed after
      head() was read has moved the head, so a commit computed from such a read is refused, not
      applied.
    */
    async head() {
      const response = await fetch(`${BASE}/head`, { cache: 'no-store' })
      if (!response.ok) throw await failure(response, 'read the branch')
      const body: unknown = await response.json()
      if (!isRecord(body) || typeof body.sha !== 'string') {
        throw new GitHubError('Mock could not read the branch: no head in the answer', 0)
      }
      return body.sha
    },

    async read(path) {
      await delay(200)
      const response = await fetch(`${BASE}/file?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
      })
      if (response.status === 404) return null
      if (!response.ok) throw await failure(response, `read ${path}`)
      return response.text()
    },

    async list(path) {
      const response = await fetch(`${BASE}/list?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
      })
      if (response.status === 404) return null
      if (!response.ok) throw await failure(response, `list ${path}`)
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return null
      return body.filter(isRecord).map((entry): RepoEntry => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        path: typeof entry.path === 'string' ? entry.path : '',
        type: entry.type === 'dir' ? 'dir' : 'file',
        size: typeof entry.size === 'number' ? entry.size : 0,
      }))
    },

    // The raw bytes, not base64: nothing here needs GitHub's envelope, and the progress bar
    // moves the same way.
    async upload(data, { onProgress, signal } = {}) {
      const response = await xhrSend({
        url: `${BASE}/blob`,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      })
      const body: unknown = JSON.parse(response.body)
      if (response.status !== 201 || !isRecord(body) || typeof body.sha !== 'string') {
        throw new GitHubError(`Mock could not upload (HTTP ${String(response.status)})`, 0)
      }
      return body.sha
    },

    async commit({ writes = [], deletes = [], message, parent }) {
      await delay(400)
      const response = await fetch(`${BASE}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          parent,
          writes: writes.map((w) =>
            isBlobWrite(w) ? { path: w.path, sha: w.sha } : { path: w.path, content: w.content },
          ),
          deletes,
        }),
      })
      if (!response.ok) throw await failure(response, 'commit')
      console.info(
        `[xconsole mock] commit "${message}"\n`,
        writes
          .map((w) =>
            isBlobWrite(w)
              ? `  write  ${w.path} (blob ${w.sha.slice(0, 7)})`
              : `  write  ${w.path} (${String(w.content.length)} chars)`,
          )
          .join('\n'),
        deletes.map((p) => `\n  delete ${p}`).join(''),
      )
    },

    async createRelease({ tag, name, body }) {
      const response = await postJson('release', { tag, name, body })
      if (response.status !== 201) throw await failure(response, 'create the release')
      const answer: unknown = await response.json()
      const id = isRecord(answer) ? answer.id : undefined
      if (!isGitHubId(id)) throw new GitHubError('Mock could not create the release: no id', 0)
      return { id }
    },

    // Gone already is fine, as against GitHub: 404 for a release, 422 for a tag.
    async deleteRelease(id) {
      const response = await postJson('release/delete', { id })
      if (!response.ok && response.status !== 404) {
        throw await failure(response, `delete release ${String(id)}`)
      }
    },

    async deleteTag(tag) {
      const response = await postJson('tag/delete', { tag })
      if (!response.ok && response.status !== 404 && response.status !== 422) {
        throw await failure(response, `delete tag ${tag}`)
      }
    },

    // What the helper does against GitHub, done by the store: the same address and answer.
    async uploadReleaseAsset(release, name, data, { onProgress, signal } = {}) {
      const query = `release=${String(release)}&name=${encodeURIComponent(name)}`
      const response = await xhrSend({
        url: `${BASE}/release/asset?${query}`,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      })
      let body: unknown = null
      try {
        body = JSON.parse(response.body)
      } catch {
        // Not JSON: the status says enough.
      }
      const asset = response.status === 201 ? assetOf(body) : null
      if (asset === null) {
        const reason = isRecord(body) && typeof body.message === 'string' ? body.message : ''
        throw new GitHubError(
          `Mock could not upload the release file${reason ? `: ${reason}` : ''} (HTTP ${String(response.status)})`,
          response.status,
        )
      }
      return asset
    },
  }
}
