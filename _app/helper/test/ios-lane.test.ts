/*
  The REAL iOS lane through the bridge, against the fake usbmuxd and lockdownd: hot-plug,
  the probe pipeline and trust (§3.4), the whitelists in every response (§3.5), lock and
  Developer Mode (§3.6), the TLS-failed path, Wi-Fi (§3.9), usbmuxd restarts, and --doctor.
*/
import { beforeAll, describe, expect, it } from 'vitest'
import { IOS_TUNING, linkCut } from '../src/ios-lane'
import type { DetailResponse, ErrorBody, Snapshot } from '../src/types'
import { buildPlist } from '../src/plist'
import type { Toolbox } from '../src/tools'
import { request, tempDir, toolbox, until } from './harness'
import { hasOpenssl, makeChain, pairRecordPlist, type Chain } from './fakes/certs'
import { BIG_ECID, UDID, plaintextKeys, sessionKeys, startIosRig } from './fakes/lockdownd'

let chain: Chain
let other: Chain
beforeAll(() => {
  if (!hasOpenssl) return
  const dir = tempDir('certs-')
  chain = makeChain(dir, 'empty')
  other = makeChain(dir, 'named')
}, 30_000)

const SECRETS = [
  'InternationalMobileEquipmentIdentity',
  '350000000000000',
  'PhoneNumber',
  '+84 90',
  'WiFiAddress',
  'aa:bb:cc',
  'DieID',
  '1234567890123',
  'BasebandSerialNumber',
  'IntegratedCircuitCardIdentity',
  '89840000000000000000',
  'EscrowBag',
  'PrivateKey',
  'BEGIN',
]

describe.skipIf(!hasOpenssl)('iOS lane: listing and trust', () => {
  it('lists a plugged-in iPhone as ready, with one clean arrival line', async () => {
    const started = Date.now()
    const rig = await startIosRig({ chain })
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready', 2_000)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(row).toMatchObject({
      id: UDID,
      platform: 'ios',
      connection: 'usb',
      name: 'Ngọc’s iPhone 12 Pro',
      model: '',
      modelId: 'iPhone13,3',
      osVersion: '27.0',
      blockers: ['XCODE_REQUIRED'],
      capabilities: { screenshot: false, identifiers: true, logs: true, install: false },
    })
    expect(rig.s.logs.filter((l) => l.includes('Ngọc’s iPhone 12 Pro'))[0]).toMatch(
      /\+ Ngọc’s iPhone 12 Pro · iOS 27\.0 · USB · trusted$/,
    )
    const lanes = rig.s.bridge.registry.lanes().ios
    expect(lanes).toMatchObject({
      status: 'ok',
      xcode: 'not-installed',
      screenshots: 'none',
      wifiHidden: 0,
    })
  })

  it('shows "connecting" while a slow probe runs, then ready', async () => {
    const rig = await startIosRig({ chain, script: { sessionDelayMs: 800 } })
    await rig.waitRow((r) => r?.state === 'connecting', 'connecting', 2_000)
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 4_000)
  })

  it('hot-plug: Attached → ready, Detached → gone at once', async () => {
    const rig = await startIosRig({ chain, plugged: false })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.plug()
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 2_000)
    rig.unplug()
    await rig.waitRow((r) => r === null, 'gone', 1_000)
    expect(rig.s.logs.some((l) => /- Ngọc’s iPhone 12 Pro$/.test(l))).toBe(true)
  })

  it('no pair record → untrusted, then the 3 s poll finds one → ready', async () => {
    const rig = await startIosRig({ chain, record: false, tuning: { pairPollMs: 200 } })
    const row = await rig.waitRow((r) => r?.state === 'untrusted', 'untrusted')
    expect(row?.blockers).toEqual(['IOS_UNTRUSTED'])
    expect(row?.capabilities).toMatchObject({ screenshot: false, identifiers: false, logs: false })
    /** The name comes from the plaintext read, before any trust. */
    expect(row?.name).toBe('Ngọc’s iPhone 12 Pro')
    const before = rig.mux.messages.filter((m) => m === 'ReadPairRecord').length
    await new Promise((resolve) => setTimeout(resolve, 500))
    /** Not active: no polling. */
    expect(rig.mux.messages.filter((m) => m === 'ReadPairRecord').length).toBe(before)
    await rig.activate()
    await until(
      () => rig.mux.messages.filter((m) => m === 'ReadPairRecord').length > before,
      2_000,
      'poll',
    )
    rig.mux.records.set(UDID, pairRecordPlist(chain))
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    /** Never anything that writes the Mac's pairing. */
    expect(rig.mux.messages.filter((m) => /Save|Delete/.test(m))).toEqual([])
    expect(rig.phone.requests.map((r) => r.Request)).not.toContain('Pair')
  })

  it('a Paired event re-probes at once', async () => {
    const rig = await startIosRig({ chain, record: false, tuning: { pairPollMs: 60_000 } })
    await rig.waitRow((r) => r?.state === 'untrusted', 'untrusted')
    rig.mux.records.set(UDID, pairRecordPlist(chain))
    rig.mux.paired(rig.deviceId())
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 2_000)
  })

  it('maps StartSession refusals: InvalidHostID, UserDeniedPairing → untrusted; pending → authorizing; PasswordProtected → locked', async () => {
    const cases = [
      ['InvalidHostID', 'untrusted', 'IOS_UNTRUSTED'],
      ['UserDeniedPairing', 'untrusted', 'IOS_UNTRUSTED'],
      ['PairingDialogResponsePending', 'authorizing', 'IOS_UNTRUSTED'],
      ['PasswordProtected', 'locked', 'IOS_LOCKED'],
      ['tls-reset', 'untrusted', 'IOS_UNTRUSTED'],
    ] as const
    for (const [mode, state, blocker] of cases) {
      const rig = await startIosRig({ chain, script: { startSession: mode } })
      const row = await rig.waitRow((r) => r?.state === state, `${mode} → ${state}`)
      expect(row?.blockers).toEqual([blocker])
    }
  })

  it('a locked or revoked phone is re-probed every 5 s while active, and recovers', async () => {
    const rig = await startIosRig({
      chain,
      script: { startSession: 'PasswordProtected' },
      tuning: { reprobeMs: 200 },
    })
    await rig.waitRow((r) => r?.state === 'locked', 'locked')
    rig.phone.script.startSession = 'trusted'
    await rig.activate()
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
  })

  it('AFU-locked (PasswordProtected in the session) stays ready; the detail says locked', async () => {
    const rig = await startIosRig({
      chain,
      script: { session: sessionKeys({ PasswordProtected: true }) },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(200)
    expect(reply.json<DetailResponse>()).toMatchObject({ kind: 'ios', facts: { locked: true } })
  })

  it('Developer Mode off → blocker and no screenshots; identifiers and logs stay', async () => {
    const rig = await startIosRig({ chain, script: { amfi: false } })
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready')
    expect(row?.blockers[0]).toBe('IOS_DEVELOPER_MODE_OFF')
    expect(row?.capabilities).toMatchObject({ screenshot: false, identifiers: true, logs: true })
    expect(rig.s.logs.some((l) => l.includes('Developer Mode is off'))).toBe(true)
  })

  it('iOS 15: no amfi request, developerMode null, no blocker for it', async () => {
    const rig = await startIosRig({
      chain,
      script: {
        plaintext: plaintextKeys({ ProductVersion: '15.8', ProductType: 'iPhone10,1' }),
        session: sessionKeys({ ProductVersion: '15.8', ProductType: 'iPhone10,1' }),
      },
    })
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready')
    expect(row?.blockers).toEqual(['TOOL_MISSING'])
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.json<DetailResponse>()).toMatchObject({ facts: { developerMode: null } })
    expect(rig.phone.requests.some((r) => r.Domain === 'com.apple.security.mac.amfi')).toBe(false)
  })

  it('QueryType that is not lockdown → unknown; an Apple TV is never listed', async () => {
    const rig = await startIosRig({ chain, script: { queryType: 'com.apple.something' } })
    await rig.waitRow((r) => r?.state === 'unknown', 'unknown')
    const tv = await startIosRig({
      chain,
      script: {
        plaintext: plaintextKeys({ DeviceClass: 'AppleTV', ProductType: 'AppleTV11,1' }),
        session: sessionKeys({ DeviceClass: 'AppleTV', ProductType: 'AppleTV11,1' }),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(tv.row()).toBeNull()
  })

  it('lockdown not answering three times → offline + IOS_LOCKDOWN_FAILED', async () => {
    const rig = await startIosRig({ chain, plugged: false, tuning: { unreachableGapMs: 50 } })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.mux.attach({ deviceId: 999, udid: UDID, connection: 'USB', port: () => null })
    const row = await rig.waitRow((r) => r?.state === 'offline', 'offline')
    expect(row?.blockers).toEqual(['IOS_LOCKDOWN_FAILED'])
    expect(rig.mux.connects.filter((c) => c.deviceId === 999)).toHaveLength(3)
  })

  it('an offline phone is looked at again while active, and comes back', async () => {
    const rig = await startIosRig({
      chain,
      plugged: false,
      tuning: { unreachableGapMs: 50, reprobeMs: 200 },
    })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    let answering = false
    rig.mux.attach({
      deviceId: 998,
      udid: UDID,
      connection: 'USB',
      port: (p) => (answering ? rig.phone.port(p) : null),
    })
    await rig.waitRow((r) => r?.state === 'offline', 'offline')
    answering = true
    await rig.activate()
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
  })
})

describe.skipIf(!hasOpenssl)('iOS lane: detail and whitelists', () => {
  it('returns whitelisted facts, UniqueChipID as a decimal string, and nothing personal anywhere', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(200)
    const detail = reply.json<DetailResponse>()
    expect(detail).toEqual({
      platform: 'ios',
      kind: 'ios',
      facts: {
        udid: UDID,
        connection: 'usb',
        source: 'lockdown',
        device: {
          DeviceName: 'Ngọc’s iPhone 12 Pro',
          DeviceClass: 'iPhone',
          ProductType: 'iPhone13,3',
          ProductVersion: '27.0',
          BuildVersion: '24A437',
          SerialNumber: 'F2LXXXXXXXXX',
          HardwareModel: 'D53pAP',
          ModelNumber: 'MGM93',
          RegionInfo: 'VN/A',
          CPUArchitecture: 'arm64e',
          TimeZone: 'Asia/Ho_Chi_Minh',
          UniqueChipID: BIG_ECID.toString(),
        },
        battery: {
          BatteryCurrentCapacity: 87,
          BatteryIsCharging: false,
          ExternalConnected: true,
          FullyCharged: false,
        },
        disk: {
          TotalDiskCapacity: 256000000000,
          TotalDataCapacity: 247531839488,
          TotalDataAvailable: 160951455744,
          AmountDataAvailable: 40063803392,
        },
        international: { Language: 'vi', Locale: 'vi_VN' },
        developerMode: true,
        locked: false,
        withheld: [],
      },
    })
    const devices = await request(rig.s.port, { path: '/api/devices', headers: rig.s.auth })
    for (const text of [reply.text, devices.text, rig.s.logs.join('\n')]) {
      for (const secret of SECRETS) expect(text).not.toContain(secret)
    }
  })

  it('lists refused domains as withheld and caches the detail for 5 s', async () => {
    const rig = await startIosRig({ chain, script: { amfi: 'PasswordProtected' } })
    rig.phone.script.domains = {
      ...rig.phone.script.domains,
      'com.apple.mobile.battery': 'PasswordProtected',
      'com.apple.disk_usage': 'GetProhibited',
    }
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    const first = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(first.json<{ facts: { withheld: string[] } }>().facts.withheld).toEqual([
      'battery',
      'disk',
      'developerMode',
    ])
    const sessions = rig.phone.requests.filter((r) => r.Request === 'StartSession').length
    await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(rig.phone.requests.filter((r) => r.Request === 'StartSession').length).toBe(sessions)
  })

  it('a link that drops inside the detail session → 502 IOS_UNREACHABLE, never a helper bug', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    rig.phone.script.sessionGetValue = 'drop'
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(502)
    expect(reply.json<ErrorBody>().error.code).toBe('IOS_UNREACHABLE')
    expect(rig.s.errors).toEqual([])
  })

  it('lockdownd refusing the session’s GetValue goes through the row like a StartSession refusal', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    rig.phone.script.sessionGetValue = 'InvalidHostID'
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(409)
    expect(reply.json<ErrorBody>().error).toMatchObject({ code: 'IOS_UNTRUSTED' })
    expect(rig.s.errors).toEqual([])
  })

  it('a revoked trust found by the detail → 409 IOS_UNTRUSTED and an untrusted row', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    rig.phone.script.startSession = 'InvalidHostID'
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(409)
    expect(reply.json<ErrorBody>().error).toMatchObject({
      code: 'IOS_UNTRUSTED',
      state: 'untrusted',
    })
    await rig.waitRow((r) => r?.state === 'untrusted', 'untrusted')
  })
})

describe.skipIf(!hasOpenssl)('iOS lane: TLS failures', () => {
  it('a synchronous TLS throw falls back to ideviceinfo when it is installed', async () => {
    const toolsRef: { current: Toolbox | null } = { current: null }
    const rig = await startIosRig({
      chain,
      plugged: false,
      toolsRef,
      bridge: { timeouts: { toolsCache: 0 } },
    })
    rig.mux.records.set(UDID, pairRecordPlist(chain, { HostPrivateKey: chain.strayKey }))
    rig.s.bin.fixture('info.plist', buildPlist(sessionKeys()))
    const info = rig.s.bin.tool(
      'ideviceinfo',
      `case "$*" in
  *DeveloperModeStatus*) printf '<plist version="1.0"><true/></plist>' ;;
  *com.apple.mobile.battery*) printf '<plist version="1.0"><dict><key>BatteryCurrentCapacity</key><integer>55</integer></dict></plist>' ;;
  *-q*) echo 'ERROR: Could not connect to lockdownd: Password protected (-17)' >&2; exit 255 ;;
  *) cat "$FAKE_STATE/fixtures/info.plist" ;;
esac`,
    )
    const syslog = rig.s.bin.simple('idevicesyslog')
    toolsRef.current = toolbox((t) => {
      t.ideviceinfo = { path: info, version: '1.4.0' }
      t.idevicesyslog = { path: syslog, version: null }
    })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.plug()
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready')
    expect(row?.capabilities).toMatchObject({ identifiers: true, logs: true })
    expect(rig.s.bin.calls().find((c) => c.name === 'ideviceinfo')?.argv).toEqual([
      '-u',
      UDID,
      '-x',
    ])
    const detail = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(detail.json<DetailResponse>()).toMatchObject({
      facts: {
        source: 'ideviceinfo',
        device: { SerialNumber: 'F2LXXXXXXXXX', UniqueChipID: BIG_ECID.toString() },
        battery: { BatteryCurrentCapacity: 55 },
        developerMode: true,
        withheld: ['disk', 'international'],
      },
    })
    for (const secret of SECRETS) expect(detail.text).not.toContain(secret)
    expect(rig.s.bridge.lanes.ios?.facts().tlsFailures).toHaveLength(1)
  })

  it('never runs ideviceinfo without a pair record (it would ask the phone to trust)', async () => {
    const toolsRef: { current: Toolbox | null } = { current: null }
    const rig = await startIosRig({
      chain,
      record: false,
      plugged: false,
      toolsRef,
      bridge: { timeouts: { toolsCache: 0 } },
    })
    const info = rig.s.bin.simple('ideviceinfo', { stdout: buildPlist(sessionKeys()) })
    toolsRef.current = toolbox((t) => {
      t.ideviceinfo = { path: info, version: '1.4.0' }
    })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.plug()
    await rig.waitRow((r) => r?.state === 'untrusted', 'untrusted')
    expect(rig.s.bin.calls().filter((c) => c.name === 'ideviceinfo')).toEqual([])
  })

  it('without libimobiledevice: plaintext facts, TOOL_MISSING and a tlsFailures fact', async () => {
    const rig = await startIosRig({ chain, plugged: false })
    rig.mux.records.set(UDID, pairRecordPlist(chain, { HostPrivateKey: chain.strayKey }))
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.plug()
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready')
    expect(row?.blockers).toEqual(['TOOL_MISSING', 'XCODE_REQUIRED'])
    expect(row?.capabilities).toMatchObject({ identifiers: true, logs: false, screenshot: false })
    const facts = rig.s.bridge.lanes.ios?.facts()
    expect(facts?.tlsFailures).toEqual([
      expect.objectContaining({ code: expect.stringMatching(/^ERR_/) as unknown }),
    ])
    const detail = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(detail.json<DetailResponse>()).toMatchObject({
      facts: { source: 'plaintext', device: { ProductType: 'iPhone13,3' } },
    })
  })

  it('pinning: a device certificate other than the pair record’s marks the row offline', async () => {
    const rig = await startIosRig({ chain, script: { presentCert: other.device } })
    await rig.waitRow((r) => r?.state === 'offline', 'offline')
    expect(rig.s.logs).toContainEqual(
      expect.stringContaining('certificate differs from the pair record (refused)'),
    )
    /** The probe ended the session at the handshake: nothing was asked over it. */
    const requests = rig.phone.requests.map((r) => r.Request)
    expect(requests.slice(requests.lastIndexOf('StartSession') + 1)).toEqual([])
  })

  it('pinning: a ready row whose phone now presents another certificate refuses the detail', async () => {
    const rig = await startIosRig({ chain, tuning: { reprobeMs: 300 } })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    rig.phone.script.presentCert = other.device
    const reply = await request(rig.s.port, { path: rig.path('detail'), headers: rig.s.auth })
    expect(reply.status).toBe(502)
    expect(reply.json<ErrorBody>().error.code).toBe('IOS_LOCKDOWN_FAILED')
    expect(reply.text).not.toContain('iPhone13,3')
    const row = await rig.waitRow((r) => r?.state === 'offline', 'offline')
    expect(row?.blockers).toEqual(['IOS_LOCKDOWN_FAILED'])
    expect(rig.s.logs).toContainEqual(
      expect.stringContaining('certificate differs from the pair record (refused)'),
    )
    /** The paired phone again: the next probe brings the row back. */
    delete rig.phone.script.presentCert
    await rig.activate()
    await rig.waitRow((r) => r?.state === 'ready', 'ready again')
  })

  it('pinning: with enforcement off, a different certificate is only logged', async () => {
    const rig = await startIosRig({
      chain,
      script: { presentCert: other.device },
      tuning: { enforcePinning: false },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    expect(rig.s.logs.some((l) => l.includes('certificate differs from the pair record'))).toBe(
      true,
    )
  })
})

describe.skipIf(!hasOpenssl)('iOS lane: Wi-Fi, usbmuxd and rescan', () => {
  it('ignores a Wi-Fi-only iPhone without --wifi, and counts it', async () => {
    const rig = await startIosRig({ chain, connection: 'Network' })
    await until(() => rig.s.bridge.registry.lanes().ios.wifiHidden === 1, 2_000, 'wifiHidden')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(rig.row()).toBeNull()
    expect(rig.mux.connects).toEqual([])
  })

  it('with --wifi: shown after 2 s stable, held 30 s after it leaves', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 400, wifiHoldMs: 500 },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rig.row()).toBeNull()
    const row = await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    expect(row?.connection).toBe('network')
    /** Probed once stable, listed when the probe answers: one clean arrival line. */
    expect(rig.s.logs.filter((l) => l.includes('iPhone'))[0]).toMatch(/· Wi-Fi · trusted$/)
    rig.unplug()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rig.row()?.connection).toBe('network')
    await rig.waitRow((r) => r === null, 'dropped after the hold', 2_000)
  })

  it('with --wifi: usbmuxd’s real rhythm (a new DeviceID each return, bursts, strays) never hides the row', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 400, wifiHoldMs: 1_500 },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    const seen: Array<string | null> = []
    const sampler = setInterval(() => seen.push(rig.row()?.state ?? null), 10)
    try {
      const ids = [rig.deviceId()]
      /** Gone for a while, back under a new DeviceID: shown at once, not after another 2 s. */
      rig.unplug()
      await new Promise((resolve) => setTimeout(resolve, 300))
      ids.push(rig.plug('Network'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      /** A burst: back for a moment, away, back again; and a Detached for an id never announced. */
      for (let i = 0; i < 4; i++) {
        rig.unplug()
        await new Promise((resolve) => setTimeout(resolve, 30))
        ids.push(rig.plug('Network'))
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      rig.mux.detach(99_999)
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(new Set(ids).size).toBe(ids.length)
    } finally {
      clearInterval(sampler)
    }
    expect(seen.length).toBeGreaterThan(50)
    expect(seen.filter((state) => state !== 'ready')).toEqual([])
    expect(rig.s.logs.filter((l) => /[+-] Ngọc’s iPhone 12 Pro/.test(l))).toHaveLength(1)
    expect(rig.row()?.connection).toBe('network')
  })

  it('with --wifi: a return whose probe cannot reach the phone keeps the row ready', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 200, wifiHoldMs: 3_000, unreachableGapMs: 50 },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    rig.unplug()
    /** Listed again, but gone before lockdown answers: every Connect is refused. */
    rig.mux.attach({ deviceId: 7_001, udid: UDID, connection: 'Network', port: () => null })
    await until(() => rig.mux.connects.some((c) => c.deviceId === 7_001), 2_000, 'probed')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(rig.row()?.state).toBe('ready')
  })

  it('with --wifi: a probe cut short by the phone leaving again changes nothing', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 200, wifiHoldMs: 3_000 },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    /** What a link cut mid-handshake looks like from here: a reset TLS session ("untrusted"). */
    rig.phone.script.startSession = 'tls-reset'
    rig.phone.script.sessionDelayMs = 300
    rig.unplug()
    const id = rig.plug('Network')
    await until(() => rig.mux.connects.some((c) => c.deviceId === id), 2_000, 'probing')
    rig.unplug()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(rig.row()?.state).toBe('ready')
    rig.phone.script.startSession = 'trusted'
    rig.phone.script.sessionDelayMs = 0
    rig.plug('Network')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(rig.row()?.state).toBe('ready')
  })

  it('with --wifi: a link cut before usbmuxd says Detached still changes nothing', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 200, wifiHoldMs: 3_000 },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    /** The phone is already gone, usbmuxd has not noticed: the handshake resets, nothing more. */
    rig.phone.script.startSession = 'tls-reset'
    rig.unplug()
    const id = rig.plug('Network')
    await until(() => rig.mux.connects.some((c) => c.deviceId === id), 2_000, 'probing')
    const seen: Array<string | null> = []
    const sampler = setInterval(() => seen.push(rig.row()?.state ?? null), 10)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
    } finally {
      clearInterval(sampler)
    }
    expect(seen.filter((state) => state !== 'ready')).toEqual([])
    expect(rig.row()?.blockers).not.toContain('IOS_UNTRUSTED')
  })

  it('with --wifi: the phone’s own refusal (InvalidHostID) still marks a ready row untrusted', async () => {
    const rig = await startIosRig({
      chain,
      connection: 'Network',
      bridge: { wifi: true },
      tuning: { wifiStableMs: 200, wifiHoldMs: 3_000 },
    })
    await rig.waitRow((r) => r?.state === 'ready', 'ready', 3_000)
    rig.phone.script.startSession = 'InvalidHostID'
    rig.unplug()
    rig.plug('Network')
    const row = await rig.waitRow((r) => r?.state === 'untrusted', 'untrusted', 3_000)
    expect(row?.blockers).toEqual(['IOS_UNTRUSTED'])
  })

  it('linkCut: a cut link, never the phone’s answer or a pinning mismatch', () => {
    expect(linkCut({ status: 'offline', reason: 'connect:refused' })).toBe(true)
    expect(linkCut({ status: 'offline', reason: 'lockdown:closed' })).toBe(true)
    expect(linkCut({ status: 'untrusted', reason: 'tls:reset' })).toBe(true)
    expect(linkCut({ status: 'untrusted', reason: 'InvalidHostID' })).toBe(false)
    expect(linkCut({ status: 'untrusted', reason: 'pair-record:none' })).toBe(false)
    expect(linkCut({ status: 'locked', reason: 'PasswordProtected' })).toBe(false)
    expect(linkCut({ status: 'authorizing', reason: 'PairingDialogResponsePending' })).toBe(false)
    expect(linkCut({ status: 'offline', reason: 'tls:pin' })).toBe(false)
  })

  it('holds a Wi-Fi row for 120 s by default: usbmuxd’s real gaps run 6–90 s', () => {
    expect(IOS_TUNING.wifiHoldMs).toBe(120_000)
    expect(IOS_TUNING.wifiStableMs).toBe(2_000)
  })

  it('a phone on USB and Wi-Fi is one USB row', async () => {
    const rig = await startIosRig({ chain, bridge: { wifi: true } })
    rig.mux.attach({ deviceId: 5_000, udid: UDID, connection: 'Network', port: rig.phone.port })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(rig.s.bridge.registry.devices()).toHaveLength(1)
    expect(rig.row()?.connection).toBe('usb')
  })

  it('usbmuxd restarts: the lane reports it, reconnects and resyncs', async () => {
    const rig = await startIosRig({ chain, tuning: { muxGraceMs: 5_000 } })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    await rig.mux.stop()
    await until(() => rig.s.bridge.registry.lanes().ios.status === 'error', 2_000, 'error')
    expect(rig.row()?.state).toBe('ready')
    await rig.mux.start()
    await until(() => rig.s.bridge.registry.lanes().ios.status === 'ok', 3_000, 'ok again')
    expect(rig.s.logs.some((l) => l.includes('usbmuxd) stopped answering'))).toBe(true)
    expect(rig.s.logs.some((l) => l.includes('usbmuxd) is back'))).toBe(true)
    await until(
      () => rig.mux.messages.filter((m) => m === 'ListDevices').length >= 2,
      2_000,
      'resync',
    )
    expect(rig.row()?.state).toBe('ready')
  })

  it('a replug while the old probe is still unwinding still probes the new attachment', async () => {
    /** Tool discovery is slow (a stale cache): the old probe's last step outlives the replug. */
    const rig = await startIosRig({
      chain,
      plugged: false,
      script: { sessionDelayMs: 300 },
      bridge: {
        resolveTools: () =>
          new Promise<Toolbox>((resolve) => setTimeout(() => resolve(toolbox()), 600)),
        timeouts: { toolsCache: 0 },
      },
    })
    await until(() => rig.mux.listeners() === 1, 2_000, 'listening')
    rig.plug()
    await until(
      () => rig.phone.requests.some((r) => r.Request === 'StartSession'),
      2_000,
      'first probe in StartSession',
    )
    rig.unplug()
    await new Promise((resolve) => setTimeout(resolve, 50))
    rig.plug()
    await rig.waitRow((r) => r?.state === 'ready', 'ready after the replug', 5_000)
  })

  it('usbmuxd gone for longer than the grace: rows dropped', async () => {
    const rig = await startIosRig({ chain, tuning: { muxGraceMs: 300 } })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    await rig.mux.stop()
    await rig.waitRow((r) => r === null, 'dropped', 2_000)
  })

  it('a missing socket reads as missing in facts() and error in the lane', async () => {
    const rig = await startIosRig({ chain, bridge: { usbmuxdSocket: '/nonexistent/usbmuxd' } })
    await until(() => rig.s.bridge.registry.lanes().ios.status === 'error', 2_000, 'error')
    expect(rig.s.bridge.lanes.ios?.facts().usbmuxd).toBe('missing')
    expect(rig.s.bridge.registry.lanes().ios.reason).toContain('no usbmuxd socket')
  })

  it('rescan re-lists and re-probes; retry re-checks one device', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    const before = rig.phone.requests.filter((r) => r.Request === 'StartSession').length
    const rescan = await request(rig.s.port, {
      method: 'POST',
      path: '/api/rescan',
      headers: rig.s.auth,
    })
    expect(rescan.status).toBe(200)
    expect(rescan.json<Snapshot>().devices).toHaveLength(1)
    expect(rig.phone.requests.filter((r) => r.Request === 'StartSession').length).toBeGreaterThan(
      before,
    )
    rig.phone.script.startSession = 'PasswordProtected'
    const retry = await request(rig.s.port, {
      method: 'POST',
      path: rig.path('retry'),
      headers: rig.s.auth,
    })
    expect(retry.json<{ device: { state: string } }>().device.state).toBe('locked')
  })
})

describe.skipIf(!hasOpenssl)('iOS lane: --doctor', () => {
  it('prints counts and protocol facts, never names, keys or log text', async () => {
    const rig = await startIosRig({ chain })
    await rig.waitRow((r) => r?.state === 'ready', 'ready')
    const lines: string[] = []
    await rig.s.bridge.lanes.ios?.probeForDoctor?.((line) => lines.push(line))
    const text = lines.join('\n')
    expect(text).toContain('iPhone: usbmuxd answers')
    expect(text).toContain('1 device(s) listed by usbmuxd')
    expect(text).toContain(`${UDID} · USB DeviceID`)
    expect(text).toContain('pair record: yes')
    expect(text).toContain('plaintext GetValue: 26 keys')
    expect(text).toContain('StartSession: ok')
    expect(text).toMatch(/TLS: TLSv1\.[23] \S+/)
    expect(text).toContain('PasswordProtected no')
    expect(text).toContain('battery: ok (4 keys kept)')
    expect(text).toContain('amfi DeveloperModeStatus: true')
    expect(text).toContain("peer certificate equals the pair record's DeviceCertificate: yes")
    expect(text).toMatch(/syslog_relay 3 s: \d+ bytes/)
    expect(text).toContain('devicectl lockState: skipped')
    for (const secret of [...SECRETS, 'Ngọc', 'locationd', 'first'])
      expect(text).not.toContain(secret)
  })
})
