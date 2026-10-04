import { Check, ChevronDown, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/cn'

import { bySeverity, GATE_STEPS, worst } from '../preflight/checks'
import { FIX, STATUS_META } from '../preflight/copy'
import type { CheckItem, FixAction, Os } from '../preflight/types'
import { Command, FixButton, RowBody, StatusWord, type FixWiring } from './checklist'
import { PlatformBadge, TONE_SURFACE } from './status'

/** The actions that need WebUSB: while the browser can't, they point at why. */
const USB_ACTIONS: readonly FixAction[] = ['add-device', 'find-phone']

/** The Gate's phone steps, in GATE_STEPS order; a step checks.ts didn't return is skipped. */
export function gateSteps(phone: readonly CheckItem[]): CheckItem[] {
  return GATE_STEPS.flatMap((id) => phone.filter((item) => item.id === id))
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
 * phone) right here rather than in docs.
 */
export function Gate({
  browser,
  phone,
  wiring,
  os,
}: {
  /** browserChecks(env). */
  browser: readonly CheckItem[]
  /** phoneChecks(input): the steps come from GATE_STEPS, other rows show only when not OK. */
  phone: readonly CheckItem[]
  /** `add-device` and `find-phone` above all; the steps hide an action with no handler. */
  wiring: FixWiring
  /** On Windows, a phone maker's driver is the other usual owner of the ADB interface. */
  os?: Os
}) {
  const webusb = browser.some((item) => item.id === 'browser.webusb' && item.status === 'ok')
  const browserBlocked = worst(browser) === 'blocking'
  const browserProblems = bySeverity(browser.filter((item) => item.status !== 'ok'))
  // Connection rows past the steps (who holds the phone, the system's permission) only
  // matter once something went wrong; "not checked yet" says nothing here.
  const phoneProblems = bySeverity(
    phone.filter(
      (item) =>
        !GATE_STEPS.includes(item.id) && (item.status === 'warning' || item.status === 'blocking'),
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
        {webusb ? 'Android is ready. iOS needs a helper.' : 'Device Lab'}
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

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PlatformBadge platform="ios" />
              <CardTitle>Needs the helper</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              macOS keeps the iPhone USB connection for itself, so no browser can reach it. A small
              local helper bridges the gap — it is not built yet.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" disabled>
                <Download /> Get the helper
              </Button>
              <span className="text-muted-foreground text-xs">Coming in phase 2</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground mt-6 text-xs">
        WebUSB needs Chrome, Edge or Opera · USB debugging must be on · the helper needs macOS and
        Node 18+
      </p>
    </div>
  )
}
