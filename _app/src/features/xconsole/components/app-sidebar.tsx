import { Link } from '@tanstack/react-router'
import { GitBranch, Settings } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useMessages } from '@/lib/i18n'

import { CONSOLE_MODULES, type ConsoleModule } from '../console-menu'
import { XCONSOLE_MESSAGES } from '../messages'
import { REPO } from '../repo/github'

/** shadcn's collapsible sidebar: the modules, then the repository and Settings at the foot. */
export function AppSidebar({
  current,
  onOpenSettings,
}: {
  current: ConsoleModule
  onOpenSettings: () => void
}) {
  // On a phone the sidebar is a sheet over the page: close it once something is chosen.
  const { setOpenMobile } = useSidebar()
  const t = useMessages(XCONSOLE_MESSAGES)
  return (
    // Below the site header (--header-height, set by the layout), not over it.
    <Sidebar
      collapsible="icon"
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/" title="bauloc.github.io">
                <span className="bg-sidebar-primary text-sidebar-primary-foreground grid aspect-square size-8 place-items-center rounded-lg text-base font-bold">
                  X
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">XConsole</span>
                  <span className="text-muted-foreground truncate text-xs">bauloc.github.io</span>
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t.modules}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {CONSOLE_MODULES.map((module) => (
                <SidebarMenuItem key={module.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={module.to === current.to}
                    tooltip={t.module[module.id].title}
                  >
                    <Link
                      to={module.to}
                      onClick={() => {
                        setOpenMobile(false)
                      }}
                    >
                      <module.icon />
                      <span>{t.module[module.id].title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t.repository}>
              <a href={`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer">
                <GitBranch />
                <span className="truncate">{REPO}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t.settings}
              onClick={() => {
                setOpenMobile(false)
                onOpenSettings()
              }}
            >
              <Settings />
              <span>{t.settings}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
