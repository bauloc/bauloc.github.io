import { PackagePlus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

import { isLocalFailure } from '../backends/backend'
import { installErrorWording, type Tone } from '../model'
import type { Job } from '../store'
import { StateDot } from './status'

/*
  Long-running work, per device: an install that is still sending after its dialog closed (and
  later recordings and bug reports). One row per job, with its progress and, while the work can
  still be stopped, a Cancel. A job that ended stays until dismissed, so an install whose
  dialog was closed still says how it went. Every phase is words, never colour alone.
*/

/** What the strip reads of a store job. `cancel` is there only while the work can be stopped. */
export type StripJob = Pick<
  Job,
  | 'id'
  | 'deviceId'
  | 'deviceName'
  | 'kind'
  | 'label'
  | 'phase'
  | 'sent'
  | 'total'
  | 'cancel'
  | 'outcome'
>

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * "21.5 of 34.7 MB": both numbers in the total's unit, so the pair reads at a glance and the
 * left number never changes unit mid-transfer.
 */
export function fmtTransfer(sent: number, total: number): string {
  let unit = 0
  let scale = 1
  while (total / scale >= 1024 && unit < UNITS.length - 1) {
    scale *= 1024
    unit++
  }
  if (unit === 0) return `${String(sent)} of ${String(total)} B`
  const num = (bytes: number) => {
    const n = bytes / scale
    return n.toFixed(n < 100 ? 1 : 0)
  }
  return `${num(sent)} of ${num(total)} ${UNITS[unit] ?? ''}`
}

/** Whole percent, never 100 before the last byte. */
export function percentOf(sent: number, total: number): number {
  if (total <= 0) return 0
  if (sent >= total) return 100
  return Math.min(99, Math.floor((sent / total) * 100))
}

const isRunning = (job: Pick<StripJob, 'phase'>) =>
  job.phase === 'sending' || job.phase === 'installing'

const PHASE_TONE: Readonly<Record<StripJob['phase'], Tone>> = {
  sending: 'busy',
  installing: 'busy',
  done: 'ok',
  failed: 'bad',
  cancelled: 'off',
}

/**
 * The phase in words: "Sending · 21.5 of 34.7 MB · 62%", "Installing on the phone…", and how
 * an ended job went.
 */
export function jobPhaseText(job: Pick<StripJob, 'phase' | 'sent' | 'total' | 'outcome'>): string {
  const { sent = 0, total = 0, outcome } = job
  switch (job.phase) {
    case 'sending':
      return total > 0
        ? `Sending · ${fmtTransfer(sent, total)} · ${String(percentOf(sent, total))}%`
        : 'Sending…'
    case 'installing':
      return 'Installing on the phone…'
    case 'done':
      return outcome?.ok && outcome.warnings.length > 0 ? 'Installed, with warnings' : 'Installed'
    case 'failed':
      // A failure in this tab (a file that changed since it was picked) has its own sentence;
      // Android's wording would say the phone refused it.
      return outcome && !outcome.ok
        ? `Didn’t install: ${isLocalFailure(outcome) ? outcome.message : installErrorWording(outcome).text}`
        : 'Didn’t install'
    case 'cancelled':
      return 'Cancelled. Nothing was installed.'
  }
}

/**
 * A thin bar: determinate when the total is known, an indeterminate pulse otherwise (an
 * install Android is committing has no progress to report).
 */
export function ProgressBar({
  value,
  max,
  label,
  className,
}: {
  value?: number
  max?: number
  /** The accessible name, such as "Sending to Pixel 9". */
  label: string
  className?: string
}) {
  const known = value !== undefined && max !== undefined && max > 0
  const pct = known ? percentOf(value, max) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? pct : undefined}
      className={cn('bg-muted h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <div
        className={cn(
          'bg-primary h-full rounded-full transition-[width] duration-300',
          !known && 'w-full opacity-40 motion-safe:animate-pulse',
        )}
        style={known ? { width: `${String(pct)}%` } : undefined}
      />
    </div>
  )
}

/**
 * The jobs, one row each: progress and Cancel while running; how it went, Show and Dismiss
 * once ended. Renders nothing without jobs.
 */
export function JobsStrip({
  jobs,
  onDismiss,
  onShow,
  className,
}: {
  jobs: readonly StripJob[]
  /** Removes an ended job (lab.dismissJob). */
  onDismiss?: (jobId: string) => void
  /** Opens the job's dialog again, for its details and its way forward. */
  onShow?: (job: StripJob) => void
  className?: string
}) {
  if (jobs.length === 0) return null
  const many = new Set(jobs.map((j) => j.deviceId)).size > 1

  return (
    <section aria-label="Jobs" className={cn('rounded-xl border', className)}>
      <ul className="divide-y">
        {jobs.map((job) => {
          const running = isRunning(job)
          const phase = jobPhaseText(job)
          const sending = job.phase === 'sending'
          return (
            <li key={job.id} className="flex items-center gap-3 px-3 py-2">
              <PackagePlus aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{job.label}</span>
                  {many && (
                    <span className="text-muted-foreground shrink-0 text-xs">{job.deviceName}</span>
                  )}
                  <span
                    className="text-muted-foreground ml-auto flex min-w-0 items-center gap-1.5 text-xs tabular-nums"
                    title={phase}
                  >
                    <StateDot tone={PHASE_TONE[job.phase]} />
                    <span className="truncate">{phase}</span>
                  </span>
                </div>
                {running && (
                  <ProgressBar
                    className="mt-1.5"
                    label={`${job.label}: ${phase}`}
                    value={sending ? job.sent : undefined}
                    max={sending ? job.total : undefined}
                  />
                )}
              </div>
              {job.cancel && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Cancel installing ${job.label}`}
                  onClick={job.cancel}
                >
                  <X /> Cancel
                </Button>
              )}
              {!running && onShow && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onShow(job)
                  }}
                >
                  Show
                </Button>
              )}
              {!running && onDismiss && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Dismiss ${job.label}`}
                  title="Dismiss"
                  onClick={() => {
                    onDismiss(job.id)
                  }}
                >
                  <X />
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
