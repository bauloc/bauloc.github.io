import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LIMITS, NAME, PROTOCOL, VERSION } from './constants'
import type { Timeouts } from './types'
import { HelperError, singleFlight } from './util'

/**
 * The only upstream files local mode serves (§2.9): hashed build assets, and this helper's
 * own published file for the Environment check's update row. Everything else redirects to
 * the live site; nothing is ever read from this Mac's disk.
 */
export const LOCAL_ASSET =
  /^\/(?:assets\/[\w.-]{1,120}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico|pdf)|device\/agent\/device-bridge\.mjs)$/

/** Old and short page URLs that land on /device/, query kept. */
const PAGE_REDIRECTS = new Set(['/', '/device', '/device/index.html'])

/**
 * Every inline script, so the CSP can hash each one: a future inline module script cannot
 * silently break local mode the way a hash-the-first-script rule would.
 */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi

/** By extension, never from upstream: a proxied file can't arrive with a surprising type. */
const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
}

/**
 * The boot record the local page reads before its bundle runs. It never carries the token:
 * that arrives only through `#pair=` or the pair dialog. `<` is escaped so no value can end
 * the script element.
 */
export function bootScript(apiBase: string): string {
  const boot = JSON.stringify({ mode: 'local', apiBase, protocol: PROTOCOL, version: VERSION })
  return `<script>window.DVC_BOOT=${boot.replace(/</g, '\\u003c')}</script>`
}

/** The page's CSP: scripts from this origin plus the hash of every inline script in `html`. */
export function cspFor(html: string): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map(
    (match) =>
      `'sha256-${createHash('sha256')
        .update(match[1] ?? '', 'utf8')
        .digest('base64')}'`,
  )
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * The live /device/ HTML with the boot script inserted before its first script (the theme
 * script, which must still run before first paint), and the CSP that admits exactly the
 * inline scripts now in it. No <base href>: it would break the router's pushState URLs.
 */
export function bootHtml(html: string | Buffer, apiBase: string): { body: Buffer; csp: string } {
  const text = typeof html === 'string' ? html : html.toString('utf8')
  const at = text.search(/<script\b/i)
  if (at < 0)
    throw new HelperError('UPSTREAM_STATUS', 502, 'The Device Lab page has no script to start.')
  const out = text.slice(0, at) + bootScript(apiBase) + '\n    ' + text.slice(at)
  return { body: Buffer.from(out, 'utf8'), csp: cspFor(out) }
}

interface Entry {
  body: Buffer
  etag: string | null
  checkedAt: number
}

export interface LocalMode {
  readonly handle: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
    host: string,
  ) => Promise<void>
}

function sendPlain(
  res: ServerResponse,
  status: number,
  text: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(text + '\n', 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

/** A decoded body, refused as soon as it grows past `cap`. */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  /** content-length counts the compressed bytes: over the cap means the decoded body is too. */
  if (Number(response.headers.get('content-length')) > cap) {
    await response.body?.cancel()
    throw new HelperError('UPSTREAM_TOO_LARGE', 502, 'The upstream file is too large.')
  }
  const chunks: Buffer[] = []
  let total = 0
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk = Buffer.from(read.value as Uint8Array)
    total += chunk.length
    if (total > cap) {
      await reader.cancel()
      throw new HelperError('UPSTREAM_TOO_LARGE', 502, 'The upstream file is too large.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Local mode (§2.9, §6.4): the helper serves the live Device Lab page from its own origin,
 * for Safari (which never lets a secure page reach loopback) and for anyone without the
 * Local Network Access grant. The upstream is fixed; this is not a general proxy.
 */
export function createLocalMode(opts: {
  upstream: string
  timeouts: Timeouts
  now: () => number
  fetch: typeof fetch
}): LocalMode {
  const upstream = new URL(opts.upstream).origin
  const cache = new Map<string, Entry>()
  const flights = singleFlight()

  const remember = (pathname: string, entry: Entry): void => {
    cache.delete(pathname)
    cache.set(pathname, entry)
    if (cache.size > LIMITS.upstreamEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  /**
   * One upstream GET. Redirects are followed by hand and only within the upstream origin,
   * so an off-site redirect is refused before anything off-site is contacted. `fetch` has
   * already decoded the body: its content-encoding and content-length are never copied.
   */
  async function fetchFrom(pathname: string, previous: Entry | undefined): Promise<Entry> {
    let target = new URL(pathname, upstream)
    for (let hops = 0; ; hops++) {
      const headers: Record<string, string> = { 'user-agent': `${NAME}/${VERSION}` }
      if (previous?.etag && hops === 0) headers['if-none-match'] = previous.etag
      let response: Response
      try {
        response = await opts.fetch(target, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeouts.upstream),
        })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        throw new HelperError(
          'UPSTREAM_UNREACHABLE',
          timedOut ? 504 : 502,
          `Could not reach ${upstream}.`,
        )
      }
      if (response.status === 304 && previous) {
        await response.body?.cancel()
        return { ...previous, checkedAt: opts.now() }
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        const next = location ? new URL(location, target) : null
        if (!next || next.origin !== upstream || hops >= 3) {
          throw new HelperError(
            'UPSTREAM_REDIRECT',
            502,
            `${upstream}${pathname} redirected off-site.`,
          )
        }
        target = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new HelperError(
          'UPSTREAM_STATUS',
          response.status === 404 ? 404 : 502,
          `${upstream}${pathname} answered ${String(response.status)}.`,
        )
      }
      try {
        const body = await readCapped(response, LIMITS.upstream)
        return { body, etag: response.headers.get('etag'), checkedAt: opts.now() }
      } catch (error) {
        if (error instanceof HelperError) throw error
        throw new HelperError('UPSTREAM_UNREACHABLE', 504, `Could not read ${upstream}${pathname}.`)
      }
    }
  }

  /** The cached copy while fresh; else a revalidation; offline, the last good copy. */
  function load(pathname: string, maxAgeMs: number): Promise<Entry> {
    const hit = cache.get(pathname)
    if (hit && opts.now() - hit.checkedAt < maxAgeMs) return Promise.resolve(hit)
    return flights.run(pathname, async () => {
      try {
        const entry = await fetchFrom(pathname, hit)
        remember(pathname, entry)
        return entry
      } catch (error) {
        if (hit) return hit
        throw error
      }
    })
  }

  async function page(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const entry = await load('/device/', opts.timeouts.htmlRevalidate)
    /**
     * apiBase comes from the Host header, which the gate has already allowlisted: a page
     * opened as localhost stays same-origin with the API it calls.
     */
    const { body, csp } = bootHtml(entry.body, `http://${host}`)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function asset(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const helperFile = pathname.startsWith('/device/')
    /** Build assets are content-hashed and never change; the helper file keeps its name. */
    const entry = await load(
      pathname,
      helperFile ? opts.timeouts.htmlRevalidate : Number.POSITIVE_INFINITY,
    )
    const extension = pathname.slice(pathname.lastIndexOf('.') + 1)
    res.writeHead(200, {
      'Content-Type': TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(entry.body.length),
      'Cache-Control': helperFile ? 'no-cache' : 'public, max-age=31536000, immutable',
      /**
       * Ignored for subresources; stops a top-level visit to, say, an SVG from running script here.
       */
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : entry.body)
  }

  return {
    async handle(req, res, pathname, search, host) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendPlain(res, 405, 'GET only.', { Allow: 'GET, HEAD' })
      }
      if (PAGE_REDIRECTS.has(pathname)) {
        res.writeHead(302, { Location: `/device/${search}`, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      /** Browsers ask for it on their own; redirecting it off-site would trip img-src 'self'. */
      if (pathname === '/favicon.ico') return sendPlain(res, 404, 'Not found.')
      try {
        if (pathname === '/device/') return await page(req, res, host)
        if (LOCAL_ASSET.test(pathname)) return await asset(req, res, pathname)
      } catch (error) {
        if (!(error instanceof HelperError)) throw error
        const advice =
          pathname === '/device/'
            ? `\nThis copy of Device Lab loads the live page from ${upstream}, so it needs internet access.`
            : ''
        return sendPlain(
          res,
          error.status,
          `Device Lab could not load ${pathname}: ${error.message} (${error.code})${advice}`,
        )
      }
      /**
       * The rest of the site lives upstream. Concatenating (never resolving) keeps a path
       * such as //evil.example on the upstream host.
       */
      const target = new URL(upstream + pathname + search)
      if (target.origin !== upstream) return sendPlain(res, 400, 'Bad path.')
      res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' })
      res.end()
    },
  }
}
