// Every subset, each with its unicode-range, so a browser fetches only the ones the text on
// screen needs (latin here). The per-subset entry files carry no unicode-range, and combining
// them would let the last one shadow the others.
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/700.css'

import { Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { NavRail } from './components/nav-rail'
import { SidePanel } from './components/side-panel'
import { menuItemFor } from './profile-menu'

/** The Flutter build's `MaterialApp.title`. */
const TITLE = "BAULOC's Profile"

/**
 * `/profile/` — a port of the Flutter portfolio that used to be served here as a prebuilt
 * bundle: the menu rail, the teal side panel at `wide`, and the current section beside them.
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

  useEffect(() => {
    const previous = document.title
    document.title = TITLE
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div
      data-page="profile"
      className="font-profile text-profile-on-surface [&_:focus-visible]:outline-profile-primary flex min-h-dvh bg-white text-[14px] leading-[1.43] tracking-[0.25px]"
    >
      <NavRail current={current} />
      <SidePanel />
      <main className="min-w-0 flex-1">
        <h1 className="sr-only">Nguyen Phuoc Loc — {current.title}</h1>
        <Outlet />
      </main>
    </div>
  )
}
