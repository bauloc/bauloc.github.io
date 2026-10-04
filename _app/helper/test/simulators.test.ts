/*
  WP3, simulators (§5, §9.2 simulators row): the simctl join on the research's real JSON, and
  the lane through the bridge against a fake simctl binary. The fake records every call, so
  the tests also prove what never ran: `-` as a screenshot path, a screenshot of a simulator
  that is not booted, simctl on an Xcode whose first launch is pending, boot or shutdown.
*/
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBridge } from '../src/bridge'
import {
  SIMCTL_COMMANDS,
  createSimulatorLane,
  parseSimctlList,
  simEntries,
  simFacts,
  simctlReason,
} from '../src/simulator-lane'
import type { SimctlInfo } from '../src/tools'
import type { Snapshot, Timeouts } from '../src/types'
import { sleep } from '../src/util'
import { alive, type FakeBin } from './fakes/bin'
import {
  isStream,
  isolation,
  onCleanup,
  openStream,
  request,
  tinyPng,
  toolbox,
  until,
  type Stream,
} from './harness'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown

const DEVICES = fixture('simctl-devices.json')
const RUNTIMES = fixture('simctl-runtimes.json')
const DEVICETYPES = fixture('simctl-devicetypes.json')

const IPHONE_18_PRO = 'A1AED6E5-7DDB-4536-AE22-CA4C1D6B8D9E'
const IPHONE_11_PRO = '87B187EA-3710-48F0-A16F-8861DA0444DD'
const IPAD_PRO = 'DB07459C-6FCF-4997-BA30-18EC48825F5A'
const SHUT_DOWN = '7016E0D8-CDEC-42BE-8E0C-D998A18C03B2'

type DevicesJson = { devices: Record<string, Array<Record<string, unknown>>> }

/** The devices fixture with some simulators' states changed (or removed with null). */
function devicesWith(states: Record<string, string | null>): DevicesJson {
  const copy = JSON.parse(JSON.stringify(DEVICES)) as DevicesJson
  for (const [runtime, list] of Object.entries(copy.devices)) {
    copy.devices[runtime] = list
      .filter((d) => states[String(d.udid)] !== null)
      .map((d) => {
        const state = states[String(d.udid)]
        return state ? { ...d, state } : d
      })
  }
  return copy
}

/* ---------------------------------------------------------------------- the join --- */

describe('parseSimctlList (§5)', () => {
  it('lists the booted iOS simulators, joined with runtime and device type', () => {
    const rows = parseSimctlList(DEVICES, RUNTIMES, DEVICETYPES)
    expect(rows.map((r) => r.id).sort()).toEqual([IPHONE_11_PRO, IPHONE_18_PRO, IPAD_PRO].sort())
    expect(rows.find((r) => r.id === IPHONE_18_PRO)).toEqual({
      id: IPHONE_18_PRO,
      platform: 'ios',
      connection: 'simulator',
      state: 'ready',
      name: 'iPhone 18 Pro',
      model: 'iPhone 18 Pro',
      modelId: 'iPhone19,2',
      osVersion: '27.0',
      blockers: [],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
    })
    expect(rows.find((r) => r.id === IPHONE_11_PRO)).toMatchObject({
      modelId: 'iPhone12,3',
      osVersion: '18.0',
    })
    expect(rows.find((r) => r.id === IPAD_PRO)).toMatchObject({
      name: 'iPad Pro 13-inch (M5)',
      modelId: 'iPad17,4',
    })
  })

  it('keeps only iOS runtimes', () => {
    const devices = devicesWith({})
    devices.devices['com.apple.CoreSimulator.SimRuntime.watchOS-11-0'] = [
      {
        udid: '11111111-2222-3333-4444-555555555555',
        name: 'Apple Watch Series 10 (46mm)',
        state: 'Booted',
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm',
      },
    ]
    devices.devices['com.apple.CoreSimulator.SimRuntime.xrOS-2-0'] = [
      { udid: '11111111-2222-3333-4444-666666666666', name: 'Apple Vision Pro', state: 'Booted' },
    ]
    expect(parseSimctlList(devices, RUNTIMES, DEVICETYPES)).toHaveLength(3)
  })

  it('Booting is connecting, with no capabilities; Shutdown is not listed', () => {
    const rows = parseSimctlList(
      devicesWith({ [IPHONE_18_PRO]: 'Booting', [IPHONE_11_PRO]: 'Shutting Down' }),
      RUNTIMES,
      DEVICETYPES,
    )
    expect(rows.map((r) => r.id).sort()).toEqual([IPHONE_18_PRO, IPAD_PRO].sort())
    expect(rows.find((r) => r.id === IPHONE_18_PRO)).toMatchObject({
      state: 'connecting',
      capabilities: { screenshot: false, identifiers: false, logs: false, install: false },
    })
  })

  it('falls back to what the identifiers say when runtimes or device types are missing', () => {
    const rows = parseSimctlList(DEVICES, {}, null)
    expect(rows.find((r) => r.id === IPHONE_18_PRO)).toMatchObject({
      name: 'iPhone 18 Pro',
      model: '',
      modelId: '',
      osVersion: '27.0',
    })
  })

  it('survives malformed JSON and skips ids no request could address', () => {
    expect(parseSimctlList(null, null, null)).toEqual([])
    expect(parseSimctlList({ devices: [] }, 'x', 3)).toEqual([])
    expect(
      parseSimctlList(
        {
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
              { udid: '--help', state: 'Booted', name: 'x' },
              { udid: '../../etc', state: 'Booted', name: 'y' },
              'not an object',
            ],
          },
        },
        RUNTIMES,
        DEVICETYPES,
      ),
    ).toEqual([])
  })

  it('the detail facts never carry the data or log path (they name the Mac’s user)', () => {
    const entry = simEntries(DEVICES, RUNTIMES, DEVICETYPES).find((e) => e.udid === IPHONE_18_PRO)
    if (!entry) throw new Error('missing')
    const facts = simFacts(entry)
    expect(facts).toEqual({
      udid: IPHONE_18_PRO,
      name: 'iPhone 18 Pro',
      deviceType: { name: 'iPhone 18 Pro', modelIdentifier: 'iPhone19,2' },
      runtime: { name: 'iOS 27.0', version: '27.0', build: '24A434' },
      state: 'Booted',
      dataPathSize: 4709453824,
    })
    expect(JSON.stringify(facts)).not.toMatch(/Users|dataPath"|logPath/)
  })

  it('runs only list, io screenshot and spawn log stream: never boot, shutdown or erase', () => {
    const verbs = SIMCTL_COMMANDS.map((argv) => argv[0])
    expect([...new Set(verbs)]).toEqual(['list', 'io', 'spawn'])
  })

  it('words the unavailable reasons for the banner', () => {
    const info = (state: SimctlInfo['state']): SimctlInfo => ({
      state,
      devDir: null,
      simctl: null,
      coreSimulator: null,
      expected: null,
    })
    expect(simctlReason(info('not-installed'))).toBe('simulators need Xcode')
    expect(simctlReason(info('needs-first-launch'))).toBe(
      'Xcode must finish setting up before simulators work: open Xcode once',
    )
  })
})

/* ------------------------------------------------------------- the lane via HTTP --- */

const FAST: Partial<Timeouts> = {
  simctlList: 3_000,
  simctlScreenshot: 3_000,
  logFirstByte: 3_000,
  logHello: 5_000,
  retry: 5_000,
}

/** A fake simctl: lists from fixtures, saves a PNG, streams a compact log; all scriptable. */
function fakeSimctl(bin: FakeBin): string {
  bin.fixture('devices.json', JSON.stringify(DEVICES))
  bin.fixture('runtimes.json', JSON.stringify(RUNTIMES))
  bin.fixture('devicetypes.json', JSON.stringify(DEVICETYPES))
  bin.fixture('shot.png', tinyPng())
  return bin.file(
    path.join(bin.state, 'Xcode.app/CoreSimulator/bin/simctl'),
    `printf '%s' "$DEVELOPER_DIR" > "$FAKE_STATE/developer-dir"
# Its own call log, one write per line: the lane runs three lists at once.
line=$(printf '%s\t' "$@")
printf '%s\n' "$line" >> "$FAKE_STATE/simctl.log"
case "$1" in
  list) cat "$FAKE_STATE/fixtures/$3.json" ;;
  io)
    [ -f "$FAKE_STATE/fixtures/hang-screenshot" ] && sleep 60
    pwd > "$FAKE_STATE/screenshot-cwd"
    cat "$FAKE_STATE/fixtures/shot.png" > "$5" ;;
  spawn)
    if [ -f "$FAKE_STATE/fixtures/spawn-exit" ]; then
      echo 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405)' >&2
      exit "$(cat "$FAKE_STATE/fixtures/spawn-exit")"
    fi
    echo $$ > "$FAKE_STATE/simctl.pid"
    echo 'getpwuid_r did not find a match for uid 501' >&2
    printf 'Timestamp               Ty Process[PID:TID]\\n'
    sleep 60 &
    echo $! > "$FAKE_STATE/simctl.gpid"
    i=0
    while :; do
      i=$((i+1))
      echo "2026-10-04 08:32:26.731 I  UserEventAgent[38363:6797d5] [com.apple.x:y] line $i"
      [ -f "$FAKE_STATE/fixtures/spawn-end" ] && exit 0
      sleep 0.05
    done ;;
  *) exit 64 ;;
esac`,
    'simctl',
  )
}

interface SimRun {
  port: number
  auth: Record<string, string>
  bin: FakeBin
  simctl: string
  logs: string[]
  snapshot: () => Promise<Snapshot>
  calls: () => string[][]
}

async function startSimulators(state: SimctlInfo['state'] = 'ready'): Promise<SimRun> {
  const iso = await isolation({ timeouts: FAST, simulators: true })
  const simctl = fakeSimctl(iso.bin)
  const bridge = createBridge({
    ...iso.input,
    platform: 'darwin',
    lanes: {
      ios: null,
      android: null,
      simulators: (ctx) => createSimulatorLane(ctx, { listMs: 100 }),
    },
    resolveTools: () =>
      Promise.resolve(
        toolbox((t) => {
          t.simctl = {
            state,
            devDir: '/Applications/Xcode.app/Contents/Developer',
            simctl: state === 'ready' ? simctl : null,
            coreSimulator: state === 'ready' ? '1171.7' : '1100.1',
            expected: '1171.7',
          }
        }),
      ),
  })
  const { port } = await bridge.listen()
  onCleanup(() => bridge.close())
  const auth = { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' }
  return {
    port,
    auth,
    bin: iso.bin,
    simctl,
    logs: iso.logs,
    snapshot: async () => (await request(port, { path: '/api/devices', headers: auth })).json(),
    calls: () => simctlCalls(iso.bin),
  }
}

async function listed(run: SimRun, count = 3): Promise<void> {
  await until(async () => (await run.snapshot()).devices.length === count, 4_000, 'simulators')
}

describe('the simulator lane through the bridge', () => {
  it('lists booted simulators with the real binary and DEVELOPER_DIR', async () => {
    const run = await startSimulators()
    await listed(run)
    const snapshot = await run.snapshot()
    expect(snapshot.lanes.simulators).toEqual({ status: 'ok', booted: 3 })
    expect(snapshot.devices.every((d) => d.connection === 'simulator')).toBe(true)
    expect(run.calls()).toContainEqual(['list', '-j', 'devices', 'booted'])
    expect(readFileSync(path.join(run.bin.state, 'developer-dir'), 'utf8')).toBe(
      '/Applications/Xcode.app/Contents/Developer',
    )
    /** Each simulator gets the same arrival line a phone does. */
    expect(
      run.logs.some((l) => l.includes('+ iPhone 18 Pro · iOS 27.0 · Simulator · booted')),
    ).toBe(true)
  })

  it('first launch pending: unavailable, and simctl never runs', async () => {
    const run = await startSimulators('needs-first-launch')
    await until(async () => (await run.snapshot()).lanes.simulators.status === 'unavailable', 2_000)
    await sleep(300)
    const snapshot = await run.snapshot()
    expect(snapshot.lanes.simulators).toMatchObject({
      status: 'unavailable',
      reason: 'Xcode must finish setting up before simulators work: open Xcode once',
    })
    expect(snapshot.devices).toEqual([])
    expect(run.calls()).toEqual([])
  })

  it('detail: the simulator facts', async () => {
    const run = await startSimulators()
    await listed(run)
    const reply = await request(run.port, {
      path: `/api/devices/${IPHONE_18_PRO}/detail`,
      headers: run.auth,
    })
    expect(reply.json()).toMatchObject({
      platform: 'ios',
      kind: 'simulator',
      facts: { udid: IPHONE_18_PRO, runtime: { version: '27.0' }, state: 'Booted' },
    })
  })

  it('screenshot: into a private temp file (never `-`), removed afterwards', async () => {
    const run = await startSimulators()
    await listed(run)
    const reply = await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPHONE_18_PRO}/screenshot`,
      headers: run.auth,
    })
    expect(reply.status).toBe(200)
    expect(reply.headers['x-screenshot-source']).toBe('simctl')
    expect(reply.body.equals(tinyPng())).toBe(true)
    const shot = run.calls().find((argv) => argv[0] === 'io')
    expect(shot?.slice(0, 4)).toEqual(['io', IPHONE_18_PRO, 'screenshot', '--type=png'])
    const file = shot?.[4] ?? ''
    expect(file).not.toBe('-')
    expect(path.basename(file)).toBe('shot.png')
    /** The tool ran inside that private folder, which is gone now. */
    const cwd = readFileSync(path.join(run.bin.state, 'screenshot-cwd'), 'utf8').trim()
    const unprivate = (p: string): string => p.replace(/^\/private(?=\/)/, '')
    expect(unprivate(cwd)).toBe(unprivate(path.dirname(file)))
    expect(existsSync(path.dirname(file))).toBe(false)
  })

  it('screenshot: refused at once when the simulator is no longer booted (no hang)', async () => {
    const run = await startSimulators()
    await listed(run)
    /** It shut down after the last list: the fresh Booted check catches it. */
    run.bin.fixture('devices.json', JSON.stringify(devicesWith({ [IPHONE_18_PRO]: 'Shutdown' })))
    run.bin.fixture('hang-screenshot', '')
    const started = Date.now()
    const reply = await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPHONE_18_PRO}/screenshot`,
      headers: run.auth,
    })
    expect(reply.status).toBe(404)
    expect(reply.json()).toMatchObject({ error: { code: 'DEVICE_NOT_FOUND' } })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(run.calls().some((argv) => argv[0] === 'io')).toBe(false)
  })

  it('screenshot: a booting simulator is not ready; a hung capture times out', async () => {
    const run = await startSimulators()
    await listed(run)
    run.bin.fixture('devices.json', JSON.stringify(devicesWith({ [IPHONE_11_PRO]: 'Booting' })))
    await until(async () => (await run.snapshot()).devices.some((d) => d.state === 'connecting'))
    const booting = await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPHONE_11_PRO}/screenshot`,
      headers: run.auth,
    })
    expect(booting.status).toBe(409)

    run.bin.fixture('hang-screenshot', '')
    const hung = await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPHONE_18_PRO}/screenshot`,
      headers: run.auth,
    })
    expect(hung.status).toBe(504)
    expect(hung.json()).toMatchObject({ error: { code: 'TOOL_TIMEOUT' } })
  })

  it('logs: header and stderr dropped; leaving reaps simctl and its grandchild', async () => {
    const run = await startSimulators()
    await listed(run)
    const stream = await openStream(run.port, `/api/devices/${IPHONE_18_PRO}/logs`, run.auth)
    if (!isStream(stream)) throw new Error(stream.text)
    expect(stream.messages[0]).toMatchObject({ t: 'hello', source: 'simctl' })
    await stream.waitFor((m) => m.t === 'lines' && m.lines.some((l) => l.endsWith('line 3')))
    const lines = stream.messages.flatMap((m) => (m.t === 'lines' ? m.lines : []))
    expect(lines.some((l) => l.startsWith('Timestamp'))).toBe(false)
    expect(lines.some((l) => l.includes('getpwuid_r'))).toBe(false)
    expect(lines[0]).toMatch(/^2026-10-04 08:32:26\.731 I {2}UserEventAgent\[38363:6797d5\]/)
    expect(run.calls()).toContainEqual([
      'spawn',
      IPHONE_18_PRO,
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
    ])
    const pid = run.bin.pid('simctl')
    const gpid = run.bin.gpid('simctl')
    expect(alive(pid) && alive(gpid)).toBe(true)
    stream.abort()
    await until(() => !alive(pid) && !alive(gpid), 3_000, 'simctl and its grandchild gone')
  })

  it('logs: simctl exit 149 (not booted) is a JSON 409 before any stream', async () => {
    const run = await startSimulators()
    await listed(run)
    run.bin.fixture('spawn-exit', '149')
    const reply = await openStream(run.port, `/api/devices/${IPHONE_18_PRO}/logs`, run.auth)
    expect(isStream(reply)).toBe(false)
    expect(reply.status).toBe(409)
    expect((reply as { json: () => unknown }).json()).toMatchObject({
      error: { code: 'DEVICE_NOT_READY' },
    })
  })

  it('logs: simctl exit 148 (unknown device) is a 404', async () => {
    const run = await startSimulators()
    await listed(run)
    run.bin.fixture('spawn-exit', '148')
    const reply = await openStream(run.port, `/api/devices/${IPHONE_18_PRO}/logs`, run.auth)
    expect(reply.status).toBe(404)
  })

  it('logs: a simulator that shuts down ends the stream as device-gone', async () => {
    const run = await startSimulators()
    await listed(run)
    const stream = (await openStream(
      run.port,
      `/api/devices/${IPHONE_18_PRO}/logs`,
      run.auth,
    )) as Stream
    await stream.waitFor((m) => m.t === 'lines')
    run.bin.fixture('devices.json', JSON.stringify(devicesWith({ [IPHONE_18_PRO]: null })))
    run.bin.fixture('spawn-end', '')
    const end = await stream.waitFor((m) => m.t === 'end', 5_000)
    expect(end).toMatchObject({ reason: 'device-gone' })
  })

  it('polls only while a page is active, and rescan refreshes the runtime catalog', async () => {
    const run = await startSimulators()
    await listed(run)
    const catalogCalls = (): number =>
      run.calls().filter((argv) => argv[0] === 'list' && argv[2] === 'runtimes').length
    expect(catalogCalls()).toBe(1)
    await request(run.port, { method: 'POST', path: '/api/rescan', headers: run.auth })
    expect(catalogCalls()).toBe(2)
    /** The 100 ms poll re-lists devices only, from the cached catalog. */
    const before = run.calls().length
    await sleep(350)
    const polled = run.calls().slice(before)
    expect(polled.length).toBeGreaterThan(0)
    expect(polled.every((argv) => argv[2] === 'devices')).toBe(true)
  })

  it('nothing it ran ever boots, shuts down, erases or installs', async () => {
    const run = await startSimulators()
    await listed(run)
    await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPHONE_18_PRO}/screenshot`,
      headers: run.auth,
    })
    await request(run.port, {
      method: 'POST',
      path: `/api/devices/${IPAD_PRO}/retry`,
      headers: run.auth,
    })
    for (const argv of run.calls()) {
      expect(['list', 'io', 'spawn']).toContain(argv[0])
      expect(argv).not.toContain(SHUT_DOWN)
    }
  })
})

/** Every argv the fake simctl was run with, from its own log. */
function simctlCalls(bin: FakeBin): string[][] {
  const file = path.join(bin.state, 'simctl.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\t$/, '').split('\t'))
}
