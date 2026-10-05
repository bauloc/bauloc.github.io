import { ArrowUpRight } from 'lucide-react'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { CARD, CARD_GLOW, GROUP_LABEL, Section, Tag } from '../components/section'
import { PROFILE_MESSAGES } from '../messages'
import { OWN_APPS, PROFESSIONAL_WORK, type Project } from '../portfolio'

/**
 * One app, as the reference's project card: its icon beside it, the name (a link to its store
 * listing when it is still there, the whole card then clickable), who it was for, what it is,
 * and its platforms as tags.
 */
function ProjectCard({ project }: { project: Project }) {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  const name = (
    <span className="text-profile-ink text-base leading-tight font-medium">{project.title}</span>
  )
  return (
    <li className="mb-12">
      <div className={CARD}>
        <div className={CARD_GLOW} />
        <div className="z-10 sm:order-2 sm:col-span-6">
          <h4>
            {project.link === undefined ? (
              name
            ) : (
              <a
                href={project.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-profile-ink hover:text-profile-primary focus-visible:text-profile-primary group/link inline-flex items-baseline text-base leading-tight font-medium"
              >
                {/* Stretches the link over the card, as the reference does. */}
                <span className="absolute -inset-x-4 -inset-y-2.5 hidden rounded md:-inset-x-6 md:-inset-y-4 lg:block" />
                <span>
                  {project.title}
                  <ArrowUpRight
                    aria-hidden="true"
                    className="ml-1 inline-block size-4 translate-y-px transition-transform group-hover/link:translate-x-1 group-hover/link:-translate-y-1 group-focus-visible/link:translate-x-1 group-focus-visible/link:-translate-y-1 motion-reduce:transition-none"
                  />
                  <span className="sr-only"> {t.newTab}</span>
                </span>
              </a>
            )}
          </h4>
          {project.context !== undefined && (
            <p className="text-profile-muted mt-1 text-sm">{project.context[locale]}</p>
          )}
          <p className="mt-2 text-sm leading-normal">{project.description[locale]}</p>
          <ul aria-label={t.platforms} className="mt-2 flex flex-wrap">
            {project.platforms.split(', ').map((platform) => (
              <Tag key={platform}>{platform}</Tag>
            ))}
          </ul>
        </div>
        <img
          src={project.icon}
          alt=""
          width={80}
          height={80}
          loading="lazy"
          className="border-profile-line/60 group-hover:border-profile-line z-10 size-16 rounded-[22%] border-2 transition sm:order-1 sm:col-span-2 sm:size-20 sm:translate-y-1"
        />
      </div>
    </li>
  )
}

/** The work: apps built for employers, then apps built and published alone. */
export function PortfolioSection() {
  const t = useMessages(PROFILE_MESSAGES)
  return (
    <Section id="portfolio" title={t.section.portfolio}>
      <p className="mb-12">{t.portfolioLead}</p>

      <h3 className={GROUP_LABEL}>{t.professionalWork}</h3>
      <ul className="group/list">
        {PROFESSIONAL_WORK.map((project) => (
          <ProjectCard key={project.title} project={project} />
        ))}
      </ul>

      <h3 className={`${GROUP_LABEL} mt-16 mb-2`}>{t.ownApps}</h3>
      <p className="mb-8 text-sm">{t.ownAppsNote}</p>
      <ul className="group/list">
        {OWN_APPS.map((project) => (
          <ProjectCard key={project.title} project={project} />
        ))}
      </ul>
    </Section>
  )
}
