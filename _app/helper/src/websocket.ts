import { createHash } from 'node:crypto'

/**
 * §13a WebSocket frames (RFC 6455), the server's half, and only as much of it as the adb
 * tunnel needs (§4.10): the opening handshake's accept key, frames written unmasked and
 * unfragmented, and a decoder for what a browser sends (masked frames, possibly fragmented,
 * pings and a close). No extensions: `permessage-deflate` is never negotiated, so a frame
 * with an RSV bit set is a protocol error.
 *
 * Node has no WebSocket server built in, and the helper has no dependencies, hence this
 * module. A browser cannot open TCP, and fetch() cannot stream a request body over HTTP/1.1,
 * so a WebSocket is the one way a page gets a two-way byte stream to the helper.
 */

/** RFC 6455 §1.3: appended to the client's key before hashing. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A client key is 16 random bytes in base64. */
export const WS_KEY = /^[A-Za-z0-9+/]{22}==$/

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + GUID, 'latin1')
    .digest('base64')
}

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

/** Close codes the helper sends (RFC 6455 §7.4.1). */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  policyViolation: 1008,
  tooBig: 1009,
  internalError: 1011,
} as const

/** One frame from server to client: never masked (§5.1), always final. */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** A close frame: the code, then a reason of at most 123 bytes. */
export function encodeClose(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OPCODE.close, payload)
}

/** A frame the decoder refused: the connection closes with `code`. */
export class WsProtocolError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'WsProtocolError'
    this.code = code
  }
}

/** One decoded frame, unmasked. A data frame's `opcode` is its message's, continuations included. */
export type WsFrame =
  | {
      readonly kind: 'data'
      readonly opcode: 1 | 2
      readonly fin: boolean
      readonly payload: Buffer
    }
  | { readonly kind: 'close'; readonly code: number | null }
  | { readonly kind: 'ping'; readonly payload: Buffer }
  | { readonly kind: 'pong' }

export interface FrameDecoder {
  /** Every complete frame in what has arrived so far; throws WsProtocolError on a bad one. */
  readonly push: (chunk: Buffer) => WsFrame[]
}

/**
 * Frames from a client, as they complete. `maxPayload` caps one frame (a browser sends a
 * message as one frame, and the page sends at most 256 KiB at a time); larger ones close
 * the connection with 1009 before their payload is buffered.
 */
export function createFrameDecoder(maxPayload: number): FrameDecoder {
  let buffered: Buffer = Buffer.alloc(0)
  /** The opcode of a fragmented message in progress, or null. */
  let message: 1 | 2 | null = null

  /** One frame from the front of `buffered`, or null until it has all arrived. */
  const next = (): WsFrame | null => {
    if (buffered.length < 2) return null
    const b0 = buffered[0] ?? 0
    const b1 = buffered[1] ?? 0
    const fin = (b0 & 0x80) !== 0
    if ((b0 & 0x70) !== 0)
      throw new WsProtocolError(CLOSE.protocolError, 'No extension was agreed.')
    const opcode = b0 & 0x0f
    /** §5.1: every frame a client sends is masked. */
    if ((b1 & 0x80) === 0)
      throw new WsProtocolError(CLOSE.protocolError, 'Client frames are masked.')
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffered.length < 4) return null
      length = buffered.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffered.length < 10) return null
      if (buffered.readUInt32BE(2) !== 0)
        throw new WsProtocolError(CLOSE.tooBig, 'Frame too large.')
      length = buffered.readUInt32BE(6)
      offset = 10
    }
    const control = opcode >= 0x8
    if (control && (!fin || length > 125)) {
      throw new WsProtocolError(CLOSE.protocolError, 'A control frame is short and unfragmented.')
    }
    if (length > maxPayload) throw new WsProtocolError(CLOSE.tooBig, 'Frame too large.')
    if (buffered.length < offset + 4 + length) return null
    const mask = buffered.subarray(offset, offset + 4)
    const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length))
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0)
    buffered = buffered.subarray(offset + 4 + length)

    switch (opcode) {
      case OPCODE.text:
      case OPCODE.binary: {
        if (message !== null) {
          throw new WsProtocolError(CLOSE.protocolError, 'A new message began inside another.')
        }
        if (!fin) message = opcode
        return { kind: 'data', opcode, fin, payload }
      }
      case OPCODE.continuation: {
        if (message === null) throw new WsProtocolError(CLOSE.protocolError, 'Nothing to continue.')
        const of = message
        if (fin) message = null
        return { kind: 'data', opcode: of, fin, payload }
      }
      case OPCODE.close:
        return { kind: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : null }
      case OPCODE.ping:
        return { kind: 'ping', payload }
      case OPCODE.pong:
        return { kind: 'pong' }
      default:
        throw new WsProtocolError(CLOSE.protocolError, 'Unknown opcode.')
    }
  }

  return {
    push(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
      const frames: WsFrame[] = []
      for (let frame = next(); frame; frame = next()) frames.push(frame)
      return frames
    },
  }
}

/**
 * The client's `Sec-WebSocket-Protocol` offers, in order. A browser cannot set headers on a
 * WebSocket, so the page sends its token as one of these (`bearer.<token>`, as Kubernetes
 * does); the helper answers with the tunnel's own protocol name only, never the token.
 */
export function offeredProtocols(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}
