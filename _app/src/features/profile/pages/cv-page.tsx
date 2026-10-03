import '@fontsource/roboto/400.css'
import '@fontsource/roboto/700.css'

import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'

import avatar from '../assets/avatar.jpg'
import { ELEVATED_BUTTON } from '../components/elevated-button'
import {
  CV_CONTACT,
  CV_EDUCATION,
  CV_EXPERIENCE,
  CV_NAME,
  CV_SKILLS,
  CV_SUMMARY,
  CV_TITLE,
} from '../cv'
import { OWN_APPS } from '../portfolio'

/*
  The CV as one A4 page set in the profile's type and teal. The apps built for employers are
  told under Experience, so only the indie apps get their own section. It is a web page first — so the
  CV is its data and cannot drift from the profile — and `npm run cv` prints it to the PDF the
  DOWNLOAD button serves.

  Screen: a white sheet on the rail's grey, with Back and Print above it. Print: the sheet
  alone, with real page margins from @page so a second page would start below its top edge.
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
      className="bg-profile-rail font-profile min-h-dvh py-6 text-black print:bg-white print:py-0"
    >
      <style>{PRINT_CSS}</style>

      <div className="mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between px-4 print:hidden">
        <Link
          to="/profile"
          className="text-profile-primary text-[15px] font-medium hover:underline"
        >
          ← Back to profile
        </Link>
        <button
          type="button"
          onClick={() => {
            window.print()
          }}
          className={ELEVATED_BUTTON}
        >
          Print / Save as PDF
        </button>
      </div>

      <article className="shadow-profile-2 mx-auto w-[210mm] max-w-full bg-white px-[16mm] py-[12mm] text-[9.5pt] leading-[1.4] print:w-auto print:p-0 print:shadow-none">
        <header className="flex items-center gap-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24pt] leading-tight font-bold">{CV_NAME}</h1>
            <p className="text-profile-teal mt-0.5 text-[12pt] font-bold">{CV_TITLE}</p>
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

        <Section title="Summary">
          <p>{CV_SUMMARY}</p>
        </Section>

        <Section title="Skills">
          <dl className="grid grid-cols-[28mm_1fr] gap-x-3 gap-y-1">
            {CV_SKILLS.map((skill) => (
              <div key={skill.area} className="contents">
                <dt className="font-bold">{skill.area}</dt>
                <dd>{skill.items}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Experience">
          <div className="space-y-3">
            {CV_EXPERIENCE.map((job) => (
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

        <Section title="Own apps">
          <ul className="space-y-1">
            {OWN_APPS.map((app) => (
              <li key={app.title} className="break-inside-avoid">
                <span className="font-bold">{app.title}</span>
                <span className="text-profile-on-surface-variant"> ({app.platforms})</span>:{' '}
                {app.description}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Education">
          <div className="space-y-1.5">
            {CV_EDUCATION.map((item) => (
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
