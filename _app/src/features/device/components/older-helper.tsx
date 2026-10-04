import { cn } from '@/lib/cn'

import { downloadCommand } from '../helper/status'
import type { GatedFeature } from '../helper/update'
import { COPY } from '../preflight/copy'
import { Command } from './checklist'
import { StateDot, TONE_SURFACE } from './status'

/*
  "Your helper is older than this page", said where the feature would be (featureSupport is
  `older`): what it can't do yet, the command that fetches the new file and starts it on the
  port this page talks to, and the reload after. Without it a helper downloaded before the
  feature shipped just left the feature out, and the tester saw nothing and no reason.
*/

export function OlderHelper({
  feature,
  port,
  className,
}: {
  feature: GatedFeature
  /** The port this page talks to (status.env.port), so the new helper starts where it looks. */
  port: number
  className?: string
}) {
  return (
    <div className={cn('min-w-0 space-y-2 rounded-xl border p-3', TONE_SURFACE.warn, className)}>
      <p className="flex items-center gap-2 text-sm leading-6 font-medium">
        <StateDot tone="warn" />
        Update the helper
      </p>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {COPY.older.sentence(feature)}
      </p>
      <Command text={downloadCommand(port)} />
      <p className="text-muted-foreground text-xs leading-relaxed">{COPY.older.then}</p>
    </div>
  )
}
