#!/usr/bin/env node
/**
 * cv.mjs — print the /profile/cv page to the PDF that the profile's DOWNLOAD button serves.
 *
 * The CV is a page of the app (src/features/profile/pages/cv-page.tsx, data in cv.ts and
 * portfolio.ts), so it is edited as code and can never disagree with the profile. This script
 * turns it into src/features/profile/assets/cv.pdf, which the app imports — so the PDF ships
 * through the normal build with a hashed name, and a stale one cannot linger in /assets/.
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
const OUT = path.join(APP, 'src/features/profile/assets/cv.pdf')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (!existsSync(CHROME)) {
  console.error(`cv: Chrome not found at ${CHROME}. Set CHROME to its executable.`)
  process.exit(1)
}

/*
  Print from a production build served statically, not from a dev server: a fresh dev server
  optimises dependencies on the first request and keeps an HMR socket open, and headless
  Chrome's virtual-time budget then waits for an idle network that never comes.

  The build imports cv.pdf, so the first run needs one to exist: the previous PDF if there is
  one, otherwise any PDF copied in as a stand-in until this run replaces it.
*/
if (!existsSync(OUT)) {
  console.error(`cv: ${path.relative(APP, OUT)} is missing. Copy any PDF there once, then rerun.`)
  process.exit(1)
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

// A throwaway profile: a running Chrome would otherwise swallow the headless instance.
const profile = mkdtempSync(path.join(tmpdir(), 'cv-chrome-'))
const printed = path.join(outDir, 'cv.pdf')
let chromeLog
try {
  if (port === null) throw new Error('the preview server did not report a port')
  // Asynchronous on purpose: the preview server lives in this process, and a synchronous
  // spawn would block the event loop it needs to answer Chrome's requests.
  chromeLog = await new Promise((resolve, reject) => {
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
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
  })
  if (existsSync(printed)) copyFileSync(printed, OUT)
} finally {
  rmSync(profile, { recursive: true, force: true })
  await server.close()
}

if (!existsSync(printed)) {
  console.error(`cv: Chrome wrote no PDF.\n${chromeLog}`)
  process.exit(1)
}
rmSync(outDir, { recursive: true, force: true })

// The page is laid out for one A4 sheet; say so when the content has outgrown it.
const pages = (readFileSync(OUT, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
console.log(`cv: wrote ${path.relative(APP, OUT)} (${String(pages)} page${pages === 1 ? '' : 's'})`)
if (pages !== 1) console.warn('cv: the CV no longer fits one page — tighten cv.ts or cv-page.tsx.')
