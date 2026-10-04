/*
  §3.8 logs through the real iOS lane and the bridge: syslog_relay (framing, batching,
  device-gone, abort), the switch to idevicesyslog after silence, the fallbacks, and the
  errors when no log source works.
*/
import http from 'node:http'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Toolbox } from '../src/tools'
import type { ErrorBody, LogMsg } from '../src/types'
import { isStream, openStream, tempDir, toolbox, until, type Reply, type Stream } from './harness'
import { hasOpenssl, makeChain, type Chain } from './fakes/certs'
import { UDID, startIosRig, type IosRig, type LockdowndScript } from './fakes/lockdownd'

let chain: Chain
let other: Chain
beforeAll(() => {
  if (!hasOpenssl) return
  const dir = tempDir('certs-')
  chain = makeChain(dir, 'empty')
  other = makeChain(dir, 'named')
}, 30_000)

async function rig(
  script: Partial<LockdowndScript> = {},
  opts: { syslogTool?: (r: IosRig) => string; silenceMs?: number } = {},
): Promise<IosRig> {
  const toolsRef: { current: Toolbox | null } = { current: toolbox() }
  const r = await startIosRig({
    chain,
    script,
    toolsRef,
    bridge: {
      timeouts: { toolsCache: 0, logSilenceSwitch: opts.silenceMs ?? 8_000, logFirstByte: 1_500 },
    },
  })
  if (opts.syslogTool) {
    const tool = opts.syslogTool(r)
    toolsRef.current = toolbox((t) => {
      t.idevicesyslog = { path: tool, version: null }
    })
  }
  await r.waitRow((row) => row?.state === 'ready', 'ready')
  return r
}

async function stream(r: IosRig): Promise<Stream> {
  const opened = await openStream(r.s.port, r.path('logs'), r.s.auth)
  if (!isStream(opened))
    throw new Error(`Expected a stream, got ${String(opened.status)} ${opened.text}`)
  return opened
}

async function refused(r: IosRig): Promise<Reply> {
  const opened = await openStream(r.s.port, r.path('logs'), r.s.auth)
  if (isStream(opened)) throw new Error('Expected an error, got a stream')
  return opened
}

const linesOf = (s: Stream): string[] => s.messages.flatMap((m) => (m.t === 'lines' ? m.lines : []))

/** A fake idevicesyslog: the connected marker, two lines, then quiet until killed. */
function idevicesyslog(r: IosRig, extra = ''): string {
  return r.s.bin.tool(
    'idevicesyslog',
    `echo $$ > "$FAKE_STATE/idevicesyslog.pid"
echo "[connected:${UDID}]"
echo "Oct  4 09:53:23.101270 locationd[27551] <Debug>: from idevicesyslog"
echo "*** Device is passcode protected, enter passcode on the device to continue ***"
${extra}
while :; do sleep 1; done`,
  )
}

describe.skipIf(!hasOpenssl)('iOS logs: syslog_relay', () => {
  it('streams NUL-framed messages as lines, inner newlines split', async () => {
    const r = await rig()
    const s = await stream(r)
    expect(await s.waitFor((m) => m.t === 'hello')).toMatchObject({
      t: 'hello',
      device: UDID,
      source: 'syslog_relay',
    })
    await until(() => linesOf(s).length >= 3, 2_000, 'lines')
    expect(linesOf(s)).toEqual([
      'Oct  4 08:19:52 Ngocs-iPhone-12-Pro locationd[27551] <Notice>: first',
      'Oct  4 08:19:52 Ngocs-iPhone-12-Pro SpringBoard[60] <Error>: two',
      'lines',
    ])
    /** The session that started the service was stopped; the service runs on its own. */
    const requests = r.phone.requests.map((q) => q.Request)
    expect(requests.slice(-2)).toEqual(['StartService', 'StopSession'])
    s.abort()
  })

  it('batches a busy relay into records of at most 200 lines', async () => {
    const messages = Array.from({ length: 250 }, (_, i) => `line ${String(i)}\n`)
    const r = await rig({ syslog: { ssl: true, messages, intervalMs: 0 } })
    const s = await stream(r)
    await until(() => linesOf(s).length >= 250, 3_000, '250 lines')
    const batches = s.messages.filter((m): m is Extract<LogMsg, { t: 'lines' }> => m.t === 'lines')
    expect(batches.every((b) => b.lines.length <= 200)).toBe(true)
    expect(linesOf(s).slice(0, 2)).toEqual(['line 0', 'line 1'])
    s.abort()
  })

  it('ends with device-gone when the iPhone is unplugged', async () => {
    const r = await rig({ syslog: { ssl: false, messages: ['tick\n'], intervalMs: 50 } })
    const s = await stream(r)
    await s.waitFor((m) => m.t === 'lines')
    r.unplug()
    expect(await s.waitFor((m) => m.t === 'end')).toEqual({ t: 'end', reason: 'device-gone' })
  })

  it('ends with eof when the relay closes', async () => {
    const r = await rig({
      syslog: { ssl: true, messages: ['only\n'], intervalMs: 0, closeAfter: true },
    })
    const s = await stream(r)
    expect(await s.waitFor((m) => m.t === 'end')).toEqual({ t: 'end', reason: 'eof' })
    expect(linesOf(s)).toEqual(['only'])
  })

  it('over Wi-Fi, a link that drops ends the log as a drop; the held row resumes it when back', async () => {
    const r = await startIosRig({
      chain,
      connection: 'Network',
      script: { syslog: { ssl: true, messages: ['tick\n'], intervalMs: 50 } },
      bridge: { wifi: true },
      tuning: { wifiStableMs: 100, wifiHoldMs: 5_000 },
    })
    await r.waitRow((row) => row?.state === 'ready', 'ready')
    const s = await stream(r)
    await s.waitFor((m) => m.t === 'lines')
    r.unplug()
    expect(await s.waitFor((m) => m.t === 'end')).toEqual({
      t: 'end',
      reason: 'device-gone',
      code: 'DEVICE_DROPPED',
      message: 'The iPhone dropped off Wi-Fi.',
    })
    /** Still listed (the hold); asking now says why it cannot, in a code the page waits out. */
    expect(r.row()?.state).toBe('ready')
    const away = await refused(r)
    expect([away.status, away.json<ErrorBody>().error.code]).toEqual([502, 'IOS_UNREACHABLE'])
    r.plug('Network')
    const again = await stream(r)
    await again.waitFor((m) => m.t === 'lines')
    again.abort()
  })

  it('over USB a relay that closes is still a plain eof', async () => {
    const r = await rig({
      syslog: { ssl: false, messages: ['only\n'], intervalMs: 0, closeAfter: true },
    })
    const s = await stream(r)
    expect(await s.waitFor((m) => m.t === 'end')).toEqual({ t: 'end', reason: 'eof' })
  })

  it('a client that leaves closes the service socket within 100 ms', async () => {
    const r = await rig({ syslog: { ssl: true, messages: ['tick\n'], intervalMs: 50 } })
    const s = await stream(r)
    await s.waitFor((m) => m.t === 'lines')
    const left = Date.now()
    s.abort()
    await until(() => r.phone.services[0]?.closedAt != null, 1_000, 'service closed')
    expect((r.phone.services[0]?.closedAt ?? Infinity) - left).toBeLessThan(100)
  })

  it('a client that leaves during the service handshake leaves no relay behind', async () => {
    const r = await rig({
      syslog: { ssl: true, messages: ['tick\n'], intervalMs: 20, holdMs: 400 },
    })
    /** Raw: the stream has no headers yet, so the harness's openStream would still be waiting. */
    const req = http.request({
      host: '127.0.0.1',
      port: r.s.port,
      path: r.path('logs'),
      agent: false,
      headers: { Host: `127.0.0.1:${String(r.s.port)}`, ...r.s.auth },
    })
    req.on('error', () => undefined)
    req.end()
    await until(() => r.phone.services.length === 1, 2_000, 'service connection')
    req.destroy()
    await until(() => r.phone.services[0]?.closedAt != null, 1_500, 'service closed')
  })
})

describe.skipIf(!hasOpenssl)('iOS logs: pinning', () => {
  it('another certificate on the syslog_relay service → 502 IOS_LOCKDOWN_FAILED, no fallback', async () => {
    const r = await rig({}, { syslogTool: (x) => idevicesyslog(x) })
    r.phone.script.servicePresentCert = other.device
    const reply = await refused(r)
    expect([reply.status, reply.json<ErrorBody>().error.code]).toEqual([502, 'IOS_LOCKDOWN_FAILED'])
    await until(() => r.phone.services[0]?.closedAt != null, 1_000, 'service closed')
    expect(r.s.bin.calls().filter((c) => c.name === 'idevicesyslog')).toEqual([])
    await r.waitRow((row) => row?.state === 'offline', 'offline')
  })

  it('another certificate on the session → 502 IOS_LOCKDOWN_FAILED before any service starts', async () => {
    const r = await rig({}, { syslogTool: (x) => idevicesyslog(x) })
    r.phone.script.presentCert = other.device
    const reply = await refused(r)
    expect([reply.status, reply.json<ErrorBody>().error.code]).toEqual([502, 'IOS_LOCKDOWN_FAILED'])
    expect(r.phone.requests.filter((q) => q.Request === 'StartService')).toEqual([])
    expect(r.s.bin.calls().filter((c) => c.name === 'idevicesyslog')).toEqual([])
    expect(r.row()?.state).toBe('offline')
  })
})

describe.skipIf(!hasOpenssl)('iOS logs: fallbacks', () => {
  it('8 s of silence → idevicesyslog, with a notice', async () => {
    const r = await rig(
      { syslog: { ssl: true, messages: [], intervalMs: 0 } },
      { syslogTool: (x) => idevicesyslog(x), silenceMs: 300 },
    )
    const s = await stream(r)
    expect(await s.waitFor((m) => m.t === 'hello')).toMatchObject({ source: 'syslog_relay' })
    expect(await s.waitFor((m) => m.t === 'notice')).toEqual({
      t: 'notice',
      text: 'Switched to idevicesyslog',
    })
    await until(() => linesOf(s).length >= 2, 3_000, 'fallback lines')
    expect(linesOf(s)).toEqual([
      'Oct  4 09:53:23.101270 locationd[27551] <Debug>: from idevicesyslog',
      '*** Device is passcode protected, enter passcode on the device to continue ***',
    ])
    const run = r.s.bin.calls().find((c) => c.name === 'idevicesyslog')
    expect(run?.argv).toEqual(['-u', UDID, '--no-colors', '-x'])
    s.abort()
    await until(
      () => {
        const pid = r.s.bin.pid('idevicesyslog')
        try {
          if (pid) process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      3_000,
      'idevicesyslog stopped',
    )
  })

  it('no syslog_relay on the phone → idevicesyslog from the start', async () => {
    const r = await rig({ syslog: 'InvalidService' }, { syslogTool: (x) => idevicesyslog(x) })
    const s = await stream(r)
    expect(await s.waitFor((m) => m.t === 'hello')).toMatchObject({ source: 'idevicesyslog' })
    expect(await s.waitFor((m) => m.t === 'notice')).toEqual({
      t: 'notice',
      text: 'Connected through idevicesyslog',
    })
    s.abort()
  })

  it('idevicesyslog [disconnected:…] ends the stream as device-gone', async () => {
    const r = await rig(
      { syslog: 'InvalidService' },
      { syslogTool: (x) => idevicesyslog(x, `sleep 0.2; echo "[disconnected:${UDID}]"`) },
    )
    const s = await stream(r)
    const end = await s.waitFor((m) => m.t === 'end', 4_000)
    expect(end).toMatchObject({ t: 'end', reason: 'device-gone' })
  })

  it('no log source at all → 503 LOGS_UNAVAILABLE before hello', async () => {
    const r = await rig({ syslog: 'InvalidService' })
    const reply = await refused(r)
    expect(reply.status).toBe(503)
    expect(reply.json<{ error: { code: string } }>().error.code).toBe('LOGS_UNAVAILABLE')
  })

  it('StartService refused while locked → 409 IOS_LOCKED; the row stays ready', async () => {
    const r = await rig({ syslog: 'PasswordProtected' })
    const reply = await refused(r)
    expect(reply.status).toBe(409)
    expect(reply.json<{ error: { code: string } }>().error.code).toBe('IOS_LOCKED')
    expect(r.row()?.state).toBe('ready')
  })
})
