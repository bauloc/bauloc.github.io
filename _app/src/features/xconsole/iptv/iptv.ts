import { defineMessages } from '@/lib/i18n'
import { currentLocale, type Locale } from '@/lib/locale'

import type { RepoFile } from '../repo/github'

/*
  IPTV: mirror an upstream M3U playlist to /iptv, the URL IPTV player apps are pointed at.
  /iptv must stay a real file at the root with no extension, starting with #EXTM3U —
  `npm run publish` asserts both. The sync record moved to data/ with the console port.
*/

export const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/giangnam0201/All-In-One-IPTV/main/channels.m3u'
export const TARGET_PATH = 'iptv'
export const META_PATH = 'data/iptv/meta.json'
export const PUBLIC_URL = 'https://bauloc.github.io/iptv'

export interface SyncMeta {
  last_synced_at: string | null
  channel_count: number
  source_url: string
}

export const EMPTY_META: SyncMeta = {
  last_synced_at: null,
  channel_count: 0,
  source_url: DEFAULT_SOURCE,
}

/** The last sync, or the defaults when there is none or it is unreadable — it is only a record. */
export function parseMeta(text: string | null): SyncMeta {
  if (text === null) return EMPTY_META
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null) return EMPTY_META
    const d = data as Record<string, unknown>
    return {
      last_synced_at: typeof d.last_synced_at === 'string' ? d.last_synced_at : null,
      channel_count: typeof d.channel_count === 'number' ? d.channel_count : 0,
      source_url: typeof d.source_url === 'string' && d.source_url ? d.source_url : DEFAULT_SOURCE,
    }
  } catch {
    return EMPTY_META
  }
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/**
 * The playlist as /iptv must hold it: no byte-order mark and no leading whitespace, so the file
 * starts with #EXTM3U exactly — which players need and `npm run publish` asserts.
 */
export function normalizePlaylist(text: string): string {
  // trimStart also strips any byte-order marks: U+FEFF is whitespace to JavaScript.
  return text.trimStart()
}

/** What the helpers below say, worded when they run (see model.ts's PROBLEMS). */
const WORDS = defineMessages({
  en: { notM3u: 'Response does not start with #EXTM3U', never: 'Never', unknown: 'Unknown' },
  vi: { notM3u: 'Phản hồi không bắt đầu bằng #EXTM3U', never: 'Chưa có', unknown: 'Không rõ' },
})

/** A playlist the players can read, or why it is not one. Expects normalizePlaylist's output. */
export function checkPlaylist(
  text: string,
  locale: Locale = currentLocale(),
): { ok: true; channels: number } | { ok: false; reason: string } {
  if (!text.startsWith('#EXTM3U')) {
    return { ok: false, reason: WORDS[locale].notM3u }
  }
  return { ok: true, channels: (text.match(/^#EXTINF/gm) ?? []).length }
}

/**
 * `2026-05-10T08:33:17Z` → `10-May-2026 15:33` in local time, or `10/05/2026 15:33` in
 * Vietnamese; 'Never' before the first sync.
 */
export function formatSyncTime(iso: string | null, locale: Locale = currentLocale()): string {
  if (!iso) return WORDS[locale].never
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return WORDS[locale].unknown
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (locale === 'vi') {
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear())} ${time}`
  }
  return `${pad(d.getDate())}-${months[d.getMonth()] ?? ''}-${String(d.getFullYear())} ${time}`
}

/** The playlist and its sync record, as one commit. */
export function planSync(
  playlist: string,
  channels: number,
  sourceUrl: string,
  now: string,
): { writes: RepoFile[]; message: string; meta: SyncMeta } {
  const meta: SyncMeta = { last_synced_at: now, channel_count: channels, source_url: sourceUrl }
  let host = sourceUrl
  try {
    host = new URL(sourceUrl).hostname
  } catch {
    // Not a parseable URL: name it as typed.
  }
  return {
    writes: [
      { path: TARGET_PATH, content: playlist },
      { path: META_PATH, content: `${JSON.stringify(meta, null, 2)}\n` },
    ],
    message: `iptv: sync ${String(channels)} channels from ${host}`,
    meta,
  }
}
