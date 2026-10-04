import { Plus, RefreshCw, Smartphone } from 'lucide-react'
import { useState, type Ref } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/cn'

import { STATE_META, deviceMatches, hintFor, type Device, type Platform } from '../model'
import { PlatformIcon } from './platform-icon'
import { PlatformBadge, StateDot } from './status'

/** One device as a row: what it is, what state it is in, and the first thing to fix. */
function DeviceRow({
  device,
  selected,
  activity,
  onSelect,
}: {
  device: Device
  selected: boolean
  /** Work running on it, in words ("Shop: Sending · 42%"). */
  activity?: string
  onSelect: () => void
}) {
  const meta = STATE_META[device.state]
  const hint = hintFor(device)
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'bg-card hover:bg-accent/50 w-full rounded-xl border p-3.5 text-left transition-colors',
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
          selected && 'border-primary ring-primary/15 ring-[3px]',
        )}
      >
        <span className="flex items-center gap-2">
          <StateDot tone={meta.tone} />
          {/* Device names are user-editable on the phone: rendered as text, never markup. */}
          <span className="min-w-0 flex-1 truncate font-semibold">{device.name}</span>
          <span className="text-muted-foreground text-xs font-medium">{meta.label}</span>
        </span>
        <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <PlatformBadge platform={device.platform} version={device.osVersion} />
          {device.connection === 'network' && <Badge variant="outline">Wi‑Fi</Badge>}
          <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
            {device.id}
          </span>
        </span>
        {hint && (
          <span
            className={cn(
              'text-muted-foreground mt-2 block border-l-2 pl-2 text-xs leading-relaxed',
              meta.tone === 'bad' ? 'border-red-500' : 'border-amber-500',
            )}
          >
            {hint.title}
          </span>
        )}
        {activity && (
          <span className="text-muted-foreground mt-2 flex min-w-0 items-center gap-1.5 text-xs">
            <StateDot tone="busy" />
            <span className="truncate">{activity}</span>
          </span>
        )}
      </button>
    </li>
  )
}

type PlatformFilter = 'all' | Platform

const PLATFORM_FILTERS: readonly { value: PlatformFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
]

const isPlatformFilter = (value: string): value is PlatformFilter =>
  PLATFORM_FILTERS.some((f) => f.value === value)

/**
 * Every connected device in one list for both platforms, with a filter (focus it with /),
 * a platform segmented control with live counts, Refresh (R) and Add device.
 */
export function DeviceList({
  devices,
  selectedId,
  canAdd,
  filterRef,
  activity,
  onSelect,
  onAdd,
  onRefresh,
}: {
  devices: readonly Device[]
  selectedId: string | null
  canAdd: boolean
  /** The filter box, for the / shortcut. */
  filterRef?: Ref<HTMLInputElement>
  /** Per device id, the work running on it: an install's phase, so it shows from any row. */
  activity?: ReadonlyMap<string, string>
  onSelect: (id: string) => void
  onAdd: () => void
  onRefresh: () => Promise<void>
}) {
  const [filter, setFilter] = useState('')
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const facets = { android: platform !== 'ios', ios: platform !== 'android' }
  const visible = devices.filter((d) => deviceMatches(d, filter, facets))
  const count = (p: PlatformFilter) =>
    p === 'all' ? devices.length : devices.filter((d) => d.platform === p).length

  return (
    <aside aria-label="Devices" className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-2">
        <Input
          ref={filterRef}
          type="search"
          placeholder="Filter devices  ( / )"
          aria-label="Filter devices"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
          }}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh devices (R)"
          title="Refresh (R)"
          data-device-refresh
          // aria-disabled, not disabled: disabling the focused button drops focus to <body>.
          aria-disabled={refreshing}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (refreshing) return
            setRefreshing(true)
            void onRefresh().finally(() => {
              setRefreshing(false)
            })
          }}
        >
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </Button>
        {canAdd && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Add a device"
            title="Add a device"
            onClick={onAdd}
          >
            <Plus />
          </Button>
        )}
      </div>

      {/* A segmented control, as shadcn draws its tabs: one choice at a time, never none. */}
      <ToggleGroup
        type="single"
        value={platform}
        onValueChange={(value) => {
          if (isPlatformFilter(value)) setPlatform(value)
        }}
        aria-label="Platform"
        className="bg-muted text-foreground/75 h-9 w-full rounded-lg p-[3px]"
      >
        {PLATFORM_FILTERS.map(({ value, label }) => (
          <ToggleGroupItem
            key={value}
            value={value}
            // Radio semantics, radio behaviour: an arrow key moves focus AND chooses, as the
            // ARIA radio group pattern expects. Radix's roving focus alone only moves focus.
            onFocus={() => {
              setPlatform(value)
            }}
            className={cn(
              'h-full flex-1 gap-1.5 rounded-md border border-transparent px-2 data-[spacing=0]:rounded-md',
              'hover:text-foreground hover:bg-transparent',
              'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm',
              'dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30',
            )}
          >
            {value !== 'all' && <PlatformIcon platform={value} />}
            {label}
            <span className="tabular-nums">{count(value)}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {visible.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {visible.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              selected={d.id === selectedId}
              activity={activity?.get(d.id)}
              onSelect={() => {
                onSelect(d.id)
              }}
            />
          ))}
        </ul>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center rounded-xl border border-dashed px-4 py-10 text-center text-sm">
          <Smartphone className="mb-3 size-8 opacity-60" />
          <p className="text-foreground font-medium">Nothing matches this filter</p>
          <p className="mt-1">Clear the filter, or choose All.</p>
        </div>
      )}
    </aside>
  )
}
