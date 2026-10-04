import { HELPER_URL } from '../helper/status'
import type { BrowserEnv, BrowserName, LnaPermission, Os, PublishedHelper } from './types'

/*
  The browser, read once into a plain object (BrowserEnv) that checks.ts takes as input, so
  every path of the checklist can run in Vitest's node environment. Reading is all this does:
  nothing is requested or probed. The Local Network Access permission is QUERIED, which never
  prompts — only a request to 127.0.0.1 would, and none is made here. The one request this file
  makes goes to bauloc.github.io, for the published helper file (readPublishedHelper).
*/

/** The globals the reader touches, injectable for tests. */
export interface EnvSource {
  readonly isSecureContext: boolean
  readonly location: { readonly protocol: string; readonly href: string }
  readonly navigator: object & {
    /** Only its presence is read: the API exists in secure contexts of browsers with WebUSB. */
    readonly usb?: unknown
    readonly userAgent: string
    readonly platform?: string
    /** User-Agent Client Hints, Chromium only. */
    readonly userAgentData?: {
      readonly platform?: string
      readonly brands?: readonly { readonly brand: string }[]
    }
    readonly permissions?: {
      query(descriptor: { name: string }): Promise<{ readonly state: string }>
    }
  }
  readonly document: object & {
    /** Chromium's name for the permissions policy API, and the spec's newer one. */
    readonly featurePolicy?: { allowsFeature(feature: string): boolean }
    readonly permissionsPolicy?: { allowsFeature(feature: string): boolean }
  }
  readonly DecompressionStream?: new (format: 'deflate-raw') => unknown
  readonly version: string
}

/** The real globals. Only call it in a browser. */
export function browserSource(): EnvSource {
  return {
    isSecureContext: window.isSecureContext,
    location: window.location,
    navigator: window.navigator,
    document: window.document,
    DecompressionStream:
      typeof DecompressionStream === 'function' ? DecompressionStream : undefined,
    version: __APP_VERSION__,
  }
}

/** The page's address for "Copy this page's link": the fragment can carry the pairing token. */
export function pageLink(href: string): string {
  const hash = href.indexOf('#')
  return hash < 0 ? href : href.slice(0, hash)
}

/** What the embedding page's permissions policy says about USB; null when the browser can't say. */
function usbPolicy(document: EnvSource['document']): boolean | null {
  const policy = document.permissionsPolicy ?? document.featurePolicy
  if (!policy) return null
  try {
    return policy.allowsFeature('usb')
  } catch {
    return null
  }
}

/** Whether the browser can inflate raw deflate, which .xapk and .apkm entries need. */
function canInflate(Inflate: EnvSource['DecompressionStream']): boolean {
  if (!Inflate) return false
  try {
    // Constructing it is the test: older engines have the class but reject the format.
    new Inflate('deflate-raw')
    return true
  } catch {
    return false
  }
}

const isAnswer = (state: string): state is 'granted' | 'prompt' | 'denied' =>
  state === 'granted' || state === 'prompt' || state === 'denied'

/**
 * Chrome 145+ and Firefox 151+ know `loopback-network`; Chrome 142–144 only the older
 * `local-network-access`. That alias answers oddly where both exist ("denied" while loopback
 * was granted), so it is only asked when the new name throws. A browser that throws on both
 * (Safari, older Firefox) is `unsupported`.
 */
export async function lnaPermission(
  permissions: EnvSource['navigator']['permissions'],
): Promise<LnaPermission> {
  if (!permissions) return 'unsupported'
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const { state } = await permissions.query({ name })
      return isAnswer(state) ? state : 'unsupported'
    } catch {
      // A TypeError: this browser doesn't know the name. Try the next one.
    }
  }
  return 'unsupported'
}

const CLIENT_HINT_OS: Readonly<Record<string, Os>> = {
  macOS: 'mac',
  Windows: 'windows',
  Linux: 'linux',
  'Chrome OS': 'chromeos',
  ChromeOS: 'chromeos',
  'Chromium OS': 'chromeos',
  Android: 'android',
  iOS: 'ios',
}

/** The OS, from Client Hints when the browser sends them, else from the user agent string. */
export function parseOs(hintPlatform: string | undefined, platform: string, ua: string): Os {
  const hinted = hintPlatform === undefined ? undefined : CLIENT_HINT_OS[hintPlatform]
  if (hinted) return hinted
  // Android's user agent also says Linux, and iPadOS's says Macintosh: the specific ones first.
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/CrOS/.test(ua)) return 'chromeos'
  if (/Windows/.test(ua) || /^Win/.test(platform)) return 'windows'
  if (/Macintosh|Mac OS X/.test(ua) || /^Mac/.test(platform)) return 'mac'
  if (/Linux|X11/.test(ua) || /Linux/.test(platform)) return 'linux'
  return 'other'
}

/**
 * The browser, for sentences that name it ("Chrome may use Pixel 9.") and for Safari's helper
 * advice. Client Hints brands first: they tell Edge and Opera from Chrome reliably; any other
 * Chromium (Brave, Vivaldi) is named "This browser" rather than mislabelled.
 */
export function parseBrowser(
  brands: readonly { readonly brand: string }[],
  ua: string,
): BrowserName {
  if (brands.length > 0) {
    const names = new Set(brands.map((b) => b.brand))
    if (names.has('Microsoft Edge')) return 'edge'
    if (names.has('Opera') || names.has('Opera GX')) return 'opera'
    if (names.has('Google Chrome')) return 'chrome'
    if (names.has('Chromium')) return 'other'
  }
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge'
  if (/OPR\/|Opera/.test(ua)) return 'opera'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox'
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

/**
 * Everything checks.ts needs to know about this browser, read once. `appUpdated` starts false;
 * the page sets it when a lazy chunk fails to load (onStaleBuild).
 */
export async function readEnvironment(source: EnvSource = browserSource()): Promise<BrowserEnv> {
  return { ...environmentNow(source), lna: await lnaPermission(source.navigator.permissions) }
}

/**
 * The same, without waiting on the Local Network Access query (`lna` is `unsupported`): what
 * the page renders its first frame with, so the Gate never flashes a wrong answer.
 */
export function environmentNow(source: EnvSource = browserSource()): BrowserEnv {
  const { navigator } = source
  return {
    secure: source.isSecureContext,
    https: source.location.protocol === 'https:',
    href: pageLink(source.location.href),
    webusb: 'usb' in navigator,
    usbPolicy: usbPolicy(source.document),
    inflate: canInflate(source.DecompressionStream),
    lna: 'unsupported',
    os: parseOs(navigator.userAgentData?.platform, navigator.platform ?? '', navigator.userAgent),
    browser: parseBrowser(navigator.userAgentData?.brands ?? [], navigator.userAgent),
    version: source.version,
    appUpdated: false,
  }
}

/* ---------------------------------------------------------------- *
 * A deploy under an open tab
 *
 * `npm run publish` replaces /assets/ wholesale, so a tab opened before a deploy asks for
 * lazy chunks that no longer exist. Vite announces a failed preload as `vite:preloadError`;
 * a failed import() rejects with one of these engine-specific messages.
 * ---------------------------------------------------------------- */

const STALE_BUILD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

/** Whether an error is a lazy chunk that is gone: Device Lab was updated while the tab was open. */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STALE_BUILD.test(message)
}

/**
 * Calls `listener` when Vite fails to preload a chunk. Returns the unsubscribe. The event is
 * not cancelled: the import still rejects, so the code that asked for it can fail visibly too.
 */
export function onStaleBuild(
  listener: () => void,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const handle = () => {
    listener()
  }
  target.addEventListener('vite:preloadError', handle)
  return () => {
    target.removeEventListener('vite:preloadError', handle)
  }
}

/* ---------------------------------------------------------------- *
 * The published helper (spec §12b `helper.update`)
 * ---------------------------------------------------------------- */

/** The built helper's version line; its banner and /api/health read the same constant. */
export const HELPER_VERSION_LINE = /^const VERSION = "([^"]+)";$/m

/** How long the Environment check waits for the published file before saying it couldn't. */
const PUBLISHED_TIMEOUT_MS = 10_000

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The helper file as published on bauloc.github.io: its VERSION and SHA-256, to compare with
 * /api/health's. Null when it can't be read (offline, not deployed yet: it 404s until then, or
 * a file without the version line). Never rejects. The request carries nothing of this page:
 * no credentials, no referrer.
 */
export async function readPublishedHelper(
  fetchImpl: typeof fetch = fetch,
  url: string = HELPER_URL,
): Promise<PublishedHelper | null> {
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(PUBLISHED_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const bytes = await response.arrayBuffer()
    const version = HELPER_VERSION_LINE.exec(new TextDecoder().decode(bytes))?.[1]
    if (!version || version.length > 40) return null
    return { version, sha256: toHex(await crypto.subtle.digest('SHA-256', bytes)) }
  } catch {
    return null
  }
}
