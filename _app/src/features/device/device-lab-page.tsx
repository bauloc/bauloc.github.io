import '@fontsource-variable/geist'

import { Activity, FlaskConical } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ThemeToggle } from '@/components/theme-toggle'
import { Toaster } from '@/components/toaster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { createMockBackend } from './backends/mock'
import { createWebUsbBackend } from './backends/webusb'
import { DeviceDetailPane } from './components/device-detail'
import { DeviceList } from './components/device-list'
import { DoctorDialog, environmentRows } from './components/doctor-dialog'
import { Gate } from './components/gate'
import { LogConsole } from './components/log-console'
import { StateDot } from './components/status'
import { readZoom, saveZoom } from './prefs'
import { createDeviceLab, useDeviceLabSnapshot, type DeviceLab } from './store'

/** `?mock=1` adds the fixture lane, as the legacy page did — demoable with no phone attached. */
function isMock(): boolean {
  return new URLSearchParams(window.location.search).get('mock') === '1'
}

function createLab(): DeviceLab {
  const lanes = [createWebUsbBackend()]
  if (isMock()) lanes.push(createMockBackend())
  return createDeviceLab(lanes)
}

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/**
 * True while focus is in a text field, where single-key shortcuts must not fire. A slider or a
 * checkbox is not one: after dragging the thumbnail size, S still takes a screenshot.
 */
function isTyping(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type)
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

/**
 * `/device/` — Device Lab: the phones plugged into this computer, their identifiers,
 * screenshots and logs. Android works straight from Chrome or Edge over WebUSB; iOS needs a
 * local helper that is not built yet. Redesigned on its port to match XConsole (shadcn/ui,
 * light and dark), with the legacy page's behaviour kept.
 */
export function DeviceLabPage() {
  const [lab] = useState(createLab)
  const snap = useDeviceLabSnapshot(lab)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [zoom, setZoom] = useState(readZoom)
  const filterRef = useRef<HTMLInputElement>(null)
  const webusb = lab.backends.some((b) => b.kind === 'webusb' && b.isAvailable())
  const mock = lab.backends.some((b) => b.kind === 'mock')

  useEffect(() => {
    void lab.start()
    return () => {
      lab.stop()
    }
  }, [lab])

  useEffect(() => {
    const previous = document.title
    document.title = 'Device Lab'
    return () => {
      document.title = previous
    }
  }, [])

  const selected = snap.devices.find((d) => d.id === snap.selectedId) ?? null
  const goneId = snap.selectedId !== null && !selected ? snap.selectedId : null
  const selectedBackend = selected
    ? lab.backends.find((b) => b.kind === selected.backend)
    : undefined

  const add = () => {
    // Must stay inside the click handler: requestDevice needs transient user activation.
    lab.requestDevice().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      if (/No device selected/i.test(message)) return
      toast.error(
        message === 'WEBUSB_UNSUPPORTED' ? 'WebUSB not available' : 'Could not open that device',
        {
          description:
            message === 'WEBUSB_UNSUPPORTED'
              ? 'Firefox and Safari do not implement WebUSB. Use Chrome or Edge.'
              : message || 'Unknown error',
        },
      )
    })
  }

  const capture = (id: string) => {
    const name = snap.devices.find((d) => d.id === id)?.name ?? id
    void lab.capture(id).then((failure) => {
      if (failure !== null) toast.error(`Screenshot of ${name} failed`, { description: failure })
    })
  }

  // The legacy shortcuts: / filter, S screenshot, R refresh. Never while typing, with a
  // modifier, or behind an open dialog — the page there is inert to the pointer too.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (doctorOpen || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
    if (isTyping()) {
      if (e.key === 'Escape' && document.activeElement instanceof HTMLElement)
        document.activeElement.blur()
      return
    }
    if (e.key === '/') {
      e.preventDefault()
      filterRef.current?.focus()
    } else if ((e.key === 's' || e.key === 'S') && selected?.state === 'ready') {
      e.preventDefault()
      capture(selected.id)
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      document.querySelector<HTMLButtonElement>('[data-device-refresh]')?.click()
    }
  })
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      onKey(e)
    }
    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
    }
  }, [])

  const usbDevices = snap.devices.filter((d) => d.backend === 'webusb')
  const usbReady = usbDevices.filter((d) => d.state === 'ready').length
  const laneTone = !webusb ? 'warn' : usbDevices.length === 0 ? 'off' : usbReady ? 'ok' : 'warn'
  const laneText = !webusb
    ? 'No WebUSB'
    : usbDevices.length === 0
      ? 'WebUSB ready'
      : `${String(usbReady)}/${String(usbDevices.length)} Android ready`

  return (
    <div data-page="device" data-shell="console" className="flex min-h-dvh flex-col">
      {/* Keyed by sequence, so a repeated message is a new node and is spoken again. */}
      <p role="status" aria-live="polite" className="sr-only">
        <span key={snap.announcement.seq}>{snap.announcement.text}</span>
      </p>

      <header className="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur">
        <a href="/" className="flex items-center gap-2.5" title="bauloc.github.io">
          <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg text-base font-bold">
            D
          </span>
          <span className="leading-tight">
            <span className="block font-semibold">Device Lab</span>
            <span className="text-muted-foreground hidden text-xs sm:block">bauloc.github.io</span>
          </span>
        </a>
        {/* Two chips, deliberately: "helper unreachable" and "helper up, zero devices" must never
            look the same (Maestro #3012 reported "0 devices" while the agent was the failure). */}
        <div className="ml-2 hidden items-center gap-2 md:flex">
          <Badge
            variant="outline"
            className="gap-1.5"
            title={
              webusb
                ? 'This browser talks to Android devices directly over USB.'
                : 'Firefox and Safari do not implement WebUSB.'
            }
          >
            <StateDot tone={laneTone} />
            {laneText}
          </Badge>
          <Badge
            variant="outline"
            className="gap-1.5"
            title="The local helper adds iOS support. Not built yet."
          >
            <StateDot tone="off" />
            Helper not detected
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {mock && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
            >
              <FlaskConical />
              Mock<span className="hidden md:inline"> devices</span>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Environment check"
            title="Environment check"
            onClick={() => {
              setDoctorOpen(true)
            }}
          >
            <Activity />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        {snap.devices.length === 0 ? (
          <Gate webusb={webusb} onAdd={add} />
        ) : (
          <div className="mx-auto grid w-full max-w-7xl items-start gap-6 lg:grid-cols-[22rem_1fr]">
            {/* At lg the list stays in view and scrolls on its own, as the legacy pane did, so
                a long list is never cut off below the fold. The padding keeps focus rings whole. */}
            <div className="lg:sticky lg:top-20 lg:-m-1 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:p-1">
              <DeviceList
                filterRef={filterRef}
                devices={snap.devices}
                selectedId={snap.selectedId}
                canAdd={webusb}
                onSelect={(id) => {
                  lab.select(id)
                }}
                onAdd={add}
                onRefresh={() => lab.refresh()}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <DeviceDetailPane
                device={selected}
                goneId={goneId}
                detail={snap.detail}
                shots={selected ? snap.shots.filter((s) => s.deviceId === selected.id) : []}
                zoom={zoom}
                capturing={snap.capturing}
                retrying={selected ? snap.retrying.includes(selected.id) : false}
                onCapture={() => {
                  if (selected) capture(selected.id)
                }}
                onRetry={() => (selected ? lab.retry(selected.id) : Promise.resolve())}
                onReloadDetail={() => {
                  lab.reloadDetail()
                }}
                onDoctor={() => {
                  setDoctorOpen(true)
                }}
                onZoom={(z) => {
                  setZoom(z)
                  saveZoom(z)
                }}
                onClearShots={() => {
                  if (selected) lab.clearShots(selected.id)
                }}
              />
              {selected?.state === 'ready' &&
                selected.capabilities.logs &&
                selectedBackend?.logs && (
                  <LogConsole key={selected.id} device={selected} backend={selectedBackend} />
                )}
            </div>
          </div>
        )}
      </main>

      <footer className="text-muted-foreground px-4 pb-4 text-center text-xs md:px-6">
        The Android robot is reproduced from work created and shared by Google, used under CC BY
        3.0. Apple and the Apple logo are trademarks of Apple Inc.
      </footer>

      <DoctorDialog
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        rows={environmentRows({
          webusb,
          secure: window.isSecureContext,
          mock,
          devices: snap.devices.length,
        })}
      />
      <Toaster />
    </div>
  )
}
