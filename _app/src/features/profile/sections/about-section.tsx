import { Check } from 'lucide-react'

import { useMessages } from '@/lib/i18n'

import { Section } from '../components/section'
import { PROFILE_MESSAGES } from '../messages'

/*
  Written to bring in work: what Loc does, the proof (FPT Play, Tevi, his own apps), and what he
  offers. The words are in messages.ts, where every claim is backed by the Resume, the 2016 CV
  or a live store listing. Plain text, as the reference sets its own.
*/

/** "Cross-platform apps in Flutter: iOS, …": what it is, set apart from its details. */
function Service({ text }: { text: string }) {
  const colon = text.indexOf(':')
  if (colon < 0) return text
  return (
    <>
      <span className="text-profile-ink font-medium">{text.slice(0, colon)}</span>
      {text.slice(colon)}
    </>
  )
}

export function AboutSection() {
  const t = useMessages(PROFILE_MESSAGES)
  return (
    <Section id="about_me" title={t.section.about}>
      {t.about.map((paragraph) => (
        <p key={paragraph} className="mb-4">
          {paragraph}
        </p>
      ))}

      <h3 className="text-profile-ink mt-10 mb-2 font-semibold">{t.helpWith}</h3>
      <p className="mb-5">{t.helpWithLead}</p>
      <ul className="space-y-2.5">
        {t.services.map((service) => (
          <li key={service} className="flex gap-3">
            <Check aria-hidden="true" className="text-profile-tint mt-1.5 size-4 shrink-0" />
            <span>
              <Service text={service} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
