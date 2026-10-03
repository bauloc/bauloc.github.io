import { ContactPrompt } from '../components/contact-prompt'
import { OWN_APPS, PROFESSIONAL_WORK, type Project } from '../portfolio'

const H2 = 'text-[18px] font-semibold wide:text-[22px]'

/**
 * One app: its icon, what it is, and the store link when it is still listed. The icon sits
 * beside the name only; the description runs under both, so a phone keeps the full width
 * for text, and at `wide` it is indented to line up with the name.
 */
function ProjectCard({ project }: { project: Project }) {
  return (
    <li className="bg-profile-teal-50 wide:p-6 rounded-sm p-4 text-black">
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
            {[project.context, project.platforms].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <div className="wide:pl-20">
        <p className="mt-3 text-[16px]">{project.description}</p>
        {project.link !== undefined && (
          <a
            href={project.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-profile-primary mt-3 inline-block text-[16px] font-medium whitespace-nowrap underline-offset-4 hover:underline"
          >
            View on the App Store ↗
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
  return (
    <div className="wide:p-8 max-w-[1200px] p-3">
      <p className="wide:text-[26px] max-w-[760px] text-[20px] leading-snug font-medium text-black">
        Apps I have built over the past ten years: for FPT Telecom and Tevi, and under my own name.
      </p>

      <h2 className={`${H2} mt-8`}>Professional work</h2>
      <ul className="wide:grid-cols-2 mt-4 grid gap-4">
        {PROFESSIONAL_WORK.map((project) => (
          <ProjectCard key={project.title} project={project} />
        ))}
      </ul>

      <h2 className={`${H2} mt-10`}>My own apps</h2>
      <p className="mt-1 text-[16px] text-black">
        Designed, built and published on my own developer account. Some of the older ones are no
        longer on the stores.
      </p>
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
