import { Download, ExternalLink, Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'

import type { HelperPhase, HelperStatus } from '../helper/connection'
import {
  HELPER_URL,
  NEEDS_HELPER,
  NEEDS_MAC,
  NODE_URL,
  helperCard,
  helperChip,
  nodeHint,
  type HelperActionView,
} from '../helper/status'
import type { CheckItem, CheckStatus, Os } from '../preflight/types'
import { Command, type FixWiring } from './checklist'
import type { HelperHandlers } from './helper-chip'
import { STEP_TEXT, StepBody, StepItem, StepList, TextLink, type StepState } from './setup-steps'
import { StateDot } from './status'

/*
  The Gate's iPhone & iPad side (spec §6.8): the local helper's setup as numbered steps (get
  Node.js, start the helper, pair, plug in and Trust, Developer Mode, Xcode), with the step the
  helper's phase is at open and the others one line each. Shown while nothing is listed. Also
  the Wi‑Fi dialog's helper setup (HelperCardBody).
  The words come from helper/status.ts helperCard(); this file only lays them out.
*/

/**
 * The phase's title ("Needs the helper", "Pair this page", "Ready for iPhones"), which every
 * phase has: where focus goes when the control a keyboard user was on goes away with its phase
 * (the pair dialog closing on success, a look that ended).
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
 * The phase's words, the command, the buttons: the Wi‑Fi dialog's content, in place of its form,
 * while the helper isn't running or paired. (The Gate's iPhone steps lay the same words out as
 * a step instead: OpenStepBody below.)
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
  const view = {
    ...card,
    body: withoutIphoneCase ? card.body.filter((text) => text !== NEEDS_HELPER) : card.body,
  }
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
          {looking && i === view.body.length - 1 && <Looking />}
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
              <Button
                key={link.href}
                asChild
                variant="link"
                className="h-auto px-0 has-[>svg]:px-0"
              >
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {link.label}
                  <ExternalLink aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
            ))}
            {downloads && (
              <Button asChild variant="link" className="h-auto px-0 has-[>svg]:px-0">
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

/** The spinner before "Looking for the helper…". */
function Looking() {
  return (
    <Loader2
      aria-hidden="true"
      className="text-muted-foreground mr-1.5 inline size-3.5 animate-spin align-[-2px]"
    />
  )
}

/** What the first-run "Already running?" line starts with: the command's result, not a question. */
const OPENS_PAIRED = 'It opens this page paired.'

/**
 * The open step of the Gate's iPhone side, in the helper's words (helperCard), ordered as a
 * step reads: what it is and what the command does, how it went, the command, the links about
 * it, then the way round for a helper already running ("Already running? [Connect helper]")
 * with the browser's prompt explained right under that button.
 */
function OpenStepBody({
  status,
  on,
  os,
  intro,
}: {
  status: HelperStatus
  on: HelperHandlers
  os?: Os
  /** What the step is about, before the helper's own words. */
  intro?: string
}) {
  const card = helperCard(status, { os })
  const body = card.body.filter((text) => text !== NEEDS_HELPER)
  const lead = card.actionsLead ?? ''
  const opensPaired = lead.startsWith(OPENS_PAIRED)
  const inlineLead = opensPaired ? lead.slice(OPENS_PAIRED.length).trim() : lead
  const description = [intro, opensPaired ? OPENS_PAIRED : null].filter(Boolean).join(' ')
  // Node.js has a step of its own.
  const links = card.links.filter((link) => link.href !== NODE_URL)
  const downloads = card.command?.text.startsWith(`curl -fsSL ${HELPER_URL} `) ?? false
  const looking = status.phase === 'checking'
  // On a first run the body says how the last look went; otherwise it explains the phase.
  const feedback = FIRST_RUN.has(status.phase)
  const actions = card.actions.filter(
    (action) => action.href || (action.action !== 'open-local' && on[action.action]),
  )
  return (
    <>
      {description && <p className={STEP_TEXT}>{description}</p>}
      {body.map((text, i) => (
        <p key={text} className={feedback ? 'text-sm leading-relaxed' : STEP_TEXT}>
          {looking && i === body.length - 1 && <Looking />}
          {text}
        </p>
      ))}
      {card.command && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{card.command.lead}</p>
          <Command text={card.command.text} label="Copy the command" />
        </div>
      )}
      {(links.length > 0 || downloads) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {links.map((link) => (
            <TextLink key={link.href} href={link.href}>
              {link.label}
            </TextLink>
          ))}
          {downloads && (
            <TextLink
              href={HELPER_URL}
              download="device-bridge.mjs"
              icon={<Download aria-hidden="true" />}
            >
              Download device-bridge.mjs
            </TextLink>
          )}
        </div>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {inlineLead && <span className="text-muted-foreground text-sm">{inlineLead}</span>}
          {actions.map((action, i) => (
            <ActionButton key={action.action} view={action} on={on} primary={i === 0} />
          ))}
        </div>
      )}
      {card.notes.map((note) => (
        <p key={note} className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          {note}
        </p>
      ))}
    </>
  )
}

/**
 * The checklist rows the iPhone steps cover, so the Gate's checks leave them out: Node.js and
 * Xcode are steps 1 and 6 (from these rows); whether the browser may reach the helper, whether
 * it runs, is current and is paired are steps 2 and 3 (from its phase, which says the same).
 */
export const IOS_STEP_ROWS: readonly string[] = [
  'mac.node',
  'helper.lna',
  'helper.running',
  'helper.version',
  'helper.paired',
  'ios.xcode',
]

/** Phases in which a helper ran on this Mac, so Node.js is there. */
const RAN: ReadonlySet<HelperPhase> = new Set([
  'unpaired',
  'stale',
  'connected',
  'outdated',
  'newer',
  'lost',
])

/** The phases whose "start the helper" step needs telling what it is: nothing ran yet. */
const FIRST_RUN: ReadonlySet<HelperPhase> = new Set(['off', 'checking', 'absent', 'dismissed'])

/** How the start step stands, by phase: off and checking say nothing yet. */
const START_STATUS: Partial<Record<HelperPhase, CheckStatus>> = {
  absent: 'warning',
  dismissed: 'warning',
  denied: 'blocking',
  safari: 'warning',
  foreign: 'blocking',
  outdated: 'warning',
  newer: 'warning',
  lost: 'warning',
}

const XCODE_SENTENCE =
  'Screenshots of iOS 17 and newer need Xcode on this Mac. Identifiers and logs work without it.'

/**
 * The iPhone & iPad setup: the phase in one line (its title, which takes focus when the phase
 * takes away the control a keyboard user was on), then the six steps. Steps 3 to 6 wait on the
 * helper running and paired; Developer Mode and Xcode can be done any time after. Off macOS
 * there are no steps: no helper reaches an iPhone there, and the line says so.
 */
export function IosSetup({
  status,
  on,
  os,
  checklist = [],
  wiring,
}: {
  status: HelperStatus
  on: HelperHandlers
  /** The system this page runs on: the Node.js hint, and no steps off macOS. */
  os?: Os
  /** gateChecks(…): the steps take mac.node and ios.xcode from it when the helper has said. */
  checklist?: readonly CheckItem[]
  /** For the buttons and links of the rows the steps take from the checklist. */
  wiring?: FixWiring
}) {
  const view = helperCard(status, { os })
  const tone = helperChip(status, []).tone
  const rootRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  // The last element focused in here, or null once focus went elsewhere.
  const lastFocus = useRef<Element | null>(null)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null
      lastFocus.current = target && rootRef.current?.contains(target) ? target : null
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

  const { phase } = status
  const mac = view.body[0] !== NEEDS_MAC
  const stage =
    phase === 'connected' ? 'plug' : phase === 'unpaired' || phase === 'stale' ? 'pair' : 'start'
  const paired = stage === 'plug'
  const ran = RAN.has(phase)
  const nodeRow = checklist.find((item) => item.id === 'mac.node')
  const xcodeRow = checklist.find((item) => item.id === 'ios.xcode')
  const lane = status.lanes?.ios
  // Before pairing the later steps wait on it; the step the phase is at is current.
  const at = (s: typeof stage, done: boolean): StepState =>
    stage === s ? 'current' : done ? 'done' : 'waiting'
  const anyTime: StepState = paired ? 'todo' : 'waiting'

  return (
    <div ref={rootRef} className="space-y-6">
      <div className="flex items-center gap-2">
        <StateDot tone={tone} />
        <h3
          ref={titleRef}
          id={HELPER_CARD_TITLE_ID}
          tabIndex={-1}
          className="text-sm leading-6 font-semibold outline-none"
        >
          {view.title}
        </h3>
      </div>

      {!mac ? (
        <p className={STEP_TEXT}>{NEEDS_MAC}</p>
      ) : (
        <StepList label="Set up the helper">
          {nodeRow ? (
            <StepItem
              n={1}
              label="Node.js 18 or newer"
              state={nodeRow.status === 'ok' ? 'done' : 'current'}
              status={nodeRow.status}
            >
              <StepBody item={nodeRow} wiring={wiring} />
            </StepItem>
          ) : ran ? (
            <StepItem n={1} label="Node.js 18 or newer" state="done">
              <p className={STEP_TEXT}>Node.js runs the helper.</p>
            </StepItem>
          ) : (
            <StepItem n={1} label="Node.js 18 or newer" state="current">
              <p className={STEP_TEXT}>{nodeHint(os)}</p>
              <TextLink href={NODE_URL}>Get Node.js (LTS)</TextLink>
            </StepItem>
          )}

          <StepItem
            n={2}
            label="Download and start the helper"
            state={at('start', true)}
            status={stage === 'start' ? START_STATUS[phase] : undefined}
          >
            {stage === 'start' ? (
              <OpenStepBody
                status={status}
                on={on}
                os={os}
                intro={
                  FIRST_RUN.has(phase)
                    ? 'One file that runs with Node.js, only while its Terminal window is open.'
                    : undefined
                }
              />
            ) : (
              <p className={STEP_TEXT}>{`Running on 127.0.0.1:${String(status.env.port)}.`}</p>
            )}
          </StepItem>

          <StepItem
            n={3}
            label="Pair this page with the helper"
            state={at('pair', paired)}
            status={phase === 'stale' ? 'warning' : undefined}
          >
            {stage === 'pair' ? (
              <OpenStepBody status={status} on={on} os={os} />
            ) : (
              <p className={STEP_TEXT}>
                {paired
                  ? 'This page is paired with the helper.'
                  : 'The helper prints a link that opens this page paired, or a token to paste.'}
              </p>
            )}
          </StepItem>

          <StepItem n={4} label="Plug in the iPhone and tap Trust" state={at('plug', false)}>
            <p className={paired ? 'text-sm leading-relaxed' : STEP_TEXT}>
              Plug in an iPhone or iPad with a cable and unlock it. If it asks, tap Trust.
            </p>
          </StepItem>

          <StepItem n={5} label="Developer Mode, for screenshots" state={anyTime}>
            <p className={STEP_TEXT}>
              On iOS 16 and newer: Settings → Privacy &amp; Security → Developer Mode → On. The
              iPhone restarts; then tap Turn On.
            </p>
          </StepItem>

          {xcodeRow ? (
            <StepItem
              n={6}
              label="Xcode, for iOS 17 and newer"
              state={xcodeRow.status === 'ok' ? 'done' : anyTime}
              status={xcodeRow.status}
            >
              <StepBody item={xcodeRow} wiring={wiring} />
            </StepItem>
          ) : (
            <StepItem
              n={6}
              label="Xcode, for iOS 17 and newer"
              state={lane?.xcode === 'ready' ? 'done' : anyTime}
              status={lane?.screenshots === 'none' ? 'warning' : undefined}
            >
              <p className={STEP_TEXT}>
                {lane?.xcode === 'ready' ? 'Xcode is ready for screenshots.' : XCODE_SENTENCE}
              </p>
            </StepItem>
          )}
        </StepList>
      )}
    </div>
  )
}
