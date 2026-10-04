import { describe, expect, it } from 'vitest'

import {
  CHECKIN_MAIN,
  CHECKIN_MARSHMALLOW,
  CHECKIN_OLDER,
  DUMPSYS_PACKAGE,
  DUMPSYS_PACKAGE_OLDER,
  DUMPSYS_UPDATED_SYSTEM_APP,
  PM_LIST_MINIMAL,
  PM_LIST_SYSTEM,
  PM_LIST_TWO_USERS,
  PM_LIST_UNKNOWN_OPTION,
  PM_LIST_USER,
  PM_PATH,
  QUERY_TWO_LAUNCHERS,
  RESOLVE_CHOOSER,
  RESOLVE_ONE,
} from './fixtures'
import {
  APP_COMMANDS,
  appMatches,
  hasUnknownOption,
  installerName,
  launcherFrom,
  listPackagesCommand,
  mergeApps,
  parseCheckin,
  parseCheckinFlags,
  parseDfAvailable,
  parseDumpsysPackage,
  parsePmList,
  parsePmPath,
  sortApps,
  type AppRow,
} from './packages'

describe('parsePmList', () => {
  it('splits path and name at the LAST =, since paths carry base64 with = in it', () => {
    const rows = parsePmList(PM_LIST_USER)
    expect(rows.map((r) => r.name)).toEqual([
      'com.example.shop',
      'com.example.notes',
      'org.sample.reader',
    ])
    expect(rows[1]).toEqual({
      name: 'com.example.notes',
      path: '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk',
      versionCode: 42,
      installer: 'com.android.vending',
      uids: [10234],
      stopped: null,
    })
  })

  it('reads installer=null as none, every uid, and versionCodes past 2^31', () => {
    const [shop, , reader] = parsePmList(PM_LIST_USER)
    expect(shop?.versionCode).toBe(4294967338)
    expect(reader).toMatchObject({ installer: null, uids: [10301, 1010301] })
  })

  it('leaves no trailing space on the name when -i comes without --show-versioncode', () => {
    expect(parsePmList(PM_LIST_MINIMAL)).toEqual([
      {
        name: 'com.example.notes',
        path: '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk',
        versionCode: null,
        installer: 'com.android.vending',
        uids: [],
        stopped: null,
      },
    ])
  })

  it('keeps the framework, whose name has no dot', () => {
    expect(parsePmList(PM_LIST_SYSTEM)[0]).toMatchObject({
      name: 'android',
      path: '/system/framework/framework-res.apk',
    })
  })

  it('skips error lines, blank lines and garbage', () => {
    expect(parsePmList(`${PM_LIST_UNKNOWN_OPTION}\n\nnot a package\npackage:\n`)).toEqual([])
  })

  it('lists a package two users have on different versions once, with both uids', () => {
    expect(parsePmList(PM_LIST_TWO_USERS)).toEqual([
      expect.objectContaining({
        name: 'org.sample.reader',
        versionCode: 7,
        uids: [10301, 1010301],
      }),
    ])
  })

  it('reads the undocumented stopped= field, and plain names with no flags', () => {
    expect(
      parsePmList('package:com.example.notes stopped=true\npackage:org.sample.reader\n'),
    ).toEqual([
      {
        name: 'com.example.notes',
        path: null,
        versionCode: null,
        installer: null,
        uids: [],
        stopped: true,
      },
      {
        name: 'org.sample.reader',
        path: null,
        versionCode: null,
        installer: null,
        uids: [],
        stopped: null,
      },
    ])
  })
})

describe('listPackagesCommand', () => {
  it('uses cmd package from Android 7, with every flag', () => {
    expect(listPackagesCommand(37, 'user').text).toBe(
      'cmd package list packages -f -i -U --show-versioncode -3',
    )
    expect(listPackagesCommand(24, 'system').text).toBe(
      'cmd package list packages -f -i -U --show-versioncode -s',
    )
  })

  it('drops the newer flags for the retry, and before Android 7 uses pm', () => {
    expect(listPackagesCommand(37, 'user', true).text).toBe('cmd package list packages -f -i -3')
    expect(listPackagesCommand(23, 'user').text).toBe('pm list packages -f -i -3')
  })

  it('spots the refusal that asks for the retry', () => {
    expect(hasUnknownOption(PM_LIST_UNKNOWN_OPTION)).toBe(true)
    expect(hasUnknownOption(PM_LIST_USER)).toBe(false)
  })
})

describe('parseCheckin', () => {
  it('reads AOSP main: last update on the pkg line, first install from user 0', () => {
    const notes = parseCheckin(CHECKIN_MAIN).get('com.example.notes')
    expect(notes).toEqual({
      name: 'com.example.notes',
      versionCode: 42,
      lastUpdated: 1790000000000,
      firstInstalled: 1780000000000,
      splits: ['base', 'config.arm64_v8a', 'config.xxhdpi'],
      users: [
        { id: 0, installed: true, stopped: false, enabledState: 0, firstInstalled: 1780000000000 },
        { id: 10, installed: false, stopped: true, enabledState: 0, firstInstalled: null },
      ],
    })
  })

  it('reads the user flags: stopped, and disabled by the user', () => {
    const reader = parseCheckin(CHECKIN_MAIN).get('org.sample.reader')
    expect(reader?.users[0]).toMatchObject({ stopped: true, enabledState: 3 })
    expect(parseCheckin(CHECKIN_MAIN).get('com.example.shop')?.versionCode).toBe(4294967338)
  })

  it('reads the older layout, where both times sit on the pkg line', () => {
    expect(parseCheckin(CHECKIN_OLDER).get('com.example.notes')).toMatchObject({
      lastUpdated: 1790000000000,
      firstInstalled: 1780000000000,
      splits: ['base'],
    })
    expect(parseCheckin(CHECKIN_OLDER).get('org.sample.reader')?.users[0]).toMatchObject({
      stopped: true,
    })
  })

  it('reads Android 6 flags, which have no suspended pair', () => {
    expect(parseCheckinFlags('IbSL')).toEqual({ installed: true, stopped: true })
    expect(parseCheckinFlags('IbsL')).toEqual({ installed: true, stopped: false })
    expect(parseCheckin(CHECKIN_MARSHMALLOW).get('com.example.notes')?.users[0]?.stopped).toBe(true)
  })

  it('reads the flags of later Android, suspended pair first', () => {
    expect(parseCheckinFlags('IbsusLiavpiqha')).toEqual({ installed: true, stopped: false })
    expect(parseCheckinFlags('IbSUSLiavpiqha')).toEqual({ installed: true, stopped: true })
    expect(parseCheckinFlags('ibsuSliavpiqha')).toEqual({ installed: false, stopped: true })
  })
})

describe('mergeApps', () => {
  const merged = () =>
    mergeApps(
      [
        { rows: parsePmList(PM_LIST_USER), system: false },
        { rows: parsePmList(PM_LIST_SYSTEM), system: true },
      ],
      parseCheckin(CHECKIN_MAIN),
    )

  it("joins each row with its times and user 0's state", () => {
    expect(merged().find((r) => r.packageName === 'org.sample.reader')).toEqual({
      packageName: 'org.sample.reader',
      apkPath: '/data/app/~~Q2Fv==/org.sample.reader-AA==/base.apk',
      versionCode: 7,
      installer: null,
      system: false,
      uids: [10301, 1010301],
      lastUpdated: 1791000000000,
      firstInstalled: 1785000000000,
      enabled: false,
      stopped: true,
    })
  })

  it('marks which list a row came from, and leaves times unknown without checkin data', () => {
    const chrome = merged().find((r) => r.packageName === 'com.android.chrome')
    expect(chrome).toMatchObject({ system: true, lastUpdated: null, enabled: null, stopped: null })
    expect(merged().find((r) => r.packageName === 'com.example.shop')?.enabled).toBe(false)
  })
})

describe('sortApps and appMatches', () => {
  const row = (packageName: string, lastUpdated: number | null): AppRow => ({
    packageName,
    apkPath: null,
    versionCode: 1,
    installer: 'com.android.vending',
    system: false,
    uids: [],
    lastUpdated,
    firstInstalled: null,
    enabled: true,
    stopped: false,
  })
  const rows = [row('com.b', 5), row('com.a', null), row('com.c', 9), row('com.d', 5)]

  it('puts the most recently updated first, unknown times last, ties by name', () => {
    expect(sortApps(rows, 'updated').map((r) => r.packageName)).toEqual([
      'com.c',
      'com.b',
      'com.d',
      'com.a',
    ])
  })

  it('sorts by label where one is known, else by package name', () => {
    const labels = new Map([['com.c', 'Alpha']])
    expect(sortApps(rows, 'name', labels).map((r) => r.packageName)).toEqual([
      'com.c',
      'com.a',
      'com.b',
      'com.d',
    ])
  })

  it('matches the package, the label and the installer, ignoring case', () => {
    const r = row('com.example.notes', 1)
    expect(appMatches(r, '')).toBe(true)
    expect(appMatches(r, 'EXAMPLE')).toBe(true)
    expect(appMatches(r, 'quick', 'Quick Notes')).toBe(true)
    expect(appMatches(r, 'google play')).toBe(true)
    expect(appMatches(r, 'shop')).toBe(false)
  })
})

describe('installerName', () => {
  it('names the stores a tester knows, and says Unknown when Android recorded none', () => {
    expect(installerName('com.android.vending')).toBe('Google Play')
    expect(installerName('com.google.android.packageinstaller')).toBe('Package installer')
    expect(installerName(null)).toBe('Unknown')
    expect(installerName('org.sample.store')).toBe('org.sample.store')
  })
})

describe('parseDumpsysPackage', () => {
  it('reads the Packages: block of AOSP main', () => {
    expect(parseDumpsysPackage(DUMPSYS_PACKAGE, 'com.example.notes')).toEqual({
      packageName: 'com.example.notes',
      versionName: '1.4.0 (beta 2)',
      versionCode: 42,
      minSdk: 24,
      targetSdk: 36,
      codePath: '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==',
      dataDir: '/data/user/0/com.example.notes',
      splits: ['base', 'config.arm64_v8a', 'config.xxhdpi'],
      installer: 'com.android.vending',
      firstInstalled: '2026-08-01 08:00:00',
      lastUpdated: '2026-09-20 09:30:00',
      debuggable: true,
      testOnly: false,
      system: false,
      primaryCpuAbi: 'arm64-v8a',
      user0: { installed: true, stopped: false, enabledState: 0 },
    })
  })

  it('takes the installed copy of an updated system app, not the factory one', () => {
    expect(parseDumpsysPackage(DUMPSYS_UPDATED_SYSTEM_APP, 'com.android.chrome')).toMatchObject({
      versionCode: 695112333,
      versionName: '140.0.7339.51',
      system: true,
    })
  })

  it('reads older Android, where times and the data folder are package-level', () => {
    expect(parseDumpsysPackage(DUMPSYS_PACKAGE_OLDER, 'com.example.notes')).toMatchObject({
      versionCode: 42,
      targetSdk: 28,
      splits: ['base'],
      dataDir: '/data/user/0/com.example.notes',
      firstInstalled: '2019-04-01 08:00:00',
      installer: null,
      primaryCpuAbi: null,
      testOnly: true,
      debuggable: false,
      user0: { installed: true, stopped: true, enabledState: 3 },
    })
  })

  it('answers null for an app the phone does not have', () => {
    expect(parseDumpsysPackage(DUMPSYS_PACKAGE, 'org.sample.reader')).toBeNull()
    expect(parseDumpsysPackage('', 'com.example.notes')).toBeNull()
  })
})

describe('parsePmPath', () => {
  it('lists every APK, base first', () => {
    expect(parsePmPath(PM_PATH)).toEqual([
      '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk',
      '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/split_config.arm64_v8a.apk',
      '/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/split_config.xxhdpi.apk',
    ])
    expect(parsePmPath('')).toEqual([])
  })
})

describe('launcherFrom', () => {
  it("reads resolve-activity's component", () => {
    expect(launcherFrom(RESOLVE_ONE, 'com.example.notes')).toBe('com.example.notes/.MainActivity')
  })

  it("ignores Android's chooser, and picks the app's first launcher from query-activities", () => {
    expect(launcherFrom(RESOLVE_CHOOSER, 'com.example.notes')).toBeNull()
    expect(launcherFrom(QUERY_TWO_LAUNCHERS, 'com.example.notes')).toBe(
      'com.example.notes/.MainActivity',
    )
    expect(launcherFrom('No activity found\n', 'com.example.notes')).toBeNull()
  })
})

describe('parseDfAvailable', () => {
  it('reads the available 1K blocks of df /data as bytes', () => {
    const df =
      'Filesystem      1K-blocks     Used Available Use% Mounted on\n/dev/block/dm-48 114786388 27952736  86833652  25% /data/user/0\n'
    expect(parseDfAvailable(df)).toBe(86833652 * 1024)
    expect(parseDfAvailable('df: /data: Permission denied\n')).toBeNull()
  })
})

describe('APP_COMMANDS', () => {
  it('quotes every package name, and builds what the plan says to run', () => {
    expect(APP_COMMANDS.dump('com.example.notes').text).toBe("dumpsys package 'com.example.notes'")
    expect(APP_COMMANDS.path('com.example.notes').text).toBe("pm path 'com.example.notes'")
    expect(APP_COMMANDS.resolveLauncher('com.example.notes').text).toBe(
      "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 'com.example.notes'",
    )
    expect(APP_COMMANDS.start('com.example.notes/.Main$Alias').text).toBe(
      "am start -n 'com.example.notes/.Main$Alias' -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
    )
    expect(APP_COMMANDS.monkey('com.example.notes').text).toBe(
      "monkey -p 'com.example.notes' -c android.intent.category.LAUNCHER 1",
    )
    expect(APP_COMMANDS.stop('com.example.notes').text).toBe("am force-stop 'com.example.notes'")
    expect(APP_COMMANDS.info('com.example.notes').text).toBe(
      "am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d 'package:com.example.notes'",
    )
    expect(APP_COMMANDS.clear('com.example.notes').text).toBe("pm clear 'com.example.notes'")
    expect(APP_COMMANDS.uninstall('com.example.notes').text).toBe(
      "pm uninstall 'com.example.notes'",
    )
    expect(APP_COMMANDS.globalSetting('verifier_verify_adb_installs').text).toBe(
      "settings get global 'verifier_verify_adb_installs'",
    )
  })

  it('refuses a bad name or component before building anything', () => {
    expect(() => APP_COMMANDS.uninstall('com.example; reboot')).toThrow('INVALID_PACKAGE_NAME')
    expect(() => APP_COMMANDS.start('com.example/.A;reboot')).toThrow('INVALID_COMPONENT')
    expect(() => APP_COMMANDS.globalSetting('a b')).toThrow('INVALID_ARGUMENT')
  })
})
