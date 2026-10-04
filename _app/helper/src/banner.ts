import { DEFAULT_PORT, INSTALL, SITE } from './constants'
import type { Toolbox } from './tools'
import type { Lanes } from './types'
import { plural } from './util'

/** The links that pair a page, each carrying this run's token in the fragment (§6.2). */
export function pairLinks(
  port: number,
  token: string,
): { hosted: string; local: string; dev: string } {
  const fragment = `#pair=${token}${port === DEFAULT_PORT ? '' : `&port=${String(port)}`}`
  return {
    hosted: `${SITE}/device/${fragment}`,
    local: `http://127.0.0.1:${String(port)}/device/${fragment}`,
    dev: `http://localhost:7360/device/${fragment}`,
  }
}

export interface BannerInput {
  version: string
  port: number
  token: string
  tokenId: string
  keepToken: boolean
  dev: boolean
  /** A browser tab opens by itself: macOS, a terminal, and no --no-open. */
  opening: boolean
  /** This file as the tester should type it, `~/device-bridge.mjs`. */
  script: string
  platform: NodeJS.Platform
  lanes: Lanes
  androidDevices: number
  /** null while discovery is still running. */
  toolbox: Toolbox | null
  /** The checklist's warning lines (formatChecklist, not all); null while still checking. */
  checklist: string[] | null
}

/** Twelve columns, so the lane lines read as a table. */
const column = (name: string): string => name.padEnd(12)

function iphoneLine(b: BannerInput): string {
  const ios = b.lanes.ios
  if (b.platform !== 'darwin') return `${column('iPhone')}unavailable · iPhones need macOS`
  if (ios.status === 'error') {
    return `${column('iPhone')}not answering · ${ios.reason ?? "macOS's iPhone service (usbmuxd) isn't answering"}`
  }
  if (ios.status === 'unavailable') {
    return `${column('iPhone')}${ios.reason ? `unavailable · ${ios.reason}` : 'checking…'}`
  }
  const xcode = b.toolbox?.xcode
  if (!xcode) return `${column('iPhone')}ready · checking Xcode…`
  if (xcode.state === 'ready') {
    const which = xcode.version ? `Xcode ${xcode.version}` : 'Xcode'
    return `${column('iPhone')}ready · screenshots of iOS 17 and newer through ${which}`
  }
  if (xcode.state === 'needs-first-launch') {
    return `${column('iPhone')}ready · Xcode must finish setting up before screenshots work: open Xcode once`
  }
  return `${column('iPhone')}ready · screenshots of iOS 17 and newer need Xcode (identifiers and logs work)`
}

function androidLine(b: BannerInput): string {
  const android = b.lanes.android
  if (android.status === 'off') return `${column('Android')}off (--no-android)`
  const adb = b.toolbox?.adb
  const named = adb ? (adb.version ? `adb ${adb.version}` : 'adb') : null
  if (android.status === 'ok') {
    const lead = named ? `${named} · ` : ''
    return `${column('Android')}${lead}sharing the running adb server (${plural(b.androidDevices, 'phone')})`
  }
  if (!b.toolbox) return `${column('Android')}checking…`
  if (!named) {
    return `${column('Android')}adb not found · Chrome's WebUSB still works; for Safari or Firefox: ${INSTALL.adb}`
  }
  if (android.status === 'error') {
    return `${column('Android')}${named} · ${android.reason ?? "the adb server isn't answering"}`
  }
  return `${column('Android')}${named} · no adb server running, so Android stays with Chrome's WebUSB`
}

/**
 * A lane still in its initial state, 'unavailable' with no reason, has not reported yet:
 * every real 'unavailable' a lane sets carries a reason (§1.3, initialLanes).
 */
const pending = (lane: { status: string; reason?: string }): boolean =>
  lane.status === 'unavailable' && lane.reason === undefined

/** True once the iPhone and simulator lanes have each reported at least once. */
export function lanesReported(lanes: Lanes): boolean {
  return !pending(lanes.ios) && !pending(lanes.simulators)
}

function simulatorsLine(b: BannerInput): string {
  const simulators = b.lanes.simulators
  if (simulators.status === 'off')
    return `${column('Simulators')}off (add --simulators to list booted ones)`
  if (simulators.status === 'ok') {
    return `${column('Simulators')}${simulators.booted ? String(simulators.booted) : 'none'} booted`
  }
  if (pending(simulators)) return `${column('Simulators')}checking…`
  return `${column('Simulators')}unavailable · ${simulators.reason ?? 'simulators need Xcode'}`
}

/** §1.10, exact: what the tester reads first, and the links that pair a page. */
export function bannerText(b: BannerInput): string {
  const links = pairLinks(b.port, b.token)
  const hidden = b.lanes.ios.wifiHidden
  const lines = [
    `Device Lab helper ${b.version} · http://127.0.0.1:${String(b.port)} (this Mac only)`,
    '',
    b.opening
      ? 'Opening Device Lab in your browser. If nothing opens, use the link for your browser:'
      : 'Open Device Lab with the link for your browser:',
    `  Chrome, Edge, Firefox   ${links.hosted}`,
    `  Safari                  ${links.local}`,
    ...(b.dev ? [`  Dev server              ${links.dev}`] : []),
    b.keepToken
      ? `Or paste this token on the page (kept between runs):  ${b.token}`
      : `Or paste this token on the page:  ${b.token}`,
    `Fingerprint ${b.tokenId} — the page shows the same one once it is paired.`,
    '',
    iphoneLine(b),
    androidLine(b),
    simulatorsLine(b),
    ...(hidden > 0
      ? [
          `${column('Wi-Fi')}${plural(hidden, 'iPhone')} seen only over Wi-Fi (add --wifi to list ${hidden === 1 ? 'it' : 'them'})`,
        ]
      : []),
    ...(b.checklist ?? [`${column('Checks')}checking…`]),
    `Full checklist: node ${b.script} --doctor`,
    '',
    b.keepToken
      ? 'Keep this window open while you test. Ctrl+C stops the helper; the token stays the same across restarts (--keep-token).'
      : 'Keep this window open while you test. Ctrl+C stops the helper; the token changes on every start.',
  ]
  return lines.join('\n')
}
