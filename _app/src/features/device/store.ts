import { useSyncExternalStore } from 'react'

import type { InstallErrorCode, InstallFailure, InstallOutcome } from './backends/android/pm-output'
import type { InstallPlan } from './backends/archive/plan'
import type { AppAction, Backend, InstallOptions, InstallProgress } from './backends/backend'
import {
  deviceErrorMessage,
  fileChangedFailure,
  isFileChangedError,
  isLocalFailure,
} from './backends/backend'
import {
  installErrorWording,
  mergeDevices,
  shotFilename,
  type Device,
  type DeviceDetail,
  type DeviceState,
} from './model'
import type { PickerOutcome, UsbFinding } from './preflight/types'

/*
  Device Lab's state, outside React: the merged device list, the selection, the open
  device's detail, screenshots, and what to announce. React reads it through
  useSyncExternalStore; backends feed it through their subscriptions. Keeping it here keeps
  the rules testable without a DOM (store.test.ts), and they are the legacy page's rules:

  - one list for both platforms, first lane wins on a shared device (model.mergeDevices);
  - auto-select only when exactly one device is ready and nothing is selected — never
    silently pick among several (scrcpy #3137, Maestro #2096);
  - a selected device that disappears is SAID to have gone, not silently swapped (STF);
  - detail is fetched when the selected device becomes ready, and dropped when it stops being;
  - long work (an install) is a per-device JOB with a phase, bytes and a Cancel. Only phase
    changes are announced, never progress. A device that goes away takes its jobs with it:
    they are aborted, and an install reports CONNECTION_LOST rather than "Cancelled".
*/

/** At most this many screenshots are kept; older ones are released (blob URLs revoked). */
export const SHOT_LIMIT = 12

export interface Shot {
  readonly id: string
  readonly deviceId: string
  readonly deviceName: string
  readonly blob: Blob
  /** A blob URL: <img> cannot carry an Authorization header, and a token in a URL leaks. */
  readonly url: string
  readonly at: Date
  readonly fileName: string
}

export type DetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly deviceId: string }
  | { readonly status: 'ready'; readonly deviceId: string; readonly detail: DeviceDetail }
  | { readonly status: 'failed'; readonly deviceId: string; readonly message: string }

export type JobKind = 'install'

/**
 * `sending` (Cancel works) → `installing` (it doesn't: Android can't stop a commit) → one of
 * the three ends. A job that ended stays listed until dismissed, so a dialog closed mid-install
 * still finds its result in the jobs strip.
 */
export type JobPhase = 'sending' | 'installing' | 'done' | 'failed' | 'cancelled'

export interface Job {
  readonly id: string
  readonly deviceId: string
  readonly deviceName: string
  readonly kind: JobKind
  /** What it is about: the app's label, else its package, else the file's name. */
  readonly label: string
  readonly phase: JobPhase
  /** Bytes sent so far, and in all. */
  readonly sent?: number
  readonly total?: number
  /** ms since the epoch: when the job started, and when its phase last changed. */
  readonly startedAt: number
  readonly phaseSince: number
  /** Present while the job can still be stopped. */
  readonly cancel?: () => void
  /** An install's outcome, once done or failed. */
  readonly outcome?: InstallOutcome
}

/** Phases a job is still running in. */
export const isJobActive = (job: Job) => job.phase === 'sending' || job.phase === 'installing'

/** The device's running job of a kind, if any: one install per device at a time. */
export function activeJob(jobs: readonly Job[], deviceId: string, kind: JobKind): Job | undefined {
  return jobs.find((j) => j.deviceId === deviceId && j.kind === kind && isJobActive(j))
}

/** Progress is published at most this often; phase changes always at once. */
export const PROGRESS_INTERVAL_MS = 100

/**
 * A message for the polite live region. `seq` makes each one a new event: a live region speaks
 * only when its DOM changes, so a second "Screenshot captured from Pixel 9." would be silent.
 */
export interface Announcement {
  readonly text: string
  readonly seq: number
}

export interface DeviceLabSnapshot {
  readonly devices: readonly Device[]
  /** What the user (or the one-ready-device rule) selected; may name a device that has gone. */
  readonly selectedId: string | null
  readonly detail: DetailState
  readonly shots: readonly Shot[]
  readonly capturing: boolean
  /** Devices with a Retry in flight, so its button follows the device, not the card on screen. */
  readonly retrying: readonly string[]
  /** For the polite live region: connection changes and job results, once each. */
  readonly announcement: Announcement
  /** Installs, per device: running ones and finished ones not yet dismissed. */
  readonly jobs: readonly Job[]
  /** How the last Add device picker ended, for the checklist. */
  readonly picker: PickerOutcome
  /** Per device: since when (ms) it has waited on "Allow USB debugging?". */
  readonly authorizingSince: Readonly<Record<string, number>>
  /** The last look at the raw USB devices ("Find my phone…", or a scan of granted ones). */
  readonly usb: UsbFinding
  /**
   * Per device: bumped when its installed apps changed through Device Lab (an install, an
   * uninstall), so the Apps tab knows to list them again.
   */
  readonly appsRevision: Readonly<Record<string, number>>
}

const INITIAL: DeviceLabSnapshot = {
  devices: [],
  selectedId: null,
  detail: { status: 'idle' },
  shots: [],
  capturing: false,
  retrying: [],
  announcement: { text: '', seq: 0 },
  jobs: [],
  picker: 'none',
  authorizingSince: {},
  usb: { kind: 'unknown' },
  appsRevision: {},
}

/** States in which a device is waiting on the phone's "Allow USB debugging?". */
const AUTHORIZING: ReadonlySet<DeviceState> = new Set(['authorizing', 'unauthorized'])
/** States a running job survives. Anything else means the phone went away. */
const CONNECTED: ReadonlySet<DeviceState> = new Set(['ready', 'busy'])

/** How a store reads the time: injectable, for tests. */
export interface DeviceLabOptions {
  readonly now?: () => number
}

export interface DeviceLab {
  readonly backends: readonly Backend[]
  // Properties, not methods: useSyncExternalStore receives them detached from the object.
  readonly getSnapshot: () => DeviceLabSnapshot
  readonly subscribe: (listener: () => void) => () => void
  start(): Promise<void>
  stop(): void
  select(id: string | null): void
  /** USER GESTURE ONLY. Resolves to the picked device's id, or null when the picker was dismissed. */
  requestDevice(): Promise<string | null>
  /** Re-poll every lane and reclaim held devices — what Refresh means. */
  refresh(): Promise<void>
  retry(id: string): Promise<void>
  reloadDetail(): void
  /** Resolves to null on success, or the failure's wording. */
  capture(id: string): Promise<string | null>
  clearShots(deviceId: string): void
  announce(message: string): void
  /**
   * Starts an install job on a device and resolves with the job once it ended (done, failed or
   * cancelled). Rejects with INSTALL_IN_PROGRESS while another install runs on that device,
   * DEVICE_NOT_READY when the device can't install, and NOTHING_TO_INSTALL for a plan with
   * problems: words for them are in DEVICE_ERRORS.
   */
  install(deviceId: string, plan: InstallPlan, options?: InstallOptions): Promise<Job>
  /** Cancels a job while it can still be cancelled. */
  cancelJob(jobId: string): void
  /** Removes an ended job from the list. */
  dismissJob(jobId: string): void
  /**
   * An app action, announced when it works. Resolves to null on success, or the failure's
   * wording. Uninstall bumps the device's appsRevision.
   */
  appAction(deviceId: string, pkg: string, action: AppAction): Promise<string | null>
  /** Records what "Find my phone…" or a scan of granted devices found. */
  setUsbFinding(finding: UsbFinding): void
}

/** What an install is called in messages. */
export function installLabel(plan: InstallPlan): string {
  return plan.app?.label || plan.app?.packageName || plan.inputs[0]?.name || 'the app'
}

/** What a successful app action says, for the live region. */
function actionDone(action: AppAction, pkg: string, device: string): string {
  switch (action) {
    case 'launch':
      return `Opened ${pkg} on ${device}.`
    case 'stop':
      return `Stopped ${pkg}.`
    case 'clear':
      return `Cleared the data of ${pkg} on ${device}.`
    case 'uninstall':
      return `Uninstalled ${pkg} from ${device}.`
    case 'info':
      return `Opened App info for ${pkg} on ${device}.`
  }
}

/**
 * An archive that broke while it was read for sending: damaged, or packed in a way it can't be
 * read. (One that changed since it was picked is isFileChangedError, checked first.)
 */
const damagedFile = (error: unknown) =>
  error instanceof Error && /^ZIP_[A-Z_]+$/.test(error.message)

/** pm-output's installFailure, without pulling that module into the page's chunk. */
const failure = (
  code: InstallErrorCode,
  message: string,
  params: Readonly<Record<string, string>> = {},
): InstallFailure => ({ ok: false, code, androidCode: null, message, params, output: '' })

/** Why a job's signal was aborted: the tester, or the device going away. */
type AbortCause = 'cancel' | 'lost' | 'stop'

export function createDeviceLab(
  backends: readonly Backend[],
  options: DeviceLabOptions = {},
): DeviceLab {
  const now = options.now ?? Date.now
  let snap = INITIAL
  /** Running jobs' abort handles, and why each was aborted. */
  const running = new Map<string, { controller: AbortController; cause: AbortCause | null }>()
  let jobSeq = 0
  const listeners = new Set<() => void>()
  const unsubscribers: (() => void)[] = []
  /** Bumped on every detail request, so a slow reply for a previous device is dropped. */
  let detailTicket = 0
  /** Bumped by stop(), so work still in flight from before it changes nothing after. */
  let generation = 0

  const set = (patch: Partial<DeviceLabSnapshot>) => {
    snap = { ...snap, ...patch }
    for (const listener of listeners) listener()
  }
  const say = (text: string): Announcement => ({ text, seq: snap.announcement.seq + 1 })

  const available = () => backends.filter((b) => b.isAvailable())
  const backendOf = (device: Device | undefined) =>
    device ? backends.find((b) => b.kind === device.backend) : undefined
  const findDevice = (id: string | null) =>
    id === null ? undefined : snap.devices.find((d) => d.id === id)

  function loadDetail(device: Device) {
    const backend = backendOf(device)
    if (!backend) return
    const ticket = ++detailTicket
    set({ detail: { status: 'loading', deviceId: device.id } })
    backend.detail(device.id).then(
      (detail) => {
        if (ticket === detailTicket)
          set({ detail: { status: 'ready', deviceId: device.id, detail } })
      },
      (error: unknown) => {
        if (ticket === detailTicket) {
          set({
            detail: { status: 'failed', deviceId: device.id, message: deviceErrorMessage(error) },
          })
        }
      },
    )
  }

  /** Detail follows the selected device's readiness, as the legacy 'devices' listener did. */
  function syncDetail() {
    const device = findDevice(snap.selectedId)
    const d = snap.detail
    const ownsDetail = d.status !== 'idle' && device !== undefined && d.deviceId === device.id
    if (!device || device.state !== 'ready') {
      if (d.status !== 'idle') {
        detailTicket++
        set({ detail: { status: 'idle' } })
      }
      return
    }
    if (!ownsDetail) loadDetail(device)
  }

  function select(id: string | null) {
    detailTicket++
    set({ selectedId: id, detail: { status: 'idle' } })
    syncDetail()
  }

  /** Replaces one job; a job that is gone (dismissed, or stop()) stays gone. */
  function patchJob(id: string, patch: Partial<Job>, announcement?: string) {
    if (!snap.jobs.some((j) => j.id === id)) return
    set({
      jobs: snap.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      ...(announcement === undefined ? {} : { announcement: say(announcement) }),
    })
  }

  function abortJob(id: string, cause: AbortCause) {
    const handle = running.get(id)
    if (!handle || handle.cause) return
    handle.cause = cause
    handle.controller.abort(new DOMException('The job was stopped.', 'AbortError'))
  }

  /** Aborts the jobs of devices that left the list or stopped being connected. */
  function abortOrphanedJobs(devices: readonly Device[]) {
    for (const job of snap.jobs) {
      if (!isJobActive(job)) continue
      const device = devices.find((d) => d.id === job.deviceId)
      if (!device || !CONNECTED.has(device.state)) abortJob(job.id, 'lost')
    }
  }

  /** Since when each device has waited on its prompt: kept while it keeps waiting. */
  function authorizingTimes(devices: readonly Device[]): Readonly<Record<string, number>> {
    const out: Record<string, number> = {}
    let changed = false
    for (const d of devices) {
      if (!AUTHORIZING.has(d.state)) continue
      const since = snap.authorizingSince[d.id]
      out[d.id] = since ?? now()
      if (since === undefined) changed = true
    }
    if (!changed && Object.keys(out).length === Object.keys(snap.authorizingSince).length) {
      return snap.authorizingSince
    }
    return out
  }

  function onDevicesChanged() {
    const previous = snap.devices
    const devices = mergeDevices(available().map((b) => b.list()))
    let selectedId = snap.selectedId
    if (selectedId === null) {
      const ready = devices.filter((d) => d.state === 'ready')
      if (ready.length === 1 && ready[0]) selectedId = ready[0].id
    }
    let message: string | null = null
    const before = new Map(previous.map((d) => [d.id, d]))
    for (const d of devices) {
      const was = before.get(d.id)
      if (d.state === 'ready' && was?.state !== 'ready') message = `${d.name} connected.`
    }
    if (
      snap.selectedId !== null &&
      before.has(snap.selectedId) &&
      !devices.some((d) => d.id === snap.selectedId)
    ) {
      message = 'The selected device disconnected.'
    }
    // A gone selection is kept so the pane can say it went. Once nothing is attached the gate
    // replaces the pane, though, and holding on would stop the next phone on the cable from
    // being picked by the one-ready-device rule.
    if (devices.length === 0) selectedId = null
    set({
      devices,
      selectedId,
      authorizingSince: authorizingTimes(devices),
      ...(message === null ? {} : { announcement: say(message) }),
    })
    abortOrphanedJobs(devices)
    syncDetail()
  }

  async function runInstall(
    device: Device,
    install: NonNullable<Backend['install']>,
    plan: InstallPlan,
    opts: InstallOptions,
  ): Promise<Job> {
    const gen = generation
    const id = `job_${String(++jobSeq)}`
    const label = installLabel(plan)
    const controller = new AbortController()
    const handle = { controller, cause: null as AbortCause | null }
    running.set(id, handle)
    const started = now()
    let lastPublished = 0
    let phase: InstallProgress['phase'] = 'sending'
    const cancel = () => {
      if (phase === 'sending') abortJob(id, 'cancel')
    }
    const job: Job = {
      id,
      deviceId: device.id,
      deviceName: device.name,
      kind: 'install',
      label,
      phase: 'sending',
      sent: 0,
      total: plan.totalBytes,
      startedAt: started,
      phaseSince: started,
      cancel,
    }
    set({
      jobs: [...snap.jobs, job],
      announcement: say(`Sending ${label} to ${device.name}.`),
    })

    const onProgress = (p: InstallProgress) => {
      if (gen !== generation) return
      const t = now()
      if (p.phase !== phase) {
        phase = p.phase
        lastPublished = t
        // Android can't stop a commit, so Cancel goes away here.
        patchJob(
          id,
          { phase: p.phase, sent: p.sent, total: p.total, phaseSince: t, cancel: undefined },
          `Installing ${label} on ${device.name}…`,
        )
        return
      }
      if (t - lastPublished < PROGRESS_INTERVAL_MS && p.sent < p.total) return
      lastPublished = t
      patchJob(id, { sent: p.sent, total: p.total })
    }

    let outcome: InstallOutcome | null
    try {
      outcome = await install(device.id, plan, opts, onProgress, controller.signal)
    } catch (error) {
      const lost =
        handle.cause === 'lost' || (error instanceof Error && error.message === 'DEVICE_NOT_READY')
      if (lost) outcome = failure('CONNECTION_LOST', '', { phase })
      else if (handle.cause !== null)
        outcome = null // Cancel, or stop()
      // A file changed since the pick fails the same way on Retry: it has to be picked again.
      else if (isFileChangedError(error)) outcome = fileChangedFailure()
      else outcome = failure(damagedFile(error) ? 'NOT_APK' : 'UNKNOWN', deviceErrorMessage(error))
    } finally {
      running.delete(id)
    }

    const t = now()
    let end: Partial<Job>
    let message: string
    if (outcome === null) {
      end = { phase: 'cancelled' }
      message = 'Cancelled. Nothing was installed.'
    } else if (outcome.ok) {
      end = { phase: 'done', outcome }
      message =
        outcome.warnings.length > 0
          ? `Installed ${label} on ${device.name}, with warnings.`
          : `Installed ${label} on ${device.name}.`
    } else {
      end = { phase: 'failed', outcome }
      // The browser's own sentence as it is: Android never saw this install.
      const text = isLocalFailure(outcome)
        ? outcome.message
        : installErrorWording(outcome, { abis: device.android?.abis ?? [] }).text
      message = `Install on ${device.name} failed: ${text}`
    }
    const final: Job = {
      ...(snap.jobs.find((j) => j.id === id) ?? job),
      ...end,
      phaseSince: t,
      cancel: undefined,
    }
    if (gen !== generation) return final
    patchJob(id, final, message)
    if (outcome?.ok) bumpApps(device.id)
    return final
  }

  function bumpApps(deviceId: string) {
    set({
      appsRevision: {
        ...snap.appsRevision,
        [deviceId]: (snap.appsRevision[deviceId] ?? 0) + 1,
      },
    })
  }

  return {
    backends,
    getSnapshot: () => snap,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start() {
      const gen = generation
      for (const b of available()) unsubscribers.push(b.subscribe(onDevicesChanged))
      onDevicesChanged()
      for (const b of available()) {
        try {
          await b.start()
        } catch (error) {
          console.warn(`[device] backend "${b.kind}" failed to start`, error)
        }
      }
      if (gen !== generation) return
      onDevicesChanged()
      set({ announcement: say('Device Lab ready.') })
    },

    stop() {
      generation++
      detailTicket++
      for (const id of Array.from(running.keys())) abortJob(id, 'stop')
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      for (const b of backends) b.stop()
      for (const shot of snap.shots) URL.revokeObjectURL(shot.url)
      snap = INITIAL
    },

    select,

    async requestDevice() {
      const backend = available().find((b) => b.canRequest && b.requestDevice)
      if (!backend?.requestDevice) throw new Error('WEBUSB_UNSUPPORTED')
      let id: string | null
      try {
        id = await backend.requestDevice()
      } catch (error) {
        // Some versions report a dismissed picker as NotFoundError "No device selected".
        if (
          error instanceof Error &&
          (error.name === 'NotFoundError' || /No device selected/i.test(error.message))
        ) {
          set({ picker: 'dismissed' })
        }
        throw error
      }
      set({ picker: id === null ? 'dismissed' : 'picked' })
      if (id !== null) select(id)
      return id
    },

    async refresh() {
      for (const b of available()) {
        await b.start()
        await b.retryHeld?.()
        await b.refresh?.()
      }
    },

    // The detail follows on its own: a device that becomes ready re-enters syncDetail.
    async retry(id) {
      const backend = backendOf(findDevice(id))
      if (!backend?.retry || snap.retrying.includes(id)) return
      const gen = generation
      set({ retrying: [...snap.retrying, id] })
      try {
        await backend.retry(id)
      } finally {
        if (gen === generation) set({ retrying: snap.retrying.filter((r) => r !== id) })
      }
    },

    reloadDetail() {
      const device = findDevice(snap.selectedId)
      if (device?.state === 'ready') loadDetail(device)
    },

    async capture(id) {
      const device = findDevice(id)
      const backend = backendOf(device)
      if (!device || !backend || snap.capturing) return null
      const gen = generation
      set({ capturing: true })
      try {
        const blob = await backend.screenshot(id)
        if (gen !== generation) return null
        const at = new Date()
        const shot: Shot = {
          id: `shot_${String(at.getTime())}`,
          deviceId: id,
          deviceName: device.name,
          blob,
          url: URL.createObjectURL(blob),
          at,
          fileName: shotFilename(device, at),
        }
        const shots = [shot, ...snap.shots]
        // Revoke what drops off the end, or it leaks for the life of the page.
        for (const dropped of shots.splice(SHOT_LIMIT)) URL.revokeObjectURL(dropped.url)
        set({
          shots,
          capturing: false,
          announcement: say(`Screenshot captured from ${device.name}.`),
        })
        return null
      } catch (error) {
        if (gen !== generation) return null
        set({ capturing: false })
        return deviceErrorMessage(error)
      }
    },

    clearShots(deviceId) {
      const [gone, kept] = [
        snap.shots.filter((s) => s.deviceId === deviceId),
        snap.shots.filter((s) => s.deviceId !== deviceId),
      ]
      for (const s of gone) URL.revokeObjectURL(s.url)
      set({ shots: kept })
    },

    announce(message) {
      set({ announcement: say(message) })
    },

    install(deviceId, plan, opts = {}) {
      const device = findDevice(deviceId)
      const backend = backendOf(device)
      if (
        !device ||
        !backend?.install ||
        !device.capabilities.install ||
        device.state !== 'ready'
      ) {
        return Promise.reject(new Error('DEVICE_NOT_READY'))
      }
      if (activeJob(snap.jobs, deviceId, 'install')) {
        return Promise.reject(new Error('INSTALL_IN_PROGRESS'))
      }
      if (plan.problems.length > 0 || plan.parts.length === 0) {
        return Promise.reject(new Error('NOTHING_TO_INSTALL'))
      }
      return runInstall(device, backend.install, plan, opts)
    },

    cancelJob(jobId) {
      const job = snap.jobs.find((j) => j.id === jobId)
      if (job?.cancel) job.cancel()
    },

    dismissJob(jobId) {
      const job = snap.jobs.find((j) => j.id === jobId)
      if (!job || isJobActive(job)) return
      set({ jobs: snap.jobs.filter((j) => j.id !== jobId) })
    },

    async appAction(deviceId, pkg, action) {
      const device = findDevice(deviceId)
      const backend = backendOf(device)
      if (!device || !backend?.appAction) return deviceErrorMessage(new Error('DEVICE_NOT_READY'))
      const gen = generation
      try {
        await backend.appAction(deviceId, pkg, action)
      } catch (error) {
        // Just the reason: the caller titles it ("Couldn’t open Shop"), knowing the app's label.
        return deviceErrorMessage(error)
      }
      if (gen !== generation) return null
      set({ announcement: say(actionDone(action, pkg, device.name)) })
      if (action === 'uninstall') bumpApps(deviceId)
      return null
    },

    setUsbFinding(finding) {
      set({ usb: finding })
    },
  }
}

export function useDeviceLabSnapshot(lab: DeviceLab): DeviceLabSnapshot {
  return useSyncExternalStore(lab.subscribe, lab.getSnapshot, lab.getSnapshot)
}
