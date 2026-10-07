import { INTL_LOCALE, type Locale } from '@/lib/locale'

/*
  How the console writes sizes and times. Sizes count in 1024s, as Device Lab's do, so GitHub's
  100 MiB limit reads as "100 MB"; one decimal below 100, as the file managers show them.
*/

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** `24537088` → `23.4 MB`, or `23,4 MB` in Vietnamese. */
export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let n = bytes
  let unit = 0
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  const digits = unit === 0 || n >= 100 ? 0 : 1
  const number = new Intl.NumberFormat(INTL_LOCALE[locale], {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n)
  return `${number} ${UNITS[unit] ?? ''}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * An ISO timestamp in local time, as the console writes dates elsewhere: `07-Oct-2026 08:15`,
 * or `07/10/2026 08:15` in Vietnamese. '' for anything that is not a time.
 */
export function formatDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (locale === 'vi') {
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear())} ${time}`
  }
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()] ?? ''}-${String(d.getFullYear())} ${time}`
}
