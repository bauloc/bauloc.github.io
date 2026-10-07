// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/lib/locale'

import { ConsoleContext } from '../console-context'
import { isBlobWrite, type CommitPlan, type Repo, type RepoEntry } from '../repo/github'
import { ArtifactsPage } from './artifacts-page'
import {
  parseArtifactDb,
  servedHtml,
  utf8Length,
  type ArtifactDraft,
  type ArtifactEntry,
} from './model'
import {
  PREVIEW_ALLOW,
  PREVIEW_SANDBOX_FLAGS,
  SANDBOX_FLAGS,
  artifactSource,
} from './templates/wrapper'

/*
  The module as the owner meets it, against a repository held in memory: the list and its
  states, uploading pasted HTML (small, and large enough to go up as a blob first) or a file,
  the safeguards around an upload under way, editing over the served file, the conflicts that
  refuse a publish, downloading, and deleting.
*/

beforeAll(() => {
  // Radix's Switch measures itself, and the sheet scrolls its problems into view: jsdom has
  // neither ResizeObserver nor Element.scrollTo.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (typeof Element.prototype.scrollTo !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      value: () => undefined,
    })
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The default elsewhere; a test that switches to Vietnamese must not leak it.
  setLocale('en')
})

/** A repository in memory: files by path, blobs by sha, and every commit made. */
function memoryRepo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const blobs = new Map<string, string>()
  const commits: CommitPlan[] = []
  const repo: Repo = {
    head: () => Promise.resolve(`head-${String(commits.length)}`),
    read: (path) => Promise.resolve(files.get(path) ?? null),
    list: (path) => {
      const entries: RepoEntry[] = [...files.keys()]
        .filter((p) => p.startsWith(`${path}/`))
        .map((p) => ({ name: p.slice(path.length + 1), path: p, type: 'file', size: 1 }))
      return Promise.resolve(entries.length > 0 ? entries : null)
    },
    upload: async (data, options) => {
      const sha = `blob-${String(blobs.size)}`
      blobs.set(sha, await data.text())
      options?.onProgress?.(1)
      return sha
    },
    commit: (plan) => {
      commits.push(plan)
      for (const write of plan.writes ?? []) {
        files.set(write.path, isBlobWrite(write) ? (blobs.get(write.sha) ?? '') : write.content)
      }
      for (const path of plan.deletes ?? []) files.delete(path)
      return Promise.resolve()
    },
  }
  return { repo, files, blobs, commits }
}

function renderPage(repo: Repo) {
  render(
    <ConsoleContext.Provider value={{ repo, mock: false, openSettings: vi.fn() }}>
      <ArtifactsPage />
    </ConsoleContext.Provider>,
  )
}

const entry = (overrides: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  id: 'abc12345',
  title: 'Old title',
  file_name: 'old.html',
  size: 40,
  sandbox: true,
  created_at: '2026-10-01T01:00:00Z',
  updated_at: '2026-10-01T01:00:00Z',
  ...overrides,
})

const OLD_PAGE = '<!DOCTYPE html><title>Old</title><p>old page</p>'

/** The files that publish `served` with OLD_PAGE as its page: its index and its served file. */
function publishedFiles(served: ArtifactEntry): Record<string, string> {
  const draft: ArtifactDraft = {
    id: served.id,
    title: served.title,
    source: OLD_PAGE,
    file_name: served.file_name,
    sandbox: served.sandbox,
  }
  return {
    'data/artifact/db.json': JSON.stringify({ version: 1, entries: [served] }),
    [`artifact/${served.id}.html`]: servedHtml(draft),
  }
}

/** A repository already serving one artifact, with its index. */
function publishedRepo(served = entry()) {
  return memoryRepo(publishedFiles(served))
}

/** A file as the picker or a drop hands it over. */
const htmlFile = (parts: BlobPart[], name = 'dropped.html') =>
  new File(parts, name, { type: 'text/html' })

/** A file let go on `target`, the way a browser fires it; false when the page took the drop. */
const dropFile = (target: Element, file: File) =>
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [file] } })

/** '<title>café<' saved as windows-1252 / ISO-8859-1, where é is the one byte 0xE9: not UTF-8. */
const CAFE_LATIN1 = new Uint8Array([...new TextEncoder().encode('<title>caf'), 0xe9, 0x3c])

/**
 * The blobs the page turns into object URLs, in place of the browser's own, until `restore`
 * puts back whatever was there before (jsdom has a createObjectURL, and no revokeObjectURL).
 */
function captureObjectUrls() {
  const blobs: Blob[] = []
  const names = ['createObjectURL', 'revokeObjectURL'] as const
  const before = names.map((name) => Object.getOwnPropertyDescriptor(URL, name))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob)
      return `blob:captured-${String(blobs.length)}`
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
  const restore = () => {
    names.forEach((name, i) => {
      const descriptor = before[i]
      if (descriptor) Object.defineProperty(URL, name, descriptor)
      else Reflect.deleteProperty(URL, name)
    })
  }
  return { blobs, restore }
}

async function openUploadSheet(names = { upload: 'Upload HTML', sheet: 'Upload an HTML page' }) {
  const upload = await screen.findByRole('button', { name: names.upload })
  await waitFor(() => {
    expect(upload).toBeEnabled()
  })
  fireEvent.click(upload)
  return screen.findByRole('dialog', { name: names.sheet })
}

function paste(sheet: HTMLElement, html: string) {
  fireEvent.mouseDown(within(sheet).getByRole('tab', { name: /Paste HTML/ }))
  fireEvent.change(within(sheet).getByLabelText('HTML to publish'), { target: { value: html } })
}

async function openMenuItem(title: string, item: string) {
  fireEvent.keyDown(await screen.findByRole('button', { name: `Actions for ${title}` }), {
    key: 'Enter',
  })
  fireEvent.keyDown(await screen.findByRole('menuitem', { name: item }), { key: 'Enter' })
}

describe('the list', () => {
  it('is empty, ready for a first page, when the site has never had an artifact', async () => {
    renderPage(memoryRepo().repo)
    expect(await screen.findByText('No artifacts yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload HTML' })).toBeEnabled()
  })

  it('refuses to publish when the index is lost while pages are still served', async () => {
    renderPage(memoryRepo({ 'artifact/abc12345.html': '<p>x</p>' }).repo)
    expect(await screen.findByText('The artifact index was not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload HTML' })).toBeDisabled()
  })

  it('shows each artifact with how it runs and its link', async () => {
    const full = entry({ id: 'full0001', title: 'Trusted tool', sandbox: false })
    const { repo } = memoryRepo({
      'data/artifact/db.json': JSON.stringify({ version: 1, entries: [entry(), full] }),
    })
    renderPage(repo)
    expect(await screen.findByText('Old title')).toBeInTheDocument()
    expect(screen.getByText('Trusted tool')).toBeInTheDocument()
    expect(screen.getByText('Sandboxed', { selector: '[data-slot=badge]' })).toBeInTheDocument()
    expect(screen.getByText('Full page')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'bauloc.github.io/artifact/abc12345.html' }),
    ).toHaveAttribute('href', 'https://bauloc.github.io/artifact/abc12345.html')
  })
})

describe('uploading', () => {
  it('publishes pasted HTML in one commit, titled from the page, and lists it first', async () => {
    const { repo, files, commits } = publishedRepo()
    renderPage(repo)
    const sheet = await openUploadSheet()
    paste(sheet, '<!DOCTYPE html><title>Pasted &amp; ready</title><p>new</p>')
    expect(within(sheet).getByLabelText(/^Title/)).toHaveValue('Pasted & ready')
    const id = within(sheet).getByLabelText<HTMLInputElement>(/^Link/).value
    expect(id).toMatch(/^[a-z0-9]{8}$/)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ message: `Add artifact: ${id}`, parent: 'head-0' })
    expect(commits[0]!.writes?.map((w) => w.path)).toEqual([
      `artifact/${id}.html`,
      'data/artifact/db.json',
    ])
    expect(artifactSource(files.get(`artifact/${id}.html`) ?? '', true)).toBe(
      '<!DOCTYPE html><title>Pasted &amp; ready</title><p>new</p>',
    )
    const db = parseArtifactDb(files.get('data/artifact/db.json') ?? '')
    expect(db.entries.map((e) => e.title)).toEqual(['Pasted & ready', 'Old title'])
    const cards = await screen.findAllByRole('button', { name: /^Actions for / })
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Actions for Pasted & ready',
      'Actions for Old title',
    ])
  })

  it('previews the page in a frame that can never share the console origin', async () => {
    renderPage(memoryRepo().repo)
    const sheet = await openUploadSheet()
    paste(sheet, '<p>preview me</p>')
    const frame = await within(sheet).findByTitle('Preview of Untitled page')
    expect(frame).toHaveAttribute('sandbox', PREVIEW_SANDBOX_FLAGS)
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toContain('<p>preview me</p>')
    // Nor any device a grant to the site would hand it, while it is only being looked at.
    expect(frame).toHaveAttribute('allow', PREVIEW_ALLOW)
  })

  it('opens the preview in a tab of its own as the wrapper, never the raw page, with no device', async () => {
    const urls = captureObjectUrls()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderPage(memoryRepo().repo)
      const sheet = await openUploadSheet()
      paste(sheet, '<title>Mine</title><p>raw</p>')
      fireEvent.click(within(sheet).getByRole('button', { name: 'Open preview in new tab' }))
      expect(open).toHaveBeenCalledWith('blob:captured-1', '_blank', 'noopener')
      const html = (await urls.blobs[0]?.text()) ?? ''
      expect(artifactSource(html, true)).toBe('<title>Mine</title><p>raw</p>')
      const frame = /<iframe\b[^>]*>/.exec(html)?.[0] ?? ''
      expect(frame).toContain(`sandbox="${SANDBOX_FLAGS}"`)
      // The tab is a blob: of the console's own origin, which the site's grants would reach.
      expect(frame).toContain(`allow="${PREVIEW_ALLOW}"`)
      // Never the link's own storage key: a draft's preview must not touch the live page's.
      expect(frame).toContain('data-id="(preview)"')
    } finally {
      urls.restore()
    }
  })

  it('says where the title comes from: the page, else the file name', async () => {
    renderPage(memoryRepo().repo)
    const sheet = await openUploadSheet()
    expect(
      within(sheet).getByText(
        "Taken from the page's <title>, or else the file name; change it freely.",
      ),
    ).toBeInTheDocument()
    dropFile(
      within(sheet).getByRole('button', { name: /Drop an HTML file here/ }),
      htmlFile(['<p>untitled</p>'], 'q3-report.html'),
    )
    await waitFor(() => {
      expect(within(sheet).getByLabelText(/^Title/)).toHaveValue('q3-report')
    })
  })

  it('uploads a large page first, then places it by its blob', async () => {
    const { repo, blobs, commits } = memoryRepo()
    renderPage(repo)
    const sheet = await openUploadSheet()
    const big = `<!DOCTYPE html><title>Big</title><p>${'x'.repeat(600 * 1024)}</p>`
    paste(sheet, big)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    await waitFor(() => {
      expect(commits).toHaveLength(1)
    })
    expect(blobs.size).toBe(1)
    const placed = commits[0]!.writes?.[0]
    expect(placed && isBlobWrite(placed) ? placed.sha : null).toBe('blob-0')
    expect(artifactSource([...blobs.values()][0] ?? '', true)).toBe(big)
  })

  it('warns before serving a page without the sandbox', async () => {
    renderPage(memoryRepo().repo)
    const sheet = await openUploadSheet()
    const sandbox = within(sheet).getByRole('switch', { name: /Run in a sandbox/ })
    expect(sandbox).toBeChecked()
    expect(within(sheet).queryByText(/including the XConsole token/)).not.toBeInTheDocument()
    fireEvent.click(sandbox)
    expect(sandbox).not.toBeChecked()
    expect(within(sheet).getByText(/including the XConsole token/)).toBeInTheDocument()
  })

  it('refuses a link already in use, and an empty page', async () => {
    const { repo, commits } = memoryRepo({
      'data/artifact/db.json': '{"version":1,"entries":[]}',
      'artifact/taken1.html': '<p>by hand</p>',
    })
    renderPage(repo)
    const sheet = await openUploadSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Choose an HTML file or paste the HTML',
    )
    paste(sheet, '<title>Mine</title>')
    fireEvent.change(within(sheet).getByLabelText(/^Link/), { target: { value: 'Taken1' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'The link "taken1" is already in use.',
    )
    expect(commits).toEqual([])
  })

  it('refuses a link the list already shows before uploading anything', async () => {
    const { repo, commits } = publishedRepo(entry({ id: 'report' }))
    const upload = vi.spyOn(repo, 'upload')
    renderPage(repo)
    const sheet = await openUploadSheet()
    paste(sheet, `<title>Big</title><p>${'x'.repeat(600 * 1024)}</p>`)
    fireEvent.change(within(sheet).getByLabelText(/^Link/), { target: { value: 'report' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'The link "report" is already in use. Choose another.',
    )
    expect(upload).not.toHaveBeenCalled()
    expect(commits).toEqual([])
  })

  it('cannot be closed, left or handed a file while the page goes up, until Cancel', async () => {
    const { repo, commits } = memoryRepo()
    let cancelled = false
    repo.upload = (_data, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          cancelled = true
          reject(new DOMException('The upload was cancelled.', 'AbortError'))
        })
      })
    renderPage(repo)
    const sheet = await openUploadSheet()
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    paste(sheet, `<title>Big</title><p>${'x'.repeat(600 * 1024)}</p>`)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    const cancel = await within(sheet).findByRole('button', { name: 'Cancel upload' })

    // The X that would do nothing is gone, and leaving the page asks first.
    expect(within(sheet).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
    // A file let go now is refused, not opened over the console, and not taken either.
    fireEvent.mouseDown(within(sheet).getByRole('tab', { name: /File/ }))
    expect(dropFile(within(sheet).getByLabelText(/^Title/), htmlFile(['<p>late</p>']))).toBe(false)

    fireEvent.click(cancel)
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })
    expect(cancelled).toBe(true)
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    expect(within(sheet).queryByText('dropped.html')).not.toBeInTheDocument()
    expect(commits).toEqual([])
  })

  it('takes a file let go beside the drop zone, and refuses one where none is taken', async () => {
    renderPage(memoryRepo().repo)
    const sheet = await openUploadSheet()
    const title = within(sheet).getByLabelText(/^Title/)
    expect(dropFile(title, htmlFile(['<title>Dropped beside</title><p>x</p>']))).toBe(false)
    expect(await within(sheet).findByText('dropped.html')).toBeInTheDocument()
    await waitFor(() => {
      expect(title).toHaveValue('Dropped beside')
    })

    // The Paste tab has no zone: the drop is refused, and the page stays as pasted.
    paste(sheet, '<title>Pasted</title>')
    expect(dropFile(within(sheet).getByLabelText('HTML to publish'), htmlFile(['<p>no</p>']))).toBe(
      false,
    )
    expect(within(sheet).getByLabelText('HTML to publish')).toHaveValue('<title>Pasted</title>')
    expect(title).toHaveValue('Pasted')
  })

  it('refuses a file not saved as UTF-8 rather than publish it garbled', async () => {
    const { repo, commits } = memoryRepo()
    renderPage(repo)
    const sheet = await openUploadSheet()
    dropFile(
      within(sheet).getByRole('button', { name: /Drop an HTML file here/ }),
      htmlFile([CAFE_LATIN1], 'cafe.html'),
    )
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'This file is not saved as UTF-8, so its text would come out garbled. Save it as UTF-8 in your editor, then choose it again.',
    )
    expect(within(sheet).queryByText('cafe.html')).not.toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Choose an HTML file or paste the HTML',
    )
    expect(commits).toEqual([])
  })

  it('says why in Vietnamese when the console speaks Vietnamese', async () => {
    setLocale('vi')
    renderPage(memoryRepo().repo)
    const sheet = await openUploadSheet({ upload: 'Tải lên HTML', sheet: 'Tải lên trang HTML' })
    // Let go beside the zone this time: the stray drop is read the same way.
    dropFile(within(sheet).getByLabelText(/^Tiêu đề/), htmlFile([CAFE_LATIN1], 'cafe.html'))
    const alert = await within(sheet).findByRole('alert')
    expect(alert).toHaveTextContent(
      'File này không được lưu ở dạng UTF-8 nên chữ sẽ bị lỗi. Hãy lưu lại file ở dạng UTF-8 trong trình soạn thảo rồi chọn lại.',
    )
    expect(alert).not.toHaveTextContent('not saved as UTF-8')
    expect(within(sheet).queryByText('cafe.html')).not.toBeInTheDocument()
  })
})

describe('editing', () => {
  it('publishes over the served file, keeping the link and the page', async () => {
    const { repo, files, commits } = publishedRepo()
    renderPage(repo)
    await openMenuItem('Old title', 'Edit')
    const sheet = await screen.findByRole('dialog', { name: 'Edit artifact' })
    const title = await within(sheet).findByLabelText(/^Title/)
    expect(title).toHaveValue('Old title')
    expect(within(sheet).getByLabelText(/^Link/)).toBeDisabled()
    // An edit keeps its title whatever the page says, so no hint claims otherwise.
    expect(within(sheet).queryByText(/Taken from the page's <title>/)).not.toBeInTheDocument()
    fireEvent.change(title, { target: { value: 'New title' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save & publish' }))
    await waitFor(() => {
      expect(commits).toHaveLength(1)
    })
    expect(commits[0]!.message).toBe('Update artifact: abc12345')
    const served = files.get('artifact/abc12345.html') ?? ''
    expect(artifactSource(served, true)).toBe(OLD_PAGE)
    expect(served).toContain('<title>New title</title>')
    expect(parseArtifactDb(files.get('data/artifact/db.json') ?? '').entries[0]).toMatchObject({
      id: 'abc12345',
      title: 'New title',
      file_name: 'old.html',
      created_at: '2026-10-01T01:00:00Z',
    })
  })

  it('refuses to publish over a page that changed since it was opened', async () => {
    const { repo, files, commits } = publishedRepo()
    renderPage(repo)
    await openMenuItem('Old title', 'Edit')
    const sheet = await screen.findByRole('dialog', { name: 'Edit artifact' })
    await within(sheet).findByLabelText(/^Title/)
    files.set('artifact/abc12345.html', '<p>changed in another tab</p>')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save & publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('was changed elsewhere')
    expect(commits).toEqual([])
  })

  it('refuses to undo a rename made elsewhere to a full page, whose file did not change', async () => {
    const full = entry({ sandbox: false })
    const { repo, files, commits } = publishedRepo(full)
    renderPage(repo)
    await openMenuItem('Old title', 'Edit')
    const sheet = await screen.findByRole('dialog', { name: 'Edit artifact' })
    await within(sheet).findByLabelText(/^Title/)
    // Another tab renames it: a full page is served as itself, so only the index changes.
    const renamed = { ...full, title: 'Renamed elsewhere', updated_at: '2026-10-07T02:00:00Z' }
    files.set('data/artifact/db.json', JSON.stringify({ version: 1, entries: [renamed] }))
    paste(sheet, '<p>new page</p>')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save & publish' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('was changed elsewhere')
    expect(commits).toEqual([])
    // The list behind (hidden from the accessibility tree while the sheet is open) shows the
    // rename, so the next edit starts from it.
    expect(await screen.findByText('Renamed elsewhere')).toBeInTheDocument()
  })

  it('opens a page from its entry as it is now, not from a list older than a sandbox switch', async () => {
    // The list is read while the page is served as itself...
    const { repo, files, commits } = publishedRepo(entry({ sandbox: false }))
    renderPage(repo)
    expect(await screen.findByText('Full page')).toBeInTheDocument()
    // ...then another tab turns the sandbox on, and the served file becomes the wrapper.
    for (const [path, text] of Object.entries(publishedFiles(entry({ sandbox: true })))) {
      files.set(path, text)
    }
    await openMenuItem('Old title', 'Edit')
    const sheet = await screen.findByRole('dialog', { name: 'Edit artifact' })
    expect(await within(sheet).findByRole('switch', { name: /Run in a sandbox/ })).toBeChecked()
    expect(screen.getByText('Sandboxed', { selector: '[data-slot=badge]' })).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save & publish' }))
    await waitFor(() => {
      expect(commits).toHaveLength(1)
    })
    // The page inside, once: never the wrapper published as the page, nor wrapped twice.
    expect(artifactSource(files.get('artifact/abc12345.html') ?? '', true)).toBe(OLD_PAGE)
    expect(parseArtifactDb(files.get('data/artifact/db.json') ?? '').entries[0]).toMatchObject({
      sandbox: true,
      size: utf8Length(OLD_PAGE),
    })
  })

  it('drops a page deleted elsewhere from the list instead of opening it', async () => {
    const { repo, files } = publishedRepo()
    renderPage(repo)
    await screen.findByText('Old title')
    files.set('data/artifact/db.json', '{"version":1,"entries":[]}')
    files.delete('artifact/abc12345.html')
    await openMenuItem('Old title', 'Edit')
    expect(await screen.findByText('No artifacts yet')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('downloading', () => {
  it('saves the page itself, read with its entry as it is now', async () => {
    const urls = captureObjectUrls()
    const saved = urls.blobs
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      // Listed as a full page; another tab has since turned the sandbox on.
      const { repo, files } = publishedRepo(entry({ sandbox: false }))
      renderPage(repo)
      await screen.findByText('Full page')
      for (const [path, text] of Object.entries(publishedFiles(entry({ sandbox: true })))) {
        files.set(path, text)
      }
      await openMenuItem('Old title', 'Download HTML')
      await waitFor(() => {
        expect(click).toHaveBeenCalledTimes(1)
      })
      expect(await saved[0]?.text()).toBe(OLD_PAGE)
    } finally {
      urls.restore()
    }
  })
})

describe('deleting', () => {
  it('removes the page and its entry in one commit, after asking', async () => {
    const { repo, files, commits } = publishedRepo()
    renderPage(repo)
    await openMenuItem('Old title', 'Delete')
    const alert = await screen.findByRole('alertdialog', { name: 'Delete Old title?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(commits).toHaveLength(1)
    })
    expect(commits[0]).toMatchObject({
      message: 'Delete artifact: abc12345',
      deletes: ['artifact/abc12345.html'],
    })
    expect(files.has('artifact/abc12345.html')).toBe(false)
    expect(await screen.findByText('No artifacts yet')).toBeInTheDocument()
  })
})
