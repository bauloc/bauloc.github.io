import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { CV_FILE_NAME, CV_PDF } from '../cv'
import { PROFILE_MESSAGES } from '../messages'
import { ELEVATED_BUTTON } from './elevated-button'

/**
 * The close of About me and Portfolio: who the work is for, and the way to Contact. Set on
 * the contact cards' teal tint, so it reads as the same family as the cards it leads to.
 */
export function ContactPrompt({ children }: { children?: ReactNode }) {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  return (
    <section className="bg-profile-card wide:p-6 text-profile-ink mt-10 rounded-sm p-4">
      <h2 className="wide:text-[22px] text-[18px] font-semibold">{t.workTogether}</h2>
      <p className="mt-2 text-[16px]">{t.workTogetherBody}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link to="/profile/contact" className={ELEVATED_BUTTON}>
          {t.contactMe}
        </Link>
        {children}
        {/* The side panel's DOWNLOAD is hidden below `wide`, so phones get the CV here. */}
        <a
          href={CV_PDF[locale]}
          download={CV_FILE_NAME[locale]}
          className="text-profile-primary text-[16px] font-medium underline-offset-4 hover:underline"
        >
          {t.downloadCv}
        </a>
      </div>
    </section>
  )
}
