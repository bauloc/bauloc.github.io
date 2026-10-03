/*
  Per-browser conveniences, under the legacy page's key (dvc_prefs) so a tester's settings
  carry over. Only conveniences live here: storage can be blocked or cleared at any time.
*/

const KEY = 'dvc_prefs'
const DEFAULT_ZOOM = 160

function read(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The screenshot thumbnail width, 80–480 px. */
export function readZoom(): number {
  const z = Number(read().shotZoom)
  return z >= 80 && z <= 480 ? z : DEFAULT_ZOOM
}

export function saveZoom(zoom: number) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...read(), shotZoom: zoom }))
  } catch {
    // A private window, or site data blocked: the size holds for this page view only.
  }
}
