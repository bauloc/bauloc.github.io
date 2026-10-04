import {
  androidError,
  assertPackageName,
  isPackageName,
  shellCmd,
  type ShellCommand,
} from './shell'

/*
  Installed apps, as text the phone prints and the commands that make it print it. Pure: the
  formats come from AOSP main (PackageManagerShellCommand.runListPackages, Settings.
  dumpPackageLPr) and from the read-only probe's notes, and the Pixel run will record the real
  thing.

  No shell command prints an app's label or icon: those are read out of the APK itself, lazily
  (apkPath below is where). Until one is read, the package name stands in.
*/

export type AppScope = 'user' | 'system' | 'all'

/** One `package:` line of `pm list packages`. */
export interface PmListRow {
  readonly name: string
  /** base.apk (`-f`). */
  readonly path: string | null
  readonly versionCode: number | null
  /** The installer's package name; null when Android recorded none (`installer=null`). */
  readonly installer: string | null
  /** Every user the package is installed for, as uids (`-U`). */
  readonly uids: readonly number[]
  /** Only with the undocumented `--show-stopped`; null otherwise. */
  readonly stopped: boolean | null
}

/**
 * `package:[<path>=]<name>[ versionCode:<n>][ stopped=<b>][  installer=<pkg>][ uid:<u>[,<u>]]`.
 * Read from the right, field by field, because the path holds `=` (base64 directory names): the
 * name is what follows the LAST `=`. Lines come in HashMap order, so sort them yourself. Anything
 * that is not a `package:` line (an `Error: Unknown option` line, say) is skipped, and a package
 * listed twice (two users on different versions) is kept once.
 */
export function parsePmList(text: string): PmListRow[] {
  const rows = new Map<string, PmListRow>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('package:')) continue
    let rest = line.slice('package:'.length).trimEnd()
    const take = (re: RegExp): string | undefined => {
      const m = re.exec(rest)
      if (!m) return undefined
      rest = rest.slice(0, m.index)
      return m[1] ?? ''
    }
    const uids = (take(/ uid:([\d,]+)$/) ?? '').split(',').filter(Boolean).map(Number)
    // Two spaces before installer= on AOSP main; take one or both.
    const installer = take(/ {1,2}installer=(\S*)$/)
    const stopped = take(/ stopped=(true|false)$/)
    const versionCode = take(/ versionCode:(-?\d+)$/)
    rest = rest.trim()
    const eq = rest.lastIndexOf('=')
    const name = rest.slice(eq + 1)
    if (!isPackageName(name)) continue
    const known = rows.get(name)
    if (known) {
      rows.set(name, { ...known, uids: [...new Set([...known.uids, ...uids])] })
      continue
    }
    rows.set(name, {
      name,
      path: eq >= 0 ? rest.slice(0, eq) : null,
      versionCode: versionCode === undefined ? null : Number(versionCode),
      installer:
        installer === undefined || installer === 'null' || installer === '' ? null : installer,
      uids,
      stopped: stopped === undefined ? null : stopped === 'true',
    })
  }
  return Array.from(rows.values())
}

/**
 * The list command for one scope. `cmd package` from Android 7 (it answers without starting a
 * JVM), `pm` before. `minimal` drops the flags an older or OEM pm may not know (`-U`,
 * `--show-versioncode`), for the retry after "Unknown option".
 */
export function listPackagesCommand(
  sdk: number,
  scope: Exclude<AppScope, 'all'>,
  minimal = false,
): ShellCommand {
  const tool = sdk >= 24 ? shellCmd`cmd package` : shellCmd`pm`
  const extra = minimal || sdk < 24 ? shellCmd`` : shellCmd` -U --show-versioncode`
  const which = scope === 'user' ? shellCmd`-3` : shellCmd`-s`
  return shellCmd`${tool} list packages -f -i${extra} ${which}`
}

/** pm's answer to a flag it does not know: the whole listing is refused, not just the flag. */
export const hasUnknownOption = (text: string) => /Unknown option/i.test(text)

/* ---------------------------------------------------------------- *
 * dumpsys package --checkin: times and state for every package at once
 * ---------------------------------------------------------------- */

export interface CheckinUser {
  readonly id: number
  readonly installed: boolean
  readonly stopped: boolean
  /** PackageManager.COMPONENT_ENABLED_STATE_*: 0 default, 1 enabled, 2 disabled, 3 disabled by
   *  the user, 4 disabled until used. */
  readonly enabledState: number
  /** Epoch ms; null on Android versions that keep it per package, not per user. */
  readonly firstInstalled: number | null
}

export interface CheckinPackage {
  readonly name: string
  readonly versionCode: number | null
  /** Epoch ms: no time zone involved, unlike dumpsys package's dates. */
  readonly lastUpdated: number | null
  /** Epoch ms; per package on older Android, else from user 0's line. */
  readonly firstInstalled: number | null
  readonly splits: readonly string[]
  readonly users: readonly CheckinUser[]
}

export const CHECKIN_COMMAND = shellCmd`dumpsys package --checkin`

const epochMs = (value: string | undefined) => {
  const n = Number(value)
  return value && /^\d+$/.test(value) && n > 0 ? n : null
}

/**
 * The per-user flags of a `pkg-usr` line, letters in AOSP's order: I/i installed, B/b hidden,
 * SU/su suspended (Android 7+), S/s stopped, l/L not launched, then IA, VPI, Q and HA. A capital
 * means true, except `l`. Android 6 has no suspended pair, so `su` is only taken when it is there.
 */
export function parseCheckinFlags(flags: string): { installed: boolean; stopped: boolean } {
  let at = 0
  const installed = flags[at++] === 'I'
  at++ // hidden
  if (/^(SU|su)/.test(flags.slice(at))) at += 2
  const stopped = flags[at] === 'S'
  return { installed, stopped }
}

/**
 * `pkg,…` lines, each followed by its `pkg-splt` and `pkg-usr` lines. Two layouts exist:
 * - AOSP main: `pkg,<name>,<appId>,<versionCode>,<lastUpdate>,<installer><uid><owner>,<source>`,
 *   and the first-install time per user, on `pkg-usr,<user>,<flags>,<enabled>,<caller>,<first>,`;
 * - older Android: `pkg,<name>,<appId>,<versionCode>,<firstInstall>,<lastUpdate>,<installer>`.
 * They are told apart by field 5: a time (all digits) only in the older layout. The installer
 * is not read from here: main glues name, uid and owner together with no separator, and
 * `pm list packages -i` already says it plainly.
 */
export function parseCheckin(text: string): Map<string, CheckinPackage> {
  type Building = { pkg: CheckinPackage; splits: string[]; users: CheckinUser[] }
  const out = new Map<string, Building>()
  let current: Building | null = null
  for (const raw of text.split('\n')) {
    const f = raw.replace(/\r$/, '').split(',')
    if (f[0] === 'pkg' && f[1]) {
      const older = /^\d+$/.test(f[5] ?? '')
      const splits: string[] = []
      const users: CheckinUser[] = []
      current = {
        pkg: {
          name: f[1],
          versionCode: /^-?\d+$/.test(f[3] ?? '') ? Number(f[3]) : null,
          lastUpdated: epochMs(older ? f[5] : f[4]),
          firstInstalled: older ? epochMs(f[4]) : null,
          splits,
          users,
        },
        splits,
        users,
      }
      out.set(f[1], current)
    } else if (f[0] === 'pkg-splt' && current && f[1]) {
      current.splits.push(f[1])
    } else if (f[0] === 'pkg-usr' && current && f[1] && f[2]) {
      const { installed, stopped } = parseCheckinFlags(f[2])
      current.users.push({
        id: Number(f[1]),
        installed,
        stopped,
        enabledState: Number(f[3] ?? 0) || 0,
        firstInstalled: epochMs(f[5]),
      })
    }
  }
  return new Map(
    Array.from(out, ([name, { pkg, users }]) => {
      const owner = users.find((u) => u.id === 0)
      return [name, { ...pkg, firstInstalled: pkg.firstInstalled ?? owner?.firstInstalled ?? null }]
    }),
  )
}

/* ---------------------------------------------------------------- *
 * The rows of the Apps tab
 * ---------------------------------------------------------------- */

export interface AppRow {
  readonly packageName: string
  /** base.apk: where the label and icon are read from. */
  readonly apkPath: string | null
  readonly versionCode: number | null
  /** The installer's package name; installerName() words it. */
  readonly installer: string | null
  readonly system: boolean
  readonly uids: readonly number[]
  /** Epoch ms; null when `--checkin` did not answer, and the list then sorts by name. */
  readonly lastUpdated: number | null
  readonly firstInstalled: number | null
  /** User 0's state; null when unknown. */
  readonly enabled: boolean | null
  readonly stopped: boolean | null
}

/** One list per scope it was asked for (`-3` and `-s` for All), joined with the checkin data. */
export function mergeApps(
  lists: readonly { readonly rows: readonly PmListRow[]; readonly system: boolean }[],
  checkin: ReadonlyMap<string, CheckinPackage>,
): AppRow[] {
  const out = new Map<string, AppRow>()
  for (const { rows, system } of lists) {
    for (const row of rows) {
      if (out.has(row.name)) continue
      const facts = checkin.get(row.name)
      const owner = facts?.users.find((u) => u.id === 0)
      out.set(row.name, {
        packageName: row.name,
        apkPath: row.path,
        versionCode: row.versionCode ?? facts?.versionCode ?? null,
        installer: row.installer,
        system,
        uids: row.uids,
        lastUpdated: facts?.lastUpdated ?? null,
        firstInstalled: facts?.firstInstalled ?? null,
        enabled: owner ? owner.enabledState <= 1 : null,
        stopped: owner ? owner.stopped : row.stopped,
      })
    }
  }
  return Array.from(out.values())
}

export type AppSort = 'updated' | 'name'

/**
 * "Recently updated" (newest first, unknown times last) or "Name". Names are the labels read
 * from the APKs where known, else package names.
 */
export function sortApps(
  rows: readonly AppRow[],
  by: AppSort,
  labels?: ReadonlyMap<string, string>,
): AppRow[] {
  const name = (row: AppRow) => labels?.get(row.packageName) ?? row.packageName
  return rows.slice().sort((a, b) => {
    if (by === 'updated' && a.lastUpdated !== b.lastUpdated) {
      if (a.lastUpdated === null) return 1
      if (b.lastUpdated === null) return -1
      return b.lastUpdated - a.lastUpdated
    }
    return name(a).localeCompare(name(b)) || a.packageName.localeCompare(b.packageName)
  })
}

/** The filter box: a case-insensitive match on the package name, the label and the installer. */
export function appMatches(row: AppRow, filter: string, label?: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  return [row.packageName, label ?? '', installerName(row.installer)]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

/** Stores and installers a tester will recognise; anything else shows its package name. */
const INSTALLERS: Readonly<Record<string, string>> = {
  'com.android.vending': 'Google Play',
  'com.google.android.packageinstaller': 'Package installer',
  'com.android.packageinstaller': 'Package installer',
  'com.android.shell': 'adb',
  'com.sec.android.app.samsungapps': 'Galaxy Store',
  'com.huawei.appmarket': 'AppGallery',
  'com.xiaomi.market': 'Xiaomi GetApps',
  'com.amazon.venezia': 'Amazon Appstore',
  'dev.firebase.appdistribution': 'Firebase App Tester',
  'org.fdroid.fdroid': 'F-Droid',
}

export function installerName(installer: string | null): string {
  if (!installer) return 'Unknown'
  return INSTALLERS[installer] ?? installer
}

/* ---------------------------------------------------------------- *
 * One app: dumpsys package <pkg> and pm path <pkg>
 * ---------------------------------------------------------------- */

export interface PackageDump {
  readonly packageName: string
  readonly versionName: string | null
  readonly versionCode: number | null
  readonly minSdk: number | null
  readonly targetSdk: number | null
  readonly codePath: string | null
  /** User 0's data folder. */
  readonly dataDir: string | null
  /** `base` first, then the split names, without revision numbers. */
  readonly splits: readonly string[]
  readonly installer: string | null
  /**
   * Device-local `yyyy-MM-dd HH:mm:ss` with NO offset: show it with the phone's time zone
   * (persist.sys.timezone). The checkin times in AppRow are the unambiguous ones.
   */
  readonly firstInstalled: string | null
  readonly lastUpdated: string | null
  readonly debuggable: boolean
  readonly testOnly: boolean
  readonly system: boolean
  readonly primaryCpuAbi: string | null
  /** User 0's `User 0:` line. */
  readonly user0: {
    readonly installed: boolean
    readonly stopped: boolean
    readonly enabledState: number
  } | null
}

/**
 * The lines of `<pkg>`'s block in the `Packages:` section. The `Hidden system packages:` section
 * repeats the factory copy of an updated system app under the same header, so the search starts
 * at `Packages:` when the dump has one.
 */
function packageBlock(text: string, pkg: string): string[] | null {
  const lines = text.replace(/\r/g, '').split('\n')
  const section = lines.indexOf('Packages:')
  const header = `  Package [${pkg}]`
  const start = lines.findIndex((line, i) => i > section && line.startsWith(header))
  if (start < 0) return null
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    // The block's own lines are indented by four or more; anything less ends it.
    if (!line.startsWith('    ')) break
    block.push(line.trim())
  }
  return block
}

/** The block of `dumpsys package <pkg>` for one app, or null when the app is not installed. */
export function parseDumpsysPackage(text: string, pkg: string): PackageDump | null {
  const block = packageBlock(text, pkg)
  if (!block) return null
  /** The first `key=value` line for `key`; values may hold spaces (versionName). */
  const value = (key: string) => {
    const line = block.find((l) => l.startsWith(`${key}=`))
    return line === undefined ? null : line.slice(key.length + 1)
  }
  const numberIn = (re: RegExp) => {
    for (const line of block) {
      const m = re.exec(line)
      if (m?.[1] !== undefined) return Number(m[1])
    }
    return null
  }
  const nullable = (v: string | null) => (v === null || v === '' || v === 'null' ? null : v)
  const flags = (value('flags') ?? '').replace(/[[\]]/g, ' ').split(/\s+/).filter(Boolean)
  const splits = (value('splits') ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/:\d+$/, ''))
    .filter(Boolean)
  const user = block.find((l) => l.startsWith('User 0:'))
  const userFlag = (key: string) =>
    user ? new RegExp(`\\b${key}=(\\w+)`).exec(user)?.[1] : undefined
  return {
    packageName: pkg,
    versionName: nullable(value('versionName')),
    versionCode: numberIn(/^versionCode=(\d+)/),
    minSdk: numberIn(/\bminSdk=(\d+)/),
    targetSdk: numberIn(/\btargetSdk=(\d+)/),
    codePath: nullable(value('codePath')),
    dataDir: nullable(value('dataDir')),
    splits,
    installer: nullable(value('installerPackageName')),
    // Package-level on older Android; on main the first one is user 0's.
    firstInstalled: nullable(value('firstInstallTime')),
    lastUpdated: nullable(value('lastUpdateTime')),
    debuggable: flags.includes('DEBUGGABLE'),
    testOnly: flags.includes('TEST_ONLY'),
    system: flags.includes('SYSTEM'),
    primaryCpuAbi: nullable(value('primaryCpuAbi')),
    user0: user
      ? {
          installed: userFlag('installed') !== 'false',
          stopped: userFlag('stopped') === 'true',
          enabledState: Number(userFlag('enabled') ?? 0) || 0,
        }
      : null,
  }
}

/** `pm path <pkg>`: `package:<path>` per APK, base first. Nothing (and exit 1) when not installed. */
export function parsePmPath(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length))
    .filter(Boolean)
}

/* ---------------------------------------------------------------- *
 * Launching: which activity a launcher would open
 * ---------------------------------------------------------------- */

const COMPONENT = /^([A-Za-z][\w]*(?:\.\w+)*)\/(\.?[\w$]+(?:\.[\w$]+)*)$/

export function assertComponent(value: string): string {
  if (!COMPONENT.test(value)) throw androidError('INVALID_COMPONENT')
  return value
}

/**
 * The first `pkg/.Activity` line of resolve-activity or query-activities `--brief` output that
 * belongs to `pkg`. resolve-activity names Android's chooser
 * (`android/com.android.internal.app.ResolverActivity`) when an app has two launcher activities,
 * which debug builds often do (LeakCanary adds one); that is not the app, so it is skipped.
 */
export function launcherFrom(text: string, pkg: string): string | null {
  for (const raw of text.split('\n')) {
    const m = COMPONENT.exec(raw.trim())
    if (m && m[1] === pkg) return m[0]
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Free space, for the install checks
 * ---------------------------------------------------------------- */

/** `df /data` (1K blocks) → bytes available, or null when the output is not that table. */
export function parseDfAvailable(text: string): number | null {
  const cols = (text.trim().split('\n').pop() ?? '').trim().split(/\s+/)
  const kb = cols[3]
  return kb !== undefined && /^\d+$/.test(kb) ? Number(kb) * 1024 : null
}

/* ---------------------------------------------------------------- *
 * The commands, each name validated before it is quoted
 * ---------------------------------------------------------------- */

const settingKey = (key: string) => {
  if (!/^[a-z0-9_.]+$/.test(key)) throw androidError('INVALID_ARGUMENT')
  return key
}

export const APP_COMMANDS = {
  dump: (pkg: string) => shellCmd`dumpsys package ${assertPackageName(pkg)}`,
  path: (pkg: string) => shellCmd`pm path ${assertPackageName(pkg)}`,
  resolveLauncher: (pkg: string) =>
    shellCmd`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${assertPackageName(pkg)}`,
  queryLaunchers: (pkg: string) =>
    shellCmd`cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${assertPackageName(pkg)}`,
  /** What a launcher sends, so a running app comes to the front instead of opening twice. */
  start: (component: string) =>
    shellCmd`am start -n ${assertComponent(component)} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`,
  /** The fallback that needs no activity name: one event, which is the launch. */
  monkey: (pkg: string) =>
    shellCmd`monkey -p ${assertPackageName(pkg)} -c android.intent.category.LAUNCHER 1`,
  stop: (pkg: string) => shellCmd`am force-stop ${assertPackageName(pkg)}`,
  info: (pkg: string) =>
    shellCmd`am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d ${`package:${assertPackageName(pkg)}`}`,
  clear: (pkg: string) => shellCmd`pm clear ${assertPackageName(pkg)}`,
  uninstall: (pkg: string) => shellCmd`pm uninstall ${assertPackageName(pkg)}`,
  df: shellCmd`df /data`,
  /** Read-only, e.g. `verifier_verify_adb_installs` for the Play Protect check. */
  globalSetting: (key: string) => shellCmd`settings get global ${settingKey(key)}`,
} as const
