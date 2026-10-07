#!/usr/bin/env node
/**
 * publish.mjs — sync `_app/dist/` out to the repo root, then assert the whole URL contract.
 *
 * GitHub Pages serves this repo from the `master` branch root, so "deploying" means writing
 * build output into the repo and committing it. That is a deliberate choice, not a shortcut:
 * `/terms/{slug}/`, `/privacy/{slug}/`, `/iptv`, `/build/{id}/` and `/artifact/{id}.html` are
 * committed directly by the in-browser xconsole and served by Pages within ~60s with no build
 * in the loop. Putting them behind a
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

import {
  readdirSync,
  statSync,
  existsSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
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
 * Section shells: a copy of index.html placed at `<section>/index.html` so that the
 * bookmarked URL `/<section>/` answers 200 from a real file instead of 404-ing into the SPA
 * fallback. Asset URLs are root-absolute, so the same HTML boots from any path.
 *
 * `head` gives a section its own title and description. Link previews (Zalo, Telegram,
 * Facebook) read them from the HTML without running JS, so a shared /profile/ link would
 * otherwise be previewed as "bauloc.github.io". Everything else stays byte-identical.
 *
 * Entries are added as each area is ported: 'profile' when the Flutter bundle was replaced,
 * 'xconsole' when the console moved into the app, 'device' when Device Lab did. Adding one
 * early would replace a working page with a shell the router cannot yet serve.
 */
const SECTIONS = [
  {
    path: 'profile',
    head: {
      // The Flutter build's own title and manifest description, so previews read as before.
      title: "BAULOC's Profile",
      description: "BAULOC's Profile - Software Developer",
    },
  },
  {
    path: 'xconsole',
    head: {
      title: 'XConsole',
      description: 'Publish app Terms & Privacy pages straight to this repo.',
    },
  },
  {
    path: 'device',
    head: {
      title: 'Device Lab',
      description:
        'Identifiers, screenshots and logs for the phones plugged into this computer. Android works straight from Chrome over WebUSB.',
    },
  },
]

/**
 * Hand-written files that must sit beside a section shell. /profile/ was a Flutter app, and
 * its service worker is still registered in the browsers of everyone who visited it; this
 * replacement unregisters it the next time the browser checks for an update. Without it the
 * old worker keeps waking up for every request under /profile/.
 */
const SECTION_COMPANIONS = [
  { path: path.join('profile', 'flutter_service_worker.js'), mustContain: 'unregister()' },
]

/**
 * Paths this script must NEVER write, and which must exist. These are published directly —
 * by the browser console (terms/privacy/iptv/data) or by hand (device/agent) — and a build
 * must not be able to change or delete them.
 */
const PROTECTED = [
  // Live and store-facing / machine-consumed. Their absence is a bug, not a stage.
  { path: 'terms', required: true },
  { path: 'privacy', required: true },
  { path: 'iptv', required: true },
  // The console's own records (data/term-privacy/, data/iptv/). They arrived with the
  // console port, in the same commit as the path constants that read them: a console that
  // reads a missing index must not mistake it for an empty one and write that back.
  { path: 'data', required: true },
  // The Device Lab helper testers download (device/agent/device-bridge.mjs). Built from
  // _app/helper by `npm run helper:build` and committed by hand; never written by a publish.
  { path: path.join('device', 'agent'), required: true },
  // XConsole's Builds and Artifacts: install pages with their APK/IPA, and hosted HTML pages,
  // whose links testers and readers already hold. Not required: neither exists before its
  // first upload, and an empty one is a fact, not a bug.
  { path: 'build', required: false },
  { path: 'artifact', required: false },
]

/** A published page slug. Also the name of a directory under terms/ and privacy/. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/**
 * Whether Pages publishes an entry of the console's directories at all. These checks read the
 * working tree, and Jekyll leaves out every name that starts with a dot: Finder's .DS_Store
 * (gitignored, so it only ever exists here) is never served, and neither is a folder that holds
 * nothing else — which is what `git pull` leaves of build/<id>/ after XConsole deleted the
 * build, if Finder had been in it: git removes the tracked files and keeps the folder for the
 * ignored one. Checking those would fail every publish over something the site never sees.
 */
const isPublished = (name) => !name.startsWith('.')
const publishesAnything = (dir) => readdirSync(dir).some(isPublished)

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

/** Escape text for an HTML attribute value or element content. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The tags a section's `head` replaces, each of which index.html must contain exactly once.
 * Fail-closed: a shell with half its head rewritten would preview with the site's title and
 * the section's description.
 */
const HEAD_TAGS = [
  { pattern: /<title>[^<]*<\/title>/g, render: (h) => `<title>${escapeHtml(h.title)}</title>` },
  {
    pattern: /<meta name="description" content="[^"]*" \/>/g,
    render: (h) => `<meta name="description" content="${escapeHtml(h.description)}" />`,
  },
  {
    pattern: /<meta property="og:title" content="[^"]*" \/>/g,
    render: (h) => `<meta property="og:title" content="${escapeHtml(h.title)}" />`,
  },
  {
    pattern: /<meta property="og:description" content="[^"]*" \/>/g,
    render: (h) => `<meta property="og:description" content="${escapeHtml(h.description)}" />`,
  },
]

/** Tags in `html` that do not occur exactly once, by pattern source. */
function headTagProblems(html) {
  return HEAD_TAGS.filter(({ pattern }) => (html.match(pattern) ?? []).length !== 1).map(
    ({ pattern }) => pattern.source,
  )
}

/** index.html with a section's title and description swapped in. */
function sectionHtml(html, head) {
  if (!head) return html
  let out = html
  for (const { pattern, render } of HEAD_TAGS) out = out.replace(pattern, render(head))
  return out
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

if (existsSync(distIndex) && SECTIONS.some((s) => s.head)) {
  const problems = headTagProblems(readFileSync(distIndex, 'utf8'))
  check(
    problems.length === 0,
    problems.length === 0
      ? 'dist/index.html has one of each head tag a section rewrites'
      : `dist/index.html lacks exactly one of: ${problems.join(', ')} — section heads cannot be rewritten`,
  )
}

for (const { path: rel, mustContain } of SECTION_COMPANIONS) {
  const file = path.join(ROOT, rel)
  check(
    existsSync(file) && readFileSync(file, 'utf8').includes(mustContain),
    `section companion in place: /${rel.split(path.sep).join('/')}`,
  )
}

for (const { path: rel, required } of PROTECTED) {
  if (required) check(fingerprint(rel) !== null, `protected path exists: ${rel}`)
}

/*
  Everything above is a PRE-FLIGHT: it must pass before a single byte is written, or a
  failure leaves the repo root half-updated while the report claims nothing changed.
*/
if (failures.length > 0) {
  console.error(`\npublish: FAILED pre-flight (${failures.length} checks)\n`)
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error('\nNothing was written. The repo root is untouched.\n')
  process.exit(1)
}

const before = new Map(PROTECTED.map(({ path: p }) => [p, fingerprint(p)]))

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

    It replaces the old rafgraph spa-github-pages encoder, whose decoder had been deleted
    from profile/index.html, so `/terms/no-such-slug/` bounced to `/profile/` with a 200.
    An unknown address still ends on the profile — the router sends it there
    (src/routes/__root.tsx) — but only after Pages has answered it with a 404, so a link
    checker still sees the broken link.
  */
  copyFileSync(distIndex, path.join(ROOT, '404.html'))

  const shell = readFileSync(distIndex, 'utf8')
  for (const section of SECTIONS) {
    mkdirSync(path.join(ROOT, section.path), { recursive: true })
    writeFileSync(path.join(ROOT, section.path, 'index.html'), sectionHtml(shell, section.head))
  }
}

for (const [rel, fp] of before) {
  // A null fingerprint before and after is still equal — a not-yet-created protected path
  // is verified as still-not-created, which is exactly the guarantee we want.
  check(fingerprint(rel) === fp, `protected path untouched by publish: ${rel}`)
}

/* ------------------------------------------------------------------ *
 * 3. Assert the served contract
 * ------------------------------------------------------------------ */

for (const f of [...OWNED_FILES, ...SECTIONS.map((s) => path.join(s.path, 'index.html'))]) {
  check(existsSync(path.join(ROOT, f)), `published: /${f.split(path.sep).join('/')}`)
}

// A section shell must boot the SAME build as /index.html — a stale shell would load hashed
// chunks that publish just deleted from /assets/.
const rootIndex = path.join(ROOT, 'index.html')
for (const section of SECTIONS) {
  const file = path.join(ROOT, section.path, 'index.html')
  if (!existsSync(file) || !existsSync(rootIndex)) continue
  check(
    readFileSync(file, 'utf8') === sectionHtml(readFileSync(rootIndex, 'utf8'), section.head),
    `/${section.path}/index.html is the current shell${section.head ? ` titled "${section.head.title}"` : ''}`,
  )
}

check(
  existsSync(path.join(ROOT, 'assets')) && readdirSync(path.join(ROOT, 'assets')).length > 0,
  'published: /assets/ is non-empty',
)

// /iptv is consumed directly by IPTV player apps. It must stay a real file at the root and
// must never gain an extension.
const iptv = path.join(ROOT, 'iptv')
check(existsSync(iptv) && statSync(iptv).isFile(), '/iptv is a real file')
check(readFileSync(iptv, 'utf8').startsWith('#EXTM3U'), '/iptv still starts with #EXTM3U')

// Store-facing pages must be real static HTML, never SPA routes: a store reviewer's crawler
// does not run JS.
for (const kind of ['terms', 'privacy']) {
  const dir = path.join(ROOT, kind)
  if (!existsSync(dir)) continue
  for (const slug of readdirSync(dir)) {
    const page = path.join(dir, slug)
    if (!isPublished(slug) || !statSync(page).isDirectory() || !publishesAnything(page)) continue
    check(SLUG.test(slug), `/${kind}/${slug}/ slug is well-formed`)
    check(existsSync(path.join(page, 'index.html')), `/${kind}/${slug}/ has a real index.html`)
  }
}

// Install pages and hosted artifacts, published straight from XConsole like the legal pages:
// each build is a well-formed id with a real page, each artifact a well-formed id's .html.
const buildRoot = path.join(ROOT, 'build')
if (existsSync(buildRoot)) {
  for (const id of readdirSync(buildRoot)) {
    const build = path.join(buildRoot, id)
    if (!isPublished(id) || !statSync(build).isDirectory() || !publishesAnything(build)) continue
    check(SLUG.test(id), `/build/${id}/ id is well-formed`)
    check(existsSync(path.join(build, 'index.html')), `/build/${id}/ has a real index.html`)
  }
}
const artifactRoot = path.join(ROOT, 'artifact')
if (existsSync(artifactRoot)) {
  for (const name of readdirSync(artifactRoot)) {
    if (!isPublished(name)) continue
    check(
      name.endsWith('.html') && SLUG.test(name.slice(0, -'.html'.length)),
      `/artifact/${name} is a well-formed id's page`,
    )
  }
}

/*
  A root `.nojekyll` is the single most destructive one-file change available in this repo:
  it turns Jekyll off, and Jekyll's underscore rule is the ONLY thing keeping `_app/`
  (including node_modules) and `_deprecated/` (148 MB) off the public internet.
*/
check(
  !existsSync(path.join(ROOT, '.nojekyll')),
  'no root .nojekyll (would publish _app/ and _deprecated/)',
)

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
  console.error(
    `\n${verb}: FAILED ${failures.length} of ${failures.length + notes.length} checks\n`,
  )
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error(
    CHECK_ONLY
      ? '\nNothing was written.\n'
      : '\nOutput WAS written before these post-checks ran — inspect `git diff` and do not commit.\n',
  )
  process.exit(1)
}

console.log(`\n${verb}: all ${notes.length} checks passed`)
console.log(notes.join('\n'))
if (!CHECK_ONLY) {
  console.log(
    `\nWrote: /index.html, /404.html, /assets/${SECTIONS.length ? `, ${SECTIONS.map((s) => `/${s.path}/index.html`).join(', ')}` : ''}`,
  )
  console.log('Commit and push to deploy.\n')
}
