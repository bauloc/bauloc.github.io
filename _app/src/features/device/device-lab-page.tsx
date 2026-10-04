import '@fontsource-variable/geist'

import { Activity, FlaskConical } from 'lucide-react'
import { lazy, useEffect, useEffectEvent, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ThemeToggle } from '@/components/theme-toggle'
import { Toaster } from '@/components/toaster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { DEVICE_ERRORS, deviceErrorMessage, type Backend } from './backends/backend'
import { createMockBackend } from './backends/mock'
import { createWebUsbBackend } from './backends/webusb'
import type { FixWiring } from './components/checklist'
import { DeviceDetailPane, type DetailTab } from './components/device-detail'
import { DeviceList } from './components/device-list'
import { DoctorDialog } from './components/doctor-dialog'
import { Gate } from './components/gate'
import { deviceCheck } from './components/hint-card'
import {
  InstallButton,
  InstallDialog,
  InstallDropZone,
  filesFromDrop,
  type InstallActions,
} from './components/install-dialog'
import { JobsStrip, jobPhaseText } from './components/jobs-strip'
import { LogConsole } from './components/log-console'
import { StateDot } from './components/status'
import { installPhoneOf, type Device } from './model'
import { browserChecks, featureChecks, helperChecks, phoneChecks } from './preflight/checks'
import { COPY } from './preflight/copy'
import { environmentNow, onStaleBuild, readEnvironment } from './preflight/env'
import type { BrowserEnv, CheckItem, FixAction } from './preflight/types'
import { findMyPhone, scanGranted } from './preflight/usb-diagnose'
import { readZoom, saveZoom } from './prefs'
import {
  createDeviceLab,
  isJobActive,
  useDeviceLabSnapshot,
  type DeviceLab,
  type DeviceLabSnapshot,
  type Job,
} from './store'

// The tabs' code (and media.ts, the badge reader) loads with the tab, never with the page.
const AppsTab = lazy(() => import('./components/apps-tab').then((m) => ({ default: m.AppsTab })))
const ImagesTab = lazy(() =>
  import('./components/images-tab').then((m) => ({ default: m.ImagesTab })),
)

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
 * True inside an open menu, any of them: there a letter is typeahead, the menu's own way to
 * jump to an item, never the page's S, R or /.
 */
function inMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"], [role="menubar"]') !== null
}

/** How often the checklist looks at the clock while a phone waits on "Allow USB debugging?". */
const AUTHORIZING_TICK_MS = 5_000

/** The Android phone the checklist is about: the selected one, else the first listed. */
function checklistPhone(devices: readonly Device[], selected: Device | null): Device | null {
  if (selected?.platform === 'android') return selected
  return devices.find((d) => d.platform === 'android') ?? null
}

/** Why a drop or Install app can't go to this device, or null when it can. */
function installRefusal(device: Device | null, backend: Backend | undefined): string | null {
  if (!device) return 'Select a ready Android phone first, then drop the file again.'
  if (device.platform === 'ios')
    return 'Installing on iPhone and iPad needs the Device Lab helper, which isn’t built yet.'
  if (!backend?.install) return 'This connection can’t install apps.'
  if (device.state !== 'ready')
    return `${device.name} isn’t ready. Fix what its card says, then try again.`
  if (!device.capabilities.install) return DEVICE_ERRORS.INSTALL_UNSUPPORTED
  return null
}

/** A device's latest install job, running or ended and not dismissed. */
const latestInstall = (jobs: readonly Job[], deviceId: string): Job | null =>
  jobs.filter((j) => j.deviceId === deviceId && j.kind === 'install').at(-1) ?? null

/** "Installing Shop · 42%", per device with a running job, for the list's rows. */
function activityOf(jobs: readonly Job[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const job of jobs)
    if (isJobActive(job)) out.set(job.deviceId, `${job.label}: ${jobPhaseText(job)}`)
  return out
}

/** One device's install dialog: what was dropped or picked, and whether it is showing. */
interface InstallState {
  readonly files: readonly File[] | null
  readonly open: boolean
}

type Installs = Readonly<Record<string, InstallState>>

/**
 * The install dialogs whose device is still listed (the same object when all are). An unplugged
 * phone's dialog is unmounted, so its entry is forgotten too: plugging the phone back in, under
 * the same id, must never open a dialog nobody asked for.
 */
export function keepListed(installs: Installs, devices: readonly Pick<Device, 'id'>[]): Installs {
  const listed = new Set(devices.map((d) => d.id))
  const kept = Object.entries(installs).filter(([id]) => listed.has(id))
  return kept.length === Object.keys(installs).length ? installs : Object.fromEntries(kept)
}

/**
 * Opens or closes one device's dialog, keeping whatever files it has now. Applied to the current
 * state, never to one captured at render: a toast's Show runs long after that render, and newer
 * files may have been dropped since.
 */
export function withOpen(installs: Installs, deviceId: string, open: boolean): Installs {
  const current = installs[deviceId]
  if (!current && !open) return installs
  return { ...installs, [deviceId]: { files: current?.files ?? null, open } }
}

/** Whether a drag carries files from the computer (not text or a link from the page). */
export const carriesFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

/** The checklist's rows for the Environment check, in its section order. */
function doctorItems(
  env: BrowserEnv,
  phoneItems: readonly CheckItem[],
  phone: Device | null,
): CheckItem[] {
  return [
    ...browserChecks(env),
    ...phoneItems,
    ...helperChecks(null, null),
    ...featureChecks('summary', {
      phone: phone ? installPhoneOf(phone) : null,
      inflate: env.inflate,
    }),
  ]
}

/** The operations an install dialog needs, bound to one device. */
function installActions(lab: DeviceLab, backend: Backend, id: string): InstallActions {
  const notReady = () => Promise.reject(new Error('DEVICE_NOT_READY'))
  const act = async (pkg: string, action: 'launch' | 'uninstall') => {
    const failure = await lab.appAction(id, pkg, action)
    if (failure !== null) throw new Error(failure)
  }
  return {
    deviceSpec: () => backend.deviceSpec?.(id) ?? notReady(),
    installFacts: (pkg) => backend.installFacts?.(id, pkg) ?? notReady(),
    install: (plan, options) => lab.install(id, plan, options),
    openApp: (pkg) => act(pkg, 'launch'),
    uninstall: (pkg) => act(pkg, 'uninstall'),
  }
}

/**
 * `/device/` — Device Lab: the phones plugged into this computer, their identifiers,
 * screenshots and logs, and for Android their apps, images and installs. Android works
 * straight from Chrome or Edge over WebUSB; iOS needs a local helper that is not built yet.
 * Redesigned on its port to match XConsole (shadcn/ui, light and dark), with the legacy
 * page's behaviour kept.
 */
export function DeviceLabPage() {
  const [lab] = useState(createLab)
  const snap = useDeviceLabSnapshot(lab)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [zoom, setZoom] = useState(readZoom)
  const [env, setEnv] = useState(() => environmentNow())
  const [appUpdated, setAppUpdated] = useState(false)
  const [finding, setFinding] = useState(false)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [installs, setInstalls] = useState<Installs>({})
  const [now, setNow] = useState(Date.now)
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

  // The browser, read on load and again around the Environment check: a permission may have
  // changed since (the first frame used environmentNow, which can't wait for one).
  useEffect(() => {
    void readEnvironment().then(setEnv)
  }, [doctorOpen])

  // A deploy under an open tab: every later lazy chunk 404s. Say so once, with Reload. Vite
  // reports a failed preload; a tab whose chunk failed reports it through onStale.
  const staleSaid = useRef(false)
  const markStale = () => {
    if (staleSaid.current) return
    staleSaid.current = true
    setAppUpdated(true)
    toast.error('Device Lab was updated', {
      description: COPY.app.updated,
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => {
          window.location.reload()
        },
      },
    })
  }
  const onPreloadError = useEffectEvent(markStale)
  useEffect(
    () =>
      onStaleBuild(() => {
        onPreloadError()
      }),
    [],
  )

  // Adjusted during render, not in an effect: a phone unplugged and plugged back in between two
  // effects would otherwise mount its old dialog open again.
  const listedInstalls = keepListed(installs, snap.devices)
  if (listedInstalls !== installs) setInstalls(listedInstalls)

  const selected = snap.devices.find((d) => d.id === snap.selectedId) ?? null
  const goneId = snap.selectedId !== null && !selected ? snap.selectedId : null
  const backendOf = (device: Device | null) =>
    device ? lab.backends.find((b) => b.kind === device.backend) : undefined
  const selectedBackend = backendOf(selected)
  const phone = checklistPhone(snap.devices, selected)
  const authorizingSince = phone ? (snap.authorizingSince[phone.id] ?? null) : null

  // "No prompt on the phone?" turns up after 30 s of waiting, so the clock ticks meanwhile.
  useEffect(() => {
    if (authorizingSince === null) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, AUTHORIZING_TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [authorizingSince])

  // What the raw USB devices say (a phone with USB debugging off is invisible to Add device).
  // Read while the Gate shows and whenever something is plugged in or out; it never prompts.
  const gate = snap.devices.length === 0
  useEffect(() => {
    const usb = 'usb' in navigator ? navigator.usb : null
    if (!usb) return
    let live = true
    const scan = (always: boolean) => {
      scanGranted(usb).then(
        (found) => {
          // A quiet scan never clears what "Find my phone…" found; a plug event may.
          if (live && (always || found.kind !== 'unknown')) lab.setUsbFinding(found)
        },
        () => undefined,
      )
    }
    const onChange = () => {
      scan(true)
    }
    if (gate) scan(false)
    usb.addEventListener('connect', onChange)
    usb.addEventListener('disconnect', onChange)
    return () => {
      live = false
      usb.removeEventListener('connect', onChange)
      usb.removeEventListener('disconnect', onChange)
    }
  }, [lab, gate])

  const add = () => {
    // Must stay inside the click handler: requestDevice needs transient user activation.
    lab.requestDevice().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      if (
        /No device selected/i.test(message) ||
        (error instanceof Error && error.name === 'NotFoundError')
      )
        return
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

  const findPhone = () => {
    if (finding || !('usb' in navigator)) return
    setFinding(true)
    // Called straight from the click: the chooser needs the user's gesture.
    findMyPhone(navigator.usb)
      .then(async (found) => {
        lab.setUsbFinding(found)
        // Chrome fires no connect event for a raw grant, so the lane looks again itself.
        if (found.kind === 'adb') await lab.refresh()
      })
      .catch((error: unknown) => {
        toast.error('Couldn’t list the USB devices', { description: deviceErrorMessage(error) })
      })
      .finally(() => {
        setFinding(false)
      })
  }

  const capture = (id: string) => {
    const name = snap.devices.find((d) => d.id === id)?.name ?? id
    void lab.capture(id).then((failure) => {
      if (failure !== null) toast.error(`Screenshot of ${name} failed`, { description: failure })
    })
  }

  const showInstall = (deviceId: string, files?: readonly File[]) => {
    setInstalls((all) => ({
      ...all,
      [deviceId]: { files: files ?? all[deviceId]?.files ?? null, open: true },
    }))
  }

  // The legacy shortcuts: / filter, S screenshot, R refresh. Never while typing, with a
  // modifier, in a menu, or behind an open dialog — the page there is inert to the pointer too.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (doctorOpen || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
    if (inMenu(e.target) || inMenu(document.activeElement)) return
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

  const environment: BrowserEnv = appUpdated ? { ...env, appUpdated } : env
  const browserItems = browserChecks(environment)
  const phoneItems = phoneChecks({
    device: phone ? { name: phone.name, state: phone.state, blockers: phone.blockers } : null,
    picker: snap.picker,
    usb: snap.usb,
    authorizingSince,
    now,
    os: env.os,
    browser: env.browser,
    // Neither is known yet: the other-tab channel and the helper's doctor come later.
    otherTab: false,
    holder: null,
  })
  const reload = () => {
    window.location.reload()
  }
  const pending: FixAction[] = []
  if (finding) pending.push('find-phone')
  if (phone && snap.retrying.includes(phone.id)) pending.push('retry')
  const wiring: FixWiring = {
    on: {
      'add-device': add,
      'find-phone': findPhone,
      reload,
      ...(phone ? { retry: () => lab.retry(phone.id) } : {}),
    },
    pending,
  }

  const usbDevices = snap.devices.filter((d) => d.backend === 'webusb')
  const usbReady = usbDevices.filter((d) => d.state === 'ready').length
  const laneTone = !webusb ? 'warn' : usbDevices.length === 0 ? 'off' : usbReady ? 'ok' : 'warn'
  const laneText = !webusb
    ? 'No WebUSB'
    : usbDevices.length === 0
      ? 'WebUSB ready'
      : `${String(usbReady)}/${String(usbDevices.length)} Android ready`

  const refusal = installRefusal(selected, selectedBackend)
  const selectedJobs = selected ? snap.jobs.filter((j) => j.deviceId === selected.id) : []

  // Where a drop goes, from the drop zone or from anywhere else on the page.
  const dropFiles = (files: readonly File[]) => {
    if (selected) showInstall(selected.id, files)
  }
  const refuseDrop = () => {
    toast.error('Can’t install here', {
      description: refusal ?? 'Select a ready Android phone first.',
    })
  }

  // A drop outside the zone: on the header, the footer, or an open dialog or sheet (portalled to
  // <body>). Left to the browser, Chrome downloads an APK and navigates away to an image, which
  // ends the USB sessions and any running install. So it is caught and taken like the zone's.
  const onStrayDrop = useEffectEvent((data: DataTransfer) => {
    if (refusal !== null) {
      refuseDrop()
      return
    }
    filesFromDrop(data).then(
      (files) => {
        if (files.length > 0) dropFiles(files)
      },
      () => {
        toast.error('Couldn’t read what was dropped', {
          description: 'Pick the files with Install app instead.',
        })
      },
    )
  })
  useEffect(() => {
    const allow = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      // Prevented already: the zone took it.
      if (!carriesFiles(e) || e.defaultPrevented || !e.dataTransfer) return
      e.preventDefault()
      onStrayDrop(e.dataTransfer)
    }
    window.addEventListener('dragenter', allow)
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', allow)
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [])

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

      {/* The whole page takes a dropped app: it goes to the selected phone, or says why not. */}
      <InstallDropZone
        enabled={refusal === null}
        deviceName={selected?.name ?? ''}
        className="flex-1 p-4 md:p-6"
        onFiles={dropFiles}
        onRefused={refuseDrop}
      >
        <main>
          {snap.devices.length === 0 ? (
            <Gate browser={browserItems} phone={phoneItems} wiring={wiring} os={env.os} />
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
                  activity={activityOf(snap.jobs)}
                  onSelect={(id) => {
                    lab.select(id)
                  }}
                  onAdd={add}
                  onRefresh={() => lab.refresh()}
                />
              </div>
              <DeviceDetailPane
                device={selected}
                goneId={goneId}
                detail={snap.detail}
                shots={selected ? snap.shots.filter((s) => s.deviceId === selected.id) : []}
                zoom={zoom}
                capturing={snap.capturing}
                retrying={selected ? snap.retrying.includes(selected.id) : false}
                check={selected?.platform === 'android' ? deviceCheck(selected, phoneItems) : null}
                wiring={wiring}
                tab={tab}
                onTab={setTab}
                onStale={markStale}
                actions={
                  selected?.platform === 'android' &&
                  selectedBackend?.install && (
                    <InstallButton
                      disabled={refusal !== null}
                      title={
                        refusal ?? 'Install an .apk, .apks, .xapk, .apkm or .aab, or drop one here'
                      }
                      onFiles={(files) => {
                        showInstall(selected.id, files)
                      }}
                    />
                  )
                }
                jobs={
                  <JobsStrip
                    jobs={selectedJobs}
                    onDismiss={(id) => {
                      lab.dismissJob(id)
                    }}
                    onShow={(job) => {
                      showInstall(job.deviceId)
                    }}
                  />
                }
                log={
                  selected?.state === 'ready' &&
                  selected.capabilities.logs &&
                  selectedBackend?.logs && (
                    <LogConsole key={selected.id} device={selected} backend={selectedBackend} />
                  )
                }
                apps={
                  selected &&
                  selectedBackend && (
                    <AppsTab
                      device={selected}
                      lane={selectedBackend}
                      reloadKey={snap.appsRevision[selected.id] ?? 0}
                      timeZone={timeZoneOf(snap, selected.id)}
                      act={(pkg, action) => lab.appAction(selected.id, pkg, action)}
                      onAnnounce={(text) => {
                        lab.announce(text)
                      }}
                    />
                  )
                }
                images={
                  selected &&
                  selectedBackend && (
                    <ImagesTab
                      device={selected}
                      backend={selectedBackend}
                      zoom={zoom}
                      onZoom={(z) => {
                        setZoom(z)
                        saveZoom(z)
                      }}
                    />
                  )
                }
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
            </div>
          )}
        </main>
      </InstallDropZone>

      <footer className="text-muted-foreground px-4 pb-4 text-center text-xs md:px-6">
        The Android robot is reproduced from work created and shared by Google, used under CC BY
        3.0. Apple and the Apple logo are trademarks of Apple Inc.
      </footer>

      {/* One dialog per device that has had one, kept mounted while its device is listed, so a
          closed dialog still follows its job and can show how it ended. */}
      {snap.devices.map((device) => {
        const state = installs[device.id]
        const backend = backendOf(device)
        if (!state || !backend?.install) return null
        return (
          <InstallDialog
            key={device.id}
            open={state.open}
            onOpenChange={(open) => {
              setInstalls((all) => withOpen(all, device.id, open))
            }}
            device={device}
            phone={installPhoneOf(device)}
            ready={device.state === 'ready' && device.capabilities.install === true}
            job={latestInstall(snap.jobs, device.id)}
            files={state.files}
            actions={installActions(lab, backend, device.id)}
            wiring={wiring}
          />
        )
      })}

      <DoctorDialog
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        items={doctorItems(environment, phoneItems, phone)}
        phoneName={phone?.name}
        wiring={wiring}
      />
      <Toaster />
    </div>
  )
}

/** The phone's time zone, once its identifiers are read: dumpsys prints times without one. */
function timeZoneOf(snap: DeviceLabSnapshot, deviceId: string): string | undefined {
  const { detail } = snap
  if (detail.status !== 'ready' || detail.deviceId !== deviceId) return undefined
  return detail.detail.hardware.Timezone || undefined
}
