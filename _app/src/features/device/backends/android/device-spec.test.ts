import { describe, expect, it } from 'vitest'

import {
  DEVICE_SPEC_COMMANDS,
  abisFromConfig,
  buildDeviceSpec,
  collectDeviceSpec,
  localesFromConfig,
  parseFeatures,
  parseGlExtensions,
  parseMemTotalBytes,
  validateDeviceSpec,
  type DeviceSpecOutputs,
} from './device-spec'
import { fakeAdb } from './fake-adb'
import { AM_GET_CONFIG, MEMINFO, PM_FEATURES, SPEC_GETPROP, SURFACE_FLINGER_GREP } from './fixtures'

const PIXEL: DeviceSpecOutputs = {
  getprop: SPEC_GETPROP,
  amConfig: AM_GET_CONFIG,
  features: PM_FEATURES,
  surfaceFlinger: SURFACE_FLINGER_GREP,
  meminfo: MEMINFO,
  wmDensity: 'Physical density: 420\n',
  sdkSandbox: 'Service sdk_sandbox: found\n',
}

const props = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([key, value]) => `[${key}]: [${value}]`)
    .join('\n')

describe('localesFromConfig', () => {
  it("reads am get-config's locale list after the mcc and mnc", () => {
    expect(localesFromConfig(AM_GET_CONFIG)).toEqual(['en-US', 'vi-VN'])
    expect(localesFromConfig('config: fr-rFR-ldltr-sw411dp-port\n')).toEqual(['fr-FR'])
    expect(localesFromConfig('config: de-ldltr-sw411dp\n')).toEqual(['de'])
  })

  it('reads b+ locales the way bundletool does: the language and a 2-letter or 3-digit region', () => {
    expect(localesFromConfig('config: b+sr+Latn+RS,en-ldltr\n')).toEqual(['sr-RS', 'en'])
    expect(localesFromConfig('config: b+fil+PH-ldltr\n')).toEqual(['fil-PH'])
    expect(localesFromConfig('config: b+es+419,en-rUS-ldltr\n')).toEqual(['es-419', 'en-US'])
  })

  it("keeps Android's old language codes, which the split matcher maps", () => {
    expect(localesFromConfig('config: iw-rIL,in-rID-ldltr\n')).toEqual(['iw-IL', 'in-ID'])
  })

  it('gives up on the whole list over one unreadable locale, as bundletool does', () => {
    expect(localesFromConfig('config: en-rUS,x1-ldltr\n')).toEqual([])
    expect(localesFromConfig('config: mcc310-ldltr-sw411dp\n')).toEqual([])
    expect(localesFromConfig('abi: arm64-v8a\n')).toEqual([])
  })
})

describe('the other parsers', () => {
  it('keeps the ABIs bundletool knows', () => {
    expect(abisFromConfig('abi: arm64-v8a,armeabi-v7a,armeabi\n')).toEqual([
      'arm64-v8a',
      'armeabi-v7a',
      'armeabi',
    ])
    expect(abisFromConfig('abi: x86_64, arm64-v8a-hwasan\n')).toEqual(['x86_64'])
    expect(abisFromConfig('')).toEqual([])
  })

  it('reads features, the GL ES version line included, and skips warnings', () => {
    expect(parseFeatures(`WARNING: linker: something\n${PM_FEATURES}\n`)).toEqual([
      'reqGlEsVersion=0x30002',
      'android.hardware.bluetooth',
      'android.hardware.camera',
      'android.software.webview',
    ])
  })

  it('reads the GL extensions from the line after GLES:, whole dump or grepped', () => {
    const expected = [
      'GL_EXT_debug_marker',
      'GL_ARM_rgba8',
      'GL_OES_depth24',
      'GL_KHR_texture_compression_astc_ldr',
    ]
    expect(parseGlExtensions(SURFACE_FLINGER_GREP)).toEqual(expected)
    const whole = `Build configuration: [sf PRESENT_TIME_OFFSET=0]\nDisplay identification data:\n\n${SURFACE_FLINGER_GREP.replace('--\n', '')}Region undefinedRegion (this=0x7b2c)\n`
    expect(parseGlExtensions(whole)).toEqual(expected)
    expect(parseGlExtensions('GLES: ARM, Mali\nGL_EXT_a\n')).toEqual([])
    expect(parseGlExtensions('')).toEqual([])
  })

  it('reads MemTotal as bytes', () => {
    expect(parseMemTotalBytes(MEMINFO)).toBe(11765412 * 1024)
    expect(parseMemTotalBytes('')).toBeNull()
  })
})

describe('buildDeviceSpec', () => {
  it('builds the spec bundletool would build for the Pixel 9', () => {
    const spec = buildDeviceSpec(PIXEL)
    expect(spec).toEqual({
      supportedAbis: ['arm64-v8a'],
      supportedLocales: ['en-US', 'vi-VN'],
      deviceFeatures: [
        'reqGlEsVersion=0x30002',
        'android.hardware.bluetooth',
        'android.hardware.camera',
        'android.software.webview',
      ],
      glExtensions: [
        'GL_EXT_debug_marker',
        'GL_ARM_rgba8',
        'GL_OES_depth24',
        'GL_KHR_texture_compression_astc_ldr',
      ],
      screenDensity: 420,
      sdkVersion: 37,
      sdkRuntime: { supported: true },
      ramBytes: 11765412 * 1024,
      buildBrand: 'google',
      buildDevice: 'tokay',
      socManufacturer: 'Google',
      socModel: 'Tensor G4',
    })
    expect(validateDeviceSpec(spec)).toEqual([])
  })

  it('falls back as bundletool does when am get-config says nothing', () => {
    const spec = buildDeviceSpec({ ...PIXEL, amConfig: '' })
    expect(spec.supportedAbis).toEqual(['arm64-v8a'])
    expect(spec.supportedLocales).toEqual(['en-US'])
    const bare = buildDeviceSpec({
      ...PIXEL,
      amConfig: '',
      getprop: props({
        'ro.build.version.sdk': '30',
        'ro.product.cpu.abi': 'armeabi-v7a',
        'ro.product.locale': 'vi-VN',
      }),
    })
    expect(bare).toMatchObject({ supportedAbis: ['armeabi-v7a'], supportedLocales: ['vi-VN'] })
    const nothing = buildDeviceSpec({
      ...PIXEL,
      amConfig: '',
      getprop: props({ 'ro.build.version.sdk': '30' }),
    })
    expect(nothing.supportedLocales).toEqual(['en-US'])
  })

  it('uses the legacy language and region properties before Android 6', () => {
    const spec = buildDeviceSpec({
      ...PIXEL,
      amConfig: '',
      getprop: props({
        'ro.build.version.sdk': '22',
        'ro.product.locale.language': 'vi',
        'ro.product.locale.region': 'VN',
        'persist.sys.locale': 'en-US',
      }),
    })
    expect(spec.supportedLocales).toEqual(['vi-VN'])
  })

  it('takes the PHYSICAL density from wm density, never an override, when no property has it', () => {
    const getprop = props({ 'ro.build.version.sdk': '37', 'ro.product.cpu.abilist': 'arm64-v8a' })
    const wmDensity = 'Physical density: 440\nOverride density: 300\n'
    expect(buildDeviceSpec({ ...PIXEL, getprop, wmDensity }).screenDensity).toBe(440)
    const emulator = props({ 'ro.build.version.sdk': '35', 'qemu.sf.lcd_density': '320' })
    expect(buildDeviceSpec({ ...PIXEL, getprop: emulator, wmDensity }).screenDensity).toBe(320)
  })

  it('names a preview build by its codename, one SDK level up', () => {
    const getprop = `${SPEC_GETPROP}\n[ro.build.version.codename]: [Baklava]\n[ro.build.version.sdk]: [35]`
    expect(buildDeviceSpec({ ...PIXEL, getprop })).toMatchObject({
      sdkVersion: 36,
      codename: 'Baklava',
    })
  })

  it('skips GL extensions on Android 7.1 watches only, and the SDK runtime below Android 14', () => {
    const watch = props({
      'ro.build.version.sdk': '25',
      'ro.build.characteristics': 'nosdcard,watch',
    })
    expect(buildDeviceSpec({ ...PIXEL, getprop: watch }).glExtensions).toEqual([])
    expect(buildDeviceSpec({ ...PIXEL, getprop: watch }).sdkRuntime).toEqual({ supported: false })
    expect(
      buildDeviceSpec({ ...PIXEL, sdkSandbox: 'Service sdk_sandbox: not found\n' }).sdkRuntime,
    ).toEqual({
      supported: false,
    })
  })
})

describe('validateDeviceSpec', () => {
  it("refuses what bundletool's parser refuses, in its words", () => {
    const empty = buildDeviceSpec({
      getprop: '',
      amConfig: '',
      features: '',
      surfaceFlinger: '',
      meminfo: '',
      wmDensity: '',
      sdkSandbox: '',
    })
    expect(validateDeviceSpec({ ...empty, supportedLocales: [] })).toEqual([
      'Device spec SDK version (0) should be set to a strictly positive number.',
      'Device spec screen density (0) should be set to a strictly positive number.',
      'Device spec supported ABI list is empty.',
      'Device spec supported locales list is empty.',
    ])
  })
})

describe('collectDeviceSpec', () => {
  it('runs read-only constant commands and builds the spec from their answers', async () => {
    const answers = new Map<string, string>([
      [DEVICE_SPEC_COMMANDS.getprop.text, PIXEL.getprop],
      [DEVICE_SPEC_COMMANDS.amConfig.text, PIXEL.amConfig],
      [DEVICE_SPEC_COMMANDS.features.text, PIXEL.features],
      [DEVICE_SPEC_COMMANDS.surfaceFlinger.text, PIXEL.surfaceFlinger],
      [DEVICE_SPEC_COMMANDS.meminfo.text, PIXEL.meminfo],
      [DEVICE_SPEC_COMMANDS.wmDensity.text, PIXEL.wmDensity],
      [DEVICE_SPEC_COMMANDS.sdkSandbox.text, PIXEL.sdkSandbox],
    ])
    const { adb, calls } = fakeAdb({
      answer: (call) => ({ stdout: answers.get(call.command) ?? '' }),
    })
    const { spec, problems } = await collectDeviceSpec(adb)
    expect(spec).toEqual(buildDeviceSpec(PIXEL))
    expect(problems).toEqual([])
    expect(calls.map((c) => c.command).sort()).toEqual([...answers.keys()].sort())
    expect(DEVICE_SPEC_COMMANDS.surfaceFlinger.text).toBe(
      "dumpsys SurfaceFlinger | grep -A 1 -e '^SurfaceFlinger global state:' -e '^GLES:'",
    )
  })
})
