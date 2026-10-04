import { ChevronDown, Loader2, Unplug, Wifi, X } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

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
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/cn'

import type { NetworkTarget, PairTarget } from '../helper/client'
import type { HelperStatus } from '../helper/connection'
import {
  addressOf,
  DEFAULT_ADB_PORT,
  parseAddress,
  parsePairingCode,
  parsePort,
  recentLabel,
  targetOfSerial,
  sameTarget,
  type HostProblem,
  type RecentDevice,
} from '../helper/network'
import { STATE_META, type Device } from '../model'
import { ALLOW_DEBUGGING, wifiChecks, wifiHelperReady } from '../preflight/checks'
import { COPY, FIX, STATUS_META } from '../preflight/copy'
import type { CheckItem, Os } from '../preflight/types'
import type { WifiSnapshot } from '../wifi'
import { PathFix, RowBody, StatusWord, type FixWiring } from './checklist'
import { HelperCardBody } from './helper-card'
import type { HelperHandlers } from './helper-chip'
import { TONE_SURFACE } from './status'

/*
  "Network device (Wi‑Fi)…" (§4.7): an Android TV across the room, or a phone without its
  cable, connected through the local helper and Google's adb server. A browser can't open a TCP
  connection, so without the helper (or before this page is paired with it) the dialog shows
  the helper card's way to start and pair it instead of the form.

  Two ways in, as Android offers them:
  - Network debugging (Android TV) or a port opened before (`adb tcpip 5555`): an address and
    a port, then Connect.
  - Wireless debugging (Android 11 and newer, phones and Google TV): pair once with the code the
    device shows, then connect on the port the Wireless debugging screen shows (it differs
    from the pairing port).

  Progress is the Wi‑Fi rows of the checklist (checks.ts wifiChecks): the device answering,
  then allowing this computer, each with its sentence and its fix.
*/

const HOST_WORDS: Readonly<Record<HostProblem, string>> = {
  empty: COPY.wifi.hostEmpty,
  invalid: COPY.wifi.hostInvalid,
  public: COPY.wifi.hostPublic,
  loopback: COPY.wifi.hostLoopback,
  name: COPY.wifi.hostName,
}

/** One row of the checklist, in the dialog: status word, label, then its body. */
function Row({ item, wiring }: { item: CheckItem; wiring?: FixWiring }) {
  return (
    <li
      className={cn(
        'space-y-1 rounded-lg border p-3 wrap-anywhere',
        item.status !== 'unchecked' && TONE_SURFACE[STATUS_META[item.status].tone],
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <p className="text-sm leading-6 font-medium">{item.label}</p>
        <StatusWord status={item.status} />
      </div>
      <RowBody item={item} wiring={wiring} />
    </li>
  )
}

/** A field's label, input and its own error, wired for screen readers. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error: string | null
  children: ReactNode
}) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs leading-relaxed">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-muted-foreground text-xs leading-relaxed">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** Input props for a field: never autofilled or corrected, described by its error or hint. */
const fieldProps = (id: string, error: string | null, hint: boolean) => ({
  id,
  autoComplete: 'off',
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'aria-invalid': error !== null || undefined,
  'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
})

/** The remembered devices: one click to connect again, one to forget. */
function RecentList({
  recent,
  devices,
  busy,
  disconnecting,
  onConnect,
  onDisconnect,
  onForget,
}: {
  recent: readonly RecentDevice[]
  devices: readonly Device[]
  busy: boolean
  disconnecting: string | null
  onConnect: (target: NetworkTarget) => void
  onDisconnect: (serial: string) => void
  onForget: (target: NetworkTarget) => void
}) {
  const headingId = `${useId()}-recent`
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-medium">
        Recent
      </h3>
      <ul className="divide-y rounded-lg border">
        {recent.map((r) => {
          const label = recentLabel(r)
          const listed = devices.find((d) => {
            const t = d.connection === 'network' ? targetOfSerial(d.id) : null
            return t !== null && sameTarget(t, r)
          })
          return (
            <li key={addressOf(r)} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name || addressOf(r)}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {r.name && <span className="font-mono">{addressOf(r)} · </span>}
                  {listed ? STATE_META[listed.state].label : 'Not connected'}
                </p>
              </div>
              {listed ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Disconnect ${label}`}
                  aria-disabled={disconnecting !== null || undefined}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    if (disconnecting === null) onDisconnect(listed.id)
                  }}
                >
                  {disconnecting === listed.id ? <Loader2 className="animate-spin" /> : <Unplug />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${label}`}
                  aria-disabled={busy || undefined}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    if (!busy) onConnect({ host: r.host, port: r.port })
                  }}
                >
                  Connect
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Forget ${label}`}
                title="Forget"
                onClick={() => {
                  onForget({ host: r.host, port: r.port })
                }}
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function WifiDialog({
  open,
  onOpenChange,
  status,
  helperOn,
  wiring,
  wifi,
  devices,
  onConnect,
  onPair,
  onDisconnect,
  onForget,
  onShow,
  os,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: HelperStatus
  /** The helper card's buttons: connect, pair. */
  helperOn: HelperHandlers
  /** The checklist's actions: start-adb above all. */
  wiring: FixWiring
  wifi: WifiSnapshot
  /** The page's list, to follow the device a connect added. */
  devices: readonly Device[]
  onConnect: (target: NetworkTarget) => Promise<unknown>
  onPair: (target: PairTarget) => Promise<boolean>
  onDisconnect: (serial: string) => void
  onForget: (target: NetworkTarget) => void
  /** Selects a listed device, and closes the dialog. */
  onShow: (id: string) => void
  /** The system this page runs on: how to get Node.js, and where to type the command. */
  os?: Os
}) {
  const uid = useId()
  const opener = useRef<HTMLElement | null>(null)
  const portRef = useRef<HTMLInputElement>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [pairAddress, setPairAddress] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [pairOpen, setPairOpen] = useState(false)
  /** After a pairing, the connect port is the one the device shows: 5555 would be a guess. */
  const [portRequired, setPortRequired] = useState(false)

  const { attempt } = wifi
  const running = attempt?.state === 'running'
  const device = attempt?.serial ? (devices.find((d) => d.id === attempt.serial) ?? null) : null
  const rows = wifiChecks({ helper: status, attempt, device })
  const rowOf = (id: CheckItem['id']) => rows.find((r) => r.id === id)
  const helperRow = rowOf('wifi.helper')
  const adbRow = rowOf('wifi.adbServer')
  // Only after a connect this computer blocked: said first, as the thing to fix.
  const localRow = rowOf('wifi.localNetwork')
  const reachRow = rowOf('wifi.reachable')
  const authRow = rowOf('wifi.authorized')
  const ready = wifiHelperReady(status)
  const paired = status.phase === 'connected' && status.pairing !== null
  const ids = {
    host: `${uid}-host`,
    port: `${uid}-port`,
    pairAddress: `${uid}-pair-address`,
    code: `${uid}-code`,
  }

  const close = (next: boolean) => {
    if (!next) {
      // The code is single-use and the tester's: never kept past the dialog.
      setCode('')
      setErrors({})
    }
    onOpenChange(next)
  }

  const connect = (e: FormEvent) => {
    e.preventDefault()
    if (running) return
    const address = parseAddress(host)
    // A port pasted with the address wins over an empty port field.
    const fallback =
      address.ok && address.port !== null ? address.port : portRequired ? null : DEFAULT_ADB_PORT
    const portValue = parsePort(port, fallback)
    const next = {
      host: address.ok ? null : HOST_WORDS[address.problem],
      port: portValue.ok
        ? null
        : portValue.problem === 'empty'
          ? COPY.wifi.portEmpty
          : COPY.wifi.portInvalid,
    }
    setErrors(next)
    if (!address.ok || !portValue.ok) {
      document.getElementById(address.ok ? ids.port : ids.host)?.focus()
      return
    }
    setHost(address.host)
    setPort(String(portValue.port))
    void onConnect({ host: address.host, port: portValue.port })
  }

  const pair = (e: FormEvent) => {
    e.preventDefault()
    if (running) return
    const address = parseAddress(pairAddress)
    const parsedCode = parsePairingCode(code)
    const next = {
      pairAddress: !address.ok
        ? HOST_WORDS[address.problem]
        : address.port === null
          ? COPY.wifi.portEmpty
          : null,
      code: parsedCode.ok
        ? null
        : parsedCode.problem === 'empty'
          ? COPY.wifi.codeEmpty
          : COPY.wifi.codeInvalid,
    }
    setErrors(next)
    if (!address.ok || address.port === null || !parsedCode.ok) {
      document.getElementById(next.pairAddress ? ids.pairAddress : ids.code)?.focus()
      return
    }
    const target = { host: address.host, port: address.port, code: parsedCode.code }
    void onPair(target).then((ok) => {
      setCode('')
      if (!ok) return
      // Connecting is next, on another port: the address is the same, the port isn't.
      setHost(target.host)
      setPort('')
      setPortRequired(true)
      portRef.current?.focus()
    })
  }

  const fieldError = (key: string) => errors[key] ?? null

  let body: ReactNode
  if (!paired) {
    body = (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed">{COPY.wifi.helperOff}</p>
        <div className="space-y-4 rounded-xl border p-4">
          <HelperCardBody status={status} on={helperOn} os={os} withoutIphoneCase />
        </div>
      </div>
    )
  } else if (!ready && helperRow) {
    body = (
      <ul aria-label="Before you connect" className="space-y-2">
        <Row item={helperRow} wiring={wiring} />
      </ul>
    )
  } else if (adbRow && adbRow.status !== 'ok') {
    body = (
      <ul aria-label="Before you connect" className="space-y-2">
        <Row item={adbRow} wiring={wiring} />
      </ul>
    )
  } else {
    const showRow = attempt !== null
    const authOk = authRow?.status === 'ok' && device !== null
    body = (
      <div className="space-y-5">
        {wifi.recent.length > 0 && (
          <RecentList
            recent={wifi.recent}
            devices={devices}
            busy={running}
            disconnecting={wifi.disconnecting}
            onConnect={(target) => {
              setHost(target.host)
              setPort(String(target.port))
              setErrors({})
              void onConnect(target)
            }}
            onDisconnect={onDisconnect}
            onForget={onForget}
          />
        )}

        <form onSubmit={connect} noValidate aria-label="Connect" className="space-y-3">
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-3">
            <Field id={ids.host} label="IP address" error={fieldError('host')}>
              <Input
                {...fieldProps(ids.host, fieldError('host'), true)}
                name="wifi-host"
                inputMode="url"
                placeholder="192.168.1.20"
                className="font-mono"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value)
                  if (errors.host) setErrors((all) => ({ ...all, host: null }))
                }}
              />
            </Field>
            <Field id={ids.port} label="Port" error={fieldError('port')}>
              <Input
                {...fieldProps(ids.port, fieldError('port'), false)}
                ref={portRef}
                name="wifi-port"
                inputMode="numeric"
                placeholder="5555"
                className="font-mono"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value)
                  if (errors.port) setErrors((all) => ({ ...all, port: null }))
                }}
              />
            </Field>
          </div>
          <p id={`${ids.host}-hint`} className="text-muted-foreground text-xs leading-relaxed">
            The address is on the device: in its network settings, or on the Wireless debugging
            screen. A TV’s Network debugging uses port 5555.
          </p>
          <Button
            type="submit"
            aria-disabled={running || undefined}
            className="aria-disabled:opacity-50"
          >
            {running && attempt.kind === 'connect' ? (
              <>
                <Loader2 className="animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <Wifi /> Connect
              </>
            )}
          </Button>
        </form>

        {showRow && (
          <ul aria-label="Progress" className="space-y-2">
            {localRow && <Row item={localRow} wiring={wiring} />}
            {reachRow && <Row item={reachRow} wiring={wiring} />}
            {attempt.kind === 'connect' && attempt.state === 'ok' && authRow && (
              <Row item={authRow} wiring={wiring} />
            )}
          </ul>
        )}
        {authOk && (
          <Button
            variant="default"
            onClick={() => {
              onShow(device.id)
            }}
          >
            Show {device.name || device.id}
          </Button>
        )}

        <details
          className="group rounded-lg border"
          open={pairOpen}
          onToggle={(e) => {
            setPairOpen(e.currentTarget.open)
          }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2.5 text-sm font-medium">
            Pair with a code (Android 11 and newer)
            <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
          </summary>
          <form
            onSubmit={pair}
            noValidate
            aria-label="Pair with a code"
            className="space-y-3 border-t px-3 py-3"
          >
            <p className="text-muted-foreground text-xs leading-relaxed">
              Phones and Google TV with Wireless debugging: on the device, open{' '}
              <span className="text-foreground">{FIX.pairWithCode.path}</span>. Type the address,
              port and code it shows, then connect with the port shown on the Wireless debugging
              screen itself.
            </p>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-3">
              <Field
                id={ids.pairAddress}
                label="IP address & port"
                error={fieldError('pairAddress')}
              >
                <Input
                  {...fieldProps(ids.pairAddress, fieldError('pairAddress'), false)}
                  name="wifi-pair-address"
                  inputMode="url"
                  placeholder="192.168.1.20:37099"
                  className="font-mono"
                  value={pairAddress}
                  onChange={(e) => {
                    setPairAddress(e.target.value)
                    if (errors.pairAddress) setErrors((all) => ({ ...all, pairAddress: null }))
                  }}
                />
              </Field>
              <Field id={ids.code} label="Pairing code" error={fieldError('code')}>
                <Input
                  {...fieldProps(ids.code, fieldError('code'), false)}
                  name="wifi-pair-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  placeholder="123456"
                  className="font-mono tracking-widest"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    if (errors.code) setErrors((all) => ({ ...all, code: null }))
                  }}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="outline"
              aria-disabled={running || undefined}
              className="aria-disabled:opacity-50"
            >
              {running && attempt.kind === 'pair' ? (
                <>
                  <Loader2 className="animate-spin" /> Pairing…
                </>
              ) : (
                'Pair'
              )}
            </Button>
          </form>
        </details>

        <details className="group rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2.5 text-sm font-medium">
            How to turn it on
            <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-2 border-t px-3 py-3">
            <PathFix fix={FIX.tvNetworkDebugging} />
            <PathFix fix={FIX.phoneWirelessDebugging} />
            <p className="text-xs leading-relaxed">
              <span className="text-foreground font-medium">Network:</span>{' '}
              <span className="text-muted-foreground">
                The device and this computer must be on the same Wi‑Fi.
              </span>
            </p>
            <PathFix fix={ALLOW_DEBUGGING} />
          </div>
        </details>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg [&>*]:min-w-0"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e) => {
          if (!opener.current?.isConnected) return
          e.preventDefault()
          opener.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Connect over Wi‑Fi</DialogTitle>
          <DialogDescription>
            An Android TV or phone on the same Wi‑Fi as this computer, through the local helper.
            Details, screenshots and the log work over Wi‑Fi.
          </DialogDescription>
        </DialogHeader>

        {/* Progress and results, spoken once each: the rows themselves stay quiet. */}
        <p role="status" aria-live="polite" className="sr-only">
          {wifiAnnouncement(rows, attempt?.state ?? null)}
        </p>

        {body}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              close(false)
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What the live region says: the progress row that changed last, in its own words. */
export function wifiAnnouncement(
  rows: readonly CheckItem[],
  state: 'running' | 'ok' | 'failed' | null,
): string {
  if (state === null) return ''
  const local = rows.find((r) => r.id === 'wifi.localNetwork')
  if (state === 'failed' && local) return local.sentence
  const reach = rows.find((r) => r.id === 'wifi.reachable')
  const auth = rows.find((r) => r.id === 'wifi.authorized')
  if (state === 'ok' && auth && auth.status !== 'unchecked') return auth.sentence
  return reach?.sentence ?? ''
}
