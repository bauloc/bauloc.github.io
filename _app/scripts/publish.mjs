#!/usr/bin/env node
/**
 * publish.mjs — sync `_app/dist/` out to the repo root, then assert the whole URL contract.
 *
 * GitHub Pages serves this repo from the `master` branch root, so "deploying" means writing
 * build output into the repo and committing it. That is a deliberate choice, not a shortcut:
 * `/terms/{slug}/`, `/privacy/{slug}/` and `/iptv` are committed directly by the in-browser
 * xconsole and served by Pages within ~60s with no build in the loop. Putting them behind a
 * build would mean an app-store-facing legal page could not go live without CI, or without
 * someone opening a laptop.
 *
 * The consequence is that this script shares a directory with files it must never touch.
 * So it owns an explicit, short list of paths and refuses to write anywhere else — and it
 * verifies afterwards that the untouched paths were in fact untouched, byte for byte.
 *
 *   node scripts/publish.mjs                # sync + assert
 *   node scripts/publish.mjs --check-only   # assert only, write nothing
 */

import { readdirSync, statSync, existsSync, rmSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const ROOT = path.resolve(APP, '..')
const DIST = path.join(APP, 'dist')

const CHECK_ONLY = process.argv.includes('--check-only')

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

/**
 * Paths this script owns. Everything here is overwritten on every publish, so nothing
 * hand-written may live at these paths.
 */
const OWNED_FILES = ['index.html', '404.html']
const OWNED_DIRS = ['assets']

/**
 * Section shells: a byte copy of index.html placed at `<section>/index.html` so that the
 * bookmarked URL `/<section>/` answers 200 from a real file instead of 404-ing into the SPA
 * fallback. Asset URLs are root-absolute, so the same HTML boots from any path.
 *
 * Entries are added as each area is ported: 'xconsole' in stage 3, 'device' in stage 4.
 * Adding one early would replace a working page with a shell the router cannot yet serve.
 */
const SECTIONS = []

/**
 * Paths this script must NEVER write, and which must exist. These are published directly —
 * by the browser console (terms/privacy/iptv/data), by a Flutter build (profile), or by hand
 * (device/agent) — and a build must not be able to change or delete them.
 */
const PROTECTED = [
  'terms',
  'privacy',
  'iptv',
  'profile',
  'data',
  path.join('device', 'agent'),
]

/** A published page slug. Also the name of a directory under terms/ and privacy/. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const failures = []
const notes = []

function check(ok, message) {
  if (ok) notes.push(`  ok    ${message}`)
  else failures.push(message)
  return ok
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full))
  }
  return out.sort()
}

/** Cheap identity of a protected tree: every relative path plus its size. */
function fingerprint(rel) {
  const full = path.join(ROOT, rel)
  if (!existsSync(full)) return null
  if (statSync(full).isFile()) return `${rel}:${statSync(full).size}`
  return walk(full)
    .map((f) => `${f}:${statSync(path.join(full, f)).size}`)
    .join('\n')
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry)
    const dst = path.join(to, entry)
    if (statSync(src).isDirectory()) copyDir(src, dst)
    else copyFileSync(src, dst)
  }
}

/* ------------------------------------------------------------------ *
 * 1. Pre-flight on dist/
 * ------------------------------------------------------------------ */

if (!existsSync(DIST)) {
  console.error('publish: _app/dist does not exist. Run `npm run build` first.')
  process.exit(1)
}

const distIndex = path.join(DIST, 'index.html')
check(existsSync(distIndex), 'dist/index.html exists')

/*
  THE JEKYLL TRAP. Pages runs this repo through Jekyll, whose EntryFilter drops any entry
  whose basename starts with `_` — the same rule that keeps `_app/` and `_deprecated/` off
  the internet. TanStack Router's autoCodeSplitting would otherwise emit `_app-<hash>.js`
  and `_id-<hash>.js`, and a dropped chunk fails at the first navigation, looking like a
  bundler bug. vite.config.ts forces a `c-` prefix; this is the assertion that keeps it true.
*/
const distAssets = path.join(DIST, 'assets')
const underscored = existsSync(distAssets)
  ? readdirSync(distAssets).filter((f) => f.startsWith('_'))
  : []
check(
  underscored.length === 0,
  underscored.length === 0
    ? 'no leading-underscore chunk in dist/assets (Jekyll would drop them)'
    : `dist/assets has leading-underscore files Jekyll WILL DROP: ${underscored.join(', ')}`,
)

/* ------------------------------------------------------------------ *
 * 2. Snapshot the protected paths, sync, then prove they did not move
 * ------------------------------------------------------------------ */

const before = new Map(PROTECTED.map((p) => [p, fingerprint(p)]))

if (!CHECK_ONLY) {
  // assets/ is exclusively build output, so wiping it is safe and stops stale hashed
  // chunks accumulating in git forever.
  for (const dir of OWNED_DIRS) rmSync(path.join(ROOT, dir), { recursive: true, force: true })

  for (const dir of OWNED_DIRS) {
    const from = path.join(DIST, dir)
    if (existsSync(from)) copyDir(from, path.join(ROOT, dir))
  }

  copyFileSync(distIndex, path.join(ROOT, 'index.html'))

  /*
    404.html is a byte copy of index.html — the standard GitHub Pages SPA fallback. It must
    be produced HERE and not shipped from a `public/` directory: Vite copies public/ before
    it writes the bundle, so a hand-written 404.html would reference the *previous* build's
    hashed chunks and would not be overwritten.

    It replaces the old rafgraph spa-github-pages encoder, which was actively harmful: its
    decoder had been deleted from profile/index.html, so `/terms/no-such-slug/` bounced to
    `/profile/` with a 200 — an app-store reviewer with a typo saw a Flutter portfolio.
  */
  copyFileSync(distIndex, path.join(ROOT, '404.html'))

  for (const section of SECTIONS) {
    mkdirSync(path.join(ROOT, section), { recursive: true })
    copyFileSync(distIndex, path.join(ROOT, section, 'index.html'))
  }
}

for (const [rel, fp] of before) {
  const now = fingerprint(rel)
  check(fp !== null, `protected path exists: ${rel}`)
  check(now === fp, `protected path untouched by publish: ${rel}`)
}

/* ------------------------------------------------------------------ *
 * 3. Assert the served contract
 * ------------------------------------------------------------------ */

for (const f of [...OWNED_FILES, ...SECTIONS.map((s) => path.join(s, 'index.html'))]) {
  check(existsSync(path.join(ROOT, f)), `published: /${f.split(path.sep).join('/')}`)
}

check(
  existsSync(path.join(ROOT, 'assets')) && readdirSync(path.join(ROOT, 'assets')).length > 0,
  'published: /assets/ is non-empty',
)

// /iptv is consumed directly by IPTV player apps. It must stay a real file at the root and
// must never gain an extension.
const iptv = path.join(ROOT, 'iptv')
check(existsSync(iptv) && statSync(iptv).isFile(), '/iptv is a real file')
check(
  readFileSync(iptv, 'utf8').startsWith('#EXTM3U'),
  '/iptv still starts with #EXTM3U',
)

// Store-facing pages must be real static HTML, never SPA routes: a store reviewer's crawler
// does not run JS.
for (const kind of ['terms', 'privacy']) {
  const dir = path.join(ROOT, kind)
  if (!existsSync(dir)) continue
  for (const slug of readdirSync(dir)) {
    if (!statSync(path.join(dir, slug)).isDirectory()) continue
    check(SLUG.test(slug), `/${kind}/${slug}/ slug is well-formed`)
    check(
      existsSync(path.join(dir, slug, 'index.html')),
      `/${kind}/${slug}/ has a real index.html`,
    )
  }
}

/*
  A root `.nojekyll` is the single most destructive one-file change available in this repo:
  it turns Jekyll off, and Jekyll's underscore rule is the ONLY thing keeping `_app/`
  (including node_modules) and `_deprecated/` (148 MB) off the public internet.
*/
check(!existsSync(path.join(ROOT, '.nojekyll')), 'no root .nojekyll (would publish _app/ and _deprecated/)')

// The old spa-github-pages encoder must be gone, not merely bypassed: it rewrites
// location.pathname before the router can read it.
if (existsSync(path.join(ROOT, '404.html'))) {
  check(
    !readFileSync(path.join(ROOT, '404.html'), 'utf8').includes('pathSegmentsToKeep'),
    '404.html is the SPA shell, not the old redirect encoder',
  )
}

/* ------------------------------------------------------------------ *
 * 4. Report
 * ------------------------------------------------------------------ */

const verb = CHECK_ONLY ? 'check' : 'publish'

if (failures.length > 0) {
  console.error(`\n${verb}: FAILED ${failures.length} of ${failures.length + notes.length} checks\n`)
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error('\nNothing was committed. The previous site stays up.\n')
  process.exit(1)
}

console.log(`\n${verb}: all ${notes.length} checks passed`)
console.log(notes.join('\n'))
if (!CHECK_ONLY) {
  console.log(`\nWrote: /index.html, /404.html, /assets/${SECTIONS.length ? `, ${SECTIONS.map((s) => `/${s}/index.html`).join(', ')}` : ''}`)
  console.log('Commit and push to deploy.\n')
}
