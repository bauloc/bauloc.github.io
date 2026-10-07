import { createHash, randomBytes, randomInt } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

/*
  The XConsole mock's GitHub, for `npm run dev` only (`/xconsole/?mock`).

  The browser side (src/features/xconsole/repo/mock-repo.ts) sends its uploads and commits here
  instead of to GitHub. They are applied to an overlay kept in this process's memory, on top of
  the repo as it is on disk, and the dev server SERVES the overlay at the real paths — so a build
  "published" in the mock opens at http://localhost:7360/build/<id>/ exactly as it would on Pages,
  and an artifact at /artifact/<id>.html. Nothing is written to disk and nothing leaves this
  machine; restarting the dev server starts over.

  Writes are confined to the paths the console publishes (the same contract vite.config.ts
  serves), checked on the normalised relative path, so a crafted request cannot reach anything
  else in the repo — or outside it.

  And only the console itself may make them. What the store holds is served as HTML on the dev
  console's own origin, whose localStorage holds the real GitHub token once the console has been
  used without ?mock: a page that could write here could put a script there and read the token.
  So a request the browser marks as another page's is refused (403), and each write must carry
  the media type the console sends (415 otherwise) — a commit as application/json, an upload as
  application/octet-stream. A page of another site can send neither without a CORS preflight,
  which Vite answers without letting it through. The origin check is not redundant with that:
  Vite's default CORS does let any localhost origin through (another dev server's port, any
  *.localhost name), and only the origin tells those apart from this one.

  GitHub Releases are simulated too, for builds of 100 MiB or more: on GitHub their binary is a
  release's asset, uploaded through the Device Lab helper, which the mock never uses. Here a
  release is a record in memory, and an asset upload is read to its end and counted, never kept:
  the install page links the asset at its github.com address, which no dev server serves, so
  keeping up to 2 GB in this process's memory would buy nothing.
*/

/** What the console may write: these directories' subtrees, and these exact files. */
const WRITABLE_DIRS = ['terms', 'privacy', 'data', 'build', 'artifact']
const WRITABLE_FILES = ['iptv']

/** Bodies larger than this are refused: a build in the repo is under 100 MiB, base64 or not. */
const MAX_BODY = 160 * 1024 * 1024

/** GitHub's limit on a release asset (builds/paths.ts's RELEASE_MAX_BYTES): under 2 GiB. */
const MAX_ASSET = 2 * 1024 ** 3 - 1

/** Where GitHub serves this repo's release assets: what an asset's `url` would be there. */
const RELEASE_DOWNLOADS = 'https://github.com/bauloc/bauloc.github.io/releases/download/'

/** An asset's name as the Builds module writes one (paths.ts's FILE_NAME_PATTERN). */
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,78}\.(?:apk|ipa)$/

/** What the console uploads an asset as: an APK's own type, or plain bytes for an IPA. */
const ASSET_TYPES = ['application/vnd.android.package-archive', 'application/octet-stream']

/** A tag name that names only a tag (github.ts's isPlainTag): no '/', no '..'. */
const isPlainTag = (tag: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(tag) && !tag.includes('..')

/**
 * A repo-relative path the mock may write: already normalised, relative, without `..`, inside
 * one of the console's directories (or one of its files). Exported for the test.
 */
export function isWritable(rel: string): boolean {
  if (rel === '' || rel.includes('\0') || rel.includes('\\')) return false
  if (rel.startsWith('/') || path.posix.normalize(rel) !== rel) return false
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false
  }
  if (WRITABLE_FILES.includes(rel)) return true
  return WRITABLE_DIRS.some((dir) => rel.startsWith(`${dir}/`))
}

/** The overlay: a path's bytes, or null when the mock deleted it. */
export type Overlay = Map<string, Buffer | null>

/** A release as the mock keeps it: what GitHub would hold, its assets' bytes aside. */
export interface MockRelease {
  readonly id: number
  readonly tag: string
  readonly name: string
  readonly body: string
  readonly assets: { readonly id: number; readonly name: string; readonly size: number }[]
}

export interface MockStore {
  readonly overlay: Overlay
  /** Bytes for a repo-relative path: the overlay's, else the file on disk; null when neither. */
  readonly read: (rel: string) => Buffer | null
  /** The releases the mock holds, by id, and its tags: deleting a release leaves its tag. */
  readonly releases: ReadonlyMap<number, MockRelease>
  readonly tags: ReadonlySet<string>
  /** Answers /__xconsole-mock/* requests; false for anything else. */
  readonly handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/**
 * Reads a body to its end and counts it, keeping nothing: a release asset's bytes. Refuses one
 * over `max`, and a client that went away (a cancelled upload) ends it too.
 */
function countBody(req: IncomingMessage, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0
    let ended = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      ended = true
      resolve(size)
    })
    req.on('error', reject)
    req.on('close', () => {
      if (!ended) reject(new Error('the upload was cut short'))
    })
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether, as far as the browser says, a request comes from a page of this server. Browsers send
 * Sec-Fetch-Site (same-origin, or none for an address typed in the bar) and, with every POST,
 * Origin; a request with neither (curl, the tests) is no page's, and its writes still have to
 * pass the media type check. The Host it is compared with has passed Vite's host check, which
 * runs first, so a site that points its own name at 127.0.0.1 cannot pass for this server.
 */
function fromThisOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${req.headers.host ?? ''}`
}

/** A request's media type without its parameters: `application/json; charset=utf-8` → `application/json`. */
function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** A write sent as something the console never sends: a form's body, or a no-cors fetch's. */
function unsupported(res: ServerResponse, expected: string): true {
  send(res, 415, { message: `Unsupported Media Type: send ${expected}` })
  return true
}

export function createMockStore(repoRoot: string): MockStore {
  const overlay: Overlay = new Map()
  const blobs = new Map<string, Buffer>()

  /*
    Releases and tags, as GitHub keeps them apart: deleting a release leaves its tag, and a tag
    in use refuses a second release (422 already_exists), so the console's clean-up after a
    failed publish is exercised the way it runs against GitHub. Ids start at a random number,
    as the head does: one read before a restart matches nothing after it.
  */
  const releases = new Map<number, MockRelease>()
  const tags = new Set<string>()
  let nextId = randomInt(100_000, 900_000)

  /*
    The branch head, as GitHub keeps one: it moves with every commit, and a commit names the head
    it was computed from (`parent`). One built on any other head is refused in GitHub's words, as
    a non-fast-forward, so two tabs publishing at once fail here as they would on Pages instead of
    the second silently undoing the first. Each store starts from a random head, so a head read
    before a restart never matches one of the new, emptied overlay.
  */
  const lineage = randomBytes(4).toString('hex')
  let commits = 0
  const head = () => `mock-${lineage}-${String(commits)}`

  function fromDisk(rel: string): Buffer | null {
    // Reads only what could be written: the mock is not a way to read the rest of the repo.
    if (!isWritable(rel)) return null
    const file = path.join(repoRoot, rel)
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null
  }

  function read(rel: string): Buffer | null {
    const changed = overlay.get(rel)
    if (changed !== undefined) return changed
    return fromDisk(rel)
  }

  /** A directory's entries: the disk's and the overlay's, less what the overlay deleted. */
  function list(rel: string) {
    const entries = new Map<
      string,
      { name: string; path: string; type: 'file' | 'dir'; size: number }
    >()
    const dir = path.join(repoRoot, rel)
    const onDisk = isWritable(`${rel}/x`) && existsSync(dir) && statSync(dir).isDirectory()
    if (onDisk) {
      for (const name of readdirSync(dir)) {
        const child = `${rel}/${name}`
        const stat = statSync(path.join(dir, name))
        entries.set(name, {
          name,
          path: child,
          type: stat.isDirectory() ? 'dir' : 'file',
          size: stat.isDirectory() ? 0 : stat.size,
        })
      }
    }
    let seen = onDisk
    for (const [key, bytes] of overlay) {
      if (!key.startsWith(`${rel}/`)) continue
      const rest = key.slice(rel.length + 1)
      const name = rest.split('/')[0] ?? ''
      const isDir = rest.includes('/')
      if (bytes === null) {
        // A deleted file disappears; a directory only once nothing in it is left.
        if (!isDir) entries.delete(name)
        continue
      }
      seen = true
      entries.set(name, {
        name,
        path: `${rel}/${name}`,
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : bytes.length,
      })
    }
    // A directory on disk whose every file the overlay deleted is gone, as it would be on GitHub.
    for (const [name, entry] of entries) {
      if (entry.type !== 'dir') continue
      const prefix = `${rel}/${name}/`
      const alive =
        [...overlay].some(([key, bytes]) => key.startsWith(prefix) && bytes !== null) ||
        walk(path.join(dir, name)).some((file) => overlay.get(`${prefix}${file}`) !== null)
      if (!alive) entries.delete(name)
    }
    return seen ? [...entries.values()] : null
  }

  function walk(dir: string, base = ''): string[] {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      const rel = base ? `${base}/${name}` : name
      return statSync(full).isDirectory() ? walk(full, rel) : [rel]
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/__xconsole-mock/')) return false
    const action = url.pathname.slice('/__xconsole-mock/'.length)

    // Before anything is read, a body included (see the top of the file).
    if (!fromThisOrigin(req)) {
      send(res, 403, { message: 'Forbidden: only the console on this server may use the mock' })
      return true
    }

    try {
      if (req.method === 'GET' && action === 'head') {
        send(res, 200, { sha: head() })
        return true
      }

      if (req.method === 'GET' && action === 'file') {
        const rel = url.searchParams.get('path') ?? ''
        const bytes = isWritable(rel) ? read(rel) : null
        if (bytes === null) {
          send(res, 404, { message: 'Not Found' })
          return true
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        res.end(bytes)
        return true
      }

      if (req.method === 'GET' && action === 'list') {
        const rel = url.searchParams.get('path') ?? ''
        const entries = isWritable(`${rel}/x`) ? list(rel) : null
        if (entries === null) send(res, 404, { message: 'Not Found' })
        else send(res, 200, entries)
        return true
      }

      if (req.method === 'POST' && action === 'blob') {
        if (mediaType(req) !== 'application/octet-stream') {
          return unsupported(res, 'application/octet-stream')
        }
        const bytes = await readBody(req)
        const sha = createHash('sha1').update(bytes).digest('hex')
        blobs.set(sha, bytes)
        send(res, 201, { sha })
        return true
      }

      if (req.method === 'POST' && action === 'commit') {
        if (mediaType(req) !== 'application/json') return unsupported(res, 'application/json')
        const plan: unknown = JSON.parse((await readBody(req)).toString('utf8'))
        if (!isRecord(plan)) throw new Error('not a commit')
        const writes = Array.isArray(plan.writes) ? plan.writes.filter(isRecord) : []
        const deletes = Array.isArray(plan.deletes)
          ? plan.deletes.filter((p): p is string => typeof p === 'string')
          : []
        // Checked in full before anything is applied: a commit is all or nothing, as on GitHub.
        const staged: [string, Buffer | null][] = []
        for (const write of writes) {
          const rel = typeof write.path === 'string' ? write.path : ''
          if (!isWritable(rel)) throw new Error(`may not write ${rel}`)
          if (typeof write.content === 'string')
            staged.push([rel, Buffer.from(write.content, 'utf8')])
          else if (typeof write.sha === 'string' && blobs.has(write.sha)) {
            staged.push([rel, blobs.get(write.sha) ?? null])
          } else throw new Error(`no content for ${rel}`)
        }
        for (const rel of deletes) {
          if (!isWritable(rel)) throw new Error(`may not delete ${rel}`)
          staged.push([rel, null])
        }
        const message = typeof plan.message === 'string' ? plan.message : '(no message)'
        if (plan.parent !== head()) {
          console.info(
            `[xconsole mock] refused commit "${message}": built on ${String(plan.parent)}, not on the head ${head()}`,
          )
          // GitHub's own words for it; mock-repo.ts turns them into github.ts's sentence.
          send(res, 422, { message: 'Update is not a fast forward' })
          return true
        }
        for (const [rel, bytes] of staged) overlay.set(rel, bytes)
        commits += 1
        console.info(
          `[xconsole mock] commit "${message}"\n` +
            staged
              .map(([rel, bytes]) =>
                bytes === null
                  ? `  delete ${rel}`
                  : `  write  ${rel} (${String(bytes.length)} bytes)`,
              )
              .join('\n'),
        )
        send(res, 200, { ok: true })
        return true
      }

      // GitHub Releases (see the top of the file). Every write is a POST with the media type
      // the console sends, like the rest of the store: a JSON body, or an asset's bytes.
      if (req.method === 'POST' && action === 'release') {
        if (mediaType(req) !== 'application/json') return unsupported(res, 'application/json')
        const input: unknown = JSON.parse((await readBody(req)).toString('utf8'))
        if (!isRecord(input) || typeof input.tag !== 'string' || !isPlainTag(input.tag)) {
          throw new Error('not a release')
        }
        if (tags.has(input.tag)) {
          // GitHub's answer for a tag that already has a release, or was left by a deleted one.
          send(res, 422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] })
          return true
        }
        const release: MockRelease = {
          id: nextId++,
          tag: input.tag,
          name: typeof input.name === 'string' ? input.name : '',
          body: typeof input.body === 'string' ? input.body : '',
          assets: [],
        }
        releases.set(release.id, release)
        tags.add(release.tag)
        console.info(`[xconsole mock] release ${String(release.id)} "${release.tag}" created`)
        send(res, 201, { id: release.id, tag_name: release.tag })
        return true
      }

      if (req.method === 'POST' && action === 'release/delete') {
        if (mediaType(req) !== 'application/json') return unsupported(res, 'application/json')
        const input: unknown = JSON.parse((await readBody(req)).toString('utf8'))
        const id = isRecord(input) ? input.id : undefined
        if (typeof id !== 'number' || !releases.delete(id)) {
          send(res, 404, { message: 'Not Found' })
          return true
        }
        console.info(`[xconsole mock] release ${String(id)} deleted`)
        send(res, 200, { ok: true })
        return true
      }

      if (req.method === 'POST' && action === 'tag/delete') {
        if (mediaType(req) !== 'application/json') return unsupported(res, 'application/json')
        const input: unknown = JSON.parse((await readBody(req)).toString('utf8'))
        const tag = isRecord(input) ? input.tag : undefined
        if (typeof tag !== 'string' || !tags.delete(tag)) {
          send(res, 422, { message: 'Reference does not exist' })
          return true
        }
        console.info(`[xconsole mock] tag "${tag}" deleted`)
        send(res, 200, { ok: true })
        return true
      }

      if (req.method === 'POST' && action === 'release/asset') {
        if (!ASSET_TYPES.includes(mediaType(req))) return unsupported(res, ASSET_TYPES.join(' or '))
        const id = url.searchParams.get('release') ?? ''
        const name = url.searchParams.get('name') ?? ''
        const release = /^\d{1,15}$/.test(id) ? releases.get(Number(id)) : undefined
        if (release === undefined) {
          send(res, 404, { message: 'Not Found' })
          return true
        }
        if (!ASSET_NAME.test(name)) throw new Error(`not an asset name: ${name}`)
        if (release.assets.some((a) => a.name === name)) {
          send(res, 422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] })
          return true
        }
        if (Number(req.headers['content-length'] ?? 0) > MAX_ASSET) {
          send(res, 413, { message: 'Payload Too Large' })
          return true
        }
        const size = await countBody(req, MAX_ASSET)
        if (size === 0) throw new Error('an empty asset')
        const asset = { id: nextId++, name, size }
        release.assets.push(asset)
        console.info(
          `[xconsole mock] release ${String(release.id)}: asset ${name} (${String(size)} bytes, not kept)`,
        )
        send(res, 201, { ...asset, url: `${RELEASE_DOWNLOADS}${release.tag}/${name}` })
        return true
      }

      send(res, 404, { message: 'Not Found' })
      return true
    } catch (error) {
      send(res, 400, { message: error instanceof Error ? error.message : 'Bad request' })
      return true
    }
  }

  return { overlay, read, releases, tags, handle }
}
