/*
  §4b tool discovery, below the checklist: which() and its search rules, the wrapper reader
  and version rules the first-launch gate depends on, and the resolvers' edges that the
  §12e scenarios (preflight.test.ts) do not reach.
*/
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../src/bridge'
import { childEnv, runTool, type RunOptions, type RunTool } from '../src/process'
import {
  canonicalVersion,
  classifyPython,
  compareVersions,
  extraDirsFor,
  isAppleShim,
  parseShebang,
  parseWrapper,
  resolveAdb,
  resolveBundletool,
  resolveJava,
  resolveTools,
  resolveXcode,
  shellQuote,
  toolOptionsFrom,
  which,
  type ToolOptions,
} from '../src/tools'
import type { BridgeInput } from '../src/types'
import { fakeMac, type FakeMac } from './fakes/mac'
import { tempDir } from './harness'

/** The wrappers as Xcode 27 ships them [V], so the reader is tested on the real text. */
const DEVICECTL_WRAPPER = `#!/bin/zsh
DEVELOPER_USR_BIN_DIR=\${0%/*}
export DEVELOPER_DIR=\${DEVELOPER_USR_DIR%/*}

EXPECTED_VERSION="642.16"
CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist" 2>&1)"

if [[ "\${EXPECTED_VERSION}" != "\${CURRENT_VERSION}" ]]; then
    "\${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch
fi
exec "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/devicectl" "\${@}"
`
const SIMCTL_WRAPPER = `#!/bin/bash
EXPECTED_VERSION="1171.7"
CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist" 2>/dev/null)"
if [[ -z "\${CURRENT_VERSION}" ]] || version_is_older "\${CURRENT_VERSION}" "\${EXPECTED_VERSION}"; then
    "\${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2
fi
exec "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl" "\${@}"
`

function executable(file: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

/** ToolOptions on `mac`, recording every run. */
function optionsOf(
  mac: FakeMac,
  input: BridgeInput = {},
): { opts: ToolOptions; ran: string[][]; envs: Map<string, NodeJS.ProcessEnv | undefined> } {
  const options = resolveOptions({ platform: 'darwin', ...mac.input, ...input })
  const ran: string[][] = []
  const envs = new Map<string, NodeJS.ProcessEnv | undefined>()
  const recording = ((file: string, argv: readonly string[], o: RunOptions = {}) => {
    ran.push([file, ...argv])
    envs.set(file, o.env)
    return runTool(file, argv, { env: childEnv({}, options.env), ...o })
  }) as RunTool
  return { opts: toolOptionsFrom(options, recording), ran, envs }
}

describe('which()', () => {
  it('finds an executable regular file on PATH, then in the extra directories', () => {
    const root = tempDir()
    const a = executable(path.join(root, 'a/adb'))
    const b = executable(path.join(root, 'b/adb'))
    expect(
      which('adb', { searchPath: path.join(root, 'a'), extraDirs: [path.join(root, 'b')] }),
    ).toBe(a)
    expect(which('adb', { searchPath: '', extraDirs: [path.join(root, 'b')] })).toBe(b)
  })

  it('skips relative and empty PATH entries, files that are not executable, and folders', () => {
    const root = tempDir()
    executable(path.join(root, 'adb'))
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(path.join(plain, 'adb'), '#!/bin/sh\n')
    mkdirSync(path.join(root, 'dir/adb'), { recursive: true })
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(
        which('adb', {
          searchPath: ['.', '', './', 'bin', plain, path.join(root, 'dir')].join(path.delimiter),
          extraDirs: ['.', 'relative'],
        }),
      ).toBeNull()
    } finally {
      process.chdir(cwd)
    }
  })

  it('reject passes over a match and keeps looking', () => {
    const root = tempDir()
    const first = executable(path.join(root, 'one/python3'))
    const second = executable(path.join(root, 'two/python3'))
    const searchPath = [path.dirname(first), path.dirname(second)].join(path.delimiter)
    expect(which('python3', { searchPath, extraDirs: [], reject: (f) => f === first })).toBe(second)
  })
})

describe('extraDirsFor()', () => {
  const home = '/Users/tester'
  it('Homebrew for everything; the Android SDK for adb; python.org and ~/.local for Python', () => {
    expect(extraDirsFor('bundletool', { home, env: {} })).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ])
    expect(
      extraDirsFor('adb', { home, env: { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/old-sdk' } }),
    ).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/sdk/platform-tools',
      '/old-sdk/platform-tools',
      '/Users/tester/Library/Android/sdk/platform-tools',
    ])
    for (const name of ['pymobiledevice3', 'python3']) {
      expect(extraDirsFor(name, { home, env: {} }).slice(2)).toEqual([
        '/Library/Frameworks/Python.framework/Versions/Current/bin',
        '/Users/tester/.local/bin',
      ])
    }
  })
})

describe('the wrapper reader and version rules', () => {
  it('reads expected version, plist and real binary from the shipped wrappers', () => {
    expect(parseWrapper(DEVICECTL_WRAPPER)).toEqual({
      expected: '642.16',
      plist:
        '/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist',
      target:
        '/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/devicectl',
    })
    expect(parseWrapper(SIMCTL_WRAPPER)).toMatchObject({
      expected: '1171.7',
      target:
        '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl',
    })
    expect(parseWrapper('#!/bin/sh\necho hi\n')).toEqual({
      expected: null,
      plist: null,
      target: null,
    })
  })

  it('compares as simctl does: trailing .0 removed, numeric per component', () => {
    expect(canonicalVersion('1107.0.0')).toBe('1107')
    expect(canonicalVersion('1171.7')).toBe('1171.7')
    expect(canonicalVersion('10.0.1')).toBe('10.0.1')
    expect(compareVersions('1171.7', '1171.7')).toBe(0)
    expect(compareVersions('1171.10', '1171.9')).toBe(1)
    expect(compareVersions('1171.6.9', '1171.7')).toBe(-1)
    expect(compareVersions('1172', '1171.7')).toBe(1)
    expect(compareVersions(canonicalVersion('1171.7.0'), '1171.7')).toBe(0)
  })

  it('a wrapper missing its decisive lines reads as first launch, never as ready', async () => {
    const mac = await fakeMac()
    const { devDir } = mac.xcode()
    writeFileSync(path.join(devDir, 'usr/bin/devicectl'), '#!/bin/zsh\nexec something\n')
    mac.xcodeSelect(devDir)
    const { opts, ran } = optionsOf(mac)
    expect((await resolveXcode(opts)).state).toBe('needs-first-launch')
    expect(ran.map((r) => r[0])).toEqual([mac.input.xcodeSelectPath])
  })
})

describe('small helpers', () => {
  it('parseShebang', () => {
    expect(parseShebang('#!/usr/bin/env python3\nimport sys')).toEqual({
      interpreter: '/usr/bin/env',
      arg: 'python3',
    })
    expect(
      parseShebang('#!/Library/Frameworks/Python.framework/Versions/3.9/bin/python3.9\n'),
    ).toEqual({
      interpreter: '/Library/Frameworks/Python.framework/Versions/3.9/bin/python3.9',
      arg: null,
    })
    expect(parseShebang('#! /bin/sh -e\n')).toEqual({ interpreter: '/bin/sh', arg: '-e' })
    expect(parseShebang('\x7fELF…')).toBeNull()
  })

  it('shellQuote quotes only what needs it', () => {
    expect(shellQuote('/Applications/Xcode.app/Contents/Developer')).toBe(
      '/Applications/Xcode.app/Contents/Developer',
    )
    expect(shellQuote('/Applications/Xcode 26.app/Contents/Developer')).toBe(
      "'/Applications/Xcode 26.app/Contents/Developer'",
    )
    expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`)
  })

  it('isAppleShim covers /usr/bin only', () => {
    expect(isAppleShim('/usr/bin/python3')).toBe(true)
    expect(isAppleShim('/usr/bin/java')).toBe(true)
    expect(isAppleShim('/usr/local/bin/python3')).toBe(false)
    expect(isAppleShim('/opt/homebrew/bin/java')).toBe(false)
  })

  it('classifyPython reads files only: python.org, PEP 668, other', async () => {
    expect(
      await classifyPython('/Library/Frameworks/Python.framework/Versions/9.9/bin/python3'),
    ).toBe('python.org')
    const mac = await fakeMac()
    const brew = mac.brewPython(path.join(mac.root, 'brewbin'))
    expect(await classifyPython(brew)).toBe('externally-managed')
    expect(await classifyPython(mac.python(path.join(mac.root, 'venv/bin/python3')))).toBe('other')
    expect(mac.bin.calls()).toEqual([])
  })
})

describe('resolvers', () => {
  it('resolveTools on linux runs nothing of Xcode', async () => {
    const mac = await fakeMac()
    mac.xcodeSelect('/Applications/Xcode.app/Contents/Developer')
    const { opts, ran } = optionsOf(mac, { platform: 'linux' })
    const t = await resolveTools(opts)
    expect(t.xcode.state).toBe('not-installed')
    expect(t.simctl.state).toBe('not-installed')
    expect(ran).toEqual([])
  })

  it('asks xcode-select once for Xcode and simctl together', async () => {
    const mac = await fakeMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    const { opts, ran } = optionsOf(mac)
    const t = await resolveTools(opts)
    expect(t.xcode).toMatchObject({
      state: 'ready',
      version: '27.0',
      build: '27A266a',
      license: true,
    })
    expect(t.xcode.devicectl).toBe(
      path.join(mac.input.coreDeviceDir ?? '', 'Versions/A/Resources/bin/devicectl'),
    )
    expect(t.simctl).toMatchObject({ state: 'ready', coreSimulator: '1171.7', expected: '1171.7' })
    expect(ran.filter((r) => r[0] === mac.input.xcodeSelectPath)).toHaveLength(1)
  })

  it('a DEVELOPER_DIR that is not a directory is ignored', async () => {
    const mac = await fakeMac()
    const { devDir } = mac.xcode()
    mac.xcodeSelect(devDir)
    const { opts } = optionsOf(mac, { env: { ...mac.input.env, DEVELOPER_DIR: '/nowhere/at/all' } })
    expect((await resolveXcode(opts)).devDir).toBe(devDir)
  })

  it('resolveAdb: the version, or null when `adb version` fails', async () => {
    const mac = await fakeMac()
    mac.bin.simple('adb', {
      stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n',
    })
    const { opts } = optionsOf(mac)
    expect(await resolveAdb(opts)).toEqual({
      path: path.join(mac.bin.dir, 'adb'),
      version: '36.0.0',
    })
    mac.bin.simple('adb', { exit: 1 })
    expect(await resolveAdb(opts)).toEqual({ path: path.join(mac.bin.dir, 'adb'), version: null })
  })

  it('resolveJava: a broken JAVA_HOME is the answer, not a reason to look elsewhere', async () => {
    const mac = await fakeMac()
    mac.javaHome(mac.jdk(path.join(mac.root, 'jbr/Contents/Home')))
    const { opts, ran } = optionsOf(mac, {
      env: { ...mac.input.env, JAVA_HOME: path.join(mac.root, 'gone') },
    })
    expect(await resolveJava(opts)).toBeNull()
    expect(ran).toEqual([])
  })

  it('resolveBundletool names a broken JAVA_HOME, and only that one', async () => {
    const mac = await fakeMac()
    mac.javaHome(null)
    mac.bin.tool('bundletool', 'echo 1.18.3')
    const gone = path.join(mac.root, 'gone')
    const broken = optionsOf(mac, { env: { ...mac.input.env, JAVA_HOME: gone } })
    expect(await resolveBundletool(broken.opts)).toMatchObject({
      java: null,
      works: false,
      brokenJavaHome: gone,
    })
    /** No JAVA_HOME and no Java at all: nothing to clear, a Java to install. */
    const none = optionsOf(mac, { env: { ...mac.input.env, JAVA_HOME: '' } })
    expect(await resolveBundletool(none.opts)).toMatchObject({ java: null, brokenJavaHome: null })
  })

  it('resolveBundletool hands bundletool the Java it checked, as JAVA_HOME and first on PATH', async () => {
    const mac = await fakeMac()
    const home = mac.jdk(path.join(mac.root, 'jbr/Contents/Home'))
    mac.javaHome(home)
    const bundletool = mac.bin.tool(
      'bundletool',
      'echo "$JAVA_HOME" > "$FAKE_STATE/bundletool.env"\necho 1.18.3',
    )
    const { opts, envs } = optionsOf(mac)
    expect(await resolveBundletool(opts)).toMatchObject({
      version: '1.18.3',
      works: true,
      java: { home, version: '21.0.11', source: 'java_home' },
    })
    expect(readFileSync(path.join(mac.bin.state, 'bundletool.env'), 'utf8').trim()).toBe(home)
    const env = envs.get(bundletool)
    expect(env?.JAVA_HOME).toBe(home)
    expect(env?.PATH?.split(path.delimiter)).toEqual([path.join(home, 'bin'), mac.bin.dir])
  })
})
