import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/*
  The helper's own suite, separate from the page's (vite.config.ts only collects src/**):
  no React, no DOM, no router plugin, just Node.

  `forks`, not threads: the tests spawn real fake tools, send signals, and the helper installs
  a process-wide `exit` hook that reaps children. Each file gets its own process, so one
  file's children and hooks can never be seen by another.

  Timeouts are generous because several tests wait on process groups dying and on the
  bundler; each test still sets the tight deadlines it actually asserts.
*/
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Next to the page's cache, not in a helper/node_modules of its own.
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-helper', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
