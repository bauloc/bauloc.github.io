import { describe, expect, it } from 'vitest'

import { fakeAdb } from './fake-adb'
import {
  blockRange,
  fileSizes,
  listDirectory,
  openDeviceFile,
  pullFile,
  readFileRange,
} from './files'

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

describe('listDirectory', () => {
  it('lists a folder without . and .., with sizes and times in ms', async () => {
    const { adb, syncs } = fakeAdb({
      dirs: {
        '/sdcard/Download': [
          { name: 'a.jpg', size: 10, mtime: 1790000000 },
          { name: 'sub', size: 4096, dir: true },
        ],
      },
    })
    expect(await listDirectory(adb, '/sdcard/Download')).toEqual([
      { name: 'a.jpg', size: 10, modified: 1790000000000, isDirectory: false, isFile: true },
      { name: 'sub', size: 4096, modified: 0, isDirectory: true, isFile: false },
    ])
    expect(syncs[0]?.disposed).toBe(true)
  })

  it('answers an empty list for a folder that is not there, as adbd does', async () => {
    expect(await listDirectory(fakeAdb().adb, '/sdcard/Nope')).toEqual([])
  })
})

describe('fileSizes', () => {
  it('sizes each path with one sync session, null where unreadable', async () => {
    const { adb, syncs } = fakeAdb({ files: { '/data/app/x/base.apk': bytes(300) } })
    expect(await fileSizes(adb, ['/data/app/x/base.apk', '/data/app/x/split.apk'])).toEqual([
      300,
      null,
    ])
    expect(syncs).toHaveLength(1)
  })
})

describe('pullFile', () => {
  it('reads a whole file, reporting progress against its size', async () => {
    const file = bytes(10_000)
    const { adb, syncs } = fakeAdb({ files: { '/sdcard/DCIM/a.jpg': file }, chunkSize: 4096 })
    const progress: [number, number | null][] = []
    expect(
      await pullFile(adb, '/sdcard/DCIM/a.jpg', { onProgress: (r, t) => progress.push([r, t]) }),
    ).toEqual(file)
    expect(progress).toEqual([
      [4096, 10_000],
      [8192, 10_000],
      [10_000, 10_000],
    ])
    expect(syncs[0]?.disposed).toBe(true)
  })

  it('stops the transfer on abort by closing the sync session', async () => {
    const controller = new AbortController()
    const { adb, syncs } = fakeAdb({
      files: { '/sdcard/DCIM/a.jpg': bytes(100_000) },
      chunkSize: 1000,
    })
    const pending = pullFile(adb, '/sdcard/DCIM/a.jpg', {
      signal: controller.signal,
      onProgress: (received) => {
        if (received >= 3000) controller.abort()
      },
    })
    await expect(pending).rejects.toThrow(/abort/i)
    expect(syncs[0]?.disposed).toBe(true)
  })

  it('refuses a file over the limit, before reading it or while reading it', async () => {
    const { adb, syncs } = fakeAdb({ files: { '/sdcard/big.jpg': bytes(5000) } })
    await expect(pullFile(adb, '/sdcard/big.jpg', { maxBytes: 4000 })).rejects.toThrow(
      'FILE_TOO_LARGE',
    )
    expect(syncs[0]).toMatchObject({ disposed: true, reads: [] })
  })

  it("rejects with the phone's error for a missing file", async () => {
    await expect(pullFile(fakeAdb().adb, '/sdcard/nope.jpg')).rejects.toThrow(
      'No such file or directory',
    )
  })

  it('refuses a path that is not a plain absolute one', async () => {
    const { adb, syncs } = fakeAdb()
    await expect(pullFile(adb, '/sdcard/../data/x')).rejects.toThrow('INVALID_DEVICE_PATH')
    expect(syncs).toEqual([])
  })
})

describe('blockRange', () => {
  it('covers the range with whole blocks and says where it starts inside them', () => {
    expect(blockRange(0, 10, 4096)).toEqual({ skip: 0, count: 1, from: 0 })
    expect(blockRange(100, 50, 4096)).toEqual({ skip: 0, count: 1, from: 100 })
    // Straddles a boundary: two blocks for 2 bytes.
    expect(blockRange(4095, 2, 4096)).toEqual({ skip: 0, count: 2, from: 4095 })
    expect(blockRange(8192, 4096, 4096)).toEqual({ skip: 2, count: 1, from: 0 })
    expect(blockRange(10_000, 9000, 4096)).toEqual({ skip: 2, count: 3, from: 1808 })
  })
})

describe('readFileRange', () => {
  const apk = '/data/app/~~Ab1x==/com.example.notes-Zz9==/base.apk'

  /**
   * A phone whose shell answers `dd` the way toybox does, from real bytes: whole blocks from
   * `skip`, fewer at the end of the file. It knows no `head -c`, like Android 7.x and 8.0.
   */
  const ddPhone = (file: Uint8Array) =>
    fakeAdb({
      files: { [apk]: file },
      answer: (call) => {
        const m = /^dd if='([^']+)' bs='(\d+)' skip='(\d+)' count='(\d+)' 2>\/dev\/null$/.exec(
          call.command,
        )
        if (!m) return { stderr: 'head: Unknown option c\n', exitCode: 1 }
        const [bs, skip, count] = [Number(m[2]), Number(m[3]), Number(m[4])]
        return { stdout: file.slice(skip * bs, (skip + count) * bs) }
      },
    })

  it('reads a slice with dd on whole blocks, the path quoted, and cuts the range out', async () => {
    const file = bytes(20_000)
    const { adb, calls } = ddPhone(file)
    expect(await readFileRange(adb, apk, 100, 50)).toEqual(file.slice(100, 150))
    expect(calls[0]?.command).toBe(`dd if='${apk}' bs='4096' skip='0' count='1' 2>/dev/null`)
    // Across a block boundary, and from a later block.
    expect(await readFileRange(adb, apk, 4000, 5000)).toEqual(file.slice(4000, 9000))
    expect(calls[1]?.command).toBe(`dd if='${apk}' bs='4096' skip='0' count='3' 2>/dev/null`)
    expect(await readFileRange(adb, apk, 12_300, 10)).toEqual(file.slice(12_300, 12_310))
    expect(calls[2]?.command).toBe(`dd if='${apk}' bs='4096' skip='3' count='1' 2>/dev/null`)
    expect(calls.every((c) => !c.command.includes('head'))).toBe(true)
  })

  it('opens a file as the badge reader reads it: its size, then slices clipped to the end', async () => {
    const file = bytes(120)
    const { adb, calls } = ddPhone(file)
    const read = await openDeviceFile(adb, apk)
    expect(read).toMatchObject({ path: apk, size: 120 })
    expect(await read.read(100, 50)).toEqual(file.slice(100, 120))
    expect(calls[0]?.command).toBe(`dd if='${apk}' bs='4096' skip='0' count='1' 2>/dev/null`)
    expect(await read.read(120, 10)).toEqual(new Uint8Array())
    expect(calls).toHaveLength(1)
    await expect(openDeviceFile(adb, '/data/app/gone/base.apk')).rejects.toThrow('FILE_READ_FAILED')
  })

  it("rejects when the read fails, in the phone's words when it has any, and refuses bad ranges", async () => {
    // dd's own complaint goes to /dev/null: a failed read is its exit code.
    const silent = fakeAdb({ answer: () => ({ exitCode: 1 }) }).adb
    await expect(readFileRange(silent, '/x', 0, 1)).rejects.toThrow('FILE_READ_FAILED')
    const { adb } = fakeAdb({
      answer: () => ({ stderr: '/system/bin/sh: dd: not found\n', exitCode: 127 }),
    })
    await expect(readFileRange(adb, '/x', 0, 1)).rejects.toThrow('dd: not found')
    await expect(readFileRange(adb, '/x', -1, 1)).rejects.toThrow('INVALID_ARGUMENT')
    await expect(readFileRange(adb, '/x', 0, 0)).rejects.toThrow('INVALID_ARGUMENT')
  })
})
