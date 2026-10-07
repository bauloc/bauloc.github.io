/** Where everything XConsole publishes is served: GitHub Pages, from the repo's master branch. */
export const SITE = 'https://bauloc.github.io'

/**
 * The origin a published file is opened from in the console. In the dev mock nothing reaches
 * GitHub, but the dev server serves what the mock published at the same paths (see
 * dev/xconsole-mock-store.ts), so links point there instead.
 */
export function liveOrigin(mock: boolean): string {
  return mock ? window.location.origin : SITE
}
