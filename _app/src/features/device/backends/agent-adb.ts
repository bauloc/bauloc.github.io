import {
  ADB_SERVER_DEFAULT_FEATURES,
  Adb,
  AdbBanner,
  type AdbFeature,
  type AdbSocket,
  type AdbTransport,
} from '@yume-chan/adb'
import { MaybeConsumable, ReadableStream } from '@yume-chan/stream-extra'

import type { AdbTunnel } from '../helper/client'

/*
  The local helper's adb tunnel (spec §4.10) as an AdbTransport, so a device that only Google's
  adb server reaches — an Android TV on the Wi‑Fi, a phone the server holds — gets the very
  operations WebUSB runs (webusb-ops.ts: installs, apps, images), unchanged.

  It works the way ya-webadb's own AdbServerTransport does: every service is a new connection
  (here a WebSocket the helper pipes to `host:transport:<serial>` + the service), and the
  device's features come from the server (`host:features`), read once before the first one.

  Loaded on first use, with @yume-chan/adb, like the WebUSB lane's code: a tester who never
  opens an Android device through the helper never downloads it.
*/

/** One tunnel as an AdbSocket. */
export function tunnelSocket(service: string, tunnel: AdbTunnel): AdbSocket {
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<undefined>((resolve) => {
    resolveClosed = () => {
      resolve(undefined)
    }
  })
  void tunnel.closed.then(resolveClosed)

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      tunnel.read(
        (bytes) => {
          controller.enqueue(bytes)
        },
        () => {
          try {
            controller.close()
          } catch {
            // Already cancelled by its reader.
          }
        },
      )
    },
    cancel() {
      tunnel.close()
    },
  })

  // As over WebUSB, closing the writable doesn't close the socket: a service that reads its
  // input knows its length (`install-write -S`), and close() is what ends it.
  const writable = new MaybeConsumable.WritableStream<Uint8Array>({
    write: (chunk) => tunnel.write(chunk),
    abort: () => {
      tunnel.close()
    },
  })

  return {
    service,
    readable,
    writable,
    get closed() {
      return closed
    },
    close() {
      tunnel.close()
    },
  }
}

export interface TunnelTransportOptions {
  /** The device's adb serial, as the helper lists it. */
  readonly serial: string
  /** Its adbd features (GET /api/devices/:id/adb). */
  readonly features: readonly string[]
  /** Opens one service through the helper (HelperConnection api.openAdb). */
  readonly open: (service: string) => Promise<AdbTunnel>
}

/** Reverse tunnels would let the device reach this computer: the helper never opens one. */
const NO_REVERSE = 'Reverse tunnels are not available through the local helper.'

class TunnelTransport implements AdbTransport {
  readonly serial: string
  /** What ya-webadb's AdbServerTransport uses: the server splits packets itself. */
  readonly maxPayloadSize = 1024 * 1024
  readonly banner: AdbBanner
  readonly clientFeatures: readonly AdbFeature[] = ADB_SERVER_DEFAULT_FEATURES
  readonly disconnected: Promise<void>
  readonly #open: (service: string) => Promise<AdbTunnel>
  readonly #sockets = new Set<AdbSocket>()
  #closed = false
  #resolveDisconnected: () => void = () => undefined

  constructor(o: TunnelTransportOptions) {
    this.serial = o.serial
    this.banner = new AdbBanner('device', undefined, undefined, undefined, [
      ...o.features,
    ] as AdbFeature[])
    this.#open = o.open
    this.disconnected = new Promise<void>((resolve) => {
      this.#resolveDisconnected = resolve
    })
  }

  async connect(service: string): Promise<AdbSocket> {
    if (this.#closed) throw new Error('DEVICE_NOT_READY')
    const tunnel = await this.#open(service)
    if (this.#closed) {
      tunnel.close()
      throw new Error('DEVICE_NOT_READY')
    }
    const socket = tunnelSocket(service, tunnel)
    this.#sockets.add(socket)
    void socket.closed.then(() => this.#sockets.delete(socket))
    return socket
  }

  addReverseTunnel(): never {
    throw new Error(NO_REVERSE)
  }

  removeReverseTunnel(): never {
    throw new Error(NO_REVERSE)
  }

  clearReverseTunnels(): void {
    // None was ever added.
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const socket of this.#sockets) void socket.close()
    this.#sockets.clear()
    this.#resolveDisconnected()
  }
}

/** An Adb over the helper's tunnel. close() ends every service it has open. */
export function createTunnelAdb(o: TunnelTransportOptions): Adb {
  return new Adb(new TunnelTransport(o))
}
