/*
  The site's service worker: it keeps the build's files (/assets/*) in the browser for good.

  GitHub Pages answers every file with `Cache-Control: max-age=600`, and a site cannot change
  that. Ten minutes after a visit, the browser must ask the server again about every script,
  stylesheet and image before it uses its copy: a round trip per wave of the page's imports,
  each one to a CDN edge that often has to fetch the file again itself. A name under /assets/
  carries a hash of its content (vite.config.ts), so a copy kept here can never be stale, and it
  is answered from here without asking.

  Nothing else passes through here. Pages, /data/, /build/, /artifact/, /terms/, /privacy/,
  /iptv, the helper, and other origins go to the network exactly as without a worker. A page is
  never kept, so a deploy shows on the next load as before: the new page names new files.

  Registered by src/lib/service-worker.ts. To retire it, publish a sw.js that calls
  `self.registration.unregister()` when it installs, as profile/flutter_service_worker.js did
  for the Flutter app's worker.
*/

const CACHE = 'bauloc-assets-v1'
/** Files kept, the oldest dropped first: about two builds, if every page of each was opened. */
const LIMIT = 300

self.addEventListener('install', (event) => {
  void self.skipWaiting()
  /*
    Chromium's static routes: page loads, and every request outside /assets/, go straight to the
    network without starting this worker. Each rule is added on its own, so a browser that knows
    only the first still gets it; one that knows neither falls back to the fetch handler below,
    which lets those requests through anyway.
  */
  if (typeof event.addRoutes !== 'function') return
  const rules = [
    { condition: { requestMode: 'navigate' }, source: 'network' },
    { condition: { not: { urlPattern: { pathname: '/assets/*' } } }, source: 'network' },
  ]
  event.waitUntil(
    Promise.all(rules.map((rule) => Promise.resolve(event.addRoutes(rule)).catch(() => {}))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('bauloc-assets-') && name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

/** A request for a whole build file: a plain GET from this origin, under /assets/, no query. */
function isAsset(request) {
  if (request.method !== 'GET' || request.mode === 'navigate' || request.headers.has('range')) {
    return false
  }
  const url = new URL(request.url)
  return url.origin === self.location.origin && url.pathname.startsWith('/assets/') && !url.search
}

/** Only a whole, successful answer from this origin is kept: never the 404 of a chunk a deploy removed. */
function keepable(response) {
  return response.status === 200 && response.type === 'basic' && !response.redirected
}

async function keep(cache, request, response) {
  await cache.put(request, response)
  const requests = await cache.keys()
  for (const old of requests.slice(0, Math.max(0, requests.length - LIMIT))) {
    await cache.delete(old)
  }
}

self.addEventListener('fetch', (event) => {
  if (!isAsset(event.request)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const kept = await cache.match(event.request, { ignoreVary: true })
      if (kept) return kept
      const response = await fetch(event.request)
      if (keepable(response)) event.waitUntil(keep(cache, event.request, response.clone()))
      return response
    })(),
  )
})

/*
  A page that loaded before this worker controlled it names the build files it fetched, so they
  are kept too. They are still fresh in the HTTP cache from that load, so keeping them costs no
  download, and they are fetched all at once: a page left early still finds most of them kept.
*/
self.addEventListener('message', (event) => {
  const { data } = event
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return
  const urls = [...new Set(data.urls.filter((url) => typeof url === 'string'))].slice(0, LIMIT)
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(urls.map((url) => warm(cache, url)))
    })(),
  )
})

/** Keeps one build file a page named, unless it is kept already. A failure skips only that file. */
async function warm(cache, url) {
  try {
    const request = new Request(url)
    if (!isAsset(request) || (await cache.match(request, { ignoreVary: true }))) return
    const response = await fetch(request)
    if (keepable(response)) await keep(cache, request, response)
  } catch {
    // Not a URL, offline, or gone: the next page that asks for it fetches it and keeps it then.
  }
}
