/*
  XConsole's release upload (§2.10): POST /api/github/release-asset streams one build file to a
  GitHub release, through a local fake of uploads.github.com (fakes/github.ts) put in place
  with createBridge's `githubUploads`. Nothing here reaches GitHub.

  - the pure parts: the request's checks, the fixed upstream URL and headers, GitHub's words
    and the answer mapping;
  - the route through the whole §2.1 pipeline: Origin and the bearer token still first, the
    preflight naming X-GitHub-Token, every refusal before a byte reaches GitHub;
  - the stream: bytes and headers exactly as GitHub must get them, back-pressure, the page
    going away, one upload at a time, the idle deadline, shutdown, and Node's own request
    deadline lifted only while an upload streams;
  - the terminal: the token, the query and the helper's own token never in a line.
*/
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ASSET_NAME,
  GITHUB_TOKEN,
  RELEASE_ID,
  githubAnswer,
  githubMessage,
  parseUpload,
  uploadHeaders,
  uploadUrl,
  type ReleaseUpload,
} from '../src/github-upload'
import { HelperError } from '../src/util'
import type { ErrorBody, Health, ReleaseAsset } from '../src/types'
import { DOWNLOAD, TAG, startFakeGitHub, storedAsset, type FakeGitHub } from './fakes/github'
import { freePort, request, startBridge, until, type Reply, type Started } from './harness'

const SITE = 'https://bauloc.github.io'
/** A fake token in the shape of a classic one; every log line is searched for it. */
const PAT = 'ghp_TestTokenNeverLogged0123456789abcd'
const RELEASE = '254881234'
const NAME = 'big-app-1.4.0-77.apk'
const APK = 'application/vnd.android.package-archive'
const MiB = 1024 * 1024

const assetPath = (query = `release=${RELEASE}&name=${NAME}`): string =>
  `/api/github/release-asset?${query}`
const upstreamPath = `/repos/bauloc/bauloc.github.io/releases/${RELEASE}/assets?name=${NAME}`
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const codeOf = (reply: Reply): string => reply.json<ErrorBody>().error.code

/* ------------------------------------------------------------------ the pure parts --- */

const HEADERS = {
  'content-length': '1048576',
  'content-type': APK,
  'x-github-token': PAT,
}
const QUERY = `?release=${RELEASE}&name=${NAME}`

/** parseUpload's refusal for one request, as [status, code], or the upload it reads. */
function refusal(headers: Record<string, string | undefined>, search = QUERY): [number, string] {
  try {
    parseUpload(headers, search)
  } catch (error) {
    if (error instanceof HelperError) return [error.status, error.code]
    throw error
  }
  return [0, 'accepted']
}

describe('parseUpload: the request, checked before its body is read (§2.10)', () => {
  it('reads a good request', () => {
    expect(parseUpload(HEADERS, QUERY)).toEqual({
      release: RELEASE,
      name: NAME,
      contentType: APK,
      size: MiB,
      token: PAT,
    })
    expect(
      parseUpload(
        { ...HEADERS, 'content-type': ' Application/Octet-Stream ' },
        '?name=app.ipa&release=1',
      ),
    ).toMatchObject({ name: 'app.ipa', release: '1', contentType: 'application/octet-stream' })
  })

  it.each<[string, Record<string, string | undefined>, number, string]>([
    ['no length', { 'content-length': undefined }, 411, 'LENGTH_REQUIRED'],
    ['a chunked body', { 'transfer-encoding': 'chunked' }, 411, 'LENGTH_REQUIRED'],
    ['a length that is not a number', { 'content-length': '12abc' }, 400, 'BAD_REQUEST'],
    ['an empty file', { 'content-length': '0' }, 400, 'BAD_REQUEST'],
    [
      '2 GiB, one byte past GitHub’s limit',
      { 'content-length': '2147483648' },
      413,
      'PAYLOAD_TOO_LARGE',
    ],
    ['no Content-Type', { 'content-type': undefined }, 400, 'BAD_REQUEST'],
    ['another Content-Type', { 'content-type': 'text/html' }, 400, 'BAD_REQUEST'],
    ['a Content-Type with parameters', { 'content-type': `${APK}; q=1` }, 400, 'BAD_REQUEST'],
    ['no X-GitHub-Token', { 'x-github-token': undefined }, 400, 'BAD_REQUEST'],
    ['a short token', { 'x-github-token': 'ghp_short' }, 400, 'BAD_REQUEST'],
    [
      'a token with a space',
      { 'x-github-token': 'ghp_abc def0123456789abcdef' },
      400,
      'BAD_REQUEST',
    ],
    ['two tokens', { 'x-github-token': `${PAT}, ${PAT}` }, 400, 'BAD_REQUEST'],
    ['a token of 256 characters', { 'x-github-token': 'a'.repeat(256) }, 400, 'BAD_REQUEST'],
  ])('refuses %s', (_name, patch, status, code) => {
    expect(refusal({ ...HEADERS, ...patch })).toEqual([status, code])
  })

  it('takes exactly GitHub’s largest file, 2 147 483 647 bytes', () => {
    expect(parseUpload({ ...HEADERS, 'content-length': '2147483647' }, QUERY).size).toBe(
      2_147_483_647,
    )
  })

  it.each([
    ['no query', ''],
    ['no release', `?name=${NAME}`],
    ['no name', `?release=${RELEASE}`],
    ['a release that is not a number', `?release=12a&name=${NAME}`],
    ['a release of 16 digits', `?release=${'1'.repeat(16)}&name=${NAME}`],
    ['a negative release', `?release=-1&name=${NAME}`],
    ['two releases', `?release=1&release=2&name=${NAME}`],
    ['another parameter', `?release=1&name=${NAME}&owner=evil`],
    ['a name with a path', `?release=1&name=..%2Fapp.apk`],
    ['a name in capitals', `?release=1&name=App.apk`],
    ['a name that starts with a dot', `?release=1&name=.app.apk`],
    ['a name with a space', `?release=1&name=my%20app.apk`],
    ['a zip', `?release=1&name=app.zip`],
    ['a name of 84 characters', `?release=1&name=${'a'.repeat(80)}.apk`],
  ])('refuses %s with 400', (_name, search) => {
    expect(refusal(HEADERS, search)).toEqual([400, 'BAD_REQUEST'])
  })

  it('never repeats the token in a refusal', () => {
    for (const patch of [{ 'content-type': 'text/html' }, { 'content-length': '0' }]) {
      try {
        parseUpload({ ...HEADERS, ...patch }, QUERY)
      } catch (error) {
        expect(JSON.stringify({ ...(error as HelperError) }) + String(error)).not.toContain(PAT)
      }
    }
  })

  it('has the contract’s patterns', () => {
    expect(GITHUB_TOKEN.test(`github_pat_${'A1'.repeat(41)}`)).toBe(true)
    expect(RELEASE_ID.test('123456789012345')).toBe(true)
    expect(ASSET_NAME.test(`${'a'.repeat(79)}.ipa`)).toBe(true)
    expect(ASSET_NAME.test(`${'a'.repeat(80)}.ipa`)).toBe(false)
  })
})

describe('the upstream: fixed host and repository, the token in one header', () => {
  const upload: ReleaseUpload = {
    release: RELEASE,
    name: NAME,
    contentType: APK,
    size: 5 * MiB,
    token: PAT,
  }

  it('posts to the site’s own repository on uploads.github.com', () => {
    expect(uploadUrl('https://uploads.github.com', upload).href).toBe(
      `https://uploads.github.com${upstreamPath}`,
    )
  })

  it('lets a test replace only the origin, never the path', () => {
    expect(uploadUrl('http://127.0.0.1:9/elsewhere/', upload).href).toBe(
      `http://127.0.0.1:9${upstreamPath}`,
    )
  })

  it('sends the token in Authorization and nowhere in the URL', () => {
    expect(uploadHeaders(upload)).toEqual({
      Authorization: `token ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': APK,
      'Content-Length': String(5 * MiB),
      'User-Agent': 'bauloc-device-bridge/1.4.0',
    })
    expect(uploadUrl('https://uploads.github.com', upload).href).not.toContain(PAT)
  })
})

describe('GitHub’s answer, as the helper passes it on', () => {
  const asset = storedAsset(NAME, 5 * MiB, APK)

  it('passes a stored file on as {id, name, size, url}', () => {
    expect(githubAnswer(201, asset)).toEqual({
      id: 245_678_901,
      name: NAME,
      size: 5 * MiB,
      url: `${DOWNLOAD}${TAG}/${NAME}`,
    })
  })

  it.each([
    ['another repository', 'https://github.com/evil/bauloc.github.io/releases/download/x/a.apk'],
    [
      'a look-alike host',
      'https://github.com.evil.example/bauloc/bauloc.github.io/releases/download/x/a.apk',
    ],
    [
      'a look-alike repository',
      'https://github.com/bauloc/bauloc.github.io.evil/releases/download/x/a.apk',
    ],
    ['plain http', 'http://github.com/bauloc/bauloc.github.io/releases/download/x/a.apk'],
    ['a space', `${DOWNLOAD}${TAG}/a b.apk`],
    ['no address', undefined],
  ])('refuses a 201 whose address is %s', (_name, url) => {
    expect(() => githubAnswer(201, { ...asset, browser_download_url: url })).toThrow(
      expect.objectContaining({
        code: 'GITHUB_UPLOAD_FAILED',
        status: 502,
        extra: { status: 201 },
      }),
    )
  })

  it.each<[string, unknown]>([
    ['an id that is not a number', { ...asset, id: '245678901' }],
    ['an id of 0', { ...asset, id: 0 }],
    ['no name', { ...asset, name: '' }],
    ['a size that is not a number', { ...asset, size: '5' }],
    ['no JSON at all', null],
  ])('refuses a 201 with %s', (_name, body) => {
    expect(() => githubAnswer(201, body)).toThrow(
      expect.objectContaining({ code: 'GITHUB_UPLOAD_FAILED' }),
    )
  })

  it('maps 401 to GITHUB_UNAUTHORIZED, 422 to GITHUB_ASSET_EXISTS, the rest to GITHUB_UPLOAD_FAILED', () => {
    const fail = (status: number, body: unknown): HelperError => {
      try {
        githubAnswer(status, body)
      } catch (error) {
        return error as HelperError
      }
      throw new Error('accepted')
    }
    expect(fail(401, { message: 'Bad credentials' })).toMatchObject({
      code: 'GITHUB_UNAUTHORIZED',
      status: 502,
    })
    const exists = fail(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }],
    })
    expect([exists.code, exists.message]).toEqual([
      'GITHUB_ASSET_EXISTS',
      'Validation Failed: ReleaseAsset name already_exists',
    ])
    expect(fail(422, null).message).toBe('The release already has a file with this name.')
    expect(fail(404, { message: 'Not Found' })).toMatchObject({
      code: 'GITHUB_UPLOAD_FAILED',
      message: 'Not Found',
      extra: { status: 404 },
    })
    expect(fail(500, '<html>').message).toBe('GitHub answered 500.')
    expect(fail(200, { message: 'OK?' })).toMatchObject({ code: 'GITHUB_UPLOAD_FAILED' })
  })

  it('cleans GitHub’s words and cuts them at 300 characters', () => {
    expect(githubMessage({ message: `bad\u001b[31m red\u0007 ${'x'.repeat(400)}` })).toBe(
      `bad red ${'x'.repeat(292)}`,
    )
    expect(githubMessage({ errors: ['one', { message: 'two' }, 3, null] })).toBe('one; two')
    expect(githubMessage(null)).toBe('')
    expect(githubMessage([1, 2])).toBe('')
  })
})

/* -------------------------------------------------------------------- the route --- */

interface UploadOptions {
  query?: string
  /** Over the defaults; `undefined` leaves a header out. */
  headers?: Record<string, string | undefined>
  body?: Buffer
  /** Write the body this many bytes at a time… */
  chunk?: number
  /** …this long apart. */
  gapMs?: number
}

/** An upload as XConsole's XHR sends it: Origin, bearer, X-GitHub-Token, the file's type and length. */
function upload(s: Started, o: UploadOptions = {}): Promise<Reply> {
  const body = o.body ?? randomBytes(64 * 1024)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries({
    Host: `127.0.0.1:${String(s.port)}`,
    ...s.auth,
    'X-GitHub-Token': PAT,
    'Content-Type': APK,
    'Content-Length': String(body.length),
    ...o.headers,
  })) {
    if (value !== undefined) headers[name] = value
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: s.port,
        method: 'POST',
        path: assetPath(o.query),
        agent: false,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (data: Buffer) => chunks.push(data))
        res.on('end', () => {
          const all = Buffer.concat(chunks)
          const text = all.toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: all,
            text,
            json: <T>() => JSON.parse(text) as T,
          })
        })
      },
    )
    req.on('error', reject)
    const size = o.chunk ?? 256 * 1024
    let at = 0
    const next = (): void => {
      if (req.destroyed) return
      if (at >= body.length) {
        req.end()
        return
      }
      const piece = body.subarray(at, at + size)
      at += piece.length
      const go = (): void => {
        if (o.gapMs) setTimeout(next, o.gapMs)
        else next()
      }
      if (req.write(piece)) go()
      else req.once('drain', go)
    }
    next()
  })
}

/**
 * Raw bytes on a socket, for framing Node's client would fix (no length, a chunked body), and
 * for a refused upload read the way a browser reads it: the request and the start of its body
 * sent, then whatever the helper answers before it closes the connection. Chrome reads an
 * answer that arrives mid-upload once its next write fails; this client stops writing instead.
 */
function rawRequest(port: number, head: string[], body: string | Buffer = ''): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`), Buffer.from(body)]))
    })
    socket.on('data', (chunk) => (data += chunk.toString('latin1')))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(data))
  })
}

/** The status, headers (lower-cased) and JSON body of a raw answer. */
function parseRaw(answer: string): {
  status: number
  headers: Record<string, string>
  json: ErrorBody
} {
  const end = answer.indexOf('\r\n\r\n')
  const [statusLine = '', ...lines] = answer.slice(0, end).split('\r\n')
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return {
    status: Number(statusLine.split(' ')[1]),
    headers,
    json: JSON.parse(answer.slice(end + 4)) as ErrorBody,
  }
}

let gh: FakeGitHub
let s: Started
beforeAll(async () => {
  gh = await startFakeGitHub()
  s = await startBridge({ githubUploads: gh.url, verbose: true })
})

describe('the §2.1 pipeline still comes first', () => {
  it('refuses another site with a bare 403, before GitHub hears of it', async () => {
    const before = gh.seen.length
    const reply = await upload(s, { headers: { Origin: 'https://evil.example' } })
    expect([reply.status, codeOf(reply)]).toEqual([403, 'BAD_ORIGIN'])
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(gh.seen.length).toBe(before)
  })

  it.each([
    ['no bearer token', []],
    ['a wrong one', [`Authorization: Bearer ${'B'.repeat(43)}`]],
  ])(
    'answers 401 to %s at once, readable, closing the connection, GitHub untouched',
    async (_name, auth) => {
      const before = gh.seen.length
      /** A file of 64 MiB is announced; the answer comes after its first 16 KiB, unread. */
      const answer = parseRaw(
        await rawRequest(
          s.port,
          [
            `POST ${assetPath()} HTTP/1.1`,
            `Host: 127.0.0.1:${String(s.port)}`,
            `Origin: ${SITE}`,
            ...auth,
            `X-GitHub-Token: ${PAT}`,
            `Content-Type: ${APK}`,
            `Content-Length: ${String(64 * MiB)}`,
          ],
          randomBytes(16 * 1024),
        ),
      )
      expect([answer.status, answer.json.error.code]).toEqual([401, 'UNAUTHORIZED'])
      expect(answer.headers['access-control-allow-origin']).toBe(SITE)
      expect(answer.headers.connection).toBe('close')
      expect(gh.seen.length).toBe(before)
    },
  )

  it('lets this route alone past the 1 KiB body cap', async () => {
    const elsewhere = await request(s.port, {
      method: 'POST',
      path: '/api/rescan',
      headers: { ...s.auth, 'Content-Length': '2048' },
      body: 'x'.repeat(2048),
    })
    expect([elsewhere.status, codeOf(elsewhere)]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
    const big = await upload(s, { body: randomBytes(2048) })
    expect(big.status).toBe(201)
  })

  it('answers the CORS preflight naming X-GitHub-Token, with no token needed', async () => {
    const reply = await request(s.port, {
      method: 'OPTIONS',
      path: assetPath(),
      headers: {
        Origin: SITE,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-github-token',
      },
    })
    expect(reply.status).toBe(204)
    expect(reply.headers['access-control-allow-origin']).toBe(SITE)
    expect(reply.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS')
    expect(reply.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, X-GitHub-Token',
    )
  })

  it('takes POST only', async () => {
    const reply = await request(s.port, { path: assetPath(), headers: s.auth })
    expect([reply.status, reply.headers.allow]).toEqual([405, 'POST'])
  })

  it('lists github.upload in health, from 1.4.0', async () => {
    const health = (await request(s.port, { path: '/api/health' })).json<Health>()
    expect(health.version).toBe('1.4.0')
    expect(health.features).toContain('github.upload')
  })
})

describe('the request’s checks, through the route (§2.10)', () => {
  it.each<[string, UploadOptions, number, string]>([
    ['no X-GitHub-Token', { headers: { 'X-GitHub-Token': undefined } }, 400, 'BAD_REQUEST'],
    ['a malformed token', { headers: { 'X-GitHub-Token': 'not a token' } }, 400, 'BAD_REQUEST'],
    ['another Content-Type', { headers: { 'Content-Type': 'text/plain' } }, 400, 'BAD_REQUEST'],
    ['a release that is not a number', { query: `release=x&name=${NAME}` }, 400, 'BAD_REQUEST'],
    ['a name that is not a build', { query: `release=${RELEASE}&name=a.exe` }, 400, 'BAD_REQUEST'],
    ['an extra parameter', { query: `release=1&name=${NAME}&x=1` }, 400, 'BAD_REQUEST'],
  ])(
    'answers %s with %i, closing the connection, GitHub untouched',
    async (_name, o, status, code) => {
      const before = gh.seen.length
      const reply = await upload(s, o)
      expect([reply.status, codeOf(reply)]).toEqual([status, code])
      expect(reply.headers['access-control-allow-origin']).toBe(SITE)
      expect(reply.headers.connection).toBe('close')
      expect(reply.text).not.toContain(PAT)
      expect(gh.seen.length).toBe(before)
    },
  )

  const head = (extra: string[]): string[] => [
    `POST ${assetPath()} HTTP/1.1`,
    `Host: 127.0.0.1:${String(s.port)}`,
    `Origin: ${SITE}`,
    `Authorization: Bearer ${s.token}`,
    `X-GitHub-Token: ${PAT}`,
    `Content-Type: ${APK}`,
    ...extra,
  ]

  it('answers a request without a length 411', async () => {
    const answer = await rawRequest(s.port, head(['Connection: close']))
    expect(answer).toMatch(/^HTTP\/1\.1 411 /)
    expect(answer).toContain('"code":"LENGTH_REQUIRED"')
  })

  it('answers a chunked body 411, without reading it', async () => {
    const answer = await rawRequest(
      s.port,
      head(['Transfer-Encoding: chunked']),
      '5\r\nhello\r\n0\r\n\r\n',
    )
    expect(answer).toMatch(/^HTTP\/1\.1 411 /)
    expect(answer).toContain('"code":"LENGTH_REQUIRED"')
  })

  it('answers a file of 2 GiB 413 at once, without waiting for its bytes', async () => {
    const started = Date.now()
    const answer = await rawRequest(s.port, head(['Content-Length: 2147483648']))
    expect(answer).toMatch(/^HTTP\/1\.1 413 /)
    expect(answer).toContain('"code":"PAYLOAD_TOO_LARGE"')
    expect(answer).toMatch(/\r\nConnection: close\r\n/i)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('answers an empty file 400', async () => {
    const answer = await rawRequest(s.port, head(['Content-Length: 0', 'Connection: close']))
    expect(answer).toMatch(/^HTTP\/1\.1 400 /)
    expect(answer).toContain('"code":"BAD_REQUEST"')
  })
})

describe('the stream to GitHub', () => {
  it('streams a few MB, with exactly the path and headers GitHub must get', async () => {
    gh.behave({ kind: 'store' })
    const body = randomBytes(5 * MiB + 123)
    const reply = await upload(s, { body })
    expect(reply.status).toBe(201)
    expect(reply.json<ReleaseAsset>()).toEqual({
      id: 245_678_901,
      name: NAME,
      size: body.length,
      url: `${DOWNLOAD}${TAG}/${NAME}`,
    })
    expect(reply.headers['access-control-allow-origin']).toBe(SITE)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers.connection).toBe('close')

    const seen = gh.seen.at(-1)!
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe(upstreamPath)
    expect(seen.sha256).toBe(sha256(body))
    expect(seen.bytes).toBe(body.length)
    const { host, connection, ...rest } = seen.headers
    expect(host).toBe(gh.url.slice('http://'.length))
    expect(connection).toBe('close')
    expect(rest).toEqual({
      authorization: `token ${PAT}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': APK,
      'content-length': String(body.length),
      'user-agent': 'bauloc-device-bridge/1.4.0',
    })
    /** The helper's own token and the page's origin stay on this Mac. */
    expect(JSON.stringify(seen.headers)).not.toContain(s.token)
    expect(seen.url).not.toContain(PAT)
  })

  it('sends an IPA as plain bytes', async () => {
    const reply = await upload(s, {
      query: `release=${RELEASE}&name=app-2.0-1.ipa`,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(reply.status).toBe(201)
    expect(gh.seen.at(-1)?.headers['content-type']).toBe('application/octet-stream')
  })

  it('holds back the page while GitHub is slow: back-pressure, not memory', async () => {
    gh.behave({ kind: 'hold' })
    const total = 64 * MiB
    const piece = randomBytes(MiB)
    const hash = createHash('sha256')
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      method: 'POST',
      path: assetPath(),
      agent: false,
      headers: {
        ...s.auth,
        'X-GitHub-Token': PAT,
        'Content-Type': APK,
        'Content-Length': String(total),
      },
    })
    const answered = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
    })
    let sent = 0
    const pump = (): Promise<boolean> =>
      new Promise((resolve) => {
        const go = (): void => {
          while (sent < total) {
            sent += piece.length
            hash.update(piece)
            if (!req.write(piece)) {
              const stalled = setTimeout(() => resolve(true), 400)
              req.once('drain', () => {
                clearTimeout(stalled)
                go()
              })
              return
            }
          }
          resolve(false)
        }
        go()
      })
    expect(await pump()).toBe(true)
    /** A stalled loopback pipe absorbs 4–7 MiB on the build Mac, at most about 16 MiB. */
    expect(sent).toBeLessThan(total / 2)
    expect(gh.seen.at(-1)?.bytes ?? 0).toBeLessThan(total / 2)
    gh.release()
    gh.behave({ kind: 'store' })
    await new Promise<void>((resolve) => {
      const rest = (): void => {
        while (sent < total) {
          sent += piece.length
          hash.update(piece)
          if (!req.write(piece)) {
            req.once('drain', rest)
            return
          }
        }
        req.end()
        resolve()
      }
      rest()
    })
    expect(await answered).toBe(201)
    await until(() => gh.seen.at(-1)?.sha256 !== null, 5_000, 'the whole file')
    expect(gh.seen.at(-1)?.sha256).toBe(hash.digest('hex'))
  })

  it.each<[string, number, unknown, string, Record<string, unknown>]>([
    ['a refused token', 401, { message: 'Bad credentials' }, 'GITHUB_UNAUTHORIZED', {}],
    [
      'a file the release already has',
      422,
      {
        message: 'Validation Failed',
        errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }],
      },
      'GITHUB_ASSET_EXISTS',
      { message: 'Validation Failed: ReleaseAsset name already_exists' },
    ],
    [
      'a server error, its message cut at 300',
      500,
      { message: 'y'.repeat(400) },
      'GITHUB_UPLOAD_FAILED',
      { status: 500, message: 'y'.repeat(300) },
    ],
    [
      'a release that is gone',
      404,
      { message: 'Not Found' },
      'GITHUB_UPLOAD_FAILED',
      { status: 404 },
    ],
    [
      'a 201 pointing elsewhere',
      201,
      { ...storedAsset(NAME, 1, APK), browser_download_url: 'https://evil.example/a.apk' },
      'GITHUB_UPLOAD_FAILED',
      { status: 201 },
    ],
  ])('answers %s with 502 and its code', async (_name, status, body, code, extra) => {
    gh.behave({ kind: 'answer', status, body })
    const reply = await upload(s)
    expect(reply.status).toBe(502)
    expect(reply.json<ErrorBody>().error).toMatchObject({ code, ...extra })
    expect(reply.headers['access-control-allow-origin']).toBe(SITE)
    gh.behave({ kind: 'store' })
  })

  it('takes GitHub’s early answer as the answer, while the page is still sending', async () => {
    const failed = (): number =>
      s.logs.filter(
        (line) => line.includes('GitHub upload: failed') && line.includes('UNAUTHORIZED'),
      ).length
    const before = failed()
    gh.behave({ kind: 'answer', status: 401, body: { message: 'Bad credentials' }, early: true })
    /** 256 KiB of a 64 MiB file sent, the rest still to come when GitHub refuses. */
    const answer = parseRaw(
      await rawRequest(
        s.port,
        [
          `POST ${assetPath()} HTTP/1.1`,
          `Host: 127.0.0.1:${String(s.port)}`,
          `Origin: ${SITE}`,
          `Authorization: Bearer ${s.token}`,
          `X-GitHub-Token: ${PAT}`,
          `Content-Type: ${APK}`,
          `Content-Length: ${String(64 * MiB)}`,
        ],
        randomBytes(256 * 1024),
      ),
    )
    gh.behave({ kind: 'store' })
    expect([answer.status, answer.json.error.code]).toEqual([502, 'GITHUB_UNAUTHORIZED'])
    expect(answer.headers['access-control-allow-origin']).toBe(SITE)
    expect(answer.headers.connection).toBe('close')
    expect(gh.seen.at(-1)?.bytes ?? 0).toBeLessThan(64 * MiB)
    await until(() => failed() > before, 3_000, 'the failure line')
    expect((await upload(s)).status).toBe(201)
  })

  it('destroys the request to GitHub when the page goes away mid-file, and frees the slot', async () => {
    gh.behave({ kind: 'store' })
    const before = gh.seen.length
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      method: 'POST',
      path: assetPath(),
      agent: false,
      headers: {
        ...s.auth,
        'X-GitHub-Token': PAT,
        'Content-Type': APK,
        'Content-Length': String(8 * MiB),
      },
    })
    req.on('error', () => undefined)
    req.write(randomBytes(MiB))
    const seen = await gh.arrived(before + 1)
    await until(() => seen.bytes >= MiB, 3_000, 'the first MiB at GitHub')
    req.destroy()
    await seen.done
    expect([seen.aborted, seen.cut]).toEqual([true, true])
    expect(seen.sha256).toBeNull()
    await until(() =>
      s.logs.some((line) => /GitHub upload: stopped after [\d.]+ s: the page went away/.test(line)),
    )
    expect((await upload(s)).status).toBe(201)
  })

  it('runs one upload at a time: a second gets 409 UPLOAD_BUSY', async () => {
    gh.behave({ kind: 'hold' })
    const before = gh.seen.length
    const first = upload(s, { body: randomBytes(MiB) })
    await gh.arrived(before + 1)
    gh.behave({ kind: 'store' })
    const second = await upload(s, { body: randomBytes(1024) })
    expect([second.status, codeOf(second)]).toEqual([409, 'UPLOAD_BUSY'])
    expect(second.headers.connection).toBe('close')
    expect(gh.seen.length).toBe(before + 1)
    gh.release()
    expect((await first).status).toBe(201)
    expect((await upload(s)).status).toBe(201)
  })
})

describe('when GitHub can’t be reached, or stops', () => {
  it('answers GITHUB_UNREACHABLE when nothing listens', async () => {
    const closed = await startBridge({
      githubUploads: `http://127.0.0.1:${String(await freePort())}`,
    })
    const reply = await upload(closed, { body: randomBytes(1024) })
    expect([reply.status, codeOf(reply)]).toEqual([502, 'GITHUB_UNREACHABLE'])
    expect(closed.logs.some((line) => line.includes('GitHub upload: failed after'))).toBe(true)
  })

  it('gives up when nothing moves for githubIdle, and destroys the request to GitHub', async () => {
    const quiet = await startFakeGitHub()
    quiet.behave({ kind: 'silent' })
    const b = await startBridge({ githubUploads: quiet.url, timeouts: { githubIdle: 300 } })
    const started = Date.now()
    const reply = await upload(b)
    expect([reply.status, codeOf(reply)]).toEqual([502, 'GITHUB_UNREACHABLE'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    /** GitHub had the whole file and never answered: the helper hung up on it. */
    const seen = quiet.seen[0]!
    await seen.done
    expect(seen.sha256).not.toBeNull()
    expect(seen.cut).toBe(true)
    quiet.behave({ kind: 'store' })
    expect((await upload(b)).status).toBe(201)
    await quiet.stop()
  })

  it('gives up on a page that stops sending mid-file, and frees the slot', async () => {
    const b = await startBridge({ githubUploads: gh.url, timeouts: { githubIdle: 300 } })
    gh.behave({ kind: 'store' })
    const answer = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: b.port,
          method: 'POST',
          path: assetPath(),
          agent: false,
          headers: {
            ...b.auth,
            'X-GitHub-Token': PAT,
            'Content-Type': APK,
            'Content-Length': '1000',
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.write(Buffer.alloc(500))
    })
    expect(answer).toBe(502)
    expect((await upload(b)).status).toBe(201)
  })

  it('stops the upload mid-file when the helper stops, and tells the page', async () => {
    const github = await startFakeGitHub()
    const b = await startBridge({ githubUploads: github.url })
    /** Half of a 2 MiB file sent; the rest never comes before the helper stops. */
    const reply = new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: b.port,
          method: 'POST',
          path: assetPath(),
          agent: false,
          headers: {
            ...b.auth,
            'X-GitHub-Token': PAT,
            'Content-Type': APK,
            'Content-Length': String(2 * MiB),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (data: Buffer) => chunks.push(data))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.from(text),
              text,
              json: <T>() => JSON.parse(text) as T,
            })
          })
        },
      )
      req.on('error', reject)
      req.write(randomBytes(MiB))
    })
    const seen = await github.arrived(1)
    await until(() => seen.bytes >= MiB, 3_000, 'the first half at GitHub')
    await b.bridge.close()
    await seen.done
    expect([seen.aborted, seen.cut]).toEqual([true, true])
    const answer = await reply
    expect([answer.status, codeOf(answer)]).toEqual([503, 'HELPER_STOPPING'])
    expect(
      b.logs.some((line) =>
        /GitHub upload: stopped after [\d.]+ s: the helper is stopping/.test(line),
      ),
    ).toBe(true)
    await github.stop()
  })
})

describe('Node’s request deadline, lifted only while an upload streams', () => {
  /** A POST whose 64-byte body trickles in over ~3 s; resolves with how long the server let it live. */
  const trickle = (port: number, token: string): Promise<number> =>
    new Promise((resolve) => {
      const started = Date.now()
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'POST /api/rescan HTTP/1.1',
            `Host: 127.0.0.1:${String(port)}`,
            `Authorization: Bearer ${token}`,
            'Content-Length: 64',
            '',
            '',
          ].join('\r\n'),
        )
        let sent = 0
        const timer = setInterval(() => {
          if (socket.destroyed || sent >= 64) return clearInterval(timer)
          socket.write('xx')
          sent += 2
        }, 100)
      })
      /** Read what comes (the answer, then the refusal), or the close is never seen. */
      socket.resume()
      socket.on('error', () => undefined)
      socket.on('close', () => resolve(Date.now() - started))
    })

  it('still cuts a slow body elsewhere, before and after an upload slower than the deadline', async () => {
    /** Node swaps the two deadlines when headersTimeout is the longer, as it never is in use. */
    const b = await startBridge({
      githubUploads: gh.url,
      timeouts: { requestTimeout: 300, headersTimeout: 200, requestCheck: 50, githubIdle: 2_000 },
    })
    gh.behave({ kind: 'store' })
    expect(await trickle(b.port, b.token)).toBeLessThan(1_500)
    /** 20 pieces 60 ms apart: four times the deadline. */
    const slow = await upload(b, { body: randomBytes(20 * 1024), chunk: 1024, gapMs: 60 })
    expect(slow.status).toBe(201)
    expect(await trickle(b.port, b.token)).toBeLessThan(1_500)
  })
})

describe('the terminal (T25)', () => {
  it('says the size and the time, never the token, the query or the helper’s token', () => {
    const text = [...s.logs, ...s.errors].join('\n')
    expect(text).toMatch(/POST \/api\/github\/release-asset 201 \d+ ms · 5\.0 MB/)
    expect(text).toMatch(/GitHub upload: sending 5\.0 MB to a release…/)
    expect(text).toMatch(/GitHub upload: done, 5\.0 MB in [\d.]+ s/)
    expect(text).toMatch(/GitHub upload: failed after [\d.]+ s \(GITHUB_ASSET_EXISTS\)/)
    expect(text).not.toContain(PAT)
    expect(text).not.toContain('TestTokenNeverLogged')
    expect(text).not.toContain(s.token)
    expect(text).not.toContain(RELEASE)
    expect(text).not.toContain(NAME)
    expect(text).not.toContain('release=')
    expect(text).not.toContain('Bearer')
    expect(s.errors).toEqual([])
  })
})
