/* ============================================================
   Device Lab — mock backend  (loaded ONLY with ?mock=1)

   Lets the whole UI — including every empty, error and
   unauthorized state — be built and demoed with no device and no
   helper attached. Query-gated rather than a tracked-but-unlinked
   file, so it never has to be removed before committing.

   STAGE 0: fixtures only. The stubbed transport lands with the
   backend interface in 02-backend.js.
   ============================================================ */

const DVC_MOCK_DEVICES = [
  {
    id: '55090DLAQ0026D',
    platform: 'android',
    state: 'ready',
    connection: 'usb',
    name: 'Pixel 9',
    model: 'Pixel 9',
    manufacturer: 'Google',
    osVersion: '17',
    sdkInt: 37,
    abi: 'arm64-v8a',
    serial: '55090DLAQ0026D',
    androidId: 'a430d5902cade0d5',
    screen: { w: 1080, h: 2424, density: 420 },
    battery: { level: 62, charging: true, tempC: 36.7 },
    storage: { freeBytes: 88_918_069_248, totalBytes: 117_541_261_312 },
    blockers: []
  },
  {
    id: '00008101-001E29801AC0001E',
    platform: 'ios',
    state: 'ready',
    connection: 'usb',
    name: "Bầu's iPhone 12 Pro",
    model: 'iPhone 12 Pro',
    modelIdentifier: 'iPhone13,3',
    osVersion: '26.5.2',
    osBuild: '23F84',
    serial: 'F17DK2SC0D92',
    udid: '00008101-001E29801AC0001E',
    developerMode: true,
    pairingState: 'paired',
    blockers: ['TUNNEL_REQUIRED']
  },
  {
    id: 'R58MC0ABCDE',
    platform: 'android',
    state: 'unauthorized',
    connection: 'usb',
    name: 'Galaxy S21',
    blockers: ['ANDROID_UNAUTHORIZED']
  },
  {
    id: '00008120-000A1B2C3D4E5F01',
    platform: 'ios',
    state: 'untrusted',
    connection: 'usb',
    name: 'iPad Pro',
    blockers: ['IOS_UNTRUSTED']
  },
  {
    id: '192.168.1.42:5555',
    platform: 'android',
    state: 'offline',
    connection: 'network',
    name: 'Redmi Note 12',
    blockers: ['ANDROID_OFFLINE']
  }
];

const DVC_MOCK_HEALTH = {
  name: 'bauloc-device-bridge',
  version: '1.0.0',
  protocol: 1,
  port: DVC_DEFAULT_PORT,
  tokenId: 'deadbeef',
  readOnly: false,
  needsPairing: false
};

console.info('[dvc] MOCK MODE — ' + DVC_MOCK_DEVICES.length + ' fixture devices, no real transport');
