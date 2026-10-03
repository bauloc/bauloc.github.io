import { useSyncExternalStore } from 'react'

/*
  The GitHub token lives in this browser's localStorage and nowhere else — that is the
  console's whole security model, and why .gitignore guards against any token file.

  The key is the legacy console's, so a token saved there keeps working after the port.
*/

const KEY = 'xconsole_pat'
const listeners = new Set<() => void>()

/**
 * The token for THIS page view, used only once storage has failed: reading throws (site data
 * blocked) or saving throws (blocked, or full — old Safari private windows have no quota).
 * Never a fallback for a merely missing key: then logging out in another tab would not log
 * out here. Where saving fails, no other tab can have saved one either.
 */
let unstored = ''
let memoryOnly = false

export function readToken(): string {
  if (memoryOnly) return unstored
  try {
    return window.localStorage.getItem(KEY) ?? ''
  } catch {
    return unstored
  }
}

export function saveToken(token: string) {
  try {
    window.localStorage.setItem(KEY, token.trim())
  } catch {
    // The token works until the page is closed, then the console asks again.
    memoryOnly = true
    unstored = token.trim()
  }
  for (const listener of listeners) listener()
}

export function clearToken() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // As above.
  }
  unstored = ''
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** The saved token, '' when there is none; follows saves, logouts and other tabs. */
export function useToken(): string {
  return useSyncExternalStore(subscribe, readToken, () => '')
}
