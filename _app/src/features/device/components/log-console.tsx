import { ArrowDownToLine, ClipboardCopy, Eraser, Loader2, Play, Square } from 'lucide-react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'

import { clockSeconds, type LogDevice, type LogSessions } from '../log-sessions'
import { logSourceName, type LogLevel } from './log-level'

export { LOG_LIMIT } from '../log-sessions'
export { logLevel, logSourceName, type LogLevel } from './log-level'

const LEVEL_CLASS: Readonly<Record<LogLevel, string>> = {
  E: 'text-red-600 dark:text-red-400',
  F: 'text-red-600 dark:text-red-400 font-semibold',
  W: 'text-amber-700 dark:text-amber-400',
  D: 'text-muted-foreground',
  '': '',
}

/** What the card's description says about the stream, after its source and line count. */
export function logStatusText(phase: 'idle' | 'running' | 'waiting', until: number | null): string {
  if (phase === 'waiting') {
    return until === null
      ? 'waiting for the device to come back'
      : `waiting for the device until ${clockSeconds(until)}`
  }
  return 'newest at the bottom'
}

/**
 * The device log (logcat, an iPhone's syslog or a simulator's log). The stream itself lives in
 * LogSessions, so a device that drops for a moment keeps its log, says so in it, and resumes;
 * this card only shows it. Deliberately not a live region: narrating every line to a screen
 * reader is unusable — the console is role="log" with aria-live off, and the page announces a
 * drop and a resume once each instead.
 */
export function LogConsole({
  device,
  sessions,
  onStart,
}: {
  /** The device, or what is known of it while it is away. */
  device: LogDevice
  sessions: LogSessions
  /** Starts the log; undefined while the device can't stream one (away, not ready). */
  onStart?: () => void
}) {
  const view = useSyncExternalStore(
    sessions.subscribe,
    () => sessions.view(device.id),
    () => sessions.view(device.id),
  )
  const { lines, phase } = view
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  /** Whether the reader is at the bottom; scrolled up to read, new lines must not yank them down. */
  const atBottom = useRef(true)

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && follow && atBottom.current) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const running = phase !== 'idle'
  const needle = filter.trim().toLowerCase()
  const shown = needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Device log</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-1.5">
          {phase === 'waiting' && (
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
          )}
          <span>
            {logSourceName(device)}, {logStatusText(phase, view.until)} ·{' '}
            {lines.length.toLocaleString('en')} lines
          </span>
        </CardDescription>
        <CardAction className="flex gap-2">
          {running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                sessions.stop(device.id)
              }}
            >
              <Square /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={onStart} disabled={!onStart}>
              <Play /> Start
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Input
            type="search"
            className="h-8 max-w-xs"
            placeholder="Filter lines"
            aria-label="Filter log lines"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
            }}
          />
          {/* A toggle keeps one label; aria-pressed carries the state. */}
          <Button
            size="sm"
            variant={follow ? 'secondary' : 'ghost'}
            aria-pressed={follow}
            onClick={() => {
              setFollow((f) => !f)
              atBottom.current = true
            }}
          >
            <ArrowDownToLine /> Auto-scroll
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={shown.length === 0}
            onClick={() => {
              navigator.clipboard.writeText(shown.map((l) => l.text).join('\n')).then(
                () => toast.success(`Copied ${String(shown.length)} lines`),
                () =>
                  toast.error('Copy failed', {
                    description: 'Your browser blocked clipboard access.',
                  }),
              )
            }}
          >
            <ClipboardCopy /> Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            // aria-disabled: once it has cleared, a disabled button would drop focus to <body>.
            aria-disabled={lines.length === 0}
            className="aria-disabled:opacity-50"
            onClick={() => {
              sessions.clear(device.id)
            }}
          >
            <Eraser /> Clear
          </Button>
        </div>
        <div
          ref={viewport}
          role="log"
          aria-live="off"
          aria-label={`Log of ${device.name}`}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
          }}
          className="bg-muted/40 h-72 overflow-auto rounded-lg border p-2 font-mono text-xs leading-5"
        >
          {shown.length === 0 ? (
            <p className="text-muted-foreground p-2">
              {lines.length
                ? 'No line matches the filter.'
                : phase === 'waiting'
                  ? 'Waiting for the device to come back…'
                  : running
                    ? 'Waiting for lines…'
                    : 'Press Start to stream the device log.'}
            </p>
          ) : (
            shown.map((l) => (
              <div
                key={l.seq}
                className={cn(
                  'whitespace-pre-wrap',
                  // The page's own notes are sentences: they wrap at words, log lines anywhere.
                  l.note ? 'text-muted-foreground wrap-break-word italic' : 'break-all',
                  !l.note && LEVEL_CLASS[l.level],
                )}
              >
                {l.text}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
