import { describe, expect, it } from 'vitest'

import { isBlobWrite, type RepoWrite } from '../repo/github'
import {
  ARTIFACT_DB_PATH,
  MAX_ARTIFACT_BYTES,
  artifactPath,
  artifactUrl,
  decodeUtf8,
  editConflict,
  parseArtifactDb,
  planArtifactDelete,
  planArtifactPublish,
  servedHtml,
  sizeProblem,
  utf8Length,
  validateArtifact,
  type ArtifactDb,
  type ArtifactDraft,
  type ArtifactEntry,
} from './model'
import { artifactSource } from './templates/wrapper'

const NOW = '2026-10-07T01:15:00.000Z'

const older: ArtifactEntry = {
  id: 'older',
  title: 'Older',
  file_name: 'older.html',
  size: 12,
  sandbox: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const db: ArtifactDb = { version: 1, updated_at: '2026-01-01T00:00:00Z', entries: [older] }

const draft: ArtifactDraft = {
  id: 'k3x9q2mf',
  title: '  Quarterly report ',
  source: '<!DOCTYPE html><title>Q3</title><p>Phước Lộc 😀</p>',
  file_name: 'report.html',
  sandbox: true,
}

/** A plan's text write at `path`. */
function written(writes: readonly RepoWrite[], path: string): string {
  const write = writes.find((w) => w.path === path)
  if (!write || isBlobWrite(write)) throw new Error(`no text write at ${path}`)
  return write.content
}

describe('where an artifact lives', () => {
  it('is served at artifact/<id>.html, on the live site unless told otherwise', () => {
    expect(ARTIFACT_DB_PATH).toBe('data/artifact/db.json')
    expect(artifactPath('k3x9q2mf')).toBe('artifact/k3x9q2mf.html')
    expect(artifactUrl('k3x9q2mf')).toBe('https://bauloc.github.io/artifact/k3x9q2mf.html')
    expect(artifactUrl('a', 'http://localhost:7360')).toBe('http://localhost:7360/artifact/a.html')
  })
})

describe('utf8Length', () => {
  it('counts the bytes GitHub stores, not the characters', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('Lộc')).toBe(5)
    expect(utf8Length('😀')).toBe(4)
  })
})

describe('decodeUtf8', () => {
  it('reads UTF-8, dropping a leading BOM as Blob.text() does', () => {
    const page = '<p>Phước Lộc 😀</p>'
    expect(decodeUtf8(new TextEncoder().encode(page))).toBe(page)
    expect(decodeUtf8(new TextEncoder().encode(`\uFEFF${page}`))).toBe(page)
    expect(decodeUtf8(new Uint8Array())).toBe('')
  })

  it('refuses text in any other encoding instead of garbling it', () => {
    // 'café' saved as windows-1252 / ISO-8859-1: é is the single byte 0xE9.
    const latin1 = new Uint8Array([...new TextEncoder().encode('<p>caf'), 0xe9, 0x3c])
    expect(decodeUtf8(latin1)).toBeNull()
    // UTF-16LE with its BOM, as Notepad once saved "Unicode".
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x70, 0x00]))).toBeNull()
    // The same bytes as an ArrayBuffer, which is what File.arrayBuffer() gives.
    expect(decodeUtf8(latin1.slice().buffer)).toBeNull()
  })
})

describe('parseArtifactDb', () => {
  it('reads an index, refusing one without entries in the console language', () => {
    expect(parseArtifactDb(JSON.stringify(db))).toEqual(db)
    expect(() => parseArtifactDb('{"version":1}', 'en')).toThrow(
      'data/artifact/db.json is not an artifact index (no "entries" list)',
    )
    expect(() => parseArtifactDb('[]', 'vi')).toThrow(
      'data/artifact/db.json không phải chỉ mục artifact (thiếu danh sách "entries")',
    )
  })

  it('fills what a hand-written entry leaves out, and never assumes a sandbox', () => {
    const parsed = parseArtifactDb('{"entries":[{"id":"bare"}]}')
    expect(parsed).toEqual({
      version: 1,
      entries: [
        {
          id: 'bare',
          title: 'bare',
          file_name: '',
          size: 0,
          sandbox: false,
          created_at: '',
          updated_at: '',
        },
      ],
    })
  })

  it('drops entries whose id could not be served, or would point outside artifact/', () => {
    const parsed = parseArtifactDb(
      JSON.stringify({
        entries: [
          { id: '../../xconsole/index' },
          { id: 'Upper' },
          { id: '' },
          'not an entry',
          { id: 'ok', size: -5 },
          { id: 'ok', title: 'a repeat' },
        ],
      }),
    )
    expect(parsed.entries.map((e) => e.id)).toEqual(['ok'])
    expect(parsed.entries[0]!.size).toBe(0)
  })
})

describe('validateArtifact', () => {
  it('accepts a complete draft', () => {
    expect(validateArtifact(draft, 'en')).toEqual([])
  })

  it('names every missing answer', () => {
    expect(validateArtifact({ ...draft, id: '', title: ' ', source: ' \n' }, 'en')).toEqual([
      'Link is required',
      'Title is required',
      'Choose an HTML file or paste the HTML',
    ])
  })

  it('refuses a link that `npm run publish` would reject', () => {
    for (const id of ['My-Page', '-edge', 'a_b', 'x'.repeat(65)]) {
      expect(validateArtifact({ ...draft, id }, 'en'), id).toEqual([
        expect.stringContaining('The link may use only'),
      ])
    }
  })

  it('refuses a page over the size limit, counted in UTF-8 bytes', () => {
    // Under the limit in characters, over it in bytes: 'ộ' is three bytes.
    const source = 'ộ'.repeat(10 * 1024 * 1024)
    expect(source.length).toBeLessThan(MAX_ARTIFACT_BYTES)
    expect(validateArtifact({ ...draft, source }, 'en')).toEqual([
      'The page is 30.0 MB; the limit is 25.0 MB',
    ])
    expect(sizeProblem(MAX_ARTIFACT_BYTES, 'en')).toBeNull()
    expect(sizeProblem(MAX_ARTIFACT_BYTES + 1, 'vi')).toBe(
      'Trang nặng 25,0 MB; giới hạn là 25,0 MB',
    )
  })

  it('refuses a full page Jekyll would run as a template, but not inside the sandbox', () => {
    const source = '---\nlayout: x\n---\n<p>{{ site.title }}</p>'
    expect(validateArtifact({ ...draft, source, sandbox: false }, 'en')).toEqual([
      expect.stringContaining('GitHub Pages (Jekyll) would run as a template'),
    ])
    expect(validateArtifact({ ...draft, source, sandbox: true }, 'en')).toEqual([])
    expect(
      validateArtifact({ ...draft, source: `<p>x</p>\n${source}`, sandbox: false }, 'en'),
    ).toEqual([])
    expect(servedHtml({ ...draft, source, sandbox: true }).startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('says the same problems in Vietnamese, in the same order', () => {
    const blank = { ...draft, id: 'Bad', title: '', source: '' }
    expect(validateArtifact(blank, 'vi')).toEqual([
      'Link chỉ gồm a–z, 0–9 và dấu gạch nối ở giữa, tối đa 64 ký tự',
      'Cần nhập tiêu đề',
      'Hãy chọn file HTML hoặc dán HTML vào',
    ])
  })
})

describe('planArtifactPublish', () => {
  it('writes the served page and the index in one commit', () => {
    const plan = planArtifactPublish({ draft }, db, null, NOW)
    expect(plan.writes.map((w) => w.path)).toEqual(['artifact/k3x9q2mf.html', ARTIFACT_DB_PATH])
    expect(plan.deletes).toEqual([])
    expect(plan.message).toBe('Add artifact: k3x9q2mf')
  })

  it('serves a sandboxed page inside the wrapper, and the page itself without it', () => {
    const wrapped = written(
      planArtifactPublish({ draft }, db, null, NOW).writes,
      artifactPath(draft.id),
    )
    expect(wrapped).toBe(servedHtml(draft))
    expect(wrapped).toContain('<iframe id="artifact" data-id="k3x9q2mf"')
    expect(artifactSource(wrapped, true)).toBe(draft.source)

    const full = { ...draft, sandbox: false }
    expect(
      written(planArtifactPublish({ draft: full }, db, null, NOW).writes, artifactPath(draft.id)),
    ).toBe(draft.source)
  })

  it('places an uploaded page by its blob sha instead of carrying it', () => {
    const plan = planArtifactPublish({ draft, sha: 'abc123' }, db, null, NOW)
    expect(plan.writes[0]).toEqual({ path: 'artifact/k3x9q2mf.html', sha: 'abc123' })
  })

  it('records the entry with its title trimmed and its own size in bytes', () => {
    const plan = planArtifactPublish({ draft }, db, null, NOW)
    expect(plan.db.entries[0]).toEqual({
      id: 'k3x9q2mf',
      title: 'Quarterly report',
      file_name: 'report.html',
      size: utf8Length(draft.source),
      sandbox: true,
      created_at: NOW,
      updated_at: NOW,
    })
  })

  it('writes the index with its keys in a fixed order and a final newline', () => {
    const text = written(planArtifactPublish({ draft }, db, null, NOW).writes, ARTIFACT_DB_PATH)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)
    const file = JSON.parse(text) as { entries: Record<string, unknown>[] }
    expect(Object.keys(file)).toEqual(['version', 'updated_at', 'entries'])
    expect(Object.keys(file.entries[0]!)).toEqual([
      'id',
      'title',
      'file_name',
      'size',
      'sandbox',
      'created_at',
      'updated_at',
    ])
    expect(parseArtifactDb(text)).toEqual(planArtifactPublish({ draft }, db, null, NOW).db)
  })

  it('puts a new page first in the list', () => {
    expect(planArtifactPublish({ draft }, db, null, NOW).db.entries.map((e) => e.id)).toEqual([
      'k3x9q2mf',
      'older',
    ])
  })

  it('keeps an edited page in place, with its id and its creation date', () => {
    const second: ArtifactEntry = { ...older, id: 'second' }
    const two: ArtifactDb = { version: 1, entries: [older, second] }
    const plan = planArtifactPublish({ draft: { ...draft, id: 'renamed' } }, two, second, NOW)
    expect(plan.message).toBe('Update artifact: second')
    expect(plan.db.entries.map((e) => e.id)).toEqual(['older', 'second'])
    expect(plan.db.entries[1]).toMatchObject({
      id: 'second',
      created_at: older.created_at,
      updated_at: NOW,
    })
    expect(plan.writes[0]!.path).toBe('artifact/second.html')
    expect(written(plan.writes, 'artifact/second.html')).toContain('data-id="second"')
  })
})

describe('editConflict', () => {
  const loaded = '<!DOCTYPE html><p>v1</p>'

  it('lets an edit through when nothing changed since it was opened', () => {
    expect(editConflict(older, db, loaded, loaded, 'en')).toBeNull()
    // The same entry read back from the file is the same entry.
    expect(editConflict(older, parseArtifactDb(JSON.stringify(db)), loaded, loaded)).toBeNull()
  })

  it('refuses to bring back a page deleted in the meantime', () => {
    expect(editConflict(older, db, loaded, null, 'en')).toMatch(/was deleted after you opened it/)
    expect(editConflict(older, { ...db, entries: [] }, loaded, loaded, 'en')).toMatch(/was deleted/)
  })

  it('refuses to undo an edit made in the meantime', () => {
    expect(editConflict(older, db, loaded, `${loaded} `, 'en')).toMatch(/was changed elsewhere/)
    expect(editConflict(older, db, loaded, `${loaded} `, 'vi')).toMatch(/đã được sửa ở nơi khác/)
  })

  it('refuses to undo a change made only to the index, as a full page served as is gets', () => {
    // A rename, a new file name, the sandbox switched, a size or a date written by hand: the
    // served file can stay byte for byte the same through each.
    const changes: Partial<ArtifactEntry>[] = [
      { title: 'Renamed elsewhere' },
      { file_name: 'other.html' },
      { size: 13 },
      { sandbox: false },
      { created_at: '2026-02-02T00:00:00Z' },
      { updated_at: '2026-10-07T00:00:00Z' },
    ]
    for (const change of changes) {
      const theirs: ArtifactDb = { ...db, entries: [{ ...older, ...change }] }
      expect(editConflict(older, theirs, loaded, loaded, 'en'), JSON.stringify(change)).toBe(
        '"older" was changed elsewhere after you opened it, so nothing was published. Close this and open it again to edit the latest version.',
      )
    }
  })

  it('looks only at the entry being edited', () => {
    const other: ArtifactEntry = { ...older, id: 'other', title: 'Another page' }
    const busy: ArtifactDb = { ...db, entries: [{ ...other, title: 'Renamed' }, older] }
    expect(editConflict(older, busy, loaded, loaded, 'en')).toBeNull()
  })
})

describe('planArtifactDelete', () => {
  it('drops the entry and deletes the served page in one commit', () => {
    const plan = planArtifactDelete('older', db, NOW)
    expect(plan.db).toEqual({ version: 1, updated_at: NOW, entries: [] })
    expect(plan.writes.map((w) => w.path)).toEqual([ARTIFACT_DB_PATH])
    expect(plan.deletes).toEqual(['artifact/older.html'])
    expect(plan.message).toBe('Delete artifact: older')
  })

  it('only drops the entry when its page is already gone', () => {
    expect(planArtifactDelete('older', db, NOW, false).deletes).toEqual([])
  })
})
