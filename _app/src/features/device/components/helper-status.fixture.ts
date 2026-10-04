import type { HelperPhase, HelperStatus } from '../helper/connection'
import type { DoctorReport, Health, HelperDevice, Lanes } from '../helper/protocol'

/*
  Test fixtures for the helper's components: a HelperStatus in any phase, as HelperConnection
  would report it, and a doctor report. Only tests import this file.
*/

export const LANES: Lanes = {
  ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: false, wifiHidden: 0 },
  android: { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: false },
  simulators: { status: 'off', booted: 0 },
}

export const HEALTH: Health = {
  name: 'bauloc-device-bridge',
  version: '1.0.0',
  protocol: 1,
  features: ['android.start-server'],
  port: 8787,
  tokenId: '4d1566a1',
  tokenPersistent: false,
  runId: 'r',
  startedAt: 0,
  local: false,
  platform: 'darwin-arm64',
  sha256: 'ab'.repeat(32),
}

/** Phases in which a helper answered /api/health. */
const ANSWERED: readonly HelperPhase[] = ['connected', 'unpaired', 'stale', 'outdated', 'newer']

export function helperStatus(phase: HelperPhase, patch: Partial<HelperStatus> = {}): HelperStatus {
  return {
    phase,
    promptLikely: false,
    env: {
      mode: 'hosted',
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: false,
      devOrigin: false,
    },
    permission: 'granted',
    health: ANSWERED.includes(phase) ? HEALTH : null,
    lanes: phase === 'connected' ? LANES : null,
    pairing:
      phase === 'connected'
        ? { tokenId: '4d1566a1', remembered: false, tokenPersistent: false }
        : null,
    remember: false,
    intent: phase !== 'off',
    since: new Date(2026, 9, 4, 14, 5).getTime(),
    error: null,
    ...patch,
  }
}

export const IPHONE_ROW: HelperDevice = {
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
}

export const REPORT: DoctorReport = {
  helper: {
    name: 'bauloc-device-bridge',
    version: '1.0.0',
    protocol: 1,
    node: '24.12.0',
    openssl: '3.6.1',
    platform: 'darwin',
    arch: 'arm64',
    macos: '27.0.1',
    port: 8787,
    startedAt: new Date(2026, 9, 4, 9, 30).getTime(),
    local: false,
    tokenPersistent: false,
    flags: ['--simulators'],
    sha256: 'ab'.repeat(32),
  },
  lanes: LANES,
  items: [
    {
      id: 'mac.node',
      group: 'mac',
      label: 'Node 24.12.0',
      status: 'ok',
      sentence: 'Node 24.12.0 runs the helper.',
      fixes: [],
      neededFor: ['helper'],
    },
    {
      id: 'ios.xcode',
      group: 'ios',
      label: 'Xcode',
      status: 'warning',
      sentence:
        'Xcode isn’t installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.',
      fixes: [
        {
          kind: 'link',
          href: 'https://apps.apple.com/app/xcode/id497799835',
          label: 'Get Xcode from the App Store',
        },
      ],
      neededFor: ['ios.screenshot'],
    },
    {
      id: 'ios.pymobiledevice3',
      group: 'ios',
      label: 'pymobiledevice3',
      status: 'warning',
      sentence: 'Not installed. Only needed for the optional root tunnel (a later helper version).',
      fixes: [{ kind: 'command', command: 'python3 -m pip install -U pymobiledevice3' }],
      neededFor: [],
      optional: true,
    },
  ],
  checkedAt: 0,
}
