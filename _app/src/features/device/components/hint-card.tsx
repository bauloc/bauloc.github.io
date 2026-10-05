import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { localized } from '@/lib/i18n'

import { STATE_META, type Device, type Hint } from '../model'
import { COPY } from '../preflight/copy'
import type { CheckId, CheckItem, Fix } from '../preflight/types'
import { FixButton, PathFix, splitFixes, type FixWiring } from './checklist'
import { TONE_SURFACE } from './status'

/** Titles for the phone rows that can stand in for a device hint. */
const CHECK_TITLES = localized<Partial<Readonly<Record<CheckId, string>>>>({
  en: {
    'phone.notHeld': 'Something else is using this phone',
    'phone.osAccess': 'This computer won’t let the browser open the phone',
  },
  vi: {
    'phone.notHeld': 'Có thứ khác đang dùng điện thoại này',
    'phone.osAccess': 'Máy tính này không cho trình duyệt mở điện thoại',
  },
})

/** What a copy button's toast says, worded when it is raised. */
const COPY_TOAST = localized({
  en: {
    copied: 'Copied',
    failed: 'Copy failed',
    byHand: 'Select the text and copy it by hand.',
  },
  vi: {
    copied: 'Đã sao chép',
    failed: 'Không sao chép được',
    byHand: 'Hãy bôi đen đoạn chữ và tự sao chép.',
  },
})

/**
 * The phone row that says more about this device's blocker than its hint does, or null:
 * the system refusing to open the phone (Linux udev rules, a Windows driver), or who holds it
 * when that is known (another tab, or a process the helper named). The generic "another
 * program" row is left out: the hint already says that, with today's wording. Windows' row
 * is not generic — it adds the maker's driver the hint doesn't know about — so it stays.
 */
export function deviceCheck(device: Device, phone: readonly CheckItem[]): CheckItem | null {
  const access = phone.find((item) => item.id === 'phone.osAccess')
  if (access?.status === 'blocking') return access
  if (device.state !== 'held') return null
  const held = phone.find((item) => item.id === 'phone.notHeld')
  return held?.status === 'blocking' && held.sentence !== COPY.notHeld.held ? held : null
}

/** What the card says: the hint, with a known phone row's sentence, fixes and detail in its place. */
export function hintContent(
  hint: Hint | null,
  check: CheckItem | null,
): { title: string; body: string; fixes: readonly Fix[]; extra?: string } | null {
  if (check) {
    return {
      title: CHECK_TITLES[check.id] ?? hint?.title ?? check.label,
      body: check.sentence,
      fixes: check.fixes ?? [],
      ...(check.detail ? { extra: check.detail } : {}),
    }
  }
  if (!hint) return null
  return {
    title: hint.title,
    body: hint.body,
    fixes: hint.fixes ?? [],
    ...(hint.extra ? { extra: hint.extra } : {}),
  }
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(COPY_TOAST.copied, { description: text }),
    () =>
      toast.error(COPY_TOAST.failed, {
        description: COPY_TOAST.byHand,
      }),
  )
}

/**
 * What is wrong and what to DO about it: the device's first blocker, with its fixes as
 * buttons — copy a command, reconnect, open the environment check, open a guide — and any
 * settings path to follow on the phone.
 */
export function HintCard({
  device,
  hint,
  check = null,
  retrying,
  onRetry,
  onDoctor,
  wiring,
}: {
  device: Device
  hint: Hint | null
  /** From deviceCheck(): a phone row that knows more than the hint (who holds the phone). */
  check?: CheckItem | null
  /** This device's Retry is in flight (the store tracks it, per device). */
  retrying: boolean
  onRetry: () => Promise<void>
  onDoctor: () => void
  /** The checklist's other actions (`release-other-tab`…); one with no handler isn't shown. */
  wiring?: FixWiring
}) {
  const content = hintContent(hint, check)
  if (!content) return null
  // A hint is always something to act on: on a ready device (Xcode missing, Developer Mode
  // off) it is a warning, as the list row's amber rule shows it, never the green of "all good".
  const stateTone = STATE_META[device.state].tone
  const tone = stateTone === 'ok' ? 'warn' : stateTone
  const { commands, paths, buttons } = splitFixes(content.fixes)
  // Retry and the environment check are this card's own; the rest go through the wiring.
  const own: FixWiring = {
    ...wiring,
    on: { ...wiring?.on, retry: onRetry, doctor: onDoctor },
    pending: retrying ? [...(wiring?.pending ?? []), 'retry'] : wiring?.pending,
  }

  return (
    <div role="note" className={cn('rounded-xl border p-4', TONE_SURFACE[tone])}>
      <h3 className="font-semibold">{content.title}</h3>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{content.body}</p>
      {paths.length > 0 && (
        <div className="mt-3 space-y-1">
          {paths.map((fix) => (
            <PathFix key={fix.label + fix.path} fix={fix} />
          ))}
        </div>
      )}
      {commands.length + buttons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {commands.map((fix) => (
            <Button
              key={fix.label}
              size="sm"
              variant={fix.primary ? 'default' : 'outline'}
              onClick={() => {
                copyText(fix.copy)
              }}
            >
              {fix.label}
            </Button>
          ))}
          {buttons.map((fix) => (
            <FixButton key={fix.label} fix={fix} wiring={own} />
          ))}
        </div>
      )}
      {content.extra && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">{content.extra}</p>
      )}
    </div>
  )
}
