import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { LANGUAGES, isLocale, setLocale, useLocale } from '@/lib/locale'

import { SITE_MESSAGES } from './messages'

/**
 * EN · VI in a console header: a segmented control in shadcn's tabs look, Device Lab's
 * platform filter made small. Both languages stay in view, so nobody has to guess whether a
 * label names the current language or the next one; each is named in itself.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale()
  const t = useMessages(SITE_MESSAGES)
  return (
    <ToggleGroup
      type="single"
      value={locale}
      onValueChange={(value) => {
        if (isLocale(value)) setLocale(value)
      }}
      aria-label={t.language}
      className={cn('bg-muted text-foreground/75 h-8 rounded-lg p-[3px]', className)}
    >
      {LANGUAGES.map((language) => (
        <ToggleGroupItem
          key={language.value}
          value={language.value}
          lang={language.value}
          aria-label={language.name}
          title={language.name}
          // Radio semantics, radio behaviour, as in Device Lab's filter: an arrow key moves
          // focus and chooses.
          onFocus={() => {
            setLocale(language.value)
          }}
          className={cn(
            'h-full min-w-9 rounded-md border border-transparent px-2 text-xs font-semibold data-[spacing=0]:rounded-md',
            'hover:text-foreground hover:bg-transparent',
            'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            'dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30',
          )}
        >
          {language.short}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
