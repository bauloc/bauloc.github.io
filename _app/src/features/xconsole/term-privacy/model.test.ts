import { describe, expect, it } from 'vitest'

import {
  DB_PATH,
  editConflict,
  emptyDraft,
  parseDb,
  parsePage,
  planDelete,
  planPublish,
  slugify,
  validateGeneral,
  validatePrivacy,
  type DbIndex,
  type LegalPage,
} from './model'

const NOW = '2026-10-03T12:00:00.000Z'

const draft = {
  ...emptyDraft('2026-10-03'),
  slug: 'my-app',
  app_name: '  My App ',
  platform: ['ios' as const],
  app_description: 'Does things.',
  data_used_for: 'To do things.',
  third_party_services: [' Firebase ', ''],
}

const db: DbIndex = {
  version: 1,
  entries: [
    {
      slug: 'older',
      app_name: 'Older',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      terms_url: 'https://bauloc.github.io/terms/older/',
      privacy_url: 'https://bauloc.github.io/privacy/older/',
      platform: ['android'],
    },
  ],
}

describe('slugify', () => {
  it('makes a URL slug the way the legacy console did', () => {
    expect(slugify('  My Awesome App 2!  ')).toBe('my-awesome-app-2')
  })

  it('folds Vietnamese accents instead of dropping the letters', () => {
    expect(slugify('Cải Lương -- Nam Bộ')).toBe('cai-luong-nam-bo')
    expect(slugify('Đường Đua')).toBe('duong-dua')
  })
})

describe('validation', () => {
  it('accepts a complete draft', () => {
    expect(validateGeneral(draft)).toEqual([])
    expect(validatePrivacy(draft)).toEqual([])
  })

  it('refuses a slug that `npm run publish` would reject', () => {
    expect(validateGeneral({ ...draft, slug: 'My App' })).toEqual([
      expect.stringContaining('URL Slug may use only'),
    ])
    expect(validateGeneral({ ...draft, slug: '-edge-' })).toHaveLength(1)
  })

  it('refuses a website that is not an http(s) URL', () => {
    expect(validateGeneral({ ...draft, website_url: 'javascript:alert(1)' })).toEqual([
      'Website must start with http:// or https://',
    ])
    expect(validateGeneral({ ...draft, website_url: 'https://plsoft.vn' })).toEqual([])
  })

  it('refuses an effective date that is not a real date', () => {
    for (const effective_date of ['2026-02-31', '"><img src=x>', '19/03/2026']) {
      expect(validateGeneral({ ...draft, effective_date })).toEqual([
        'Effective Date must be a valid date',
      ])
    }
  })

  it('names every missing answer', () => {
    const blank = { ...emptyDraft(''), developer_name: '', developer_email: '', country: '' }
    expect(validateGeneral(blank)).toHaveLength(8)
    expect(validatePrivacy({ ...blank, contact_email: '' })).toHaveLength(2)
  })
})

describe('planPublish', () => {
  it('writes the answers, the index and both pages in one commit', () => {
    const plan = planPublish(draft, db, null, NOW)
    expect(plan.writes.map((w) => w.path)).toEqual([
      'data/term-privacy/pages/my-app.json',
      DB_PATH,
      'terms/my-app/index.html',
      'privacy/my-app/index.html',
    ])
    expect(plan.deletes).toEqual([])
    expect(plan.message).toBe('Add term & privacy: my-app')
  })

  it('saves the answers trimmed, in the legacy key order', () => {
    const page = JSON.parse(planPublish(draft, db, null, NOW).writes[0]!.content) as LegalPage
    expect(Object.keys(page)).toEqual([
      'slug',
      'app_name',
      'developer_name',
      'developer_email',
      'website_url',
      'platform',
      'app_description',
      'effective_date',
      'last_updated',
      'data_collected',
      'data_used_for',
      'third_party_services',
      'has_account_creation',
      'children_under_13',
      'contact_email',
      'country',
      'created_at',
      'updated_at',
    ])
    expect(page.app_name).toBe('My App')
    expect(page.third_party_services).toEqual(['Firebase'])
    expect(page.created_at).toBe(NOW)
  })

  it('puts a new page first in the list', () => {
    expect(planPublish(draft, db, null, NOW).db.entries.map((e) => e.slug)).toEqual([
      'my-app',
      'older',
    ])
  })

  it('keeps an edited page in place, with its slug and its creation date', () => {
    const existing = parsePage(
      JSON.stringify({ ...draft, slug: 'older', created_at: '2026-01-01T00:00:00Z' }),
    )
    const plan = planPublish({ ...draft, slug: 'renamed' }, db, existing, NOW)
    expect(plan.message).toBe('Update term & privacy: older')
    expect(plan.db.entries.map((e) => e.slug)).toEqual(['older'])
    expect(plan.writes.map((w) => w.path)).toContain('terms/older/index.html')
    const page = JSON.parse(plan.writes[0]!.content) as LegalPage
    expect(page.created_at).toBe('2026-01-01T00:00:00Z')
    expect(page.updated_at).toBe(NOW)
  })
})

describe('editConflict', () => {
  const loaded = '{"slug":"older","updated_at":"2026-01-01T00:00:00Z"}'

  it('lets an edit through when nothing changed since it was opened', () => {
    expect(editConflict('older', db, loaded, loaded)).toBeNull()
  })

  it('refuses to bring back a page deleted in the meantime', () => {
    expect(editConflict('older', db, loaded, null)).toMatch(/was deleted after you opened it/)
    expect(editConflict('older', { ...db, entries: [] }, loaded, loaded)).toMatch(/was deleted/)
  })

  it('refuses to undo an edit made in the meantime', () => {
    const theirs = loaded.replace('2026-01-01', '2026-02-02')
    expect(editConflict('older', db, loaded, theirs)).toMatch(/was changed elsewhere/)
  })
})

describe('planDelete', () => {
  it('drops the entry and deletes the answers and both pages', () => {
    const plan = planDelete('older', db, NOW)
    expect(plan.db.entries).toEqual([])
    expect(plan.writes.map((w) => w.path)).toEqual([DB_PATH])
    expect(plan.deletes).toEqual([
      'data/term-privacy/pages/older.json',
      'terms/older/index.html',
      'privacy/older/index.html',
    ])
  })
})

describe('parsing', () => {
  it('reads an index, refusing one without entries', () => {
    expect(parseDb(JSON.stringify(db)).entries[0]!.slug).toBe('older')
    expect(() => parseDb('{"version":1}')).toThrow(/entries/)
  })

  it("expands a legacy ['both'] platform", () => {
    expect(parsePage(JSON.stringify({ slug: 'a', platform: ['both'] })).platform).toEqual([
      'ios',
      'android',
    ])
  })
})
