import {
  Download,
  Ellipsis,
  ExternalLink,
  Pencil,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
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

import { formatBytes, formatDateTime } from '../format'
import { ARTIFACT_MESSAGES } from './messages'
import type { ArtifactEntry } from './model'

/** How a page is served, in the colours the console gives safe (emerald) and caution (amber). */
export function SandboxBadge({ sandbox }: { sandbox: boolean }) {
  const t = useMessages(ARTIFACT_MESSAGES)
  return (
    <Badge
      variant="secondary"
      title={sandbox ? t.sandboxedTitle : t.fullTitle}
      className={cn(
        'border-transparent',
        sandbox
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      {sandbox ? <ShieldCheck /> : <ShieldAlert />}
      {sandbox ? t.badgeSandboxed : t.badgeFull}
    </Badge>
  )
}

/** A hosted page: its title, how it runs, size and date, its link, and its actions in a menu. */
export function ArtifactCard({
  entry,
  url,
  busy,
  onEdit,
  onDownload,
  onDelete,
}: {
  entry: ArtifactEntry
  /** Where the page is served: the live site, or the dev mock's origin. */
  url: string
  /** Another change is committing: editing and deleting wait for it. */
  busy: boolean
  onEdit: () => void
  onDownload: () => void
  onDelete: () => void
}) {
  const t = useMessages(ARTIFACT_MESSAGES)
  const locale = useLocale()
  const updated = formatDateTime(entry.updated_at, locale)
  return (
    <Card className="min-w-0 gap-4 py-5 transition-shadow hover:shadow-md">
      <CardHeader className="px-5">
        <CardTitle className="truncate text-base" title={entry.title}>
          {entry.title}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          <SandboxBadge sandbox={entry.sandbox} />
          <span className="text-xs tabular-nums" title={entry.file_name || t.pasted}>
            · {formatBytes(entry.size, locale)}
            {updated && ` · ${updated}`}
          </span>
        </CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t.actionsFor(entry.title)}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem disabled={busy} onSelect={onEdit}>
                <Pencil /> {t.edit}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> {t.open}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDownload}>
                <Download /> {t.download}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
                <Trash2 /> {t.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        <div className="bg-muted/40 flex items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground/80 hover:text-primary min-w-0 flex-1 truncate font-mono text-xs hover:underline"
          >
            {url.replace(/^https?:\/\//, '')}
          </a>
          <CopyButton text={url} label={t.copyUrl} />
          <Button variant="ghost" size="icon" className="size-7" asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t.open}
              title={t.open}
            >
              <ExternalLink />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
