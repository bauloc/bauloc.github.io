import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { pb } from './__fixtures__/synth'
import { parseToc, pbFields } from './toc'

/*
  The tables of contents bundletool 1.18.3 wrote for the probe sets (see make-picks.mjs), and
  hand-made ones for fields those sets leave unset.
*/

const toc = (name: string) =>
  parseToc(readFileSync(new URL(`./__fixtures__/${name}.toc.pb`, import.meta.url)))

describe('parseToc', () => {
  it('reads the variants, modules and APKs of an APK set', () => {
    const t = toc('probe-all')
    expect(t.packageName).toBe('com.bauloc.bundleprobe')
    expect(t.bundletoolVersion).toBe('1.18.3')
    expect(t.variants.map((v) => [v.number, v.targeting.sdk])).toEqual([
      [0, { value: [24], alternatives: [29, 32] }],
      [1, { value: [29], alternatives: [24, 32] }],
      [2, { value: [32], alternatives: [24, 29] }],
    ])
    const [base, extras] = t.variants[2]!.modules
    expect([base?.name, base?.delivery, extras?.name, extras?.delivery]).toEqual([
      'base',
      'install-time',
      'extras',
      'on-demand',
    ])
    expect(base?.apks.find((a) => a.splitId === '')).toMatchObject({
      path: 'splits/base-master_3.apk',
      kind: 'split',
      isMasterSplit: true,
    })
    expect(base?.apks.find((a) => a.splitId === 'config.arm64_v8a')?.targeting.abi).toEqual({
      value: ['arm64-v8a'],
      alternatives: ['armeabi-v7a', 'x86_64'],
    })
    expect(base?.apks.find((a) => a.splitId === 'config.xxhdpi')?.targeting.density).toEqual({
      value: [480],
      alternatives: [120, 160, 213, 240, 320, 640],
    })
    expect(base?.apks.find((a) => a.splitId === 'config.vi')?.targeting.language).toEqual({
      value: ['vi'],
      alternatives: [],
    })
  })

  it('reads asset packs, the bundle’s default suffixes and module conditions', () => {
    expect(toc('probe-packs').assetPacks.map((p) => [p.name, p.delivery, p.apks[0]?.kind])).toEqual(
      [
        ['itpack', 'install-time', 'asset-slice'],
        ['odpack', 'on-demand', 'asset-slice'],
      ],
    )
    const matrix = toc('matrix')
    expect(matrix.defaults).toEqual({ textureFormat: 'etc2', deviceTier: '1' })
    const cond = matrix.variants[0]!.modules.find((m) => m.name === 'cond')
    expect(cond?.targeting).toEqual({
      sdk: { value: [30], alternatives: [] },
      deviceFeatures: [{ name: 'android.hardware.camera.ar', version: 0 }],
      userCountries: false,
      deviceGroups: [],
    })
    const astc = matrix.variants[0]!.modules[0]!.apks.find((a) => a.splitId === 'config.astc')
    expect(astc?.targeting.textureFormat).toEqual({
      value: ['astc'],
      alternatives: ['pvrtc', 'etc2'],
    })
  })

  it('reads the fields the probe sets leave unset', () => {
    const t = parseToc(
      pb([
        [4, 'com.example.app'],
        [
          5,
          [
            [1, 1],
            [2, 'local_testing'],
          ],
        ],
        [
          1,
          [
            [3, 4],
            [1, [[6, [[1, 1]]]]],
            [
              2,
              [
                [
                  1,
                  [
                    [1, 'base'],
                    [2, 1],
                    [4, 'shared'],
                  ],
                ],
                [
                  2,
                  [
                    [
                      1,
                      [
                        [
                          4,
                          [
                            [1, [[1, 0]]],
                            [2, [[2, 420]]],
                          ],
                        ],
                      ],
                    ],
                    [2, 'standalones/standalone.apk'],
                    [4, [[3, 'base']]],
                  ],
                ],
              ],
            ],
          ],
        ],
      ]),
    )
    expect(t.localTesting).toEqual({ enabled: true, path: 'local_testing' })
    const variant = t.variants[0]!
    expect(variant.number).toBe(4)
    expect(variant.targeting.requiresSdkRuntime).toBe(true)
    expect(variant.modules[0]).toMatchObject({
      delivery: 'unknown',
      onDemandDeprecated: true,
      dependencies: ['shared'],
    })
    // A density given by alias 0 (unspecified) or in dpi.
    expect(variant.modules[0]!.apks[0]).toMatchObject({
      kind: 'standalone',
      splitId: 'base',
      targeting: { density: { value: [0], alternatives: [420] } },
    })
  })

  it('refuses bytes that are not a protobuf message', () => {
    expect(() => pbFields(Uint8Array.from([0x0a, 0x10, 0x01]))).toThrow('PROTOBUF_CORRUPT')
    expect(() => pbFields(Uint8Array.from([0x0b]))).toThrow('PROTOBUF_CORRUPT') // a group
    expect(() => pbFields(Uint8Array.from([0x08, 0x80]))).toThrow('PROTOBUF_CORRUPT')
  })
})
