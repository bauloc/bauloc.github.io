import { FileText, Tv, type LucideIcon } from 'lucide-react'

/** The console's modules, in sidebar order. A new module is one entry here plus its route. */
export interface ConsoleModule {
  readonly title: string
  readonly description: string
  readonly to: '/xconsole/term-privacy' | '/xconsole/iptv'
  readonly icon: LucideIcon
  /** The legacy console addressed modules by hash (`/xconsole/#iptv`). */
  readonly legacyHash: string
}

export const CONSOLE_MODULES = [
  {
    title: 'Term & Privacy',
    description: 'Legal pages for App Store and Google Play submissions.',
    to: '/xconsole/term-privacy',
    icon: FileText,
    legacyHash: '#term-privacy',
  },
  {
    title: 'IPTV',
    description: 'Mirror an upstream M3U playlist to bauloc.github.io/iptv.',
    to: '/xconsole/iptv',
    icon: Tv,
    legacyHash: '#iptv',
  },
] as const satisfies readonly ConsoleModule[]

/** The module a path shows. `/xconsole/` itself opens the first one, as the legacy console did. */
export function moduleFor(pathname: string): ConsoleModule {
  const path = pathname.replace(/\/+$/, '')
  return CONSOLE_MODULES.find((m) => m.to === path) ?? CONSOLE_MODULES[0]
}
