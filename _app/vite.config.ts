import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/*
  The app version comes from package.json, the single place it is bumped, and is inlined as
  `__APP_VERSION__` at build time.

  Read with `readFileSync` rather than `import pkg from './package.json'`: an import would pull
  the whole manifest — including every dependency name — into the module graph, and TS would
  have to widen `include` to cover a file outside `src`.
*/
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string }

/** Repo root — one level up from this Vite project. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/*
  The repo root serves a static contract that this build neither produces nor owns:

    /terms/{slug}/   /privacy/{slug}/   /iptv   /profile/**   /data/**   /device/agent/**

  Those files are committed straight to the repo by the in-browser xconsole (or, for
  /profile/, by a Flutter build) and GitHub Pages serves them directly — deliberately, so
  that publishing an app-store-facing legal page never waits on a build.

  `vite dev` knows nothing about them, so without this plugin `/terms/test-app-kaka/` in dev
  falls through to the SPA and you cannot see what a store reviewer sees. `vite preview` has
  the same gap, since these files are not in dist/ either.
*/
function serveRepoRootContract(): Plugin {
  /*
    Each entry is a directory whose subtree may be served, or an exact file. Containment is
    checked against THE MATCHED ENTRY, not against the repo root.

    That distinction is the whole security of this plugin, and getting it wrong is easy:
    an earlier version resolved the path and only asserted `startsWith(repoRoot)`, so
    `/terms/%2e%2e%2f_app%2fpackage.json` escaped the `terms/` prefix, stayed inside the
    repo, and served _app/package.json. Verified, then fixed. `npm run dev` must expose
    exactly these six things and nothing else.
  */
  const DIRS = ['terms', 'privacy', 'profile', 'data', 'device/agent']
  const FILES = ['iptv']

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.otf': 'font/otf',
    '.frag': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
  }

  /** Absolute directory, guaranteed to end in a separator so a sibling like
   *  `terms-old/` cannot satisfy a `terms/` prefix test. */
  const dirBase = (rel: string) => path.join(repoRoot, rel) + path.sep

  /** Resolve a URL path to a file this plugin is allowed to serve, or null. */
  function resolveOwned(urlPath: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return null // malformed percent-encoding
    }
    if (decoded.includes('\0')) return null

    /*
      Reject anything that is not already normalised. Browsers collapse `.` and `..` before
      sending, so this only rejects hand-crafted requests — and it buys dev/prod fidelity:
      GitHub Pages normalises `/data/../iptv` to `/iptv` and serves it there, so a dev server
      that answered the un-normalised URL would be modelling a host that does not exist.
      Combined with the per-entry containment below, a `..` cannot reach anything at all.
    */
    if (path.posix.normalize(decoded) !== decoded) return null

    const target = path.resolve(repoRoot, '.' + decoded)

    for (const rel of FILES) {
      if (target === path.join(repoRoot, rel)) return target
    }
    for (const rel of DIRS) {
      /*
        Two cases, and the first is easy to forget: `path.resolve` drops the trailing
        separator, so the directory ITSELF (`/profile/` → `<root>/profile`) does not
        satisfy a `<root>/profile/` prefix test. Omitting it made `/profile/` fall through
        to the SPA and stopped serving the Flutter bundle — caught by the size regression,
        1331 B down to the 765 B shell.
      */
      if (target === path.join(repoRoot, rel)) return target
      // startsWith on the base WITH a trailing separator, so a sibling `terms-old/` cannot
      // satisfy a `terms/` test.
      if (target.startsWith(dirBase(rel))) return target
    }
    return null
  }

  return {
    name: 'bauloc:serve-repo-root-contract',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
        const resolved = resolveOwned(urlPath)
        if (resolved === null) return next()

        let file = resolved
        if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
        if (!existsSync(file) || !statSync(file).isFile()) return next()

        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    // Must come before the react plugin.
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
    serveRepoRootContract(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 7360, strictPort: true },
  build: {
    outDir: 'dist',
    // No sourcemaps: the output is committed into a public repo, so shipping them would
    // publish this project's entire source and multiply the committed diff.
    sourcemap: false,
    rollupOptions: {
      output: {
        /*
          THE JEKYLL TRAP, and the reason these three lines exist.

          GitHub Pages serves this repo through Jekyll (the Pages source is a branch, not
          Actions). Jekyll's EntryFilter rejects any entry whose BASENAME starts with `_`,
          `.`, `#` or `~` — that rule is what keeps `_app/` and `_deprecated/` off the
          internet, and we depend on it.

          But TanStack Router's autoCodeSplitting names chunks after route files, so a
          layout route yields `_app-<hash>.js`, a param route `_id-<hash>.js`. Verified in
          the reference project's real build output: 18 such files. Published through
          Jekyll they are silently dropped, and the SPA 404s its own chunk on the first
          navigation — a failure that reads like a bundler fault.

          So: force a `c-` prefix and strip any leading underscores from the chunk name.
          `npm run publish` asserts that dist/assets contains no leading-underscore file,
          which is the check that keeps this true after everyone has forgotten why.
        */
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/c-[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    pool: 'threads',
  },
})
