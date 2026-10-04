import { Loader2, RefreshCw, Smartphone, Tv, Wifi } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

import { deviceErrorMessage } from '../backends/backend'
import type { HelperStatus } from '../helper/connection'
import type { NearbyKind } from '../helper/protocol'
import { downloadCommand } from '../helper/status'
import { nearbyAvailability, type NearbyRow, type NearbySnapshot } from '../nearby'
import { nearbyBlockedCheck } from '../preflight/checks'
import { COPY, FIX } from '../preflight/copy'
import { Command, PathFix, RowBody, StatusWord } from './checklist'
import { TONE_SURFACE } from './status'

/*
  "On this network", under the devices: the Android TVs and phones the helper hears
  advertising debugging, not connected yet, each with one action. Connect runs the Wi‑Fi
  dialog's connect (the device asks "Allow debugging?" next); Pair… opens that dialog filled
  in. Nothing here connects by itself.

  Looks when it first shows, then every 30 s while the tab is visible (nearby.ts); Refresh looks
  again now. Without a running, paired helper it is one quiet line, not an error.
*/

/** The badge: how the device offers debugging. */
export const KIND_LABEL: Readonly<Record<NearbyKind, string>> = {
  adb: 'Network debugging',
  wireless: 'Wireless debugging',
  pairing: 'Wireless debugging',
}

/** One found device's name, address and kind, as the list and the Wi‑Fi dialog both show it. */
export function NearbySummary({ row }: { row: NearbyRow }) {
  const Icon = row.tv ? Tv : Smartphone
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2.5">
      <Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {/* Names come from the network: rendered as text, never markup. */}
        <span className="block truncate text-sm font-medium">{row.name}</span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
            {row.address}
          </span>
          <Badge variant="outline" className="font-normal">
            {KIND_LABEL[row.kind]}
          </Badge>
          {row.pairingOpen && row.action.kind === 'pair' && (
            <span className="text-muted-foreground text-xs">Pairing screen open</span>
          )}
        </span>
      </span>
    </span>
  )
}

/** The section's own heading row: title, and Refresh once it can look. */
function Heading({ id, busy, onRefresh }: { id: string; busy?: boolean; onRefresh?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <h2 id={id} className="text-muted-foreground flex-1 text-xs font-medium tracking-wide">
        On this network
      </h2>
      {onRefresh && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 aria-disabled:opacity-50"
          aria-label="Look again for devices on this network"
          title="Look again"
          // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onRefresh()
          }}
        >
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
        </Button>
      )}
    </div>
  )
}

export function NearbySection({
  status,
  snapshot,
  rows,
  connecting,
  onWatch,
  onRefresh,
  onConnect,
  onPair,
  onHelper,
}: {
  status: HelperStatus
  snapshot: NearbySnapshot
  /** nearbyRows(snapshot.devices, the listed devices): only what isn't connected yet. */
  rows: readonly NearbyRow[]
  /** The row whose connect is running now, by key. */
  connecting: string | null
  /** nearby.watch: looks while this shows. */
  onWatch: () => () => void
  onRefresh: () => Promise<void>
  onConnect: (row: NearbyRow) => void
  onPair: (row: NearbyRow) => void
  /** Where the helper is set up: started, then paired. */
  onHelper: () => void
}) {
  const headingId = useId()
  const availability = nearbyAvailability(status)
  const ready = availability === 'ready'
  const [refreshing, setRefreshing] = useState(false)
  // Spoken once a look the tester asked for ends; the quiet ones every 30 s say nothing new.
  const [announce, setAnnounce] = useState(false)

  useEffect(() => (ready ? onWatch() : undefined), [ready, onWatch])

  if (availability === 'helper') {
    return (
      <section aria-labelledby={headingId} className="space-y-1.5">
        <Heading id={headingId} />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {COPY.nearby.helperOff}{' '}
          <button
            type="button"
            onClick={onHelper}
            className="text-primary font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            Set up the helper
          </button>
        </p>
      </section>
    )
  }

  if (availability === 'old' || snapshot.state === 'unsupported') {
    return (
      <section aria-labelledby={headingId} className="space-y-2">
        <Heading id={headingId} />
        <p className="text-muted-foreground text-xs leading-relaxed">{COPY.nearby.helperOld}</p>
        <Command text={downloadCommand(status.env.port)} />
      </section>
    )
  }

  const busy = snapshot.busy || refreshing
  const refresh = () => {
    setRefreshing(true)
    setAnnounce(false)
    void onRefresh().finally(() => {
      setRefreshing(false)
      setAnnounce(true)
    })
  }
  const blocked = snapshot.state === 'blocked' ? nearbyBlockedCheck(status, snapshot.detail) : null
  const looking = snapshot.state === 'looking' || snapshot.state === 'idle'

  return (
    <section aria-labelledby={headingId} aria-busy={busy || undefined} className="space-y-2">
      <Heading id={headingId} busy={busy} onRefresh={refresh} />
      <p role="status" aria-live="polite" className="sr-only">
        {announce && !busy ? nearbyAnnouncement(snapshot, rows) : ''}
      </p>

      {blocked && (
        <div className={cn('space-y-1 rounded-xl border p-3', TONE_SURFACE.bad)}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p className="text-sm leading-6 font-medium">{blocked.label}</p>
            <StatusWord status={blocked.status} />
          </div>
          <RowBody item={blocked} />
        </div>
      )}

      {snapshot.state === 'failed' && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {snapshot.message ||
            (snapshot.code
              ? deviceErrorMessage(new Error(snapshot.code))
              : COPY.nearby.unavailable)}
        </p>
      )}

      {rows.length > 0 ? (
        <ul className="bg-card divide-y rounded-xl border">
          {rows.map((row) => {
            const running = connecting === row.key
            return (
              <li key={row.key} className="flex items-center gap-3 px-3.5 py-3">
                <NearbySummary row={row} />
                {row.action.kind === 'connect' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Connect ${row.name} (${row.address})`}
                    aria-disabled={connecting !== null || undefined}
                    className="shrink-0 aria-disabled:opacity-50"
                    onClick={() => {
                      if (connecting === null) onConnect(row)
                    }}
                  >
                    {running ? <Loader2 className="animate-spin" /> : <Wifi />}
                    {running ? 'Connecting…' : 'Connect'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Pair ${row.name} (${row.address})…`}
                    className="shrink-0"
                    onClick={() => {
                      onPair(row)
                    }}
                  >
                    Pair…
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      ) : looking ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          Looking…
        </p>
      ) : snapshot.state === 'ok' && snapshot.devices.length > 0 ? (
        // Only after a look that ran: blocked or failed, the devices here are adb's own list,
        // and the row or sentence above already says why nothing else is known.
        <p className="text-muted-foreground text-xs leading-relaxed">{COPY.nearby.allListed}</p>
      ) : (
        snapshot.state === 'ok' && (
          <div className="space-y-1.5 rounded-xl border border-dashed px-3.5 py-3">
            <p className="text-sm leading-relaxed">{COPY.nearby.empty}</p>
            <p className="text-muted-foreground text-xs leading-relaxed">{COPY.nearby.emptyStep}</p>
            <PathFix fix={FIX.tvNetworkDebugging} />
            <PathFix fix={FIX.phoneWirelessDebugging} />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {COPY.nearby.emptyOther}
            </p>
          </div>
        )
      )}
    </section>
  )
}

/** How a look ended, in one sentence for the live region. */
export function nearbyAnnouncement(snapshot: NearbySnapshot, rows: readonly NearbyRow[]): string {
  if (snapshot.state === 'blocked') return COPY.nearby.blocked
  if (snapshot.state === 'failed') return snapshot.message || COPY.nearby.unavailable
  if (rows.length > 0) return COPY.nearby.found(rows.length)
  return snapshot.devices.length > 0 ? COPY.nearby.allListed : COPY.nearby.none
}
