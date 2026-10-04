import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { OUT_FILE, bundleHelper, forbiddenApis } from '../build.mjs'
import { tempDir } from './harness'

let code = ''
let file = ''
beforeAll(async () => {
  code = (await bundleHelper()).code
  file = path.join(tempDir('bundle-'), 'device-bridge.mjs')
  writeFileSync(file, code)
})

describe('the built file', () => {
  it('starts with the shebang and the header comment', () => {
    const lines = code.split('\n')
    expect(lines[0]).toBe('#!/usr/bin/env node')
    expect(lines[1]).toBe('/*')
    expect(lines[2]).toBe(' * Device Lab helper 1.1.1 (bauloc-device-bridge)')
    expect(code).toContain(' * What it never does')
    expect(code).toContain('https://github.com/bauloc/bauloc.github.io/tree/master/_app/helper/src')
  })
  it('has a table of contents whose line numbers point at the regions', () => {
    const lines = code.split('\n')
    const entries = [...code.matchAll(/^ \* +(\d+) {2}.+ (src\/[\w-]+\.ts)$/gm)]
    expect(entries.length).toBeGreaterThan(10)
    for (const [, line, module] of entries) {
      expect(lines[Number(line) - 1]).toBe(`//#region ${String(module)}`)
    }
  })
  it('titles every module in the contents by its section, never by its file name alone', () => {
    const entries = [...code.matchAll(/^ \* +\d+ {2}(.+?) +(src\/[\w-]+\.ts)$/gm)]
    const untitled = entries.filter(([, title]) => title?.startsWith('src/'))
    expect(untitled.map(([, , module]) => module)).toEqual([])
    expect(entries.map(([, title]) => title?.trim())).toContain('§9 mDNS browser')
  })
  it('says what it does on the network for Android, and that it never connects by itself', () => {
    expect(code).toContain(
      ' *     phones on the Wi-Fi with read-only mDNS questions, and never connects one by itself.',
    )
  })
  it('lays the modules out in the order of the spec’s sections (§1.2)', () => {
    const regions = [...code.matchAll(/^\/\/#region (\S+)$/gm)].map((m) => m[1])
    const order = [
      'src/guard.ts',
      'src/constants.ts',
      'src/cli.ts',
      'src/util.ts',
      'src/process.ts',
      'src/registry.ts',
      'src/auth.ts',
      'src/http.ts',
      'src/local-mode.ts',
      'src/bridge.ts',
      'src/main.ts',
    ]
    const positions = order.map((name) => regions.indexOf(name))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(regions[0]).toBe('src/guard.ts')
  })
  it('imports node: built-ins only and declares VERSION once', () => {
    const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(3)
    expect(imports.every((source) => source?.startsWith('node:'))).toBe(true)
    expect(code.match(/^const VERSION = "1\.1\.1";$/gm)).toHaveLength(1)
  })
  it('is 1.1.1, a fix on 1.1.0 (android.discover), in the line the page reads', () => {
    // A new feature bumps the minor version, a fix the patch (§2.8): 1.0.0 helpers exist
    // with and without discovery, so the page's update chip could not tell them apart by
    // version; 1.1.1 lets it tell a tester on 1.1.0 that the fixed helper is out.
    // The page's own pattern (preflight/env.ts HELPER_VERSION_LINE), on the published file.
    expect(/^const VERSION = "([^"]+)";$/m.exec(code)?.[1]).toBe('1.1.1')
    expect(code).toContain('lanes.android ? "android.discover" : null')
  })
  it('keeps the doc comments a reader needs', () => {
    expect(code).toContain('* 1. Host: a DNS-rebound evil.example still says')
    expect(code).not.toContain('@__PURE__')
  })
})

describe('Node 18 denylist (§1.1)', () => {
  it('finds nothing in the fresh build, nor in the committed file', () => {
    expect(forbiddenApis(code)).toEqual([])
    if (existsSync(OUT_FILE)) expect(forbiddenApis(readFileSync(OUT_FILE, 'utf8'))).toEqual([])
  })
  it.each([
    ['AbortSignal.any', 'const s = AbortSignal.any([a, b])'],
    ['Promise.withResolvers', 'const { promise } = Promise.withResolvers()'],
    ['.toSorted()', 'const x = [3, 1].toSorted()'],
    ['.toReversed()', 'const x = [3, 1].toReversed()'],
    ['Object.groupBy', 'Object.groupBy([], (x) => x)'],
    ['the regex v flag', 'const r = /[\\p{L}--[a-z]]/v'],
    ['the regex v flag', 'const r = new RegExp("a", "v")'],
    ['import.meta.dirname', 'const d = import.meta.dirname'],
    ['import.meta.filename', 'const f = import.meta.filename'],
    ['node:sqlite', 'import { DatabaseSync } from "node:sqlite"'],
    ['glob from node:fs', 'import { glob } from "node:fs"'],
    ['glob from node:fs/promises', 'import { glob } from "node:fs/promises"'],
    ['globalThis.crypto', 'const c = globalThis.crypto.getRandomValues(new Uint8Array(4))'],
    ['crypto (the global WebCrypto)', 'const u = crypto.randomUUID()'],
    ['an import of "zod" (built-ins only)', 'import { z } from "zod"'],
    ['require()', 'const fs = require("fs")'],
  ])('catches %s', (api, snippet) => {
    expect(forbiddenApis(snippet).map((hit) => hit.api)).toContain(api)
  })
  it('ignores comments and allows what Node 18 has', () => {
    expect(
      forbiddenApis(`
        /** AbortSignal.any() arrived in Node 20; Promise.withResolvers() too. */
        // const x = [1].toSorted()
        import { randomUUID } from "node:crypto"
        import { setMaxListeners } from "node:events"
        const id = randomUUID()
        const t = AbortSignal.timeout(5)
        const last = [1, 2].findLast((n) => n > 1)
        const at = [1, 2].at(-1)
        const re = /x/dgimsuy
      `),
    ).toEqual([])
  })
})

describe('its exports and its first run', () => {
  it('exports what the tests and the page’s contract test import (§1.2)', async () => {
    const helper = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    for (const name of [
      'createBridge',
      'NAME',
      'VERSION',
      'PROTOCOL',
      'ID',
      'ADB_EXEC',
      'ADB_DETAIL',
      'EMITTED_BLOCKERS',
      'LOCKDOWN_REQUESTS',
      'LOCKDOWN_SERVICES',
      'tokenIdOf',
      'proofOf',
      'parsePlist',
      'buildPlist',
      'parseDevicesL',
      'mapAdbState',
      'deriveIos',
      'classifyDevicectl',
      'splitSyslogRelay',
      'which',
      'runTool',
      'liveChildren',
      'bootHtml',
      'formatChecklist',
    ]) {
      expect(helper[name], name).toBeDefined()
    }
    expect((helper.tokenIdOf as (t: string) => string)('example-token')).toBe('4d1566a1')
    expect(helper.ADB_DETAIL).toEqual([
      ['getprop', 'getprop'],
      ['wmSize', 'wm size'],
      ['wmDensity', 'wm density'],
      ['battery', 'dumpsys battery'],
      ['df', 'df /data'],
      ['androidId', 'settings get secure android_id'],
    ])
  })
  it('runs on this Node: --version, and a usage error exits 64', () => {
    expect(execFileSync(process.execPath, [file, '--version'], { encoding: 'utf8' })).toBe(
      '1.1.1\n',
    )
    let status: number | null = null
    try {
      execFileSync(process.execPath, [file, '--nope'], { stdio: 'pipe' })
    } catch (error) {
      status = (error as { status: number }).status
    }
    expect(status).toBe(64)
  })
})
