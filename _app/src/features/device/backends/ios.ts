import { localized } from '@/lib/i18n'

import { fmtBytes, type DeviceDetail } from '../model'
import type { IosFacts, SimFacts } from '../helper/protocol'
import IOS_MODELS from './ios-models.json'

/*
  Turning the helper's iOS facts into the detail pane — pure, so it is tested on fixtures
  (ios.test.ts). The helper sends raw, whitelisted lockdown values (spec §3.5) and leaves the
  wording to the page, as androidDetail does for adb output: the labels are Apple's own
  (Settings → General → About, Finder, Xcode), so a value pasted into a ticket reads the way
  the tester saw it on the phone.

  Empty values are '' and DetailGroup hides them: a field iOS withheld (locked, no session)
  never shows as a blank that looks like a reading.
*/

const MODELS: Readonly<Record<string, string>> = IOS_MODELS

/** The words in the detail's values, in the language on screen when it is read. */
const VALUES = localized({
  en: {
    freeUpTo: (free: string, most: string) => `${free} free · up to ${most} as iOS clears caches`,
    free: (free: string) => `${free} free`,
    on: 'On',
    off: 'Off',
    charging: ' · charging',
    plaintextNote: 'Only the basic identifiers are available; the environment check says why.',
    withheldNote: 'Unlock the device to read battery and storage.',
    paired: 'Paired',
    notPaired: 'Not paired',
    locked: 'Locked',
    unlocked: 'Unlocked',
    used: (size: string) => `${size} used`,
  },
  vi: {
    freeUpTo: (free: string, most: string) =>
      `Còn trống ${free} · tối đa ${most} khi iOS dọn bộ nhớ đệm`,
    free: (free: string) => `Còn trống ${free}`,
    on: 'Bật',
    off: 'Tắt',
    charging: ' · đang sạc',
    plaintextNote:
      'Chỉ đọc được các thông tin định danh cơ bản; Kiểm tra môi trường sẽ cho biết lý do.',
    withheldNote: 'Mở khóa thiết bị để đọc pin và bộ nhớ.',
    paired: 'Đã ghép nối',
    notPaired: 'Chưa ghép nối',
    locked: 'Đang khóa',
    unlocked: 'Đã mở khóa',
    used: (size: string) => `Đã dùng ${size}`,
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
 * "iPhone13,3" → "iPhone 12 Pro", from Xcode's device_traits.db (scripts/ios-models.mjs).
 * '' when the identifier is newer than the table: the caller shows the identifier instead.
 */
export function iosModelName(modelId: string): string {
  return Object.hasOwn(MODELS, modelId) ? (MODELS[modelId] ?? '') : ''
}

/**
 * Bytes in decimal units, as Apple counts storage: 256_000_000_000 → "256 GB" (what Settings →
 * General → About says, where fmtBytes' 1024-based "238 GB" would read as the wrong phone).
 * Three significant figures at most, trailing zeros dropped: "98.8 GB", "1.23 GB", "1 TB".
 */
export function fmtDecimalBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  const digits = i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2
  return `${String(Number(n.toFixed(digits)))} ${units[i] ?? ''}`
}

/**
 * The ECID as Apple's restore and configuration tools print it: 0x and 16 hex digits, which on
 * every iPhone since 2018 is the second half of the UDID. Lockdown sends it as a decimal string,
 * because it can exceed 2^53; anything else is shown as it came.
 */
export function fmtEcid(decimal: string | undefined): string {
  if (!decimal) return ''
  if (!/^\d{1,20}$/.test(decimal)) return decimal
  const value = BigInt(decimal)
  if (value >= 1n << 64n) return decimal
  return `0x${value.toString(16).toUpperCase().padStart(16, '0')}`
}

/**
 * Free space, in both of lockdown's figures, since neither is what Settings says:
 * AmountDataAvailable is free right now, and TotalDataAvailable adds what iOS can clear when it
 * needs room (caches, offloadable apps). "40.3 GB free · up to 161 GB as iOS clears caches";
 * one figure when they round the same or only one came.
 */
export function iosAvailable(disk: IosFacts['disk']): string {
  const free = fmtDecimalBytes(disk?.AmountDataAvailable)
  const most = fmtDecimalBytes(disk?.TotalDataAvailable)
  const more = (disk?.TotalDataAvailable ?? 0) > (disk?.AmountDataAvailable ?? 0)
  if (free && most && most !== free && more) return VALUES.freeUpTo(free, most)
  const one = free || most
  return one ? VALUES.free(one) : ''
}

const onOff = (value: boolean | null): string =>
  value === null ? '' : value ? VALUES.on : VALUES.off

function battery(facts: IosFacts): string {
  const level = facts.battery?.BatteryCurrentCapacity
  if (level === undefined) return ''
  return `${String(level)}%${facts.battery?.BatteryIsCharging ? VALUES.charging : ''}`
}

/** Why some fields are empty, when the reason is something the tester can change. */
function detailsNote(facts: IosFacts): string {
  if (facts.source === 'plaintext') return VALUES.plaintextNote
  if (facts.withheld.length > 0) return VALUES.withheldNote
  return ''
}

/**
 * The detail pane for an iPhone or iPad the helper reads over lockdown. `connectionLabel` names
 * the lane ("USB (local helper)", "Wi‑Fi (local helper)").
 */
export function iosDetail(facts: IosFacts, connectionLabel: string): DeviceDetail {
  const d = facts.device
  const productType = d.ProductType ?? ''
  const disk = facts.disk
  const language = facts.international?.Language ?? ''
  const locale = facts.international?.Locale ?? ''
  return {
    platform: 'ios',
    // IMEI, phone number and MAC addresses are deliberately absent: the helper never reads them
    // (spec §3.5), so a ticket can't carry them by accident.
    identity: {
      'Device name': d.DeviceName ?? '',
      Model: iosModelName(productType) || productType,
      'Model identifier': productType,
      // Settings shows the part number and the region together: MGLQ3 + LL/A → MGLQ3LL/A.
      'Model number': (d.ModelNumber ?? '') + (d.ModelNumber ? (d.RegionInfo ?? '') : ''),
      Serial: d.SerialNumber ?? '',
      Identifier: facts.udid,
      ECID: fmtEcid(d.UniqueChipID),
    },
    software: fields({
      iOS: d.ProductVersion ?? '',
      Build: d.BuildVersion ?? '',
      'Developer Mode': () => onOff(facts.developerMode),
      // plaintext: lockdown answered without a session, so this Mac holds no pairing it can use.
      Pairing: () => (facts.source === 'plaintext' ? VALUES.notPaired : VALUES.paired),
    }),
    hardware: {
      'Hardware model': d.HardwareModel ?? '',
      'CPU architecture': d.CPUArchitecture ?? '',
      Capacity: fmtDecimalBytes(disk?.TotalDiskCapacity),
      Language: language,
      Locale: locale,
      'Time zone': d.TimeZone ?? '',
    },
    status: fields({
      Battery: () => battery(facts),
      Available: () => iosAvailable(disk),
      Lock: () => (facts.locked === null ? '' : facts.locked ? VALUES.locked : VALUES.unlocked),
      Connection: connectionLabel,
      'Details note': () => detailsNote(facts),
    }),
  }
}

/** The detail pane for a booted iOS Simulator, from `simctl list`. */
export function simulatorDetail(facts: SimFacts): DeviceDetail {
  const size = facts.dataPathSize
  return {
    platform: 'ios',
    identity: {
      'Device name': facts.name,
      Model: facts.deviceType.name,
      'Model identifier': facts.deviceType.modelIdentifier,
      Identifier: facts.udid,
    },
    software: { iOS: facts.runtime.version, Build: facts.runtime.build },
    hardware: {},
    status: fields({
      Storage: size === undefined ? '' : () => VALUES.used(fmtBytes(size)),
      Connection: 'Simulator',
    }),
  }
}
