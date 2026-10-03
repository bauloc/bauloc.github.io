const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A calendar date as the form stores it (`2026-03-19`) and its month, or null for anything else. */
function dateParts(isoDate: string): { y: string; month: string; d: string } | null {
  const [, y = '', m = '', d = ''] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate) ?? []
  const month = MONTHS[Number(m) - 1]
  // Round-tripped through Date so 2026-02-31 is refused rather than rolled into March.
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (!month || date.getUTCDate() !== Number(d) || date.getUTCMonth() !== Number(m) - 1) return null
  return { y, month, d }
}

/** True for a real calendar date written `YYYY-MM-DD`, what the form's date field stores. */
export const isIsoDate = (value: string) => dateParts(value) !== null

/**
 * `2026-03-19` → `19-Mar-2026`, the legacy console's format; '' for no date and for anything
 * that is not one. The legacy version split any string on '-' and printed the pieces, so a
 * hand-edited page file could put markup in the published page.
 */
export function formatDate(isoDate: string): string {
  const parts = dateParts(isoDate)
  return parts ? `${parts.d}-${parts.month}-${parts.y}` : ''
}

/**
 * Escape text for HTML content and double-quoted attributes. The legacy templates put what
 * the user typed straight into the page, so an `&` or `<` in an app name produced broken HTML.
 * Apostrophes are left alone: the templates never use single-quoted attributes, and leaving
 * them keeps every existing page byte-identical.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The website as it may appear in a published page: an http(s) URL, or nothing. Anything else
 * (javascript:, data:, a bare host) is dropped rather than linked — the console refuses it at
 * entry, and this keeps a hand-edited page file from slipping one through.
 */
export function safeWebsite(url: string): string {
  const site = url.trim()
  return /^https?:\/\//i.test(site) ? site : ''
}
