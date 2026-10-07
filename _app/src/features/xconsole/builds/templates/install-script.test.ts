// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { qrSvg } from '../qr'
import type { BuildEntry } from '../types'
import { ANDROID, IOS, everyText } from './__fixtures__/entries'
import { installPageHtml } from './install-page'
import { INSTALL_SCRIPT } from './install-script'

/*
  The install page's script, run for real: the generated page is put in jsdom's document, the
  browser it believes it is in is set up, and the script runs as the page runs it.
*/

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  iphoneZalo:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/525',
  iphoneFacebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/482.0.0.40.104;FBBV/658000000]',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36',
  androidDesktopSite:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  // Chrome on a Linux laptop: the very same user agent as Android's "Desktop site".
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
}

interface Browser {
  userAgent?: string
  /** navigator.platform, which tells Android's "Desktop site" from a Linux laptop. */
  platform?: string
  touchPoints?: number
  languages?: string[]
  systemDark?: boolean
  saved?: Record<string, string>
  clipboard?: { writeText: (text: string) => Promise<void> } | undefined
}

/** Defines a navigator property for this test only (afterEach removes what it set). */
const defined: (readonly [object, string])[] = []
function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
  defined.push([target, key])
}

afterEach(() => {
  for (const [target, key] of defined.splice(0)) Reflect.deleteProperty(target, key)
  localStorage.clear()
})

/**
 * jsdom's own window: the global the page's script runs in. Vitest's `window` is Node's global
 * dressed as one, so what is defined on it is not seen there (navigator is the same object).
 */
function pageWindow(): Window {
  const dom: unknown = Reflect.get(globalThis, 'jsdom')
  const view: unknown = typeof dom === 'object' && dom !== null ? Reflect.get(dom, 'window') : null
  if (typeof view !== 'object' || view === null) throw new Error('Not in a jsdom environment')
  return view as Window
}

/** The page as a browser would load it: its own document, then its script, run once. */
function open(entry: BuildEntry, browser: Browser = {}): HTMLElement {
  define(navigator, 'userAgent', browser.userAgent ?? UA.macChrome)
  define(navigator, 'platform', browser.platform ?? 'MacIntel')
  define(navigator, 'maxTouchPoints', browser.touchPoints ?? 0)
  define(navigator, 'languages', browser.languages ?? ['en-US', 'en'])
  define(navigator, 'clipboard', browser.clipboard)
  define(pageWindow(), 'matchMedia', (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && browser.systemDark === true,
    addEventListener: () => undefined,
  }))
  localStorage.clear()
  for (const [key, value] of Object.entries(browser.saved ?? {})) localStorage.setItem(key, value)

  const parsed = new DOMParser().parseFromString(
    installPageHtml(entry, { qrSvg: qrSvg('https://bauloc.github.io/build/x/') }),
    'text/html',
  )
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement)
  // A script that came in through DOMParser never runs, so the page's own is run as a new one.
  const script = document.createElement('script')
  script.textContent = INSTALL_SCRIPT
  document.head.append(script)
  return document.documentElement
}

const $ = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`No ${selector}`)
  return element
}

describe('before the first paint', () => {
  it.each([
    ['iphoneSafari', 0, 'iPhone', 'ios', 'default'],
    ['iphoneChrome', 0, 'iPhone', 'ios', 'other'],
    ['iphoneZalo', 0, 'iPhone', 'ios', 'in-app'],
    ['iphoneFacebook', 0, 'iPhone', 'ios', 'in-app'],
    ['ipadDesktop', 5, 'MacIntel', 'ios', 'default'],
    ['androidChrome', 5, 'Linux armv81', 'android', 'default'],
    ['androidWebView', 5, 'Linux armv81', 'android', 'in-app'],
    ['androidDesktopSite', 5, 'Linux armv81', 'android', 'default'],
    // Android from before Chrome froze the value names the kernel's own architecture.
    ['androidDesktopSite', 5, 'Linux aarch64', 'android', 'default'],
    ['androidDesktopSite', 5, 'Linux armv7l', 'android', 'default'],
    // The same user agent on a touch-screen laptop: a desk, where the QR code is the way in.
    ['linuxChrome', 10, 'Linux x86_64', 'desktop', 'default'],
    ['macChrome', 0, 'MacIntel', 'desktop', 'default'],
    ['ipadDesktop', 0, 'MacIntel', 'desktop', 'default'],
    ['windowsEdge', 10, 'Win32', 'desktop', 'default'],
  ] as const)(
    '%s with %i touch points on %s is %s, %s',
    (ua, touchPoints, platform, device, browser) => {
      const root = open(IOS, { userAgent: UA[ua], touchPoints, platform })
      expect(root.dataset.device).toBe(device)
      expect(root.dataset.browser).toBe(browser)
    },
  )

  it('takes the saved theme, else the system’s', () => {
    expect(open(ANDROID, { saved: { 'bauloc:theme': 'dark' } }).classList.contains('dark')).toBe(
      true,
    )
    expect(
      open(ANDROID, { systemDark: true, saved: { 'bauloc:theme': 'light' } }).classList.contains(
        'dark',
      ),
    ).toBe(false)
    expect(open(ANDROID, { systemDark: true }).classList.contains('dark')).toBe(true)
    expect(open(ANDROID).classList.contains('dark')).toBe(false)
    expect($('meta[name="theme-color"]').getAttribute('content')).toBe('#ffffff')
  })

  it('takes the saved language, else the browser’s first that the site speaks', () => {
    expect(open(ANDROID, { saved: { 'bauloc:locale': 'vi' } }).lang).toBe('vi')
    expect(open(ANDROID, { languages: ['fr-FR', 'vi-VN', 'en'] }).lang).toBe('vi')
    expect(open(ANDROID, { languages: ['ja'] }).lang).toBe('en')
    expect(open(ANDROID, { languages: ['vi'], saved: { 'bauloc:locale': 'en' } }).lang).toBe('en')
  })

  it('marks an iOS build whose profile has expired, and takes its Install away', () => {
    const past = { ...IOS.ios!.profile!, expires: '2026-01-14T08:00:00.000Z' }
    const root = open(
      { ...IOS, ios: { ...IOS.ios!, profile: past } },
      { userAgent: UA.iphoneSafari },
    )
    expect(root.classList.contains('expired')).toBe(true)
    expect($('.install').hasAttribute('href')).toBe(false)
    expect($('.install').getAttribute('aria-disabled')).toBe('true')
    expect(open(IOS, { userAgent: UA.iphoneSafari }).classList.contains('expired')).toBe(false)
    expect($('.install').getAttribute('href')).toMatch(/^itms-services:/)
  })

  it('takes Install away on the other platform’s phone', () => {
    open(IOS, { userAgent: UA.androidChrome, touchPoints: 5 })
    expect($('.install').hasAttribute('href')).toBe(false)
    open(ANDROID, { userAgent: UA.iphoneSafari })
    expect($('.install').hasAttribute('href')).toBe(false)
    open(ANDROID, { userAgent: UA.androidChrome, touchPoints: 5 })
    expect($('.install').getAttribute('href')).toBe('/build/k3x9q2mf/lich-am-viet-2.4.1-241.apk')
    // A touch-screen Linux laptop is a desk, not an Android phone: no wrong-platform verdict.
    const root = open(IOS, {
      userAgent: UA.linuxChrome,
      touchPoints: 10,
      platform: 'Linux x86_64',
    })
    expect(root.dataset.device).toBe('desktop')
    expect($('.install').getAttribute('href')).toMatch(/^itms-services:/)
  })
})

describe('once the page is parsed', () => {
  it('writes each time in the reader’s zone, in their language', () => {
    open(ANDROID)
    // The suite runs in Asia/Ho_Chi_Minh (vite.config.ts): 01:15 UTC is 08:15 there.
    expect($('.meta time').textContent).toBe('07-Oct-2026 08:15')
    $('[data-set-lang="vi"]').click()
    expect($('.meta time').textContent).toBe('07/10/2026 08:15')
  })

  it('switches the language, remembers it, and renames what has no text of its own', () => {
    const root = open(ANDROID)
    const languages = $('.seg')
    expect(languages.getAttribute('aria-label')).toBe('Language')
    $('[data-set-lang="vi"]').click()
    expect(root.lang).toBe('vi')
    expect(localStorage.getItem('bauloc:locale')).toBe('vi')
    expect(languages.getAttribute('aria-label')).toBe('Ngôn ngữ')
    expect($('[data-set-lang="vi"]').getAttribute('aria-pressed')).toBe('true')
    expect($('[data-set-lang="en"]').getAttribute('aria-pressed')).toBe('false')
    expect($('[data-theme-toggle]').getAttribute('aria-label')).toBe('Chuyển sang giao diện tối')
  })

  it('switches the theme and remembers it', () => {
    const root = open(ANDROID)
    $('[data-theme-toggle]').click()
    expect(root.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('bauloc:theme')).toBe('dark')
    expect($('meta[name="theme-color"]').getAttribute('content')).toBe('#0a0a0a')
    expect($('[data-theme-toggle]').getAttribute('aria-label')).toBe('Switch to light mode')
    $('[data-theme-toggle]').click()
    expect(root.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('bauloc:theme')).toBe('light')
  })

  it('copies the link, and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    open(IOS, { userAgent: UA.iphoneZalo, clipboard: { writeText } })
    const button = $('.n-safari [data-copy]')
    button.click()
    await vi.waitFor(() => {
      expect(button.dataset.state).toBe('copied')
    })
    expect(writeText).toHaveBeenCalledWith('https://bauloc.github.io/build/pw7h2c4n/')
    expect($('#status').textContent).toBe('Copied')
  })

  it('offers the link to copy by hand where the browser will not copy it', async () => {
    open(IOS, {
      userAgent: UA.iphoneZalo,
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    })
    const button = $('.n-safari [data-copy]')
    button.click()
    const field = await vi.waitFor(() => $<HTMLInputElement>('.n-safari .copy-field'))
    expect(field.value).toBe('https://bauloc.github.io/build/pw7h2c4n/')
    expect(field.readOnly).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(button.dataset.state).toBeUndefined()
  })

  it('says what happens next once Install is tapped', () => {
    const root = open(ANDROID, { userAgent: UA.androidChrome, touchPoints: 5 })
    $('.install').addEventListener('click', (event) => {
      event.preventDefault()
    })
    $('.install').click()
    expect(root.classList.contains('tapped')).toBe(true)
  })
})

describe('the page as a browser parses it', () => {
  it('holds no markup from a hostile index: one script, no handlers, no stray elements', () => {
    const HOSTILE = `"'><script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">`
    for (const entry of [ANDROID, IOS]) {
      const parsed = new DOMParser().parseFromString(
        installPageHtml(everyText(entry, HOSTILE), { qrSvg: qrSvg('https://bauloc.github.io/') }),
        'text/html',
      )
      expect(parsed.querySelectorAll('script')).toHaveLength(1)
      expect(parsed.querySelectorAll('img[src="x"], iframe, object, embed, form')).toHaveLength(0)
      for (const element of parsed.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          expect(attribute.name, element.outerHTML.slice(0, 80)).not.toMatch(/^on/)
          expect(attribute.value).not.toMatch(/^\s*javascript:/i)
        }
      }
      expect(parsed.querySelector('h1')!.textContent).toBe(HOSTILE)
      expect(parsed.title).toBe(`${HOSTILE} ${HOSTILE}`)
    }
  })
})
