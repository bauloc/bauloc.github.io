import { useEffect, useMemo, useState } from 'react'

import { gitHubRepo, type Repo } from './github'
import { useToken } from './token'

const MOCK_KEY = 'xconsole_mock'

/**
 * `?mock` in the dev server swaps GitHub for an in-memory copy (mock-repo.ts), for the rest
 * of the tab's session — moving between modules drops the query string. `?mock=0` ends it.
 */
export function isMockMode(): boolean {
  if (!import.meta.env.DEV) return false
  const param = new URLSearchParams(window.location.search).get('mock')
  try {
    if (param === '0') window.sessionStorage.removeItem(MOCK_KEY)
    else if (param !== null) window.sessionStorage.setItem(MOCK_KEY, '1')
    return window.sessionStorage.getItem(MOCK_KEY) === '1'
  } catch {
    return param !== null && param !== '0'
  }
}

/**
 * The repository the console talks to: GitHub with the saved token, or the mock. `null` while
 * there is no token (the console asks for one) or the mock is still loading.
 */
export function useRepo(): Repo | null {
  const token = useToken()
  const github = useMemo(() => (token === '' ? null : gitHubRepo(token)), [token])
  const [mock, setMock] = useState<Repo | null>(null)

  useEffect(() => {
    if (!isMockMode()) return
    let live = true
    // Behind DEV, so production builds tree-shake the mock away entirely.
    if (import.meta.env.DEV) {
      void import('./mock-repo').then(({ mockRepo }) => {
        if (live) setMock(mockRepo())
      })
    }
    return () => {
      live = false
    }
  }, [])

  return isMockMode() ? mock : github
}
