import { Link } from '@tanstack/react-router'
import { FileDown, Mail } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'

import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import avatar from '../assets/avatar.jpg'
import { CONTACT_EMAIL } from '../contact'
import { CV_FILE_NAME, CV_NAME, CV_PDF } from '../cv'
import { PROFILE_MESSAGES } from '../messages'
import { PROFILE_MENU, type ProfileMenuItem } from '../profile-menu'
import { BrandIcon } from './brand-icons'

const ICON = 'size-6'

/** Where else to find him, as the reference's row of marks. */
const ELSEWHERE: readonly { name: string; href: string; icon: ReactNode }[] = [
  {
    name: 'GitHub',
    href: 'https://github.com/bauloc',
    icon: <BrandIcon name="github" className={ICON} />,
  },
  {
    name: 'Telegram',
    href: 'https://t.me/bauloc',
    icon: <BrandIcon name="telegram" className={ICON} />,
  },
  {
    name: 'Zalo',
    href: 'https://zalo.me/+84973989634',
    icon: <BrandIcon name="zalo" className={ICON} />,
  },
  {
    name: 'Email',
    href: `mailto:${CONTACT_EMAIL}`,
    icon: <Mail className={ICON} aria-hidden="true" />,
  },
]

const MARK =
  'text-profile-muted hover:text-profile-ink focus-visible:text-profile-ink block transition-colors'

/**
 * The page's left column, after brittanychiang.com: who he is, the sections (the one on screen
 * marked by a long green line), and where else to find him. From lg up it stays put beside the
 * scrolling sections, its marks at the foot; it scrolls itself only when a short window cannot
 * hold it, and that scrolling would clip the portrait's glow at its edge, so the column
 * reaches 3 rem further left than its content. On a phone it is simply the top of the page. A
 * plain block, not a <header>: the site header above is the page's one banner.
 */
export function ProfileIntro({
  active,
  onSelect,
}: {
  active: ProfileMenuItem['id']
  onSelect: (item: ProfileMenuItem, event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  return (
    <div className="lg:sticky lg:top-10 lg:-ml-12 lg:flex lg:max-h-[calc(100dvh-2.5rem)] lg:w-[calc(48%+3rem)] lg:flex-col lg:justify-between lg:overflow-y-auto lg:py-20 lg:pl-12">
      <div>
        {/* A green light runs round the ring (`.avatar-ring`, globals.css). */}
        <div className="avatar-ring size-24 rounded-full p-1">
          <img
            src={avatar}
            alt=""
            width={88}
            height={88}
            className="size-full rounded-full object-cover"
          />
        </div>
        <h1 className="text-profile-ink mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
          {CV_NAME}
        </h1>
        {/* Both of what he is, each on its own line. */}
        <p className="text-profile-ink mt-3 text-lg leading-snug font-medium tracking-tight sm:text-xl">
          <span className="block">{t.role}</span>
          <span className="block">{t.engineer}</span>
        </p>
        <p className="mt-4 max-w-xs leading-normal">{t.aboutLead}</p>

        <nav aria-label={t.sectionsNav} className="hidden lg:block">
          <ul className="mt-12 w-max">
            {PROFILE_MENU.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.to}
                  resetScroll={false}
                  data-active={item.id === active}
                  aria-current={item.id === active ? 'location' : undefined}
                  onClick={(event) => {
                    onSelect(item, event)
                  }}
                  className="group flex items-center py-3"
                >
                  <span className="bg-profile-line group-hover:bg-profile-ink group-focus-visible:bg-profile-ink group-data-[active=true]:bg-profile-tint mr-4 h-px w-8 transition-all group-hover:w-16 group-focus-visible:w-16 group-data-[active=true]:w-16 motion-reduce:transition-none" />
                  <span className="text-profile-muted group-hover:text-profile-ink group-focus-visible:text-profile-ink group-data-[active=true]:text-profile-ink text-xs font-bold tracking-widest uppercase">
                    {t.section[item.id]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <ul aria-label={t.elsewhere} className="mt-8 ml-1 flex items-center">
        {ELSEWHERE.map((link) => (
          <li key={link.name} className="mr-5 shrink-0">
            <a
              href={link.href}
              target={link.href.startsWith('mailto:') ? undefined : '_blank'}
              rel="noopener noreferrer"
              title={link.name}
              className={MARK}
            >
              <span className="sr-only">
                {link.name}
                {link.href.startsWith('mailto:') ? '' : ` ${t.newTab}`}
              </span>
              {link.icon}
            </a>
          </li>
        ))}
        <li className="mr-5 shrink-0">
          <a
            href={CV_PDF[locale]}
            download={CV_FILE_NAME[locale]}
            title={t.downloadCv}
            className={MARK}
          >
            <span className="sr-only">{t.downloadCv}</span>
            <FileDown className={ICON} aria-hidden="true" />
          </a>
        </li>
      </ul>
    </div>
  )
}
