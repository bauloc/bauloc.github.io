import type { UsbFinding } from './types'

/*
  "Find my phone…" (PLAN §3.2, phone.usbDebugging): why a phone is missing from Add device's
  list. That list only offers devices with the ADB interface, so a phone with USB debugging
  off looks exactly like a phone that isn't plugged in. The browser's unfiltered list does
  show it, and the descriptors the system read at plug-in — vendor id, interface classes —
  tell the cases apart without the device ever being opened. Tango's own matchFilters reads
  them the same way.
*/

/** The parts of a USBDevice read here: descriptors only, available without open(). */
export interface UsbDescription {
  readonly vendorId: number
  readonly productId: number
  readonly productName?: string | null
  readonly manufacturerName?: string | null
  readonly configurations: readonly {
    readonly interfaces: readonly {
      readonly alternates: readonly {
        readonly interfaceClass: number
        readonly interfaceSubclass: number
        readonly interfaceProtocol: number
      }[]
    }[]
  }[]
}

/** Google's ADB interface: vendor-specific class 0xff, subclass 0x42, protocol 1. */
export const ADB_INTERFACE = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x01 } as const
/** The same class and subclass with protocol 3 is fastboot: a phone sitting in its bootloader. */
const FASTBOOT_PROTOCOL = 0x03
const APPLE = 0x05ac

/**
 * USB vendor ids of Android phone and tablet makers, checked against usb.ids (2026-06-26) and
 * the android-udev-rules project's 51-android.rules. Ids that mostly appear on other hardware —
 * Intel, Dell, Foxconn, Microsoft, Razer, Sony's PlayStation id — are left out, so a dock or a
 * controller is never reported as a phone with USB debugging off. null marks a chipset maker's
 * id, which many brands' phones ship with, so the brand can't be named.
 */
const ANDROID_VENDORS: ReadonlyMap<number, string | null> = new Map<number, string | null>([
  [0x18d1, 'Google'],
  [0x04e8, 'Samsung'],
  [0x2717, 'Xiaomi'],
  [0x22d9, 'OPPO'],
  [0x2a70, 'OnePlus'],
  [0x2d95, 'vivo'],
  [0x12d1, 'Huawei'],
  [0x22b8, 'Motorola'],
  [0x0fce, 'Sony'],
  [0x1004, 'LG'],
  [0x0bb4, 'HTC'],
  [0x19d2, 'ZTE'],
  [0x0b05, 'ASUS'],
  [0x17ef, 'Lenovo'],
  [0x2006, 'Lenovo'],
  [0x2b4c, 'ZUK'],
  [0x1bbb, 'TCL'],
  [0x1ebf, 'Coolpad'],
  [0x2e04, 'Nokia'],
  [0x2ae5, 'Fairphone'],
  [0x2a45, 'Meizu'],
  [0x2e17, 'Essential'],
  [0x2b0e, 'LeEco'],
  [0x2916, 'Yota'],
  [0x2a96, 'Micromax'],
  [0x2a47, 'BQ'],
  [0x1949, 'Amazon'],
  [0x0955, 'NVIDIA'],
  [0x04dd, 'Sharp'],
  [0x0482, 'Kyocera'],
  [0x0fca, 'BlackBerry'],
  [0x0e8d, null], // MediaTek
  [0x05c6, null], // Qualcomm
  [0x1782, null], // Spreadtrum (Unisoc)
  [0x2207, null], // Rockchip
  [0x1f3a, null], // Allwinner
])

/**
 * The maker's name when the device comes from an Android maker (null: a chipset maker's id),
 * undefined for anyone else. Samsung's id is also on its drives and printers, and its phones
 * use product ids 0x66xx–0x68xx, so only those count.
 */
export function androidMaker(vendorId: number, productId: number): string | null | undefined {
  if (vendorId === 0x04e8 && (productId < 0x6600 || productId > 0x68ff)) return undefined
  return ANDROID_VENDORS.get(vendorId)
}

function hasInterface(device: UsbDescription, protocol: number): boolean {
  return device.configurations.some((configuration) =>
    configuration.interfaces.some((iface) =>
      iface.alternates.some(
        (alternate) =>
          alternate.interfaceClass === ADB_INTERFACE.classCode &&
          alternate.interfaceSubclass === ADB_INTERFACE.subclassCode &&
          alternate.interfaceProtocol === protocol,
      ),
    ),
  )
}

/** Whether the device offers ADB: USB debugging is on and Add device would list it. */
export function hasAdbInterface(device: UsbDescription): boolean {
  return hasInterface(device, ADB_INTERFACE.protocolCode)
}

/** The product name as the device reports it; Samsung's reads SAMSUNG_Android. */
function productName(device: UsbDescription): string {
  return (device.productName ?? '').replace(/_/g, ' ').trim()
}

/** What one device the tester picked in "Find my phone…" says about their phone. */
export function diagnosePicked(device: UsbDescription): UsbFinding {
  const name = productName(device)
  if (hasAdbInterface(device)) return { kind: 'adb', name: name || 'Your phone' }
  const maker = androidMaker(device.vendorId, device.productId)
  const fallback = maker ? `Your ${maker} phone` : 'Your phone'
  // Only Android's bootloader speaks fastboot, whoever made the phone.
  if (hasInterface(device, FASTBOOT_PROTOCOL)) return { kind: 'bootloader', name: name || fallback }
  if (maker !== undefined) return { kind: 'debugging-off', name: name || fallback }
  return {
    kind: 'not-android',
    name: name || (device.manufacturerName ?? '').trim() || 'That device',
    sure: device.vendorId === APPLE,
  }
}

/**
 * What the devices this browser was already allowed to use say (navigator.usb.getDevices()).
 * A phone allowed while USB debugging was on stays allowed when it is turned off — on phones
 * that keep their product id, like Samsung's — and then shows up here without the interface.
 * Devices that are not phones were picked at some earlier time and are not worth a word now.
 */
export function diagnoseGranted(devices: readonly UsbDescription[]): UsbFinding {
  let phone: UsbFinding | null = null
  for (const device of devices) {
    const finding = diagnosePicked(device)
    if (finding.kind === 'adb') return finding
    if (!phone && (finding.kind === 'debugging-off' || finding.kind === 'bootloader')) {
      phone = finding
    }
  }
  return phone ?? { kind: 'unknown' }
}

/** The part of navigator.usb "Find my phone…" needs, so tests can pass a fake. */
export interface UsbChooser {
  requestDevice(options: { filters: USBDeviceFilter[] }): Promise<UsbDescription>
}

export interface UsbGranted {
  getDevices(): Promise<readonly UsbDescription[]>
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

/**
 * "Find my phone…": the browser's list of EVERY USB device, with the pick described rather
 * than opened. USER GESTURE ONLY — requestDevice needs transient activation, so call this
 * straight from the click handler. Picking grants the device to this page, as Add device does:
 * a phone found with the ADB interface is then the WebUSB lane's to connect on its next sync.
 */
export async function findMyPhone(usb: UsbChooser): Promise<UsbFinding> {
  try {
    return diagnosePicked(await usb.requestDevice({ filters: [] }))
  } catch (error) {
    // Closing the chooser — or a chooser with nothing in it — rejects with NotFoundError.
    if (isNamed(error, 'NotFoundError')) return { kind: 'not-listed' }
    throw error
  }
}

/** The granted devices' finding; never prompts, so it can run whenever the Gate is shown. */
export async function scanGranted(usb: UsbGranted): Promise<UsbFinding> {
  return diagnoseGranted(await usb.getDevices())
}
