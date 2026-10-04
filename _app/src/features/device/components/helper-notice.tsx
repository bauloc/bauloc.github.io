import type { ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

import type { HelperStatus } from '../helper/connection'
import { helperNotice } from '../helper/status'
import type { HelperUpdate } from '../helper/update'
import type { HelperHandlers } from './helper-chip'
import { StateDot, TONE_SURFACE } from './status'

/*
  The strip above the device grid once devices are listed and the Gate is gone (spec §6.8):
  the helper stopped, restarted, is outdated or newer, a newer one is published ("Helper update
  available", from the published file the update row reads), or something else holds its port. Only
  for a tester who showed they want the helper in this page view (helperNotice checks
  `intent`), so an Android-only tester never sees it. The live region and the lost toast say
  the change once; this strip stays while it is true.
*/

function copyCommand(command: string) {
  navigator.clipboard.writeText(command).then(
    () => toast.success('Copied', { description: command }),
    () => toast.error('Copy failed', { description: 'Select the text and copy it by hand.' }),
  )
}

export function HelperNotice({
  status,
  on,
  update = null,
}: {
  status: HelperStatus
  on: HelperHandlers
  /** helperUpdate(…): a newer published helper, said while this one is connected. */
  update?: HelperUpdate | null
}) {
  const view = helperNotice(status, update)
  if (!view) return null
  const { action } = view
  let button: ReactNode = null
  if (action.action === 'copy-command' && action.command) {
    const command = action.command
    button = (
      <Button
        size="sm"
        variant="outline"
        title={command}
        onClick={() => {
          copyCommand(command)
        }}
      >
        {action.label}
      </Button>
    )
  } else if (action.action !== 'open-local' && action.action !== 'copy-command') {
    const run = on[action.action]
    if (run) {
      button = (
        <Button size="sm" variant="outline" onClick={run}>
          {action.label}
        </Button>
      )
    }
  }
  return (
    <section
      aria-label="Local helper"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3',
        TONE_SURFACE[view.tone],
      )}
    >
      <StateDot tone={view.tone} />
      <p className="min-w-0 flex-1 text-sm leading-relaxed">{view.text}</p>
      {button}
    </section>
  )
}
