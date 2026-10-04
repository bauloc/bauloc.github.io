import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apk, makeZip, pb, PNG_1PX, type SynthEntry } from './__fixtures__/synth'
import {
  androidName,
  bundletoolCommand,
  checkPhone,
  planInstall,
  type InstallPlan,
  type PlanIssue,
} from './plan'
import type { DeviceSpec } from './select'
import { openZip } from './zip'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
const fileOf = (name: string, bytes: Uint8Array<ArrayBuffer> = new Uint8Array(fixture(name))) =>
  new File([bytes], name)
const codes = (issues: readonly PlanIssue[]) => issues.map((i) => i.code)
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const pixel9: DeviceSpec = {
  supportedAbis: ['arm64-v8a'],
  supportedLocales: ['en-US'],
  screenDensity: 420,
  sdkVersion: 37,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* A split app made in the test: a base that needs an ABI and a density split, and the splits. */
const GAME = 'com.example.game'
const part = (split: string, splitTypes: string, abis: string[] = []) =>
  apk({ package: GAME, versionCode: 7, split, splitTypes }, { abis })
const game = {
  base: apk({
    package: GAME,
    versionCode: 7,
    versionName: '7.0',
    minSdk: 24,
    targetSdk: 35,
    requiredSplitTypes: 'base__abi,base__density',
  }),
  arm64: part('config.arm64_v8a', 'base__abi', ['arm64-v8a']),
  armv7: part('config.armeabi_v7a', 'base__abi', ['armeabi-v7a']),
  xxhdpi: part('config.xxhdpi', 'base__density'),
  mdpi: part('config.mdpi', 'base__density'),
  en: part('config.en', ''),
  vi: part('config.vi', ''),
}
const OBB = `Android/obb/${GAME}/main.7.${GAME}.obb`

function xapk(extra: SynthEntry[] = []) {
  const splits = [
    ['config.arm64_v8a', game.arm64],
    ['config.armeabi_v7a', game.armv7],
    ['config.xxhdpi', game.xxhdpi],
    ['config.mdpi', game.mdpi],
    ['config.en', game.en],
    ['config.vi', game.vi],
  ] as const
  const manifest = {
    xapk_version: 2,
    package_name: GAME,
    name: 'Example Game',
    version_code: '7',
    version_name: '7.0',
    min_sdk_version: '24',
    target_sdk_version: '35',
    icon: 'icon.png',
    split_apks: [
      { file: `${GAME}.apk`, id: 'base' },
      ...splits.map(([id]) => ({ file: `${id}.apk`, id })),
    ],
    expansions: [{ file: OBB, install_location: 'EXTERNAL_STORAGE', install_path: OBB }],
  }
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest), method: 8 },
    { name: 'icon.png', data: PNG_1PX, method: 8 },
    { name: `${GAME}.apk`, data: game.base, method: 8 },
    ...splits.map(([id, data]) => ({ name: `${id}.apk`, data, method: 8 })),
    { name: OBB, data: 'game data '.repeat(100), method: 8 },
    ...extra,
  ])
}

describe('planInstall: one APK', () => {
  it('plans a single APK as one part, with its name, icon and versions', async () => {
    const plan = await planInstall([fileOf('badge.apk')], pixel9)
    expect(plan).toMatchObject({ kind: 'apk', problems: [], warnings: [], selection: null })
    expect(plan.parts.map((p) => [p.name, p.source, p.split, p.role.kind])).toEqual([
      ['0.apk', 'badge.apk', '', 'base'],
    ])
    expect(plan.totalBytes).toBe(fixture('badge.apk').length)
    expect(plan.app).toMatchObject({
      packageName: 'com.bauloc.badgeprobe',
      versionCode: 812,
      versionName: '1.4.0',
      minSdk: 26,
      targetSdk: 35,
      testOnly: true,
      debuggable: true,
      label: 'Badge Probe',
      icon: { kind: 'bitmap', mime: 'image/png' },
    })
    expect(codes(plan.notes)).toEqual(['TEST_ONLY'])
    expect(await drain(await plan.parts[0]!.open())).toEqual(new Uint8Array(fixture('badge.apk')))
  })

  it('refuses a lone split, and native code the phone cannot run', async () => {
    const lone = await planInstall([fileOf('badge-config.vi.apk')], pixel9)
    expect(codes(lone.problems)).toEqual(['LONE_SPLIT'])
    expect(lone.parts).toEqual([])

    const arm32 = apk({ package: 'com.example.old', versionCode: 1 }, { abis: ['armeabi-v7a'] })
    const plan = await planInstall([fileOf('old.apk', arm32)], pixel9)
    expect(plan.problems).toMatchObject([
      {
        code: 'NO_MATCHING_ABIS',
        message: 'The app has native code only for armeabi-v7a. This phone runs 64-bit apps only.',
      },
    ])
    const older = await planInstall([fileOf('old.apk', arm32)], {
      ...pixel9,
      supportedAbis: ['arm64-v8a', 'armeabi-v7a'],
    })
    expect(older.problems).toEqual([])
  })

  it('refuses an app for a newer Android, and warns about one built for a much older one', async () => {
    const newer = apk({ package: 'com.example.new', versionCode: 1, minSdk: 36 })
    const refused = await planInstall([fileOf('new.apk', newer)], { ...pixel9, sdkVersion: 35 })
    expect(refused.problems).toMatchObject([
      {
        code: 'OLDER_SDK',
        message:
          'This app needs Android 16 (API 36) or newer. This phone runs Android 15 (API 35).',
      },
    ])

    const legacy = (target: number) =>
      fileOf(
        'legacy.apk',
        apk({ package: 'com.example.legacy', versionCode: 1, targetSdk: target }),
      )
    const warned = await planInstall([legacy(22)], pixel9)
    expect(warned.warnings).toMatchObject([
      { code: 'DEPRECATED_SDK_VERSION', action: 'install-anyway' },
    ])
    expect(
      codes((await planInstall([legacy(23)], { ...pixel9, sdkVersion: 34 })).warnings),
    ).toEqual([])
    expect(codes((await planInstall([legacy(23)], pixel9)).warnings)).toEqual([
      'DEPRECATED_SDK_VERSION',
    ])
    expect(
      codes((await planInstall([legacy(22)], { ...pixel9, sdkVersion: 33 })).warnings),
    ).toEqual([])
  })
})

describe('planInstall: several APKs', () => {
  const badgeSet = () => [
    fileOf('badge.apk'),
    fileOf('badge-config.vi.apk'),
    fileOf('badge-config.xxhdpi.apk'),
  ]

  it('installs them as one set, picking the phone’s parts and its language', async () => {
    const plan = await planInstall(badgeSet(), { ...pixel9, supportedLocales: ['vi-VN'] })
    expect(plan.kind).toBe('apk-set')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.name, p.split, p.role.kind])).toEqual([
      ['0.apk', '', 'base'],
      ['1.apk', 'config.xxhdpi', 'density'],
      ['2.apk', 'config.vi', 'language'],
    ])
    expect(plan.selection).toEqual({ offered: 3, abi: '', density: 'xxhdpi', languages: ['vi'] })
    expect(plan.app?.label).toBe('Huy hiệu')
    expect(plan.inputs.every((i) => i.used)).toBe(true)

    const english = await planInstall(badgeSet(), pixel9)
    expect(english.parts.map((p) => p.split)).toEqual(['', 'config.xxhdpi'])
    expect(english.inputs.map((i) => [i.name, i.used])).toEqual([
      ['badge.apk', true],
      ['badge-config.vi.apk', false],
      ['badge-config.xxhdpi.apk', true],
    ])
  })

  it('refuses APKs that do not belong together', async () => {
    const other = await planInstall([fileOf('badge.apk'), fileOf('badge-vector.apk')], pixel9)
    expect(other.problems).toMatchObject([
      {
        code: 'DIFFERENT_APPS',
        message:
          'These APKs are from different apps (com.bauloc.badgeprobe and com.bauloc.badgevector). Install one app at a time.',
      },
    ])
    const v1 = apk({ package: GAME, versionCode: 1 })
    const v2 = apk({ package: GAME, versionCode: 2, split: 'config.en' })
    expect(
      codes((await planInstall([fileOf('a.apk', v1), fileOf('b.apk', v2)], pixel9)).problems),
    ).toEqual(['DIFFERENT_VERSIONS'])
    const twice = await planInstall([fileOf('a.apk', v1), fileOf('b.apk', v1)], pixel9)
    expect(codes(twice.problems)).toEqual(['TWO_BASES'])
    const split = apk({ package: GAME, versionCode: 1, split: 'config.en' })
    const dup = await planInstall(
      [fileOf('a.apk', v1), fileOf('b.apk', split), fileOf('c.apk', split)],
      pixel9,
    )
    expect(codes(dup.problems)).toEqual(['DUPLICATE_SPLIT'])
    const noBase = await planInstall([fileOf('b.apk', split), fileOf('c.apk', game.xxhdpi)], pixel9)
    expect(noBase.problems).toMatchObject([
      {
        code: 'NO_BASE',
        message:
          'These are parts of a split app without its base APK. Add the base APK (usually base.apk).',
      },
    ])
  })

  it('takes the per-ABI build for this phone out of several (Flutter’s --split-per-abi)', async () => {
    const build = (abi: string) =>
      fileOf(`app-${abi}-release.apk`, apk({ package: GAME, versionCode: 7 }, { abis: [abi] }))
    const plan = await planInstall(
      [build('armeabi-v7a'), build('arm64-v8a'), build('x86_64')],
      pixel9,
    )
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => p.source)).toEqual(['app-arm64-v8a-release.apk'])
    expect(plan.notes).toMatchObject([
      {
        code: 'ABI_PICKED',
        message:
          'Picked app-arm64-v8a-release.apk for this phone’s CPU; left out app-armeabi-v7a-release.apk and app-x86_64-release.apk.',
      },
    ])
    expect(plan.inputs.map((i) => i.used)).toEqual([false, true, false])
  })

  it('takes per-ABI builds whose versionCodes differ by ABI, as Flutter numbers them', async () => {
    const build = (abi: string, versionCode: number) =>
      fileOf(`app-${abi}-release.apk`, apk({ package: GAME, versionCode }, { abis: [abi] }))
    const plan = await planInstall([build('armeabi-v7a', 1007), build('arm64-v8a', 2007)], pixel9)
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => p.source)).toEqual(['app-arm64-v8a-release.apk'])
  })

  it('refuses two universal builds of one app instead of taking one as a per-ABI build', async () => {
    // Android Studio's outputs/apk folder: a debug and a release APK, both with every ABI.
    const universal = (versionCode: number) =>
      apk({ package: GAME, versionCode }, { abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'] })
    const same = await planInstall(
      [fileOf('app-debug.apk', universal(7)), fileOf('app-release.apk', universal(7))],
      pixel9,
    )
    expect(same.problems).toMatchObject([
      {
        code: 'TWO_BASES',
        message:
          'There is more than one complete APK here (app-debug.apk and app-release.apk). Pick one of them.',
      },
    ])
    expect(same.parts).toEqual([])
    expect(same.notes).toEqual([])

    const older = await planInstall(
      [fileOf('v1.apk', universal(1)), fileOf('v2.apk', universal(2))],
      pixel9,
    )
    expect(codes(older.problems)).toEqual(['DIFFERENT_VERSIONS'])
    expect(older.parts).toEqual([])

    // One per-ABI build next to a universal one overlaps on arm64-v8a: not a per-ABI set either.
    const mixed = await planInstall(
      [
        fileOf(
          'app-arm64-v8a-release.apk',
          apk({ package: GAME, versionCode: 7 }, { abis: ['arm64-v8a'] }),
        ),
        fileOf('app-release.apk', universal(7)),
      ],
      pixel9,
    )
    expect(codes(mixed.problems)).toEqual(['TWO_BASES'])
  })

  it('refuses a set missing a split type the base requires', async () => {
    const plan = await planInstall(
      [fileOf('base.apk', game.base), fileOf('xxhdpi.apk', game.xxhdpi)],
      pixel9,
    )
    expect(codes(plan.problems)).toEqual(['MISSING_SPLIT'])
  })

  it('skips stray files dropped with a folder, and says what it skipped', async () => {
    const plan = await planInstall(
      [fileOf('badge.apk'), new File(['{}'], 'output-metadata.json')],
      pixel9,
    )
    expect(plan.problems).toEqual([])
    expect(plan.warnings).toMatchObject([
      {
        code: 'FILES_SKIPPED',
        message:
          'Skipped output-metadata.json: Device Lab installs .apk, .apks, .xapk, .apkm and .aab files.',
      },
    ])
    expect(plan.inputs.map((i) => [i.kind, i.used])).toEqual([
      ['apk', true],
      ['other', false],
    ])
  })
})

describe('planInstall: bundletool .apks', () => {
  it('picks the phone’s splits, streams them straight from the file, and leaves on-demand modules out', async () => {
    const plan = await planInstall([fileOf('probe-unsigned.apks')], pixel9)
    expect(plan.kind).toBe('apks')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.name, p.source, p.split, p.role.kind])).toEqual([
      ['0.apk', 'splits/base-master.apk', '', 'base'],
      ['1.apk', 'splits/base-xxhdpi.apk', 'config.xxhdpi', 'density'],
      ['2.apk', 'splits/base-arm64_v8a.apk', 'config.arm64_v8a', 'abi'],
    ])
    expect(plan.selection).toEqual({
      offered: 4,
      abi: 'arm64-v8a',
      density: 'xxhdpi',
      languages: [],
    })
    expect(plan.app).toMatchObject({
      packageName: 'com.bauloc.bundleprobe',
      versionName: '1.0',
      minSdk: 32,
      nativeAbis: ['arm64-v8a'],
      label: 'Bundle Probe',
      icon: { kind: 'bitmap', mime: 'image/png' },
    })
    const zip = await openZip(new Blob([fixture('probe-unsigned.apks')]))
    for (const p of plan.parts) {
      const expected = await zip.bytes(zip.get(p.source)!)
      expect(p.size).toBe(expected.length)
      expect(await drain(await p.open())).toEqual(expected)
    }
  })

  it('refuses a phone the set has nothing for, in bundletool’s terms', async () => {
    const x86 = await planInstall([fileOf('probe-unsigned.apks')], {
      ...pixel9,
      supportedAbis: ['x86'],
    })
    expect(x86.problems).toMatchObject([
      {
        code: 'NO_MATCHING_ABIS',
        message: 'The app has native code only for arm64-v8a. This phone runs x86.',
      },
    ])
    const old = await planInstall([fileOf('probe-unsigned.apks')], { ...pixel9, sdkVersion: 30 })
    expect(old.problems).toMatchObject([
      {
        code: 'OLDER_SDK',
        message:
          'This app needs Android 12L (API 32) or newer. This phone runs Android 11 (API 30).',
      },
    ])
  })

  /** A table of contents in protobuf, for set layouts the probe files do not cover. */
  const sdkTargeting = (min: number) => [[1, [[1, [[1, min]]]]]] as const
  const master = (path: string, splitId: string) =>
    [
      [1, [[5, sdkTargeting(24)]]],
      [2, path],
      [
        3,
        [
          [1, splitId],
          [2, 1],
        ],
      ],
    ] as const

  it('adds install-time asset pack slices, and warns about a local-testing set', async () => {
    const toc = pb([
      [4, GAME],
      [2, [[2, '1.18.3']]],
      [
        1,
        [
          [3, 0],
          [
            2,
            [
              [
                1,
                [
                  [1, 'base'],
                  [6, 1],
                ],
              ],
              [2, master('splits/base-master.apk', '')],
            ],
          ],
        ],
      ],
      [
        3,
        [
          [
            1,
            [
              [1, 'textures'],
              [4, 1],
            ],
          ],
          [
            2,
            [
              [1, []],
              [2, 'asset-slices/textures-master.apk'],
              [
                7,
                [
                  [1, 'textures'],
                  [2, 1],
                ],
              ],
            ],
          ],
        ],
      ],
      [
        3,
        [
          [
            1,
            [
              [1, 'later'],
              [4, 2],
            ],
          ],
          [
            2,
            [
              [1, []],
              [2, 'asset-slices/later-master.apk'],
              [
                7,
                [
                  [1, 'later'],
                  [2, 1],
                ],
              ],
            ],
          ],
        ],
      ],
      [
        5,
        [
          [1, 1],
          [2, 'local_testing'],
        ],
      ],
    ])
    const set = makeZip([
      { name: 'toc.pb', data: toc },
      {
        name: 'splits/base-master.apk',
        data: apk({ package: GAME, versionCode: 7, minSdk: 24, targetSdk: 35 }),
      },
      {
        name: 'asset-slices/textures-master.apk',
        data: apk({ package: GAME, versionCode: 7, split: 'textures', delivery: 'install-time' }),
      },
      {
        name: 'asset-slices/later-master.apk',
        data: apk({ package: GAME, versionCode: 7, split: 'later', delivery: 'on-demand' }),
      },
    ])
    const plan = await planInstall([fileOf('game.apks', set)], pixel9)
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.source, p.split, p.role])).toEqual([
      ['splits/base-master.apk', '', { module: 'base', kind: 'base', value: '' }],
      [
        'asset-slices/textures-master.apk',
        'textures',
        { module: 'textures', kind: 'asset-pack', value: '' },
      ],
    ])
    expect(codes(plan.warnings)).toEqual(['LOCAL_TESTING'])
  })

  it('installs a universal set as its one APK', async () => {
    const toc = pb([
      [4, GAME],
      [2, [[2, '1.18.3']]],
      [
        1,
        [
          [3, 0],
          [
            2,
            [
              [
                1,
                [
                  [1, 'base'],
                  [6, 1],
                ],
              ],
              [
                2,
                [
                  [1, []],
                  [2, 'universal.apk'],
                  [4, []],
                ],
              ],
            ],
          ],
        ],
      ],
    ])
    const universal = apk({ package: GAME, versionCode: 7 }, { abis: ['arm64-v8a', 'x86_64'] })
    const plan = await planInstall(
      [
        fileOf(
          'universal.apks',
          makeZip([
            { name: 'toc.pb', data: toc },
            { name: 'universal.apk', data: universal },
          ]),
        ),
      ],
      pixel9,
    )
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.name, p.source, p.role.kind])).toEqual([
      ['0.apk', 'universal.apk', 'base'],
    ])
    expect(plan.app?.nativeAbis).toEqual(['arm64-v8a', 'x86_64'])
  })

  it('refuses sets built for system images', async () => {
    const toc = pb([
      [4, 'com.example.system'],
      [2, [[2, '1.18.3']]],
      [
        1,
        [
          [3, 0],
          [
            2,
            [
              [
                1,
                [
                  [1, 'base'],
                  [6, 1],
                ],
              ],
              [
                2,
                [
                  [2, 'system/system.apk'],
                  [6, []],
                ],
              ],
            ],
          ],
        ],
      ],
    ])
    const set = makeZip([
      { name: 'toc.pb', data: toc },
      { name: 'system/system.apk', data: apk({ package: 'com.example.system', versionCode: 1 }) },
    ])
    const plan = await planInstall([fileOf('system.apks', set)], pixel9)
    expect(codes(plan.problems)).toEqual(['APKS_MODE_UNSUPPORTED'])
  })
})

describe('planInstall: .xapk, .apkm and zips', () => {
  it('reads an .xapk: its parts inflated on the fly, its name and icon, and the OBB it cannot copy', async () => {
    const plan = await planInstall([fileOf('Example Game.xapk', xapk())], pixel9)
    expect(plan.kind).toBe('xapk')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => [p.name, p.source, p.split])).toEqual([
      ['0.apk', `${GAME}.apk`, ''],
      ['1.apk', 'config.arm64_v8a.apk', 'config.arm64_v8a'],
      ['2.apk', 'config.xxhdpi.apk', 'config.xxhdpi'],
      ['3.apk', 'config.en.apk', 'config.en'],
    ])
    expect(await drain(await plan.parts[1]!.open())).toEqual(game.arm64)
    expect(plan.parts[1]!.size).toBe(game.arm64.length)
    expect(plan.selection).toEqual({
      offered: 7,
      abi: 'arm64-v8a',
      density: 'xxhdpi',
      languages: ['en'],
    })
    expect(plan.app).toMatchObject({
      packageName: GAME,
      versionCode: 7,
      versionName: '7.0',
      label: 'Example Game',
      icon: { kind: 'bitmap', mime: 'image/png' },
      nativeAbis: ['arm64-v8a', 'armeabi-v7a'],
    })
    expect(plan.expansions).toEqual([{ path: `/sdcard/${OBB}`, size: 1000 }])
    expect(codes(plan.warnings)).toEqual(['XAPK_OBB'])
  })

  it('reads an .apkm', async () => {
    const info = {
      apkm_version: 5,
      app_name: 'Example Game',
      release_version: '7.0',
      versioncode: '7',
      pname: GAME,
      min_api: '24',
    }
    const apkm = makeZip([
      { name: 'info.json', data: JSON.stringify(info), method: 8 },
      { name: 'icon.png', data: PNG_1PX, method: 8 },
      { name: 'base.apk', data: game.base, method: 8 },
      { name: 'split_config.armeabi_v7a.apk', data: game.armv7, method: 8 },
      { name: 'split_config.mdpi.apk', data: game.mdpi, method: 8 },
      { name: 'split_config.vi.apk', data: game.vi, method: 8 },
      { name: 'APKM_installer.url', data: '[InternetShortcut]', method: 8 },
    ])
    const plan = await planInstall([fileOf('game.apkm', apkm)], {
      supportedAbis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
      supportedLocales: ['vi-VN', 'en-US'],
      screenDensity: 320,
      sdkVersion: 30,
    })
    expect(plan.kind).toBe('apkm')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => p.split)).toEqual([
      '',
      'config.armeabi_v7a',
      'config.mdpi',
      'config.vi',
    ])
    expect(plan.app?.label).toBe('Example Game')
  })

  it('refuses an old encrypted .apkm, and an app-named file that is not one', async () => {
    const plan = await planInstall([new File(['\x01\x02 not a zip'], 'old.apkm')], pixel9)
    expect(plan.problems).toMatchObject([
      {
        code: 'APKM_ENCRYPTED',
        message:
          'old.apkm is encrypted (an old APKMirror format). Download it again from APKMirror.',
      },
    ])
    expect(plan.inputs).toEqual([
      { name: 'old.apkm', size: 12, kind: 'apkm-encrypted', used: false },
    ])
    const page = await planInstall([new File(['<!doctype html>'], 'app.apk')], pixel9)
    expect(codes(page.problems)).toEqual(['NOT_APK'])
  })

  it('reads a zip of split APKs (SAI’s .apks, a compressed folder), skipping macOS shadows', async () => {
    const zip = makeZip([
      { name: 'app/base.apk', data: new Uint8Array(fixture('badge.apk')) },
      {
        name: 'app/split_config.xxhdpi.apk',
        data: new Uint8Array(fixture('badge-config.xxhdpi.apk')),
      },
      { name: '__MACOSX/app/._base.apk', data: 'apple double' },
    ])
    const plan = await planInstall([fileOf('app.zip', zip)], pixel9)
    expect(plan.kind).toBe('zip')
    expect(plan.problems).toEqual([])
    expect(plan.parts.map((p) => p.source)).toEqual(['app/base.apk', 'app/split_config.xxhdpi.apk'])
    expect(plan.app).toMatchObject({ label: 'Badge Probe', icon: { kind: 'bitmap' } })
  })

  it('says when the browser cannot unpack compressed APKs', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    const plan = await planInstall([fileOf('game.xapk', xapk())], pixel9)
    expect(plan.problems).toMatchObject([
      {
        code: 'UNZIP_UNSUPPORTED',
        message:
          'This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer).',
      },
    ])
  })
})

describe('planInstall: what it refuses up front', () => {
  it('names an .aab and the app inside, but sends nothing', async () => {
    const plan = await planInstall([fileOf('probe.aab')], pixel9)
    expect(plan.kind).toBe('aab')
    expect(plan.parts).toEqual([])
    expect(codes(plan.problems)).toEqual(['AAB_NEEDS_HELPER'])
    expect(plan.app).toMatchObject({
      packageName: 'com.bauloc.bundleprobe',
      versionCode: 1,
      minSdk: 24,
      nativeAbis: ['armeabi-v7a', 'arm64-v8a', 'x86_64'],
    })
  })

  it('installs one app at a time', async () => {
    const plan = await planInstall([fileOf('probe-unsigned.apks'), fileOf('badge.apk')], pixel9)
    expect(codes(plan.problems)).toEqual(['MIXED_INPUTS'])
    expect(plan.inputs.map((i) => i.kind)).toEqual(['apks', 'apk'])
  })

  it('refuses damaged files, and has nothing to say about nothing', async () => {
    const whole = fixture('badge.apk')
    const cut = await planInstall(
      [fileOf('cut.apk', new Uint8Array(whole.subarray(0, 1500)))],
      pixel9,
    )
    expect(cut.problems).toMatchObject([
      {
        code: 'DAMAGED',
        message: 'cut.apk is damaged or incomplete. Download or copy it again.',
        file: 'cut.apk',
      },
    ])
    const locked = makeZip([
      { name: 'base.apk', data: 'x', flags: 1 },
      { name: 'info.json', data: '{}' },
    ])
    expect(codes((await planInstall([fileOf('locked.apkm', locked)], pixel9)).problems)).toEqual([
      'ENCRYPTED_ZIP',
    ])
    expect(codes((await planInstall([], pixel9)).problems)).toEqual(['NOTHING_TO_INSTALL'])
    expect(codes((await planInstall([new File(['hello'], 'notes.txt')], pixel9)).problems)).toEqual(
      ['NOTHING_TO_INSTALL'],
    )
  })
})

describe('checkPhone', () => {
  const planOf = (totalBytes: number, versionCode = 812): InstallPlan => ({
    kind: 'apk',
    inputs: [],
    app: {
      packageName: 'com.example.app',
      versionCode,
      versionName: '1.4.0',
      minSdk: 24,
      targetSdk: 35,
      testOnly: false,
      debuggable: false,
      nativeAbis: [],
      label: null,
      icon: null,
    },
    parts: [],
    totalBytes,
    selection: null,
    expansions: [],
    problems: [],
    warnings: [],
    notes: [],
  })
  const MB = 1024 * 1024

  it('blocks below the app’s size and warns below twice it', () => {
    expect(checkPhone(planOf(210 * MB), { sdk: 37, freeBytes: 150 * MB }).problems).toMatchObject([
      {
        code: 'INSUFFICIENT_SPACE',
        message: 'Not enough space on the phone: needs about 210 MB, 150 MB free.',
      },
    ])
    expect(codes(checkPhone(planOf(210 * MB), { sdk: 37, freeBytes: 300 * MB }).warnings)).toEqual([
      'LOW_SPACE',
    ])
    expect(checkPhone(planOf(210 * MB), { sdk: 37, freeBytes: 500 * MB })).toEqual({
      problems: [],
      warnings: [],
      notes: [],
    })
  })

  it('tells an update, a reinstall and a downgrade apart', () => {
    const installed = (versionCode: number, debuggable = false) => ({
      sdk: 37,
      installed: { versionCode, versionName: '1.5.0', debuggable },
    })
    expect(checkPhone(planOf(1), installed(900)).problems).toMatchObject([
      {
        code: 'VERSION_DOWNGRADE',
        action: 'uninstall-first',
        message:
          'A newer version is installed (1.5.0 (900)). Android won’t put an older one over it; uninstalling it first deletes its data.',
      },
    ])
    expect(checkPhone(planOf(1), installed(900, true)).warnings).toMatchObject([
      { code: 'VERSION_DOWNGRADE', action: 'allow-downgrade' },
    ])
    expect(codes(checkPhone(planOf(1), installed(700)).notes)).toEqual(['UPDATE'])
    expect(codes(checkPhone(planOf(1), installed(812)).notes)).toEqual(['REINSTALL'])
    expect(checkPhone(planOf(1), { sdk: 37, installed: null })).toEqual({
      problems: [],
      warnings: [],
      notes: [],
    })
  })
})

describe('wording helpers', () => {
  it('names Android versions the way testers know them', () => {
    expect([21, 26, 32, 37, 40].map(androidName)).toEqual([
      'Android 5.0 (API 21)',
      'Android 8.0 (API 26)',
      'Android 12L (API 32)',
      'Android 17 (API 37)',
      'API 40',
    ])
  })

  it('gives the bundletool command for an .aab, quoted for a shell', () => {
    expect(bundletoolCommand('app-release.aab')).toBe(
      'bundletool build-apks --bundle=app-release.aab --output=app-release.apks --mode=universal',
    )
    expect(bundletoolCommand("My App's.aab")).toBe(
      `bundletool build-apks --bundle='My App'\\''s.aab' --output='My App'\\''s.apks' --mode=universal`,
    )
  })
})
