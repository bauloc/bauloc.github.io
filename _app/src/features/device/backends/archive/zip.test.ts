import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { makeZip, type SynthEntry } from './__fixtures__/synth'
import {
  blobSource,
  bytesSource,
  canInflate,
  openZip,
  scanZipStream,
  ZipError,
  type ByteSource,
} from './zip'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const LONG = 'deflate me '.repeat(500)

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A source over bytes that counts its reads, the way a phone-backed source costs a command each. */
function counted(bytes: Uint8Array) {
  const source = bytesSource(bytes)
  const log: [number, number][] = []
  const wrapped: ByteSource = {
    size: source.size,
    read: (offset, length) => {
      log.push([offset, length])
      return source.read(offset, length)
    },
  }
  return { source: wrapped, log }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof ZipError ? error.code : `not a ZipError: ${String(error)}`
  }
  return 'resolved'
}

const sample: SynthEntry[] = [
  { name: 'stored.txt', data: 'kept as is' },
  { name: 'folder/', data: '' },
  { name: 'folder/deflated.txt', data: LONG, method: 8 },
]

describe('openZip', () => {
  it('lists files, leaves directories out, and reads STORED and DEFLATE entries', async () => {
    const zip = await openZip(new Blob([makeZip(sample)]))
    expect(zip.entries.map((e) => e.name)).toEqual(['stored.txt', 'folder/deflated.txt'])
    expect(text(await zip.bytes(zip.get('stored.txt')!))).toBe('kept as is')
    const deflated = zip.get('folder/deflated.txt')!
    expect(deflated.method).toBe(8)
    expect(deflated.compressedSize).toBeLessThan(deflated.uncompressedSize)
    expect(text(await zip.bytes(deflated))).toBe(LONG)
    expect(text(await drain(await zip.stream(deflated)))).toBe(LONG)
  })

  it('reads a small archive in one read, and an entry with its header in one more', async () => {
    const { source, log } = counted(makeZip(sample))
    const zip = await openZip(source)
    expect(log).toHaveLength(1)
    await zip.bytes(zip.get('folder/deflated.txt')!)
    expect(log).toHaveLength(2)
  })

  it('finds data behind a local header padded past the central one, as zipalign writes it', async () => {
    const bytes = makeZip([{ name: 'padded.bin', data: 'aligned data', localExtra: 1000 }])
    const { source, log } = counted(bytes)
    const zip = await openZip(source)
    const entry = zip.get('padded.bin')!
    expect(text(await zip.bytes(entry))).toBe('aligned data')
    expect(log).toHaveLength(3) // the tail, then the header guess, then the data it missed
    expect(text(await drain(await zip.stream(entry)))).toBe('aligned data')
  })

  it('reads ZIP64 directories: our own, Info-ZIP’s `zip -fz`, and Python’s force_zip64', async () => {
    const ours = await openZip(new Blob([makeZip(sample, { zip64: true })]))
    expect(ours.entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ['stored.txt', 10],
      ['folder/deflated.txt', LONG.length],
    ])
    expect(text(await ours.bytes(ours.get('folder/deflated.txt')!))).toBe(LONG)

    const infozip = await openZip(new Blob([fixture('zip64-infozip.zip')]))
    expect(infozip.entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ['a.txt', 12],
      ['b.txt', 50],
    ])
    expect(text(await infozip.bytes(infozip.get('a.txt')!))).toBe('hello zip64\n')
    expect(text(await infozip.bytes(infozip.get('b.txt')!))).toMatch(/^second entry/)

    const python = await openZip(new Blob([fixture('zip64-python.zip')]))
    expect(python.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(text(await python.bytes(python.get('a.txt')!))).toBe('hello from python\n')
    expect(text(await python.bytes(python.get('b.txt')!))).toBe('deflated '.repeat(20))
  })

  it('finds the end record behind an archive comment', async () => {
    const zip = await openZip(new Blob([makeZip(sample, { comment: 'x'.repeat(40_000) })]))
    expect(zip.entries).toHaveLength(2)
  })

  it('refuses what is not a whole zip', async () => {
    expect(await codeOf(openZip(new Blob(['not an archive at all, just some text'])))).toBe(
      'ZIP_NOT_A_ZIP',
    )
    expect(await codeOf(openZip(new Blob(['PK'])))).toBe('ZIP_NOT_A_ZIP')
    const whole = makeZip(sample)
    expect(await codeOf(openZip(new Blob([whole.slice(0, whole.length - 30)])))).toBe(
      'ZIP_NOT_A_ZIP',
    )
  })

  it('refuses a damaged central directory and a multi-disk archive', async () => {
    const bytes = makeZip(sample)
    const v = new DataView(bytes.buffer)
    const eocd = bytes.length - 22
    const damaged = bytes.slice()
    new DataView(damaged.buffer).setUint32(v.getUint32(eocd + 16, true), 0xdeadbeef, true)
    expect(await codeOf(openZip(new Blob([damaged])))).toBe('ZIP_CORRUPT')

    const spanned = bytes.slice()
    new DataView(spanned.buffer).setUint16(eocd + 4, 1, true)
    expect(await codeOf(openZip(new Blob([spanned])))).toBe('ZIP_MULTIDISK')
  })

  it('refuses encrypted entries and unknown compression, and still reads the others', async () => {
    const zip = await openZip(
      new Blob([
        makeZip([
          { name: 'secret.apk', data: 'xx', flags: 0x0001 },
          { name: 'lzma.apk', data: 'xx', method: 14 },
          { name: 'plain.txt', data: 'fine' },
        ]),
      ]),
    )
    for (const read of [
      (n: string) => zip.bytes(zip.get(n)!),
      (n: string) => zip.stream(zip.get(n)!),
      (n: string) => zip.blob(zip.get(n)!),
    ]) {
      expect(await codeOf(read('secret.apk'))).toBe('ZIP_ENCRYPTED')
    }
    expect(await codeOf(zip.bytes(zip.get('lzma.apk')!))).toBe('ZIP_METHOD')
    expect(text(await zip.bytes(zip.get('plain.txt')!))).toBe('fine')
  })

  it('stops inflating at the declared size, and refuses an entry that comes out short', async () => {
    const zip = await openZip(
      new Blob([
        makeZip([
          { name: 'bomb.bin', data: '0'.repeat(1_000_000), method: 8, declaredSize: 1000 },
          { name: 'short.bin', data: 'abc', method: 8, declaredSize: 10 },
        ]),
      ]),
    )
    expect(await codeOf(zip.bytes(zip.get('bomb.bin')!))).toBe('ZIP_SIZE_MISMATCH')
    expect(await codeOf(drain(await zip.stream(zip.get('bomb.bin')!)))).toBe('ZIP_SIZE_MISMATCH')
    expect(await codeOf(drain(await zip.stream(zip.get('short.bin')!)))).toBe('ZIP_SIZE_MISMATCH')
  })

  it('reports damaged DEFLATE data as a corrupt entry, not the inflater’s own error', async () => {
    const bytes = makeZip([{ name: 'broken.bin', data: LONG, method: 8 }])
    const zip = await openZip(new Blob([bytes]))
    const entry = zip.get('broken.bin')!
    const damaged = bytes.slice()
    damaged.fill(0xff, 40, 60) // inside the compressed data, after the 30-byte header and name
    const broken = await openZip(new Blob([damaged]))
    const error = await broken.bytes(broken.get('broken.bin')!).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZipError)
    expect(error).toMatchObject({ code: 'ZIP_CORRUPT', entry: 'broken.bin' })
    expect(text(await zip.bytes(entry))).toBe(LONG)
  })

  it('caps what it holds in memory', async () => {
    const zip = await openZip(new Blob([makeZip(sample)]))
    expect(await codeOf(zip.bytes(zip.get('folder/deflated.txt')!, 100))).toBe('ZIP_TOO_LARGE')
  })

  it('gives a STORED entry as a Blob to open as a zip of its own, and no Blob for DEFLATE', async () => {
    const inner = makeZip([{ name: 'AndroidManifest.xml', data: 'manifest' }])
    const outer = await openZip(
      new Blob([
        makeZip([
          { name: 'splits/base-master.apk', data: inner },
          { name: 'deflated.apk', data: inner, method: 8 },
        ]),
      ]),
    )
    const blob = await outer.blob(outer.get('splits/base-master.apk')!)
    expect(blob?.size).toBe(inner.length)
    const nested = await openZip(blob!)
    expect(text(await nested.bytes(nested.get('AndroidManifest.xml')!))).toBe('manifest')
    expect(await outer.blob(outer.get('deflated.apk')!)).toBeNull()
  })

  it('streams from a source with no Blob behind it, in pieces', async () => {
    const big = 'z'.repeat(600_000)
    const { source, log } = counted(makeZip([{ name: 'big.bin', data: big }]))
    const zip = await openZip(source)
    const before = log.length
    expect(text(await drain(await zip.stream(zip.get('big.bin')!)))).toBe(big)
    expect(log.length - before).toBeGreaterThan(2) // a header read, then 256 KB pieces
  })

  it('lets a read failure through as itself, rather than calling the file corrupt', async () => {
    const gone = new DOMException('The file changed on disk.', 'NotReadableError')
    const failing: ByteSource = { size: 1000, read: () => Promise.reject(gone) }
    await expect(openZip(failing)).rejects.toBe(gone)
  })

  it('reads a Blob through blobSource exactly like openZip(blob)', async () => {
    const bytes = makeZip(sample)
    const a = await openZip(blobSource(new Blob([bytes])))
    expect(text(await a.bytes(a.get('stored.txt')!))).toBe('kept as is')
  })

  it('knows this runtime can inflate', () => {
    expect(canInflate()).toBe(true)
  })
})

describe('scanZipStream', () => {
  // Filler that does not compress, so skipping it means skipping 200 KB of stream.
  const dex = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251)
  const apkBytes = makeZip([
    { name: 'AndroidManifest.xml', data: 'the manifest', method: 8 },
    { name: 'classes.dex', data: dex },
    { name: 'resources.arsc', data: 'the table' },
  ])
  const stream = () => new Blob([apkBytes]).stream()

  it('finds entries front to back, inflating the ones asked for', async () => {
    const found = await scanZipStream(stream(), ['AndroidManifest.xml', 'resources.arsc'], 1e7)
    expect(text(found.get('AndroidManifest.xml')!)).toBe('the manifest')
    expect(text(found.get('resources.arsc')!)).toBe('the table')
  })

  it('stops reading once it has what it wants', async () => {
    // One 64-byte piece per pull, the way an inflater hands data over, counting what was asked for.
    let pulled = 0
    const trickle = new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = apkBytes.subarray(pulled * 64, ++pulled * 64)
        if (piece.length === 0) controller.close()
        else controller.enqueue(piece)
      },
    })
    const found = await scanZipStream(trickle, ['AndroidManifest.xml'], 1e7)
    expect(found.has('AndroidManifest.xml')).toBe(true)
    expect(pulled * 64).toBeLessThan(1000)
  })

  it('gives up at an entry whose size follows its data, and past its byte limit', async () => {
    const described = makeZip([
      { name: 'first.bin', data: 'x'.repeat(100), descriptor: true, method: 8 },
      { name: 'AndroidManifest.xml', data: 'late manifest' },
    ])
    const blocked = await scanZipStream(
      new Blob([described]).stream(),
      ['AndroidManifest.xml'],
      1e7,
    )
    expect(blocked.size).toBe(0)

    const limited = await scanZipStream(stream(), ['resources.arsc'], 1000)
    expect(limited.size).toBe(0)
  })

  it('refuses a wanted entry declared larger than its limit, before holding any of it', async () => {
    // A manifest that claims 200 MB: it must not be buffered or inflated, whatever it holds.
    const bomb = makeZip([
      { name: 'AndroidManifest.xml', data: '0'.repeat(100_000), method: 8, declaredSize: 2e8 },
    ])
    const error = await scanZipStream(new Blob([bomb]).stream(), ['AndroidManifest.xml'], 1e6)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZipError)
    expect(error).toMatchObject({ code: 'ZIP_TOO_LARGE', entry: 'AndroidManifest.xml' })

    // Within the limit, an entry that inflates past its declared size still stops there.
    const lying = makeZip([
      { name: 'AndroidManifest.xml', data: '0'.repeat(1_000_000), method: 8, declaredSize: 1000 },
    ])
    const stopped = await scanZipStream(new Blob([lying]).stream(), ['AndroidManifest.xml'], 1e6)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(stopped).toMatchObject({ code: 'ZIP_SIZE_MISMATCH' })

    // Entries it only skips may be any size: only what it holds is capped.
    const skipped = makeZip([
      { name: 'classes.dex', data: '0'.repeat(10_000), method: 8, declaredSize: 2e8 },
      { name: 'AndroidManifest.xml', data: 'the manifest' },
    ])
    const found = await scanZipStream(new Blob([skipped]).stream(), ['AndroidManifest.xml'], 1e6)
    expect(text(found.get('AndroidManifest.xml')!)).toBe('the manifest')
  })

  it('reads a ZIP64 local header (Python’s force_zip64)', async () => {
    const found = await scanZipStream(
      new Blob([fixture('zip64-python.zip')]).stream(),
      ['b.txt'],
      1e6,
    )
    expect(text(found.get('b.txt')!)).toBe('deflated '.repeat(20))
  })
})
