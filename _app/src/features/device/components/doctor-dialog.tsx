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

/** The facts the environment check reports, as label/value pairs (also its plain-text copy). */
export function environmentRows(input: {
  webusb: boolean
  secure: boolean
  mock: boolean
  devices: number
}): [string, string][] {
  return [
    ['Browser WebUSB', input.webusb ? 'available' : 'not implemented in this browser'],
    ['Secure context', input.secure ? 'yes' : 'no — WebUSB requires HTTPS or localhost'],
    ['Mock devices', input.mock ? 'on (?mock=1)' : 'off'],
    ['UI version', __APP_VERSION__],
    ['Devices seen', String(input.devices)],
    ['Local helper', 'not running (iOS unavailable)'],
  ]
}

/** What this page can currently do, and why — the first thing to read when something does not work. */
export function DoctorDialog({
  open,
  onOpenChange,
  rows,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: readonly [string, string][]
}) {
  // Opened from two places with no DialogTrigger, so Radix has nowhere to return focus to:
  // remember what had it, and put it back on close instead of leaving it on <body>.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
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
          <DialogDescription>What this page can currently do, and why.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y rounded-lg border">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[9rem_1fr] gap-3 px-3 py-2 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n')).then(
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
