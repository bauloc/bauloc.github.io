/*
  A fake Mac for the preflight suites (§12e): the system tools the helper calls by absolute
  path, an /Applications with Xcodes in it, CoreDevice and CoreSimulator frameworks, Pythons,
  JDKs and Homebrew, all inside one private folder. Built on isolation(), so the PATH holds
  only the fakes a test adds and nothing real can be found or run.

  Every fake script logs to calls.log (fakes/bin.ts), which is how the tests prove what never
  ran: the devicectl and simctl wrappers exit 99 before doing anything and are logged as
  `devicectl-wrapper` / `simctl-wrapper`; xcodebuild logs its argv, so `-runFirstLaunch` would
  show.
*/
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildPlist } from '../../src/plist'
import type { BridgeInput } from '../../src/types'
import type { FakeBin } from './bin'
import { isolation } from '../harness'

export interface FakeXcode {
  /** `…/Xcode.app/Contents/Developer` */
  devDir: string
}

export interface XcodeSpec {
  /** Folder name in /Applications. */
  name?: string
  version?: string
  build?: string
  /** 'wrapper' (Xcode 26+), 'binary' (older: devicectl is the real tool), 'none' (pre-15). */
  devicectl?: 'wrapper' | 'binary' | 'none'
  /** What the wrapper expects from CoreDevice and CoreSimulator. */
  expected?: string
  simExpected?: string
  /** Exit code of `xcodebuild -license check`. */
  license?: number
  /** Exit code of the real devicectl's `device capture screenshot -h`. */
  capture?: number
  simctl?: boolean
}

export interface FakeMac {
  readonly root: string
  readonly bin: FakeBin
  readonly home: string
  /** createBridge()/resolveOptions() input with every system path pointing in here. */
  readonly input: BridgeInput
  /** `xcode-select -p` prints `dir`, or exits 2 (nothing selected) for null. */
  readonly xcodeSelect: (dir: string | null) => void
  readonly xcode: (spec?: XcodeSpec) => FakeXcode
  /** The installed frameworks' CFBundleVersion; null leaves the Info.plist out. */
  readonly coreDevice: (version: string | null) => void
  readonly coreSimulator: (version: string | null) => void
  /** simctl's `list -j devices booted` answer. */
  readonly bootedSimulators: (count: number) => void
  readonly macos: (version: string) => void
  /** A python3 at `file` answering --version and `<script> version`. */
  readonly python: (
    file: string,
    opts?: { version?: string; pmd3?: string; hang?: boolean },
  ) => string
  /** pymobiledevice3 in the fake PATH with this shebang line (without `#!`). */
  readonly pymobiledevice3: (shebang: string) => string
  /** A Homebrew Python (PEP 668 marker), linked as <dir>/python3. */
  readonly brewPython: (dir: string) => string
  /** `brew` in the fake PATH; its prefix is the fake root. */
  readonly brew: () => string
  /** A JDK whose bin/java prints `version`; returns its home. */
  readonly jdk: (home: string, version?: string) => string
  /** `/usr/libexec/java_home` prints `home`, or exits 1 for null. */
  readonly javaHome: (home: string | null) => void
}

const exec = (file: string, body: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

export async function fakeMac(input: BridgeInput = {}): Promise<FakeMac> {
  const iso = await isolation(input)
  const { bin } = iso
  const root = path.dirname(bin.dir)
  const at = (...parts: string[]): string => path.join(root, 'mac', ...parts)
  const paths = {
    xcodeSelectPath: at('usr/bin/xcode-select'),
    plistBuddyPath: at('usr/libexec/PlistBuddy'),
    javaHomePath: at('usr/libexec/java_home'),
    swVersPath: at('usr/bin/sw_vers'),
    applicationsDir: at('Applications'),
    coreDeviceDir: at('Library/Developer/PrivateFrameworks/CoreDevice.framework'),
    coreSimulatorDir: at('Library/Developer/PrivateFrameworks/CoreSimulator.framework'),
    systemVersionPlist: at('System/Library/CoreServices/SystemVersion.plist'),
  }
  mkdirSync(paths.applicationsDir, { recursive: true })
  const resources = (framework: string): string => path.join(framework, 'Versions/A/Resources')
  const realDevicectl = path.join(resources(paths.coreDeviceDir), 'bin/devicectl')
  const realSimctl = path.join(resources(paths.coreSimulatorDir), 'bin/simctl')

  /** PlistBuddy prints the version stored in the fake Info.plist, or fails as the real one. */
  bin.file(
    paths.plistBuddyPath,
    `[ -f "$3" ] && cat "$3" && exit 0
echo "Print: Entry, \\":CFBundleVersion\\", Does Not Exist" >&2
exit 1`,
    'PlistBuddy',
  )
  const frameworkVersion = (framework: string, version: string | null): void => {
    const plist = path.join(resources(framework), 'Info.plist')
    mkdirSync(path.dirname(plist), { recursive: true })
    if (version === null) rmSync(plist, { force: true })
    else writeFileSync(plist, version + '\n')
  }
  frameworkVersion(paths.coreDeviceDir, '642.16')
  frameworkVersion(paths.coreSimulatorDir, '1171.7')
  bin.fixture('simctl-booted.json', JSON.stringify({ devices: {} }))
  bin.file(
    realSimctl,
    `[ "$1" = list ] && cat "$FAKE_STATE/fixtures/simctl-booted.json" && exit 0
exit 64`,
    'simctl',
  )
  let captureExit = 0
  const writeRealDevicectl = (): void => {
    bin.file(
      realDevicectl,
      `[ "$4" = "-h" ] && echo "Capture a screenshot" && exit ${String(captureExit)}
exit 64`,
      'devicectl',
    )
  }
  writeRealDevicectl()

  const xcode = (spec: XcodeSpec = {}): FakeXcode => {
    const app = path.join(paths.applicationsDir, spec.name ?? 'Xcode.app')
    const devDir = path.join(app, 'Contents/Developer')
    mkdirSync(path.join(devDir, 'usr/bin'), { recursive: true })
    writeFileSync(
      path.join(app, 'Contents/version.plist'),
      buildPlist({
        CFBundleShortVersionString: spec.version ?? '27.0',
        ProductBuildVersion: spec.build ?? '27A266a',
      }),
    )
    bin.file(
      path.join(devDir, 'usr/bin/xcodebuild'),
      `[ "$1" = "-license" ] && [ "$2" = check ] && exit ${String(spec.license ?? 0)}
exit 0`,
      'xcodebuild',
    )
    const kind = spec.devicectl ?? 'wrapper'
    if (kind === 'wrapper') {
      /** The real wrapper's three decisive lines, after an exit: it must never be run. */
      bin.file(
        path.join(devDir, 'usr/bin/devicectl'),
        `exit 99
EXPECTED_VERSION="${spec.expected ?? '642.16'}"
CURRENT_VERSION="$(${paths.plistBuddyPath} -c "Print :CFBundleVersion" "${path.join(resources(paths.coreDeviceDir), 'Info.plist')}" 2>&1)"
if [ "\${EXPECTED_VERSION}" != "\${CURRENT_VERSION}" ]; then "\${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch; fi
exec "${realDevicectl}" "\${@}"`,
        'devicectl-wrapper',
      )
    } else if (kind === 'binary') {
      /** Not a script: Xcode 15–25 shipped devicectl itself here. /usr/bin/true answers -h. */
      symlinkSync('/usr/bin/true', path.join(devDir, 'usr/bin/devicectl'))
    }
    if (spec.simctl ?? true) {
      bin.file(
        path.join(devDir, 'usr/bin/simctl'),
        `exit 99
EXPECTED_VERSION="${spec.simExpected ?? '1171.7'}"
CURRENT_VERSION="$(${paths.plistBuddyPath} -c "Print :CFBundleVersion" "${path.join(resources(paths.coreSimulatorDir), 'Info.plist')}" 2>/dev/null)"
exec "${realSimctl}" "\${@}"`,
        'simctl-wrapper',
      )
    }
    if (spec.capture !== undefined && spec.capture !== captureExit) {
      captureExit = spec.capture
      writeRealDevicectl()
    }
    return { devDir }
  }

  const xcodeSelect = (dir: string | null): void => {
    bin.file(
      paths.xcodeSelectPath,
      dir === null
        ? `echo "xcode-select: error: unable to get active developer directory" >&2
exit 2`
        : `echo '${dir}'`,
      'xcode-select',
    )
  }

  const python: FakeMac['python'] = (file, opts = {}) => {
    bin.file(
      file,
      `[ "$1" = "--version" ] && echo "Python ${opts.version ?? '3.9.6'}" && exit 0
case "$1" in
  */pymobiledevice3) ${opts.hang ? 'sleep 30;' : ''} [ "$2" = version ] && echo "${opts.pmd3 ?? '9.8.1'}" && exit 0 ;;
esac
exit 1`,
      path.basename(file),
    )
    return file
  }

  return {
    root,
    bin,
    home: iso.home,
    input: { ...iso.input, ...paths },
    xcodeSelect,
    xcode,
    coreDevice: (version) => frameworkVersion(paths.coreDeviceDir, version),
    coreSimulator: (version) => frameworkVersion(paths.coreSimulatorDir, version),
    bootedSimulators(count) {
      const booted = Array.from({ length: count }, (_, i) => ({
        udid: `0000000${String(i)}-0000-0000-0000-000000000000`,
        name: `iPhone ${String(i)}`,
        state: 'Booted',
      }))
      bin.fixture(
        'simctl-booted.json',
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-27-0': booted,
            'com.apple.CoreSimulator.SimRuntime.watchOS-27-0': [{ udid: 'w', state: 'Booted' }],
          },
        }),
      )
    },
    macos(version) {
      mkdirSync(path.dirname(paths.systemVersionPlist), { recursive: true })
      writeFileSync(
        paths.systemVersionPlist,
        buildPlist({ ProductName: 'macOS', ProductVersion: version }),
      )
    },
    python,
    pymobiledevice3(shebang) {
      const file = path.join(bin.dir, 'pymobiledevice3')
      /** A console script as pip writes it. The helper runs it through the Python it names. */
      exec(file, `#!${shebang}\n# -*- coding: utf-8 -*-\nimport sys\n`)
      return file
    },
    brewPython(dir) {
      const prefix = path.join(root, 'brew/Cellar/python@3.14/3.14.2')
      const real = python(path.join(prefix, 'bin/python3.14'))
      mkdirSync(path.join(prefix, 'lib/python3.14'), { recursive: true })
      writeFileSync(
        path.join(prefix, 'lib/python3.14/EXTERNALLY-MANAGED'),
        '[externally-managed]\n',
      )
      mkdirSync(dir, { recursive: true })
      symlinkSync(real, path.join(dir, 'python3'))
      return path.join(dir, 'python3')
    },
    brew: () => bin.simple('brew'),
    jdk(home, version = '21.0.11') {
      bin.file(
        path.join(home, 'bin/java'),
        `echo 'openjdk version "${version}" 2025-04-15' >&2
exit 0`,
        'java',
      )
      return home
    },
    javaHome(home) {
      bin.file(
        paths.javaHomePath,
        home === null ? 'echo "Unable to locate a Java Runtime." >&2\nexit 1' : `echo '${home}'`,
        'java_home',
      )
    },
  }
}
