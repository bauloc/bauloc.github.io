import { Download, Ellipsis, Pencil, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { useConsole } from '../console-context'
import { formatBytes, formatDateTime } from '../format'
import { liveOrigin } from '../site'
import { PlatformBadges } from '../term-privacy/page-card'
import { LinkRow } from './link-row'
import { BUILD_MESSAGES } from './messages'
import { versionLabel } from './model'
import { binaryUrl, buildFileUrl, buildUrl } from './paths'
import { QrDialog } from './qr-dialog'
import type { BuildEntry } from './types'

/** The first letter of a name, for a tile that stands in for an icon. */
const initial = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'

/**
 * An app's icon, or its initial on a tinted tile when it has none — none was drawn, or it does
 * not load (Pages takes a minute to serve a just-published one). A failure is remembered per
 * address, so a new icon gets its own chance to load.
 */
export function AppIcon({
  src,
  name,
  className,
}: {
  src: string | null
  name: string
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const base = cn('size-10 shrink-0 rounded-[22%] text-base', className)
  if (src !== null && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        className={cn(base, 'bg-muted object-cover')}
        onError={() => {
          setFailed(src)
        }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(base, 'bg-primary/10 text-primary grid place-items-center font-semibold')}
    >
      {initial(name)}
    </span>
  )
}

/**
 * Where the console shows a build's icon from. The binary's hash rides along as a query, which
 * Pages ignores but its cache does not: a new version's icon shows at once, not ten minutes on.
 */
export function iconUrl(entry: BuildEntry, origin: string): string | null {
  if (!entry.icon) return null
  const url = buildFileUrl(entry.id, entry.icon, origin)
  return entry.sha256 ? `${url}?v=${entry.sha256.slice(0, 12)}` : url
}

/** A published build: its icon and version, the install link, and its actions in a menu. */
export function BuildCard({
  entry,
  busy,
  onEdit,
  onReplace,
  onDelete,
}: {
  entry: BuildEntry
  /** Another change is committing: editing, replacing and deleting wait for it. */
  busy: boolean
  onEdit: () => void
  onReplace: () => void
  onDelete: () => void
}) {
  const { mock } = useConsole()
  const t = useMessages(BUILD_MESSAGES).card
  const locale = useLocale()
  const [qr, setQr] = useState(false)
  const origin = liveOrigin(mock)
  const url = buildUrl(entry.id, origin)
  const version = versionLabel(entry)
  const date = formatDateTime(entry.uploaded_at, locale)
  const extension = entry.platform === 'android' ? 'apk' : 'ipa'
  return (
    <Card className="min-w-0 gap-4 py-5 transition-shadow hover:shadow-md">
      <CardHeader className="px-5">
        <div className="flex min-w-0 items-center gap-3">
          <AppIcon src={iconUrl(entry, origin)} name={entry.name} />
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="truncate text-base leading-tight">{entry.name}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-1.5">
              <PlatformBadges platforms={[entry.platform]} />
              {version && <span className="text-xs tabular-nums">{version}</span>}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t.actionsFor(entry.name)}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem disabled={busy} onSelect={onEdit}>
                <Pencil /> {t.edit}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={onReplace}>
                <Upload /> {t.replace}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                {/* A release's file downloads from github.com, which names it itself. */}
                <a href={binaryUrl(entry, origin)} download={entry.file}>
                  <Download /> {t.download(extension)}
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
                <Trash2 /> {t.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 px-5">
        <p className="text-muted-foreground text-xs tabular-nums">
          {formatBytes(entry.size, locale)}
          {/* Where the file is, when it is not on the site: it takes no room in Storage. */}
          {entry.release && ` · ${t.inRelease}`}
          {date && ` · ${date}`}
        </p>
        <LinkRow
          url={url}
          onQr={() => {
            setQr(true)
          }}
        />
      </CardContent>
      <QrDialog open={qr} onOpenChange={setQr} name={entry.name} url={url} />
    </Card>
  )
}
