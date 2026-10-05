import { Ellipsis, ExternalLink, Pencil, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { CopyButton } from '@/components/copy-button'
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

import { XCONSOLE_MESSAGES } from '../messages'
import type { DbEntry, Platform } from './model'

const PLATFORM: Record<Platform, { label: string; className: string }> = {
  ios: { label: 'iOS', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  android: {
    label: 'Android',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
}

export function PlatformBadges({ platforms }: { platforms: readonly Platform[] }) {
  return platforms.map((p) => (
    <Badge key={p} variant="secondary" className={cn('border-transparent', PLATFORM[p].className)}>
      {PLATFORM[p].label}
    </Badge>
  ))
}

/**
 * One published URL: which page it is, the link, and Copy. The tag is a fixed width so the
 * two rows' links line up; Vietnamese's "Điều khoản" needs a wider one than "Privacy".
 */
function UrlRow({ kind, url }: { kind: 'terms' | 'privacy'; url: string }) {
  const t = useMessages(XCONSOLE_MESSAGES).pages
  const terms = kind === 'terms'
  const name = terms ? t.terms : t.privacy
  return (
    <div className="bg-muted/40 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
      <span
        className={cn(
          'w-14 shrink-0 text-[11px] font-semibold tracking-wide uppercase [&:lang(vi)]:w-[5.25rem]',
          terms ? 'text-indigo-600 dark:text-indigo-300' : 'text-emerald-600 dark:text-emerald-300',
        )}
      >
        {name}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground/80 hover:text-primary min-w-0 flex-1 truncate font-mono text-xs hover:underline"
      >
        {url.replace(/^https:\/\//, '')}
      </a>
      <CopyButton text={url} label={t.copyUrl(name)} />
    </div>
  )
}

/** A published app: name, platforms, date, both URLs, and its actions in a menu. */
export function PageCard({
  entry,
  busy,
  onEdit,
  onDelete,
}: {
  entry: DbEntry
  /** Another change is committing: editing and deleting wait for it. */
  busy: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = all.pages
  const created = all.date(entry.created_at.split('T')[0] ?? '')
  return (
    <Card className="min-w-0 gap-4 py-5 transition-shadow hover:shadow-md">
      <CardHeader className="px-5">
        <CardTitle className="truncate text-base">{entry.app_name}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          <PlatformBadges platforms={entry.platform} />
          {created && <span className="text-xs">· {created}</span>}
        </CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t.actionsFor(entry.app_name)}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem disabled={busy} onSelect={onEdit}>
                <Pencil /> {t.edit}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={entry.terms_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> {t.openTerms}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={entry.privacy_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> {t.openPrivacy}
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
        <UrlRow kind="terms" url={entry.terms_url} />
        <UrlRow kind="privacy" url={entry.privacy_url} />
      </CardContent>
    </Card>
  )
}
