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
import { defineMessages, localized, useMessages } from '@/lib/i18n'

import {
  DETAIL_GROUPS,
  STATE_META,
  detailLabel,
  detailMarkdown,
  hintFor,
  isNote,
  type Device,
  type DeviceDetail,
} from '../model'
import { COPY } from '../preflight/copy'
import { isStaleBuildError } from '../preflight/env'
import type { Lanes } from '../helper/protocol'
import type { FeatureSupport } from '../helper/update'
import type { CheckItem } from '../preflight/types'
import type { DetailState, Shot } from '../store'
import { InlineChecklist, type FixWiring } from './checklist'
import { HintCard } from './hint-card'
import { OlderHelper } from './older-helper'
import { Screenshots } from './screenshots'
import { PlatformBadge, StateDot } from './status'

/** What the functions and the tab boundary below say, worded when they run. */
const DETAIL_TEXT = localized({
  en: {
    adbServer: 'Google’s adb server',
    devicectl: 'Xcode’s devicectl',
    notReady: 'The device is not ready',
    noScreenshots: 'Screenshots are unavailable for this device — see the note above.',
    takeVia: (via: string) => `Take a screenshot (S) · through ${via}`,
    take: 'Take a screenshot (S)',
    updated: 'Device Lab was updated',
    tabFailed: (tab: string) => `The ${tab} tab didn’t load`,
    reloadToRetry: (reason: string) => `${reason}. Reload the page to try again.`,
    unknownError: 'Unknown error',
    reload: 'Reload',
  },
  vi: {
    adbServer: 'adb server của Google',
    devicectl: 'devicectl của Xcode',
    notReady: 'Thiết bị chưa sẵn sàng',
    noScreenshots: 'Không chụp được màn hình thiết bị này — xem ghi chú ở trên.',
    takeVia: (via: string) => `Chụp màn hình (S) · qua ${via}`,
    take: 'Chụp màn hình (S)',
    updated: 'Device Lab đã được cập nhật',
    tabFailed: (tab: string) => `Không tải được thẻ ${tab}`,
    reloadToRetry: (reason: string) => `${reason}. Hãy tải lại trang để thử lại.`,
    unknownError: 'Lỗi không xác định',
    reload: 'Tải lại',
  },
})

const DEVICE_DETAIL_MESSAGES = defineMessages({
  en: {
    note: 'Note',
    copy: (label: string) => `Copy ${label}`,
    tabs: { overview: 'Overview', apps: 'Apps', images: 'Images' },
    loadingTab: (tab: string) => `Loading ${tab}`,
    gone: 'That device disconnected',
    goneDetail: (id: ReactNode) => (
      <>
        {id} is no longer connected. Plug it back in, or reconnect it over Wi‑Fi, and it will
        reappear in the list.
      </>
    ),
    select: 'Select a device to see its identifiers and take screenshots.',
    region: 'Device detail',
    identifiersLater: 'Identifiers appear once the device is ready.',
    readFailed: (name: string) => `Could not read details from ${name}`,
    retry: 'Retry',
    loadingDetails: 'Loading details',
    takeScreenshot: 'Take Screenshot',
    copiedMarkdown: 'Copied as Markdown',
    pasteIntoTicket: 'Paste it straight into the ticket.',
    copyFailed: 'Copy failed',
    clipboardBlocked: 'Your browser blocked clipboard access.',
    copyMarkdown: 'Copy all as Markdown',
    sections: (name: string) => `${name} sections`,
  },
  vi: {
    note: 'Ghi chú',
    copy: (label: string) => `Sao chép ${label}`,
    tabs: { overview: 'Tổng quan', apps: 'Ứng dụng', images: 'Ảnh' },
    loadingTab: (tab: string) => `Đang tải thẻ ${tab}`,
    gone: 'Thiết bị đó đã ngắt kết nối',
    goneDetail: (id: ReactNode) => (
      <>
        {id} không còn kết nối. Hãy cắm lại hoặc kết nối lại qua Wi‑Fi để thiết bị hiện lại trong
        danh sách.
      </>
    ),
    select: 'Chọn một thiết bị để xem thông tin định danh và chụp màn hình.',
    region: 'Chi tiết thiết bị',
    identifiersLater: 'Thông tin định danh sẽ hiện khi thiết bị sẵn sàng.',
    readFailed: (name: string) => `Không đọc được thông tin chi tiết từ ${name}`,
    retry: 'Thử lại',
    loadingDetails: 'Đang tải thông tin chi tiết',
    takeScreenshot: 'Chụp màn hình',
    copiedMarkdown: 'Đã sao chép dạng Markdown',
    pasteIntoTicket: 'Dán thẳng vào ticket.',
    copyFailed: 'Không sao chép được',
    clipboardBlocked: 'Trình duyệt đã chặn quyền truy cập bộ nhớ tạm.',
    copyMarkdown: 'Sao chép tất cả dạng Markdown',
    sections: (name: string) => `Các mục của ${name}`,
  },
})

/** One group of identifiers: label, value, and Copy — the values are what testers paste into tickets. */
function DetailGroup({ title, fields }: { title: string; fields: Record<string, string> }) {
  const t = useMessages(DEVICE_DETAIL_MESSAGES)
  const rows = Object.entries(fields).filter(([, v]) => v)
  if (rows.length === 0) return null
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {rows.map(([key, value]) => {
            const note = isNote(key)
            // The key is Apple's or Google's English; the row shows it in the language on screen.
            const label = detailLabel(key)
            return (
              <div
                key={key}
                className="grid grid-cols-[8.5rem_1fr] items-center gap-3 py-1.5 sm:grid-cols-[10rem_1fr]"
              >
                <dt className="text-muted-foreground text-sm">{note ? t.note : label}</dt>
                {/* Device-supplied: rendered as text, never markup. The Copy button sits inside
                    the <dd>, since a <dl> group may hold only terms and descriptions. */}
                {note ? (
                  <dd className="text-muted-foreground text-xs">{value}</dd>
                ) : (
                  <dd className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere" title={value}>
                      {value}
                    </span>
                    <CopyButton text={value} label={t.copy(label)} />
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

/**
 * What takes a device's screenshots, for the Take Screenshot tooltip: the helper's tool for
 * its rows (from its lanes), the browser itself for WebUSB. Null when nothing is known.
 */
export function screenshotVia(
  device: Pick<Device, 'backend' | 'platform' | 'connection'>,
  lanes: Lanes | null,
): string | null {
  if (device.backend === 'webusb') return 'WebUSB'
  if (device.backend !== 'agent') return null
  if (device.platform === 'android') return DETAIL_TEXT.adbServer
  if (device.connection === 'simulator') return 'simctl'
  return lanes?.ios.screenshots === 'devicectl' ? DETAIL_TEXT.devicectl : null
}

/** Take Screenshot's tooltip: what it does, or why it can't. */
export function screenshotTitle(
  device: Pick<Device, 'state' | 'capabilities'>,
  via: string | null,
): string {
  if (device.state !== 'ready') return DETAIL_TEXT.notReady
  if (!device.capabilities.screenshot) {
    return DETAIL_TEXT.noScreenshots
  }
  return via ? DETAIL_TEXT.takeVia(via) : DETAIL_TEXT.take
}

/**
 * An Android device the helper reaches (over Wi‑Fi, or a phone the adb server holds) gets its
 * Apps and Images tabs and installs through the helper's adb tunnel (feature `android.adb`).
 * A helper from before it says so here, with the command that updates it, so the missing tabs
 * and Install button don't read as broken.
 */
export function AdbNote({
  device,
  support,
  port,
}: {
  device: Pick<Device, 'platform' | 'backend' | 'state'>
  /** featureSupport(status, 'android.adb'). */
  support: FeatureSupport
  /** The port this page talks to, for the update command. */
  port: number
}) {
  if (device.platform !== 'android' || device.backend !== 'agent' || device.state !== 'ready')
    return null
  if (support !== 'older') return null
  return <OlderHelper feature="android.adb" port={port} />
}

/** The detail pane's tabs. Files joins them in P2. */
export type DetailTab = 'overview' | 'apps' | 'images'

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
            {stale ? DETAIL_TEXT.updated : DETAIL_TEXT.tabFailed(this.props.name)}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {stale
              ? COPY.app.updated
              : DETAIL_TEXT.reloadToRetry(
                  failed.error instanceof Error ? failed.error.message : DETAIL_TEXT.unknownError,
                )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.location.reload()
          }}
        >
          <RotateCcw /> {DETAIL_TEXT.reload}
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
  const t = useMessages(DEVICE_DETAIL_MESSAGES)
  return (
    <TabBoundary name={name} onStale={onStale}>
      <Suspense
        fallback={
          <div className="grid gap-3" aria-label={t.loadingTab(name)}>
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
  goneAction,
  detail,
  shots,
  zoom,
  capturing,
  retrying,
  check = null,
  inline = [],
  captureVia = null,
  wiring,
  tab,
  actions,
  jobs,
  note,
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
  /** What to do about the gone device, under its words: Connect again, for a Wi‑Fi one. */
  goneAction?: ReactNode
  detail: DetailState
  shots: readonly Shot[]
  zoom: number
  capturing: boolean
  /** A Retry for this device is in flight. */
  retrying: boolean
  /** hint-card's deviceCheck(): a phone row that says more than the hint. */
  check?: CheckItem | null
  /**
   * checks.ts inlineChecks(): the helper's row for the tool this device's blocker needs
   * (Xcode, libimobiledevice), shown under the hint card. OK rows are left out.
   */
  inline?: readonly CheckItem[]
  /** screenshotVia(): what takes the screenshot, for the button's tooltip. */
  captureVia?: string | null
  /** The checklist's actions, for the hint card. */
  wiring?: FixWiring
  /** The open tab; one the device doesn't offer falls back to Overview. */
  tab: DetailTab
  /** More header buttons, after Take Screenshot (Install app). */
  actions?: ReactNode
  /** The jobs strip, under the header. */
  jobs?: ReactNode
  /** A note under the jobs: what this connection can't offer yet (AdbNote). */
  note?: ReactNode
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
  const t = useMessages(DEVICE_DETAIL_MESSAGES)
  if (!device) {
    const empty = (
      <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center text-sm">
        {goneId ? (
          <>
            <Unplug className="mb-3 size-8 opacity-70" />
            <p className="text-foreground font-medium">{t.gone}</p>
            <p className="mt-1 max-w-sm">
              {t.goneDetail(<span className="font-mono wrap-anywhere">{goneId}</span>)}
            </p>
            {goneAction && <div className="mt-4">{goneAction}</div>}
          </>
        ) : (
          <p>{t.select}</p>
        )}
      </div>
    )
    // A log that was running waits for the device here, and says so (log-sessions.ts).
    return (
      <section aria-label={t.region} className="flex min-w-0 flex-col gap-4">
        {empty}
        {goneId && log}
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
  const inlineId = `inline-check-${device.id}`
  const shown = inline.filter((item) => item.status !== 'ok')
  // A ready device that can't take screenshots: the button stays focusable, so its tooltip and
  // the note it points at can be reached by keyboard too.
  const noShots = ready && !device.capabilities.screenshot
  // The inline rows' Retry is this device's, never the checklist phone's.
  const inlineWiring: FixWiring = {
    ...wiring,
    on: { ...wiring?.on, retry: onRetry, doctor: onDoctor },
  }

  const overview = (
    <>
      {!ready ? (
        <p className="text-muted-foreground text-sm">{t.identifiersLater}</p>
      ) : detail.status === 'failed' ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
          <div className="flex-1 text-sm">
            <p className="font-medium">{t.readFailed(device.name)}</p>
            <p className="text-muted-foreground mt-0.5">{detail.message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onReloadDetail}>
            <RotateCcw /> {t.retry}
          </Button>
        </div>
      ) : loaded ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {DETAIL_GROUPS.map(([key, title]) => (
            <DetailGroup key={key} title={title} fields={loaded[key]} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2" aria-label={t.loadingDetails}>
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
          captureTitle={screenshotTitle(device, captureVia)}
          captureDescribedBy={noShots && shown.length > 0 ? inlineId : undefined}
          onCapture={onCapture}
          onZoom={onZoom}
          onClear={onClearShots}
        />
      )}
      {log}
    </>
  )

  return (
    <section aria-label={t.region} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* At least 20rem for the name before the buttons wrap below it: a Wi‑Fi device has four. */}
        <div className="flex min-w-[min(100%,20rem)] flex-1 items-center gap-2.5">
          <StateDot tone={meta.tone} className="size-2.5" />
          <h2 className="truncate text-xl font-semibold tracking-tight">{device.name}</h2>
          <PlatformBadge platform={device.platform} version={device.osVersion} />
          <span className="text-muted-foreground text-sm font-medium">{meta.label}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Busy is aria-disabled, not disabled: a control that disables itself under the
              keyboard drops focus to <body>. */}
          <Button
            disabled={!ready}
            aria-disabled={capturing || noShots || undefined}
            aria-describedby={noShots && shown.length > 0 ? inlineId : undefined}
            className="aria-disabled:opacity-50"
            title={screenshotTitle(device, captureVia)}
            onClick={() => {
              if (!capturing && !noShots) onCapture()
            }}
          >
            {capturing ? <Loader2 className="animate-spin" /> : <Camera />}
            {t.takeScreenshot}
          </Button>
          {actions}
          <Button
            variant="outline"
            disabled={!loaded}
            onClick={() => {
              if (!loaded) return
              navigator.clipboard.writeText(detailMarkdown(loaded, new Date())).then(
                () =>
                  toast.success(t.copiedMarkdown, {
                    description: t.pasteIntoTicket,
                  }),
                () =>
                  toast.error(t.copyFailed, {
                    description: t.clipboardBlocked,
                  }),
              )
            }}
          >
            <ClipboardCopy /> {t.copyMarkdown}
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

      {/* The helper's rows can carry long paths: let them break anywhere. */}
      {shown.length > 0 && (
        <InlineChecklist
          id={inlineId}
          items={shown}
          wiring={inlineWiring}
          className="wrap-anywhere"
        />
      )}

      {jobs}
      {note}

      {/* Always a Tabs, even with Overview alone, so the tree under it (the log) never remounts
          when Apps and Images come and go with the connection. */}
      <Tabs
        value={open}
        onValueChange={(value) => {
          const next = tabs.find((id) => id === value)
          if (next) onTab(next)
        }}
        className="gap-4"
      >
        {tabs.length > 1 && (
          <TabsList aria-label={t.sections(device.name)} className="w-full sm:w-fit">
            {tabs.map((id) => {
              const Icon = TAB_ICONS[id]
              return (
                <TabsTrigger key={id} value={id} className="px-3">
                  <Icon />
                  {t.tabs[id]}
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
            <LazyTab name={t.tabs.apps} onStale={onStale}>
              {apps}
            </LazyTab>
          </TabsContent>
        )}
        {tabs.includes('images') && (
          <TabsContent value="images" className="min-w-0">
            <LazyTab name={t.tabs.images} onStale={onStale}>
              {images}
            </LazyTab>
          </TabsContent>
        )}
      </Tabs>
    </section>
  )
}
