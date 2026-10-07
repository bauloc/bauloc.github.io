/*
  A stand-in for https://uploads.github.com as the release upload (§2.10) meets it: plain HTTP
  on 127.0.0.1, put in place with createBridge's `githubUploads`. Every request is recorded as
  it arrives (method, URL, headers, the bytes of its body and their SHA-256, whether its body
  ended short, whether the helper hung up before an answer), and each test says how the next
  ones are answered:

  - `store` (the default): read the whole body, then 201 with an asset like GitHub's own, its
    download address in the site's repository;
  - `answer`: a status and a JSON body, after reading the body, or before it (`early`), as
    GitHub does when it refuses a token without reading on;
  - `hold`: read nothing until release(), then store; for back-pressure, a busy helper and
    shutdown;
  - `silent`: read the body and never answer, for the idle deadline.

  Nothing here ever reaches the real GitHub.
*/
import { createHash } from 'node:crypto'
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const DOWNLOAD = 'https://github.com/bauloc/bauloc.github.io/releases/download/'
export const TAG = 'build-abc12345-20261007081530'

export type Behaviour =
  | { kind: 'store' }
  | { kind: 'answer'; status: number; body: unknown; early?: boolean }
  | { kind: 'hold' }
  | { kind: 'silent' }

export interface UploadSeen {
  readonly method: string
  /** The path and query as sent. */
  readonly url: string
  readonly headers: IncomingHttpHeaders
  /** Body bytes received so far. */
  bytes: number
  /** The whole body's SHA-256, once it ended. */
  sha256: string | null
  /** The connection closed before the body ended: the helper gave up on it. */
  aborted: boolean
  /** The connection closed before this fake answered: the helper hung up. */
  cut: boolean
  /** Resolves when the connection is over: answered, or cut. */
  readonly done: Promise<void>
}

export interface FakeGitHub {
  readonly url: string
  readonly seen: UploadSeen[]
  /** How the next uploads are answered. */
  behave: (behaviour: Behaviour) => void
  /** Lets a held upload's body flow. */
  release: () => void
  /** Resolves once `count` uploads have arrived. */
  arrived: (count: number, timeoutMs?: number) => Promise<UploadSeen>
  /** Stop listening: later uploads fail to connect, as when GitHub is unreachable. */
  stop: () => Promise<void>
}

/** GitHub's 201 for a stored asset, trimmed to the fields that matter here. */
export function storedAsset(name: string, size: number, type: string): Record<string, unknown> {
  return {
    url: 'https://api.github.com/repos/bauloc/bauloc.github.io/releases/assets/245678901',
    id: 245_678_901,
    node_id: 'RA_kwDOAbCdEf4OpQrS',
    name,
    label: '',
    state: 'uploaded',
    content_type: type,
    size,
    download_count: 0,
    created_at: '2026-10-07T08:15:31Z',
    updated_at: '2026-10-07T08:15:31Z',
    browser_download_url: `${DOWNLOAD}${TAG}/${name}`,
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  let behaviour: Behaviour = { kind: 'store' }
  const seen: UploadSeen[] = []
  const held: Array<() => void> = []
  const arrivals: Array<() => void> = []

  const server = http.createServer((req, res) => {
    let markDone: () => void = () => undefined
    const upload: UploadSeen = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      bytes: 0,
      sha256: null,
      aborted: false,
      cut: false,
      done: new Promise<void>((resolve) => {
        markDone = resolve
      }),
    }
    seen.push(upload)
    for (const wake of arrivals.splice(0)) wake()
    const now = behaviour
    const hash = createHash('sha256')
    req.on('data', (chunk: Buffer) => {
      upload.bytes += chunk.length
      hash.update(chunk)
    })
    req.on('end', () => {
      upload.sha256 = hash.digest('hex')
      /** A held upload, once released, is stored like any other. */
      if (now.kind === 'store' || now.kind === 'hold') {
        const name = new URL(upload.url, 'http://x').searchParams.get('name') ?? ''
        sendJson(res, 201, storedAsset(name, upload.bytes, String(req.headers['content-type'])))
      } else if (now.kind === 'answer' && !now.early) {
        sendJson(res, now.status, now.body)
      }
    })
    /** Over once both have closed: they do so in either order, ticks apart. */
    let open = 2
    req.on('close', () => {
      if (!req.complete) upload.aborted = true
      if (--open === 0) markDone()
    })
    res.on('close', () => {
      if (!res.writableFinished) upload.cut = true
      if (--open === 0) markDone()
    })
    if (now.kind === 'answer' && now.early) {
      /** GitHub refusing a request from its headers: the answer, then the connection closed. */
      res.setHeader('Connection', 'close')
      sendJson(res, now.status, now.body)
      return
    }
    if (now.kind === 'hold') {
      req.pause()
      held.push(() => req.resume())
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    behave: (next) => {
      behaviour = next
    },
    release: () => {
      for (const resume of held.splice(0)) resume()
    },
    arrived: (count, timeoutMs = 3_000) =>
      new Promise<UploadSeen>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`Only ${String(seen.length)} of ${String(count)} uploads arrived.`)),
          timeoutMs,
        )
        const check = (): void => {
          const upload = seen[count - 1]
          if (upload) {
            clearTimeout(timer)
            resolve(upload)
          } else arrivals.push(check)
        }
        check()
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
