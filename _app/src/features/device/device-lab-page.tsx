import '@fontsource-variable/geist'

import { Activity, FlaskConical, Loader2, Unplug, Wifi } from 'lucide-react'
import {
  lazy,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { SITE_URL, SiteHeader } from '@/components/site-header'
import { Toaster } from '@/components/toaster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { defineMessages, localized, useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { createAgentBackend } from './backends/agent'
import { DEVICE_ERRORS, deviceErrorMessage, type Backend } from './backends/backend'
import { createMockBackend } from './backends/mock'
import { createWebUsbBackend } from './backends/webusb'
import { BLACK_SHOT } from './black-shot'
import type { FixWiring } from './components/checklist'
import {
  DeviceDetailPane,
  WifiNote,
  screenshotVia,
  type DetailTab,
} from './components/device-detail'
import { DeviceList } from './components/device-list'
import { aboutRows, DoctorDialog } from './components/doctor-dialog'
import { Gate, readGatePlatform, saveGatePlatform, type GatePlatform } from './components/gate'
import { HelperChip, type HelperHandlers } from './components/helper-chip'
import { HelperNotice } from './components/helper-notice'
import { NearbySection } from './components/nearby-list'
import { deviceCheck } from './components/hint-card'
import { PairDialog } from './components/pair-dialog'
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
import { WifiDialog } from './components/wifi-dialog'
import {
  createHelperConnection,
  type HelperConnection,
  type HelperPhase,
} from './helper/connection'
import { resolveHelperEnv } from './helper/env'
import { sameTarget, targetOfSerial } from './helper/network'
import { readPendingPair, takePairFragment } from './helper/pair-fragment'
import type { DoctorReport } from './helper/protocol'
import { helperAnnouncement, pairError, rememberNote } from './helper/status'
import { readStoredPort, readStoredToken } from './helper/token'
import { helperUpdate } from './helper/update'
import { createLogSessions, RESUME_WINDOW_MS, spanText, type LogEvent } from './log-sessions'
import { installPhoneOf, type Device } from './model'
import {
  browserChecks,
  deviceChecks,
  featureChecks,
  gateChecks,
  helperChecks,
  inlineChecks,
  isToolId,
  phoneChecks,
  sortChecks,
  TOOL_BLOCKERS,
  wifiChecks,
  wifiHelperReady,
  type HelperCheckContext,
} from './preflight/checks'
import { COPY } from './preflight/copy'
import { environmentNow, onStaleBuild, readEnvironment, readPublishedHelper } from './preflight/env'
import type { BrowserEnv, CheckItem, FixAction, PublishedHelper } from './preflight/types'
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
import { createNearby, nearbyAvailability, nearbyRows, type NearbyRow } from './nearby'
import { createWifi } from './wifi'

// The tabs' code (and media.ts, the badge reader) loads with the tab, never with the page.
const AppsTab = lazy(() => import('./components/apps-tab').then((m) => ({ default: m.AppsTab })))
const ImagesTab = lazy(() =>
  import('./components/images-tab').then((m) => ({ default: m.ImagesTab })),
)

/** What the functions below and the log's events say, worded when they run. */
const PAGE_TEXT = localized({
  en: {
    slowCapture: 'Still working — the first screenshot of an iPhone can take up to 20 seconds.',
    logDropped: (name: string, wait: string) =>
      `Lost the connection to ${name}. Its log picks up again if it comes back within ${wait}.`,
    logResumed: (name: string) => `${name} is back. Its log resumed.`,
    logUnlisted: (name: string) => `${name} left the device list, so its log stopped.`,
    logGaveUp: (name: string) => `${name} didn’t come back, so its log stopped.`,
    logStopped: 'The log stopped',
    selectThenDrop: 'Select a ready Android phone first, then drop the file again.',
    noIosInstall: 'Installing on iPhone and iPad isn’t supported yet.',
    noInstall: 'This connection can’t install apps.',
    notReady: (name: string) => `${name} isn’t ready. Fix what its card says, then try again.`,
  },
  vi: {
    slowCapture: 'Vẫn đang chụp — lần chụp màn hình đầu tiên trên iPhone có thể mất tới 20 giây.',
    logDropped: (name: string, wait: string) =>
      `Mất kết nối với ${name}. Log sẽ tự chạy tiếp nếu thiết bị kết nối lại trong vòng ${wait}.`,
    logResumed: (name: string) => `${name} đã kết nối lại. Log đã chạy tiếp.`,
    logUnlisted: (name: string) => `${name} đã rời danh sách thiết bị nên log đã dừng.`,
    logGaveUp: (name: string) => `${name} không kết nối lại nên log đã dừng.`,
    logStopped: 'Log đã dừng',
    selectThenDrop: 'Hãy chọn một điện thoại Android đã sẵn sàng, rồi thả lại tệp.',
    noIosInstall: 'Chưa hỗ trợ cài đặt lên iPhone và iPad.',
    noInstall: 'Kết nối này không cài được ứng dụng.',
    notReady: (name: string) =>
      `${name} chưa sẵn sàng. Hãy làm theo hướng dẫn đang hiện cho thiết bị này, rồi thử lại.`,
  },
})

const DEVICE_LAB_MESSAGES = defineMessages({
  en: {
    updated: 'Device Lab was updated',
    reload: 'Reload',
    noWebUsb: 'WebUSB not available',
    openFailed: 'Could not open that device',
    noWebUsbDetail:
      'Firefox and Safari do not implement WebUSB. Use Chrome or Edge, or the local helper.',
    unknownError: 'Unknown error',
    listFailed: 'Couldn’t list the USB devices',
    shotFailed: (name: string) => `Screenshot of ${name} failed`,
    shotBlack: (name: string) => `The screenshot of ${name} is all black`,
    helperStopped: 'Local helper stopped',
    helperStoppedDetail: 'Start it again; this page reconnects by itself.',
    pairFailed: 'Couldn’t pair with the helper',
    disconnected: (name: string) => `${name} disconnected.`,
    disconnectFailed: (name: string) => `Couldn’t disconnect ${name}`,
    adbRunning: 'Google’s adb server is running.',
    adbFailed: 'Couldn’t start the adb server',
    forgotten: 'This page is no longer paired with the helper.',
    lane: {
      none: 'No WebUSB',
      idle: 'WebUSB ready',
      ready: (ready: number, total: number) => `${String(ready)}/${String(total)} Android ready`,
      title: 'This browser talks to Android devices directly over USB.',
      noneTitle: 'Firefox and Safari do not implement WebUSB.',
    },
    cannotInstall: 'Can’t install here',
    selectPhone: 'Select a ready Android phone first.',
    dropUnreadable: 'Couldn’t read what was dropped',
    pickInstead: 'Pick the files with Install app instead.',
    /** The badge of `?mock=1`; `wide` is the part shown from md up. */
    mock: (wide: (text: string) => ReactNode) => <>Mock{wide(' devices')}</>,
    environmentCheck: 'Environment check',
    connectAgain: 'Connect again',
    disconnectTitle: 'Disconnect this Wi‑Fi device (adb disconnect)',
    disconnect: 'Disconnect',
    installTitle: 'Install an .apk, .apks, .xapk, .apkm or .aab, or drop one here',
    credits:
      'The Android robot is reproduced from work created and shared by Google, used under CC BY 3.0. Apple and the Apple logo are trademarks of Apple Inc.',
  },
  vi: {
    updated: 'Device Lab đã được cập nhật',
    reload: 'Tải lại',
    noWebUsb: 'Không dùng được WebUSB',
    openFailed: 'Không mở được thiết bị đó',
    noWebUsbDetail:
      'Firefox và Safari không hỗ trợ WebUSB. Hãy dùng Chrome hoặc Edge, hoặc helper cục bộ.',
    unknownError: 'Lỗi không xác định',
    listFailed: 'Không lấy được danh sách thiết bị USB',
    shotFailed: (name: string) => `Không chụp được màn hình ${name}`,
    shotBlack: (name: string) => `Ảnh chụp màn hình của ${name} toàn màu đen`,
    helperStopped: 'Helper cục bộ đã dừng',
    helperStoppedDetail: 'Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
    pairFailed: 'Không ghép nối được với helper',
    disconnected: (name: string) => `Đã ngắt kết nối ${name}.`,
    disconnectFailed: (name: string) => `Không ngắt kết nối được ${name}`,
    adbRunning: 'adb server của Google đang chạy.',
    adbFailed: 'Không khởi động được adb server',
    forgotten: 'Trang này không còn ghép nối với helper nữa.',
    lane: {
      none: 'Không có WebUSB',
      idle: 'WebUSB sẵn sàng',
      ready: (ready: number, total: number) => `${String(ready)}/${String(total)} Android sẵn sàng`,
      title: 'Trình duyệt này giao tiếp trực tiếp với thiết bị Android qua USB.',
      noneTitle: 'Firefox và Safari không hỗ trợ WebUSB.',
    },
    cannotInstall: 'Không cài được ở đây',
    selectPhone: 'Hãy chọn một điện thoại Android đã sẵn sàng trước.',
    dropUnreadable: 'Không đọc được nội dung vừa thả',
    pickInstead: 'Hãy chọn tệp bằng nút Cài ứng dụng.',
    mock: (wide: (text: string) => ReactNode) => <>{wide('Thiết bị ')}Mock</>,
    environmentCheck: 'Kiểm tra môi trường',
    connectAgain: 'Kết nối lại',
    disconnectTitle: 'Ngắt kết nối thiết bị Wi‑Fi này (adb disconnect)',
    disconnect: 'Ngắt kết nối',
    installTitle: 'Cài tệp .apk, .apks, .xapk, .apkm hoặc .aab, hoặc thả tệp vào đây',
    credits:
      'Robot Android được tái tạo từ tác phẩm do Google tạo ra và chia sẻ, được sử dụng theo giấy phép CC BY 3.0. Apple và logo Apple là nhãn hiệu của Apple Inc.',
  },
})

/**
 * The same messages, read in the language on screen when they are said: for a toast or an
 * announcement raised once an operation ends, which may be after a language switch (an
 * iPhone's first screenshot takes up to 20 s).
 */
const SAID = localized(DEVICE_LAB_MESSAGES)

/** `?mock=1` adds the fixture lane, as the legacy page did — demoable with no phone attached. */
function isMock(): boolean {
  return new URLSearchParams(window.location.search).get('mock') === '1'
}

/**
 * The store and the local helper's connection, built together because the helper is one of the
 * store's lanes. Both constructors are free of side effects (StrictMode builds this twice): the
 * helper is looked for only when the store starts its lanes, and only as §6.3 allows.
 */
function createLabAndHelper(): { lab: DeviceLab; helper: HelperConnection } {
  const pending = readPendingPair()
  const stored = readStoredToken()
  const env = resolveHelperEnv(
    window.location,
    window.DVC_BOOT,
    { pairPort: pending?.port ?? null, tokenPort: stored?.port ?? null, port: readStoredPort() },
    navigator.userAgent,
    navigator.vendor,
  )
  const helper = createHelperConnection(env)
  const lanes: Backend[] = [createWebUsbBackend(), createAgentBackend(helper)]
  // Last: its fixtures reuse real ids, and the merge rule makes it lose to a real lane anyway.
  if (isMock()) lanes.push(createMockBackend())
  return { lab: createDeviceLab(lanes), helper }
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

/** An iPhone screenshot taking longer than this gets a "still working" toast (spec §6.8). */
export const SLOW_CAPTURE_MS = 4_000
/** The toast for a helper that stopped: one at a time, gone once it is back. */
const LOST_TOAST = 'helper-lost'

/** Whether a capture goes through the helper to a real iPhone, which can be slow the first time. */
export const slowCapture = (device: Pick<Device, 'platform' | 'backend' | 'connection'>) =>
  device.platform === 'ios' && device.backend === 'agent' && device.connection !== 'simulator'

/**
 * The Android phone the checklist's phone rows are about: the selected one, else the first
 * listed. Those rows are about this browser reaching the phone over USB, so a phone the helper
 * serves (through Google's adb server) is not one: the Devices rows cover it.
 */
function checklistPhone(devices: readonly Device[], selected: Device | null): Device | null {
  const usb = (d: Device | null): d is Device => d?.platform === 'android' && d.backend !== 'agent'
  if (usb(selected)) return selected
  return devices.find(usb) ?? null
}

/**
 * An Android device the helper serves and that is ready (a cable through Google's adb server,
 * or Wi‑Fi): with one, this browser needs no phone of its own over WebUSB.
 */
function helperPhoneName(devices: readonly Device[]): string | null {
  const d = devices.find(
    (x) => x.backend === 'agent' && x.platform === 'android' && x.state === 'ready',
  )
  return d ? d.name || d.id : null
}

/** Any device the helper lists, by name: with only these, this browser's WebUSB isn't in use. */
function helperDeviceName(devices: readonly Device[]): string | null {
  const d = devices.find((x) => x.backend === 'agent')
  return d ? d.name || d.id : null
}

/** An Android device the helper reaches over Wi‑Fi. */
const isWifiAndroid = (d: Device | null): boolean =>
  d?.platform === 'android' && d.backend === 'agent' && d.connection === 'network'

/**
 * The one kind Disconnect applies to: a Wi‑Fi device listed by its address, as a connect
 * lists it. Not one adb found by itself over mDNS (adb-…._adb-tls-connect._tcp), which
 * `adb disconnect` can't drop: Wireless debugging's own switch, on the device, does.
 */
const canDisconnect = (d: Device): boolean => isWifiAndroid(d) && targetOfSerial(d.id) !== null

/** What the page says when a log drops, comes back, gives up or fails (log-sessions.ts). */
function logEventText(event: LogEvent): string | null {
  const name = event.device.name || event.device.id
  switch (event.kind) {
    case 'dropped':
      // The wait worded when it is said, not once at load, like the sentence around it.
      return PAGE_TEXT.logDropped(name, spanText(RESUME_WINDOW_MS))
    case 'resumed':
      return PAGE_TEXT.logResumed(name)
    case 'gave-up':
      return event.reason === 'unlisted' ? PAGE_TEXT.logUnlisted(name) : PAGE_TEXT.logGaveUp(name)
    case 'failed':
      return null
  }
}

/** Why a drop or Install app can't go to this device, or null when it can. */
export function installRefusal(device: Device | null, backend: Backend | undefined): string | null {
  if (!device) return PAGE_TEXT.selectThenDrop
  if (device.platform === 'ios') return PAGE_TEXT.noIosInstall
  if (device.platform === 'android' && device.connection === 'network') {
    return COPY.wifi.laterInstall
  }
  if (!backend?.install) return PAGE_TEXT.noInstall
  if (device.state !== 'ready') return PAGE_TEXT.notReady(device.name)
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
  helperItems: readonly CheckItem[],
  phone: Device | null,
): CheckItem[] {
  return [
    ...browserChecks(env),
    ...phoneItems,
    ...sortChecks(helperItems),
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
 * straight from Chrome or Edge over WebUSB; iPhones (and Android without WebUSB) through the
 * local helper, device-bridge.mjs, which the tester runs on their Mac. Redesigned on its port
 * to match XConsole (shadcn/ui, light and dark), with the legacy page's behaviour kept.
 */
export function DeviceLabPage() {
  /*
    Subscribed here, at the root, on purpose: Device Lab words much of what it shows outside
    React (checks, errors, the helper's states, all in `localized` tables), so a language
    switch re-renders the whole page and every one of them reads the new language.
  */
  useLocale()
  const t = useMessages(DEVICE_LAB_MESSAGES)
  const [{ lab, helper }] = useState(createLabAndHelper)
  const [wifi] = useState(() => createWifi({ connection: helper }))
  // What advertises debugging on the network: looked for while the list shows it, never connected.
  const [nearby] = useState(() => createNearby({ connection: helper }))
  // Logs outlive their console: a device that drops says so in its log, and resumes (§7.8).
  const [logs] = useState(() =>
    createLogSessions({
      onEvent: (event) => {
        if (event.kind === 'failed') {
          toast.error(PAGE_TEXT.logStopped, { description: deviceErrorMessage(event.error) })
          return
        }
        const text = logEventText(event)
        if (text) lab.announce(text)
      },
    }),
  )
  const snap = useDeviceLabSnapshot(lab)
  const wifiSnap = useSyncExternalStore(wifi.subscribe, wifi.getSnapshot, wifi.getSnapshot)
  const nearbySnap = useSyncExternalStore(nearby.subscribe, nearby.getSnapshot, nearby.getSnapshot)
  const waitingLogId = useSyncExternalStore(logs.subscribe, logs.waitingId, logs.waitingId)
  const status = useSyncExternalStore(helper.subscribeStatus, helper.getStatus, helper.getStatus)
  const helperDevices = useSyncExternalStore(
    helper.subscribeDevices,
    helper.getDevices,
    helper.getDevices,
  )
  // Remembered Wi‑Fi devices take the names they are listed under.
  useEffect(() => {
    wifi.sync(helperDevices)
  }, [wifi, helperDevices])
  const [pair, setPair] = useState({ open: false, key: 0 })
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  // Undefined until the published file was read (once the helper is connected).
  const [published, setPublished] = useState<PublishedHelper | null | undefined>(undefined)
  const [rechecking, setRechecking] = useState(false)
  const [startingAdb, setStartingAdb] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [zoom, setZoom] = useState(readZoom)
  // The Gate's platform, as this browser chose it last; null until the tester chooses one.
  const [gatePlatform, setGatePlatform] = useState<GatePlatform | null>(readGatePlatform)
  const [env, setEnv] = useState(() => environmentNow())
  const [appUpdated, setAppUpdated] = useState(false)
  const [finding, setFinding] = useState(false)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [installs, setInstalls] = useState<Installs>({})
  const [wifiOpen, setWifiOpen] = useState(false)
  /** A found device the Wi‑Fi dialog was opened for: it fills its fields in, once per seq. */
  const [wifiPick, setWifiPick] = useState<{ seq: number; row: NearbyRow } | null>(null)
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
    toast.error(t.updated, {
      description: COPY.app.updated,
      duration: Infinity,
      action: {
        label: t.reload,
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
  // A selection that left the list, or (with nothing selected) a device whose log waits for it.
  const goneId =
    snap.selectedId !== null && !selected ? snap.selectedId : selected ? null : waitingLogId
  const backendOf = (device: Device | null) =>
    device ? lab.backends.find((b) => b.kind === device.backend) : undefined
  const logShownId = selected?.id ?? goneId
  // A Wi‑Fi device that went: one click connects it again (the tester's click, as always).
  const goneTarget = goneId ? targetOfSerial(goneId) : null
  const logView = useSyncExternalStore(
    logs.subscribe,
    () => logs.view(logShownId ?? ''),
    () => logs.view(logShownId ?? ''),
  )

  // The logs follow the list: a device that left (or stopped being ready) drops its log into
  // waiting, one that came back resumes it. One log per tab: selecting another ends the rest.
  useEffect(() => {
    logs.sync(snap.devices, (d) => lab.backends.find((b) => b.kind === d.backend))
  }, [logs, lab, snap.devices])
  useEffect(() => {
    if (snap.selectedId !== null) logs.keepOnly(snap.selectedId)
  }, [logs, snap.selectedId])
  // Back while its log waits, with nothing selected (the list was empty): select it again.
  useEffect(() => {
    if (snap.selectedId === null && waitingLogId !== null) {
      if (snap.devices.some((d) => d.id === waitingLogId)) lab.select(waitingLogId)
    }
  }, [lab, snap.selectedId, snap.devices, waitingLogId])
  useEffect(
    () => () => {
      logs.dispose()
    },
    [logs],
  )
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
  // A log waiting for its device keeps the grid up, so the log can say what happened.
  const gate = snap.devices.length === 0 && waitingLogId === null
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
      toast.error(message === 'WEBUSB_UNSUPPORTED' ? SAID.noWebUsb : SAID.openFailed, {
        description:
          message === 'WEBUSB_UNSUPPORTED' ? SAID.noWebUsbDetail : message || SAID.unknownError,
      })
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
        toast.error(SAID.listFailed, { description: deviceErrorMessage(error) })
      })
      .finally(() => {
        setFinding(false)
      })
  }

  const capture = (id: string) => {
    const device = snap.devices.find((d) => d.id === id)
    const name = device?.name ?? id
    // The first devicectl capture of an iPhone takes seconds (once, 18): say it is still going.
    const slowId = `slow-capture-${id}`
    const slow =
      device && slowCapture(device)
        ? setTimeout(() => {
            toast(PAGE_TEXT.slowCapture, { id: slowId })
          }, SLOW_CAPTURE_MS)
        : null
    void lab.capture(id).then((failure) => {
      if (slow !== null) {
        clearTimeout(slow)
        toast.dismiss(slowId)
      }
      if (failure !== null) {
        toast.error(SAID.shotFailed(name), { description: failure })
        return
      }
      // Taken, but all black: kept in the list, and the tester told why at once.
      const shot = lab.getSnapshot().shots[0]
      if (shot?.deviceId === id && shot.black) {
        toast.warning(SAID.shotBlack(name), { description: BLACK_SHOT.text })
      }
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
    } else if (
      (e.key === 's' || e.key === 'S') &&
      selected?.state === 'ready' &&
      selected.capabilities.screenshot
    ) {
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

  /* -- The local helper -- */

  const connected = status.phase === 'connected'
  // A report from an earlier connection says nothing about the helper running now.
  const report = connected ? doctor : null

  // Said once per change, in the live region; "stopped" is a toast too, because the chip that
  // would show it is hidden on narrow screens. Only for a tester who wants the helper.
  const lastPhase = useRef<HelperPhase>(status.phase)
  const onPhase = useEffectEvent((phase: HelperPhase) => {
    const before = lastPhase.current
    lastPhase.current = phase
    const said = helperAnnouncement(before, phase, status.intent)
    if (said) lab.announce(said)
    if (phase === 'lost' && before !== 'lost' && status.intent) {
      toast.error(t.helperStopped, {
        id: LOST_TOAST,
        description: t.helperStoppedDetail,
      })
    }
    if (phase === 'connected') toast.dismiss(LOST_TOAST)
  })
  useEffect(() => {
    onPhase(status.phase)
  }, [status.phase])

  // The helper's link opened in this very tab: only the fragment changed, so main.tsx didn't see
  // it. It is taken out of the address and checked now, keeping this tab's "Remember" choice.
  const onPairLink = useEffectEvent(() => {
    const link = takePairFragment()
    if (!link) return
    const port = link.port === null ? '' : `&port=${String(link.port)}`
    helper.pair(`#pair=${link.token}${port}`, status.remember).then(
      (result) => {
        if (!result.ok) toast.error(SAID.pairFailed, { description: pairError(result, status) })
      },
      () => undefined,
    )
  })
  useEffect(() => {
    const handle = () => {
      onPairLink()
    }
    window.addEventListener('hashchange', handle)
    return () => {
      window.removeEventListener('hashchange', handle)
    }
  }, [])

  // This Mac's tools (/api/doctor, cached 30 s by the connection): for the Gate's checklist, the
  // Environment check, and a selected device whose blocker needs a tool (Xcode…).
  const wantsTools =
    selected?.backend === 'agent' && selected.blockers.some((code) => TOOL_BLOCKERS.has(code))
  const needDoctor = connected && (doctorOpen || gate || wantsTools)
  // The lanes' state: when it changes the connection drops its cached report, so read it again.
  const lanesKey = JSON.stringify(status.lanes)
  useEffect(() => {
    if (!needDoctor) return
    let live = true
    helper.doctor().then(
      (next) => {
        if (live && next) setDoctor(next)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [helper, needDoctor, lanesKey])

  // The published helper, to say whether this one is current: the Environment check's update
  // row, and "update available" on the chip and the notice strip. Read once per running helper
  // (by its SHA-256), not per poll; the check's Recheck reads it again.
  const runningSha = connected ? (status.health?.sha256 ?? null) : null
  useEffect(() => {
    if (runningSha === null) return
    let live = true
    void readPublishedHelper().then((next) => {
      if (live) setPublished(next)
    })
    return () => {
      live = false
    }
  }, [runningSha])
  const update = connected ? helperUpdate(status.health, published) : null

  const openPair = () => {
    setPair((p) => ({ open: true, key: p.key + 1 }))
  }
  const openWifi = () => {
    setWifiOpen(true)
  }
  const openWifiFor = (row: NearbyRow) => {
    setWifiPick((p) => ({ seq: (p?.seq ?? 0) + 1, row }))
    setWifiOpen(true)
  }
  // A found device's Connect: the Wi‑Fi dialog's own connect, shown there (Allow comes next).
  // Only ever on this click.
  const connectNearby = (row: NearbyRow) => {
    if (row.action.kind !== 'connect' || wifiSnap.attempt?.state === 'running') return
    openWifiFor(row)
    void wifi.connect(row.action.target)
  }

  // Only ever on the tester's click, like every Wi‑Fi operation.
  const disconnectWifi = (serial: string) => {
    const name = snap.devices.find((d) => d.id === serial)?.name || serial
    // Disconnecting on purpose is no drop: its log stops rather than waiting for it.
    logs.stop(serial)
    void wifi.disconnect(serial).then((failure) => {
      if (failure === null) lab.announce(SAID.disconnected(name))
      else
        toast.error(SAID.disconnectFailed(name), {
          description: deviceErrorMessage(new Error(failure)),
        })
    })
  }
  const openCheck = () => {
    setDoctorOpen(true)
  }

  const recheck = () => {
    if (rechecking) return
    setRechecking(true)
    helper.pollNow()
    const tools = connected ? helper.doctor(true) : Promise.resolve(null)
    const file = doctorOpen && runningSha !== null ? readPublishedHelper() : null
    Promise.all([tools, readEnvironment(), file])
      .then(([next, nextEnv, nextFile]) => {
        if (next) setDoctor(next)
        setEnv(nextEnv)
        if (file) setPublished(nextFile)
      })
      .catch(() => undefined)
      .finally(() => {
        setRechecking(false)
      })
  }

  // Only ever on this click: a running adb server takes Android phones away from WebUSB.
  const startAdb = () => {
    if (startingAdb) return
    setStartingAdb(true)
    helper
      .startAdb()
      .then(
        () => {
          lab.announce(SAID.adbRunning)
          if (connected) void helper.doctor(true).then((next) => next && setDoctor(next))
        },
        (error: unknown) => {
          toast.error(SAID.adbFailed, { description: deviceErrorMessage(error) })
        },
      )
      .finally(() => {
        setStartingAdb(false)
      })
  }

  const forget = () => {
    helper.forget()
    setDoctor(null)
    lab.announce(t.forgotten)
  }

  const helperOn: HelperHandlers = {
    connect: helper.connect,
    pair: openPair,
    check: openCheck,
    reload: () => {
      window.location.reload()
    },
  }

  const helperBase: HelperCheckContext = {
    browser: env.browser,
    webusb,
    devices: snap.devices,
  }
  const helperItems = helperChecks(status, report, helperBase)
  // The helper's tool rows (This Mac, iPhone tools, Android tools), for the device rows.
  const toolItems = helperItems.filter((item) => isToolId(item.id))
  const inline = selected && report ? inlineChecks(selected, toolItems) : []
  // The Gate lists the helper's checklist once the tester wants the helper, or it runs.
  const gateItems = connected || status.intent ? gateChecks(helperItems) : []

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
    helperPhone: helperPhoneName(snap.devices),
    helperDevice: helperDeviceName(snap.devices),
  })
  const reload = () => {
    window.location.reload()
  }
  const pending: FixAction[] = []
  if (finding) pending.push('find-phone')
  if (phone && snap.retrying.includes(phone.id)) pending.push('retry')
  if (rechecking) pending.push('recheck')
  if (startingAdb) pending.push('start-adb')
  const wiring: FixWiring = {
    on: {
      'add-device': add,
      'find-phone': findPhone,
      reload,
      ...(phone ? { retry: () => lab.retry(phone.id) } : {}),
      'connect-helper': helper.connect,
      'pair-helper': openPair,
      'check-helper': helper.pollNow,
      'start-adb': startAdb,
      'open-wifi': openWifi,
      recheck,
      doctor: openCheck,
    },
    pending,
  }

  const usbDevices = snap.devices.filter((d) => d.backend === 'webusb')
  const usbReady = usbDevices.filter((d) => d.state === 'ready').length
  const laneTone = !webusb ? 'warn' : usbDevices.length === 0 ? 'off' : usbReady ? 'ok' : 'warn'
  const laneText = !webusb
    ? t.lane.none
    : usbDevices.length === 0
      ? t.lane.idle
      : t.lane.ready(usbReady, usbDevices.length)

  const refusal = installRefusal(selected, selectedBackend)
  const selectedJobs = selected ? snap.jobs.filter((j) => j.deviceId === selected.id) : []

  // Where a drop goes, from the drop zone or from anywhere else on the page.
  const dropFiles = (files: readonly File[]) => {
    if (selected) showInstall(selected.id, files)
  }
  const refuseDrop = () => {
    toast.error(t.cannotInstall, {
      description: refusal ?? t.selectPhone,
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
        toast.error(SAID.dropUnreadable, {
          description: SAID.pickInstead,
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

  // The log: the selected device's while it can stream one, or a log that is waiting for its
  // device, or one that ended and still has something to read.
  const canLog =
    selected?.state === 'ready' &&
    selected.capabilities.logs === true &&
    selectedBackend?.logs !== undefined
  const logDevice = selected ?? logView.device
  const keepsLog = logView.phase !== 'idle' || logView.lines.length > 0
  const logConsole =
    logDevice && (canLog || keepsLog) ? (
      <LogConsole
        key={logDevice.id}
        device={logDevice}
        sessions={logs}
        onStart={
          canLog && selected && selectedBackend
            ? () => {
                logs.start(selected, selectedBackend)
              }
            : undefined
        }
      />
    ) : null

  // "On this network": what isn't listed already, and the one whose connect runs now.
  const nearbyFound = nearbyRows(nearbySnap.devices, snap.devices)
  const running = wifiSnap.attempt?.state === 'running' ? wifiSnap.attempt : null
  const nearbyConnecting =
    running?.kind === 'connect'
      ? (nearbyFound.find(
          (r) => r.action.kind === 'connect' && sameTarget(r.action.target, running),
        )?.key ?? null)
      : null
  const nearbySection = (
    <NearbySection
      status={status}
      snapshot={nearbySnap}
      rows={nearbyFound}
      connecting={running ? (nearbyConnecting ?? '') : null}
      onWatch={nearby.watch}
      onRefresh={nearby.refresh}
      onConnect={connectNearby}
      onPair={openWifiFor}
      onHelper={openWifi}
    />
  )

  // The Wi‑Fi rows, in the Environment check, once Wi‑Fi is in play.
  const wifiDevice =
    snap.devices.find((d) => d.id === wifiSnap.attempt?.serial) ??
    snap.devices.find(isWifiAndroid) ??
    null
  const wifiItems =
    wifiSnap.attempt !== null || snap.devices.some(isWifiAndroid)
      ? wifiChecks({ helper: status, attempt: wifiSnap.attempt, device: wifiDevice })
      : []

  return (
    <div data-page="device" data-shell="console" className="flex min-h-dvh flex-col">
      {/* Keyed by sequence, so a repeated message is a new node and is spoken again. */}
      <p role="status" aria-live="polite" className="sr-only">
        <span key={snap.announcement.seq}>{snap.announcement.text}</span>
      </p>

      {/* The helper's own copy of this page (local mode) is served from 127.0.0.1, whose root
          is the helper's, not the site's: its header links to the site itself. */}
      <SiteHeader
        current="device"
        base={window.DVC_BOOT?.mode === 'local' ? SITE_URL : '/'}
        actions={
          <>
            {/* Two chips, deliberately: "helper unreachable" and "helper up, zero devices" must
                never look the same (Maestro #3012 reported "0 devices" while the agent was the
                failure). From lg up, where they fit beside the sections. */}
            <div className="hidden items-center gap-2 lg:flex">
              <Badge
                variant="outline"
                className="gap-1.5"
                title={webusb ? t.lane.title : t.lane.noneTitle}
              >
                <StateDot tone={laneTone} />
                {laneText}
              </Badge>
              <HelperChip status={status} devices={helperDevices} on={helperOn} update={update} />
            </div>
            {mock && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
              >
                <FlaskConical />
                {/* The icon alone on a phone, where the language switch needs the room. */}
                <span className="max-sm:sr-only">
                  {t.mock((text) => (
                    <span className="hidden md:inline">{text}</span>
                  ))}
                </span>
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t.environmentCheck}
              title={t.environmentCheck}
              onClick={() => {
                setDoctorOpen(true)
              }}
            >
              <Activity />
            </Button>
          </>
        }
      />

      {/* The whole page takes a dropped app: it goes to the selected phone, or says why not. */}
      <InstallDropZone
        enabled={refusal === null}
        deviceName={selected?.name ?? ''}
        className="flex-1 p-4 md:p-6"
        onFiles={dropFiles}
        onRefused={refuseDrop}
      >
        <main>
          {gate ? (
            <>
              {/* Only "update available" here: the Gate's own cards say every other phase. */}
              {update && (
                <div className="mx-auto w-full max-w-3xl">
                  <HelperNotice status={status} on={helperOn} update={update} />
                </div>
              )}
              <Gate
                browser={browserItems}
                phone={phoneItems}
                wiring={wiring}
                os={env.os}
                helper={status}
                helperOn={helperOn}
                checklist={gateItems}
                onWifi={openWifi}
                choice={gatePlatform}
                onChoose={(platform) => {
                  setGatePlatform(platform)
                  saveGatePlatform(platform)
                }}
                nearby={nearbyAvailability(status) === 'helper' ? undefined : nearbySection}
              />
            </>
          ) : (
            <>
              <div className="mx-auto mb-4 w-full max-w-7xl empty:hidden">
                <HelperNotice status={status} on={helperOn} update={update} />
              </div>
              <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-start gap-6 lg:grid-cols-[22rem_1fr]">
                {/* At lg the list stays in view and scrolls on its own, as the legacy pane did, so
                  a long list is never cut off below the fold. The padding keeps focus rings whole. */}
                <div className="lg:sticky lg:top-20 lg:-m-1 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:p-1">
                  <DeviceList
                    filterRef={filterRef}
                    devices={snap.devices}
                    selectedId={snap.selectedId}
                    activity={activityOf(snap.jobs)}
                    onSelect={(id) => {
                      lab.select(id)
                    }}
                    onAddUsb={webusb ? add : undefined}
                    onAddWifi={openWifi}
                    onRefresh={() => lab.refresh()}
                  />
                  <div className="mt-6">{nearbySection}</div>
                </div>
                <DeviceDetailPane
                  device={selected}
                  goneId={goneId}
                  goneAction={
                    goneTarget &&
                    wifiHelperReady(status) && (
                      <Button
                        variant="outline"
                        aria-disabled={wifiSnap.attempt?.state === 'running' || undefined}
                        className="aria-disabled:opacity-50"
                        onClick={() => {
                          if (wifiSnap.attempt?.state !== 'running') void wifi.connect(goneTarget)
                        }}
                      >
                        {wifiSnap.attempt?.state === 'running' ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Wifi />
                        )}
                        {t.connectAgain}
                      </Button>
                    )
                  }
                  detail={snap.detail}
                  shots={selected ? snap.shots.filter((s) => s.deviceId === selected.id) : []}
                  zoom={zoom}
                  capturing={snap.capturing}
                  retrying={selected ? snap.retrying.includes(selected.id) : false}
                  check={selected && selected === phone ? deviceCheck(selected, phoneItems) : null}
                  inline={inline}
                  captureVia={selected ? screenshotVia(selected, status.lanes) : null}
                  wiring={wiring}
                  tab={tab}
                  onTab={setTab}
                  onStale={markStale}
                  actions={
                    selected && canDisconnect(selected) ? (
                      <Button
                        variant="outline"
                        aria-disabled={wifiSnap.disconnecting !== null || undefined}
                        className="aria-disabled:opacity-50"
                        title={t.disconnectTitle}
                        onClick={() => {
                          if (wifiSnap.disconnecting === null) disconnectWifi(selected.id)
                        }}
                      >
                        {wifiSnap.disconnecting === selected.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Unplug />
                        )}
                        {t.disconnect}
                      </Button>
                    ) : (
                      selected?.platform === 'android' &&
                      selectedBackend?.install && (
                        <InstallButton
                          disabled={refusal !== null}
                          title={refusal ?? t.installTitle}
                          onFiles={(files) => {
                            showInstall(selected.id, files)
                          }}
                        />
                      )
                    )
                  }
                  note={selected && <WifiNote device={selected} />}
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
                  log={logConsole}
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
            </>
          )}
        </main>
      </InstallDropZone>

      <footer className="text-muted-foreground px-4 pb-4 text-center text-xs md:px-6">
        {t.credits}
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
        items={doctorItems(
          environment,
          phoneItems,
          [
            // The published file is compared only here, once the check has read it.
            ...helperChecks(status, report, {
              ...helperBase,
              ...(doctorOpen && published !== undefined ? { published } : {}),
            }),
            ...deviceChecks(snap.devices, { connected, webusb, tools: toolItems }),
            ...wifiItems,
          ],
          phone,
        )}
        phoneName={phone?.name}
        wiring={wiring}
        about={aboutRows({
          status,
          doctor: report,
          version: env.version,
          mock,
          devices: snap.devices,
        })}
        remember={
          // Never on the helper's own page: its origin is whatever listens on the port next.
          status.pairing && status.env.mode === 'hosted'
            ? {
                on: status.pairing.remembered,
                note: rememberNote(status.pairing.tokenPersistent),
                onChange: helper.setRemember,
              }
            : null
        }
        onRecheck={recheck}
        rechecking={rechecking}
        onForget={status.pairing ? forget : undefined}
      />
      <WifiDialog
        open={wifiOpen}
        onOpenChange={setWifiOpen}
        os={env.os}
        status={status}
        helperOn={helperOn}
        wiring={wiring}
        wifi={wifiSnap}
        devices={snap.devices}
        onConnect={wifi.connect}
        onPair={wifi.pair}
        onDisconnect={disconnectWifi}
        onForget={wifi.forget}
        onShow={(id) => {
          lab.select(id)
          setWifiOpen(false)
        }}
        nearby={{ snapshot: nearbySnap, rows: nearbyFound, onWatch: nearby.watch }}
        pick={wifiPick}
      />
      <PairDialog
        key={pair.key}
        open={pair.open}
        onOpenChange={(open) => {
          setPair((p) => ({ ...p, open }))
        }}
        status={status}
        onPair={helper.pair}
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
