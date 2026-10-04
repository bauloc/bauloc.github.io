import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { UsbFinding } from './types'
import {
  androidMaker,
  diagnoseGranted,
  diagnosePicked,
  findMyPhone,
  hasAdbInterface,
  scanGranted,
  type UsbChooser,
  type UsbDescription,
  type UsbGranted,
} from './usb-diagnose'

/*
  Devices as the browser describes them before anything is opened: vendor and product ids,
  names, and the interface classes of every configuration. The ids are the real ones (usb.ids):
  a Pixel with and without debugging, in fastboot, a Galaxy, an iPhone, a Samsung drive.
*/

const iface = (interfaceClass: number, interfaceSubclass: number, interfaceProtocol: number) => ({
  alternates: [{ interfaceClass, interfaceSubclass, interfaceProtocol }],
})
const MTP = iface(0x06, 0x01, 0x01)
const ADB = iface(0xff, 0x42, 0x01)
const FASTBOOT = iface(0xff, 0x42, 0x03)
const USBMUX = iface(0xff, 0xfe, 0x02)
const MASS_STORAGE = iface(0x08, 0x06, 0x50)

function device(
  vendorId: number,
  productId: number,
  productName: string | null,
  interfaces: ReturnType<typeof iface>[],
  manufacturerName: string | null = null,
): UsbDescription {
  return { vendorId, productId, productName, manufacturerName, configurations: [{ interfaces }] }
}

const PIXEL_DEBUG = device(0x18d1, 0x4ee2, 'Pixel 9', [MTP, ADB], 'Google')
const PIXEL_MTP = device(0x18d1, 0x4ee1, 'Pixel 9', [MTP], 'Google')
const PIXEL_FASTBOOT = device(0x18d1, 0x4ee0, 'Android', [FASTBOOT], 'Google')
const GALAXY_MTP = device(0x04e8, 0x6860, 'SAMSUNG_Android', [MTP], 'SAMSUNG')
const GALAXY_DEBUG = device(0x04e8, 0x6860, 'SAMSUNG_Android', [MTP, ADB], 'SAMSUNG')
const IPHONE = device(0x05ac, 0x12a8, 'iPhone', [MTP, USBMUX], 'Apple Inc.')
const SAMSUNG_SSD = device(0x04e8, 0x61f5, 'Portable SSD T5', [MASS_STORAGE], 'Samsung')

describe('hasAdbInterface', () => {
  it('finds the ADB interface in any configuration or alternate setting', () => {
    expect(hasAdbInterface(PIXEL_DEBUG)).toBe(true)
    expect(hasAdbInterface(PIXEL_MTP)).toBe(false)
    expect(hasAdbInterface(PIXEL_FASTBOOT)).toBe(false)
    const tucked: UsbDescription = {
      vendorId: 0x18d1,
      productId: 0x4ee7,
      configurations: [
        { interfaces: [MTP] },
        {
          interfaces: [
            {
              alternates: [
                { interfaceClass: 0x0a, interfaceSubclass: 0, interfaceProtocol: 0 },
                { interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x01 },
              ],
            },
          ],
        },
      ],
    }
    expect(hasAdbInterface(tucked)).toBe(true)
    expect(hasAdbInterface({ vendorId: 1, productId: 1, configurations: [] })).toBe(false)
  })
})

describe('androidMaker', () => {
  it.each<[string, number, number, string | null | undefined]>([
    ['Google', 0x18d1, 0x4ee1, 'Google'],
    ['Samsung phone', 0x04e8, 0x6860, 'Samsung'],
    ['Samsung drive', 0x04e8, 0x61f5, undefined],
    ['Samsung printer', 0x04e8, 0x3441, undefined],
    ['Xiaomi', 0x2717, 0xff48, 'Xiaomi'],
    ['OnePlus', 0x2a70, 0x4ee7, 'OnePlus'],
    ['MediaTek, brand unknown', 0x0e8d, 0x2008, null],
    ['Apple', 0x05ac, 0x12a8, undefined],
    ['Intel (Bluetooth inside laptops)', 0x8087, 0x0033, undefined],
  ])('%s', (_, vendorId, productId, expected) => {
    expect(androidMaker(vendorId, productId)).toBe(expected)
  })
})

describe('diagnosePicked', () => {
  it.each<[string, UsbDescription, UsbFinding]>([
    ['Pixel with USB debugging on', PIXEL_DEBUG, { kind: 'adb', name: 'Pixel 9' }],
    ['Pixel with USB debugging off', PIXEL_MTP, { kind: 'debugging-off', name: 'Pixel 9' }],
    [
      'Pixel without a product name',
      device(0x18d1, 0x4ee1, null, [MTP]),
      { kind: 'debugging-off', name: 'Your Google phone' },
    ],
    [
      'Galaxy with USB debugging off',
      GALAXY_MTP,
      { kind: 'debugging-off', name: 'SAMSUNG Android' },
    ],
    [
      'Galaxy charging only (no interfaces at all)',
      device(0x04e8, 0x6860, null, []),
      { kind: 'debugging-off', name: 'Your Samsung phone' },
    ],
    [
      'a MediaTek phone without a name',
      device(0x0e8d, 0x2008, '  ', [MTP]),
      { kind: 'debugging-off', name: 'Your phone' },
    ],
    ['Pixel in fastboot', PIXEL_FASTBOOT, { kind: 'bootloader', name: 'Android' }],
    [
      'an unknown maker’s phone in fastboot',
      device(0x1234, 0x0001, null, [FASTBOOT]),
      { kind: 'bootloader', name: 'Your phone' },
    ],
    ['iPhone', IPHONE, { kind: 'not-android', name: 'iPhone', sure: true }],
    ['Samsung drive', SAMSUNG_SSD, { kind: 'not-android', name: 'Portable SSD T5', sure: false }],
    [
      'an unknown device with only a maker name',
      device(0x1234, 0x5678, null, [MTP], 'Acme'),
      { kind: 'not-android', name: 'Acme', sure: false },
    ],
    [
      'an unknown device with no names',
      device(0x1234, 0x5678, null, [MTP]),
      { kind: 'not-android', name: 'That device', sure: false },
    ],
    [
      'an unknown maker’s device that has ADB',
      device(0x1234, 0x5678, 'Tablet', [ADB]),
      { kind: 'adb', name: 'Tablet' },
    ],
  ])('%s', (_, picked, expected) => {
    expect(diagnosePicked(picked)).toEqual(expected)
  })
})

describe('diagnoseGranted', () => {
  it.each<[string, UsbDescription[], UsbFinding]>([
    ['nothing granted', [], { kind: 'unknown' }],
    ['only devices that are not phones', [IPHONE, SAMSUNG_SSD], { kind: 'unknown' }],
    [
      'a phone whose debugging was turned off',
      [IPHONE, GALAXY_MTP],
      { kind: 'debugging-off', name: 'SAMSUNG Android' },
    ],
    ['a phone in fastboot', [PIXEL_FASTBOOT], { kind: 'bootloader', name: 'Android' }],
    [
      'debugging on wins over another phone’s debugging off',
      [PIXEL_MTP, GALAXY_DEBUG],
      { kind: 'adb', name: 'SAMSUNG Android' },
    ],
    [
      'the first phone with debugging off',
      [PIXEL_MTP, GALAXY_MTP],
      { kind: 'debugging-off', name: 'Pixel 9' },
    ],
  ])('%s', (_, granted, expected) => {
    expect(diagnoseGranted(granted)).toEqual(expected)
  })
})

describe('findMyPhone', () => {
  it('asks for every USB device and describes the pick', async () => {
    const requestDevice = vi.fn<UsbChooser['requestDevice']>(() => Promise.resolve(PIXEL_MTP))
    await expect(findMyPhone({ requestDevice })).resolves.toEqual({
      kind: 'debugging-off',
      name: 'Pixel 9',
    })
    expect(requestDevice).toHaveBeenCalledWith({ filters: [] })
  })

  it('reads a closed or empty chooser as "not listed"', async () => {
    const dismissed = new DOMException('No device selected.', 'NotFoundError')
    await expect(findMyPhone({ requestDevice: () => Promise.reject(dismissed) })).resolves.toEqual({
      kind: 'not-listed',
    })
    // node-usb throws an ordinary Error with that name, not a DOMException.
    const plain = Object.assign(new Error('No device selected.'), { name: 'NotFoundError' })
    await expect(findMyPhone({ requestDevice: () => Promise.reject(plain) })).resolves.toEqual({
      kind: 'not-listed',
    })
  })

  it('lets any other failure through, for the page to report', async () => {
    const blocked = new DOMException('Access to the feature "usb" is disallowed.', 'SecurityError')
    await expect(findMyPhone({ requestDevice: () => Promise.reject(blocked) })).rejects.toBe(
      blocked,
    )
  })
})

describe('scanGranted', () => {
  it('describes what the browser already allows', async () => {
    const usb: UsbGranted = { getDevices: () => Promise.resolve([IPHONE, GALAXY_MTP]) }
    await expect(scanGranted(usb)).resolves.toEqual({
      kind: 'debugging-off',
      name: 'SAMSUNG Android',
    })
  })

  it('takes navigator.usb itself', () => {
    expectTypeOf<USB>().toExtend<UsbChooser>()
    expectTypeOf<USB>().toExtend<UsbGranted>()
    expectTypeOf<USBDevice>().toExtend<UsbDescription>()
  })
})
