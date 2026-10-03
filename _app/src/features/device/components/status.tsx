import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

import { STATE_META, type Device, type Platform, type Tone } from '../model'

/** The colour of each tone. Always shown next to the state's label, never alone. */
export const TONE_DOT: Readonly<Record<Tone, string>> = {
  ok: 'bg-emerald-500',
  busy: 'bg-indigo-500 motion-safe:animate-pulse',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  off: 'bg-zinc-400 dark:bg-zinc-500',
}

/** A tinted surface per tone, for hint cards. */
export const TONE_SURFACE: Readonly<Record<Tone, string>> = {
  ok: 'border-emerald-500/30 bg-emerald-500/5',
  busy: 'border-indigo-500/30 bg-indigo-500/5',
  warn: 'border-amber-500/40 bg-amber-500/5',
  bad: 'border-red-500/30 bg-red-500/5',
  off: 'border-border bg-muted/40',
}

export function StateDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone], className)}
    />
  )
}

export function StateLabel({ device }: { device: Device }) {
  const meta = STATE_META[device.state]
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
      <StateDot tone={meta.tone} />
      {meta.label}
    </span>
  )
}

const PLATFORM_STYLE: Readonly<Record<Platform, string>> = {
  ios: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  android: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
}

export function PlatformBadge({ platform, version }: { platform: Platform; version?: string }) {
  return (
    <Badge variant="secondary" className={cn('border-transparent', PLATFORM_STYLE[platform])}>
      {platform === 'ios' ? 'iOS' : 'Android'}
      {version ? ` ${version}` : ''}
    </Badge>
  )
}
