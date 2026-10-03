import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'
import './styles/globals.css'

/*
  Section shells are real files, so /device/index.html (or /profile/index.html) loads the app —
  and the router would answer that path with Not Found. Links like it predate the port, when
  those pages were plain index.html files, so the address is folded back to its directory first.
*/
if (window.location.pathname.endsWith('/index.html')) {
  const { pathname, search, hash } = window.location
  const directory = pathname.slice(0, -'index.html'.length)
  window.history.replaceState(window.history.state, '', `${directory}${search}${hash}`)
}

/*
  Browser history, no basepath: this is a GitHub *user* site served from the domain root,
  so `base` stays '/' and every asset URL is root-absolute.

  Deep links work through the SPA fallback that `scripts/publish.mjs` writes — a byte copy
  of index.html at /404.html. Pages serves real files first, so /terms/{slug}/ and /iptv
  never reach the router.

  Scroll restoration is on: the router saves each history entry's scroll position and puts
  it back on a reload or Back. Off, it scrolls every rendered route to the top, and the index
  forgot which sheet you had travelled to the moment you came back to it.
*/
const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root is missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
