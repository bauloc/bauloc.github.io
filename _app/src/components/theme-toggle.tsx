import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useMessages } from '@/lib/i18n'
import { setTheme, useTheme } from '@/lib/theme'

import { SITE_MESSAGES } from './messages'

/** Light ⇄ dark, shadcn's mode toggle. Shares the choice with the index's switch. */
export function ThemeToggle() {
  const theme = useTheme()
  const t = useMessages(SITE_MESSAGES)
  const next = theme === 'dark' ? 'light' : 'dark'
  const label = next === 'dark' ? t.darkMode : t.lightMode
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(next)
      }}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  )
}
