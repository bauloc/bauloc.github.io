import '@fontsource/roboto/400.css'
import '@fontsource/roboto/700.css'

import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import avatar from '../assets/avatar.jpg'
import { ELEVATED_BUTTON } from '../components/elevated-button'
import { LanguageSegments, ThemeButton } from '../components/top-bar'
import { CV, CV_CONTACT, CV_NAME } from '../cv'
import { PROFILE_MESSAGES } from '../messages'
import { OWN_APPS } from '../portfolio'

/*
  The CV as one A4 page set in the profile's type and teal. The apps built for employers are
  told under Experience, so only the indie apps get their own section. It is a web page first — so the
  CV is its data and cannot drift from the profile — and `npm run cv` prints it to the PDF the
  DOWNLOAD button serves.

  Screen: a white sheet on the rail's grey, with Back, the language, the theme and Print
  above it. The sheet stays white in dark mode (`data-paper` keeps the profile's light
  colours inside it): it is paper. Print: the sheet alone, with real page margins from @page
  so a second page would start below its top edge. `npm run cv` prints it once per language.
*/

const PRINT_CSS = '@page { size: A4; margin: 12mm 16mm; }'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className="text-profile-teal border-profile-teal/40 border-b pb-1 text-[9pt] font-bold tracking-[0.12em] uppercase">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  )
}

export function CvPage() {
  const cv = useMessages(CV)
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()

  useEffect(() => {
    const previous = document.title
    document.title = `${CV_NAME} — CV`
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div
      data-page="profile"
      className="bg-profile-rail font-profile text-profile-ink min-h-dvh py-6 print:bg-white print:py-0"
    >
      <style>{PRINT_CSS}</style>

      <div className="mx-auto mb-4 flex w-[210mm] max-w-full flex-wrap items-center justify-between gap-3 px-4 print:hidden">
        <Link
          to="/profile"
          className="text-profile-primary text-[15px] font-medium hover:underline"
        >
          {t.backToProfile}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSegments />
          <ThemeButton />
          <button
            type="button"
            onClick={() => {
              window.print()
            }}
            className={ELEVATED_BUTTON}
          >
            {t.print}
          </button>
        </div>
      </div>

      <article
        data-paper
        lang={locale}
        className="shadow-profile-2 mx-auto w-[210mm] max-w-full bg-white px-[16mm] py-[12mm] text-[9.5pt] leading-[1.4] text-black print:w-auto print:p-0 print:shadow-none"
      >
        <header className="flex items-center gap-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24pt] leading-tight font-bold">{CV_NAME}</h1>
            <p className="text-profile-teal mt-0.5 text-[12pt] font-bold">{cv.title}</p>
            <p className="text-profile-on-surface-variant mt-2 text-[8.5pt]">
              {CV_CONTACT.map((item, index) => (
                <span key={item.href}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  <a href={item.href} className="hover:underline">
                    {item.label}
                  </a>
                </span>
              ))}
            </p>
          </div>
          <img
            src={avatar}
            alt=""
            width={88}
            height={88}
            className="border-profile-teal size-[22mm] shrink-0 rounded-full border-2 object-cover"
          />
        </header>

        <Section title={cv.sections.summary}>
          <p>{cv.summary}</p>
        </Section>

        <Section title={cv.sections.skills}>
          <dl className="grid grid-cols-[28mm_1fr] gap-x-3 gap-y-1">
            {cv.skills.map((skill) => (
              <div key={skill.area} className="contents">
                <dt className="font-bold">{skill.area}</dt>
                <dd>{skill.items}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title={cv.sections.experience}>
          <div className="space-y-3">
            {cv.experience.map((job) => (
              <div key={job.company} className="break-inside-avoid">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="font-bold">
                    {job.role} <span className="font-normal">— {job.company}</span>
                  </h3>
                  <span className="text-profile-on-surface-variant shrink-0 text-[8.5pt]">
                    {job.period}
                  </span>
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {job.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        <Section title={cv.sections.ownApps}>
          <ul className="space-y-1">
            {OWN_APPS.map((app) => (
              <li key={app.title} className="break-inside-avoid">
                <span className="font-bold">{app.title}</span>
                <span className="text-profile-on-surface-variant"> ({app.platforms})</span>:{' '}
                {app.description[locale]}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={cv.sections.education}>
          <div className="space-y-1.5">
            {cv.education.map((item) => (
              <div key={item.school} className="flex items-baseline justify-between gap-4">
                <p>
                  <span className="font-bold">{item.school}</span>
                  <br />
                  {item.detail}
                </p>
                <span className="text-profile-on-surface-variant shrink-0 text-[8.5pt]">
                  {item.period}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </article>
    </div>
  )
}
