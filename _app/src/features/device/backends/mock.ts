import {
  fmtBytes,
  MIN_INSTALL_SDK,
  normalizeDevice,
  type AndroidFacts,
  type Device,
  type DeviceDetail,
  type DeviceState,
} from '../model'
import type { Backend } from './backend'
import { createMockAndroid } from './mock-android'

/*
  The mock lane (?mock=1): fixture devices in every state that matters, so the whole UI —
  empty, error and unauthorized states included — can be built and demoed with no phone and
  no helper. It finishes what the legacy 99-mock.js started (its fixtures, stage 0); the
  devices are the same ones, down to the Pixel 9 the real lane was verified on.

  It behaves like the real lanes where a tester would notice: Retry walks an unauthorized
  phone through authorizing to ready, an untrusted iPad to ready, screenshots are real PNGs,
  and the log streams.

  The Android features (mock-android.ts) work on every ready Android fixture, with fake data
  and fake progress. Their failures are asked for like this:

  Installs: drop real files (the plan is real: archive/plan reads them), named
  `<anything>-<trigger>.<ext>`. Sending runs at about 20 MB/s; Cancel works while sending.
  - `-incompatible`         UPDATE_INCOMPATIBLE, while the app is installed (so "Uninstall and
                            install" then works; com.bauloc.bundleprobe is installed to start)
  - `-downgrade`            VERSION_DOWNGRADE, unless Allow downgrade is ticked
  - `-deprecated-sdk`       DEPRECATED_SDK_VERSION, unless Install anyway is ticked
  - `-missing-split`, `-no-abis`, `-older-sdk`, `-unsigned` (NO_CERTIFICATES), `-invalid`
    (INVALID_APK), `-not-apk`, `-duplicate-permission`, `-conflicting-provider` (both name
    com.example.notes.debug), `-no-space` (INSUFFICIENT_STORAGE), `-restricted`
    (USER_RESTRICTED), `-aborted`, `-verification`, `-unknown`: that code
  - `-warnings`             installed, "Completed with warning(s)"
  - `-slow`                 installed after a 14 s commit ("Still installing…")
  - `-disconnect`           the phone is unplugged halfway through sending (CONNECTION_LOST):
                            it leaves the list, as a real one does, and 2 s later is plugged
                            back in, connecting, then ready
  Apps: com.example.flaky fails Open, Clear data and Uninstall; system apps refuse Uninstall;
  System UI, Media Storage and Gboard have no screen to open. `&apps=failed` fails the list.
  Images: `&images=failed` makes MediaStore refuse (the folder fallback still works);
  `&images=empty` lists nothing. Some camera shots are HEIC (half with a thumbnail Android
  made, half without), one is 14 MB (no preview) and one `-unreadable` can't be read.
*/

interface Fixture {
  id: string
  platform: Device['platform']
  state: DeviceState
  connection: Device['connection']
  name: string
  model?: string
  osVersion?: string
  blockers: string[]
  detail?: Omit<DeviceDetail, 'platform'>
  /** Android only: what connect would read. */
  android?: AndroidFacts
}

const PIXEL_GETPROP = [
  '[ro.product.model]: [Pixel 9]',
  '[ro.product.manufacturer]: [Google]',
  '[ro.build.version.release]: [17]',
  '[ro.build.version.sdk]: [37]',
].join('\n')

export const MOCK_FIXTURES: readonly Fixture[] = [
  {
    id: '55090DLAQ0026D',
    platform: 'android',
    state: 'ready',
    connection: 'usb',
    name: 'Pixel 9',
    model: 'Pixel 9',
    osVersion: '17',
    blockers: [],
    android: {
      sdk: 37,
      release: '17',
      manufacturer: 'Google',
      brand: 'google',
      abis: ['arm64-v8a'],
    },
    detail: {
      identity: {
        'Device name': 'Pixel 9',
        Model: 'Pixel 9',
        Manufacturer: 'Google',
        Brand: 'google',
        Codename: 'tokay',
        Serial: '55090DLAQ0026D',
        ANDROID_ID: 'a430d5902cade0d5',
      },
      software: {
        Android: '17',
        'API level': '37',
        Build: 'CP1A.260905.005',
        'Security patch': '2026-09-05',
        Fingerprint: 'google/tokay/tokay:17/CP1A.260905.005/14212356:user/release-keys',
        'Build type': 'user',
      },
      hardware: {
        ABI: 'arm64-v8a',
        'ABI list': 'arm64-v8a',
        Screen: '1080 × 2424 px',
        Density: '420 dpi',
        Locale: 'en-US',
        Timezone: 'Asia/Ho_Chi_Minh',
      },
      status: {
        Battery: '62% · charging · 36.7 °C',
        Storage: `${fmtBytes(88_918_069_248)} free of ${fmtBytes(117_541_261_312)} (24% used)`,
        Connection: 'USB (mock)',
        'ANDROID_ID note':
          'This is the shell user’s ANDROID_ID — an app reports a different value.',
      },
      raw: { getprop: PIXEL_GETPROP },
    },
  },
  {
    id: '00008101-000A1B2C3D4E5F02',
    platform: 'ios',
    state: 'ready',
    connection: 'usb',
    name: 'Ngọc’s iPhone 12 Pro',
    model: 'iPhone 12 Pro',
    osVersion: '26.5.2',
    blockers: ['TUNNEL_REQUIRED'],
    detail: {
      identity: {
        'Device name': 'Ngọc’s iPhone 12 Pro',
        Model: 'iPhone 12 Pro',
        'Model identifier': 'iPhone13,3',
        Serial: 'F2LX0EXAMPLE',
        Identifier: '00008101-000A1B2C3D4E5F02',
      },
      software: { iOS: '26.5.2', Build: '23F84', 'Developer Mode': 'On', Pairing: 'Paired' },
      hardware: {},
      status: { Connection: 'USB (mock)' },
    },
  },
  {
    id: 'R58MC0ABCDE',
    platform: 'android',
    state: 'unauthorized',
    connection: 'usb',
    name: 'Galaxy S21',
    blockers: ['ANDROID_UNAUTHORIZED'],
    android: {
      sdk: 34,
      release: '14',
      manufacturer: 'samsung',
      brand: 'samsung',
      abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
    },
  },
  {
    id: '00008120-000A1B2C3D4E5F01',
    platform: 'ios',
    state: 'untrusted',
    connection: 'usb',
    name: 'iPad Pro',
    blockers: ['IOS_UNTRUSTED'],
  },
  {
    id: '192.168.1.42:5555',
    platform: 'android',
    state: 'offline',
    connection: 'network',
    name: 'Redmi Note 12',
    blockers: ['ANDROID_OFFLINE'],
    android: {
      sdk: 33,
      release: '13',
      manufacturer: 'Xiaomi',
      brand: 'Redmi',
      abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
    },
  },
]

/** How long a `-disconnect` phone stays unplugged, then how long it takes to reconnect. */
export const MOCK_UNPLUGGED_MS = 2000
export const MOCK_RECONNECT_MS = 1000

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * A plausible screen for the device: its name, the time and a gradient — a real PNG, the size
 * a Pixel 9 captures (1080 × 2424). Like a real one it is over 1 MB, so the Screenshots card's
 * "Copy ≤ 1 MB" has something to shrink.
 */
async function renderScreen(name: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 2424
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  // Drawn on a 540-wide layout at 2x, as a phone draws dp at its density.
  ctx.scale(2, 2)
  const g = ctx.createLinearGradient(0, 0, 540, 1212)
  g.addColorStop(0, 'rgb(79 70 229)')
  g.addColorStop(1, 'rgb(16 185 129)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 540, 1212)
  ctx.fillStyle = 'rgb(255 255 255)'
  ctx.textAlign = 'center'
  ctx.font = '600 120px system-ui, sans-serif'
  const now = new Date()
  ctx.fillText(
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    270,
    380,
  )
  ctx.font = '500 36px system-ui, sans-serif'
  ctx.fillText(name, 270, 460)
  ctx.font = '400 26px system-ui, sans-serif'
  ctx.fillText('Mock screenshot · Device Lab', 270, 1140)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('SCREENSHOT_NOT_PNG'))
    }, 'image/png')
  })
}

const TAGS = [
  'ActivityManager',
  'WindowManager',
  'OkHttp',
  'ReactNativeJS',
  'chromium',
  'BluetoothAdapter',
]
const LEVELS = ['D', 'I', 'I', 'I', 'W', 'E'] as const

/** One logcat line in `-v threadtime` format. */
function fakeLogLine(n: number): string {
  const now = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, '0')
  const stamp = `${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`
  const level = LEVELS[n % LEVELS.length] ?? 'I'
  const tag = TAGS[n % TAGS.length] ?? 'App'
  return `${stamp}  1234  ${String(1234 + (n % 7))} ${level} ${tag}: mock event #${String(n)}`
}

export function createMockBackend(): Backend {
  const states = new Map(MOCK_FIXTURES.map((f) => [f.id, { state: f.state, blockers: f.blockers }]))
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const fixture = (id: string) => {
    const f = MOCK_FIXTURES.find((x) => x.id === id)
    if (!f) throw new Error('DEVICE_NOT_READY')
    return f
  }
  /** Fixtures pulled out of the "USB port": not listed at all, as a real unplugged phone. */
  const unplugged = new Set<string>()
  const isReady = (id: string) => !unplugged.has(id) && states.get(id)?.state === 'ready'
  const android = createMockAndroid({
    isReady,
    facts: (id) => MOCK_FIXTURES.find((f) => f.id === id)?.android,
    // A real unplug drops the device from the lane's list, so the page sees it go and come back
    // under the same id; leaving it listed as 'absent' would hide that path.
    disconnect(id) {
      const was = states.get(id)
      if (!was || unplugged.has(id)) return
      unplugged.add(id)
      emit()
      setTimeout(() => {
        unplugged.delete(id)
        states.set(id, { state: 'connecting', blockers: [] })
        emit()
        setTimeout(() => {
          states.set(id, was)
          emit()
        }, MOCK_RECONNECT_MS)
      }, MOCK_UNPLUGGED_MS)
    },
  })

  return {
    kind: 'mock',
    label: 'Mock devices',
    platforms: ['android', 'ios'],
    canRequest: false,
    isAvailable: () => true,
    start: () => Promise.resolve(),
    stop: () => undefined,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    list: () =>
      MOCK_FIXTURES.filter((f) => !unplugged.has(f.id)).map((f) => {
        const s = states.get(f.id) ?? { state: f.state, blockers: f.blockers }
        const ready = s.state === 'ready'
        const facts = ready ? f.android : undefined
        return normalizeDevice({
          id: f.id,
          backend: 'mock',
          platform: f.platform,
          connection: f.connection,
          state: s.state,
          name: f.name,
          model: f.model ?? '',
          osVersion: f.osVersion ?? '',
          blockers: s.blockers,
          capabilities: {
            screenshot: ready,
            identifiers: ready,
            logs: ready && f.platform === 'android',
            install: (facts?.sdk ?? 0) >= MIN_INSTALL_SDK,
            apps: !!facts,
            images: !!facts,
          },
          ...(facts ? { android: facts } : {}),
        })
      }),

    async detail(id) {
      await delay(400)
      const f = fixture(id)
      if (!isReady(id)) throw new Error('DEVICE_NOT_READY')
      return {
        platform: f.platform,
        ...(f.detail ?? {
          identity: { 'Device name': f.name, Serial: f.id },
          software: {},
          hardware: {},
          status: { Connection: 'USB (mock)' },
        }),
      }
    },

    async screenshot(id) {
      await delay(500)
      if (!isReady(id)) throw new Error('DEVICE_NOT_READY')
      return renderScreen(fixture(id).name)
    },

    // An unauthorized phone, once retried, authorizes and becomes ready, as a real one does
    // after the tester taps Allow. An offline one stays offline: retrying does not fix a cable.
    async retry(id) {
      const f = fixture(id)
      if (f.state === 'offline') {
        await delay(600)
        return
      }
      states.set(id, {
        state: 'authorizing',
        blockers: f.platform === 'ios' ? ['IOS_UNTRUSTED'] : ['ANDROID_UNAUTHORIZED'],
      })
      emit()
      await delay(1200)
      states.set(id, { state: 'ready', blockers: [] })
      emit()
    },

    ...android,

    async logs(id, onLines, signal) {
      if (!isReady(id)) throw new Error('DEVICE_NOT_READY')
      let n = 0
      onLines(Array.from({ length: 40 }, () => fakeLogLine(n++)))
      while (!signal.aborted) {
        await delay(700)
        if (signal.aborted) break
        onLines(Array.from({ length: 1 + (n % 3) }, () => fakeLogLine(n++)))
      }
    },
  }
}
