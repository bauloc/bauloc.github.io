import { describe, expect, it } from 'vitest'

import {
  parseDetail,
  parseDevice,
  parseDoctor,
  parseErrorBody,
  parseHealth,
  parseLanes,
  parseLogMsg,
  parsePreflightItem,
  parseRetry,
  parseSnapshot,
  parseStartServer,
  isDeviceId,
  parseConnectReply,
  parseDisconnectReply,
  parsePairReply,
  parseNearby,
  parseLan,
  serialOfInstance,
} from './protocol'
import { checkHost } from './network'

/*
  The guards narrow whatever arrives; they never trust it. Wrong types are refused or
  defaulted, strings are capped, blocker codes filtered, and values a newer helper might add
  read as the safe default rather than breaking the page.
*/

const IPHONE = {
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone 12 Pro',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
}

const HEALTH = {
  name: 'bauloc-device-bridge',
  version: '1.0.0',
  protocol: 1,
  features: ['android.start-server', 'simulators'],
  port: 8787,
  tokenId: '4d1566a1',
  tokenPersistent: false,
  runId: '0a1b2c3d',
  startedAt: 1_790_000_000_000,
  local: false,
  platform: 'darwin-arm64',
  sha256: 'a'.repeat(64),
  proof: 'p'.repeat(43),
}

describe('parseHealth', () => {
  it('reads a helper’s health', () => {
    expect(parseHealth(HEALTH)).toEqual(HEALTH)
  })

  it('needs a name and an integer protocol, and nothing else, to tell an old helper apart', () => {
    expect(parseHealth({ name: 'bauloc-device-bridge', protocol: 0 })).toMatchObject({
      protocol: 0,
      tokenId: '',
      features: [],
      port: 0,
    })
    expect(parseHealth({ name: 'x' })).toBeNull()
    expect(parseHealth({ name: 'x', protocol: 1.5 })).toBeNull()
    expect(parseHealth({ name: 7, protocol: 1 })).toBeNull()
    expect(parseHealth('<html>')).toBeNull()
    expect(parseHealth(null)).toBeNull()
    expect(parseHealth([HEALTH])).toBeNull()
  })

  it('drops malformed fingerprints, hashes, proofs and ports', () => {
    const health = parseHealth({
      ...HEALTH,
      tokenId: 'ZZZZZZZZ',
      sha256: 'nope',
      proof: 'short',
      port: 80,
    })
    expect(health).toMatchObject({ tokenId: '', sha256: '', port: 0 })
    expect(health).not.toHaveProperty('proof')
  })
})

describe('parseDevice', () => {
  it('reads a row', () => {
    expect(parseDevice(IPHONE)).toEqual({ ...IPHONE, capabilities: { ...IPHONE.capabilities } })
  })

  it('maps a state it does not know to unknown', () => {
    expect(parseDevice({ ...IPHONE, state: 'teleporting' })?.state).toBe('unknown')
    expect(parseDevice({ ...IPHONE, state: 'held' })?.state).toBe('unknown')
    expect(parseDevice({ ...IPHONE, state: 3 })?.state).toBe('unknown')
  })

  it('keeps only blocker codes', () => {
    const device = parseDevice({
      ...IPHONE,
      blockers: ['IOS_LOCKED', 'lowercase', '<script>', 7, 'A'.repeat(41), 'XCODE_REQUIRED'],
    })
    expect(device?.blockers).toEqual(['IOS_LOCKED', 'XCODE_REQUIRED'])
  })

  it('caps strings and strips unknown capabilities', () => {
    const device = parseDevice({
      ...IPHONE,
      name: 'n'.repeat(500),
      osVersion: 'v'.repeat(100),
      capabilities: { screenshot: 'yes', logs: true, install: true },
    })
    expect(device?.name).toHaveLength(200)
    expect(device?.osVersion).toHaveLength(40)
    expect(device?.capabilities).toEqual({
      screenshot: false,
      identifiers: false,
      logs: true,
      install: false,
    })
  })

  it('refuses a row with an id no tool may be given, or no platform', () => {
    for (const id of ['--help', '-u', '../x', 'a b', '', 'x/y', 7]) {
      expect(parseDevice({ ...IPHONE, id })).toBeNull()
    }
    expect(parseDevice({ ...IPHONE, platform: 'windows' })).toBeNull()
  })

  it('reads an unknown connection as usb', () => {
    expect(parseDevice({ ...IPHONE, connection: 'bluetooth' })?.connection).toBe('usb')
    expect(parseDevice({ ...IPHONE, connection: 'simulator' })?.connection).toBe('simulator')
  })
})

describe('parseLanes and parseSnapshot', () => {
  it('defaults every lane to not available', () => {
    expect(parseLanes(undefined)).toEqual({
      ios: {
        status: 'error',
        screenshots: 'none',
        xcode: 'not-installed',
        wifi: false,
        wifiHidden: 0,
      },
      android: { status: 'error', adb: 'missing', startedByHelper: false },
      simulators: { status: 'off', booted: 0 },
    })
  })

  it('reads lanes as the helper sends them', () => {
    const lanes = {
      ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: true, wifiHidden: 1 },
      android: { status: 'stopped', adb: 'found', startedByHelper: false, reason: 'no server' },
      simulators: { status: 'ok', booted: 3 },
    }
    expect(parseLanes(lanes)).toEqual(lanes)
    expect(parseLanes({ ...lanes, ios: { ...lanes.ios, xcode: 'quantum' } }).ios.xcode).toBe(
      'not-installed',
    )
  })

  it('reads a snapshot, dropping bad rows and duplicates', () => {
    const snapshot = parseSnapshot({
      rev: 4,
      runId: '0a1b2c3d',
      devices: [IPHONE, { ...IPHONE, name: 'again' }, { id: '--help', platform: 'ios' }, 'x'],
      lanes: {},
    })
    expect(snapshot?.rev).toBe(4)
    expect(snapshot?.devices.map((d) => d.name)).toEqual([IPHONE.name])
  })

  it('refuses a snapshot without rev or devices', () => {
    expect(parseSnapshot({ devices: [] })).toBeNull()
    expect(parseSnapshot({ rev: 1, devices: {} })).toBeNull()
  })

  it('reads retry and start-server replies', () => {
    expect(parseRetry({ device: null })).toEqual({ device: null })
    expect(parseRetry({ device: IPHONE })?.device?.id).toBe(IPHONE.id)
    expect(parseRetry({})).toBeNull()
    expect(
      parseStartServer({ android: { status: 'ok', adb: 'found', startedByHelper: true } }),
    ).toEqual({ android: { status: 'ok', adb: 'found', startedByHelper: true } })
    expect(parseStartServer({ android: 'ok' })).toBeNull()
  })
})

describe('parseDetail', () => {
  it('reads Android outputs and caps them', () => {
    const detail = parseDetail({
      platform: 'android',
      kind: 'android',
      serial: '55090DLAQ0026D',
      connection: 'usb',
      outputs: { getprop: '[ro.x]: [y]', wmSize: 7 },
    })
    expect(detail).toEqual({
      platform: 'android',
      kind: 'android',
      serial: '55090DLAQ0026D',
      connection: 'usb',
      outputs: {
        getprop: '[ro.x]: [y]',
        wmSize: '',
        wmDensity: '',
        battery: '',
        df: '',
        androidId: '',
      },
    })
  })

  it('reads iOS facts, whitelisted keys only, and the ECID as a decimal string', () => {
    const detail = parseDetail({
      platform: 'ios',
      kind: 'ios',
      facts: {
        udid: IPHONE.id,
        connection: 'network',
        source: 'lockdown',
        device: {
          DeviceName: 'Phone',
          ProductType: 'iPhone13,3',
          UniqueChipID: '18446744073709550001',
          InternationalMobileEquipmentIdentity: '350000000000000',
          WiFiAddress: 'aa:bb',
        },
        battery: { BatteryCurrentCapacity: 87, BatteryIsCharging: 'yes' },
        disk: { TotalDiskCapacity: 256e9 },
        international: { Language: 'en' },
        developerMode: true,
        locked: null,
        withheld: ['battery', 'imei'],
      },
    })
    expect(detail?.kind).toBe('ios')
    if (detail?.kind !== 'ios') return
    expect(detail.facts.device).toEqual({
      DeviceName: 'Phone',
      ProductType: 'iPhone13,3',
      UniqueChipID: '18446744073709550001',
    })
    expect(detail.facts.battery?.BatteryCurrentCapacity).toBe(87)
    expect(detail.facts.battery?.BatteryIsCharging).toBeUndefined()
    expect(detail.facts.connection).toBe('network')
    expect(detail.facts.withheld).toEqual(['battery'])
    expect(detail.facts.locked).toBeNull()
    expect(JSON.stringify(detail)).not.toContain('350000000000000')
  })

  it('accepts a numeric ECID from an older helper, and refuses junk', () => {
    const facts = (ecid: unknown) =>
      parseDetail({
        platform: 'ios',
        kind: 'ios',
        facts: { udid: 'u', device: { UniqueChipID: ecid } },
      })
    const ok = facts(1234)
    expect(ok?.kind === 'ios' && ok.facts.device.UniqueChipID).toBe('1234')
    const bad = facts('12; rm -rf')
    expect(bad?.kind === 'ios' && bad.facts.device.UniqueChipID).toBeUndefined()
  })

  it('reads simulator facts', () => {
    const detail = parseDetail({
      platform: 'ios',
      kind: 'simulator',
      facts: {
        udid: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
        name: 'iPhone 17 Pro',
        deviceType: { name: 'iPhone 17 Pro', modelIdentifier: 'iPhone18,1' },
        runtime: { name: 'iOS 27.0', version: '27.0', build: '24A5300a' },
        state: 'Booted',
        dataPathSize: 123,
      },
    })
    expect(detail?.kind === 'simulator' && detail.facts.runtime.version).toBe('27.0')
  })

  it('refuses a kind it does not know, or a mismatched platform', () => {
    expect(parseDetail({ platform: 'ios', kind: 'android', outputs: {} })).toBeNull()
    expect(parseDetail({ platform: 'ios', kind: 'watch', facts: {} })).toBeNull()
    expect(parseDetail({ platform: 'ios', kind: 'ios', facts: { device: {} } })).toBeNull()
  })
})

describe('parseLogMsg', () => {
  it('reads each record', () => {
    expect(parseLogMsg({ t: 'hello', device: 'd', source: 'syslog_relay', at: 1 })).toEqual({
      t: 'hello',
      device: 'd',
      source: 'syslog_relay',
      at: 1,
    })
    expect(parseLogMsg({ t: 'lines', lines: ['a', 2, 'b'] })).toEqual({
      t: 'lines',
      lines: ['a', 'b'],
    })
    expect(parseLogMsg({ t: 'notice', text: 'Switched' })).toEqual({
      t: 'notice',
      text: 'Switched',
    })
    expect(parseLogMsg({ t: 'ping', at: 5 })).toEqual({ t: 'ping', at: 5 })
    expect(parseLogMsg({ t: 'end', reason: 'device-gone' })).toEqual({
      t: 'end',
      reason: 'device-gone',
    })
    expect(
      parseLogMsg({ t: 'end', reason: 'error', code: 'LOGS_UNAVAILABLE', message: 'm' }),
    ).toEqual({
      t: 'end',
      reason: 'error',
      code: 'LOGS_UNAVAILABLE',
      message: 'm',
    })
  })

  it('caps lines and their count', () => {
    const msg = parseLogMsg({
      t: 'lines',
      lines: Array.from({ length: 2_000 }, () => 'x'.repeat(20_000)),
    })
    expect(msg?.t === 'lines' && msg.lines.length).toBe(1_000)
    expect(msg?.t === 'lines' && msg.lines[0]?.length).toBe(16_384)
  })

  it('refuses what is not a record, and an unknown end reason reads as error', () => {
    expect(parseLogMsg({ t: 'hello', source: 'telepathy' })).toBeNull()
    expect(parseLogMsg({ t: 'lines', lines: 'a' })).toBeNull()
    expect(parseLogMsg({ t: 'shout' })).toBeNull()
    expect(parseLogMsg('lines')).toBeNull()
    expect(parseLogMsg({ t: 'end', reason: 'boredom', code: 'bad code' })).toEqual({
      t: 'end',
      reason: 'error',
    })
  })
})

describe('parseErrorBody', () => {
  it('reads the helper’s error, with its extras', () => {
    expect(
      parseErrorBody({
        error: {
          code: 'DEVICE_NOT_READY',
          message: 'The device is not ready yet.',
          state: 'locked',
          blockers: ['IOS_LOCKED', 'nope'],
        },
      }),
    ).toEqual({
      error: {
        code: 'DEVICE_NOT_READY',
        message: 'The device is not ready yet.',
        state: 'locked',
        blockers: ['IOS_LOCKED'],
      },
    })
    expect(
      parseErrorBody({
        error: {
          code: 'TOOL_MISSING',
          message: 'm',
          tool: 'ideviceinfo',
          install: 'brew install libimobiledevice',
        },
      })?.error,
    ).toMatchObject({ tool: 'ideviceinfo', install: 'brew install libimobiledevice' })
    expect(
      parseErrorBody({ error: { code: 'UNAUTHORIZED', message: 'm', tokenId: '4d1566a1' } })?.error
        .tokenId,
    ).toBe('4d1566a1')
  })

  it('refuses a body without a code', () => {
    expect(parseErrorBody({ error: { message: 'm' } })).toBeNull()
    expect(parseErrorBody({ error: { code: 'not a code' } })).toBeNull()
    expect(parseErrorBody({ code: 'X' })).toBeNull()
  })
})

describe('parseDoctor and parsePreflightItem', () => {
  const ITEM = {
    id: 'ios.xcode',
    group: 'ios',
    label: 'Xcode 27.0',
    status: 'warning',
    sentence: 'Xcode isn’t installed, so screenshots of iOS 17 and newer are off.',
    fixes: [
      { kind: 'link', href: 'https://apps.apple.com/app/xcode/id497799835', label: 'Get Xcode' },
      {
        kind: 'command',
        command: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      },
      { kind: 'step', text: 'Open Xcode once.' },
      { kind: 'action', action: 'start-adb', label: 'Start adb server' },
    ],
    detail: 'devicectl 642.16',
    neededFor: ['ios.screenshot', 'teleport'],
    optional: false,
  }

  it('reads an item', () => {
    expect(parsePreflightItem(ITEM)).toEqual({ ...ITEM, neededFor: ['ios.screenshot'] })
  })

  it('drops fixes that could do harm or that it does not know', () => {
    const item = parsePreflightItem({
      ...ITEM,
      fixes: [
        { kind: 'link', href: 'javascript:alert(1)', label: 'x' },
        { kind: 'link', href: 'http://example.com', label: 'x' },
        { kind: 'link', href: 'file:///etc/passwd', label: 'x' },
        { kind: 'action', action: 'format-disk', label: 'x' },
        { kind: 'command', command: '' },
        { kind: 'magic' },
      ],
    })
    expect(item?.fixes).toEqual([])
  })

  it('maps an unknown status to unchecked and refuses an unknown group', () => {
    expect(parsePreflightItem({ ...ITEM, status: 'great' })?.status).toBe('unchecked')
    expect(parsePreflightItem({ ...ITEM, group: 'kitchen' })).toBeNull()
    expect(parsePreflightItem({ ...ITEM, id: 'a b' })).toBeNull()
  })

  it('reads a report', () => {
    const report = parseDoctor({
      helper: {
        name: 'bauloc-device-bridge',
        version: '1.0.0',
        protocol: 1,
        node: '24.12.0',
        openssl: '3.6.1',
        platform: 'darwin',
        arch: 'arm64',
        macos: '27.0.1',
        port: 8787,
        startedAt: 1,
        local: false,
        tokenPersistent: false,
        flags: ['--wifi'],
        sha256: 'b'.repeat(64),
      },
      lanes: {},
      items: [ITEM, { id: 'broken' }],
      checkedAt: 2,
    })
    expect(report?.helper.macos).toBe('27.0.1')
    expect(report?.items.map((i) => i.id)).toEqual(['ios.xcode'])
    expect(parseDoctor({ helper: {}, items: 'x' })).toBeNull()
  })
})

describe('the Wi‑Fi replies (§4.7)', () => {
  const ROW = {
    id: '192.168.1.42:5555',
    platform: 'android',
    connection: 'network',
    state: 'unauthorized',
    blockers: ['ANDROID_UNAUTHORIZED'],
  }

  it('reads a connect, with its row once listed', () => {
    expect(
      parseConnectReply({
        result: 'connected',
        serial: '192.168.1.42:5555',
        message: 'm',
        device: ROW,
      }),
    ).toMatchObject({
      result: 'connected',
      serial: '192.168.1.42:5555',
      device: { id: '192.168.1.42:5555', connection: 'network', state: 'unauthorized' },
    })
    expect(
      parseConnectReply({
        result: 'already-connected',
        serial: '[fe80::1%en0]:5555',
        device: null,
      }),
    ).toEqual({ result: 'already-connected', serial: '[fe80::1%en0]:5555', device: null })
  })

  it('refuses a connect it can’t trust', () => {
    expect(parseConnectReply({ result: 'maybe', serial: '192.168.1.42:5555' })).toBeNull()
    expect(parseConnectReply({ result: 'connected', serial: '../x' })).toBeNull()
    expect(parseConnectReply({ result: 'connected' })).toBeNull()
    expect(parseConnectReply('connected')).toBeNull()
  })

  it('reads a pairing and a disconnect', () => {
    expect(
      parsePairReply({ result: 'paired', host: '192.168.1.42', port: 37099, message: 'm' }),
    ).toEqual({ result: 'paired', host: '192.168.1.42', port: 37099 })
    expect(parsePairReply({ result: 'paired', host: '192.168.1.42', port: 0 })).toBeNull()
    expect(parsePairReply({ result: 'connected', host: 'h', port: 1 })).toBeNull()
    expect(parseDisconnectReply({ result: 'disconnected', serial: '192.168.1.42:5555' })).toEqual({
      result: 'disconnected',
      serial: '192.168.1.42:5555',
    })
    expect(parseDisconnectReply({ result: 'disconnected', serial: '' })).toBeNull()
  })

  it('takes IPv6 network serials as ids, and still nothing that could leave a URL path', () => {
    expect(isDeviceId('[fe80::1%en0]:5555')).toBe(true)
    expect(isDeviceId('[fd12:3456::42]:5555')).toBe(true)
    expect(isDeviceId('[fe80::1]/x:5555')).toBe(false)
    expect(isDeviceId('[fe80::1%en0/..]:5555')).toBe(false)
  })

  it('keeps a failure’s reason and adb’s words, and drops a reason that isn’t a word', () => {
    expect(
      parseErrorBody({
        error: {
          code: 'ANDROID_CONNECT_FAILED',
          message: 'Could not connect.',
          reason: 'refused',
          detail: "failed to connect to '192.168.1.42:5556': Connection refused",
        },
      })?.error,
    ).toMatchObject({
      reason: 'refused',
      detail: "failed to connect to '192.168.1.42:5556': Connection refused",
    })
    expect(
      parseErrorBody({ error: { code: 'ANDROID_CONNECT_FAILED', message: 'm', reason: '<b>' } })
        ?.error.reason,
    ).toBeUndefined()
  })
})

describe('nearby (android.discover)', () => {
  const local = (host: string) => {
    const c = checkHost(host)
    return c.ok ? c.host : null
  }
  // As dns-sd heard them on the owner's network (2026-10-04), in the helper's words.
  const TV = {
    id: 'adb:192.168.68.101:5555',
    kind: 'adb',
    host: '192.168.68.101',
    port: 5555,
    instance: 'adb-b120be004010859',
    name: 'SONY KD-43X8050H',
    serial: 'b120be004010859',
    tv: true,
    connected: false,
  }
  const PIXEL = {
    id: 'wireless:192.168.68.114:39601',
    kind: 'wireless',
    host: '192.168.68.114',
    port: 39601,
    instance: 'adb-55090DLAQ0026D-nK25Qn',
    name: '',
    tv: false,
    connected: false,
    paired: false,
  }

  it('reads what the helper heard: kind, address, and the serial in the instance name', () => {
    expect(parseNearby({ scannedAt: 42, devices: [TV, PIXEL] }, local)).toEqual({
      scannedAt: 42,
      devices: [
        {
          id: 'adb:192.168.68.101:5555',
          kind: 'adb',
          host: '192.168.68.101',
          port: 5555,
          instance: 'adb-b120be004010859',
          serial: 'b120be004010859',
          name: 'SONY KD-43X8050H',
          model: '',
          tv: true,
          connected: false,
          deviceId: null,
          paired: false,
        },
        {
          id: 'wireless:192.168.68.114:39601',
          kind: 'wireless',
          host: '192.168.68.114',
          port: 39601,
          instance: 'adb-55090DLAQ0026D-nK25Qn',
          // No serial field: the instance name carries it.
          serial: '55090DLAQ0026D',
          name: '',
          model: '',
          tv: false,
          connected: false,
          deviceId: null,
          paired: false,
        },
      ],
    })
  })

  it('never offers an address off the local network, nor a bad port or kind', () => {
    const reply = parseNearby(
      {
        devices: [
          { ...TV, id: 'a', host: '8.8.8.8' },
          { ...TV, id: 'b', host: '127.0.0.1' },
          { ...TV, id: 'c', host: '::1' },
          { ...TV, id: 'd', host: 'tv.example.com' },
          { ...TV, id: 'e', port: 0 },
          { ...TV, id: 'f', port: '5555' },
          { ...TV, id: 'g', kind: 'usb' },
          { ...TV, id: 'h', host: 'FE80::1%en0' },
          { ...TV, id: 'i', host: '10.0.0.7' },
        ],
      },
      local,
    )
    expect(reply?.devices.map((d) => d.host)).toEqual(['fe80::1%en0', '10.0.0.7'])
  })

  it('keeps paired only for Wireless debugging, and a connected row’s id only when it is one', () => {
    const [a, b, c] =
      parseNearby(
        {
          devices: [
            { ...TV, paired: true },
            { ...PIXEL, paired: true, connected: true, deviceId: '192.168.68.114:39601' },
            { ...PIXEL, id: 'x', connected: true, deviceId: '../etc' },
          ],
        },
        local,
      )?.devices ?? []
    expect(a?.paired).toBe(false)
    expect(b).toMatchObject({ paired: true, connected: true, deviceId: '192.168.68.114:39601' })
    expect(c).toMatchObject({ connected: true, deviceId: null })
  })

  it('drops repeats, strips control and direction marks from names, caps the list', () => {
    const reply = parseNearby(
      { devices: [TV, { ...TV, name: 'other' }, { ...PIXEL, name: 'Pixel\u202e 9\n<b>' }] },
      local,
    )
    expect(reply?.devices).toHaveLength(2)
    expect(reply?.devices[1]?.name).toBe('Pixel 9<b>')
    const many = Array.from({ length: 100 }, (_, i) => ({ ...TV, id: `adb:${String(i)}` }))
    expect(parseNearby({ devices: many }, local)?.devices).toHaveLength(64)
  })

  it('keeps the helper’s failure with what adb still found, and refuses what isn’t an answer', () => {
    expect(
      parseNearby(
        {
          devices: [TV],
          scannedAt: 7,
          error: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 224.0.0.251:5353' },
        },
        local,
      ),
    ).toMatchObject({
      devices: [{ id: 'adb:192.168.68.101:5555' }],
      error: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 224.0.0.251:5353' },
    })
    expect(
      parseNearby({ devices: [], error: { reason: 'later', message: 'm' } }, local)?.error,
    ).toEqual({ reason: 'failed', message: 'm', detail: '' })
    expect(parseNearby({ scannedAt: 1 }, local)).toBeNull()
    expect(parseNearby([], local)).toBeNull()
  })

  it('finds the serial in an instance name, and nothing in anything else', () => {
    expect(serialOfInstance('adb-55090DLAQ0026D-nK25Qn')).toBe('55090DLAQ0026D')
    expect(serialOfInstance('adb-b120be004010859')).toBe('b120be004010859')
    expect(serialOfInstance('SONY KD-43X8050H')).toBe('')
    expect(serialOfInstance('adb-../x')).toBe('')
  })
})

describe('every device on this network (lan.discover)', () => {
  const local = (host: string) => {
    const c = checkHost(host)
    return c.ok ? c.host : null
  }
  const SOURCES = { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' }
  // The owner's network (2026-10-04), in the helper's words; names made up where they'd identify.
  const ROUTER = {
    address: '192.168.68.1',
    self: false,
    gateway: true,
    hostnames: [],
    names: [],
    services: [],
    upnp: {
      deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      manufacturer: 'TP-Link',
      server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
    },
    found: ['reply', 'ssdp', 'gateway'],
  }
  const PIXEL = {
    address: '192.168.68.114',
    self: false,
    gateway: false,
    hostnames: ['Android_GWZJSA15.local'],
    names: [],
    services: [
      {
        type: '_adb-tls-connect._tcp',
        port: 43141,
        name: 'adb-55090DLAQ0026D-nK25Qn',
        txt: { given_name: 'BAULOC Pixel 9', name: 'Pixel 9', api: '37.1' },
      },
    ],
    found: ['reply', 'mdns'],
  }
  const reply = (devices: unknown[], patch: Record<string, unknown> = {}) => ({
    devices,
    networks: [
      { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
    ],
    sources: SOURCES,
    scannedAt: 42,
    durationMs: 4_100,
    ...patch,
  })

  it('reads what the helper found, device by device', () => {
    expect(parseLan(reply([ROUTER, PIXEL]), local)).toEqual({
      devices: [
        {
          address: '192.168.68.1',
          self: false,
          gateway: true,
          hostnames: [],
          names: [],
          services: [],
          upnp: {
            deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
            manufacturer: 'TP-Link',
            server: 'TP-LINK/TP-LINK UPnP/1.1 MiniUPnPd/1.8',
          },
          found: ['reply', 'ssdp', 'gateway'],
        },
        {
          address: '192.168.68.114',
          self: false,
          gateway: false,
          hostnames: ['Android_GWZJSA15.local'],
          names: [],
          services: [
            {
              type: '_adb-tls-connect._tcp',
              port: 43141,
              name: 'adb-55090DLAQ0026D-nK25Qn',
              txt: { given_name: 'BAULOC Pixel 9', name: 'Pixel 9', api: '37.1' },
            },
          ],
          found: ['reply', 'mdns'],
        },
      ],
      networks: [
        { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
      ],
      sources: SOURCES,
      scannedAt: 42,
      durationMs: 4_100,
    })
  })

  it('keeps only IPv4 addresses on a local network, and the first answer for each', () => {
    const at = (address: unknown, name = 'x') => ({
      ...ROUTER,
      address,
      gateway: false,
      names: [{ text: name, source: 'mdns' }],
    })
    const parsed = parseLan(
      reply([
        at('8.8.8.8'),
        at('127.0.0.1'),
        at('224.0.0.251'),
        at('0.0.0.0'),
        at('192.168.01.20'),
        at('fe80::1'),
        at('fd00::1'),
        at('printer.local'),
        at(' 10.0.0.7 '),
        at('169.254.10.2'),
        at('10.0.0.7', 'again'),
        at(17),
        at(null),
        'a string',
        null,
      ]),
      local,
    )
    expect(parsed?.devices.map((d) => [d.address, d.names[0]?.text])).toEqual([
      ['10.0.0.7', 'x'],
      ['169.254.10.2', 'x'],
    ])
  })

  it('strips control, line-breaking, bidi and invisible characters from every name', () => {
    const hostile =
      'Bau\u202e\u2066s\n\u2028\u2029 iPh\u00adone\ufeff\u061c\u2060\u2063\ufff9\u{E0041}\u{E007F} 12\t'
    const [device] =
      parseLan(
        reply([
          {
            ...PIXEL,
            names: [{ text: hostile, source: 'mdns' }],
            services: [{ type: '_airplay._tcp', name: hostile, txt: { model: hostile } }],
            upnp: { friendlyName: hostile, modelName: '\u0007' },
          },
        ]),
        local,
      )?.devices ?? []
    expect(device?.names).toEqual([{ text: 'Baus iPhone 12', source: 'mdns' }])
    expect(device?.services[0]).toEqual({
      type: '_airplay._tcp',
      name: 'Baus iPhone 12',
      txt: { model: 'Baus iPhone 12' },
    })
    // A field with nothing left to show is left out.
    expect(device?.upnp).toEqual({ friendlyName: 'Baus iPhone 12' })
    // The same cleaning for "On this network".
    const nearby = parseNearby(
      {
        devices: [
          {
            kind: 'adb',
            host: '192.168.68.101',
            port: 5555,
            name: 'TV\u2028\ufeff\u00ad\u{E0020}',
          },
        ],
      },
      local,
    )
    expect(nearby?.devices[0]?.name).toBe('TV')
  })

  it('never passes on a hardware address, whatever field carries it', () => {
    const [device] =
      parseLan(
        reply([
          {
            ...PIXEL,
            hostnames: ['6c-02-e0-12-34-56.local', 'npi9c4e21.local'],
            names: [{ text: 'Printer 6c:02:e0:12:34:56', source: 'ssdp' }],
            services: [
              // _apple-mobdev2's instance name is the iPhone's address @ its IPv6 one.
              {
                type: '_apple-mobdev2._tcp',
                port: 32498,
                name: '3a:12:34:56:78:9a@fe80::3812:34ff:fe56:789a-supportsRP-26',
              },
              {
                type: '_ipp._tcp',
                txt: { mac: '6c:02:e0:12:34:56', ty: 'HP 6C:2:E0:12:34:56', deviceid: 'x' },
              },
            ],
            upnp: { friendlyName: 'Deco 14-EB-B6-12-34-56' },
            maker: '6C02E0',
          },
        ]),
        local,
      )?.devices ?? []
    expect(device).toMatchObject({
      hostnames: ['npi9c4e21.local'],
      names: [],
      services: [{ type: '_apple-mobdev2._tcp', port: 32498 }, { type: '_ipp._tcp' }],
      maker: '6C02E0',
    })
    expect(device?.upnp).toBeUndefined()
    expect(JSON.stringify(device)).not.toMatch(/[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}/i)
  })

  it('reads every field strictly: types, ports, TXT keys, makers, sources', () => {
    const [device] =
      parseLan(
        reply([
          {
            ...PIXEL,
            self: 'yes',
            gateway: 1,
            hostnames: [
              'Baus-iPhone-12-Pro.local.',
              'BAUS-IPHONE-12-PRO.local',
              'router.lan',
              'two words.local',
              42,
            ],
            names: [
              { text: 'BAULOC Pixel 9', source: 'mdns' },
              { text: 'bauloc pixel 9', source: 'ssdp' },
              { text: 'From NetBIOS', source: 'netbios' },
              { text: '', source: 'mdns' },
              'Pixel',
            ],
            services: [
              {
                type: '_ipp._tcp',
                port: 631,
                name: 'HP',
                txt: { ty: 'HP 120x', serial: 'S1', pk: 'k', usb_MFG: 7 },
              },
              { type: '_ipp._tcp', port: 631, name: 'hp' },
              { type: '_ipps._tcp', port: 0 },
              { type: '_printer._tcp', port: '515' },
              { type: '_pdl-datastream._tcp', port: 70_000 },
              { type: '_ipp._tcp.local' },
              { type: '_ipp._sctp' },
              { type: 'ipp' },
              { type: 42 },
              { type: `_${'a'.repeat(63)}._tcp` },
            ],
            privateAddress: 'yes',
            maker: '6c02e0',
            found: ['mdns', 'netbios', 'reply', 'mdns', 7],
          },
        ]),
        local,
      )?.devices ?? []
    expect(device).toMatchObject({
      self: false,
      gateway: false,
      hostnames: ['Baus-iPhone-12-Pro.local'],
      names: [{ text: 'BAULOC Pixel 9', source: 'mdns' }],
      services: [
        { type: '_ipp._tcp', port: 631, name: 'HP', txt: { ty: 'HP 120x' } },
        { type: '_ipps._tcp' },
        { type: '_printer._tcp' },
        { type: '_pdl-datastream._tcp' },
      ],
      found: ['reply', 'mdns'],
    })
    expect(device?.services[1]).toEqual({ type: '_ipps._tcp' })
    expect(device).not.toHaveProperty('maker')
    expect(device).not.toHaveProperty('privateAddress')
    const [, privateOne, shortMaker] =
      parseLan(
        reply([
          PIXEL,
          {
            ...ROUTER,
            address: '192.168.68.2',
            gateway: false,
            privateAddress: true,
            maker: 'AC1C26',
          },
          { ...ROUTER, address: '192.168.68.3', gateway: false, maker: 'AC1C2' },
        ]),
        local,
      )?.devices ?? []
    // A private address names no maker, whatever the helper said.
    expect(privateOne).toMatchObject({ privateAddress: true })
    expect(privateOne).not.toHaveProperty('maker')
    expect(shortMaker).not.toHaveProperty('maker')
  })

  it('caps every list as the helper does', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...ROUTER,
      gateway: false,
      address: `10.0.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
    }))
    expect(parseLan(reply(many), local)?.devices).toHaveLength(256)
    const [device] =
      parseLan(
        reply([
          {
            ...PIXEL,
            hostnames: Array.from({ length: 9 }, (_, i) => `host-${String(i)}.local`),
            names: Array.from({ length: 20 }, (_, i) => ({
              text: `Name ${String(i)}`,
              source: 'mdns',
            })),
            services: Array.from({ length: 40 }, (_, i) => ({
              type: `_s${String(i)}._tcp`,
              txt: Object.fromEntries(
                [
                  'model',
                  'md',
                  'fn',
                  'ty',
                  'product',
                  'usb_MFG',
                  'usb_MDL',
                  'mfg',
                  'mdl',
                  'am',
                ].map((k) => [k, 'v'.repeat(500)]),
              ),
            })),
          },
        ]),
        local,
      )?.devices ?? []
    expect(device?.hostnames).toHaveLength(4)
    expect(device?.names).toHaveLength(8)
    expect(device?.services).toHaveLength(24)
    expect(Object.keys(device?.services[0]?.txt ?? {})).toHaveLength(8)
    expect(device?.services[0]?.txt?.model).toHaveLength(100)
    const networks = Array.from({ length: 40 }, () => ({
      interface: 'en0',
      address: '10.0.0.2',
      prefix: 24,
      size: 254,
      scanned: 254,
    }))
    expect(parseLan(reply([], { networks }), local)?.networks).toHaveLength(16)
  })

  it('reads the networks it looked at, and refuses a network that isn’t one', () => {
    const parsed = parseLan(
      reply([], {
        networks: [
          { interface: 'en0', address: '10.0.5.20', prefix: 16, size: 65_534, scanned: 254 },
          { interface: 'en7', address: '192.168.1.5', prefix: 24, size: 254, scanned: 900 },
          { interface: 'en1', address: '8.8.8.8', prefix: 24, size: 254, scanned: 254 },
          { interface: 'en2', address: '10.0.0.1', prefix: 33, size: 254, scanned: 254 },
          { interface: 'en3', address: '10.0.0.1', prefix: 24, size: -1, scanned: 0 },
          { interface: 'en4', address: '10.0.0.1', prefix: 24.5, size: 254, scanned: 0 },
          { interface: '', address: '10.0.0.1', prefix: 24, size: 254, scanned: 0 },
          'en5',
        ],
      }),
      local,
    )
    expect(parsed?.networks).toEqual([
      { interface: 'en0', address: '10.0.5.20', prefix: 16, size: 65_534, scanned: 254 },
      { interface: 'en7', address: '192.168.1.5', prefix: 24, size: 254, scanned: 254 },
    ])
  })

  it('keeps the error or note with what was still found, and reads unknown values safely', () => {
    const blocked = parseLan(
      reply([PIXEL], {
        note: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 192.168.68.1:9' },
        sources: { presence: 'blocked', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'blocked' },
        truncated: true,
      }),
      local,
    )
    expect(blocked).toMatchObject({
      devices: [{ address: '192.168.68.114' }],
      note: { reason: 'blocked', message: 'm', detail: 'send EHOSTUNREACH 192.168.68.1:9' },
      sources: { presence: 'blocked', ssdp: 'blocked' },
      truncated: true,
    })
    expect(blocked).not.toHaveProperty('error')
    const later = parseLan(
      reply([], {
        error: { reason: 'later', message: 7 },
        sources: { presence: 'maybe', neighbors: 1, resolver: 'mdnsd' },
        scannedAt: -5,
        durationMs: 'long',
        truncated: 'yes',
      }),
      local,
    )
    expect(later).toEqual({
      devices: [],
      networks: [
        { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
      ],
      sources: { presence: 'off', neighbors: 'none', resolver: 'none', ssdp: 'ok' },
      scannedAt: 0,
      durationMs: 0,
      error: { reason: 'failed', message: '', detail: '' },
    })
    expect(parseLan({ devices: [] }, local)).toMatchObject({ networks: [], scannedAt: 0 })
    expect(parseLan({ devices: {} }, local)).toBeNull()
    expect(parseLan({ scannedAt: 1 }, local)).toBeNull()
    expect(parseLan([], local)).toBeNull()
    expect(parseLan('nothing', local)).toBeNull()
  })
})
