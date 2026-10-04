import '@fontsource-variable/geist'

import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { HomeButton } from '@/components/home-button'
import { LanguageToggle } from '@/components/language-toggle'
import { ThemeToggle } from '@/components/theme-toggle'
import { Toaster } from '@/components/toaster'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useMessages } from '@/lib/i18n'

import { AppSidebar } from './components/app-sidebar'
import { TokenDialog } from './components/token-dialog'
import { ConsoleContext, type ConsoleContextValue } from './console-context'
import { CONSOLE_MODULES, moduleFor } from './console-menu'
import { XCONSOLE_MESSAGES } from './messages'
import { readToken, useToken } from './repo/token'
import { isMockMode, useRepo } from './repo/use-repo'

/**
 * `/xconsole/` — the console's shell, after shadcn/ui's dashboard: a collapsible sidebar of
 * modules, a sticky header, and the module on the right. The header leads back to the site's
 * home page and ends with the language and the theme, both the site's own choices
 * (src/lib/locale.ts, src/lib/theme.ts).
 *
 * Without a token the console can do nothing, so it asks for one before showing a module.
 */
export function XConsoleLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const current = moduleFor(pathname)
  const t = useMessages(XCONSOLE_MESSAGES)
  const title = t.module[current.id].title
  const navigate = useNavigate()
  const repo = useRepo()
  const token = useToken()
  const mock = isMockMode()
  /**
   * The token Settings was opened for, or null when closed. Settings shows only while that is
   * still the token, so a logout in another tab closes it instead of leaving the old token in
   * its field, one Save away from being written back.
   */
  const [settingsFor, setSettingsFor] = useState<string | null>(null)

  // The legacy console addressed modules by hash; keep those bookmarks working.
  useEffect(() => {
    const legacy = CONSOLE_MODULES.find((m) => m.legacyHash === window.location.hash)
    if (legacy) void navigate({ to: legacy.to, replace: true })
  }, [navigate])

  useEffect(() => {
    const previous = document.title
    document.title = `${title} · XConsole`
    return () => {
      document.title = previous
    }
  }, [title])

  const context = useMemo<ConsoleContextValue | null>(
    () =>
      repo === null
        ? null
        : {
            repo,
            mock,
            openSettings: () => {
              setSettingsFor(readToken())
            },
          },
    [repo, mock],
  )

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider data-page="xconsole" data-shell="console">
        <AppSidebar
          current={current}
          onOpenSettings={() => {
            setSettingsFor(readToken())
          }}
        />
        <SidebarInset>
          <header className="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
            <HomeButton />
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <nav
              aria-label="Breadcrumb"
              className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm"
            >
              <span className="hidden sm:inline">XConsole</span>
              <span aria-hidden="true" className="hidden sm:inline">
                /
              </span>
              <span className="text-foreground truncate font-medium">{title}</span>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {mock && (
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
                >
                  <FlaskConical />
                  {t.mock}
                  <span className="hidden md:inline">{t.mockDetail}</span>
                </Badge>
              )}
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </header>

          <div className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6 lg:p-8">
            {context === null ? (
              <div className="space-y-4" aria-hidden="true">
                <Skeleton className="h-8 w-56" />
                <Skeleton className="h-4 w-80" />
                <Skeleton className="h-40 w-full rounded-xl" />
              </div>
            ) : (
              <ConsoleContext.Provider value={context}>
                <Outlet />
              </ConsoleContext.Provider>
            )}
          </div>
        </SidebarInset>

        {/* Mounted only while needed, so after Log out it starts empty — never pre-filled with the
            token that was just logged out. */}
        {!mock && token === '' && <TokenDialog mode="connect" open onClose={() => undefined} />}
        {settingsFor !== null && settingsFor === token && (
          <TokenDialog
            mode="settings"
            open
            onClose={() => {
              setSettingsFor(null)
            }}
          />
        )}
        <Toaster />
      </SidebarProvider>
    </TooltipProvider>
  )
}
