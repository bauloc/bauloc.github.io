import { Download, ExternalLink, Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import type { HelperStatus } from '../helper/connection'
import { HELPER_URL, NEEDS_HELPER, helperCard, type HelperActionView } from '../helper/status'
import type { Os } from '../preflight/types'
import { Command } from './checklist'
import type { HelperHandlers } from './helper-chip'
import { PlatformBadge } from './status'

/*
  The Gate's iPhone card (spec §6.8): what the local helper is, the one command that gets it,
  and the one thing to do next in the phase the helper is in. Shown while nothing is listed.
  The words come from helper/status.ts helperCard(); this file only lays them out.
*/

/**
 * The card's title, which every phase has: where focus goes when the control a keyboard user
 * was on goes away with its phase (the pair dialog closing on success, a look that ended).
 */
export const HELPER_CARD_TITLE_ID = 'helper-card-title'

/** One of the card's buttons; null when the page wired nothing to it. */
function ActionButton({
  view,
  on,
  primary,
}: {
  view: HelperActionView
  on: HelperHandlers
  primary: boolean
}) {
  const variant = primary ? 'default' : 'outline'
  if (view.href) {
    return (
      <Button asChild variant={variant}>
        <a href={view.href}>{view.label}</a>
      </Button>
    )
  }
  const run = view.action === 'open-local' ? undefined : on[view.action]
  if (!run) return null
  return (
    // aria-disabled, not disabled, while busy: disabling the focused button drops focus to <body>.
    <Button
      variant={variant}
      aria-disabled={view.busy || undefined}
      className="aria-disabled:opacity-50"
      onClick={() => {
        if (!view.busy) run()
      }}
    >
      {view.busy && <Loader2 className="animate-spin" />}
      {view.action === 'reload' && <RotateCcw />}
      {view.label}
    </Button>
  )
}

/**
 * The card's content without its frame: the phase's words, the command, the buttons. The Wi‑Fi
 * dialog shows it too, in place of its form, while the helper isn't running or paired.
 */
export function HelperCardBody({
  status,
  on,
  os,
  withoutIphoneCase = false,
}: {
  status: HelperStatus
  on: HelperHandlers
  /** The system this page runs on: the Node.js hint, and the iPhone card off macOS. */
  os?: Os
  /** Leaves out why iPhones need the helper: the Wi‑Fi dialog says why Wi‑Fi does instead. */
  withoutIphoneCase?: boolean
}) {
  const card = helperCard(status, { os, iphone: !withoutIphoneCase })
  const view = withoutIphoneCase
    ? { ...card, body: card.body.filter((text) => text !== NEEDS_HELPER) }
    : card
  // The download command fetches the file: the same file, as a link, for those who'd rather.
  const downloads = view.command?.text.startsWith(`curl -fsSL ${HELPER_URL} `) ?? false
  const looking = status.phase === 'checking'
  return (
    <>
      {view.body.map((text, i) => (
        <p
          key={text}
          className={
            i === 0 ? 'text-muted-foreground text-sm leading-relaxed' : 'text-sm leading-relaxed'
          }
        >
          {looking && i === view.body.length - 1 && (
            <Loader2
              aria-hidden="true"
              className="text-muted-foreground mr-1.5 inline size-3.5 animate-spin align-[-2px]"
            />
          )}
          {text}
        </p>
      ))}

      {view.requires && (
        <p className="text-muted-foreground text-sm leading-relaxed">{view.requires}</p>
      )}

      {view.command && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{view.command.lead}</p>
          <Command text={view.command.text} label="Copy the command" />
        </div>
      )}

      {(view.actionsLead || view.actions.length > 0 || view.links.length > 0 || downloads) && (
        <div className="space-y-2">
          {view.actionsLead && <p className="text-muted-foreground text-sm">{view.actionsLead}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {view.actions.map((action, i) => (
              <ActionButton key={action.action} view={action} on={on} primary={i === 0} />
            ))}
            {view.links.map((link) => (
              <Button key={link.href} asChild variant="link" className="h-auto px-0">
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {link.label}
                  <ExternalLink aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
            ))}
            {downloads && (
              <Button asChild variant="link" className="h-auto px-0">
                <a href={HELPER_URL} download="device-bridge.mjs">
                  <Download aria-hidden="true" />
                  Download device-bridge.mjs
                </a>
              </Button>
            )}
          </div>
        </div>
      )}

      {view.notes.map((note) => (
        <p key={note} className="text-muted-foreground text-xs leading-relaxed">
          {note}
        </p>
      ))}
    </>
  )
}

export function HelperCard({
  status,
  on,
  os,
}: {
  status: HelperStatus
  on: HelperHandlers
  os?: Os
}) {
  const view = helperCard(status, { os })
  const cardRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  // The last element focused in this card, or null once focus went elsewhere.
  const lastFocus = useRef<Element | null>(null)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null
      lastFocus.current = target && cardRef.current?.contains(target) ? target : null
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
  // A phase change took away the control focus was on (Pair, Open the helper's page…): rather
  // than leave a keyboard user on <body>, put them on the title, which says the new phase.
  useLayoutEffect(() => {
    const last = lastFocus.current
    if (!last || last.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    lastFocus.current = null
    titleRef.current?.focus()
  })
  return (
    <Card ref={cardRef}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PlatformBadge platform="ios" />
          <CardTitle
            ref={titleRef}
            id={HELPER_CARD_TITLE_ID}
            tabIndex={-1}
            className="outline-none"
          >
            {view.title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <HelperCardBody status={status} on={on} os={os} />
      </CardContent>
    </Card>
  )
}
