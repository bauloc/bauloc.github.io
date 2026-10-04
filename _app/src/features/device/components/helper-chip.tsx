import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

import type { HelperStatus } from '../helper/connection'
import type { HelperDevice } from '../helper/protocol'
import { helperChip, type HelperAction, type HelperActionView } from '../helper/status'
import { StateDot } from './status'

/*
  The local helper's chip in the header, beside the WebUSB one (spec §6.8): two chips, so
  "the helper isn't running" and "the helper runs, with no devices" never look alike. The words
  come from helper/status.ts; this file only lays them out. Hidden below md like the WebUSB
  chip: the Environment check button reaches the same things on every width.
*/

/** What the page does for each of the helper's buttons. One left out hides its button. */
export type HelperHandlers = Partial<Record<Exclude<HelperAction, 'open-local'>, () => void>>

const CHIP = 'gap-1.5'
const CLICKABLE =
  'cursor-pointer hover:bg-accent hover:text-accent-foreground focus-visible:outline-none'

/**
 * The chip's accessible name: its visible text first (so speech input can say what it sees),
 * then what a click does.
 */
export const chipName = (text: string, action: HelperActionView) =>
  action.action === 'check' ? `${text}: open the Environment check` : `${text}: ${action.label}`

/**
 * The chip: a button when a click does something (connect, pair, the Environment check,
 * reload), a link for the helper's own page, plain text while it is looking.
 */
export function HelperChip({
  status,
  devices,
  on,
}: {
  status: HelperStatus
  /** The helper's own rows, for "1/2 ready via helper". */
  devices: readonly HelperDevice[]
  on: HelperHandlers
}) {
  const view = helperChip(status, devices)
  const body = (
    <>
      <StateDot tone={view.tone} />
      {view.text}
    </>
  )
  const { action } = view
  if (action?.href) {
    return (
      <Badge asChild variant="outline" className={cn(CHIP, CLICKABLE)}>
        <a href={action.href} title={view.tooltip} aria-label={chipName(view.text, action)}>
          {body}
        </a>
      </Badge>
    )
  }
  const run = action && action.action !== 'open-local' ? on[action.action] : undefined
  if (action && run) {
    return (
      <Badge asChild variant="outline" className={cn(CHIP, CLICKABLE)}>
        <button
          type="button"
          title={view.tooltip}
          aria-label={chipName(view.text, action)}
          onClick={run}
        >
          {body}
        </button>
      </Badge>
    )
  }
  // Looking: still a button, inert, so the focus a keyboard user put on Connect helper stays on
  // the chip until it says what it found.
  if (status.phase === 'checking') {
    return (
      <Badge asChild variant="outline" className={CHIP}>
        <button type="button" title={view.tooltip} aria-disabled="true">
          {body}
        </button>
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={CHIP} title={view.tooltip}>
      {body}
    </Badge>
  )
}
