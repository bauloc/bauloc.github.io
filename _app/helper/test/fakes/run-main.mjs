/*
  Runs the BUILT helper's main() in a real child process, with test options, so the
  lifecycle tests exercise the shipped file and real signals:

    node run-main.mjs <bundle.mjs> '<json bridge options>' [helper argv…]

  The JSON may carry, besides createBridge options:
    logTool          absolute path of a fake tool the fake Android lane streams logs from
    startedByHelper  report the adb server as started by the helper (for the exit advice)
  The fake Android lane lists one Pixel; every other lane is off.
*/
import { pathToFileURL } from 'node:url'

const [bundle, json, ...argv] = process.argv.slice(2)
if (!bundle || !json) throw new Error('usage: node run-main.mjs <bundle> <json> [argv…]')
const { logTool, startedByHelper, ...overrides } = JSON.parse(json)
const helper = await import(pathToFileURL(bundle).href)

/** @type {import('../../src/types').HelperDevice} */
const PIXEL = {
  id: '55090DLAQ0026D',
  platform: 'android',
  connection: 'usb',
  state: 'ready',
  name: 'Pixel 9',
  model: 'Pixel 9',
  modelId: 'tokay',
  osVersion: '17',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
}

/** @param {import('../../src/types').LaneContext} ctx @returns {import('../../src/types').AndroidLane} */
const android = (ctx) => ({
  name: 'android',
  start() {
    ctx.setLane('android', {
      status: 'ok',
      adb: 'found',
      serverProtocol: 41,
      startedByHelper: !!startedByHelper,
    })
    ctx.publish('android', [PIXEL])
  },
  stop: () => Promise.resolve(),
  rescan: () => Promise.resolve(),
  detail: () => Promise.reject(new Error('not in this test')),
  screenshot: () => Promise.reject(new Error('not in this test')),
  retry: () => Promise.resolve(),
  startServer: () => Promise.resolve(),
  connectNetwork: () => Promise.reject(new Error('not in this test')),
  pairNetwork: () => Promise.reject(new Error('not in this test')),
  disconnectNetwork: () => Promise.reject(new Error('not in this test')),
  nearby: () => Promise.resolve({ devices: [], scannedAt: Date.now() }),
  /** @param {string} _id @param {import('../../src/types').LogSink} sink @param {AbortSignal} signal */
  async logs(_id, sink, signal) {
    const tool = ctx.streamTool(logTool, [], { signal, onLines: (lines) => void sink.push(lines) })
    sink.hello('logcat')
    await tool.done
  },
  facts: () => ({
    adb: null,
    version: null,
    server: 'running',
    serverProtocol: 41,
    devices: [],
    startedByHelper: !!startedByHelper,
  }),
})

await helper.main({
  ...helper.processEnv(),
  argv,
  bridge: { ...overrides, lanes: { ios: null, simulators: null, android } },
})
