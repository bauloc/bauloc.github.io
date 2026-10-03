import type { Repo } from './github'

/*
  A stand-in for GitHub, for developing the console without a token and without committing
  anything: open /xconsole/?mock in `npm run dev`. It replaces the legacy console's dev.js.

  Reads start from the repo as it is on disk — the dev server serves /data/**, /terms/** and
  /privacy/** from the repo root (vite.config.ts) — and every commit is applied to an
  in-memory copy and logged, never sent anywhere. Reload to start over.

  Dev only: the module is imported behind `import.meta.env.DEV`, so production builds drop it.
*/

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export function mockRepo(): Repo {
  /** Paths written or deleted this session; `null` marks a deletion. */
  const changes = new Map<string, string | null>()

  return {
    head: () => Promise.resolve('mock-head'),

    // The mock has one timeline, so a read is always "at" the head and `parent` needs no check.
    async read(path) {
      await delay(250)
      const changed = changes.get(path)
      if (changed !== undefined) return changed
      const response = await fetch(`/${path}`, { cache: 'no-store' })
      // A path the dev server does not have falls through to the SPA's index.html.
      const isFallback =
        !path.endsWith('.html') &&
        (response.headers.get('content-type') ?? '').includes('text/html')
      return response.ok && !isFallback ? response.text() : null
    },

    async commit({ writes = [], deletes = [], message }) {
      await delay(500)
      for (const file of writes) changes.set(file.path, file.content)
      for (const path of deletes) changes.set(path, null)
      console.info(
        `[xconsole mock] commit "${message}"\n`,
        writes.map((f) => `  write  ${f.path} (${String(f.content.length)} chars)`).join('\n'),
        deletes.map((p) => `\n  delete ${p}`).join(''),
      )
    },
  }
}
