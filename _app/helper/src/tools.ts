/**
 * §4b Finding tools: which binaries this Mac has, which of them the helper may run, and in
 * what state Xcode is, without ever running something that changes the Mac.
 *
 * Three rules shape everything here:
 * - Only absolute paths run. which() skips relative PATH entries, and system tools are
 *   called by their fixed paths (the options), never looked up.
 * - Apple's shims never run: `xcrun`, `/usr/bin/python3` and `/usr/bin/java` can open an
 *   "install the developer tools" or "install Java" dialog on a Mac without them.
 * - Xcode's `devicectl` and `simctl` are wrapper scripts that run `xcodebuild
 *   -runFirstLaunch` when CoreDevice or CoreSimulator is out of date. The helper reads the
 *   wrapper instead of running it, predicts its verdict exactly, and runs the real binary.
 *
 * resolveTools() is the fast part every lane reads (the bridge caches it 30 s); the slow,
 * optional checks (pymobiledevice3, bundletool, Java) run only for the checklist (§12).
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { asDict, parsePlist } from './plist'
import { childEnv, ToolError, type RunTool } from './process'
import type { Timeouts, XcodeState } from './types'

/** A binary found on disk, with its version when the check could read one. */
export interface ToolInfo {
  path: string
  version: string | null
}

/** resolveXcode() (§1.5). Never runs a wrapper, xcrun or `xcodebuild -runFirstLaunch`. */
export interface XcodeInfo {
  state: XcodeState
  /** The selected developer directory, `/Applications/Xcode.app/Contents/Developer`. */
  devDir: string | null
  /** CFBundleShortVersionString, `27.0`. */
  version: string | null
  /** ProductBuildVersion, `27A266a`. */
  build: string | null
  /** The REAL devicectl binary (never the wrapper), when state is 'ready'. */
  devicectl: string | null
  /** CoreDevice's CFBundleVersion as installed, and as the wrapper expects it. */
  coreDevice: string | null
  expected: string | null
  /** `xcodebuild -license check` exited 0. Informational only: it never gates. */
  license: boolean | null
  /** For 'not-selected': the developer directory to suggest in `sudo xcode-select -s …`. */
  suggest: string | null
}

/** resolveSimctl(): the same gate on CoreSimulator, returning the real simctl binary. */
export interface SimctlInfo {
  state: 'ready' | 'not-installed' | 'not-selected' | 'needs-first-launch'
  devDir: string | null
  simctl: string | null
  coreSimulator: string | null
  expected: string | null
  /** For 'not-selected': the developer directory to suggest (optional: added after WP3). */
  suggest?: string | null
}

/** Everything the lanes and the banner read about the Mac's tools, cached 30 s by the bridge. */
export interface Toolbox {
  checkedAt: number
  xcode: XcodeInfo
  simctl: SimctlInfo
  ideviceinfo: ToolInfo | null
  idevicesyslog: ToolInfo | null
  idevicescreenshot: ToolInfo | null
  /** With the version from `adb version`, which never starts a server. */
  adb: ToolInfo | null
  /** Found or not; the version is checked by the checklist only (it takes a second). */
  pymobiledevice3: ToolInfo | null
  bundletool: ToolInfo | null
}

/** What discovery needs from the bridge's options; tests point every path at fakes. */
export interface ToolOptions {
  searchPath: string
  /** undefined = extraDirsFor(name); [] = PATH only (tests). */
  extraDirs: string[] | undefined
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  xcodeSelectPath: string
  plistBuddyPath: string
  javaHomePath: string
  applicationsDir: string
  coreDeviceDir: string
  coreSimulatorDir: string
  runTool: RunTool
  timeouts: Timeouts
  now: () => number
}

/** The ToolOptions part of the bridge's options (§1.6), with the runner to use. */
export function toolOptionsFrom(
  options: Omit<ToolOptions, 'runTool' | 'timeouts' | 'now'> & {
    timeouts: Timeouts
    now: () => number
  },
  runTool: RunTool,
): ToolOptions {
  return {
    searchPath: options.searchPath,
    extraDirs: options.extraDirs,
    home: options.home,
    env: options.env,
    platform: options.platform,
    xcodeSelectPath: options.xcodeSelectPath,
    plistBuddyPath: options.plistBuddyPath,
    javaHomePath: options.javaHomePath,
    applicationsDir: options.applicationsDir,
    coreDeviceDir: options.coreDeviceDir,
    coreSimulatorDir: options.coreSimulatorDir,
    runTool,
    timeouts: options.timeouts,
    now: options.now,
  }
}

/* ------------------------------------------------------------------- finding files --- */

/** Where Homebrew puts its commands on Apple silicon and on Intel Macs. */
export const BREW_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin']

/** python.org's installer links its commands here, whichever version is current. */
const PYTHON_ORG_BIN = '/Library/Frameworks/Python.framework/Versions/Current/bin'

/**
 * Where to look besides PATH (§1.5). A helper started from an IDE task or a launch agent
 * often has a thin PATH; Homebrew, the Android SDK and python.org still live in these places.
 */
export function extraDirsFor(
  name: string,
  opts: { home: string; env: NodeJS.ProcessEnv },
): string[] {
  const dirs = [...BREW_DIRS]
  if (name === 'adb') {
    for (const root of [opts.env.ANDROID_HOME, opts.env.ANDROID_SDK_ROOT]) {
      if (root) dirs.push(path.join(root, 'platform-tools'))
    }
    dirs.push(path.join(opts.home, 'Library/Android/sdk/platform-tools'))
  }
  if (name === 'pymobiledevice3' || name === 'python3') {
    dirs.push(PYTHON_ORG_BIN)
    dirs.push(path.join(opts.home, '.local/bin'))
  }
  return dirs
}

/**
 * An executable regular file named `name` in an absolute PATH entry or an extra directory,
 * or null. Empty and relative entries ('' and '.') are skipped: they resolve against the
 * working directory, often ~/Downloads, where a planted `adb` would otherwise run.
 * `reject` passes over a match and keeps looking (Apple's python3 shim, say).
 */
export function which(
  name: string,
  opts: {
    searchPath: string
    extraDirs: readonly string[]
    reject?: (file: string) => boolean
  },
): string | null {
  const seen = new Set<string>()
  for (const dir of [...opts.searchPath.split(path.delimiter), ...opts.extraDirs]) {
    if (!dir || !path.isAbsolute(dir) || seen.has(dir)) continue
    seen.add(dir)
    const file = path.join(dir, name)
    if (isExecutable(file) && !opts.reject?.(file)) return file
  }
  return null
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** which() with the §1.5 search rules for `name`. */
function find(name: string, opts: ToolOptions, reject?: (file: string) => boolean): string | null {
  const extraDirs = opts.extraDirs ?? extraDirsFor(name, opts)
  return which(name, { searchPath: opts.searchPath, extraDirs, reject })
}

function found(name: string, opts: ToolOptions): ToolInfo | null {
  const file = find(name, opts)
  return file ? { path: file, version: null } : null
}

/**
 * Apple's stand-ins in /usr/bin (python3, java, xcrun): each is a shim that may open an
 * install dialog instead of running anything, so a tool found there is never started.
 */
export function isAppleShim(file: string): boolean {
  return path.dirname(file) === '/usr/bin'
}

/** Homebrew's `brew`, which decides whether a fix may start with `brew install`. */
export function findBrew(opts: ToolOptions): string | null {
  return which('brew', { searchPath: opts.searchPath, extraDirs: opts.extraDirs ?? BREW_DIRS })
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** The start of a file (a wrapper script, a shebang); null when it cannot be read. */
async function readHead(file: string, bytes: number): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Shell-quotes a path for a command the tester copies, only when it needs it. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Whether `file` sits in a directory of `searchPath`. which() looks there before its extra
 * directories, so then the bare name, typed in the tester's terminal, runs this very file.
 */
export function onSearchPath(file: string, searchPath: string): boolean {
  const dirs = searchPath.split(path.delimiter).filter((dir) => path.isAbsolute(dir))
  return dirs.some((dir) => path.resolve(dir) === path.dirname(file))
}

/**
 * `adb` as a command the tester copies names it: bare when their PATH reaches the adb found,
 * else its full path (one in ~/Library/Android/sdk/platform-tools, say, is found by the
 * helper but is "command not found" in the terminal).
 */
export function adbCommand(adb: ToolInfo | null, searchPath: string): string {
  return !adb || onSearchPath(adb.path, searchPath) ? 'adb' : shellQuote(adb.path)
}

/* ------------------------------------------------------------------------ versions --- */

/** `1107.0.0` → `1107`: the simctl wrapper's canonical form before it compares. */
export function canonicalVersion(version: string): string {
  let v = version
  while (v.endsWith('.0')) v = v.slice(0, -2)
  return v
}

/** Compares dotted versions numerically by component (`1171.10` > `1171.9`): -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0
    const y = parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/* --------------------------------------------------------------------------- Xcode --- */

/** What a wrapper script says: the version it expects, the plist it reads, what it execs. */
export interface WrapperFacts {
  expected: string | null
  plist: string | null
  target: string | null
}

/**
 * Reads Xcode 26+'s devicectl/simctl wrapper (zsh/bash) as text. These three lines are all
 * it decides on [V]; the target is the real binary in CoreDevice or CoreSimulator.
 */
export function parseWrapper(text: string): WrapperFacts {
  return {
    expected: /EXPECTED_VERSION="([^"]+)"/.exec(text)?.[1] ?? null,
    plist: /PlistBuddy -c "Print :CFBundleVersion" "([^"]+)"/.exec(text)?.[1] ?? null,
    target: /exec "([^"]+)"/.exec(text)?.[1] ?? null,
  }
}

/** `…/Xcode.app/Contents/Developer`, as opposed to the Command Line Tools' directory. */
function isXcodeDevDir(dir: string): boolean {
  return /\.app\/Contents\/Developer\/?$/.test(dir)
}

/**
 * The developer directory the wrappers would use: DEVELOPER_DIR when it names a directory,
 * else `xcode-select -p`. Null when neither answers (xcode-select exits 2 with nothing set).
 */
export async function developerDir(opts: ToolOptions): Promise<string | null> {
  const fromEnv = opts.env.DEVELOPER_DIR
  if (fromEnv && path.isAbsolute(fromEnv) && (await isDirectory(fromEnv))) return fromEnv
  try {
    const { stdout } = await opts.runTool(opts.xcodeSelectPath, ['-p'], {
      timeoutMs: opts.timeouts.xcodeSelect,
    })
    const dir = stdout.trim()
    return path.isAbsolute(dir) ? dir : null
  } catch {
    return null
  }
}

/** Xcode's version.plist (XML [V]): `27.0` and `27A266a`. */
async function xcodeVersion(
  devDir: string,
): Promise<{ version: string | null; build: string | null }> {
  try {
    const plist = asDict(parsePlist(await readFile(path.join(devDir, '../version.plist'), 'utf8')))
    const version = plist?.CFBundleShortVersionString
    const build = plist?.ProductBuildVersion
    return {
      version: typeof version === 'string' ? version : null,
      build: typeof build === 'string' ? build : null,
    }
  } catch {
    return { version: null, build: null }
  }
}

interface InstalledXcode {
  devDir: string
  version: string | null
  build: string | null
}

/**
 * Xcodes in /Applications that ship `tool`, best first: `Xcode.app` (what the App Store
 * installs, so what the tester expects), then the highest version (Xcode-beta, Xcode_26.app).
 */
async function installedXcodes(opts: ToolOptions, tool: string): Promise<InstalledXcode[]> {
  let names: string[]
  try {
    names = await readdir(opts.applicationsDir)
  } catch {
    return []
  }
  const apps: Array<InstalledXcode & { name: string }> = []
  for (const name of names.filter((n) => /^Xcode[^/]*\.app$/.test(n)).sort()) {
    const devDir = path.join(opts.applicationsDir, name, 'Contents/Developer')
    if (await isFile(path.join(devDir, 'usr/bin', tool))) {
      apps.push({ name, devDir, ...(await xcodeVersion(devDir)) })
    }
  }
  return apps.sort((a, b) => {
    if (a.name === 'Xcode.app' || b.name === 'Xcode.app') return a.name === 'Xcode.app' ? -1 : 1
    return compareVersions(b.version ?? '0', a.version ?? '0')
  })
}

/** CFBundleVersion through PlistBuddy (CoreDevice's plist is binary [V]); '' on any failure. */
async function bundleVersion(opts: ToolOptions, plist: string): Promise<string> {
  try {
    const { stdout } = await opts.runTool(
      opts.plistBuddyPath,
      ['-c', 'Print :CFBundleVersion', plist],
      { timeoutMs: opts.timeouts.plistBuddy },
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

interface GateResult {
  ready: boolean
  /** The binary to run: the wrapper's exec target, or the tool itself in older Xcodes. */
  target: string
  current: string | null
  expected: string | null
}

/**
 * Predicts whether a wrapper would run `xcodebuild -runFirstLaunch`, without running it.
 * devicectl's wrapper wants an exact CoreDevice version; simctl's wants CoreSimulator not
 * to be older (trailing `.0`s removed). A failed PlistBuddy reads as '' and fails both, as
 * it does in the wrappers. A file that is not a script is an older Xcode's real binary.
 */
async function firstLaunchGate(
  opts: ToolOptions,
  wrapper: string,
  defaultPlist: string,
  rule: 'exact' | 'not-older',
): Promise<GateResult> {
  const text = await readHead(wrapper, 64 * 1024)
  if (text !== null && !text.startsWith('#!')) {
    return { ready: true, target: wrapper, current: null, expected: null }
  }
  const facts = parseWrapper(text ?? '')
  if (!facts.expected || !facts.target || !path.isAbsolute(facts.target)) {
    return { ready: false, target: wrapper, current: null, expected: facts.expected }
  }
  const current = await bundleVersion(opts, facts.plist ?? defaultPlist)
  const ready =
    rule === 'exact'
      ? current === facts.expected
      : current !== '' &&
        compareVersions(canonicalVersion(current), canonicalVersion(facts.expected)) >= 0
  return { ready, target: facts.target, current, expected: facts.expected }
}

const NO_XCODE: XcodeInfo = {
  state: 'not-installed',
  devDir: null,
  version: null,
  build: null,
  devicectl: null,
  coreDevice: null,
  expected: null,
  license: null,
  suggest: null,
}

const NO_SIMCTL: SimctlInfo = {
  state: 'not-installed',
  devDir: null,
  simctl: null,
  coreSimulator: null,
  expected: null,
  suggest: null,
}

/** A Toolbox with nothing found: the starting point, and what a failed resolve falls back to. */
export function emptyToolbox(checkedAt: number): Toolbox {
  return {
    checkedAt,
    xcode: { ...NO_XCODE },
    simctl: { ...NO_SIMCTL },
    ideviceinfo: null,
    idevicesyslog: null,
    idevicescreenshot: null,
    adb: null,
    pymobiledevice3: null,
    bundletool: null,
  }
}

/**
 * `xcodebuild -license check`: true when accepted, false when it says no, null when it
 * could not tell (missing, too slow). It only ever words a warning.
 */
async function licenseAccepted(opts: ToolOptions, devDir: string): Promise<boolean | null> {
  try {
    await opts.runTool(path.join(devDir, 'usr/bin/xcodebuild'), ['-license', 'check'], {
      timeoutMs: opts.timeouts.xcodebuildLicense,
      env: childEnv({ DEVELOPER_DIR: devDir }, opts.env),
    })
    return true
  } catch (error) {
    return error instanceof ToolError && error.reason === 'exit' ? false : null
  }
}

/**
 * Whether the real devicectl has `device capture screenshot` (Xcode 15+ [V]). Only a clear
 * "no" (a non-zero exit) turns screenshots off; a slow answer is not held against it, the
 * screenshot itself reports what goes wrong.
 */
async function canCapture(opts: ToolOptions, devicectl: string, devDir: string): Promise<boolean> {
  try {
    await opts.runTool(devicectl, ['device', 'capture', 'screenshot', '-h'], {
      timeoutMs: opts.timeouts.devicectlHelp,
      env: childEnv({ DEVELOPER_DIR: devDir }, opts.env),
    })
    return true
  } catch (error) {
    return !(error instanceof ToolError) || error.reason === 'timeout'
  }
}

/**
 * Xcode for iOS 17+ screenshots (§1.5). Runs xcode-select, PlistBuddy, `xcodebuild -license
 * check` and the real devicectl's `-h`, all read-only; never the wrapper, never xcrun, never
 * `-runFirstLaunch`. `dev` lets resolveTools() ask xcode-select once for Xcode and simctl.
 */
export async function resolveXcode(
  opts: ToolOptions,
  dev: Promise<string | null> = developerDir(opts),
): Promise<XcodeInfo> {
  if (opts.platform !== 'darwin') return { ...NO_XCODE }
  const devDir = await dev
  const wrapper = devDir ? path.join(devDir, 'usr/bin/devicectl') : null
  if (!devDir || !wrapper || !isXcodeDevDir(devDir) || !(await isFile(wrapper))) {
    const [best] = await installedXcodes(opts, 'devicectl')
    if (best) {
      return {
        ...NO_XCODE,
        state: 'not-selected',
        devDir,
        version: best.version,
        build: best.build,
        suggest: best.devDir,
      }
    }
    /** An Xcode older than 15 is selected: it is there, it just cannot take screenshots. */
    if (devDir && isXcodeDevDir(devDir) && (await isDirectory(devDir))) {
      return { ...NO_XCODE, state: 'no-capture', devDir, ...(await xcodeVersion(devDir)) }
    }
    return { ...NO_XCODE, devDir }
  }
  const [{ version, build }, gate] = await Promise.all([
    xcodeVersion(devDir),
    firstLaunchGate(
      opts,
      wrapper,
      path.join(opts.coreDeviceDir, 'Versions/A/Resources/Info.plist'),
      'exact',
    ),
  ])
  const base = {
    ...NO_XCODE,
    devDir,
    version,
    build,
    coreDevice: gate.current,
    expected: gate.expected,
  }
  if (!gate.ready) return { ...base, state: 'needs-first-launch' }
  const [license, capture] = await Promise.all([
    licenseAccepted(opts, devDir),
    canCapture(opts, gate.target, devDir),
  ])
  return capture
    ? { ...base, state: 'ready', devicectl: gate.target, license }
    : { ...base, state: 'no-capture', license }
}

/**
 * The real simctl behind the same kind of gate (§5): CoreSimulator must not be older than
 * the wrapper expects, or the wrapper would start a first launch.
 */
export async function resolveSimctl(
  opts: ToolOptions,
  dev: Promise<string | null> = developerDir(opts),
): Promise<SimctlInfo> {
  if (opts.platform !== 'darwin') return { ...NO_SIMCTL }
  const devDir = await dev
  const wrapper = devDir ? path.join(devDir, 'usr/bin/simctl') : null
  if (!devDir || !wrapper || !isXcodeDevDir(devDir) || !(await isFile(wrapper))) {
    const [best] = await installedXcodes(opts, 'simctl')
    return best
      ? { ...NO_SIMCTL, state: 'not-selected', devDir, suggest: best.devDir }
      : { ...NO_SIMCTL, devDir }
  }
  const gate = await firstLaunchGate(
    opts,
    wrapper,
    path.join(opts.coreSimulatorDir, 'Versions/A/Resources/Info.plist'),
    'not-older',
  )
  return {
    ...NO_SIMCTL,
    state: gate.ready ? 'ready' : 'needs-first-launch',
    devDir,
    simctl: gate.ready ? gate.target : null,
    coreSimulator: gate.current,
    expected: gate.expected,
  }
}

/* ---------------------------------------------------------------- other tools --- */

/** A version out of a tool's output, or null. */
function versionIn(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null
}

export function isTimeout(error: unknown): boolean {
  return error instanceof ToolError && error.reason === 'timeout'
}

/**
 * A check's tool run: any failure is an answer (null), but running out of time is not, so a
 * timeout rejects and the checklist can say "Check timed out." instead of guessing.
 */
async function attempt<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run
  } catch (error) {
    if (isTimeout(error)) throw error
    return null
  }
}

/**
 * Google's adb with its version. `adb version` prints and exits: it starts no server [V],
 * and it is the only adb command the helper runs at all without a click (§4.1).
 */
export async function resolveAdb(opts: ToolOptions): Promise<ToolInfo | null> {
  const file = find('adb', opts)
  if (!file) return null
  const run = await opts
    .runTool(file, ['version'], { timeoutMs: opts.timeouts.doctorCheck })
    .catch(() => null)
  return { path: file, version: run ? versionIn(run.stdout, /^Version (\d+(?:\.\d+)*)/m) : null }
}

/** `ideviceinfo --version` → `1.4.0`; null when it does not say. */
export async function libimobiledeviceVersion(
  opts: ToolOptions,
  ideviceinfo: string,
): Promise<string | null> {
  const run = await attempt(
    opts.runTool(ideviceinfo, ['--version'], { timeoutMs: opts.timeouts.doctorCheck }),
  )
  return run ? versionIn(run.stdout + run.stderr, /ideviceinfo (\d+\.\d+\.\d+)/) : null
}

/** A Python that could install pymobiledevice3, and how it wants to be asked. */
export interface PythonInfo {
  path: string
  /**
   * 'python.org' and 'other' take `pip install`; 'externally-managed' (Homebrew's, PEP 668)
   * refuses it, so the fix is pipx.
   */
  kind: 'python.org' | 'externally-managed' | 'other'
}

/**
 * How a Python installs packages. PEP 668 marks an externally managed one with a file next
 * to its standard library, which is where Homebrew puts it [V]; python.org's never has it.
 * Only files are read: no Python is started to ask.
 */
export async function classifyPython(file: string): Promise<PythonInfo['kind']> {
  const real = await realpath(file).catch(() => file)
  if (real.startsWith('/Library/Frameworks/Python.framework/')) return 'python.org'
  const lib = path.join(path.dirname(real), '../lib')
  const names = await readdir(lib).catch(() => [] as string[])
  for (const name of names.filter((n) => /^python3(\.\d+)?$/.test(n))) {
    if (await isFile(path.join(lib, name, 'EXTERNALLY-MANAGED'))) return 'externally-managed'
  }
  return 'other'
}

/** The first python3 on the search path that is not Apple's shim. Found, never run. */
export async function findPython(opts: ToolOptions): Promise<PythonInfo | null> {
  const file = find('python3', opts, isAppleShim)
  return file ? { path: file, kind: await classifyPython(file) } : null
}

/** `#!/usr/bin/env python3` → interpreter `/usr/bin/env`, argument `python3`. */
export function parseShebang(head: string): { interpreter: string; arg: string | null } | null {
  const match = /^#![ \t]*(\S+)(?:[ \t]+(\S+))?/.exec(head)
  return match?.[1] ? { interpreter: match[1], arg: match[2] ?? null } : null
}

export interface ScriptPython {
  path: string
  version: string | null
  /**
   * 'shim': Apple's /usr/bin/python3, which the helper never starts, so nothing ran.
   * 'missing': the interpreter the script names is gone (or `env` finds none).
   */
  state: 'ok' | 'shim' | 'missing'
}

export interface Pymobiledevice3Info {
  path: string
  version: string | null
  /** The Python it runs in; null for a self-contained binary. */
  python: ScriptPython | null
}

/**
 * The Python a script's shebang would start, decided here rather than by the kernel: for
 * `#!/usr/bin/env python3`, env would search the child's PATH, where /usr/bin may come first.
 * Null when the file is not a script (a self-contained binary runs as it is).
 */
async function scriptPython(file: string, opts: ToolOptions): Promise<ScriptPython | null> {
  const shebang = parseShebang((await readHead(file, 512)) ?? '')
  if (!shebang) return null
  let python: string | null = shebang.interpreter
  if (path.basename(shebang.interpreter) === 'env') {
    const name = shebang.arg && !shebang.arg.startsWith('-') ? shebang.arg : null
    python = name ? (find(name, opts, isAppleShim) ?? find(name, opts)) : null
    if (!python) return { path: name ?? shebang.interpreter, version: null, state: 'missing' }
  }
  if (isAppleShim(python)) return { path: python, version: null, state: 'shim' }
  if (!isExecutable(python)) return { path: python, version: null, state: 'missing' }
  return { path: python, version: null, state: 'ok' }
}

/**
 * pymobiledevice3 and the Python it lives in (§12b): `pymobiledevice3 version`, run through
 * that Python so Apple's shim can never be the one that starts, and `python --version`.
 * Rejects with ToolError 'timeout' when either runs out of time.
 */
export async function resolvePymobiledevice3(
  opts: ToolOptions,
): Promise<Pymobiledevice3Info | null> {
  const file = find('pymobiledevice3', opts)
  if (!file) return null
  const python = await scriptPython(file, opts)
  if (python && python.state !== 'ok') return { path: file, version: null, python }
  const slow = { timeoutMs: opts.timeouts.doctorSlowCheck }
  const [own, interpreter] = await Promise.all([
    attempt(
      python
        ? opts.runTool(python.path, [file, 'version'], slow)
        : opts.runTool(file, ['version'], slow),
    ),
    python
      ? attempt(opts.runTool(python.path, ['--version'], { timeoutMs: opts.timeouts.doctorCheck }))
      : null,
  ])
  return {
    path: file,
    version: own ? versionIn(own.stdout, /^(\d+\.\d+\.\d+)/m) : null,
    python: python && {
      ...python,
      version: interpreter
        ? versionIn(interpreter.stdout + interpreter.stderr, /Python (\d+\.\d+\.\d+)/)
        : null,
    },
  }
}

export interface JavaInfo {
  /** The JDK home: what JAVA_HOME should be for bundletool. */
  home: string
  version: string
  source: 'JAVA_HOME' | 'java_home' | 'Android Studio' | 'Homebrew'
}

/** `<home>/bin/java -version` (stderr [V]) → `21.0.11`; null unless it runs and says so. */
async function javaVersion(opts: ToolOptions, home: string): Promise<string | null> {
  const java = path.join(home, 'bin/java')
  if (!path.isAbsolute(home) || !isExecutable(java)) return null
  /** /usr/bin/java is Apple's stub; JAVA_HOME=/usr, or a link to it, would reach it. */
  if (isAppleShim(java) || isAppleShim(await realpath(java).catch(() => java))) return null
  const run = await attempt(
    opts.runTool(java, ['-version'], { timeoutMs: opts.timeouts.doctorSlowCheck }),
  )
  return run ? versionIn(run.stderr + run.stdout, /version "([^"]+)"/) : null
}

/** `/usr/libexec/java_home` → the default JDK's home; null when there is none (exit 1). */
async function javaHomeTool(opts: ToolOptions): Promise<string | null> {
  const run = await attempt(
    opts.runTool(opts.javaHomePath, [], { timeoutMs: opts.timeouts.doctorCheck }),
  )
  return run?.stdout.trim() || null
}

/** Homebrew's openjdk, next to the `brew` found: what Homebrew's bundletool falls back to. */
function brewJavaHome(opts: ToolOptions): string | null {
  const brew = findBrew(opts)
  return brew
    ? path.join(path.dirname(path.dirname(brew)), 'opt/openjdk/libexec/openjdk.jdk/Contents/Home')
    : null
}

/**
 * A Java that runs. JAVA_HOME when set: bundletool uses it, so a broken one IS the answer.
 * Otherwise `/usr/libexec/java_home`, Android Studio's bundled JBR, then Homebrew's openjdk.
 * Never `/usr/bin/java`: on a Mac without Java it offers to install one.
 */
export async function resolveJava(opts: ToolOptions): Promise<JavaInfo | null> {
  const fromEnv = opts.env.JAVA_HOME
  if (fromEnv) {
    const version = await javaVersion(opts, fromEnv)
    return version ? { home: fromEnv, version, source: 'JAVA_HOME' } : null
  }
  const candidates: Array<[JavaInfo['source'], () => Promise<string | null>]> = [
    ['java_home', () => javaHomeTool(opts)],
    [
      'Android Studio',
      () =>
        Promise.resolve(
          path.join(opts.applicationsDir, 'Android Studio.app/Contents/jbr/Contents/Home'),
        ),
    ],
    ['Homebrew', () => Promise.resolve(brewJavaHome(opts))],
  ]
  for (const [source, homeOf] of candidates) {
    const home = await homeOf()
    const version = home ? await javaVersion(opts, home) : null
    if (home && version) return { home, version, source }
  }
  return null
}

export interface BundletoolInfo {
  path: string
  version: string | null
  java: JavaInfo | null
  /** `bundletool version` ran: false when there is no Java or it failed to start. */
  works: boolean
  /**
   * JAVA_HOME as set, when the Java it names doesn't run. bundletool (Homebrew's script too)
   * prefers it to any other Java, so installing one more cannot help: it must be cleared.
   */
  brokenJavaHome: string | null
}

/**
 * bundletool and the Java it needs (§12b; the .aab lane comes later). It is started only
 * with a Java found above, set as JAVA_HOME and first on PATH, so neither Homebrew's script
 * nor any other can fall through to Apple's java stub. Rejects with ToolError 'timeout'.
 */
export async function resolveBundletool(opts: ToolOptions): Promise<BundletoolInfo | null> {
  const file = find('bundletool', opts)
  if (!file) return null
  const java = await resolveJava(opts)
  if (!java) {
    const brokenJavaHome = opts.env.JAVA_HOME || null
    return { path: file, version: null, java: null, works: false, brokenJavaHome }
  }
  const PATH = [path.join(java.home, 'bin'), opts.env.PATH].filter(Boolean).join(path.delimiter)
  const run = await attempt(
    opts.runTool(file, ['version'], {
      timeoutMs: opts.timeouts.doctorSlowCheck,
      env: childEnv({ JAVA_HOME: java.home, PATH }, opts.env),
    }),
  )
  return {
    path: file,
    version: run ? versionIn(run.stdout, /^(\d+\.\d+\.\d+)/m) : null,
    java,
    works: run !== null,
    brokenJavaHome: null,
  }
}

/**
 * The fast discovery every lane and the banner read (§4b): Xcode and simctl with their
 * first-launch gates, adb with its version, and where the other tools are. Never rejects.
 */
export async function resolveTools(opts: ToolOptions): Promise<Toolbox> {
  const dev = opts.platform === 'darwin' ? developerDir(opts) : Promise.resolve(null)
  const [xcode, simctl, adb] = await Promise.all([
    resolveXcode(opts, dev),
    resolveSimctl(opts, dev),
    resolveAdb(opts),
  ])
  return {
    checkedAt: opts.now(),
    xcode,
    simctl,
    ideviceinfo: found('ideviceinfo', opts),
    idevicesyslog: found('idevicesyslog', opts),
    idevicescreenshot: found('idevicescreenshot', opts),
    adb,
    pymobiledevice3: found('pymobiledevice3', opts),
    bundletool: found('bundletool', opts),
  }
}
