import { describe, expect, it } from 'vitest'

import type { Repo, RepoEntry } from '../repo/github'
import { PublishedReadError, isServed, loadArtifactDb, loadPublished } from './load'
import { NO_ARTIFACTS, servedHtml, type ArtifactEntry } from './model'

/*
  The one decision every action starts from: is a missing index an empty list, or a lost one?
  Read against a fake repository that records which ref each read asked for.
*/

function fakeRepo(files: Record<string, string>, dirs: Record<string, RepoEntry[]>) {
  const refs: (string | undefined)[] = []
  const repo: Pick<Repo, 'head' | 'read' | 'list'> = {
    head: () => Promise.resolve('head-sha'),
    read: (path, ref) => {
      refs.push(ref)
      return Promise.resolve(files[path] ?? null)
    },
    list: (path, ref) => {
      refs.push(ref)
      return Promise.resolve(dirs[path] ?? null)
    },
  }
  return { repo, refs }
}

const page = (name: string): RepoEntry => ({
  name,
  path: `artifact/${name}`,
  type: 'file',
  size: 100,
})

describe('loadArtifactDb', () => {
  it('reads the index when there is one', async () => {
    const { repo, refs } = fakeRepo(
      { 'data/artifact/db.json': '{"version":1,"entries":[{"id":"a1","sandbox":true}]}' },
      {},
    )
    const db = await loadArtifactDb(repo, 'abc123')
    expect(db?.entries.map((e) => e.id)).toEqual(['a1'])
    expect(refs).toEqual(['abc123'])
  })

  it('counts a missing index as empty while artifact/ serves no page', async () => {
    expect(await loadArtifactDb(fakeRepo({}, {}).repo)).toBe(NO_ARTIFACTS)
    const notPages = fakeRepo({}, { artifact: [{ ...page('notes'), type: 'dir' }, page('a.txt')] })
    expect(await loadArtifactDb(notPages.repo)).toBe(NO_ARTIFACTS)
  })

  it('reports a lost index, at the same ref, when pages are still served', async () => {
    const { repo, refs } = fakeRepo({}, { artifact: [page('k3x9q2mf.html')] })
    expect(await loadArtifactDb(repo, 'abc123')).toBeNull()
    expect(refs).toEqual(['abc123', 'abc123'])
  })

  it('lets an unreadable index fail loudly rather than pass for an empty one', async () => {
    const { repo } = fakeRepo({ 'data/artifact/db.json': '{"version":1}' }, {})
    await expect(loadArtifactDb(repo, undefined, 'en')).rejects.toThrow(/no "entries" list/)
    await expect(loadArtifactDb(repo, undefined, 'vi')).rejects.toThrow(/thiếu danh sách "entries"/)
  })
})

describe('loadPublished', () => {
  const PAGE = '<!DOCTYPE html><title>Page</title><p>the page</p>'

  const entry = (overrides: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
    id: 'k3x9q2mf',
    title: 'Listed title',
    file_name: 'page.html',
    size: PAGE.length,
    sandbox: true,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  })

  /** A repo publishing `published`, served the way its sandbox flag says. */
  function publishing(published: ArtifactEntry, served?: string | null) {
    const files: Record<string, string> = {
      'data/artifact/db.json': JSON.stringify({ version: 1, entries: [published] }),
    }
    const page =
      served === undefined
        ? servedHtml({
            id: published.id,
            title: published.title,
            source: PAGE,
            file_name: published.file_name,
            sandbox: published.sandbox,
          })
        : served
    if (page !== null) files[`artifact/${published.id}.html`] = page
    return fakeRepo(files, {})
  }

  it('reads the entry and the served file at the head, and the page out of it', async () => {
    const { repo, refs } = publishing(entry())
    const read = await loadPublished(repo, entry(), 'en')
    expect(refs).toEqual(['head-sha', 'head-sha'])
    expect(read.entry).toEqual(entry())
    expect(read.index.entries).toEqual([entry()])
    expect(read.served).toContain('<iframe id="artifact"')
    expect(read.source).toBe(PAGE)
  })

  it("trusts the entry at the head, not the list's, for how the file holds the page", async () => {
    // The list still says full page; another tab has since turned the sandbox on.
    const { repo } = publishing(entry({ sandbox: true, title: 'Renamed' }))
    const read = await loadPublished(repo, entry({ sandbox: false }), 'en')
    expect(read.entry).toMatchObject({ sandbox: true, title: 'Renamed' })
    expect(read.source).toBe(PAGE)
    // And the other way: the list says sandboxed, the page is served as itself now.
    const full = publishing(entry({ sandbox: false }))
    expect((await loadPublished(full.repo, entry({ sandbox: true }), 'en')).source).toBe(PAGE)
  })

  it('says why it cannot, with the index it read whenever it read one', async () => {
    const failure = async (repo: Pick<Repo, 'head' | 'read' | 'list'>) => {
      const error: unknown = await loadPublished(repo, entry(), 'en').catch((e: unknown) => e)
      if (!(error instanceof PublishedReadError)) throw new Error('expected a PublishedReadError')
      return error
    }

    const gone = await failure(fakeRepo({ 'data/artifact/db.json': '{"entries":[]}' }, {}).repo)
    expect(gone.message).toBe('Listed title was deleted elsewhere.')
    expect(gone.index).toEqual(NO_ARTIFACTS)

    const unserved = await failure(publishing(entry(), null).repo)
    expect(unserved.message).toBe('artifact/k3x9q2mf.html is missing on GitHub.')
    expect(unserved.index?.entries).toHaveLength(1)

    const unreadable = await failure(publishing(entry(), '<p>written by hand</p>').repo)
    expect(unreadable.message).toBe(
      'artifact/k3x9q2mf.html does not hold the page in the form XConsole writes it.',
    )

    const lost = await failure(fakeRepo({}, { artifact: [page('k3x9q2mf.html')] }).repo)
    expect(lost.message).toBe('data/artifact/db.json is missing on GitHub.')
    expect(lost.index).toBeNull()
  })

  it('words its reasons in Vietnamese too', async () => {
    const { repo } = fakeRepo({ 'data/artifact/db.json': '{"entries":[]}' }, {})
    await expect(loadPublished(repo, entry(), 'vi')).rejects.toThrow(
      'Listed title đã bị xóa ở nơi khác.',
    )
  })
})

describe('isServed', () => {
  it('finds a page by its path in the listing', async () => {
    const { repo } = fakeRepo({}, { artifact: [page('k3x9q2mf.html')] })
    expect(await isServed(repo, 'k3x9q2mf')).toBe(true)
    expect(await isServed(repo, 'k3x9q2m')).toBe(false)
    expect(await isServed(fakeRepo({}, {}).repo, 'k3x9q2mf')).toBe(false)
  })
})
