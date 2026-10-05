#!/usr/bin/env node
/**
 * scripts/helper-fake.mjs — the BUILT Device Lab helper on 127.0.0.1:8787, with fake phones.
 *
 *   npm run helper:fake                        # then `npm run dev` and open the printed link
 *   npm run helper:fake -- --port 8788         # another port
 *   npm run helper:fake -- --token <43 chars>  # the same pairing across restarts
 *   npm run helper:fake -- --local-from http://127.0.0.1:4173
 *                                              # local mode: serve /device/ from that build
 *                                              # (`npm run build && npx vite preview`), as
 *                                              # the real helper serves the published page
 *   npm run helper:fake -- --source            # run helper/src instead of the built file
 *                                              # (before `npm run helper:build`)
 *   npm run helper:fake -- --helper <file>     # run another built helper, such as an older
 *                                              # release, to see what the page says to it:
 *       git show 6ecedd0:device/agent/device-bridge.mjs > /tmp/old-helper.mjs
 *       npm run helper:fake -- --helper /tmp/old-helper.mjs   # 1.0.0, before discovery
 *   npm run helper:fake -- --no-android        # as `--no-android`: no Android lane, so no
 *                                              # android.* features either
 *
 * For UI work without phones (spec §9.3): every chip, card, notice, hint and checklist state
 * on demand. It runs ../device/agent/device-bridge.mjs — the very file testers download — through
 * its exported createBridge(), with the helper test suite's own fakes in place of the real
 * world (helper/test/fakes and helper/test/harness.ts):
 *
 *   - the three lanes are the suite's scriptable fake lanes, driven by the commands below;
 *   - usbmuxd is the suite's fake usbmuxd socket, so the checklist's usbmuxd row is green;
 *   - "Google's adb server" is the suite's fake adb server, started and stopped by `adb`;
 *   - tool discovery returns a fixed toolbox (Xcode ready, set up or missing), and the PATH is
 *     an empty folder: nothing on this Mac is ever run, no adb, no Xcode, no device.
 *
 * Commands on stdin (type `help`):
 *   plug ios|android|sim     unplug ios|android|sim
 *   trust on|off             lock bfu|afu|off          devmode on|off
 *   screen on|off            off: the iPhone's screenshots come back all black, as a locked
 *                            iPhone with its screen off sends them (devicectl says success)
 *   xcode ready|missing|setup
 *   adb on|off|missing       android ready|auth|offline
 *   simulators on|off        status        help        quit
 *
 * A Wi-Fi TV (§4.7), "Living Room TV" at 192.168.1.42:5555, reached by the page's Network
 * device (Wi-Fi)… dialog (connect and pair are the page's, never the script's):
 *   tv answer ok|refused|unreachable|blocked|timeout|slow    how the next connects answer
 *                            (blocked: this Mac refused it, as a VPN or macOS local network
 *                            privacy does: "No route to host" at once)
 *   tv allow | tv deny       "Allow debugging?" on the TV (it asks once connected)
 *   tv drop                  it leaves the Wi-Fi: offline now, gone 3 s later, log ends
 *   tv back                  it is back (and its log resumes, if one was running)
 *   tv pairing on|off        Wireless debugging: connect needs a pairing first; the code
 *                            and pairing port are printed (`tv status` prints them again)
 *   tv forget                forget the pairing and the TV's "Always allow"
 * An iPhone over Wi-Fi drops and comes back with `unplug ios` and `plug ios`: its log ends
 * with device-gone, as the real lane's does.
 *
 * "On this network" (§4.8, GET /api/android/nearby): what the fake network advertises. The
 * page only lists it; connecting is still its Connect or Pair…, answered by the TV above:
 *   net tv on|off            the TV above advertises adb (Network debugging) at its address;
 *                            with `tv pairing on`, Wireless debugging instead (Pair… until paired)
 *   net pairscreen on|off    its "Pair device with pairing code" screen is open (pairing port)
 *   net phone on|off         a Pixel 9 with Wireless debugging at 192.168.1.57, listed only:
 *                            it is not on the fake network, so connecting it fails as unreachable
 *   net blocked on|off       this Mac can't reach the local network: the scan's mDNS query is
 *                            refused at once (EHOSTUNREACH), as from VS Code's terminal on macOS
 *                            or behind a VPN; what adb lists is still reported
 *   net slow on|off          each look takes 3 s (the real one listens for 2 s)
 *
 * "Devices on this network" (§2.8, GET /api/lan/devices): a fixed, varied fake network — a
 * router, this Mac, an iPhone, the Wi-Fi TV above (same Connect/Pair, Show once connected), a
 * Galaxy phone (Connect over Wi‑Fi…), a printer, two speakers, an IoT sensor and a NAS, so every
 * filter and row action shows. `net blocked` keeps only what the resolver named; `net slow`
 * lengthens the look. Nothing here is real.
 *
 * The fakes are TypeScript; they are bundled with rolldown into a temporary file first, with
 * `vitest` replaced by a stub (the harness registers its cleanup with afterAll), so this runs
 * on plain Node.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { build } from 'rolldown'

const APP = fileURLToPath(new URL('..', import.meta.url))
const HELPER_FILE = path.resolve(APP, '../device/agent/device-bridge.mjs')
const FAKES = path.join(APP, 'helper/test')

/* ------------------------------------------------------------------ arguments --- */

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
  process.exit(0)
}
const port = Number(option('--port') ?? 8787)
const token = option('--token')
const localFrom = option('--local-from')
const fromSource = args.includes('--source')
const otherHelper = option('--helper')
const noAndroid = args.includes('--no-android')
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--port must be a port from 1024 to 65535.')
  process.exit(64)
}
if (localFrom !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(localFrom)) {
  console.error('--local-from must be a loopback origin such as http://127.0.0.1:4173.')
  process.exit(64)
}
if (otherHelper !== undefined && (fromSource || !/\.m?js$/.test(otherHelper))) {
  console.error('--helper takes a built helper file (.mjs), and not together with --source.')
  process.exit(64)
}
if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  console.error('--token must be 43 base64url characters, as the helper prints it.')
  process.exit(64)
}

/* ------------------------------------------------------------ the fakes, bundled --- */

const cleanups = []
const STUB = '\0vitest-stub'
const entry = `
export { fakeIosLane, fakeAndroidLane, fakeSimulatorLane } from ${JSON.stringify(path.join(FAKES, 'fakes/lane.ts'))}
export { IPHONE, PIXEL, SIMULATOR } from ${JSON.stringify(path.join(FAKES, 'fakes/devices.ts'))}
export { isolation, toolbox, tinyPng } from ${JSON.stringify(path.join(FAKES, 'harness.ts'))}
export { createFakeUsbmuxd } from ${JSON.stringify(path.join(FAKES, 'fakes/usbmuxd.ts'))}
export { createFakeAdbServer, pixel } from ${JSON.stringify(path.join(FAKES, 'fakes/adb-server.ts'))}
export { connectFailed, pairFailed } from ${JSON.stringify(path.join(APP, 'helper/src/android-lane.ts'))}
export { HelperError } from ${JSON.stringify(path.join(APP, 'helper/src/util.ts'))}
${
  fromSource
    ? `export { createBridge } from ${JSON.stringify(path.join(APP, 'helper/src/bridge.ts'))}
export { VERSION } from ${JSON.stringify(path.join(APP, 'helper/src/constants.ts'))}`
    : ''
}
`
const bundled = await build({
  cwd: APP,
  input: 'helper-fake-entry',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'helper-fake',
      resolveId(id) {
        if (id === 'helper-fake-entry') return '\0helper-fake-entry'
        if (id === 'vitest') return STUB
        return null
      },
      load(id) {
        if (id === '\0helper-fake-entry') return entry
        // The harness's only use of vitest: cleanups, run here on exit instead.
        if (id === STUB)
          return 'export const afterAll = (fn) => { globalThis.__helperFakeCleanups.push(fn) }'
        return null
      },
    },
  ],
  output: { format: 'esm' },
})
globalThis.__helperFakeCleanups = cleanups
const tmp = mkdtempSync(path.join(os.tmpdir(), 'helper-fake-'))
const chunk = bundled.output.find((o) => o.type === 'chunk')
writeFileSync(path.join(tmp, 'fakes.mjs'), chunk.code)
const fakes = await import(pathToFileURL(path.join(tmp, 'fakes.mjs')).href)
// --source: the bridge comes from the same bundle as the fakes, so their errors are its own.
const helper = fromSource
  ? fakes
  : await import(pathToFileURL(otherHelper ? path.resolve(otherHelper) : HELPER_FILE).href)

/**
 * A HelperError the bridge recognises (describeError checks the class). The built file's own
 * when it exports one; else the bundled source's, which only --source recognises.
 */
const HelperErrorClass = helper.HelperError ?? fakes.HelperError
const asHelperError = (e) =>
  e instanceof HelperErrorClass ? e : new HelperErrorClass(e.code, e.status, e.message, e.extra)
const pixel9 = JSON.parse(readFileSync(path.join(FAKES, 'fixtures/pixel-9.json'), 'utf8'))

/* ------------------------------------------------------------------ the world --- */

const world = {
  ios: { plugged: true, trust: true, lock: 'off', devmode: true, screen: true },
  android: { plugged: true, state: 'ready' },
  adb: 'on',
  /** The page's "Start adb server" started it (the exit advice and the lane say so). */
  adbStartedByHelper: false,
  sim: { plugged: true },
  simulators: false,
  xcode: 'ready',
  /** The Wi-Fi TV: on the network always; listed once the page connected it. */
  tv: {
    host: '192.168.1.42',
    port: 5555,
    listed: false,
    /** It chose Allow (with Always allow): listed ready on the next connect too. */
    allowed: false,
    /** unauthorized, ready, offline: once listed. */
    state: 'unauthorized',
    answer: 'ok',
    /** Wireless debugging: connect needs a pairing first. */
    pairing: false,
    paired: false,
    pairPort: 37099,
    code: '482913',
  },
  /** What the fake network advertises over mDNS (§4.8). */
  net: { tv: true, pairscreen: false, phone: false, blocked: false, slow: false },
}

const XCODE_STATE = { ready: 'ready', missing: 'not-installed', setup: 'needs-first-launch' }
const XCODE_BLOCKER = { missing: 'XCODE_REQUIRED', setup: 'XCODE_SETUP_REQUIRED' }

function iosRows() {
  if (!world.ios.plugged) return []
  const row = { ...fakes.IPHONE, blockers: [], capabilities: { ...fakes.IPHONE.capabilities } }
  if (!world.ios.trust) {
    return [{ ...row, state: 'untrusted', blockers: ['IOS_UNTRUSTED'], capabilities: none() }]
  }
  if (world.ios.lock === 'bfu') {
    return [{ ...row, state: 'locked', blockers: ['IOS_LOCKED'], capabilities: none() }]
  }
  if (!world.ios.devmode) row.blockers.push('IOS_DEVELOPER_MODE_OFF')
  if (world.xcode !== 'ready') row.blockers.push(XCODE_BLOCKER[world.xcode])
  row.capabilities.screenshot = row.blockers.length === 0
  return [row]
}

function androidRows() {
  return [...pixelRows(), ...tvRows()]
}

function pixelRows() {
  if (world.adb !== 'on' || !world.android.plugged) return []
  const { state } = world.android
  if (state === 'auth') {
    return [
      {
        ...fakes.PIXEL,
        state: 'unauthorized',
        blockers: ['ANDROID_UNAUTHORIZED'],
        capabilities: none(),
      },
    ]
  }
  if (state === 'offline') {
    return [
      { ...fakes.PIXEL, state: 'offline', blockers: ['ANDROID_OFFLINE'], capabilities: none() },
    ]
  }
  return [fakes.PIXEL]
}

const simRows = () => (world.simulators && world.sim.plugged ? [fakes.SIMULATOR] : [])

const TV_SERIAL = () => `${world.tv.host}:${world.tv.port}`
const TV = {
  platform: 'android',
  connection: 'network',
  name: 'Living Room TV',
  model: 'SHIELD Android TV',
  modelId: 'mdarcy',
  osVersion: '11',
}

/** The TV's row while the adb server lists it; its name only once it allowed this Mac. */
function tvRows() {
  const { tv } = world
  if (world.adb !== 'on' || !tv.listed) return []
  const base = { ...TV, id: TV_SERIAL() }
  if (tv.state === 'ready') return [{ ...base, state: 'ready', blockers: [], capabilities: all() }]
  if (tv.state === 'offline') {
    return [{ ...base, state: 'offline', blockers: ['ANDROID_OFFLINE'], capabilities: none() }]
  }
  // Unauthorized: adb knows nothing but the serial yet.
  return [
    {
      ...base,
      name: '',
      model: '',
      modelId: '',
      osVersion: '',
      state: 'unauthorized',
      blockers: ['ANDROID_UNAUTHORIZED'],
      capabilities: none(),
    },
  ]
}

const all = () => ({ screenshot: true, identifiers: true, logs: true, install: false })
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })

/** POST /api/android/connect, as the real lane answers it (adb 36's texts). */
async function tvConnect({ host, port }, signal) {
  const { tv } = world
  const target = `${host}:${port}`
  const failed = (reason, said) => asHelperError(fakes.connectFailed(target, reason, said))
  if (tv.answer === 'slow') await wait(3_000, signal)
  if (tv.answer === 'timeout') {
    await wait(4_000, signal)
    throw failed('timeout')
  }
  if (tv.answer === 'blocked') {
    throw failed('blocked', `failed to connect to '${target}': No route to host`)
  }
  if (host !== tv.host || tv.answer === 'unreachable') {
    throw failed('unreachable', `failed to connect to '${target}': No route to host`)
  }
  if (port !== tv.port || tv.answer === 'refused') {
    throw failed('refused', `failed to connect to '${target}': Connection refused`)
  }
  if (tv.pairing && !tv.paired) throw failed('unpaired', `failed to authenticate to ${target}`)
  const already = tv.listed && tv.state !== 'offline'
  tv.listed = true
  tv.state = tv.allowed ? 'ready' : 'unauthorized'
  publish()
  console.log(`  tv │ connected (${tv.state}); \`tv allow\` chooses Allow on the TV`)
  return {
    result: already ? 'already-connected' : 'connected',
    serial: target,
    message: `${already ? 'already connected' : 'connected'} to ${target}`,
  }
}

/** POST /api/android/pair: the code and port the TV's pairing screen shows. */
async function tvPair({ host, port, code }) {
  const { tv } = world
  const target = `${host}:${port}`
  const failed = (reason, said) => asHelperError(fakes.pairFailed(target, reason, said))
  if (tv.answer === 'blocked') throw failed('blocked', `failed to connect to ${target}`)
  if (host !== tv.host) throw failed('unreachable', `failed to connect to ${target}`)
  if (!tv.pairing || port !== tv.pairPort) {
    throw failed('refused', 'Failed: Unable to start pairing client.')
  }
  if (code !== tv.code)
    throw failed('wrong-code', 'Failed: Wrong password or connection was dropped.')
  tv.paired = true
  console.log('  tv │ paired; connect next on port', tv.port)
  return { message: `Successfully paired to ${target} [guid=adb-FAKE42-AbCdEf]` }
}

async function tvDisconnect(serial) {
  if (serial !== TV_SERIAL() || !world.tv.listed) {
    throw asHelperError(
      new fakes.HelperError('DEVICE_NOT_FOUND', 404, 'The device is no longer connected.'),
    )
  }
  world.tv.listed = false
  publish()
  return { message: `disconnected ${serial}` }
}

let tvAway = null

/** The phone `net phone on` puts on the network: advertised, never reachable. */
const NET_PHONE = { host: '192.168.1.57', port: 41235, pairPort: 37123 }

/** GET /api/android/nearby, as the real lane answers it: what mDNS heard, and what adb lists. */
async function nearbyResult(refresh, signal) {
  const { tv, net } = world
  const scannedAt = Date.now()
  await wait(net.slow ? 3_000 : refresh ? 1_000 : 200, signal)
  const listed = world.adb === 'on' && tv.listed
  const tvEntry = (kind, port) => ({
    id: `${kind}:${tv.host}:${port}`,
    host: tv.host,
    port,
    kind,
    instance: tv.pairing ? 'adb-FAKE42TV0001-AbCdEf' : 'adb-fake42tv0001',
    name: 'Living Room TV',
    serial: tv.pairing ? 'FAKE42TV0001' : 'fake42tv0001',
    tv: true,
    connected: listed && kind !== 'pairing',
    ...(listed && kind !== 'pairing' ? { deviceId: TV_SERIAL() } : {}),
    ...(kind === 'adb' ? {} : { paired: tv.paired }),
  })
  // Blocked: the helper's own query never left, so only what adb lists already is reported.
  if (net.blocked) {
    return {
      devices: listed ? [tvEntry(tv.pairing ? 'wireless' : 'adb', tv.port)] : [],
      scannedAt,
      error: {
        reason: 'blocked',
        message: 'This computer can’t reach the local network, so it can’t look for devices on it.',
        detail: 'send EHOSTUNREACH 224.0.0.251:5353',
      },
    }
  }
  const devices = []
  if (net.tv) {
    devices.push(tvEntry(tv.pairing ? 'wireless' : 'adb', tv.port))
    if (tv.pairing && net.pairscreen) devices.push(tvEntry('pairing', tv.pairPort))
  }
  if (net.phone) {
    const phone = (kind, port) => ({
      id: `${kind}:${NET_PHONE.host}:${port}`,
      host: NET_PHONE.host,
      port,
      kind,
      instance: 'adb-55090FAKE0026D-nK25Qn',
      name: '',
      serial: '55090FAKE0026D',
      tv: false,
      connected: false,
      paired: false,
    })
    devices.push(phone('wireless', NET_PHONE.port), phone('pairing', NET_PHONE.pairPort))
  }
  return { devices, scannedAt }
}

/** The LAN this fake sits on: own address .10, the Wi-Fi TV at its nearby address, the gateway .1. */
const LAN_NET = { interface: 'en0', address: '192.168.1.10', prefix: 24, size: 254, scanned: 254 }

/**
 * GET /api/lan/devices, injected through the `lanScan` seam (§2.8): a small but varied network,
 * so every filter and every row action shows. The Wi-Fi TV sits at its "On this network"
 * address, so its row offers the same Connect/Pair (and Show once the page has connected it).
 * `net blocked` and `net slow` steer it as they steer "On this network".
 */
async function lanResult(scanCtx) {
  const { net } = world
  const scannedAt = Date.now()
  await wait(net.slow ? 3_000 : 400, scanCtx.signal)
  // Every device the fake network has; blocked keeps only what the resolver (mDNS/SSDP) still named.
  const all = [
    {
      address: '192.168.1.1',
      self: false,
      gateway: true,
      hostnames: [],
      names: [{ text: 'Archer AX55', source: 'ssdp' }],
      services: [],
      upnp: {
        deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
        friendlyName: 'Archer AX55',
        manufacturer: 'TP-Link',
        modelName: 'Archer AX55',
      },
      found: ['gateway', 'ssdp'],
    },
    {
      address: '192.168.1.10',
      self: true,
      gateway: false,
      hostnames: ['baus-macbook-pro.local'],
      names: [{ text: 'Bau’s MacBook Pro', source: 'mdns' }],
      services: [
        { type: '_companion-link._tcp', port: 49152, name: 'Bau’s MacBook Pro' },
        { type: '_smb._tcp', port: 445 },
        { type: '_device-info._tcp', txt: { model: 'Mac15,6' } },
      ],
      found: ['self', 'mdns'],
    },
    {
      address: '192.168.1.23',
      self: false,
      gateway: false,
      hostnames: ['baus-iphone.local'],
      names: [{ text: 'Bau’s iPhone', source: 'mdns' }],
      services: [
        { type: '_apple-mobdev2._tcp', port: 49153 },
        { type: '_airplay._tcp', port: 7000, name: 'Bau’s iPhone', txt: { model: 'iPhone16,2' } },
        { type: '_raop._tcp', port: 7000, txt: { am: 'iPhone16,2' } },
      ],
      found: ['reply', 'mdns'],
    },
    {
      address: world.tv.host,
      self: false,
      gateway: false,
      hostnames: ['living-room-tv.local'],
      names: [{ text: 'Living Room TV', source: 'mdns' }],
      services: [
        { type: '_androidtvremote2._tcp', port: 6466, name: 'Living Room TV' },
        { type: '_googlecast._tcp', port: 8009, txt: { fn: 'Living Room TV', md: 'Chromecast' } },
        { type: '_adb-tls-connect._tcp', port: world.tv.port },
      ],
      found: ['reply', 'mdns'],
    },
    {
      address: '192.168.1.50',
      self: false,
      gateway: false,
      hostnames: ['hp-officejet.local'],
      names: [{ text: 'HP OfficeJet Pro 9015', source: 'mdns' }],
      services: [
        { type: '_ipp._tcp', port: 631, name: 'HP OfficeJet Pro 9015', txt: { ty: 'HP OfficeJet Pro 9015' } },
        { type: '_printer._tcp', port: 515 },
      ],
      found: ['reply', 'mdns'],
    },
    {
      address: '192.168.1.60',
      self: false,
      gateway: false,
      hostnames: ['kitchen-homepod.local'],
      names: [{ text: 'Kitchen HomePod', source: 'mdns' }],
      services: [
        { type: '_airplay._tcp', port: 7000, name: 'Kitchen HomePod', txt: { model: 'AudioAccessory5,1' } },
        { type: '_raop._tcp', port: 7000, txt: { am: 'AudioAccessory5,1' } },
      ],
      found: ['mdns'],
    },
    {
      address: '192.168.1.66',
      self: false,
      gateway: false,
      hostnames: [],
      names: [{ text: 'Sonos Living Room', source: 'ssdp' }],
      services: [{ type: '_sonos._tcp', port: 1443, name: 'Sonos Living Room' }],
      upnp: {
        deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
        friendlyName: 'Sonos Living Room',
        manufacturer: 'Sonos',
        modelName: 'One SL',
      },
      found: ['ssdp', 'mdns'],
    },
    {
      address: '192.168.1.70',
      self: false,
      gateway: false,
      hostnames: ['living-room-sensor.local'],
      names: [{ text: 'Living Room Sensor', source: 'mdns' }],
      services: [{ type: '_esphomelib._tcp', port: 6053, name: 'Living Room Sensor' }],
      privateAddress: true,
      found: ['reply', 'mdns'],
    },
    {
      address: '192.168.1.80',
      self: false,
      gateway: false,
      hostnames: ['diskstation.local'],
      names: [{ text: 'DiskStation', source: 'mdns' }],
      services: [{ type: '_adisk._tcp', port: 9 }],
      found: ['reply', 'mdns'],
    },
    {
      address: '192.168.1.90',
      self: false,
      gateway: false,
      hostnames: ['galaxy-s23.local'],
      names: [],
      services: [],
      found: ['reply', 'reverse'],
    },
  ]
  const sources = { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' }
  if (net.blocked) {
    // The helper's own packets never left; only what the system resolver named is still here.
    const named = all.filter((d) => d.found.some((f) => f === 'mdns' || f === 'ssdp'))
    return {
      devices: named,
      networks: [LAN_NET],
      sources: { presence: 'blocked', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'blocked' },
      scannedAt,
      durationMs: Date.now() - scannedAt,
      note: {
        reason: 'blocked',
        message: 'This computer can’t reach the local network, so it can’t look for devices on it.',
        detail: 'send EHOSTUNREACH 192.168.1.1:9',
      },
    }
  }
  return {
    devices: all,
    networks: [LAN_NET],
    sources,
    scannedAt,
    durationMs: Date.now() - scannedAt,
  }
}

const none = () => ({ screenshot: false, identifiers: false, logs: false, install: false })

const iosLaneState = () => ({
  status: 'ok',
  screenshots: world.xcode === 'ready' ? 'devicectl' : 'none',
  xcode: XCODE_STATE[world.xcode],
  wifi: false,
  wifiHidden: 0,
})

const androidLaneState = () =>
  world.adb === 'on'
    ? { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: world.adbStartedByHelper }
    : {
        status: 'stopped',
        adb: world.adb === 'missing' ? 'missing' : 'found',
        startedByHelper: false,
      }

const simLaneState = () => ({
  status: world.simulators ? 'ok' : 'off',
  booted: simRows().length,
})

/* -------------------------------------------------------------- what devices say --- */

function iosFacts(row) {
  return {
    udid: row.id,
    connection: 'usb',
    source: 'lockdown',
    device: {
      DeviceName: row.name,
      DeviceClass: 'iPhone',
      ProductType: row.modelId,
      ProductVersion: row.osVersion,
      BuildVersion: '24A437',
      SerialNumber: 'F2LZZ0FAKE01',
      HardwareModel: 'D53pAP',
      ModelNumber: 'MGLQ3',
      RegionInfo: 'LL/A',
      CPUArchitecture: 'arm64e',
      TimeZone: 'Asia/Ho_Chi_Minh',
      UniqueChipID: '18446744073709550001',
    },
    battery: { BatteryCurrentCapacity: 87, BatteryIsCharging: true, ExternalConnected: true },
    disk: {
      TotalDiskCapacity: 256_000_000_000,
      TotalDataAvailable: 161_040_000_000,
      AmountDataAvailable: 40_300_000_000,
    },
    international: { Language: 'en', Locale: 'en_VN' },
    developerMode: world.ios.devmode,
    locked: world.ios.lock === 'afu',
    withheld: [],
  }
}

async function detail(id) {
  if (id === fakes.IPHONE.id)
    return { platform: 'ios', kind: 'ios', facts: iosFacts(iosRows()[0] ?? fakes.IPHONE) }
  if (id === fakes.SIMULATOR.id) {
    const s = fakes.SIMULATOR
    return {
      platform: 'ios',
      kind: 'simulator',
      facts: {
        udid: s.id,
        name: s.name,
        deviceType: { name: s.model, modelIdentifier: s.modelId },
        runtime: { name: `iOS ${s.osVersion}`, version: s.osVersion, build: '24A5300a' },
        state: 'Booted',
        dataPathSize: 1_234_567_890,
      },
    }
  }
  if (id === TV_SERIAL()) {
    // The Pixel's outputs, named as the TV: only the identity rows differ.
    const getprop = pixel9.outputs.getprop
      .replace(/\[ro\.product\.model\]: \[[^\]]*\]/, '[ro.product.model]: [SHIELD Android TV]')
      .replace(/\[ro\.product\.manufacturer\]: \[[^\]]*\]/, '[ro.product.manufacturer]: [NVIDIA]')
      .replace(/\[ro\.product\.brand\]: \[[^\]]*\]/, '[ro.product.brand]: [NVIDIA]')
      .replace(/\[ro\.build\.version\.release\]: \[[^\]]*\]/, '[ro.build.version.release]: [11]')
    return {
      platform: 'android',
      kind: 'android',
      serial: id,
      connection: 'network',
      outputs: { ...pixel9.outputs, getprop, wmSize: 'Physical size: 1920x1080\n', battery: '' },
    }
  }
  return {
    platform: 'android',
    kind: 'android',
    serial: id,
    connection: 'usb',
    outputs: pixel9.outputs,
  }
}

const LOG_SOURCE = { ios: 'syslog_relay', android: 'logcat', simulators: 'simctl' }
const SYSLOG_LEVELS = ['Notice', 'Info', 'Debug', 'Warning', 'Error', 'Fault']
const LOGCAT_LEVELS = ['I', 'D', 'V', 'W', 'E', 'F']
const SIM_LEVELS = ['Df', 'Db', 'I', 'E', 'F', 'A']

/** One plausible line for the source, with a level that varies, as LogConsole colours them. */
function logLine(lane, n) {
  const now = new Date()
  const pad = (v, w = 2) => String(v).padStart(w, '0')
  const hms = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  if (lane === 'ios') {
    const month = now.toLocaleString('en-US', { month: 'short' })
    return `${month} ${String(now.getDate()).padStart(2)} ${hms} iPhone SpringBoard(FrontBoard)[57] <${SYSLOG_LEVELS[n % 6]}>: fake event ${n}`
  }
  if (lane === 'android') {
    return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hms}.${pad(n % 1000, 3)}  1234  5678 ${LOGCAT_LEVELS[n % 6]} ActivityManager: fake event ${n}`
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hms}.${pad(n % 1000, 3)} ${SIM_LEVELS[n % 6]}  SpringBoard[1234:5678] fake event ${n}`
}

/** Whether the device still streams: a dropped TV or an unplugged iPhone ends its log. */
function streaming(id) {
  if (id === TV_SERIAL()) return world.tv.listed && world.tv.state === 'ready'
  if (id === fakes.IPHONE.id) return iosRows().some((r) => r.state === 'ready')
  return true
}

function logsFor(lane) {
  return async (id, sink, signal) => {
    sink.hello(LOG_SOURCE[lane])
    let n = 0
    while (!signal.aborted && streaming(id)) {
      sink.push([logLine(lane, n++), logLine(lane, n++)])
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}

const screenshot = (source) => async () => ({ png: fakes.tinyPng(), source })

/** CRC-32 of a PNG chunk's type and data. */
function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An all-black 390×844 RGB PNG: what a locked iPhone with its screen off sends (§3.7). */
function blackPng(width = 390, height = 844) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  // Each scanline: filter byte 0, then width × 3 zero bytes.
  const pixels = Buffer.alloc(height * (1 + width * 3))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const iosScreenshot = async () =>
  world.ios.screen ? screenshot('devicectl')() : { png: blackPng(), source: 'devicectl' }

/* ------------------------------------------------------------------ the helper --- */

const iosLane = fakes.fakeIosLane({
  state: iosLaneState(),
  rows: iosRows(),
  detail,
  screenshot: iosScreenshot,
  logs: logsFor('ios'),
  retry: async () => publish(),
  rescan: async () => publish(),
})
const androidLane = fakes.fakeAndroidLane({
  state: androidLaneState(),
  rows: androidRows(),
  detail,
  screenshot: screenshot('adb'),
  logs: logsFor('android'),
  retry: async () => publish(),
  rescan: async () => publish(),
  startServer: async () => {
    world.adbStartedByHelper = true
    await setAdb('on')
  },
  connectNetwork: (target, signal) => tvConnect(target, signal),
  pairNetwork: (target) => tvPair(target),
  disconnectNetwork: (serial) => tvDisconnect(serial),
  nearby: (refresh, signal) => nearbyResult(refresh, signal),
})
const simLane = fakes.fakeSimulatorLane({
  state: simLaneState(),
  rows: simRows(),
  detail,
  screenshot: screenshot('simctl'),
  logs: logsFor('simulators'),
  rescan: async () => publish(),
})

const usbmuxd = await fakes.createFakeUsbmuxd()
cleanups.push(() => usbmuxd.close())

const { input, bin } = await fakes.isolation({
  port,
  ...(token ? { token } : {}),
  dev: true,
  // Local mode only with a build to serve: the real one proxies the published site.
  local: localFrom !== undefined,
  ...(localFrom ? { upstream: localFrom } : {}),
  simulators: true,
  usbmuxdSocket: usbmuxd.path,
  heartbeatMs: 15_000,
  timeouts: {
    killGrace: 1_500,
    rescan: 5_000,
    retry: 10_000,
    logHello: 30_000,
    logBatch: 100,
    banner: 3_000,
    portProbe: 2_000,
  },
  // A fixed toolbox: discovery never runs anything. Paths point into an empty folder.
  resolveTools: () =>
    Promise.resolve(
      fakes.toolbox((t) => {
        t.xcode.state = XCODE_STATE[world.xcode]
        if (world.xcode !== 'missing') {
          t.xcode.devDir = '/Applications/Xcode.app/Contents/Developer'
          t.xcode.version = '27.0'
          t.xcode.build = '27A266a'
          t.xcode.coreDevice = world.xcode === 'setup' ? '641.0' : '642.16'
          t.xcode.expected = '642.16'
          t.xcode.license = true
        }
        if (world.xcode === 'ready') {
          t.simctl.state = 'ready'
          t.simctl.devDir = '/Applications/Xcode.app/Contents/Developer'
        }
        if (world.adb !== 'missing') t.adb = { path: path.join(bin.dir, 'adb'), version: '36.0.0' }
      }),
    ),
  log: (line) => console.log(`  helper │ ${line}`),
  errorLog: (line) => console.error(`  helper ! ${line}`),
  // "Devices on this network" (§2.8): the whole look replaced by the fake network above. It is
  // the helper's own, independent of the Android lane, so it runs even with --no-android.
  lanScan: (scanCtx) => lanResult(scanCtx),
  ...(noAndroid ? { android: false } : {}),
  lanes: {
    ios: iosLane.factory,
    android: noAndroid ? null : androidLane.factory,
    simulators: simLane.factory,
  },
})

let adbServer = null
async function setAdb(next) {
  world.adb = next
  if (next !== 'on') world.adbStartedByHelper = false
  // A server that stops forgets its network devices: they are connected again by hand.
  if (next !== 'on') world.tv.listed = false
  if (next === 'on' && !adbServer) {
    adbServer = await fakes.createFakeAdbServer({ port: input.adbPort })
  } else if (next !== 'on' && adbServer) {
    await adbServer.close()
    adbServer = null
  }
  publish()
}

function publish() {
  adbServer?.setDevices(
    world.android.plugged && world.adb === 'on'
      ? [
          fakes.pixel(
            world.android.state === 'auth'
              ? 'unauthorized'
              : world.android.state === 'offline'
                ? 'offline'
                : 'device',
          ),
        ]
      : [],
  )
  iosLane.ctx().setLane('ios', iosLaneState())
  iosLane.ctx().publish('ios', iosRows())
  // --no-android: the bridge never created the Android lane, so there is nothing to tell.
  if (!noAndroid) {
    androidLane.ctx().setLane('android', androidLaneState())
    androidLane.ctx().publish('android', androidRows())
  }
  simLane.ctx().setLane('simulators', simLaneState())
  simLane.ctx().publish('simulators', simRows())
}

const bridge = helper.createBridge(input)
try {
  await bridge.listen()
} catch (error) {
  console.error(`Could not listen on 127.0.0.1:${port}: ${error.message}`)
  console.error('Is the real helper (or another helper:fake) running? Stop it, or use --port.')
  await shutdown(1)
}
await setAdb('on')

const pairLink = (origin) => `${origin}/device/#pair=${bridge.token}&port=${bridge.port}`
console.log(`
Device Lab helper ${helper.VERSION} — FAKE PHONES — 127.0.0.1:${bridge.port} (fingerprint ${bridge.tokenId})${
  otherHelper ? `\n  Running ${path.resolve(otherHelper)}` : ''
}${noAndroid ? '\n  --no-android: no Android lane' : ''}

  Pair the dev page:     ${pairLink('http://localhost:7360')}
  Token (pair dialog):   ${bridge.token}${
    localFrom
      ? `\n  Local mode:            ${pairLink(`http://127.0.0.1:${bridge.port}`)}\n                         (serves /device/ from ${localFrom})`
      : ''
  }

Nothing real is touched: fake lanes, fake usbmuxd, fake adb server, empty PATH.
Type \`help\` for the commands. Ctrl+C to stop.
`)

/* ------------------------------------------------------------------ commands --- */

const HELP = `  plug ios|android|sim     unplug ios|android|sim
  trust on|off             lock bfu|afu|off          devmode on|off
  screen on|off            (off: the iPhone's screenshots come back all black)
  xcode ready|missing|setup
  adb on|off|missing       android ready|auth|offline
  simulators on|off        status        help        quit
  tv answer ok|refused|unreachable|blocked|timeout|slow
  tv allow|deny|drop|back|forget        tv pairing on|off
  net tv|pairscreen|phone|blocked|slow on|off      (what "On this network" hears)`

function describeWorld() {
  return [
    `iPhone ${world.ios.plugged ? 'plugged' : 'unplugged'} · trust ${world.ios.trust ? 'on' : 'off'} · lock ${world.ios.lock} · screen ${world.ios.screen ? 'on' : 'off'} · Developer Mode ${world.ios.devmode ? 'on' : 'off'}`,
    `Xcode ${world.xcode} · adb ${world.adb} · Pixel ${world.android.plugged ? world.android.state : 'unplugged'} · simulators ${world.simulators ? 'on' : 'off'}`,
    `TV ${TV_SERIAL()} ${world.tv.listed ? world.tv.state : 'not connected'} · answers ${world.tv.answer}${
      world.tv.pairing
        ? ` · Wireless debugging: pair at ${world.tv.host}:${world.tv.pairPort} with ${world.tv.code}${world.tv.paired ? ' (paired)' : ''}`
        : ''
    }`,
    `Network: ${
      Object.entries(world.net)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join(', ') || 'nothing advertised'
    }`,
  ].join('\n')
}

const KIND = {
  ios: 'ios',
  iphone: 'ios',
  android: 'android',
  pixel: 'android',
  sim: 'sim',
  simulator: 'sim',
}

async function run(lineText) {
  const [cmd, arg] = lineText.trim().toLowerCase().split(/\s+/)
  const onOff = arg === 'on' ? true : arg === 'off' ? false : null
  switch (cmd) {
    case '':
    case undefined:
      return
    case 'help':
      return console.log(HELP)
    case 'status':
      return console.log(describeWorld())
    case 'quit':
    case 'exit':
      return shutdown(0)
    case 'plug':
    case 'unplug': {
      const kind = KIND[arg]
      if (!kind) return console.log('plug|unplug ios|android|sim')
      world[kind].plugged = cmd === 'plug'
      if (kind === 'sim' && cmd === 'plug') world.simulators = true
      break
    }
    case 'trust':
      if (onOff === null) return console.log('trust on|off')
      world.ios.trust = onOff
      break
    case 'lock':
      if (!['bfu', 'afu', 'off'].includes(arg)) return console.log('lock bfu|afu|off')
      world.ios.lock = arg
      break
    case 'devmode':
      if (onOff === null) return console.log('devmode on|off')
      world.ios.devmode = onOff
      break
    case 'screen':
      if (onOff === null) return console.log('screen on|off')
      world.ios.screen = onOff
      return console.log(describeWorld())
    case 'xcode':
      if (!(arg in XCODE_STATE)) return console.log('xcode ready|missing|setup')
      world.xcode = arg
      break
    case 'adb':
      if (!['on', 'off', 'missing'].includes(arg)) return console.log('adb on|off|missing')
      await setAdb(arg)
      return console.log(describeWorld())
    case 'android':
      if (!['ready', 'auth', 'offline'].includes(arg))
        return console.log('android ready|auth|offline')
      world.android.state = arg
      break
    case 'simulators':
      if (onOff === null) return console.log('simulators on|off')
      world.simulators = onOff
      break
    case 'tv': {
      const sub = arg
      const value = lineText.trim().toLowerCase().split(/\s+/)[2]
      const { tv } = world
      if (sub === 'answer') {
        if (!['ok', 'refused', 'unreachable', 'blocked', 'timeout', 'slow'].includes(value))
          return console.log('tv answer ok|refused|unreachable|blocked|timeout|slow')
        tv.answer = value
      } else if (sub === 'allow') {
        tv.allowed = true
        if (tv.listed && tv.state === 'unauthorized') tv.state = 'ready'
      } else if (sub === 'deny') {
        tv.allowed = false
        if (tv.listed) tv.state = 'unauthorized'
      } else if (sub === 'drop') {
        if (!tv.listed) return console.log('The TV isn’t connected.')
        tv.state = 'offline'
        clearTimeout(tvAway)
        tvAway = setTimeout(() => {
          tv.listed = false
          publish()
          console.log('  tv │ gone from the list')
        }, 3_000)
      } else if (sub === 'back') {
        clearTimeout(tvAway)
        tv.listed = true
        tv.state = tv.allowed ? 'ready' : 'unauthorized'
      } else if (sub === 'pairing') {
        if (!['on', 'off'].includes(value)) return console.log('tv pairing on|off')
        tv.pairing = value === 'on'
        tv.paired = false
      } else if (sub === 'forget') {
        tv.paired = false
        tv.allowed = false
      } else {
        return console.log('tv answer …|allow|deny|drop|back|pairing on|off|forget')
      }
      break
    }
    case 'net': {
      const value = lineText.trim().toLowerCase().split(/\s+/)[2]
      if (!(arg in world.net) || !['on', 'off'].includes(value))
        return console.log('net tv|pairscreen|phone|blocked|slow on|off')
      world.net[arg] = value === 'on'
      // The page hears it on its next look (Refresh, or within 30 s).
      return console.log(describeWorld())
    }
    default:
      return console.log(`Unknown command "${cmd}". Type help.`)
  }
  publish()
  console.log(describeWorld())
}

let stopping = false
async function shutdown(code) {
  if (stopping) process.exit(130)
  stopping = true
  await bridge.close().catch(() => undefined)
  await adbServer?.close().catch(() => undefined)
  for (const cleanup of cleanups.splice(0).reverse())
    await Promise.resolve(cleanup()).catch(() => undefined)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (text) => {
  run(text).catch((error) => console.error(error))
})
rl.on('close', () => {
  // stdin ended (piped input): keep serving until Ctrl+C.
})
