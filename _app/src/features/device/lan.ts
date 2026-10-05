import { deviceErrorMessage } from './backends/backend'
import { HelperError, isAbortError } from './helper/client'
import type { HelperConnection, HelperStatus } from './helper/connection'
import { addressOf, DEFAULT_ADB_PORT, targetOfSerial } from './helper/network'
import {
  serialOfInstance,
  type LanDevice,
  type LanNetwork,
  type LanResult,
} from './helper/protocol'
import { featureSupport, type FeatureSupport } from './helper/update'
import { LAN_COPY } from './lan-copy'
import type { LanView } from './lan-kinds'
import type { ListedDevice, NearbyRow } from './nearby'

/*
  "Devices on this network" (feature `lan.discover`): every device the helper finds on this
  computer's network, as the page lists them. It looks when the list opens, answered at once
  when the helper looked in the last 30 s, and on Refresh. Nothing runs in the background (no
  timer, no interval), and closing the list only stops waiting: the helper's look goes on, and
  it keeps the answer for the next opening. Plain functions over a snapshot, with subscribe(),
  for useSyncExternalStore.
*/

/** A look this recent stands: opening the list again within it asks nothing. */
export const LAN_FRESH = 30_000

/**
 * Whether the helper can look now: `helper` while it isn't running and paired, `older` for a
 * helper from before this list (1.2.0). --no-android has no say: the list is the helper's own.
 */
export function lanAvailability(
  status: Pick<HelperStatus, 'phase' | 'pairing' | 'health' | 'lanes'>,
): FeatureSupport {
  return featureSupport(status, 'lan.discover')
}

export type LanState =
  /** Nothing asked yet. */
  | 'idle'
  /** The first look, with nothing found yet. */
  | 'looking'
  | 'ok'
  /** This computer can't reach the local network; what the system's resolver named is kept. */
  | 'blocked'
  /** The helper couldn't look (`message` says why), or the request failed. */
  | 'failed'
  /** The helper is older than this list (no `lan.discover`, or no such route). */
  | 'unsupported'

export interface LanSnapshot {
  readonly state: LanState
  /** The last answer: kept while a later look runs, and through a failed request. */
  readonly result: LanResult | null
  /** A look is in flight (the first shows the skeleton; later ones only turn Refresh). */
  readonly busy: boolean
  /** When the last answer or failure came (ms since the epoch), or null before one. */
  readonly at: number | null
  /** failed: what to say. */
  readonly message?: string
  /** failed: the helper's reason, or the page's code for the request. */
  readonly code?: string
  /** blocked, failed: what the system said, as the helper passed it on. */
  readonly detail?: string
}

export interface Lan {
  readonly getSnapshot: () => LanSnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** The list opened: look, unless an answer came moments ago. */
  readonly open: () => void
  /** Refresh: ask the helper to look again now, not answer from its last look. */
  readonly refresh: () => Promise<void>
  /** The list closed: stop waiting for an answer. */
  readonly close: () => void
}

export interface LanDeps {
  readonly connection: Pick<HelperConnection, 'lanDevices'>
  readonly now?: () => number
}

const INITIAL: LanSnapshot = { state: 'idle', result: null, busy: false, at: null }

/** A failed request's state, worded by the page (never a bare code). */
function failure(error: unknown): Partial<LanSnapshot> {
  if (error instanceof HelperError) {
    if (error.code === 'LAN_UNSUPPORTED' || error.code === 'NOT_FOUND') {
      return { state: 'unsupported', code: error.code }
    }
    // Our own deadline: the helper's words for it, not "the device took too long".
    const timeout = error.kind === 'timeout'
    const code = timeout ? 'HELPER_TIMEOUT' : error.code
    const words = deviceErrorMessage(timeout ? new Error(code) : error)
    return { state: 'failed', code, message: words === code ? LAN_COPY.state.unavailable : words }
  }
  return { state: 'failed', code: 'INTERNAL', message: LAN_COPY.state.unavailable }
}

/** An answer's state: the helper's `error` or `note` says why it couldn't look everywhere. */
function settled(result: LanResult, at: number): Partial<LanSnapshot> {
  const problem = result.error ?? result.note
  if (!problem) return { state: 'ok', result, at }
  const detail = problem.detail ? { detail: problem.detail } : {}
  if (problem.reason === 'blocked') return { state: 'blocked', result, at, ...detail }
  const message =
    problem.reason === 'no-network' ? LAN_COPY.state.noNetwork : LAN_COPY.state.unavailable
  return { state: 'failed', result, at, code: problem.reason, message, ...detail }
}

export function createLan(deps: LanDeps): Lan {
  const now = deps.now ?? Date.now
  const listeners = new Set<() => void>()
  let snap: LanSnapshot = INITIAL
  let inflight: { refresh: boolean; done: Promise<void>; controller: AbortController } | null = null
  /** Bumped by close(): a Refresh queued behind a look that close() dropped never runs. */
  let generation = 0

  function set(next: Partial<LanSnapshot>) {
    // A new state replaces the last one's words: they never outlive the state they explain.
    const base: LanSnapshot =
      'state' in next
        ? { state: snap.state, result: snap.result, busy: snap.busy, at: snap.at }
        : snap
    snap = { ...base, ...next }
    for (const listener of listeners) listener()
  }

  /** Back to rest after a look that won't answer: the first look's skeleton goes too. */
  const idle = () => {
    set({ busy: false, ...(snap.state === 'looking' ? { state: 'idle' as const } : {}) })
  }

  function look(refresh: boolean): Promise<void> {
    // A Refresh while a look runs waits for it, then looks again; never two at once.
    if (inflight) {
      if (!refresh || inflight.refresh) return inflight.done
      const ran = generation
      return inflight.done.then(() => (generation === ran ? look(true) : undefined))
    }
    const controller = new AbortController()
    set({ busy: true, ...(snap.state === 'idle' ? { state: 'looking' as const } : {}) })
    const done = deps.connection.lanDevices(refresh, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) set({ ...settled(result, now()), busy: false })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        // Aborted by something else (the connection stopping): nothing to say, nothing busy.
        if (isAbortError(error)) idle()
        else set({ ...failure(error), at: now(), busy: false })
      },
    )
    const mine = { refresh, done, controller }
    inflight = mine
    return done.finally(() => {
      if (inflight === mine) inflight = null
    })
  }

  return {
    getSnapshot: () => snap,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    open() {
      if (inflight) return
      // Answered moments ago (a quick close and reopen): the answer stands.
      const answered = snap.state === 'ok' || snap.state === 'blocked'
      if (answered && snap.at !== null && now() - snap.at < LAN_FRESH) return
      void look(false)
    },

    refresh: () => look(true),

    close() {
      generation++
      if (!inflight) return
      inflight.controller.abort()
      inflight = null
      idle()
    },
  }
}

/** How a look ended, in one sentence for the live region; `blocked`: the card's sentence. */
export function lanAnnouncement(snapshot: LanSnapshot, blocked = ''): string {
  switch (snapshot.state) {
    case 'blocked':
      return blocked
    case 'failed':
      return snapshot.message || LAN_COPY.state.unavailable
    case 'ok':
      return LAN_COPY.state.found(snapshot.result?.devices.length ?? 0)
    default:
      return ''
  }
}

const LINK_LOCAL = /^169\.254\./

/**
 * The devices to list, one row each. A Mac or an iPhone on a cable (or a Thunderbolt bridge) also
 * answers on a link-local address, 169.254/16, under the same name: that row repeats its Wi‑Fi
 * one and is left out. A device known only there stays.
 */
export function shownDevices(devices: readonly LanDevice[]): readonly LanDevice[] {
  const known = new Set<string>()
  for (const d of devices) {
    if (LINK_LOCAL.test(d.address)) continue
    for (const host of d.hostnames) known.add(host.toLowerCase())
    for (const name of d.names) known.add(name.text.toLowerCase())
  }
  if (known.size === 0) return devices
  return devices.filter(
    (d) =>
      !LINK_LOCAL.test(d.address) ||
      !(
        d.hostnames.some((host) => known.has(host.toLowerCase())) ||
        d.names.some((name) => known.has(name.text.toLowerCase()))
      ),
  )
}

/** A network as people write it: its own address and prefix → '192.168.68.0/24'. */
export function networkName(network: Pick<LanNetwork, 'address' | 'prefix'>): string {
  const [a = 0, b = 0, c = 0, d = 0] = network.address.split('.').map(Number)
  const mask = network.prefix === 0 ? 0 : (0xffffffff << (32 - network.prefix)) >>> 0
  const base = (((a << 24) | (b << 16) | (c << 8) | d) & mask) >>> 0
  const parts = [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255]
  return `${parts.join('.')}/${String(network.prefix)}`
}

/** A line under the list: what it could not use on this computer, and the fix if there is one. */
export interface LanNote {
  readonly text: string
  readonly command?: string
}

/** What this list couldn't use here (`platform`: the helper's, as health says it). */
export function lanNotes(result: LanResult, platform: string): LanNote[] {
  const words = LAN_COPY.footer
  const notes: LanNote[] = []
  if (platform.startsWith('darwin') && result.sources.neighbors !== 'ok') {
    notes.push({ text: words.makersHidden(result.devices.some((d) => d.maker !== undefined)) })
  }
  if (platform.startsWith('linux') && result.sources.resolver === 'none') {
    notes.push({ text: words.avahi, command: words.avahiCommand })
  }
  // Without the presence check (Windows) no network was swept: nothing partial to say.
  if (result.sources.presence !== 'off') {
    for (const network of result.networks) {
      // §3: `size` is the subnet's host-address count (2^(32−prefix)−2) and `scanned` is the
      // addresses the helper probed, this computer's own included, so the two are equal on a
      // fully swept /24. §2.2 trims the sweep in only two ways — a prefix shorter than /24 is
      // swept across just the /24 that holds this computer, and an interface past the target
      // budget is not swept at all (`scanned` 0). Flag those, and only those: an ordinary /24
      // says nothing, whatever off-by-one a parallel helper's own counting might carry.
      const partial =
        network.scanned < network.size && (network.prefix < 24 || network.scanned === 0)
      if (partial) {
        notes.push({ text: words.partial(networkName(network), network.scanned, network.size) })
      }
    }
  }
  if (result.truncated) notes.push({ text: words.truncated(result.devices.length) })
  return notes
}

/* ---------------------------------------------------------------- *
 * What each device offers
 * ---------------------------------------------------------------- */

/** What a device on this network offers in Device Lab, if anything. */
export type LanAction =
  /** It is in the device list already: select it there. */
  | { readonly kind: 'show'; readonly id: string }
  /** It advertises debugging ("On this network"): its Connect or Pair…. */
  | { readonly kind: 'nearby'; readonly row: NearbyRow }
  /** An Android TV or phone that doesn't advertise debugging yet: the Wi‑Fi dialog, filled in. */
  | { readonly kind: 'wifi'; readonly row: NearbyRow }
  /** An iPhone or iPad: how to bring it in (a cable once, or the helper's --wifi). */
  | { readonly kind: 'iphone' }

/** The listed device this one is: by its Wi‑Fi address, or by the adb name it advertises. */
function listedIdOf(device: LanDevice, listed: readonly ListedDevice[]): string | null {
  const byAddress = listed.find(
    (l) => l.connection === 'network' && targetOfSerial(l.id)?.host === device.address,
  )
  if (byAddress) return byAddress.id
  for (const service of device.services) {
    const instance = service.name ?? ''
    if (!instance || !service.type.toLowerCase().startsWith('_adb')) continue
    const serial = serialOfInstance(instance)
    // adb lists an mDNS connection as "<instance>._adb-tls-connect._tcp", a cable by serial.
    const hit = listed.find((l) => l.id.startsWith(`${instance}.`) || (serial && l.id === serial))
    if (hit) return hit.id
  }
  return null
}

/** The Wi‑Fi dialog's fields for it: a TV's address and 5555, a phone's pairing address. */
function wifiRow(device: LanDevice, view: Pick<LanView, 'kind' | 'name'>): NearbyRow {
  const key = `lan:${device.address}`
  if (view.kind === 'tv') {
    const target = { host: device.address, port: DEFAULT_ADB_PORT }
    return {
      key,
      name: view.name,
      address: addressOf(target),
      kind: 'adb',
      tv: true,
      pairingOpen: false,
      action: { kind: 'connect', target },
    }
  }
  return {
    key,
    name: view.name,
    address: device.address,
    kind: 'wireless',
    tv: false,
    pairingOpen: false,
    action: { kind: 'pair', host: device.address, pair: null, connect: null },
  }
}

/** What Device Lab takes over Wi‑Fi from Android: TVs, phones and tablets. */
const WIFI_KINDS: ReadonlySet<LanView['kind']> = new Set(['phone', 'tablet', 'tv'])

/**
 * The one action for a device: Show when it is listed already, else its "On this network" row
 * (`nearby`: nearbyRows' output, joined by address), else Connect over Wi‑Fi… for an Android
 * TV or phone, else the note for an iPhone or iPad.
 */
export function lanAction(
  device: LanDevice,
  view: Pick<LanView, 'kind' | 'name' | 'os'>,
  nearby: readonly NearbyRow[],
  listed: readonly ListedDevice[],
): LanAction | null {
  if (device.self) return null
  const id = listedIdOf(device, listed)
  if (id !== null) return { kind: 'show', id }
  const row = nearby.find(
    (r) => (r.action.kind === 'connect' ? r.action.target.host : r.action.host) === device.address,
  )
  if (row) return { kind: 'nearby', row }
  if (view.os === 'android' && WIFI_KINDS.has(view.kind)) {
    return { kind: 'wifi', row: wifiRow(device, view) }
  }
  if (view.os === 'ios' && (view.kind === 'phone' || view.kind === 'tablet'))
    return { kind: 'iphone' }
  return null
}
