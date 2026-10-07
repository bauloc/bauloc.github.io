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

/**
 * An upload that never got an answer: the connection dropped, or the browser gave up. The most
 * likely failure of a 100 MB build on a phone hotspot, so toastFailure words it in the console's
 * language rather than showing this English sentence.
 */
export class NetworkError extends GitHubError {
  constructor() {
    super('The upload was interrupted. Check the connection and try again.', 0)
    this.name = 'NetworkError'
  }
}

/** A text file, committed with its content. */
export interface RepoFile {
  readonly path: string
  readonly content: string
}

/** A file whose bytes are already on GitHub as a blob (Repo.upload): the commit only places it. */
export interface RepoBlobFile {
  readonly path: string
  readonly sha: string
}

export type RepoWrite = RepoFile | RepoBlobFile

/** One entry of a directory listing. */
export interface RepoEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'dir'
  /** Bytes; 0 for a directory. */
  readonly size: number
}

export interface UploadOptions {
  /** How much of the request has been sent, 0 to 1. GitHub still has to store it after 1. */
  readonly onProgress?: (fraction: number) => void
  readonly signal?: AbortSignal
}

export interface CommitPlan {
  readonly writes?: readonly RepoWrite[]
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
 *
 * Big files go up first, with `upload`, and are placed by sha in the commit: an upload takes
 * minutes on a slow line, and the head is read after it, so the window in which another
 * publish can slip in stays as short as the commit itself.
 */
export interface Repo {
  /** The published branch's current commit. */
  head(): Promise<string>
  /** A file's text at `ref` (default: the published branch), or null when it does not exist. */
  read(path: string, ref?: string): Promise<string | null>
  /** A directory's entries at `ref`, or null when there is no such directory. */
  list(path: string, ref?: string): Promise<RepoEntry[] | null>
  /** Stores bytes as a git blob and resolves to its sha, for a commit to place. */
  upload(data: Blob, options?: UploadOptions): Promise<string>
  /** All writes and deletes as ONE commit, so a page and its index can never disagree. */
  commit(plan: CommitPlan): Promise<void>
}

/** A release to create: its tag (made from `master`), title and description. */
export interface ReleaseInput {
  readonly tag: string
  readonly name: string
  readonly body: string
}

/** An asset of a release, as GitHub stored it: what the Builds module records and links to. */
export interface ReleaseAsset {
  readonly id: number
  readonly name: string
  readonly size: number
  /** GitHub's browser_download_url: https://github.com/<repo>/releases/download/<tag>/<name>. */
  readonly url: string
}

/**
 * GitHub Releases, for the one file a commit cannot carry: a build of 100 MiB or more. A
 * release's asset holds it, and the commit records where (builds/).
 *
 * Kept apart from Repo, so only what publishes a release needs them: the other modules, and
 * their tests' repositories, stay as they are. `hasReleases` tells whether a repo has them.
 *
 * The browser can create and delete releases (api.github.com answers CORS) but cannot upload
 * an asset: uploads.github.com answers no preflight. So against GitHub the asset goes up
 * through the Device Lab helper on the owner's Mac (builds/helper.ts), and only the dev mock,
 * where nothing reaches GitHub, stores one itself (uploadReleaseAsset).
 */
export interface Releases {
  /** Creates a release, and its tag from the published branch; resolves to the release's id. */
  createRelease(input: ReleaseInput): Promise<{ id: number }>
  /** Deletes a release; one already gone is fine. Its tag stays: see deleteTag. */
  deleteRelease(id: number): Promise<void>
  /** Deletes a tag; one already gone is fine. */
  deleteTag(tag: string): Promise<void>
  /** The dev mock only: stores an asset of `release` the way the helper uploads one. */
  readonly uploadReleaseAsset?: (
    release: number,
    name: string,
    data: Blob,
    options?: UploadOptions,
  ) => Promise<ReleaseAsset>
}

export const hasReleases = (repo: Repo): repo is Repo & Releases =>
  'createRelease' in repo &&
  typeof repo.createRelease === 'function' &&
  'deleteRelease' in repo &&
  typeof repo.deleteRelease === 'function' &&
  'deleteTag' in repo &&
  typeof repo.deleteTag === 'function'

/** A release's id or an asset's, as GitHub numbers them. */
export const isGitHubId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * A tag name that can only ever name a tag: letters, digits, '.', '_' and '-', never a '/' or
 * '..'. It goes into the path of a DELETE, where a tag spelled like `../heads/master` must not
 * reach a branch, whatever the index it came from says.
 */
export const isPlainTag = (tag: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(tag) && !tag.includes('..')

export const isBlobWrite = (write: RepoWrite): write is RepoBlobFile => 'sha' in write

/**
 * GitHub refuses any file of 100 MiB or more: a push with one is rejected, and so is a blob.
 * Every caller checks before uploading: a tester's build that large goes to a release instead
 * (Releases), and nothing ever fails with a bare 422.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

/**
 * Text up to this size is sent inline in the tree. Beyond it, it goes up as a blob first, so a
 * tree request never carries a large page (an artifact can be megabytes of inline images).
 */
export const INLINE_TEXT_BYTES = 512 * 1024

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

/** GitHub's own sentence from an error body, or ''. */
function reasonOf(body: unknown): string {
  return isRecord(body) && typeof body.message === 'string' ? body.message : ''
}

/**
 * GitHub's sentence and, for a "Validation Failed", the codes of what failed: `Validation Failed
 * (already_exists)` says what the sentence alone does not.
 */
function detailedReason(body: unknown): string {
  const reason = reasonOf(body)
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : []
  const codes = errors.flatMap((e) => (isRecord(e) && typeof e.code === 'string' ? [e.code] : []))
  return codes.length > 0 ? `${reason || 'Refused'} (${codes.join(', ')})` : reason
}

/** The Contents API returns base64 with line breaks; the bytes inside are UTF-8. */
export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Base64 of some bytes: the browser's own encoder where it has one (2025+), else btoa. */
function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let binary = ''
  // String.fromCharCode takes its bytes as arguments; 32 K of them stays inside every engine's limit.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/**
 * The bytes as base64, a piece at a time. Each piece is a multiple of 3 bytes, so the pieces'
 * base64 joins into the whole's with no padding in between, and a 100 MB build is never one
 * 133 MB string: the pieces go straight into the request Blob, which the browser can keep on disk.
 */
async function base64Pieces(data: Blob, signal?: AbortSignal): Promise<string[]> {
  const PIECE = 3 * 1024 * 1024
  const pieces: string[] = []
  for (let at = 0; at < data.size; at += PIECE) {
    signal?.throwIfAborted()
    pieces.push(toBase64(new Uint8Array(await data.slice(at, at + PIECE).arrayBuffer())))
  }
  return pieces
}

export interface SendRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Blob
  readonly onProgress?: (fraction: number) => void
  readonly signal?: AbortSignal
}

export interface SendResponse {
  readonly status: number
  readonly body: string
}

/** POSTs a body and reports how much of it has gone. */
export type Sender = (request: SendRequest) => Promise<SendResponse>

/**
 * XMLHttpRequest, not fetch: fetch cannot report how much of a request body has been sent,
 * and an upload of tens of megabytes without a progress bar looks like a hang.
 */
export const xhrSend: Sender = ({ url, headers, body, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      )
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      resolve({ status: xhr.status, body: xhr.responseText })
    }
    xhr.onerror = () => {
      reject(new NetworkError())
    }
    xhr.onabort = () => {
      reject(new DOMException('The upload was cancelled.', 'AbortError'))
    }
    signal?.addEventListener(
      'abort',
      () => {
        xhr.abort()
      },
      { once: true },
    )
    xhr.send(body)
  })

export function gitHubRepo(
  token: string,
  fetchImpl: typeof fetch = fetch,
  send: Sender = xhrSend,
): Repo & Releases {
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
  }

  /**
   * One API call. `no-store` because the API marks responses cacheable for 60 s, and a list
   * re-read just after publishing must not come back from the cache without the new page.
   */
  async function call(
    path: string,
    init: RequestInit = {},
    accept = headers.Accept,
  ): Promise<Response> {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        ...headers,
        Accept: accept,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
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

  async function upload(data: Blob, { onProgress, signal }: UploadOptions = {}): Promise<string> {
    const pieces = await base64Pieces(data, signal)
    const body = new Blob(['{"encoding":"base64","content":"', ...pieces, '"}'], {
      type: 'application/json',
    })
    const response = await send({
      url: `${API}/git/blobs`,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
    })
    if (response.status === 401) throw new AuthError()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(response.body)
    } catch {
      // Not JSON: a proxy's error page, say. The status says enough.
    }
    if (response.status !== 201) {
      const reason = reasonOf(parsed)
      throw new GitHubError(
        `Could not upload the file${reason ? `: ${reason}` : ''} (HTTP ${String(response.status)})`,
        response.status,
      )
    }
    return stringAt(parsed, ['sha'], 'blob sha')
  }

  /*
    A large build's release: a prerelease, never "Latest" (a tester's build is no release of the
    site), tagged from the published branch. Its description links the install page, so the
    Releases list on GitHub says what each one is for.
  */
  async function createRelease({ tag, name, body }: ReleaseInput): Promise<{ id: number }> {
    const response = await call('/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: BRANCH,
        name,
        body,
        draft: false,
        prerelease: true,
        make_latest: 'false',
      }),
    })
    const parsed: unknown = await response.json().catch(() => null)
    if (response.status !== 201) {
      const reason = detailedReason(parsed)
      throw new GitHubError(
        `Could not create the release${reason ? `: ${reason}` : ''} (HTTP ${String(response.status)})`,
        response.status,
      )
    }
    const id = isRecord(parsed) ? parsed.id : undefined
    if (!isGitHubId(id)) throw new GitHubError('Unexpected GitHub response: no release id', 0)
    return { id }
  }

  /** A release, deleted. Its tag stays behind (GitHub leaves it): deleteTag removes that. */
  async function deleteRelease(id: number): Promise<void> {
    if (!isGitHubId(id)) throw new Error(`Refusing to delete release "${String(id)}"`)
    const response = await call(`/releases/${String(id)}`, { method: 'DELETE' })
    // Gone already, by hand or by an earlier attempt: what was asked for is true.
    if (response.ok || response.status === 404) return
    throw new GitHubError(
      `Could not delete release ${String(id)} (HTTP ${String(response.status)})`,
      response.status,
    )
  }

  async function deleteTag(tag: string): Promise<void> {
    if (!isPlainTag(tag)) throw new Error(`Refusing to delete tag "${tag}"`)
    const response = await call(`/git/refs/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
    // GitHub answers a tag that is not there with 422 ("Reference does not exist"), or 404.
    if (response.ok || response.status === 404 || response.status === 422) return
    throw new GitHubError(
      `Could not delete tag ${tag} (HTTP ${String(response.status)})`,
      response.status,
    )
  }

  return {
    head,
    upload,
    createRelease,
    deleteRelease,
    deleteTag,

    /*
      The raw media type: the file itself, not a JSON envelope around its base64. The envelope
      only carries files up to 1 MB — beyond that GitHub answers 403 — and an artifact page
      with its images inline is easily larger. Raw works up to 100 MB, the limit of a file.
    */
    async read(path, ref = BRANCH) {
      const response = await call(
        `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        {},
        'application/vnd.github.raw+json',
      )
      if (response.status === 404) return null
      if (!response.ok) {
        throw new GitHubError(
          `Could not read ${path} (HTTP ${String(response.status)})`,
          response.status,
        )
      }
      // text() decodes UTF-8 whatever the response claims, which is what every file here is.
      return response.text()
    },

    async list(path, ref = BRANCH) {
      const response = await call(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`)
      if (response.status === 404) return null
      if (!response.ok) {
        throw new GitHubError(
          `Could not list ${path} (HTTP ${String(response.status)})`,
          response.status,
        )
      }
      const body: unknown = await response.json()
      // A file answers with an object: there is no directory by that name.
      if (!Array.isArray(body)) return null
      return body.filter(isRecord).map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        path: typeof entry.path === 'string' ? entry.path : '',
        type: entry.type === 'dir' ? 'dir' : 'file',
        size: typeof entry.size === 'number' ? entry.size : 0,
      }))
    },

    /*
      The Git Data API, not the Contents API: Contents writes one file per commit, and a
      second write in a row races the first and fails with 409. Here the tree is built on top
      of `parent` and the ref is moved once, without force — so if the branch moved since
      `parent` was read, GitHub refuses the update as a non-fast-forward instead of the change
      silently undoing someone else's commit.
    */
    async commit({ writes = [], deletes = [], message, parent }) {
      const placed: RepoBlobFile[] = []
      const inline: RepoFile[] = []
      for (const write of writes) {
        if (isBlobWrite(write)) placed.push(write)
        else if (new Blob([write.content]).size > INLINE_TEXT_BYTES) {
          placed.push({ path: write.path, sha: await upload(new Blob([write.content])) })
        } else inline.push(write)
      }
      const baseTree = stringAt(
        await json(`/git/commits/${parent}`, {}, 'read the base commit'),
        ['tree', 'sha'],
        'base tree',
      )
      const tree = [
        ...inline.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
        ...placed.map((file) => ({ path: file.path, mode: '100644', type: 'blob', sha: file.sha })),
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
        const reason = reasonOf(body)
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
