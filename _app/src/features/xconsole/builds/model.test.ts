import { describe, expect, it } from 'vitest'

import { isBlobWrite, type RepoEntry, type RepoFile, type RepoWrite } from '../repo/github'
import { BUILD_MESSAGES } from './messages'
import {
  EMPTY_BUILD_DB,
  NAME_MAX,
  NOTES_MAX,
  buildConflict,
  deleteBuildRelease,
  entryFromInspection,
  fileFindings,
  idTaken,
  matchesBuild,
  mergeFindings,
  parseBuildDb,
  planBuildDelete,
  planBuildEdit,
  planBuildPublish,
  readBuildDb,
  releaseFor,
  replaceFindings,
  sha256Hex,
  sizeFindings,
  storageUsed,
  suggestedName,
  uploadedOf,
  validateBuildDraft,
  versionLabel,
  type EntryInput,
  type FindingCode,
} from './model'
import {
  BUILD_DB_PATH,
  MAX_BUILD_BYTES,
  RELEASE_MAX_BYTES,
  WARN_BUILD_BYTES,
  binaryFileName,
  buildUrl,
} from './paths'
import { qrSvg } from './qr'
import { installPageHtml } from './templates/install-page'
import { manifestPlist } from './templates/manifest'
import type { BuildDb, BuildEntry, BuildInspection } from './types'

const NOW = '2026-10-07T01:15:00.000Z'
const LATER = '2026-10-08T02:30:00.000Z'
const SHA = 'ab'.repeat(32)
const MiB = 1024 * 1024

const ENTRY_KEYS = [
  'id',
  'platform',
  'name',
  'bundle_id',
  'version',
  'build',
  'file',
  'size',
  'sha256',
  'icon',
  'min_os',
  'notes',
  'android',
  'ios',
  'release',
  'uploaded_at',
  'created_at',
  'updated_at',
]

const android: BuildInspection = {
  platform: 'android',
  name: 'My App',
  bundleId: 'com.example.app',
  version: '1.2.0',
  build: '45',
  minOs: '24',
  // Keys out of the file's order on purpose: the entry must not take them as they come.
  android: { abis: ['arm64-v8a', 'armeabi-v7a'], debuggable: true, target_sdk: 35 },
  ios: null,
  icon: null,
  problems: [],
  warnings: [],
}

const ios: BuildInspection = {
  platform: 'ios',
  name: 'Cải Lương',
  bundleId: 'vn.plsoft.cailuong',
  version: '2.0',
  build: '7',
  minOs: '15.0',
  android: null,
  ios: {
    profile: {
      device_count: 12,
      expires: '2027-01-01T00:00:00.000Z',
      team: 'PLSOFT',
      name: 'Cai Luong Ad Hoc',
      kind: 'ad-hoc',
    },
    devices: ['iphone', 'ipad'],
  },
  icon: null,
  problems: [],
  warnings: [],
}

function entryOf(inspection: BuildInspection, more: Partial<EntryInput> = {}): BuildEntry {
  const name = more.name ?? inspection.name
  return entryFromInspection({
    inspection,
    id: 'k3x9q2mf',
    name,
    notes: '',
    file: binaryFileName(name, inspection.version, inspection.build, inspection.platform),
    size: 24 * MiB,
    sha256: SHA,
    icon: true,
    now: NOW,
    existing: null,
    ...more,
  })
}

const older: BuildEntry = {
  ...entryOf(android, { id: 'older', name: 'Older', icon: false }),
  uploaded_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const db: BuildDb = { version: 1, updated_at: older.updated_at, entries: [older] }

const paths = (writes: readonly RepoWrite[]) => writes.map((w) => w.path)
const contentOf = (writes: readonly RepoWrite[], path: string): string => {
  const write = writes.find((w): w is RepoFile => w.path === path && !isBlobWrite(w))
  if (!write) throw new Error(`no text write for ${path}`)
  return write.content
}

describe('entryFromInspection', () => {
  it('writes the keys in the file’s order, nested ones too', () => {
    const entry = entryOf(android)
    expect(Object.keys(entry)).toEqual(ENTRY_KEYS)
    expect(Object.keys(entry.android ?? {})).toEqual(['target_sdk', 'debuggable', 'abis'])
    const apple = entryOf(ios)
    expect(Object.keys(apple.ios ?? {})).toEqual(['devices', 'profile'])
    expect(Object.keys(apple.ios?.profile ?? {})).toEqual([
      'kind',
      'name',
      'team',
      'expires',
      'device_count',
    ])
  })

  it('takes the facts from the file and the words from the sheet', () => {
    const entry = entryOf(android, {
      name: '  My   App\nBeta ',
      notes: '\r\nFixed login.\r\nNew icon.\r\n\r\n',
    })
    expect(entry).toMatchObject({
      id: 'k3x9q2mf',
      platform: 'android',
      name: 'My App Beta',
      bundle_id: 'com.example.app',
      version: '1.2.0',
      build: '45',
      size: 24 * MiB,
      sha256: SHA,
      icon: 'icon.png',
      min_os: '24',
      notes: 'Fixed login.\nNew icon.',
      android: { target_sdk: 35, debuggable: true, abis: ['arm64-v8a', 'armeabi-v7a'] },
      ios: null,
      uploaded_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    expect(entryOf(android, { icon: false }).icon).toBe('')
  })

  it('keeps only the facts of the build’s own platform', () => {
    const mixed: BuildInspection = { ...ios, android: android.android }
    const entry = entryOf(mixed)
    expect(entry.android).toBeNull()
    expect(entry.ios?.profile?.kind).toBe('ad-hoc')
  })

  it('keeps the link’s creation date when a new version replaces it', () => {
    const entry = entryOf(android, { id: 'older', existing: older, now: LATER })
    expect(entry.created_at).toBe(older.created_at)
    // A new binary is a new upload, whatever link it goes under.
    expect(entry.uploaded_at).toBe(LATER)
    expect(entry.updated_at).toBe(LATER)
  })
})

describe('planBuildPublish', () => {
  it('places the binary and icon by sha and writes the page and the index, in that order', () => {
    const entry = entryOf(android)
    const plan = planBuildPublish({ entry, shas: { binary: 'b1', icon: 'i1' } }, db, null, NOW)
    expect(paths(plan.writes)).toEqual([
      'build/k3x9q2mf/my-app-1.2.0-45.apk',
      'build/k3x9q2mf/icon.png',
      'build/k3x9q2mf/index.html',
      BUILD_DB_PATH,
    ])
    expect(plan.writes[0]).toEqual({ path: 'build/k3x9q2mf/my-app-1.2.0-45.apk', sha: 'b1' })
    expect(plan.writes[1]).toEqual({ path: 'build/k3x9q2mf/icon.png', sha: 'i1' })
    expect(plan.deletes).toEqual([])
    expect(plan.message).toBe('Add build: k3x9q2mf (My App 1.2.0 (45))')
  })

  it('generates the install page from the entry, with a QR code of the live link', () => {
    const entry = entryOf(android)
    const plan = planBuildPublish({ entry, shas: { binary: 'b1', icon: 'i1' } }, db, null, NOW)
    expect(contentOf(plan.writes, 'build/k3x9q2mf/index.html')).toBe(
      installPageHtml(entry, { qrSvg: qrSvg('https://bauloc.github.io/build/k3x9q2mf/') }),
    )
  })

  it('writes the OTA manifest for an iOS build, and nothing for a missing icon', () => {
    const entry = entryOf(ios, { icon: false })
    const plan = planBuildPublish({ entry, shas: { binary: 'b2', icon: null } }, db, null, NOW)
    expect(paths(plan.writes)).toEqual([
      'build/k3x9q2mf/cai-luong-2.0-7.ipa',
      'build/k3x9q2mf/index.html',
      'build/k3x9q2mf/manifest.plist',
      BUILD_DB_PATH,
    ])
    expect(contentOf(plan.writes, 'build/k3x9q2mf/manifest.plist')).toBe(manifestPlist(entry))
    expect(plan.message).toBe('Add build: k3x9q2mf (Cải Lương 2.0 (7))')
  })

  it('puts a new build first, and writes the index as stable JSON with a final newline', () => {
    const entry = entryOf(android)
    const plan = planBuildPublish({ entry, shas: { binary: 'b1', icon: 'i1' } }, db, null, NOW)
    expect(plan.db.entries.map((e) => e.id)).toEqual(['k3x9q2mf', 'older'])
    const text = contentOf(plan.writes, BUILD_DB_PATH)
    expect(text).toBe(`${JSON.stringify(plan.db, null, 2)}\n`)
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['version', 'updated_at', 'entries'])
    expect(plan.db.updated_at).toBe(NOW)
    // What is written reads back as exactly what the list shows next.
    expect(parseBuildDb(text)).toEqual(plan.db)
  })

  it('names a version without a build number, or a build without a version, plainly', () => {
    const plain = entryOf({ ...android, build: '' })
    expect(
      planBuildPublish({ entry: plain, shas: { binary: 'b', icon: 'i' } }, db, null, NOW).message,
    ).toBe('Add build: k3x9q2mf (My App 1.2.0)')
  })

  it('replaces a build in place, removing the files the new version no longer uses', () => {
    const existing = entryOf(android, { id: 'older', name: 'Older', icon: true })
    const index: BuildDb = { version: 1, entries: [entryOf(ios, { id: 'first' }), existing] }
    const next = entryOf(
      { ...android, version: '1.3.0', build: '46' },
      {
        id: 'older',
        name: 'Older',
        icon: false,
        existing,
        now: LATER,
      },
    )
    const plan = planBuildPublish(
      { entry: next, shas: { binary: 'b3', icon: null } },
      index,
      existing,
      LATER,
    )
    expect(plan.message).toBe('Update build: older (Older 1.3.0 (46))')
    expect(plan.db.entries.map((e) => e.id)).toEqual(['first', 'older'])
    expect(paths(plan.writes)).toContain('build/older/older-1.3.0-46.apk')
    expect(plan.deletes).toEqual(['build/older/older-1.2.0-45.apk', 'build/older/icon.png'])
    expect(plan.db.entries[1]?.created_at).toBe(existing.created_at)
  })

  it('overwrites a binary of the same name instead of deleting it', () => {
    const existing = entryOf(android, { id: 'older', name: 'Older' })
    const next = entryOf(android, { id: 'older', name: 'Older', existing, now: LATER })
    const plan = planBuildPublish(
      { entry: next, shas: { binary: 'b4', icon: 'i4' } },
      { version: 1, entries: [existing] },
      existing,
      LATER,
    )
    expect(plan.deletes).toEqual([])
  })

  it('removes only what is there when it knows what build/<id>/ holds', () => {
    const existing = entryOf(android, { id: 'older', name: 'Older', icon: true })
    const next = entryOf(
      { ...android, build: '46' },
      {
        id: 'older',
        name: 'Older',
        icon: false,
        existing,
      },
    )
    const plan = planBuildPublish(
      {
        entry: next,
        shas: { binary: 'b5', icon: null },
        // The icon was removed by hand: deleting it again would fail the whole commit.
        found: ['build/older/index.html', 'build/older/older-1.2.0-45.apk'],
      },
      { version: 1, entries: [existing] },
      existing,
      LATER,
    )
    expect(plan.deletes).toEqual(['build/older/older-1.2.0-45.apk'])
  })

  it('drops the manifest when a link moves from iOS to Android', () => {
    const existing = entryOf(ios, { id: 'older' })
    const next = entryOf(android, { id: 'older', existing })
    const plan = planBuildPublish(
      { entry: next, shas: { binary: 'b6', icon: 'i6' } },
      { version: 1, entries: [existing] },
      existing,
      LATER,
    )
    expect(plan.deletes).toEqual(['build/older/cai-luong-2.0-7.ipa', 'build/older/manifest.plist'])
  })

  it('refuses an entry and an upload that disagree about the icon', () => {
    expect(() =>
      planBuildPublish(
        { entry: entryOf(android, { icon: true }), shas: { binary: 'b', icon: null } },
        db,
        null,
        NOW,
      ),
    ).toThrow(/icon/)
    expect(() =>
      planBuildPublish(
        { entry: entryOf(android, { icon: false }), shas: { binary: 'b', icon: 'i' } },
        db,
        null,
        NOW,
      ),
    ).toThrow(/icon/)
  })
})

describe('every plan', () => {
  it('refuses an id or a file name that could reach outside build/<id>/', () => {
    const good = entryOf(android)
    const shas = { binary: 'b', icon: 'i' }
    for (const bad of [
      { ...good, id: '../site' },
      { ...good, id: 'a/b' },
      { ...good, file: '../../index.html' },
      { ...good, file: '_config.apk' },
      { ...good, file: 'app.ipa' },
    ]) {
      expect(() => planBuildPublish({ entry: bad, shas }, db, null, NOW)).toThrow(/Refusing/)
      expect(() => planBuildEdit(bad, { version: 1, entries: [bad] }, NOW)).toThrow(/Refusing/)
      expect(() => planBuildDelete(bad, [], db, NOW)).toThrow(/Refusing/)
    }
  })
})

describe('planBuildEdit', () => {
  it('regenerates the page and the index, keeping the build’s place and its files', () => {
    const second = entryOf(android, { id: 'second', name: 'Second' })
    const index: BuildDb = { version: 1, entries: [older, second] }
    const plan = planBuildEdit(
      { ...older, name: '  Renamed ', notes: 'New notes\r\n' },
      index,
      LATER,
    )
    expect(paths(plan.writes)).toEqual(['build/older/index.html', BUILD_DB_PATH])
    expect(plan.deletes).toEqual([])
    expect(plan.message).toBe('Edit build: older')
    expect(plan.db.entries.map((e) => e.id)).toEqual(['older', 'second'])
    const edited = plan.db.entries[0]
    expect(edited).toMatchObject({
      name: 'Renamed',
      notes: 'New notes',
      file: older.file,
      // A new name or notes is not a new upload: the page's "Uploaded" stays where it was.
      uploaded_at: older.uploaded_at,
      created_at: older.created_at,
      updated_at: LATER,
    })
    expect(Object.keys(edited ?? {})).toEqual(ENTRY_KEYS)
    expect(contentOf(plan.writes, 'build/older/index.html')).toBe(
      installPageHtml(edited ?? older, { qrSvg: qrSvg(buildUrl('older')) }),
    )
  })

  it('regenerates the manifest of an iOS build, whose title is the name', () => {
    const apple = entryOf(ios, { id: 'apple' })
    const plan = planBuildEdit(
      { ...apple, name: 'Renamed' },
      { version: 1, entries: [apple] },
      LATER,
    )
    expect(paths(plan.writes)).toEqual([
      'build/apple/index.html',
      'build/apple/manifest.plist',
      BUILD_DB_PATH,
    ])
  })

  it('refuses to edit a build the index does not have', () => {
    expect(() => planBuildEdit(entryOf(android, { id: 'gone' }), db, LATER)).toThrow(/gone/)
  })
})

describe('planBuildDelete', () => {
  it('removes every file found under the build’s directory, and its entry', () => {
    const entry = entryOf(ios, { id: 'apple' })
    const index: BuildDb = { version: 1, entries: [entry, older] }
    const plan = planBuildDelete(
      entry,
      [
        'build/apple/notes.txt',
        'build/apple/manifest.plist',
        'build/apple/icon.png',
        'build/apple/cai-luong-2.0-7.ipa',
        'build/apple/index.html',
        'build/apple/index.html',
      ],
      index,
      LATER,
    )
    expect(plan.deletes).toEqual([
      'build/apple/index.html',
      'build/apple/cai-luong-2.0-7.ipa',
      'build/apple/icon.png',
      'build/apple/manifest.plist',
      'build/apple/notes.txt',
    ])
    expect(paths(plan.writes)).toEqual([BUILD_DB_PATH])
    expect(plan.db.entries.map((e) => e.id)).toEqual(['older'])
    expect(plan.db.updated_at).toBe(LATER)
    expect(plan.message).toBe('Delete build: apple')
  })

  it('removes nothing that is not there, so a half-deleted build can still leave the list', () => {
    const plan = planBuildDelete(older, [], db, LATER)
    expect(plan.deletes).toEqual([])
    expect(plan.db.entries).toEqual([])
  })

  it('never removes anything outside the build’s own directory', () => {
    const plan = planBuildDelete(
      older,
      [
        'build/older/index.html',
        'build/other/index.html',
        'build/older-2/index.html',
        'build/older/nested/file.txt',
        'index.html',
        BUILD_DB_PATH,
      ],
      db,
      LATER,
    )
    expect(plan.deletes).toEqual(['build/older/index.html'])
  })
})

describe('buildConflict', () => {
  it('lets a change through when nothing happened since the sheet opened', () => {
    expect(buildConflict(older, db)).toBeNull()
    // Read back from the file, the same build is still the same.
    expect(buildConflict(older, parseBuildDb(JSON.stringify(db)))).toBeNull()
  })

  it('refuses to bring back a build deleted in the meantime', () => {
    expect(buildConflict(older, EMPTY_BUILD_DB)).toMatch(/"Older" was deleted after you opened it/)
  })

  it('refuses to undo a change made in the meantime', () => {
    const theirs: BuildDb = { version: 1, entries: [{ ...older, notes: 'Theirs' }] }
    expect(buildConflict(older, theirs)).toMatch(/"Older" was changed elsewhere/)
    const newer: BuildDb = { version: 1, entries: [{ ...older, sha256: 'cd'.repeat(32) }] }
    expect(buildConflict(older, newer, 'vi')).toMatch(/đã được sửa ở nơi khác/)
  })
})

describe('validateBuildDraft', () => {
  const draft = { id: 'k3x9q2mf', name: 'My App', notes: '' }

  it('accepts a complete draft', () => {
    expect(validateBuildDraft(draft, 'en')).toEqual([])
  })

  it('refuses a link the site cannot serve', () => {
    expect(validateBuildDraft({ ...draft, id: '' }, 'en')).toEqual(['Link is required'])
    for (const id of ['My-App', '-edge', 'a_b', 'a/b', '../x', 'x'.repeat(65)]) {
      expect(validateBuildDraft({ ...draft, id }, 'en'), id).toEqual([
        expect.stringContaining('The link may use only'),
      ])
    }
  })

  it('needs a name of a sensible length, and bounds the notes', () => {
    expect(validateBuildDraft({ ...draft, name: ' \n ' }, 'en')).toEqual(['App name is required'])
    expect(validateBuildDraft({ ...draft, name: 'x'.repeat(NAME_MAX) }, 'en')).toEqual([])
    expect(validateBuildDraft({ ...draft, name: 'x'.repeat(NAME_MAX + 1) }, 'en')).toEqual([
      `App name must be at most ${String(NAME_MAX)} characters`,
    ])
    expect(validateBuildDraft({ ...draft, notes: 'x'.repeat(NOTES_MAX) }, 'en')).toEqual([])
    expect(validateBuildDraft({ ...draft, notes: 'x'.repeat(NOTES_MAX + 1) }, 'en')).toEqual([
      `Release notes must be at most ${String(NOTES_MAX)} characters`,
    ])
  })

  it('says the same problems in Vietnamese, in the same order', () => {
    const blank = { id: '', name: '', notes: 'x'.repeat(NOTES_MAX + 1) }
    expect(validateBuildDraft(blank, 'en')).toHaveLength(3)
    expect(validateBuildDraft(blank, 'vi')).toEqual([
      'Cần nhập link',
      'Cần nhập tên ứng dụng',
      `Ghi chú phát hành tối đa ${String(NOTES_MAX)} ký tự`,
    ])
  })
})

describe('parseBuildDb', () => {
  it('reads an index back exactly as it was planned', () => {
    const plan = planBuildPublish(
      { entry: entryOf(ios), shas: { binary: 'b', icon: 'i' } },
      db,
      null,
      NOW,
    )
    const parsed = parseBuildDb(contentOf(plan.writes, BUILD_DB_PATH))
    expect(parsed).toEqual(plan.db)
    for (const entry of parsed.entries) expect(Object.keys(entry)).toEqual(ENTRY_KEYS)
  })

  it('refuses a file that is not an index', () => {
    expect(() => parseBuildDb('{"version":1}')).toThrow(/entries/)
    expect(() => parseBuildDb('[]')).toThrow(/entries/)
    expect(() => parseBuildDb('not json')).toThrow()
  })

  it('fills in what an older or hand-written entry leaves out', () => {
    const parsed = parseBuildDb(
      JSON.stringify({ entries: [{ id: 'bare', platform: 'android', file: 'bare.apk' }] }),
    )
    expect(parsed.version).toBe(1)
    expect(parsed.updated_at).toBeUndefined()
    expect(parsed.entries).toEqual([
      {
        id: 'bare',
        platform: 'android',
        name: 'bare',
        bundle_id: '',
        version: '',
        build: '',
        file: 'bare.apk',
        size: 0,
        sha256: '',
        icon: '',
        min_os: '',
        notes: '',
        android: null,
        ios: null,
        release: null,
        uploaded_at: '',
        created_at: '',
        updated_at: '',
      },
    ])
  })

  it('drops entries whose id, platform or file name could point anywhere else', () => {
    const good = { id: 'good', platform: 'android', file: 'good.apk' }
    const parsed = parseBuildDb(
      JSON.stringify({
        entries: [
          good,
          { ...good, id: 'Bad-Case' },
          { ...good, id: '../escape' },
          { ...good, id: '' },
          { ...good, id: 'win', platform: 'windows' },
          { ...good, id: 'dots', file: '../../index.html' },
          { ...good, id: 'hidden', file: '.hidden.apk' },
          { ...good, id: 'exe', file: 'setup.exe' },
          { ...good, id: 'swapped', file: 'swapped.ipa' },
          { ...good, id: 'apple', platform: 'ios', file: 'apple.apk' },
          'not an entry',
          null,
          [good],
          // A second entry for an id already seen: two cannot both own build/good/.
          { ...good, name: 'Duplicate' },
        ],
      }),
    )
    expect(parsed.entries.map((e) => [e.id, e.name])).toEqual([['good', 'good']])
  })

  it('narrows every field, and trusts no icon name but icon.png', () => {
    const [entry] = parseBuildDb(
      JSON.stringify({
        version: 2,
        updated_at: NOW,
        entries: [
          {
            id: 'apple',
            platform: 'ios',
            name: '  Apple  ',
            file: 'apple-1-1.ipa',
            size: -5,
            sha256: 'AB'.repeat(32),
            icon: '../index.html',
            android: { target_sdk: 34, debuggable: true, abis: [] },
            ios: {
              devices: ['iphone', 'watch', 7],
              profile: { kind: 'beta', name: 3, team: 'T', expires: '', device_count: -1 },
            },
          },
        ],
      }),
    ).entries
    expect(entry).toMatchObject({
      name: 'Apple',
      size: 0,
      sha256: '',
      icon: '',
      android: null,
      ios: {
        devices: ['iphone'],
        profile: { kind: 'unknown', name: '', team: 'T', expires: '', device_count: null },
      },
    })
    const android = parseBuildDb(
      JSON.stringify({
        entries: [
          {
            id: 'droid',
            platform: 'android',
            file: 'droid.apk',
            size: 1.5,
            icon: 'icon.png',
            android: { target_sdk: '35', debuggable: 'yes', abis: ['x86_64', 1] },
          },
        ],
      }),
    ).entries[0]
    expect(android).toMatchObject({
      size: 0,
      icon: 'icon.png',
      android: { target_sdk: 0, debuggable: false, abis: ['x86_64'] },
    })
  })
})

describe('readBuildDb', () => {
  const entry = (name: string): RepoEntry => ({ name, path: `build/${name}`, type: 'dir', size: 0 })

  function repoWith(text: string | null, listing: RepoEntry[] | null) {
    const calls: string[] = []
    return {
      calls,
      read: (path: string, ref?: string) => {
        calls.push(`read ${path} @${ref ?? 'master'}`)
        return Promise.resolve(text)
      },
      list: (path: string, ref?: string) => {
        calls.push(`list ${path} @${ref ?? 'master'}`)
        return Promise.resolve(listing)
      },
    }
  }

  it('reads the index at the commit it is given', async () => {
    const repo = repoWith(JSON.stringify(db), null)
    expect(await readBuildDb(repo, 'abc123')).toEqual(db)
    expect(repo.calls).toEqual([`read ${BUILD_DB_PATH} @abc123`])
  })

  it('starts empty where there has never been a build', async () => {
    expect(await readBuildDb(repoWith(null, null))).toEqual(EMPTY_BUILD_DB)
    expect(await readBuildDb(repoWith(null, []))).toEqual(EMPTY_BUILD_DB)
  })

  it('reports a missing index when builds exist, rather than an empty list', async () => {
    const repo = repoWith(null, [entry('k3x9q2mf')])
    expect(await readBuildDb(repo, 'abc123')).toBeNull()
    expect(repo.calls).toEqual([`read ${BUILD_DB_PATH} @abc123`, 'list build @abc123'])
  })
})

describe('idTaken', () => {
  const dir: RepoEntry = {
    name: 'index.html',
    path: 'build/k3x9q2mf/index.html',
    type: 'file',
    size: 10,
  }

  it('is taken by an entry, or by files nobody claims', () => {
    expect(idTaken('older', db, null)).toBe(true)
    expect(idTaken('k3x9q2mf', db, [dir])).toBe(true)
    expect(idTaken('k3x9q2mf', db, null)).toBe(false)
    expect(idTaken('k3x9q2mf', db, [])).toBe(false)
  })
})

describe('findings', () => {
  it('refuses 2 GiB and more, sends 100 MiB and more to a release, and warns from 50 MiB', () => {
    expect(sizeFindings(RELEASE_MAX_BYTES + 1)).toEqual({
      problems: [{ code: 'TOO_LARGE' }],
      warnings: [],
    })
    // A release file does not grow the repo: no LARGE beside it.
    for (const size of [MAX_BUILD_BYTES, RELEASE_MAX_BYTES]) {
      expect(sizeFindings(size)).toEqual({ problems: [], warnings: [{ code: 'VIA_RELEASE' }] })
    }
    expect(sizeFindings(MAX_BUILD_BYTES - 1)).toEqual({
      problems: [],
      warnings: [{ code: 'LARGE' }],
    })
    expect(sizeFindings(WARN_BUILD_BYTES).warnings).toEqual([{ code: 'LARGE' }])
    expect(sizeFindings(WARN_BUILD_BYTES - 1)).toEqual({ problems: [], warnings: [] })
  })

  it('refuses another platform under a link, and warns about another app', () => {
    const current = entryOf(android, { id: 'older' })
    expect(replaceFindings(current, ios).problems).toEqual([{ code: 'REPLACE_PLATFORM' }])
    expect(replaceFindings(current, { ...android, bundleId: 'com.other' })).toEqual({
      problems: [],
      warnings: [{ code: 'REPLACE_BUNDLE', detail: 'com.example.app' }],
    })
    expect(replaceFindings(current, android)).toEqual({ problems: [], warnings: [] })
    // A bundle id one side could not read is not a different app.
    expect(replaceFindings(current, { ...android, bundleId: '' }).warnings).toEqual([])
  })

  it('merges findings with each code once, and never warns about what already blocks', () => {
    const merged = mergeFindings(
      { problems: [{ code: 'APK_TEST_ONLY' }], warnings: [{ code: 'LARGE' }] },
      sizeFindings(RELEASE_MAX_BYTES + 1),
      { problems: [{ code: 'TOO_LARGE' }], warnings: [{ code: 'TOO_LARGE' }] },
      { problems: [], warnings: [{ code: 'APK_DEBUGGABLE' }, { code: 'LARGE' }] },
    )
    expect(merged.problems.map((p) => p.code)).toEqual(['APK_TEST_ONLY', 'TOO_LARGE'])
    expect(merged.warnings.map((w) => w.code)).toEqual(['LARGE', 'APK_DEBUGGABLE'])
  })

  it('adds what the size and the link say to what the file says', () => {
    const iosLink = entryOf(ios, { id: 'older' })
    const debuggable: BuildInspection = { ...android, warnings: [{ code: 'APK_DEBUGGABLE' }] }
    expect(fileFindings(debuggable, RELEASE_MAX_BYTES + 1, null)).toEqual({
      problems: [{ code: 'TOO_LARGE' }],
      warnings: [{ code: 'APK_DEBUGGABLE' }],
    })
    expect(fileFindings(debuggable, MAX_BUILD_BYTES, null)).toEqual({
      problems: [],
      warnings: [{ code: 'APK_DEBUGGABLE' }, { code: 'VIA_RELEASE' }],
    })
    expect(fileFindings(android, WARN_BUILD_BYTES, iosLink)).toEqual({
      problems: [{ code: 'REPLACE_PLATFORM' }],
      warnings: [{ code: 'LARGE' }],
    })
    expect(fileFindings(android, MiB, null)).toEqual({ problems: [], warnings: [] })
  })

  it('says only that a file is not a build, and nothing about the build it is not', () => {
    // A 150 MB CI .zip dropped as a new version of an iOS build: inspect/ refuses it as no
    // build, guessing Android for its platform. Neither the size advice nor the platform clash
    // is about this file.
    const zip: BuildInspection = {
      ...android,
      name: 'build',
      bundleId: '',
      version: '',
      build: '',
      minOs: '',
      android: null,
      problems: [{ code: 'NOT_A_BUILD' }],
    }
    expect(fileFindings(zip, 150 * MiB, entryOf(ios, { id: 'older' }))).toEqual({
      problems: [{ code: 'NOT_A_BUILD' }],
      warnings: [],
    })
    expect(fileFindings(zip, 150 * MiB, null).problems).toEqual([{ code: 'NOT_A_BUILD' }])
    // An error page saved as app.ipa takes iOS from its name, and is still no build to refuse
    // under an Android link, nor one to warn about as a large upload.
    const page: BuildInspection = { ...zip, platform: 'ios', name: 'app' }
    expect(fileFindings(page, 60 * MiB, entryOf(android, { id: 'older' }))).toEqual({
      problems: [{ code: 'NOT_A_BUILD' }],
      warnings: [],
    })
  })
})

describe('wording', () => {
  const values = {
    detail: 'config.arm64_v8a',
    date: '07-Oct-2026 08:15',
    size: '123 MB',
    devices: '12',
    platform: 'iOS',
  }
  const en = BUILD_MESSAGES.en.finding
  const vi = BUILD_MESSAGES.vi.finding

  it('words every finding in both languages, with the values it is given', () => {
    // Every code there is: the wording is typed by FindingCode, so its keys are the full list.
    const codes = Object.keys(en) as FindingCode[]
    expect(codes).toContain('APK_V1_ONLY')
    expect(Object.keys(vi)).toEqual(codes)
    for (const words of [en, vi]) {
      for (const code of codes) {
        expect(words[code](values).length, code).toBeGreaterThan(20)
      }
      expect(words.TOO_LARGE(values)).toContain('123 MB')
      expect(words.TOO_LARGE(values)).toContain('2 GB')
      expect(words.TOO_LARGE(values)).not.toContain('100 MB')
      expect(words.VIA_RELEASE(values)).toContain('123 MB')
      expect(words.VIA_RELEASE(values)).toContain('100 MB')
      expect(words.VIA_RELEASE(values)).toContain('GitHub Releases')
      expect(words.IPA_EXPIRES_SOON(values)).toContain(values.date)
      expect(words.IPA_DEVELOPMENT(values)).toContain('12')
      expect(words.REPLACE_PLATFORM(values)).toContain('iOS')
    }
    expect(en.IPA_DEVELOPMENT(values)).toMatch(/Developer Mode/)
    expect(vi.IPA_DEVELOPMENT(values)).toMatch(/Chế độ nhà phát triển/)
  })

  it('sends an APK back to a build the console takes, through Android Studio’s menu as it is now', () => {
    const menu = 'Build › Generate Bundle(s) / APK(s) › Generate APK(s)'
    for (const words of [en, vi]) {
      expect(words.APK_SPLIT(values)).toContain(menu)
      expect(words.APK_TEST_ONLY(values)).toContain(menu)
      // bundletool writes an .apks set, which the console refuses: the APK is inside it.
      expect(words.APK_SPLIT(values)).toMatch(/universal\.apk .*\.apks/)
      // A release build without a signingConfig is unsigned, and refused in turn.
      expect(words.APK_TEST_ONLY(values)).toContain('./gradlew assembleDebug')
      expect(words.APK_TEST_ONLY(values)).toContain('signingConfig')
      expect(words.APK_TEST_ONLY(values)).not.toContain('assembleRelease')
      expect(words.APK_SPLIT(values)).not.toContain('Build › Build APK(s)')
    }
    expect(en.APK_SPLIT(values)).toContain('(config.arm64_v8a)')
  })

  it('says why a v1-only signature is refused, and how to add v2', () => {
    expect(en.APK_V1_ONLY(values)).toMatch(/v1 \(JAR\).*API 30.*Android 11/)
    for (const words of [en, vi]) {
      expect(words.APK_V1_ONLY(values)).toContain('v2SigningEnabled')
      expect(words.APK_V1_ONLY(values)).toContain('apksigner')
    }
    // Not the unsigned wording: this APK is signed, only not well enough.
    expect(en.APK_V1_ONLY(values)).not.toMatch(/not signed/)
  })

  it('gives size advice for either platform: R8 does not shrink an IPA', () => {
    expect(en.TOO_LARGE(values)).toMatch(/Android: .*R8.*; iOS: /)
    expect(vi.TOO_LARGE(values)).toMatch(/Android: .*R8.*; iOS: /)
  })

  it('names the ways to distribute an IPA as Xcode’s Organizer shows them now', () => {
    const methods = 'Release Testing (Ad Hoc), Debugging (Development)'
    for (const code of ['IPA_NO_PROFILE', 'IPA_APP_STORE'] as const) {
      expect(en[code](values)).toContain(`${methods} or Enterprise`)
      expect(vi[code](values)).toContain(`${methods} hoặc Enterprise`)
    }
    expect(en.IPA_NO_PROFILE(values)).toContain('Distribute App › Release Testing')
    expect(vi.IPA_NO_PROFILE(values)).toContain('Distribute App › Release Testing')
    expect(BUILD_MESSAGES.en.sheet.dropHint).toContain(`Distribute App › ${methods} or Enterprise`)
    expect(BUILD_MESSAGES.vi.sheet.dropHint).toContain(
      `Distribute App › ${methods} hoặc Enterprise`,
    )
  })

  it('counts the devices a development build is limited to, one or many', () => {
    const at = (devices: string) => en.IPA_DEVELOPMENT({ ...values, devices })
    expect(at('1')).toContain('only the one registered device can install it')
    expect(at('12')).toContain('only the 12 registered devices can install it')
    expect(at('')).toContain('only registered devices can install it')
    expect(vi.IPA_DEVELOPMENT({ ...values, devices: '1' })).toContain('chỉ 1 thiết bị đã đăng ký')
    expect(vi.IPA_DEVELOPMENT({ ...values, devices: '' })).toContain('chỉ thiết bị đã đăng ký')
  })

  it('announces what reading a file found, counted in each language', () => {
    const said = BUILD_MESSAGES.en.sheet.readResult
    expect(said('My App 1.2.0 (45)', 1, 1)).toBe('Read My App 1.2.0 (45): 1 problem, 1 warning')
    expect(said('My App 1.2.0 (45)', 2, 0)).toBe('Read My App 1.2.0 (45): 2 problems')
    expect(said('My App', 0, 3)).toBe('Read My App: 3 warnings')
    expect(said('My App', 0, 0)).toBe('Read My App: no problems')
    const viSaid = BUILD_MESSAGES.vi.sheet.readResult
    expect(viSaid('My App 1.2.0 (45)', 1, 1)).toBe('Đã đọc My App 1.2.0 (45): 1 vấn đề, 1 cảnh báo')
    expect(viSaid('My App', 2, 0)).toBe('Đã đọc My App: 2 vấn đề')
    expect(viSaid('My App', 0, 0)).toBe('Đã đọc My App: không có vấn đề nào')
  })
})

describe('suggestedName', () => {
  const link = entryOf(android, { id: 'older', name: 'Renamed by the owner' })

  it('names a new link after the app', () => {
    expect(suggestedName(android, null)).toBe('My App')
  })

  it('keeps the link’s name for a new version of the same app', () => {
    expect(suggestedName({ ...android, name: 'Label', version: '1.3.0' }, link)).toBe(
      'Renamed by the owner',
    )
    // A bundle id that could not be read (a file that is no build, say) is not another app.
    expect(suggestedName({ ...android, name: 'build', bundleId: '' }, link)).toBe(
      'Renamed by the owner',
    )
    // Nor is another platform, which is refused anyway (REPLACE_PLATFORM).
    expect(suggestedName(ios, link)).toBe('Renamed by the owner')
  })

  it('takes another app’s own name, which the link’s would misstate', () => {
    expect(suggestedName({ ...android, name: 'Other App', bundleId: 'com.other' }, link)).toBe(
      'Other App',
    )
  })
})

describe('what the list shows', () => {
  it('labels a version with its build number', () => {
    expect(versionLabel({ version: '1.2.0', build: '45' })).toBe('1.2.0 (45)')
    expect(versionLabel({ version: '1.2.0', build: '' })).toBe('1.2.0')
    expect(versionLabel({ version: '', build: '45' })).toBe('(45)')
    expect(versionLabel({ version: ' ', build: ' ' })).toBe('')
  })

  it('adds up the binaries', () => {
    expect(storageUsed(EMPTY_BUILD_DB)).toBe(0)
    expect(
      storageUsed({ version: 1, entries: [older, { ...older, id: 'two', size: 5 * MiB }] }),
    ).toBe(older.size + 5 * MiB)
  })

  it('finds a build by any word of its name, bundle id, version or link, accents or not', () => {
    const apple = entryOf(ios, { id: 'apple-beta', name: 'Cải Lương Đêm' })
    for (const query of ['', '  ', 'cai luong', 'CẢI', 'dem', 'vn.plsoft', '2.0', 'apple-beta']) {
      expect(matchesBuild(apple, query), query).toBe(true)
    }
    for (const query of ['android', 'cai xyz', 'com.example']) {
      expect(matchesBuild(apple, query), query).toBe(false)
    }
  })

  it('writes upload progress in the total’s unit', () => {
    expect(uploadedOf(Math.round(12.3 * MiB), Math.round(45.6 * MiB), 'en')).toEqual({
      sent: '12.3',
      total: '45.6 MB',
    })
    expect(uploadedOf(Math.round(12.3 * MiB), Math.round(45.6 * MiB), 'vi')).toEqual({
      sent: '12,3',
      total: '45,6 MB',
    })
    expect(uploadedOf(50 * MiB, 150 * MiB, 'en')).toEqual({ sent: '50', total: '150 MB' })
    expect(uploadedOf(512 * 1024, 2 * MiB, 'en')).toEqual({ sent: '0.5', total: '2.0 MB' })
    expect(uploadedOf(700, 1000, 'en')).toEqual({ sent: '700', total: '1,000 B' })
    // Never more than the whole, nor less than nothing.
    expect(uploadedOf(3 * MiB, 2 * MiB, 'en').sent).toBe('2.0')
    expect(uploadedOf(-1, 2 * MiB, 'en').sent).toBe('0.0')
  })

  it('hashes a file as lowercase hex SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('a build whose binary is a GitHub Release’s asset (100 MiB or more)', () => {
  const RELEASE = { id: 182736455, tag: 'build-k3x9q2mf-20261007011500', asset_id: 9081726 }
  const big = (more: Partial<EntryInput> = {}) =>
    entryOf(android, { size: 300 * MiB, release: RELEASE, ...more })

  it('records the release after the platform’s facts, its own keys in order too', () => {
    const entry = big()
    expect(entry.release).toEqual(RELEASE)
    expect(Object.keys(entry)).toEqual(ENTRY_KEYS)
    expect(Object.keys(entry.release ?? {})).toEqual(['id', 'tag', 'asset_id'])
    // Every other build: null, never missing.
    expect(entryOf(android).release).toBeNull()
  })

  it('names the release after the app and its version, and links the install page', () => {
    const now = new Date('2026-10-07T01:15:00.000Z')
    expect(
      releaseFor({ id: 'k3x9q2mf', name: '  My   App ', version: '1.2.0', build: '45' }, now),
    ).toEqual({
      tag: 'build-k3x9q2mf-20261007011500',
      name: 'My App 1.2.0 (45)',
      body: 'Install page: https://bauloc.github.io/build/k3x9q2mf/',
    })
    expect(releaseFor({ id: 'x1', name: '', version: '', build: '' }, now).name).toBe('x1')
  })

  it('publishes without writing the binary, and links it from the page', () => {
    const entry = big()
    const plan = planBuildPublish({ entry, shas: { binary: null, icon: 'i1' } }, db, null, NOW)
    expect(paths(plan.writes)).toEqual([
      'build/k3x9q2mf/icon.png',
      'build/k3x9q2mf/index.html',
      BUILD_DB_PATH,
    ])
    expect(plan.message).toBe('Add build: k3x9q2mf (My App 1.2.0 (45))')
    expect(plan.db.entries[0]?.release).toEqual(RELEASE)
    expect(contentOf(plan.writes, 'build/k3x9q2mf/index.html')).toContain(
      `href="https://github.com/bauloc/bauloc.github.io/releases/download/${RELEASE.tag}/my-app-1.2.0-45.apk"`,
    )
    // The index reads back with the release, exactly.
    expect(parseBuildDb(contentOf(plan.writes, BUILD_DB_PATH))).toEqual(plan.db)
  })

  it('writes an iOS build’s manifest pointing at the release', () => {
    const entry = entryOf(ios, { size: 300 * MiB, release: RELEASE, icon: false })
    const plan = planBuildPublish({ entry, shas: { binary: null, icon: null } }, db, null, NOW)
    expect(paths(plan.writes)).toEqual([
      'build/k3x9q2mf/index.html',
      'build/k3x9q2mf/manifest.plist',
      BUILD_DB_PATH,
    ])
    expect(contentOf(plan.writes, 'build/k3x9q2mf/manifest.plist')).toContain(
      `<string>https://github.com/bauloc/bauloc.github.io/releases/download/${RELEASE.tag}/cai-luong-2.0-7.ipa</string>`,
    )
  })

  it('refuses a binary both in the repo and in a release, or in neither', () => {
    expect(() =>
      planBuildPublish({ entry: big(), shas: { binary: 'b', icon: 'i' } }, db, null, NOW),
    ).toThrow(/repo or in a release/)
    expect(() =>
      planBuildPublish(
        { entry: entryOf(android), shas: { binary: null, icon: 'i' } },
        db,
        null,
        NOW,
      ),
    ).toThrow(/repo or in a release/)
  })

  it('removes the repo’s binary when a new version goes to a release, even of the same name', () => {
    const existing = entryOf(android, { id: 'older', name: 'Older' })
    const next = big({
      id: 'older',
      name: 'Older',
      existing,
      now: LATER,
      release: { ...RELEASE, tag: 'build-older-20261008023000' },
    })
    expect(next.file).toBe(existing.file)
    const plan = planBuildPublish(
      {
        entry: next,
        shas: { binary: null, icon: 'i' },
        found: ['build/older/index.html', 'build/older/icon.png', `build/older/${existing.file}`],
      },
      { version: 1, entries: [existing] },
      existing,
      LATER,
    )
    expect(plan.deletes).toEqual([`build/older/${existing.file}`])
    expect(paths(plan.writes)).not.toContain(`build/older/${existing.file}`)
  })

  it('puts a new version back in the repo with nothing of the old release to remove there', () => {
    const existing = big({
      id: 'older',
      name: 'Older',
      release: { ...RELEASE, tag: 'build-older-20261007011500' },
    })
    const next = entryOf(
      { ...android, build: '46' },
      { id: 'older', name: 'Older', existing, now: LATER },
    )
    const plan = planBuildPublish(
      {
        entry: next,
        shas: { binary: 'b7', icon: 'i7' },
        found: ['build/older/index.html', 'build/older/icon.png'],
      },
      { version: 1, entries: [existing] },
      existing,
      LATER,
    )
    expect(plan.deletes).toEqual([])
    expect(plan.writes[0]).toEqual({ path: 'build/older/older-1.2.0-46.apk', sha: 'b7' })
    expect(plan.db.entries[0]?.release).toBeNull()
  })

  it('keeps the release through an edit of the name or notes', () => {
    const entry = big()
    const plan = planBuildEdit({ ...entry, notes: 'New' }, { version: 1, entries: [entry] }, LATER)
    expect(plan.db.entries[0]?.release).toEqual(RELEASE)
    expect(paths(plan.writes)).toEqual(['build/k3x9q2mf/index.html', BUILD_DB_PATH])
    expect(contentOf(plan.writes, 'build/k3x9q2mf/index.html')).toContain(RELEASE.tag)
  })

  it('deletes only what the build has in the repo: the release goes apart, after the commit', () => {
    const entry = big()
    const plan = planBuildDelete(
      entry,
      ['build/k3x9q2mf/index.html', 'build/k3x9q2mf/icon.png'],
      { version: 1, entries: [entry] },
      LATER,
    )
    expect(plan.deletes).toEqual(['build/k3x9q2mf/index.html', 'build/k3x9q2mf/icon.png'])
  })

  it('sees a release changed elsewhere as a change', () => {
    const entry = big()
    const theirs: BuildDb = {
      version: 1,
      entries: [{ ...entry, release: { ...RELEASE, asset_id: RELEASE.asset_id + 1 } }],
    }
    expect(buildConflict(entry, theirs)).toMatch(/was changed elsewhere/)
    expect(buildConflict(entry, { version: 1, entries: [entry] })).toBeNull()
  })

  it('does not count a release’s binary against the site’s storage', () => {
    const repoBuild = { ...older, size: 40 * MiB }
    expect(
      storageUsed({
        version: 1,
        entries: [
          repoBuild,
          big({ id: 'big1', release: { ...RELEASE, tag: 'build-big1-20261007011500' } }),
        ],
      }),
    ).toBe(40 * MiB)
  })

  it('never warns about the repo’s history for a file that goes to a release', () => {
    const merged = mergeFindings(
      { problems: [], warnings: [{ code: 'LARGE' }, { code: 'APK_DEBUGGABLE' }] },
      sizeFindings(MAX_BUILD_BYTES),
    )
    expect(merged.warnings.map((w) => w.code)).toEqual(['APK_DEBUGGABLE', 'VIA_RELEASE'])
  })
})

describe('parseBuildDb and a release', () => {
  const good = {
    id: 'big1',
    platform: 'android',
    file: 'big.apk',
    release: { id: 182736455, tag: 'build-big1-20261007011500', asset_id: 9081726 },
  }
  const ids = (entries: unknown[]) =>
    parseBuildDb(JSON.stringify({ entries })).entries.map((e) => e.id)

  it('keeps a release it can trust, and reads none (or null) as the repo', () => {
    const [entry] = parseBuildDb(JSON.stringify({ entries: [good] })).entries
    expect(entry?.release).toEqual(good.release)
    const plain = parseBuildDb(
      JSON.stringify({
        entries: [
          { ...good, id: 'a', release: null },
          { id: 'b', platform: 'android', file: 'b.apk' },
        ],
      }),
    ).entries
    expect(plain.map((e) => [e.id, e.release])).toEqual([
      ['a', null],
      ['b', null],
    ])
  })

  it('drops an entry whose release could point anywhere else, or delete anything else', () => {
    const release = good.release
    expect(
      ids([
        good,
        { ...good, id: 'r1', release: 'build-r1-20261007011500' },
        { ...good, id: 'r2', release: [] },
        { ...good, id: 'r3', release: { ...release, tag: 'build-r3-20261007011500', id: 0 } },
        { ...good, id: 'r4', release: { ...release, tag: 'build-r4-20261007011500', id: '5' } },
        { ...good, id: 'r5', release: { ...release, tag: 'build-r5-20261007011500', id: 1.5 } },
        { ...good, id: 'r6', release: { id: 1, tag: 'build-r6-20261007011500' } },
        {
          ...good,
          id: 'r7',
          release: { ...release, tag: 'build-r7-20261007011500', asset_id: -2 },
        },
        { ...good, id: 'r8', release: { ...release, tag: 'v1.0' } },
        { ...good, id: 'r9', release: { ...release, tag: '../../heads/master' } },
        // Another build's release: its file would show on this page, and go with this build.
        { ...good, id: 'r10', release },
        { ...good, id: 'r11', release: { ...release, tag: 'build-r11-x-20261007011500' } },
        { ...good, id: 'r12', release: { ...release, tag: 'build-r12-2026100701150' } },
      ]),
    ).toEqual(['big1'])
  })
})

describe('deleteBuildRelease', () => {
  const release = { id: 42, tag: 'build-big-20261001010000' }
  const repoThat = (fails: { release?: boolean; tag?: boolean } = {}) => {
    const calls: string[] = []
    return {
      calls,
      deleteRelease: (id: number) => {
        calls.push(`release ${String(id)}`)
        return fails.release ? Promise.reject(new Error('offline')) : Promise.resolve()
      },
      deleteTag: (tag: string) => {
        calls.push(`tag ${tag}`)
        return fails.tag ? Promise.reject(new Error('offline')) : Promise.resolve()
      },
    }
  }

  it('deletes the release, then its tag, and says both are gone', async () => {
    const repo = repoThat()
    expect(await deleteBuildRelease(repo, release)).toBe(true)
    expect(repo.calls).toEqual(['release 42', 'tag build-big-20261001010000'])
  })

  it('tries the tag even when the release stays, and never rejects', async () => {
    const stuck = repoThat({ release: true })
    expect(await deleteBuildRelease(stuck, release)).toBe(false)
    expect(stuck.calls).toEqual(['release 42', 'tag build-big-20261001010000'])
    expect(await deleteBuildRelease(repoThat({ tag: true }), release)).toBe(false)
  })
})
