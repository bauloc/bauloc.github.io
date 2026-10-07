/*
  The ids in published addresses: /artifact/<id>.html and /build/<id>/. The same shape as a
  Term & Privacy slug and as `npm run publish` checks it, lowercase only — a macOS checkout
  cannot hold two directories whose names differ only in case.
*/

export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export const isId = (value: string) => ID_PATTERN.test(value)

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A fresh id, `length` letters and digits from the browser's CSPRNG. Bytes of 252 and up are
 * drawn again: 252 is the largest multiple of 36 under 256, so every character is equally likely.
 */
export function randomId(length = 8): string {
  let id = ''
  const bytes = new Uint8Array(length * 2)
  while (id.length < length) {
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte < 252 && id.length < length) id += ALPHABET[byte % 36] ?? ''
    }
  }
  return id
}
