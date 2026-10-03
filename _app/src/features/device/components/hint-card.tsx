import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

import { STATE_META, type Device, type Hint } from '../model'
import { TONE_SURFACE } from './status'

/**
 * What is wrong and what to DO about it: the device's first blocker, with its fixes as
 * buttons — copy a command, reconnect, open the environment check.
 */
export function HintCard({
  device,
  hint,
  retrying,
  onRetry,
  onDoctor,
}: {
  device: Device
  hint: Hint
  /** This device's Retry is in flight (the store tracks it, per device). */
  retrying: boolean
  onRetry: () => Promise<void>
  onDoctor: () => void
}) {
  const tone = STATE_META[device.state].tone

  return (
    <div role="note" className={cn('rounded-xl border p-4', TONE_SURFACE[tone])}>
      <h3 className="font-semibold">{hint.title}</h3>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{hint.body}</p>
      {hint.fixes && hint.fixes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {hint.fixes.map((fix) => {
            const variant = fix.primary ? 'default' : 'outline'
            if ('copy' in fix) {
              return (
                <Button
                  key={fix.label}
                  size="sm"
                  variant={variant}
                  onClick={() => {
                    navigator.clipboard.writeText(fix.copy).then(
                      () => toast.success('Copied', { description: fix.copy }),
                      () =>
                        toast.error('Copy failed', {
                          description: 'Select the text and copy it by hand.',
                        }),
                    )
                  }}
                >
                  {fix.label}
                </Button>
              )
            }
            if (fix.action === 'retry') {
              return (
                // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
                <Button
                  key={fix.label}
                  size="sm"
                  variant={variant}
                  aria-disabled={retrying}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    if (!retrying) void onRetry()
                  }}
                >
                  {retrying && <Loader2 className="animate-spin" />}
                  {retrying ? 'Reconnecting…' : fix.label}
                </Button>
              )
            }
            return (
              <Button key={fix.label} size="sm" variant={variant} onClick={onDoctor}>
                {fix.label}
              </Button>
            )
          })}
        </div>
      )}
      {hint.extra && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">{hint.extra}</p>
      )}
    </div>
  )
}
