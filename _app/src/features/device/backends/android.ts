import { localized } from '@/lib/i18n'

import { fmtBytes, type DeviceDetail } from '../model'

/*
  Turning adb shell output into the detail pane — pure, so it is tested on recorded output
  (parity.test.ts compares it with what the legacy dvcUsbDetail made of the same text).

  Each command runs separately, never as one compound shell string: building a compound
  command would mean quoting for the DEVICE's shell, a trap avoided entirely by never
  assembling shell strings. These are the commands, in the order the outputs are passed in.
*/
export const DETAIL_COMMANDS = [
  ['getprop'],
  ['wm', 'size'],
  ['wm', 'density'],
  ['dumpsys', 'battery'],
  ['df', '/data'],
  ['settings', 'get', 'secure', 'android_id'],
] as const

export interface DetailOutputs {
  getprop: string
  wmSize: string
  wmDensity: string
  battery: string
  df: string
  androidId: string
}

/** `[ro.product.model]: [Pixel 9]` lines → `{ 'ro.product.model': 'Pixel 9' }`. */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim())
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2]
  }
  return out
}

/** The words in the detail's values, in the language on screen when it is read. */
const VALUES = localized({
  en: {
    charging: ' · charging',
    storage: (free: string, total: string) => `${free} free of ${total}`,
    used: (percent: string) => ` (${percent}% used)`,
    androidIdNote: 'This is the shell user’s ANDROID_ID — an app reports a different value.',
  },
  vi: {
    charging: ' · đang sạc',
    storage: (free: string, total: string) => `Còn trống ${free} trên ${total}`,
    used: (percent: string) => ` (đã dùng ${percent}%)`,
    androidIdNote: 'Đây là ANDROID_ID của người dùng shell — ứng dụng sẽ đọc được giá trị khác.',
  },
})

/**
 * A detail group whose worded values (the functions) are read again at every access: the store
 * keeps the detail it read, and the pane still says it in the language on screen after a switch.
 */
function fields(values: Readonly<Record<string, string | (() => string)>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') out[key] = value
    else Object.defineProperty(out, key, { enumerable: true, configurable: true, get: value })
  }
  return out
}

/**
 * The detail pane for an Android device, from the outputs of DETAIL_COMMANDS. `connection` names
 * the lane that read them: the helper passes its own ("USB (adb server)"), and the default keeps
 * WebUSB's answers identical to the legacy page's (parity.json).
 */
export function androidDetail(
  o: DetailOutputs,
  serial: string,
  connection = 'USB (WebUSB)',
): DeviceDetail {
  const p = parseGetprop(o.getprop)
  const prop = (key: string) => p[key] ?? ''

  // Prefer the override when the tester has changed resolution or density.
  const size =
    /Override size:\s*(\d+)x(\d+)/.exec(o.wmSize) ?? /Physical size:\s*(\d+)x(\d+)/.exec(o.wmSize)
  const dens =
    /Override density:\s*(\d+)/.exec(o.wmDensity) ?? /Physical density:\s*(\d+)/.exec(o.wmDensity)

  const battLevel = /^\s*level:\s*(\d+)/m.exec(o.battery)
  const battTemp = /^\s*temperature:\s*(-?\d+)/m.exec(o.battery) // deci-°C
  const battStatus = /^\s*status:\s*(\d+)/m.exec(o.battery)
  const powered = /(AC|USB|Wireless) powered:\s*true/.test(o.battery)
  // BatteryManager.BATTERY_STATUS_CHARGING = 2, _FULL = 5.
  const charging = powered || battStatus?.[1] === '2' || battStatus?.[1] === '5'

  // df prints the mount point as /data/user/0, not /data — so it is not checked. 1K blocks.
  const dfCols = (o.df.trim().split('\n').pop() ?? '').trim().split(/\s+/)
  const kTotal = Number(dfCols[1])
  const kUsed = Number(dfCols[2])
  const kFree = Number(dfCols[3])

  return {
    platform: 'android',
    // IMEI is deliberately absent: since Android 10 the shell user lacks
    // READ_PRIVILEGED_PHONE_STATE, and an empty field would imply it could be read.
    identity: {
      'Device name': prop('ro.product.model') || serial,
      Model: prop('ro.product.model'),
      Manufacturer: prop('ro.product.manufacturer'),
      Brand: prop('ro.product.brand'),
      Codename: prop('ro.product.device'),
      Serial: prop('ro.serialno') || serial,
      ANDROID_ID: o.androidId.trim(),
    },
    software: {
      Android: prop('ro.build.version.release_or_codename') || prop('ro.build.version.release'),
      'API level': prop('ro.build.version.sdk'),
      Build: prop('ro.build.display.id') || prop('ro.build.id'),
      'Security patch': prop('ro.build.version.security_patch'),
      Fingerprint: prop('ro.build.fingerprint'),
      'Build type': prop('ro.build.type'),
    },
    hardware: {
      ABI: prop('ro.product.cpu.abi'),
      'ABI list': prop('ro.product.cpu.abilist'),
      Screen: size ? `${size[1] ?? ''} × ${size[2] ?? ''} px` : '',
      Density: dens ? `${dens[1] ?? ''} dpi` : '',
      Locale: prop('persist.sys.locale'),
      Timezone: prop('persist.sys.timezone'),
    },
    status: fields({
      Battery: battLevel
        ? () =>
            `${battLevel[1] ?? ''}%` +
            (charging ? VALUES.charging : '') +
            (battTemp ? ` · ${(Number(battTemp[1]) / 10).toFixed(1)} °C` : '')
        : '',
      Storage:
        Number.isFinite(kFree) && Number.isFinite(kTotal)
          ? () =>
              VALUES.storage(fmtBytes(kFree * 1024), fmtBytes(kTotal * 1024)) +
              (Number.isFinite(kUsed)
                ? VALUES.used(String(Math.round((kUsed / kTotal) * 100)))
                : '')
          : '',
      Connection: connection,
      'ANDROID_ID note': () => VALUES.androidIdNote,
    }),
    raw: { getprop: o.getprop },
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** The IEND chunk every complete PNG ends with: zero length, the type, and its CRC. */
const PNG_END = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const

function matchesAt(bytes: Uint8Array, pattern: readonly number[], at: number): boolean {
  if (at < 0 || at + pattern.length > bytes.length) return false
  return pattern.every((byte, i) => bytes[at + i] === byte)
}

/**
 * The PNG inside what `screencap -p` sent back, or null when there is none. Text can come
 * first — screencap warns on stderr about phones with two displays, and without the shell
 * protocol adbd mixes stderr into the output — and an image cut short by a pulled cable has no
 * IEND chunk, so it is refused rather than saved as a broken file.
 */
export function extractPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  let start = -1
  for (let i = 0; i + PNG_SIGNATURE.length <= bytes.length; i++) {
    if (matchesAt(bytes, PNG_SIGNATURE, i)) {
      start = i
      break
    }
  }
  if (start < 0) return null
  // IEND is the last chunk, so search back from the end; anything after it is dropped.
  for (let end = bytes.length - PNG_END.length; end > start; end--) {
    if (matchesAt(bytes, PNG_END, end)) return bytes.slice(start, end + PNG_END.length)
  }
  return null
}
