import { describe, expect, it } from 'vitest'
import { bannerText, lanesReported, pairLinks, type BannerInput } from '../src/banner'
import { initialLanes } from '../src/registry'
import { emptyToolbox, type Toolbox } from '../src/tools'
import type { Lanes } from '../src/types'

const T = 'T'.repeat(43)

function toolbox(patch: (t: Toolbox) => void = () => undefined): Toolbox {
  const t = emptyToolbox(0)
  t.xcode = {
    ...t.xcode,
    state: 'ready',
    version: '27.0',
    devDir: '/Applications/Xcode.app/Contents/Developer',
  }
  t.adb = { path: '/opt/homebrew/bin/adb', version: '36.0.0' }
  patch(t)
  return t
}

function lanes(patch: Partial<{ [K in keyof Lanes]: Partial<Lanes[K]> }> = {}): Lanes {
  const base = initialLanes({ platform: 'darwin', wifi: false, android: true, simulators: false })
  return {
    ios: { ...base.ios, status: 'ok', ...patch.ios },
    android: { ...base.android, status: 'stopped', ...patch.android },
    simulators: { ...base.simulators, ...patch.simulators },
  }
}

function input(patch: Partial<BannerInput> = {}): BannerInput {
  return {
    version: '1.1.1',
    port: 8787,
    token: T,
    tokenId: '4d1566a1',
    keepToken: false,
    dev: false,
    opening: true,
    script: '~/device-bridge.mjs',
    platform: 'darwin',
    lanes: lanes(),
    androidDevices: 0,
    toolbox: toolbox(),
    checklist: [],
    ...patch,
  }
}

describe('the banner (§1.10)', () => {
  it('is exactly the spec’s text in the common case', () => {
    expect(bannerText(input()))
      .toBe(`Device Lab helper 1.1.1 · http://127.0.0.1:8787 (this Mac only)

Opening Device Lab in your browser. If nothing opens, use the link for your browser:
  Chrome, Edge, Firefox   https://bauloc.github.io/device/#pair=${T}
  Safari                  http://127.0.0.1:8787/device/#pair=${T}
Or paste this token on the page:  ${T}
Fingerprint 4d1566a1 — the page shows the same one once it is paired.

iPhone      ready · screenshots of iOS 17 and newer through Xcode 27.0
Android     adb 36.0.0 · no adb server running, so Android stays with Chrome's WebUSB
Simulators  off (add --simulators to list booted ones)
Full checklist: node ~/device-bridge.mjs --doctor

Keep this window open while you test. Ctrl+C stops the helper; the token changes on every start.`)
  })

  it('adds &port= to both links on another port, and the dev link with --dev', () => {
    const text = bannerText(input({ port: 8788, dev: true }))
    expect(text).toContain(`https://bauloc.github.io/device/#pair=${T}&port=8788`)
    expect(text).toContain(`http://127.0.0.1:8788/device/#pair=${T}&port=8788`)
    expect(text).toContain(
      `  Dev server              http://localhost:7360/device/#pair=${T}&port=8788`,
    )
    expect(pairLinks(8787, T).hosted).toBe(`https://bauloc.github.io/device/#pair=${T}`)
  })

  it('words the line variants', () => {
    const line = (patch: Partial<BannerInput>, prefix: string): string | undefined =>
      bannerText(input(patch))
        .split('\n')
        .find((l) => l.startsWith(prefix))
    expect(line({ opening: false }, 'Open')).toBe('Open Device Lab with the link for your browser:')
    expect(line({ toolbox: toolbox((t) => (t.xcode.state = 'not-installed')) }, 'iPhone')).toBe(
      'iPhone      ready · screenshots of iOS 17 and newer need Xcode (identifiers and logs work)',
    )
    expect(
      line({ toolbox: toolbox((t) => (t.xcode.state = 'needs-first-launch')) }, 'iPhone'),
    ).toBe(
      'iPhone      ready · Xcode must finish setting up before screenshots work: open Xcode once',
    )
    expect(line({ platform: 'linux' }, 'iPhone')).toBe(
      'iPhone      unavailable · iPhones need macOS',
    )
    expect(
      line({ lanes: lanes({ android: { status: 'ok' } }), androidDevices: 1 }, 'Android'),
    ).toBe('Android     adb 36.0.0 · sharing the running adb server (1 phone)')
    expect(line({ toolbox: toolbox((t) => (t.adb = null)) }, 'Android')).toBe(
      "Android     adb not found · Chrome's WebUSB still works; for Safari or Firefox: brew install --cask android-platform-tools",
    )
    expect(line({ lanes: lanes({ android: { status: 'off' } }) }, 'Android')).toBe(
      'Android     off (--no-android)',
    )
    expect(line({ lanes: lanes({ simulators: { status: 'ok', booted: 2 } }) }, 'Simulators')).toBe(
      'Simulators  2 booted',
    )
    expect(line({ lanes: lanes({ ios: { wifiHidden: 1 } }) }, 'Wi-Fi')).toBe(
      'Wi-Fi       1 iPhone seen only over Wi-Fi (add --wifi to list it)',
    )
    expect(line({ keepToken: true }, 'Or paste')).toBe(
      `Or paste this token on the page (kept between runs):  ${T}`,
    )
  })

  it('prints checking… for what has not finished and the checklist lines it is given', () => {
    const text = bannerText(
      input({ toolbox: null, checklist: null, lanes: lanes({ ios: { status: 'unavailable' } }) }),
    )
    expect(text).toContain('iPhone      checking…')
    expect(text).toContain('Android     checking…')
    expect(text).toContain('Checks      checking…')
    const listed = bannerText(
      input({ checklist: ['Xcode: needs setup', '  → sudo xcodebuild -runFirstLaunch'] }),
    )
    expect(listed).toContain(
      'Xcode: needs setup\n  → sudo xcodebuild -runFirstLaunch\nFull checklist: node ~/device-bridge.mjs --doctor',
    )
  })

  it('says checking… for simulators that have not listed yet, not "need Xcode"', () => {
    const line = (patch: Partial<BannerInput>, prefix: string): string | undefined =>
      bannerText(input(patch))
        .split('\n')
        .find((l) => l.startsWith(prefix))
    const on = initialLanes({ platform: 'darwin', wifi: false, android: true, simulators: true })
    expect(line({ lanes: lanes({ simulators: on.simulators }) }, 'Simulators')).toBe(
      'Simulators  checking…',
    )
    expect(
      line(
        {
          lanes: lanes({ simulators: { status: 'unavailable', reason: 'simulators need Xcode' } }),
        },
        'Simulators',
      ),
    ).toBe('Simulators  unavailable · simulators need Xcode')
  })

  it('knows when the iPhone and simulator lanes have reported (the banner waits for it)', () => {
    const fresh = initialLanes({ platform: 'darwin', wifi: false, android: true, simulators: true })
    expect(lanesReported(fresh)).toBe(false)
    expect(lanesReported({ ...fresh, ios: { ...fresh.ios, status: 'ok' } })).toBe(false)
    expect(
      lanesReported({
        ...fresh,
        ios: { ...fresh.ios, status: 'ok' },
        simulators: { status: 'ok', booted: 3 },
      }),
    ).toBe(true)
    const off = initialLanes({ platform: 'darwin', wifi: false, android: true, simulators: false })
    expect(lanesReported({ ...off, ios: { ...off.ios, status: 'error', reason: 'x' } })).toBe(true)
    expect(
      lanesReported(
        initialLanes({ platform: 'linux', wifi: false, android: true, simulators: true }),
      ),
    ).toBe(true)
  })

  it('never shows the token anywhere but the links and the paste line', () => {
    const lines = bannerText(input())
      .split('\n')
      .filter((l) => l.includes(T))
    expect(lines).toHaveLength(3)
  })
})
