import type { HomeLink } from '../home-links'

/**
 * Right-aligned meta. Short, lowercase, same slot for every kind of row.
 *
 * `↗` rather than the word "external": it was the longest string in the column and pulled
 * the eye to the least important row on the page.
 */
function metaFor(link: HomeLink): string {
  if (link.external === true) return '↗'
  return link.status
}

/**
 * One row of the index.
 *
 * No card, no border, no background — whitespace separates rows, which is the single
 * biggest structural change from the card grid this replaces. Chrome around every entry
 * stops scaling long before the entries do.
 *
 * The layout is a three-column grid: a fixed gutter for the keyboard cursor, the title, and
 * right-aligned meta. The gutter is always present even when empty, so moving the cursor
 * never shifts the text — the commonest way a list like this feels cheap.
 *
 * There is deliberately no description here. A bare icon grid could not express "this needs
 * a GitHub token" or "this is half-built", which is the one thing you must know before
 * clicking; a text row gets that for free in the meta slot. The description still exists in
 * the data, where it feeds search and the accessible name.
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
      aria-label={`${link.title} — ${link.description}`}
      title={link.description}
      href={link.href}
      target={link.external === true ? '_blank' : undefined}
      rel={link.external === true ? 'noopener noreferrer' : undefined}
      onMouseMove={onHover}
      className="group grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-3 py-[0.4375rem] text-inherit no-underline"
    >
      {/* Always rendered, so the cursor appearing cannot move the title. */}
      <span
        aria-hidden="true"
        className={`text-accent font-mono text-xs transition-opacity duration-100 ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      >
        →
      </span>

      <span
        className={`truncate font-mono text-sm transition-colors duration-100 ${
          active ? 'text-accent' : 'text-foreground'
        }`}
      >
        {link.title}
      </span>

      <span className="text-muted-foreground/60 font-mono text-[0.6875rem] tracking-[0.02em] tabular-nums">
        {metaFor(link)}
      </span>
    </a>
  )
}
