import { Adb, AdbBanner, type AdbSocket, type AdbTransport } from '@yume-chan/adb'
import { describe, expect, it } from 'vitest'

import { runInstall } from './pm'
import { run, shellCmd } from './shell'

/*
  The same functions over Tango's REAL Adb class: its shell-protocol framing, its exec: service
  and android-bin's own process wrapping all run as shipped. Only USB is replaced, by sockets
  that answer from a script. The other tests use a lighter fake; this one catches a Tango or
  android-bin upgrade that changes what goes over the wire.
*/

const encoder = new TextEncoder()

/** One shell-protocol packet: id, little-endian length, data. */
function packet(id: number, data: Uint8Array) {
  const out = new Uint8Array(5 + data.byteLength)
  out[0] = id
  new DataView(out.buffer).setUint32(1, data.byteLength, true)
  out.set(data, 5)
  return out
}

interface Reply {
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
  /** Answer once this many bytes came in (install-write -S). */
  readonly readStdin?: number
}

function phone(features: string[], reply: (service: string) => Reply) {
  const services: string[] = []
  const stdins = new Map<string, Uint8Array>()
  const connect = (service: string) => {
    services.push(service)
    const answer = reply(service)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let closed = false
    let markClosed!: () => void
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const close = () => {
      if (closed) return
      closed = true
      controller.close()
      markClosed()
    }
    let stdin = new Uint8Array()
    const respond = () => {
      if (closed || stdin.byteLength < (answer.readStdin ?? 0)) return
      if (service.startsWith('shell,v2,')) {
        controller.enqueue(packet(1, encoder.encode(answer.stdout)))
        controller.enqueue(packet(2, encoder.encode(answer.stderr ?? '')))
        controller.enqueue(packet(3, Uint8Array.of(answer.exitCode ?? 0)))
      } else {
        controller.enqueue(encoder.encode(answer.stdout + (answer.stderr ?? '')))
      }
      close()
    }
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const next = new Uint8Array(stdin.byteLength + chunk.byteLength)
        next.set(stdin)
        next.set(chunk, stdin.byteLength)
        stdin = next
        stdins.set(service, stdin)
        respond()
      },
    })
    queueMicrotask(respond)
    const socket = {
      service,
      readable,
      writable,
      closed: new Promise<undefined>((resolve) => {
        markClosed = () => {
          resolve(undefined)
        }
      }),
      close: () => {
        close()
        return Promise.resolve()
      },
    }
    return Promise.resolve(socket as unknown as AdbSocket)
  }
  const transport = {
    serial: 'TEST0001',
    maxPayloadSize: 1024 * 1024,
    banner: AdbBanner.parse(`device::features=${features.join(',')}`),
    disconnected: new Promise<void>(() => undefined),
    clientFeatures: ['shell_v2', 'cmd', 'abb_exec', 'stat_v2', 'ls_v2'],
    connect,
    addReverseTunnel: () => Promise.reject(new Error('not supported')),
    removeReverseTunnel: () => Promise.resolve(),
    clearReverseTunnels: () => Promise.resolve(),
    close: () => Promise.resolve(),
  } as unknown as AdbTransport
  return { adb: new Adb(transport), services, stdins }
}

describe("over Tango's real Adb", () => {
  it('runs a command over shell v2 exactly as built, and reads its framed answer', async () => {
    const { adb, services } = phone(['shell_v2', 'cmd'], () => ({
      stdout: 'package:/data/app/x/base.apk\n',
      stderr: 'warning\n',
      exitCode: 0,
    }))
    const result = await run(adb, shellCmd`pm path ${'com.example.notes'}`)
    expect(services).toEqual(["shell,v2,raw:pm path 'com.example.notes'"])
    expect(result).toEqual({
      stdout: 'package:/data/app/x/base.apk\n',
      stderr: 'warning\n',
      exitCode: 0,
    })
  })

  it('falls back to exec: on a phone without shell v2', async () => {
    const { adb, services } = phone([], () => ({ stdout: 'uid=2000(shell)\n' }))
    expect(await run(adb, shellCmd`id`)).toEqual({
      stdout: 'uid=2000(shell)\n',
      stderr: '',
      exitCode: null,
    })
    expect(services).toEqual(['exec:id'])
  })

  it("installs through android-bin's abb_exec transport, bare tokens and all", async () => {
    const apk = Uint8Array.from({ length: 5000 }, (_, i) => i % 256)
    const { adb, services, stdins } = phone(['shell_v2', 'cmd', 'abb_exec'], (service) => {
      if (service.includes('install-create'))
        return { stdout: 'Success: created install session [42]\n' }
      if (service.includes('install-write'))
        return { stdout: 'Success: streamed 5000 bytes\n', readStdin: 5000 }
      return { stdout: 'Success\n' }
    })
    const part = { size: apk.byteLength, open: () => new Blob([apk]).stream() }
    expect(await runInstall(adb, [part], { sdk: 37, allowTest: true })).toEqual({
      ok: true,
      warnings: [],
      output: 'Success',
    })
    expect(services).toEqual([
      'abb_exec:package\0install-create\0-r\0-t\0-S\x005000\0',
      'abb_exec:package\0install-write\0-S\x005000\x0042\x000.apk\0-\0',
      'abb_exec:package\0install-commit\x0042\0',
    ])
    expect(stdins.get(services[1] ?? '')).toEqual(apk)
  })
})
