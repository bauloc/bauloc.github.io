// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConsoleContext } from '../console-context'
import {
  AuthError,
  isBlobWrite,
  type CommitPlan,
  type Repo,
  type RepoEntry,
  type UploadOptions,
} from '../repo/github'
import { BuildsPage } from './builds-page'
import { EMPTY_BUILD_DB, entryFromInspection, parseBuildDb } from './model'
import { BUILD_DB_PATH } from './paths'
import type { BuildDb, BuildEntry, BuildInspection } from './types'

/*
  The Builds page as the owner meets it, against a repository in memory: what it shows for each
  state of the index, and the commits that uploading, editing and deleting make. Reading the
  file is scripted (inspect/ has its own tests); everything after it is the real thing.
*/

const scripted = vi.hoisted(() => ({
  inspection: null as BuildInspection | null,
  icon: null as Blob | null,
  /** How many files have been read: a drop must be read once, and a refused one never. */
  reads: 0,
  /** While set, every read waits for it: the sheet can be seen mid-read. */
  gate: null as Promise<unknown> | null,
}))

vi.mock('./inspect', () => ({
  inspectBuild: async () => {
    scripted.reads++
    await scripted.gate
    if (scripted.inspection) return scripted.inspection
    throw new Error('Not a zip')
  },
}))

vi.mock('./inspect/icon', () => ({
  renderIconPng: () => Promise.resolve(scripted.icon),
}))

beforeAll(() => {
  // Radix's popper measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Nor scrolling: the sheet scrolls its body to bring a problem into view.
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: () => undefined,
    configurable: true,
  })
  // jsdom has no blob: URLs; the sheet only hands them to an <img>.
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:icon', configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true })
})

beforeEach(() => {
  scripted.inspection = ANDROID
  scripted.icon = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
  scripted.reads = 0
  scripted.gate = null
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const ANDROID: BuildInspection = {
  platform: 'android',
  name: 'My App',
  bundleId: 'com.example.app',
  version: '1.2.0',
  build: '45',
  minOs: '24',
  android: { target_sdk: 35, debuggable: false, abis: ['arm64-v8a'] },
  ios: null,
  icon: { kind: 'image', mime: 'image/png', bytes: new Uint8Array([1]) },
  problems: [],
  warnings: [],
}

const IOS: BuildInspection = {
  platform: 'ios',
  name: 'Cải Lương',
  bundleId: 'vn.plsoft.cailuong',
  version: '2.0',
  build: '7',
  minOs: '15.0',
  android: null,
  ios: {
    devices: ['iphone'],
    profile: {
      kind: 'ad-hoc',
      name: 'Ad Hoc',
      team: 'PLSOFT',
      expires: '2027-01-01T00:00:00.000Z',
      device_count: 3,
    },
  },
  icon: null,
  problems: [],
  warnings: [],
}

/** What inspect/ says of a file that is no build: refused, its platform only guessed. */
const NOT_BUILD: BuildInspection = {
  ...ANDROID,
  name: 'notes',
  bundleId: '',
  version: '',
  build: '',
  minOs: '',
  android: null,
  icon: null,
  problems: [{ code: 'NOT_A_BUILD' }],
}

function entry(inspection: BuildInspection, id: string, name = inspection.name): BuildEntry {
  return entryFromInspection({
    inspection,
    id,
    name,
    notes: '',
    file: `${id}-file.${inspection.platform === 'android' ? 'apk' : 'ipa'}`,
    size: 3 * 1024 * 1024,
    sha256: 'ab'.repeat(32),
    icon: false,
    now: '2026-10-01T01:00:00.000Z',
    existing: null,
  })
}

const DROID = entry(ANDROID, 'droid', 'Droid App')
const APPLE = entry(IOS, 'apple')
const TWO: BuildDb = { version: 1, entries: [DROID, APPLE] }

interface FakeRepo extends Repo {
  readonly commits: CommitPlan[]
  readonly uploads: Blob[]
  readonly files: Map<string, string>
}

/** A repository in memory. `upload` may be replaced to hold an upload open or refuse it. */
function fakeRepo(db: BuildDb | null, dirs: Record<string, RepoEntry[]> = {}): FakeRepo {
  const files = new Map<string, string>()
  if (db) files.set(BUILD_DB_PATH, JSON.stringify(db))
  const commits: CommitPlan[] = []
  const uploads: Blob[] = []
  return {
    commits,
    uploads,
    files,
    head: () => Promise.resolve('head-1'),
    read: (path) => Promise.resolve(files.get(path) ?? null),
    list: (path) => Promise.resolve(dirs[path] ?? null),
    upload: (data: Blob, options?: UploadOptions) => {
      uploads.push(data)
      options?.onProgress?.(0.5)
      return Promise.resolve(`blob-${String(uploads.length)}`)
    },
    commit: (plan) => {
      commits.push(plan)
      for (const write of plan.writes ?? []) {
        if (!isBlobWrite(write)) files.set(write.path, write.content)
      }
      return Promise.resolve()
    },
  }
}

const file =
  (name: string) =>
  (path: string): RepoEntry => ({
    name,
    path: `${path}/${name}`,
    type: 'file',
    size: 1,
  })

function renderPage(repo: Repo, openSettings = vi.fn()) {
  render(
    <ConsoleContext.Provider value={{ repo, mock: false, openSettings }}>
      <BuildsPage />
    </ConsoleContext.Provider>,
  )
  return { openSettings }
}

/** A file of a zip's first bytes: what the scripted read is handed. */
const buildFile = (name = 'app-release.apk') =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], name)

/** Drops a file on the sheet's drop zone, through its file input. */
function chooseFile(name?: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  fireEvent.change(input, { target: { files: [buildFile(name)] } })
}

/**
 * Drags a file from Finder over `target` and lets it go there. `prevented`: the page took the
 * drop, so the browser does not open the file over the console. `effect`: what the pointer
 * showed on the way, 'copy' where the file would be taken and 'none' where it would not.
 */
function dropFile(target: Element, name?: string) {
  // jsdom has no DataTransfer: the events carry this object as theirs.
  const dataTransfer = { files: [buildFile(name)], types: ['Files'], dropEffect: '' }
  fireEvent.dragEnter(target, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  const effect = dataTransfer.dropEffect
  return { prevented: !fireEvent.drop(target, { dataTransfer }), effect }
}

/** Gives a read that should not have started the time to finish, so its absence means something. */
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      }),
  )

/** Opens a card's ⋯ menu from the keyboard and picks an item. */
function menu(buildName: string, item: string) {
  const trigger = screen.getByRole('button', { name: `Actions for ${buildName}` })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

const committed = (repo: FakeRepo, index = 0) => {
  const plan = repo.commits[index]
  if (!plan) throw new Error(`no commit #${String(index)}`)
  return plan
}

const writtenDb = (plan: CommitPlan) => {
  const write = plan.writes?.find((w) => w.path === BUILD_DB_PATH)
  if (!write || isBlobWrite(write)) throw new Error('no index written')
  return parseBuildDb(write.content)
}

/* ---------------------------------------------------------------- *
 * The list
 * ---------------------------------------------------------------- */

describe('the list', () => {
  it('starts empty where there has never been a build', async () => {
    renderPage(fakeRepo(null))
    expect(await screen.findByText('No builds yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload build/ })).toBeEnabled()
  })

  it('refuses to upload while builds exist but their index is missing', async () => {
    renderPage(fakeRepo(null, { build: [file('k3x9q2mf')('build')] }))
    expect(await screen.findByText('The build index was not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload build/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('offers a new token when GitHub refuses the one it has', async () => {
    const repo = fakeRepo(TWO)
    repo.read = () => Promise.reject(new AuthError())
    const { openSettings } = renderPage(repo)
    fireEvent.click(await screen.findByRole('button', { name: 'Update token' }))
    expect(openSettings).toHaveBeenCalled()
  })

  it('shows each build with its version, size and link, filtered by platform and search', async () => {
    renderPage(fakeRepo(TWO))
    expect(await screen.findByText('Droid App')).toBeInTheDocument()
    expect(screen.getByText('Cải Lương')).toBeInTheDocument()
    expect(screen.getByText('1.2.0 (45)')).toBeInTheDocument()
    expect(screen.getByText('bauloc.github.io/build/droid/')).toBeInTheDocument()
    expect(screen.getByText('1 Android · 1 iOS')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /iOS/ }))
    expect(screen.queryByText('Droid App')).not.toBeInTheDocument()
    expect(screen.getByText('Cải Lương')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /All/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search builds' }), {
      target: { value: 'cai luong' },
    })
    expect(screen.queryByText('Droid App')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search builds' }), {
      target: { value: 'nothing like it' },
    })
    expect(screen.getByText('No build matches')).toBeInTheDocument()
  })

  it('shows the icon from the live site, and the initial while it cannot load', async () => {
    const withIcon: BuildEntry = { ...DROID, icon: 'icon.png' }
    renderPage(fakeRepo({ version: 1, entries: [withIcon, APPLE] }))
    await screen.findByText('Droid App')
    const img = document.querySelector('img')
    expect(img).toHaveAttribute(
      'src',
      `https://bauloc.github.io/build/droid/icon.png?v=${DROID.sha256.slice(0, 12)}`,
    )
    // The build without an icon shows its initial from the start.
    expect(screen.getByText('C')).toBeInTheDocument()
    if (img) fireEvent.error(img)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('D')).toBeInTheDocument()
  })

  it('shows a build’s link as a QR code', async () => {
    renderPage(fakeRepo(TWO))
    await screen.findByText('Droid App')
    fireEvent.click(screen.getAllByRole('button', { name: 'Show the QR code' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('img', { name: 'QR code of the install link for Droid App' }),
    ).toBeInTheDocument()
  })

  it('deletes a build with every file its directory holds, in one commit', async () => {
    const repo = fakeRepo(TWO, {
      'build/droid': ['index.html', 'droid-file.apk', 'stray.txt'].map((n) =>
        file(n)('build/droid'),
      ),
    })
    renderPage(repo)
    await screen.findByText('Droid App')
    menu('Droid App', 'Delete')
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Delete Droid App?')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(repo.commits).toHaveLength(1)
    })
    const plan = committed(repo)
    expect(plan.message).toBe('Delete build: droid')
    expect(plan.parent).toBe('head-1')
    expect(plan.deletes).toEqual([
      'build/droid/index.html',
      'build/droid/droid-file.apk',
      'build/droid/stray.txt',
    ])
    expect(writtenDb(plan).entries.map((e) => e.id)).toEqual(['apple'])
    await waitFor(() => {
      expect(screen.queryByText('Droid App')).not.toBeInTheDocument()
    })
  })
})

/* ---------------------------------------------------------------- *
 * The sheet
 * ---------------------------------------------------------------- */

describe('uploading', () => {
  it('reads the file, then uploads the icon and the binary and publishes them in one commit', async () => {
    const repo = fakeRepo(EMPTY_BUILD_DB)
    renderPage(repo)
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile()

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('com.example.app')).toBeInTheDocument()
    // The versions a tester finds in Settings, as the install page names them.
    expect(within(sheet).getByText('Android 7.0 (API 24)')).toBeInTheDocument()
    expect(within(sheet).getByText('Android 15 (API 35)')).toBeInTheDocument()
    expect(within(sheet).getByLabelText(/App name/)).toHaveValue('My App')
    const link = within(sheet).getByLabelText(/^Link/)
    expect((link as HTMLInputElement).value).toMatch(/^[a-z0-9]{8}$/)
    fireEvent.change(link, { target: { value: 'My-Link' } })
    expect(link).toHaveValue('my-link')
    fireEvent.change(within(sheet).getByLabelText(/Release notes/), {
      target: { value: 'Fixed login.' },
    })

    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('Build published')).toBeInTheDocument()

    expect(repo.uploads.map((b) => b.size)).toEqual([4, 7])
    const plan = committed(repo)
    expect(plan.message).toBe('Add build: my-link (My App 1.2.0 (45))')
    expect(plan.writes?.map((w) => w.path)).toEqual([
      'build/my-link/my-app-1.2.0-45.apk',
      'build/my-link/icon.png',
      'build/my-link/index.html',
      BUILD_DB_PATH,
    ])
    const [published] = writtenDb(plan).entries
    expect(published).toMatchObject({
      id: 'my-link',
      notes: 'Fixed login.',
      icon: 'icon.png',
      size: 7,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    })
    expect(within(sheet).getByText('bauloc.github.io/build/my-link/')).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByText('My App')).toBeInTheDocument()
  })

  it('names the levels of a build for an old phone or a preview as plainly as it can', async () => {
    // minSdk 16, which older Flutter and React Native apps still declare, has a version to name.
    // A preview's levels have none — its codename as the minimum, API 10000 as the target — and
    // keep the plain wording rather than losing their rows.
    scripted.inspection = {
      ...ANDROID,
      minOs: '16',
      android: { target_sdk: 10000, debuggable: false, abis: [] },
    }
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('Android 4.1 (API 16)')).toBeInTheDocument()
    expect(within(sheet).getByText('API 10000')).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose another file' }))
    scripted.inspection = { ...ANDROID, minOs: 'VanillaIceCream' }
    chooseFile()
    expect(await within(sheet).findByText('API VanillaIceCream')).toBeInTheDocument()
  })

  it('holds publishing back while the build has a problem, and says how to fix it', async () => {
    scripted.inspection = { ...ANDROID, problems: [{ code: 'APK_TEST_ONLY' }] }
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(/\.\/gradlew assembleDebug/)).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  it('tells a screen reader when the read is done, what it found, and so why Publish is off', async () => {
    let release = () => {}
    scripted.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    scripted.inspection = {
      ...ANDROID,
      problems: [{ code: 'APK_TEST_ONLY' }],
      warnings: [{ code: 'APK_DEBUGGABLE' }],
    }
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    const sheet = await screen.findByRole('dialog')
    // There, and silent, before it has anything to say: a region that appears with its text
    // already in it is not read out.
    const status = within(sheet).getByRole('status')
    expect(status).toBeEmptyDOMElement()

    chooseFile()
    expect(status).toHaveTextContent('Reading the build…')
    release()
    await waitFor(() => {
      expect(status).toHaveTextContent('Read My App 1.2.0 (45): 1 problem, 1 warning')
    })
    // The same region all along, and the only one: the boxes under it come and go.
    expect(within(sheet).getByRole('status')).toBe(status)
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  it('shows a file that is not a build as just a file, with no platform guessed', async () => {
    scripted.inspection = NOT_BUILD
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile('notes.txt')
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('notes.txt')).toBeInTheDocument()
    expect(within(sheet).getByText(/This is not an .apk or .ipa file/)).toBeInTheDocument()
    expect(within(sheet).queryByText('Android')).not.toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(within(sheet).getByRole('status')).toHaveTextContent('Read notes.txt: 1 problem')
  })

  it('says only that a file is not a build when it comes as a new version', async () => {
    renderPage(fakeRepo(TWO))
    await screen.findByText('Cải Lương')
    menu('Cải Lương', 'Upload new version')
    scripted.inspection = { ...NOT_BUILD, name: 'MyApp' }
    chooseFile('MyApp.zip')
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(/This is not an .apk or .ipa file/)).toBeInTheDocument()
    // inspect/ guessed Android for it, but it is no Android build to refuse under an iOS link.
    expect(within(sheet).queryByText(/This link holds the iOS build/)).not.toBeInTheDocument()
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(1)
    expect(within(sheet).getByRole('status')).toHaveTextContent('Read MyApp.zip: 1 problem')
  })

  it('says why a file could not be read, and takes another', async () => {
    scripted.inspection = null
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile('notes.txt')
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('notes.txt: Not a zip')).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose another file' }))
    expect(within(sheet).getByText(/Drop an .apk or .ipa here/)).toBeInTheDocument()
  })

  it('refuses a link the list already has before sending anything', async () => {
    const repo = fakeRepo(TWO)
    renderPage(repo)
    fireEvent.click(await screen.findByRole('button', { name: /Upload build/ }))
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('com.example.app')
    fireEvent.change(within(sheet).getByLabelText(/^Link/), { target: { value: 'droid' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(
      await within(sheet).findByText('The link /build/droid/ is already in use. Choose another.'),
    ).toBeInTheDocument()
    expect(repo.uploads).toEqual([])
  })

  it('cancels an upload, publishing nothing, and reuses nothing it did not finish', async () => {
    const repo = fakeRepo(EMPTY_BUILD_DB)
    const info = vi.spyOn(toast, 'info')
    let calls = 0
    repo.upload = (_data, options) => {
      calls++
      if (calls === 1) return Promise.resolve('icon-blob')
      // The binary: held open until the sheet aborts it, as the XHR would be.
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The upload was cancelled.', 'AbortError'))
        })
      })
    }
    renderPage(repo)
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('com.example.app')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))

    const cancel = await within(sheet).findByRole('button', { name: /Cancel upload/ })
    // While bytes are going up, the sheet stays open and offers no way out but Cancel.
    expect(within(sheet).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    fireEvent.click(cancel)

    await waitFor(() => {
      expect(info).toHaveBeenCalledWith('Upload cancelled', expect.anything())
    })
    expect(repo.commits).toEqual([])
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeEnabled()
  })

  it('keeps the file and the answers when GitHub refuses the token, and offers a new one', async () => {
    const repo = fakeRepo(EMPTY_BUILD_DB)
    repo.upload = () => Promise.reject(new AuthError())
    const { openSettings } = renderPage(repo)
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('com.example.app')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))

    expect(await within(sheet).findByText(/GitHub refused the token/)).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Update token' }))
    expect(openSettings).toHaveBeenCalled()
    expect(within(sheet).getByText('com.example.app')).toBeInTheDocument()
    expect(within(sheet).getByLabelText(/App name/)).toHaveValue('My App')
  })

  it('uploads a new version under the same link, removing the old binary', async () => {
    const repo = fakeRepo(TWO, {
      'build/droid': ['index.html', 'droid-file.apk'].map((n) => file(n)('build/droid')),
    })
    renderPage(repo)
    await screen.findByText('Droid App')
    menu('Droid App', 'Upload new version')
    scripted.inspection = { ...ANDROID, version: '1.3.0', build: '46' }
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('1.3.0 (46)')
    expect(within(sheet).getByLabelText(/App name/)).toHaveValue('Droid App')
    expect(within(sheet).getByLabelText(/^Link/)).toBeDisabled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('New version published')).toBeInTheDocument()

    const plan = committed(repo)
    expect(plan.message).toBe('Update build: droid (Droid App 1.3.0 (46))')
    expect(plan.deletes).toEqual(['build/droid/droid-file.apk'])
    expect(writtenDb(plan).entries.map((e) => [e.id, e.version, e.created_at])).toEqual([
      ['droid', '1.3.0', DROID.created_at],
      ['apple', '2.0', APPLE.created_at],
    ])
  })

  it('names a new version that is another app after it, unless a name was typed', async () => {
    const OTHER: BuildInspection = { ...ANDROID, name: 'Other App', bundleId: 'com.other.app' }
    renderPage(fakeRepo(TWO))
    await screen.findByText('Droid App')
    menu('Droid App', 'Upload new version')
    scripted.inspection = OTHER
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('com.other.app')).toBeInTheDocument()
    const name = within(sheet).getByLabelText(/App name/)
    // The link's name would put another app's name on this one's install page.
    expect(name).toHaveValue('Other App')
    expect(within(sheet).getByText(/A different app: the link holds com.example.app/)).toBeVisible()

    // Back to the app the link holds: its own name comes back with it.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose another file' }))
    scripted.inspection = ANDROID
    chooseFile()
    expect(await within(sheet).findByText('com.example.app')).toBeInTheDocument()
    expect(name).toHaveValue('Droid App')

    // A name typed in the sheet is the owner's, whatever file comes next.
    fireEvent.change(name, { target: { value: 'Typed' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose another file' }))
    scripted.inspection = OTHER
    chooseFile()
    expect(await within(sheet).findByText('com.other.app')).toBeInTheDocument()
    expect(name).toHaveValue('Typed')
  })

  it('refuses a new version for the other platform under a link', async () => {
    renderPage(fakeRepo(TWO))
    await screen.findByText('Droid App')
    menu('Droid App', 'Upload new version')
    scripted.inspection = IOS
    chooseFile('app.ipa')
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(/This link holds the Android build/)).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
  })
})

describe('a file let go beside the drop zone', () => {
  it('is taken while the zone shows, and read once when it lands on the zone itself', async () => {
    renderPage(fakeRepo(EMPTY_BUILD_DB))
    fireEvent.click(await screen.findByRole('button', { name: /Upload the first build/ }))
    const sheet = await screen.findByRole('dialog')
    // On the App name field: taken as if dropped on the zone, never opened by the browser.
    expect(dropFile(within(sheet).getByLabelText(/App name/))).toEqual({
      prevented: true,
      effect: 'copy',
    })
    expect(await within(sheet).findByText('com.example.app')).toBeInTheDocument()
    expect(scripted.reads).toBe(1)

    // On the zone, the zone takes it, and the sheet's guard does not take it a second time.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose another file' }))
    const zone = within(sheet).getByRole('button', { name: /Drop an .apk or .ipa here/ })
    expect(dropFile(zone)).toEqual({ prevented: true, effect: 'copy' })
    expect(await within(sheet).findByText('com.example.app')).toBeInTheDocument()
    await settle()
    expect(scripted.reads).toBe(2)
  })

  it('is refused, not opened, once a file is read, while one is being read, and in an edit', async () => {
    let release = () => {}
    scripted.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPage(fakeRepo(TWO))
    await screen.findByText('Droid App')
    menu('Droid App', 'Upload new version')
    chooseFile()
    const sheet = await screen.findByRole('dialog')
    // Mid-read: the file being read stays the one; no second read starts.
    expect(dropFile(within(sheet).getByLabelText(/Release notes/))).toEqual({
      prevented: true,
      effect: 'none',
    })
    release()
    expect(await within(sheet).findByText('com.example.app')).toBeInTheDocument()
    expect(scripted.reads).toBe(1)

    // Read: replacing it takes the X first, rather than a file dropped by mistake.
    expect(dropFile(within(sheet).getByLabelText(/App name/))).toEqual({
      prevented: true,
      effect: 'none',
    })
    await settle()
    expect(scripted.reads).toBe(1)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    menu('Droid App', 'Edit name and notes')
    const edit = await screen.findByRole('dialog')
    expect(dropFile(within(edit).getByLabelText(/Release notes/))).toEqual({
      prevented: true,
      effect: 'none',
    })
    await settle()
    expect(scripted.reads).toBe(1)
    expect(within(edit).getByRole('button', { name: 'Save & publish' })).toBeDisabled()
  })
})

describe('editing', () => {
  it('saves new notes over the install page, and nothing when nothing changed', async () => {
    const repo = fakeRepo(TWO)
    renderPage(repo)
    await screen.findByText('Droid App')
    menu('Droid App', 'Edit name and notes')
    const sheet = await screen.findByRole('dialog')
    const save = within(sheet).getByRole('button', { name: 'Save & publish' })
    expect(save).toBeDisabled()
    fireEvent.change(within(sheet).getByLabelText(/Release notes/), {
      target: { value: 'Try the new login.' },
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(repo.commits).toHaveLength(1)
    })
    const plan = committed(repo)
    expect(plan.message).toBe('Edit build: droid')
    expect(plan.deletes).toEqual([])
    expect(plan.writes?.map((w) => w.path)).toEqual(['build/droid/index.html', BUILD_DB_PATH])
    expect(writtenDb(plan).entries[0]?.notes).toBe('Try the new login.')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('refuses to save over a build changed elsewhere since the sheet opened', async () => {
    const repo = fakeRepo(TWO)
    renderPage(repo)
    await screen.findByText('Droid App')
    menu('Droid App', 'Edit name and notes')
    const sheet = await screen.findByRole('dialog')
    // Another device saves first.
    repo.files.set(
      BUILD_DB_PATH,
      JSON.stringify({ ...TWO, entries: [{ ...DROID, notes: 'Theirs' }, APPLE] }),
    )
    fireEvent.change(within(sheet).getByLabelText(/Release notes/), { target: { value: 'Mine' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save & publish' }))
    expect(await within(sheet).findByText(/was changed elsewhere/)).toBeInTheDocument()
    expect(repo.commits).toEqual([])
  })
})
