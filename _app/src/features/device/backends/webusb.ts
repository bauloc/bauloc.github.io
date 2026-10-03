import type { Adb } from '@yume-chan/adb'
import type {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from '@yume-chan/adb-daemon-webusb'

import { normalizeDevice, type Device, type DeviceState } from '../model'
import { DETAIL_COMMANDS, androidDetail, extractPng } from './android'
import type { Backend } from './backend'

/*
  WebUSB: the ADB protocol straight from the browser, via ya-webadb ("Tango", MIT). No helper,
  no daemon, no adb on PATH. Ported from the hand-written Device Lab's 03-webusb.js, which was
  verified on a real Pixel 9; its decisions are kept, and the comments that justify them.

  Two facts shape this file:

  1. A USB interface has exactly ONE owner. If Google's adb server got there first, the claim
     fails — and the adb server respawns the moment any IDE polls for devices. That is the
     single most common failure here, so it gets a first-class state (`held`) and an
     actionable hint, not a generic error.

  2. Only requestDevice() needs a user gesture. getDevices() and connect() do not — so once a
     device has been granted, a reload reconnects it silently. That is why this lane feels like
     "it just works" on the second visit.

  3. Every connect is an ATTEMPT, numbered per session. Retry, a device leaving and stop() bump
     the number, and close the USB device so the old attempt's pending transfers abort. An
     attempt that finds itself superseded closes what it opened and touches nothing else.
     Without that, a Retry pressed while the phone still asks to allow USB debugging left two
     readers on the one IN endpoint, and the phone never got past "authorizing".

  The library is imported lazily, so a browser without WebUSB never downloads it.
*/

/** On Android 11+ the phone's "Allow USB debugging?" prompt shows this name. */
const APP_NAME = 'BauLoc Device Lab'
/** A backstop poll for the cases Chrome fires no event (a device added by requestDevice). */
const SYNC_INTERVAL_MS = 4000

interface Session {
  /** The row's id: the serial, made unique when two attached devices report the same one. */
  id: string
  /** The serial as the device reports it, which is what ADB is told. */
  serial: string
  device: AdbDaemonWebUsbDevice
  adb: Adb | null
  connecting: boolean
  /** The current attempt's number (see 3. above). */
  attempt: number
  state: DeviceState
  blockers: string[]
  props: { model: string; brand: string; release: string }
}

type Tango = Awaited<ReturnType<typeof loadTango>>

async function loadTango() {
  const [core, webusb, credential] = await Promise.all([
    import('@yume-chan/adb'),
    import('@yume-chan/adb-daemon-webusb'),
    import('@yume-chan/adb-credential-web'),
  ])
  return {
    Adb: core.Adb,
    AdbDaemonTransport: core.AdbDaemonTransport,
    manager: webusb.AdbDaemonWebUsbDeviceManager.BROWSER,
    CredentialStore: credential.default,
  }
}

/**
 * A connect or authenticate failure, as something the tester can act on. The claim-interface
 * case is the one that matters. Exported for tests; matches the legacy dvcUsbClassify.
 */
export function classifyUsbError(error: unknown): { state: DeviceState; blockers: string[] } {
  const name = error instanceof Error ? error.name : ''
  const msg = error instanceof Error ? error.message : ''
  if (name === 'DeviceBusyError' || /claim|busy|already in use/i.test(msg)) {
    return { state: 'held', blockers: ['ADB_SERVER_HOLDING'] }
  }
  if (name === 'NetworkError' || /disconnect|transfer|no such device/i.test(msg)) {
    return { state: 'offline', blockers: ['ANDROID_OFFLINE'] }
  }
  if (name === 'NotFoundError' || /no device/i.test(msg)) {
    return { state: 'absent', blockers: [] }
  }
  if (name === 'SecurityError' || /access denied|permission/i.test(msg)) {
    return { state: 'held', blockers: ['WEBUSB_CLAIM_FAILED'] }
  }
  return { state: 'offline', blockers: ['WEBUSB_CLAIM_FAILED'] }
}

export function createWebUsbBackend(): Backend {
  const sessions = new Map<string, Session>()
  const listeners = new Set<() => void>()
  let tango: Promise<Tango> | null = null
  let manager: AdbDaemonWebUsbDeviceManager | null = null
  let credentials: InstanceType<Tango['CredentialStore']> | null = null
  let started = false
  let syncing = false
  let timer = 0

  const emit = () => {
    for (const listener of listeners) listener()
  }

  function getTango(): Promise<Tango> {
    // A failed import is retried next time instead of being cached forever.
    tango ??= loadTango().catch((error: unknown) => {
      tango = null
      throw error
    })
    return tango
  }

  async function ensureManager(): Promise<{ manager: AdbDaemonWebUsbDeviceManager; t: Tango }> {
    const t = await getTango()
    if (!manager) {
      // Undefined when navigator.usb is missing — the same check Tango makes internally.
      if (!t.manager) throw new Error('WEBUSB_UNSUPPORTED')
      manager = t.manager
      // The RSA key pair lives in Web Crypto + IndexedDB.
      credentials = new t.CredentialStore(APP_NAME)
    }
    return { manager, t }
  }

  /** Each attached USB device's row id, so two that report the same serial stay two rows. */
  const ids = new WeakMap<USBDevice, string>()

  function idFor(device: AdbDaemonWebUsbDevice): string {
    const known = ids.get(device.raw)
    if (known !== undefined) return known
    const base = device.serial || device.name || 'unknown'
    let id = base
    for (let n = 2; sessions.has(id); n++) id = `${base}#${String(n)}`
    ids.set(device.raw, id)
    return id
  }

  function entry(device: AdbDaemonWebUsbDevice): Session {
    const id = idFor(device)
    let s = sessions.get(id)
    if (!s) {
      s = {
        id,
        serial: device.serial || device.name || 'unknown',
        device,
        adb: null,
        connecting: false,
        attempt: 0,
        state: 'connecting',
        blockers: [],
        props: { model: '', brand: '', release: '' },
      }
      sessions.set(id, s)
    } else {
      s.device = device
    }
    return s
  }

  /**
   * Ends whatever the session has going: the attempt in flight is superseded, the ADB session
   * closed, and the USB device closed, which aborts pending transfers and releases the claim.
   */
  async function release(s: Session): Promise<void> {
    s.attempt++
    const adb = s.adb
    s.adb = null
    if (adb) await Promise.resolve(adb.close()).catch(() => undefined)
    await s.device.raw.close().catch(() => undefined)
  }

  function setState(s: Session, state: DeviceState, blockers: string[] = []) {
    s.state = state
    s.blockers = blockers
    emit()
  }

  async function connect(s: Session): Promise<void> {
    if (s.adb || s.connecting) return
    s.connecting = true
    const attempt = ++s.attempt
    const superseded = () => attempt !== s.attempt
    try {
      const { t } = await ensureManager()
      if (superseded()) return
      setState(s, 'connecting')
      const connection = await s.device.connect() // claims the interface
      if (superseded()) {
        // Whatever superseded this could not close a device that was still opening (WebUSB
        // refuses a close while an open or claim is in flight), so close it now.
        await s.device.raw.close().catch(() => undefined)
        return
      }

      // authenticate() stays pending while the phone shows "Allow USB debugging?" — so the
      // honest state is `authorizing`, not a spinner that looks like our own slowness.
      setState(s, 'authorizing', ['ANDROID_UNAUTHORIZED'])
      if (!credentials) throw new Error('WEBUSB_UNSUPPORTED')
      const transport = await t.AdbDaemonTransport.authenticate({
        serial: s.serial,
        connection,
        credentialStore: credentials,
      })
      if (superseded()) {
        await Promise.resolve(transport.close()).catch(() => undefined)
        return
      }
      const adb = new t.Adb(transport)
      s.adb = adb

      // Cheap identity for the list row; the full dump waits for detail().
      const [model, brand, release] = await Promise.all([
        adb.getProp('ro.product.model').catch(() => ''),
        adb.getProp('ro.product.manufacturer').catch(() => ''),
        adb.getProp('ro.build.version.release').catch(() => ''),
      ])
      if (superseded()) return // whatever superseded it closed this session
      s.props = { model, brand, release }

      // A device can vanish mid-session (cable, reboot, sleep): reflect it rather than
      // leaving a stale "Ready".
      void adb.disconnected.then(
        () => {
          onLost(s, adb)
        },
        () => {
          onLost(s, adb)
        },
      )
      setState(s, 'ready')
    } catch (error) {
      if (superseded()) return
      // ya-webadb keeps the connection open after a failed authenticate, and its stream keeps a
      // transfer pending on the IN endpoint. Close the device, or the next attempt would share
      // that endpoint with a reader nobody owns.
      await s.device.raw.close().catch(() => undefined)
      const c = classifyUsbError(error)
      console.warn(`[device] WebUSB connect failed for ${s.id}`, error)
      setState(s, c.state, c.blockers)
    } finally {
      if (!superseded()) s.connecting = false
    }
  }

  function onLost(s: Session, adb: Adb) {
    // Only the session that died: a reconnect may already have replaced it.
    if (s.adb !== adb) return
    s.adb = null
    // Keep the row until the next sync, so a brief re-enumeration (a USB mode switch) does
    // not make it flicker away and back.
    if (sessions.get(s.id) === s) setState(s, 'absent')
  }

  /** Reconcile with what the browser says is granted and present; auto-connect anything new. */
  async function sync(): Promise<void> {
    if (syncing) return
    syncing = true
    try {
      const { manager: m } = await ensureManager()
      const devices = await m.getDevices()
      // stop() may have run while this waited: connecting now would leave a session that
      // nothing releases.
      if (!started) return
      const present = new Set<string>()
      for (const device of devices) {
        const s = entry(device)
        present.add(s.id)
        // `held` is sticky on purpose: retrying a claim every few seconds would hammer the USB
        // stack while adb owns the device. Only an explicit Reconnect / Refresh clears it.
        if (!s.adb && !s.connecting && s.state !== 'held') void connect(s)
      }
      for (const [id, s] of Array.from(sessions)) {
        if (present.has(id)) continue
        sessions.delete(id)
        await release(s)
      }
      emit()
    } catch (error) {
      if (!(error instanceof Error && error.message === 'WEBUSB_UNSUPPORTED')) {
        console.warn('[device] WebUSB sync failed', error)
      }
    } finally {
      syncing = false
    }
  }

  const onUsbChange = () => {
    void sync()
  }
  const onVisible = () => {
    if (!document.hidden) void sync()
  }

  const isAvailable = () => typeof navigator !== 'undefined' && 'usb' in navigator

  function ready(id: string): Adb {
    const adb = sessions.get(id)?.adb
    if (!adb) throw new Error('DEVICE_NOT_READY')
    return adb
  }

  return {
    kind: 'webusb',
    label: 'WebUSB',
    platforms: ['android'],
    canRequest: true,

    isAvailable,

    async start() {
      if (started || !isAvailable()) return
      started = true
      // navigator.usb events are the authoritative signal; the interval is only a backstop.
      navigator.usb.addEventListener('connect', onUsbChange)
      navigator.usb.addEventListener('disconnect', onUsbChange)
      document.addEventListener('visibilitychange', onVisible)
      timer = window.setInterval(() => {
        if (!document.hidden) void sync()
      }, SYNC_INTERVAL_MS)
      await sync()
    },

    stop() {
      if (!started) return
      started = false
      navigator.usb.removeEventListener('connect', onUsbChange)
      navigator.usb.removeEventListener('disconnect', onUsbChange)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
      // Release every device, an attempt still waiting on a phone's prompt included, so the
      // next start() (or another program) can claim it cleanly.
      for (const s of sessions.values()) void release(s)
      sessions.clear()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    list(): Device[] {
      return Array.from(sessions.values(), (s) =>
        normalizeDevice({
          id: s.id,
          backend: 'webusb',
          platform: 'android',
          connection: 'usb',
          state: s.state,
          name: s.props.model || s.device.name || s.serial,
          model: s.props.model,
          osVersion: s.props.release,
          blockers: s.blockers,
          capabilities: {
            screenshot: !!s.adb,
            identifiers: !!s.adb,
            install: !!s.adb,
            logs: !!s.adb,
          },
        }),
      )
    },

    // USER GESTURE ONLY — the spec rejects requestDevice without transient activation.
    async requestDevice() {
      const { manager: m } = await ensureManager()
      const device = await m.requestDevice()
      if (!device) return null // the picker was dismissed
      const s = entry(device)
      await connect(s)
      emit()
      return s.id
    },

    async detail(id) {
      const sh = ready(id).subprocess.noneProtocol
      const [getprop, wmSize, wmDensity, battery, df, androidId] = await Promise.all(
        DETAIL_COMMANDS.map((command) => sh.spawnWaitText(command).catch(() => '')),
      )
      return androidDetail(
        {
          getprop: getprop ?? '',
          wmSize: wmSize ?? '',
          wmDensity: wmDensity ?? '',
          battery: battery ?? '',
          df: df ?? '',
          androidId: androidId ?? '',
        },
        id,
      )
    },

    async screenshot(id) {
      // `screencap -p`, not framebuffer(): framebuffer throws whenever anything on screen sets
      // FLAG_SECURE (lock screen, banking apps, video) and its payload is far larger. It runs
      // over the exec: service the legacy page was verified with, where adbd mixes stderr into
      // the bytes — screencap warns there on phones with two displays (foldables, flip covers),
      // so extractPng() finds the image inside. spawnWait concatenates bytes: no text decoding.
      const bytes = await ready(id).subprocess.noneProtocol.spawnWait(['screencap', '-p'])
      const png = extractPng(bytes)
      if (!png) throw new Error('SCREENSHOT_NOT_PNG')
      return new Blob([png], { type: 'image/png' })
    },

    async retry(id) {
      const s = sessions.get(id)
      if (!s) return
      // Supersede an attempt still waiting (say, on the phone's prompt) and abort its transfers
      // before claiming again.
      await release(s)
      s.connecting = false
      s.state = 'connecting' // clears `held`, so the claim is attempted
      await connect(s)
    },

    // Refresh reclaims everything currently held, so the list's button is a real recovery
    // action and not just a re-poll.
    async retryHeld() {
      const held = Array.from(sessions.values()).filter((s) => s.state === 'held' && !s.adb)
      for (const s of held) s.state = 'connecting'
      await Promise.all(held.map((s) => connect(s)))
    },

    refresh: sync,

    async forget(id) {
      const s = sessions.get(id)
      if (!s) return
      await release(s)
      await s.device.raw.forget().catch(() => undefined)
      sessions.delete(id)
      emit()
    },

    async logs(id, onLines, signal) {
      const adb = ready(id)
      // -T 200: the last 200 lines first, then follow. threadtime is what Android Studio shows.
      // The signal goes to spawn as well: it refuses to start once aborted, and closes the
      // socket on abort, which kills logcat on the phone.
      const process = await adb.subprocess.noneProtocol.spawn(
        ['logcat', '-v', 'threadtime', '-T', '200'],
        signal,
      )
      const reader = process.output.getReader()
      // Closing the socket does not end the output until the phone acknowledges, so lines in
      // flight would keep arriving after Stop: cancel the reader at once instead.
      const stop = () => {
        void reader.cancel().catch(() => undefined)
      }
      signal.addEventListener('abort', stop, { once: true })
      const decoder = new TextDecoder()
      let carry = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          const text = carry + decoder.decode(value, { stream: true })
          const parts = text.split(/\r?\n/)
          carry = parts.pop() ?? ''
          if (parts.length > 0) onLines(parts)
        }
        if (carry && !signal.aborted) onLines([carry])
      } finally {
        signal.removeEventListener('abort', stop)
        reader.releaseLock()
      }
    },
  }
}
