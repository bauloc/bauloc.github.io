import { Check, ChevronDown, Wifi } from 'lucide-react'

import { Button } from '@/components/ui/button'

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/cn'

import type { HelperStatus } from '../helper/connection'
import { helperAndroid } from '../helper/status'
import { bySeverity, GATE_STEPS, gateSummary, worst } from '../preflight/checks'
import { FIX, STATUS_META } from '../preflight/copy'
import type { CheckItem, Fix, FixAction, Os } from '../preflight/types'
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
import { HelperCard } from './helper-card'
import type { HelperHandlers } from './helper-chip'
import { PlatformBadge, TONE_SURFACE } from './status'

/** The actions that need WebUSB: while the browser can't, they point at why. */
const USB_ACTIONS: readonly FixAction[] = ['add-device', 'find-phone']

/** The Gate's phone steps, in GATE_STEPS order; a step checks.ts didn't return is skipped. */
export function gateSteps(phone: readonly CheckItem[]): CheckItem[] {
  return GATE_STEPS.flatMap((id) => phone.filter((item) => item.id === id))
}

const STEP_IDS: ReadonlySet<string> = new Set(GATE_STEPS)

/** The checklist card's Re-check: the helper's tools again, and the page's own rows. */
const RECHECK = { label: 'Re-check', action: 'recheck' } as const satisfies Fix

/** Android through the helper, for a browser without WebUSB (spec §6.8), above the steps. */
function HelperAndroid({ helper, wiring }: { helper: HelperStatus; wiring: FixWiring }) {
  const view = helperAndroid(helper)
  if (!view) return null
  const ready = !view.command && !view.startAdb && helper.lanes?.android.status === 'ok'
  return (
    <section
      aria-label="Through the local helper"
      className={cn('space-y-2 rounded-xl border p-3', TONE_SURFACE[ready ? 'ok' : 'warn'])}
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

/** One line of the checklist card, as in the Environment check. */
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
 * The checklist under the two cards (spec §12d): the helper's rows and this Mac's tools that
 * matter here. What needs attention is listed; what passed folds away behind one line.
 */
function ChecklistCard({ items, wiring }: { items: readonly CheckItem[]; wiring: FixWiring }) {
  const open = items.filter((item) => item.status !== 'ok')
  const passed = items.filter((item) => item.status === 'ok')
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Checklist</CardTitle>
        <CardDescription>{gateSummary(items)}</CardDescription>
        {wiring.on?.recheck && (
          <CardAction>
            <FixButton fix={RECHECK} wiring={wiring} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {open.length > 0 && (
          <ul aria-label="Needs attention" className="divide-y rounded-lg border">
            {collapseRepeats(open).map((entry) => (
              <ChecklistLine key={entry.key} entry={entry} wiring={wiring} />
            ))}
          </ul>
        )}
        {passed.length > 0 && (
          <details className="group text-sm">
            <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
              Show {passed.length} passed {passed.length === 1 ? 'check' : 'checks'}
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
            </summary>
            <ul aria-label="Passed" className="mt-3 divide-y rounded-lg border">
              {collapseRepeats(passed).map((entry) => (
                <ChecklistLine key={entry.key} entry={entry} wiring={wiring} />
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

/** One numbered step. "Not checked" is a neutral step: a number, no status word, no colour. */
function Step({ n, item, wiring }: { n: number; item: CheckItem; wiring: FixWiring }) {
  const ok = item.status === 'ok'
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-3">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-6 place-items-center rounded-full border text-xs font-semibold tabular-nums',
          TONE_SURFACE[STATUS_META[item.status].tone],
        )}
      >
        {ok ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 className="text-sm leading-6 font-medium">
            <span className="sr-only">Step {n}: </span>
            {item.label}
          </h3>
          {item.status !== 'unchecked' && <StatusWord status={item.status} />}
        </div>
        <RowBody item={item} wiring={wiring} />
      </div>
    </li>
  )
}

/** A row that isn't OK, tinted by its status, above the steps. */
function Problem({ item, wiring }: { item: CheckItem; wiring: FixWiring }) {
  return (
    <div
      className={cn(
        'space-y-0.5 rounded-xl border p-3',
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
 * The zero state — the PRIMARY screen, not an error page: most visitors arrive with nothing
 * connected. The Android card is "Before you connect": what this browser can't do comes
 * first, then the phone's four steps, then help for the most common failure (adb holding the
 * phone) right here rather than in docs. The iPhone card is the local helper's (HelperCard),
 * and once the tester wants the helper, the checklist of its rows and this Mac's tools follows.
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
}: {
  /** browserChecks(env). */
  browser: readonly CheckItem[]
  /** phoneChecks(input): the steps come from GATE_STEPS, other rows show only when not OK. */
  phone: readonly CheckItem[]
  /**
   * `add-device` and `find-phone` above all; the steps hide an action with no handler. The
   * checklist card's rows use it too (`connect-helper`, `pair-helper`, `start-adb`, `recheck`).
   */
  wiring: FixWiring
  /**
   * On Windows, a phone maker's driver is the other usual owner of the ADB interface. Off macOS
   * the iPhone card says iPhones need a Mac; the Node.js hint is worded per system.
   */
  os?: Os
  /** The local helper, as HelperConnection reports it. */
  helper: HelperStatus
  /** The iPhone card's buttons: connect, pair, the Environment check, reload. */
  helperOn?: HelperHandlers
  /** gateChecks(…): the helper's rows and this Mac's tools. Empty: no checklist card. */
  checklist?: readonly CheckItem[]
  /** Opens "Network device (Wi‑Fi)…": a TV or phone across the room, through the helper. */
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

  return (
    <div className="mx-auto w-full max-w-4xl py-6 md:py-12">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
        {helper.phase === 'connected'
          ? 'Plug in a phone.'
          : webusb
            ? 'Android is ready. iOS needs a helper.'
            : 'Device Lab'}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
        Identifiers, screenshots and logs for the phones plugged into this computer. Everything runs
        locally — nothing about your devices is uploaded anywhere.
      </p>

      <div className="mt-8 grid items-start gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PlatformBadge platform="android" />
              <CardTitle>Before you connect</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!webusb && <HelperAndroid helper={helper} wiring={wiring} />}

            {browserProblems.length > 0 ? (
              <section id={browserId} aria-label="This browser" className="space-y-3">
                {browserProblems.map((item) => (
                  <Problem key={item.id} item={item} wiring={wiring} />
                ))}
              </section>
            ) : (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <StatusWord status="ok" />
                <span className="text-muted-foreground">
                  This browser can talk to Android phones over USB. Nothing to install.
                </span>
              </p>
            )}

            {phoneProblems.map((item) => (
              <Problem key={item.id} item={item} wiring={stepWiring} />
            ))}

            <ol aria-label="Connect your phone" className="space-y-4">
              {gateSteps(phone).map((item, i) => (
                <Step key={item.id} n={i + 1} item={item} wiring={stepWiring} />
              ))}
            </ol>

            {onWifi && (
              <section aria-label="Over Wi‑Fi" className="space-y-2 border-t pt-4">
                <p className="text-sm leading-relaxed">
                  <span className="font-medium">A TV or phone across the room?</span>{' '}
                  <span className="text-muted-foreground">
                    Connect it over Wi‑Fi instead of a cable, through the local helper.
                  </span>
                </p>
                <Button variant="outline" size="sm" onClick={onWifi}>
                  <Wifi /> Network device (Wi‑Fi)…
                </Button>
              </section>
            )}

            {webusb && (
              <details className="group text-sm">
                <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
                  Didn’t see your phone?
                  <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="text-muted-foreground mt-3 space-y-3 leading-relaxed">
                  {stepWiring.on?.['find-phone'] && (
                    <>
                      <p>
                        Not in the browser’s list at all? Find my phone… lists every USB device and
                        says what it sees, for example a phone with USB debugging off.
                      </p>
                      <FixButton fix={findPhone} wiring={stepWiring} />
                    </>
                  )}
                  <p>
                    In the list, but “unable to claim interface”? One program at a time can own a
                    USB device, and Google’s adb server usually got there first. Quit it, then try
                    again:
                  </p>
                  <Command text="adb kill-server" />
                  <p>
                    If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ,
                    Flutter, VS Code, Unity or scrcpy. Quit that too, or use the local helper
                    instead, which shares the adb server rather than fighting it.
                  </p>
                  {os === 'windows' && (
                    <>
                      <p>
                        No adb running? Then a phone maker’s USB driver probably owns the phone’s
                        ADB interface. Switch it to WinUSB:
                      </p>
                      <p className="text-foreground">{FIX.winUsbSwitch.path}</p>
                    </>
                  )}
                </div>
              </details>
            )}
          </CardContent>
        </Card>

        <HelperCard status={helper} on={helperOn} os={os} />
      </div>

      {checklist.length > 0 && <ChecklistCard items={checklist} wiring={wiring} />}

      <p className="text-muted-foreground mt-6 text-xs">
        WebUSB needs Chrome, Edge or Opera · USB debugging must be on · the helper needs macOS and
        Node 18 or newer, plus Xcode for iOS 17+ screenshots
      </p>
    </div>
  )
}
