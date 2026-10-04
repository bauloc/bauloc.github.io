/*
  The iOS lane's pure parts: the plist codec, both frame codecs, syslog_relay framing, the
  devicectl classifier, the whitelists, the first-launch wrapper check and deriveIos().
*/
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EMITTED_BLOCKERS, LIMITS } from '../src/constants'
import {
  NO_IOS_TOOLS,
  classifyDevicectl,
  deriveIos,
  isFirstLaunchWrapper,
  splitSyslogRelay,
  whitelistDevice,
  type IosEntry,
  type IosTools,
} from '../src/ios-lane'
import { assertLockdownRequest, createLockdownReader, encodeLockdownFrame } from '../src/lockdown'
import { buildPlist, parsePlist } from '../src/plist'
import {
  assertMuxMessage,
  createMuxReader,
  encodeMuxFrame,
  htons,
  toPairRecord,
  type MuxFrame,
} from '../src/usbmuxd'
import { tempDir } from './harness'
import { BIG_ECID, plaintextKeys, sessionKeys } from './fakes/lockdownd'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown

describe('plist', () => {
  it('round-trips every type, BigInt beyond 2^53 included', () => {
    const value = {
      text: 'Ngọc’s <iPhone> & "co"',
      small: 42,
      negative: -7,
      big: BIG_ECID,
      real: 1.5,
      yes: true,
      no: false,
      data: Buffer.from([0, 1, 2, 255]),
      list: [1, 'two', [3], {}],
      nested: { empty: [], deeper: { k: 'v' } },
    }
    const parsed = parsePlist(buildPlist(value))
    expect(parsed).toEqual(value)
    expect(typeof (parsed as { big: unknown }).big).toBe('bigint')
  })
  it('reads dates as ISO strings and self-closing tags as empty values', () => {
    const xml = buildPlist({ when: new Date('2026-10-04T08:19:52.123Z') })
    expect(parsePlist(xml)).toEqual({ when: '2026-10-04T08:19:52Z' })
    expect(
      parsePlist(
        '<plist><dict><key>a</key><string/><key>b</key><data/><key>c</key><dict/></dict></plist>',
      ),
    ).toEqual({ a: '', b: Buffer.alloc(0), c: {} })
  })
  it('refuses integers it cannot read instead of guessing', () => {
    expect(() => parsePlist('<plist><integer>12abc</integer></plist>')).toThrow(/malformed/)
  })
})

describe('usbmuxd frames', () => {
  it('writes the 16-byte little-endian header with the total length', () => {
    const frame = encodeMuxFrame({ MessageType: 'ListDevices' }, 7)
    expect(frame.readUInt32LE(0)).toBe(frame.length)
    expect(frame.readUInt32LE(4)).toBe(1)
    expect(frame.readUInt32LE(8)).toBe(8)
    expect(frame.readUInt32LE(12)).toBe(7)
    expect(parsePlist(frame.subarray(16).toString())).toEqual({ MessageType: 'ListDevices' })
  })
  it('reads frames split anywhere and keeps what follows', () => {
    const frames: MuxFrame[] = []
    const reader = createMuxReader((frame) => frames.push(frame))
    const bytes = Buffer.concat([
      encodeMuxFrame({ Number: 0 }, 1),
      encodeMuxFrame({ Number: 1 }, 2),
      Buffer.from('raw'),
    ])
    for (let i = 0; i < bytes.length; i += 5) reader.push(bytes.subarray(i, i + 5))
    expect(frames.map((f) => [f.tag, f.body.Number])).toEqual([
      [1, 0],
      [2, 1],
    ])
    expect(reader.rest().toString()).toBe('raw')
  })
  it('refuses a frame over the 4 MiB cap or under its own header', () => {
    const header = Buffer.alloc(16)
    header.writeUInt32LE(LIMITS.frame + 1, 0)
    expect(() => createMuxReader(() => undefined).push(header)).toThrow(/frame/)
    header.writeUInt32LE(4, 0)
    expect(() => createMuxReader(() => undefined).push(header)).toThrow(/frame/)
  })
  it('sends the port in network byte order (62078 → 32498)', () => {
    expect(htons(62078)).toBe(32498)
    expect(htons(htons(49321))).toBe(49321)
  })
  it('never sends a message outside MUX_MESSAGES', () => {
    for (const type of ['SavePairRecord', 'DeletePairRecord', 'Pair']) {
      expect(() => assertMuxMessage(type)).toThrow(/never sends/)
    }
    expect(() => assertMuxMessage('ListDevices')).not.toThrow()
  })
  it('keeps only the pair-record fields the helper uses', () => {
    const data = Buffer.from(
      buildPlist({
        HostID: 'H',
        SystemBUID: 'S',
        HostCertificate: Buffer.from('hc'),
        HostPrivateKey: Buffer.from('hk'),
        DeviceCertificate: Buffer.from('dc'),
        RootCertificate: Buffer.from('rc'),
        RootPrivateKey: Buffer.from('secret'),
        EscrowBag: Buffer.from('bag'),
        WiFiMACAddress: 'aa:bb',
      }),
    )
    const record = toPairRecord(data)
    expect(Object.keys(record).sort()).toEqual([
      'DeviceCertificate',
      'HostCertificate',
      'HostID',
      'HostPrivateKey',
      'RootCertificate',
      'SystemBUID',
    ])
    expect(() => toPairRecord(Buffer.from('bplist00…'))).toThrow(/binary/)
    expect(() => toPairRecord(Buffer.from(buildPlist({ HostID: 'H' })))).toThrow(/missing/)
  })
})

describe('lockdown frames and allowlist', () => {
  it('uses a u32 big-endian length without the header', () => {
    const frame = encodeLockdownFrame({ Request: 'QueryType' })
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    const seen: unknown[] = []
    const reader = createLockdownReader((body) => seen.push(body.Request))
    reader.push(frame.subarray(0, 3))
    reader.push(Buffer.concat([frame.subarray(3), frame]))
    expect(seen).toEqual(['QueryType', 'QueryType'])
  })
  it('refuses Pair, SetValue and every other request outside LOCKDOWN_REQUESTS', () => {
    for (const request of [
      'Pair',
      'Unpair',
      'ValidatePair',
      'SetValue',
      'RemoveValue',
      'EnterRecovery',
      'Activate',
    ]) {
      expect(() => assertLockdownRequest({ Request: request })).toThrow(/never sends/)
    }
    expect(() =>
      assertLockdownRequest({ Request: 'StartService', Service: 'com.apple.mobile.screenshotr' }),
    ).toThrow(/never starts/)
    expect(() =>
      assertLockdownRequest({ Request: 'StartService', Service: 'com.apple.syslog_relay' }),
    ).not.toThrow()
  })
})

describe('splitSyslogRelay', () => {
  const nul = (text: string): Buffer => Buffer.from(text + '\0')
  it('splits on NUL, drops the trailing newline and splits inner newlines', () => {
    const { lines, carry } = splitSyslogRelay(
      Buffer.concat([
        nul('Oct  4 08:19:52 a locationd[1] <Notice>: one\n'),
        nul('two\nthree\n'),
        Buffer.from('par'),
      ]),
      Buffer.alloc(0),
    )
    expect(lines).toEqual(['Oct  4 08:19:52 a locationd[1] <Notice>: one', 'two', 'three'])
    expect(carry.toString()).toBe('par')
    expect(splitSyslogRelay(nul('tial\n'), carry).lines).toEqual(['partial'])
  })
  it('keeps UTF-8 intact across chunks and strips escapes and control characters', () => {
    const bytes = nul('Ngọc’s \x1b[31mred\x1b[0m\x07 tab\there\n')
    const cut = bytes.indexOf(Buffer.from('ầ')) + 1
    const first = splitSyslogRelay(bytes.subarray(0, cut), Buffer.alloc(0))
    const second = splitSyslogRelay(bytes.subarray(cut), first.carry)
    expect(first.lines).toEqual([])
    expect(second.lines).toEqual(['Ngọc’s red tab\there'])
  })
  it('caps a line at 8 KiB and a message without NUL at four times that', () => {
    const long = 'x'.repeat(LIMITS.line + 10)
    expect(splitSyslogRelay(nul(long), Buffer.alloc(0)).lines).toEqual([
      'x'.repeat(LIMITS.line) + ' [truncated]',
    ])
    const runaway = splitSyslogRelay(Buffer.alloc(LIMITS.line * 4 + 1, 0x61), Buffer.alloc(0))
    expect(runaway.carry.length).toBe(0)
    expect(runaway.lines).toHaveLength(1)
    expect(runaway.lines[0]?.endsWith(' [truncated]')).toBe(true)
  })
})

describe('classifyDevicectl', () => {
  const env = (outcome: string, error?: Record<string, unknown>): unknown => ({
    info: { outcome, jsonVersion: 5 },
    ...(error ? { error } : {}),
  })
  const described = (code: number, text: string): Record<string, unknown> => ({
    code,
    domain: 'com.apple.dt.CoreDeviceError',
    userInfo: { NSLocalizedDescription: { string: text } },
  })
  it('reads the real envelopes captured on this Mac', () => {
    expect(classifyDevicectl(fixture('ios-devicectl-success.json'), 0)).toBeNull()
    expect(classifyDevicectl(fixture('ios-devicectl-4016.json'), 1)?.code).toBe('IOS_UNREACHABLE')
    expect(classifyDevicectl(fixture('ios-devicectl-1001.json'), 1)?.code).toBe(
      'SCREENSHOT_UNSUPPORTED',
    )
    expect(classifyDevicectl(fixture('ios-devicectl-1000.json'), 1)?.code).toBe('DEVICE_NOT_FOUND')
    expect(classifyDevicectl(fixture('ios-devicectl-timeout.json'), 1)?.code).toBe('TOOL_TIMEOUT')
  })
  it('maps every row of the §3.7 table', () => {
    const cases: Array<[unknown, number | null, string, number]> = [
      [null, 72, 'XCODE_REQUIRED', 503],
      [null, 64, 'XCODE_REQUIRED', 503],
      [env('timeout'), 1, 'TOOL_TIMEOUT', 504],
      [null, 2, 'TOOL_TIMEOUT', 504],
      [
        env('failed', described(1000, 'The specified device was not found.')),
        1,
        'DEVICE_NOT_FOUND',
        404,
      ],
      [env('failed', described(1001, 'Not supported.')), 1, 'SCREENSHOT_UNSUPPORTED', 501],
      [
        env('failed', described(3, 'The operation failed since the device is locked.')),
        1,
        'IOS_LOCKED',
        409,
      ],
      [
        env('failed', described(3, 'Developer Mode is turned off.')),
        1,
        'IOS_DEVELOPER_MODE_OFF',
        409,
      ],
      [env('failed', described(4016, 'Not able to fulfill.')), 1, 'IOS_UNREACHABLE', 502],
      [env('failed', described(9, 'Something else.')), 1, 'TOOL_FAILED', 502],
      [null, 1, 'TOOL_FAILED', 502],
      [env('success'), 1, 'TOOL_FAILED', 502],
    ]
    for (const [envelope, exit, code, status] of cases) {
      const error = classifyDevicectl(envelope, exit)
      expect([error?.code, error?.status]).toEqual([code, status])
    }
    expect(classifyDevicectl(env('failed', described(9, 'Something else.')), 1)?.message).toBe(
      'Something else.',
    )
  })
})

describe('whitelists', () => {
  it('keeps only the pre-session keys, whatever the phone sends', () => {
    const kept = whitelistDevice(parsePlist(buildPlist(plaintextKeys())), 'plaintext')
    expect(Object.keys(kept).sort()).toEqual([
      'BuildVersion',
      'CPUArchitecture',
      'DeviceClass',
      'DeviceName',
      'HardwareModel',
      'ProductType',
      'ProductVersion',
    ])
  })
  it('keeps the session keys, UniqueChipID as an exact decimal string, and nothing personal', () => {
    const kept = whitelistDevice(parsePlist(buildPlist(sessionKeys())), 'session')
    expect(kept.UniqueChipID).toBe(BIG_ECID.toString())
    const json = JSON.stringify(kept)
    for (const secret of [
      'InternationalMobileEquipmentIdentity',
      '350000000000000',
      'PhoneNumber',
      '+84 90',
      'WiFiAddress',
      'aa:bb:cc',
      'DieID',
      'BasebandSerialNumber',
      'IntegratedCircuitCardIdentity',
      'UniqueDeviceID',
    ]) {
      expect(json).not.toContain(secret)
    }
  })
})

describe('isFirstLaunchWrapper', () => {
  it('spots the zsh wrapper and passes a real binary or a plain script', () => {
    const dir = tempDir()
    const wrapper = path.join(dir, 'wrapper')
    writeFileSync(
      wrapper,
      '#!/bin/zsh\nEXPECTED_VERSION="642.16"\nxcodebuild -runFirstLaunch\nexec "/real/devicectl" "$@"\n',
    )
    const binary = path.join(dir, 'binary')
    writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))
    const script = path.join(dir, 'script')
    writeFileSync(script, '#!/bin/sh\necho hi\n')
    for (const file of [wrapper, binary, script]) chmodSync(file, 0o755)
    expect(isFirstLaunchWrapper(wrapper)).toBe(true)
    expect(isFirstLaunchWrapper(binary)).toBe(false)
    expect(isFirstLaunchWrapper(script)).toBe(false)
    expect(isFirstLaunchWrapper(path.join(dir, 'missing'))).toBe(true)
  })
})

describe('deriveIos (§3.10)', () => {
  const entry = (patch: Partial<IosEntry> = {}): IosEntry => ({
    udid: '00008101-000A1B2C3D4E5F02',
    connection: 'usb',
    probing: false,
    status: 'ready',
    reason: '',
    source: 'lockdown',
    device: {
      DeviceName: 'Ngọc’s iPhone 12 Pro',
      ProductType: 'iPhone13,3',
      ProductVersion: '27.0',
    },
    developerMode: true,
    locked: false,
    ddiRequired: false,
    devicectlUnsupported: false,
    ...patch,
  })
  const ready: IosTools = { xcode: 'ready', idevicescreenshot: false, idevicesyslog: false }
  const caps = (row: ReturnType<typeof deriveIos>): string =>
    ['screenshot', 'identifiers', 'logs']
      .map((k) => (row.capabilities[k as 'logs'] ? 'yes' : 'no'))
      .join('/')

  it('rows 1–7: every state that is not ready', () => {
    const cases: Array<[Partial<IosEntry>, string, string[]]> = [
      [{ status: null, probing: true, device: {} }, 'connecting', []],
      [{ status: 'untrusted', reason: 'pair-record:none' }, 'untrusted', ['IOS_UNTRUSTED']],
      [{ status: 'untrusted', reason: 'InvalidHostID' }, 'untrusted', ['IOS_UNTRUSTED']],
      [{ status: 'authorizing' }, 'authorizing', ['IOS_UNTRUSTED']],
      [{ status: 'locked' }, 'locked', ['IOS_LOCKED']],
      [{ status: 'offline' }, 'offline', ['IOS_LOCKDOWN_FAILED']],
      [{ status: 'unknown' }, 'unknown', []],
    ]
    for (const [patch, state, blockers] of cases) {
      const row = deriveIos(entry(patch), ready)
      expect([row.state, row.blockers, caps(row)]).toEqual([state, blockers, 'no/no/no'])
    }
  })
  it('row 8: ready, with the screenshot gap named by the tools', () => {
    const row = deriveIos(entry(), ready)
    expect([row.state, row.blockers, caps(row)]).toEqual(['ready', [], 'yes/yes/yes'])
    expect(row).toMatchObject({
      name: 'Ngọc’s iPhone 12 Pro',
      modelId: 'iPhone13,3',
      osVersion: '27.0',
      model: '',
    })

    const noXcode = deriveIos(entry(), NO_IOS_TOOLS)
    expect([noXcode.blockers, caps(noXcode)]).toEqual([['XCODE_REQUIRED'], 'no/yes/yes'])
    const setup = deriveIos(entry(), { ...ready, xcode: 'needs-first-launch' })
    expect(setup.blockers).toEqual(['XCODE_SETUP_REQUIRED'])
    const devOff = deriveIos(entry({ developerMode: false }), ready)
    expect([devOff.blockers, caps(devOff)]).toEqual([['IOS_DEVELOPER_MODE_OFF'], 'no/yes/yes'])
    const unsupported = deriveIos(entry({ devicectlUnsupported: true }), ready)
    expect([unsupported.blockers, caps(unsupported)]).toEqual([[], 'no/yes/yes'])
  })
  it('row 8 on iOS 16 and older: idevicescreenshot, its disk image, or TOOL_MISSING', () => {
    const old = { DeviceName: 'Old', ProductType: 'iPhone10,1', ProductVersion: '15.8' }
    const withTool = deriveIos(entry({ device: old, developerMode: null }), {
      ...NO_IOS_TOOLS,
      idevicescreenshot: true,
    })
    expect([withTool.blockers, caps(withTool)]).toEqual([[], 'yes/yes/yes'])
    const missing = deriveIos(entry({ device: old, developerMode: null }), NO_IOS_TOOLS)
    expect([missing.blockers, caps(missing)]).toEqual([['TOOL_MISSING'], 'no/yes/yes'])
    const ddi = deriveIos(entry({ device: old, ddiRequired: true }), {
      ...ready,
      idevicescreenshot: true,
    })
    expect([ddi.blockers, caps(ddi)]).toEqual([['IOS_DDI_REQUIRED'], 'no/yes/yes'])
  })
  it('only ever emits blockers listed in EMITTED_BLOCKERS (the page has wording for each)', () => {
    const tools: IosTools[] = [
      NO_IOS_TOOLS,
      ready,
      { ...ready, xcode: 'needs-first-launch' },
      { ...NO_IOS_TOOLS, idevicescreenshot: true },
    ]
    const entries: Array<Partial<IosEntry>> = [
      { status: null },
      { status: 'untrusted' },
      { status: 'authorizing' },
      { status: 'locked' },
      { status: 'offline' },
      { status: 'unknown' },
      { developerMode: false },
      { source: 'plaintext' },
      { ddiRequired: true },
      { device: { ProductVersion: '15.0' } },
    ]
    const seen = new Set<string>()
    for (const t of tools)
      for (const e of entries) for (const b of deriveIos(entry(e), t).blockers) seen.add(b)
    expect([...seen].filter((b) => !(EMITTED_BLOCKERS as readonly string[]).includes(b))).toEqual(
      [],
    )
    expect(seen.size).toBeGreaterThanOrEqual(8)
  })
  it('the ideviceinfo fallback has logs only with idevicesyslog; row 9 (plaintext) has none', () => {
    const fallback = deriveIos(entry({ source: 'ideviceinfo' }), { ...ready, idevicesyslog: true })
    expect(caps(fallback)).toBe('yes/yes/yes')
    expect(caps(deriveIos(entry({ source: 'ideviceinfo' }), ready))).toBe('yes/yes/no')
    const plain = deriveIos(entry({ source: 'plaintext' }), NO_IOS_TOOLS)
    expect([plain.state, plain.blockers, caps(plain)]).toEqual([
      'ready',
      ['TOOL_MISSING', 'XCODE_REQUIRED'],
      'no/yes/no',
    ])
  })
})
