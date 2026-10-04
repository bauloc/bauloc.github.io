import { ClipboardCopy, Loader2, RotateCcw, Unlink } from 'lucide-react'
import { useId, useRef } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

import type { HelperStatus } from '../helper/connection'
import type { DoctorReport } from '../helper/protocol'
import { clockTime } from '../helper/status'
import type { Device } from '../model'
import { checklistText, GROUP_ORDER, redactSecrets, worst } from '../preflight/checks'
import { GROUP_TITLES, STATUS_META } from '../preflight/copy'
import type { CheckItem, CheckStatus } from '../preflight/types'
import {
  collapseRepeats,
  joinLabels,
  RowBody,
  StatusWord,
  type ChecklistEntry,
  type FixWiring,
} from './checklist'

const SUMMARY_ORDER: readonly CheckStatus[] = ['blocking', 'warning', 'unchecked']

/** "2 Blocking · 1 Warning · 9 Not checked", or that everything is OK. */
export function checklistSummary(items: readonly CheckItem[]): string {
  const parts = SUMMARY_ORDER.flatMap((status) => {
    const n = items.filter((item) => item.status === status).length
    return n > 0 ? [`${String(n)} ${STATUS_META[status].label}`] : []
  })
  return parts.length > 0 ? parts.join(' · ') : 'Everything checked is OK.'
}

/* ---------------------------------------------------------------- *
 * About (spec §12d)
 * ---------------------------------------------------------------- */

/** One fact at the top of the Environment check. */
export interface AboutRow {
  readonly label: string
  readonly value: string
}

/** What the About rows read. */
export interface AboutInput {
  readonly status: HelperStatus
  readonly doctor: DoctorReport | null
  /** The build this tab runs. */
  readonly version: string
  readonly mock: boolean
  readonly devices: readonly Pick<Device, 'backend'>[]
}

/**
 * Page mode, the helper's address, this tab's build, the mock lane, what is listed, then what
 * the helper said about itself. Facts only, never the token: the fingerprint is 8 hex of its
 * hash, which is what both sides print to compare.
 */
export function aboutRows({ status, doctor, version, mock, devices }: AboutInput): AboutRow[] {
  const viaHelper = devices.filter((d) => d.backend === 'agent').length
  const rows: AboutRow[] = [
    {
      label: 'Page mode',
      value: status.env.mode === 'local' ? 'The helper’s own page' : 'Hosted',
    },
    { label: 'Helper address', value: status.env.apiBase },
    { label: 'UI version', value: version },
    { label: 'Mock devices', value: mock ? 'On' : 'Off' },
    {
      label: 'Devices seen',
      value:
        viaHelper > 0
          ? `${String(devices.length)} (${String(viaHelper)} through the helper)`
          : String(devices.length),
    },
  ]
  const { health, pairing } = status
  if (health) {
    rows.push({
      label: 'Helper',
      value: `${health.version} · protocol ${String(health.protocol)}`,
    })
  }
  if (doctor) {
    const { helper } = doctor
    const host = [`Node ${helper.node}`, `${helper.platform}-${helper.arch}`]
    if (helper.macos) host.push(`macOS ${helper.macos}`)
    rows.push(
      { label: 'Helper runs on', value: host.join(' · ') },
      { label: 'Helper started', value: clockTime(helper.startedAt) },
      { label: 'Helper options', value: helper.flags.join(' ') || 'none' },
    )
  }
  if (pairing) rows.push({ label: 'Fingerprint', value: pairing.tokenId })
  return rows
}

/**
 * "Copy as text": the About rows, then the checklist, ready to paste into a ticket. Run through
 * redactSecrets as a whole, so nothing here can ever carry the helper's token.
 */
export function environmentText(
  about: readonly AboutRow[],
  items: readonly CheckItem[],
  phoneName?: string,
): string {
  const head = about.length > 0 ? ['About', ...about.map((r) => `${r.label}: ${r.value}`)] : []
  const body = checklistText(items, phoneName)
  return redactSecrets([head.join('\n'), body].filter(Boolean).join('\n\n'))
}

/* ---------------------------------------------------------------- *
 * The dialog
 * ---------------------------------------------------------------- */

/** One line of a section: status word in a column of its own, then the label and the rest. */
function Line({ entry, wiring }: { entry: ChecklistEntry; wiring?: FixWiring }) {
  return (
    <li className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[5.5rem_1fr]">
      <StatusWord status={entry.item.status} className="h-5" />
      {/* The helper's rows can carry long paths: let them break anywhere. */}
      <div className="min-w-0 space-y-0.5 wrap-anywhere">
        <p className="text-sm leading-5 font-medium">{joinLabels(entry.labels)}</p>
        <RowBody item={entry.item} wiring={wiring} />
      </div>
    </li>
  )
}

/**
 * Every row in its section, in GROUP_ORDER: This browser · Phone: {name} · Helper · This Mac ·
 * iPhone tools · Android tools · Devices · Optional tools · Features. Each heading carries the
 * section's worst status.
 */
function Sections({
  items,
  phoneName,
  wiring,
}: {
  items: readonly CheckItem[]
  phoneName?: string
  wiring?: FixWiring
}) {
  const uid = useId()
  return (
    <div className="space-y-5">
      {GROUP_ORDER.map((group) => {
        const rows = items.filter((item) => item.group === group)
        if (rows.length === 0) return null
        const title =
          group === 'phone' && phoneName
            ? `${GROUP_TITLES.phone}: ${phoneName}`
            : GROUP_TITLES[group]
        const headingId = `${uid}-${group}`
        return (
          <section key={group} aria-labelledby={headingId} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 id={headingId} className="text-sm font-semibold">
                {title}
              </h3>
              <StatusWord status={worst(rows)} />
            </div>
            <ul className="divide-y rounded-lg border">
              {collapseRepeats(rows).map((entry) => (
                <Line key={entry.key} entry={entry} wiring={wiring} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/** "Remember on this computer", while the page is paired. */
export interface RememberControl {
  readonly on: boolean
  /** rememberNote(tokenPersistent). */
  readonly note: string
  readonly onChange: (on: boolean) => void
}

function About({
  rows,
  remember,
}: {
  rows: readonly AboutRow[]
  remember?: RememberControl | null
}) {
  const uid = useId()
  return (
    <section aria-labelledby={`${uid}-about`} className="space-y-2">
      <h3 id={`${uid}-about`} className="text-sm font-semibold">
        About
      </h3>
      <dl className="divide-y rounded-lg border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[7rem_1fr] items-baseline gap-3 px-3 py-1.5 sm:grid-cols-[10rem_1fr]"
          >
            <dt className="text-muted-foreground text-sm">{row.label}</dt>
            <dd className="min-w-0 font-mono text-sm wrap-anywhere">{row.value}</dd>
          </div>
        ))}
      </dl>
      {remember && (
        <div className="grid gap-1.5 rounded-lg border px-3 py-2.5">
          <div className="flex items-center gap-3">
            <Switch
              id={`${uid}-remember`}
              checked={remember.on}
              onCheckedChange={remember.onChange}
              aria-describedby={`${uid}-remember-note`}
            />
            <Label htmlFor={`${uid}-remember`}>Remember on this computer</Label>
          </div>
          <p id={`${uid}-remember-note`} className="text-muted-foreground text-xs leading-relaxed">
            {remember.note}
          </p>
        </div>
      )}
    </section>
  )
}

/**
 * What this page can currently do, and why — the first thing to read when something does not
 * work. The About rows, then every checklist row in its section, with "Copy as text" for a
 * ticket (never the helper's token), Re-check, and Forget pairing while the page is paired.
 */
export function DoctorDialog({
  open,
  onOpenChange,
  items,
  phoneName,
  wiring,
  about = [],
  remember = null,
  onRecheck,
  rechecking = false,
  onForget,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** browserChecks + phoneChecks + helperChecks + deviceChecks + featureChecks('summary', …). */
  items: readonly CheckItem[]
  /** The phone the rows are about, for the "Phone: Pixel 9" heading. */
  phoneName?: string
  wiring?: FixWiring
  /** aboutRows(…); none: no About section. */
  about?: readonly AboutRow[]
  remember?: RememberControl | null
  /** Checks the helper's tools and the page's own rows again. */
  onRecheck?: () => void
  rechecking?: boolean
  /** Shown only while the page is paired. */
  onForget?: () => void
}) {
  // Opened from two places with no DialogTrigger, so Radix has nowhere to return focus to:
  // remember what had it, and put it back on close instead of leaving it on <body>.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          opener.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Environment check</DialogTitle>
          <DialogDescription>
            What this page can do right now, and what to fix. {checklistSummary(items)}
          </DialogDescription>
        </DialogHeader>
        {/* Shorter on a phone, where the footer's buttons take two rows. */}
        <div className="-mx-6 max-h-[min(55dvh,40rem)] space-y-5 overflow-y-auto px-6 sm:max-h-[min(70dvh,40rem)]">
          {about.length > 0 && <About rows={about} remember={remember} />}
          <Sections items={items} phoneName={phoneName} wiring={wiring} />
        </div>
        {/* Two columns on a phone: four buttons stacked would push the list off screen. */}
        <DialogFooter className="grid grid-cols-2 sm:flex">
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(environmentText(about, items, phoneName)).then(
                () => toast.success('Copied the environment check'),
                () =>
                  toast.error('Copy failed', {
                    description: 'Your browser blocked clipboard access.',
                  }),
              )
            }}
          >
            <ClipboardCopy /> Copy as text
          </Button>
          {onForget && (
            <Button variant="outline" onClick={onForget}>
              <Unlink /> Forget pairing
            </Button>
          )}
          {onRecheck && (
            // aria-disabled while it runs: disabling the focused button drops focus to <body>.
            <Button
              variant="outline"
              aria-disabled={rechecking || undefined}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (!rechecking) onRecheck()
              }}
            >
              {rechecking ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {rechecking ? 'Checking…' : 'Re-check'}
            </Button>
          )}
          <Button
            onClick={() => {
              onOpenChange(false)
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
