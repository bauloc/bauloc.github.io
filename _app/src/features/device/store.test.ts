import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { classifyPmOutput, type InstallOutcome } from './backends/android/pm-output'
import type { InstallPlan } from './backends/archive/plan'
import {
  DEVICE_ERRORS,
  isFileChangedFailure,
  type Backend,
  type InstallProgress,
} from './backends/backend'
import { normalizeDevice, type Device, type DeviceDetail, type DeviceState } from './model'
import { PROGRESS_INTERVAL_MS, SHOT_LIMIT, activeJob, createDeviceLab } from './store'

/** A scriptable lane: tests set its devices and fire its change notification. */
function fakeBackend(kind: Backend['kind'] = 'webusb') {
  let devices: Device[] = []
  const listeners = new Set<() => void>()
  const detail = vi.fn<(id: string) => Promise<DeviceDetail>>((id) =>
    Promise.resolve({
      platform: 'android',
      identity: { Serial: id },
      software: {},
      hardware: {},
      status: {},
    }),
  )
  const screenshot = vi.fn<(id: string) => Promise<Blob>>(() => Promise.resolve(new Blob(['png'])))
  const backend: Backend = {
    kind,
    label: kind,
    platforms: ['android'],
    canRequest: false,
    isAvailable: () => true,
    start: () => Promise.resolve(),
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    list: () => devices,
    detail,
    screenshot,
  }
  return {
    backend,
    detail,
    screenshot,
    set(...list: [string, DeviceState, string[]?][]) {
      devices = list.map(([id, state, blockers = []]) =>
        normalizeDevice({
          id,
          backend: kind,
          state,
          blockers,
          name: id,
          capabilities: { install: state === 'ready' },
          android: {
            sdk: 37,
            release: '17',
            manufacturer: 'Google',
            brand: 'google',
            abis: ['arm64-v8a'],
          },
        }),
      )
      for (const listener of listeners) listener()
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const revokeObjectURL = vi.fn<(url: string) => void>()

beforeEach(() => {
  let n = 0
  revokeObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${String(++n)}`, revokeObjectURL })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDeviceLab', () => {
  it('selects the only ready device, and never guesses among several', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()

    lane.set(['a', 'ready'], ['b', 'unauthorized'])
    expect(lab.getSnapshot().selectedId).toBe('a')

    const two = fakeBackend()
    const lab2 = createDeviceLab([two.backend])
    await lab2.start()
    two.set(['a', 'ready'], ['b', 'ready'])
    expect(lab2.getSnapshot().selectedId).toBeNull()
  })

  it('loads the detail when the selected device becomes ready, and drops it when it stops being', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'authorizing'])
    lab.select('a')
    expect(lab.getSnapshot().detail.status).toBe('idle')

    lane.set(['a', 'ready'])
    expect(lab.getSnapshot().detail.status).toBe('loading')
    await flush()
    expect(lab.getSnapshot().detail).toMatchObject({ status: 'ready', deviceId: 'a' })

    lane.set(['a', 'offline'])
    expect(lab.getSnapshot().detail.status).toBe('idle')
  })

  it('re-reads the detail behind the shown one when a ready device’s blockers change', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    // The only ready device: selected on its own, and its detail read.
    lane.set(['a', 'ready', ['IOS_DEVELOPER_MODE_OFF']])
    await flush()
    expect(lab.getSnapshot().selectedId).toBe('a')
    expect(lane.detail).toHaveBeenCalledTimes(1)

    // The same list again reads nothing; Developer Mode turned on does, without a loading flash.
    lane.set(['a', 'ready', ['IOS_DEVELOPER_MODE_OFF']])
    expect(lane.detail).toHaveBeenCalledTimes(1)
    lane.detail.mockRejectedValueOnce(new Error('IOS_UNREACHABLE'))
    lane.set(['a', 'ready'])
    expect(lane.detail).toHaveBeenCalledTimes(2)
    expect(lab.getSnapshot().detail.status).toBe('ready')
    // A quiet read that fails keeps what was shown.
    await flush()
    expect(lab.getSnapshot().detail).toMatchObject({ status: 'ready', deviceId: 'a' })
  })

  it('drops a slow detail reply for a device that is no longer selected', async () => {
    const lane = fakeBackend()
    let resolveA: (d: DeviceDetail) => void = () => undefined
    lane.detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve
        }),
    )
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'ready'])
    lab.select('a')
    lab.select('b')
    await flush()
    resolveA({
      platform: 'android',
      identity: { Serial: 'stale' },
      software: {},
      hardware: {},
      status: {},
    })
    await flush()
    expect(lab.getSnapshot().detail).toMatchObject({ status: 'ready', deviceId: 'b' })
  })

  it('keeps the selection of a device that disconnected, so the page can say it went', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'offline'])
    lane.set(['b', 'offline'])
    const snap = lab.getSnapshot()
    expect(snap.selectedId).toBe('a')
    expect(snap.devices.map((d) => d.id)).toEqual(['b'])
    expect(snap.announcement.text).toBe('The selected device disconnected.')
  })

  it('picks the next phone on the cable once nothing else is attached (a swap)', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['pixel', 'ready'])
    lane.set()
    expect(lab.getSnapshot().selectedId).toBeNull()
    lane.set(['galaxy', 'authorizing'])
    lane.set(['galaxy', 'ready'])
    expect(lab.getSnapshot().selectedId).toBe('galaxy')
  })

  it('makes a repeated announcement a new one, so a live region speaks it again', async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    await lab.capture('a')
    const first = lab.getSnapshot().announcement
    await lab.capture('a')
    const second = lab.getSnapshot().announcement
    expect(second.text).toBe(first.text)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('tracks a Retry per device, so its button follows the device', async () => {
    const lane = fakeBackend()
    let finish: () => void = () => undefined
    const retry = vi.fn<(id: string) => Promise<void>>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const lab = createDeviceLab([{ ...lane.backend, retry }])
    await lab.start()
    lane.set(['a', 'unauthorized'], ['b', 'unauthorized'])
    const pending = lab.retry('a')
    expect(lab.getSnapshot().retrying).toEqual(['a'])
    await lab.retry('a') // a second press while the first is in flight does nothing
    expect(retry).toHaveBeenCalledTimes(1)
    finish()
    await pending
    expect(lab.getSnapshot().retrying).toEqual([])
  })

  it('lets work still in flight at stop() change nothing after it', async () => {
    const lane = fakeBackend()
    let deliver: (blob: Blob) => void = () => undefined
    lane.screenshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    const capture = lab.capture('a')
    lab.stop()
    deliver(new Blob(['png']))
    expect(await capture).toBeNull()
    expect(lab.getSnapshot().shots).toEqual([])
  })

  it('lists a device two lanes can see once, from the first lane', async () => {
    const usb = fakeBackend('webusb')
    const mock = fakeBackend('mock')
    const lab = createDeviceLab([usb.backend, mock.backend])
    await lab.start()
    usb.set(['same', 'ready'])
    mock.set(['same', 'offline'], ['other', 'ready'])
    // Both ready, so sorted by name; 'same' comes from the WebUSB lane, as it listed it first.
    expect(lab.getSnapshot().devices.map((d) => `${d.id}:${d.backend}`)).toEqual([
      'other:mock',
      'same:webusb',
    ])
  })

  describe('a device two lanes list (model.mergeDevices)', () => {
    /** One row each from WebUSB, the helper and the mock, in the page's lane order. */
    async function lanes(
      usb: DeviceState | null,
      agent: DeviceState | null,
      mock: DeviceState | null = null,
    ) {
      const [u, a, m] = [fakeBackend('webusb'), fakeBackend('agent'), fakeBackend('mock')]
      const lab = createDeviceLab([u.backend, a.backend, m.backend])
      await lab.start()
      if (usb) u.set(['pixel', usb])
      if (agent) a.set(['pixel', agent])
      if (mock) m.set(['pixel', mock])
      const rows = lab.getSnapshot().devices
      expect(rows).toHaveLength(1)
      return `${rows[0]?.backend ?? ''}:${rows[0]?.state ?? ''}`
    }

    it('takes the helper’s ready row over WebUSB’s held one: the adb server owns the phone', async () => {
      expect(await lanes('held', 'ready')).toBe('agent:ready')
    })

    it('takes the helper’s row over a held one whatever its state', async () => {
      expect(await lanes('held', 'unauthorized')).toBe('agent:unauthorized')
    })

    it('takes the more usable state', async () => {
      expect(await lanes('offline', 'ready')).toBe('agent:ready')
      expect(await lanes('ready', 'offline')).toBe('webusb:ready')
    })

    it('keeps lane order on a tie', async () => {
      expect(await lanes('ready', 'ready')).toBe('webusb:ready')
    })

    it('never lets the mock beat a real lane, even when the real row is worse', async () => {
      expect(await lanes(null, 'untrusted', 'ready')).toBe('agent:untrusted')
    })
  })

  it(`keeps the newest ${String(SHOT_LIMIT)} screenshots and releases the rest`, async () => {
    const lane = fakeBackend()
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    for (let i = 0; i < SHOT_LIMIT + 2; i++) expect(await lab.capture('a')).toBeNull()
    expect(lab.getSnapshot().shots).toHaveLength(SHOT_LIMIT)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)

    lab.clearShots('a')
    expect(lab.getSnapshot().shots).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledTimes(SHOT_LIMIT + 2)
  })

  it('keeps an all-black screenshot, marks it, and says why and what to do', async () => {
    const lane = fakeBackend()
    const looksBlack = vi.fn<(blob: Blob) => Promise<boolean>>()
    looksBlack.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const lab = createDeviceLab([lane.backend], { looksBlack })
    await lab.start()
    lane.set(['a', 'ready'])
    expect(await lab.capture('a')).toBeNull()
    expect(lab.getSnapshot().shots[0]?.black).toBe(true)
    expect(lab.getSnapshot().announcement.text).toBe(
      'Screenshot captured from a, all black. The screen was off or locked: wake and unlock the device, then take it again.',
    )
    expect(await lab.capture('a')).toBeNull()
    expect(lab.getSnapshot().shots.map((s) => s.black)).toEqual([false, true])
    expect(lab.getSnapshot().announcement.text).toBe('Screenshot captured from a.')
    // A look that fails says nothing, as before.
    looksBlack.mockRejectedValueOnce(new Error('decode'))
    expect(await lab.capture('a')).toBeNull()
    expect(lab.getSnapshot().shots[0]?.black).toBe(false)
  })

  it('reports a failed screenshot in words, not codes', async () => {
    const lane = fakeBackend()
    lane.screenshot.mockRejectedValueOnce(new Error('SCREENSHOT_NOT_PNG'))
    const lab = createDeviceLab([lane.backend])
    await lab.start()
    lane.set(['a', 'ready'])
    expect(await lab.capture('a')).toMatch(/not a PNG/)
    expect(lab.getSnapshot().capturing).toBe(false)
  })
})

/* ---------------------------------------------------------------- *
 * Jobs: installs
 * ---------------------------------------------------------------- */

/** A plan with one part, as archive/plan makes them; only what the store reads matters. */
function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return {
    kind: 'apk',
    inputs: [{ name: 'probe.apk', size: 1000, kind: 'apk', used: true }],
    app: {
      packageName: 'com.bauloc.bundleprobe',
      versionCode: 2,
      versionName: '1.1',
      minSdk: 32,
      targetSdk: 35,
      testOnly: false,
      debuggable: true,
      nativeAbis: [],
      label: 'Bundle Probe',
      icon: null,
    },
    parts: [
      {
        name: '0.apk',
        source: 'probe.apk',
        split: '',
        role: { module: 'base', kind: 'base', value: '' },
        size: 1000,
        open: () => Promise.resolve(new ReadableStream<Uint8Array>()),
      },
    ],
    totalBytes: 1000,
    selection: null,
    expansions: [],
    problems: [],
    warnings: [],
    notes: [],
    ...overrides,
  }
}

type InstallCall = Parameters<NonNullable<Backend['install']>>

/** A lane whose install the test drives: report progress, then resolve or reject it. */
function installLane() {
  const lane = fakeBackend()
  const calls: {
    args: InstallCall
    progress: (p: InstallProgress) => void
    signal: AbortSignal
    resolve: (o: InstallOutcome) => void
    reject: (e: unknown) => void
  }[] = []
  const install = vi.fn((...args: InstallCall) => {
    const [, , , progress, signal] = args
    return new Promise<InstallOutcome>((resolve, reject) => {
      calls.push({ args, progress, signal, resolve, reject })
      // A real lane rejects with the signal's reason once aborted.
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error)
      })
    })
  })
  let t = 1_000_000
  const clock = {
    now: () => t,
    tick: (ms: number) => {
      t += ms
    },
  }
  const lab = createDeviceLab([{ ...lane.backend, install }], { now: clock.now })
  return { lane, lab, install, calls, clock }
}

const call = <T>(list: readonly T[]) => {
  const last = list.at(-1)
  if (!last) throw new Error('no install call')
  return last
}

describe('install jobs', () => {
  it('walks sending → installing → done, announcing each phase once and never the bytes', async () => {
    const { lane, lab, calls, clock } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const done = lab.install('a', plan(), { grantPermissions: true })

    const job = lab.getSnapshot().jobs[0]
    expect(job).toMatchObject({
      deviceId: 'a',
      kind: 'install',
      label: 'Bundle Probe',
      phase: 'sending',
      sent: 0,
      total: 1000,
    })
    expect(typeof job?.cancel).toBe('function')
    expect(lab.getSnapshot().announcement.text).toBe('Sending Bundle Probe to a.')
    expect(call(calls).args[2]).toEqual({ grantPermissions: true })

    const seq = lab.getSnapshot().announcement.seq
    clock.tick(PROGRESS_INTERVAL_MS)
    call(calls).progress({ phase: 'sending', sent: 400, total: 1000 })
    // Too soon after the last update: not published.
    clock.tick(10)
    call(calls).progress({ phase: 'sending', sent: 500, total: 1000 })
    expect(lab.getSnapshot().jobs[0]?.sent).toBe(400)
    // The last byte always is.
    call(calls).progress({ phase: 'sending', sent: 1000, total: 1000 })
    expect(lab.getSnapshot().jobs[0]?.sent).toBe(1000)
    expect(lab.getSnapshot().announcement.seq).toBe(seq)

    clock.tick(5)
    call(calls).progress({ phase: 'installing', sent: 1000, total: 1000 })
    const installing = lab.getSnapshot().jobs[0]
    expect(installing).toMatchObject({ phase: 'installing', phaseSince: clock.now() })
    expect(installing?.cancel).toBeUndefined() // Android can't stop a commit
    expect(lab.getSnapshot().announcement.text).toBe('Installing Bundle Probe on a…')

    call(calls).resolve(classifyPmOutput('Success'))
    const final = await done
    expect(final).toMatchObject({ phase: 'done', outcome: { ok: true } })
    expect(lab.getSnapshot().jobs[0]).toMatchObject({ phase: 'done' })
    expect(lab.getSnapshot().announcement.text).toBe('Installed Bundle Probe on a.')
    expect(lab.getSnapshot().appsRevision).toEqual({ a: 1 })

    lab.dismissJob(final.id)
    expect(lab.getSnapshot().jobs).toEqual([])
  })

  it('cancels while sending: the lane sees the abort, and nothing is called installed', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const done = lab.install('a', plan())
    const id = lab.getSnapshot().jobs[0]?.id ?? ''
    lab.cancelJob(id)
    expect(call(calls).signal.aborted).toBe(true)
    expect(await done).toMatchObject({ phase: 'cancelled' })
    expect(lab.getSnapshot().announcement.text).toBe('Cancelled. Nothing was installed.')
    expect(lab.getSnapshot().appsRevision).toEqual({})
  })

  it('reports a refusal in INSTALL_ERRORS words, with the outcome kept for Details', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const done = lab.install('a', plan())
    call(calls).resolve(
      classifyPmOutput(
        'Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 1 is older than current 2]',
      ),
    )
    const job = await done
    expect(job.phase).toBe('failed')
    expect(job.outcome).toMatchObject({ ok: false, code: 'VERSION_DOWNGRADE' })
    expect(lab.getSnapshot().announcement.text).toBe(
      'Install on a failed: The phone has a newer version (2) than this file (1).',
    )
  })

  it('runs one install per device at a time, and refuses a plan with problems', async () => {
    const { lane, lab, install, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'ready'])
    const first = lab.install('a', plan())
    await expect(lab.install('a', plan())).rejects.toThrow('INSTALL_IN_PROGRESS')
    const other = lab.install('b', plan()) // another phone is fine
    expect(install).toHaveBeenCalledTimes(2)
    expect(activeJob(lab.getSnapshot().jobs, 'a', 'install')?.deviceId).toBe('a')

    const blocked = plan({
      parts: [],
      problems: [{ code: 'AAB_NEEDS_HELPER', message: 'Needs the helper.' }],
    })
    await expect(lab.install('a', blocked)).rejects.toThrow('INSTALL_IN_PROGRESS')
    for (const c of calls) c.resolve(classifyPmOutput('Success'))
    await Promise.all([first, other])
    await expect(lab.install('a', blocked)).rejects.toThrow('NOTHING_TO_INSTALL')
  })

  it('refuses a device that is not ready or cannot install', async () => {
    const { lane, lab } = installLane()
    await lab.start()
    lane.set(['a', 'authorizing'])
    await expect(lab.install('a', plan())).rejects.toThrow('DEVICE_NOT_READY')
    await expect(lab.install('nobody', plan())).rejects.toThrow('DEVICE_NOT_READY')
  })

  it('aborts the jobs of a device that went away, as CONNECTION_LOST, not Cancelled', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'], ['b', 'ready'])
    const onA = lab.install('a', plan())
    const onB = lab.install('b', plan())
    const [a, b] = calls
    lane.set(['b', 'ready'], ['a', 'absent'])
    expect(a?.signal.aborted).toBe(true)
    expect(b?.signal.aborted).toBe(false)
    const job = await onA
    expect(job).toMatchObject({
      phase: 'failed',
      outcome: { code: 'CONNECTION_LOST', params: { phase: 'sending' } },
    })
    expect(lab.getSnapshot().announcement.text).toBe(
      'Install on a failed: The phone disconnected during the install. Nothing was installed.',
    )
    b?.resolve(classifyPmOutput('Success'))
    expect(await onB).toMatchObject({ phase: 'done' })
  })

  it('words a phone lost mid-commit as "may have finished", and other failures as UNKNOWN or NOT_APK', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const lost = lab.install('a', plan())
    call(calls).progress({ phase: 'installing', sent: 1000, total: 1000 })
    lane.set()
    expect(await lost).toMatchObject({
      outcome: { code: 'CONNECTION_LOST', params: { phase: 'installing' } },
    })
    expect(lab.getSnapshot().announcement.text).toMatch(/disconnected while installing/)

    lane.set(['a', 'ready'])
    for (const code of ['ZIP_CORRUPT', 'ZIP_NOT_A_ZIP']) {
      const damaged = lab.install('a', plan())
      call(calls).reject(new Error(code))
      expect(await damaged).toMatchObject({ outcome: { code: 'NOT_APK' } })
    }

    const odd = lab.install('a', plan())
    call(calls).reject(new Error('Something odd'))
    expect(await odd).toMatchObject({ outcome: { code: 'UNKNOWN', message: 'Something odd' } })
    // Android never saw it, so it isn't worded as Android's refusal.
    expect(lab.getSnapshot().announcement.text).toBe('Install on a failed: Something odd')
  })

  it('words a file that changed or moved since it was picked as "pick it again", not as a bad APK', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const errors = [
      // Chrome, for a File rebuilt on disk after the pick, and for one deleted or moved.
      new DOMException('The requested file could not be read.', 'NotReadableError'),
      new DOMException('A requested file or directory could not be found.', 'NotFoundError'),
      // The sender and the zip reader, for one that changed size.
      new Error('INSTALL_SIZE_MISMATCH'),
      new Error('ZIP_SIZE_MISMATCH'),
    ]
    for (const error of errors) {
      const changed = lab.install('a', plan())
      call(calls).reject(error)
      const job = await changed
      expect(job).toMatchObject({
        phase: 'failed',
        outcome: {
          code: 'UNKNOWN',
          androidCode: null,
          output: '',
          message: DEVICE_ERRORS.FILE_CHANGED,
          params: { cause: 'FILE_CHANGED' },
        },
      })
      expect(job.outcome && !job.outcome.ok && isFileChangedFailure(job.outcome)).toBe(true)
      expect(lab.getSnapshot().announcement.text).toBe(
        `Install on a failed: ${DEVICE_ERRORS.FILE_CHANGED}`,
      )
    }
  })

  it('keeps a dialog-closed job listed until dismissed, and stop() ends every job quietly', async () => {
    const { lane, lab, calls } = installLane()
    await lab.start()
    lane.set(['a', 'ready'])
    const done = lab.install('a', plan())
    const id = lab.getSnapshot().jobs[0]?.id ?? ''
    lab.dismissJob(id) // still running: stays
    expect(lab.getSnapshot().jobs).toHaveLength(1)
    lab.stop()
    expect(call(calls).signal.aborted).toBe(true)
    await done
    expect(lab.getSnapshot().jobs).toEqual([])
  })
})

describe('preflight inputs', () => {
  it('records how the picker ended', async () => {
    const lane = fakeBackend()
    const answers: (string | null)[] = [null, 'a']
    const requestDevice = vi.fn(() => Promise.resolve(answers.shift() ?? null))
    const lab = createDeviceLab([{ ...lane.backend, canRequest: true, requestDevice }])
    await lab.start()
    expect(lab.getSnapshot().picker).toBe('none')
    await lab.requestDevice()
    expect(lab.getSnapshot().picker).toBe('dismissed')
    await lab.requestDevice()
    expect(lab.getSnapshot().picker).toBe('picked')

    requestDevice.mockRejectedValueOnce(
      Object.assign(new Error('No device selected.'), { name: 'NotFoundError' }),
    )
    await expect(lab.requestDevice()).rejects.toThrow('No device selected')
    expect(lab.getSnapshot().picker).toBe('dismissed')
  })

  it('remembers since when each device has waited on "Allow USB debugging?"', async () => {
    const lane = fakeBackend()
    let t = 5000
    const lab = createDeviceLab([lane.backend], { now: () => t })
    await lab.start()
    lane.set(['a', 'authorizing'])
    expect(lab.getSnapshot().authorizingSince).toEqual({ a: 5000 })
    t = 9000
    lane.set(['a', 'unauthorized'], ['b', 'authorizing']) // still waiting: the time is kept
    expect(lab.getSnapshot().authorizingSince).toEqual({ a: 5000, b: 9000 })
    lane.set(['a', 'ready'], ['b', 'authorizing'])
    expect(lab.getSnapshot().authorizingSince).toEqual({ b: 9000 })
  })

  it('keeps the last USB finding', async () => {
    const lab = createDeviceLab([fakeBackend().backend])
    await lab.start()
    lab.setUsbFinding({ kind: 'debugging-off', name: 'Pixel 9' })
    expect(lab.getSnapshot().usb).toEqual({ kind: 'debugging-off', name: 'Pixel 9' })
  })
})

describe('app actions', () => {
  it('announces what worked, words what failed, and marks the app list changed on uninstall', async () => {
    const lane = fakeBackend()
    const appAction = vi.fn<NonNullable<Backend['appAction']>>(() => Promise.resolve())
    const lab = createDeviceLab([{ ...lane.backend, appAction }])
    await lab.start()
    lane.set(['a', 'ready'])

    expect(await lab.appAction('a', 'com.example.notes', 'stop')).toBeNull()
    expect(lab.getSnapshot().announcement.text).toBe('Stopped com.example.notes.')
    expect(await lab.appAction('a', 'com.example.notes', 'uninstall')).toBeNull()
    expect(lab.getSnapshot().announcement.text).toBe('Uninstalled com.example.notes from a.')
    expect(lab.getSnapshot().appsRevision).toEqual({ a: 1 })

    appAction.mockRejectedValueOnce(new Error('APP_NOT_LAUNCHABLE'))
    expect(await lab.appAction('a', 'com.android.systemui', 'launch')).toBe(
      'This app has no screen to open.',
    )
    appAction.mockRejectedValueOnce(new Error('CLEAR_FAILED'))
    expect(await lab.appAction('a', 'com.example.notes', 'clear')).toMatch(/didn’t clear/)
  })
})
