import { FileCode2, FileText, Package, Tv, type LucideIcon } from 'lucide-react'

/**
 * The console's modules, in sidebar order. A new module is one entry here, its title and
 * description in messages.tsx, and its route.
 */
export interface ConsoleModule {
  /** Names the module in XCONSOLE_MESSAGES.module, where its words are in both languages. */
  readonly id: 'termPrivacy' | 'iptv' | 'artifacts' | 'builds'
  readonly to:
    '/xconsole/term-privacy' | '/xconsole/iptv' | '/xconsole/artifacts' | '/xconsole/builds'
  readonly icon: LucideIcon
  /** The legacy console addressed modules by hash (`/xconsole/#iptv`); newer modules never were. */
  readonly legacyHash?: string
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
  {
    id: 'artifacts',
    to: '/xconsole/artifacts',
    icon: FileCode2,
  },
  {
    id: 'builds',
    to: '/xconsole/builds',
    icon: Package,
  },
] as const satisfies readonly ConsoleModule[]

/** The module a path shows. `/xconsole/` itself opens the first one, as the legacy console did. */
export function moduleFor(pathname: string): ConsoleModule {
  const path = pathname.replace(/\/+$/, '')
  return CONSOLE_MODULES.find((m) => m.to === path) ?? CONSOLE_MODULES[0]
}
