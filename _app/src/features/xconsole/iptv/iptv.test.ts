import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SOURCE,
  META_PATH,
  checkPlaylist,
  isHttpUrl,
  normalizePlaylist,
  parseMeta,
  planSync,
} from './iptv'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

describe('checkPlaylist', () => {
  it('counts the channels of an M3U playlist', () => {
    expect(checkPlaylist('#EXTM3U\n#EXTINF:-1,A\nhttp://a\n#EXTINF:-1,B\nhttp://b\n')).toEqual({
      ok: true,
      channels: 2,
    })
  })

  it('refuses anything that is not one, such as an HTML error page', () => {
    expect(checkPlaylist('<!doctype html>')).toMatchObject({ ok: false })
  })

  it('commits a playlist that starts with #EXTM3U exactly, as publish.mjs requires', () => {
    const body = normalizePlaylist('\uFEFF \n#EXTM3U\n#EXTINF:-1,A\nhttp://a\n')
    expect(body.startsWith('#EXTM3U')).toBe(true)
    expect(checkPlaylist(body)).toEqual({ ok: true, channels: 1 })
    // Unnormalised, the same text is refused rather than committed with a leading blank.
    expect(checkPlaylist(' \n#EXTM3U\n')).toMatchObject({ ok: false })
  })
})

describe('parseMeta', () => {
  it('falls back to the defaults when there is no record or it is broken', () => {
    expect(parseMeta(null).source_url).toBe(DEFAULT_SOURCE)
    expect(parseMeta('not json').channel_count).toBe(0)
  })

  it('reads the record committed in this repo, at the path the console uses', () => {
    const meta = parseMeta(readFileSync(path.join(ROOT, META_PATH), 'utf8'))
    expect(meta.channel_count).toBeGreaterThan(0)
    expect(meta.last_synced_at).not.toBeNull()
  })
})

describe('planSync', () => {
  it('writes /iptv and its record in one commit, named after the source host', () => {
    const plan = planSync(
      '#EXTM3U\n',
      0,
      'https://raw.githubusercontent.com/x/y.m3u',
      '2026-10-03T00:00:00Z',
    )
    expect(plan.writes.map((w) => w.path)).toEqual(['iptv', 'data/iptv/meta.json'])
    expect(plan.message).toBe('iptv: sync 0 channels from raw.githubusercontent.com')
    expect(plan.writes[1]!.content.endsWith('\n')).toBe(true)
  })

  it('only accepts http(s) sources', () => {
    expect(isHttpUrl('ftp://x')).toBe(false)
    expect(isHttpUrl(' https://x ')).toBe(true)
  })
})
