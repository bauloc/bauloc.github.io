import type { Adb } from '@yume-chan/adb'

import { androidError, assertDevicePath, runBytes, shellCmd, type RunBytesResult } from './shell'

/*
  Reading files off the phone. Read-only, every function here: nothing is written, created or
  touched on the device.

  Whole files go over the sync protocol, one AdbSync per transfer. Cancelling a sync read does
  NOT stop it: Tango drains the rest of the file so the socket stays usable, which for a 5 MB
  photo is the whole photo. Closing the AdbSync (dispose) is what stops it, so an abort disposes,
  and the AdbSync is never reused afterwards.

  Slices of a file (the APK label and icon reader needs a few hundred KB out of a 30 MB APK) go
  over the shell instead, with `dd` on whole blocks, because sync RECV cannot seek.
*/

/** A sync entry's type field: S_IFDIR and S_IFREG, shifted (LinuxFileType in Tango). */
const DIRECTORY = 0o04
const FILE = 0o10

export interface DirEntry {
  readonly name: string
  readonly size: number
  /** Epoch ms. */
  readonly modified: number
  readonly isDirectory: boolean
  readonly isFile: boolean
}

/**
 * A folder's entries, without `.` and `..`. A folder that does not exist (or cannot be read)
 * comes back empty, as adbd answers it: no error.
 */
export async function listDirectory(adb: Adb, path: string): Promise<DirEntry[]> {
  assertDevicePath(path)
  const sync = await adb.sync()
  try {
    const entries = await sync.readdir(path)
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({
        name: e.name,
        size: Number(e.size),
        modified: Number(e.mtime) * 1000,
        isDirectory: e.type === DIRECTORY,
        isFile: e.type === FILE,
      }))
  } finally {
    await sync.dispose()
  }
}

/** Each path's size in bytes, null where it cannot be read. One AdbSync for the lot. */
export async function fileSizes(adb: Adb, paths: readonly string[]): Promise<(number | null)[]> {
  const sync = await adb.sync()
  try {
    const sizes: (number | null)[] = []
    for (const path of paths) {
      sizes.push(
        await sync.lstat(assertDevicePath(path)).then(
          (stat) => Number(stat.size),
          () => null,
        ),
      )
    }
    return sizes
  } finally {
    await sync.dispose()
  }
}

export interface PullOptions {
  readonly signal?: AbortSignal
  /** Refuse files larger than this, before or while reading them. */
  readonly maxBytes?: number
  /** Bytes so far, and the size when the phone reported one. */
  readonly onProgress?: (received: number, total: number | null) => void
}

/**
 * One whole file. Rejects with the signal's reason on abort, with `FILE_TOO_LARGE` past
 * `maxBytes`, and with the phone's own error (a missing file, say) otherwise.
 */
export async function pullFile(
  adb: Adb,
  path: string,
  options: PullOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { chunks, received } = await readWhole(adb, path, options)
  const out = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/**
 * One whole file as a Blob, as pullFile rejects. The chunks go into the Blob as they are, so a
 * large file (an APK, a video) is not copied a second time inside the tab.
 */
export async function pullBlob(
  adb: Adb,
  path: string,
  type: string,
  options: PullOptions = {},
): Promise<Blob> {
  const { chunks } = await readWhole(adb, path, options)
  return new Blob(chunks, { type })
}

async function readWhole(
  adb: Adb,
  path: string,
  options: PullOptions,
): Promise<{ chunks: Uint8Array<ArrayBuffer>[]; received: number }> {
  const { signal, maxBytes = Infinity, onProgress } = options
  assertDevicePath(path)
  signal?.throwIfAborted()
  const sync = await adb.sync()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    void sync.dispose().catch(() => undefined)
  }
  signal?.addEventListener('abort', dispose, { once: true })
  try {
    const total = await sync.lstat(path).then(
      (stat) => Number(stat.size),
      () => null,
    )
    if (total !== null && total > maxBytes) throw androidError('FILE_TOO_LARGE')
    const reader = sync.read(path).getReader()
    // Each chunk is a fresh buffer off the USB transfer, never a shared one.
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        received += value.byteLength
        if (received > maxBytes) throw androidError('FILE_TOO_LARGE')
        chunks.push(value as Uint8Array<ArrayBuffer>)
        onProgress?.(received, total)
      }
    } finally {
      reader.releaseLock()
    }
    return { chunks, received }
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', dispose)
    // Also on an early exit (too large): disposing is the only way to stop the transfer.
    dispose()
  }
}

/** dd's block size for slices: a page, so a slice costs at most two pages more than it asks. */
export const RANGE_BLOCK = 4096

/**
 * The whole blocks of `block` bytes that cover `length` bytes from `offset`: dd's `skip` and
 * `count`, and where the range starts inside what dd sends back.
 */
export function blockRange(
  offset: number,
  length: number,
  block = RANGE_BLOCK,
): { skip: number; count: number; from: number } {
  const from = offset % block
  return { skip: (offset - from) / block, count: Math.ceil((from + length) / block), from }
}

/**
 * `length` bytes of a file from `offset`, over the shell. Fewer bytes come back only at the end
 * of the file.
 *
 * `dd` on whole blocks, cut to the range here, and not `tail -c +N | head -c M`: toybox only
 * gained `head -c` in 0.7.5 (late 2017), after Android 7.x and 8.0 shipped, and both are
 * supported phones. Every Android 7+ has a dd that knows if=, bs=, skip= and count=, and seeks
 * to `skip` on a plain file. Its record counts go to stderr, which the exec: route (no shell
 * protocol) would mix into the bytes, hence the 2>/dev/null; dd's exit code still reports a
 * failed read.
 */
export async function readFileRange(
  adb: Adb,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) {
    throw androidError('INVALID_ARGUMENT')
  }
  const { skip, count, from } = blockRange(offset, length)
  const result: RunBytesResult = await runBytes(
    adb,
    shellCmd`dd if=${assertDevicePath(path)} bs=${RANGE_BLOCK} skip=${skip} count=${count} 2>/dev/null`,
  )
  if (result.exitCode !== null && result.exitCode !== 0) {
    const said = result.stderr.trim()
    throw said ? new Error(said) : androidError('FILE_READ_FAILED')
  }
  return result.stdout.subarray(from, from + length)
}

/**
 * A file on the phone, readable in slices: the shape of the archive readers' ByteSource, so an
 * installed app's base.apk (and its splits) go straight into the APK badge reader.
 */
export interface DeviceFile {
  readonly path: string
  readonly size: number
  /** `length` bytes from `offset`; fewer only at the end of the file. */
  readonly read: (offset: number, length: number) => Promise<Uint8Array>
}

/** Opens a file for reading in slices: one lstat for its size, then a `dd` per read. */
export async function openDeviceFile(adb: Adb, path: string): Promise<DeviceFile> {
  const [size] = await fileSizes(adb, [assertDevicePath(path)])
  if (size == null) throw androidError('FILE_READ_FAILED')
  return {
    path,
    size,
    read: (offset, length) => {
      const n = Math.min(length, size - offset)
      return n > 0 ? readFileRange(adb, path, offset, n) : Promise.resolve(new Uint8Array())
    },
  }
}
