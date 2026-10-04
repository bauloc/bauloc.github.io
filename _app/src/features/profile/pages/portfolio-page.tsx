import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { ContactPrompt } from '../components/contact-prompt'
import { PROFILE_MESSAGES } from '../messages'
import { OWN_APPS, PROFESSIONAL_WORK, type Project } from '../portfolio'

const H2 = 'text-[18px] font-semibold wide:text-[22px]'

/**
 * One app: its icon, what it is, and the store link when it is still listed. The icon sits
 * beside the name only; the description runs under both, so a phone keeps the full width
 * for text, and at `wide` it is indented to line up with the name.
 */
function ProjectCard({ project }: { project: Project }) {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  return (
    <li className="bg-profile-card wide:p-6 text-profile-ink rounded-sm p-4">
      <div className="flex items-center gap-4">
        <img
          src={project.icon}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          className="wide:size-16 size-14 shrink-0 rounded-[22%]"
        />
        <div className="min-w-0">
          <h3 className="text-[18px] font-bold">{project.title}</h3>
          <p className="text-profile-on-surface-variant mt-0.5 text-[14px]">
            {[project.context?.[locale], project.platforms].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <div className="wide:pl-20">
        <p className="mt-3 text-[16px]">{project.description[locale]}</p>
        {project.link !== undefined && (
          <a
            href={project.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-profile-primary mt-3 inline-block text-[16px] font-medium whitespace-nowrap underline-offset-4 hover:underline"
          >
            {t.viewOnAppStore}
          </a>
        )}
      </div>
    </li>
  )
}

/**
 * The work itself, in two groups: apps built for employers, and apps built and published
 * alone. Two columns at `wide`, one below.
 */
export function PortfolioPage() {
  const t = useMessages(PROFILE_MESSAGES)
  return (
    <div className="wide:p-8 max-w-[1200px] p-3">
      <p className="wide:text-[26px] text-profile-ink max-w-[760px] text-[20px] leading-snug font-medium">
        {t.portfolioLead}
      </p>

      <h2 className={`${H2} mt-8`}>{t.professionalWork}</h2>
      <ul className="wide:grid-cols-2 mt-4 grid gap-4">
        {PROFESSIONAL_WORK.map((project) => (
          <ProjectCard key={project.title} project={project} />
        ))}
      </ul>

      <h2 className={`${H2} mt-10`}>{t.ownApps}</h2>
      <p className="text-profile-ink mt-1 text-[16px]">{t.ownAppsNote}</p>
      <ul className="wide:grid-cols-2 mt-4 grid gap-4">
        {OWN_APPS.map((project) => (
          <ProjectCard key={project.title} project={project} />
        ))}
      </ul>

      <div className="max-w-[760px]">
        <ContactPrompt />
      </div>
    </div>
  )
}
