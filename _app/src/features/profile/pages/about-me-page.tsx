import { Link } from '@tanstack/react-router'

import { useMessages } from '@/lib/i18n'

import { ContactPrompt } from '../components/contact-prompt'
import { MaterialIcon } from '../components/material-icon'
import { PROFILE_MESSAGES } from '../messages'

/*
  Written to bring in work: what Loc does, the proof (FPT Play, Tevi, his own apps), and the
  way to reach him. The words are in messages.ts, where every claim is backed by the Resume
  page, the 2016 CV or a live store listing.
*/

const H2 = 'mt-8 text-[18px] font-semibold wide:text-[22px]'

export function AboutMePage() {
  const t = useMessages(PROFILE_MESSAGES)
  return (
    <div className="wide:p-8 text-profile-ink max-w-[760px] p-3 text-[16px]">
      <p className="wide:text-[26px] text-[20px] leading-snug font-medium">{t.aboutLead}</p>

      <div className="mt-6 space-y-4">
        {t.about.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>

      <h2 className={H2}>{t.helpWith}</h2>
      <ul className="mt-3 space-y-2">
        {t.services.map((service) => (
          <li key={service} className="flex gap-3">
            <MaterialIcon name="check" className="text-profile-teal mt-[-1px] shrink-0" />
            {service}
          </li>
        ))}
      </ul>

      <ContactPrompt>
        <Link
          to="/profile/portfolio"
          className="text-profile-primary text-[16px] font-medium underline-offset-4 hover:underline"
        >
          {t.seeWork}
        </Link>
      </ContactPrompt>
    </div>
  )
}
