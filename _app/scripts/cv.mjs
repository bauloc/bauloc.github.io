#!/usr/bin/env node
/**
 * cv.mjs — print the /profile/cv page to the PDFs that the profile's DOWNLOAD button serves,
 * one per language.
 *
 * The CV is a page of the app (src/features/profile/pages/cv-page.tsx, data in cv.ts and
 * portfolio.ts), so it is edited as code and can never disagree with the profile. This script
 * turns it into src/features/profile/assets/cv.pdf (English) and cv-vi.pdf (Vietnamese), which
 * the app imports — so the PDFs ship through the normal build with hashed names, and a stale
 * one cannot linger in /assets/.
 *
 * Run it after changing the CV's content, then build and publish as usual:
 *
 *   npm run cv
 *
 * It starts its own Vite dev server on a free port (the usual one may be running) and prints
 * with headless Chrome. CHROME=/path/to/chrome overrides the macOS default location.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'

const APP = fileURLToPath(new URL('..', import.meta.url))
const ASSETS = path.join(APP, 'src/features/profile/assets')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/*
  The page speaks the browser's language when nothing is saved, and every run gets a fresh
  Chrome profile with nothing saved, so `--accept-lang` alone picks the CV's language.
  (`--lang` does not reach navigator.languages in headless Chrome; `--accept-lang` does.)
*/
const PRINTS = [
  { file: 'cv.pdf', acceptLang: 'en-US' },
  { file: 'cv-vi.pdf', acceptLang: 'vi' },
]

if (!existsSync(CHROME)) {
  console.error(`cv: Chrome not found at ${CHROME}. Set CHROME to its executable.`)
  process.exit(1)
}

/*
  Print from a production build served statically, not from a dev server: a fresh dev server
  optimises dependencies on the first request and keeps an HMR socket open, and headless
  Chrome's virtual-time budget then waits for an idle network that never comes.

  The build imports both PDFs, so the first run needs them to exist: the previous ones if
  there are any, otherwise any PDF copied in as a stand-in until this run replaces it.
*/
for (const { file } of PRINTS) {
  if (!existsSync(path.join(ASSETS, file))) {
    console.error(
      `cv: ${path.relative(APP, path.join(ASSETS, file))} is missing. Copy any PDF there once, then rerun.`,
    )
    process.exit(1)
  }
}
const outDir = mkdtempSync(path.join(tmpdir(), 'cv-build-'))
await build({ root: APP, logLevel: 'error', build: { outDir, emptyOutDir: true } })
// Port 0: let the OS pick, so this works while `npm run dev` holds 7360. The host is pinned
// because Vite's default, `localhost`, can bind IPv6 only, where Chrome's 127.0.0.1 misses it.
const server = await preview({
  root: APP,
  logLevel: 'error',
  build: { outDir },
  preview: { port: 0, host: '127.0.0.1', strictPort: false },
})
const address = server.httpServer.address()
const port = typeof address === 'object' && address !== null ? address.port : null

/** Print the CV once, in the language `acceptLang` asks for; Chrome's log, for when it fails. */
function print(printed, acceptLang) {
  // A throwaway profile: a running Chrome would otherwise swallow the headless instance, and
  // a profile with a saved language would override `--accept-lang`.
  const profile = mkdtempSync(path.join(tmpdir(), 'cv-chrome-'))
  // Asynchronous on purpose: the preview server lives in this process, and a synchronous
  // spawn would block the event loop it needs to answer Chrome's requests.
  return new Promise((resolve, reject) => {
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        `--accept-lang=${acceptLang}`,
        '--no-pdf-header-footer',
        // Time for the SPA to boot, the route chunk to load and the fonts to arrive.
        '--virtual-time-budget=15000',
        `--print-to-pdf=${printed}`,
        `http://127.0.0.1:${String(port)}/profile/cv`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let log = ''
    chrome.stdout.on('data', (chunk) => (log += String(chunk)))
    chrome.stderr.on('data', (chunk) => (log += String(chunk)))
    chrome.on('error', reject)
    chrome.on('close', () => {
      resolve(log)
    })
  }).finally(() => {
    rmSync(profile, { recursive: true, force: true })
  })
}

const failures = []
try {
  if (port === null) throw new Error('the preview server did not report a port')
  for (const { file, acceptLang } of PRINTS) {
    const printed = path.join(outDir, file)
    const out = path.join(ASSETS, file)
    const chromeLog = await print(printed, acceptLang)
    if (!existsSync(printed)) {
      failures.push(`cv: Chrome wrote no ${file}.\n${chromeLog}`)
      continue
    }
    copyFileSync(printed, out)
    // The page is laid out for one A4 sheet; say so when the content has outgrown it.
    const pages = (readFileSync(out, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    console.log(
      `cv: wrote ${path.relative(APP, out)} (${String(pages)} page${pages === 1 ? '' : 's'})`,
    )
    if (pages !== 1)
      console.warn(`cv: ${file} no longer fits one page — tighten cv.ts or cv-page.tsx.`)
  }
} finally {
  await server.close()
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
rmSync(outDir, { recursive: true, force: true })
