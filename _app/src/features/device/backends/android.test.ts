import { describe, expect, it } from 'vitest'

import { androidDetail, extractPng } from './android'
import { DETAIL_FIXTURES } from './fixtures'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
/** A stand-in PNG: signature, some chunk bytes, IEND. */
const png = Uint8Array.from([...SIGNATURE, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, ...IEND])
const text = (s: string) => new TextEncoder().encode(s)
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

describe('extractPng', () => {
  it('passes a clean screenshot through unchanged', () => {
    expect(extractPng(png)).toEqual(png)
  })

  it('finds the image behind the warning screencap prints on phones with two displays', () => {
    const warning = text(
      '[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found, however this default is not guaranteed to be consistent across captures. A display id should be specified.\n',
    )
    expect(extractPng(join(warning, png))).toEqual(png)
  })

  it('drops anything that follows the image', () => {
    expect(extractPng(join(png, text('\nWARNING: linker: something\n')))).toEqual(png)
  })

  it('keeps the whole image when its pixel data holds the IEND chunk’s own bytes', () => {
    // Compressed pixels may hold any bytes: only the LAST IEND chunk ends the image.
    const idat = [0, 0, 0, 14, 0x49, 0x44, 0x41, 0x54, 7, ...IEND, 9, 1, 2, 3, 4]
    const shot = Uint8Array.from([...SIGNATURE, ...idat, ...IEND])
    expect(extractPng(join(shot, text('\nWARNING: linker: something\n')))).toEqual(shot)
  })

  it('refuses an image cut short, and output that holds no image at all', () => {
    expect(extractPng(png.slice(0, png.length - 5))).toBeNull()
    expect(extractPng(text('/system/bin/sh: screencap: not found\n'))).toBeNull()
    expect(extractPng(new Uint8Array())).toBeNull()
  })
})

describe('androidDetail', () => {
  const { outputs, serial } = DETAIL_FIXTURES['pixel-9']!

  it('names the lane that read the outputs, and only that changes', () => {
    const webusb = androidDetail(outputs, serial)
    expect(webusb.status.Connection).toBe('USB (WebUSB)')
    const helper = androidDetail(outputs, serial, 'Wi‑Fi (adb server)')
    expect(helper).toEqual({
      ...webusb,
      status: { ...webusb.status, Connection: 'Wi‑Fi (adb server)' },
    })
  })
})
