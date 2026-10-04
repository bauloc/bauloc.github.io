#!/usr/bin/env node
/**
 * scripts/ios-models.mjs — writes src/features/device/backends/ios-models.json, the map from an
 * Apple ProductType to its marketing name ("iPhone13,3" → "iPhone 12 Pro").
 *
 *   node scripts/ios-models.mjs           # regenerate after an Xcode update, then commit
 *   node scripts/ios-models.mjs --check   # exit 1 when the committed file is stale
 *
 * The helper reports ProductType only (an iPhone never says its marketing name over lockdown),
 * and Xcode ships the names in device_traits.db. Reading it here, once, keeps Xcode off the
 * tester's machine and the table out of the helper: the page carries it, and a phone newer
 * than this table shows its identifier until the file is regenerated.
 *
 * Read-only: /usr/bin/sqlite3 opens the database with -readonly, and nothing else is run. It
 * exits 1 with a plain message when Xcode, or the database inside it, is missing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('..', import.meta.url))
const OUT = path.join(APP, 'src/features/device/backends/ios-models.json')
const DB_IN_DEVELOPER_DIR = 'Platforms/iPhoneOS.platform/usr/standalone/device_traits.db'
const SQLITE = '/usr/bin/sqlite3'
const QUERY = 'select distinct ProductType, ProductDescription from Devices'

/** Xcode's Developer folder: DEVELOPER_DIR when set, else the one xcode-select names. */
function developerDir() {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR
  try {
    return execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim()
  } catch {
    return '/Applications/Xcode.app/Contents/Developer'
  }
}

function fail(message) {
  console.error(`ios-models: ${message}`)
  process.exit(1)
}

const db = path.join(developerDir(), DB_IN_DEVELOPER_DIR)
if (!existsSync(db)) {
  fail(
    `Xcode's device_traits.db isn't at ${db}.\n` +
      'Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app` ' +
      'if the Command Line Tools are selected.',
  )
}
if (!existsSync(SQLITE)) fail(`${SQLITE} is missing.`)

let rows
try {
  rows = JSON.parse(execFileSync(SQLITE, ['-readonly', '-json', db, QUERY], { encoding: 'utf8' }))
} catch (error) {
  fail(`sqlite3 couldn't read ${db}: ${error instanceof Error ? error.message : String(error)}`)
}

/** Sorted by identifier, the first name wins for a ProductType Xcode lists twice. */
const models = {}
for (const { ProductType: id, ProductDescription: name } of rows) {
  if (typeof id !== 'string' || typeof name !== 'string' || !id || !name.trim()) continue
  models[id] ??= name.trim()
}
const sorted = Object.fromEntries(
  Object.entries(models).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
)
const text = JSON.stringify(sorted, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== text) fail(`${path.relative(APP, OUT)} is stale: run node scripts/ios-models.mjs`)
  console.log(`ios-models: up to date (${String(Object.keys(sorted).length)} models)`)
} else {
  writeFileSync(OUT, text)
  console.log(
    `ios-models: wrote ${String(Object.keys(sorted).length)} models to ${path.relative(APP, OUT)}`,
  )
}
