import type { ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { defineMessages, useMessages } from '@/lib/i18n'

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

/** The copy toasts say what the site's do (SITE_MESSAGES), in both languages. */
const NOTICE_MESSAGES = defineMessages({
  en: {
    region: 'Local helper',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    copyByHand: 'Select the text and copy it by hand.',
  },
  vi: {
    region: 'Helper cục bộ',
    copied: 'Đã sao chép',
    copyFailed: 'Không sao chép được',
    copyByHand: 'Hãy bôi đen đoạn chữ và tự sao chép.',
  },
})

type NoticeMessages = (typeof NOTICE_MESSAGES)['en']

function copyCommand(command: string, t: NoticeMessages) {
  navigator.clipboard.writeText(command).then(
    () => toast.success(t.copied, { description: command }),
    () => toast.error(t.copyFailed, { description: t.copyByHand }),
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
  const t = useMessages(NOTICE_MESSAGES)
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
          copyCommand(command, t)
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
      aria-label={t.region}
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
