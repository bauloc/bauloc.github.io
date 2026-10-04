import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { DEV_ORIGINS, NAME } from './constants'

/** 32 random bytes in base64url: 256 bits, 43 characters, safe in a URL fragment. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** 16 random bytes in base64url, from the page's crypto.getRandomValues. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22}$/

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The token's public fingerprint: 8 hex of its SHA-256. The page shows it to say which run
 * it is paired with, and compares it with health.tokenId before it sends the token anywhere.
 */
export function tokenIdOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Proof that whoever answers on this port holds the token, without revealing it (§2.8):
 * HMAC-SHA256 keyed with the token over the port the helper is bound to and the page's
 * challenge. A squatter on another port that relays the challenge here gets a proof over
 * THIS port, which the page, computing over the port it talks to, rejects.
 */
export function proofOf(token: string, port: number, challenge: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(`${NAME} proof v1|${String(port)}|${challenge}`, 'utf8')
    .digest('base64url')
}

/**
 * `Authorization: Bearer <token>`, compared in constant time over the SHA-256 of each side:
 * both are always 32 bytes, so timingSafeEqual never throws and the length of a wrong
 * guess leaks nothing.
 */
export function createBearerCheck(token: string): (header: string | undefined) => boolean {
  const expected = createHash('sha256').update(token, 'utf8').digest()
  return (header) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')
    if (!match?.[1]) return false
    return timingSafeEqual(createHash('sha256').update(match[1], 'utf8').digest(), expected)
  }
}

/* --------------------------------------------------------------- --keep-token --- */

/** A refusal to use the kept token, worded for the terminal (§1.10); exit 1. */
export class TokenFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenFileError'
  }
}

/** ~/Library/Application Support on macOS, $XDG_CONFIG_HOME (or ~/.config) elsewhere. */
export function tokenFilePath(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : path.join(home, '.config')
  return path.join(base, NAME, 'token')
}

const quoteForShell = (file: string): string => `'${file.replace(/'/g, `'\\''`)}'`

/**
 * Refuse a path another user could have planted or can read: a symbolic link (it could
 * point anywhere), an owner other than us, or any group or other permission bit.
 */
function assertPrivate(file: string, uid: number | undefined, mode: 0o700 | 0o600): void {
  const stats = lstatSync(file)
  if (stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
    throw new TokenFileError(
      `The token file ${file} is a symbolic link or belongs to another user; refusing to use it.`,
    )
  }
  if (mode === 0o700 && !stats.isDirectory()) {
    throw new TokenFileError(`The token file's folder ${file} is not a folder; refusing to use it.`)
  }
  if (mode === 0o600 && !stats.isFile()) {
    throw new TokenFileError(
      `The token file ${file} is a symbolic link or belongs to another user; refusing to use it.`,
    )
  }
  if ((stats.mode & 0o077) !== 0) {
    if (mode === 0o700) {
      /** Our own folder with loose permissions: tightening it is safe and expected. */
      chmodSync(file, 0o700)
      return
    }
    throw new TokenFileError(
      `The token file ${file} can be read by other users. Fix it with: chmod 600 ${quoteForShell(file)}`,
    )
  }
}

/** Write `token` to a new file next to `file` (O_EXCL, 0600), then move it into place. */
function writeTokenFile(file: string, token: string): void {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(fd, token + '\n')
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, file)
  } catch (error) {
    unlinkSync(temporary)
    throw error
  }
}

/**
 * The token kept across restarts with --keep-token (§1.11): created on first use in a 0700
 * folder as a 0600 file, replaced with --new-token, refused when it is not provably ours
 * and private. A corrupt file is replaced rather than trusted.
 */
export function loadKeptToken(opts: {
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  getuid: (() => number) | undefined
  newToken: boolean
}): { token: string; path: string; created: boolean } {
  const file = tokenFilePath(opts.home, opts.platform, opts.env)
  const dir = path.dirname(file)
  const uid = opts.getuid?.()
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    assertPrivate(dir, uid, 0o700)
    let existing: string | null = null
    try {
      assertPrivate(file, uid, 0o600)
      existing = readFileSync(file, 'utf8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== null && TOKEN_PATTERN.test(existing) && !opts.newToken) {
      return { token: existing, path: file, created: false }
    }
    const token = generateToken()
    writeTokenFile(file, token)
    return { token, path: file, created: true }
  } catch (error) {
    if (error instanceof TokenFileError) throw error
    /** A folder we may not write, a full disk: still a sentence, never a stack trace. */
    const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message
    throw new TokenFileError(`The token file ${file} could not be used (${String(reason)}).`)
  }
}

/* --------------------------------------------------------- "Page connected" lines --- */

/** The browser family for the terminal, from the User-Agent; never the whole string. */
export function browserFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return 'Firefox'
  if (/\b(?:OPR|Opera)\//.test(ua)) return 'Opera'
  if (/\b(?:Chrome|CriOS|Chromium|HeadlessChrome)\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari'
  return 'Another client'
}

/** The dev origins (--dev) by the command that serves them, so the terminal names the page. */
const DEV_PAGES: Readonly<Record<string, string>> = {
  '7360': 'npm run dev',
  '4173': 'vite preview',
  '8000': 'npm run serve:site',
}

/**
 * Where an authorised request came from, for the terminal. A page names itself by its
 * Origin: the dev origins as "the dev page", so a tester running `npm run dev` recognises
 * it. A client without an Origin (curl, or the helper's own page fetching same-origin) is
 * named by the Host it used.
 */
export function pageWhere(origin: string | undefined, host: string): string {
  if (origin === undefined) return `http://${host}`
  if ((DEV_ORIGINS as readonly string[]).includes(origin)) {
    const command = DEV_PAGES[origin.slice(origin.lastIndexOf(':') + 1)]
    return `the dev page ${origin}${command ? ` (${command})` : ''}`
  }
  return origin
}

/**
 * "Page connected: Chrome on https://bauloc.github.io", once per page and browser family, on
 * the first authorised request from it. "Another client" is only for a client that sent no
 * Origin and no browser User-Agent; a page with an Origin is always a browser.
 */
export function createPageLog(
  log: (line: string) => void,
): (origin: string | undefined, host: string, userAgent: string | undefined) => void {
  const seen = new Set<string>()
  return (origin, host, userAgent) => {
    const known = browserFamily(userAgent)
    const family = known === 'Another client' && origin !== undefined ? 'A browser' : known
    const where = pageWhere(origin, host)
    const key = `${family} ${where}`
    if (seen.has(key)) return
    seen.add(key)
    log(`Page connected: ${family} on ${where}`)
  }
}
