import { createHmac } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TokenFileError,
  browserFamily,
  createBearerCheck,
  createPageLog,
  pageWhere,
  generateToken,
  loadKeptToken,
  proofOf,
  tokenFilePath,
  tokenIdOf,
} from '../src/auth'
import { tempDir } from './harness'

const uid = process.getuid?.() ?? 0

describe('token, tokenId and proof', () => {
  it('generates 43-character base64url tokens, different every time', () => {
    const a = generateToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateToken()).not.toBe(a)
  })
  it('tokenIdOf("example-token") is 4d1566a1 (the page computes the same)', () => {
    expect(tokenIdOf('example-token')).toBe('4d1566a1')
  })
  it('proofOf is the HMAC of §2.8 and changes with the port', () => {
    const token = 'A'.repeat(43)
    const challenge = 'abcdefghijklmnopqrstuv'
    const reference = createHmac('sha256', token)
      .update(`bauloc-device-bridge proof v1|8787|${challenge}`)
      .digest('base64url')
    expect(proofOf(token, 8787, challenge)).toBe(reference)
    expect(proofOf(token, 8788, challenge)).not.toBe(reference)
  })
})

describe('createBearerCheck', () => {
  const token = generateToken()
  const check = createBearerCheck(token)
  it('accepts the token, in any case of the scheme', () => {
    expect(check(`Bearer ${token}`)).toBe(true)
    expect(check(`bearer ${token}`)).toBe(true)
  })
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['short', 'Bearer abc'],
    ['wrong', `Bearer ${'B'.repeat(43)}`],
    ['wrong scheme', `Basic ${token}`],
    ['extra text', `Bearer ${token} x`],
    ['the token alone', token],
  ])('refuses %s', (_name, header) => {
    expect(check(header)).toBe(false)
  })
})

describe('--keep-token file (§1.11)', () => {
  const opts = (home: string, newToken = false) => ({
    home,
    platform: 'darwin' as const,
    env: {},
    getuid: () => uid,
    newToken,
  })

  it('lives under Application Support on macOS and XDG_CONFIG_HOME elsewhere', () => {
    expect(tokenFilePath('/Users/b', 'darwin', {})).toBe(
      '/Users/b/Library/Application Support/bauloc-device-bridge/token',
    )
    expect(tokenFilePath('/home/b', 'linux', { XDG_CONFIG_HOME: '/cfg' })).toBe(
      '/cfg/bauloc-device-bridge/token',
    )
    expect(tokenFilePath('/home/b', 'linux', {})).toBe('/home/b/.config/bauloc-device-bridge/token')
  })
  it('creates a 0600 file in a 0700 folder, then keeps returning the same token', () => {
    const home = tempDir()
    const first = loadKeptToken(opts(home))
    expect(first.created).toBe(true)
    expect(statSync(first.path).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(first.path)).mode & 0o777).toBe(0o700)
    expect(readFileSync(first.path, 'utf8')).toBe(first.token + '\n')
    const again = loadKeptToken(opts(home))
    expect(again).toMatchObject({ token: first.token, created: false })
  })
  it('replaces the token with --new-token, and a corrupt file instead of trusting it', () => {
    const home = tempDir()
    const first = loadKeptToken(opts(home))
    const replaced = loadKeptToken(opts(home, true))
    expect(replaced.token).not.toBe(first.token)
    writeFileSync(replaced.path, 'not a token\n', { mode: 0o600 })
    const repaired = loadKeptToken(opts(home))
    expect(repaired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(repaired.created).toBe(true)
  })
  it('refuses a file other users can read, with the chmod fix', () => {
    const home = tempDir()
    const { path: file } = loadKeptToken(opts(home))
    chmodSync(file, 0o640)
    expect(() => loadKeptToken(opts(home))).toThrow(
      new TokenFileError(
        `The token file ${file} can be read by other users. Fix it with: chmod 600 '${file}'`,
      ),
    )
  })
  it('refuses a symbolic link', () => {
    const home = tempDir()
    const file = tokenFilePath(home, 'darwin', {})
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const elsewhere = path.join(home, 'elsewhere')
    writeFileSync(elsewhere, 'x'.repeat(43), { mode: 0o600 })
    symlinkSync(elsewhere, file)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(() => loadKeptToken(opts(home))).toThrow(
      `The token file ${file} is a symbolic link or belongs to another user; refusing to use it.`,
    )
  })
  it('refuses a file owned by another user', () => {
    const home = tempDir()
    const { path: file } = loadKeptToken(opts(home))
    expect(() => loadKeptToken({ ...opts(home), getuid: () => uid + 1 })).toThrow(TokenFileError)
    expect(() => loadKeptToken({ ...opts(home), getuid: () => uid + 1 })).toThrow(
      /is a symbolic link or belongs to another user/,
    )
    expect(readFileSync(file, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}\n$/)
  })
  it('words any other failure as a sentence, not a stack trace', () => {
    const home = tempDir()
    const blocked = path.join(home, 'Library')
    writeFileSync(blocked, 'a file where a folder should be')
    expect(() => loadKeptToken(opts(home))).toThrow(TokenFileError)
    expect(() => loadKeptToken(opts(home))).toThrow(/could not be used \(E[A-Z]+\)\.$/)
  })
  it('tightens its own folder when its permissions are loose', () => {
    const home = tempDir()
    const dir = path.dirname(tokenFilePath(home, 'darwin', {}))
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    loadKeptToken(opts(home))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('"Page connected" lines', () => {
  it('names the browser family, never the whole User-Agent', () => {
    expect(
      browserFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome')
    expect(browserFamily('Mozilla/5.0 … Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0')).toBe('Edge')
    expect(browserFamily('Mozilla/5.0 (Macintosh; rv:157.0) Gecko/20100101 Firefox/157.0')).toBe(
      'Firefox',
    )
    expect(
      browserFamily(
        'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
      ),
    ).toBe('Safari')
    expect(browserFamily('curl/8.7.1')).toBe('Another client')
    /** Headless Chrome (Playwright, Puppeteer, the integration runs) is Chrome too. */
    expect(
      browserFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome')
  })
  it('prints once per origin and family', () => {
    const lines: string[] = []
    const log = createPageLog((line) => lines.push(line))
    const chrome = 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36'
    log('https://bauloc.github.io', '127.0.0.1:8787', chrome)
    log('https://bauloc.github.io', '127.0.0.1:8787', chrome)
    log('http://127.0.0.1:8787', '127.0.0.1:8787', chrome)
    expect(lines).toEqual([
      'Page connected: Chrome on https://bauloc.github.io',
      'Page connected: Chrome on http://127.0.0.1:8787',
    ])
  })
  it('names the dev page by its command; "Another client" only without an Origin', () => {
    const lines: string[] = []
    const log = createPageLog((line) => lines.push(line))
    const chrome = 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36'
    log('http://localhost:7360', '127.0.0.1:8787', chrome)
    log('http://127.0.0.1:4173', '127.0.0.1:8787', chrome)
    log('http://localhost:8000', '127.0.0.1:8787', chrome)
    /** A page always has a browser behind it, even one this helper cannot name. */
    log('http://localhost:7360', '127.0.0.1:8787', 'SomeNewBrowser/1.0')
    log(undefined, '127.0.0.1:8787', 'curl/8.7.1')
    log(undefined, 'localhost:8787', undefined)
    expect(lines).toEqual([
      'Page connected: Chrome on the dev page http://localhost:7360 (npm run dev)',
      'Page connected: Chrome on the dev page http://127.0.0.1:4173 (vite preview)',
      'Page connected: Chrome on the dev page http://localhost:8000 (npm run serve:site)',
      'Page connected: A browser on the dev page http://localhost:7360 (npm run dev)',
      'Page connected: Another client on http://127.0.0.1:8787',
      'Page connected: Another client on http://localhost:8787',
    ])
    expect(pageWhere('https://bauloc.github.io', '127.0.0.1:8787')).toBe('https://bauloc.github.io')
  })
})
