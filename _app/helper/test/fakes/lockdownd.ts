/*
  A fake iPhone behind the fake usbmuxd: lockdownd on port 62078 and syslog_relay on a
  service port, scripted per test.

  - Plaintext QueryType and GetValue, with the 26 keys a real phone answers over USB [V],
    including the ones the helper must drop (WiFiAddress, BasebandSerialNumber, DieID…).
  - StartSession modes: trusted (then server-side TLS with requestCert, like lockdownd),
    InvalidHostID, PasswordProtected (BFU), PairingDialogResponsePending, UserDeniedPairing,
    tls-reset (the phone hangs up on the handshake), slow, and no-ssl.
  - The session's GetValue carries IMEI, PhoneNumber, ICCID, MAC addresses and a
    UniqueChipID above 2^64 − 2^53, so the whitelist tests have something to catch.
  - Domains, amfi's DeveloperModeStatus (explicit key only, as on a real phone), and
    syslog_relay: NUL-terminated messages, some with inner newlines.
  - Failures mid-operation: another certificate on the session or on the service only, a
    session GetValue that drops the link or is refused, a service that holds its handshake.
  Every request is recorded as received.
*/
import type { Socket } from 'node:net'
import tls from 'node:tls'
import { createIosLane, type IosTuning } from '../../src/ios-lane'
import { createLockdownReader, encodeLockdownFrame } from '../../src/lockdown'
import type { PlistInput, PlistValue } from '../../src/plist'
import type { Toolbox } from '../../src/tools'
import type { BridgeInput, HelperDevice } from '../../src/types'
import { onCleanup, request, startBridge, toolbox, until, type Started } from '../harness'
import { pairRecordPlist, type Chain } from './certs'
import { createFakeUsbmuxd, type FakeMuxDevice, type FakeUsbmuxd } from './usbmuxd'

export const UDID = '00008101-000A1B2C3D4E5F02'
export const SYSLOG_PORT = 49_321

export type SessionMode =
  | 'trusted'
  | 'no-ssl'
  | 'InvalidHostID'
  | 'PasswordProtected'
  | 'PairingDialogResponsePending'
  | 'UserDeniedPairing'
  | 'tls-reset'

export interface SyslogScript {
  ssl: boolean
  /** Written once the service connects (and after TLS when ssl). */
  messages: string[]
  /** Then the same messages again every interval, until the client leaves. 0 = once. */
  intervalMs: number
  /** Close the service after the messages instead of staying open. */
  closeAfter?: boolean
  /** Hold a new service connection this long before its TLS handshake (or first bytes). */
  holdMs?: number
}

export interface LockdowndScript {
  queryType: string
  plaintext: Record<string, PlistInput>
  session: Record<string, PlistInput>
  /** A dictionary, or a lockdown Error string. */
  domains: Record<string, Record<string, PlistInput> | string>
  /** DeveloperModeStatus, an Error string, or undefined (MissingValue). */
  amfi: boolean | string | undefined
  startSession: SessionMode
  /** Delay before answering StartSession. */
  sessionDelayMs: number
  /** The chain whose Device certificate and key the phone presents. */
  chain: Chain | null
  /** Present this certificate instead of the chain's (pinning mismatch). */
  presentCert?: { cert: Buffer; key: Buffer }
  /** Present this certificate on the syslog_relay service only. */
  servicePresentCert?: { cert: Buffer; key: Buffer }
  /**
   * The session's whole-device GetValue: 'drop' closes the connection when it arrives (a
   * Wi-Fi link that went), any other string is answered as a lockdown Error.
   */
  sessionGetValue?: string
  /** StartService answer: a service, or a lockdown Error string. */
  syslog: SyslogScript | string
}

export interface FakeLockdownd {
  script: LockdowndScript
  readonly requests: Array<Record<string, PlistValue>>
  /** Plug into FakeMuxDevice.port. */
  readonly port: FakeMuxDevice['port']
  /** Service connections opened and when each closed (ms since epoch), for abort tests. */
  readonly services: Array<{ openedAt: number; closedAt: number | null }>
  /** A HostCertificate the phone saw in the session handshake, or null. */
  peerSeen: boolean
}

export const BIG_ECID = 18446744073709550001n

export function plaintextKeys(patch: Record<string, PlistInput> = {}): Record<string, PlistInput> {
  return {
    ActivationState: 'Activated',
    BasebandCertId: 3554301762,
    BasebandKeyHashInformation: { AKeyStatus: 2 },
    BasebandSerialNumber: Buffer.from('c0ffee00', 'hex'),
    BasebandVersion: '5.00.00',
    BoardId: 12,
    BuildVersion: '24A437',
    CPUArchitecture: 'arm64e',
    ChipID: 33025,
    DeviceClass: 'iPhone',
    DeviceColor: '1',
    DeviceName: 'Ngọc’s iPhone 12 Pro',
    DieID: 1234567890123,
    HardwareModel: 'D53pAP',
    HasSiDP: true,
    PartitionType: 'GUID_partition_scheme',
    ProductName: 'iPhone OS',
    ProductType: 'iPhone13,3',
    ProductVersion: '27.0',
    ProductionSOC: true,
    ProtocolVersion: '2',
    SupportedDeviceFamilies: [1],
    TelephonyCapability: true,
    UniqueChipID: BIG_ECID,
    UniqueDeviceID: UDID,
    WiFiAddress: 'aa:bb:cc:00:11:22',
    ...patch,
  }
}

export function sessionKeys(patch: Record<string, PlistInput> = {}): Record<string, PlistInput> {
  return {
    ...plaintextKeys(),
    BluetoothAddress: 'aa:bb:cc:00:11:23',
    DevicePublicKey: Buffer.from('public key'),
    EthernetAddress: 'aa:bb:cc:00:11:24',
    IntegratedCircuitCardIdentity: '89840000000000000000',
    InternationalMobileEquipmentIdentity: '350000000000000',
    InternationalMobileEquipmentIdentity2: '350000000000001',
    InternationalMobileSubscriberIdentity: '452040000000000',
    MobileEquipmentIdentifier: '35000000000000',
    ModelNumber: 'MGM93',
    NonVolatileRAM: { 'boot-args': Buffer.from('') },
    PasswordProtected: false,
    PhoneNumber: '+84 90 000 0000',
    RegionInfo: 'VN/A',
    SerialNumber: 'F2LXXXXXXXXX',
    TimeZone: 'Asia/Ho_Chi_Minh',
    ...patch,
  }
}

export function domainKeys(): Record<string, Record<string, PlistInput>> {
  return {
    'com.apple.mobile.battery': {
      BatteryCurrentCapacity: 87,
      BatteryIsCharging: false,
      ExternalConnected: true,
      FullyCharged: false,
      GasGaugeCapability: true,
    },
    'com.apple.disk_usage': {
      AmountDataAvailable: 40063803392,
      NANDInfo: Buffer.alloc(8, 1),
      TotalDataAvailable: 160951455744,
      TotalDataCapacity: 247531839488,
      TotalDiskCapacity: 256000000000,
    },
    'com.apple.international': { Language: 'vi', Locale: 'vi_VN', Keyboards: ['vi_VN'] },
  }
}

export function defaultScript(chain: Chain | null): LockdowndScript {
  return {
    queryType: 'com.apple.mobile.lockdown',
    plaintext: plaintextKeys(),
    session: sessionKeys(),
    domains: domainKeys(),
    amfi: true,
    startSession: 'trusted',
    sessionDelayMs: 0,
    chain,
    syslog: {
      ssl: true,
      messages: [
        'Oct  4 08:19:52 Ngocs-iPhone-12-Pro locationd[27551] <Notice>: first\n',
        'Oct  4 08:19:52 Ngocs-iPhone-12-Pro SpringBoard[60] <Error>: two\nlines\n',
      ],
      intervalMs: 0,
    },
  }
}

function serverTls(
  raw: Socket,
  script: LockdowndScript,
  onSecure: (socket: tls.TLSSocket) => void,
  service = false,
): void {
  const present =
    (service ? script.servicePresentCert : undefined) ?? script.presentCert ?? script.chain?.device
  if (!present) {
    raw.destroy()
    return
  }
  const socket = new tls.TLSSocket(raw, {
    isServer: true,
    requestCert: true,
    rejectUnauthorized: false,
    secureContext: tls.createSecureContext({
      cert: present.cert,
      key: present.key,
      ciphers: 'DEFAULT:@SECLEVEL=0',
    }),
  })
  socket.on('error', () => undefined)
  socket.once('secure', () => onSecure(socket))
}

export function createFakeLockdownd(script: LockdowndScript): FakeLockdownd {
  const requests: Array<Record<string, PlistValue>> = []
  const services: FakeLockdownd['services'] = []
  const fake: FakeLockdownd = {
    script,
    requests,
    services,
    peerSeen: false,
    port(port) {
      if (port === 62078) return lockdown
      const s = fake.script.syslog
      if (port === SYSLOG_PORT && typeof s !== 'string') return (socket) => syslog(socket, s)
      return null
    },
  }

  function syslog(raw: Socket, s: SyslogScript): void {
    const record = { openedAt: Date.now(), closedAt: null as number | null }
    services.push(record)
    raw.on('error', () => undefined)
    raw.on('close', () => {
      record.closedAt = Date.now()
    })
    const run = (socket: Socket): void => {
      let timer: NodeJS.Timeout | undefined
      const write = (): void => {
        if (socket.destroyed) return
        socket.write(Buffer.concat(s.messages.map((m) => Buffer.from(m + '\0'))))
      }
      write()
      if (s.closeAfter) socket.end()
      else if (s.intervalMs > 0) timer = setInterval(write, s.intervalMs)
      socket.on('close', () => clearInterval(timer))
    }
    const start = (): void => {
      if (raw.destroyed) return
      if (s.ssl) serverTls(raw, fake.script, run, true)
      else run(raw)
    }
    if (s.holdMs) {
      raw.pause()
      setTimeout(start, s.holdMs)
    } else start()
  }

  function lockdown(raw: Socket): void {
    raw.on('error', () => undefined)
    let inSession = false
    let current: Socket = raw
    const reply = (body: Record<string, PlistInput>): void => {
      current.write(encodeLockdownFrame(body))
    }
    const handle = (body: Record<string, PlistValue>): void => {
      requests.push(body)
      const s = fake.script
      const request = typeof body.Request === 'string' ? body.Request : ''
      switch (request) {
        case 'QueryType':
          return reply({ Request: 'QueryType', Type: s.queryType })
        case 'GetValue': {
          const domain = typeof body.Domain === 'string' ? body.Domain : undefined
          const key = typeof body.Key === 'string' ? body.Key : undefined
          if (!inSession) {
            if (domain) return reply({ Request: 'GetValue', Error: 'MissingValue' })
            if (key) return reply({ Request: 'GetValue', Key: key, Value: s.plaintext[key] ?? '' })
            return reply({ Request: 'GetValue', Value: s.plaintext })
          }
          if (domain === 'com.apple.security.mac.amfi') {
            if (key !== 'DeveloperModeStatus') return reply({ Request: 'GetValue', Value: {} })
            if (typeof s.amfi === 'boolean') return reply({ Request: 'GetValue', Value: s.amfi })
            return reply({ Request: 'GetValue', Error: s.amfi ?? 'MissingValue' })
          }
          if (domain) {
            const value = s.domains[domain]
            if (value === undefined) return reply({ Request: 'GetValue', Error: 'MissingValue' })
            if (typeof value === 'string') return reply({ Request: 'GetValue', Error: value })
            return reply({ Request: 'GetValue', Domain: domain, Value: value })
          }
          if (key) {
            const value = s.session[key]
            if (value === undefined) return reply({ Request: 'GetValue', Error: 'MissingValue' })
            return reply({ Request: 'GetValue', Key: key, Value: value })
          }
          if (s.sessionGetValue === 'drop') {
            current.destroy()
            raw.destroy()
            return
          }
          if (s.sessionGetValue) return reply({ Request: 'GetValue', Error: s.sessionGetValue })
          return reply({ Request: 'GetValue', Value: s.session })
        }
        case 'StartSession': {
          const answer = (): void => {
            switch (s.startSession) {
              case 'trusted':
              case 'no-ssl':
              case 'tls-reset': {
                const ssl = s.startSession !== 'no-ssl'
                reply({ Request: 'StartSession', SessionID: 'FAKE-SESSION', EnableSessionSSL: ssl })
                if (s.startSession === 'tls-reset') {
                  raw.end()
                  return
                }
                inSession = true
                if (ssl) {
                  raw.removeAllListeners('data')
                  serverTls(raw, s, (secure) => {
                    fake.peerSeen = secure.getPeerCertificate()?.raw !== undefined
                    current = secure
                    secure.on('data', onData)
                  })
                }
                return
              }
              default:
                return reply({ Request: 'StartSession', Error: s.startSession })
            }
          }
          if (s.sessionDelayMs > 0) setTimeout(answer, s.sessionDelayMs)
          else answer()
          return
        }
        case 'StartService': {
          if (!inSession) return reply({ Request: 'StartService', Error: 'InvalidHostID' })
          if (body.Service !== 'com.apple.syslog_relay') {
            return reply({ Request: 'StartService', Error: 'InvalidService' })
          }
          if (typeof s.syslog === 'string')
            return reply({ Request: 'StartService', Error: s.syslog })
          return reply({
            Request: 'StartService',
            Service: 'com.apple.syslog_relay',
            Port: SYSLOG_PORT,
            EnableServiceSSL: s.syslog.ssl,
          })
        }
        case 'StopSession':
          inSession = false
          return reply({ Request: 'StopSession' })
        default:
          /** What a real phone does with a request it will not serve to this host. */
          return reply({ Request: request, Error: 'InvalidRequest' })
      }
    }
    const reader = createLockdownReader(handle)
    const onData = (chunk: Buffer): void => {
      try {
        reader.push(chunk)
      } catch {
        current.destroy()
      }
    }
    raw.on('data', onData)
    raw.resume()
  }

  return fake
}

/* ------------------------------------------------------------------- the rig --- */

/**
 * The iOS lane suites' setup: a fake usbmuxd, one fake iPhone on it, and a listening bridge
 * running the REAL iOS lane against them, with a fixed Toolbox (no discovery runs).
 */
export interface IosRig {
  readonly s: Started
  readonly mux: FakeUsbmuxd
  readonly phone: FakeLockdownd
  readonly deviceId: () => number
  /** The phone's row in the bridge's snapshot, or null. */
  readonly row: () => HelperDevice | null
  readonly waitRow: (
    match: (row: HelperDevice | null) => boolean,
    what?: string,
    ms?: number,
  ) => Promise<HelperDevice | null>
  /** An authenticated request: the §1.3 cadences run while the page is active. */
  readonly activate: () => Promise<void>
  /** Plug the phone in again (a new DeviceID, as usbmuxd assigns). */
  readonly plug: (connection?: 'USB' | 'Network') => number
  readonly unplug: () => void
  readonly path: (action: string) => string
}

export interface IosRigOptions {
  chain?: Chain | null
  script?: Partial<LockdowndScript>
  /** Store a pair record for the phone (default: when there is a chain). */
  record?: boolean
  /** Plug the phone in before the bridge starts (default true). */
  plugged?: boolean
  connection?: 'USB' | 'Network'
  tools?: (t: Toolbox) => void
  /** Called on every resolveTools(), so a test can change the tools mid-run. */
  toolsRef?: { current: Toolbox | null }
  tuning?: Partial<IosTuning>
  bridge?: BridgeInput
  udid?: string
}

let nextDeviceId = 100

export async function startIosRig(opts: IosRigOptions = {}): Promise<IosRig> {
  const chain = opts.chain ?? null
  const udid = opts.udid ?? UDID
  const mux = await createFakeUsbmuxd()
  onCleanup(() => mux.close())
  const phone = createFakeLockdownd({ ...defaultScript(chain), ...opts.script })
  if (chain && opts.record !== false) mux.records.set(udid, pairRecordPlist(chain))
  let current = 0
  const plug = (connection: 'USB' | 'Network' = opts.connection ?? 'USB'): number => {
    current = nextDeviceId++
    mux.attach({ deviceId: current, udid, connection, port: phone.port })
    return current
  }
  if (opts.plugged !== false) plug()
  const box = toolbox(opts.tools)
  const s = await startBridge({
    usbmuxdSocket: mux.path,
    lanes: {
      ios: (ctx) =>
        createIosLane(ctx, {
          tickMs: 50,
          connectingGraceMs: 300,
          reconnectMs: [100],
          ...opts.tuning,
        }),
    },
    resolveTools: () => Promise.resolve(opts.toolsRef?.current ?? box),
    ...opts.bridge,
    timeouts: {
      muxRequest: 1_000,
      muxConnectUsb: 1_000,
      muxConnectNetwork: 1_000,
      lockdownRequest: 1_500,
      lockdownTls: 2_000,
      probeTotal: 6_000,
      detailTotal: 6_000,
      domain: 1_000,
      ...opts.bridge?.timeouts,
    },
  })
  const row = (): HelperDevice | null => s.bridge.registry.device(udid)
  return {
    s,
    mux,
    phone,
    deviceId: () => current,
    row,
    async waitRow(match, what = 'row', ms = 4_000) {
      await until(() => match(row()), ms, what)
      return row()
    },
    async activate() {
      await request(s.port, { path: '/api/devices', headers: s.auth })
    },
    plug,
    unplug: () => mux.detach(current),
    path: (action) => `/api/devices/${encodeURIComponent(udid)}/${action}`,
  }
}
