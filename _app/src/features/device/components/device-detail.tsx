import {
  AppWindow,
  Camera,
  ClipboardCopy,
  Images,
  LayoutList,
  Loader2,
  RotateCcw,
  TriangleAlert,
  Unplug,
} from 'lucide-react'
import { Component, Suspense, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'

import {
  DETAIL_GROUPS,
  STATE_META,
  detailMarkdown,
  hintFor,
  isNote,
  type Device,
  type DeviceDetail,
} from '../model'
import { COPY } from '../preflight/copy'
import { isStaleBuildError } from '../preflight/env'
import type { CheckItem } from '../preflight/types'
import type { DetailState, Shot } from '../store'
import type { FixWiring } from './checklist'
import { HintCard } from './hint-card'
import { Screenshots } from './screenshots'
import { PlatformBadge, StateDot } from './status'

/** One group of identifiers: label, value, and Copy — the values are what testers paste into tickets. */
function DetailGroup({ title, fields }: { title: string; fields: Record<string, string> }) {
  const rows = Object.entries(fields).filter(([, v]) => v)
  if (rows.length === 0) return null
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {rows.map(([label, value]) => {
            const note = isNote(label)
            return (
              <div
                key={label}
                className="grid grid-cols-[8.5rem_1fr] items-center gap-3 py-1.5 sm:grid-cols-[10rem_1fr]"
              >
                <dt className="text-muted-foreground text-sm">{note ? 'Note' : label}</dt>
                {/* Device-supplied: rendered as text, never markup. The Copy button sits inside
                    the <dd>, since a <dl> group may hold only terms and descriptions. */}
                {note ? (
                  <dd className="text-muted-foreground text-xs">{value}</dd>
                ) : (
                  <dd className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere" title={value}>
                      {value}
                    </span>
                    <CopyButton text={value} label={`Copy ${label}`} />
                  </dd>
                )}
              </div>
            )
          })}
        </dl>
      </CardContent>
    </Card>
  )
}

/** The detail pane's tabs. Files joins them in P2. */
export type DetailTab = 'overview' | 'apps' | 'images'

const TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  overview: 'Overview',
  apps: 'Apps',
  images: 'Images',
}

const TAB_ICONS: Readonly<Record<DetailTab, typeof LayoutList>> = {
  overview: LayoutList,
  apps: AppWindow,
  images: Images,
}

/**
 * The tabs a device offers: Overview always; Apps and Images while it is connected and its
 * lane can read them.
 */
export function detailTabs(device: Pick<Device, 'capabilities' | 'state'>): DetailTab[] {
  const tabs: DetailTab[] = ['overview']
  if (device.state !== 'ready' && device.state !== 'busy') return tabs
  if (device.capabilities.apps) tabs.push('apps')
  if (device.capabilities.images) tabs.push('images')
  return tabs
}

/** With Overview alone there is no tab list, so its panel drops the tab panel semantics. */
const PLAIN_PANEL = { role: undefined, 'aria-labelledby': undefined, tabIndex: undefined }

/**
 * Catches a tab that failed to load. Its code is a lazy chunk, and `npm run publish` replaces
 * /assets/ wholesale, so a tab opened before a deploy asks for a chunk that is gone: that case
 * says Device Lab was updated, and both offer Reload — a failed lazy import is not retried.
 */
class TabBoundary extends Component<
  { name: string; onStale?: () => void; children: ReactNode },
  { failed: { error: unknown } | null }
> {
  override state: { failed: { error: unknown } | null } = { failed: null }

  static getDerivedStateFromError(error: unknown) {
    return { failed: { error } }
  }

  override componentDidCatch(error: unknown) {
    if (isStaleBuildError(error)) this.props.onStale?.()
  }

  override render() {
    const { failed } = this.state
    if (!failed) return this.props.children
    const stale = isStaleBuildError(failed.error)
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
        <div className="flex-1 text-sm">
          <p className="font-medium">
            {stale ? 'Device Lab was updated' : `The ${this.props.name} tab didn’t load`}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {stale
              ? COPY.app.updated
              : `${failed.error instanceof Error ? failed.error.message : 'Unknown error'}. Reload the page to try again.`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.location.reload()
          }}
        >
          <RotateCcw /> Reload
        </Button>
      </div>
    )
  }
}

/** A lazy tab: a skeleton while its code loads, the boundary if it can't. */
function LazyTab({
  name,
  onStale,
  children,
}: {
  name: string
  onStale?: () => void
  children: ReactNode
}) {
  return (
    <TabBoundary name={name} onStale={onStale}>
      <Suspense
        fallback={
          <div className="grid gap-3" aria-label={`Loading ${name}`}>
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        }
      >
        {children}
      </Suspense>
    </TabBoundary>
  )
}

/**
 * The selected device: what state it is in, the fix for whatever blocks it, then its tabs —
 * Overview (identifiers, screenshots and the log), Apps and Images when the device offers
 * them. Overview stays mounted while another tab is open, so the log keeps streaming; Apps
 * and Images unmount, which stops their reads (their caches outlive them).
 */
export function DeviceDetailPane({
  device,
  goneId,
  detail,
  shots,
  zoom,
  capturing,
  retrying,
  check = null,
  wiring,
  tab,
  actions,
  jobs,
  log,
  apps,
  images,
  onTab,
  onStale,
  onCapture,
  onRetry,
  onReloadDetail,
  onDoctor,
  onZoom,
  onClearShots,
}: {
  device: Device | null
  /** The id of a selected device that has since disconnected. */
  goneId: string | null
  detail: DetailState
  shots: readonly Shot[]
  zoom: number
  capturing: boolean
  /** A Retry for this device is in flight. */
  retrying: boolean
  /** hint-card's deviceCheck(): a phone row that says more than the hint. */
  check?: CheckItem | null
  /** The checklist's actions, for the hint card. */
  wiring?: FixWiring
  /** The open tab; one the device doesn't offer falls back to Overview. */
  tab: DetailTab
  /** More header buttons, after Take Screenshot (Install app). */
  actions?: ReactNode
  /** The jobs strip, under the header. */
  jobs?: ReactNode
  /** The log console, at the end of Overview. */
  log?: ReactNode
  /** The Apps tab's content; lazy, so it loads with the tab. */
  apps?: ReactNode
  images?: ReactNode
  onTab: (tab: DetailTab) => void
  /** A tab's code is gone: Device Lab was updated under this page. */
  onStale?: () => void
  onCapture: () => void
  onRetry: () => Promise<void>
  onReloadDetail: () => void
  onDoctor: () => void
  onZoom: (zoom: number) => void
  onClearShots: () => void
}) {
  if (!device) {
    return (
      <section
        aria-label="Device detail"
        className="text-muted-foreground flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center text-sm"
      >
        {goneId ? (
          <>
            <Unplug className="mb-3 size-8 opacity-70" />
            <p className="text-foreground font-medium">That device disconnected</p>
            <p className="mt-1 max-w-sm">
              <span className="font-mono">{goneId}</span> is no longer attached. Reconnect the cable
              and it will reappear in the list.
            </p>
          </>
        ) : (
          <p>Select a device to see its identifiers and take screenshots.</p>
        )}
      </section>
    )
  }

  const meta = STATE_META[device.state]
  const ready = device.state === 'ready'
  const hint = hintFor(device)
  const loaded: DeviceDetail | null =
    detail.status === 'ready' && detail.deviceId === device.id ? detail.detail : null
  const tabs = detailTabs(device)
  const open = tabs.includes(tab) ? tab : 'overview'

  const overview = (
    <>
      {!ready ? (
        <p className="text-muted-foreground text-sm">
          Identifiers appear once the device is ready.
        </p>
      ) : detail.status === 'failed' ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
          <div className="flex-1 text-sm">
            <p className="font-medium">Could not read details from {device.name}</p>
            <p className="text-muted-foreground mt-0.5">{detail.message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onReloadDetail}>
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : loaded ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {DETAIL_GROUPS.map(([key, title]) => (
            <DetailGroup key={key} title={title} fields={loaded[key]} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2" aria-label="Loading details">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      )}

      {ready && (
        <Screenshots
          shots={shots}
          zoom={zoom}
          capturing={capturing}
          canCapture={device.capabilities.screenshot === true}
          onCapture={onCapture}
          onZoom={onZoom}
          onClear={onClearShots}
        />
      )}
      {log}
    </>
  )

  return (
    <section aria-label="Device detail" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <StateDot tone={meta.tone} className="size-2.5" />
          <h2 className="truncate text-xl font-semibold tracking-tight">{device.name}</h2>
          <PlatformBadge platform={device.platform} version={device.osVersion} />
          <span className="text-muted-foreground text-sm font-medium">{meta.label}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Busy is aria-disabled, not disabled: a control that disables itself under the
              keyboard drops focus to <body>. */}
          <Button
            disabled={!ready || !device.capabilities.screenshot}
            aria-disabled={capturing}
            className="aria-disabled:opacity-50"
            title={ready ? 'Take a screenshot (S)' : 'The device is not ready'}
            onClick={() => {
              if (!capturing) onCapture()
            }}
          >
            {capturing ? <Loader2 className="animate-spin" /> : <Camera />}
            Take Screenshot
          </Button>
          {actions}
          <Button
            variant="outline"
            disabled={!loaded}
            onClick={() => {
              if (!loaded) return
              navigator.clipboard.writeText(detailMarkdown(loaded, new Date())).then(
                () =>
                  toast.success('Copied as Markdown', {
                    description: 'Paste it straight into the ticket.',
                  }),
                () =>
                  toast.error('Copy failed', {
                    description: 'Your browser blocked clipboard access.',
                  }),
              )
            }}
          >
            <ClipboardCopy /> Copy all as Markdown
          </Button>
        </div>
      </div>

      {(hint || check) && (
        <HintCard
          key={device.id}
          device={device}
          hint={hint}
          check={check}
          retrying={retrying}
          onRetry={onRetry}
          onDoctor={onDoctor}
          wiring={wiring}
        />
      )}

      {jobs}

      {/* Always a Tabs, even with Overview alone, so the tree under it (the log) never remounts
          when Apps and Images come and go with the connection. */}
      <Tabs
        value={open}
        onValueChange={(value) => {
          const next = tabs.find((t) => t === value)
          if (next) onTab(next)
        }}
        className="gap-4"
      >
        {tabs.length > 1 && (
          <TabsList aria-label={`${device.name} sections`} className="w-full sm:w-fit">
            {tabs.map((t) => {
              const Icon = TAB_ICONS[t]
              return (
                <TabsTrigger key={t} value={t} className="px-3">
                  <Icon />
                  {TAB_LABELS[t]}
                </TabsTrigger>
              )
            })}
          </TabsList>
        )}
        {/* Kept mounted and only hidden, so the log keeps streaming behind Apps and Images. */}
        <TabsContent
          value="overview"
          forceMount
          className="flex min-w-0 flex-col gap-4 data-[state=inactive]:hidden"
          {...(tabs.length === 1 ? PLAIN_PANEL : {})}
        >
          {overview}
        </TabsContent>
        {tabs.includes('apps') && (
          <TabsContent value="apps" className="min-w-0">
            <LazyTab name="Apps" onStale={onStale}>
              {apps}
            </LazyTab>
          </TabsContent>
        )}
        {tabs.includes('images') && (
          <TabsContent value="images" className="min-w-0">
            <LazyTab name="Images" onStale={onStale}>
              {images}
            </LazyTab>
          </TabsContent>
        )}
      </Tabs>
    </section>
  )
}
