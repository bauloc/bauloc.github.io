import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { setTheme, useTheme } from '@/lib/theme'

/** Light ⇄ dark, shadcn's mode toggle. Shares the choice with the index's switch. */
export function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        setTheme(next)
      }}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  )
}
