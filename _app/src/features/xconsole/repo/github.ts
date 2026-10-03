/*
  The console's whole backend: this repository, read and written through the GitHub REST API
  with the visitor's Personal Access Token. GitHub Pages serves the `master` branch, so a
  commit here is a deploy — a published page is live about a minute later, with no build in
  the loop.

  Every response is narrowed from `unknown`: the lint rules forbid trusting the API's shape,
  and a renamed field should fail loudly here rather than as `undefined` in a legal page.
*/

export const REPO = 'bauloc/bauloc.github.io'
export const BRANCH = 'master'
const API = `https://api.github.com/repos/${REPO}`

/** The token was refused. The UI answers this by asking for a new one. */
export class AuthError extends Error {
  constructor() {
    super('GitHub refused the token. Update it in Settings.')
    this.name = 'AuthError'
  }
}

export class GitHubError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

export interface RepoFile {
  readonly path: string
  readonly content: string
}

export interface CommitPlan {
  readonly writes?: readonly RepoFile[]
  readonly deletes?: readonly string[]
  readonly message: string
  /**
   * The commit the change was computed from (see Repo.head). The new commit is built on it,
   * so if the branch has moved since, the update is refused instead of silently overwriting
   * whatever landed in between. Required so that no caller can forget it: a change that reads
   * nothing first passes `await repo.head()`.
   */
  readonly parent: string
}

/**
 * What the console needs from a repository. A mock implements it too (mock-repo.ts).
 *
 * A read-modify-write goes: `const head = await repo.head()`, read at `head`, compute, then
 * `commit({ ..., parent: head })`. Reading at the branch NAME instead would let a push that
 * lands between the read and the commit be undone without an error.
 */
export interface Repo {
  /** The published branch's current commit. */
  head(): Promise<string>
  /** A file's text at `ref` (default: the published branch), or null when it does not exist. */
  read(path: string, ref?: string): Promise<string | null>
  /** All writes and deletes as ONE commit, so a page and its index can never disagree. */
  commit(plan: CommitPlan): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `obj.a.b…` as a string, or a GitHubError naming what was missing. */
function stringAt(value: unknown, keys: readonly string[], what: string): string {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) break
    current = current[key]
  }
  if (typeof current !== 'string') {
    throw new GitHubError(`Unexpected GitHub response: no ${what}`, 0)
  }
  return current
}

/** The Contents API returns base64 with line breaks; the bytes inside are UTF-8. */
export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function gitHubRepo(token: string, fetchImpl: typeof fetch = fetch): Repo {
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
  }

  /**
   * One API call. `no-store` because the API marks responses cacheable for 60 s, and a list
   * re-read just after publishing must not come back from the cache without the new page.
   */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (response.status === 401) throw new AuthError()
    return response
  }

  async function json(path: string, init: RequestInit, what: string): Promise<unknown> {
    const response = await call(path, init)
    if (!response.ok)
      throw new GitHubError(`Could not ${what} (HTTP ${String(response.status)})`, response.status)
    return response.json()
  }

  async function head(): Promise<string> {
    return stringAt(
      await json(`/git/ref/heads/${BRANCH}`, {}, 'read the branch'),
      ['object', 'sha'],
      'branch head',
    )
  }

  /** Each path segment encoded, so a space or a non-ASCII name cannot change the request. */
  const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

  return {
    head,

    async read(path, ref = BRANCH) {
      const response = await call(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`)
      if (response.status === 404) return null
      if (!response.ok) {
        throw new GitHubError(
          `Could not read ${path} (HTTP ${String(response.status)})`,
          response.status,
        )
      }
      return decodeBase64Utf8(stringAt(await response.json(), ['content'], 'file content'))
    },

    /*
      The Git Data API, not the Contents API: Contents writes one file per commit, and a
      second write in a row races the first and fails with 409. Here the tree is built on top
      of `parent` and the ref is moved once, without force — so if the branch moved since
      `parent` was read, GitHub refuses the update as a non-fast-forward instead of the change
      silently undoing someone else's commit.
    */
    async commit({ writes = [], deletes = [], message, parent }) {
      const baseTree = stringAt(
        await json(`/git/commits/${parent}`, {}, 'read the base commit'),
        ['tree', 'sha'],
        'base tree',
      )
      const tree = [
        ...writes.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
        // A null sha deletes the path.
        ...deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
      ]
      const newTree = stringAt(
        await json(
          '/git/trees',
          { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
          'create the tree',
        ),
        ['sha'],
        'tree sha',
      )
      const commit = stringAt(
        await json(
          '/git/commits',
          { method: 'POST', body: JSON.stringify({ message, tree: newTree, parents: [parent] }) },
          'create the commit',
        ),
        ['sha'],
        'commit sha',
      )
      const moved = await call(`/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit }),
      })
      if (moved.status === 422) {
        const body: unknown = await moved.json().catch(() => null)
        const reason = isRecord(body) && typeof body.message === 'string' ? body.message : ''
        // "Update is not a fast forward": the branch moved since `parent`. Each action re-reads
        // at the new head when it runs again, so a retry is all it takes.
        if (/fast.?forward/i.test(reason)) {
          throw new GitHubError(
            'Something else was published at the same moment, so nothing was saved. Try again.',
            422,
          )
        }
        // Anything else (a branch rule, say) would refuse a retry too: say what GitHub said.
        throw new GitHubError(
          `GitHub refused to update the branch: ${reason || 'no reason given'} (HTTP 422)`,
          422,
        )
      }
      if (!moved.ok) {
        throw new GitHubError(
          `Could not update the branch (HTTP ${String(moved.status)})`,
          moved.status,
        )
      }
    },
  }
}
