import type { LinkStatus } from '../home-links'

/**
 * `wip` is the reason this exists. Device Lab is half-built, and a launcher that presents an
 * unfinished tool identically to a finished one sends you into a dead end. `internal` says
 * "this needs a token", which is different from "this is not ready".
 */
const LABEL: Record<LinkStatus, string> = {
  live: 'live',
  wip: 'wip',
  internal: 'internal',
}

const TONE: Record<LinkStatus, string> = {
  live: 'text-st-ok/90',
  wip: 'text-st-warn/90',
  internal: 'text-muted-foreground',
}

export function StatusBadge({ status }: { status: LinkStatus }) {
  // Colour is never the only signal — the word is the signal, the colour is emphasis.
  return (
    <span className={`font-mono text-[0.6875rem] tracking-[0.06em] ${TONE[status]}`}>
      {LABEL[status]}
    </span>
  )
}
