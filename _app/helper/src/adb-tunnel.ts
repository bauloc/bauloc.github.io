import type { Duplex } from 'node:stream'
import type { TunnelReply } from './types'
import { LIMITS } from './constants'
import {
  CLOSE,
  OPCODE,
  WsProtocolError,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
} from './websocket'
import { linkSignals } from './util'

/**
 * §13b The adb tunnel (§4.10): one WebSocket, one device service, the bytes in between.
 *
 * Device Lab's Android operations (installs, the Apps and Images tabs) speak adb to a phone:
 * over WebUSB in Chrome, and through this tunnel for a device only Google's adb server
 * reaches, an Android TV on the Wi-Fi above all. The page opens a WebSocket per service,
 * exactly as an adb client opens a socket per service, and its first message names the
 * service. The helper sends `host:transport:<serial>` and that service to the server itself,
 * answers `{"t":"ok"}` or `{"t":"error",code,message}`, and from then on copies bytes both
 * ways until either side closes. The HTTP layer has already checked Host, Origin and the
 * token before the upgrade; this module owns what happens after it.
 *
 * Back-pressure both ways: the device's bytes stop being read while the page's socket is
 * full, and the page's frames stop being read while the device's socket is.
 */

export interface TunnelOptions {
  /** Opens the service the page named: a listed, ready Android device's (HelperError otherwise). */
  readonly open: (service: string, signal: AbortSignal) => Promise<Duplex>
  /** How the opening's failure reads on the wire; null when nobody is left to tell. */
  readonly describe: (error: unknown) => { code: string; message: string } | null
  /** How long the page has to name its service. */
  readonly helloMs: number
  /** Aborts on shutdown. */
  readonly signal: AbortSignal
  /** An unexpected failure: stderr, never the page. */
  readonly bug: (error: unknown) => void
}

export interface Tunnel {
  /** Ends the tunnel with a close frame (shutdown: 1001). */
  readonly close: (code: number, reason?: string) => void
  /** Settles once both sockets are gone. */
  readonly done: Promise<void>
}

/** The opening message: `{"service": "<an adb service>"}`. */
export function parseHello(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const service = (value as { service?: unknown }).service
    return typeof service === 'string' && service.length > 0 ? service : null
  } catch {
    return null
  }
}

/**
 * Serves one upgraded socket. `head` is whatever arrived with the upgrade request after its
 * headers: the start of the page's first frame, possibly.
 */
export function serveTunnel(ws: Duplex, head: Buffer, o: TunnelOptions): Tunnel {
  const decoder = createFrameDecoder(LIMITS.tunnelFrame)
  const life = linkSignals([o.signal])
  let phase: 'hello' | 'opening' | 'open' | 'closed' = 'hello'
  let hello: Buffer[] = []
  let helloBytes = 0
  let adb: Duplex | null = null
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const send = (frame: Buffer): boolean => (ws.writable ? ws.write(frame) : false)
  const sendText = (reply: TunnelReply): void => {
    send(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(reply), 'utf8')))
  }

  /** Close frame, then the TCP connection; the device's socket goes with it. */
  const close = (code: number, reason = ''): void => {
    if (phase === 'closed') return
    phase = 'closed'
    clearTimeout(helloTimer)
    life.abort()
    life.dispose()
    if (ws.writable) {
      ws.end(encodeClose(code, reason))
      /** A page that never answers the close frame doesn't keep the socket. */
      setTimeout(() => ws.destroy(), 1_000).unref()
    } else ws.destroy()
    adb?.destroy()
  }

  const helloTimer = setTimeout(() => {
    close(CLOSE.policyViolation, 'No service was named.')
  }, o.helloMs)
  helloTimer.unref()

  /** Whether a side waits for the other's 'drain': one listener at a time, however many writes. */
  let pageFull = false
  let deviceFull = false

  /** The device's bytes go to the page as binary frames, paused while the page lags. */
  const pipeFromDevice = (device: Duplex): void => {
    device.on('data', (chunk: Buffer) => {
      if (phase !== 'open') return
      if (!send(encodeFrame(OPCODE.binary, chunk)) && !pageFull) {
        pageFull = true
        device.pause()
        ws.once('drain', () => {
          pageFull = false
          if (phase === 'open') device.resume()
        })
      }
    })
    /** The service ended (a command finished, a file was read): the tunnel ends with it. */
    device.on('end', () => close(CLOSE.normal))
    device.on('close', () => close(CLOSE.normal))
    device.on('error', () => close(CLOSE.normal))
    device.resume()
  }

  const opening = (service: string): void => {
    phase = 'opening'
    clearTimeout(helloTimer)
    /** A refusal thrown before any promise exists still becomes the error message. */
    Promise.resolve()
      .then(() => o.open(service, life.signal))
      .then(
        (device) => {
          if (phase !== 'opening') {
            device.destroy()
            return
          }
          adb = device
          sendText({ t: 'ok' })
          phase = 'open'
          pipeFromDevice(device)
        },
        (error: unknown) => {
          if (phase !== 'opening') return
          const said = o.describe(error)
          if (said) sendText({ t: 'error', code: said.code, message: said.message })
          close(CLOSE.normal)
        },
      )
  }

  const onFrames = (chunk: Buffer): void => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      close(error instanceof WsProtocolError ? error.code : CLOSE.protocolError)
      return
    }
    for (const frame of frames) {
      if (phase === 'closed') return
      switch (frame.kind) {
        case 'ping':
          send(encodeFrame(OPCODE.pong, frame.payload))
          break
        case 'pong':
          break
        case 'close':
          /** Echo the page's code, as RFC 6455 §5.5.1 asks; none means a normal close. */
          close(frame.code !== null && frame.code >= 1000 && frame.code < 5000 ? frame.code : 1000)
          return
        case 'data':
          if (phase === 'hello') {
            if (frame.opcode !== OPCODE.text) {
              close(CLOSE.unsupportedData, 'Name the service first.')
              return
            }
            helloBytes += frame.payload.length
            if (helloBytes > LIMITS.tunnelHello) {
              close(CLOSE.tooBig)
              return
            }
            hello.push(frame.payload)
            if (!frame.fin) break
            const service = parseHello(Buffer.concat(hello).toString('utf8'))
            hello = []
            if (service === null) {
              close(CLOSE.unsupportedData, 'Name the service first.')
              return
            }
            opening(service)
          } else if (phase === 'opening' || frame.opcode !== OPCODE.binary) {
            /** The page waits for "ok" before it writes, and writes bytes only. */
            close(CLOSE.protocolError)
            return
          } else if (adb && frame.payload.length > 0 && !adb.write(frame.payload) && !deviceFull) {
            deviceFull = true
            ws.pause()
            adb.once('drain', () => {
              deviceFull = false
              if (phase === 'open') ws.resume()
            })
          }
          break
      }
    }
  }

  ws.on('data', onFrames)
  ws.on('error', () => undefined)
  /** The HTTP server's sockets are half-open: a page that went away only ends its side. */
  ws.on('end', () => close(CLOSE.normal))
  ws.on('close', () => {
    if (phase !== 'closed') {
      phase = 'closed'
      clearTimeout(helloTimer)
      life.abort()
      life.dispose()
      adb?.destroy()
    }
    resolveDone()
  })
  if (head.length) onFrames(head)
  if (o.signal.aborted) close(CLOSE.goingAway)

  return { close, done }
}
