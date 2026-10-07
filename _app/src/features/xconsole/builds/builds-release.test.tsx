// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConsoleContext } from '../console-context'
import {
  isBlobWrite,
  type CommitPlan,
  type ReleaseAsset,
  type ReleaseInput,
  type Releases,
  type Repo,
  type RepoEntry,
} from '../repo/github'
import { BuildsPage } from './builds-page'
import type * as HelperModule from './helper'
import {
  HelperUploadError,
  pairHelper,
  probeHelper,
  uploadViaHelper,
  type HelperProbe,
  type HelperUpload,
  type ReadyHelper,
} from './helper'
import { EMPTY_BUILD_DB, entryFromInspection, parseBuildDb } from './model'
import { BUILD_DB_PATH, RELEASE_DOWNLOAD_BASE } from './paths'
import type { BuildDb, BuildEntry, BuildInspection } from './types'

/*
  Builds of 100 MiB or more, as the owner publishes them: the binary goes to a GitHub Release
  made for it — through the Device Lab helper, or the dev mock's own releases — and the commit
  records the release. Everything a failure or a Cancel leaves behind is deleted again, and so
  is the release of a version replaced or deleted. Reading the file is scripted, as is the
  helper (helper.test.ts has its own tests); the sheet, the page and the model are the real ones.
*/

const scripted = vi.hoisted(() => ({
  inspection: null as BuildInspection | null,
  icon: null as Blob | null,
}))

vi.mock('./inspect', () => ({
  inspectBuild: () => Promise.resolve(scripted.inspection),
}))

vi.mock('./inspect/icon', () => ({
  renderIconPng: () => Promise.resolve(scripted.icon),
}))

vi.mock('./helper', async (importOriginal) => ({
  ...(await importOriginal<typeof HelperModule>()),
  probeHelper: vi.fn(),
  pairHelper: vi.fn(),
  uploadViaHelper: vi.fn(),
}))

const MiB = 1024 * 1024
const PAT = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
const TOKEN = 'abcdefghijABCDEFGHIJ0123456789_-abcdefghijk'
const READY: ReadyHelper = { state: 'ready', version: '1.4.0', port: 8787, token: TOKEN }

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

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: () => undefined,
    configurable: true,
  })
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:icon', configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true })
})

beforeEach(() => {
  scripted.inspection = ANDROID
  scripted.icon = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
  window.localStorage.setItem('xconsole_pat', PAT)
  vi.mocked(probeHelper).mockResolvedValue(READY)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(probeHelper).mockReset()
  vi.mocked(pairHelper).mockReset()
  vi.mocked(uploadViaHelper).mockReset()
  window.localStorage.clear()
})

/* ---------------------------------------------------------------- *
 * A repository with releases, in memory
 * ---------------------------------------------------------------- */

interface FakeRelease extends ReleaseInput {
  readonly assets: string[]
}

/**
 * Files, commits and releases in memory, and one log of what reached "GitHub" in order —
 * releases, tags, assets, commits — and of each look for the helper.
 */
function releaseRepo(db: BuildDb | null, dirs: Record<string, RepoEntry[]> = {}) {
  const files = new Map<string, string>()
  if (db) files.set(BUILD_DB_PATH, JSON.stringify(db))
  const commits: CommitPlan[] = []
  const uploads: Blob[] = []
  const releases = new Map<number, FakeRelease>()
  const tags = new Set<string>()
  const log: string[] = []
  let nextId = 500
  const repo: Repo & Releases = {
    head: () => Promise.resolve('head-1'),
    read: (path) => Promise.resolve(files.get(path) ?? null),
    list: (path) => Promise.resolve(dirs[path] ?? null),
    upload: (data) => {
      uploads.push(data)
      return Promise.resolve(`blob-${String(uploads.length)}`)
    },
    commit: (plan) => {
      log.push(`commit ${plan.message}`)
      commits.push(plan)
      for (const write of plan.writes ?? []) {
        if (!isBlobWrite(write)) files.set(write.path, write.content)
      }
      return Promise.resolve()
    },
    createRelease: (input) => {
      const id = nextId++
      log.push(`create ${String(id)} ${input.tag}`)
      releases.set(id, { ...input, assets: [] })
      tags.add(input.tag)
      return Promise.resolve({ id })
    },
    deleteRelease: (id) => {
      log.push(`delete release ${String(id)}`)
      releases.delete(id)
      return Promise.resolve()
    },
    deleteTag: (tag) => {
      log.push(`delete tag ${tag}`)
      tags.delete(tag)
      return Promise.resolve()
    },
    uploadReleaseAsset: (release, name, data, options) => {
      log.push(`asset ${String(release)} ${name}`)
      options?.onProgress?.(0.5)
      const made = releases.get(release)
      if (!made) return Promise.reject(new Error('no release'))
      made.assets.push(name)
      return Promise.resolve(assetOf(made.tag, name, data.size))
    },
  }
  return { repo, files, commits, uploads, releases, tags, log }
}

type Fake = ReturnType<typeof releaseRepo>

const assetOf = (tag: string, name: string, size: number): ReleaseAsset => ({
  id: 900,
  name,
  size,
  url: `${RELEASE_DOWNLOAD_BASE}${tag}/${name}`,
})

/** The helper as the sheet meets it: each look and each upload logged with the repo's calls. */
function scriptHelper(fake: Fake, looks: HelperProbe[] = [READY]) {
  let at = 0
  vi.mocked(probeHelper).mockImplementation(() => {
    fake.log.push('probe')
    const found = looks[Math.min(at, looks.length - 1)] ?? READY
    at++
    return Promise.resolve(found)
  })
  vi.mocked(uploadViaHelper).mockImplementation((upload: HelperUpload) => {
    fake.log.push(`helper upload ${String(upload.releaseId)} ${upload.name}`)
    const release = fake.releases.get(upload.releaseId)
    if (!release) return Promise.reject(new Error('no release'))
    return Promise.resolve(assetOf(release.tag, upload.name, upload.file.size))
  })
}

function renderPage(repo: Repo, mock = false) {
  const openSettings = vi.fn()
  render(
    <ConsoleContext.Provider value={{ repo, mock, openSettings }}>
      <BuildsPage />
    </ConsoleContext.Provider>,
  )
  return { openSettings }
}

/** A build file that says it is `size` bytes long: no test writes 150 MB. */
function bigFile(size = 150 * MiB, name = 'app-release.apk'): File {
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  fireEvent.change(input, { target: { files: [file] } })
}

/** Opens the sheet for a new build, reads `file` into it and names its link. */
async function openWith(file: File, link = 'big-link') {
  fireEvent.click(await screen.findByRole('button', { name: /Upload (the first )?build/ }))
  chooseFile(file)
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByText('com.example.app')
  fireEvent.change(within(sheet).getByLabelText(/^Link/), { target: { value: link } })
  return sheet
}

function menu(buildName: string, item: string) {
  const trigger = screen.getByRole('button', { name: `Actions for ${buildName}` })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

const writtenDb = (plan: CommitPlan | undefined) => {
  const write = plan?.writes?.find((w) => w.path === BUILD_DB_PATH)
  if (!write || isBlobWrite(write)) throw new Error('no index written')
  return parseBuildDb(write.content)
}

const TAG = /^build-big-link-\d{14}$/

/* ---------------------------------------------------------------- *
 * Publishing
 * ---------------------------------------------------------------- */

describe('publishing a build of 100 MB or more', () => {
  it('in the dev mock: makes a release, stores the file there, and commits no binary', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    renderPage(fake.repo, true)
    const sheet = await openWith(bigFile())
    expect(within(sheet).getByText(/so it goes to GitHub Releases instead/)).toBeInTheDocument()
    expect(within(sheet).getByText(/simulated GitHub Release/)).toBeInTheDocument()
    expect(within(sheet).queryByText(/already in the repository’s history/)).toBeNull()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('Build published')).toBeInTheDocument()

    // The mock never uses the helper.
    expect(probeHelper).not.toHaveBeenCalled()
    expect(uploadViaHelper).not.toHaveBeenCalled()
    expect(fake.log).toEqual([
      expect.stringMatching(/^create 500 build-big-link-\d{14}$/),
      'asset 500 my-app-1.2.0-45.apk',
      'commit Add build: big-link (My App 1.2.0 (45))',
    ])
    // Only the icon went up as a blob.
    expect(fake.uploads.map((b) => b.size)).toEqual([4])
    const plan = fake.commits[0]
    expect(plan?.writes?.map((w) => w.path)).toEqual([
      'build/big-link/icon.png',
      'build/big-link/index.html',
      BUILD_DB_PATH,
    ])
    const [entry] = writtenDb(plan).entries
    expect(entry).toMatchObject({ size: 150 * MiB, release: { id: 500, asset_id: 900 } })
    expect(entry?.release?.tag).toMatch(TAG)
    expect(fake.files.get('build/big-link/index.html')).toContain(
      `href="${RELEASE_DOWNLOAD_BASE}${entry?.release?.tag ?? ''}/my-app-1.2.0-45.apk"`,
    )
    expect(fake.releases.get(500)).toMatchObject({
      name: 'My App 1.2.0 (45)',
      body: 'Install page: https://bauloc.github.io/build/big-link/',
      assets: ['my-app-1.2.0-45.apk'],
    })
  })

  it('waits for the helper, then proves it again and sends the file through it', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake, [{ state: 'missing', reason: 'absent', port: 8787 }, READY])
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.mocked(uploadViaHelper).mockImplementation(async (upload: HelperUpload) => {
      fake.log.push(`helper upload ${String(upload.releaseId)} ${upload.name}`)
      upload.onProgress?.(0.5)
      await gate
      const release = fake.releases.get(upload.releaseId)
      return assetOf(release?.tag ?? '', upload.name, upload.file.size)
    })
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())

    // Nothing answers yet: the command to start it, and Publish waits.
    expect(await within(sheet).findByText('Start the helper on this Mac:')).toBeInTheDocument()
    expect(
      within(sheet).getByText(
        'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
      ),
    ).toBeInTheDocument()
    expect(within(sheet).getByText(/Chrome may ask to let this page reach apps/)).toBeVisible()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()

    // Started: Check again finds it ready.
    fireEvent.click(within(sheet).getByRole('button', { name: /Check again/ }))
    expect(
      await within(sheet).findByText('Helper 1.4.0 connected — the file goes to GitHub Releases.'),
    ).toBeInTheDocument()
    const publish = within(sheet).getByRole('button', { name: 'Publish' })
    expect(publish).toBeEnabled()
    fireEvent.click(publish)

    expect(
      await within(sheet).findByText(
        'Uploading to GitHub Releases through the helper… 75 of 150 MB · 50%',
      ),
    ).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: /Cancel upload/ })).toBeInTheDocument()
    finish()
    expect(await within(sheet).findByText('Build published')).toBeInTheDocument()

    // The release first, then a fresh proof, and only then the file with the owner's token.
    expect(fake.log.slice(-4)).toEqual([
      expect.stringMatching(/^create 500 build-big-link-\d{14}$/),
      'probe',
      'helper upload 500 my-app-1.2.0-45.apk',
      'commit Add build: big-link (My App 1.2.0 (45))',
    ])
    expect(uploadViaHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 8787,
        token: TOKEN,
        pat: PAT,
        releaseId: 500,
        name: 'my-app-1.2.0-45.apk',
        contentType: 'application/vnd.android.package-archive',
      }),
    )
    expect(writtenDb(fake.commits[0]).entries[0]?.release).toMatchObject({ id: 500, asset_id: 900 })
  })

  it('pairs from the link the helper printed, pasted in the card', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake, [{ state: 'unpaired', version: '1.4.0', port: 8787 }])
    vi.mocked(pairHelper).mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      port: 8787,
      tokenId: '4d1566a1',
    })
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    const input = await within(sheet).findByLabelText('The helper’s link or token')
    fireEvent.change(input, { target: { value: 'https://bauloc.github.io/device/#pair=old' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'That token is from another run of the helper. This helper’s fingerprint is 4d1566a1',
    )
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()

    vi.mocked(pairHelper).mockResolvedValueOnce({ ok: true, helper: READY })
    // Paired, the helper holds this page's token: a look from then on finds it ready.
    scriptHelper(fake, [READY])
    fireEvent.change(input, { target: { value: 'https://bauloc.github.io/device/#pair=new' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair' }))
    expect(await within(sheet).findByText(/Helper 1\.4\.0 connected/)).toBeInTheDocument()
    expect(pairHelper).toHaveBeenLastCalledWith('https://bauloc.github.io/device/#pair=new')
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeEnabled()
  })

  it('looks again when the owner comes back from Terminal, keeping what is typed in the card', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake, [{ state: 'missing', reason: 'absent', port: 8787 }])
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    await within(sheet).findByText('Start the helper on this Mac:')

    // Started in Terminal, which opened Device Lab; back here, it is running but unpaired.
    scriptHelper(fake, [{ state: 'unpaired', version: '1.4.0', port: 8787 }])
    fireEvent.focus(window)
    const input = await within(sheet).findByLabelText('The helper’s link or token')
    fireEvent.change(input, { target: { value: 'https://bauloc.github.io/device/#pair=' } })

    // Away to copy the link and back: the look is quiet, and the half-pasted link stays.
    const looks = vi.mocked(probeHelper).mock.calls.length
    fireEvent.focus(window)
    await waitFor(() => {
      expect(vi.mocked(probeHelper).mock.calls.length).toBe(looks + 1)
    })
    expect(within(sheet).getByLabelText('The helper’s link or token')).toHaveValue(
      'https://bauloc.github.io/device/#pair=',
    )
    expect(within(sheet).queryByText('Looking for the helper on this Mac…')).toBeNull()
  })

  it('says to update a helper that cannot upload to releases yet', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake, [{ state: 'outdated', version: '1.3.0', port: 8788 }])
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    expect(
      await within(sheet).findByText(
        /This helper \(1\.3\.0\) cannot upload to GitHub Releases yet/,
      ),
    ).toBeInTheDocument()
    expect(within(sheet).getByText(/node ~\/device-bridge\.mjs --port 8788$/)).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  it('deletes the release again when the file could not go up, and commits nothing', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    vi.mocked(uploadViaHelper).mockRejectedValue(new HelperUploadError('UPLOAD_BUSY', 409))
    const failed = vi.spyOn(toast, 'error')
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    await within(sheet).findByText(/Helper 1\.4\.0 connected/)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))

    await waitFor(() => {
      expect(failed).toHaveBeenCalledWith('Publish failed', {
        id: undefined,
        description: 'The helper is already uploading another file. Wait for it to finish.',
      })
    })
    const tag = [...fake.log].find((l) => l.startsWith('create'))?.split(' ')[2] ?? ''
    expect(tag).toMatch(TAG)
    expect(fake.log).toContain('delete release 500')
    expect(fake.log).toContain(`delete tag ${tag}`)
    expect(fake.releases.size).toBe(0)
    expect(fake.tags.size).toBe(0)
    expect(fake.commits).toEqual([])
    // The card looks at the helper again after a failure; once it answers, a retry may start,
    // and makes a release of its own.
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeEnabled()
    })
  })

  it('deletes the release when the upload is cancelled', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    vi.mocked(uploadViaHelper).mockImplementation(
      (upload: HelperUpload) =>
        new Promise((_resolve, reject) => {
          upload.signal?.addEventListener('abort', () => {
            reject(new DOMException('The upload was cancelled.', 'AbortError'))
          })
        }),
    )
    const info = vi.spyOn(toast, 'info')
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    await within(sheet).findByText(/Helper 1\.4\.0 connected/)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    // Once the file is on its way to the release, not while it is still being hashed.
    await waitFor(() => {
      expect(uploadViaHelper).toHaveBeenCalled()
    })
    fireEvent.click(within(sheet).getByRole('button', { name: /Cancel upload/ }))

    await waitFor(() => {
      expect(info).toHaveBeenCalledWith('Upload cancelled', expect.anything())
    })
    expect(fake.log).toContain('delete release 500')
    expect(fake.releases.size).toBe(0)
    expect(fake.tags.size).toBe(0)
    expect(fake.commits).toEqual([])
  })

  it('deletes the release when the commit is refused: the link was taken meanwhile', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    renderPage(fake.repo, true)
    const sheet = await openWith(bigFile())
    // Another tab publishes under the same link while this one uploads.
    const theirs = entryFromInspection({
      inspection: ANDROID,
      id: 'big-link',
      name: 'Theirs',
      notes: '',
      file: 'theirs.apk',
      size: 1,
      sha256: 'ab'.repeat(32),
      icon: false,
      now: '2026-10-01T00:00:00.000Z',
      existing: null,
    })
    fake.files.set(BUILD_DB_PATH, JSON.stringify({ version: 1, entries: [theirs] }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(
      await within(sheet).findByText(
        'The link /build/big-link/ is already in use. Choose another.',
      ),
    ).toBeInTheDocument()
    expect(fake.log.slice(-2)).toEqual([
      'delete release 500',
      expect.stringMatching(/^delete tag build-big-link-\d{14}$/),
    ])
    expect(fake.commits).toEqual([])
  })

  it('says so when a release it made could not be deleted again', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    vi.mocked(uploadViaHelper).mockRejectedValue(new HelperUploadError('GITHUB_UNREACHABLE', 502))
    fake.repo.deleteRelease = () => Promise.reject(new Error('offline'))
    const warned = vi.spyOn(toast, 'warning')
    renderPage(fake.repo)
    const sheet = await openWith(bigFile())
    await within(sheet).findByText(/Helper 1\.4\.0 connected/)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    await waitFor(() => {
      expect(warned).toHaveBeenCalledWith(
        expect.stringMatching(
          /^The unfinished release build-big-link-\d{14} could not be removed\. Delete it on GitHub, under Releases\.$/,
        ),
      )
    })
  })

  it('refuses a file of 2 GB or more outright, and never looks for the helper', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    renderPage(fake.repo)
    const sheet = await openWith(bigFile(2 * 1024 ** 3))
    expect(within(sheet).getByText(/GitHub refuses files of 2 GB or more/)).toBeInTheDocument()
    expect(within(sheet).queryByText('Device Lab helper')).toBeNull()
    expect(within(sheet).getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(probeHelper).not.toHaveBeenCalled()
  })

  it('keeps a build under 100 MB in the repo, as before, without the helper', async () => {
    const fake = releaseRepo(EMPTY_BUILD_DB)
    scriptHelper(fake)
    renderPage(fake.repo)
    const sheet = await openWith(bigFile(60 * MiB))
    expect(within(sheet).queryByText('Device Lab helper')).toBeNull()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('Build published')).toBeInTheDocument()
    expect(fake.log).toEqual(['commit Add build: big-link (My App 1.2.0 (45))'])
    expect(fake.commits[0]?.writes?.[0]).toEqual({
      path: 'build/big-link/my-app-1.2.0-45.apk',
      sha: 'blob-2',
    })
    expect(probeHelper).not.toHaveBeenCalled()
  })
})

/* ---------------------------------------------------------------- *
 * A build whose file is in a release: a new version, and a delete
 * ---------------------------------------------------------------- */

const RELEASE = { id: 42, tag: 'build-big-20261001010000', asset_id: 7 }

const BIG: BuildEntry = {
  ...entryFromInspection({
    inspection: ANDROID,
    id: 'big',
    name: 'Big App',
    notes: '',
    file: 'big-app-1.2.0-45.apk',
    size: 300 * MiB,
    sha256: 'ab'.repeat(32),
    icon: false,
    release: RELEASE,
    now: '2026-10-01T01:00:00.000Z',
    existing: null,
  }),
}

describe('a build whose file is in a release', () => {
  it('marks it in the list, and downloads it from the release', async () => {
    renderPage(releaseRepo({ version: 1, entries: [BIG] }).repo)
    expect(await screen.findByText(/300 MB · GitHub Releases/)).toBeInTheDocument()
    // The Pages site's storage does not count it.
    expect(screen.getByText('0 B')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Actions for Big App' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Download the .apk' })).toHaveAttribute(
      'href',
      `${RELEASE_DOWNLOAD_BASE}${RELEASE.tag}/big-app-1.2.0-45.apk`,
    )
  })

  it('deletes the old release once a new version is published under the link', async () => {
    const fake = releaseRepo({ version: 1, entries: [BIG] })
    scriptHelper(fake)
    renderPage(fake.repo)
    await screen.findByText('Big App')
    menu('Big App', 'Upload new version')
    scriptedVersion('1.3.0', '46')
    chooseFile(bigFile(20 * MiB))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('1.3.0 (46)')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('New version published')).toBeInTheDocument()
    await waitFor(() => {
      expect(fake.log).toEqual([
        'commit Update build: big (Big App 1.3.0 (46))',
        'delete release 42',
        'delete tag build-big-20261001010000',
      ])
    })
    expect(writtenDb(fake.commits[0]).entries[0]?.release).toBeNull()
  })

  it('says so when the old release could not be removed, the new version published all the same', async () => {
    const fake = releaseRepo({ version: 1, entries: [BIG] })
    fake.repo.deleteTag = () => Promise.reject(new Error('offline'))
    const warned = vi.spyOn(toast, 'warning')
    renderPage(fake.repo)
    await screen.findByText('Big App')
    menu('Big App', 'Upload new version')
    scriptedVersion('1.3.0', '46')
    chooseFile(bigFile(20 * MiB))
    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByText('1.3.0 (46)')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByText('New version published')).toBeInTheDocument()
    await waitFor(() => {
      expect(warned).toHaveBeenCalledWith(
        'Published, but the previous version’s release build-big-20261001010000 could not be removed. Delete it on GitHub, under Releases.',
      )
    })
  })

  it('deletes its release and tag after the commit that deletes the build', async () => {
    const fake = releaseRepo(
      { version: 1, entries: [BIG] },
      {
        'build/big': [{ name: 'index.html', path: 'build/big/index.html', type: 'file', size: 1 }],
      },
    )
    renderPage(fake.repo)
    await screen.findByText('Big App')
    menu('Big App', 'Delete')
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/its file from GitHub Releases/)).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(fake.log).toEqual([
        'commit Delete build: big',
        'delete release 42',
        'delete tag build-big-20261001010000',
      ])
    })
    expect(fake.commits[0]?.deletes).toEqual(['build/big/index.html'])
  })

  it('says which release stayed when it could not be deleted', async () => {
    const fake = releaseRepo({ version: 1, entries: [BIG] })
    fake.repo.deleteRelease = () => Promise.reject(new Error('offline'))
    const warned = vi.spyOn(toast, 'warning')
    renderPage(fake.repo)
    await screen.findByText('Big App')
    menu('Big App', 'Delete')
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => {
      expect(warned).toHaveBeenCalledWith(
        'Big App is deleted, but its file’s release build-big-20261001010000 could not be removed. Delete it on GitHub, under Releases.',
      )
    })
    expect(fake.commits).toHaveLength(1)
  })
})

/** The next file read is the same app at another version. */
function scriptedVersion(version: string, build: string) {
  scripted.inspection = { ...ANDROID, version, build }
}
