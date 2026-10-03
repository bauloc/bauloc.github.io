import { Camera, ClipboardCopy, Loader2, RotateCcw, TriangleAlert, Unplug } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
import type { DetailState, Shot } from '../store'
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

/**
 * The selected device: what state it is in, the fix for whatever blocks it, its
 * identifiers once ready, and its screenshots.
 */
export function DeviceDetailPane({
  device,
  goneId,
  detail,
  shots,
  zoom,
  capturing,
  retrying,
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

      {hint && (
        <HintCard
          key={device.id}
          device={device}
          hint={hint}
          retrying={retrying}
          onRetry={onRetry}
          onDoctor={onDoctor}
        />
      )}

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

      {ready && <Screenshots shots={shots} zoom={zoom} onZoom={onZoom} onClear={onClearShots} />}
    </section>
  )
}
