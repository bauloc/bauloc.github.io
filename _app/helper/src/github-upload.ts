import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  GITHUB_API_VERSION,
  GITHUB_REPO,
  LIMITS,
  NAME,
  RELEASE_ASSET_TYPES,
  RELEASE_DOWNLOAD_PREFIX,
  VERSION,
} from './constants'
import type { ReleaseAsset } from './types'
import { HelperError, abortError, clean } from './util'

/**
 * §13c Release assets for XConsole (§2.10): one build file, streamed to a GitHub release.
 *
 * XConsole publishes a build by committing it to the site's repository, and GitHub refuses a
 * file of 100 MiB or more there. Such a file goes to a GitHub Release instead. The console can
 * create the release itself (api.github.com allows CORS) but can't fill it: uploads.github.com
 * answers no CORS preflight, so no page can send it a file. The console hands the file to this
 * helper, on the owner's Mac, which sends it on:
 *
 * - to one place only: uploads.github.com, a release of the site's own repository, named by
 *   its number, and a file named the way XConsole names builds;
 * - streamed, with back-pressure, so nothing is held in memory whatever the size, and the
 *   page's upload progress follows the real upload;
 * - with the owner's GitHub token in the Authorization header of that one request, and
 *   nowhere else: it is never kept, logged, echoed in an answer, or put in a URL.
 *
 * The HTTP layer has checked Host, Origin and the bearer token before this module sees the
 * request, lets this route alone past the 1 KiB body cap, and runs one upload at a time.
 */

/** The route (§2.2): `POST /api/github/release-asset?release=<id>&name=<file>`. */
export const RELEASE_ASSET_PATH = '/api/github/release-asset'

/** A GitHub token as XConsole keeps it: classic (`ghp_…`) or fine-grained (`github_pat_…`). */
export const GITHUB_TOKEN = /^[A-Za-z0-9_]{20,255}$/
/** A release id: GitHub's are integers, far below 15 digits. */
export const RELEASE_ID = /^\d{1,15}$/
/**
 * A build's file name as XConsole writes one (FILE_NAME_PATTERN, builds/paths.ts): letters,
 * digits, '.', '_' and '-', so it reads the same in the upload's URL, on GitHub, and in the
 * download address testers get.
 */
export const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,78}\.(?:apk|ipa)$/

/** An upload request, once its query and every header passed (parseUpload). */
export interface ReleaseUpload {
  readonly release: string
  readonly name: string
  readonly contentType: (typeof RELEASE_ASSET_TYPES)[number]
  /** The Content-Length: the file's size, and the length GitHub is told up front. */
  readonly size: number
  /** The owner's GitHub token, for this one upload's Authorization header and nothing else. */
  readonly token: string
}

/**
 * The page's request, checked before a byte of its body is read (§2.10): its framing first,
 * a length GitHub can be told up front (411 without one, 413 past GitHub's limit), then the
 * query and the headers (400). No answer repeats what the request said: the token least of all.
 */
export function parseUpload(headers: IncomingHttpHeaders, search: string): ReleaseUpload {
  const length = headers['content-length']
  if (headers['transfer-encoding'] !== undefined || length === undefined) {
    throw new HelperError(
      'LENGTH_REQUIRED',
      411,
      'Send the file with its Content-Length, not chunked.',
    )
  }
  /** Node's parser lets only digits through; checked again, since the number reaches GitHub. */
  if (!/^\d+$/.test(length)) {
    throw new HelperError('BAD_REQUEST', 400, 'The Content-Length is not a number.')
  }
  const size = Number(length)
  if (size > LIMITS.releaseAsset) {
    throw new HelperError('PAYLOAD_TOO_LARGE', 413, 'GitHub takes release files smaller than 2 GB.')
  }
  if (size === 0) throw new HelperError('BAD_REQUEST', 400, 'The file is empty.')

  /** Exactly these two parameters, once each: anything else is a request this route never gets. */
  const query = new URLSearchParams(search)
  const release = query.get('release')
  const name = query.get('name')
  if (
    [...query.keys()].length !== 2 ||
    release === null ||
    name === null ||
    !RELEASE_ID.test(release) ||
    !ASSET_NAME.test(name)
  ) {
    throw new HelperError(
      'BAD_REQUEST',
      400,
      'Name the release (?release=<id>) and the file (&name=<file>.apk or .ipa).',
    )
  }

  const type = (headers['content-type'] ?? '').trim().toLowerCase()
  const contentType = RELEASE_ASSET_TYPES.find((allowed) => allowed === type)
  if (!contentType) {
    throw new HelperError(
      'BAD_REQUEST',
      400,
      'Send the file as application/vnd.android.package-archive or application/octet-stream.',
    )
  }

  const token = headers['x-github-token']
  if (typeof token !== 'string' || !GITHUB_TOKEN.test(token)) {
    throw new HelperError('BAD_REQUEST', 400, 'Send the GitHub token in X-GitHub-Token.')
  }
  return { release, name, contentType, size, token }
}

/**
 * Where the file goes: a release of the site's own repository. `base` is uploads.github.com;
 * a test's fake replaces only that, never the path.
 */
export function uploadUrl(base: string, upload: Pick<ReleaseUpload, 'release' | 'name'>): URL {
  return new URL(
    `/repos/${GITHUB_REPO}/releases/${upload.release}/assets?name=${encodeURIComponent(upload.name)}`,
    base,
  )
}

/** The upload's headers: the token in Authorization, the file's type and length as the page sent them. */
export function uploadHeaders(upload: ReleaseUpload): Record<string, string> {
  return {
    Authorization: `token ${upload.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'Content-Type': upload.contentType,
    'Content-Length': String(upload.size),
    'User-Agent': `${NAME}/${VERSION}`,
  }
}

/**
 * GitHub's own words in an error answer, for the page to show when it has none of its own:
 * the `message`, then what its `errors` say ("Validation Failed: ReleaseAsset name
 * already_exists"), control characters stripped, at most 300 characters.
 */
export function githubMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const { message, errors } = body as { message?: unknown; errors?: unknown }
  const details = (Array.isArray(errors) ? (errors as unknown[]) : [])
    .slice(0, 4)
    .map((item) => {
      if (typeof item === 'string') return item
      if (typeof item !== 'object' || item === null) return ''
      const { resource, field, code, message: said } = item as Record<string, unknown>
      return [resource, field, code, said]
        .filter((part): part is string => typeof part === 'string' && part !== '')
        .join(' ')
    })
    .filter((detail) => detail !== '')
  const lead = typeof message === 'string' ? message.trim() : ''
  const text = details.length ? `${lead ? `${lead}: ` : ''}${details.join('; ')}` : lead
  return clean(text, LIMITS.githubMessage)
}

/** GitHub's answer as JSON, or null when it is none (a proxy's HTML page, say). */
function jsonOf(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return null
  }
}

/** A 201's body, when it describes a file of the site's own repository; else null. */
function storedAsset(body: unknown): ReleaseAsset | null {
  if (typeof body !== 'object' || body === null) return null
  const { id, name, size, browser_download_url: url } = body as Record<string, unknown>
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (typeof name !== 'string' || name === '' || name.length > 255) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  if (
    typeof url !== 'string' ||
    url.length > 2048 ||
    !url.startsWith(RELEASE_DOWNLOAD_PREFIX) ||
    !/^[\x21-\x7e]+$/.test(url)
  ) {
    return null
  }
  return { id, name, size, url }
}

/**
 * GitHub's answer as the helper passes it on (§2.10): the file it stored, or an error the page
 * words by its code, each a 502 since the helper itself did its part. A 201 whose download
 * address is not under the site's repository is not trusted: the page would hand that
 * address to testers. GitHub answers an upload with 201 and nothing else, so any other status
 * is a failure.
 */
export function githubAnswer(status: number, body: unknown): ReleaseAsset {
  if (status === 201) {
    const asset = storedAsset(body)
    if (asset) return asset
    throw new HelperError(
      'GITHUB_UPLOAD_FAILED',
      502,
      'GitHub answered without the address of the file it stored.',
      { status },
    )
  }
  const said = githubMessage(body)
  if (status === 401) throw new HelperError('GITHUB_UNAUTHORIZED', 502, 'GitHub refused the token.')
  if (status === 422) {
    throw new HelperError(
      'GITHUB_ASSET_EXISTS',
      502,
      said || 'The release already has a file with this name.',
    )
  }
  throw new HelperError('GITHUB_UPLOAD_FAILED', 502, said || `GitHub answered ${String(status)}.`, {
    status,
  })
}

export interface UploadOptions {
  /** https://uploads.github.com, or a test's fake. */
  readonly base: string
  /** Nothing moved either way for this long: GitHub, or the page, stopped (githubIdle). */
  readonly idleMs: number
  /** Aborts when the page leaves or the helper stops; the request to GitHub goes with it. */
  readonly signal: AbortSignal
}

/**
 * Streams the page's request body to GitHub, and resolves with what GitHub stored
 * (githubAnswer), or rejects with its error.
 *
 * `pipe` carries the back-pressure: while GitHub's socket is full the page's is not read, so
 * memory stays flat and the page's progress is the real upload's. An answer GitHub sends
 * before the body is all there (a refused token, say) is the answer: the rest is not sent,
 * and the reset that usually follows doesn't turn it into "unreachable".
 *
 * Rejects with GITHUB_UNREACHABLE when GitHub can't be reached, the connection drops before
 * its answer, or nothing moves for `idleMs`; with an AbortError when the signal aborts or the
 * page's request ends short. Whichever way it ends, the request to GitHub is destroyed.
 */
export function uploadReleaseAsset(
  source: IncomingMessage,
  upload: ReleaseUpload,
  o: UploadOptions,
): Promise<ReleaseAsset> {
  return new Promise<ReleaseAsset>((resolve, reject) => {
    const url = uploadUrl(o.base, upload)
    const send: (url: URL, options: RequestOptions) => ClientRequest =
      url.protocol === 'http:' ? httpRequest : httpsRequest
    /** No agent: a connection of its own, closed with the upload, never kept for later. */
    const sink = send(url, { method: 'POST', headers: uploadHeaders(upload), agent: false })
    let answered = false
    let settled = false

    const unreachable = (): HelperError =>
      new HelperError(
        'GITHUB_UNREACHABLE',
        502,
        'GitHub could not be reached, or stopped answering.',
      )
    const idle = setTimeout(() => settle(unreachable()), o.idleMs)
    /** Every chunk either way, the page's to GitHub or GitHub's answer, restarts the deadline. */
    const touch = (): void => {
      if (!settled) idle.refresh()
    }
    const onAbort = (): void => settle(abortError())
    function settle(outcome: ReleaseAsset | Error): void {
      if (settled) return
      settled = true
      clearTimeout(idle)
      o.signal.removeEventListener('abort', onAbort)
      source.off('data', touch)
      source.unpipe(sink)
      sink.destroy()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }

    /** Once GitHub answered, an error on the connection is GitHub closing it, not a failure. */
    sink.on('error', () => {
      if (!answered) settle(unreachable())
    })
    sink.on('response', (answer) => {
      answered = true
      touch()
      /** An early answer: GitHub reads nothing more, so nothing more is sent. */
      source.unpipe(sink)
      source.off('data', touch)
      const status = answer.statusCode ?? 0
      const conclude = (body: unknown): void => {
        try {
          settle(githubAnswer(status, body))
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const chunks: Buffer[] = []
      let bytes = 0
      answer.on('data', (chunk: Buffer) => {
        touch()
        bytes += chunk.length
        /** Past the cap the answer is judged by its status alone, and not read on. */
        if (bytes > LIMITS.githubAnswer) conclude(null)
        else chunks.push(chunk)
      })
      answer.on('end', () => conclude(jsonOf(Buffer.concat(chunks))))
      answer.on('error', () => settle(unreachable()))
      answer.on('close', () => {
        if (!answer.complete) settle(unreachable())
      })
    })
    /** The page's request ended short: it went away mid-file. */
    source.on('close', () => {
      if (!source.complete) settle(abortError())
    })

    source.pipe(sink)
    source.on('data', touch)
    if (o.signal.aborted) onAbort()
    else o.signal.addEventListener('abort', onAbort, { once: true })
  })
}
