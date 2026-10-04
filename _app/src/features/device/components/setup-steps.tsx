import { Check, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

import { STATUS_META } from '../preflight/copy'
import type { CheckItem, CheckStatus, Fix } from '../preflight/types'
import { Command, FixButton, splitFixes, StatusWord, type FixWiring } from './checklist'
import { TONE_SURFACE } from './status'

/*
  The Gate's numbered setup steps, for both platforms: a number in a circle on a thin rail,
  the step's heading with its status word, then what to do. Android's steps are checklist rows
  (preflight/checks.ts); the iPhone's are the helper's phases (helper-card.tsx). One look for
  both, so switching platforms changes the words and nothing else.
*/

/**
 * Where a step stands. `done` shows a check; `current` is the one to do now; `todo` can be done
 * any time; `waiting` needs an earlier step first, so its heading is quieter. A status other
 * than OK or Not checked tints the circle and adds its word: keep those for real problems.
 */
export type StepState = 'done' | 'current' | 'todo' | 'waiting'

/** The numbered list; `label` names it for assistive technology. */
export function StepList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol aria-label={label} className="flex flex-col">
      {children}
    </ol>
  )
}

/** One step. Its heading reads "Step n: label" to a screen reader; the number is decorative. */
export function StepItem({
  n,
  label,
  state,
  status,
  bodyId,
  children,
}: {
  n: number
  label: ReactNode
  state: StepState
  /** Shown as a word beside the heading, and tints the circle: Warning and Blocking only. */
  status?: CheckStatus
  /** An id for the body, for a control elsewhere that the step explains (aria-describedby). */
  bodyId?: string
  children?: ReactNode
}) {
  const flagged = status === 'warning' || status === 'blocking'
  return (
    <li
      className={cn(
        'relative grid grid-cols-[1.75rem_1fr] gap-x-4 pb-7 last:pb-0',
        // The rail between circles: centred under each one, stopping short of the next.
        'before:bg-border before:absolute before:top-9 before:bottom-2 before:left-[calc(0.875rem-0.5px)] before:w-px last:before:hidden',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-7 place-items-center rounded-full border text-xs font-semibold tabular-nums',
          state === 'done'
            ? TONE_SURFACE.ok
            : flagged
              ? TONE_SURFACE[STATUS_META[status].tone]
              : state === 'current'
                ? 'border-foreground/70 bg-card text-foreground'
                : 'bg-card text-muted-foreground',
        )}
      >
        {state === 'done' ? (
          <Check className="size-3.5 text-emerald-700 dark:text-emerald-300" />
        ) : (
          n
        )}
      </span>
      <div className="min-w-0 space-y-1.5 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3
            className={cn(
              'text-sm leading-6 font-medium',
              state === 'waiting' && !flagged && 'text-muted-foreground',
            )}
          >
            <span className="sr-only">Step {n}: </span>
            {label}
          </h3>
          {/* A done step's check says OK already; Not checked says nothing. */}
          {status && status !== 'unchecked' && status !== 'ok' && <StatusWord status={status} />}
        </div>
        {children && (
          <div id={bodyId} className="max-w-[65ch] space-y-3">
            {children}
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * A link to documentation elsewhere: words in the primary colour with the external mark, the
 * same on both platforms. Buttons are for actions only. A block of its own, so it keeps the
 * steps' rhythm instead of sitting on a line box.
 */
export function TextLink({
  href,
  download,
  icon,
  children,
}: {
  href: string
  /** A file to save rather than a page to open: no new tab, no external mark. */
  download?: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <a
      href={href}
      {...(download !== undefined
        ? { download }
        : { target: '_blank', rel: 'noopener noreferrer' })}
      className="text-primary focus-visible:ring-ring/50 flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {icon}
      {children}
      {download === undefined && (
        <>
          <ExternalLink aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </>
      )}
    </a>
  )
}

/** The quieter body text of a step. */
export const STEP_TEXT = 'text-muted-foreground text-sm leading-relaxed'

/**
 * A checklist row as a step's body: the sentence; settings paths to follow as a lettered
 * sub-list, in the body's size; commands; the detail line; then the actions as buttons and
 * the documentation as links on one row.
 */
export function StepBody({ item, wiring }: { item: CheckItem; wiring?: FixWiring }) {
  const { commands, paths, buttons } = splitFixes(item.fixes)
  const links = buttons.filter((fix): fix is Extract<Fix, { href: string }> => 'href' in fix)
  // An action nobody wired draws nothing, so it mustn't leave an empty row behind either.
  const actions = buttons.filter((fix) => 'action' in fix && wiring?.on?.[fix.action])
  return (
    <>
      <p className={STEP_TEXT}>{item.sentence}</p>
      {paths.length === 1 && (
        <p className={STEP_TEXT}>
          <span className="text-foreground font-medium">{paths[0]?.label}:</span> {paths[0]?.path}
        </p>
      )}
      {paths.length > 1 && (
        <ol className={cn(STEP_TEXT, 'list-[lower-alpha] space-y-1.5 pl-5')}>
          {paths.map((fix) => (
            <li key={fix.label + fix.path} className="pl-1">
              <span className="text-foreground font-medium">{fix.label}:</span> {fix.path}
            </li>
          ))}
        </ol>
      )}
      {commands.map((fix) => (
        <Command key={fix.copy} text={fix.copy} label={fix.label} />
      ))}
      {item.detail && (
        <p className="text-muted-foreground text-xs leading-relaxed">{item.detail}</p>
      )}
      {(actions.length > 0 || links.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {actions.map((fix) => (
            <FixButton key={fix.label} fix={fix} wiring={wiring} />
          ))}
          {links.map((fix) => (
            <TextLink key={fix.href} href={fix.href}>
              {fix.label}
            </TextLink>
          ))}
        </div>
      )}
    </>
  )
}
