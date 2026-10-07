// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { HEALTH, IPHONE_ROW, REPORT, helperStatus } from './components/helper-status.fixture'
import type { Backend } from './backends/backend'
import { DeviceLabPage, installRefusal, keepListed, slowCapture, withOpen } from './device-lab-page'
import type * as ConnectionModule from './helper/connection'
import type * as EnvModule from './preflight/env'
import type { HelperConnection, HelperStatus } from './helper/connection'
import type { HelperDevice, LanDevice, LanResult } from './helper/protocol'
import { normalizeDevice } from './model'

/*
  The page's own HelperConnection is replaced by one the test drives: its status and its rows
  change on command, and every call is recorded. The connection itself, against the real built
  helper, is helper/real-helper.test.ts's subject.
*/
const fake = vi.hoisted(() => {
  const state: {
    status: HelperStatus | null
    devices: readonly HelperDevice[]
    statusListeners: Set<() => void>
    deviceListeners: Set<() => void>
  } = { status: null, devices: [], statusListeners: new Set(), deviceListeners: new Set() }
  return { state }
})

/** A look that found nothing, as a helper with nothing on its network answers. */
const LAN_NONE: LanResult = {
  devices: [],
  networks: [],
  sources: { presence: 'ok', neighbors: 'hidden', resolver: 'dns-sd', ssdp: 'ok' },
  scannedAt: 1,
  durationMs: 0,
}

const calls = {
  connect: vi.fn(),
  forget: vi.fn(),
  pair: vi.fn<HelperConnection['pair']>(() => Promise.resolve({ ok: true })),
  doctor: vi.fn<HelperConnection['doctor']>(() => Promise.resolve(REPORT)),
  screenshot: vi.fn<HelperConnection['api']['screenshot']>(() => new Promise(() => undefined)),
  connectNetwork: vi.fn<HelperConnection['connectNetwork']>(() => new Promise(() => undefined)),
  pairNetwork: vi.fn<HelperConnection['pairNetwork']>(() => new Promise(() => undefined)),
  disconnectNetwork: vi.fn<HelperConnection['disconnectNetwork']>(
    () => new Promise(() => undefined),
  ),
  nearby: vi.fn<HelperConnection['nearby']>(() => Promise.resolve({ devices: [], scannedAt: 1 })),
  lanDevices: vi.fn<HelperConnection['lanDevices']>(() => Promise.resolve(LAN_NONE)),
}

function setHelper(status: HelperStatus, devices: readonly HelperDevice[] = fake.state.devices) {
  act(() => {
    fake.state.status = status
    fake.state.devices = devices
    for (const listener of fake.state.statusListeners) listener()
    for (const listener of fake.state.deviceListeners) listener()
  })
}

function fakeConnection(): HelperConnection {
  const subscribe = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
  return {
    // Stable between calls, as useSyncExternalStore needs.
    getStatus: () => (fake.state.status ??= helperStatus('off')),
    subscribeStatus: subscribe(fake.state.statusListeners),
    getDevices: () => fake.state.devices,
    subscribeDevices: subscribe(fake.state.deviceListeners),
    start: () => undefined,
    stop: () => undefined,
    connect: calls.connect,
    pair: calls.pair,
    forget: calls.forget,
    setRemember: () => undefined,
    rescan: () => Promise.resolve(),
    pollNow: () => undefined,
    doctor: calls.doctor,
    startAdb: () => Promise.resolve(),
    connectNetwork: calls.connectNetwork,
    pairNetwork: calls.pairNetwork,
    disconnectNetwork: calls.disconnectNetwork,
    nearby: calls.nearby,
    lanDevices: calls.lanDevices,
    api: {
      detail: () => new Promise(() => undefined),
      screenshot: calls.screenshot,
      capture: () => new Promise(() => undefined),
      retry: () => Promise.resolve(null),
      logs: () => Promise.resolve(),
      adbInfo: () => new Promise(() => undefined),
      openAdb: () => new Promise(() => undefined),
    },
  }
}

vi.mock('./helper/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  createHelperConnection: () => fakeConnection(),
}))

// The published helper file, read once the helper is connected: never the network in a test.
const readPublished = vi.hoisted(() =>
  vi.fn<() => Promise<{ version: string; sha256: string } | null>>(() => Promise.resolve(null)),
)
vi.mock('./preflight/env', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  readPublishedHelper: readPublished,
}))

const APK = new File(['PK'], 'shop.apk', { type: 'application/vnd.android.package-archive' })

describe('keepListed', () => {
  const installs = {
    PIXEL: { files: [APK], open: true },
    GALAXY: { files: null, open: false },
  }

  it('forgets the dialog of a device that left the list, so a replug opens nothing', () => {
    const kept = keepListed(installs, [{ id: 'GALAXY' }])
    expect(kept).toEqual({ GALAXY: { files: null, open: false } })
    // Plugged back in under the same id: still nothing to mount.
    expect(keepListed(kept, [{ id: 'PIXEL' }, { id: 'GALAXY' }]).PIXEL).toBeUndefined()
  })

  it('returns the same object when every device is still listed', () => {
    expect(keepListed(installs, [{ id: 'PIXEL' }, { id: 'GALAXY' }, { id: 'OTHER' }])).toBe(
      installs,
    )
  })
})

describe('installRefusal', () => {
  const tv = normalizeDevice({
    id: '192.168.1.42:5555',
    backend: 'agent',
    platform: 'android',
    connection: 'network',
    state: 'ready',
    name: 'BRAVIA 4K UR3',
  })
  const facts = { sdk: 29, release: '10', manufacturer: 'Sony', brand: 'Sony', abis: ['armeabi-v7a'] }
  const lane = { install: () => Promise.reject(new Error('unused')) } as unknown as Backend

  it('lets a Wi‑Fi device install through the helper’s adb tunnel', () => {
    const ready = { ...tv, android: facts, capabilities: { install: true, apps: true } }
    expect(installRefusal(ready, lane, 'ready')).toBeNull()
  })

  it('says a helper from before the tunnel needs updating', () => {
    expect(installRefusal(tv, lane, 'older')).toBe(
      'This helper can’t open apps, images or installs on this device. Download it again; the command replaces it.',
    )
  })

  it('waits for the device’s API level rather than calling it too old', () => {
    expect(installRefusal(tv, lane, 'ready')).toBe(
      'BRAVIA 4K UR3 isn’t ready. Fix what its card says, then try again.',
    )
    expect(installRefusal({ ...tv, android: { ...facts, sdk: 23 } }, lane, 'ready')).toBe(
      'Installing needs Android 7.0 or newer.',
    )
  })

  it('still refuses a lane that can’t install', () => {
    expect(installRefusal({ ...tv, connection: 'usb' }, undefined)).toBe(
      'This connection can’t install apps.',
    )
  })
})

describe('withOpen', () => {
  it('keeps the files that are there now, not the ones of an older render', () => {
    const newer = [new File(['PK'], 'other.apk')]
    // The toast's Show, from the render where the first install started, after B was dropped.
    const now = { PIXEL: { files: newer, open: true } }
    expect(withOpen(now, 'PIXEL', true).PIXEL).toEqual({ files: newer, open: true })
    expect(withOpen(now, 'PIXEL', false).PIXEL).toEqual({ files: newer, open: false })
  })

  it('opens a forgotten device’s dialog with no files, and leaves it forgotten when closing', () => {
    expect(withOpen({}, 'PIXEL', true)).toEqual({ PIXEL: { files: null, open: true } })
    const none = {}
    expect(withOpen(none, 'PIXEL', false)).toBe(none)
  })
})

/** A file drag event as Chrome sends it: `types` says Files, the files come with the drop. */
function fileDrag(type: 'dragover' | 'drop', files: File[] = [APK]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const data = {
    types: ['Files'],
    files,
    items: [],
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return event
}

describe('DeviceLabPage, files dropped outside the drop zone', () => {
  beforeAll(() => {
    // jsdom has no matchMedia; the theme toggle asks it for the system's dark mode.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    // Sonner's toasts outlive the Toaster: a later test must not see this one's.
    act(() => {
      toast.dismiss()
    })
    cleanup()
  })

  it('stops the browser’s own file drop on the header, and says why it can’t install', async () => {
    render(<DeviceLabPage />)
    const header = document.querySelector('header')
    expect(header).toBeTruthy()

    const over = fileDrag('dragover')
    header?.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)

    // No ready Android phone is selected (no WebUSB, no mock lane): the existing refusal.
    const drop = fileDrag('drop')
    act(() => {
      header?.dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(await screen.findByText('Can’t install here')).toBeTruthy()
    expect(screen.getByText('Select a ready Android phone first, then drop the file again.'))
  })

  it('leaves a drag of text alone', () => {
    render(<DeviceLabPage />)
    const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'] } })
    document.querySelector('header')?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('handles a drop on the zone once, through the zone', () => {
    const error = vi.spyOn(toast, 'error')
    try {
      render(<DeviceLabPage />)
      const drop = fileDrag('drop')
      act(() => {
        document.querySelector('main')?.dispatchEvent(drop)
      })
      expect(drop.defaultPrevented).toBe(true)
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith('Can’t install here', expect.anything())
    } finally {
      error.mockRestore()
    }
  })

  it('takes a drop on the header to the selected phone, as the zone would', async () => {
    window.history.replaceState(null, '', '/device/?mock=1')
    try {
      render(<DeviceLabPage />)
      act(() => {
        screen.getByRole('button', { name: /Pixel 9/ }).click()
      })
      act(() => {
        document.querySelector('header')?.dispatchEvent(fileDrag('drop'))
      })
      expect(await screen.findByRole('dialog')).toBeTruthy()
      expect(screen.queryByText('Can’t install here')).toBeNull()
    } finally {
      window.history.replaceState(null, '', '/device/')
    }
  })

  it('stops catching drops once the page is gone', () => {
    const { unmount } = render(<DeviceLabPage />)
    unmount()
    const over = fileDrag('dragover')
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
  })
})

describe('slowCapture', () => {
  it('is only for real iPhones through the helper', () => {
    expect(slowCapture({ platform: 'ios', backend: 'agent', connection: 'usb' })).toBe(true)
    expect(slowCapture({ platform: 'ios', backend: 'agent', connection: 'network' })).toBe(true)
    expect(slowCapture({ platform: 'ios', backend: 'agent', connection: 'simulator' })).toBe(false)
    expect(slowCapture({ platform: 'ios', backend: 'mock', connection: 'usb' })).toBe(false)
    expect(slowCapture({ platform: 'android', backend: 'agent', connection: 'usb' })).toBe(false)
  })
})

describe('DeviceLabPage, with the local helper', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    // Radix's Switch measures itself; jsdom has no ResizeObserver.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    cleanup()
    vi.useRealTimers()
    fake.state.status = null
    fake.state.devices = []
    for (const fn of Object.values(calls)) fn.mockClear()
    readPublished.mockReset()
    readPublished.mockImplementation(() => Promise.resolve(null))
  })

  const live = () => screen.getAllByRole('status').find((el) => el.getAttribute('aria-live'))

  /** Renders the page and waits for its lanes to start, which the live region says. */
  async function renderPage() {
    render(<DeviceLabPage />)
    await waitFor(() => {
      expect(live()).toHaveTextContent('Device Lab ready.')
    })
  }

  it('puts the helper’s chip in the header, which connects on a click', async () => {
    await renderPage()
    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    if (!header) return
    expect(within(header).queryByText('Helper not detected')).toBeNull()
    act(() => {
      within(header).getByRole('button', { name: 'Connect helper: Connect helper' }).click()
    })
    expect(calls.connect).toHaveBeenCalledTimes(1)
    // The Gate's iPhone side is the helper's.
    act(() => {
      screen.getByRole('radio', { name: /iPhone & iPad/ }).click()
    })
    expect(screen.getByText('Needs the helper')).toBeInTheDocument()
    window.localStorage.removeItem('dvc_prefs')
  })

  it('remembers the Gate’s platform for the next visit, and opens on it', async () => {
    window.localStorage.setItem('dvc_prefs', JSON.stringify({ gatePlatform: 'ios' }))
    try {
      await renderPage()
      expect(screen.getByRole('radio', { name: /iPhone & iPad/ })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      expect(
        screen.getByRole('heading', { level: 2, name: 'Set up iPhone through the helper' }),
      ).toBeTruthy()
      act(() => {
        screen.getByRole('radio', { name: /Android/ }).click()
      })
      expect(
        screen.getByRole('heading', { level: 2, name: 'Set up Android over USB' }),
      ).toBeTruthy()
      expect(JSON.parse(window.localStorage.getItem('dvc_prefs') ?? '{}')).toEqual({
        gatePlatform: 'android',
      })
    } finally {
      window.localStorage.removeItem('dvc_prefs')
    }
  })

  it('lists the helper’s iPhone, says it connected once, and asks for its tools', async () => {
    await renderPage()
    setHelper(helperStatus('checking'))
    setHelper(helperStatus('connected'), [IPHONE_ROW])
    expect(await screen.findByRole('button', { name: /Ngọc’s iPhone/ })).toBeTruthy()
    expect(live()).toHaveTextContent('Local helper connected.')
    expect(
      screen.getByRole('button', { name: '1/1 ready via helper: open the Environment check' }),
    ).toBeTruthy()
    // Nothing to fix about the helper, so no strip above the list.
    expect(screen.queryByRole('region', { name: 'Local helper' })).toBeNull()
  })

  it('says how a look the tester asked for ended, and nothing for one the browser made', async () => {
    await renderPage()
    // Firefox looks on load, with no Connect click: nobody asked, so nothing is said.
    setHelper(helperStatus('checking', { intent: false }))
    setHelper(helperStatus('absent', { intent: false }))
    expect(live()).not.toHaveTextContent('Local helper not found.')
    // Connect clicked: the button stays put while the page looks, so the answer is said.
    setHelper(helperStatus('checking'))
    setHelper(helperStatus('absent'))
    expect(live()).toHaveTextContent('Local helper not found. Is it running?')
  })

  it('shows the checklist on the Gate once connected, with this Mac’s tools', async () => {
    await renderPage()
    setHelper(helperStatus('connected'), [])
    // The visit opened on Android (no helper then), and a helper coming up mid-visit doesn't
    // move it: the tester chooses the iPhone side.
    expect(screen.getByRole('radio', { name: /Android/ })).toHaveAttribute('aria-checked', 'true')
    act(() => {
      screen.getByRole('radio', { name: /iPhone & iPad/ }).click()
    })
    expect(await screen.findByText('Get Xcode from the App Store')).toBeTruthy()
    expect(calls.doctor).toHaveBeenCalled()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up iPhone through the helper' }),
    ).toBeTruthy()
    expect(screen.getByText('Ready for iPhones')).toBeInTheDocument()
  })

  it('says when the helper stopped: live region, toast, and a strip above the list', async () => {
    window.history.replaceState(null, '', '/device/?mock=1')
    try {
      await renderPage()
      setHelper(helperStatus('connected'), [IPHONE_ROW])
      setHelper(helperStatus('lost'), [])
      expect(await screen.findByText('Local helper stopped')).toBeTruthy()
      expect(live()).toHaveTextContent('Local helper stopped.')
      expect(screen.getByRole('region', { name: 'Local helper' })).toHaveTextContent(
        'The helper stopped at 14:05. Start it again; this page reconnects by itself.',
      )
      // Back again: the toast goes.
      setHelper(helperStatus('connected'), [IPHONE_ROW])
      expect(live()).toHaveTextContent('Local helper connected.')
    } finally {
      window.history.replaceState(null, '', '/device/')
    }
  })

  it('pairs from the chip through the pair dialog', async () => {
    await renderPage()
    setHelper(helperStatus('unpaired'))
    act(() => {
      screen.getByRole('button', { name: 'Pair this page: Pair…' }).click()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Pair this page with the helper' })
    const input = within(dialog).getByLabelText('Token or link')
    act(() => {
      fireEvent.change(input, { target: { value: 'Qx7-' + 'a'.repeat(39) } })
    })
    act(() => {
      within(dialog).getByRole('button', { name: 'Pair' }).click()
    })
    await waitFor(() => {
      expect(calls.pair).toHaveBeenCalledWith('Qx7-' + 'a'.repeat(39), false)
    })
  })

  it('lists the helper in the Environment check, and forgets the pairing from there', async () => {
    await renderPage()
    setHelper(helperStatus('connected'), [IPHONE_ROW])
    act(() => {
      screen.getByRole('button', { name: 'Environment check' }).click()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Environment check' })
    expect(within(dialog).getByText('Fingerprint')).toBeInTheDocument()
    expect(await within(dialog).findByText('This Mac')).toBeInTheDocument()
    expect(within(dialog).getByText('Ngọc’s iPhone: Trust')).toBeInTheDocument()
    act(() => {
      within(dialog).getByRole('button', { name: 'Forget pairing' }).click()
    })
    expect(calls.forget).toHaveBeenCalledTimes(1)
  })

  /** A helper new enough for Wi‑Fi, and the TV it connected. */
  const WIFI_HELPER = helperStatus('connected', {
    health: { ...HEALTH, features: ['android.start-server', 'android.connect'] },
  })
  const TV_ROW: HelperDevice = {
    id: '192.168.1.42:5555',
    platform: 'android',
    connection: 'network',
    state: 'ready',
    name: 'Living Room TV',
    model: 'SHIELD Android TV',
    modelId: 'mdarcy',
    osVersion: '11',
    blockers: [],
    capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
  }

  it('connects a TV over Wi‑Fi from the Gate, through the helper', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [])
    // Wi‑Fi is Android's: on the iPhone side it isn't shown.
    act(() => {
      screen.getByRole('radio', { name: /iPhone & iPad/ }).click()
    })
    expect(screen.queryByRole('button', { name: 'Network device (Wi‑Fi)…' })).toBeNull()
    act(() => {
      screen.getByRole('radio', { name: /Android/ }).click()
    })
    act(() => {
      screen.getByRole('button', { name: 'Network device (Wi‑Fi)…' }).click()
    })
    window.localStorage.removeItem('dvc_prefs')
    const dialog = await screen.findByRole('dialog', { name: 'Connect over Wi‑Fi' })
    act(() => {
      fireEvent.change(within(dialog).getByLabelText('IP address'), {
        target: { value: '192.168.1.42' },
      })
    })
    act(() => {
      within(dialog).getByRole('button', { name: 'Connect' }).click()
    })
    expect(calls.connectNetwork).toHaveBeenCalledWith({ host: '192.168.1.42', port: 5555 })
    expect(within(dialog).getByRole('button', { name: 'Connecting…' })).toBeInTheDocument()
  })

  it('a Wi‑Fi TV through a helper from before the adb tunnel: says to update it, offers Disconnect', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    act(() => {
      screen.getByRole('button', { name: /Living Room TV/ }).click()
    })
    const pane = screen.getByRole('region', { name: 'Device detail' })
    expect(pane).toHaveTextContent(
      'Your helper is older than this page: it can’t list apps, show images or install apps on this device yet.',
    )
    expect(pane).toHaveTextContent('curl -fsSL')
    expect(within(pane).queryByRole('tab', { name: /Apps/ })).toBeNull()
    const install = within(pane).getByRole('button', { name: /Install app/ })
    expect(install).toBeDisabled()
    expect(install).toHaveAttribute(
      'title',
      'This helper can’t open apps, images or installs on this device. Download it again; the command replaces it.',
    )
    act(() => {
      within(pane).getByRole('button', { name: 'Disconnect' }).click()
    })
    expect(calls.disconnectNetwork).toHaveBeenCalledWith('192.168.1.42:5555')
  })

  it('a Wi‑Fi TV through a helper with the adb tunnel: Apps, Images and Install app', async () => {
    await renderPage()
    setHelper(
      helperStatus('connected', {
        health: { ...HEALTH, features: ['android.start-server', 'android.connect', 'android.adb'] },
      }),
      [TV_ROW],
    )
    act(() => {
      screen.getByRole('button', { name: /Living Room TV/ }).click()
    })
    const pane = screen.getByRole('region', { name: 'Device detail' })
    expect(within(pane).getByRole('tab', { name: /Apps/ })).toBeInTheDocument()
    expect(within(pane).getByRole('tab', { name: /Images/ })).toBeInTheDocument()
    expect(pane).not.toHaveTextContent('Your helper is older than this page')
    expect(pane).not.toHaveTextContent('later version')
    // Its API level is still being read through the tunnel, so not installable yet.
    expect(within(pane).getByRole('button', { name: /Install app/ })).toHaveAttribute(
      'title',
      'Living Room TV isn’t ready. Fix what its card says, then try again.',
    )
  })

  it('no Disconnect for a phone adb found by itself (mDNS): adb disconnect can’t drop it', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [
      { ...TV_ROW, id: 'adb-55090DLAQ0026D-vWgJpq._adb-tls-connect._tcp', name: 'Pixel 9' },
    ])
    act(() => {
      screen.getByRole('button', { name: /Pixel 9/ }).click()
    })
    const pane = screen.getByRole('region', { name: 'Device detail' })
    expect(within(pane).getByRole('button', { name: /Install app/ })).toBeInTheDocument()
    expect(within(pane).queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  const DISCOVER_HELPER = helperStatus('connected', {
    health: {
      ...HEALTH,
      features: ['android.start-server', 'android.connect', 'android.discover'],
    },
  })
  const nearbyReply = (devices: Record<string, unknown>[]) => {
    calls.nearby.mockImplementation(() =>
      Promise.resolve({
        scannedAt: 1,
        devices: devices.map((d) => ({
          instance: '',
          serial: '',
          name: '',
          model: '',
          tv: false,
          connected: false,
          deviceId: null,
          paired: false,
          ...d,
        })) as never,
      }),
    )
  }
  const BRAVIA = {
    id: 'adb:192.168.68.101:5555',
    kind: 'adb',
    host: '192.168.68.101',
    port: 5555,
    serial: 'b120be004010859',
    name: 'SONY KD-43X8050H',
    tv: true,
  }

  it('lists what is on the network under the devices, and connects one only on its click', async () => {
    nearbyReply([BRAVIA])
    await renderPage()
    setHelper(DISCOVER_HELPER, [TV_ROW])
    const section = await screen.findByRole('region', { name: 'On this network' })
    await waitFor(() => {
      expect(section).toHaveTextContent('SONY KD-43X8050H')
    })
    expect(section).toHaveTextContent('192.168.68.101:5555')
    expect(calls.nearby).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    // Listing is only looking.
    expect(calls.connectNetwork).not.toHaveBeenCalled()
    act(() => {
      within(section)
        .getByRole('button', { name: /^Connect SONY KD-43X8050H/ })
        .click()
    })
    expect(calls.connectNetwork).toHaveBeenCalledOnce()
    expect(calls.connectNetwork).toHaveBeenCalledWith({ host: '192.168.68.101', port: 5555 })
    // The Wi‑Fi dialog shows it connecting, filled in with that device.
    const dialog = await screen.findByRole('dialog', { name: 'Connect over Wi‑Fi' })
    expect(within(dialog).getByLabelText<HTMLInputElement>('IP address').value).toBe(
      '192.168.68.101',
    )
    expect(within(dialog).getByRole('list', { name: 'Progress' })).toHaveTextContent(
      'Connecting to 192.168.68.101:5555…',
    )
  })

  it('leaves out what is listed already, and opens pairing filled in for a phone', async () => {
    nearbyReply([
      { ...BRAVIA, host: '192.168.1.42', id: 'adb:192.168.1.42:5555' },
      {
        id: 'wireless:192.168.68.114:39601',
        kind: 'wireless',
        host: '192.168.68.114',
        port: 39601,
        instance: 'adb-55090DLAQ0026D-nK25Qn',
        serial: '55090DLAQ0026D',
      },
    ])
    await renderPage()
    setHelper(DISCOVER_HELPER, [TV_ROW])
    const section = await screen.findByRole('region', { name: 'On this network' })
    await waitFor(() => {
      expect(section).toHaveTextContent('55090DLAQ0026D')
    })
    // The TV at 192.168.1.42:5555 is the listed Living Room TV.
    expect(section).not.toHaveTextContent('SONY KD-43X8050H')
    act(() => {
      within(section)
        .getByRole('button', { name: /^Pair 55090DLAQ0026D/ })
        .click()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Connect over Wi‑Fi' })
    expect(within(dialog).getByLabelText<HTMLInputElement>('IP address & port').value).toBe(
      '192.168.68.114',
    )
    expect(within(dialog).getByLabelText<HTMLInputElement>('Port').value).toBe('39601')
    expect(calls.pairNetwork).not.toHaveBeenCalled()
    expect(calls.connectNetwork).not.toHaveBeenCalled()
  })

  it('with nothing plugged in, the Gate lists what is on the network once the helper can look', async () => {
    nearbyReply([BRAVIA])
    await renderPage()
    expect(screen.queryByRole('region', { name: 'On this network' })).toBeNull()
    setHelper(DISCOVER_HELPER, [])
    const section = await screen.findByRole('region', { name: 'On this network' })
    await waitFor(() => {
      expect(section).toHaveTextContent('SONY KD-43X8050H')
    })
  })

  /** The update notice's command, in a section. */
  const command = (section: HTMLElement) => within(section).getByText(/^curl -fsSL /)

  it('a helper older than discovery: says so under the devices, with the command, never asked', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    const section = await screen.findByRole('region', { name: 'On this network' })
    expect(section).toHaveTextContent(
      'Your helper is older than this page: it can’t look for devices on this network yet.',
    )
    expect(command(section)).toHaveTextContent(
      'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
    )
    expect(section).toHaveTextContent('Then reload this page.')
    expect(calls.nearby).not.toHaveBeenCalled()
  })

  it('…and in the Gate’s Wi‑Fi part when nothing is plugged in (the owner’s case)', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [])
    act(() => {
      screen.getByRole('radio', { name: /Android/ }).click()
    })
    const wifi = screen.getByRole('region', { name: /Phone or TV on Wi‑Fi\?/ })
    const section = within(wifi).getByRole('region', { name: 'On this network' })
    expect(section).toHaveTextContent('Update the helper')
    expect(command(section)).toBeInTheDocument()
    expect(calls.nearby).not.toHaveBeenCalled()
    // The same helper, updated: the list instead, and no notice.
    nearbyReply([BRAVIA])
    setHelper(DISCOVER_HELPER, [])
    await waitFor(() => {
      expect(section).toHaveTextContent('SONY KD-43X8050H')
    })
    expect(section).not.toHaveTextContent('older than this page')
  })

  const LAN_HELPER = helperStatus('connected', {
    health: {
      ...HEALTH,
      features: ['android.start-server', 'android.connect', 'android.discover', 'lan.discover'],
    },
  })
  const lanDevice = (address: string, patch: Partial<LanDevice> = {}): LanDevice => ({
    address,
    self: false,
    gateway: false,
    hostnames: [],
    names: [],
    services: [],
    found: ['reply', 'mdns'],
    ...patch,
  })
  /** An Android TV that announces itself, debugging off: Connect over Wi‑Fi…. */
  const LAN_BRAVIA = lanDevice('192.168.68.101', {
    services: [
      { type: '_androidtvremote2._tcp', port: 6466, name: 'SONY KD-43X8050H' },
      { type: '_googlecast._tcp', port: 8009, txt: { fn: 'Bedroom TV', md: 'BRAVIA 4K VH2' } },
    ],
  })
  /** The listed Living Room TV, as the network sees it: Show. */
  const LAN_SHIELD = lanDevice('192.168.1.42', {
    services: [{ type: '_googlecast._tcp', txt: { fn: 'Living Room TV', md: 'SHIELD' } }],
  })
  const lanReply = (devices: LanDevice[]) => {
    calls.lanDevices.mockImplementation(() =>
      Promise.resolve({
        ...LAN_NONE,
        devices,
        networks: [
          { interface: 'en0', address: '192.168.68.113', prefix: 24, size: 254, scanned: 254 },
        ],
      }),
    )
  }
  const chooseScan = () => {
    act(() => {
      screen.getByRole('link', { name: 'Scan Device' }).click()
    })
  }
  const scanList = () => screen.findByRole('region', { name: 'Devices on this network' })

  it('Scan Device lists every device on this network in the page; Connect Device comes back', async () => {
    nearbyReply([])
    lanReply([LAN_BRAVIA, LAN_SHIELD])
    await renderPage()
    setHelper(LAN_HELPER, [TV_ROW])
    // Connect Device first, with the device list; nothing on the network is asked yet.
    expect(screen.getByRole('link', { name: 'Connect Device' })).toHaveAttribute('aria-current', 'page')
    expect(calls.lanDevices).not.toHaveBeenCalled()
    chooseScan()
    const list = await scanList()
    expect(calls.lanDevices).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    await waitFor(() => {
      expect(list).toHaveTextContent('Bedroom TV')
    })
    expect(list).toHaveAccessibleDescription(/^2 devices on 192\.168\.68\.0\/24 · looked /)
    act(() => {
      screen.getByRole('link', { name: 'Connect Device' }).click()
    })
    expect(screen.queryByRole('region', { name: 'Devices on this network' })).toBeNull()
    expect(screen.getByRole('button', { name: /Living Room TV/ })).toBeVisible()
  })

  it('opens on Scan Device when the address says ?view=scan, and tells the route of a change', async () => {
    nearbyReply([])
    lanReply([LAN_BRAVIA])
    const change = vi.fn()
    render(<DeviceLabPage view="scan" onViewChange={change} />)
    await waitFor(() => {
      expect(live()).toHaveTextContent('Device Lab ready.')
    })
    expect(screen.getByRole('link', { name: 'Scan Device' })).toHaveAttribute('aria-current', 'page')
    expect(await scanList()).toBeVisible()
    act(() => {
      screen.getByRole('link', { name: 'Connect Device' }).click()
    })
    expect(change).toHaveBeenCalledWith('connect')
  })

  it('…Connect over Wi‑Fi… opens the Wi‑Fi dialog over the list, filled in; Show goes to the device', async () => {
    // The TV doesn't advertise debugging: nothing "On this network" to connect.
    nearbyReply([])
    lanReply([LAN_BRAVIA, LAN_SHIELD])
    await renderPage()
    setHelper(LAN_HELPER, [TV_ROW])
    chooseScan()
    const list = await scanList()
    const wifiButton = await within(list).findByRole('button', {
      name: 'Connect Bedroom TV (192.168.68.101:5555) over Wi‑Fi…',
    })
    act(() => {
      wifiButton.click()
    })
    const wifi = await screen.findByRole('dialog', { name: 'Connect over Wi‑Fi' })
    expect(within(wifi).getByLabelText<HTMLInputElement>('IP address').value).toBe('192.168.68.101')
    expect(within(wifi).getByLabelText<HTMLInputElement>('Port').value).toBe('5555')
    // Filled in only: connecting is still the tester's click, after turning debugging on.
    expect(calls.connectNetwork).not.toHaveBeenCalled()
    act(() => {
      within(wifi).getAllByRole('button', { name: 'Close' })[0]?.click()
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Connect over Wi‑Fi' })).toBeNull()
    })
    // Back on the list, under the dialog all along. Show goes to Connect Device, that device
    // selected.
    const back = screen.getByRole('region', { name: 'Devices on this network' })
    act(() => {
      within(back).getByRole('button', { name: 'Show Living Room TV in the device list' }).click()
    })
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Devices on this network' })).toBeNull()
    })
    expect(screen.getByRole('link', { name: 'Connect Device' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /Living Room TV/, pressed: true })).toBeVisible()
  })

  it('…a TV advertising debugging gets the same Connect as “On this network”', async () => {
    nearbyReply([BRAVIA])
    lanReply([LAN_BRAVIA])
    await renderPage()
    setHelper(LAN_HELPER, [TV_ROW])
    chooseScan()
    const list = await scanList()
    const connect = await within(list).findByRole('button', {
      name: 'Connect Bedroom TV (192.168.68.101:5555)',
    })
    act(() => {
      connect.click()
    })
    expect(calls.connectNetwork).toHaveBeenCalledOnce()
    expect(calls.connectNetwork).toHaveBeenCalledWith({ host: '192.168.68.101', port: 5555 })
    const wifi = await screen.findByRole('dialog', { name: 'Connect over Wi‑Fi' })
    expect(within(wifi).getByRole('list', { name: 'Progress' })).toHaveTextContent(
      'Connecting to 192.168.68.101:5555…',
    )
  })

  it('…from the Gate too; a helper older than the list says so, and nothing is asked', async () => {
    await renderPage()
    setHelper(DISCOVER_HELPER, [])
    chooseScan()
    const list = await scanList()
    expect(list).toHaveTextContent(
      'Your helper is older than this page: it can’t list every device on this network yet.',
    )
    expect(calls.lanDevices).not.toHaveBeenCalled()
  })

  it('says “update available” on the chip and the notice when a newer helper is published', async () => {
    readPublished.mockImplementation(() =>
      Promise.resolve({ version: '1.1.0', sha256: 'cd'.repeat(32) }),
    )
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    const header = document.querySelector('header')
    if (!header) throw new Error('no header')
    const chip = await within(header).findByRole('button', {
      name: '1/1 ready via helper · update available: open the Environment check',
    })
    expect(chip).toHaveAttribute(
      'title',
      expect.stringMatching(/^Helper 1\.1\.0 is out; this one is 1\.0\.0\./),
    )
    const notice = screen.getByRole('region', { name: 'Local helper' })
    expect(notice).toHaveTextContent(
      'Helper update available. Helper 1.1.0 is out; this one is 1.0.0. Press Ctrl+C in its window, run the command, then reload this page.',
    )
    expect(within(notice).getByRole('button', { name: 'Copy command' })).toHaveAttribute(
      'title',
      expect.stringMatching(/^curl -fsSL /),
    )
    expect(readPublished).toHaveBeenCalledTimes(1)
  })

  it('…above the Gate too, when nothing is plugged in, and nothing else of the strip there', async () => {
    readPublished.mockImplementation(() =>
      Promise.resolve({ version: '1.1.0', sha256: 'cd'.repeat(32) }),
    )
    await renderPage()
    setHelper(WIFI_HELPER, [])
    const notice = await screen.findByRole('region', { name: 'Local helper' })
    expect(notice).toHaveTextContent('Helper update available. Helper 1.1.0 is out')
    expect(screen.getByRole('heading', { level: 1, name: 'Scan or connect a device' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Device' })).toHaveAttribute('aria-current', 'page')
    // The Gate's cards say a stopped helper; the strip doesn't repeat it there.
    setHelper(helperStatus('lost'), [])
    expect(screen.queryByRole('region', { name: 'Local helper' })).toBeNull()
  })

  it('…the same version built again counts (both files said 1.0.0); the same file does not', async () => {
    readPublished.mockImplementation(() =>
      Promise.resolve({ version: '1.0.0', sha256: 'cd'.repeat(32) }),
    )
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    expect(
      await screen.findByText(
        /^Helper update available\. A newer build of helper 1\.0\.0 is out\./,
      ),
    ).toBeInTheDocument()
    cleanup()
    readPublished.mockImplementation(() =>
      Promise.resolve({ version: '1.0.0', sha256: HEALTH.sha256 }),
    )
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    await waitFor(() => {
      expect(readPublished).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByText(/update available/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^1\/1 ready via helper:/ })).toBeInTheDocument()
  })

  it('a log whose device drops says so, and stops once the device leaves the list', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    act(() => {
      screen.getByRole('button', { name: /Living Room TV/ }).click()
    })
    act(() => {
      screen.getByRole('button', { name: 'Start' }).click()
    })
    // The fake's stream ends at once: over Wi‑Fi, that is the link dropping.
    const log = await screen.findByRole('log')
    await waitFor(() => {
      expect(log).toHaveTextContent('Lost the connection to Living Room TV')
    })
    expect(live()).toHaveTextContent(
      'Lost the connection to Living Room TV. Its log picks up again if it comes back within 2 minutes.',
    )
    // Still listed (the helper holds a dropped Wi‑Fi device): the log waits.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    // Gone from the list: nothing is held for it any more, so the log stops and says so.
    setHelper(WIFI_HELPER, [])
    await waitFor(() => {
      expect(live()).toHaveTextContent('Living Room TV left the device list, so its log stopped.')
    })
  })

  it('offers Remember on the hosted page only, never on the helper’s own page', async () => {
    await renderPage()
    setHelper(helperStatus('connected'), [IPHONE_ROW])
    act(() => {
      screen.getByRole('button', { name: 'Environment check' }).click()
    })
    let dialog = await screen.findByRole('dialog', { name: 'Environment check' })
    expect(within(dialog).getByText('Remember on this computer')).toBeInTheDocument()
    const hosted = helperStatus('connected')
    setHelper(
      { ...hosted, env: { ...hosted.env, mode: 'local', apiBase: 'http://127.0.0.1:8787' } },
      [IPHONE_ROW],
    )
    dialog = screen.getByRole('dialog', { name: 'Environment check' })
    expect(within(dialog).queryByText('Remember on this computer')).toBeNull()
  })

  it('says the browser needs no phone of its own while the helper serves one', async () => {
    await renderPage()
    setHelper(WIFI_HELPER, [TV_ROW])
    act(() => {
      screen.getByRole('button', { name: 'Environment check' }).click()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Environment check' })
    expect(dialog).toHaveTextContent(
      'Not needed: Living Room TV is ready through the local helper, which doesn’t use WebUSB.',
    )
    expect(dialog).not.toHaveTextContent('No phone allowed yet')
    expect(within(dialog).getByText('Wi‑Fi devices')).toBeInTheDocument()
  })

  it('doesn’t warn about WebUSB in a session with only the helper’s iPhone', async () => {
    await renderPage()
    setHelper(helperStatus('connected'), [IPHONE_ROW])
    act(() => {
      screen.getByRole('button', { name: 'Environment check' }).click()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Environment check' })
    expect(dialog).toHaveTextContent(
      'Not checked: Ngọc’s iPhone goes through the local helper, which doesn’t use WebUSB.',
    )
    expect(dialog).not.toHaveTextContent('No phone allowed yet')
  })

  it('keeps an all-black screenshot and says the screen was off or locked', async () => {
    // A locked iPhone with its screen off answers with a black PNG; the browser samples it.
    // Set by hand and put back after: unstubAllGlobals would take this file's matchMedia too.
    const before = {
      createImageBitmap: Reflect.get(globalThis, 'createImageBitmap') as unknown,
      OffscreenCanvas: Reflect.get(globalThis, 'OffscreenCanvas') as unknown,
      createObjectURL: Reflect.get(URL, 'createObjectURL') as unknown,
    }
    Reflect.set(globalThis, 'createImageBitmap', () =>
      Promise.resolve({ width: 1170, height: 2532, close: () => undefined }),
    )
    Reflect.set(
      globalThis,
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            drawImage: () => undefined,
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) =>
                i % 4 === 3 ? 255 : 0,
              ),
            }),
          }
        }
      },
    )
    Reflect.set(URL, 'createObjectURL', () => 'blob:shot')
    calls.screenshot.mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }))
    try {
      await renderPage()
      setHelper(helperStatus('connected'), [IPHONE_ROW])
      act(() => {
        screen.getByRole('button', { name: /Ngọc’s iPhone/ }).click()
      })
      act(() => {
        screen.getAllByRole('button', { name: 'Take Screenshot' })[0]?.click()
      })
      expect(
        await screen.findByText(/The screenshot of Ngọc’s iPhone is all black/),
      ).toBeInTheDocument()
      const thumbnail = screen.getByRole('img', {
        name: /Screenshot of Ngọc’s iPhone at .*, all black/,
      })
      expect(thumbnail.closest('li')).toHaveTextContent(
        'All black. The screen was off or locked: wake and unlock the device, then take it again.',
      )
      expect(live()).toHaveTextContent('all black. The screen was off or locked')
    } finally {
      Reflect.set(globalThis, 'createImageBitmap', before.createImageBitmap)
      Reflect.set(globalThis, 'OffscreenCanvas', before.OffscreenCanvas)
      Reflect.set(URL, 'createObjectURL', before.createObjectURL)
    }
  })

  it('says a first iPhone screenshot is still going after 4 seconds', async () => {
    await renderPage()
    setHelper(helperStatus('connected'), [IPHONE_ROW])
    act(() => {
      screen.getByRole('button', { name: /Ngọc’s iPhone/ }).click()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => {
      screen.getAllByRole('button', { name: 'Take Screenshot' })[0]?.click()
    })
    expect(calls.screenshot).toHaveBeenCalledWith(IPHONE_ROW.id)
    expect(screen.queryByText(/Still working/)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(3_999)
    })
    expect(screen.queryByText(/Still working/)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
      // Sonner draws a new toast on its own next tick.
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
    expect(
      await screen.findByText(
        'Still working — the first screenshot of an iPhone can take up to 20 seconds.',
      ),
    ).toBeTruthy()
  })
})

describe('DeviceLabPage, the S, R and / shortcuts', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    window.history.replaceState(null, '', '/device/?mock=1')
  })

  afterAll(() => {
    window.history.replaceState(null, '', '/device/')
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    cleanup()
    vi.restoreAllMocks()
  })

  it('leaves letters to a menu that has focus: there they are its typeahead', async () => {
    render(<DeviceLabPage />)
    act(() => {
      screen.getByRole('button', { name: /Pixel 9/ }).click()
    })
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Apps/ }))
    const more = await screen.findAllByRole(
      'button',
      { name: /^More actions for / },
      { timeout: 4000 },
    )
    fireEvent.keyDown(more[0]!, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    const item = within(menu).getAllByRole('menuitem')[0]!
    item.focus()

    // The Screenshots card's button, the one S presses.
    const shoot = document.querySelector('[aria-keyshortcuts="S"]')
    const filter = screen.getByRole('searchbox', { name: 'Filter devices' })
    const clicks = vi.spyOn(HTMLButtonElement.prototype, 'click')
    for (const key of ['s', 'S', 'r', 'R', '/']) fireEvent.keyDown(item, { key })
    expect(shoot).toHaveAttribute('aria-disabled', 'false')
    expect(clicks).not.toHaveBeenCalled()
    expect(filter).not.toHaveFocus()
    expect(screen.getByRole('menu')).toBe(menu)

    // Outside the menu they are the page's again.
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    fireEvent.keyDown(document.body, { key: 'r' })
    expect(clicks.mock.contexts).toContain(document.querySelector('[data-device-refresh]'))
    fireEvent.keyDown(document.body, { key: 's' })
    expect(shoot).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(document.body, { key: '/' })
    expect(filter).toHaveFocus()
    // Renders the whole page and its Apps tab: slower than the default 5 s on a loaded machine.
  }, 15_000)
})
