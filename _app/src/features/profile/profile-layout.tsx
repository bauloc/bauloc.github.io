import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from 'react'

import { SiteHeader } from '@/components/site-header'
import { useMessages } from '@/lib/i18n'

import { ProfileIntro } from './components/profile-intro'
import { Spotlight } from './components/spotlight'
import { PROFILE_MESSAGES } from './messages'
import { PROFILE_MENU, menuItemFor, sectionId, type ProfileMenuItem } from './profile-menu'
import { AboutSection } from './sections/about-section'
import { ContactSection } from './sections/contact-section'
import { PortfolioSection } from './sections/portfolio-section'
import { RelaxSection } from './sections/relax-section'
import { ResumeSection } from './sections/resume-section'

/** Smooth, unless the visitor asked for less motion. */
function behaviour(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** Scrolls to a section; after a choice, focus goes there too, so Tab and a reader go on from it. */
function scrollToSection(item: ProfileMenuItem, how: ScrollBehavior, focus = false) {
  const section = document.getElementById(sectionId(item))
  section?.scrollIntoView({ behavior: how, block: 'start' })
  if (focus) section?.focus({ preventScroll: true })
}

/** The section on screen: the last whose top has passed a third of the window. */
function sectionOnScreen(): ProfileMenuItem {
  const line = window.innerHeight / 3
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
  if (atBottom) return PROFILE_MENU[4]
  let current: ProfileMenuItem = PROFILE_MENU[0]
  for (const item of PROFILE_MENU) {
    const top = document.getElementById(sectionId(item))?.getBoundingClientRect().top
    if (top !== undefined && top <= line) current = item
  }
  return current
}

/**
 * `/profile/` — the portfolio as one page, after brittanychiang.com: who Loc is on the left,
 * staying put from lg up, and the sections scrolling on the right (About, Portfolio, Resume,
 * Relax, Contact). The section on screen lights its line in the nav and names itself in the
 * site header's prompt (`~/profile/resume`).
 *
 * The sections keep the addresses the Flutter build gave them (`/profile/resume`): opening one
 * lands on that section, choosing one in the nav goes to its address and scrolls there, and
 * scrolling takes the address of the section on screen. The CV (`/profile/cv`) is a page of
 * its own.
 */
export function ProfileLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const routed = menuItemFor(pathname)
  /**
   * On the way to another page (the CV, the home page): the address already names it while
   * its code loads, and this page stays as it is until it goes.
   */
  const leaving = routed === null && pathname.replace(/\/+$/, '') !== '/profile'
  const t = useMessages(PROFILE_MESSAGES)
  const [active, setActive] = useState<ProfileMenuItem>(routed ?? PROFILE_MENU[0])
  const arrived = useRef(false)
  const navigate = useNavigate()
  /** The section whose address the page took from the scroll, until the router has it. */
  const followed = useRef<ProfileMenuItem['id'] | null>(null)
  /** The frame that will scroll to the section the address names. */
  const pending = useRef(0)

  useEffect(() => {
    const previous = document.title
    document.title = t.documentTitle
    return () => {
      document.title = previous
    }
  }, [t.documentTitle])

  // Which section is on screen, once per frame while the page scrolls. Once the arrival is
  // done the address follows it, replacing the history entry so Back still leaves the page,
  // one step at a time: each waits for the router to have the last. The bare `/profile/`
  // already stands for the first section.
  const onScrolled = useEffectEvent(() => {
    const current = sectionOnScreen()
    setActive(current)
    const named = routed ?? PROFILE_MENU[0]
    if (leaving || !arrived.current || followed.current !== null || current.id === named.id) return
    followed.current = current.id
    void navigate({ to: current.to, replace: true, resetScroll: false })
  })

  // To the section the address names, once the router has had its turn (two frames on): with
  // scroll restoration on (main.tsx) it puts a reloaded page back where it was, and that
  // position wins over the section's top. On arrival at once; after a choice in the nav
  // smoothly (the nav's links keep the router from resetting the scroll). `arrived` flips only
  // when this runs, so React's dev-mode double mount still counts as one arrival.
  //
  // An address taken from the scroll moves nothing, and leaves a scroll still to come alone
  // (a choice made while the page was still coasting); if the page has moved on meanwhile,
  // the address follows again.
  useEffect(() => {
    if (leaving) {
      cancelAnimationFrame(pending.current)
      return
    }
    if (routed !== null && followed.current === routed.id) {
      followed.current = null
      onScrolled()
      return
    }
    followed.current = null
    cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      pending.current = requestAnimationFrame(() => {
        pending.current = 0
        const arrival = !arrived.current
        arrived.current = true
        if (routed === null) {
          if (!arrival) window.scrollTo({ top: 0, behavior: behaviour() })
          return
        }
        if (arrival && window.scrollY !== 0) return
        scrollToSection(routed, arrival ? 'auto' : behaviour(), !arrival)
      })
    })
  }, [routed, leaving])
  useEffect(
    () => () => {
      cancelAnimationFrame(pending.current)
    },
    [],
  )

  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      onScrolled()
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  // A choice of the section the address already names changes nothing to navigate to:
  // scroll there anyway. A click with a modifier is the browser's (a new tab, a window).
  const select = (item: ProfileMenuItem, event: MouseEvent<HTMLAnchorElement>) => {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    if (routed?.id !== item.id || modified || event.button !== 0) return
    event.preventDefault()
    scrollToSection(item, behaviour(), true)
  }

  return (
    <div
      data-page="profile"
      className="font-console bg-profile-page text-profile-text selection:bg-profile-tint/30 selection:text-profile-ink min-h-dvh leading-relaxed antialiased"
    >
      <SiteHeader current="profile" path={`/profile/${sectionId(active)}`} />
      <Spotlight />
      <div className="mx-auto min-h-screen max-w-screen-xl px-6 py-12 md:px-12 md:py-16 lg:py-0">
        <main className="lg:flex lg:justify-between lg:gap-4">
          <ProfileIntro active={active.id} onSelect={select} />
          <div className="pt-24 lg:w-[52%] lg:py-24">
            <AboutSection />
            <PortfolioSection />
            <ResumeSection />
            <RelaxSection />
            <ContactSection />
          </div>
        </main>
      </div>
    </div>
  )
}
