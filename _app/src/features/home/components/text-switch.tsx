import type { ReactNode } from 'react'

/**
 * A pair of words in a corner — "Light  Dark", "List  Grid", "English  Tiếng Việt" — set
 * like the reference's own text links: the current choice in ink, the other in label grey.
 * Pressed-state buttons rather than one toggle, so the choice reads without an icon to decode.
 */
export function TextSwitch<T extends string>({
  label,
  options,
  value,
  onSelect,
  className,
}: {
  /** Accessible name of the group. */
  label: string
  /** `lang` marks a label written in another language than the page's: a language's own name. */
  options: readonly { readonly value: T; readonly label: ReactNode; readonly lang?: string }[]
  value: T
  /** Called only for a change; gets the pressed button, e.g. to start an animation there. */
  onSelect: (next: T, from: HTMLButtonElement) => void
  /** Placement: which corner, e.g. `bottom-6 left-6`. */
  className: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`fixed z-10 flex gap-4 text-[14px] leading-none ${className}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          lang={option.lang}
          aria-pressed={option.value === value}
          onClick={(event) => {
            if (option.value !== value) onSelect(option.value, event.currentTarget)
          }}
          className="text-index-label hover:text-index-ink aria-pressed:text-index-ink cursor-pointer py-2 transition-colors duration-200"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
