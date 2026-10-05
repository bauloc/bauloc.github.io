import type { CSSProperties } from 'react'
import { Toaster as Sonner } from 'sonner'

import { useMessages } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

import { SITE_MESSAGES } from './messages'

/**
 * Sonner's toaster in the site's theme. shadcn's own `sonner` component reads next-themes,
 * which this app does not use, so this thin wrapper takes its place.
 */
export function Toaster() {
  const theme = useTheme()
  const t = useMessages(SITE_MESSAGES)
  return (
    <Sonner
      theme={theme}
      position="top-right"
      richColors
      closeButton
      containerAriaLabel={t.notifications}
      toastOptions={{ closeButtonAriaLabel: t.closeToast }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as CSSProperties
      }
    />
  )
}
