import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

import { useMessages } from '@/lib/i18n'

import { CARD, CARD_GLOW, Section } from '../components/section'
import { PROFILE_MESSAGES } from '../messages'
import { RESUME } from '../resume'

/**
 * The resume as the reference's experience list: newest first, the dates in a quiet column on
 * the left, what happened and its details on the right, each entry lighting up under the
 * pointer. Then the way to the full CV.
 */
export function ResumeSection() {
  const t = useMessages(PROFILE_MESSAGES)
  const resume = useMessages(RESUME)
  return (
    <Section id="resume" title={t.section.resume}>
      <ol className="group/list">
        {[...resume].reverse().map((entry) => (
          <li key={entry.when} className="mb-12">
            <div className={CARD}>
              <div className={CARD_GLOW} />
              <p className="text-profile-muted z-10 mt-1 mb-2 text-xs font-semibold tracking-wide uppercase sm:col-span-2">
                {entry.when}
              </p>
              <div className="z-10 sm:col-span-6">
                <h3 className="text-profile-ink leading-snug font-medium">{entry.what}</h3>
                {entry.details !== undefined && (
                  <ul className="mt-2 space-y-1 text-sm leading-normal">
                    {entry.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <Link
        to="/profile/cv"
        className="text-profile-ink hover:text-profile-primary focus-visible:text-profile-primary group/link inline-flex items-baseline leading-tight font-semibold"
      >
        {t.viewFullCv}
        <ArrowRight
          aria-hidden="true"
          className="ml-1 inline-block size-4 translate-y-0.5 transition-transform group-hover/link:translate-x-1 group-focus-visible/link:translate-x-1 motion-reduce:transition-none"
        />
      </Link>
    </Section>
  )
}
