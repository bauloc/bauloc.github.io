import { Network, Usb } from 'lucide-react'
import type { MouseEvent } from 'react'

import { cn } from '@/lib/cn'
import { defineMessages, useMessages } from '@/lib/i18n'

/*
  Device Lab's two jobs, Scan Device (every device on this network) and Connect Device (a phone
  over USB or Wi‑Fi), as the page's own tabs: a level above the choices inside each job (the
  platform cards under Connect Device), so the two never look alike. Each tab is a link to its
  own address, ?view=scan or ?view=connect: a plain click switches in place, a new tab or a
  copied link opens that job directly.
*/

/** Which of Device Lab's two jobs the page shows. */
export type DeviceView = 'scan' | 'connect'

const VIEWS: readonly DeviceView[] = ['scan', 'connect']

/** `?view=scan` or `?view=connect`; anything else is Connect, the page's first job. */
export function parseView(value: unknown): DeviceView {
  return value === 'scan' ? 'scan' : 'connect'
}

/** This page's address with `view` set, its other parameters (?mock=1) kept. */
function viewHref(view: DeviceView): string {
  if (typeof window === 'undefined') return `?view=${view}`
  const params = new URLSearchParams(window.location.search)
  params.set('view', view)
  return `${window.location.pathname}?${params.toString()}`
}

const MODE_MESSAGES = defineMessages({
  en: {
    title: 'Scan or connect a device',
    lead: 'Scan every device on your network, or connect a phone for its details, screenshots and logs. Everything runs locally — nothing about your devices is uploaded anywhere.',
    label: 'Device Lab',
    views: {
      scan: { name: 'Scan Device', how: 'Every device on this Wi‑Fi' },
      connect: { name: 'Connect Device', how: 'A phone over USB or Wi‑Fi' },
    },
  },
  vi: {
    title: 'Quét hoặc kết nối thiết bị',
    lead: 'Quét mọi thiết bị trên mạng của bạn, hoặc kết nối điện thoại để xem thông tin, ảnh chụp màn hình và log. Mọi thứ chạy ngay trên máy — không có dữ liệu nào về thiết bị của bạn bị tải lên bất cứ đâu.',
    label: 'Device Lab',
    views: {
      scan: { name: 'Quét thiết bị', how: 'Mọi thiết bị trên Wi‑Fi này' },
      connect: { name: 'Kết nối thiết bị', how: 'Điện thoại qua USB hoặc Wi‑Fi' },
    },
  },
})

const ICON = { scan: Network, connect: Usb } as const

/** A plain left click switches in place; one with a modifier is the browser's (a new tab…). */
const plainClick = (e: MouseEvent) =>
  !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/**
 * The page's title and its two tabs. Without `intro` only the tabs show, above the device list
 * once a phone is connected.
 */
export function ModeSwitch({
  value,
  onChange,
  intro = true,
}: {
  value: DeviceView
  onChange: (view: DeviceView) => void
  intro?: boolean
}) {
  const t = useMessages(MODE_MESSAGES)
  return (
    <div>
      {intro && (
        <>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{t.title}</h1>
          <p className="text-muted-foreground mt-3 max-w-[65ch] text-base leading-relaxed">
            {t.lead}
          </p>
        </>
      )}
      <nav aria-label={t.label} className={cn('border-b', intro && 'mt-8')}>
        <ul className="-mb-px flex">
          {VIEWS.map((view) => {
            const current = view === value
            const { name, how } = t.views[view]
            const Icon = ICON[view]
            return (
              <li key={view} className="min-w-0 flex-1 sm:flex-none">
                <a
                  href={viewHref(view)}
                  aria-current={current ? 'page' : undefined}
                  title={how}
                  onClick={(e) => {
                    if (!plainClick(e)) return
                    e.preventDefault()
                    onChange(view)
                  }}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-t-md border-b-2 px-3 pt-1 pb-3 text-sm font-medium transition-colors sm:justify-start sm:px-4 sm:text-base',
                    'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
                    current
                      ? 'border-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 sm:size-5" />
                  <span className="truncate">{name}</span>
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
