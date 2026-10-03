import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DB_PATH, SLUG_PATTERN, pagePath, parseDb } from './model'

/*
  The console's data, checked where it actually lives in this repo. The path constants and
  the files must move together: a console that reads a missing index would show an empty
  list — and the legacy console then wrote that empty list back over the real one.
*/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const db = parseDb(readFileSync(path.join(ROOT, DB_PATH), 'utf8'))

describe('data/term-privacy in this repo', () => {
  it('has an index at the path the console reads', () => {
    expect(db.entries.length).toBeGreaterThan(0)
  })

  it.each(db.entries.map((e) => [e.slug]))(
    '%s has its answers, both pages and a valid slug',
    (slug) => {
      expect(slug).toMatch(SLUG_PATTERN)
      for (const rel of [
        pagePath(slug),
        `terms/${slug}/index.html`,
        `privacy/${slug}/index.html`,
      ]) {
        expect(existsSync(path.join(ROOT, rel)), rel).toBe(true)
      }
    },
  )
})
