/*
  The usbmuxd and lockdown clients against the fake daemons: requests, hot-plug and
  reconnect, Connect pipes, and lockdown's TLS with BOTH pair-record certificate chains
  (empty names, as real records; named, which OpenSSL 3 refuses at its default level).
*/
import tls from 'node:tls'
import { beforeAll, describe, expect, it } from 'vitest'
import { TIMEOUTS } from '../src/constants'
import { LOCKDOWN_PORT, LockdownError, createLockdown, startTls, tlsOptions } from '../src/lockdown'
import { createUsbmux, MuxError, type MuxEvent, type Usbmux } from '../src/usbmuxd'
import { onCleanup, tempDir, until } from './harness'
import { hasOpenssl, makeChain, pairRecord, pairRecordPlist, type Chain } from './fakes/certs'
import { UDID, createFakeLockdownd, defaultScript, type FakeLockdownd } from './fakes/lockdownd'
import { createFakeUsbmuxd, type FakeUsbmuxd } from './fakes/usbmuxd'

const timeouts = {
  ...TIMEOUTS,
  muxRequest: 1_000,
  muxConnectUsb: 1_000,
  lockdownRequest: 1_000,
  lockdownTls: 2_000,
}

let chains: Record<'empty' | 'named', Chain>
beforeAll(() => {
  if (!hasOpenssl) return
  const dir = tempDir('certs-')
  chains = { empty: makeChain(dir, 'empty'), named: makeChain(dir, 'named') }
}, 30_000)

async function fakeMux(): Promise<FakeUsbmuxd> {
  const mux = await createFakeUsbmuxd()
  onCleanup(() => mux.close())
  return mux
}

function client(mux: FakeUsbmuxd, reconnectMs: number[] = [50]): Usbmux {
  return createUsbmux({ socketPath: mux.path, timeouts, reconnectMs })
}

function phone(mux: FakeUsbmuxd, chain: Chain | null, deviceId = 7): FakeLockdownd {
  const lockdownd = createFakeLockdownd(defaultScript(chain))
  mux.attach({ deviceId, udid: UDID, connection: 'USB', port: lockdownd.port })
  if (chain) mux.records.set(UDID, pairRecordPlist(chain))
  return lockdownd
}

describe('usbmuxd client', () => {
  it('lists devices and reads BUID with one connection per request', async () => {
    const mux = await fakeMux()
    phone(mux, null)
    const usbmux = client(mux)
    const list = await usbmux.listDevices()
    expect(list).toEqual([
      expect.objectContaining({
        DeviceID: 7,
        Properties: expect.objectContaining({
          ConnectionType: 'USB',
          SerialNumber: UDID,
        }) as unknown,
      }),
    ])
    expect(await usbmux.readBuid()).toBe('FAKE-SYSTEM-BUID')
    expect(mux.messages).toEqual(['ListDevices', 'ReadBUID'])
  })
  it('reads a pair record, or null for Result 2', async () => {
    const mux = await fakeMux()
    const usbmux = client(mux)
    expect(await usbmux.readPairRecord(UDID)).toBeNull()
    mux.records.set(UDID, {
      HostID: 'H',
      SystemBUID: 'S',
      HostCertificate: Buffer.from('c'),
      HostPrivateKey: Buffer.from('k'),
      DeviceCertificate: Buffer.from('d'),
      RootPrivateKey: Buffer.from('never kept'),
    })
    const record = await usbmux.readPairRecord(UDID)
    expect(record).toMatchObject({ HostID: 'H', SystemBUID: 'S' })
    expect(record).not.toHaveProperty('RootPrivateKey')
  })
  it('refuses to send anything outside MUX_MESSAGES', () => {
    const usbmux = createUsbmux({ socketPath: '/nonexistent', timeouts })
    expect(() => usbmux.request({ MessageType: 'SavePairRecord' as 'Listen' })).toThrow(
      /never sends/,
    )
  })
  it('says missing when there is no socket, and times out on a silent one', async () => {
    const usbmux = createUsbmux({ socketPath: '/nonexistent/usbmuxd', timeouts })
    await expect(usbmux.listDevices()).rejects.toMatchObject({ code: 'missing' })
    const mux = await fakeMux()
    mux.garbageOnce = true
    await expect(client(mux).listDevices()).rejects.toBeInstanceOf(MuxError)
  })
  it('connects to a device port in network byte order and hands over a raw pipe', async () => {
    const mux = await fakeMux()
    phone(mux, null)
    const usbmux = client(mux)
    const socket = await usbmux.connect(7, LOCKDOWN_PORT)
    expect(mux.connects).toEqual([{ deviceId: 7, port: 62078 }])
    const lockdown = createLockdown(socket, { timeouts })
    expect(await lockdown.queryType()).toBe('com.apple.mobile.lockdown')
    lockdown.close()
    await expect(usbmux.connect(7, 1234)).rejects.toMatchObject({ code: 'result', result: 3 })
    await expect(usbmux.connect(99, LOCKDOWN_PORT)).rejects.toMatchObject({ code: 'result' })
  })
  it('watches Attached, Detached and Paired, and reconnects after usbmuxd restarts', async () => {
    const mux = await fakeMux()
    const usbmux = client(mux)
    const events: MuxEvent[] = []
    const stop = usbmux.watch((event) => events.push(event))
    onCleanup(stop)
    await until(() => events.some((e) => e.type === 'listening'), 2_000, 'listening')
    phone(mux, null, 11)
    mux.paired(11)
    mux.detach(11)
    await until(() => events.length >= 4, 2_000, 'events')
    expect(events.map((e) => e.type)).toEqual(['listening', 'attached', 'paired', 'detached'])

    await mux.stop()
    await until(() => events.some((e) => e.type === 'disconnected'), 2_000, 'disconnected')
    await mux.start()
    await until(() => events.filter((e) => e.type === 'listening').length === 2, 3_000, 'relisten')
    expect(mux.listeners()).toBe(1)
    stop()
    await until(() => mux.listeners() === 0, 2_000, 'unwatched')
  })
})

describe('lockdown client', () => {
  it('reads plaintext values before a session and refuses Pair', async () => {
    const mux = await fakeMux()
    const lockdownd = phone(mux, null)
    const lockdown = createLockdown(await client(mux).connect(7, LOCKDOWN_PORT), { timeouts })
    onCleanup(lockdown.close)
    expect(await lockdown.queryType()).toBe('com.apple.mobile.lockdown')
    const all = (await lockdown.getValue()) as Record<string, unknown>
    expect(Object.keys(all)).toHaveLength(26)
    expect(() => lockdown.send({ Request: 'Pair' })).toThrow(/never sends/)
    expect(() => lockdown.send({ Request: 'SetValue', Key: 'DeviceName', Value: 'x' })).toThrow()
    expect(lockdownd.requests.map((r) => r.Request)).toEqual(['QueryType', 'GetValue'])
    expect(lockdownd.requests.every((r) => r.Label === 'device-bridge')).toBe(true)
  })

  for (const kind of ['empty', 'named'] as const) {
    it.skipIf(!hasOpenssl)(
      `opens a TLS session with the ${kind}-name chain and the §3.3 options`,
      async () => {
        const mux = await fakeMux()
        const lockdownd = phone(mux, chains[kind])
        const usbmux = client(mux)
        const record = await usbmux.readPairRecord(UDID)
        if (!record) throw new Error('no record')
        const lockdown = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), { timeouts })
        onCleanup(lockdown.close)
        const session = await lockdown.startSession(record)
        expect(session.tls).not.toBeNull()
        expect(session.protocol).toMatch(/^TLSv1\.[23]$/)
        expect(session.peerMatches).toBe(true)
        const all = (await lockdown.getValue()) as Record<string, unknown>
        expect(all.PasswordProtected).toBe(false)
        expect(await lockdown.getValue('com.apple.security.mac.amfi', 'DeveloperModeStatus')).toBe(
          true,
        )
        expect(lockdownd.peerSeen).toBe(true)
        await lockdown.stopSession()
        const sent = lockdownd.requests.find((r) => r.Request === 'StartSession')
        expect(sent).toMatchObject({ HostID: record.HostID, SystemBUID: record.SystemBUID })
      },
    )
  }

  it.skipIf(!hasOpenssl)(
    'the named chain throws synchronously under default TLS options (why SECLEVEL=0)',
    async () => {
      const mux = await fakeMux()
      phone(mux, chains.named)
      const raw = await client(mux).connect(7, LOCKDOWN_PORT)
      onCleanup(() => raw.destroy())
      let code = ''
      try {
        tls
          .connect({
            socket: raw,
            cert: chains.named.host.cert,
            key: chains.named.host.key,
            rejectUnauthorized: false,
          })
          .destroy()
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code ?? 'thrown'
      }
      /** Builds with a lower default level connect; the point is that ours never depends on it. */
      expect(['ERR_SSL_CA_MD_TOO_WEAK', '']).toContain(code)
      expect(tlsOptions(pairRecord(chains.named), raw).ciphers).toBe('DEFAULT:@SECLEVEL=0')
    },
  )

  it.skipIf(!hasOpenssl)(
    'turns a synchronous TLS throw (a key that does not match) into tls-failed',
    async () => {
      const mux = await fakeMux()
      phone(mux, chains.empty)
      const usbmux = client(mux)
      const lockdown = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), { timeouts })
      onCleanup(lockdown.close)
      const bad = pairRecord(chains.empty, { HostPrivateKey: chains.empty.strayKey })
      const error = await lockdown.startSession(bad).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LockdownError)
      expect(error).toMatchObject({ code: 'tls-failed' })
      expect((error as LockdownError).detail).toMatch(/^ERR_/)
    },
  )

  it.skipIf(!hasOpenssl)(
    'reads a hang-up right after StartSession as tls-reset (untrusted)',
    async () => {
      const mux = await fakeMux()
      const lockdownd = phone(mux, chains.empty)
      lockdownd.script.startSession = 'tls-reset'
      const lockdown = createLockdown(await client(mux).connect(7, LOCKDOWN_PORT), { timeouts })
      onCleanup(lockdown.close)
      await expect(lockdown.startSession(pairRecord(chains.empty))).rejects.toMatchObject({
        code: 'tls-reset',
      })
    },
  )

  it.skipIf(!hasOpenssl)('reports a peer certificate that is not the pair record’s', async () => {
    const mux = await fakeMux()
    const lockdownd = phone(mux, chains.empty)
    lockdownd.script.presentCert = chains.named.device
    const usbmux = client(mux)
    const record = await usbmux.readPairRecord(UDID)
    if (!record) throw new Error('no record')
    const lockdown = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), { timeouts })
    onCleanup(lockdown.close)
    expect((await lockdown.startSession(record)).peerMatches).toBe(false)
  })

  it.skipIf(!hasOpenssl)(
    'with pin on, ends a session and a service handshake that present another certificate',
    async () => {
      const mux = await fakeMux()
      const lockdownd = phone(mux, chains.empty)
      const usbmux = client(mux)
      const record = await usbmux.readPairRecord(UDID)
      if (!record) throw new Error('no record')

      const pinned = { timeouts, pin: true }
      const good = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), pinned)
      onCleanup(good.close)
      expect((await good.startSession(record)).peerMatches).toBe(true)
      await good.startService('com.apple.syslog_relay')

      lockdownd.script.servicePresentCert = chains.named.device
      const raw = await usbmux.connect(7, (await good.startService('com.apple.syslog_relay')).port)
      await expect(startTls(raw, record, 2_000, { pin: true })).rejects.toMatchObject({
        code: 'tls-pin',
      })
      expect(raw.destroyed).toBe(true)

      lockdownd.script.presentCert = chains.named.device
      const bad = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), pinned)
      onCleanup(bad.close)
      await expect(bad.startSession(record)).rejects.toMatchObject({ code: 'tls-pin' })
      /** Nothing more goes over it. */
      await expect(bad.getValue()).rejects.toMatchObject({ code: 'tls-pin' })
    },
  )

  it('passes lockdown refusals through raw, and closes on a timeout', async () => {
    const dummy = {
      HostID: 'H',
      SystemBUID: 'S',
      HostCertificate: Buffer.alloc(0),
      HostPrivateKey: Buffer.alloc(0),
      DeviceCertificate: Buffer.alloc(0),
    }
    const mux = await fakeMux()
    const lockdownd = phone(mux, null)
    const usbmux = client(mux)
    for (const mode of [
      'InvalidHostID',
      'PasswordProtected',
      'PairingDialogResponsePending',
    ] as const) {
      lockdownd.script.startSession = mode
      const lockdown = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), { timeouts })
      await expect(lockdown.startSession(dummy)).rejects.toMatchObject({ code: mode })
      lockdown.close()
    }
    lockdownd.script.startSession = 'trusted'
    lockdownd.script.sessionDelayMs = 2_000
    const slow = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), {
      timeouts: { lockdownRequest: 200, lockdownTls: 200 },
    })
    await expect(slow.startSession(dummy)).rejects.toMatchObject({ code: 'timeout' })
    await expect(slow.queryType()).rejects.toMatchObject({ code: 'timeout' })
  })

  it.skipIf(!hasOpenssl)('starts syslog_relay with service TLS', async () => {
    const mux = await fakeMux()
    phone(mux, chains.empty)
    const usbmux = client(mux)
    const record = await usbmux.readPairRecord(UDID)
    if (!record) throw new Error('no record')
    const lockdown = createLockdown(await usbmux.connect(7, LOCKDOWN_PORT), { timeouts })
    onCleanup(lockdown.close)
    await lockdown.startSession(record)
    const service = await lockdown.startService('com.apple.syslog_relay')
    expect(service.ssl).toBe(true)
    const raw = await usbmux.connect(7, service.port)
    const { socket } = await startTls(raw, record, 2_000)
    onCleanup(() => socket.destroy())
    const received = await new Promise<string>((resolve) =>
      socket.once('data', (d: Buffer) => resolve(d.toString())),
    )
    expect(received).toContain('locationd[27551] <Notice>: first\n\0')
    await lockdown.stopSession()
  })
})
