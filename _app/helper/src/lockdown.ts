/**
 * §6 lockdownd: the iPhone's own front desk on port 62078, reached through a usbmuxd pipe.
 * Before a session it answers a few plaintext questions (what it is, its name and version);
 * with the Mac's existing pair record it opens a TLS session that reads identifiers, battery,
 * storage and Developer Mode, and starts the system log relay.
 *
 * Only LOCKDOWN_REQUESTS and LOCKDOWN_SERVICES are ever sent: send() throws before writing
 * anything else, so a bug cannot pair, unpair or change a setting on a tester's phone.
 */
import { X509Certificate, constants as cryptoConstants } from 'node:crypto'
import type { Socket } from 'node:net'
import tls, { type TLSSocket } from 'node:tls'
import { LIMITS, LOCKDOWN_REQUESTS, LOCKDOWN_SERVICES } from './constants'
import { asDict, buildPlist, parsePlist, type PlistInput, type PlistValue } from './plist'
import type { Timeouts } from './types'
import type { PairRecord } from './usbmuxd'
import { errorText } from './util'

export type LockdownRequest = (typeof LOCKDOWN_REQUESTS)[number]
export type LockdownService = (typeof LOCKDOWN_SERVICES)[number]

/** The port lockdownd listens on, on every iPhone. */
export const LOCKDOWN_PORT = 62078

/**
 * A refusal or failure. `code` is lockdownd's own Error string (`InvalidHostID`,
 * `PasswordProtected`, `MissingValue`…), passed through raw as the spec asks (G12), or one
 * of the client's: 'timeout', 'closed', 'protocol', 'tls-reset' (the phone hung up on the
 * handshake: it no longer trusts this Mac), 'tls-failed' (this Node could not do the
 * handshake at all; `detail` names why, such as ERR_SSL_CA_MD_TOO_WEAK), 'tls-pin' (pinning
 * is on and the phone presented a certificate other than the pair record's, G25).
 */
export class LockdownError extends Error {
  readonly code: string
  readonly detail: string
  constructor(code: string, message: string, detail = '') {
    super(message)
    this.name = 'LockdownError'
    this.code = code
    this.detail = detail
  }
}

/** What a session's TLS handshake negotiated, for --doctor and the pinning check (G25). */
export interface SessionInfo {
  sessionId: string
  tls: TLSSocket | null
  protocol: string | null
  cipher: string | null
  /**
   * Whether the phone presented exactly the pair record's DeviceCertificate. null when it
   * could not be compared. Never false with `pin` on: the session ends with 'tls-pin' instead.
   */
  peerMatches: boolean | null
}

export interface Lockdown {
  /** The allowlisted request itself, for tests: throws before writing anything else. */
  readonly send: (
    message: { Request: string } & Record<string, PlistInput | undefined>,
    opts?: { timeoutMs?: number },
  ) => Promise<Record<string, PlistValue>>
  readonly queryType: () => Promise<string>
  /** Whole domain when `key` is absent. Before StartSession only the plaintext keys answer. */
  readonly getValue: (
    domain?: string,
    key?: string,
    opts?: { timeoutMs?: number },
  ) => Promise<PlistValue | undefined>
  /** StartSession with the record's HostID and SystemBUID, then TLS when the phone asks. */
  readonly startSession: (record: PairRecord) => Promise<SessionInfo>
  readonly startService: (name: LockdownService) => Promise<{ port: number; ssl: boolean }>
  readonly stopSession: () => Promise<void>
  /** Destroys the connection; every pending request rejects with 'closed'. */
  readonly close: () => void
}

export interface LockdownOptions {
  timeouts: Pick<Timeouts, 'lockdownRequest' | 'lockdownTls'>
  /** End the session when the phone's certificate is not the pair record's (G25, §3.3). */
  pin?: boolean
}

/* ------------------------------------------------------------------- framing --- */

/** A u32 big-endian length, then that many bytes of XML plist [V]. */
export function encodeLockdownFrame(body: Record<string, PlistInput | undefined>): Buffer {
  const payload = Buffer.from(buildPlist(body), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/** Bytes in, dictionaries out; throws LockdownError('protocol') past the 4 MiB frame cap. */
export function createLockdownReader(onFrame: (body: Record<string, PlistValue>) => void): {
  push: (chunk: Buffer) => void
} {
  let buffer: Buffer = Buffer.alloc(0)
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length > LIMITS.frame) {
          throw new LockdownError('protocol', `lockdownd sent a frame of ${String(length)} bytes.`)
        }
        if (buffer.length < 4 + length) return
        const body = asDict(parsePlist(buffer.subarray(4, 4 + length).toString('utf8')))
        buffer = buffer.subarray(4 + length)
        if (!body)
          throw new LockdownError('protocol', 'lockdownd sent a reply that is not a dictionary.')
        onFrame(body)
      }
    },
  }
}

/** Refuses anything outside the allowlists before a byte is written (T11). */
export function assertLockdownRequest(
  message: { Request: string } & Record<string, unknown>,
): asserts message is { Request: LockdownRequest } & Record<string, unknown> {
  if (!(LOCKDOWN_REQUESTS as readonly string[]).includes(message.Request)) {
    throw new Error(
      `The helper never sends the lockdown request ${JSON.stringify(message.Request)}.`,
    )
  }
  if (
    message.Request === 'StartService' &&
    !(LOCKDOWN_SERVICES as readonly string[]).includes(String(message.Service))
  ) {
    throw new Error(`The helper never starts the service ${JSON.stringify(message.Service)}.`)
  }
}

/* ----------------------------------------------------------------------- TLS --- */

/**
 * The client side of lockdown's TLS (§3.3), the same for the session and for services:
 * - the pair record's host certificate and key, from memory only;
 * - no verification of the phone's certificate: it is self-issued (pinning is separate);
 * - `@SECLEVEL=0`, because pair-record chains are SHA-1, which OpenSSL 3 refuses by default
 *   (a named SHA-1 chain even throws synchronously, before any byte is sent [V]);
 * - TLS 1.2 or newer, and legacy renegotiation for older lockdownd, as pymobiledevice3 does.
 */
export function tlsOptions(record: PairRecord, socket: Socket): tls.ConnectionOptions {
  return {
    socket,
    cert: record.HostCertificate,
    key: record.HostPrivateKey,
    rejectUnauthorized: false,
    ciphers: 'DEFAULT:@SECLEVEL=0',
    minVersion: 'TLSv1.2',
    secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT,
  }
}

/** Codes Node gives a handshake the phone cut short: an untrusted Mac, not a broken Node. */
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_SSL_SSL_HANDSHAKE_FAILURE'])

function isReset(error: NodeJS.ErrnoException): boolean {
  return (
    RESET_CODES.has(error.code ?? '') ||
    /socket disconnected before secure TLS connection|socket hang up/i.test(error.message)
  )
}

/** Whether the phone presented exactly the pair record's DeviceCertificate (G25). */
function peerMatches(socket: TLSSocket, record: PairRecord): boolean | null {
  try {
    const peer = socket.getPeerCertificate(true)
    const expected = derOf(record.DeviceCertificate)
    return peer.raw && expected ? peer.raw.equals(expected) : null
  } catch {
    return null
  }
}

function derOf(pem: Buffer): Buffer | null {
  try {
    return new X509Certificate(pem).raw
  } catch {
    return null
  }
}

/**
 * Wraps `raw` in TLS with the pair record. A synchronous throw (OpenSSL refusing the
 * certificates outright) and every handshake failure become LockdownError: 'tls-reset' when
 * the phone hung up, 'tls-failed' otherwise. With `pin`, a phone whose certificate is not the
 * pair record's ends it as 'tls-pin': every lockdown session and every service handshake goes
 * through here, so this is the one place pinning is enforced (G25).
 */
export function startTls(
  raw: Socket,
  record: PairRecord,
  timeoutMs: number,
  opts: { pin?: boolean } = {},
): Promise<{
  socket: TLSSocket
  protocol: string | null
  cipher: string | null
  peerMatches: boolean | null
}> {
  return new Promise((resolve, reject) => {
    let socket: TLSSocket
    try {
      socket = tls.connect(tlsOptions(record, raw))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR_TLS'
      raw.destroy()
      return reject(
        new LockdownError(
          'tls-failed',
          `This Node could not start TLS with the iPhone (${code}).`,
          code,
        ),
      )
    }
    let settled = false
    const fail = (error: LockdownError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      raw.destroy()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new LockdownError('tls-failed', 'The TLS handshake took too long.', 'timeout')),
      timeoutMs,
    )
    socket.once('secureConnect', () => {
      if (settled) return
      const matches = peerMatches(socket, record)
      if (opts.pin && matches === false) {
        fail(
          new LockdownError(
            'tls-pin',
            'The iPhone presented a certificate other than the one it was paired with.',
          ),
        )
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        socket,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name ?? null,
        peerMatches: matches,
      })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'ERR_TLS'
      fail(
        isReset(error)
          ? new LockdownError('tls-reset', 'The iPhone ended the secure session.', code)
          : new LockdownError('tls-failed', `TLS with the iPhone failed (${code}).`, code),
      )
    })
    socket.once('close', () =>
      fail(new LockdownError('tls-reset', 'The iPhone closed the secure session.', 'EOF')),
    )
  })
}

/* --------------------------------------------------------------------- client --- */

interface Waiter {
  resolve: (body: Record<string, PlistValue>) => void
  reject: (error: LockdownError) => void
  timer: NodeJS.Timeout
}

/**
 * A lockdown channel over a usbmuxd pipe to port 62078. Requests run one at a time, as
 * lockdownd answers them in order; a request that times out closes the channel, because a
 * late reply would otherwise be read as the answer to the next question.
 */
export function createLockdown(raw: Socket, opts: LockdownOptions): Lockdown {
  const { timeouts } = opts
  let transport: Socket = raw
  let tlsSocket: TLSSocket | null = null
  let sessionId: string | null = null
  let closed: LockdownError | null = null
  const waiters: Waiter[] = []
  let queue: Promise<unknown> = Promise.resolve()

  const failAll = (error: LockdownError): void => {
    closed ??= error
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(closed)
    }
  }

  const reader = createLockdownReader((body) => {
    const waiter = waiters.shift()
    if (!waiter) return
    clearTimeout(waiter.timer)
    waiter.resolve(body)
  })
  const onData = (chunk: Buffer): void => {
    try {
      reader.push(chunk)
    } catch (error) {
      failAll(error instanceof LockdownError ? error : new LockdownError('protocol', String(error)))
      transport.destroy()
    }
  }
  const onClose = (): void =>
    failAll(new LockdownError('closed', 'lockdownd closed the connection.'))
  const onError = (): void => undefined

  const attach = (socket: Socket): void => {
    transport = socket
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)
    socket.resume()
  }
  const detach = (socket: Socket): void => {
    socket.off('data', onData)
    socket.off('close', onClose)
  }
  attach(raw)

  function exchange(
    name: string,
    message: Record<string, PlistInput | undefined>,
    timeoutMs: number,
  ): Promise<Record<string, PlistValue>> {
    return new Promise((resolve, reject) => {
      if (closed) return reject(closed)
      const timer = setTimeout(() => {
        failAll(new LockdownError('timeout', `lockdownd did not answer ${name} in time.`))
        transport.destroy()
      }, timeoutMs)
      waiters.push({ resolve, reject, timer })
      transport.write(encodeLockdownFrame({ Label: 'device-bridge', ...message }))
    })
  }

  const send: Lockdown['send'] = (message, sendOpts = {}) => {
    assertLockdownRequest(message)
    const run = queue.then(async () => {
      const reply = await exchange(
        message.Request,
        message,
        sendOpts.timeoutMs ?? timeouts.lockdownRequest,
      )
      if (typeof reply.Error === 'string') {
        throw new LockdownError(
          reply.Error,
          `lockdownd refused ${message.Request}: ${reply.Error}.`,
        )
      }
      return reply
    })
    queue = run.catch(() => undefined)
    return run
  }

  async function queryType(): Promise<string> {
    const reply = await send({ Request: 'QueryType' })
    return typeof reply.Type === 'string' ? reply.Type : ''
  }

  async function getValue(
    domain?: string,
    key?: string,
    valueOpts: { timeoutMs?: number } = {},
  ): Promise<PlistValue | undefined> {
    const reply = await send({ Request: 'GetValue', Domain: domain, Key: key }, valueOpts)
    return reply.Value
  }

  async function startSession(record: PairRecord): Promise<SessionInfo> {
    const reply = await send({
      Request: 'StartSession',
      HostID: record.HostID,
      SystemBUID: record.SystemBUID,
    })
    sessionId = typeof reply.SessionID === 'string' ? reply.SessionID : ''
    if (reply.EnableSessionSSL !== true) {
      return { sessionId, tls: null, protocol: null, cipher: null, peerMatches: null }
    }
    /** From here on every byte is TLS: the plaintext reader lets go of the raw pipe. */
    detach(raw)
    const secured = await startTls(raw, record, timeouts.lockdownTls, { pin: opts.pin }).catch(
      (error: unknown) => {
        const failure =
          error instanceof LockdownError ? error : new LockdownError('tls-failed', errorText(error))
        failAll(failure)
        throw failure
      },
    )
    tlsSocket = secured.socket
    attach(secured.socket)
    return {
      sessionId,
      tls: secured.socket,
      protocol: secured.protocol,
      cipher: secured.cipher,
      peerMatches: secured.peerMatches,
    }
  }

  async function startService(name: LockdownService): Promise<{ port: number; ssl: boolean }> {
    const reply = await send({ Request: 'StartService', Service: name })
    if (typeof reply.Port !== 'number') {
      throw new LockdownError('protocol', `lockdownd started ${name} without a port.`)
    }
    return { port: reply.Port, ssl: reply.EnableServiceSSL === true }
  }

  async function stopSession(): Promise<void> {
    if (sessionId === null) return
    const id = sessionId
    sessionId = null
    await send({ Request: 'StopSession', SessionID: id })
  }

  function close(): void {
    failAll(new LockdownError('closed', 'The lockdown connection was closed.'))
    tlsSocket?.destroy()
    raw.destroy()
  }

  return { send, queryType, getValue, startSession, startService, stopSession, close }
}
