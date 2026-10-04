import { describe, expect, it, vi } from 'vitest'

import {
  capturePairFragment,
  clearPendingPair,
  parsePairFragment,
  parsePairInput,
  readPendingPair,
  takePairFragment,
  type FragmentWindow,
} from './pair-fragment'
import { resolvePort } from './env'
import { memoryStores, readStoredPort, readStoredToken, saveStoredPort, saveToken } from './token'

/*
  The #pair= fragment is read once, before the router: stashed and stripped on /device, or,
  in Safari on the hosted page, forwarded to the helper's own page. A malformed one is
  stripped too, and never stashed.
*/

const TOKEN = 'abcdefghijABCDEFGHIJ0123456789_-abcdefghijk'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15'

function fakeWindow(href: string, ua = CHROME, vendor = 'Google Inc.', boot?: unknown) {
  const url = new URL(href)
  const replaced: string[] = []
  const states: { state: unknown; url: string }[] = []
  const win: FragmentWindow = {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      origin: url.origin,
      replace: (to: string | URL) => {
        replaced.push(String(to))
      },
    },
    history: {
      state: { key: 'router-state' },
      replaceState: (state: unknown, _unused: string, to?: string | URL | null) => {
        states.push({ state, url: String(to) })
      },
    },
    navigator: { userAgent: ua, vendor },
    DVC_BOOT: boot,
  }
  return { win, replaced, states }
}

describe('parsePairFragment', () => {
  it('reads a token and a port', () => {
    expect(parsePairFragment(`#pair=${TOKEN}&port=8788`)).toEqual({ token: TOKEN, port: 8788 })
  })

  it('reads a link without a port as 8787: the helper leaves it out only there', () => {
    expect(parsePairFragment(`pair=${TOKEN}`)).toEqual({ token: TOKEN, port: 8787 })
    expect(parsePairFragment(`#pair=${TOKEN}`)).toEqual({ token: TOKEN, port: 8787 })
  })

  it('a default-port link wins over the port of an earlier pairing on 8788', () => {
    const stores = memoryStores()
    saveToken({ v: 1, token: TOKEN, port: 8788, tokenId: '0123abcd' }, false, stores)
    saveStoredPort(8788, stores)
    const { win } = fakeWindow(`https://bauloc.github.io/device/#pair=${TOKEN}`)
    capturePairFragment(win, stores)
    const pending = readPendingPair(stores)
    expect(pending).toEqual({ token: TOKEN, port: 8787 })
    expect(
      resolvePort({
        pairPort: pending?.port,
        tokenPort: readStoredToken(stores)?.port,
        port: readStoredPort(stores),
      }),
    ).toBe(8787)
  })

  it('ignores both on a bad token or a bad port', () => {
    expect(parsePairFragment(`#pair=${TOKEN.slice(1)}`)).toBeNull()
    expect(parsePairFragment(`#pair=${TOKEN}x`)).toBeNull()
    expect(parsePairFragment(`#pair=${TOKEN.slice(1)}+`)).toBeNull()
    for (const port of ['80', '65536', '8787.5', 'abc', '-1', '']) {
      expect(parsePairFragment(`#pair=${TOKEN}&port=${port}`)).toBeNull()
    }
  })
})

describe('parsePairInput', () => {
  it('takes the bare token or the whole printed link', () => {
    // A bare token is for the helper this page talks to; a link names its helper.
    expect(parsePairInput(`  ${TOKEN}\n`)).toEqual({ token: TOKEN, port: null })
    expect(parsePairInput(`https://bauloc.github.io/device/#pair=${TOKEN}`)).toEqual({
      token: TOKEN,
      port: 8787,
    })
    expect(parsePairInput(`https://bauloc.github.io/device/#pair=${TOKEN}&port=8788`)).toEqual({
      token: TOKEN,
      port: 8788,
    })
  })

  it('refuses anything else', () => {
    expect(parsePairInput('')).toBeNull()
    expect(parsePairInput('hello')).toBeNull()
    expect(parsePairInput(`https://bauloc.github.io/device/?pair=${TOKEN}`)).toBeNull()
  })
})

describe('capturePairFragment', () => {
  it('stashes the candidate and strips the fragment, keeping path, query and history state', () => {
    const stores = memoryStores()
    const { win, states, replaced } = fakeWindow(
      `https://bauloc.github.io/device/?mock=1#pair=${TOKEN}&port=8788`,
    )
    capturePairFragment(win, stores)
    expect(readPendingPair(stores)).toEqual({ token: TOKEN, port: 8788 })
    expect(states).toEqual([{ state: { key: 'router-state' }, url: '/device/?mock=1' }])
    expect(replaced).toEqual([])
  })

  it('works on /device without the slash', () => {
    const stores = memoryStores()
    const { win } = fakeWindow(`https://bauloc.github.io/device#pair=${TOKEN}`)
    capturePairFragment(win, stores)
    expect(readPendingPair(stores)).toEqual({ token: TOKEN, port: 8787 })
  })

  it('strips a malformed fragment without stashing it', () => {
    const stores = memoryStores()
    const { win, states } = fakeWindow(`https://bauloc.github.io/device/#pair=short`)
    capturePairFragment(win, stores)
    expect(readPendingPair(stores)).toBeNull()
    expect(states).toHaveLength(1)
  })

  it('leaves other pages and other fragments alone', () => {
    for (const href of [
      `https://bauloc.github.io/profile/#pair=${TOKEN}`,
      `https://bauloc.github.io/#pair=${TOKEN}`,
      'https://bauloc.github.io/device/#section-logs',
      'https://bauloc.github.io/device/',
    ]) {
      const stores = memoryStores()
      const { win, states, replaced } = fakeWindow(href)
      capturePairFragment(win, stores)
      expect(readPendingPair(stores)).toBeNull()
      expect(states).toEqual([])
      expect(replaced).toEqual([])
    }
  })

  it('forwards hosted Safari to the helper’s own page, keeping the fragment there', () => {
    const stores = memoryStores()
    const { win, replaced, states } = fakeWindow(
      `https://bauloc.github.io/device/#pair=${TOKEN}&port=8788`,
      SAFARI,
      'Apple Computer, Inc.',
    )
    capturePairFragment(win, stores)
    expect(replaced).toEqual([`http://127.0.0.1:8788/device/#pair=${TOKEN}&port=8788`])
    expect(states).toEqual([])
    expect(readPendingPair(stores)).toBeNull()
  })

  it('in Safari on the helper’s own page, stashes like any other browser', () => {
    const stores = memoryStores()
    const boot = { mode: 'local', apiBase: 'http://127.0.0.1:8787', protocol: 1, version: '1.0.0' }
    const { win, replaced } = fakeWindow(
      `http://127.0.0.1:8787/device/#pair=${TOKEN}&port=8787`,
      SAFARI,
      'Apple Computer, Inc.',
      boot,
    )
    capturePairFragment(win, stores)
    expect(replaced).toEqual([])
    expect(readPendingPair(stores)).toEqual({ token: TOKEN, port: 8787 })
  })

  it('does nothing the second time', () => {
    const stores = memoryStores()
    const setItem = vi.spyOn(stores.session!, 'setItem')
    const first = fakeWindow(`https://bauloc.github.io/device/#pair=${TOKEN}`)
    capturePairFragment(first.win, stores)
    // After the strip the address has no fragment left.
    const second = fakeWindow('https://bauloc.github.io/device/')
    capturePairFragment(second.win, stores)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(second.states).toEqual([])
  })

  it('a cleared candidate is gone, and junk in storage reads as none', () => {
    const stores = memoryStores()
    const { win } = fakeWindow(`https://bauloc.github.io/device/#pair=${TOKEN}`)
    capturePairFragment(win, stores)
    clearPendingPair(stores)
    expect(readPendingPair(stores)).toBeNull()
    stores.session?.setItem('dvc_pair_pending', '{"v":1,"token":"x"}')
    expect(readPendingPair(stores)).toBeNull()
    stores.session?.setItem('dvc_pair_pending', 'not json')
    expect(readPendingPair(stores)).toBeNull()
  })
})

describe('takePairFragment', () => {
  it('strips a link opened in a tab already on /device/ and hands it back, unstashed', () => {
    const stores = memoryStores()
    const { win, states } = fakeWindow(`http://localhost:7360/device/#pair=${TOKEN}&port=8788`)
    expect(takePairFragment(win, stores)).toEqual({ token: TOKEN, port: 8788 })
    expect(states.map((s) => s.url)).toEqual(['/device/'])
    // The page checks it at once; nothing waits for the next load.
    expect(readPendingPair(stores)).toBeNull()
  })

  it('returns null with no fragment, a malformed one (stripped), or Safari forwarded', () => {
    const stores = memoryStores()
    expect(takePairFragment(fakeWindow('https://bauloc.github.io/device/').win, stores)).toBeNull()
    const bad = fakeWindow(`https://bauloc.github.io/device/#pair=${TOKEN.slice(2)}`)
    expect(takePairFragment(bad.win, stores)).toBeNull()
    expect(bad.states).toHaveLength(1)
    const safari = fakeWindow(
      `https://bauloc.github.io/device/#pair=${TOKEN}`,
      SAFARI,
      'Apple Computer, Inc.',
    )
    expect(takePairFragment(safari.win, stores)).toBeNull()
    expect(safari.replaced).toEqual([`http://127.0.0.1:8787/device/#pair=${TOKEN}&port=8787`])
  })
})
