import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { ELEVATED_BUTTON } from './elevated-button'

/**
 * The close of About me and Portfolio: who the work is for, and the way to Contact. Set on
 * the contact cards' teal tint, so it reads as the same family as the cards it leads to.
 */
export function ContactPrompt({ children }: { children?: ReactNode }) {
  return (
    <section className="bg-profile-teal-50 wide:p-6 mt-10 rounded-sm p-4 text-black">
      <h2 className="wide:text-[22px] text-[18px] font-semibold">Let&apos;s work together</h2>
      <p className="mt-2 text-[16px]">
        I&apos;m available for freelance and contract projects. Whether it&apos;s a new app, a
        feature for an existing one, or an app that needs rescuing, tell me what you&apos;re
        building and I&apos;ll get back to you as soon as possible.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link to="/profile/contact" className={ELEVATED_BUTTON}>
          Contact me
        </Link>
        {children}
      </div>
    </section>
  )
}
