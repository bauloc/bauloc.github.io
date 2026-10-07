/*
  A fake adb server: Google's host protocol on 127.0.0.1, in this process, on a port the test
  picks (or 0). It answers what the Android lane may send — host:version, track-devices-l,
  devices-l, reconnect-offline, host:transport:<serial>, host:features, the exec: commands and
  the adb tunnel's device services (§4.10) — the way the
  real server does, including its FAIL texts, so the lane is tested against the wire and not
  against itself. No adb binary and no real server are ever involved.

  The test drives it: setDevices() pushes a new list to every tracker (as a hot-plug does),
  `exec` answers commands per serial, and close() is the server dying. Every service string
  received is recorded, so a test can assert that only allowlisted constants were sent.

  It also plays a small local network (§4.7): addNetworkDevice() puts a TV or phone at an
  address, and host:connect:, host:pair: and host:disconnect: answer with adb 36's texts. A
  device that has not allowed this Mac is listed `unauthorized` and its connect answers
  "failed to authenticate to X", as adb 36 does; accept() (the tester chose Allow on the TV)
  makes it `device`, refuse() leaves it there, and drop() is the TV leaving the Wi-Fi: `offline` at once,
  gone from the list a moment later, its logcat left hanging as a dead TCP link would.
*/
import net, { type AddressInfo, type Socket } from 'node:net'

export interface FakeAdbDevice {
  serial: string
  /** adb's state word, or a whole `no permissions (…)` sentence. */
  state: string
  /** Everything after the state, as the server prints it: ` usb:1-1 product:… transport_id:3`. */
  props?: string
}

/** What one exec: answers: bytes then EOF, a function that writes and ends, or FAIL text. */
export type ExecAnswer =
  string | Buffer | { fail: string } | { hang: true } | ((socket: Socket) => void)

/** A device on the fake network: what host:connect: and host:pair: find at an address. */
export interface FakeNetworkDevice {
  /** Where host:connect: reaches it, as adb writes it: `192.168.1.20:5555`. */
  address: string
  /** The tracker's properties once it allows this Mac: ` product:… model:… device:…`. */
  props: string
  /**
   * Wireless debugging (Android 11+): host:connect: answers "failed to authenticate" until a
   * host:pair: to `address` with `code` succeeded.
   */
  pairing?: { address: string; code: string }
  /** It allowed this Mac's key before: listed as `device` straight away. */
  allowed?: boolean
}

/** How one host:connect: answers instead of the network's own answer. */
export type ConnectAnswer = string | { fail: string } | { hang: true }

export interface FakeAdbServer {
  readonly port: number
  /** Every request payload, in order (`host:version`, `host:transport:X`, `exec:getprop`…). */
  readonly services: string[]
  /** Replace the device list; every tracker gets it at once. */
  readonly setDevices: (devices: FakeAdbDevice[]) => void
  /** How exec:<cmd> on <serial> answers; undefined → FAIL "closed". */
  exec: (serial: string, cmd: string) => ExecAnswer | undefined
  /**
   * How any other device service on <serial> answers (`shell,v2,raw:…`, `sync:`, `abb_exec:…`,
   * the adb tunnel's, §4.10); undefined → FAIL "closed".
   */
  service: (serial: string, service: string) => ExecAnswer | undefined
  /** `host:features` after host:transport:<serial>: the device's comma-separated features. */
  features: (serial: string) => string
  /** Answer track-devices-l with FAIL, as a server without the tracker would. */
  failTrack: boolean
  /**
   * What host:mdns:services answers (§4.8): the server's own mDNS list, one
   * `<instance>\t<service>\t<address>:<port>` line per service, or a FAIL. '' by default.
   */
  mdnsServices: string | { fail: string }
  /** Requests never answered (a hung server). */
  readonly hang: Set<string>
  /** Put a device on the fake network (§4.7); it is listed only once something connects. */
  readonly addNetworkDevice: (device: FakeNetworkDevice) => void
  /** Overrides host:connect: for one address: a refusal text, a FAIL, or no answer at all. */
  connectAnswer: (address: string) => ConnectAnswer | undefined
  /**
   * host:disconnect: as the real server does it: the tracker lists the device `offline` (before
   * the answer), and drops it this many ms later. null: dropped at once.
   */
  disconnectLingerMs: number | null
  /** The tester chose Allow on the device: `unauthorized` → `device`, remembered. */
  readonly accept: (serial: string) => void
  /** The tester chose Deny: it stays `unauthorized`. */
  readonly refuse: (serial: string) => void
  /**
   * The device left the Wi-Fi: `offline` now, gone from the list after `awayMs`. Its open
   * exec: streams stay open and silent, unless `closeStreams`.
   */
  readonly drop: (serial: string, opts?: { awayMs?: number; closeStreams?: boolean }) => void
  /** Open trackers and open exec: streams right now. */
  readonly trackers: () => number
  readonly streams: () => number
  /** The server dies: listener closed, every socket destroyed. */
  readonly close: () => Promise<void>
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0')

/** `OKAY` + length + payload: how host services carry their answer. */
function okayWith(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  return Buffer.concat([Buffer.from('OKAY' + hex4(body.length)), body])
}

function fail(message: string): Buffer {
  const body = Buffer.from(message, 'utf8')
  return Buffer.concat([Buffer.from('FAIL' + hex4(body.length)), body])
}

/** The devices -l text the server sends: serial padded to 22, state, properties. */
export function devicesText(devices: readonly FakeAdbDevice[]): string {
  return devices.map((d) => `${d.serial.padEnd(22)} ${d.state}${d.props ?? ''}\n`).join('')
}

/** The real server's refusals after host:transport:, by state (adb 36). */
function transportRefusal(device: FakeAdbDevice | undefined, serial: string): string | null {
  if (!device) return `device '${serial}' not found`
  if (device.state === 'unauthorized') {
    return "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\nTry 'adb kill-server' if that seems wrong.\nOtherwise check for a confirmation dialog on your device."
  }
  if (device.state === 'offline') return 'device offline'
  if (device.state === 'authorizing') return 'device still authorizing'
  if (device.state === 'connecting') return 'device still connecting'
  if (device.state !== 'device') return `device '${serial}' not found`
  return null
}

export async function createFakeAdbServer(opts: { port?: number } = {}): Promise<FakeAdbServer> {
  const sockets = new Set<Socket>()
  const trackers = new Set<Socket>()
  /** Open exec: streams, by the serial they run on. */
  const streams = new Map<Socket, string>()
  const services: string[] = []
  const hang = new Set<string>()
  let devices: FakeAdbDevice[] = []
  /** What host:connect: added: listed after `devices`, kept when setDevices() replaces those. */
  let connected: FakeAdbDevice[] = []
  const network = new Map<string, FakeNetworkDevice & { paired: boolean }>()
  let transportId = 100
  const timers = new Set<NodeJS.Timeout>()

  const all = (): FakeAdbDevice[] => [...devices, ...connected]
  const push = (): void => {
    const body = Buffer.from(devicesText(all()), 'utf8')
    for (const socket of trackers)
      socket.write(Buffer.concat([Buffer.from(hex4(body.length)), body]))
  }
  const listedProps = (device: FakeNetworkDevice, allowed: boolean, id: number): string =>
    allowed ? `${device.props} transport_id:${String(id)}` : ` transport_id:${String(id)}`

  /** adb 36's answers to the three Wi-Fi services: OKAY with a sentence, mostly. */
  const connect = (address: string): Buffer | null => {
    const override = fake.connectAnswer(address)
    if (override !== undefined) {
      if (typeof override === 'string') return okayWith(override)
      if ('fail' in override) return fail(override.fail)
      return null
    }
    const device = network.get(address)
    if (!device) return okayWith(`failed to connect to '${address}': Connection refused`)
    if (device.pairing && !device.paired) return okayWith(`failed to authenticate to ${address}`)
    if (connected.some((d) => d.serial === address)) {
      return okayWith(`already connected to ${address}`)
    }
    const id = transportId++
    const allowed = device.allowed ?? false
    connected.push({
      serial: address,
      state: allowed ? 'device' : 'unauthorized',
      props: listedProps(device, allowed, id),
    })
    push()
    /**
     * adb 36 registers the transport either way, but answers EPERM for one that is still
     * unauthorized: the TV now asks "Allow debugging?", and the reply reads as a failure.
     */
    return okayWith(allowed ? `connected to ${address}` : `failed to authenticate to ${address}`)
  }
  const pair = (code: string, address: string): Buffer => {
    const device = [...network.values()].find((d) => d.pairing?.address === address)
    if (!device?.pairing) return okayWith('Failed: Unable to start pairing client.')
    if (device.pairing.code !== code) {
      return okayWith('Failed: Wrong password or connection was dropped.')
    }
    device.paired = true
    return okayWith(
      `Successfully paired to ${address} [guid=adb-FAKE${String(transportId)}-AbCdEf]`,
    )
  }
  const closeStreams = (serial: string): void => {
    for (const [socket, on] of streams) if (on === serial) socket.destroy()
  }
  const disconnect = (serial: string): Buffer => {
    const listed = connected.find((d) => d.serial === serial)
    if (!listed) return fail(`no such device '${serial}'`)
    closeStreams(serial)
    if (fake.disconnectLingerMs === null) {
      connected = connected.filter((d) => d !== listed)
      push()
      return okayWith(`disconnected ${serial}`)
    }
    listed.state = 'offline'
    listed.props = (listed.props ?? '').replace(/ (?:product|model|device):\S+/g, '')
    push()
    const timer = setTimeout(() => {
      timers.delete(timer)
      connected = connected.filter((d) => d !== listed)
      push()
    }, fake.disconnectLingerMs)
    timers.add(timer)
    return okayWith(`disconnected ${serial}`)
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      trackers.delete(socket)
      streams.delete(socket)
    })
    socket.on('error', () => undefined)
    let buffered = Buffer.alloc(0)
    /** After host:transport:, the next request on this socket is the device service. */
    let transport: string | null = null
    let busy = false

    const handle = (service: string): void => {
      services.push(service)
      if (hang.has(service)) {
        busy = true
        return
      }
      if (service === 'host:version') return void socket.end(okayWith('0029'))
      if (service === 'host:devices-l') return void socket.end(okayWith(devicesText(all())))
      if (service === 'host:reconnect-offline') return void socket.end(okayWith('done'))
      if (service === 'host:mdns:services') {
        const list = fake.mdnsServices
        return void socket.end(typeof list === 'string' ? okayWith(list) : fail(list.fail))
      }
      if (service === 'host:track-devices-l') {
        if (fake.failTrack) return void socket.end(fail('unknown host service'))
        trackers.add(socket)
        socket.write(okayWith(devicesText(all())))
        busy = true
        return
      }
      if (service.startsWith('host:connect:')) {
        const answer = connect(service.slice('host:connect:'.length))
        busy = true
        if (answer) socket.end(answer)
        return
      }
      const pairing = /^host:pair:(\d{6}):(.+)$/.exec(service)
      if (pairing?.[1] && pairing[2]) return void socket.end(pair(pairing[1], pairing[2]))
      if (service.startsWith('host:disconnect:')) {
        return void socket.end(disconnect(service.slice('host:disconnect:'.length)))
      }
      if (service.startsWith('host:transport:')) {
        const serial = service.slice('host:transport:'.length)
        const refusal = transportRefusal(
          all().find((d) => d.serial === serial),
          serial,
        )
        if (refusal) return void socket.end(fail(refusal))
        transport = serial
        socket.write('OKAY')
        return
      }
      if (transport && service === 'host:features') {
        return void socket.end(okayWith(fake.features(transport)))
      }
      if (transport && !service.startsWith('host')) {
        busy = true
        const answer = service.startsWith('exec:')
          ? fake.exec(transport, service.slice('exec:'.length))
          : fake.service(transport, service)
        if (answer === undefined) return void socket.end(fail('closed'))
        if (typeof answer === 'string' || Buffer.isBuffer(answer)) {
          socket.write('OKAY')
          return void socket.end(answer)
        }
        if (typeof answer === 'function') {
          socket.write('OKAY')
          streams.set(socket, transport)
          return answer(socket)
        }
        if ('fail' in answer) return void socket.end(fail(answer.fail))
        return
      }
      socket.end(fail('unknown host service'))
    }

    socket.on('data', (chunk: Buffer) => {
      if (busy) return
      buffered = Buffer.concat([buffered, chunk])
      while (!busy && buffered.length >= 4) {
        const length = parseInt(buffered.subarray(0, 4).toString('latin1'), 16)
        if (Number.isNaN(length)) return void socket.destroy()
        if (buffered.length < 4 + length) return
        const service = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        handle(service)
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  const fake: FakeAdbServer = {
    port,
    services,
    setDevices(list) {
      devices = list.map((d) => ({ ...d }))
      push()
    },
    addNetworkDevice(device) {
      network.set(device.address, { ...device, paired: false })
    },
    connectAnswer: () => undefined,
    disconnectLingerMs: null,
    accept(serial) {
      const listed = connected.find((d) => d.serial === serial)
      const device = network.get(serial)
      if (!listed || !device) return
      device.allowed = true
      const id = transportId++
      listed.state = 'device'
      listed.props = listedProps(device, true, id)
      push()
    },
    refuse(serial) {
      if (connected.some((d) => d.serial === serial)) push()
    },
    drop(serial, o = {}) {
      const listed = connected.find((d) => d.serial === serial)
      if (!listed) return
      listed.state = 'offline'
      listed.props = (listed.props ?? '').replace(/ (?:product|model|device):\S+/g, '')
      if (o.closeStreams) closeStreams(serial)
      push()
      const timer = setTimeout(() => {
        timers.delete(timer)
        connected = connected.filter((d) => d !== listed)
        push()
      }, o.awayMs ?? 200)
      timers.add(timer)
    },
    exec: () => undefined,
    service: () => undefined,
    features: () => 'shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,abb_exec,sendrecv_v2',
    failTrack: false,
    mdnsServices: '',
    hang,
    trackers: () => trackers.size,
    streams: () => streams.size,
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
    },
  }
  return fake
}

/** A Pixel 9 as the tracker lists it over USB. */
export function pixel(state = 'device', transportId = 3): FakeAdbDevice {
  return {
    serial: '55090DLAQ0026D',
    state,
    props: ` usb:1-1 product:tokay model:Pixel_9 device:tokay transport_id:${String(transportId)}`,
  }
}

/**
 * logcat as adbd streams it: `history` lines at once (-T 200), then one line every
 * `intervalMs` until the client closes the socket. `onClose` sees the stream end.
 */
export function endlessLogcat(
  opts: { history?: number; intervalMs?: number; onClose?: () => void } = {},
): (socket: Socket) => void {
  return (socket) => {
    const line = (n: number): string =>
      `10-04 08:41:02.${String(n % 1000).padStart(3, '0')}  1234  5678 I ActivityManager: line ${String(n)}\n`
    let n = 0
    let text = ''
    for (; n < (opts.history ?? 200); n++) text += line(n)
    socket.write(text)
    const timer = setInterval(() => {
      if (!socket.destroyed) socket.write(line(n++))
    }, opts.intervalMs ?? 20)
    socket.on('close', () => {
      clearInterval(timer)
      opts.onClose?.()
    })
  }
}

/** An NVIDIA SHIELD with Network debugging on, as `adb connect` finds it on port 5555. */
export function shield(host = '192.168.1.20'): FakeNetworkDevice {
  return {
    address: `${host}:5555`,
    props: ' product:mdarcy model:SHIELD_Android_TV device:mdarcy',
  }
}
