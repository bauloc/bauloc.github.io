import type { CSSProperties } from 'react'
import { Toaster as Sonner } from 'sonner'

import { useTheme } from '@/lib/theme'

/**
 * Sonner's toaster in the site's theme. shadcn's own `sonner` component reads next-themes,
 * which this app does not use, so this thin wrapper takes its place.
 */
export function Toaster() {
  const theme = useTheme()
  return (
    <Sonner
      theme={theme}
      position="top-right"
      richColors
      closeButton
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
