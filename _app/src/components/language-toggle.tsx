import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { LANGUAGES, isLocale, setLocale, useLocale } from '@/lib/locale'

import { SITE_MESSAGES } from './messages'

/**
 * EN · VI in the site header's command-line row: two monospace segments on the row's dark
 * ground, the current one lit. Both languages stay in view, so nobody has to guess whether a
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
      className={cn(
        'h-7 rounded-md bg-white/[0.06] p-0.5 ring-1 ring-white/10 ring-inset',
        className,
      )}
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
            'font-terminal h-full min-w-8 rounded-[5px] px-1.5 text-xs font-medium text-zinc-400 data-[spacing=0]:rounded-[5px]',
            'hover:bg-transparent hover:text-zinc-100',
            'data-[state=on]:bg-white/15 data-[state=on]:text-zinc-50',
            'focus-visible:ring-2 focus-visible:ring-green-400',
          )}
        >
          {language.short}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
