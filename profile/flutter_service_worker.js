/*
  /profile/ used to be a Flutter web app, and Flutter registered a service worker at this URL
  in the browser of everyone who opened it. /profile/ is now a page of the site's single-page
  app (_app/src/features/profile/), which uses no service worker.

  Browsers re-fetch this script when they check the old worker for updates. This version
  installs in its place, deletes the Flutter app's caches and unregisters itself, so the old
  worker stops waking up for every request under /profile/. Keep it until no browser can still
  have the old worker; `npm run publish` checks that it is here.
*/
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Flutter's caches only: `caches` is shared by the whole origin.
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name.startsWith('flutter-')).map((name) => caches.delete(name)))
      await self.registration.unregister()
    })(),
  )
})
