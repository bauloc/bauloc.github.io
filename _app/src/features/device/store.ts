import { useSyncExternalStore } from 'react'

import type { Backend } from './backends/backend'
import { deviceErrorMessage } from './backends/backend'
import { mergeDevices, shotFilename, type Device, type DeviceDetail } from './model'

/*
  Device Lab's state, outside React: the merged device list, the selection, the open
  device's detail, screenshots, and what to announce. React reads it through
  useSyncExternalStore; backends feed it through their subscriptions. Keeping it here keeps
  the rules testable without a DOM (store.test.ts), and they are the legacy page's rules:

  - one list for both platforms, first lane wins on a shared device (model.mergeDevices);
  - auto-select only when exactly one device is ready and nothing is selected — never
    silently pick among several (scrcpy #3137, Maestro #2096);
  - a selected device that disappears is SAID to have gone, not silently swapped (STF);
  - detail is fetched when the selected device becomes ready, and dropped when it stops being.
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
}

const INITIAL: DeviceLabSnapshot = {
  devices: [],
  selectedId: null,
  detail: { status: 'idle' },
  shots: [],
  capturing: false,
  retrying: [],
  announcement: { text: '', seq: 0 },
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
}

export function createDeviceLab(backends: readonly Backend[]): DeviceLab {
  let snap = INITIAL
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
    set({ devices, selectedId, ...(message === null ? {} : { announcement: say(message) }) })
    syncDetail()
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
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      for (const b of backends) b.stop()
      for (const shot of snap.shots) URL.revokeObjectURL(shot.url)
      snap = INITIAL
    },

    select,

    async requestDevice() {
      const backend = available().find((b) => b.canRequest && b.requestDevice)
      if (!backend?.requestDevice) throw new Error('WEBUSB_UNSUPPORTED')
      const id = await backend.requestDevice()
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
  }
}

export function useDeviceLabSnapshot(lab: DeviceLab): DeviceLabSnapshot {
  return useSyncExternalStore(lab.subscribe, lab.getSnapshot, lab.getSnapshot)
}
