import type { AndroidFacts } from '../model'
import type { DeviceSpec } from './android/device-spec'
import type { Album, ImageRow } from './android/media'
import type { AppRow } from './android/packages'
import type { AppDetail } from './android/pm'
import type { InstallOutcome } from './android/pm-output'
import type { BadgeIcon } from './archive/apk-badge'
import { imageKey, type AppBadge, type Backend } from './backend'
import { limiter } from './webusb-ops'

/*
  The mock lane's Android operations: installs, apps and images with fake data, fake progress
  and every failure the real lane can report, so each state of the Install dialog, the Apps
  tab and the Images tab can be built and demoed with no phone. mock.ts documents the
  triggers; this file holds the fixtures and the behaviour.

  The fixtures are synthetic: the repo is public, so no real photo names and no private
  package lists. System packages are Android's and Google's public ones.
*/

/** How mock.ts lets these operations see and change its devices. */
export interface MockHooks {
  readonly isReady: (id: string) => boolean
  readonly facts: (id: string) => AndroidFacts | undefined
  /** The cable "comes out" for a few seconds: the device goes absent, then ready again. */
  readonly disconnect: (id: string) => void
}

type MockOps = Required<
  Pick<
    Backend,
    | 'install'
    | 'apps'
    | 'app'
    | 'appAction'
    | 'images'
    | 'thumbnail'
    | 'pull'
    | 'deviceSpec'
    | 'installFacts'
    | 'appBadge'
  >
>

/** What a page URL's `&apps=` and `&images=` ask the mock to do. */
function scenario(name: 'apps' | 'images'): string {
  try {
    return new URLSearchParams(globalThis.location.search).get(name) ?? ''
  } catch {
    return ''
  }
}

/** Waits, or rejects with the signal's reason when it aborts first. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/* ---------------------------------------------------------------- *
 * Installs: file-name triggers
 * ---------------------------------------------------------------- */

/**
 * The install outcomes a file name can ask for, as `<anything>-<trigger>.<ext>`, with what
 * pm would print. `{pkg}` and `{code}` are the app's package and versionCode.
 */
export const INSTALL_TRIGGERS = {
  incompatible:
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package {pkg} signatures do not match newer version; ignoring!]',
  downgrade:
    'Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code {code} is older than current {newer}]',
  'missing-split': 'Failure [INSTALL_FAILED_MISSING_SPLIT: Missing split for {pkg}]',
  'no-abis':
    'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
  'older-sdk':
    'Failure [INSTALL_FAILED_OLDER_SDK: Failed parse during installPackageLI: Requires newer sdk version #99 (current version is #{sdk})]',
  'deprecated-sdk':
    'Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: App package must target at least SDK version 24, but found 22]',
  unsigned:
    'Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES: Failed collecting certificates for /data/app/vmdl1.tmp/0.apk]',
  invalid: 'Failure [INSTALL_FAILED_INVALID_APK: Split null was defined multiple times]',
  'not-apk': 'Failure [INSTALL_PARSE_FAILED_NOT_APK: Failed to parse /data/app/vmdl1.tmp/0.apk]',
  'duplicate-permission':
    'Failure [INSTALL_FAILED_DUPLICATE_PERMISSION: Package {pkg} attempting to redeclare permission com.example.notes.permission.C2D already owned by com.example.notes.debug]',
  'conflicting-provider':
    'Failure [INSTALL_FAILED_CONFLICTING_PROVIDER: Can’t install because provider name com.example.notes.files (in package {pkg}) is already used by com.example.notes.debug]',
  'no-space':
    'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to override installation location]',
  restricted: 'Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]',
  aborted: 'Failure [INSTALL_FAILED_ABORTED: User rejected permissions]',
  verification: 'Failure [INSTALL_FAILED_VERIFICATION_FAILURE: Package Verification Result]',
  unknown: 'Failure [INSTALL_FAILED_INTERNAL_ERROR: Session relinquished]',
  warnings: 'Warning: Package {pkg} has a deprecated legacy permission\nCompleted with warning(s)',
  /** Success, after a commit long enough for the dialog's "Still installing" line. */
  slow: 'Success',
  /** The cable comes out halfway through sending. */
  disconnect: '',
} as const

export type InstallTrigger = keyof typeof INSTALL_TRIGGERS

/** The trigger in any of the dropped files' names, or null for a plain success. */
export function installTrigger(names: readonly string[]): InstallTrigger | null {
  const triggers = Object.keys(INSTALL_TRIGGERS) as InstallTrigger[]
  for (const name of names) {
    const stem = name.toLowerCase().replace(/\.[a-z0-9]+$/, '')
    // Longest first, so `-no-space` is never read as something shorter.
    const found = triggers
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((t) => stem.endsWith(`-${t}`))
    if (found) return found
  }
  return null
}

/** Whether an option the dialog offers gets past a trigger, as it would on a phone. */
function overcome(trigger: InstallTrigger, opts: Parameters<MockOps['install']>[2]): boolean {
  if (trigger === 'downgrade') return opts.allowDowngrade === true
  if (trigger === 'deprecated-sdk') return opts.bypassLowTargetSdkBlock === true
  return false
}

/** Bytes per second of fake sending: about what Tango manages over USB 3. */
const SEND_RATE = 20 * 1024 * 1024

/* ---------------------------------------------------------------- *
 * Apps
 * ---------------------------------------------------------------- */

interface MockApp {
  readonly packageName: string
  readonly label: string
  readonly versionName: string
  readonly versionCode: number
  readonly system: boolean
  readonly installer: string | null
  /** Days since the last update, and since the first install. */
  readonly updated: number
  readonly installed: number
  readonly targetSdk: number
  readonly minSdk: number
  readonly debuggable?: boolean
  /** No launcher activity: Open fails with APP_NOT_LAUNCHABLE. */
  readonly headless?: boolean
  readonly disabled?: boolean
  stopped?: boolean
  /** How its badge draws: a bitmap, an adaptive icon, or none (the initial). */
  readonly icon: 'bitmap' | 'adaptive' | null
  /** Hue of the icon, 0–360. */
  readonly hue: number
  readonly splits?: readonly string[]
}

/**
 * An app on a mock device: the fixture's "days ago" fixed as times when the device's list is
 * first made, and set again by an install. Fixed, not worked out from the clock on each apps()
 * call: the Apps tab keys a badge by version and update time, so a time that moved every call
 * would drop every badge after each install or uninstall.
 */
interface InstalledApp extends Omit<MockApp, 'updated' | 'installed'> {
  /** Epoch ms. */
  readonly lastUpdated: number
  readonly firstInstalled: number
}

const APP_FIXTURES: readonly MockApp[] = [
  // prettier-ignore
  ...([
    ['com.bauloc.bundleprobe', 'Bundle Probe', '1.0', 1, 0.2, 3, 35, 32, 'adaptive', 140, { debuggable: true, splits: ['config.arm64_v8a', 'config.en', 'config.xxhdpi'] }],
    ['com.example.notes', 'Notes', '4.2.0', 4200, 1, 120, 35, 26, 'bitmap', 45, {}],
    ['com.example.notes.debug', 'Notes (debug)', '4.3.0-dev', 4300, 0.5, 20, 35, 26, 'bitmap', 50, { debuggable: true }],
    ['com.example.shop', 'Shop', '12.8.1', 128100, 3, 400, 34, 24, 'adaptive', 10, { splits: ['config.arm64_v8a', 'config.en', 'config.xxhdpi'] }],
    ['com.example.maps.lite', 'Maps Lite', '2.1', 210, 12, 300, 33, 24, 'bitmap', 200, {}],
    ['com.example.flaky', 'Flaky Demo', '0.9.1', 91, 2, 60, 34, 24, null, 0, {}],
    ['org.example.reader', 'Reader', '7.0.3', 70003, 30, 600, 34, 23, 'adaptive', 260, {}],
    ['com.example.camera.pro', 'Camera Pro', '5.5', 550, 8, 210, 35, 29, 'bitmap', 330, {}],
    ['com.example.music', 'Music', '3.14.0', 31400, 5, 90, 35, 26, 'adaptive', 290, {}],
    ['com.example.fitness', 'Fitness', '1.8.2', 182, 45, 500, 33, 26, null, 100, { disabled: true }],
    ['dev.example.chat', 'Chat', '24.39.0', 2439000, 0.1, 700, 35, 28, 'adaptive', 170, {}],
    ['io.example.weather', 'Weather', '6.0.0', 600, 60, 800, 34, 24, 'bitmap', 210, { stopped: true }],
    ['com.example.wallet', 'Wallet', '9.1.0', 91000, 14, 365, 35, 28, 'bitmap', 120, {}],
  ] as const).map(
    ([packageName, label, versionName, versionCode, updated, installed, targetSdk, minSdk, icon, hue, extra]): MockApp => ({
      packageName, label, versionName, versionCode, updated, installed, targetSdk, minSdk, icon, hue,
      system: false,
      installer: packageName.includes('debug') || packageName.startsWith('com.bauloc') ? null : 'com.android.vending',
      ...extra,
    }),
  ),
  // prettier-ignore
  ...([
    ['android', 'Android System', '17', 37, 40, true, null],
    ['com.android.settings', 'Settings', '17', 37, 40, false, 'bitmap'],
    ['com.android.systemui', 'System UI', '17', 37, 40, true, null],
    ['com.android.providers.media', 'Media Storage', '17', 37, 40, true, null],
    ['com.android.vending', 'Google Play Store', '44.1.23', 84412300, 2, false, 'adaptive'],
    ['com.google.android.gms', 'Google Play services', '25.39.33', 253933000, 1, true, 'adaptive'],
    ['com.android.chrome', 'Chrome', '141.0.7390.70', 739007033, 6, false, 'adaptive'],
    ['com.google.android.apps.photos', 'Photos', '7.48.0', 79250000, 9, false, 'adaptive'],
    ['com.google.android.apps.messaging', 'Messages', '20250917', 312345678, 11, false, 'adaptive'],
    ['com.google.android.dialer', 'Phone', '199.0', 19900000, 20, false, 'adaptive'],
    ['com.google.android.deskclock', 'Clock', '8.4', 840, 50, false, 'bitmap'],
    ['com.google.android.inputmethod.latin', 'Gboard', '15.7.2', 157200, 4, true, null],
  ] as const).map(
    ([packageName, label, versionName, versionCode, updated, headless, icon], i): MockApp => ({
      packageName, label, versionName, versionCode, updated, headless, icon,
      installed: 700, targetSdk: 37, minSdk: 31, hue: (i * 47) % 360,
      system: true,
      installer: updated < 40 ? 'com.android.vending' : null,
    }),
  ),
]

/** `/data/app/~~<hash>==/<pkg>-<hash>==/base.apk`: the shape Android uses, `=` included. */
function apkDir(pkg: string): string {
  let h = 0
  for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const tag = h.toString(36).padStart(7, 'x')
  return `/data/app/~~${tag}Qa1x==/${pkg}-${tag}Zr2y==`
}

/** An app's APKs as app() lists them: base first, then its splits. */
function apksOf(
  app: Pick<MockApp, 'packageName' | 'versionCode' | 'splits'>,
): { path: string; size: number }[] {
  const dir = apkDir(app.packageName)
  return [
    { path: `${dir}/base.apk`, size: 8_000_000 + (app.versionCode % 40_000_000) },
    ...(app.splits ?? []).map((s, i) => ({
      path: `${dir}/split_${s}.apk`,
      size: i === 0 ? 2_400_000 : 60_000 + i * 15_000,
    })),
  ]
}

/** A transfer's progress at about 30 MB/s, at least 400 ms. */
async function stream(
  total: number,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const duration = Math.max(400, (total / (30 * 1024 * 1024)) * 1000)
  const started = Date.now()
  let sent = 0
  while (sent < total) {
    await wait(80, signal)
    sent = Math.min(total, Math.round((total * (Date.now() - started)) / duration))
    onProgress(sent, total)
  }
}

/** A device-local `yyyy-MM-dd HH:mm:ss`, as dumpsys prints it. */
function dumpTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ---------------------------------------------------------------- *
 * Images
 * ---------------------------------------------------------------- */

interface MockImage extends ImageRow {
  /** Android already made a thumbnail for it (else the original stands in, or nothing). */
  readonly cached: boolean
  readonly hue: number
}

const ORIGINAL_PREVIEW_LIMIT = 8 * 1024 * 1024

/** The phone's photos, newest first: screenshots, camera shots (some HEIC), downloads. */
function imageFixtures(now: number): MockImage[] {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = (ms: number, sep: string) => {
    const d = new Date(ms)
    return `${String(d.getFullYear())}${p(d.getMonth() + 1)}${p(d.getDate())}${sep}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }
  const rows: MockImage[] = []
  let id = 1000040000
  for (let i = 0; i < 75; i++) {
    const taken = now - i * 5 * HOUR - (i % 7) * 600_000
    const name = `Screenshot_${stamp(taken, '-')}.png`
    rows.push({
      id: String(id--),
      name,
      folder: 'Pictures/Screenshots/',
      size: 900_000 + ((i * 7919) % 2_400_000),
      taken,
      modified: taken,
      width: 1080,
      height: 2424,
      mime: 'image/png',
      path: `/storage/emulated/0/Pictures/Screenshots/${name}`,
      cached: i % 3 !== 2,
      hue: (i * 37) % 360,
    })
  }
  for (let i = 0; i < 24; i++) {
    const taken = now - (i * 17 + 3) * HOUR
    const heic = i % 6 === 4
    const huge = i === 9
    const unreadable = i === 13
    const name = `PXL_${stamp(taken, '_')}${String(100 + i)}${unreadable ? '-unreadable' : ''}.${heic ? 'heic' : 'jpg'}`
    rows.push({
      id: String(id--),
      name,
      folder: 'DCIM/Camera/',
      size: huge ? 14_200_000 : 2_600_000 + ((i * 104729) % 2_900_000),
      taken,
      modified: taken + 2000,
      width: i % 4 === 1 ? 3072 : 4080,
      height: i % 4 === 1 ? 4080 : 3072,
      mime: heic ? 'image/heic' : 'image/jpeg',
      path: `/storage/emulated/0/DCIM/Camera/${name}`,
      // Half the HEIC photos have a thumbnail Android made, which is a JPEG.
      cached: heic ? i % 12 === 4 : i % 2 === 0,
      hue: (i * 53 + 20) % 360,
    })
  }
  for (let i = 0; i < 6; i++) {
    const modified = now - (i * 41 + 9) * HOUR
    const name = `download-${String(i + 1)}.${i % 2 ? 'webp' : 'jpg'}`
    rows.push({
      id: String(id--),
      name,
      folder: 'Download/',
      size: 180_000 + i * 90_000,
      taken: null,
      modified,
      width: 1200,
      height: 800,
      mime: i % 2 ? 'image/webp' : 'image/jpeg',
      path: `/storage/emulated/0/Download/${name}`,
      cached: false,
      hue: (i * 61 + 200) % 360,
    })
  }
  return rows
}

const ALBUM_FOLDERS: Readonly<Record<Album, readonly string[]>> = {
  screenshots: ['Pictures/Screenshots/'],
  camera: ['DCIM/Camera/'],
  all: ['Pictures/Screenshots/', 'DCIM/Camera/', 'Download/'],
}

/** The row as a lane returns it, without the mock's own fields. */
function asRow(m: MockImage): ImageRow {
  return {
    id: m.id,
    name: m.name,
    folder: m.folder,
    size: m.size,
    taken: m.taken,
    modified: m.modified,
    width: m.width,
    height: m.height,
    mime: m.mime,
    path: m.path,
  }
}

/**
 * MediaStore's order as media.ts asks for it: when taken, else the file's time, newest first
 * (unknown last), then _id DESC. A download with no date taken sorts by when it was saved.
 */
export function newestFirst(a: ImageRow, b: ImageRow): number {
  const at = (r: ImageRow) => r.taken ?? r.modified ?? -1
  if (at(a) !== at(b)) return at(b) - at(a)
  return Number(b.id) - Number(a.id)
}

/* ---------------------------------------------------------------- *
 * Drawing (browser only: the mock lane never runs in tests)
 * ---------------------------------------------------------------- */

function canvas(width: number, height: number) {
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  return { el, ctx }
}

function toBlob(el: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    el.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('PREVIEW_NOT_IMAGE'))
      },
      type,
      quality,
    )
  })
}

/** A photo-like picture: a gradient, a sun, a horizon, and its name. */
async function drawImage(row: MockImage, width: number, height: number, type: string) {
  const { el, ctx } = canvas(width, height)
  const g = ctx.createLinearGradient(0, 0, width, height)
  g.addColorStop(0, `hsl(${String(row.hue)} 70% 60%)`)
  g.addColorStop(1, `hsl(${String((row.hue + 60) % 360)} 60% 30%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'hsl(48 100% 85% / 0.9)'
  ctx.beginPath()
  ctx.arc(width * 0.7, height * 0.3, Math.min(width, height) * 0.12, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = `hsl(${String((row.hue + 180) % 360)} 35% 22% / 0.85)`
  ctx.fillRect(0, height * 0.72, width, height * 0.28)
  ctx.fillStyle = 'rgb(255 255 255)'
  ctx.textAlign = 'center'
  ctx.font = `500 ${String(Math.round(Math.min(width, height) / 18))}px system-ui, sans-serif`
  ctx.fillText(row.name, width / 2, height * 0.88)
  return toBlob(el, type, 0.85)
}

/** An app icon: a rounded square and the label's initial, as PNG bytes. */
async function drawIcon(label: string, hue: number, transparent: boolean): Promise<Uint8Array> {
  const size = 192
  const { el, ctx } = canvas(size, size)
  if (!transparent) {
    ctx.fillStyle = `hsl(${String(hue)} 65% 45%)`
    ctx.beginPath()
    ctx.roundRect(0, 0, size, size, 40)
    ctx.fill()
  }
  ctx.fillStyle = 'rgb(255 255 255)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${String(transparent ? 64 : 96)}px system-ui, sans-serif`
  ctx.fillText(label.slice(0, 1).toUpperCase(), size / 2, size / 2 + 4)
  return new Uint8Array(await (await toBlob(el, 'image/png')).arrayBuffer())
}

/** hsl(hue 55% 40%) as 0xAARRGGBB, the way an adaptive icon's colour background comes. */
function argbFromHue(hue: number): number {
  const s = 0.55
  const l = 0.4
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return ((0xff << 24) | (f(0) << 16) | (f(8) << 8) | f(4)) >>> 0
}

async function iconFor(app: Pick<MockApp, 'icon' | 'label' | 'hue'>): Promise<BadgeIcon | null> {
  if (app.icon === 'bitmap') {
    const bytes = await drawIcon(app.label, app.hue, false)
    return { kind: 'bitmap', mime: 'image/png', bytes: new Uint8Array(bytes) }
  }
  if (app.icon === 'adaptive') {
    const bytes = await drawIcon(app.label, app.hue, true)
    return {
      kind: 'adaptive',
      foreground: { mime: 'image/png', bytes: new Uint8Array(bytes) },
      background: { argb: argbFromHue(app.hue) },
    }
  }
  return null
}

/* ---------------------------------------------------------------- *
 * The operations
 * ---------------------------------------------------------------- */

const PIXEL_SPEC: DeviceSpec = {
  supportedAbis: ['arm64-v8a'],
  supportedLocales: ['en-US', 'vi-VN'],
  deviceFeatures: [
    'android.hardware.camera',
    'android.hardware.nfc',
    'android.hardware.vulkan.level',
    'reqGlEsVersion=0x30002',
  ],
  glExtensions: [
    'GL_EXT_texture_compression_astc_decode_mode',
    'GL_KHR_texture_compression_astc_ldr',
  ],
  screenDensity: 420,
  sdkVersion: 37,
  ramBytes: 12_000_000_000,
  buildBrand: 'google',
  buildDevice: 'tokay',
  sdkRuntime: { supported: true },
}

export function createMockAndroid(hooks: MockHooks): MockOps {
  /** Installed apps per device: installs add to it, uninstalls take away. */
  const installed = new Map<string, Map<string, InstalledApp>>()
  const epoch = Date.now()
  const images = imageFixtures(epoch)
  const previews = limiter(3)
  const badgeReads = limiter(2)

  const appsOf = (id: string) => {
    let apps = installed.get(id)
    if (!apps) {
      apps = new Map(
        APP_FIXTURES.map(({ updated, installed: since, ...a }) => [
          a.packageName,
          {
            ...a,
            lastUpdated: Math.round(epoch - updated * DAY),
            firstInstalled: Math.round(epoch - since * DAY),
          },
        ]),
      )
      installed.set(id, apps)
    }
    return apps
  }
  const ready = (id: string): AndroidFacts => {
    const facts = hooks.facts(id)
    if (!hooks.isReady(id) || !facts) throw new Error('DEVICE_NOT_READY')
    return facts
  }
  const appOf = (id: string, pkg: string) => {
    const app = appsOf(id).get(pkg)
    if (!app) throw new Error('APP_NOT_INSTALLED')
    return app
  }
  const imageOf = (key: string) => {
    const row = images.find((r) => imageKey(r) === key || r.path === key)
    if (!row) throw new Error('PREVIEW_UNAVAILABLE')
    return row
  }

  function rowOf(app: InstalledApp): AppRow {
    return {
      packageName: app.packageName,
      apkPath: `${apkDir(app.packageName)}/base.apk`,
      versionCode: app.versionCode,
      installer: app.installer,
      system: app.system,
      uids: [10_000 + (app.hue % 900)],
      lastUpdated: app.lastUpdated,
      firstInstalled: app.firstInstalled,
      enabled: !app.disabled,
      stopped: app.stopped ?? false,
    }
  }

  async function outcomeFor(
    trigger: InstallTrigger | null,
    pkg: string,
    versionCode: number,
    sdk: number,
  ): Promise<InstallOutcome> {
    const { classifyPmOutput } = await import('./android/pm-output')
    const text = (trigger ? INSTALL_TRIGGERS[trigger] : 'Success')
      .replaceAll('{pkg}', pkg)
      .replaceAll('{code}', String(versionCode))
      .replaceAll('{newer}', String(versionCode + 100))
      .replaceAll('{sdk}', String(sdk))
    return classifyPmOutput(text || 'Success')
  }

  return {
    async install(id, plan, opts, onProgress, signal) {
      const facts = ready(id)
      if ((facts.sdk ?? 0) < 24) throw new Error('INSTALL_UNSUPPORTED')
      if (plan.problems.length > 0 || plan.parts.length === 0) throw new Error('NOTHING_TO_INSTALL')
      const pkg = plan.app?.packageName ?? 'com.example.unknown'
      let trigger = installTrigger(plan.inputs.map((input) => input.name))
      // UPDATE_INCOMPATIBLE only while the other build is there: "Uninstall and install" works.
      if (trigger === 'incompatible' && !appsOf(id).has(pkg)) trigger = null
      if (trigger && overcome(trigger, opts)) trigger = null

      const total = plan.totalBytes
      const duration = Math.min(15_000, Math.max(1200, (total / SEND_RATE) * 1000))
      const started = Date.now()
      let sent = 0
      onProgress({ phase: 'sending', sent, total })
      while (sent < total) {
        await wait(100, signal)
        sent = Math.min(total, Math.round((total * (Date.now() - started)) / duration))
        onProgress({ phase: 'sending', sent, total })
        if (trigger === 'disconnect' && sent >= total / 2) {
          hooks.disconnect(id)
          throw new Error('Socket closed')
        }
      }

      onProgress({ phase: 'installing', sent: total, total })
      // Android can't stop a commit: no signal here.
      await wait(trigger === 'slow' ? 14_000 : 1500)
      const outcome = await outcomeFor(trigger, pkg, plan.app?.versionCode ?? 1, facts.sdk ?? 0)
      if (outcome.ok && plan.app) {
        const app = plan.app
        const known = appsOf(id).get(pkg)
        const now = Date.now()
        appsOf(id).set(pkg, {
          packageName: pkg,
          label: app.label ?? pkg,
          versionName: app.versionName,
          versionCode: app.versionCode,
          system: known?.system ?? false,
          installer: null,
          lastUpdated: now,
          firstInstalled: known?.firstInstalled ?? now,
          targetSdk: app.targetSdk,
          minSdk: app.minSdk,
          debuggable: app.debuggable,
          icon: known?.icon ?? null,
          hue: known?.hue ?? 160,
        })
      }
      return outcome
    },

    async apps(id, scope) {
      ready(id)
      await wait(600)
      if (scenario('apps') === 'failed') {
        throw new Error('cmd: Can’t find service: package')
      }
      return Array.from(appsOf(id).values())
        .filter((a) => scope === 'all' || a.system === (scope === 'system'))
        .map(rowOf)
    },

    async app(id, pkg) {
      ready(id)
      await wait(300)
      const app = appOf(id, pkg)
      const dir = apkDir(pkg)
      const splits = app.splits ?? []
      const detail: AppDetail = {
        packageName: pkg,
        versionName: app.versionName,
        versionCode: app.versionCode,
        minSdk: app.minSdk,
        targetSdk: app.targetSdk,
        codePath: dir,
        dataDir: `/data/user/0/${pkg}`,
        splits: ['base', ...splits],
        installer: app.installer,
        firstInstalled: dumpTime(app.firstInstalled),
        lastUpdated: dumpTime(app.lastUpdated),
        debuggable: app.debuggable ?? false,
        testOnly: false,
        system: app.system,
        primaryCpuAbi: app.system ? null : 'arm64-v8a',
        user0: {
          installed: true,
          stopped: app.stopped ?? false,
          enabledState: app.disabled ? 3 : 0,
        },
        apks: apksOf(app),
      }
      return detail
    },

    async appAction(id, pkg, action) {
      ready(id)
      await wait(400)
      const app = appOf(id, pkg)
      if (pkg === 'com.example.flaky') {
        if (action === 'launch') {
          throw new Error(
            'Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] pkg=com.example.flaky }',
          )
        }
        if (action === 'clear') throw new Error('CLEAR_FAILED')
        if (action === 'uninstall') throw new Error('DELETE_FAILED_DEVICE_POLICY_MANAGER')
      }
      switch (action) {
        case 'launch':
          if (app.headless || app.disabled) throw new Error('APP_NOT_LAUNCHABLE')
          app.stopped = false
          return
        case 'stop':
        case 'clear':
          app.stopped = true
          return
        case 'info':
          return
        case 'uninstall':
          if (app.system) throw new Error('DELETE_FAILED_INTERNAL_ERROR')
          appsOf(id).delete(pkg)
          return
      }
    },

    async images(id, q) {
      ready(id)
      await wait(q.offset === 0 ? 700 : 400)
      const mode = scenario('images')
      if (mode === 'failed' && !q.folders) {
        throw new Error(
          'Permission Denial: reading com.android.providers.media.MediaProvider uri content://media/external/images/media from pid=12345, uid=2000',
        )
      }
      if (mode === 'empty') return []
      const folders = ALBUM_FOLDERS[q.album]
      const rows = images
        .filter((r) => folders.includes(r.folder))
        .map((r) =>
          // A folder listing knows no ids, dates taken or sizes in pixels.
          q.folders ? { ...asRow(r), id: '', taken: null, width: null, height: null } : asRow(r),
        )
      // A folder row has no date taken, so newestFirst orders it by file time, as media.ts does.
      rows.sort(newestFirst)
      return rows.slice(q.offset, q.offset + q.limit)
    },

    async thumbnail(id, mediaId, signal) {
      ready(id)
      return previews(async () => {
        await wait(150 + (Number(mediaId.replace(/\D/g, '').slice(-2)) % 5) * 60, signal)
        const row = imageOf(mediaId)
        if (row.name.includes('-unreadable')) throw new Error('FILE_READ_FAILED')
        // As media.ts previewSource: a cached thumbnail, else a small enough original.
        const original =
          !row.mime.startsWith('image/hei') && (row.size ?? 0) <= ORIGINAL_PREVIEW_LIMIT
        if (!row.cached && !original) throw new Error('PREVIEW_UNAVAILABLE')
        const w = row.width ?? 1200
        const h = row.height ?? 800
        const scale = Math.min(1, 384 / Math.max(w, h))
        return drawImage(row, Math.round(w * scale), Math.round(h * scale), 'image/jpeg')
      }, signal)
    },

    async pull(id, devicePath, onProgress, signal) {
      ready(id)
      const apk = Array.from(appsOf(id).values())
        .flatMap((a) => apksOf(a))
        .find((a) => a.path === devicePath)
      if (apk) {
        // Stand-in bytes: a saved mock APK is not meant to install.
        await stream(apk.size, onProgress, signal)
        return new Blob([new Uint8Array(apk.size)], {
          type: 'application/vnd.android.package-archive',
        })
      }
      const row = imageOf(devicePath)
      if (row.name.includes('-unreadable')) {
        await wait(300, signal)
        throw new Error('FILE_READ_FAILED')
      }
      const total = row.size ?? 1_000_000
      await stream(total, onProgress, signal)
      // Chrome can't decode HEIC: stand-in bytes, for the viewer's note and Save.
      if (row.mime.startsWith('image/hei')) {
        return new Blob([new Uint8Array(total)], { type: row.mime })
      }
      const w = row.width ?? 1200
      const h = row.height ?? 800
      const scale = Math.min(1, 2048 / Math.max(w, h))
      return drawImage(row, Math.round(w * scale), Math.round(h * scale), row.mime)
    },

    async deviceSpec(id) {
      const facts = ready(id)
      await wait(500)
      return {
        ...PIXEL_SPEC,
        supportedAbis: [...facts.abis],
        sdkVersion: facts.sdk ?? PIXEL_SPEC.sdkVersion,
        ...(facts.brand ? { buildBrand: facts.brand } : {}),
      }
    },

    async installFacts(id, pkg) {
      const facts = ready(id)
      await wait(400)
      const app = pkg === null ? undefined : appsOf(id).get(pkg)
      return {
        sdk: facts.sdk,
        freeBytes: 88_918_069_248,
        installed: app
          ? {
              versionCode: app.versionCode,
              versionName: app.versionName,
              debuggable: app.debuggable ?? false,
            }
          : null,
        verifyAdbInstalls: '1',
      }
    },

    async appBadge(id, pkg, signal): Promise<AppBadge> {
      ready(id)
      return badgeReads(async () => {
        await wait(200 + (pkg.length % 5) * 80, signal)
        const app = appOf(id, pkg)
        return { label: app.label, icon: await iconFor(app) }
      }, signal)
    },
  }
}
