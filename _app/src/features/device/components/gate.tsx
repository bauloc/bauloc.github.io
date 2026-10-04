import { ChevronDown, Wifi } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/cn'

import type { Platform } from '../model'
import type { HelperPhase, HelperStatus } from '../helper/connection'
import { helperAndroid } from '../helper/status'
import { bySeverity, GATE_STEPS, gateSummary, worst } from '../preflight/checks'
import { COPY, FIX, STATUS_META } from '../preflight/copy'
import type { CheckItem, CheckStatus, Fix, FixAction, Os } from '../preflight/types'
import {
  collapseRepeats,
  Command,
  FixButton,
  joinLabels,
  RowBody,
  StatusWord,
  type ChecklistEntry,
  type FixWiring,
} from './checklist'
import { IOS_STEP_ROWS, IosSetup } from './helper-card'
import type { HelperHandlers } from './helper-chip'
import { PlatformIcon } from './platform-icon'
import { STEP_TEXT, StepBody, StepItem, StepList } from './setup-steps'
import { TONE_SURFACE } from './status'

/* ---------------------------------------------------------------- *
 * The platform choice: which one, remembered, preset
 * ---------------------------------------------------------------- */

/** The platform the Gate is about: one at a time, never both. */
export type GatePlatform = Platform

const PLATFORMS: readonly GatePlatform[] = ['android', 'ios']

/** Under the per-browser prefs key (prefs.ts), beside the screenshot zoom. */
const PREFS_KEY = 'dvc_prefs'
const PREFS_FIELD = 'gatePlatform'

function readPrefs(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}')
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The platform this browser chose last time, or null: never chosen, or storage blocked. */
export function readGatePlatform(): GatePlatform | null {
  const value = readPrefs()[PREFS_FIELD]
  return value === 'android' || value === 'ios' ? value : null
}

/** Remembers the tester's choice for the next visit. Only a choice they made is saved. */
export function saveGatePlatform(platform: GatePlatform) {
  try {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...readPrefs(), [PREFS_FIELD]: platform }),
    )
  } catch {
    // A private window, or site data blocked: the choice holds for this page view only.
  }
}

/** Phases that say the helper is in play: it runs, or is being paired. */
const HELPER_IN_PLAY: ReadonlySet<HelperPhase> = new Set(['unpaired', 'stale', 'connected'])

/**
 * The platform to show before the tester chose one. The page knows better when this browser
 * runs on an iPhone or iPad, or the helper is being set up or paired (iPhones need it): iOS.
 * A browser that talks USB with no helper in play: Android. Otherwise a Mac's browser without
 * WebUSB (Safari, Firefox) is likelier there for an iPhone, anything else for Android.
 */
export function presetPlatform({
  os,
  webusb,
  helper,
}: {
  os?: Os
  webusb: boolean
  helper: HelperStatus
}): GatePlatform {
  if (os === 'ios') return 'ios'
  // The helper serves Android over Wi-Fi too, and iPhones only from a Mac: elsewhere it says
  // nothing about which platform the tester came for.
  const mac = os === undefined || os === 'mac'
  if (mac && (HELPER_IN_PLAY.has(helper.phase) || (helper.intent && helper.phase !== 'off'))) {
    return 'ios'
  }
  if (webusb) return 'android'
  return mac ? 'ios' : 'android'
}

const CHOICES: Readonly<Record<GatePlatform, { name: string; how: string }>> = {
  android: { name: 'Android', how: 'USB, in this browser' },
  ios: { name: 'iPhone & iPad', how: 'Via a helper on a Mac' },
}

/**
 * The first choice, as two large tiles with the platform marks: a radio group, so Tab enters
 * on the chosen one and the arrow keys (Home, End too) move and choose at once. Side by side
 * at every width, so the steps start on a phone's first screen.
 */
function PlatformPicker({
  value,
  onChange,
}: {
  value: GatePlatform
  onChange: (platform: GatePlatform) => void
}) {
  const refs = useRef<Partial<Record<GatePlatform, HTMLButtonElement | null>>>({})
  const move = (e: KeyboardEvent, from: GatePlatform) => {
    const i = PLATFORMS.indexOf(from)
    const last = PLATFORMS.length - 1
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? PLATFORMS[i === last ? 0 : i + 1]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? PLATFORMS[i === 0 ? last : i - 1]
          : e.key === 'Home'
            ? PLATFORMS[0]
            : e.key === 'End'
              ? PLATFORMS[last]
              : undefined
    if (!to) return
    e.preventDefault()
    onChange(to)
    refs.current[to]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="Platform" className="grid grid-cols-2 gap-3">
      {PLATFORMS.map((platform) => {
        const checked = platform === value
        const { name, how } = CHOICES[platform]
        return (
          <button
            key={platform}
            ref={(el) => {
              refs.current[platform] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              onChange(platform)
            }}
            onKeyDown={(e) => {
              move(e, platform)
            }}
            className={cn(
              // A phone: the mark beside the name, the line under both, about 64 px tall. Wider: the
              // mark, the words, the radio mark in a row.
              'bg-card grid min-w-0 grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5 rounded-xl border p-3 text-left transition-colors sm:flex sm:gap-4 sm:p-4',
              'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
              checked ? 'border-primary ring-primary/15 ring-[3px]' : 'hover:bg-muted/50',
            )}
          >
            {/* Filled when chosen: with the radio mark, the state isn't the border alone. */}
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-md border sm:size-10 sm:rounded-lg',
                checked ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted',
              )}
            >
              <PlatformIcon platform={platform} className="size-3.5 sm:size-5" />
            </span>
            <span className="contents sm:grid sm:min-w-0 sm:flex-1 sm:gap-0.5">
              <span className="text-sm leading-5 font-semibold sm:text-base sm:leading-6">
                {name}
              </span>
              <span className="text-muted-foreground col-span-2 text-xs leading-4 sm:text-sm sm:leading-5">
                {how}
              </span>
            </span>
            {/* The radio's own mark, centred on the words; too wide for a phone's two tiles. */}
            <span
              aria-hidden="true"
              className={cn(
                'hidden size-4 shrink-0 place-items-center rounded-full border sm:grid',
                checked ? 'border-primary' : 'border-input',
              )}
            >
              {checked && <span className="bg-primary size-2 rounded-full" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * Android
 * ---------------------------------------------------------------- */

/** The actions that need WebUSB: while the browser can't, they point at why. */
const USB_ACTIONS: readonly FixAction[] = ['add-device', 'find-phone']

/** The Gate's phone steps, in GATE_STEPS order; a step checks.ts didn't return is skipped. */
export function gateSteps(phone: readonly CheckItem[]): CheckItem[] {
  return GATE_STEPS.flatMap((id) => phone.filter((item) => item.id === id))
}

const STEP_IDS: ReadonlySet<string> = new Set(GATE_STEPS)

/**
 * A step's status word, kept for real problems. A warning that only says what to do next
 * ("No phone allowed yet…", "Tap Allow on the phone") is the step being current, not wrong:
 * no word, no amber.
 */
export function stepStatus(item: CheckItem): CheckStatus | undefined {
  const next =
    (item.id === 'phone.permission' && item.sentence === COPY.permission.none) ||
    (item.id === 'phone.authorized' && item.sentence === COPY.authorized.waiting)
  return next ? undefined : item.status
}

/** The checks' Re-check: the helper's tools again, and the page's own rows. */
const RECHECK = { label: 'Re-check', action: 'recheck' } as const satisfies Fix

/** Android through the helper, for a browser without WebUSB (spec §6.8), above the steps. */
function HelperAndroid({ helper, wiring }: { helper: HelperStatus; wiring: FixWiring }) {
  const view = helperAndroid(helper)
  if (!view) return null
  const ready = !view.command && !view.startAdb && helper.lanes?.android.status === 'ok'
  return (
    <section
      aria-label="Through the local helper"
      className={cn('space-y-2 rounded-xl border p-4', TONE_SURFACE[ready ? 'ok' : 'warn'])}
    >
      <h3 className="text-sm leading-6 font-medium">Through the local helper</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{view.sentence}</p>
      {view.command && <Command text={view.command} />}
      {view.startAdb && (
        <>
          <FixButton fix={{ label: view.startAdb.label, action: 'start-adb' }} wiring={wiring} />
          <p className="text-muted-foreground text-xs leading-relaxed">{view.startAdb.note}</p>
        </>
      )}
    </section>
  )
}

/** A connection row that isn't OK, tinted by its status, above the steps. */
function Problem({ item, wiring }: { item: CheckItem; wiring: FixWiring }) {
  return (
    <div
      className={cn(
        'space-y-0.5 rounded-xl border p-4',
        TONE_SURFACE[STATUS_META[item.status].tone],
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 className="text-sm leading-6 font-medium">{item.label}</h3>
        <StatusWord status={item.status} />
      </div>
      <RowBody item={item} wiring={wiring} />
    </div>
  )
}

/**
 * Step 1, this browser: one line when it can do USB; otherwise each thing in the way, as a
 * small heading of its own and what to do about it.
 */
function BrowserStepBody({
  problems,
  wiring,
}: {
  problems: readonly CheckItem[]
  wiring: FixWiring
}) {
  if (problems.length === 0) {
    return (
      <p className={STEP_TEXT}>
        This browser can talk to Android phones over USB. Nothing to install.
      </p>
    )
  }
  return problems.map((item) => (
    <div key={item.id} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h4 className="text-sm leading-6 font-medium">{item.label}</h4>
        {/* One problem: the step's own word says it. Several: each says its own. */}
        {problems.length > 1 && <StatusWord status={item.status} />}
      </div>
      <StepBody item={item} wiring={wiring} />
    </div>
  ))
}

/** A section of the platform card below its steps, ruled off like the other ones. */
const SECTION = 'border-t pt-5'

/** The helper-only path for Android: a TV or phone on the network, in the Android card. */
function WifiSection({ onWifi }: { onWifi: () => void }) {
  return (
    <section
      aria-labelledby="gate-wifi-title"
      className={cn(SECTION, 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between')}
    >
      <div className="min-w-0 space-y-0.5">
        <h3 id="gate-wifi-title" className="text-sm leading-6 font-medium">
          Phone or TV on Wi‑Fi?
          <span className="text-muted-foreground hidden font-normal sm:inline">
            {' '}
            Through the helper
          </span>
        </h3>
        <p className="text-muted-foreground max-w-[52ch] text-sm leading-relaxed">
          {/* On a phone the tag line moves down here, rather than breaking the heading. */}
          <span className="sm:hidden">Through the helper: </span>
          An Android TV, or a phone across the room, with no cable.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onWifi} className="self-start sm:self-center">
        <Wifi /> Network device (Wi‑Fi)…
      </Button>
    </section>
  )
}

/**
 * Android's side, all numbered: this browser first, then the phone's four steps; help for the
 * most common failure (adb holding the phone) right under them rather than in docs; then the
 * helper's Wi‑Fi path.
 */
function AndroidSetup({
  browser,
  phone,
  wiring,
  os,
  helper,
  onWifi,
}: {
  browser: readonly CheckItem[]
  phone: readonly CheckItem[]
  wiring: FixWiring
  os?: Os
  helper: HelperStatus
  onWifi?: () => void
}) {
  const webusb = browser.some((item) => item.id === 'browser.webusb' && item.status === 'ok')
  const browserBlocked = worst(browser) === 'blocking'
  const browserProblems = bySeverity(browser.filter((item) => item.status !== 'ok'))
  // Connection rows past the steps (who holds the phone, the system's permission) only
  // matter once something went wrong; "not checked yet" says nothing here.
  const phoneProblems = bySeverity(
    phone.filter(
      (item) => !STEP_IDS.has(item.id) && (item.status === 'warning' || item.status === 'blocking'),
    ),
  )
  const browserId = 'gate-browser'
  const stepWiring: FixWiring = browserBlocked
    ? { ...wiring, blocked: [...(wiring.blocked ?? []), ...USB_ACTIONS], blockedBy: browserId }
    : wiring
  const findPhone = { label: 'Find my phone…', action: 'find-phone' } as const
  const steps = gateSteps(phone)
  const browserOk = browserProblems.length === 0
  // The step to do now: the first that isn't OK, this browser included.
  const current = browserOk ? steps.findIndex((item) => item.status !== 'ok') : -1

  return (
    <div className="space-y-6">
      {!webusb && <HelperAndroid helper={helper} wiring={wiring} />}

      {phoneProblems.map((item) => (
        <Problem key={item.id} item={item} wiring={stepWiring} />
      ))}

      <StepList label="Connect your phone">
        <StepItem
          n={1}
          label="This browser"
          state={browserOk ? 'done' : 'current'}
          status={browserOk ? undefined : worst(browserProblems)}
          bodyId={browserId}
        >
          <BrowserStepBody problems={browserProblems} wiring={wiring} />
        </StepItem>
        {steps.map((item, i) => (
          <StepItem
            key={item.id}
            n={i + 2}
            label={item.label}
            state={item.status === 'ok' ? 'done' : i === current ? 'current' : 'todo'}
            status={stepStatus(item)}
          >
            <StepBody item={item} wiring={stepWiring} />
          </StepItem>
        ))}
      </StepList>

      {webusb && (
        <details className={cn(SECTION, 'group text-sm')}>
          <summary className="text-primary flex w-fit cursor-pointer list-none items-center gap-1 font-medium">
            Didn’t see your phone?
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="text-muted-foreground mt-3 max-w-[65ch] space-y-3 leading-relaxed">
            {stepWiring.on?.['find-phone'] && (
              <>
                <p>
                  Not in the browser’s list at all? Find my phone… lists every USB device and says
                  what it sees, for example a phone with USB debugging off.
                </p>
                <FixButton fix={findPhone} wiring={stepWiring} />
              </>
            )}
            <p>
              In the list, but “unable to claim interface”? One program at a time can own a USB
              device, and Google’s adb server usually got there first. Quit it, then try again:
            </p>
            <Command text="adb kill-server" />
            <p>
              If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ,
              Flutter, VS Code, Unity or scrcpy. Quit that too, or use the local helper instead,
              which shares the adb server rather than fighting it.
            </p>
            {os === 'windows' && (
              <>
                <p>
                  No adb running? Then a phone maker’s USB driver probably owns the phone’s ADB
                  interface. Switch it to WinUSB:
                </p>
                <p className="text-foreground">{FIX.winUsbSwitch.path}</p>
              </>
            )}
          </div>
        </details>
      )}

      {onWifi && <WifiSection onWifi={onWifi} />}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * All checks
 * ---------------------------------------------------------------- */

/** Which platform a checklist row is about, or null for one about the helper or this Mac. */
function rowPlatform(item: CheckItem): GatePlatform | null {
  if (item.group === 'ios' || item.id.startsWith('ios.')) return 'ios'
  if (item.group === 'android' || item.id.startsWith('android.') || item.id === 'helper.adbServer')
    return 'android'
  return null
}

/**
 * The rows the chosen platform's checks list: its own and the shared ones, less what the steps
 * already say (on the iPhone side, every row its steps cover) and rows not checked yet, which
 * say nothing a tester can act on here.
 */
export function platformChecklist(
  items: readonly CheckItem[],
  platform: GatePlatform,
): CheckItem[] {
  return items.filter((item) => {
    if (item.status === 'unchecked') return false
    if (platform === 'ios' && IOS_STEP_ROWS.includes(item.id)) return false
    const own = rowPlatform(item)
    return own === null || own === platform
  })
}

/** One line of the checks, as in the Environment check. */
function ChecklistLine({ entry, wiring }: { entry: ChecklistEntry; wiring: FixWiring }) {
  return (
    <li className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[5.5rem_1fr]">
      <StatusWord status={entry.item.status} className="h-5" />
      <div className="min-w-0 space-y-0.5 wrap-anywhere">
        <p className="text-sm leading-5 font-medium">{joinLabels(entry.labels)}</p>
        <RowBody item={entry.item} wiring={wiring} />
      </div>
    </li>
  )
}

/**
 * The helper's rows and this Mac's tools that matter for the chosen platform (spec §12d), at
 * the foot of the platform card behind one line. It opens by itself when a row needs attention.
 */
function AllChecks({ items, wiring }: { items: readonly CheckItem[]; wiring: FixWiring }) {
  const attention = items.some((item) => item.status === 'warning' || item.status === 'blocking')
  return (
    <details className={cn(SECTION, 'group text-sm')} open={attention || undefined}>
      <summary className="flex w-fit cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-primary inline-flex items-center gap-1 font-medium">
          All checks ({items.length})
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </span>
        <span className="text-muted-foreground">{gateSummary(items)}</span>
      </summary>
      <div className="mt-3 space-y-3">
        <ul aria-label="All checks" className="divide-y rounded-lg border">
          {collapseRepeats(items).map((entry) => (
            <ChecklistLine key={entry.key} entry={entry} wiring={wiring} />
          ))}
        </ul>
        {wiring.on?.recheck && <FixButton fix={RECHECK} wiring={wiring} />}
      </div>
    </details>
  )
}

/* ---------------------------------------------------------------- *
 * The Gate
 * ---------------------------------------------------------------- */

const HEADLINES: Readonly<Record<GatePlatform, { title: string; promise: string }>> = {
  android: {
    title: 'Set up Android over USB',
    promise: 'Plug a phone into this computer and this browser talks to it directly.',
  },
  ios: {
    title: 'Set up iPhone through the helper',
    promise: 'A small helper on this Mac connects your iPhone.',
  },
}

/**
 * The zero state — the PRIMARY screen, not an error page: most visitors arrive with nothing
 * connected. First the choice, Android or iPhone & iPad; then one card for the chosen platform
 * alone: its headline and promise, its setup as numbered steps with their status, its help and
 * (for Android) the helper's Wi‑Fi path, and its checks. Nothing of the other platform shows
 * but the choice itself.
 */
export function Gate({
  browser,
  phone,
  wiring,
  os,
  helper,
  helperOn = {},
  checklist = [],
  onWifi,
  choice,
  onChoose,
}: {
  /** browserChecks(env). */
  browser: readonly CheckItem[]
  /** phoneChecks(input): the steps come from GATE_STEPS, other rows show only when not OK. */
  phone: readonly CheckItem[]
  /**
   * `add-device` and `find-phone` above all; the steps hide an action with no handler. The
   * checks' rows use it too (`connect-helper`, `pair-helper`, `start-adb`, `recheck`).
   */
  wiring: FixWiring
  /**
   * On Windows, a phone maker's driver is the other usual owner of the ADB interface. Off macOS
   * the iPhone side says iPhones need a Mac; the Node.js hint is worded per system.
   */
  os?: Os
  /** The local helper, as HelperConnection reports it. */
  helper: HelperStatus
  /** The iPhone side's buttons: connect, pair, the Environment check, reload. */
  helperOn?: HelperHandlers
  /** gateChecks(…): the helper's rows and this Mac's tools. Empty: no checks section. */
  checklist?: readonly CheckItem[]
  /** Opens "Network device (Wi‑Fi)…": a TV or phone across the room, through the helper. */
  onWifi?: () => void
  /**
   * The platform the tester chose (remembered by the page), or null for none yet: the Gate
   * presets one then. Leave it out to let the Gate keep the choice itself.
   */
  choice?: GatePlatform | null
  /** The tester chose a platform: the page remembers it. */
  onChoose?: (platform: GatePlatform) => void
}) {
  const [own, setOwn] = useState<GatePlatform | null>(null)
  const chosen = choice === undefined ? own : choice
  const webusb = browser.some((item) => item.id === 'browser.webusb' && item.status === 'ok')
  // Decided once per visit: the helper changing phase mid-visit (a Connect on the Android side,
  // for its Wi-Fi path) must not flip the page to the other platform.
  const [preset] = useState(() => presetPlatform({ os, webusb, helper }))
  const platform = chosen ?? preset
  const choose = (next: GatePlatform) => {
    setOwn(next)
    onChoose?.(next)
  }
  const { title, promise } = HEADLINES[platform]
  const items = platformChecklist(checklist, platform)

  return (
    <div className="mx-auto w-full max-w-3xl py-6 md:py-8">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Connect a device</h1>
      <p className="text-muted-foreground mt-3 max-w-[65ch] text-base leading-relaxed">
        Identifiers, screenshots and logs for the phones plugged into this computer. Everything runs
        locally — nothing about your devices is uploaded anywhere.
      </p>

      <div className="mt-8">
        <PlatformPicker value={platform} onChange={choose} />
      </div>

      <Card aria-labelledby="gate-platform-title" role="region" className="mt-6 gap-6 py-6">
        <CardHeader className="gap-1 px-5 sm:px-6">
          <h2 id="gate-platform-title" className="text-xl leading-7 font-semibold tracking-tight">
            {title}
          </h2>
          <p className={STEP_TEXT}>{promise}</p>
        </CardHeader>
        <CardContent className="space-y-6 px-5 sm:px-6">
          {platform === 'android' ? (
            <AndroidSetup
              browser={browser}
              phone={phone}
              wiring={wiring}
              os={os}
              helper={helper}
              onWifi={
                onWifi &&
                (() => {
                  // Taking Android's Wi-Fi path is choosing Android: remembered, so pairing the
                  // helper for it never sends the next visit to the iPhone side.
                  choose('android')
                  onWifi()
                })
              }
            />
          ) : (
            <IosSetup status={helper} on={helperOn} os={os} checklist={checklist} wiring={wiring} />
          )}
          {items.length > 0 && <AllChecks items={items} wiring={wiring} />}
        </CardContent>
      </Card>
    </div>
  )
}
