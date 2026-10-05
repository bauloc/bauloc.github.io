import '@fontsource-variable/geist'

import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { LanguageToggle } from './language-toggle'
import { SITE_MESSAGES } from './messages'
import { ThemeToggle } from './theme-toggle'

/** Where the site lives, for a page that is not served from the site itself. */
export const SITE_URL = 'https://bauloc.github.io/'

export type SiteSection = 'home' | 'profile' | 'xconsole' | 'device'

/** The site's sections, in the header's order; each path is relative to the site's root. */
const SECTIONS: readonly { readonly id: SiteSection; readonly path: string }[] = [
  { id: 'home', path: '' },
  { id: 'profile', path: 'profile/' },
  { id: 'xconsole', path: 'xconsole/' },
  { id: 'device', path: 'device/' },
]

/**
 * The header every page under the home page shares, after ui.shadcn.com's own: the site's
 * sections as ghost buttons (Home first, the current one in the accent colour), then the
 * page's own controls, the language and the theme. On a phone the sections fold into a menu
 * named after the current one.
 *
 * It wears the console palette and face on every page, the Profile's Material one included
 * (theme.css scopes them to `[data-site-header]`), so it looks the same everywhere. Two things
 * follow the page: its ground (`--site-header-bg`) and the current section's colour
 * (`--site-header-accent`: the Profile's teal, the index's blue; the console indigo otherwise).
 * 56 px tall (`top-14` below it).
 *
 * Every link is a full page load, as between the site's sections anywhere. `base` is where the
 * site is: the helper's own copy of Device Lab is served from 127.0.0.1 and passes SITE_URL.
 */
export function SiteHeader({
  current,
  leading,
  actions,
  base = '/',
  className,
}: {
  /** The page's section; null on a page that is none of them. */
  current: SiteSection | null
  /** Before the sections: XConsole's sidebar trigger. */
  leading?: ReactNode
  /** The page's own controls, before the language. */
  actions?: ReactNode
  base?: string
  className?: string
}) {
  const t = useMessages(SITE_MESSAGES)
  const label = (id: SiteSection) => (id === 'home' ? t.home : t.section[id])
  const links = SECTIONS.map((section) => ({
    ...section,
    href: `${base}${section.path}`,
    label: label(section.id),
    current: section.id === current,
  }))

  return (
    <header
      data-site-header
      className={cn(
        'font-console text-foreground sticky top-0 z-50 w-full border-b bg-[var(--site-header-bg,var(--background))] text-sm tracking-normal',
        className,
      )}
    >
      <div className="flex h-14 items-center gap-2 px-4 md:px-6">
        {leading}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              // Named "Menu: <section>"; its text is the section alone.
              aria-label={current ? `${t.menu}: ${label(current)}` : undefined}
              className="-ml-2 h-8 gap-2.5 px-2 md:hidden"
            >
              {/* shadcn's two-bar menu mark. */}
              <span aria-hidden="true" className="relative size-4">
                <span className="bg-foreground absolute top-1 left-0 h-0.5 w-4" />
                <span className="bg-foreground absolute top-2.5 left-0 h-0.5 w-4" />
              </span>
              <span className="text-[15px] font-medium">{current ? label(current) : t.menu}</span>
            </Button>
          </DropdownMenuTrigger>
          {/* Portalled into <body>: it carries the header's palette with it. */}
          <DropdownMenuContent data-site-header align="start" className="font-console w-48">
            {links.map((link) => (
              <DropdownMenuItem key={link.id} asChild>
                <a
                  href={link.href}
                  aria-current={link.current ? 'page' : undefined}
                  className="font-medium aria-[current=page]:text-[var(--site-header-accent,var(--primary))]"
                >
                  {link.label}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <nav aria-label={t.sections} className="hidden items-center md:flex">
          {links.map((link) => (
            <Button key={link.id} variant="ghost" size="sm" asChild>
              <a
                href={link.href}
                title={link.id === 'home' ? t.homeTitle : undefined}
                aria-current={link.current ? 'page' : undefined}
                className="text-foreground/80 hover:text-foreground px-2.5 aria-[current=page]:text-[var(--site-header-accent,var(--primary))]"
              >
                {link.label}
              </a>
            </Button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {actions}
          {actions ? (
            <Separator
              orientation="vertical"
              className="hidden data-[orientation=vertical]:h-4 sm:block"
            />
          ) : null}
          <LanguageToggle />
          <Separator
            orientation="vertical"
            className="hidden data-[orientation=vertical]:h-4 sm:block"
          />
          <ThemeToggle className="size-8" />
        </div>
      </div>
    </header>
  )
}
