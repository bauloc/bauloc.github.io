import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { PROFILE_MESSAGES } from '../messages'
import { PROFILE_MENU, type ProfileMenuItem } from '../profile-menu'
import { MaterialIcon } from './material-icon'

/**
 * The menu down the left edge: 79 px wide on a small screen and 100 px at `wide`, one 79 px
 * item per section. The current one gets a teal tint and a 4 px teal bar on its left edge —
 * the bar's lane is always there, so the icon and label sit at the same place either way.
 */
export function NavRail({ current }: { current: ProfileMenuItem }) {
  const t = useMessages(PROFILE_MESSAGES)
  return (
    <nav
      aria-label={t.nav}
      className="bg-profile-rail wide:w-[100px] sticky top-0 h-dvh w-[79px] shrink-0 self-start"
    >
      <ul>
        {PROFILE_MENU.map((item) => {
          const active = item.to === current.to
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'text-profile-on-surface relative flex h-[79px] flex-col items-center justify-center gap-1.5 pl-1 text-center text-[15px] leading-5 no-underline transition-colors',
                  'hover:bg-profile-ink/[0.04] active:bg-profile-ink/10 focus-visible:-outline-offset-2',
                  active && 'bg-profile-teal/30 hover:bg-profile-teal/30 font-medium',
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="bg-profile-teal absolute inset-y-0 left-0 w-1"
                  />
                )}
                <MaterialIcon name={item.icon} className="text-profile-ink/87" />
                {t.section[item.id]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
