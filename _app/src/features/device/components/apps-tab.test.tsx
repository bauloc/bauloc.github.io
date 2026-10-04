// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppBadge, AppDetail, AppRow, AppScope } from '../backends/backend'
import { normalizeDevice, type Device } from '../model'
import type { AppsLane } from './app-sheet'
import { AppsTab, countText, createBadgeQueue, emptyCopy, rowMeta, staleOnScreen } from './apps-tab'

afterEach(() => {
  cleanup()
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
