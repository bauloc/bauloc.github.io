/*
  A fake usbmuxd: a Unix socket speaking the 16-byte framing, with the helper's own codec
  (encodeMuxFrame, createMuxReader), so a framing bug shows up as a codec test failure
  rather than as two wrong halves agreeing.

  - ListDevices, ReadBUID, ReadPairRecord (a record, or `Result 2`).
  - Listen: Result 0, then Attached / Detached / Paired pushed by the test.
  - Connect: the same socket becomes a pipe to an in-process fake device, by port; an
    unknown port answers `Result 3` (refused), as usbmuxd does. Detached closes the pipes
    to that DeviceID, as a pulled cable or a dropped Wi-Fi link does.
  - stop() and start() simulate usbmuxd dying and coming back (same path).
  Every MessageType received is recorded, so a test can prove what was never sent.
*/
import { mkdtempSync, rmSync } from 'node:fs'
import net, { type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildPlist, type PlistInput } from '../../src/plist'
import { createMuxReader, encodeMuxFrame } from '../../src/usbmuxd'

export interface FakeMuxDevice {
  deviceId: number
  udid: string
  connection: 'USB' | 'Network'
  /** The handler for a pipe to `port` on the device, or null (refused). */
  port: (port: number) => ((socket: Socket) => void) | null
  /** Extra Properties, as a real entry carries (ProductID, LocationID…). */
  properties?: Record<string, PlistInput>
}

export interface FakeUsbmuxd {
  readonly path: string
  readonly attach: (device: FakeMuxDevice) => void
  readonly detach: (deviceId: number) => void
  readonly paired: (deviceId: number) => void
  /** UDID → the pair record plist; absent = `Result 2`. */
  readonly records: Map<string, Record<string, PlistInput>>
  /** Every MessageType received, in order. */
  readonly messages: string[]
  /** Connect requests: device and (host order) port. */
  readonly connects: Array<{ deviceId: number; port: number }>
  readonly listeners: () => number
  /** usbmuxd dies: the server and every connection close. */
  readonly stop: () => Promise<void>
  readonly start: () => Promise<void>
  readonly close: () => Promise<void>
  /** Answer the next ListDevices with garbage instead of a plist. */
  garbageOnce: boolean
}

function properties(device: FakeMuxDevice): Record<string, PlistInput> {
  return {
    ConnectionType: device.connection,
    DeviceID: device.deviceId,
    SerialNumber: device.udid,
    ...(device.connection === 'USB'
      ? {
          ConnectionSpeed: 480000000,
          LocationID: 336592896,
          ProductID: 4776,
          USBSerialNumber: device.udid.replace('-', ''),
        }
      : {
          EscapedFullServiceName: 'fake._apple-mobdev2._tcp.local.',
          InterfaceIndex: 14,
          NetworkAddress: Buffer.alloc(16),
        }),
    ...device.properties,
  }
}

function ntohs(value: number): number {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff)
}

export async function createFakeUsbmuxd(): Promise<FakeUsbmuxd> {
  /** Short: a Unix socket path is capped at 104 bytes on macOS. */
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mux-'))
  const socketPath = path.join(dir, 'usbmuxd')
  const devices = new Map<number, FakeMuxDevice>()
  const listening = new Set<Socket>()
  const sockets = new Set<Socket>()
  const records = new Map<string, Record<string, PlistInput>>()
  const messages: string[] = []
  const connects: Array<{ deviceId: number; port: number }> = []
  /** Open pipes, by the DeviceID they run to. */
  const pipes = new Map<Socket, number>()
  let server: Server | null = null

  const push = (body: Record<string, PlistInput>): void => {
    for (const socket of listening) socket.write(encodeMuxFrame(body, 0))
  }

  const onConnection = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      listening.delete(socket)
      pipes.delete(socket)
    })
    socket.on('error', () => undefined)
    const reader = createMuxReader(({ tag, body }) => {
      const type = typeof body.MessageType === 'string' ? body.MessageType : ''
      messages.push(type)
      const reply = (message: Record<string, PlistInput>): void => {
        socket.write(encodeMuxFrame(message, tag))
      }
      switch (type) {
        case 'ListDevices': {
          if (fake.garbageOnce) {
            fake.garbageOnce = false
            const header = Buffer.alloc(16)
            header.writeUInt32LE(8, 0)
            socket.write(header)
            return
          }
          reply({
            DeviceList: [...devices.values()].map((device) => ({
              DeviceID: device.deviceId,
              MessageType: 'Attached',
              Properties: properties(device),
            })),
          })
          return
        }
        case 'Listen':
          reply({ MessageType: 'Result', Number: 0 })
          listening.add(socket)
          return
        case 'ReadBUID':
          reply({ BUID: 'FAKE-SYSTEM-BUID' })
          return
        case 'ReadPairRecord': {
          const record = records.get(typeof body.PairRecordID === 'string' ? body.PairRecordID : '')
          if (!record) return reply({ MessageType: 'Result', Number: 2 })
          reply({ PairRecordData: Buffer.from(buildPlist(record)) })
          return
        }
        case 'Connect': {
          const device = devices.get(Number(body.DeviceID))
          const port = ntohs(Number(body.PortNumber))
          connects.push({ deviceId: Number(body.DeviceID), port })
          const handler = device?.port(port) ?? null
          if (!handler) return reply({ MessageType: 'Result', Number: 3 })
          reader.stop()
          socket.removeAllListeners('data')
          reply({ MessageType: 'Result', Number: 0 })
          const rest = reader.rest()
          if (rest.length) socket.unshift(rest)
          pipes.set(socket, Number(body.DeviceID))
          handler(socket)
          return
        }
        default:
          reply({ MessageType: 'Result', Number: 1 })
      }
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk)
      } catch {
        socket.destroy()
      }
    })
  }

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      rmSync(socketPath, { force: true })
      const s = net.createServer(onConnection)
      s.once('error', reject)
      s.listen(socketPath, () => {
        server = s
        resolve()
      })
    })

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      const s = server
      server = null
      for (const socket of sockets) socket.destroy()
      if (!s) return resolve()
      s.close(() => resolve())
    })

  const fake: FakeUsbmuxd = {
    path: socketPath,
    attach(device) {
      devices.set(device.deviceId, device)
      push({ MessageType: 'Attached', DeviceID: device.deviceId, Properties: properties(device) })
    },
    detach(deviceId) {
      devices.delete(deviceId)
      push({ MessageType: 'Detached', DeviceID: deviceId })
      for (const [socket, to] of pipes) if (to === deviceId) socket.destroy()
    },
    paired(deviceId) {
      push({ MessageType: 'Paired', DeviceID: deviceId })
    },
    records,
    messages,
    connects,
    listeners: () => listening.size,
    stop,
    start,
    async close() {
      await stop()
      rmSync(dir, { recursive: true, force: true })
    },
    garbageOnce: false,
  }
  await start()
  return fake
}
