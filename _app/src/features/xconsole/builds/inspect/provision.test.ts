import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseProvision } from './provision'

/*
  Provisioning profiles, synthetic only: adhoc.mobileprovision is a plist written by hand
  between envelope-shaped bytes and junk (__fixtures__/make-fixtures.sh), and the other kinds
  are made here the same way. A real profile lists real devices' UDIDs and holds certificates,
  so none is ever committed.
*/

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))
const utf8 = (text: string) => new TextEncoder().encode(text)

/** Bytes that are not UTF-8, around the plist, as a CMS envelope's are. */
const JUNK_BEFORE = Uint8Array.from([0x30, 0x82, 0x1f, 0x3c, 0x06, 0x09, 0x2a, 0x86, 0xff, 0x00])
const JUNK_AFTER = Uint8Array.from([0xa0, 0x82, 0x0f, 0xfe, 0x3c, 0x00, 0x80, 0x81])

const envelope = (plist: string) => Uint8Array.from([...JUNK_BEFORE, ...utf8(plist), ...JUNK_AFTER])

interface Spec {
  devices?: number
  allDevices?: boolean
  getTaskAllow?: boolean
  expires?: string
}

/** A profile's plist with just the keys parseProvision reads, the way Apple's are laid out. */
function profile(spec: Spec): string {
  const udid = '<string>00000000-0000000000000000</string>'
  const devices =
    spec.devices === undefined
      ? ''
      : `<key>ProvisionedDevices</key><array>${udid.repeat(spec.devices)}</array>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Entitlements</key>
	<dict>
		<key>get-task-allow</key>
		${spec.getTaskAllow ? '<true/>' : '<false/>'}
	</dict>
	${spec.expires === undefined ? '' : `<key>ExpirationDate</key><date>${spec.expires}</date>`}
	<key>Name</key>
	<string>Probe Profile</string>
	${devices}
	${spec.allDevices ? '<key>ProvisionsAllDevices</key><true/>' : ''}
	<key>TeamName</key>
	<string>Probe Team</string>
</dict>
</plist>`
}

describe('parseProvision', () => {
  it('reads the plist out of its envelope', () => {
    expect(parseProvision(fixture('adhoc.mobileprovision'))).toEqual({
      kind: 'ad-hoc',
      name: 'Probe Ad Hoc',
      team: 'Probe Team & Co.',
      expires: '2027-09-01T10:00:00Z',
      device_count: 3,
    })
  })

  it('tells the four kinds apart', () => {
    const expires = '2027-01-02T03:04:05Z'
    const read = (spec: Spec) => parseProvision(envelope(profile({ expires, ...spec })))
    expect(read({ devices: 2, getTaskAllow: true })).toMatchObject({
      kind: 'development',
      device_count: 2,
    })
    expect(read({ devices: 5, getTaskAllow: false })).toMatchObject({
      kind: 'ad-hoc',
      device_count: 5,
    })
    expect(read({ allDevices: true })).toEqual({
      kind: 'enterprise',
      name: 'Probe Profile',
      team: 'Probe Team',
      expires,
      device_count: null,
    })
    expect(read({})).toMatchObject({ kind: 'app-store', device_count: null })
    // An empty list is still a list: no device can install it, but it is not for the App Store.
    expect(read({ devices: 0 })).toMatchObject({ kind: 'ad-hoc', device_count: 0 })
  })

  it('leaves out what the profile does not say', () => {
    expect(parseProvision(envelope(profile({ devices: 1 })))).toMatchObject({ expires: '' })
    const bare = '<?xml version="1.0"?><plist><dict/></plist>'
    expect(parseProvision(utf8(bare))).toEqual({
      kind: 'app-store',
      name: '',
      team: '',
      expires: '',
      device_count: null,
    })
  })

  it('stops at the first end of a plist, whatever follows', () => {
    const tail = utf8('<?xml junk </plist> more')
    const bytes = Uint8Array.from([...envelope(profile({ devices: 1 })), ...tail])
    expect(parseProvision(bytes)).toMatchObject({ kind: 'ad-hoc', device_count: 1 })
  })

  it('answers null when there is no plist to read', () => {
    const plist = profile({ devices: 1 })
    for (const bytes of [
      new Uint8Array(0),
      JUNK_BEFORE,
      envelope(plist.replace('<?xml', '<?XML')),
      envelope(plist.replace('</plist>', '')),
      envelope(plist.replace('<dict>', '<dict><dict>')),
      envelope('<?xml version="1.0"?><plist><array/></plist>'),
    ]) {
      expect(parseProvision(bytes)).toBeNull()
    }
  })
})
