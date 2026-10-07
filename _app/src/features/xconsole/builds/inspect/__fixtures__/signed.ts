/*
  Test-only: an APK as apksigner leaves it, as far as inspectApk can tell. Device Lab's fixture
  APKs are unsigned (a parser never needed a signature), and the Upload sheet refuses an unsigned
  APK, so tests that are about something else sign theirs first.

  A v2+ APK Signing Block goes between the last entry and the central directory: a size, the
  signer blocks, the size again and the 16-byte magic. Only its position and magic are checked
  here, so the block carries no signers; the end record's central-directory offset moves past it.
*/

const MAGIC = new TextEncoder().encode('APK Sig Block 42')

/** Where the end-of-central-directory record starts. */
function endRecord(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === 0x06054b50) return at
  }
  throw new Error('not a zip')
}

/** The APK with an (empty) v2 signing block in front of its central directory. */
export function signed(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const end = endRecord(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const directory = view.getUint32(end + 16, true)
  // size (u64) + no pairs + size (u64) + magic; each size counts what follows the first one.
  const block = new Uint8Array(8 + 8 + MAGIC.length)
  const blockView = new DataView(block.buffer)
  blockView.setBigUint64(0, BigInt(8 + MAGIC.length), true)
  blockView.setBigUint64(8, BigInt(8 + MAGIC.length), true)
  block.set(MAGIC, 16)
  const out = new Uint8Array(bytes.length + block.length)
  out.set(bytes.subarray(0, directory), 0)
  out.set(block, directory)
  out.set(bytes.subarray(directory), directory + block.length)
  new DataView(out.buffer).setUint32(end + block.length + 16, directory + block.length, true)
  return out
}
