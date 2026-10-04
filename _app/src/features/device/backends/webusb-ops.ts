import type { Adb } from '@yume-chan/adb'

import { MIN_INSTALL_SDK } from '../model'
import type { DeviceSpec } from './android/device-spec'
import type { ImageFormat, ImageRow, ImageSort } from './android/media'
import type { AppRow } from './android/packages'
import {
  imageKey,
  type AppBadge,
  type Backend,
  type InstallFacts,
  type InstallProgress,
} from './backend'

/*
  The WebUSB lane's Android operations (installs, apps, images), apart from webusb.ts, which
  owns the USB connection: here a connected phone is just an Adb, so every operation runs in
  tests against android/fake-adb.ts. Each one is a thin layer over the android/ modules, which
  hold the commands and the parsing, and those modules load on first use: a tester who only
  takes screenshots never downloads them, and android-bin loads on the first install only.

  Two rules from the plan are enforced here rather than by the callers:
  - previews never write to the phone: a thumbnail Android already made, else the original,
    never the thumbnail URI (which makes MediaProvider create one);
  - reads that share the cable with the log and screenshots are limited: three previews and
    two APK badge reads at a time per phone, whatever the UI asks for.
*/

/** One connected phone, as the operations see it. */
export interface OpsTarget {
  readonly adb: Adb
  readonly serial: string
  /** ro.build.version.sdk; null when connect couldn't read it. */
  readonly sdk: number | null
  /** False once this session is over (cable, Forget, a reconnect). */
  readonly alive: () => boolean
}

type OpName =
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

export type AndroidOps = Required<Pick<Backend, OpName>> & {
  /** Forgets what was cached for a device. Call it when its session ends. */
  readonly reset: (id: string) => void
  /**
   * Abandons install sessions an earlier connection left open: the cable was pulled, the tab
   * closed or the browser crashed mid-install. Android would otherwise keep their bytes for up
   * to three days.
   */
  readonly abandonLeftovers: (id: string) => Promise<void>
}

/** Previews read at once (media.ts PREVIEW_CONCURRENCY, kept here so media.ts loads lazily). */
const PREVIEW_READS = 3
/** APK badge reads at once: each is several `dd` commands, up to ~2 MB. */
const BADGE_READS = 2
/** A photo or video pulled into the tab is refused past this size. */
const PULL_MAX_BYTES = 512 * 1024 * 1024
/** An app's APK, likewise: a game's base.apk can pass 512 MB. */
const APK_PULL_MAX_BYTES = 1024 * 1024 * 1024
const APK_TYPE = 'application/vnd.android.package-archive'

const loadPm = () => import('./android/pm')
const loadPmOutput = () => import('./android/pm-output')
const loadMedia = () => import('./android/media')
const loadFiles = () => import('./android/files')
const loadSpec = () => import('./android/device-spec')
const loadBadge = () => import('./archive/apk-badge')

/* ---------------------------------------------------------------- *
 * A concurrency limit
 * ---------------------------------------------------------------- */

export type Limiter = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>

/**
 * Runs at most `concurrency` tasks at once, the rest in order of arrival. A task whose signal
 * aborts while it waits is dropped and rejects with the signal's reason; one already running
 * is the task's own business.
 */
export function limiter(concurrency: number): Limiter {
  let running = 0
  const waiting: (() => void)[] = []
  const next = () => {
    if (running < concurrency) waiting.shift()?.()
  }
  return <T>(task: () => Promise<T>, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error)
        return
      }
      const start = () => {
        signal?.removeEventListener('abort', drop)
        running++
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running--
            next()
          })
      }
      const drop = () => {
        const at = waiting.indexOf(start)
        if (at < 0) return
        waiting.splice(at, 1)
        reject(signal?.reason as Error)
      }
      signal?.addEventListener('abort', drop, { once: true })
      waiting.push(start)
      next()
    })
}

/* ---------------------------------------------------------------- *
 * Install sessions left open, per serial, across tabs
 * ---------------------------------------------------------------- */

/** The part of Storage this uses: localStorage in the browser, a Map-backed one in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const OPEN_SESSIONS_KEY = 'device-lab.open-install-sessions'

/**
 * localStorage, or null where it is missing or throws (a sandboxed frame, a preview, blocked
 * cookies). Not sessionStorage: a session left open by a tab that was closed or crashed
 * mid-send is only found again by the next tab that connects the phone, and a few ids per
 * serial are all it holds.
 */
export function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Session ids by serial. Best effort: storage that fails only means a session left open waits
 * for Android's own clean-up.
 */
export function openSessions(store: KeyValueStore | null) {
  const read = (): Record<string, number[]> => {
    try {
      const parsed: unknown = JSON.parse(store?.getItem(OPEN_SESSIONS_KEY) ?? '{}')
      if (typeof parsed !== 'object' || parsed === null) return {}
      const out: Record<string, number[]> = {}
      for (const [serial, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) out[serial] = ids.filter((n): n is number => Number.isInteger(n))
      }
      return out
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, number[]>) => {
    try {
      const kept = Object.fromEntries(Object.entries(all).filter(([, ids]) => ids.length > 0))
      if (Object.keys(kept).length === 0) store?.removeItem(OPEN_SESSIONS_KEY)
      else store?.setItem(OPEN_SESSIONS_KEY, JSON.stringify(kept))
    } catch {
      // Full or blocked: see above.
    }
  }
  return {
    list: (serial: string): number[] => read()[serial] ?? [],
    add(serial: string, id: number) {
      const all = read()
      all[serial] = [...new Set([...(all[serial] ?? []), id])]
      write(all)
    },
    remove(serial: string, id: number) {
      const all = read()
      all[serial] = (all[serial] ?? []).filter((n) => n !== id)
      write(all)
    },
  }
}

/* ---------------------------------------------------------------- *
 * The operations
 * ---------------------------------------------------------------- */

const IMAGE_TYPES: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heif: 'image/heif',
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What is remembered per phone while its session lasts. */
interface DeviceCache {
  /** Rows from apps(), so a badge is cached by version and update time. */
  readonly apps: Map<string, AppRow>
  /**
   * Rows from images(), by imageKey, so thumbnail() knows the file behind an id. Every row of
   * the listing on screen stays here (the tab holds the same rows anyway): one dropped would
   * leave its tile with no preview when it scrolls back into view.
   */
  readonly images: Map<string, ImageRow>
  /** The sort MediaStore took on this connection; null until a page has been listed. */
  imageSort: ImageSort | null
  /** The APKs app() found with `pm path`: the only files outside shared storage pull() reads. */
  readonly apkPaths: Set<string>
  /** The thumbnails Android already made: listed once per Images tab load. */
  thumbnails: Promise<ReadonlyMap<string, number>> | null
  spec: Promise<DeviceSpec> | null
  readonly badges: Map<string, Promise<AppBadge>>
  readonly previews: Limiter
  readonly badgeReads: Limiter
}

export interface AndroidOpsOptions {
  /** Where open install sessions are remembered; localStorage by default. */
  readonly store?: KeyValueStore | null
}

/**
 * The operations over whichever phone `target` names. `target` throws DEVICE_NOT_READY for
 * a device that has no session, which every operation passes on.
 */
export function createAndroidOps(
  target: (id: string) => OpsTarget,
  options: AndroidOpsOptions = {},
): AndroidOps {
  const caches = new Map<string, DeviceCache>()
  const sessions = openSessions(options.store === undefined ? defaultStore() : options.store)

  const cache = (id: string): DeviceCache => {
    let c = caches.get(id)
    if (!c) {
      c = {
        apps: new Map(),
        images: new Map(),
        imageSort: null,
        apkPaths: new Set(),
        thumbnails: null,
        spec: null,
        badges: new Map(),
        previews: limiter(PREVIEW_READS),
        badgeReads: limiter(BADGE_READS),
      }
      caches.set(id, c)
    }
    return c
  }

  const installable = (t: OpsTarget): number => {
    if (t.sdk === null || t.sdk < MIN_INSTALL_SDK) throw new Error('INSTALL_UNSUPPORTED')
    return t.sdk
  }

  async function deviceSpec(id: string): Promise<DeviceSpec> {
    const t = target(id)
    const c = cache(id)
    const pending = (c.spec ??= loadSpec()
      .then((m) => m.collectDeviceSpec(t.adb))
      .then((r) => r.spec))
    // A failure is not remembered: the next ask tries again.
    pending.catch(() => {
      if (c.spec === pending) c.spec = null
    })
    return pending
  }

  async function readBadge(id: string, pkg: string): Promise<AppBadge> {
    const t = target(id)
    const [pm, files, badges, spec] = await Promise.all([
      loadPm(),
      loadFiles(),
      loadBadge(),
      deviceSpec(id).catch(() => null),
    ])
    const [base, ...splits] = await pm.apkPaths(t.adb, pkg)
    if (base === undefined) throw new Error('APP_NOT_INSTALLED')
    const badge = await badges.readApkBadge(
      await files.openDeviceFile(t.adb, base),
      splits.map((path) => ({
        name: badges.splitNameOf(path),
        open: () => files.openDeviceFile(t.adb, path),
      })),
      {
        ...(spec ? { locales: spec.supportedLocales, density: spec.screenDensity } : {}),
        ...(t.sdk === null ? {} : { sdk: t.sdk }),
      },
    )
    return { label: badge.label, icon: badge.icon }
  }

  return {
    reset(id) {
      caches.delete(id)
    },

    async abandonLeftovers(id) {
      const t = target(id)
      const left = sessions.list(t.serial)
      if (left.length === 0 || t.sdk === null || t.sdk < MIN_INSTALL_SDK) return
      const pm = await loadPm()
      for (const sessionId of left) {
        // Answered either way (abandoned, or pm no longer knows it): forget it. No answer at
        // all means the phone went again; keep it for the next connection.
        const answered = await pm.abandonInstallSession(t.adb, t.sdk, sessionId).then(
          () => true,
          () => false,
        )
        if (answered) sessions.remove(t.serial, sessionId)
      }
    },

    async install(id, plan, opts, onProgress, signal) {
      const t = target(id)
      const sdk = installable(t)
      if (plan.problems.length > 0 || plan.parts.length === 0) throw new Error('NOTHING_TO_INSTALL')
      const [pm, output] = await Promise.all([loadPm(), loadPmOutput()])
      let progress: InstallProgress = { phase: 'sending', sent: 0, total: plan.totalBytes }
      const report = (patch: Partial<InstallProgress>) => {
        progress = { ...progress, ...patch }
        onProgress(progress)
      }
      let open: number | null = null
      try {
        const outcome = await pm.runInstall(t.adb, plan.parts, {
          sdk,
          allowTest: plan.app?.testOnly ?? false,
          allowDowngrade: opts.allowDowngrade ?? false,
          grantPermissions: opts.grantPermissions ?? false,
          bypassLowTargetSdkBlock: opts.bypassLowTargetSdkBlock ?? false,
          signal,
          onProgress: (sent, total) => {
            report({ sent, total })
          },
          onPhase: (phase) => {
            report({ phase })
          },
          onSession: (sessionId) => {
            if (sessionId !== null) sessions.add(t.serial, sessionId)
            else if (open !== null) sessions.remove(t.serial, open)
            open = sessionId
          },
        })
        if (outcome.ok) cache(id).badges.clear()
        return outcome
      } catch (error) {
        // A Cancel, or a failure while the phone is still there: the caller words it.
        if (signal.aborted || t.alive()) throw error
        return output.installFailure('CONNECTION_LOST', messageOf(error), '', null, {
          phase: progress.phase,
        })
      }
    },

    async apps(id, scope) {
      const t = target(id)
      const pm = await loadPm()
      // An unknown API level takes the `pm` route, which every Android has.
      const rows = await pm.listApps(t.adb, t.sdk ?? 0, scope)
      const c = cache(id)
      for (const row of rows) c.apps.set(row.packageName, row)
      return rows
    },

    async app(id, pkg) {
      const t = target(id)
      const detail = await (await loadPm()).appDetail(t.adb, pkg)
      const known = cache(id).apkPaths
      for (const apk of detail.apks) known.add(apk.path)
      return detail
    },

    async appAction(id, pkg, action) {
      const t = target(id)
      const pm = await loadPm()
      switch (action) {
        case 'launch':
          return pm.launchApp(t.adb, t.sdk ?? 0, pkg)
        case 'stop':
          return pm.stopApp(t.adb, pkg)
        case 'info':
          return pm.openAppInfo(t.adb, pkg)
        case 'clear':
          return pm.clearAppData(t.adb, pkg)
        case 'uninstall': {
          await pm.uninstallApp(t.adb, pkg)
          cache(id).apps.delete(pkg)
          return
        }
      }
    },

    async images(id, q) {
      const t = target(id)
      const media = await loadMedia()
      const c = cache(id)
      let rows: ImageRow[]
      if (q.folders) {
        rows = (await media.listFolderImages(t.adb, q.album)).slice(q.offset, q.offset + q.limit)
      } else {
        const page = { offset: q.offset, limit: q.limit }
        const listed = await media.queryImages(t.adb, t.sdk ?? 0, q.album, page, {
          ...(c.imageSort ? { sort: c.imageSort } : {}),
        })
        c.imageSort = listed.sort
        rows = listed.rows
      }
      // A first page is a new listing (an album, Refresh): the rows of the one before go, and
      // thumbnails made since are worth finding. Later pages only add to it.
      if (q.offset === 0) {
        c.thumbnails = null
        c.images.clear()
      }
      for (const row of rows) c.images.set(imageKey(row), row)
      return rows
    },

    async thumbnail(id, mediaId, signal) {
      const t = target(id)
      const c = cache(id)
      const row = c.images.get(mediaId)
      if (!row) throw new Error('PREVIEW_UNAVAILABLE')
      const media = await loadMedia()
      return c.previews(async () => {
        // One folder listing, read-only; a phone that refuses it just has no cached ones.
        c.thumbnails ??= media.listThumbnailCache(t.adb).catch(() => new Map<string, number>())
        const source = media.previewSource(row, await c.thumbnails)
        const bytes = await media.readPreview(t.adb, source, signal)
        const format = media.sniffImage(bytes)
        return new Blob([bytes], { type: format ? IMAGE_TYPES[format] : row.mime })
      }, signal)
    },

    async pull(id, devicePath, onProgress, signal) {
      const t = target(id)
      const [media, files] = await Promise.all([loadMedia(), loadFiles()])
      const apk = cache(id).apkPaths.has(devicePath)
      if (!apk && !media.isMediaPath(devicePath)) throw new Error('NOT_A_MEDIA_FILE')
      const type = apk ? APK_TYPE : media.mimeFromName(devicePath) || 'application/octet-stream'
      return files.pullBlob(t.adb, devicePath, type, {
        signal,
        maxBytes: apk ? APK_PULL_MAX_BYTES : PULL_MAX_BYTES,
        onProgress: (received, total) => {
          onProgress(received, total ?? 0)
        },
      })
    },

    deviceSpec,

    async installFacts(id, pkg) {
      const t = target(id)
      const pm = await loadPm()
      const [freeBytes, installed, verifyAdbInstalls] = await Promise.all([
        pm.dataFreeBytes(t.adb).catch(() => null),
        pkg === null
          ? null
          : pm.installedPackage(t.adb, pkg).then(
              (dump): InstallFacts['installed'] =>
                dump === null
                  ? null
                  : dump.versionCode === null
                    ? undefined
                    : {
                        versionCode: dump.versionCode,
                        versionName: dump.versionName ?? '',
                        debuggable: dump.debuggable,
                      },
              () => undefined,
            ),
        pm.readGlobalSetting(t.adb, 'verifier_verify_adb_installs').catch(() => null),
      ])
      return { sdk: t.sdk, freeBytes, installed, verifyAdbInstalls }
    },

    async appBadge(id, pkg, signal) {
      target(id) // DEVICE_NOT_READY before anything is queued
      const c = cache(id)
      const row = c.apps.get(pkg)
      const key = row ? `${pkg}@${String(row.versionCode)}@${String(row.lastUpdated)}` : pkg
      const known = c.badges.get(key)
      if (known) return known
      const pending = c.badgeReads(() => readBadge(id, pkg), signal)
      c.badges.set(key, pending)
      // A failure (or a row scrolled away before its turn) is not remembered.
      pending.catch(() => {
        if (c.badges.get(key) === pending) c.badges.delete(key)
      })
      return pending
    },
  }
}
