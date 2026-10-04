/*
  A ZIP reader for random-access bytes: a dropped File, or a file on the phone read in pieces.
  Only the central directory is read up front; each entry is read or streamed when asked for,
  so a 2 GB .xapk never has to fit in memory, and an APK inside an .apks (always STORED) streams
  straight from disk as a zero-copy Blob slice. DEFLATE goes through the browser's own
  DecompressionStream('deflate-raw') (Chrome and Edge 103+): no zip library.

  Ported from the bundle-install prototype (proto/zip.mjs) and the APK badge probe
  (pixel-probes/apk.ts), which read what bundletool, aapt2, APKPure and APKMirror write.

  Refused with a code, never guessed at: encrypted entries, compression other than STORED and
  DEFLATE, multi-disk archives, and an entry that comes out a different size than its header
  declares. That last check is also the cap on a zip bomb: inflating stops at the declared size,
  which is the exact byte count `pm install-write -S` is promised.
*/

/** Random access to some bytes. Every reader in this folder works on one of these. */
export interface ByteSource {
  /** Total length in bytes. */
  readonly size: number
  /** `length` bytes from `offset`; fewer only at the end of the source. */
  readonly read: (offset: number, length: number) => Promise<Uint8Array>
  /** A zero-copy view of a range, when the bytes live in a Blob: the browser streams it from disk. */
  readonly slice?: (start: number, end: number) => Blob
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    slice: (start, end) => blob.slice(start, end),
  }
}

/** Bytes already in memory: a small inflated APK, or a test's synthetic archive. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  }
}

export type ZipErrorCode =
  /** No end-of-central-directory record: not a zip at all, or a download cut short. */
  | 'ZIP_NOT_A_ZIP'
  /** Records that do not add up: a damaged file. */
  | 'ZIP_CORRUPT'
  | 'ZIP_MULTIDISK'
  | 'ZIP_ENCRYPTED'
  /** Compressed with something other than STORED or DEFLATE. */
  | 'ZIP_METHOD'
  /** Came out a different size than its header declares. */
  | 'ZIP_SIZE_MISMATCH'
  /** Larger than the caller agreed to hold in memory. */
  | 'ZIP_TOO_LARGE'
  /** This browser has no DecompressionStream('deflate-raw'). */
  | 'ZIP_NO_INFLATE'

/** A refusal. Its message is the code, as with every Device Lab error code; the UI owns wording. */
export class ZipError extends Error {
  readonly code: ZipErrorCode
  /** The entry it concerns, when there is one. */
  readonly entry: string

  constructor(code: ZipErrorCode, entry = '', options?: ErrorOptions) {
    super(code, options)
    this.name = 'ZipError'
    this.code = code
    this.entry = entry
  }
}

export interface ZipEntry {
  readonly name: string
  /** 0 = STORED, 8 = DEFLATE. Anything else is refused when read. */
  readonly method: number
  readonly flags: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  /** Where the entry's local header starts. */
  readonly localOffset: number
}

export interface ZipArchive {
  readonly source: ByteSource
  /** Files only: directory entries are left out. */
  readonly entries: readonly ZipEntry[]
  readonly get: (name: string) => ZipEntry | undefined
  /** The whole entry, inflated. Refuses one that would be larger than `limit` bytes. */
  readonly bytes: (entry: ZipEntry, limit?: number) => Promise<Uint8Array<ArrayBuffer>>
  /** The entry as a stream of exactly `uncompressedSize` bytes, inflated when DEFLATE. */
  readonly stream: (entry: ZipEntry) => Promise<ReadableStream<Uint8Array>>
  /** A STORED entry as a zero-copy Blob, to open as a zip of its own; null when it is not one. */
  readonly blob: (entry: ZipEntry) => Promise<Blob | null>
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_DESCRIPTOR = 0x08074b50

const EOCD_SIZE = 22
const LOCATOR_SIZE = 20
const EOCD64_SIZE = 56
/** The end record, a comment of up to 64 KB, and the ZIP64 locator in front of it. */
const TAIL_SIZE = EOCD_SIZE + 0xffff + LOCATOR_SIZE
/** Enough for the local header of the entries read whole (manifests, tables, icons). */
const LOCAL_SLACK = 512
const DEFAULT_LIMIT = 32 * 1024 * 1024
/** Device reads are one shell command each, so big entries stream in big pieces. */
const CHUNK = 256 * 1024

const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

function u64(v: DataView, at: number): number {
  const n = v.getBigUint64(at, true)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('ZIP_CORRUPT')
  return Number(n)
}

/** Whether this browser can inflate DEFLATE entries, which .xapk and .apkm files need. */
export function canInflate(): boolean {
  try {
    new DecompressionStream('deflate-raw')
    return true
  } catch {
    return false
  }
}

function inflater(entry: string): DecompressionStream {
  try {
    return new DecompressionStream('deflate-raw')
  } catch {
    throw new ZipError('ZIP_NO_INFLATE', entry)
  }
}

/**
 * A damaged record is read past its end (a RangeError from DataView), and damaged DEFLATE data
 * makes the inflater throw a TypeError: both mean a corrupt file. Anything else, such as a file
 * changed on disk after it was picked or a phone unplugged mid-read, keeps its own identity.
 */
function rethrow(error: unknown, entry = ''): never {
  if (error instanceof RangeError || error instanceof TypeError) {
    throw new ZipError('ZIP_CORRUPT', entry, { cause: error })
  }
  throw error
}

/** The end record's offset in `tail`: the last signature whose comment fits before the end. */
function findEocd(tail: Uint8Array): number {
  const v = view(tail)
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (v.getUint32(i, true) !== SIG_EOCD) continue
    if (i + EOCD_SIZE + v.getUint16(i + 20, true) <= tail.length) return i
  }
  return -1
}

interface Directory {
  count: number
  cdSize: number
  cdOffset: number
  /** Where the end records start: the central directory must end at or before it. */
  end: number
}

async function readDirectoryInfo(
  source: ByteSource,
  tail: Uint8Array,
  tailStart: number,
): Promise<Directory> {
  const at = findEocd(tail)
  if (at < 0) throw new ZipError('ZIP_NOT_A_ZIP')
  const v = view(tail)
  const dir: Directory = {
    count: v.getUint16(at + 10, true),
    cdSize: v.getUint32(at + 12, true),
    cdOffset: v.getUint32(at + 16, true),
    end: tailStart + at,
  }
  let disk = v.getUint16(at + 4, true)
  let cdDisk = v.getUint16(at + 6, true)

  // ZIP64: a locator right in front of the end record points at the 64-bit end record, which is
  // authoritative for every field it carries.
  const loc = at - LOCATOR_SIZE
  if (loc >= 0 && v.getUint32(loc, true) === SIG_EOCD64_LOCATOR) {
    const offset = u64(v, loc + 8)
    const record = await source.read(offset, EOCD64_SIZE)
    if (record.length < EOCD64_SIZE) throw new ZipError('ZIP_CORRUPT')
    const r = view(record)
    if (r.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('ZIP_CORRUPT')
    disk = r.getUint32(16, true)
    cdDisk = r.getUint32(20, true)
    dir.count = u64(r, 32)
    dir.cdSize = u64(r, 40)
    dir.cdOffset = u64(r, 48)
    dir.end = offset
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('ZIP_MULTIDISK')
  if (dir.cdOffset + dir.cdSize > dir.end) throw new ZipError('ZIP_CORRUPT')
  return dir
}

function parseCentralDirectory(cd: Uint8Array, count: number): ZipEntry[] {
  const v = view(cd)
  const utf8 = new TextDecoder()
  const entries: ZipEntry[] = []
  let records = 0
  let p = 0
  for (; p + 46 <= cd.length && v.getUint32(p, true) === SIG_CENTRAL; records++) {
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    let compressedSize = v.getUint32(p + 20, true)
    let uncompressedSize = v.getUint32(p + 24, true)
    let localOffset = v.getUint32(p + 42, true)
    const nameEnd = p + 46 + nameLen
    if (nameEnd + extraLen + commentLen > cd.length) throw new ZipError('ZIP_CORRUPT')

    // The ZIP64 extra field (id 1) carries only the fields that overflowed, in this order.
    for (let x = nameEnd; x + 4 <= nameEnd + extraLen;) {
      const id = v.getUint16(x, true)
      const len = v.getUint16(x + 2, true)
      if (id === 0x0001) {
        let q = x + 4
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(v, q)
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(v, q)
          q += 8
        }
        if (localOffset === 0xffffffff) localOffset = u64(v, q)
      }
      x += 4 + len
    }

    const name = utf8.decode(cd.subarray(p + 46, nameEnd))
    if (!name.endsWith('/')) {
      entries.push({
        name,
        method: v.getUint16(p + 10, true),
        flags: v.getUint16(p + 8, true),
        crc32: v.getUint32(p + 16, true),
        compressedSize,
        uncompressedSize,
        localOffset,
      })
    }
    p = nameEnd + extraLen + commentLen
  }
  // Fewer records than the end record counts: the directory was cut or overwritten. (More is
  // tolerated: writers of over 65,535 entries without ZIP64 let the 16-bit count wrap.)
  if (records < count) throw new ZipError('ZIP_CORRUPT')
  return entries
}

function checkReadable(
  entry: Pick<ZipEntry, 'name' | 'flags' | 'method' | 'compressedSize' | 'uncompressedSize'>,
): void {
  if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    throw new ZipError('ZIP_ENCRYPTED', entry.name)
  }
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('ZIP_METHOD', entry.name)
  if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw new ZipError('ZIP_CORRUPT', entry.name)
  }
}

/**
 * `body` as a stream that delivers exactly `size` bytes. More is refused as soon as it shows,
 * fewer when it ends, and a failure inside the inflater surfaces as ZIP_CORRUPT naming the
 * entry instead of the browser's own wording.
 */
function exactly(
  body: ReadableStream<Uint8Array>,
  size: number,
  entry: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let seen = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await reader.read()
      } catch (error) {
        rethrow(error, entry)
      }
      if (step.done) {
        if (seen !== size) throw new ZipError('ZIP_SIZE_MISMATCH', entry)
        controller.close()
        return
      }
      seen += step.value.byteLength
      if (seen > size) {
        await reader.cancel().catch(() => undefined)
        throw new ZipError('ZIP_SIZE_MISMATCH', entry)
      }
      controller.enqueue(step.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** A range of a source that has no Blob behind it, read in big pieces as the consumer pulls. */
function rangeStream(
  source: ByteSource,
  start: number,
  length: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let done = 0
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (done >= length) {
        controller.close()
        return
      }
      const piece = await source.read(start + done, Math.min(CHUNK, length - done))
      if (piece.length === 0) throw new ZipError('ZIP_CORRUPT')
      done += piece.length
      // A copy the inflater accepts: a source may hand out views of a shared buffer.
      controller.enqueue(new Uint8Array(piece))
    },
  })
}

/** A stream drained into one buffer of the size it is known to have. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(size)
  const reader = stream.getReader()
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.set(value, at)
    at += value.byteLength
  }
  return out
}

/** Opens a zip: reads its end record and central directory, and nothing else yet. */
export async function openZip(input: Blob | ByteSource): Promise<ZipArchive> {
  const source = input instanceof Blob ? blobSource(input) : input
  if (source.size < EOCD_SIZE) throw new ZipError('ZIP_NOT_A_ZIP')

  let entries: ZipEntry[]
  try {
    const tailStart = Math.max(0, source.size - TAIL_SIZE)
    const tail = await source.read(tailStart, source.size - tailStart)
    const dir = await readDirectoryInfo(source, tail, tailStart)
    // The central directory usually sits inside the tail already: one read for small archives.
    const cd =
      dir.cdOffset >= tailStart
        ? tail.subarray(dir.cdOffset - tailStart, dir.cdOffset - tailStart + dir.cdSize)
        : await source.read(dir.cdOffset, dir.cdSize)
    if (cd.length !== dir.cdSize) throw new ZipError('ZIP_CORRUPT')
    entries = parseCentralDirectory(cd, dir.count)
  } catch (error) {
    rethrow(error)
  }

  const byName = new Map<string, ZipEntry>()
  // A name listed twice keeps its first entry. (An APK like that is refused by Android anyway.)
  for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e)
  const starts = new Map<ZipEntry, number>()

  /**
   * Where the entry's data starts. The LOCAL name and extra lengths can differ from the central
   * ones (zipalign pads the local extra field), so they are always read.
   */
  async function dataStart(entry: ZipEntry): Promise<number> {
    const known = starts.get(entry)
    if (known !== undefined) return known
    const header = await source.read(entry.localOffset, 30)
    const start = localDataStart(header, entry)
    starts.set(entry, start)
    return start
  }

  function localDataStart(header: Uint8Array, entry: ZipEntry): number {
    if (header.length < 30) throw new ZipError('ZIP_CORRUPT', entry.name)
    const v = view(header)
    if (v.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('ZIP_CORRUPT', entry.name)
    const start = entry.localOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true)
    if (start + entry.compressedSize > source.size) throw new ZipError('ZIP_CORRUPT', entry.name)
    return start
  }

  return {
    source,
    entries,
    get: (name) => byName.get(name),

    async bytes(entry, limit = DEFAULT_LIMIT) {
      checkReadable(entry)
      if (entry.uncompressedSize > limit) throw new ZipError('ZIP_TOO_LARGE', entry.name)
      let raw: Uint8Array
      try {
        // One read for the header and the data together: on a phone every read is a command.
        const chunk = await source.read(entry.localOffset, 30 + LOCAL_SLACK + entry.compressedSize)
        const start = localDataStart(chunk, entry) - entry.localOffset
        raw =
          start + entry.compressedSize <= chunk.length
            ? chunk.subarray(start, start + entry.compressedSize)
            : await source.read(entry.localOffset + start, entry.compressedSize)
        if (raw.length !== entry.compressedSize) throw new ZipError('ZIP_CORRUPT', entry.name)
      } catch (error) {
        rethrow(error, entry.name)
      }
      if (entry.method === 0) return raw.slice()
      const body = new Blob([raw.slice()]).stream().pipeThrough(inflater(entry.name))
      return collect(exactly(body, entry.uncompressedSize, entry.name), entry.uncompressedSize)
    },

    async stream(entry) {
      checkReadable(entry)
      const start = await dataStart(entry).catch((error: unknown) => rethrow(error, entry.name))
      const end = start + entry.compressedSize
      const raw = source.slice
        ? source.slice(start, end).stream()
        : rangeStream(source, start, entry.compressedSize)
      const body = entry.method === 8 ? raw.pipeThrough(inflater(entry.name)) : raw
      return exactly(body, entry.uncompressedSize, entry.name)
    },

    async blob(entry) {
      if (!source.slice || entry.method !== 0) return null
      checkReadable(entry)
      const start = await dataStart(entry).catch((error: unknown) => rethrow(error, entry.name))
      return source.slice(start, start + entry.compressedSize)
    },
  }
}

/*
  Reading front to back. An APK kept DEFLATE inside an .xapk or .apkm cannot be opened by its
  central directory without inflating everything in front of it, but its manifest is its first
  entry (bundletool, AGP and aapt2 all write it first), so a walk over the local headers of the
  inflated stream finds it after a few kilobytes.
*/

/** Bytes pulled from a stream on demand, held only until taken. */
function pump(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let chunks: Uint8Array[] = []
  let buffered = 0
  let consumed = 0
  let ended = false

  async function fill(n: number): Promise<boolean> {
    while (buffered < n && !ended) {
      const { done, value } = await reader.read()
      if (done) ended = true
      else {
        chunks.push(value)
        buffered += value.byteLength
      }
    }
    return buffered >= n
  }

  function take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const head = chunks[0]
      if (!head) throw new ZipError('ZIP_CORRUPT')
      const part = head.subarray(0, n - at)
      out.set(part, at)
      at += part.length
      if (part.length === head.length) chunks.shift()
      else chunks[0] = head.subarray(part.length)
    }
    buffered -= n
    consumed += n
    return out
  }

  /** Drops `n` bytes without holding them: the entries skipped can be hundreds of MB. */
  async function skip(n: number): Promise<boolean> {
    let left = n
    while (left > 0) {
      if (buffered === 0 && !(await fill(1))) return false
      const drop = Math.min(left, buffered)
      take(drop)
      left -= drop
    }
    return true
  }

  return {
    fill,
    take,
    skip,
    consumed: () => consumed,
    close() {
      chunks = []
      void reader.cancel().catch(() => undefined)
    },
  }
}

/**
 * The named entries of a ZIP read front to back from `stream`, by their local headers. It stops
 * as soon as every name is found, and gives up, keeping what it has, at the central directory,
 * at an entry whose size only follows its data (a data descriptor), or after `limit` bytes.
 * A named entry declared larger than `limit` is refused with ZIP_TOO_LARGE.
 */
export async function scanZipStream(
  stream: ReadableStream<Uint8Array>,
  names: readonly string[],
  limit: number,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const wanted = new Set(names)
  const found = new Map<string, Uint8Array<ArrayBuffer>>()
  const p = pump(stream)
  const utf8 = new TextDecoder()
  try {
    while (found.size < wanted.size && p.consumed() < limit) {
      if (!(await p.fill(30))) break
      const h = view(p.take(30))
      if (h.getUint32(0, true) !== SIG_LOCAL) break
      const flags = h.getUint16(6, true)
      const method = h.getUint16(8, true)
      let compressedSize = h.getUint32(18, true)
      let uncompressedSize = h.getUint32(22, true)
      const nameLen = h.getUint16(26, true)
      const extraLen = h.getUint16(28, true)
      if (!(await p.fill(nameLen + extraLen))) break
      const name = utf8.decode(p.take(nameLen))
      const extra = view(p.take(extraLen))
      for (let x = 0; x + 4 <= extraLen;) {
        const id = extra.getUint16(x, true)
        const len = extra.getUint16(x + 2, true)
        // In a LOCAL header the ZIP64 field holds both sizes whenever it is present.
        if (id === 0x0001 && len >= 16) {
          uncompressedSize = u64(extra, x + 4)
          compressedSize = u64(extra, x + 12)
        }
        x += 4 + len
      }
      if ((flags & FLAG_DESCRIPTOR) !== 0 && compressedSize === 0) break

      if (wanted.has(name) && !found.has(name)) {
        checkReadable({ name, flags, method, compressedSize, uncompressedSize })
        // The sizes come from the stream itself, so a crafted one could ask for gigabytes: refuse
        // before buffering anything. Inflating then stops at the declared size, inside the cap.
        if (compressedSize > limit || uncompressedSize > limit) {
          throw new ZipError('ZIP_TOO_LARGE', name)
        }
        if (!(await p.fill(compressedSize))) break
        const raw = p.take(compressedSize)
        if (method === 0) found.set(name, raw)
        else {
          const body = new Blob([raw]).stream().pipeThrough(inflater(name))
          found.set(name, await collect(exactly(body, uncompressedSize, name), uncompressedSize))
        }
      } else if (!(await p.skip(compressedSize))) break

      if ((flags & FLAG_DESCRIPTOR) !== 0) {
        if (!(await p.fill(4))) break
        const signed = view(p.take(4)).getUint32(0, true) === SIG_DESCRIPTOR
        if (!(await p.skip(signed ? 12 : 8))) break
      }
    }
  } catch (error) {
    rethrow(error)
  } finally {
    p.close()
  }
  return found
}
