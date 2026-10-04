import { createHash, createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  browserStores,
  clearToken,
  dropToken,
  memoryStores,
  newChallenge,
  proofOf,
  readRemember,
  readStoredPort,
  readStoredToken,
  saveStoredPort,
  saveToken,
  setRemembered,
  subscribeToken,
  tokenIdOf,
  type StorageLike,
  type TokenStores,
} from './token'

/*
  Where the token lives, and the two hashes the page checks a helper with. The hashes are
  compared with Node's own crypto (what the helper uses), so the page and the helper can't
  drift apart on the message format.
*/

const TOKEN = 'abcdefghijABCDEFGHIJ0123456789_-abcdefghijk'
const entry = (token = TOKEN, port = 8787, tokenId = '01234567') =>
  ({ v: 1, token, port, tokenId }) as const

/** A Map-backed Storage, optionally broken. */
function storage(broken = false): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  const guard = () => {
    if (broken) throw new DOMException('Blocked', 'SecurityError')
  }
  return {
    map,
    getItem: (k) => (guard(), map.get(k) ?? null),
    setItem: (k, v) => {
      guard()
      map.set(k, v)
    },
    removeItem: (k) => {
      guard()
      map.delete(k)
    },
  }
}

describe('the hashes', () => {
  it('tokenIdOf is the first 8 hex of SHA-256, as the helper computes it', async () => {
    expect(await tokenIdOf('example-token')).toBe('4d1566a1')
    expect(await tokenIdOf(TOKEN)).toBe(
      createHash('sha256').update(TOKEN).digest('hex').slice(0, 8),
    )
  })

  it('proofOf is the helper’s HMAC over the port and the challenge', async () => {
    const challenge = 'AAAAAAAAAAAAAAAAAAAAAA'
    const expected = createHmac('sha256', Buffer.from(TOKEN, 'utf8'))
      .update(`bauloc-device-bridge proof v1|8787|${challenge}`, 'utf8')
      .digest('base64url')
    expect(await proofOf(TOKEN, 8787, challenge)).toBe(expected)
    expect(await proofOf(TOKEN, 8788, challenge)).not.toBe(expected)
  })

  it('newChallenge is 16 bytes of base64url, fresh each time', () => {
    const a = newChallenge()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newChallenge()).not.toBe(a)
    expect(newChallenge((b) => b.fill(255))).toBe('_____________________w')
  })
})

describe('storing the token', () => {
  it('keeps it for this tab only by default', () => {
    const session = storage()
    const local = storage()
    const stores: TokenStores = { session, local }
    saveToken(entry(), false, stores)
    expect(readStoredToken(stores)).toEqual({ ...entry(), remembered: false })
    expect(local.map.size).toBe(0)
  })

  it('remembers it on this computer when asked, and updates a remembered one', () => {
    const local = storage()
    const stores: TokenStores = { session: storage(), local }
    saveToken(entry(), true, stores)
    expect(readStoredToken(stores)?.remembered).toBe(true)
    // A new tab (fresh session) pairs anew without the switch: the remembered entry follows.
    const tab2: TokenStores = { session: storage(), local }
    const next = entry('B'.repeat(43), 8787, '89abcdef')
    saveToken(next, false, tab2)
    expect(JSON.parse(local.map.get('dvc_token') ?? '{}')).toMatchObject({ tokenId: '89abcdef' })
  })

  it('a new tab reads the remembered token', () => {
    const local = storage()
    saveToken(entry(), true, { session: storage(), local })
    expect(readStoredToken({ session: storage(), local })).toEqual({ ...entry(), remembered: true })
  })

  it('the switch copies the tab’s token there, or removes it', () => {
    const stores: TokenStores = { session: storage(), local: storage() }
    saveToken(entry(), false, stores)
    setRemembered(true, stores)
    expect(readStoredToken(stores)?.remembered).toBe(true)
    setRemembered(false, stores)
    expect(readStoredToken(stores)).toEqual({ ...entry(), remembered: false })
  })

  it('keeps the Remember choice when a stale token is dropped, so the next pairing is remembered', () => {
    const local = storage()
    const stores: TokenStores = { session: storage(), local }
    saveToken(entry(), true, stores)
    // The helper restarted: its old token goes, from both stores.
    dropToken(TOKEN, stores)
    expect(readStoredToken(stores)).toBeNull()
    expect(readRemember(stores)).toBe(true)
    // The next pairing passes no switch of its own (a #pair= link): it is remembered anyway.
    const next = entry('B'.repeat(43), 8787, '89abcdef')
    saveToken(next, false, stores)
    expect(readStoredToken(stores)).toEqual({ ...next, remembered: true })
    expect(readStoredToken({ session: storage(), local })?.token).toBe(next.token)
  })

  it('reads a token remembered before the choice had its key as on, and keeps it on', () => {
    const local = storage()
    const stores: TokenStores = { session: storage(), local }
    local.map.set('dvc_token', JSON.stringify(entry()))
    expect(readRemember(stores)).toBe(true)
    dropToken(TOKEN, stores)
    expect(local.map.get('dvc_remember')).toBe('1')
    expect(readRemember(stores)).toBe(true)
  })

  it('only the tester turns Remember off; forgetting the pairing leaves the choice', () => {
    const stores: TokenStores = { session: storage(), local: storage() }
    expect(readRemember(stores)).toBe(false)
    setRemembered(true, stores)
    expect(readRemember(stores)).toBe(true)
    clearToken(stores)
    expect(readRemember(stores)).toBe(true)
    setRemembered(false, stores)
    expect(readRemember(stores)).toBe(false)
    saveToken(entry(), false, stores)
    expect(readStoredToken(stores)?.remembered).toBe(false)
  })

  it('forget clears both', () => {
    const stores: TokenStores = { session: storage(), local: storage() }
    saveToken(entry(), true, stores)
    clearToken(stores)
    expect(readStoredToken(stores)).toBeNull()
  })

  it('ignores entries that aren’t exactly ours', () => {
    const session = storage()
    const stores: TokenStores = { session, local: storage() }
    for (const text of [
      'not json',
      '{"v":2,"token":"' + TOKEN + '","port":8787,"tokenId":"01234567"}',
      '{"v":1,"token":"short","port":8787,"tokenId":"01234567"}',
      '{"v":1,"token":"' + TOKEN + '","port":80,"tokenId":"01234567"}',
      '{"v":1,"token":"' + TOKEN + '","port":8787,"tokenId":"XYZ"}',
    ]) {
      session.map.set('dvc_token', text)
      expect(readStoredToken(stores)).toBeNull()
    }
  })

  it('never sits next to the console’s GitHub token', () => {
    const local = storage()
    saveToken(entry(), true, { session: storage(), local })
    expect([...local.map.keys()].sort()).toEqual(['dvc_remember', 'dvc_token'])
  })

  it('falls back to memory when storage throws, for the rest of the page view', () => {
    // memoryStores() is the same resilient store with no browser behind it.
    const stores = memoryStores()
    saveToken(entry(), true, stores)
    expect(readStoredToken(stores)).toEqual({ ...entry(), remembered: true })
  })

  it('a store that starts throwing keeps working from memory', () => {
    vi.stubGlobal('window', {
      sessionStorage: storage(true),
      localStorage: storage(true),
    })
    try {
      const stores = browserStores()
      saveToken(entry(), false, stores)
      expect(readStoredToken(stores)?.token).toBe(TOKEN)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('dvc_port', () => {
  it('is written only for a non-default port', () => {
    const stores: TokenStores = { session: storage(), local: storage() }
    expect(readStoredPort(stores)).toBeNull()
    saveStoredPort(8788, stores)
    expect(readStoredPort(stores)).toBe(8788)
    saveStoredPort(8787, stores)
    expect(readStoredPort(stores)).toBeNull()
  })
})

describe('subscribeToken', () => {
  it('fires for dvc_token changes from other tabs, and for a cleared store', () => {
    const target = new EventTarget()
    const listener = vi.fn()
    const off = subscribeToken(listener, target)
    const storageEvent = (key: string | null) => Object.assign(new Event('storage'), { key })
    target.dispatchEvent(storageEvent('dvc_token'))
    target.dispatchEvent(storageEvent('xconsole_pat'))
    target.dispatchEvent(storageEvent(null))
    // Another tab switched Remember: this tab's switch follows.
    target.dispatchEvent(storageEvent('dvc_remember'))
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    target.dispatchEvent(storageEvent('dvc_token'))
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
