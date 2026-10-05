import { House, Smartphone, SquareTerminal, UserRound, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { LanguageToggle } from './language-toggle'
import { SITE_MESSAGES } from './messages'
import { ThemeToggle } from './theme-toggle'

/** Where the site lives, for a page that is not served from the site itself. */
export const SITE_URL = 'https://bauloc.github.io/'

export type SiteSection = 'home' | 'profile' | 'xconsole' | 'device'

/** The site's sections, in the header's order; each path is relative to the site's root. */
const SECTIONS: readonly {
  readonly id: SiteSection
  readonly path: string
  readonly icon: LucideIcon
}[] = [
  { id: 'home', path: '', icon: House },
  { id: 'profile', path: 'profile/', icon: UserRound },
  { id: 'xconsole', path: 'xconsole/', icon: SquareTerminal },
  { id: 'device', path: 'device/', icon: Smartphone },
]

/**
 * The header every page under the home page shares, in two rows.
 *
 * The first is the site's, the same on every page and in both themes: a command line, dark and
 * monospaced, so it reads as the site's own frame and not as part of the page below it. It
 * prompts at the page's path (`bauloc@github.io:~/device $`), and on its right are the sections
 * as icons named by their tooltips (the current one lit green), the language and the theme.
 *
 * The second is the page's own, on the page's ground (`--site-header-bg`): what it is (`title`,
 * a PageTitle), what it reports (`status`, from lg up) and what it offers (`actions`). A page
 * with nothing of its own (the 404) has no second row.
 *
 * The rows are 40 and 48 px, so what sticks below a two-row header starts at `top-22`; the
 * header's bottom edge covers the pixel left over. Every link is a full page load, as between
 * the site's sections anywhere. `base` is where the site is: the helper's own copy of Device
 * Lab is served from 127.0.0.1 and passes SITE_URL.
 */
export function SiteHeader({
  current,
  path,
  leading,
  title,
  status,
  actions,
  base = '/',
  className,
}: {
  /** The page's section; null on a page that is none of them. */
  current: SiteSection | null
  /** The page's own path for the prompt (`/profile/contact`); the section's by default. */
  path?: string
  /** First in the page's row: XConsole's sidebar trigger. */
  leading?: ReactNode
  /** What the page is: a PageTitle. Without it there is no second row. */
  title?: ReactNode
  /** What the page reports beside its title, from lg up: Device Lab's chips. */
  status?: ReactNode
  /** The page's own controls, at the end of its row. */
  actions?: ReactNode
  base?: string
  className?: string
}) {
  const t = useMessages(SITE_MESSAGES)
  const label = (id: SiteSection) => (id === 'home' ? t.home : t.section[id])
  const section = SECTIONS.find((s) => s.id === current)

  return (
    <header
      data-site-header
      className={cn(
        'font-console text-foreground sticky top-0 z-50 w-full border-b bg-[var(--site-header-bg,var(--background))] text-sm tracking-normal',
        className,
      )}
    >
      {/* The site's row: a command line. */}
      <div className="font-terminal flex h-10 items-center gap-2 bg-zinc-950 px-4 text-[13px] text-zinc-300 sm:gap-3 md:px-6 dark:bg-zinc-900">
        <Prompt path={path ?? `/${section?.path ?? ''}`} />

        <TooltipProvider delayDuration={150}>
          <nav aria-label={t.sections} className="ml-auto flex items-center gap-0.5">
            {SECTIONS.map((link) => {
              const Icon = link.icon
              const name = label(link.id)
              return (
                <Tooltip key={link.id}>
                  <TooltipTrigger asChild>
                    <a
                      href={`${base}${link.path}`}
                      aria-label={name}
                      aria-current={link.id === current ? 'page' : undefined}
                      className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-green-400 aria-[current=page]:bg-white/10 aria-[current=page]:text-green-400 sm:size-8"
                    >
                      <Icon aria-hidden="true" className="size-4" />
                    </a>
                  </TooltipTrigger>
                  {/* Portalled into <body>: it carries the header's palette with it. */}
                  <TooltipContent data-site-header side="bottom" className="font-console">
                    {name}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </nav>
        </TooltipProvider>

        <span aria-hidden="true" className="hidden h-4 w-px bg-white/15 sm:block" />
        <LanguageToggle />
        <ThemeToggle className="size-7 text-zinc-300 hover:bg-white/10 hover:text-zinc-50 focus-visible:ring-2 focus-visible:ring-green-400 sm:size-8 dark:hover:bg-white/10" />
      </div>

      {/* The page's row. */}
      {title !== undefined && (
        <div className="flex h-12 items-center gap-3 px-4 md:px-6">
          {leading}
          {title}
          {status !== undefined && (
            <div className="hidden min-w-0 items-center gap-2 lg:flex">{status}</div>
          )}
          {actions !== undefined && (
            <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      )}
    </header>
  )
}

/**
 * `bauloc@github.io:~/device $` and a blinking caret: where the page is, as a shell would say
 * it. On a phone only the path shows, and it gives way first when the row is short of room.
 */
function Prompt({ path }: { path: string }) {
  const dir = `~${path.replace(/\/+$/, '')}`
  return (
    <p className="flex min-w-0 items-center whitespace-nowrap">
      <span className="hidden text-green-400 sm:inline">bauloc@github.io</span>
      <span className="hidden text-zinc-500 sm:inline">:</span>
      <span className="truncate text-sky-400">{dir}</span>
      <span className="ml-1.5 text-zinc-500">$</span>
      <span
        aria-hidden="true"
        className="animate-blink ml-1.5 inline-block h-[1.05em] w-[0.6em] shrink-0 bg-zinc-300"
      />
    </p>
  )
}

/**
 * What a page is, first in its row of the site header: an optional mark, the place it belongs
 * to (`parent`, hidden on a phone) and its own name, as a breadcrumb.
 */
export function PageTitle({
  mark,
  parent,
  children,
}: {
  mark?: ReactNode
  parent?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {mark}
      {parent !== undefined && (
        <>
          <span className="text-muted-foreground hidden shrink-0 sm:inline">{parent}</span>
          <span aria-hidden="true" className="text-muted-foreground/50 hidden sm:inline">
            /
          </span>
        </>
      )}
      <span className="truncate text-[15px] font-semibold tracking-tight">{children}</span>
    </div>
  )
}
