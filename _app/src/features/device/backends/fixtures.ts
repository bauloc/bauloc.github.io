import type { DetailOutputs } from './android'

/*
  adb shell output for the parser tests, in the exact shapes the commands print. The Pixel 9
  values are the ones the legacy page was verified with (its 99-mock.js fixtures); the others
  cover what a real fleet throws at the parser — an overridden resolution, a phone that is
  not charging, a device that answered nothing at all.
*/

const pixelGetprop = [
  '[persist.sys.locale]: [en-US]',
  '[persist.sys.timezone]: [Asia/Ho_Chi_Minh]',
  '[ro.build.display.id]: [CP1A.260905.005]',
  '[ro.build.fingerprint]: [google/tokay/tokay:17/CP1A.260905.005/14212356:user/release-keys]',
  '[ro.build.id]: [CP1A.260905.005]',
  '[ro.build.type]: [user]',
  '[ro.build.version.release]: [17]',
  '[ro.build.version.release_or_codename]: [17]',
  '[ro.build.version.sdk]: [37]',
  '[ro.build.version.security_patch]: [2026-09-05]',
  '[ro.product.brand]: [google]',
  '[ro.product.cpu.abi]: [arm64-v8a]',
  '[ro.product.cpu.abilist]: [arm64-v8a]',
  '[ro.product.device]: [tokay]',
  '[ro.product.manufacturer]: [Google]',
  '[ro.product.model]: [Pixel 9]',
  '[ro.serialno]: [55090DLAQ0026D]',
  // Lines the parser must skip: blank, garbage, and a value containing brackets.
  '',
  'not a property line',
  '[ro.boot.hardware.sku]: [G2YBB]',
].join('\n')

const pixelBattery = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  Max charging current: 500000
  status: 2
  health: 2
  present: true
  level: 62
  scale: 100
  voltage: 4012
  temperature: 367
  technology: Li-ion
`

const samsungBattery = `Current Battery Service state:
  AC powered: false
  USB powered: false
  Wireless powered: false
  status: 3
  level: 18
  temperature: -15
`

export const DETAIL_FIXTURES: Readonly<Record<string, { serial: string; outputs: DetailOutputs }>> =
  {
    'pixel-9': {
      serial: '55090DLAQ0026D',
      outputs: {
        getprop: pixelGetprop,
        wmSize: 'Physical size: 1080x2424\n',
        wmDensity: 'Physical density: 420\n',
        battery: pixelBattery,
        df: 'Filesystem      1K-blocks     Used Available Use% Mounted on\n/dev/block/dm-48 114786388 27952736  86833652  25% /data/user/0\n',
        androidId: 'a430d5902cade0d5\n',
      },
    },
    'galaxy-overridden': {
      serial: 'R58MC0ABCDE',
      outputs: {
        getprop: [
          '[ro.product.model]: [SM-G991B]',
          '[ro.product.manufacturer]: [samsung]',
          '[ro.product.brand]: [samsung]',
          '[ro.build.version.release]: [14]',
          '[ro.build.version.sdk]: [34]',
          '[ro.build.id]: [UP1A.231005.007]',
        ].join('\n'),
        wmSize: 'Physical size: 1080x2400\nOverride size: 720x1600\n',
        wmDensity: 'Physical density: 420\nOverride density: 280\n',
        battery: samsungBattery,
        df: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-3 110347320 98123456 12223864 89% /data\n',
        androidId: '',
      },
    },
    'silent-device': {
      serial: 'emulator-5554',
      outputs: { getprop: '', wmSize: '', wmDensity: '', battery: '', df: '', androidId: '' },
    },
  }
