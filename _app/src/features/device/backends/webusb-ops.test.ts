import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  fakeAdb,
  fakePart,
  type FakeAnswer,
  type FakeCall,
  type FakePhone,
} from './android/fake-adb'
import {
  CONTENT_ROWS,
  DUMPSYS_PACKAGE,
  PM_LIST_SYSTEM,
  PM_LIST_USER,
  PM_OUTPUT,
  RESOLVE_ONE,
} from './android/fixtures'
import { THUMBNAIL_DIR } from './android/media'
import { readApkBadge, splitNameOf } from './archive/apk-badge'
import type { InstallPlan } from './archive/plan'
import { bytesSource } from './archive/zip'
import type { InstallProgress } from './backend'
import {
  createAndroidOps,
  defaultStore,
  limiter,
  openSessions,
  type KeyValueStore,
} from './webusb-ops'

/*
  The WebUSB lane's Android operations over a scripted phone (android/fake-adb.ts): the exact
  commands that would cross the cable, what comes back, and the rules the plan puts on them.
  No USB, no adb.
*/

const SERIAL = '55090DLAQ0026D'
const SESSION = 1234567

/** localStorage, in memory. */
function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

/** One phone and the operations over it; `store` is shared when two tabs are being played. */
function phone(script: FakePhone = {}, sdk: number | null = 37, store = memoryStore()) {
  const fake = fakeAdb(script)
  let alive = true
  const ops = createAndroidOps(
    (id) => {
      if (id !== 'p') throw new Error('DEVICE_NOT_READY')
      return { adb: fake.adb, serial: SERIAL, sdk, alive: () => alive }
    },
    { store },
  )
  return {
    ...fake,
    ops,
    store,
    unplug: () => {
      alive = false
    },
    commands: () => fake.calls.map((c) => c.command),
  }
}

/** A package manager that installs whatever it is sent. */
function packageManager(call: FakeCall): FakeAnswer | undefined {
  const c = call.command.replace(/^cmd /, '')
  if (c.startsWith('package install-create')) return { stdout: PM_OUTPUT.created }
  const write = /^package install-write -S (\d+) /.exec(c)
  if (write) {
    const size = Number(write[1])
    return { stdout: `Success: streamed ${String(size)} bytes\n`, readStdin: size }
  }
  if (c.includes('install-commit')) return { stdout: PM_OUTPUT.success }
  if (c.startsWith('package install-abandon')) return { stdout: PM_OUTPUT.success }
  return undefined
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

function planOf(
  parts: { size: number; open: () => ReadableStream<Uint8Array> }[],
  testOnly = false,
): InstallPlan {
  return {
    kind: 'apk',
    inputs: [],
    app: { testOnly } as InstallPlan['app'],
    parts: parts.map((p, i) => ({
      name: `${String(i)}.apk`,
      source: `${String(i)}.apk`,
      split: '',
      role: { module: 'base', kind: 'base', value: '' },
      size: p.size,
      open: () => Promise.resolve(p.open()),
    })),
    totalBytes: parts.reduce((sum, p) => sum + p.size, 0),
    selection: null,
    expansions: [],
    problems: [],
    warnings: [],
    notes: [],
  } as unknown as InstallPlan
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

describe('install', () => {
  it('streams every part into one session, reports phases and bytes, and forgets the session once committed', async () => {
    const p = phone({ answer: packageManager })
    const events: InstallProgress[] = []
    const sessionsDuring: number[][] = []
    const outcome = await p.ops.install(
      'p',
      planOf([fakePart(bytes(5000)), fakePart(bytes(3000))], true),
      { grantPermissions: true },
      (e) => {
        events.push(e)
        sessionsDuring.push(openSessions(p.store).list(SERIAL))
      },
      new AbortController().signal,
    )
    expect(outcome).toMatchObject({ ok: true, warnings: [] })
    expect(p.calls.filter((c) => c.via === 'abb_exec').map((c) => c.command)).toEqual([
      'package install-create -r -t -g -S 8000',
      `package install-write -S 5000 ${String(SESSION)} 0.apk -`,
      `package install-write -S 3000 ${String(SESSION)} 1.apk -`,
      `package install-commit ${String(SESSION)}`,
    ])
    expect(events[0]).toEqual({ phase: 'sending', sent: 0, total: 8000 })
    expect(events.at(-2)).toEqual({ phase: 'sending', sent: 8000, total: 8000 })
    expect(events.at(-1)).toEqual({ phase: 'installing', sent: 8000, total: 8000 })
    // Remembered while open, so a pulled cable can be cleaned up on reconnect; gone after.
    expect(sessionsDuring.at(-1)).toEqual([SESSION])
    expect(openSessions(p.store).list(SERIAL)).toEqual([])
  })

  it('refuses a phone older than Android 7.0, and a plan with problems, before any command', async () => {
    const old = phone({ answer: packageManager }, 23)
    const signal = new AbortController().signal
    await expect(
      old.ops.install('p', planOf([fakePart(bytes(10))]), {}, () => undefined, signal),
    ).rejects.toThrow('INSTALL_UNSUPPORTED')
    const p = phone({ answer: packageManager })
    const blocked = {
      ...planOf([fakePart(bytes(10))]),
      problems: [{ code: 'NOT_APK', message: '' }],
    } as InstallPlan
    await expect(p.ops.install('p', blocked, {}, () => undefined, signal)).rejects.toThrow(
      'NOTHING_TO_INSTALL',
    )
    expect(old.calls.length + p.calls.length).toBe(0)
  })

  it('calls a transport failure after the phone went away CONNECTION_LOST, and rethrows it otherwise', async () => {
    const broken = () => ({
      size: 100,
      open: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('Transfer failed'))
          },
        }),
    })
    const gone = phone({ answer: packageManager })
    gone.unplug()
    const signal = new AbortController().signal
    const outcome = await gone.ops.install('p', planOf([broken()]), {}, () => undefined, signal)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'CONNECTION_LOST',
      params: { phase: 'sending' },
    })

    const here = phone({ answer: packageManager })
    await expect(
      here.ops.install('p', planOf([broken()]), {}, () => undefined, signal),
    ).rejects.toThrow('Transfer failed')
  })

  it('rejects with the abort on Cancel, after abandoning the session', async () => {
    const p = phone({
      answer: (call) =>
        call.command.includes('install-write') ? { hang: true } : packageManager(call),
    })
    const controller = new AbortController()
    const pending = p.ops.install(
      'p',
      planOf([fakePart(bytes(4000), 4)]),
      {},
      (e) => {
        if (e.sent > 0) controller.abort(new DOMException('Stopped', 'AbortError'))
      },
      controller.signal,
    )
    await expect(pending).rejects.toThrow('Stopped')
    expect(p.commands()).toContain(`package install-abandon ${String(SESSION)}`)
    expect(openSessions(p.store).list(SERIAL)).toEqual([])
  })

  it('abandons sessions a pulled cable left open, once the phone is back', async () => {
    const p = phone({ answer: packageManager })
    openSessions(p.store).add(SERIAL, 77)
    openSessions(p.store).add('another-phone', 88)
    await p.ops.abandonLeftovers('p')
    expect(p.commands()).toEqual(['package install-abandon 77'])
    expect(openSessions(p.store).list(SERIAL)).toEqual([])
    expect(openSessions(p.store).list('another-phone')).toEqual([88])
  })

  it('abandons a session left open by a tab that was closed mid-send, from the next tab', async () => {
    const store = memoryStore()
    // The first tab: install-write never ends, and the tab goes away without a Cancel.
    const first = phone(
      {
        answer: (call) =>
          call.command.includes('install-write') ? { hang: true } : packageManager(call),
      },
      37,
      store,
    )
    let sending!: () => void
    const started = new Promise<void>((resolve) => {
      sending = resolve
    })
    void first.ops.install(
      'p',
      planOf([fakePart(bytes(4000), 4)]),
      {},
      (e) => {
        if (e.sent > 0) sending()
      },
      new AbortController().signal,
    )
    await started
    expect(openSessions(store).list(SERIAL)).toEqual([SESSION])
    // A new tab, the same browser storage: the next connection cleans up.
    const next = phone({ answer: packageManager }, 37, store)
    await next.ops.abandonLeftovers('p')
    expect(next.commands()).toEqual([`package install-abandon ${String(SESSION)}`])
    expect(openSessions(store).list(SERIAL)).toEqual([])
  })

  it('keeps open sessions in localStorage, which outlives the tab, and copes without it', () => {
    const local = memoryStore()
    vi.stubGlobal('sessionStorage', memoryStore())
    vi.stubGlobal('localStorage', local)
    try {
      expect(defaultStore()).toBe(local)
      vi.stubGlobal('localStorage', undefined)
      expect(defaultStore()).toBeNull()
      // A sandboxed frame or blocked cookies: reading localStorage itself throws.
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError')
        },
      })
      expect(defaultStore()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})

describe('apps', () => {
  const lists = (call: FakeCall): FakeAnswer | undefined => {
    if (/list packages .* -3$/.test(call.command)) return { stdout: PM_LIST_USER }
    if (/list packages .* -s$/.test(call.command)) return { stdout: PM_LIST_SYSTEM }
    return undefined
  }

  it('lists by scope over `cmd package`, with names quoted and validated', async () => {
    const p = phone({ answer: lists })
    const rows = await p.ops.apps('p', 'user')
    expect(rows.map((r) => r.packageName).sort()).toEqual([
      'com.example.notes',
      'com.example.shop',
      'org.sample.reader',
    ])
    expect(p.commands()).toContain('cmd package list packages -f -i -U --show-versioncode -3')
    expect(rows.every((r) => !r.system)).toBe(true)
  })

  it('maps each action to its command', async () => {
    const p = phone({
      answer: (call) => {
        if (call.command.includes('resolve-activity')) return { stdout: RESOLVE_ONE }
        if (/^pm (uninstall|clear) /.test(call.command)) return { stdout: 'Success\n' }
        return undefined
      },
    })
    for (const action of ['launch', 'stop', 'info', 'clear', 'uninstall'] as const) {
      await p.ops.appAction('p', 'com.example.notes', action)
    }
    expect(p.commands()).toEqual([
      "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 'com.example.notes'",
      "am start -n 'com.example.notes/.MainActivity' -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
      "am force-stop 'com.example.notes'",
      "am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d 'package:com.example.notes'",
      "pm clear 'com.example.notes'",
      "pm uninstall 'com.example.notes'",
    ])
    await expect(p.ops.appAction('p', 'x;reboot', 'stop')).rejects.toThrow('INVALID_PACKAGE_NAME')
  })

  it('downloads the APKs `pm path` listed for an app it has read, and nothing else under /data', async () => {
    const dir = '/data/app/~~Qa1x==/com.example.notes-Zr2y=='
    const base = bytes(150_000)
    const p = phone({
      answer: (call) => {
        if (call.command.startsWith('dumpsys package ')) return { stdout: DUMPSYS_PACKAGE }
        if (call.command.startsWith('pm path ')) {
          return { stdout: `package:${dir}/base.apk\npackage:${dir}/split_config.xxhdpi.apk\n` }
        }
        return undefined
      },
      files: { [`${dir}/base.apk`]: base, [`${dir}/split_config.xxhdpi.apk`]: bytes(9_000) },
    })
    const progress = vi.fn<(sent: number, total: number) => void>()
    const signal = new AbortController().signal
    // Not before app() has listed it: a path alone proves nothing.
    await expect(p.ops.pull('p', `${dir}/base.apk`, progress, signal)).rejects.toThrow(
      'NOT_A_MEDIA_FILE',
    )
    const detail = await p.ops.app('p', 'com.example.notes')
    expect(detail.apks.map((a) => a.size)).toEqual([150_000, 9_000])
    const blob = await p.ops.pull('p', `${dir}/base.apk`, progress, signal)
    expect(blob.size).toBe(150_000)
    expect(blob.type).toBe('application/vnd.android.package-archive')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(base)
    expect(progress).toHaveBeenLastCalledWith(150_000, 150_000)
    await expect(p.ops.pull('p', `${dir}/oat/arm64/base.odex`, progress, signal)).rejects.toThrow(
      'NOT_A_MEDIA_FILE',
    )
    expect(p.syncs.every((s) => s.disposed)).toBe(true)
  })

  it('reads the facts the install checks need', async () => {
    const p = phone({
      answer: (call) => {
        if (call.command === 'df /data') {
          return {
            stdout:
              'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-48 114786388 27952736 86833652 25% /data\n',
          }
        }
        if (call.command.startsWith('dumpsys package ')) return { stdout: DUMPSYS_PACKAGE }
        if (call.command.startsWith('settings get global')) return { stdout: '1\n' }
        return undefined
      },
    })
    const facts = await p.ops.installFacts('p', 'com.example.notes')
    expect(facts).toMatchObject({
      sdk: 37,
      freeBytes: 86833652 * 1024,
      installed: {
        versionCode: expect.any(Number) as number,
        debuggable: expect.any(Boolean) as boolean,
      },
      verifyAdbInstalls: '1',
    })
    expect(await p.ops.installFacts('p', 'com.example.absent')).toMatchObject({ installed: null })
  })
})

describe('app badges', () => {
  const badge = new Uint8Array(
    readFileSync(new URL('./archive/__fixtures__/badge.apk', import.meta.url)),
  )
  const BASE = '/data/app/~~x==/com.bauloc.badgeprobe-y==/base.apk'
  /** A phone that answers `pm path` and `dd if=<file> bs= skip= count=` from real bytes. */
  const apkPhone = (): FakePhone => ({
    files: { [BASE]: badge },
    answer: (call) => {
      if (call.command.startsWith('pm path ')) return { stdout: `package:${BASE}\n` }
      const m = /^dd if='([^']+)' bs='(\d+)' skip='(\d+)' count='(\d+)' 2>\/dev\/null$/.exec(
        call.command,
      )
      if (m) {
        const [bs, skip, count] = [Number(m[2]), Number(m[3]), Number(m[4])]
        return { stdout: badge.slice(skip * bs, (skip + count) * bs) }
      }
      return undefined
    },
  })

  it('reads the label and icon from the installed APK, in slices, and caches the answer', async () => {
    const p = phone(apkPhone())
    const first = await p.ops.appBadge('p', 'com.bauloc.badgeprobe')
    // The phone's own language and screen, as the lane read them.
    const spec = await p.ops.deviceSpec('p')
    const direct = await readApkBadge(bytesSource(badge), [], {
      locales: spec.supportedLocales,
      density: spec.screenDensity,
      sdk: 37,
    })
    expect(first).toEqual({ label: direct.label, icon: direct.icon })
    expect(first.label).toBeTruthy()
    const reads = p.calls.length
    expect(await p.ops.appBadge('p', 'com.bauloc.badgeprobe')).toEqual(first)
    expect(p.calls.length).toBe(reads)
    expect(splitNameOf(BASE)).toBe('')
  })

  it('reads at most two apps at a time', async () => {
    const p = phone(apkPhone())
    let peak = 0
    let open = 0
    const original = p.adb.subprocess.shellProtocol
    const spawn = original?.spawn.bind(original)
    vi.spyOn(original!, 'spawn').mockImplementation(async (...args) => {
      if (/^pm path/.test(String(args[0]))) peak = Math.max(peak, ++open)
      const process = await spawn!(...args)
      void process.exited.finally(() => {
        if (/^pm path/.test(String(args[0]))) open--
      })
      return process
    })
    const names = ['com.a.one', 'com.a.two', 'com.a.three', 'com.a.four']
    await Promise.all(names.map((n) => p.ops.appBadge('p', n)))
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('images and previews', () => {
  const ORIGINAL = '/storage/emulated/0/DCIM/Camera/menu, final, v2=ok.jpg'
  const images = (): FakePhone => ({
    answer: (call) =>
      call.command.startsWith('content query') ? { stdout: CONTENT_ROWS } : undefined,
    dirs: { [THUMBNAIL_DIR]: [{ name: '1000012345.jpg', size: JPEG.byteLength }] },
    files: {
      [`${THUMBNAIL_DIR}/1000012345.jpg`]: JPEG,
      [ORIGINAL]: JPEG,
    },
  })

  it('previews from a thumbnail Android already made, else the original, and never asks MediaStore for one', async () => {
    const p = phone(images())
    const rows = await p.ops.images('p', { album: 'all', offset: 0, limit: 60 })
    expect(rows.map((r) => r.id)).toEqual(['1000012345', '1000012344', '1000012343'])
    const signal = new AbortController().signal

    const cached = await p.ops.thumbnail('p', '1000012345', signal)
    const original = await p.ops.thumbnail('p', '1000012344', signal)
    expect(cached.type).toBe('image/jpeg')
    expect(original.type).toBe('image/jpeg')
    expect(p.syncs.flatMap((s) => s.reads)).toEqual([`${THUMBNAIL_DIR}/1000012345.jpg`, ORIGINAL])
    // HEIC with no thumbnail: Chrome can't show the original, so there is no preview.
    await expect(p.ops.thumbnail('p', '1000012343', signal)).rejects.toThrow('PREVIEW_UNAVAILABLE')
    await expect(p.ops.thumbnail('p', '42', signal)).rejects.toThrow('PREVIEW_UNAVAILABLE')

    // The no-write rule: nothing that could make Android create a cache file.
    expect(
      p.commands().filter((c) => /content (read|call)|\/thumbnail|createThumbnail/.test(c)),
    ).toEqual([])
    expect(p.syncs.every((s) => s.disposed)).toBe(true)
  })

  /** A MediaStore with `count` images, newest first, answering pages by their offset. */
  const bigGallery = (count: number, refuseExpression = false): FakePhone => ({
    answer: (call) => {
      if (!call.command.startsWith('content query')) return undefined
      if (refuseExpression && call.command.includes('COALESCE')) {
        return { stderr: 'java.lang.IllegalArgumentException: Invalid token 1000\n' }
      }
      const offset = Number(/query-arg-offset:i:(\d+)/.exec(call.command)?.[1] ?? 0)
      const limit = Number(/query-arg-limit:i:(\d+)/.exec(call.command)?.[1] ?? 60)
      const lines: string[] = []
      for (let i = offset; i < Math.min(count, offset + limit); i++) {
        const id = String(2_000_000 - i)
        lines.push(
          `Row: ${String(i - offset)} _id=${id}, _display_name=${id}.jpg, relative_path=DCIM/Camera/, _size=8, datetaken=NULL, date_modified=1790000000, width=1, height=1, mime_type=image/jpeg, _data=/storage/emulated/0/DCIM/Camera/${id}.jpg`,
        )
      }
      return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : 'No result found.\n' }
    },
    files: { '/storage/emulated/0/DCIM/Camera/2000000.jpg': JPEG },
  })

  it('keeps every row of a long listing previewable, and forgets them on a new listing', async () => {
    const p = phone(bigGallery(6000))
    const signal = new AbortController().signal
    for (let offset = 0; offset < 6000; offset += 60) {
      await p.ops.images('p', { album: 'all', offset, limit: 60 })
    }
    // The very first tile, far behind 6,000 rows, scrolled back into view.
    expect((await p.ops.thumbnail('p', '2000000', signal)).type).toBe('image/jpeg')
    // A new first page (Refresh, another album) starts a new listing.
    await p.ops.images('p', { album: 'camera', offset: 0, limit: 1 })
    await expect(p.ops.thumbnail('p', '1999000', signal)).rejects.toThrow('PREVIEW_UNAVAILABLE')
    expect((await p.ops.thumbnail('p', '2000000', signal)).type).toBe('image/jpeg')
  })

  it('remembers which sort MediaStore took for the rest of the session', async () => {
    const p = phone(bigGallery(200, true))
    const sorts = () =>
      p
        .commands()
        .filter((c) => c.startsWith('content query'))
        .map((c) => (c.includes('COALESCE') ? 'shown' : 'taken'))
    await p.ops.images('p', { album: 'all', offset: 0, limit: 60 })
    await p.ops.images('p', { album: 'all', offset: 60, limit: 60 })
    await p.ops.images('p', { album: 'camera', offset: 0, limit: 60 })
    expect(sorts()).toEqual(['shown', 'taken', 'taken', 'taken'])
    // A new session asks again: the phone may have been updated.
    p.ops.reset('p')
    await p.ops.images('p', { album: 'all', offset: 0, limit: 60 })
    expect(sorts().slice(4)).toEqual(['shown', 'taken'])
  })

  it('lists the thumbnail folder once per tab load', async () => {
    const p = phone(images())
    const signal = new AbortController().signal
    await p.ops.images('p', { album: 'all', offset: 0, limit: 60 })
    await p.ops.thumbnail('p', '1000012345', signal)
    await p.ops.thumbnail('p', '1000012344', signal)
    const listings = () => p.syncs.filter((s) => s.reads.length === 0).length
    expect(listings()).toBe(1)
    await p.ops.images('p', { album: 'all', offset: 0, limit: 60 })
    await p.ops.thumbnail('p', '1000012345', signal)
    expect(listings()).toBe(2)
  })

  it('pages folder listings in the browser when MediaStore is not used', async () => {
    const p = phone({
      dirs: {
        '/sdcard/Pictures/Screenshots': [
          { name: 'a.png', size: 10, mtime: 300 },
          { name: 'b.png', size: 10, mtime: 200 },
          { name: '.pending-c.png', size: 10, mtime: 100 },
        ],
      },
    })
    const rows = await p.ops.images('p', {
      album: 'screenshots',
      offset: 1,
      limit: 5,
      folders: true,
    })
    expect(rows.map((r) => r.name)).toEqual(['b.png'])
    expect(p.commands()).toEqual([])
  })

  it('pulls a whole file from shared storage with progress, and nothing outside it', async () => {
    const photo = bytes(200_000)
    const p = phone({ files: { [ORIGINAL]: photo }, chunkSize: 64 * 1024 })
    const progress = vi.fn<(sent: number, total: number) => void>()
    const blob = await p.ops.pull('p', ORIGINAL, progress, new AbortController().signal)
    expect(blob.size).toBe(200_000)
    expect(blob.type).toBe('image/jpeg')
    expect(progress).toHaveBeenLastCalledWith(200_000, 200_000)
    await expect(
      p.ops.pull('p', '/data/data/com.example.notes/db', progress, new AbortController().signal),
    ).rejects.toThrow('NOT_A_MEDIA_FILE')
  })

  it('stops a pull by closing its sync connection', async () => {
    const p = phone({ files: { [ORIGINAL]: bytes(500_000) }, chunkSize: 16 * 1024 })
    const controller = new AbortController()
    const pending = p.ops.pull(
      'p',
      ORIGINAL,
      (sent) => {
        if (sent > 32 * 1024) controller.abort(new DOMException('Stopped', 'AbortError'))
      },
      controller.signal,
    )
    await expect(pending).rejects.toThrow('Stopped')
    expect(p.syncs.every((s) => s.disposed)).toBe(true)
  })
})

describe('device spec', () => {
  it('is collected once per session, and again after reset', async () => {
    const p = phone()
    await p.ops.deviceSpec('p')
    await p.ops.deviceSpec('p')
    const getprops = () => p.commands().filter((c) => c === 'getprop').length
    expect(getprops()).toBe(1)
    p.ops.reset('p')
    await p.ops.deviceSpec('p')
    expect(getprops()).toBe(2)
  })

  it('passes on DEVICE_NOT_READY for a device with no session', async () => {
    const p = phone()
    await expect(p.ops.deviceSpec('gone')).rejects.toThrow('DEVICE_NOT_READY')
    await expect(p.ops.appBadge('gone', 'com.example.notes')).rejects.toThrow('DEVICE_NOT_READY')
  })
})

describe('limiter', () => {
  it('runs at most n at once, in order, and drops a waiting task whose signal aborts', async () => {
    const run = limiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const releases: (() => void)[] = []
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        active++
        peak = Math.max(peak, active)
        order.push(n)
        releases.push(() => {
          active--
          resolve(n)
        })
      })
    const controller = new AbortController()
    const results = [run(task(1)), run(task(2)), run(task(3), controller.signal), run(task(4))]
    await Promise.resolve()
    controller.abort(new Error('scrolled away'))
    await expect(results[2]).rejects.toThrow('scrolled away')
    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await Promise.all([results[0], results[1], results[3]])).toEqual([1, 2, 4])
    expect(order).toEqual([1, 2, 4])
    expect(peak).toBe(2)
  })
})

describe('openSessions', () => {
  it('survives storage that is missing, full or holds garbage', () => {
    expect(openSessions(null).list(SERIAL)).toEqual([])
    const store = memoryStore()
    store.setItem('device-lab.open-install-sessions', '{not json')
    expect(openSessions(store).list(SERIAL)).toEqual([])
    const full: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    expect(() => {
      openSessions(full).add(SERIAL, 1)
    }).not.toThrow()
  })
})
