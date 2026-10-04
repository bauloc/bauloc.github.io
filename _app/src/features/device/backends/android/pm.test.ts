import { describe, expect, it } from 'vitest'

import { fakeAdb, fakePart, type FakeAnswer, type FakeCall } from './fake-adb'
import {
  CHECKIN_MAIN,
  DUMPSYS_PACKAGE,
  PM_LIST_MINIMAL,
  PM_LIST_SYSTEM,
  PM_LIST_UNKNOWN_OPTION,
  PM_LIST_USER,
  PM_OUTPUT,
  PM_PATH,
  QUERY_TWO_LAUNCHERS,
  RESOLVE_CHOOSER,
  RESOLVE_ONE,
} from './fixtures'
import { listPackagesCommand } from './packages'
import {
  appDetail,
  clearAppData,
  dataFreeBytes,
  installCreateArgs,
  launchApp,
  listApps,
  openAppInfo,
  readGlobalSetting,
  runInstall,
  stopApp,
  uninstallApp,
  type RunInstallOptions,
} from './pm'

const SESSION = 1234567
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256)

/** A phone's package manager that installs whatever it is sent, with overrides per step. */
function packageManager(
  overrides: Partial<Record<'create' | 'write' | 'commit' | 'abandon', FakeAnswer>> = {},
) {
  return (call: FakeCall): FakeAnswer | undefined => {
    const c = call.command.replace(/^cmd /, '')
    if (c.startsWith('package install-create'))
      return overrides.create ?? { stdout: PM_OUTPUT.created }
    const write = /^package install-write -S (\d+) /.exec(c)
    if (write) {
      const size = Number(write[1])
      return (
        overrides.write ?? { stdout: `Success: streamed ${String(size)} bytes\n`, readStdin: size }
      )
    }
    if (c.includes('install-commit')) return overrides.commit ?? { stdout: PM_OUTPUT.success }
    if (c.startsWith('package install-abandon'))
      return overrides.abandon ?? { stdout: PM_OUTPUT.success }
    return undefined
  }
}

/** Starts an install and records everything it reports along the way. */
function install(
  adb: Parameters<typeof runInstall>[0],
  parts: Parameters<typeof runInstall>[1],
  options: Partial<RunInstallOptions> = {},
) {
  const progress: [number, number][] = []
  const phases: string[] = []
  const sessions: (number | null)[] = []
  const outcome = runInstall(adb, parts, {
    sdk: 37,
    allowTest: true,
    onProgress: (sent, total) => progress.push([sent, total]),
    onPhase: (phase) => phases.push(phase),
    onSession: (id) => sessions.push(id),
    ...options,
  })
  return { outcome, progress, phases, sessions }
}

describe('installCreateArgs', () => {
  const all = {
    allowTest: true,
    allowDowngrade: true,
    grantPermissions: true,
    bypassLowTargetSdkBlock: true,
    totalBytes: 4000,
  }

  it('sends every chosen flag the phone knows', () => {
    expect(installCreateArgs(37, all)).toEqual([
      'package',
      'install-create',
      '-r',
      '-t',
      '-d',
      '-g',
      '--bypass-low-target-sdk-block',
      '-S',
      '4000',
    ])
  })

  it('leaves out what an older Android would refuse', () => {
    expect(installCreateArgs(33, all)).not.toContain('--bypass-low-target-sdk-block')
    expect(installCreateArgs(22, all)).not.toContain('-g')
    expect(installCreateArgs(37)).toEqual(['package', 'install-create', '-r'])
  })
})

describe('runInstall', () => {
  it('creates a session, streams every part into it, and commits (Android 10+: abb_exec, no shell)', async () => {
    const a = bytes(3000, 1)
    const b = bytes(1000, 2)
    const { adb, calls } = fakeAdb({ answer: packageManager() })
    const run = install(adb, [fakePart(a), fakePart(b)])
    expect(await run.outcome).toEqual({ ok: true, warnings: [], output: 'Success' })
    expect(calls.map((c) => c.service)).toEqual([
      'abb_exec:package\0install-create\0-r\0-t\0-S\x004000\0',
      `abb_exec:package\0install-write\0-S\x003000\0${String(SESSION)}\x000.apk\0-\0`,
      `abb_exec:package\0install-write\0-S\x001000\0${String(SESSION)}\x001.apk\0-\0`,
      `abb_exec:package\0install-commit\0${String(SESSION)}\0`,
    ])
    expect(calls[1]?.stdin).toEqual(a)
    expect(calls[2]?.stdin).toEqual(b)
    expect(run.phases).toEqual(['sending', 'installing'])
    expect(run.sessions).toEqual([SESSION, null])
    expect(run.progress[0]).toEqual([0, 4000])
    expect(run.progress.at(-1)).toEqual([4000, 4000])
    expect(run.progress.map(([sent]) => sent)).toEqual(
      [...run.progress.map(([sent]) => sent)].sort((x, y) => x - y),
    )
  })

  it('goes through `cmd package` on Android 8–9, with the same bare tokens', async () => {
    const { adb, calls } = fakeAdb({ features: ['shell_v2', 'cmd'], answer: packageManager() })
    const run = install(adb, [fakePart(bytes(10, 3))], { sdk: 28, allowTest: false })
    expect((await run.outcome).ok).toBe(true)
    expect(calls.map((c) => [c.via, c.command])).toEqual([
      ['exec', 'cmd package install-create -r -S 10'],
      ['exec', `cmd package install-write -S 10 ${String(SESSION)} 0.apk -`],
      ['exec', `cmd package install-commit ${String(SESSION)}`],
    ])
  })

  it('commits through pm on Android 7.0 and 7.1, whose cmd printed Success to the wrong stream', async () => {
    const { adb, calls } = fakeAdb({ features: ['shell_v2', 'cmd'], answer: packageManager() })
    const run = install(adb, [fakePart(bytes(10, 3))], { sdk: 25 })
    expect((await run.outcome).ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      via: 'shell',
      command: `pm install-commit '${String(SESSION)}'`,
    })
  })

  it('refuses phones older than Android 7 before sending anything', async () => {
    const { adb, calls } = fakeAdb({ answer: packageManager() })
    await expect(install(adb, [fakePart(bytes(10, 3))], { sdk: 23 }).outcome).rejects.toThrow(
      'INSTALL_UNSUPPORTED',
    )
    expect(calls).toEqual([])
  })

  it("returns the phone's refusal at commit, the session closed by it", async () => {
    const { adb, calls } = fakeAdb({
      answer: packageManager({ commit: { stdout: PM_OUTPUT.downgrade } }),
    })
    const run = install(adb, [fakePart(bytes(10, 3))])
    expect(await run.outcome).toMatchObject({ ok: false, code: 'VERSION_DOWNGRADE' })
    expect(run.sessions).toEqual([SESSION, null])
    expect(calls.some((c) => c.command.includes('install-abandon'))).toBe(false)
  })

  it('counts "Completed with warning(s)" as installed', async () => {
    const { adb } = fakeAdb({ answer: packageManager({ commit: { stdout: PM_OUTPUT.warnings } }) })
    const run = install(adb, [fakePart(bytes(10, 3))])
    expect(await run.outcome).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([expect.any(String)]),
    })
  })

  it("returns install-create's refusal without opening anything", async () => {
    const { adb, calls } = fakeAdb({
      answer: packageManager({ create: { stdout: PM_OUTPUT.exception } }),
    })
    const run = install(adb, [fakePart(bytes(10, 3))])
    expect(await run.outcome).toMatchObject({ ok: false, code: 'UNKNOWN' })
    expect(calls).toHaveLength(1)
    expect(run.sessions).toEqual([])
  })

  it('abandons the session when a write fails, and returns why', async () => {
    const { adb, calls } = fakeAdb({
      answer: packageManager({ write: { stdout: PM_OUTPUT.writeFailed } }),
    })
    const run = install(adb, [fakePart(bytes(10, 3))])
    expect(await run.outcome).toMatchObject({ ok: false, code: 'INSUFFICIENT_STORAGE' })
    expect(calls.at(-1)?.command).toBe(`package install-abandon ${String(SESSION)}`)
    expect(run.sessions).toEqual([SESSION, null])
  })

  it('on Cancel, stops the transfer, abandons the session and rejects: nothing installed', async () => {
    const controller = new AbortController()
    const { adb, calls } = fakeAdb({ answer: packageManager({ write: { hang: true } }) })
    const run = install(adb, [fakePart(bytes(3000, 1), 3)], {
      signal: controller.signal,
      onProgress: (sent) => {
        if (sent > 0) controller.abort()
      },
    })
    await expect(run.outcome).rejects.toThrow(/abort/i)
    expect(calls[1]?.killed).toBe(true)
    expect(calls.map((c) => c.command.split(' ')[1])).toEqual([
      'install-create',
      'install-write',
      'install-abandon',
    ])
    expect(run.sessions).toEqual([SESSION, null])
  })

  it('still cancels after the last byte, while pm takes it in', async () => {
    const controller = new AbortController()
    const { adb, calls } = fakeAdb({ answer: packageManager({ write: { hang: true } }) })
    const run = install(adb, [fakePart(bytes(300, 1), 3)], {
      signal: controller.signal,
      onProgress: (sent, total) => {
        if (sent === total) setTimeout(() => controller.abort(), 0)
      },
    })
    await expect(run.outcome).rejects.toThrow(/abort/i)
    expect(calls[1]).toMatchObject({ killed: true, stdin: bytes(300, 1) })
    expect(calls.at(-1)?.command).toBe(`package install-abandon ${String(SESSION)}`)
  })

  it('reports a part longer than its size even after pm took exactly that size', async () => {
    const { adb, calls } = fakeAdb({ answer: packageManager() })
    const run = install(adb, [fakePart(bytes(15, 1), 3, 10)])
    await expect(run.outcome).rejects.toThrow('INSTALL_SIZE_MISMATCH')
    expect(calls[1]?.stdin).toHaveLength(10)
    expect(calls.at(-1)?.command).toBe(`package install-abandon ${String(SESSION)}`)
  })

  it('refuses a part that yields more or fewer bytes than its size, rather than hang pm', async () => {
    for (const part of [fakePart(bytes(12, 1), 2, 10), fakePart(bytes(8, 1), 2, 10)]) {
      const { adb, calls } = fakeAdb({ answer: packageManager() })
      await expect(install(adb, [part]).outcome).rejects.toThrow('INSTALL_SIZE_MISMATCH')
      expect(calls.at(-1)?.command).toBe(`package install-abandon ${String(SESSION)}`)
    }
  })

  it('leaves the session reported open when the phone stops answering, for cleanup on reconnect', async () => {
    const lost = new Error('USB transfer failed')
    const { adb } = fakeAdb({
      answer: (call) => {
        if (call.command.includes('install-commit') || call.command.includes('install-abandon'))
          throw lost
        return packageManager()(call)
      },
    })
    const run = install(adb, [fakePart(bytes(10, 3))])
    await expect(run.outcome).rejects.toThrow('USB transfer failed')
    expect(run.sessions).toEqual([SESSION])
  })
})

describe('app actions', () => {
  const pkg = 'com.example.notes'
  const answers = (table: Record<string, FakeAnswer>) => (call: FakeCall) =>
    Object.entries(table).find(([prefix]) => call.command.startsWith(prefix))?.[1]

  it('opens the launcher activity the way a launcher does', async () => {
    const { adb, calls } = fakeAdb({
      answer: answers({
        'cmd package resolve-activity': { stdout: RESOLVE_ONE },
        'am start': { stdout: 'Starting: Intent { cmp=com.example.notes/.MainActivity }\n' },
      }),
    })
    await launchApp(adb, 37, pkg)
    expect(calls.map((c) => c.command)).toEqual([
      "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 'com.example.notes'",
      "am start -n 'com.example.notes/.MainActivity' -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
    ])
  })

  it("asks for the app's own launchers when the resolver names Android's chooser", async () => {
    const { adb, calls } = fakeAdb({
      answer: answers({
        'cmd package resolve-activity': { stdout: RESOLVE_CHOOSER },
        'cmd package query-activities': { stdout: QUERY_TWO_LAUNCHERS },
        'am start': { stdout: 'Starting: Intent {}\n' },
      }),
    })
    await launchApp(adb, 37, pkg)
    expect(calls.at(-1)?.command).toContain("'com.example.notes/.MainActivity'")
  })

  it('says an app with no screen has none to open', async () => {
    const { adb, calls } = fakeAdb({
      answer: answers({ 'cmd package resolve-activity': { stdout: 'No activity found\n' } }),
    })
    await expect(launchApp(adb, 37, pkg)).rejects.toThrow('APP_NOT_LAUNCHABLE')
    expect(calls).toHaveLength(1)
  })

  it('uses monkey before Android 7, which finds the activity itself', async () => {
    const { adb, calls } = fakeAdb({
      answer: answers({ monkey: { stdout: 'Events injected: 1\n' } }),
    })
    await launchApp(adb, 23, pkg)
    expect(calls.map((c) => c.command)).toEqual([
      "monkey -p 'com.example.notes' -c android.intent.category.LAUNCHER 1",
    ])
    const none = fakeAdb({
      answer: answers({ monkey: { stderr: '** No activities found to run, monkey aborted.\n' } }),
    })
    await expect(launchApp(none.adb, 23, pkg)).rejects.toThrow('APP_NOT_LAUNCHABLE')
  })

  it("reports am's own error", async () => {
    const { adb } = fakeAdb({
      answer: answers({
        'cmd package resolve-activity': { stdout: RESOLVE_ONE },
        'am start': {
          stdout:
            'Starting: Intent { cmp=com.example.notes/.MainActivity }\nError type 3\nError: Activity class {com.example.notes/com.example.notes.MainActivity} does not exist.\n',
        },
      }),
    })
    await expect(launchApp(adb, 37, pkg)).rejects.toThrow('Error type 3')
  })

  it('stops an app and opens its info page on the phone', async () => {
    const { adb, calls } = fakeAdb({
      answer: answers({ 'am start': { stdout: 'Starting: Intent {}\n' } }),
    })
    await stopApp(adb, pkg)
    await openAppInfo(adb, pkg)
    expect(calls.map((c) => c.command)).toEqual([
      "am force-stop 'com.example.notes'",
      "am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d 'package:com.example.notes'",
    ])
  })

  it("clears data, and words pm's bare Failed", async () => {
    await clearAppData(fakeAdb({ answer: () => ({ stdout: 'Success\n' }) }).adb, pkg)
    await expect(
      clearAppData(fakeAdb({ answer: () => ({ stderr: 'Failed\n', exitCode: 1 }) }).adb, pkg),
    ).rejects.toThrow('CLEAR_FAILED')
    const protectedApp = fakeAdb({
      answer: () => ({
        stderr:
          "Exception occurred while executing 'clear':\njava.lang.SecurityException: Cannot clear data for a protected package\n",
        exitCode: 255,
      }),
    })
    await expect(clearAppData(protectedApp.adb, pkg)).rejects.toThrow(
      "Exception occurred while executing 'clear':",
    )
  })

  it("uninstalls, and rejects with Android's reason", async () => {
    await uninstallApp(fakeAdb({ answer: () => ({ stdout: 'Success\n' }) }).adb, pkg)
    await expect(
      uninstallApp(fakeAdb({ answer: () => ({ stdout: PM_OUTPUT.deleteFailed }) }).adb, pkg),
    ).rejects.toThrow('DELETE_FAILED_INTERNAL_ERROR')
    await expect(
      uninstallApp(fakeAdb({ answer: () => ({ stdout: PM_OUTPUT.notInstalled }) }).adb, pkg),
    ).rejects.toThrow('not installed for 0')
  })

  it('runs nothing at all for a name that is not a package', async () => {
    const { adb, calls } = fakeAdb()
    for (const action of [stopApp, openAppInfo, clearAppData, uninstallApp]) {
      await expect(action(adb, 'com.example.notes; reboot')).rejects.toThrow('INVALID_PACKAGE_NAME')
    }
    await expect(launchApp(adb, 37, '$(reboot).x')).rejects.toThrow('INVALID_PACKAGE_NAME')
    expect(calls).toEqual([])
  })
})

describe('listApps', () => {
  it('lists user and system apps side by side and joins the checkin times', async () => {
    const { adb, calls } = fakeAdb({
      answer: (call) => {
        if (call.command === 'dumpsys package --checkin') return { stdout: CHECKIN_MAIN }
        if (call.command.endsWith('-3')) return { stdout: PM_LIST_USER }
        if (call.command.endsWith('-s')) return { stdout: PM_LIST_SYSTEM }
        return undefined
      },
    })
    const rows = await listApps(adb, 37, 'all')
    expect(rows.map((r) => [r.packageName, r.system])).toEqual([
      ['com.example.shop', false],
      ['com.example.notes', false],
      ['org.sample.reader', false],
      ['android', true],
      ['com.android.settings', true],
      ['com.android.chrome', true],
    ])
    expect(rows[1]).toMatchObject({ lastUpdated: 1790000000000, enabled: true, stopped: false })
    expect(calls.map((c) => c.via)).toEqual(['shell', 'shell', 'shell'])
  })

  it('asks again with fewer flags when pm does not know one', async () => {
    const { adb, calls } = fakeAdb({
      answer: (call) => {
        if (call.command === listPackagesCommand(37, 'user').text)
          return { stdout: PM_LIST_UNKNOWN_OPTION, exitCode: 255 }
        if (call.command === listPackagesCommand(37, 'user', true).text)
          return { stdout: PM_LIST_MINIMAL }
        return undefined
      },
    })
    const rows = await listApps(adb, 37, 'user')
    expect(rows).toMatchObject([
      { packageName: 'com.example.notes', versionCode: null, lastUpdated: null },
    ])
    expect(calls).toHaveLength(3)
  })

  it("rejects with the phone's words when it lists nothing and says why", async () => {
    const { adb } = fakeAdb({
      answer: (call) =>
        call.command.includes('list packages')
          ? {
              stderr:
                'Error: java.lang.SecurityException: Shell does not have permission to access user 150\n',
              exitCode: 255,
            }
          : undefined,
    })
    await expect(listApps(adb, 37, 'user')).rejects.toThrow(
      'Shell does not have permission to access user 150',
    )
  })

  it('still lists the apps when the checkin call fails', async () => {
    const { adb } = fakeAdb({
      answer: (call) => {
        if (call.command.includes('--checkin')) throw new Error('socket closed')
        return { stdout: PM_LIST_USER }
      },
    })
    expect((await listApps(adb, 37, 'user')).every((r) => r.lastUpdated === null)).toBe(true)
  })
})

describe('appDetail', () => {
  const base = '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk'

  it("reads the dump, the APK paths and each APK's size", async () => {
    const { adb } = fakeAdb({
      answer: (call) => {
        if (call.command.startsWith('dumpsys package')) return { stdout: DUMPSYS_PACKAGE }
        if (call.command.startsWith('pm path')) return { stdout: PM_PATH }
        return undefined
      },
      files: { [base]: bytes(2048, 1) },
    })
    const detail = await appDetail(adb, 'com.example.notes')
    expect(detail).toMatchObject({ versionName: '1.4.0 (beta 2)', debuggable: true })
    expect(detail.apks).toEqual([
      { path: base, size: 2048 },
      { path: base.replace('base.apk', 'split_config.arm64_v8a.apk'), size: null },
      { path: base.replace('base.apk', 'split_config.xxhdpi.apk'), size: null },
    ])
  })

  it('says when the app is not on the phone', async () => {
    const { adb } = fakeAdb({ answer: () => ({ stdout: '' }) })
    await expect(appDetail(adb, 'org.sample.reader')).rejects.toThrow('APP_NOT_INSTALLED')
  })
})

describe('install checks', () => {
  it('reads the free space on /data and a global setting', async () => {
    const df = fakeAdb({
      answer: () => ({
        stdout:
          'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-3 110347320 98123456 12223864 89% /data\n',
      }),
    })
    expect(await dataFreeBytes(df.adb)).toBe(12223864 * 1024)
    const setting = fakeAdb({ answer: () => ({ stdout: '1\n' }) })
    expect(await readGlobalSetting(setting.adb, 'verifier_verify_adb_installs')).toBe('1')
    expect(setting.calls[0]?.command).toBe("settings get global 'verifier_verify_adb_installs'")
    expect(
      await readGlobalSetting(fakeAdb({ answer: () => ({ stdout: 'null\n' }) }).adb, 'x'),
    ).toBeNull()
  })
})
