import { Clock, ExternalLink, Globe, ListVideo, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'

import { PageHeader, StatCard } from '../components/page-header'
import { useConsole } from '../console-context'
import { CONSOLE_MODULES } from '../console-menu'
import { toastFailure } from '../errors'
import {
  DEFAULT_SOURCE,
  META_PATH,
  PUBLIC_URL,
  checkPlaylist,
  formatSyncTime,
  isHttpUrl,
  normalizePlaylist,
  parseMeta,
  planSync,
  type SyncMeta,
} from './iptv'

const MODULE = CONSOLE_MODULES[1]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** IPTV: where /iptv comes from, when it last synced, and the button that syncs it. */
export function IptvPage() {
  const { repo, openSettings } = useConsole()
  const [meta, setMeta] = useState<SyncMeta | null>(null)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    repo
      .read(META_PATH)
      .then(
        (text) => parseMeta(text),
        (error: unknown) => {
          toastFailure('Could not read the last sync', error, openSettings)
          return parseMeta(null)
        },
      )
      .then((next) => {
        if (!live) return
        setMeta(next)
        setSource(next.source_url)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [repo, openSettings])

  const sync = async () => {
    const url = source.trim()
    if (!isHttpUrl(url)) {
      toast.error('Invalid source', { description: 'The URL must start with http:// or https://' })
      return
    }
    setBusy(true)
    const id = toast.loading('Fetching the playlist…')
    try {
      let playlist: string
      try {
        const response = await fetch(
          `${url}${url.includes('?') ? '&' : '?'}t=${String(Date.now())}`,
          {
            cache: 'no-store',
          },
        )
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        // What gets checked is exactly what gets committed.
        playlist = normalizePlaylist(await response.text())
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : 'Network error'} — check the URL, and that it allows CORS.`,
          { cause: error },
        )
      }
      const checked = checkPlaylist(playlist)
      if (!checked.ok) throw new Error(checked.reason)

      toast.loading(`Committing ${String(checked.channels)} channels…`, { id })
      const plan = planSync(playlist, checked.channels, url, new Date().toISOString())
      // Nothing was read from the repo to compute this, so it builds on whatever is newest.
      await repo.commit({ ...plan, parent: await repo.head() })
      setMeta(plan.meta)
      toast.success('Synced', {
        id,
        description: `${String(checked.channels)} channels are live at /iptv.`,
      })
    } catch (error) {
      toastFailure('Sync failed', error, openSettings, id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={MODULE.title}
        description={MODULE.description}
        actions={
          <Button
            disabled={meta === null || busy}
            onClick={() => {
              void sync()
            }}
          >
            <RefreshCw className={cn(busy && 'animate-spin')} /> Sync now
          </Button>
        }
      />

      {meta === null ? (
        <div className="grid gap-4 sm:grid-cols-3" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
          <Skeleton className="h-56 rounded-xl sm:col-span-3" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Channels"
              value={meta.channel_count.toLocaleString('en')}
              icon={<ListVideo />}
            />
            <StatCard
              label="Last sync"
              value={formatSyncTime(meta.last_synced_at)}
              icon={<Clock />}
            />
            <StatCard
              label="Source"
              value={<span className="block truncate text-lg">{hostOf(meta.source_url)}</span>}
              icon={<Globe />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Source playlist</CardTitle>
                <CardDescription>
                  An M3U or M3U8 URL. Syncing copies it to /iptv in one commit.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <Label htmlFor="iptv-source">URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="iptv-source"
                    type="url"
                    className="font-mono text-xs"
                    placeholder="https://example.com/playlist.m3u"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value)
                    }}
                  />
                  <Button
                    variant="outline"
                    title="Reset to the default source"
                    onClick={() => {
                      setSource(DEFAULT_SOURCE)
                    }}
                  >
                    <RotateCcw /> Reset
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Default: giangnam0201/All-In-One-IPTV.
                </p>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Public playlist</CardTitle>
                <CardDescription>Add this URL to any IPTV player.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="bg-muted/40 flex items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {PUBLIC_URL.replace(/^https:\/\//, '')}
                  </span>
                  <CopyButton text={PUBLIC_URL} label="Copy the playlist URL" />
                  <Button variant="ghost" size="icon" className="size-7" asChild>
                    <a
                      href={PUBLIC_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open the playlist"
                    >
                      <ExternalLink />
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
