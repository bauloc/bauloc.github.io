import { defineMessages } from '@/lib/i18n'
import { currentLocale, type Locale } from '@/lib/locale'

import { formatBytes } from '../format'
import { isId } from '../ids'
import { INLINE_TEXT_BYTES, type RepoWrite } from '../repo/github'
import { ARTIFACT_DB_PATH, artifactPath } from './paths'
import { artifactHtml, htmlMeta, type HtmlMeta } from './templates/wrapper'

export { ARTIFACT_DB_PATH, ARTIFACT_DIR, artifactPath, artifactUrl } from './paths'

/*
  Artifacts, as data and pure functions: what a hosted page is, where it lives, and exactly which
  files a publish or a delete writes. No React and no network, so all of it is tested
  (model.test.ts), and the components only render and wire.

    data/artifact/db.json      the index the list is drawn from
    artifact/<id>.html         the served page (templates/wrapper.ts)

  The index records each page's own size and whether it is sandboxed; the page itself is read
  back out of the served file when it is edited or downloaded, so nothing is stored twice.
*/

/** The largest page the console takes: past it, a page is better split than hosted whole. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
/** From here a page is worth a word: every version of it stays in the repo's history for good. */
export const WARN_ARTIFACT_BYTES = 5 * 1024 * 1024
/**
 * Larger served files go up as a blob first (Repo.upload, with progress) and the commit places
 * them by sha. Repo.commit would do the same on its own from this size, without the progress.
 */
export const UPLOAD_FIRST_BYTES = INLINE_TEXT_BYTES

/** One hosted page, as data/artifact/db.json keeps it. Keys in this order in the file. */
export interface ArtifactEntry {
  /** The page's name in its link: artifact/<id>.html. Fixed once published. */
  readonly id: string
  readonly title: string
  /** The uploaded file's name; '' when the HTML was pasted. */
  readonly file_name: string
  /** The page's own HTML in bytes (UTF-8): not the wrapper's, which is a little larger. */
  readonly size: number
  /** Served inside the sandbox wrapper, or as the page itself with the site's full access. */
  readonly sandbox: boolean
  readonly created_at: string
  readonly updated_at: string
}

export interface ArtifactDb {
  readonly version: number
  readonly updated_at?: string
  readonly entries: readonly ArtifactEntry[]
}

/** The index of a site that has never had an artifact. */
export const NO_ARTIFACTS: ArtifactDb = { version: 1, entries: [] }

/** What the sheet edits and a publish needs. */
export interface ArtifactDraft {
  readonly id: string
  readonly title: string
  /** The page's HTML, as uploaded or pasted. */
  readonly source: string
  /** The uploaded file's name; '' when pasted. */
  readonly file_name: string
  readonly sandbox: boolean
}

/** A text's size as a file: the bytes of its UTF-8, which is what GitHub stores and serves. */
export const utf8Length = (text: string) => new TextEncoder().encode(text).length

/**
 * A file's bytes as text, or null when they are not UTF-8. GitHub Pages serves every page as
 * UTF-8, so a page saved in another encoding (windows-1252, Shift_JIS…) would be published with
 * its accented letters and other non-ASCII characters turned into U+FFFD, wrapped or served as
 * is. A leading BOM is dropped, as Blob.text() drops it.
 */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- *
 * Parsing — an index edited by hand is not trusted to be complete.
 * ---------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)

export function parseArtifactDb(text: string, locale: Locale = currentLocale()): ArtifactDb {
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error(PROBLEMS[locale].notAnIndex(ARTIFACT_DB_PATH))
  }
  const seen = new Set<string>()
  const entries: ArtifactEntry[] = []
  for (const e of data.entries.filter(isRecord)) {
    const id = str(e.id)
    // An id outside the pattern names no file the site may serve, and would build paths
    // outside artifact/ for a delete; a repeated one would make two cards act on one file.
    if (!isId(id) || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      title: str(e.title).trim() || id,
      file_name: str(e.file_name),
      size: typeof e.size === 'number' && Number.isFinite(e.size) && e.size >= 0 ? e.size : 0,
      // Never assumed: the badge must not vouch for a sandbox the index does not record.
      sandbox: e.sandbox === true,
      created_at: str(e.created_at),
      updated_at: str(e.updated_at),
    })
  }
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    ...(typeof data.updated_at === 'string' ? { updated_at: data.updated_at } : {}),
    entries,
  }
}

/** The index as a file: keys spelled out in a fixed order, so every publish diffs cleanly. */
function dbFile(db: ArtifactDb): string {
  const file = {
    version: db.version,
    updated_at: db.updated_at,
    entries: db.entries.map((e) => ({
      id: e.id,
      title: e.title,
      file_name: e.file_name,
      size: e.size,
      sandbox: e.sandbox,
      created_at: e.created_at,
      updated_at: e.updated_at,
    })),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/* ---------------------------------------------------------------- *
 * Checks
 * ---------------------------------------------------------------- */

/**
 * What the checks say, in the console's language. Worded when they run, so a caller outside
 * React gets the language on screen; a test passes the one it wants.
 */
const PROBLEMS = defineMessages({
  en: {
    id: 'Link is required',
    idPattern: 'The link may use only a–z, 0–9 and inner hyphens, at most 64 characters',
    title: 'Title is required',
    empty: 'Choose an HTML file or paste the HTML',
    tooLarge: (size: string, max: string) => `The page is ${size}; the limit is ${max}`,
    frontMatter:
      'The page starts with a "---" line, which GitHub Pages (Jekyll) would run as a template. Keep it in the sandbox, or remove that line',
    deleted: (id: string) =>
      `"${id}" was deleted after you opened it, so nothing was published. Close this and check the list.`,
    changed: (id: string) =>
      `"${id}" was changed elsewhere after you opened it, so nothing was published. Close this and open it again to edit the latest version.`,
    notAnIndex: (path: string) => `${path} is not an artifact index (no "entries" list)`,
  },
  vi: {
    id: 'Cần nhập link',
    idPattern: 'Link chỉ gồm a–z, 0–9 và dấu gạch nối ở giữa, tối đa 64 ký tự',
    title: 'Cần nhập tiêu đề',
    empty: 'Hãy chọn file HTML hoặc dán HTML vào',
    tooLarge: (size: string, max: string) => `Trang nặng ${size}; giới hạn là ${max}`,
    frontMatter:
      'Trang bắt đầu bằng dòng "---" nên GitHub Pages (Jekyll) sẽ chạy nó như một template. Hãy giữ sandbox, hoặc bỏ dòng đó',
    deleted: (id: string) =>
      `"${id}" đã bị xóa sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại và kiểm tra danh sách.`,
    changed: (id: string) =>
      `"${id}" đã được sửa ở nơi khác sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại rồi mở lại để sửa bản mới nhất.`,
    notAnIndex: (path: string) => `${path} không phải chỉ mục artifact (thiếu danh sách "entries")`,
  },
})

/**
 * A first line Jekyll takes for front matter (its own test: `\A---\s*\r?\n`). Pages builds the
 * site with Jekyll, which then runs the file as a Liquid template — and one Liquid error fails
 * the whole build, holding back every later publish. Only a page served as itself can start so:
 * the wrapper starts with its doctype.
 */
const FRONT_MATTER = /^---\s*\r?\n/

/** Why a page of `bytes` is refused, or null. Also asked of a file before it is read at all. */
export function sizeProblem(bytes: number, locale: Locale = currentLocale()): string | null {
  return bytes > MAX_ARTIFACT_BYTES
    ? PROBLEMS[locale].tooLarge(formatBytes(bytes, locale), formatBytes(MAX_ARTIFACT_BYTES, locale))
    : null
}

/** What is missing or wrong in a draft, as messages; empty when it may be published. */
export function validateArtifact(draft: ArtifactDraft, locale: Locale = currentLocale()): string[] {
  const t = PROBLEMS[locale]
  const errors: string[] = []
  if (!draft.id) errors.push(t.id)
  else if (!isId(draft.id)) errors.push(t.idPattern)
  if (!draft.title.trim()) errors.push(t.title)
  // A test, not a trim: the page may be megabytes, and the first character usually answers.
  if (!/\S/.test(draft.source)) errors.push(t.empty)
  else {
    const size = sizeProblem(utf8Length(draft.source), locale)
    if (size !== null) errors.push(size)
  }
  if (!draft.sandbox && FRONT_MATTER.test(draft.source)) errors.push(t.frontMatter)
  return errors
}

/** What an edit must find unchanged in the index: every field but the id it was found by. */
const ENTRY_FIELDS = ['title', 'file_name', 'size', 'sandbox', 'created_at', 'updated_at'] as const

/**
 * Why an edit must not be published over what is on GitHub now, or null when it may be.
 * `base` and `loaded` are the index entry and the served file the edit started from, read at one
 * commit; `db` and `current` (the served file, or null) are read at the commit the edit will be
 * built on. Without this, an edit opened before another tab or device deleted the page would
 * bring it back, and one opened before another edit would quietly undo it.
 *
 * Both halves are compared. A full page is served byte for byte, so renaming it, or uploading the
 * same page from another file, changes only the index: an edit that compared the served file
 * alone would write its stale title or file name back over the new one. Every field is compared,
 * so a hand edit of the index counts too.
 */
export function editConflict(
  base: ArtifactEntry,
  db: ArtifactDb,
  loaded: string,
  current: string | null,
  locale: Locale = currentLocale(),
): string | null {
  const t = PROBLEMS[locale]
  const now = db.entries.find((e) => e.id === base.id)
  if (current === null || now === undefined) return t.deleted(base.id)
  if (current !== loaded || ENTRY_FIELDS.some((field) => now[field] !== base[field])) {
    return t.changed(base.id)
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Publishing — exactly which files change, in one commit
 * ---------------------------------------------------------------- */

export interface ArtifactPlan {
  readonly writes: RepoWrite[]
  readonly deletes: string[]
  readonly message: string
  /** The index after the commit, so the list re-renders without a re-read. */
  readonly db: ArtifactDb
}

const NO_META: HtmlMeta = { description: '', image: '', icon: '' }

/** The file a draft is served as, at artifact/<id>.html: the wrapper, or the page itself. */
export function servedHtml(draft: ArtifactDraft): string {
  return artifactHtml({
    id: draft.id,
    title: draft.title.trim(),
    source: draft.source,
    sandbox: draft.sandbox,
    meta: draft.sandbox ? htmlMeta(draft.source) : NO_META,
  })
}

/**
 * Publishing writes two files at once: the served page and the index.
 *
 * `sha` is the blob of `servedHtml(draft)` when the caller uploaded it first (UPLOAD_FIRST_BYTES);
 * without it the page goes in the commit as text. `existing` is the entry being edited, or null
 * for a new page. An edit keeps the id — it is the link people already hold — its creation
 * date, and its place in the list; a new page goes first.
 */
export function planArtifactPublish(
  input: { readonly draft: ArtifactDraft; readonly sha?: string },
  db: ArtifactDb,
  existing: ArtifactEntry | null,
  now: string,
): ArtifactPlan {
  const draft = existing ? { ...input.draft, id: existing.id } : input.draft
  const entry: ArtifactEntry = {
    id: draft.id,
    title: draft.title.trim(),
    file_name: draft.file_name,
    size: utf8Length(draft.source),
    sandbox: draft.sandbox,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
  const listed = db.entries.some((e) => e.id === entry.id)
  const entries = listed
    ? db.entries.map((e) => (e.id === entry.id ? entry : e))
    : [entry, ...db.entries]
  const next: ArtifactDb = { version: db.version, updated_at: now, entries }
  const path = artifactPath(entry.id)
  return {
    writes: [
      input.sha ? { path, sha: input.sha } : { path, content: servedHtml(draft) },
      { path: ARTIFACT_DB_PATH, content: dbFile(next) },
    ],
    deletes: [],
    message: `${existing ? 'Update' : 'Add'} artifact: ${entry.id}`,
    db: next,
  }
}

/**
 * Deleting a page removes its served file and its index entry in one commit. `served` is false
 * when the file is already gone (removed by hand): the commit then only drops the entry, as
 * GitHub may refuse to delete a path that does not exist.
 */
export function planArtifactDelete(
  id: string,
  db: ArtifactDb,
  now: string,
  served = true,
): ArtifactPlan {
  const next: ArtifactDb = {
    version: db.version,
    updated_at: now,
    entries: db.entries.filter((e) => e.id !== id),
  }
  return {
    writes: [{ path: ARTIFACT_DB_PATH, content: dbFile(next) }],
    deletes: served ? [artifactPath(id)] : [],
    message: `Delete artifact: ${id}`,
    db: next,
  }
}
