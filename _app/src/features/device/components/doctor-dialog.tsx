import { ClipboardCopy } from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { checklistText } from '../preflight/checks'
import { STATUS_META } from '../preflight/copy'
import type { CheckItem, CheckStatus } from '../preflight/types'
import { Checklist, type FixWiring } from './checklist'

const SUMMARY_ORDER: readonly CheckStatus[] = ['blocking', 'warning', 'unchecked']

/** "2 Blocking · 1 Warning · 9 Not checked", or that everything is OK. */
export function checklistSummary(items: readonly CheckItem[]): string {
  const parts = SUMMARY_ORDER.flatMap((status) => {
    const n = items.filter((item) => item.status === status).length
    return n > 0 ? [`${String(n)} ${STATUS_META[status].label}`] : []
  })
  return parts.length > 0 ? parts.join(' · ') : 'Everything checked is OK.'
}

/**
 * What this page can currently do, and why — the first thing to read when something does not
 * work. Every checklist row, grouped This browser · Phone: {name} · Helper · Features, with
 * "Copy as text" for a ticket (checklistText never prints the helper's token).
 */
export function DoctorDialog({
  open,
  onOpenChange,
  items,
  phoneName,
  wiring,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** browserChecks + phoneChecks + helperChecks + featureChecks('summary', …), in that order. */
  items: readonly CheckItem[]
  /** The phone the rows are about, for the "Phone: Pixel 9" heading. */
  phoneName?: string
  wiring?: FixWiring
}) {
  // Opened from two places with no DialogTrigger, so Radix has nowhere to return focus to:
  // remember what had it, and put it back on close instead of leaving it on <body>.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          opener.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Environment check</DialogTitle>
          <DialogDescription>
            What this page can do right now, and what to fix. {checklistSummary(items)}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 max-h-[min(65dvh,40rem)] overflow-y-auto px-6">
          <Checklist items={items} phoneName={phoneName} wiring={wiring} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(checklistText(items, phoneName)).then(
                () => toast.success('Copied the environment check'),
                () =>
                  toast.error('Copy failed', {
                    description: 'Your browser blocked clipboard access.',
                  }),
              )
            }}
          >
            <ClipboardCopy /> Copy as text
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
