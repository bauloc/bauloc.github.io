/*
  §3.7 screenshots through the real iOS lane and the bridge: devicectl (the real binary in a
  fake CoreDevice tree, never the wrapper next to it), every classifyDevicectl outcome,
  idevicescreenshot for iOS 16 and older, and the errors when nothing applies.
*/
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Toolbox } from '../src/tools'
import type { ErrorBody } from '../src/types'
import { request, tempDir, tinyPng, toolbox } from './harness'
import { hasOpenssl, makeChain, type Chain } from './fakes/certs'
import { UDID, plaintextKeys, sessionKeys, startIosRig, type IosRig } from './fakes/lockdownd'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

let chain: Chain
beforeAll(() => {
  if (hasOpenssl) chain = makeChain(tempDir('certs-'), 'empty')
}, 30_000)

const envelope = (code: number, text: string): string =>
  JSON.stringify({
    error: {
      code,
      domain: 'com.apple.dt.CoreDeviceError',
      userInfo: { NSLocalizedDescription: { string: text } },
    },
    info: { outcome: 'failed', jsonVersion: 5 },
  })

interface Xcode {
  devDir: string
  wrapper: string
  real: string
  /** What the next devicectl run does. */
  scenario: (name: string) => void
}

/**
 * A fake Xcode: the zsh-style wrapper at <devDir>/usr/bin/devicectl (EXPECTED_VERSION, then
 * `xcodebuild -runFirstLaunch`), and the real binary in a CoreDevice tree. Scenarios read
 * $FAKE_STATE/devicectl.scenario; `4016-once` fails the first call only.
 */
function fakeXcode(rig: IosRig): Xcode {
  const root = tempDir('xcode-')
  const devDir = path.join(root, 'Xcode.app/Contents/Developer')
  const real = path.join(root, 'CoreDevice.framework/Versions/A/Resources/bin/devicectl')
  const { bin } = rig.s
  bin.fixture('shot.png', tinyPng())
  bin.fixture('success.json', readFileSync(path.join(FIXTURES, 'ios-devicectl-success.json')))
  bin.fixture('4016.json', readFileSync(path.join(FIXTURES, 'ios-devicectl-4016.json')))
  bin.fixture('1000.json', readFileSync(path.join(FIXTURES, 'ios-devicectl-1000.json')))
  bin.fixture('1001.json', readFileSync(path.join(FIXTURES, 'ios-devicectl-1001.json')))
  bin.fixture('timeout.json', readFileSync(path.join(FIXTURES, 'ios-devicectl-timeout.json')))
  bin.fixture('locked.json', envelope(3, 'The operation failed since the device is locked.'))
  bin.fixture('devmode.json', envelope(3, 'Developer Mode is turned off on the device.'))
  bin.fixture('other.json', envelope(99, 'Something unexpected happened.'))
  const wrapper = bin.file(
    path.join(devDir, 'usr/bin/devicectl'),
    `EXPECTED_VERSION="642.16"
"$FAKE_STATE/../bin/xcodebuild" -runFirstLaunch
exec ${JSON.stringify(real)} "$@"`,
    'devicectl-wrapper',
  )
  bin.file(
    real,
    `json=$(arg_after --json-output "$@")
dest=$(arg_after --destination "$@")
[ "$DEVELOPER_DIR" = ${JSON.stringify(devDir)} ] || { echo "wrong DEVELOPER_DIR" >&2; exit 9; }
scenario=$(cat "$FAKE_STATE/devicectl.scenario" 2>/dev/null || echo success)
if [ "$scenario" = 4016-once ]; then
  if [ -f "$FAKE_STATE/4016.done" ]; then scenario=success; else touch "$FAKE_STATE/4016.done"; scenario=4016; fi
fi
case "$scenario" in
  success) cp "$FAKE_STATE/fixtures/shot.png" "$dest"; cp "$FAKE_STATE/fixtures/success.json" "$json"; exit 0 ;;
  no-image) cp "$FAKE_STATE/fixtures/success.json" "$json"; exit 0 ;;
  exit64) echo "Error: Unknown option '--destination'" >&2; exit 64 ;;
  exit2) exit 2 ;;
  hang) sleep 30 ;;
  *) cp "$FAKE_STATE/fixtures/$scenario.json" "$json"; exit 1 ;;
esac`,
    'devicectl',
  )
  bin.simple('xcodebuild')
  return {
    devDir,
    wrapper,
    real,
    scenario: (name) => bin.fixture('../devicectl.scenario', name),
  }
}

function readyXcode(x: Xcode): (t: Toolbox) => void {
  return (t) => {
    t.xcode = {
      ...t.xcode,
      state: 'ready',
      devDir: x.devDir,
      devicectl: x.real,
      version: '27.0',
      build: '27A266a',
      coreDevice: '642.16',
      expected: '642.16',
      license: true,
    }
  }
}

async function rigWithXcode(
  opts: { old?: boolean; tools?: (t: Toolbox, x: Xcode, rig: IosRig) => void } = {},
): Promise<{ rig: IosRig; x: Xcode; shoot: () => ReturnType<typeof request> }> {
  const toolsRef: { current: Toolbox | null } = { current: null }
  const script = opts.old
    ? {
        plaintext: plaintextKeys({ ProductVersion: '16.7', ProductType: 'iPhone10,1' }),
        session: sessionKeys({ ProductVersion: '16.7', ProductType: 'iPhone10,1' }),
      }
    : {}
  const rig = await startIosRig({
    chain,
    plugged: false,
    script,
    toolsRef,
    tuning: { devicectlRetryMs: 100 },
    bridge: { timeouts: { toolsCache: 0, devicectlScreenshot: 3_000, idevicescreenshot: 3_000 } },
  })
  const x = fakeXcode(rig)
  toolsRef.current = toolbox((t) => {
    readyXcode(x)(t)
    opts.tools?.(t, x, rig)
  })
  rig.plug()
  await rig.waitRow((r) => r?.state === 'ready', 'ready')
  const shoot = (): ReturnType<typeof request> =>
    request(rig.s.port, { method: 'POST', path: rig.path('screenshot'), headers: rig.s.auth })
  return { rig, x, shoot }
}

const code = (reply: { json: <T>() => T }): string => reply.json<ErrorBody>().error.code

describe.skipIf(!hasOpenssl)('iOS screenshots through devicectl', () => {
  it('runs the REAL devicectl with the §3.7 arguments and DEVELOPER_DIR, never the wrapper', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    expect(rig.row()?.capabilities.screenshot).toBe(true)
    const reply = await shoot()
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/png')
    expect(reply.headers['x-screenshot-source']).toBe('devicectl')
    expect(reply.body.equals(tinyPng())).toBe(true)
    const calls = rig.s.bin.calls()
    const run = calls.find((c) => c.name === 'devicectl')
    expect(run?.argv.slice(0, 5)).toEqual(['device', 'capture', 'screenshot', '--device', UDID])
    expect(run?.argv[5]).toBe('--destination')
    expect(run?.argv[6]).toMatch(/shot\.png$/)
    expect(run?.argv.slice(7, 9)).toEqual(['--timeout', '5'])
    expect(run?.argv[9]).toBe('--json-output')
    expect(calls.map((c) => c.name)).not.toContain('devicectl-wrapper')
    expect(calls.map((c) => c.name)).not.toContain('xcodebuild')
    expect(x.wrapper).toContain('Developer/usr/bin/devicectl')
    expect(rig.s.logs.some((l) => /screenshot \d+\.\d s \(devicectl\)/.test(l))).toBe(true)
  })

  it('refuses a "real" devicectl that is the first-launch wrapper: XCODE_SETUP_REQUIRED, nothing run', async () => {
    const { rig, shoot } = await rigWithXcode({
      tools: (t, x) => {
        t.xcode.devicectl = x.wrapper
      },
    })
    expect(rig.row()?.blockers).toEqual(['XCODE_SETUP_REQUIRED'])
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([503, 'XCODE_SETUP_REQUIRED'])
    expect(rig.s.bin.calls().map((c) => c.name)).not.toContain('devicectl-wrapper')
    expect(rig.s.bin.calls().map((c) => c.name)).not.toContain('xcodebuild')
  })

  it('first launch pending → XCODE_SETUP_REQUIRED blocker; Xcode missing → XCODE_REQUIRED', async () => {
    const pending = await rigWithXcode({
      tools: (t) => {
        t.xcode.state = 'needs-first-launch'
      },
    })
    expect(pending.rig.row()?.blockers).toEqual(['XCODE_SETUP_REQUIRED'])
    expect(pending.rig.row()?.capabilities.screenshot).toBe(false)
    expect(pending.rig.s.bridge.registry.lanes().ios).toMatchObject({
      xcode: 'needs-first-launch',
      screenshots: 'none',
    })
    const missing = await rigWithXcode({
      tools: (t) => {
        t.xcode.state = 'not-installed'
      },
    })
    expect(missing.rig.row()?.blockers).toEqual(['XCODE_REQUIRED'])
    expect(missing.rig.s.bin.calls().filter((c) => c.name.startsWith('devicectl'))).toEqual([])
  })

  it('maps each devicectl failure (§3.7 table)', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    const cases: Array<[string, number, string]> = [
      ['1000', 404, 'DEVICE_NOT_FOUND'],
      ['timeout', 504, 'TOOL_TIMEOUT'],
      ['exit2', 504, 'TOOL_TIMEOUT'],
      ['locked', 409, 'IOS_LOCKED'],
      ['other', 502, 'TOOL_FAILED'],
      ['no-image', 502, 'TOOL_FAILED'],
    ]
    for (const [scenario, status, expected] of cases) {
      x.scenario(scenario)
      const reply = await shoot()
      expect([scenario, reply.status, code(reply)]).toEqual([scenario, status, expected])
    }
    /** A lock refusal leaves the row as it was (AFU-locked phones stay ready). */
    expect(rig.row()?.state).toBe('ready')
    x.scenario('other')
    expect((await shoot()).json<ErrorBody>().error.message).toBe('Something unexpected happened.')
  })

  it('4016 once: retried after 2 s and succeeds; twice: IOS_UNREACHABLE', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    x.scenario('4016-once')
    expect((await shoot()).status).toBe(200)
    expect(rig.s.bin.calls().filter((c) => c.name === 'devicectl')).toHaveLength(2)
    x.scenario('4016')
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([502, 'IOS_UNREACHABLE'])
  })

  it('Developer Mode off from devicectl adds the blocker', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    x.scenario('devmode')
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([409, 'IOS_DEVELOPER_MODE_OFF'])
    const row = await rig.waitRow(
      (r) => r?.blockers.includes('IOS_DEVELOPER_MODE_OFF') === true,
      'blocker',
    )
    expect(row?.capabilities.screenshot).toBe(false)
  })

  it('1001 marks devicectl unsupported for the device; no other lane → SCREENSHOT_UNSUPPORTED', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    x.scenario('1001')
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([501, 'SCREENSHOT_UNSUPPORTED'])
    await rig.waitRow((r) => r?.capabilities.screenshot === false, 'capability off')
  })

  it('exit 64 (no capture command) → XCODE_REQUIRED and the lane reads no-capture', async () => {
    const { rig, x, shoot } = await rigWithXcode()
    x.scenario('exit64')
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([503, 'XCODE_REQUIRED'])
    expect(rig.s.bridge.registry.lanes().ios.xcode).toBe('no-capture')
  })

  it('our own deadline kills a hung devicectl: TOOL_TIMEOUT', async () => {
    const { x, shoot } = await rigWithXcode()
    x.scenario('hang')
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([504, 'TOOL_TIMEOUT'])
  })
})

describe.skipIf(!hasOpenssl)('iOS 16 and older', () => {
  it('uses idevicescreenshot when devicectl is not available', async () => {
    const { rig, shoot } = await rigWithXcode({
      old: true,
      tools: (t, _x, r) => {
        t.xcode.state = 'not-installed'
        r.s.bin.fixture('legacy.png', tinyPng())
        const tool = r.s.bin.tool(
          'idevicescreenshot',
          'for last; do :; done\ncp "$FAKE_STATE/fixtures/legacy.png" "$last"',
        )
        t.idevicescreenshot = { path: tool, version: null }
      },
    })
    expect(rig.row()?.capabilities.screenshot).toBe(true)
    const reply = await shoot()
    expect(reply.status).toBe(200)
    expect(reply.headers['x-screenshot-source']).toBe('idevicescreenshot')
    const run = rig.s.bin.calls().find((c) => c.name === 'idevicescreenshot')
    expect(run?.argv.slice(0, 2)).toEqual(['-u', UDID])
  })

  it('"screenshotr" in the output → IOS_DDI_REQUIRED, sticky until Retry', async () => {
    const { rig, shoot } = await rigWithXcode({
      old: true,
      tools: (t, _x, r) => {
        t.xcode.state = 'not-installed'
        const tool = r.s.bin.simple('idevicescreenshot', {
          stderr:
            'Could not start screenshotr service! Remember that you have to mount the Developer disk image on your device.\n',
          exit: 1,
        })
        t.idevicescreenshot = { path: tool, version: null }
      },
    })
    const reply = await shoot()
    expect([reply.status, code(reply)]).toEqual([409, 'IOS_DDI_REQUIRED'])
    const row = await rig.waitRow(
      (r) => r?.blockers.includes('IOS_DDI_REQUIRED') === true,
      'sticky',
    )
    expect(row?.capabilities.screenshot).toBe(false)
    await request(rig.s.port, { method: 'POST', path: rig.path('retry'), headers: rig.s.auth })
    await rig.waitRow((r) => r?.blockers.includes('IOS_DDI_REQUIRED') === false, 'cleared by Retry')
  })

  it('nothing installed → TOOL_MISSING with the install command', async () => {
    const { rig } = await rigWithXcode({
      old: true,
      tools: (t) => {
        t.xcode.state = 'not-installed'
      },
    })
    expect(rig.row()?.blockers).toEqual(['TOOL_MISSING'])
  })

  it('devicectl 1001 on iOS 16 falls through to idevicescreenshot', async () => {
    const { rig, x, shoot } = await rigWithXcode({
      old: true,
      tools: (t, _x, r) => {
        r.s.bin.fixture('legacy.png', tinyPng())
        const tool = r.s.bin.tool(
          'idevicescreenshot',
          'for last; do :; done\ncp "$FAKE_STATE/fixtures/legacy.png" "$last"',
        )
        t.idevicescreenshot = { path: tool, version: null }
      },
    })
    x.scenario('1001')
    const reply = await shoot()
    expect(reply.status).toBe(200)
    expect(reply.headers['x-screenshot-source']).toBe('idevicescreenshot')
    expect(rig.row()?.capabilities.screenshot).toBe(true)
  })
})
