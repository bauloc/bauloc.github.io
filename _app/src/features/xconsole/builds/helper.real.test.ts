import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startRealHelper, type RealHelper } from '@/features/device/helper/testing/real-helper'
import { memoryStores, readTokenEntries, type TokenStores } from '@/features/device/helper/token'

import {
  GITHUB_UPLOAD,
  HelperUploadError,
  pairHelper,
  probeHelper,
  uploadViaHelper,
} from './helper'

/*
  The console's side of the helper against the REAL built helper (device/agent/device-bridge.mjs,
  started in this process with Device Lab's fake lanes): that it lists `github.upload`, that its
  fingerprint and proof pass the console's checks — so a pairing made here is one the helper
  honours — and that an upload carrying a token it does not hold is refused at its door. No
  upload here leaves this process: the one sent is refused before the helper reads its body.
*/

let helper: RealHelper
let stores: TokenStores

beforeEach(async () => {
  helper = await startRealHelper()
  stores = memoryStores()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await helper.close()
})

/** What the console reaches for, pointed at this helper, from the hosted page's origin. */
const deps = () => ({
  fetch: helper.fetch,
  stores,
  permissions: null,
  browser: { userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36', vendor: 'Google Inc.' },
})

describe('the real helper', () => {
  it('can upload to releases, and pairs with the link it prints', async () => {
    // The console looks where Device Lab last paired: here, this helper's port.
    stores.local?.setItem('dvc_port', String(helper.port))
    const before = await probeHelper(undefined, deps())
    expect(before).toMatchObject({ state: 'unpaired', port: helper.port })

    const link = `https://bauloc.github.io/device/#pair=${helper.token}&port=${String(helper.port)}`
    const paired = await pairHelper(link, deps())
    expect(paired).toEqual({
      ok: true,
      helper: {
        state: 'ready',
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown,
        port: helper.port,
        token: helper.token,
      },
    })
    expect(readTokenEntries(stores).session?.tokenId).toBe(helper.tokenId)
    expect(await probeHelper(undefined, deps())).toMatchObject({ state: 'ready' })
    // Not one request carried the token: health is all the console asked.
    expect(helper.requests.every((r) => r.authorization === null)).toBe(true)
    expect(helper.requests.every((r) => r.url.includes('/api/health?challenge='))).toBe(true)
  })

  it('lists the feature the console looks for', async () => {
    const health = (await (await helper.fetch(`${helper.apiBase}/api/health`)).json()) as {
      features: string[]
    }
    expect(health.features).toContain(GITHUB_UPLOAD)
  })

  it('refuses an upload with a token it does not hold, before reading the file', async () => {
    // XMLHttpRequest as a page on bauloc.github.io sends it, by the harness's fetch.
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        status = 0
        responseText = ''
        upload = { onprogress: null }
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        onabort: (() => void) | null = null
        private request = { method: '', url: '', headers: {} as Record<string, string> }
        open(method: string, url: string) {
          this.request = { ...this.request, method, url }
        }
        setRequestHeader(name: string, value: string) {
          this.request.headers[name] = value
        }
        abort() {
          this.onabort?.()
        }
        send(body: Blob) {
          void helper
            .fetch(this.request.url, {
              method: this.request.method,
              headers: this.request.headers,
              body,
            })
            .then(async (response) => {
              this.status = response.status
              this.responseText = await response.text()
              this.onload?.()
            })
            .catch(() => this.onerror?.())
        }
      },
    )
    const refused: unknown = await uploadViaHelper({
      port: helper.port,
      token: 'ZYXWVUTSRQzyxwvutsrq9876543210-_zyxwvutsrqp',
      pat: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      releaseId: 182736455,
      name: 'big-1.0-1.apk',
      file: new Blob([new Uint8Array(4096)]),
      contentType: 'application/vnd.android.package-archive',
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(HelperUploadError)
    expect(refused).toMatchObject({ code: 'HELPER_UNAUTHORIZED', status: 401 })
  })
})
