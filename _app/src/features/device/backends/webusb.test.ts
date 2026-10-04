import { describe, expect, it } from 'vitest'

import { classifyUsbError, classifyUsbErrorFor, parseSdk } from './webusb'

/*
  The connect-time pieces of the WebUSB lane that need no USB: the OS-aware error reading and
  the API level. classifyUsbError's legacy answers are held by parity.test.ts.
*/

const error = (name: string, message: string) => Object.assign(new Error(message), { name })

describe('classifyUsbErrorFor', () => {
  const denied = error('SecurityError', "Failed to execute 'open' on 'USBDevice': Access denied.")

  it('reads a refused open() on Linux and Windows as the system’s doing', () => {
    expect(classifyUsbErrorFor(denied, 'linux')).toEqual({
      state: 'held',
      blockers: ['USB_ACCESS_DENIED'],
    })
    expect(classifyUsbErrorFor(denied, 'windows')).toEqual({
      state: 'held',
      blockers: ['USB_ACCESS_DENIED'],
    })
  })

  it('keeps the legacy answer elsewhere, and for every other error', () => {
    expect(classifyUsbErrorFor(denied, 'mac')).toEqual(classifyUsbError(denied))
    const busy = error('NetworkError', 'Unable to claim interface.')
    expect(classifyUsbErrorFor(busy, 'linux')).toEqual({
      state: 'held',
      blockers: ['ADB_SERVER_HOLDING'],
    })
    // On Windows this is adb or a maker's driver; the checklist's row names both (checks.ts).
    expect(classifyUsbErrorFor(busy, 'windows')).toEqual({
      state: 'held',
      blockers: ['ADB_SERVER_HOLDING'],
    })
    const gone = error('NetworkError', 'A transfer error has occurred.')
    expect(classifyUsbErrorFor(gone, 'windows')).toEqual(classifyUsbError(gone))
  })
})

describe('parseSdk', () => {
  it('reads ro.build.version.sdk, and nothing that isn’t one', () => {
    expect(parseSdk('37')).toBe(37)
    expect(parseSdk(' 24\n')).toBe(24)
    expect(parseSdk('')).toBeNull()
    expect(parseSdk('0')).toBeNull()
    expect(parseSdk('Baklava')).toBeNull()
  })
})
