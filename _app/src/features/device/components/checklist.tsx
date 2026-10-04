import { ExternalLink, Loader2 } from 'lucide-react'
import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/cn'

import { bySeverity, worst } from '../preflight/checks'
import { GROUP_TITLES, STATUS_META } from '../preflight/copy'
import type { CheckGroup, CheckItem, CheckStatus, Fix, FixAction } from '../preflight/types'
import { StateDot, TONE_SURFACE } from './status'

/*
  The preflight checklist on screen (PLAN §3.1): the Environment check's grouped sections, the
  compact card at the top of a feature, and the pieces the Gate and HintCard share. Rows come
  from preflight/checks.ts; this file only draws them.

  Every status is a word beside its dot, never colour alone. A command to copy is shown as
  the command itself, because a sentence like "…drop it here:" points at it.
*/

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

/** What each action button does. The page owns these; the checklist only calls them. */
export type FixHandlers = Partial<Record<FixAction, () => void | Promise<void>>>

/** How a checklist's action buttons are wired up. */
export interface FixWiring {
  /** An action with no handler is not shown: a button must do something. */
  readonly on?: FixHandlers
  /** Actions in flight: a spinner, and aria-disabled so focus stays put. */
  readonly pending?: readonly FixAction[]
  /** Actions that can't run yet: aria-disabled, and described by the element `blockedBy` names. */
  readonly blocked?: readonly FixAction[]
  readonly blockedBy?: string
}

/* ---------------------------------------------------------------- *
 * Pure helpers
 * ---------------------------------------------------------------- */

/** "A", "A and B", "A, B and C". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1) ?? ''}`
}

/** One line on screen: a row, or several rows that say exactly the same thing. */
export interface ChecklistEntry {
  readonly key: string
  readonly labels: readonly string[]
  readonly item: CheckItem
}

/** Rows that can share a line: nothing to do about them, so only the label tells them apart. */
const mergeable = (item: CheckItem) =>
  item.status === 'unchecked' && !item.detail && (item.fixes ?? []).length === 0

/**
 * Neighbouring "Not checked" rows with the same sentence and no fixes become one line. In P1
 * that turns the helper's eight "Coming with the Device Lab helper." rows into one.
 */
export function collapseRepeats(items: readonly CheckItem[]): ChecklistEntry[] {
  const out: ChecklistEntry[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (
      last &&
      mergeable(item) &&
      mergeable(last.item) &&
      last.item.sentence === item.sentence &&
      last.item.group === item.group
    ) {
      out[out.length - 1] = { ...last, labels: [...last.labels, item.label] }
    } else {
      out.push({ key: item.id, labels: [item.label], item })
    }
  }
  return out
}

/** The fixes of a row, sorted by how they are drawn. */
export function splitFixes(fixes: readonly Fix[] = []) {
  const commands: Extract<Fix, { copy: string }>[] = []
  const paths: Extract<Fix, { path: string }>[] = []
  const buttons: Extract<Fix, { href: string } | { action: FixAction }>[] = []
  for (const fix of fixes) {
    if ('copy' in fix) commands.push(fix)
    else if ('path' in fix) paths.push(fix)
    else buttons.push(fix)
  }
  return { commands, paths, buttons }
}

/** The compact card's title, by the worst status it holds. */
export const INLINE_TITLES: Readonly<Record<Exclude<CheckStatus, 'ok'>, string>> = {
  blocking: 'Fix this first',
  warning: 'Check this first',
  unchecked: 'Not checked yet',
}

/**
 * The props for a feature's main button under its compact card: described by the card while
 * the card shows anything, and aria-disabled while a row is Blocking. The button's handler
 * must still refuse to run then — aria-disabled stops nothing by itself.
 */
export function featureButtonProps(
  items: readonly CheckItem[],
  cardId: string,
): { 'aria-disabled'?: true; 'aria-describedby'?: string } {
  if (items.every((item) => item.status === 'ok')) return {}
  return worst(items) === 'blocking'
    ? { 'aria-disabled': true, 'aria-describedby': cardId }
    : { 'aria-describedby': cardId }
}

/* ---------------------------------------------------------------- *
 * Pieces
 * ---------------------------------------------------------------- */

/** A status as its dot and its word. */
export function StatusWord({ status, className }: { status: CheckStatus; className?: string }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      <StateDot tone={meta.tone} />
      {meta.label}
    </span>
  )
}

/**
 * A command to run, on one line as it will be typed, with its copy button. Too long for the
 * width, it scrolls rather than breaking a path or URL in the middle.
 */
export function Command({ text, label = 'Copy command' }: { text: string; label?: string }) {
  return (
    <div className="bg-muted/60 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs whitespace-pre">
        {text}
      </code>
      <CopyButton text={text} label={label} />
    </div>
  )
}

/** A settings path to follow, on the phone or in the browser. */
export function PathFix({ fix }: { fix: Extract<Fix, { path: string }> }) {
  return (
    <p className="text-xs leading-relaxed">
      <span className="text-foreground font-medium">{fix.label}:</span>{' '}
      <span className="text-muted-foreground">{fix.path}</span>
    </p>
  )
}

/** A link or an action, as a small button. Null for an action nobody wired up. */
export function FixButton({
  fix,
  wiring = {},
}: {
  fix: Extract<Fix, { href: string } | { action: FixAction }>
  wiring?: FixWiring
}) {
  const variant = fix.primary ? 'default' : 'outline'
  if ('href' in fix) {
    return (
      <Button asChild size="sm" variant={variant}>
        <a href={fix.href} target="_blank" rel="noopener noreferrer">
          {fix.label}
          <ExternalLink aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Button>
    )
  }
  const run = wiring.on?.[fix.action]
  if (!run) return null
  const pending = wiring.pending?.includes(fix.action) ?? false
  const blocked = wiring.blocked?.includes(fix.action) ?? false
  return (
    // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
    <Button
      size="sm"
      variant={variant}
      aria-disabled={pending || blocked || undefined}
      aria-describedby={blocked ? wiring.blockedBy : undefined}
      className="aria-disabled:opacity-50"
      onClick={() => {
        if (!pending && !blocked) void run()
      }}
    >
      {pending && <Loader2 className="animate-spin" />}
      {pending && fix.action === 'retry' ? 'Reconnecting…' : fix.label}
    </Button>
  )
}

/**
 * What a row says beyond its label: the sentence, the commands it points at, the quieter
 * detail line, the settings paths, then the buttons.
 */
export function RowBody({ item, wiring }: { item: CheckItem; wiring?: FixWiring }) {
  const { commands, paths, buttons } = splitFixes(item.fixes)
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-muted-foreground text-sm leading-relaxed">{item.sentence}</p>
      {commands.map((fix) => (
        <Command key={fix.copy} text={fix.copy} label={fix.label} />
      ))}
      {item.detail && (
        <p className="text-muted-foreground text-xs leading-relaxed">{item.detail}</p>
      )}
      {paths.map((fix) => (
        <PathFix key={fix.label + fix.path} fix={fix} />
      ))}
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {buttons.map((fix) => (
            <FixButton key={fix.label} fix={fix} wiring={wiring} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One line of a section: status word in a column of its own, then the label and the rest. */
function ChecklistRow({ entry, wiring }: { entry: ChecklistEntry; wiring?: FixWiring }) {
  return (
    <li className="grid grid-cols-[5.5rem_1fr] gap-3 px-3 py-2.5">
      <StatusWord status={entry.item.status} className="h-5" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm leading-5 font-medium">{joinLabels(entry.labels)}</p>
        <RowBody item={entry.item} wiring={wiring} />
      </div>
    </li>
  )
}

const GROUP_ORDER: readonly CheckGroup[] = ['browser', 'phone', 'helper', 'feature']

/* ---------------------------------------------------------------- *
 * The full checklist (Environment check)
 * ---------------------------------------------------------------- */

/**
 * Every row, in sections: This browser · Phone: {name} · Helper · Features. Rows keep the order
 * checks.ts gives them (the phone's follow the Gate's steps); each section's heading carries
 * its worst status.
 */
export function Checklist({
  items,
  phoneName,
  wiring,
}: {
  items: readonly CheckItem[]
  phoneName?: string
  wiring?: FixWiring
}) {
  const uid = useId()
  return (
    <div className="space-y-5">
      {GROUP_ORDER.map((group) => {
        const rows = items.filter((item) => item.group === group)
        if (rows.length === 0) return null
        const title =
          group === 'phone' && phoneName
            ? `${GROUP_TITLES.phone}: ${phoneName}`
            : GROUP_TITLES[group]
        const headingId = `${uid}-${group}`
        return (
          <section key={group} aria-labelledby={headingId} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 id={headingId} className="text-sm font-semibold">
                {title}
              </h3>
              <StatusWord status={worst(rows)} />
            </div>
            <ul className="divide-y rounded-lg border">
              {collapseRepeats(rows).map((entry) => (
                <ChecklistRow key={entry.key} entry={entry} wiring={wiring} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * The compact card (a feature's prerequisites)
 * ---------------------------------------------------------------- */

/**
 * The card at the top of the Install dialog, the Images tab and so on: in the HintCard look,
 * tinted by the worst status, listing only what isn't OK, worst first. Renders nothing when
 * every row is OK. Point the feature's main button at it with featureButtonProps(items, id).
 */
export function InlineChecklist({
  id,
  items,
  title,
  wiring,
  className,
}: {
  /** The aria-describedby target of the feature's main button. */
  id: string
  items: readonly CheckItem[]
  title?: string
  wiring?: FixWiring
  className?: string
}) {
  const shown = bySeverity(items.filter((item) => item.status !== 'ok'))
  if (shown.length === 0) return null
  const status = worst(shown)
  const tone = STATUS_META[status].tone
  const headingId = `${id}-title`
  return (
    <div
      id={id}
      role="note"
      aria-labelledby={headingId}
      className={cn('rounded-xl border p-4', TONE_SURFACE[tone], className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="font-semibold">
          {title ?? INLINE_TITLES[status === 'ok' ? 'unchecked' : status]}
        </h3>
        <StatusWord status={status} />
      </div>
      <ul className="mt-3 space-y-3">
        {collapseRepeats(shown).map((entry) => (
          <li key={entry.key} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium">{joinLabels(entry.labels)}</span>
              <StatusWord status={entry.item.status} />
            </div>
            <RowBody item={entry.item} wiring={wiring} />
          </li>
        ))}
      </ul>
    </div>
  )
}
