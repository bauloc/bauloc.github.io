// Every subset, each with its unicode-range, so a browser fetches only the ones the text on
// screen needs (latin, and vietnamese once the page is in Vietnamese). The per-subset entry
// files carry no unicode-range, and combining them would let the last one shadow the others.
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/700.css'

import { Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { useMessages } from '@/lib/i18n'

import { NavRail } from './components/nav-rail'
import { SidePanel } from './components/side-panel'
import { TopBar } from './components/top-bar'
import { PROFILE_MESSAGES } from './messages'
import { menuItemFor } from './profile-menu'

/**
 * `/profile/` — a port of the Flutter portfolio that used to be served here as a prebuilt
 * bundle: the menu rail, the teal side panel at `wide`, and the current section beside them,
 * under a top bar that leads back to the site's home page and holds the language and theme.
 *
 * The layout is the original's. One thing is deliberately not: the Flutter build scrolled
 * each section inside its own box, while here the document scrolls and the rail and the
 * panel stay put — so the browser's own scrolling, find-in-page and keyboard all work.
 *
 * Text defaults to Material's bodyMedium, which every Flutter `Text` inherited from: 14 px,
 * 0.25 px tracking, 1.43 line height.
 */
export function ProfileLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const current = menuItemFor(pathname)
  const t = useMessages(PROFILE_MESSAGES)

  useEffect(() => {
    const previous = document.title
    document.title = t.documentTitle
    return () => {
      document.title = previous
    }
  }, [t.documentTitle])

  return (
    <div
      data-page="profile"
      className="font-profile text-profile-on-surface [&_:focus-visible]:outline-profile-primary bg-profile-page flex min-h-dvh text-[14px] leading-[1.43] tracking-[0.25px]"
    >
      <NavRail current={current} />
      <SidePanel />
      <main className="min-w-0 flex-1">
        <TopBar />
        <h1 className="sr-only">Nguyen Phuoc Loc — {t.section[current.id]}</h1>
        <Outlet />
      </main>
    </div>
  )
}
