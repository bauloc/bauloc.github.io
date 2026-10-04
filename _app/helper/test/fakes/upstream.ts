/*
  A stand-in for https://bauloc.github.io as local mode sees it: gzip like GitHub Pages (so
  copying content-encoding or content-length through would be caught), ETags with 304s,
  and a /device/ page with an inline theme script AND an inline script with attributes, so
  the CSP must hash every inline script, not just the first.
*/
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

export const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Device Lab</title>
    <script>
      // Theme before first paint.
      try { if (localStorage.getItem('bauloc:theme') === 'dark') document.documentElement.classList.add('dark') } catch (e) {}
    </script>
    <script type="application/json" data-config="1">{"note":"inline, with attributes"}</script>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body><div id="root"></div></body>
</html>
`

interface File {
  body: Buffer
  type: string
}

export interface FakeUpstream {
  readonly url: string
  /** Requests that reached `path`, in total. */
  readonly hits: (path: string) => number
  /** How many of them were answered 304. */
  readonly notModified: (path: string) => number
  readonly setFile: (path: string, body: string | Buffer, type?: string) => void
  readonly redirect: (path: string, location: string, status?: number) => void
  /** Stop answering: later requests fail to connect, as when the Mac is offline. */
  readonly stop: () => Promise<void>
}

export async function startUpstream(): Promise<FakeUpstream> {
  const files = new Map<string, File>()
  const redirects = new Map<string, { location: string; status: number }>()
  const hits = new Map<string, number>()
  const notModified = new Map<string, number>()
  const setFile = (path: string, body: string | Buffer, type = 'text/plain'): void => {
    files.set(path, { body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), type })
  }
  setFile('/device/', PAGE_HTML, 'text/html; charset=utf-8')
  setFile('/assets/index-abc123.js', 'console.log("device lab")\n', 'application/javascript')
  setFile('/assets/index-def456.css', 'body{margin:0}\n', 'text/css')
  setFile(
    '/assets/i.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'image/svg+xml',
  )
  setFile('/device/agent/device-bridge.mjs', "export const VERSION = '1.0.0'\n", 'text/javascript')

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const moved = redirects.get(path)
    if (moved) {
      res.writeHead(moved.status, { Location: moved.location })
      res.end()
      return
    }
    const file = files.get(path)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const etag = `"${createHash('sha1').update(file.body).digest('hex')}"`
    if (req.headers['if-none-match'] === etag) {
      notModified.set(path, (notModified.get(path) ?? 0) + 1)
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const body = gzip ? gzipSync(file.body) : file.body
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': String(body.length),
      ETag: etag,
      'Cache-Control': 'max-age=600',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    hits: (path) => hits.get(path) ?? 0,
    notModified: (path) => notModified.get(path) ?? 0,
    setFile,
    redirect: (path, location, status = 302) => redirects.set(path, { location, status }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
