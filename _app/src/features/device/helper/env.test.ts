import { describe, expect, it } from 'vitest'

import {
  isDevOrigin,
  isSafariLike,
  loopbackPermission,
  queryLoopback,
  resolveHelperEnv,
  type LocationLike,
  type PermissionsLike,
} from './env'

/*
  Mode resolution (spec §6.1), with the legacy page's user-agent samples. Local mode needs the
  helper's own boot script AND the matching origin: a loopback origin alone (Vite, serve:site)
  is still the hosted logic.
*/

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  opera:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 OPR/120.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/157.0 Mobile/15E148 Safari/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
}
const APPLE = 'Apple Computer, Inc.'
const GOOGLE = 'Google Inc.'

function loc(href: string): LocationLike {
  const url = new URL(href)
  return { origin: url.origin, protocol: url.protocol, hostname: url.hostname, port: url.port }
}

const HOSTED = loc('https://bauloc.github.io/device/')
const BOOT = { mode: 'local', apiBase: 'http://127.0.0.1:8787', protocol: 1, version: '1.0.0' }

describe('isSafariLike', () => {
  it('is Safari on the Mac and iPad', () => {
    expect(isSafariLike(UA.safariMac, APPLE)).toBe(true)
    expect(isSafariLike(UA.safariIpad, APPLE)).toBe(true)
  })

  it('is not the other browsers that also say Safari', () => {
    expect(isSafariLike(UA.chrome, GOOGLE)).toBe(false)
    expect(isSafariLike(UA.edge, GOOGLE)).toBe(false)
    expect(isSafariLike(UA.opera, GOOGLE)).toBe(false)
    expect(isSafariLike(UA.firefox, '')).toBe(false)
    expect(isSafariLike(UA.android, GOOGLE)).toBe(false)
    // Apple's vendor string, but another browser's engine wrapper.
    expect(isSafariLike(UA.chromeIos, APPLE)).toBe(false)
    expect(isSafariLike(UA.firefoxIos, APPLE)).toBe(false)
    // A Safari user agent with another vendor is a spoof, not Safari.
    expect(isSafariLike(UA.safariMac, GOOGLE)).toBe(false)
  })
})

describe('isDevOrigin', () => {
  it('is Vite, vite preview and serve:site on loopback, over http', () => {
    for (const href of [
      'http://localhost:7360/device/',
      'http://127.0.0.1:4173/device/',
      'http://localhost:8000/device/',
    ]) {
      expect(isDevOrigin(loc(href))).toBe(true)
    }
  })

  it('is nothing else', () => {
    for (const href of [
      'https://bauloc.github.io/device/',
      'http://127.0.0.1:8787/device/',
      'https://localhost:7360/',
      'http://example.com:7360/',
    ]) {
      expect(isDevOrigin(loc(href))).toBe(false)
    }
  })
})

describe('resolveHelperEnv', () => {
  it('is hosted on the site, on 8787 by default', () => {
    expect(resolveHelperEnv(HOSTED, undefined, {}, UA.chrome, GOOGLE)).toEqual({
      mode: 'hosted',
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: false,
      devOrigin: false,
    })
  })

  it('is local only with the helper’s boot script on the helper’s own origin', () => {
    expect(
      resolveHelperEnv(loc('http://127.0.0.1:8787/device/'), BOOT, {}, UA.safariMac, APPLE),
    ).toEqual({
      mode: 'local',
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: true,
      devOrigin: false,
    })
  })

  it('stays hosted when the boot script names another origin, or is malformed', () => {
    const page = loc('http://localhost:8787/device/')
    expect(resolveHelperEnv(page, BOOT, {}, UA.chrome, GOOGLE).mode).toBe('hosted')
    expect(
      resolveHelperEnv(
        loc('http://127.0.0.1:8787/device/'),
        { ...BOOT, mode: 'remote' },
        {},
        UA.chrome,
        GOOGLE,
      ).mode,
    ).toBe('hosted')
    expect(resolveHelperEnv(HOSTED, BOOT, {}, UA.chrome, GOOGLE).mode).toBe('hosted')
  })

  it('treats Vite and serve:site as hosted dev origins, never as the helper', () => {
    for (const href of ['http://localhost:7360/device/', 'http://localhost:8000/device/']) {
      expect(resolveHelperEnv(loc(href), undefined, {}, UA.chrome, GOOGLE)).toMatchObject({
        mode: 'hosted',
        apiBase: 'http://127.0.0.1:8787',
        devOrigin: true,
      })
    }
  })

  it('takes the port from the pending pair, then the stored token, then dvc_port', () => {
    const env = (stored: Parameters<typeof resolveHelperEnv>[2]) =>
      resolveHelperEnv(HOSTED, undefined, stored, UA.chrome, GOOGLE).port
    expect(env({ pairPort: 9001, tokenPort: 9002, port: 9003 })).toBe(9001)
    expect(env({ pairPort: null, tokenPort: 9002, port: 9003 })).toBe(9002)
    expect(env({ port: 9003 })).toBe(9003)
    expect(resolveHelperEnv(HOSTED, undefined, { port: 9003 }, UA.chrome, GOOGLE).apiBase).toBe(
      'http://127.0.0.1:9003',
    )
  })

  it('skips ports out of range', () => {
    const env = (stored: Parameters<typeof resolveHelperEnv>[2]) =>
      resolveHelperEnv(HOSTED, undefined, stored, UA.chrome, GOOGLE).port
    expect(env({ pairPort: 80, tokenPort: 70_000, port: 1.5 })).toBe(8787)
    expect(env({ pairPort: 1023, port: 1024 })).toBe(1024)
    expect(env({ port: 65_535 })).toBe(65_535)
  })

  it('never reads ?api= or ?port=', () => {
    const page = loc('https://bauloc.github.io/device/?api=https://evil.example&port=9999')
    expect(resolveHelperEnv(page, undefined, {}, UA.chrome, GOOGLE)).toMatchObject({
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
    })
  })
})

describe('queryLoopback', () => {
  const answering = (answers: Record<string, string | Error>): PermissionsLike => ({
    query({ name }) {
      const answer = answers[name]
      if (answer === undefined || answer instanceof Error) {
        return Promise.reject(answer ?? new TypeError(`Unknown permission ${name}`))
      }
      return Promise.resolve({ state: answer, onchange: null })
    },
  })

  it('asks loopback-network first', async () => {
    const permissions = answering({
      'loopback-network': 'granted',
      'local-network-access': 'denied',
    })
    expect(await loopbackPermission(permissions)).toBe('granted')
  })

  it('falls back to Chrome 142–144’s name only when the new one throws', async () => {
    expect(await loopbackPermission(answering({ 'local-network-access': 'prompt' }))).toBe('prompt')
  })

  it('is unsupported when neither is known, or nothing can be asked', async () => {
    expect(await loopbackPermission(answering({}))).toBe('unsupported')
    expect(await loopbackPermission(null)).toBe('unsupported')
    expect(await loopbackPermission(answering({ 'loopback-network': 'weird' }))).toBe('unsupported')
  })

  it('returns the PermissionStatus to watch', async () => {
    const { state, status } = await queryLoopback(answering({ 'loopback-network': 'denied' }))
    expect(state).toBe('denied')
    expect(status?.state).toBe('denied')
  })
})
