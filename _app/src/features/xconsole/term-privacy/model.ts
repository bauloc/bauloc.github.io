import { defineMessages } from '@/lib/i18n'
import { currentLocale, type Locale } from '@/lib/locale'

import type { RepoFile } from '../repo/github'
import { isIsoDate } from './templates/format'
import { privacyHtml } from './templates/privacy'
import { termsHtml } from './templates/terms'

/*
  Term & Privacy, as data and pure functions: what a page is, where it lives in the repo,
  and exactly which files a publish or a delete writes. No React and no network, so all of
  it is tested (model.test.ts), and the page component only renders and wires.

  WHERE THINGS LIVE. The data moved from xconsole/modules/term-privacy/data/ to data/ when
  the console was ported; the published pages never moved:

    data/term-privacy/db.json              the index the list is drawn from
    data/term-privacy/pages/{slug}.json    one page's answers, to edit it again later
    terms/{slug}/index.html                the published Terms of Service
    privacy/{slug}/index.html              the published Privacy Policy
*/

export const SITE = 'https://bauloc.github.io'
export const DB_PATH = 'data/term-privacy/db.json'
export const PAGES_DIR = 'data/term-privacy/pages/'

/**
 * A published slug, which is also a directory name under terms/ and privacy/. The same
 * pattern `npm run publish` asserts, so the console cannot create a page that fails it.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export type Platform = 'ios' | 'android'

/**
 * The kinds of data a page can say the app collects, in the form's order. The form labels
 * them in the console's language (messages.tsx); the published page names them by DATA_LABELS.
 */
export const DATA_COLLECTED_OPTIONS = [
  'name',
  'email',
  'location',
  'device_info',
  'usage_data',
  'camera',
  'microphone',
  'contacts',
  'payment',
] as const

/** How each kind of data is named in the published Privacy Policy. */
export const DATA_LABELS: Readonly<Record<string, string>> = {
  name: 'User name',
  email: 'Email address',
  location: 'Location data',
  device_info: 'Device information and identifiers',
  usage_data: 'App usage data and analytics',
  camera: 'Camera access',
  microphone: 'Microphone access',
  contacts: 'Contact list',
  payment: 'Payment information',
}

/**
 * One app's answers. The key ORDER is the legacy console's and is kept: it is the order of
 * data/term-privacy/pages/{slug}.json, and reordering would churn every file on its next save.
 */
export interface LegalPage {
  slug: string
  app_name: string
  developer_name: string
  developer_email: string
  website_url: string
  platform: Platform[]
  app_description: string
  effective_date: string
  last_updated: string
  data_collected: string[]
  data_used_for: string
  third_party_services: string[]
  has_account_creation: boolean
  children_under_13: boolean
  contact_email: string
  country: string
  created_at: string
  updated_at: string
}

export interface DbEntry {
  slug: string
  app_name: string
  created_at: string
  updated_at: string
  terms_url: string
  privacy_url: string
  platform: Platform[]
}

export interface DbIndex {
  version: number
  updated_at?: string
  entries: DbEntry[]
}

export const termsUrl = (slug: string) => `${SITE}/terms/${slug}/`
export const privacyUrl = (slug: string) => `${SITE}/privacy/${slug}/`
export const pagePath = (slug: string) => `${PAGES_DIR}${slug}.json`

/* ---------------------------------------------------------------- *
 * Parsing — files written by hand or by an older console are not trusted to be complete.
 * ---------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** Old pages stored `['both']`; anything unknown is dropped. */
function platforms(value: unknown): Platform[] {
  const raw = strings(value)
  const expanded = raw.includes('both') ? ['ios', 'android'] : raw
  return expanded.filter((p): p is Platform => p === 'ios' || p === 'android')
}

export function parseDb(text: string): DbIndex {
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error(`${DB_PATH} is not a page index (no "entries" list)`)
  }
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    ...(typeof data.updated_at === 'string' ? { updated_at: data.updated_at } : {}),
    entries: data.entries.filter(isRecord).map((e) => {
      const slug = str(e.slug)
      return {
        slug,
        app_name: str(e.app_name, slug),
        created_at: str(e.created_at),
        updated_at: str(e.updated_at),
        terms_url: str(e.terms_url, termsUrl(slug)),
        privacy_url: str(e.privacy_url, privacyUrl(slug)),
        platform: platforms(e.platform),
      }
    }),
  }
}

export function parsePage(text: string): LegalPage {
  const d: unknown = JSON.parse(text)
  if (!isRecord(d)) throw new Error('Page data is not an object')
  return {
    slug: str(d.slug),
    app_name: str(d.app_name),
    developer_name: str(d.developer_name),
    developer_email: str(d.developer_email),
    website_url: str(d.website_url),
    platform: platforms(d.platform),
    app_description: str(d.app_description),
    effective_date: str(d.effective_date),
    last_updated: str(d.last_updated),
    data_collected: strings(d.data_collected),
    data_used_for: str(d.data_used_for),
    third_party_services: strings(d.third_party_services),
    has_account_creation: d.has_account_creation === true,
    children_under_13: d.children_under_13 === true,
    contact_email: str(d.contact_email),
    country: str(d.country, 'Vietnam'),
    created_at: str(d.created_at),
    updated_at: str(d.updated_at),
  }
}

/* ---------------------------------------------------------------- *
 * The form
 * ---------------------------------------------------------------- */

/** What the form edits: a page without its bookkeeping timestamps. */
export type PageDraft = Omit<LegalPage, 'created_at' | 'updated_at' | 'last_updated'>

/** A new page's starting answers: the legacy console's defaults (PLSOFT, Vietnam, today). */
export function emptyDraft(today: string): PageDraft {
  return {
    slug: '',
    app_name: '',
    developer_name: 'PLSOFT',
    developer_email: 'loc.plsoft@gmail.com',
    website_url: '',
    platform: [],
    app_description: '',
    effective_date: today,
    data_collected: [],
    data_used_for: '',
    third_party_services: [],
    has_account_creation: false,
    children_under_13: false,
    contact_email: 'loc.plsoft@gmail.com',
    country: 'Vietnam',
  }
}

/**
 * An app name as a URL slug: `My App 2!` → `my-app-2`, `Cải Lương Nam Bộ` → `cai-luong-nam-bo`.
 * Accents are folded first (and đ, which has no decomposition, by hand); the legacy console
 * dropped accented letters outright and made `ci-lng-nam-b`.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * What the checks below say, in the console's language. Worded when they run, so a caller
 * outside React gets the language on screen; a test passes the one it wants.
 */
const PROBLEMS = defineMessages({
  en: {
    appName: 'App Name is required',
    slug: 'URL Slug is required',
    slugPattern: 'URL Slug may use only a–z, 0–9 and inner hyphens, at most 64 characters',
    platform: 'Platform is required',
    appDescription: 'App Description is required',
    developerName: 'Developer Name is required',
    developerEmail: 'Developer Email is required',
    website: 'Website must start with http:// or https://',
    country: 'Country is required',
    date: 'Effective Date is required',
    dateValid: 'Effective Date must be a valid date',
    dataUsedFor: 'Data usage description is required',
    contactEmail: 'Contact email is required',
    deleted: (slug: string) =>
      `"${slug}" was deleted after you opened it, so nothing was published. Close this and check the list.`,
    changed: (slug: string) =>
      `"${slug}" was changed elsewhere after you opened it, so nothing was published. Close this and open it again to edit the latest version.`,
  },
  vi: {
    appName: 'Cần nhập tên ứng dụng',
    slug: 'Cần nhập slug',
    slugPattern: 'Slug chỉ gồm a–z, 0–9 và dấu gạch nối ở giữa, tối đa 64 ký tự',
    platform: 'Cần chọn nền tảng',
    appDescription: 'Cần nhập mô tả ứng dụng',
    developerName: 'Cần nhập tên nhà phát triển',
    developerEmail: 'Cần nhập email nhà phát triển',
    website: 'Website phải bắt đầu bằng http:// hoặc https://',
    country: 'Cần nhập quốc gia',
    date: 'Cần nhập ngày hiệu lực',
    dateValid: 'Ngày hiệu lực không hợp lệ',
    dataUsedFor: 'Cần mô tả cách dùng dữ liệu',
    contactEmail: 'Cần nhập email liên hệ',
    deleted: (slug: string) =>
      `"${slug}" đã bị xóa sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại và kiểm tra danh sách.`,
    changed: (slug: string) =>
      `"${slug}" đã được sửa ở nơi khác sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại rồi mở lại để sửa bản mới nhất.`,
  },
})

/** Step 1 (General Info): what is missing or wrong, as messages. */
export function validateGeneral(draft: PageDraft, locale: Locale = currentLocale()): string[] {
  const t = PROBLEMS[locale]
  const errors: string[] = []
  if (!draft.app_name.trim()) errors.push(t.appName)
  if (!draft.slug.trim()) errors.push(t.slug)
  else if (!SLUG_PATTERN.test(draft.slug)) errors.push(t.slugPattern)
  if (draft.platform.length === 0) errors.push(t.platform)
  if (!draft.app_description.trim()) errors.push(t.appDescription)
  if (!draft.developer_name.trim()) errors.push(t.developerName)
  if (!draft.developer_email.trim()) errors.push(t.developerEmail)
  const site = draft.website_url.trim()
  if (site && !/^https?:\/\//i.test(site)) errors.push(t.website)
  if (!draft.country.trim()) errors.push(t.country)
  if (!draft.effective_date) errors.push(t.date)
  else if (!isIsoDate(draft.effective_date)) errors.push(t.dateValid)
  return errors
}

/** Step 2 (Privacy Details). */
export function validatePrivacy(draft: PageDraft, locale: Locale = currentLocale()): string[] {
  const t = PROBLEMS[locale]
  const errors: string[] = []
  if (!draft.data_used_for.trim()) errors.push(t.dataUsedFor)
  if (!draft.contact_email.trim()) errors.push(t.contactEmail)
  return errors
}

/** The draft with every text answer trimmed and empty services dropped, as the legacy console saved it. */
function cleaned(draft: PageDraft): PageDraft {
  return {
    ...draft,
    slug: draft.slug.trim(),
    app_name: draft.app_name.trim(),
    developer_name: draft.developer_name.trim(),
    developer_email: draft.developer_email.trim(),
    website_url: draft.website_url.trim(),
    app_description: draft.app_description.trim(),
    data_used_for: draft.data_used_for.trim(),
    contact_email: draft.contact_email.trim(),
    country: draft.country.trim(),
    third_party_services: draft.third_party_services.map((s) => s.trim()).filter(Boolean),
  }
}

/* ---------------------------------------------------------------- *
 * Publishing — exactly which files change, in one commit
 * ---------------------------------------------------------------- */

export interface PublishPlan {
  readonly writes: RepoFile[]
  readonly deletes: string[]
  readonly message: string
  /** The index after the commit, so the list re-renders without a re-read. */
  readonly db: DbIndex
}

/**
 * Publishing a page writes four files at once: its answers, the index, and both pages.
 *
 * `existing` is the page being edited, or null for a new one. An edit keeps the slug —
 * it is the URL submitted to the stores — and keeps `created_at`, which the legacy console
 * dropped from the page file on every edit.
 */
export function planPublish(
  draft: PageDraft,
  db: DbIndex,
  existing: LegalPage | null,
  now: string,
): PublishPlan {
  const answers = cleaned(existing ? { ...draft, slug: existing.slug } : draft)
  const created = existing?.created_at || now
  // Spelled out rather than spread: the key order is the legacy files' (see LegalPage), and a
  // spread would put keys in whatever order the draft happened to be built in.
  const page: LegalPage = {
    slug: answers.slug,
    app_name: answers.app_name,
    developer_name: answers.developer_name,
    developer_email: answers.developer_email,
    website_url: answers.website_url,
    platform: answers.platform,
    app_description: answers.app_description,
    effective_date: answers.effective_date,
    last_updated: answers.effective_date,
    data_collected: answers.data_collected,
    data_used_for: answers.data_used_for,
    third_party_services: answers.third_party_services,
    has_account_creation: answers.has_account_creation,
    children_under_13: answers.children_under_13,
    contact_email: answers.contact_email,
    country: answers.country,
    created_at: created,
    updated_at: now,
  }
  const entry: DbEntry = {
    slug: page.slug,
    app_name: page.app_name,
    created_at: created,
    updated_at: now,
    terms_url: termsUrl(page.slug),
    privacy_url: privacyUrl(page.slug),
    platform: page.platform,
  }
  const others = db.entries.filter((e) => e.slug !== page.slug)
  const index = db.entries.findIndex((e) => e.slug === page.slug)
  // An edited page keeps its place in the list; a new one goes first, as before.
  const entries =
    index >= 0 ? db.entries.map((e) => (e.slug === page.slug ? entry : e)) : [entry, ...others]
  const nextDb: DbIndex = { ...db, entries, updated_at: now }

  return {
    writes: [
      { path: pagePath(page.slug), content: JSON.stringify(page, null, 2) },
      { path: DB_PATH, content: JSON.stringify(nextDb, null, 2) },
      { path: `terms/${page.slug}/index.html`, content: termsHtml(page) },
      { path: `privacy/${page.slug}/index.html`, content: privacyHtml(page) },
    ],
    deletes: [],
    message: `${existing ? 'Update' : 'Add'} term & privacy: ${page.slug}`,
    db: nextDb,
  }
}

/**
 * Why an edit must not be published over what is on GitHub now, or null when it may be.
 * `loaded` is the page file the edit started from; `db` and `current` (the page file, or null)
 * are read at the commit the edit will be built on. Without this, an edit opened before
 * another tab or device deleted the page would bring it back, and one opened before another
 * edit would quietly undo it.
 */
export function editConflict(
  slug: string,
  db: DbIndex,
  loaded: string,
  current: string | null,
  locale: Locale = currentLocale(),
): string | null {
  if (current === null || !db.entries.some((e) => e.slug === slug)) {
    return PROBLEMS[locale].deleted(slug)
  }
  if (current !== loaded) {
    return PROBLEMS[locale].changed(slug)
  }
  return null
}

/** Deleting a page removes its answers and both pages, and its index entry, in one commit. */
export function planDelete(slug: string, db: DbIndex, now: string): PublishPlan {
  const nextDb: DbIndex = {
    ...db,
    entries: db.entries.filter((e) => e.slug !== slug),
    updated_at: now,
  }
  return {
    writes: [{ path: DB_PATH, content: JSON.stringify(nextDb, null, 2) }],
    deletes: [pagePath(slug), `terms/${slug}/index.html`, `privacy/${slug}/index.html`],
    message: `Delete term & privacy: ${slug}`,
    db: nextDb,
  }
}
