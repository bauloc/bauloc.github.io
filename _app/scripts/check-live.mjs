#!/usr/bin/env node
/**
 * check-live.mjs — compare the files this repo must never change against what is live.
 *
 * This is the highest-value check in the migration and it needs no local server: it fetches
 * the deployed URLs and byte-compares them with the working copy.
 *
 *   /terms/{slug}/    and  /privacy/{slug}/   are submitted to the App Store and Play
 *                                             Console. A reviewer's crawler does not run JS.
 *   /iptv                                     is read directly by IPTV player apps.
 *   /profile/index.html                       is a prebuilt Flutter bundle, copied verbatim.
 *
 * An empty report means those URLs did not move. A non-empty one means stop and look.
 *
 *   node scripts/check-live.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const ORIGIN = 'https://bauloc.github.io'

/** Every path that must be byte-identical between the working copy and the live site. */
function contractPaths() {
  const out = ['/iptv', '/profile/index.html']
  for (const kind of ['terms', 'privacy']) {
    const dir = path.join(ROOT, kind)
    if (!existsSync(dir)) continue
    for (const slug of readdirSync(dir)) {
      if (statSync(path.join(dir, slug)).isDirectory()) out.push(`/${kind}/${slug}/`)
    }
  }
  return out
}

/** Map a site URL to the file that backs it. */
function localFile(urlPath) {
  const rel = urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath
  return path.join(ROOT, rel)
}

let diffs = 0
let skipped = 0

for (const urlPath of contractPaths()) {
  const file = localFile(urlPath)
  const label = urlPath.padEnd(34)

  if (!existsSync(file)) {
    console.log(`  SKIP  ${label} no local file at ${path.relative(ROOT, file)}`)
    skipped++
    continue
  }

  const local = readFileSync(file)

  let res
  try {
    res = await fetch(ORIGIN + urlPath, { redirect: 'follow' })
  } catch (err) {
    console.log(`  SKIP  ${label} network: ${err instanceof Error ? err.message : 'unreachable'}`)
    skipped++
    continue
  }

  if (!res.ok) {
    // A 404 is meaningful, not a skip: a page that is live locally but missing upstream has
    // either never been deployed or has been dropped by the publish path.
    console.log(`  DIFF  ${label} live returned ${res.status}, local has ${local.length} B`)
    diffs++
    continue
  }

  const remote = Buffer.from(await res.arrayBuffer())
  if (remote.equals(local)) {
    console.log(`  same  ${label} ${local.length} B`)
    continue
  }

  // Name the first differing offset — with 10 KB of HTML, "they differ" is not actionable.
  let at = 0
  const min = Math.min(remote.length, local.length)
  while (at < min && remote[at] === local[at]) at++
  console.log(
    `  DIFF  ${label} live ${remote.length} B vs local ${local.length} B, first differs at byte ${at}`,
  )
  diffs++
}

console.log('')
if (diffs > 0) {
  console.error(
    `check-live: ${diffs} path(s) differ from the deployed site. ` +
      `If that is intentional, say so in the commit; if not, do not push.\n`,
  )
  process.exit(1)
}
console.log(`check-live: every contract path matches the deployed site${skipped ? ` (${skipped} skipped)` : ''}\n`)
