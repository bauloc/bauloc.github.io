/**
 * §5 usbmuxd: macOS's iPhone multiplexer, a root-owned Unix socket every iPhone tool goes
 * through. The helper asks it which iPhones are attached (and is told when that changes),
 * reads the Mac's existing pairing with one, and opens a raw pipe to a port on the phone.
 *
 * One connection per request, `Listen` on its own; only MUX_MESSAGES are ever sent. The
 * helper never writes or deletes a pair record: that is what pairing tools do, and the
 * helper never pairs.
 */
import net, { type Socket } from 'node:net'
import { LIMITS, MUX_MESSAGES, NAME, VERSION } from './constants'
import { asDict, buildPlist, parsePlist, type PlistInput, type PlistValue } from './plist'
import type { Timeouts } from './types'

export type MuxMessage = (typeof MUX_MESSAGES)[number]

export interface MuxDeviceProperties {
  ConnectionType: 'USB' | 'Network'
  /** The UDID. Rows are keyed by it: DeviceID changes on every attach [V]. */
  SerialNumber: string
  [key: string]: PlistValue
}

export interface MuxDevice {
  DeviceID: number
  Properties: MuxDeviceProperties
}

export type MuxEvent =
  /** Listen answered Result 0: on the first connection and after every reconnect. Resync now. */
  | { type: 'listening' }
  | { type: 'attached'; device: MuxDevice }
  | { type: 'detached'; deviceId: number }
  | { type: 'paired'; deviceId: number }
  /** The Listen socket closed or never opened; the client retries with backoff. */
  | { type: 'disconnected'; error: MuxError }

/** The Mac's pairing with one device. Held in memory only: never written, logged or returned. */
export interface PairRecord {
  HostID: string
  SystemBUID: string
  /** PEM. */
  HostCertificate: Buffer
  HostPrivateKey: Buffer
  DeviceCertificate: Buffer
  RootCertificate?: Buffer
}

export type MuxFailure =
  /** No socket at the path: not a Mac, or usbmuxd is not running. */
  | 'missing'
  | 'refused'
  | 'timeout'
  | 'closed'
  /** A frame or plist the client cannot read. */
  | 'protocol'
  /** usbmuxd answered `Result` with a non-zero Number (`result` says which). */
  | 'result'

export class MuxError extends Error {
  readonly code: MuxFailure
  /** The Result Number for 'result': 2 no such record, 3 connection refused by the device. */
  readonly result: number | null
  constructor(code: MuxFailure, message: string, result: number | null = null) {
    super(message)
    this.name = 'MuxError'
    this.code = code
    this.result = result
  }
}

export interface Usbmux {
  /** One request on its own connection; resolves with the reply plist. */
  readonly request: (
    message: { MessageType: MuxMessage } & Record<string, PlistInput>,
  ) => Promise<Record<string, PlistValue>>
  readonly listDevices: () => Promise<MuxDevice[]>
  /** Listen for hot-plug, reconnecting with backoff; returns the unsubscribe. */
  readonly watch: (onEvent: (event: MuxEvent) => void) => () => void
  /** null for `Result 2`: this Mac has no pairing with the device. */
  readonly readPairRecord: (udid: string) => Promise<PairRecord | null>
  readonly readBuid: () => Promise<string>
  /** A raw pipe to `port` on the device (lockdown is 62078), paused until its reader resumes it. */
  readonly connect: (
    deviceId: number,
    port: number,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<Socket>
}

export interface UsbmuxOptions {
  socketPath: string
  timeouts: Pick<Timeouts, 'muxRequest' | 'muxConnectUsb'>
  /** Delays before each reconnect of the Listen socket; the last one repeats (§3.2). */
  reconnectMs?: readonly number[]
}

/* ------------------------------------------------------------------- the frame --- */

/** version 1 = plist framing; message 8 = plist payload (§3.2 [V]). */
const MUX_VERSION = 1
const MUX_PLIST = 8
export const MUX_HEADER = 16

/**
 * One usbmuxd frame: a 16-byte little-endian header {total length including the header,
 * version 1, message 8, tag}, then the XML plist.
 */
export function encodeMuxFrame(body: Record<string, PlistInput | undefined>, tag: number): Buffer {
  const payload = Buffer.from(buildPlist(body), 'utf8')
  const header = Buffer.alloc(MUX_HEADER)
  header.writeUInt32LE(MUX_HEADER + payload.length, 0)
  header.writeUInt32LE(MUX_VERSION, 4)
  header.writeUInt32LE(MUX_PLIST, 8)
  header.writeUInt32LE(tag, 12)
  return Buffer.concat([header, payload])
}

export interface MuxFrame {
  tag: number
  body: Record<string, PlistValue>
}

/**
 * Bytes in, frames out. Throws MuxError('protocol') on a length below the header or above
 * the 4 MiB cap: a confused peer is closed, never buffered without bound. `rest()` returns
 * what arrived after the last whole frame (a Connect reply can be followed at once by the
 * device's first bytes).
 */
export function createMuxReader(onFrame: (frame: MuxFrame) => void): {
  push: (chunk: Buffer) => void
  rest: () => Buffer
  /** Stop reading frames: the socket now carries something else (after Connect). */
  stop: () => void
} {
  let buffer: Buffer = Buffer.alloc(0)
  let stopped = false
  return {
    push(chunk) {
      if (stopped) return
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      while (!stopped && buffer.length >= MUX_HEADER) {
        const length = buffer.readUInt32LE(0)
        if (length < MUX_HEADER || length > LIMITS.frame) {
          throw new MuxError('protocol', `usbmuxd sent a frame of ${String(length)} bytes.`)
        }
        if (buffer.length < length) return
        const tag = buffer.readUInt32LE(12)
        const payload = buffer.subarray(MUX_HEADER, length)
        buffer = buffer.subarray(length)
        const body = asDict(parsePlist(payload.toString('utf8')))
        if (!body) throw new MuxError('protocol', 'usbmuxd sent a reply that is not a dictionary.')
        onFrame({ tag, body })
      }
    },
    rest: () => buffer,
    stop: () => {
      stopped = true
    },
  }
}

/** `PortNumber` travels in network byte order inside a little-endian integer (htons). */
export function htons(port: number): number {
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff)
}

/** Refuses anything not in MUX_MESSAGES before a byte is written (T11). */
export function assertMuxMessage(type: string): asserts type is MuxMessage {
  if (!(MUX_MESSAGES as readonly string[]).includes(type)) {
    throw new Error(`The helper never sends the usbmuxd message ${JSON.stringify(type)}.`)
  }
}

/** Fields libusbmuxd sends with every request; usbmuxd logs them as the client's name. */
const CLIENT = {
  ClientVersionString: `${NAME} ${VERSION}`,
  ProgName: 'device-bridge',
  kLibUSBMuxVersion: 3,
} as const

function socketError(error: NodeJS.ErrnoException, what: string): MuxError {
  if (error.code === 'ENOENT') return new MuxError('missing', 'usbmuxd is not running.')
  if (error.code === 'ECONNREFUSED') return new MuxError('refused', 'usbmuxd refused to answer.')
  return new MuxError('closed', `usbmuxd closed the connection during ${what}.`)
}

/** A device entry as listed or announced, or null for one the helper cannot address. */
export function toMuxDevice(value: PlistValue | undefined): MuxDevice | null {
  const entry = asDict(value)
  const properties = asDict(entry?.Properties)
  const id = entry?.DeviceID ?? properties?.DeviceID
  const serial = properties?.SerialNumber
  const type = properties?.ConnectionType
  if (typeof id !== 'number' || typeof serial !== 'string') return null
  if (type !== 'USB' && type !== 'Network') return null
  return { DeviceID: id, Properties: { ...properties, ConnectionType: type, SerialNumber: serial } }
}

/**
 * The fields of a pair record the helper uses; everything else in it (the root private key,
 * the escrow bag, the Wi-Fi MAC) is dropped on arrival so it cannot leak anywhere later.
 */
export function toPairRecord(data: Buffer): PairRecord {
  if (data.subarray(0, 6).toString('latin1') === 'bplist') {
    throw new MuxError(
      'protocol',
      'The pair record is a binary plist, which the helper cannot read.',
    )
  }
  const record = asDict(parsePlist(data.toString('utf8')))
  const { HostID, SystemBUID, HostCertificate, HostPrivateKey, DeviceCertificate } = record ?? {}
  if (
    typeof HostID !== 'string' ||
    typeof SystemBUID !== 'string' ||
    !Buffer.isBuffer(HostCertificate) ||
    !Buffer.isBuffer(HostPrivateKey) ||
    !Buffer.isBuffer(DeviceCertificate)
  ) {
    throw new MuxError('protocol', 'The pair record is missing a field the helper needs.')
  }
  const root = record?.RootCertificate
  return {
    HostID,
    SystemBUID,
    HostCertificate,
    HostPrivateKey,
    DeviceCertificate,
    ...(Buffer.isBuffer(root) ? { RootCertificate: root } : {}),
  }
}

/* ------------------------------------------------------------------ the client --- */

export function createUsbmux(opts: UsbmuxOptions): Usbmux {
  const { socketPath, timeouts } = opts
  const reconnectMs = opts.reconnectMs ?? [1_000, 2_000, 4_000, 8_000, 10_000]

  /**
   * Opens a connection, sends `message`, and hands every frame to `onFrame` until it returns
   * a value (resolve) or throws (reject). The deadline and the signal destroy the socket.
   */
  function exchange<T>(
    message: Record<string, PlistInput>,
    what: string,
    timeoutMs: number,
    onFrame: (frame: MuxFrame, socket: Socket, rest: () => Buffer) => T | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.connect(socketPath)
      let settled = false
      const finish = (error: MuxError | null, value?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          socket.destroy()
          reject(error)
        } else resolve(value as T)
      }
      const timer = setTimeout(
        () => finish(new MuxError('timeout', `usbmuxd did not answer ${what} in time.`)),
        timeoutMs,
      )
      const onAbort = (): void => finish(new MuxError('closed', `${what} was cancelled.`))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const reader = createMuxReader((frame) => {
        if (settled) return
        const value = onFrame(frame, socket, reader.rest)
        if (value !== undefined) {
          reader.stop()
          finish(null, value)
        }
      })
      const onData = (chunk: Buffer): void => {
        try {
          reader.push(chunk)
        } catch (error) {
          finish(error instanceof MuxError ? error : new MuxError('protocol', String(error)))
        }
      }
      socket.on('data', onData)
      socket.on('error', (error: NodeJS.ErrnoException) => finish(socketError(error, what)))
      socket.on('close', () => finish(new MuxError('closed', `usbmuxd closed during ${what}.`)))
      socket.once('connect', () => socket.write(encodeMuxFrame({ ...CLIENT, ...message }, 1)))
    })
  }

  const request: Usbmux['request'] = (message) => {
    assertMuxMessage(message.MessageType)
    return exchange(message, message.MessageType, timeouts.muxRequest, (frame, socket) => {
      socket.destroy()
      return frame.body
    })
  }

  async function listDevices(): Promise<MuxDevice[]> {
    const reply = await request({ MessageType: 'ListDevices' })
    const list = Array.isArray(reply.DeviceList) ? reply.DeviceList : []
    return list.map(toMuxDevice).filter((device): device is MuxDevice => device !== null)
  }

  async function readPairRecord(udid: string): Promise<PairRecord | null> {
    const reply = await request({ MessageType: 'ReadPairRecord', PairRecordID: udid })
    const data = reply.PairRecordData
    if (Buffer.isBuffer(data)) return toPairRecord(data)
    const number = typeof reply.Number === 'number' ? reply.Number : -1
    /** 2 is "no such record"; the helper reads any other refusal the same way: not trusted. */
    if (reply.MessageType === 'Result' && number !== 0) return null
    throw new MuxError('protocol', 'usbmuxd answered ReadPairRecord without a record.')
  }

  async function readBuid(): Promise<string> {
    const reply = await request({ MessageType: 'ReadBUID' })
    if (typeof reply.BUID !== 'string') throw new MuxError('protocol', 'usbmuxd sent no BUID.')
    return reply.BUID
  }

  /**
   * usbmuxd answers Connect with `Result 0`, and from then on the same socket is a raw pipe
   * to the device's port. Bytes that arrived with the reply are put back for the next reader.
   */
  function connect(
    deviceId: number,
    port: number,
    connectOpts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Socket> {
    const message = { MessageType: 'Connect', DeviceID: deviceId, PortNumber: htons(port) }
    return exchange<Socket>(
      message,
      'Connect',
      connectOpts.timeoutMs ?? timeouts.muxConnectUsb,
      (frame, socket, rest) => {
        const number = frame.body.Number
        if (frame.body.MessageType !== 'Result' || number !== 0) {
          const code = typeof number === 'number' ? number : -1
          throw new MuxError(
            'result',
            `The device refused port ${String(port)} (${String(code)}).`,
            code,
          )
        }
        socket.removeAllListeners('data')
        socket.removeAllListeners('close')
        socket.removeAllListeners('error')
        /** The pipe's owner attaches its own error handler; until then errors must not crash. */
        socket.on('error', () => undefined)
        /**
         * Paused, so no byte is emitted before the new owner listens: it calls resume() (or
         * hands the socket to TLS). Bytes that came with the reply go back in front.
         */
        socket.pause()
        const leftover = rest()
        if (leftover.length) socket.unshift(leftover)
        return socket
      },
      connectOpts.signal,
    ).catch((error: unknown) => {
      throw error instanceof MuxError ? error : new MuxError('protocol', String(error))
    })
  }

  /**
   * Hot-plug. Listen answers Result 0 and then pushes Attached, Detached and Paired on the
   * same socket. When it closes (usbmuxd restarted, the Mac woke up) the client reconnects
   * after 1, 2, 4… up to 10 s, and says `listening` again so the lane resyncs with
   * ListDevices: whether Listen replays attached devices is not something to rely on.
   */
  function watch(onEvent: (event: MuxEvent) => void): () => void {
    let stopped = false
    let socket: Socket | null = null
    let timer: NodeJS.Timeout | undefined
    let attempt = 0
    let reported = false

    const schedule = (error: MuxError): void => {
      socket = null
      if (stopped) return
      if (!reported) {
        reported = true
        onEvent({ type: 'disconnected', error })
      }
      const delay = reconnectMs[Math.min(attempt, reconnectMs.length - 1)] ?? 10_000
      attempt++
      timer = setTimeout(open, delay)
      timer.unref()
    }

    const handle = (frame: MuxFrame): void => {
      const { body } = frame
      switch (body.MessageType) {
        case 'Result':
          if (body.Number !== 0) throw new MuxError('result', 'usbmuxd refused Listen.')
          attempt = 0
          reported = false
          onEvent({ type: 'listening' })
          return
        case 'Attached': {
          const device = toMuxDevice(body)
          if (device) onEvent({ type: 'attached', device })
          return
        }
        case 'Detached':
          if (typeof body.DeviceID === 'number') {
            onEvent({ type: 'detached', deviceId: body.DeviceID })
          }
          return
        case 'Paired':
          if (typeof body.DeviceID === 'number')
            onEvent({ type: 'paired', deviceId: body.DeviceID })
          return
        default:
          /** Newer usbmuxd builds announce more; ignoring them is forward compatible. */
          return
      }
    }

    function open(): void {
      if (stopped) return
      const s = net.connect(socketPath)
      socket = s
      let failure: MuxError = new MuxError('closed', 'usbmuxd closed the Listen connection.')
      const reader = createMuxReader(handle)
      s.on('connect', () => s.write(encodeMuxFrame({ ...CLIENT, MessageType: 'Listen' }, 1)))
      s.on('data', (chunk: Buffer) => {
        try {
          reader.push(chunk)
        } catch (error) {
          failure = error instanceof MuxError ? error : new MuxError('protocol', String(error))
          s.destroy()
        }
      })
      s.on('error', (error: NodeJS.ErrnoException) => {
        failure = socketError(error, 'Listen')
      })
      s.on('close', () => schedule(failure))
    }

    open()
    return () => {
      stopped = true
      clearTimeout(timer)
      socket?.destroy()
    }
  }

  return { request, listDevices, watch, readPairRecord, readBuid, connect }
}
