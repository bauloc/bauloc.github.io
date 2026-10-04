import { describe, expect, it, vi } from 'vitest'

import {
  environmentNow,
  isStaleBuildError,
  lnaPermission,
  onStaleBuild,
  pageLink,
  parseBrowser,
  parseOs,
  readEnvironment,
  type EnvSource,
} from './env'
import type { BrowserEnv } from './types'

/*
  The reader against fake globals: a secure Chrome on a Mac, then each thing a browser can
  lack. User-agent strings are real ones (Chrome 155, Edge 155, Firefox 157, Safari 27).
*/

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  operaLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 OPR/120.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
} as const

type Permissions = NonNullable<EnvSource['navigator']['permissions']>

/** Answers `query` per permission name; a name it doesn't know throws, as browsers do. */
function permissions(answers: Record<string, string>) {
  return {
    query: vi.fn<Permissions['query']>(({ name }) => {
      const state = answers[name]
      return state === undefined
        ? Promise.reject(
            new TypeError(`'${name}' is not a valid enum value of type PermissionName.`),
          )
        : Promise.resolve({ state })
    }),
  }
}

class Inflate {
  constructor(format: string) {
    if (format !== 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`)
  }
}

function source(patch: Partial<EnvSource> = {}): EnvSource {
  return {
    isSecureContext: true,
    location: { protocol: 'https:', href: 'https://bauloc.github.io/device/' },
    navigator: {
      usb: {},
      userAgent: UA.chromeMac,
      platform: 'MacIntel',
      userAgentData: {
        platform: 'macOS',
        brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }, { brand: 'Not.A/Brand' }],
      },
      permissions: permissions({ 'loopback-network': 'prompt' }),
    },
    document: { featurePolicy: { allowsFeature: (feature) => feature === 'usb' } },
    DecompressionStream: Inflate,
    version: '1.0.0',
    ...patch,
  }
}

describe('readEnvironment', () => {
  it('reads a secure Chrome on a Mac', async () => {
    const expected: BrowserEnv = {
      secure: true,
      https: true,
      href: 'https://bauloc.github.io/device/',
      webusb: true,
      usbPolicy: true,
      inflate: true,
      lna: 'prompt',
      os: 'mac',
      browser: 'chrome',
      version: '1.0.0',
      appUpdated: false,
    }
    await expect(readEnvironment(source())).resolves.toEqual(expected)
    // The first frame's answer: the same, minus the permission it would have to wait for.
    expect(environmentNow(source())).toEqual({ ...expected, lna: 'unsupported' })
  })

  it('reads an insecure page: no WebUSB to see there', async () => {
    const env = await readEnvironment(
      source({
        isSecureContext: false,
        location: { protocol: 'http:', href: 'http://192.168.1.20:7360/device/' },
        navigator: { userAgent: UA.chromeMac },
      }),
    )
    expect(env).toMatchObject({ secure: false, https: false, webusb: false, lna: 'unsupported' })
  })

  it('tells localhost apart from https', async () => {
    const env = await readEnvironment(
      source({ location: { protocol: 'http:', href: 'http://localhost:7360/device/' } }),
    )
    expect(env).toMatchObject({ secure: true, https: false })
  })

  it('drops the fragment, which can carry the pairing token', async () => {
    const env = await readEnvironment(
      source({
        location: {
          protocol: 'https:',
          href: 'https://bauloc.github.io/device/?mock=1#pair=s3cr3t',
        },
      }),
    )
    expect(env.href).toBe('https://bauloc.github.io/device/?mock=1')
  })

  it.each<[string, EnvSource['document'], boolean | null]>([
    ['an iframe without allow="usb"', { featurePolicy: { allowsFeature: () => false } }, false],
    [
      'the newer permissionsPolicy, preferred',
      {
        permissionsPolicy: { allowsFeature: () => false },
        featurePolicy: { allowsFeature: () => true },
      },
      false,
    ],
    ['no policy API (Firefox, Safari)', {}, null],
    [
      'a policy API that throws',
      {
        featurePolicy: {
          allowsFeature: () => {
            throw new Error('unknown feature')
          },
        },
      },
      null,
    ],
  ])('reads the USB policy of %s', async (_, document, expected) => {
    expect((await readEnvironment(source({ document }))).usbPolicy).toBe(expected)
  })

  it.each<[string, EnvSource['DecompressionStream'], boolean]>([
    ['DecompressionStream with deflate-raw', Inflate, true],
    [
      'a DecompressionStream that predates deflate-raw',
      class {
        constructor(format: string) {
          if (format === 'deflate-raw') throw new TypeError('Unsupported format')
        }
      },
      false,
    ],
    ['no DecompressionStream', undefined, false],
  ])('reads %s', async (_, Ctor, expected) => {
    expect((await readEnvironment(source({ DecompressionStream: Ctor }))).inflate).toBe(expected)
  })

  it('reads Edge on Windows from its client hints', async () => {
    const env = await readEnvironment(
      source({
        navigator: {
          usb: {},
          userAgent: UA.edgeWindows,
          platform: 'Win32',
          userAgentData: {
            platform: 'Windows',
            brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }],
          },
        },
      }),
    )
    expect(env).toMatchObject({ os: 'windows', browser: 'edge', webusb: true })
  })
})

describe('lnaPermission', () => {
  it.each<[string, Record<string, string>, string]>([
    ['granted', { 'loopback-network': 'granted' }, 'granted'],
    ['prompt', { 'loopback-network': 'prompt' }, 'prompt'],
    ['denied', { 'loopback-network': 'denied' }, 'denied'],
    ['Chrome 142–144 (old name only)', { 'local-network-access': 'denied' }, 'denied'],
    ['Safari (neither name)', {}, 'unsupported'],
    ['an unexpected state', { 'loopback-network': 'pending' }, 'unsupported'],
  ])('%s', async (_, answers, expected) => {
    await expect(lnaPermission(permissions(answers))).resolves.toBe(expected)
  })

  it('asks the old name only when the new one is unknown', async () => {
    const both = permissions({ 'loopback-network': 'granted', 'local-network-access': 'denied' })
    await expect(lnaPermission(both)).resolves.toBe('granted')
    expect(both.query).toHaveBeenCalledTimes(1)
    expect(both.query).toHaveBeenCalledWith({ name: 'loopback-network' })
  })

  it('is unsupported without a Permissions API', async () => {
    await expect(lnaPermission(undefined)).resolves.toBe('unsupported')
  })
})

describe('parseOs', () => {
  it.each<[string, string | undefined, string, string, string]>([
    ['macOS client hint', 'macOS', 'MacIntel', UA.chromeMac, 'mac'],
    ['Windows client hint', 'Windows', 'Win32', UA.edgeWindows, 'windows'],
    ['Linux client hint', 'Linux', 'Linux x86_64', UA.operaLinux, 'linux'],
    ['ChromeOS client hint', 'Chrome OS', 'Linux x86_64', UA.chromeOs, 'chromeos'],
    ['Android client hint', 'Android', 'Linux armv81', UA.chromeAndroid, 'android'],
    ['Firefox on Linux', undefined, 'Linux x86_64', UA.firefoxLinux, 'linux'],
    ['Safari on a Mac', undefined, 'MacIntel', UA.safariMac, 'mac'],
    ['Safari on an iPad', undefined, 'iPad', UA.safariIpad, 'ios'],
    ['Android without hints (its UA says Linux too)', undefined, '', UA.chromeAndroid, 'android'],
    ['ChromeOS without hints', undefined, '', UA.chromeOs, 'chromeos'],
    ['an unknown hint, falling back to the UA', 'Fuchsia', '', UA.edgeWindows, 'windows'],
    ['nothing to go on', undefined, '', 'Mozilla/5.0', 'other'],
  ])('%s', (_, hint, platform, ua, expected) => {
    expect(parseOs(hint, platform, ua)).toBe(expected)
  })
})

describe('parseBrowser', () => {
  it.each<[string, string[], string, string]>([
    ['Chrome by its brands', ['Chromium', 'Google Chrome'], UA.chromeMac, 'chrome'],
    ['Edge by its brands', ['Microsoft Edge', 'Chromium'], UA.edgeWindows, 'edge'],
    ['Opera by its brands', ['Opera', 'Chromium'], UA.operaLinux, 'opera'],
    ['Brave: Chromium, unnamed', ['Brave', 'Chromium'], UA.chromeMac, 'other'],
    ['Chrome by its UA', [], UA.chromeMac, 'chrome'],
    ['Edge by its UA', [], UA.edgeWindows, 'edge'],
    ['Opera by its UA', [], UA.operaLinux, 'opera'],
    ['Firefox', [], UA.firefoxLinux, 'firefox'],
    ['Safari', [], UA.safariMac, 'safari'],
    ['Safari on an iPad', [], UA.safariIpad, 'safari'],
    ['something else', [], 'curl/8.7.1', 'other'],
  ])('%s', (_, brands, ua, expected) => {
    expect(
      parseBrowser(
        brands.map((brand) => ({ brand })),
        ua,
      ),
    ).toBe(expected)
  })
})

describe('pageLink', () => {
  it('keeps the address and query, and drops the fragment', () => {
    expect(pageLink('https://bauloc.github.io/device/#pair=abc')).toBe(
      'https://bauloc.github.io/device/',
    )
    expect(pageLink('https://bauloc.github.io/device/?mock=1')).toBe(
      'https://bauloc.github.io/device/?mock=1',
    )
  })
})

describe('a deploy under an open tab', () => {
  it.each<[string, unknown, boolean]>([
    [
      'Chrome',
      new TypeError(
        'Failed to fetch dynamically imported module: https://bauloc.github.io/assets/c-apps-tab-1a2b3c.js',
      ),
      true,
    ],
    ['Firefox', new TypeError('error loading dynamically imported module'), true],
    ['Safari', new TypeError('Importing a module script failed.'), true],
    ['Vite, for a stylesheet', new Error('Unable to preload CSS for /assets/c-x-1a2b.css'), true],
    ['a plain string', 'Failed to fetch dynamically imported module: /assets/x.js', true],
    ['any other failure', new Error('DEVICE_NOT_READY'), false],
    ['not an error at all', { message: 'Failed to fetch dynamically imported module' }, false],
  ])('recognises a missing chunk in %s', (_, error, expected) => {
    expect(isStaleBuildError(error)).toBe(expected)
  })

  it('hears vite:preloadError until unsubscribed, without cancelling it', () => {
    const target = new EventTarget()
    const listener = vi.fn()
    const stop = onStaleBuild(listener, target)
    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    stop()
    target.dispatchEvent(new Event('vite:preloadError'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
