import type { HomeLink } from '../home-links'
import { StatusBadge } from './status-badge'

/**
 * One launcher result.
 *
 * A real <a>, so ⌘-click, middle-click and "copy link" work without any of our code, and so
 * the list is navigable if the keyboard handler ever breaks. `active` is driven by the
 * launcher's keyboard cursor, not by :hover or :focus — the input keeps focus the whole time,
 * which is what makes type-then-Enter feel instant.
 */
export function LinkRow({
  link,
  active,
  id,
  onHover,
}: {
  link: HomeLink
  active: boolean
  id: string
  onHover: () => void
}) {
  return (
    <a
      id={id}
      role="option"
      aria-selected={active}
      href={link.href}
      target={link.external === true ? '_blank' : undefined}
      rel={link.external === true ? 'noopener noreferrer' : undefined}
      onMouseMove={onHover}
      className={`
        flex items-center gap-3.5 rounded-md border-l-2 px-3 py-2.5 text-inherit no-underline
        transition-colors duration-100
        ${
          active
            ? 'border-l-accent bg-card'
            : 'hover:bg-card/60 border-l-transparent'
        }
      `}
    >
      <span className="w-6 shrink-0 text-center text-lg leading-none" aria-hidden="true">
        {link.icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-foreground font-mono text-sm font-semibold">{link.title}</span>
          <StatusBadge status={link.status} />
          {link.external === true && (
            <span className="text-muted-foreground text-[0.6875rem]" aria-label="opens in a new tab">
              ↗
            </span>
          )}
        </span>
        {/* Descriptions are ours, but they are still text — rendered as a text node, never markup. */}
        <span className="text-muted-foreground mt-0.5 block truncate text-[0.8125rem] leading-[1.5]">
          {link.description}
        </span>
      </span>

      <span
        aria-hidden="true"
        className={`shrink-0 font-mono text-xs transition-opacity duration-100 ${
          active ? 'text-accent opacity-100' : 'opacity-0'
        }`}
      >
        ↵
      </span>
    </a>
  )
}
