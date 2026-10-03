import {
  fmtBytes,
  normalizeDevice,
  type Device,
  type DeviceDetail,
  type DeviceState,
} from '../model'
import type { Backend } from './backend'

/*
  The mock lane (?mock=1): fixture devices in every state that matters, so the whole UI —
  empty, error and unauthorized states included — can be built and demoed with no phone and
  no helper. It finishes what the legacy 99-mock.js started (its fixtures, stage 0); the
  devices are the same ones, down to the Pixel 9 the real lane was verified on.

  It behaves like the real lanes where a tester would notice: Retry walks an unauthorized
  phone through authorizing to ready, an untrusted iPad to ready, screenshots are real PNGs,
  and the log streams.
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
    id: '00008101-001E29801AC0001E',
    platform: 'ios',
    state: 'ready',
    connection: 'usb',
    name: "Bầu's iPhone 12 Pro",
    model: 'iPhone 12 Pro',
    osVersion: '26.5.2',
    blockers: ['TUNNEL_REQUIRED'],
    detail: {
      identity: {
        'Device name': "Bầu's iPhone 12 Pro",
        Model: 'iPhone 12 Pro',
        'Model identifier': 'iPhone13,3',
        Serial: 'F17DK2SC0D92',
        Identifier: '00008101-001E29801AC0001E',
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
  },
]

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** A plausible screen for the device: its name, the time and a gradient — a real PNG. */
async function renderScreen(name: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 540
  canvas.height = 1170
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  const g = ctx.createLinearGradient(0, 0, 540, 1170)
  g.addColorStop(0, 'rgb(79 70 229)')
  g.addColorStop(1, 'rgb(16 185 129)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 540, 1170)
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
  ctx.fillText('Mock screenshot · Device Lab', 270, 1100)
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
  const isReady = (id: string) => states.get(id)?.state === 'ready'

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
      MOCK_FIXTURES.map((f) => {
        const s = states.get(f.id) ?? { state: f.state, blockers: f.blockers }
        const ready = s.state === 'ready'
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
          },
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
