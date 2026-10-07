import {
  HelperError,
  TIMEOUTS,
  createHelperClient,
  isAbortError,
} from '@/features/device/helper/client'
import {
  isSafariLike,
  queryLoopback,
  resolvePort,
  type PermissionsLike,
} from '@/features/device/helper/env'
import { parsePairInput } from '@/features/device/helper/pair-fragment'
import {
  DEFAULT_PORT,
  DVC_MAX_AGENT,
  DVC_MIN_AGENT,
  HELPER_NAME,
  isPort,
  type Health,
} from '@/features/device/helper/protocol'
import {
  browserStores,
  isToken,
  newChallenge,
  proofOf,
  readStoredPort,
  readStoredToken,
  readTokenEntries,
  sameText,
  saveStoredPort,
  saveToken,
  tokenIdOf,
  type StoredToken,
  type TokenStores,
} from '@/features/device/helper/token'
import { currentLocale } from '@/lib/locale'

import {
  AuthError,
  NetworkError,
  isGitHubId,
  xhrSend,
  type ReleaseAsset,
  type SendResponse,
} from '../repo/github'
import { BUILD_MESSAGES } from './messages'
import { FILE_NAME_PATTERN, RELEASE_DOWNLOAD_BASE, RELEASE_MAX_BYTES } from './paths'
import type { BuildPlatform } from './types'

/*
  The Device Lab helper, as the Builds module uses it: the one way a build of 100 MiB or more
  reaches GitHub Releases. A browser can create a release (api.github.com answers CORS) but not
  upload its asset (uploads.github.com answers no preflight), so the helper on the owner's Mac
  takes the file on 127.0.0.1 and streams it there itself: POST /api/github/release-asset, the
  feature `github.upload` of helper 1.4.0 (_app/helper/SPEC.md, §2.2's table of endpoints).

  Device Lab's own modules do the talking, imported rather than copied, so the two pages can
  never disagree about a helper: the token store (token.ts: the pairing is Device Lab's, and a
  pairing made on either page serves both), the pair link's reader (pair-fragment.ts) and the
  client's public health call (client.ts). The rule is Device Lab's too (§2.8, §6.5): nothing
  secret goes to a port before what answers there has proved, with an HMAC over that very port
  and a fresh challenge, that it holds the token this page has. The owner's GitHub token rides
  on the upload, so the upload is only ever made with a token a proof has just passed.
*/

/** The helper's feature for POST /api/github/release-asset (helper 1.4.0 and later). */
export const GITHUB_UPLOAD = 'github.upload'

/** Why no helper can be used: none answers, the browser blocks it, Safari, or another program. */
export type MissingReason = 'absent' | 'blocked' | 'safari' | 'foreign'

/**
 * Where the helper stands for an upload. `port` is where the console looked: the command it
 * offers starts a helper there, and a pairing is checked there.
 */
export type HelperProbe =
  | { readonly state: 'missing'; readonly reason: MissingReason; readonly port: number }
  /** Running, but without `github.upload`: an older file, to download again. */
  | { readonly state: 'outdated'; readonly version: string; readonly port: number }
  /** Running and able, but this page holds no token it has proved: paste its link. */
  | { readonly state: 'unpaired'; readonly version: string; readonly port: number }
  /** Proved just now: `token` may go to `port`, and the owner's GitHub token with it. */
  | {
      readonly state: 'ready'
      readonly version: string
      readonly port: number
      readonly token: string
    }

export type ReadyHelper = Extract<HelperProbe, { state: 'ready' }>

/** What the helper functions reach for; each defaults to the browser's own. Tests pass fakes. */
export interface HelperDeps {
  readonly fetch?: typeof fetch
  readonly stores?: TokenStores
  readonly permissions?: PermissionsLike | null
  readonly browser?: { readonly userAgent: string; readonly vendor: string }
}

const apiBase = (port: number) => `http://127.0.0.1:${String(port)}`

/**
 * Where to look for the helper: the port this page's token was paired on, else the one Device
 * Lab last paired on away from the default (dvc_port), else 8787 — Device Lab's own order
 * (§6.1), less the pairing link, which only Device Lab's address carries.
 */
function helperPort(stores: TokenStores): number {
  return resolvePort({
    tokenPort: readStoredToken(stores)?.port ?? null,
    port: readStoredPort(stores),
  })
}

/**
 * The command that starts the helper: Device Lab's download command (it downloads the file
 * again, so the same command updates an old one), for the port the console looks on, with
 * --dev when the console runs on a dev server, whose origin the helper refuses otherwise.
 * Device Lab's helper/status.ts has the same command (downloadCommand); helper.test.ts holds
 * the two together. It is not imported from there: that module carries all of Device Lab's
 * status words, which this page would load only to build one line.
 */
export function helperCommand(port: number, dev: boolean): string {
  const flag = port === DEFAULT_PORT ? '' : ` --port ${String(port)}`
  return `curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs${flag}${dev ? ' --dev' : ''}`
}

/** Whether a health reply is from a helper that can upload to GitHub Releases. */
const canUpload = (health: Health) =>
  health.protocol >= DVC_MIN_AGENT &&
  health.protocol <= DVC_MAX_AGENT &&
  health.features.includes(GITHUB_UPLOAD)

type Verdict = 'ok' | 'stale' | 'foreign'

/**
 * Device Lab's check of a token against a helper (§2.8): the helper's fingerprint must be the
 * token's, and its proof must be the HMAC this page computes over the port IT talks to — a
 * program on another port that relays the challenge to the real helper gets the real port's
 * proof, which fails here.
 */
async function verify(
  token: string,
  health: Health,
  challenge: string,
  port: number,
): Promise<Verdict> {
  if (!health.tokenId || (await tokenIdOf(token)) !== health.tokenId) return 'stale'
  if (!health.proof) return 'foreign'
  return sameText(await proofOf(token, port, challenge), health.proof) ? 'ok' : 'foreign'
}

/**
 * One health call to `port` with a fresh challenge, or why there is no helper to ask. Never
 * sends a token: health is public. A browser that cannot reach the helper is not asked at all,
 * by Device Lab's rules: Safari never lets bauloc.github.io reach 127.0.0.1 (Device Lab sends
 * it to the helper's own page, which cannot serve this console), and a denied permission fails
 * every request. While the browser may be showing its permission prompt there is no deadline:
 * Chrome holds the request until the owner answers.
 */
async function askHealth(
  port: number,
  signal: AbortSignal | undefined,
  deps: HelperDeps,
): Promise<
  { readonly health: Health; readonly challenge: string } | { readonly missing: MissingReason }
> {
  const browser =
    deps.browser ?? (typeof navigator === 'undefined' ? { userAgent: '', vendor: '' } : navigator)
  if (isSafariLike(browser.userAgent, browser.vendor)) return { missing: 'safari' }
  const permissions =
    deps.permissions !== undefined
      ? deps.permissions
      : typeof navigator === 'undefined'
        ? null
        : ((navigator.permissions as PermissionsLike | undefined) ?? null)
  const { state } = await queryLoopback(permissions)
  if (state === 'denied') return { missing: 'blocked' }
  const client = createHelperClient(
    apiBase(port),
    () => null,
    deps.fetch ? { fetch: deps.fetch } : {},
  )
  const challenge = newChallenge()
  try {
    const health = await client.health(challenge, {
      signal,
      timeoutMs: state === 'prompt' ? null : TIMEOUTS.health,
    })
    // Something answers the port, and it is not the helper.
    if (health.name !== HELPER_NAME) return { missing: 'foreign' }
    return { health, challenge }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    return {
      missing:
        error instanceof HelperError && error.code === 'HELPER_FOREIGN' ? 'foreign' : 'absent',
    }
  }
}

/**
 * Where the helper stands, checked now. `ready` only once the token this page holds — this
 * tab's, then the one remembered on this computer when it differs, as Device Lab tries them
 * (§6.5) — matches the helper's fingerprint and its proof for a fresh challenge. Never sends a
 * token. Rejects only when `signal` aborts it.
 */
export async function probeHelper(
  signal?: AbortSignal,
  deps: HelperDeps = {},
): Promise<HelperProbe> {
  const stores = deps.stores ?? browserStores()
  const port = helperPort(stores)
  const answer = await askHealth(port, signal, deps)
  if ('missing' in answer) return { state: 'missing', reason: answer.missing, port }
  const { health, challenge } = answer
  if (!canUpload(health)) return { state: 'outdated', version: health.version, port }
  const { session, local } = readTokenEntries(stores)
  const tries = [session, local].filter(
    (entry, i): entry is StoredToken =>
      entry !== null && entry.port === port && (i === 0 || entry.token !== session?.token),
  )
  for (const entry of tries) {
    if ((await verify(entry.token, health, challenge, port)) === 'ok') {
      return { state: 'ready', version: health.version, port, token: entry.token }
    }
  }
  return { state: 'unpaired', version: health.version, port }
}

/** How pasting a link went. `port` is the one tried: a link may name another than the card's. */
export type PairOutcome =
  | { readonly ok: true; readonly helper: ReadyHelper }
  | {
      readonly ok: false
      readonly reason: 'format' | 'unreachable' | 'foreign' | 'outdated' | 'blocked' | 'safari'
      readonly port: number
    }
  | {
      readonly ok: false
      readonly reason: 'stale'
      readonly port: number
      readonly tokenId: string
    }

/**
 * Pairs this page from what the owner pasted: the link the helper printed, or its token alone
 * (pair-fragment.ts reads either). The token is checked against the helper on the link's port
 * first, as Device Lab's pairing checks it, and kept only once it passed: for this tab, in
 * Device Lab's store — so Device Lab, in this tab, uses it too — and on this computer only when
 * the owner chose "Remember on this computer" in Device Lab before.
 */
export async function pairHelper(input: string, deps: HelperDeps = {}): Promise<PairOutcome> {
  const stores = deps.stores ?? browserStores()
  const looked = helperPort(stores)
  const candidate = parsePairInput(input)
  if (!candidate) return { ok: false, reason: 'format', port: looked }
  // A link names its helper's port (none is 8787); a token alone is for the port looked on.
  const port = candidate.port ?? looked
  const answer = await askHealth(port, undefined, deps)
  if ('missing' in answer) {
    return { ok: false, reason: answer.missing === 'absent' ? 'unreachable' : answer.missing, port }
  }
  const { health, challenge } = answer
  if (!canUpload(health)) return { ok: false, reason: 'outdated', port }
  const verdict = await verify(candidate.token, health, challenge, port)
  if (verdict === 'stale') return { ok: false, reason: 'stale', port, tokenId: health.tokenId }
  if (verdict === 'foreign') return { ok: false, reason: 'foreign', port }
  saveToken(
    { v: 1, token: candidate.token, port, tokenId: await tokenIdOf(candidate.token) },
    false,
    stores,
  )
  saveStoredPort(port, stores)
  return {
    ok: true,
    helper: { state: 'ready', version: health.version, port, token: candidate.token },
  }
}

/* ---------------------------------------------------------------- *
 * The upload
 * ---------------------------------------------------------------- */

/** What GitHub is told an asset is: an APK's own type, plain bytes for an IPA (§5). */
export type ReleaseContentType =
  'application/vnd.android.package-archive' | 'application/octet-stream'

export const releaseContentType = (platform: BuildPlatform): ReleaseContentType =>
  platform === 'android' ? 'application/vnd.android.package-archive' : 'application/octet-stream'

/** The owner's GitHub token as the helper takes it (§5): ghp_…, github_pat_…, nothing else. */
export const PAT_PATTERN = /^[A-Za-z0-9_]{20,255}$/

/** Why an upload through the helper failed: the helper's codes, and two of the page's own. */
export type HelperUploadCode =
  | 'HELPER_UNREACHABLE'
  | 'HELPER_UNAUTHORIZED'
  | 'HELPER_OUTDATED'
  | 'HELPER_BAD_REPLY'
  | 'UPLOAD_BUSY'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'GITHUB_ASSET_EXISTS'
  | 'GITHUB_UPLOAD_FAILED'
  | 'GITHUB_UNREACHABLE'

/** A failed upload through the helper, worded in the console's language when it is made. */
export class HelperUploadError extends Error {
  readonly code: HelperUploadCode
  /** The HTTP status the helper answered, or GitHub's for GITHUB_UPLOAD_FAILED; 0 for none. */
  readonly status: number

  constructor(code: HelperUploadCode, status = 0, gitHubMessage = '') {
    const words = BUILD_MESSAGES[currentLocale()].helperErrors
    super(
      code === 'GITHUB_UPLOAD_FAILED'
        ? words.GITHUB_UPLOAD_FAILED(status, gitHubMessage)
        : words[code],
    )
    this.name = 'HelperUploadError'
    this.code = code
    this.status = status
  }
}

export interface HelperUpload {
  /** The port of a helper probeHelper or pairHelper found ready just now… */
  readonly port: number
  /** …and the token it proved it holds. */
  readonly token: string
  /** The owner's GitHub token: the helper forwards it to GitHub for this one request. */
  readonly pat: string
  readonly releaseId: number
  /** The asset's name: the build's file name (paths.ts's FILE_NAME_PATTERN). */
  readonly name: string
  readonly file: Blob
  readonly contentType: ReleaseContentType
  /** How much of the file has gone, 0 to 1: the helper streams with back-pressure, so this is
   * how much has reached GitHub too, give or take its buffers. */
  readonly onProgress?: (fraction: number) => void
  readonly signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The helper's answer as JSON, or null when it is none. */
function parsed(response: SendResponse): unknown {
  try {
    return JSON.parse(response.body)
  } catch {
    return null
  }
}

/**
 * The fields of the helper's error body. It wraps them as every helper error is wrapped
 * (`{ error: { code, message } }`); a body with them at the top is read the same.
 */
function errorFields(body: unknown): { code: string; message: string; status: number } {
  const fields = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {}
  return {
    code: typeof fields.code === 'string' ? fields.code : '',
    message: typeof fields.message === 'string' ? fields.message.trim().slice(0, 300) : '',
    status:
      typeof fields.status === 'number' && Number.isInteger(fields.status) ? fields.status : 0,
  }
}

/** Why the helper refused, from its status and its error's code. */
function refusal(status: number, body: unknown): Error {
  const { code, message, status: upstream } = errorFields(body)
  // The owner's GitHub token was refused upstream: the console asks for a new one.
  if (code === 'GITHUB_UNAUTHORIZED') return new AuthError()
  if (code === 'GITHUB_UPLOAD_FAILED') {
    return new HelperUploadError('GITHUB_UPLOAD_FAILED', upstream || status, message)
  }
  if (code === 'GITHUB_ASSET_EXISTS' || code === 'GITHUB_UNREACHABLE' || code === 'UPLOAD_BUSY') {
    return new HelperUploadError(code, status)
  }
  // Stopped mid-upload (Ctrl+C in its window): to the owner, the same as it going away.
  if (code === 'HELPER_STOPPING') return new HelperUploadError('HELPER_UNREACHABLE', status)
  if (status === 401) return new HelperUploadError('HELPER_UNAUTHORIZED', status)
  if (status === 409) return new HelperUploadError('UPLOAD_BUSY', status)
  if (status === 413) return new HelperUploadError('PAYLOAD_TOO_LARGE', status)
  // 411 (LENGTH_REQUIRED) too: a browser always sends a file's length, so it is a malformed one.
  if (status === 400 || status === 411) return new HelperUploadError('BAD_REQUEST', status)
  // A helper without the route: its features said otherwise, so it is older than it claims.
  if (status === 404) return new HelperUploadError('HELPER_OUTDATED', status)
  return new HelperUploadError('HELPER_BAD_REPLY', status)
}

/**
 * Sends `file` to GitHub through the helper, as an asset of release `releaseId`: one XHR to
 * POST /api/github/release-asset, for the progress a fetch cannot report, with the headers of
 * §5 — the helper's token in Authorization, the owner's GitHub token in X-GitHub-Token, the
 * asset's Content-Type, and the Content-Length the browser sets from the file. Resolves to the
 * asset GitHub stored, checked: under this repo's download address, with the name asked for
 * and every byte. Rejects with a worded HelperUploadError, an AuthError when GitHub refused
 * the owner's token, or an AbortError when `signal` cancelled it.
 */
export async function uploadViaHelper(upload: HelperUpload): Promise<ReleaseAsset> {
  const { port, token, pat, releaseId, name, file, contentType, onProgress, signal } = upload
  // Each goes into the URL or a header: checked here, whatever the caller checked. A failure
  // is a bug, not a problem to word.
  if (
    !isPort(port) ||
    !isToken(token) ||
    !PAT_PATTERN.test(pat) ||
    !isGitHubId(releaseId) ||
    // The helper takes a release id of at most 15 digits.
    releaseId > 999_999_999_999_999 ||
    !FILE_NAME_PATTERN.test(name) ||
    file.size < 1 ||
    file.size > RELEASE_MAX_BYTES
  ) {
    throw new Error(`uploadViaHelper: refusing to send ${name} to release ${String(releaseId)}`)
  }
  const query = `release=${String(releaseId)}&name=${encodeURIComponent(name)}`
  let response: SendResponse
  try {
    response = await xhrSend({
      url: `${apiBase(port)}/api/github/release-asset?${query}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GitHub-Token': pat,
        'Content-Type': contentType,
      },
      body: file,
      onProgress,
      signal,
    })
  } catch (error) {
    // No answer at all: the helper stopped, or the browser refused to reach it mid-way.
    if (error instanceof NetworkError) throw new HelperUploadError('HELPER_UNREACHABLE')
    throw error
  }
  const body = parsed(response)
  if (response.status !== 201) throw refusal(response.status, body)
  const asset = isRecord(body) ? body : {}
  const { id, size, url } = asset
  if (
    !isGitHubId(id) ||
    asset.name !== name ||
    typeof size !== 'number' ||
    size !== file.size ||
    typeof url !== 'string' ||
    !url.startsWith(RELEASE_DOWNLOAD_BASE) ||
    !url.endsWith(`/${name}`)
  ) {
    throw new HelperUploadError('HELPER_BAD_REPLY', response.status)
  }
  return { id, name, size, url }
}
