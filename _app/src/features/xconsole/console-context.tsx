import { createContext, useContext } from 'react'

import type { Repo } from './repo/github'

export interface ConsoleContextValue {
  /** The repository every module reads and commits to: GitHub, or the dev mock. */
  readonly repo: Repo
  readonly mock: boolean
  /** Ask for a new token — after GitHub refused the current one, or from Settings. */
  readonly openSettings: () => void
}

export const ConsoleContext = createContext<ConsoleContextValue | null>(null)

/** For module pages: they render only inside the layout, once a repository is ready. */
export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext)
  if (value === null) throw new Error('useConsole() outside the XConsole layout')
  return value
}
