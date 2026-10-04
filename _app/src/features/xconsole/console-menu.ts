import { FileText, Tv, type LucideIcon } from 'lucide-react'

/**
 * The console's modules, in sidebar order. A new module is one entry here, its title and
 * description in messages.tsx, and its route.
 */
export interface ConsoleModule {
  /** Names the module in XCONSOLE_MESSAGES.module, where its words are in both languages. */
  readonly id: 'termPrivacy' | 'iptv'
  readonly to: '/xconsole/term-privacy' | '/xconsole/iptv'
  readonly icon: LucideIcon
  /** The legacy console addressed modules by hash (`/xconsole/#iptv`). */
  readonly legacyHash: string
}

export const CONSOLE_MODULES = [
  {
    id: 'termPrivacy',
    to: '/xconsole/term-privacy',
    icon: FileText,
    legacyHash: '#term-privacy',
  },
  {
    id: 'iptv',
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
