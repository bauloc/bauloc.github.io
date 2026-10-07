import type { ProfileInfo, ProfileKind } from '../types'
import {
  asDict,
  dictArray,
  dictBoolean,
  dictDict,
  dictString,
  parsePlist,
  type PlistDict,
  type PlistValue,
} from './plist'

/*
  embedded.mobileprovision: the provisioning profile an IPA is signed with, which decides who
  can install it. The file is a CMS (PKCS #7) envelope signed by Apple around an XML plist,
  and the plist sits in it whole, so it is found by its first and last bytes instead of by
  reading the envelope. The signature is not checked: iOS checks it when the app is
  installed, and nothing here trusts the profile for more than what to tell a tester.

  How the profile says what it is for:

    ProvisionsAllDevices = true             enterprise    any device, once its team is trusted
    ProvisionedDevices + get-task-allow     development   the devices listed, in Developer Mode
    ProvisionedDevices, no get-task-allow   ad-hoc        the devices listed
    neither                                 app-store     none: only the App Store and TestFlight
*/

const bytesOf = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0))
const START = bytesOf('<?xml')
const END = bytesOf('</plist>')

/** Where `needle` first occurs in `haystack` from `from` on, or -1. */
function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]
  const last = haystack.length - needle.length
  for (let at = haystack.indexOf(first ?? 0, from); at >= 0 && at <= last;) {
    if (needle.every((byte, i) => haystack[at + i] === byte)) return at
    at = haystack.indexOf(first ?? 0, at + 1)
  }
  return -1
}

/** A date as the plist reader writes one; anything else (a hand-edited string) is unknown. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function kindOf(profile: PlistDict, devices: readonly PlistValue[] | null): ProfileKind {
  if (dictBoolean(profile, 'ProvisionsAllDevices') === true) return 'enterprise'
  if (!devices) return 'app-store'
  const debuggable = dictBoolean(dictDict(profile, 'Entitlements'), 'get-task-allow') === true
  return debuggable ? 'development' : 'ad-hoc'
}

/**
 * What a provisioning profile allows, from the file's bytes; null when no plist can be found
 * in them or it cannot be read.
 */
export function parseProvision(bytes: Uint8Array): ProfileInfo | null {
  const start = indexOf(bytes, START, 0)
  if (start < 0) return null
  const end = indexOf(bytes, END, start)
  if (end < 0) return null
  let profile: PlistDict | null
  try {
    profile = asDict(parsePlist(bytes.subarray(start, end + END.length)))
  } catch {
    return null
  }
  if (!profile) return null

  const devices = dictArray(profile, 'ProvisionedDevices')
  const kind = kindOf(profile, devices)
  const expires = dictString(profile, 'ExpirationDate') ?? ''
  return {
    kind,
    name: dictString(profile, 'Name') ?? '',
    team: dictString(profile, 'TeamName') ?? '',
    expires: ISO_DATE.test(expires) ? expires : '',
    device_count: kind === 'enterprise' || !devices ? null : devices.length,
  }
}
