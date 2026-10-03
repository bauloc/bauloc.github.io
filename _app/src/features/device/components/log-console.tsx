import { ArrowDownToLine, ClipboardCopy, Eraser, Play, Square } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

import type { Backend } from '../backends/backend'
import { deviceErrorMessage } from '../backends/backend'
import type { Device } from '../model'

/** The log keeps this many lines; older ones scroll away for good. */
export const LOG_LIMIT = 2000

/** `-v threadtime`: "MM-DD HH:MM:SS.mmm  PID  TID L Tag: message". The level letter colours the line. */
const LEVEL = /^\S+\s+\S+\s+\d+\s+\d+\s+([VDIWEF])\s/

const LEVEL_CLASS: Record<string, string> = {
  E: 'text-red-600 dark:text-red-400',
  F: 'text-red-600 dark:text-red-400 font-semibold',
  W: 'text-amber-700 dark:text-amber-400',
  D: 'text-muted-foreground',
  V: 'text-muted-foreground',
}

interface Line {
  seq: number
  text: string
}

/**
 * The device log (logcat), streamed while open. Deliberately not a live region: narrating
 * every line to a screen reader is unusable — the console is role="log" with aria-live off.
 */
export function LogConsole({ device, backend }: { device: Device; backend: Backend }) {
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  /** Whether the reader is at the bottom; scrolled up to read, new lines must not yank them down. */
  const atBottom = useRef(true)
  const seq = useRef(0)
  const abort = useRef<AbortController | null>(null)

  // Stop the stream when the device changes or the console unmounts.
  useEffect(
    () => () => {
      abort.current?.abort()
    },
    [device.id],
  )

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && follow && atBottom.current) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const start = () => {
    if (!backend.logs) return
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    backend
      .logs(
        device.id,
        (incoming) => {
          // Lines already in flight when Stop was pressed belong to a stream that is over.
          if (controller.signal.aborted) return
          setLines((current) => {
            const next = current.concat(incoming.map((text) => ({ seq: ++seq.current, text })))
            return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
          })
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          toast.error('The log stopped', { description: deviceErrorMessage(error) })
      })
      .finally(() => {
        if (abort.current === controller) setRunning(false)
      })
  }

  const stop = () => {
    abort.current?.abort()
    abort.current = null
    setRunning(false)
  }

  const needle = filter.trim().toLowerCase()
  const shown = needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Device log</CardTitle>
        <CardDescription>
          logcat, newest at the bottom · {lines.length.toLocaleString('en')} lines
        </CardDescription>
        <CardAction className="flex gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={stop}>
              <Square /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!backend.logs}>
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
              setLines([])
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
                : running
                  ? 'Waiting for lines…'
                  : 'Press Start to stream the device log.'}
            </p>
          ) : (
            shown.map((l) => (
              <div
                key={l.seq}
                className={cn(
                  'break-all whitespace-pre-wrap',
                  LEVEL_CLASS[LEVEL.exec(l.text)?.[1] ?? ''],
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
