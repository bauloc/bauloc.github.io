import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { bootHtml, cspFor } from '../src/local-mode'
import { PAGE_HTML, startUpstream } from './fakes/upstream'
import { request, startBridge } from './harness'

const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
const hashOf = (text: string) =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

async function local(timeouts = {}) {
  const upstream = await startUpstream()
  const s = await startBridge({ upstream: upstream.url, timeouts })
  return { upstream, s }
}

describe('bootHtml', () => {
  it('inserts the boot record before the first script, escaping <', () => {
    const { body } = bootHtml(PAGE_HTML, 'http://127.0.0.1:8787</script>')
    const html = body.toString('utf8')
    const boot = html.indexOf('<script>window.DVC_BOOT=')
    expect(boot).toBeGreaterThan(0)
    expect(boot).toBeLessThan(html.indexOf('// Theme before first paint'))
    expect(html).toContain('"apiBase":"http://127.0.0.1:8787\\u003c/script>"')
    expect(html.match(/<\/script>/g)?.length).toBe(PAGE_HTML.match(/<\/script>/g)!.length + 1)
  })
  it('hashes every inline script, with or without attributes, and only those', () => {
    const { body, csp } = bootHtml(PAGE_HTML, 'http://127.0.0.1:8787')
    const inline = [...body.toString('utf8').matchAll(INLINE)].map((m) => hashOf(m[1] ?? ''))
    expect(inline).toHaveLength(3)
    for (const hash of inline) expect(csp).toContain(hash)
    expect(csp.match(/'sha256-/g)).toHaveLength(3)
    expect(cspFor('<p>no scripts</p>')).toContain("script-src 'self';")
  })
})

describe('GET /device/ (§2.9)', () => {
  it('serves the live page with the boot record, the CSP and no token', async () => {
    const { s } = await local()
    const reply = await request(s.port, { path: '/device/' })
    expect(reply.status).toBe(200)
    expect(reply.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(Number(reply.headers['content-length'])).toBe(reply.body.length)
    expect(reply.text).toContain(
      `<script>window.DVC_BOOT={"mode":"local","apiBase":"http://127.0.0.1:${String(s.port)}","protocol":1,"version":"1.4.0"}</script>`,
    )
    expect(reply.text).not.toContain(s.token)
    expect(reply.text).not.toContain(s.bridge.tokenId)
    const csp = String(reply.headers['content-security-policy'])
    for (const m of reply.text.matchAll(INLINE)) expect(csp).toContain(hashOf(m[1] ?? ''))
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    /** The adb tunnel's WebSocket (§4.10), which older Safari doesn't count as 'self'. */
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${String(s.port)};`)
  })
  it('builds apiBase from the allowlisted Host, so localhost stays same-origin', async () => {
    const { s } = await local()
    const reply = await request(s.port, { path: '/device/', host: `localhost:${String(s.port)}` })
    expect(reply.text).toContain(`"apiBase":"http://localhost:${String(s.port)}"`)
    expect(String(reply.headers['content-security-policy'])).toContain(
      `ws://localhost:${String(s.port)}`,
    )
  })
  it('answers HEAD with the headers only', async () => {
    const { s } = await local()
    const reply = await request(s.port, { method: 'HEAD', path: '/device/' })
    expect(reply.status).toBe(200)
    expect(Number(reply.headers['content-length'])).toBeGreaterThan(0)
    expect(reply.body.length).toBe(0)
  })
  it('revalidates with the ETag, and reuses the last good copy offline', async () => {
    const { upstream, s } = await local({ htmlRevalidate: 0 })
    expect((await request(s.port, { path: '/device/' })).status).toBe(200)
    expect((await request(s.port, { path: '/device/' })).status).toBe(200)
    expect(upstream.notModified('/device/')).toBe(1)
    await upstream.stop()
    const offline = await request(s.port, { path: '/device/' })
    expect(offline.status).toBe(200)
    expect(offline.text).toContain('window.DVC_BOOT=')
  })
  it('explains in plain text when the page cannot be loaded at all', async () => {
    const s = await startBridge()
    const reply = await request(s.port, { path: '/device/' })
    expect(reply.status).toBe(502)
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.text).toContain('UPSTREAM_UNREACHABLE')
    expect(reply.text).toContain('needs internet access')
  })
  it('is off with --no-local', async () => {
    const upstream = await startUpstream()
    const s = await startBridge({ upstream: upstream.url, local: false })
    expect((await request(s.port, { path: '/device/' })).status).toBe(404)
    expect(upstream.hits('/device/')).toBe(0)
  })
})

describe('assets', () => {
  it('proxies hashed assets, decoded, immutable and sandboxed, fetched once', async () => {
    const { upstream, s } = await local()
    for (let i = 0; i < 2; i++) {
      const reply = await request(s.port, { path: '/assets/index-abc123.js' })
      expect(reply.status).toBe(200)
      expect(reply.text).toBe('console.log("device lab")\n')
      expect(reply.headers).toMatchObject({
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-security-policy': "sandbox; default-src 'none'",
        'content-length': String(reply.body.length),
      })
      expect(reply.headers['content-encoding']).toBeUndefined()
    }
    expect(upstream.hits('/assets/index-abc123.js')).toBe(1)
    const svg = await request(s.port, { path: '/assets/i.svg' })
    expect(svg.headers['content-type']).toBe('image/svg+xml')
    expect(svg.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
  })
  it('serves the published helper for the update check, revalidated rather than immutable', async () => {
    const { s } = await local()
    const reply = await request(s.port, { path: '/device/agent/device-bridge.mjs' })
    expect(reply.text).toBe("export const VERSION = '1.0.0'\n")
    expect(reply.headers['cache-control']).toBe('no-cache')
  })
  it('follows an on-site redirect, refuses an off-site one, and caps the size', async () => {
    const { upstream, s } = await local()
    upstream.redirect('/assets/moved.js', '/assets/index-abc123.js')
    upstream.redirect('/assets/away.js', 'https://evil.example/x.js')
    upstream.setFile('/assets/huge.js', Buffer.alloc(17 * 1024 * 1024, 0x61))
    expect((await request(s.port, { path: '/assets/moved.js' })).text).toBe(
      'console.log("device lab")\n',
    )
    const away = await request(s.port, { path: '/assets/away.js' })
    expect([away.status, away.text.includes('UPSTREAM_REDIRECT')]).toEqual([502, true])
    const huge = await request(s.port, { path: '/assets/huge.js' })
    expect([huge.status, huge.text.includes('UPSTREAM_TOO_LARGE')]).toEqual([502, true])
    const missing = await request(s.port, { path: '/assets/nope.js' })
    expect(missing.status).toBe(404)
  })
})

describe('everything else', () => {
  it.each([
    ['/', '/device/'],
    ['/device', '/device/'],
    ['/device/index.html?mock=1', '/device/?mock=1'],
  ])('redirects %s to the page', async (path, location) => {
    const { s } = await local()
    const reply = await request(s.port, { path })
    expect([reply.status, reply.headers.location]).toEqual([302, location])
  })
  it('sends every other path to the live site, never reading this Mac’s disk', async () => {
    const { upstream, s } = await local()
    for (const [path, location] of [
      ['/profile/', `${upstream.url}/profile/`],
      ['/assets/../../etc/passwd', `${upstream.url}/etc/passwd`],
      ['/assets/%2e%2e/package.json', `${upstream.url}/package.json`],
      ['//evil.example/x?y=1', `${upstream.url}//evil.example/x?y=1`],
    ]) {
      const reply = await request(s.port, { path: path ?? '' })
      expect(reply.status).toBe(302)
      expect(reply.headers.location).toBe(location)
      expect(new URL(String(reply.headers.location)).origin).toBe(upstream.url)
    }
  })
  it('answers favicon.ico 404 (a redirect would trip img-src) and refuses other methods', async () => {
    const { s } = await local()
    expect((await request(s.port, { path: '/favicon.ico' })).status).toBe(404)
    const post = await request(s.port, { method: 'POST', path: '/device/' })
    expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD'])
  })
})
