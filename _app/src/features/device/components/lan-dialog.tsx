import {
  Cctv,
  ChevronDown,
  CircleQuestionMark,
  Cpu,
  Ellipsis,
  Gamepad2,
  HardDrive,
  Laptop,
  Loader2,
  Network,
  Printer,
  RefreshCw,
  Router,
  Smartphone,
  Speaker,
  Tablet,
  TabletSmartphone,
  Tv,
  Watch,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'

import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/cn'

import type { HelperStatus } from '../helper/connection'
import type { LanDevice, LanResult } from '../helper/protocol'
import { CARD_SENTENCES, DEV_COMMAND, startCommand } from '../helper/status'
import {
  lanAction,
  lanAnnouncement,
  lanAvailability,
  lanNotes,
  networkName,
  shownDevices,
  type LanAction,
  type LanSnapshot,
} from '../lan'
import { LAN_COPY } from '../lan-copy'
import {
  describeLan,
  LAN_GROUP,
  serviceWords,
  type LanGroup,
  type LanKind,
  type LanView,
  type VendorLookup,
} from '../lan-kinds'
import { loadVendors } from '../lan-vendors'
import type { ListedDevice, NearbyRow } from '../nearby'
import { nearbyBlockedCheck } from '../preflight/checks'
import { Command, RowBody, StatusWord } from './checklist'
import { OlderHelper } from './older-helper'
import { TONE_SURFACE } from './status'

/*
  "Devices on this network" (feature `lan.discover`): one quiet line under "On this network",
  and the dialog it opens, which lists every device the helper finds on this computer's
  network, one row each, with what Device Lab can do with it: the same Connect and Pair… as
  "On this network", Show for one already listed, Connect over Wi‑Fi… for an Android TV or
  phone that doesn't advertise debugging yet, and for an iPhone how to bring it in.

  It looks when it opens (the helper's answer of the last 30 s comes at once) and on Refresh,
  never in the background (lan.ts). Every name in it comes from the network: text, never
  markup. Each row's header is its own disclosure button (aria-expanded/aria-controls) with the
  action button beside it, so the two never nest and Tab runs name → action → facts.
*/

/** Each kind's icon: quiet, beside the name, as the rows of "On this network" draw theirs. */
const KIND_ICON: Readonly<Record<LanKind, LucideIcon>> = {
  phone: Smartphone,
  tablet: Tablet,
  tv: Tv,
  computer: Laptop,
  printer: Printer,
  speaker: Speaker,
  router: Router,
  camera: Cctv,
  console: Gamepad2,
  watch: Watch,
  storage: HardDrive,
  iot: Cpu,
  unknown: CircleQuestionMark,
}

/* ---------------------------------------------------------------- *
 * The filter
 * ---------------------------------------------------------------- */

export type LanFilterValue = 'all' | LanGroup

const FILTERS: readonly { value: LanFilterValue; icon?: LucideIcon }[] = [
  { value: 'all' },
  { value: 'phones', icon: TabletSmartphone },
  { value: 'tvs', icon: Tv },
  { value: 'computers', icon: Laptop },
  { value: 'other', icon: Ellipsis },
]

const isFilter = (value: string): value is LanFilterValue => FILTERS.some((f) => f.value === value)

/**
 * All · Phones & tablets · TVs · Computers · Other, with their counts: the device list's
 * segmented control. On a phone the four named ones show only their icon and count; the name
 * is still each segment's (spoken, and its tooltip).
 */
export function LanFilter({
  value,
  counts,
  onChange,
}: {
  value: LanFilterValue
  counts: Readonly<Record<LanFilterValue, number>>
  onChange: (value: LanFilterValue) => void
}) {
  return (
    // A segmented control, as shadcn draws its tabs: one choice at a time, never none.
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (isFilter(next)) onChange(next)
      }}
      aria-label={LAN_COPY.filter.label}
      className="bg-muted text-foreground/75 h-9 w-full rounded-lg p-[3px]"
    >
      {FILTERS.map(({ value: item, icon: Icon }) => {
        const label = LAN_COPY.filter[item]
        return (
          <ToggleGroupItem
            key={item}
            value={item}
            aria-label={LAN_COPY.filter.item(label, counts[item])}
            title={label}
            // Radio semantics, radio behaviour: an arrow key moves focus AND chooses.
            onFocus={() => {
              onChange(item)
            }}
            // flex-auto, not the device list's flex-1: five labels of unequal length share the row.
            className={cn(
              'h-full flex-auto gap-1.5 rounded-md border border-transparent px-2 data-[spacing=0]:rounded-md',
              'hover:text-foreground hover:bg-transparent',
              'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
              'dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30',
            )}
          >
            {Icon && <Icon aria-hidden="true" />}
            <span className={Icon ? 'sr-only sm:not-sr-only' : undefined}>{label}</span>
            <span className="tabular-nums">{counts[item]}</span>
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/* ---------------------------------------------------------------- *
 * A row
 * ---------------------------------------------------------------- */

/** What a row's button does: the page's own handlers. */
export interface LanHandlers {
  /** "On this network"'s Connect: the Wi‑Fi dialog's connect. */
  readonly onConnect: (row: NearbyRow) => void
  /** "On this network"'s Pair…: the Wi‑Fi dialog, its pairing filled in. */
  readonly onPair: (row: NearbyRow) => void
  /** Connect over Wi‑Fi…: the Wi‑Fi dialog, the device's address filled in. */
  readonly onWifi: (row: NearbyRow) => void
  /** Selects a listed device, and closes the dialog. */
  readonly onShow: (id: string) => void
}

function RowAction({
  action,
  view,
  connecting,
  on,
}: {
  action: LanAction
  view: LanView
  connecting: string | null
  on: LanHandlers
}): ReactNode {
  const words = LAN_COPY.action
  switch (action.kind) {
    case 'show':
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label={words.showName(view.name)}
          onClick={() => {
            on.onShow(action.id)
          }}
        >
          {words.show}
        </Button>
      )
    case 'nearby': {
      const { row } = action
      if (row.action.kind === 'pair') {
        return (
          <Button
            size="sm"
            variant="outline"
            aria-label={words.pairName(view.name, row.address)}
            onClick={() => {
              on.onPair(row)
            }}
          >
            {words.pair}
          </Button>
        )
      }
      const running = connecting === row.key
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label={words.connectName(view.name, row.address)}
          // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
          aria-disabled={connecting !== null || undefined}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (connecting === null) on.onConnect(row)
          }}
        >
          {running ? <Loader2 className="animate-spin" /> : <Wifi />}
          {running ? words.connecting : words.connect}
        </Button>
      )
    }
    case 'wifi':
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label={words.wifiName(view.name, action.row.address)}
          onClick={() => {
            on.onWifi(action.row)
          }}
        >
          <Wifi />
          {words.wifi}
        </Button>
      )
    case 'iphone':
      // Said in the row's details: nothing to press.
      return null
  }
}

interface Fact {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
  readonly copy?: string
}

/**
 * How to bring an iPhone or iPad in, worded by the helper (the finding on lan-dialog.tsx:331):
 * off macOS it can't be reached from here at all (CARD_SENTENCES.needsMac, no command); on a Mac already
 * running with --wifi it is listed, or a cable brings it in once; otherwise a cable once, or a
 * restart with --wifi. The flag stays on one line so it survives a 375 px width.
 */
function IphoneNote({ status, helperCommand }: { status: HelperStatus; helperCommand: string }) {
  const words = LAN_COPY.action.iphone
  const offMac =
    !(status.health?.platform ?? '').startsWith('darwin') ||
    status.lanes?.ios.status === 'unavailable'
  let body: ReactNode
  if (offMac) {
    body = <p className="text-muted-foreground text-xs leading-relaxed">{CARD_SENTENCES.needsMac}</p>
  } else if (status.lanes?.ios.wifi) {
    body = <p className="text-muted-foreground text-xs leading-relaxed">{words.listed}</p>
  } else {
    body = (
      <>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {words.restart}
          <code className="whitespace-nowrap">{words.wifiFlag}</code>:
        </p>
        <Command text={`${helperCommand} ${words.wifiFlag}`} />
      </>
    )
  }
  return (
    <div role="note" className="space-y-2">
      {body}
    </div>
  )
}

/** What a row shows once opened: the iPhone note, then its facts. */
function Facts({
  device,
  view,
  action,
  helperCommand,
  status,
}: {
  device: LanDevice
  view: LanView
  action: LanAction | null
  helperCommand: string
  status: HelperStatus
}) {
  const words = LAN_COPY.facts
  const services = serviceWords(device)
  const facts: Fact[] = [
    { label: words.address, value: device.address, mono: true, copy: words.copyAddress },
    { label: words.hostnames, value: device.hostnames.join(', '), mono: true },
    { label: words.model, value: view.model ?? '' },
    { label: words.maker, value: view.maker ?? '' },
    { label: words.services, value: services.join(', ') },
    { label: words.found, value: device.found.map((source) => LAN_COPY.source[source]).join(', ') },
  ].filter((fact) => fact.value)
  return (
    <div className="mt-2 space-y-2 sm:pl-6.5">
      {action?.kind === 'iphone' && <IphoneNote status={status} helperCommand={helperCommand} />}
      <dl aria-label={words.label(view.name)} className="divide-y">
        {facts.map((fact) => (
          // items-baseline, as the Environment check's About rows do: a label sits on the first
          // line of its value, not halfway down a value that wraps to several lines.
          <div key={fact.label} className="grid grid-cols-[6rem_1fr] items-baseline gap-3 py-1.5">
            <dt className="text-muted-foreground text-sm">{fact.label}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              {/* From the network: rendered as text, never markup. */}
              <span
                className={cn('min-w-0 flex-1 text-sm wrap-anywhere', fact.mono && 'font-mono')}
              >
                {fact.value}
              </span>
              {fact.copy && <CopyButton text={fact.value} label={fact.copy} />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * One device: its kind's icon, its name, the line under it (model or maker, address, badges),
 * and its one action beside them (below them on a phone, where the details need the width).
 * The summary opens the facts.
 */
export function LanRow({
  device,
  view,
  action,
  connecting,
  helperCommand,
  status,
  on,
}: {
  device: LanDevice
  view: LanView
  action: LanAction | null
  /** The "On this network" row whose connect runs now, by key; '' for another; null: none. */
  connecting: string | null
  /** How the tester starts the helper, for the iPhone note's --wifi. */
  helperCommand: string
  /** The helper's status, for the iPhone note's wording. */
  status: HelperStatus
  on: LanHandlers
}) {
  const [open, setOpen] = useState(false)
  const factsId = useId()
  const Icon = KIND_ICON[view.kind]
  // An iPhone's is a note in its opened facts, not a button.
  const button =
    action && action.kind !== 'iphone' ? (
      <RowAction action={action} view={view} connecting={connecting} on={on} />
    ) : null
  return (
    <li className="px-3 py-2.5">
      {/* A header disclosure button, not a <summary>: its chevron sits by the name (not at an
          edge that a sibling action button shifts), and Tab runs name → action → facts in
          reading order, which a native <summary> can't offer since its facts are always inside. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? factsId : undefined}
          onClick={() => {
            setOpen((was) => !was)
          }}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-[3px]"
        >
          <Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-sm font-medium">{view.name}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'text-muted-foreground size-4 shrink-0 transition-transform',
                  open && 'rotate-180',
                )}
              />
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {view.detail && (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {view.detail}
                </span>
              )}
              <span className="text-muted-foreground font-mono text-xs">{device.address}</span>
              {view.labels.map((label) => (
                <Badge key={label} variant="outline" className="font-normal">
                  {LAN_COPY.label[label]}
                </Badge>
              ))}
            </span>
          </span>
        </button>
        {button && <div className="shrink-0 pl-6.5 sm:pl-0">{button}</div>}
      </div>
      {open && (
        <div id={factsId}>
          <Facts
            device={device}
            view={view}
            action={action}
            helperCommand={helperCommand}
            status={status}
          />
        </div>
      )}
    </li>
  )
}

/* ---------------------------------------------------------------- *
 * The dialog
 * ---------------------------------------------------------------- */

/** "11 devices on 192.168.68.0/24 · looked 5 s ago", the clock ticking while it shows. */
function Summary({ result, at }: { result: LanResult; at: number | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  const since = result.scannedAt > 0 ? result.scannedAt : (at ?? now)
  const networks = [...new Set(result.networks.map(networkName))]
  return LAN_COPY.dialog.summary(
    shownDevices(result.devices).length,
    networks,
    LAN_COPY.dialog.ago(Math.max(0, Math.round((now - since) / 1000))),
  )
}

function LoadingRows() {
  return (
    <ul aria-label={LAN_COPY.state.looking} className="divide-y rounded-lg border">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="flex items-start gap-2.5 px-3 py-2.5">
          <Skeleton className="mt-0.5 size-4 rounded" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center rounded-lg border border-dashed px-4 py-10 text-center text-sm">
      <Network aria-hidden="true" className="mb-3 size-8 opacity-60" />
      <p className="text-foreground font-medium">{title}</p>
      <p className="mt-1 max-w-sm">{body}</p>
    </div>
  )
}

const matches = (query: string, device: LanDevice, view: LanView) => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [view.name, view.detail, view.maker ?? '', device.address, ...device.hostnames].some(
    (text) => text.toLowerCase().includes(q),
  )
}

export function LanDialog({
  open,
  onOpenChange,
  inline = false,
  status,
  snapshot,
  onLook,
  onStop,
  onRefresh,
  nearby,
  listed,
  connecting,
  onHelper,
  ...on
}: {
  open: boolean
  /** The modal's close; not used inline. */
  onOpenChange?: (open: boolean) => void
  /**
   * In the page instead of over it: Scan Device's own view. It looks while it shows, as the
   * dialog does while open, and keeps Refresh; it has no Close.
   */
  inline?: boolean
  status: HelperStatus
  snapshot: LanSnapshot
  /** lan.open: looks, unless the helper answered moments ago. */
  onLook: () => void
  /** lan.close: stops waiting. */
  onStop: () => void
  onRefresh: () => Promise<void>
  /** nearbyRows(…): what advertises debugging and isn't listed, joined to a device by address. */
  nearby: readonly NearbyRow[]
  /** The page's devices, for Show. */
  listed: readonly ListedDevice[]
  /** As "On this network" has it: the row whose connect runs, '' for another, null for none. */
  connecting: string | null
  /** Where the helper is set up: started, then paired. */
  onHelper: () => void
} & LanHandlers) {
  const titleId = useId()
  const descriptionId = useId()
  const availability = lanAvailability(status)
  const ready = availability === 'ready'
  // Listed by the helper, and answered by it too: a 404 is an older helper all the same.
  const listing = ready && snapshot.state !== 'unsupported'
  const [filter, setFilter] = useState<LanFilterValue>('all')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // Armed when a look the tester asked for ends (the busy flip below), spoken by the live region.
  const [announce, setAnnounce] = useState(false)
  const [vendors, setVendors] = useState<{ lookup: VendorLookup } | null>(null)

  // Each opening starts afresh: every kind, no search, nothing said yet. Adjusted during
  // render rather than on close: the page closes it too (Show), and a Refresh can end after.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFilter('all')
      setQuery('')
      setAnnounce(false)
    }
  }

  useEffect(() => {
    if (!open || !ready) return
    onLook()
    return onStop
  }, [open, ready, onLook, onStop])

  const result = snapshot.result
  const devices = useMemo(() => shownDevices(result?.devices ?? []), [result])
  // The vendor table is its own chunk, fetched only when a device has a maker's prefix.
  const wantsVendors = open && vendors === null && devices.some((d) => d.maker !== undefined)
  useEffect(() => {
    if (!wantsVendors) return
    let live = true
    loadVendors().then(
      (lookup) => {
        if (live) setVendors({ lookup })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [wantsVendors])

  // Described once per answer (and once more when the makers arrive); the actions follow the
  // page's lists, which change on every poll.
  const described = useMemo(
    () =>
      devices.map((device) => ({
        device,
        view: describeLan(device, { vendor: vendors?.lookup ?? null }),
      })),
    [devices, vendors],
  )
  const rows = described.map(({ device, view }) => ({
    device,
    view,
    action: lanAction(device, view, nearby, listed),
  }))
  const counts: Record<LanFilterValue, number> = {
    all: rows.length,
    phones: 0,
    tvs: 0,
    computers: 0,
    other: 0,
  }
  for (const { view } of rows) counts[LAN_GROUP[view.kind]]++
  const shown = rows.filter(
    ({ device, view }) =>
      (filter === 'all' || LAN_GROUP[view.kind] === filter) && matches(query, device, view),
  )

  const busy = snapshot.busy || refreshing
  // Spoken when a look the tester asked for — by opening the list, or by Refresh — ends. A busy
  // flip catches both; an opening answered at once from the cache never flips busy, so it stays
  // silent, and so does a change the tester never asked for.
  const [wasBusy, setWasBusy] = useState(busy)
  if (busy !== wasBusy) {
    setWasBusy(busy)
    if (open) setAnnounce(!busy)
  }
  const refresh = () => {
    setRefreshing(true)
    void onRefresh().finally(() => {
      setRefreshing(false)
    })
  }
  const blocked = snapshot.state === 'blocked' ? nearbyBlockedCheck(status, snapshot.detail) : null
  const helperCommand = status.env.devOrigin ? DEV_COMMAND : startCommand(status.env.port)
  const notes = listing && result ? lanNotes(result, status.health?.platform ?? '') : []

  let body: ReactNode
  if (availability === 'helper') {
    body = (
      <p className="text-sm leading-relaxed">
        {LAN_COPY.state.helperOff}{' '}
        <button
          type="button"
          onClick={onHelper}
          className="text-primary font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          {LAN_COPY.state.setUp}
        </button>
      </p>
    )
  } else if (!listing) {
    // Older than this list: said here, where the devices would be, with the command.
    body = <OlderHelper feature="lan.discover" port={status.env.port} />
  } else {
    body = (
      <div className="space-y-3">
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
          <div className="space-y-1">
            <p className="text-sm leading-relaxed">
              {snapshot.message || LAN_COPY.state.unavailable}
            </p>
            {snapshot.detail && (
              <p className="text-muted-foreground text-xs leading-relaxed">{snapshot.detail}</p>
            )}
          </div>
        )}
        {result === null ? (
          busy || snapshot.state === 'idle' || snapshot.state === 'looking' ? (
            <LoadingRows />
          ) : null
        ) : rows.length === 0 ? (
          snapshot.state === 'ok' && (
            <EmptyState title={LAN_COPY.state.empty} body={LAN_COPY.state.emptyStep} />
          )
        ) : shown.length === 0 ? (
          <EmptyState title={LAN_COPY.state.noMatch} body={LAN_COPY.state.noMatchStep} />
        ) : (
          <ul aria-label={LAN_COPY.dialog.title} className="divide-y rounded-lg border">
            {shown.map(({ device, view, action }) => (
              <LanRow
                key={device.address}
                device={device}
                view={view}
                action={action}
                connecting={connecting}
                helperCommand={helperCommand}
                status={status}
                on={on}
              />
            ))}
          </ul>
        )}
      </div>
    )
  }

  const description =
    listing && result ? <Summary result={result} at={snapshot.at} /> : LAN_COPY.dialog.about
  const liveRegion = (
    <p role="status" aria-live="polite" className="sr-only">
      {announce && !busy && listing ? lanAnnouncement(snapshot, blocked?.sentence) : ''}
    </p>
  )
  const filters = listing && rows.length > 0 && (
    <div className="grid gap-2">
      <LanFilter value={filter} counts={counts} onChange={setFilter} />
      <Input
        type="search"
        placeholder={LAN_COPY.search.placeholder}
        aria-label={LAN_COPY.search.label}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
      />
    </div>
  )
  const noteList = notes.length > 0 && (
    <div className="col-span-2 min-w-0 space-y-1.5 sm:mr-auto sm:flex-1">
      {notes.map((note) => (
        <div key={note.text} className="space-y-1.5">
          <p className="text-muted-foreground text-xs leading-relaxed">{note.text}</p>
          {note.command && <Command text={note.command} />}
        </div>
      ))}
    </div>
  )
  const refreshButton = listing && (
    <Button
      variant="outline"
      // aria-disabled while it looks: disabling the focused button drops focus to <body>.
      aria-disabled={busy || undefined}
      className="aria-disabled:opacity-50"
      onClick={() => {
        if (!busy) refresh()
      }}
    >
      <RefreshCw className={cn(busy && 'animate-spin')} />
      {LAN_COPY.dialog.refresh}
    </Button>
  )

  if (inline) {
    // Scan Device's view: the same list, in the page; the page scrolls, so the list needs no
    // height of its own, and Refresh sits beside the title.
    return (
      <section
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="bg-card space-y-4 rounded-xl border p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-xl leading-7 font-semibold tracking-tight">
              {LAN_COPY.dialog.title}
            </h2>
            <p id={descriptionId} className="text-muted-foreground text-sm leading-relaxed">
              {description}
            </p>
          </div>
          {refreshButton}
        </div>
        {liveRegion}
        {filters}
        <div aria-busy={(listing && busy) || undefined}>{body}</div>
        {noteList}
      </section>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column within the screen's height: on a short phone the list gives way, never the
          title or the buttons. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{LAN_COPY.dialog.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {liveRegion}
        {filters}

        {/* Shorter on a phone, where the title and the buttons take more of the screen. */}
        <div
          aria-busy={(listing && busy) || undefined}
          className="-mx-6 max-h-[min(55dvh,40rem)] min-h-0 overflow-y-auto px-6 sm:max-h-[min(70dvh,40rem)]"
        >
          {body}
        </div>

        <DialogFooter className={cn(listing && 'grid grid-cols-2 sm:flex sm:items-center')}>
          {noteList}
          {refreshButton}
          <Button
            onClick={() => {
              onOpenChange?.(false)
            }}
          >
            {LAN_COPY.dialog.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
