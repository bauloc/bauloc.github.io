// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openZip } from '../backends/archive/zip'
import type { AppBadge, AppDetail, AppRow, AppScope } from '../backends/backend'
import { normalizeDevice, type Device } from '../model'
import type * as AppSheetModule from './app-sheet'
import type { AppsLane } from './app-sheet'
import {
  AppsTab,
  cancelExports,
  countText,
  createBadgeQueue,
  emptyCopy,
  neighbourOf,
  rowMeta,
  savedCopy,
  staleOnScreen,
} from './apps-tab'

/** Each row draws one AppAvatar per render: counting them counts the rows' renders. */
const avatarRenders: string[] = []
vi.mock('./app-sheet', async (importOriginal) => {
  const actual = await importOriginal<typeof AppSheetModule>()
  return {
    ...actual,
    AppAvatar: (props: Parameters<typeof actual.AppAvatar>[0]) => {
      avatarRenders.push(props.packageName)
      return actual.AppAvatar(props)
    },
  }
})

afterEach(() => {
  cleanup()
  // Exports outlive the tab; none may run into the next test.
  cancelExports()
  vi.restoreAllMocks()
})

let serial = 0
/** A fresh id per test: the badge cache lives for the module's life. */
const pixel = (): Device =>
  normalizeDevice({
    id: `TEST${String(++serial)}`,
    backend: 'mock',
    state: 'ready',
    name: 'Pixel 9',
    capabilities: {},
  })

const row = (packageName: string, patch: Partial<AppRow> = {}): AppRow => ({
  packageName,
  apkPath: `/data/app/~~x==/${packageName}-y==/base.apk`,
  versionCode: 812,
  installer: 'com.android.vending',
  system: false,
  uids: [10234],
  lastUpdated: Date.UTC(2026, 8, 1),
  firstInstalled: Date.UTC(2026, 0, 1),
  enabled: true,
  stopped: false,
  ...patch,
})

const SHOP = row('com.example.shop', { lastUpdated: Date.UTC(2026, 9, 3) })
const NOTES = row('org.sample.notes', { lastUpdated: Date.UTC(2026, 9, 1), installer: null })
const SETTINGS = row('com.android.settings', { system: true, installer: null })

const detailOf = (r: AppRow): AppDetail => ({
  packageName: r.packageName,
  versionName: '1.4.0',
  versionCode: r.versionCode,
  minSdk: 26,
  targetSdk: 35,
  codePath: '/data/app/~~x==/y',
  dataDir: `/data/user/0/${r.packageName}`,
  splits: ['base', 'config.xxhdpi'],
  installer: r.installer,
  firstInstalled: '2026-01-01 08:00:00',
  lastUpdated: '2026-10-03 09:00:00',
  debuggable: false,
  testOnly: false,
  system: r.system,
  primaryCpuAbi: 'arm64-v8a',
  user0: { installed: true, stopped: false, enabledState: 0 },
  apks: [
    { path: `/data/app/~~x==/${r.packageName}-y==/base.apk`, size: 1000 },
    { path: `/data/app/~~x==/${r.packageName}-y==/split_config.xxhdpi.apk`, size: 200 },
  ],
})

function fakeLane(
  lists: Partial<Record<AppScope, AppRow[]>> = {},
  badges: Record<string, AppBadge> = {},
) {
  const installed: Record<AppScope, AppRow[]> = {
    user: lists.user ?? [SHOP, NOTES],
    system: lists.system ?? [SETTINGS],
    all: lists.all ?? [SHOP, NOTES, SETTINGS],
  }
  const lane = {
    apps: vi.fn((_id: string, scope: AppScope) => Promise.resolve(installed[scope])),
    app: vi.fn((_id: string, pkg: string) => {
      const found = installed.all.find((r) => r.packageName === pkg)
      return found
        ? Promise.resolve(detailOf(found))
        : Promise.reject(new Error('APP_NOT_INSTALLED'))
    }),
    appAction: vi.fn((_id: string, pkg: string, action: string) => {
      if (action === 'uninstall') {
        for (const scope of ['user', 'all'] as const) {
          installed[scope] = installed[scope].filter((r) => r.packageName !== pkg)
        }
      }
      return Promise.resolve()
    }),
    appBadge: vi.fn((_id: string, pkg: string) =>
      Promise.resolve(badges[pkg] ?? { label: null, icon: null }),
    ),
  } satisfies AppsLane
  return lane
}

/**
 * Waits until the badge reads the rows asked for have landed and re-rendered their rows, so the
 * renders a test counts after it are its own. Each answer re-renders its row, outside `act`.
 */
async function badgesLanded(lane: ReturnType<typeof fakeLane>, reads: number) {
  await waitFor(() => {
    expect(lane.appBadge).toHaveBeenCalledTimes(reads)
  })
  await act(async () => {
    await Promise.all(lane.appBadge.mock.results.map((result) => result.value as Promise<AppBadge>))
    // The queue hands an answer on a few microtasks later; a macrotask is past all of them.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const rowNames = () =>
  within(screen.getByRole('list', { name: 'Installed apps' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('button')?.textContent ?? '')

describe('AppsTab', () => {
  it('lists user apps, most recently updated first, with labels read from the APKs', async () => {
    const lane = fakeLane({}, { 'com.example.shop': { label: 'Shop', icon: null } })
    render(<AppsTab device={pixel()} lane={lane} />)

    await screen.findByText('Shop')
    expect(lane.apps).toHaveBeenCalledWith(expect.any(String), 'user')
    expect(screen.getByText('2 apps on Pixel 9')).toBeTruthy()
    const [first, second] = rowNames()
    expect(first).toContain('Shop')
    expect(first).toContain('com.example.shop · 812 · Google Play')
    // No label: the package name stands in, and the installer reads Unknown.
    expect(second).toContain('org.sample.notes')
    expect(second).toContain('Unknown')
    expect(lane.appBadge).toHaveBeenCalledTimes(2)
  })

  it('reads the badge again for an app updated in place while its row stays on screen', async () => {
    const lane = fakeLane({}, { 'com.example.shop': { label: 'Shop', icon: null } })
    const device = pixel()
    const { rerender } = render(<AppsTab device={device} lane={lane} reloadKey={0} />)
    await screen.findByText('Shop')
    expect(lane.appBadge).toHaveBeenCalledTimes(2)

    // A new build of Shop was installed: new version code and update time, so a new badge key.
    const updated = { ...SHOP, versionCode: 813, lastUpdated: Date.UTC(2026, 9, 4) }
    lane.apps.mockImplementation(() => Promise.resolve([updated, NOTES]))
    rerender(<AppsTab device={device} lane={lane} reloadKey={1} />)

    await waitFor(() => {
      expect(lane.appBadge).toHaveBeenCalledTimes(3)
    })
    expect(lane.appBadge).toHaveBeenLastCalledWith(
      device.id,
      'com.example.shop',
      expect.any(AbortSignal),
    )
    expect(await screen.findByText('Shop')).toBeTruthy()
    // Notes did not change: its cached badge is drawn, not read again.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lane.appBadge).toHaveBeenCalledTimes(3)
  })

  it('switches to System and All', async () => {
    const lane = fakeLane()
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('org.sample.notes')

    fireEvent.click(screen.getByRole('radio', { name: 'System' }))
    await screen.findByText('com.android.settings')
    expect(lane.apps).toHaveBeenLastCalledWith(expect.any(String), 'system')
    // The row says System in words, not only by the scope it was listed under.
    expect(rowNames()[0]).toContain('System')

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    await waitFor(() => {
      expect(rowNames()).toHaveLength(3)
    })
  })

  it('filters, and says so when nothing matches', async () => {
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    await screen.findByText('org.sample.notes')
    const box = screen.getByRole('searchbox', { name: 'Filter apps' })

    fireEvent.change(box, { target: { value: 'notes' } })
    expect(rowNames()).toHaveLength(1)
    expect(screen.getByText('1 of 2 apps on Pixel 9')).toBeTruthy()

    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(screen.getByText('Nothing matches “zzz”')).toBeTruthy()
  })

  it('shows the empty state for the scope', async () => {
    render(<AppsTab device={pixel()} lane={fakeLane({ user: [] })} />)
    expect(await screen.findByText(emptyCopy('user').title)).toBeTruthy()
  })

  it('shows a failed read with the phone’s words and a Retry that reads again', async () => {
    const lane = fakeLane()
    lane.apps.mockImplementationOnce(() =>
      Promise.reject(new Error('cmd: Can’t find service: package')),
    )
    render(<AppsTab device={pixel()} lane={lane} />)

    expect(await screen.findByText('Couldn’t read the app list from Pixel 9')).toBeTruthy()
    expect(screen.getByText('cmd: Can’t find service: package')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('org.sample.notes')
    expect(lane.apps).toHaveBeenCalledTimes(2)
  })

  it('says when the lane cannot list apps', () => {
    render(<AppsTab device={pixel()} lane={{}} />)
    expect(screen.getByText('This device can’t list its apps here')).toBeTruthy()
  })

  it('uninstalls only after a confirmation that names the app and the phone', async () => {
    const lane = fakeLane({}, { 'com.example.shop': { label: 'Shop', icon: null } })
    render(<AppsTab device={pixel()} lane={lane} />)
    fireEvent.click(await screen.findByText('Shop'))

    // The sheet reads the details.
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('arm64-v8a')
    expect(within(sheet).getByText('API 26')).toBeTruthy()
    expect(within(sheet).getByText('split_config.xxhdpi.apk')).toBeTruthy()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Uninstall…' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Uninstall Shop from Pixel 9?')).toBeTruthy()
    // Red, not the primary colour (asChild joins a passed bg-* with bg-primary unmerged).
    const action = within(confirm).getByRole('button', { name: 'Uninstall' })
    expect(action.className).toMatch(/\bbg-destructive\b/)
    expect(action.className).not.toMatch(/\bbg-primary\b/)
    expect(
      within(confirm).getByText(/Shop \(com\.example\.shop\) and all of its data/),
    ).toBeTruthy()

    // Cancel does nothing.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(lane.appAction).not.toHaveBeenCalled()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Uninstall…' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(lane.appAction).toHaveBeenCalledWith(expect.any(String), 'com.example.shop', 'uninstall')
    await waitFor(() => {
      expect(rowNames()).toHaveLength(1)
    })
    expect(screen.queryByText('Shop')).toBeNull()
  })

  it('clears data behind its own confirmation, and offers no Uninstall for a system app', async () => {
    const lane = fakeLane()
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(screen.getByRole('radio', { name: 'System' }))
    fireEvent.click(await screen.findByText('com.android.settings'))

    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).queryByRole('button', { name: 'Uninstall…' })).toBeNull()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear data…' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(
      within(confirm).getByText('Clear all data of com.android.settings on Pixel 9?'),
    ).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear data' }))
    await waitFor(() => {
      expect(lane.appAction).toHaveBeenCalledWith(
        expect.any(String),
        'com.android.settings',
        'clear',
      )
    })
  })

  it('runs the plain actions straight from the sheet', async () => {
    const lane = fakeLane()
    const announce = vi.fn()
    render(<AppsTab device={pixel()} lane={lane} onAnnounce={announce} />)
    fireEvent.click(await screen.findByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open' }))
    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('Opened org.sample.notes on Pixel 9.')
    })
    expect(lane.appAction).toHaveBeenCalledWith(expect.any(String), 'org.sample.notes', 'launch')
  })
})

/*
  The way out of the sheet and the confirmation. jsdom runs no animations, so Radix unmounts
  them at once; the fading-out tests give everything with a data-state the `enter` or `exit`
  animation the CSS gives it, and end the exits by hand.
*/
describe('AppsTab: closing the sheet and the confirmation', () => {
  const rowButton = (name: string) => screen.getByText(name).closest('button')

  function fakeExitAnimations() {
    const realStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = realStyle(el, pseudo)
      if (!(el instanceof HTMLElement) || !el.hasAttribute('data-state')) return style
      return new Proxy(style, {
        get(target, key) {
          if (key === 'animationName') return el.dataset.state === 'closed' ? 'exit' : 'enter'
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value
        },
      })
    })
    // Radix's Presence matches the animation that ended by CSS.escape, which jsdom lacks.
    if (typeof globalThis.CSS === 'undefined') vi.stubGlobal('CSS', { escape: (s: string) => s })
    return () => {
      act(() => {
        for (const el of document.querySelectorAll('[data-state="closed"]')) {
          el.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'exit' }))
        }
      })
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fades the confirmation out with its wording, not as an empty box', async () => {
    const finishExits = fakeExitAnimations()
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(within(await openMenu('org.sample.notes')).getByText('Uninstall…'))
    const confirm = await screen.findByRole('alertdialog')
    finishExits() // the menu's

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(confirm.dataset.state).toBe('closed')
    expect(within(confirm).getByText('Uninstall org.sample.notes from Pixel 9?')).toBeTruthy()
    expect(within(confirm).getByText(/removes org\.sample\.notes and all of its data/)).toBeTruthy()
    expect(within(confirm).getByText('Uninstall')).toBeTruthy()

    finishExits()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // And it stays what it was: Cancel uninstalled nothing.
    expect(rowNames()).toHaveLength(2)
  })

  it('fades the sheet out with the app in it, not as an empty panel', async () => {
    const finishExits = fakeExitAnimations()
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    fireEvent.click(await screen.findByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('arm64-v8a')

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(sheet.dataset.state).toBe('closed')
    expect(within(sheet).getByRole('heading', { name: 'org.sample.notes' })).toBeTruthy()
    // The details read before closing, not a loading skeleton: the body was not remounted.
    expect(within(sheet).getByText('arm64-v8a')).toBeTruthy()

    finishExits()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus to the next app once an uninstall took its row away', async () => {
    const third = row('net.demo.maps', { lastUpdated: Date.UTC(2026, 8, 20) })
    const lane = fakeLane({ user: [SHOP, NOTES, third], all: [SHOP, NOTES, third] })
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('net.demo.maps')
    expect(rowNames()).toHaveLength(3)

    // From the middle row's menu: the row after it takes focus.
    fireEvent.click(within(await openMenu('org.sample.notes')).getByText('Uninstall…'))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(document.activeElement).toBe(rowButton('net.demo.maps'))
    })
    expect(screen.queryByText('org.sample.notes')).toBeNull()

    // From the last row's sheet: there is none after it, so the one before.
    fireEvent.click(screen.getByText('net.demo.maps'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Uninstall…' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(rowButton('com.example.shop'))
    })
  })

  it('moves focus to the filter, or to Refresh, when no row is left to take it', async () => {
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    await screen.findByText('org.sample.notes')

    // Filtered down to one app, uninstalled from its menu: the filter still holds the query.
    const box = screen.getByRole('searchbox', { name: 'Filter apps' })
    fireEvent.change(box, { target: { value: 'notes' } })
    expect(rowNames()).toHaveLength(1)
    fireEvent.click(within(await openMenu('org.sample.notes')).getByText('Uninstall…'))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(screen.getByText('Nothing matches “notes”')).toBeTruthy()
    expect(document.activeElement).toBe(box)

    // The last app on the phone, from its sheet, with no filter: Refresh.
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(await screen.findByText('com.example.shop'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Uninstall…' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(await screen.findByText(emptyCopy('user').title)).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }))
    })
  })

  it('returns focus where it was when the confirmation is cancelled', async () => {
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(within(await openMenu('org.sample.notes')).getByText('Uninstall…'))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    )
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'More actions for org.sample.notes' }),
      )
    })
  })
})

/** A pull that waits for the test: `finish(path)` delivers that APK's bytes. */
function slowPull() {
  const waiting = new Map<
    string,
    { resolve: (blob: Blob) => void; reject: (error: unknown) => void }
  >()
  const pull = vi.fn(
    (
      _id: string,
      path: string,
      onProgress: (sent: number, total: number) => void,
      signal: AbortSignal,
    ) =>
      new Promise<Blob>((resolve, reject) => {
        onProgress(0, 0)
        waiting.set(path, { resolve, reject })
        signal.addEventListener('abort', () => {
          reject(new DOMException('Cancelled', 'AbortError'))
        })
      }),
  )
  const finish = async (path: string, text: string) => {
    await waitFor(() => {
      expect(waiting.has(path)).toBe(true)
    })
    await act(async () => {
      waiting.get(path)?.resolve(new Blob([text]))
      await Promise.resolve()
    })
  }
  return { pull, finish }
}

/** What the tab saves, caught at the anchor it clicks. */
function catchSaves() {
  const saved: { name: string; blob: Blob }[] = []
  const blobs = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${String(blobs.size)}`
    blobs.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href)
    if (blob) saved.push({ name: this.download, blob })
  })
  return saved
}

const openMenu = (name: string) => {
  fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${name}` }), {
    key: 'Enter',
  })
  return screen.findByRole('menu')
}

const BASE = (pkg: string) => `/data/app/~~x==/${pkg}-y==/base.apk`
const SPLIT = (pkg: string) => `/data/app/~~x==/${pkg}-y==/split_config.xxhdpi.apk`

describe('AppsTab: Export app', () => {
  it('exports from a row’s menu: progress on the row, then an .xapk of the split app', async () => {
    const saved = catchSaves()
    const success = vi.spyOn(toast, 'success')
    const { pull, finish } = slowPull()
    const lane = { ...fakeLane({}, { 'com.example.shop': { label: 'Shop', icon: null } }), pull }
    const announce = vi.fn()
    render(<AppsTab device={pixel()} lane={lane} onAnnounce={announce} />)
    await screen.findByText('Shop')

    const menu = await openMenu('Shop')
    // With the non-destructive items, before the separator.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent.trim()),
    ).toEqual([
      'Open',
      'Force stop',
      'App info on phone',
      'Export app',
      'Copy package name',
      'Clear data…',
      'Uninstall…',
    ])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export app' }))

    // The row lists the APKs, then pulls them, with a Cancel and a meter of its own.
    await waitFor(() => {
      expect(lane.app).toHaveBeenCalledWith(expect.any(String), 'com.example.shop')
    })
    expect(announce).toHaveBeenCalledWith('Exporting Shop.')
    const meter = await screen.findByRole('progressbar', { name: 'Export of Shop' })
    expect(screen.getByRole('button', { name: 'Cancel export of Shop' })).toBeTruthy()
    await waitFor(() => {
      expect(meter.getAttribute('aria-valuenow')).toBe('0')
    })
    expect(screen.getByText('Exporting · 0% of 1.2 KB')).toBeTruthy()
    expect(meter.getAttribute('aria-valuetext')).toBe('Exporting 0 B of 1.2 KB (2 APKs) · 0%')

    // One export per app: the item is disabled while it runs.
    const again = await openMenu('Shop')
    expect(
      within(again).getByRole('menuitem', { name: 'Export app' }).getAttribute('aria-disabled'),
    ).toBe('true')
    fireEvent.keyDown(again, { key: 'Escape' })

    await finish(BASE('com.example.shop'), 'base bytes')
    await finish(SPLIT('com.example.shop'), 'split bytes')

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    const [file] = saved
    if (!file) throw new Error('nothing saved')
    expect(file.name).toBe('com.example.shop-1.4.0.xapk')
    const zip = await openZip(file.blob)
    expect(zip.entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'base.apk',
      'split_config.xxhdpi.apk',
    ])
    const manifest = zip.get('manifest.json')
    if (!manifest) throw new Error('manifest.json missing')
    expect(JSON.parse(new TextDecoder().decode(await zip.bytes(manifest)))).toMatchObject({
      package_name: 'com.example.shop',
      name: 'Shop',
      split_apks: [
        { file: 'base.apk', id: 'base' },
        { file: 'split_config.xxhdpi.apk', id: 'config.xxhdpi' },
      ],
    })
    expect(success).toHaveBeenCalledWith('Saved com.example.shop-1.4.0.xapk', {
      description: savedCopy({ kind: 'xapk', apks: 2 }),
    })
    expect(announce).toHaveBeenCalledWith('Saved com.example.shop-1.4.0.xapk.')
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).toBeNull()
    })
  })

  it('cancels from the row, and keeps focus on the row’s menu button', async () => {
    const saved = catchSaves()
    const { pull } = slowPull()
    const lane = { ...fakeLane(), pull }
    const announce = vi.fn()
    render(<AppsTab device={pixel()} lane={lane} onAnnounce={announce} />)
    await screen.findByText('org.sample.notes')

    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    const cancel = await screen.findByRole('button', {
      name: 'Cancel export of org.sample.notes',
    })
    await waitFor(() => {
      expect(pull).toHaveBeenCalled()
    })
    cancel.focus()
    fireEvent.click(cancel)

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('Export cancelled.')
    })
    expect(screen.queryByRole('button', { name: /^Cancel export/ })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'More actions for org.sample.notes' }),
    )
    expect(saved).toEqual([])
  })

  it('cancels at once while the APKs are still being listed', async () => {
    const saved = catchSaves()
    const { pull } = slowPull()
    let listed: (detail: AppDetail) => void = () => undefined
    const lane = {
      ...fakeLane(),
      pull,
      // dumpsys can take a second or more, and the lane's read takes no signal.
      app: vi.fn(
        () =>
          new Promise<AppDetail>((resolve) => {
            listed = resolve
          }),
      ),
    }
    const announce = vi.fn()
    render(<AppsTab device={pixel()} lane={lane} onAnnounce={announce} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    await screen.findByText('Finding the APK files…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export of org.sample.notes' }))

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('Export cancelled.')
    })
    expect(screen.queryByText('Finding the APK files…')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()

    // The listing that answers late is dropped: nothing is pulled or saved.
    await act(async () => {
      listed(detailOf(NOTES))
      await Promise.resolve()
    })
    expect(pull).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('keeps an export going when the tab is left, and shows it again on return', async () => {
    const saved = catchSaves()
    const success = vi.spyOn(toast, 'success')
    const { pull, finish } = slowPull()
    const lane = { ...fakeLane(), pull }
    const announce = vi.fn()
    const device = pixel()
    const first = render(<AppsTab device={device} lane={lane} onAnnounce={announce} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    await screen.findByRole('progressbar', { name: 'Export of org.sample.notes' })

    // Off to another tab: the export is not cancelled, and goes on pulling.
    first.unmount()
    expect(announce).not.toHaveBeenCalledWith('Export cancelled.')
    await finish(BASE('org.sample.notes'), 'base')

    // Back on Apps: the row shows it, with its Cancel, and it finishes there.
    render(<AppsTab device={device} lane={lane} onAnnounce={announce} />)
    await screen.findByRole('progressbar', { name: 'Export of org.sample.notes' })
    expect(screen.getByRole('button', { name: 'Cancel export of org.sample.notes' })).toBeTruthy()
    await finish(SPLIT('org.sample.notes'), 'split')
    await waitFor(() => {
      expect(saved.map((f) => f.name)).toEqual(['org.sample.notes-1.4.0.xapk'])
    })
    expect(success).toHaveBeenCalledWith('Saved org.sample.notes-1.4.0.xapk', expect.anything())
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).toBeNull()
    })
  })

  it('saves an export that finishes while the tab is closed', async () => {
    const saved = catchSaves()
    const { pull, finish } = slowPull()
    const lane = { ...fakeLane(), pull }
    const announce = vi.fn()
    const { unmount } = render(<AppsTab device={pixel()} lane={lane} onAnnounce={announce} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    await screen.findByRole('progressbar', { name: 'Export of org.sample.notes' })
    unmount()
    await finish(BASE('org.sample.notes'), 'base')
    await finish(SPLIT('org.sample.notes'), 'split')
    await waitFor(() => {
      expect(saved.map((f) => f.name)).toEqual(['org.sample.notes-1.4.0.xapk'])
    })
    expect(announce).toHaveBeenCalledWith('Saved org.sample.notes-1.4.0.xapk.')
  })

  it('exports a one-APK app as a plain .apk from the sheet, and says so', async () => {
    const saved = catchSaves()
    const success = vi.spyOn(toast, 'success')
    const lane = fakeLane()
    const one = vi.fn((_id: string, pkg: string) =>
      Promise.resolve({
        ...detailOf(NOTES),
        packageName: pkg,
        splits: ['base'],
        apks: [{ path: BASE(pkg), size: 4 }],
      }),
    )
    const pull = vi.fn(() => Promise.resolve(new Blob(['apk!'])))
    render(<AppsTab device={pixel()} lane={{ ...lane, app: one, pull }} />)
    fireEvent.click(await screen.findByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(
      await within(sheet).findByRole('button', {
        name: 'Export app',
        description: 'Saves one .apk.',
      }),
    )

    await waitFor(() => {
      expect(saved.map((f) => f.name)).toEqual(['org.sample.notes-1.4.0.apk'])
    })
    expect(saved[0]?.blob.type).toBe('application/vnd.android.package-archive')
    expect(await saved[0]?.blob.text()).toBe('apk!')
    expect(success).toHaveBeenCalledWith('Saved org.sample.notes-1.4.0.apk', {
      description: 'To install it again, drop it on Device Lab or use adb install.',
    })
  })

  it('says why an export failed', async () => {
    catchSaves()
    const error = vi.spyOn(toast, 'error')
    const pull = vi.fn(() => Promise.reject(new Error('FILE_READ_FAILED')))
    render(<AppsTab device={pixel()} lane={{ ...fakeLane(), pull }} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith('Couldn’t export org.sample.notes', expect.anything())
    })
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('moves focus to the sheet’s Export button when the export ends while its Cancel has it', async () => {
    const saved = catchSaves()
    const { pull, finish } = slowPull()
    render(<AppsTab device={pixel()} lane={{ ...fakeLane(), pull }} />)
    fireEvent.click(await screen.findByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    const exportButton = await within(sheet).findByRole('button', { name: 'Export app' })
    fireEvent.click(exportButton)
    const cancel = await within(sheet).findByRole('button', { name: 'Cancel' })
    cancel.focus()

    // Not pressed: the export finishes by itself and its bar goes.
    await finish(BASE('org.sample.notes'), 'base')
    await finish(SPLIT('org.sample.notes'), 'split')
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    await waitFor(() => {
      expect(within(sheet).queryByRole('button', { name: 'Cancel' })).toBeNull()
    })
    expect(document.activeElement).toBe(exportButton)
  })

  it('holds Uninstall back while the app exports, and leaves Clear data open', async () => {
    catchSaves()
    const { pull, finish } = slowPull()
    const lane = { ...fakeLane(), pull }
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('org.sample.notes')
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Export app' }),
    )
    await screen.findByRole('progressbar', { name: 'Export of org.sample.notes' })

    const disabled = (menu: HTMLElement, name: string) =>
      within(menu).getByRole('menuitem', { name }).getAttribute('aria-disabled')
    const menu = await openMenu('org.sample.notes')
    expect(disabled(menu, 'Uninstall…')).toBe('true')
    expect(within(menu).getByRole('menuitem', { name: 'Uninstall…' }).title).toBe(
      'Cancel the export or let it finish to uninstall',
    )
    expect(disabled(menu, 'Clear data…')).toBeNull()
    // Another app's Uninstall is not held back.
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(disabled(await openMenu('com.example.shop'), 'Uninstall…')).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })

    // The sheet's Uninstall says why it waits, and does nothing when pressed.
    fireEvent.click(screen.getByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    const uninstall = within(sheet).getByRole('button', { name: 'Uninstall…' })
    expect(uninstall.getAttribute('aria-disabled')).toBe('true')
    expect(uninstall.title).toBe('Cancel the export or let it finish to uninstall')
    fireEvent.click(uninstall)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(lane.appAction).not.toHaveBeenCalled()

    // Once the export is saved, Uninstall is offered again.
    await finish(BASE('org.sample.notes'), 'base')
    await finish(SPLIT('org.sample.notes'), 'split')
    await waitFor(() => {
      expect(uninstall.getAttribute('aria-disabled')).toBe('false')
    })
    expect(uninstall.title).toBe('')
  })

  it('names the export the same in the menu and the sheet; the sheet says what it saves', async () => {
    const pull = vi.fn(() => Promise.resolve(new Blob(['apk!'])))
    render(<AppsTab device={pixel()} lane={{ ...fakeLane(), pull }} />)
    await screen.findByText('org.sample.notes')
    const menu = await openMenu('org.sample.notes')
    expect(within(menu).getByRole('menuitem', { name: 'Export app' })).toBeTruthy()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })

    // A split app: the same name, and the .xapk said before it is saved, not only after.
    fireEvent.click(screen.getByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('arm64-v8a')
    expect(
      within(sheet).getByRole('button', {
        name: 'Export app',
        description: 'Saves its 2 APKs as one .xapk.',
      }),
    ).toBeTruthy()
  })

  it('offers no export on a lane that cannot pull', async () => {
    render(<AppsTab device={pixel()} lane={fakeLane()} />)
    await screen.findByText('org.sample.notes')
    const menu = await openMenu('org.sample.notes')
    expect(within(menu).queryByRole('menuitem', { name: 'Export app' })).toBeNull()
  })
})

describe('AppsTab: rendering', () => {
  it('does not re-render the rows when the sheet, a menu or a dialog opens or closes', async () => {
    const lane = { ...fakeLane({}, { 'com.example.shop': { label: 'Shop', icon: null } }) }
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('Shop')
    await badgesLanded(lane, 2)
    avatarRenders.length = 0

    // The sheet, its details read, and closed again.
    fireEvent.click(screen.getByText('Shop'))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('arm64-v8a')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    // A row's menu, and a confirmation from it.
    const menu = await openMenu('org.sample.notes')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Clear data…' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    expect(avatarRenders).toEqual([])
  })

  it('re-renders only the row an action is about', async () => {
    const lane = fakeLane()
    // As on a loaded machine: Shop's badge lands after the rows are drawn, and the action
    // takes longer still. A badge landing mid-action is not the action's render.
    lane.appBadge.mockImplementation(
      (_id: string, pkg: string) =>
        new Promise((resolve) =>
          setTimeout(
            () => {
              resolve({ label: null, icon: null })
            },
            pkg === SHOP.packageName ? 30 : 0,
          ),
        ),
    )
    lane.appAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 60)
        }),
    )
    render(<AppsTab device={pixel()} lane={lane} />)
    await screen.findByText('org.sample.notes')
    await badgesLanded(lane, 2)
    avatarRenders.length = 0
    fireEvent.click(
      within(await openMenu('org.sample.notes')).getByRole('menuitem', { name: 'Force stop' }),
    )
    await waitFor(() => {
      expect(lane.appAction).toHaveBeenCalledWith(expect.any(String), 'org.sample.notes', 'stop')
    })
    await waitFor(() => {
      expect(screen.getByText('Stopped')).toBeTruthy()
    })
    expect(new Set(avatarRenders)).toEqual(new Set(['org.sample.notes']))
  })
})

describe('AppsTab through the store', () => {
  it('runs actions through `act`, and reloads when reloadKey moves', async () => {
    const lane = fakeLane()
    const act = vi.fn(() => Promise.resolve<string | null>(null))
    const device = pixel()
    const { rerender } = render(<AppsTab device={device} lane={lane} act={act} reloadKey={0} />)
    fireEvent.click(await screen.findByText('com.example.shop'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Uninstall…' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }),
    )
    await waitFor(() => {
      expect(act).toHaveBeenCalledWith('com.example.shop', 'uninstall')
    })
    expect(lane.appAction).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(rowNames()).toHaveLength(1)
    })
    expect(lane.apps).toHaveBeenCalledTimes(1)

    // The store bumped appsRevision: the list is read again.
    rerender(<AppsTab device={device} lane={lane} act={act} reloadKey={1} />)
    await waitFor(() => {
      expect(lane.apps).toHaveBeenCalledTimes(2)
    })
  })

  it('shows the store’s wording when an action fails', async () => {
    const act = vi.fn(() => Promise.resolve<string | null>('This app has no screen to open.'))
    render(<AppsTab device={pixel()} lane={fakeLane()} act={act} />)
    fireEvent.click(await screen.findByText('org.sample.notes'))
    const sheet = await screen.findByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open' }))
    await waitFor(() => {
      expect(act).toHaveBeenCalledWith('org.sample.notes', 'launch')
    })
    // Not marked as running any more: the button can be pressed again.
    await waitFor(() => {
      expect(
        within(sheet).getByRole('button', { name: 'Open' }).getAttribute('aria-disabled'),
      ).toBe('false')
    })
  })
})

describe('staleOnScreen', () => {
  it('picks the rows on screen that have no badge', () => {
    const badges = new Map([['com.example.shop', null]])
    const onScreen = new Set(['com.example.shop', 'org.sample.notes'])
    expect(staleOnScreen([SHOP, NOTES, SETTINGS], badges, onScreen)).toEqual([NOTES])
    expect(staleOnScreen([SHOP, NOTES], new Map(), new Set())).toEqual([])
  })
})

describe('createBadgeQueue', () => {
  const deferred = () => {
    let resolve: (badge: AppBadge | null) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const promise = new Promise<AppBadge | null>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('reads two at a time, newest request first, skipping dropped rows', async () => {
    const calls = new Map<string, ReturnType<typeof deferred>>()
    const order: string[] = []
    const seen: string[] = []
    const q = createBadgeQueue({
      deviceId: `Q${String(++serial)}`,
      load: (r) => {
        order.push(r.packageName)
        const d = deferred()
        calls.set(r.packageName, d)
        return d.promise
      },
      onBadge: (r, view) => seen.push(`${r.packageName}=${view?.label ?? 'null'}`),
    })
    for (const name of ['a.a', 'b.b', 'c.c', 'd.d', 'e.e']) q.want(row(name))
    q.drop('d.d')
    expect(order).toEqual(['a.a', 'b.b'])

    calls.get('a.a')?.resolve({ label: 'A', icon: null })
    await vi.waitFor(() => {
      expect(order).toEqual(['a.a', 'b.b', 'e.e'])
    })
    calls.get('b.b')?.reject(new Error('transport'))
    await vi.waitFor(() => {
      expect(order).toEqual(['a.a', 'b.b', 'e.e', 'c.c'])
    })
    expect(seen).toEqual(['a.a=A', 'b.b=null'])

    // Cached, failures included: asking again reports at once and reads nothing.
    q.want(row('b.b'))
    expect(seen.at(-1)).toBe('b.b=null')
    expect(order).toHaveLength(4)

    q.stop()
    calls.get('e.e')?.resolve({ label: 'E', icon: null })
    await Promise.resolve()
    expect(seen).not.toContain('e.e=E')
  })
})

describe('neighbourOf', () => {
  it('picks the app after, the one before for the last, and none when alone', () => {
    const shown = [SHOP, NOTES, SETTINGS]
    expect(neighbourOf(shown, NOTES.packageName)).toBe(SETTINGS.packageName)
    expect(neighbourOf(shown, SETTINGS.packageName)).toBe(NOTES.packageName)
    expect(neighbourOf([SHOP], SHOP.packageName)).toBeNull()
    expect(neighbourOf(shown, 'com.example.gone')).toBeNull()
  })
})

describe('row wording', () => {
  it('counts', () => {
    expect(countText(1, 1)).toBe('1 app')
    expect(countText(3, 12)).toBe('3 of 12 apps')
  })

  it('puts the package under a label, and leaves out what is unknown', () => {
    expect(
      rowMeta(row('com.example.shop', { lastUpdated: null }), {
        label: 'Shop',
        icon: null,
      }),
    ).toBe('com.example.shop · 812 · Google Play')
    expect(
      rowMeta(row('com.example.shop', { versionCode: null, lastUpdated: null }), undefined),
    ).toBe('Google Play')
    expect(
      rowMeta(row('com.example.shop', { lastUpdated: Date.UTC(2026, 9, 3, 2, 5) }), null),
    ).toBe('812 · Google Play · Updated 03-Oct-2026 09:05')
  })
})
