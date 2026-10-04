/*
  Opt-in, read-only run against this Mac's REAL simulators (§9.2):
    DEVICE_BRIDGE_REAL=1 npm run test:helper -- simulators-real

  It only looks at simulators that are ALREADY booted, and boots, shuts down or changes
  nothing: list, detail, one screenshot, a few seconds of log, then it checks that no
  `simctl spawn … log stream` it started is left behind. It runs CoreSimulator's real simctl
  binary directly (never the xcrun wrapper, which could start Xcode's first launch).
*/
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBridge } from '../src/bridge'
import { liveChildren, runTool } from '../src/process'
import { createSimulatorLane } from '../src/simulator-lane'
import type { HelperDevice, Snapshot } from '../src/types'
import { isStream, isolation, onCleanup, openStream, request, toolbox, until } from './harness'

const REAL = process.env.DEVICE_BRIDGE_REAL === '1'
const SIMCTL =
  '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl'

/** The selected Xcode, as `xcode-select -p` prints it (2 s), or null. */
function developerDir(): string | null {
  try {
    return execFileSync('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim()
  } catch {
    return null
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** Processes whose command line is a log stream spawned in `udid` (read-only `ps`). */
function logStreams(udid: string): string[] {
  return execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8', timeout: 5_000 })
    .split('\n')
    .filter((line) => line.includes(`spawn ${udid} log stream`))
}

describe.runIf(REAL && process.platform === 'darwin' && existsSync(SIMCTL))(
  'real simulators (opt-in, read-only)',
  () => {
    it('lists, details, screenshots and streams an already-booted simulator', async () => {
      const devDir = developerDir()
      expect(devDir, 'xcode-select -p').toBeTruthy()
      const env = { ...process.env, DEVELOPER_DIR: devDir ?? '' }
      const { stdout } = await runTool(SIMCTL, ['list', '-j', 'devices', 'booted'], {
        timeoutMs: 10_000,
        env,
      })
      const booted = Object.entries(
        (JSON.parse(stdout) as { devices: Record<string, Array<{ state: string }>> }).devices,
      )
        .filter(([runtime]) => runtime.includes('SimRuntime.iOS-'))
        .flatMap(([, list]) => list)
        .filter((d) => d.state === 'Booted')
      if (booted.length === 0) {
        console.warn('No booted iOS simulator: nothing to check (this test never boots one).')
        return
      }

      const iso = await isolation({ simulators: true, timeouts: { logHello: 15_000 } })
      const bridge = createBridge({
        ...iso.input,
        platform: 'darwin',
        env: process.env,
        lanes: { ios: null, android: null, simulators: createSimulatorLane },
        resolveTools: () =>
          Promise.resolve(
            toolbox((t) => {
              t.simctl = {
                ...t.simctl,
                state: 'ready',
                devDir,
                simctl: SIMCTL,
              }
            }),
          ),
      })
      const { port } = await bridge.listen()
      onCleanup(() => bridge.close())
      const auth = { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' }
      const snapshot = async (): Promise<Snapshot> =>
        (await request(port, { path: '/api/devices', headers: auth })).json()

      await until(async () => (await snapshot()).devices.length === booted.length, 15_000)
      const device = (await snapshot()).devices.find((d) => d.state === 'ready') as HelperDevice
      expect(device).toMatchObject({ platform: 'ios', connection: 'simulator' })
      expect(device.modelId).toMatch(/^(iPhone|iPad)\d+,\d+$/)

      const detail = await request(port, {
        path: `/api/devices/${device.id}/detail`,
        headers: auth,
      })
      expect(detail.json()).toMatchObject({ kind: 'simulator', facts: { udid: device.id } })
      expect(detail.text).not.toContain('/Users/')

      const shot = await request(port, {
        method: 'POST',
        path: `/api/devices/${device.id}/screenshot`,
        headers: auth,
      })
      expect(shot.status).toBe(200)
      const size = pngSize(shot.body)
      expect(size.width).toBeGreaterThan(300)
      expect(size.height).toBeGreaterThan(300)

      const started = Date.now()
      const stream = await openStream(port, `/api/devices/${device.id}/logs`, auth)
      if (!isStream(stream)) throw new Error(stream.text)
      await stream.waitFor((m) => m.t === 'lines', 10_000)
      console.info(`first log batch after ${String(Date.now() - started)} ms`)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(logStreams(device.id).length).toBeGreaterThan(0)
      stream.abort()
      await until(() => logStreams(device.id).length === 0, 3_000, 'log stream gone')
      await until(() => [...liveChildren].length === 0, 3_000, 'no tool left')
    }, 60_000)
  },
)
