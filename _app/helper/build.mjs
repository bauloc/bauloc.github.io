#!/usr/bin/env node
/**
 * helper/build.mjs — bundle the Device Lab helper into ONE readable file.
 *
 *   node helper/build.mjs           # write ../device/agent/device-bridge.mjs
 *   node helper/build.mjs --check   # exit 1 when that file differs from a fresh build
 *
 * The helper is authored as TypeScript modules in helper/src, one per section of the spec,
 * and shipped as a single file testers download with curl and run with plain Node. That
 * file must stay readable (a tester may review it before running it), so: no minification,
 * the doc comments kept, every module in its own `//#region`, and a header that says what
 * the helper does and never does, with a table of contents carrying real line numbers.
 *
 * The bundle is checked before it is written: node: built-ins are its only imports, the
 * version guard is its first code, VERSION appears once, and no API newer than Node 18 is
 * used (forbiddenApis, also asserted by test/build.test.ts against the built file).
 *
 * Only `/** … *\/` doc comments and `/*! … *\/` survive bundling; plain `//` and `/* *\/`
 * comments are dropped by the code generator. Anything a reader of the built file should
 * see is therefore written as a doc comment in the source.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'
import { parseSync } from 'rolldown/utils'

const HELPER = fileURLToPath(new URL('.', import.meta.url))
export const OUT_FILE = path.resolve(HELPER, '../../device/agent/device-bridge.mjs')

/** Titles for the table of contents, by module. A module missing here is listed by name. */
const SECTIONS = /** @type {Record<string, string>} */ ({
  'src/guard.ts': 'Node version guard',
  'src/constants.ts': '§1 Constants, limits and allowlists',
  'src/util.ts': '§2 Utilities',
  'src/plist.ts': '§3 Property lists',
  'src/process.ts': '§4a Running tools',
  'src/tools.ts': '§4b Finding tools',
  'src/usbmuxd.ts': '§5 usbmuxd client',
  'src/lockdown.ts': '§6 Lockdown client',
  'src/ios-lane.ts': '§7 iOS lane',
  'src/simulator-lane.ts': '§8 Simulator lane',
  'src/android-lane.ts': '§9 Android lane',
  'src/registry.ts': '§10 Device registry',
  'src/auth.ts': '§11 Token, proof and pairing',
  'src/preflight.ts': '§12 Doctor and preflight',
  'src/http.ts': '§13 HTTP API',
  'src/local-mode.ts': '§14 Local mode',
  'src/bridge.ts': '§15 Bridge lifecycle',
  'src/cli.ts': '§1 Command line',
  'src/banner.ts': '§15 Banner',
  'src/main.ts': '§15 Startup, signals and exports',
})

/* ------------------------------------------------------------- Node 18 denylist --- */

/**
 * Globals whose members below arrived after Node 18 (§1.1, plus a few the spec did not
 * list). Checked on the syntax tree, so a comment that mentions one is not a finding.
 * @type {Record<string, string[]>}
 */
const STATIC_MEMBERS = {
  AbortSignal: ['any'],
  Promise: ['withResolvers', 'try'],
  Object: ['groupBy'],
  Map: ['groupBy'],
  Array: ['fromAsync'],
  URL: ['canParse'],
  process: ['getBuiltinModule'],
  globalThis: ['crypto', 'navigator'],
}

/** Methods newer than Node 18 on built-in prototypes; the names are distinctive enough. */
const METHODS = new Set([
  'toSorted',
  'toReversed',
  'toSpliced',
  'isWellFormed',
  'toWellFormed',
  'union',
  'intersection',
  'difference',
  'symmetricDifference',
  'isSubsetOf',
  'isSupersetOf',
  'isDisjointFrom',
])

/**
 * Named imports from built-ins that Node 18.0 lacks. A missing named export is a link-time
 * SyntaxError, before the version guard could print anything.
 * @type {Record<string, string[]>}
 */
const IMPORTS = {
  'node:fs': ['glob', 'globSync', 'openAsBlob'],
  'node:fs/promises': ['glob'],
  'node:util': ['styleText', 'parseArgs'],
  'node:crypto': ['hash'],
  'node:os': ['availableParallelism'],
  'node:events': ['addAbortListener'],
  'node:module': ['register'],
  'node:process': ['getBuiltinModule'],
}

/** Built-in modules Node 18 does not have at all. */
const MODULES = new Set(['node:sqlite', 'node:test/reporters', 'node:sea'])

/**
 * @param {unknown} node
 * @param {(node: Record<string, any>) => void} visit
 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = /** @type {Record<string, any>} */ (node)
  if (typeof record.type === 'string') visit(record)
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'start' && key !== 'end') walk(record[key], visit)
  }
}

/** @param {Record<string, any> | undefined} node */
const nameOf = (node) =>
  node?.type === 'Identifier'
    ? String(node.name)
    : node?.type === 'Literal'
      ? String(node.value)
      : null

/**
 * Every use of an API newer than Node 18 in `code`, with its line.
 * @param {string} code
 * @returns {Array<{ api: string, line: number }>}
 */
export function forbiddenApis(code) {
  const result = parseSync('device-bridge.mjs', code, { sourceType: 'module', lang: 'js' })
  if (result.errors.length) {
    throw new Error(`The bundle does not parse: ${result.errors.map((e) => e.message).join('; ')}`)
  }
  /** @type {Array<{ api: string, at: number }>} */
  const found = []
  let cryptoImported = false
  walk(result.program, (node) => {
    if (node.type === 'MemberExpression' && !node.computed) {
      const object = nameOf(node.object)
      const property = nameOf(node.property)
      if (object && property && STATIC_MEMBERS[object]?.includes(property)) {
        found.push({ api: `${object}.${property}`, at: node.start })
      } else if (property && METHODS.has(property)) {
        found.push({ api: `.${property}()`, at: node.start })
      } else if (object === 'crypto') {
        found.push({ api: 'crypto (the global WebCrypto)', at: node.start })
      }
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'MetaProperty') {
      const property = nameOf(node.property)
      if (property === 'dirname' || property === 'filename') {
        found.push({ api: `import.meta.${property}`, at: node.start })
      }
    }
    if (node.type === 'Literal' && node.regex && String(node.regex.flags).includes('v')) {
      found.push({ api: 'the regex v flag', at: node.start })
    }
    if (
      (node.type === 'NewExpression' || node.type === 'CallExpression') &&
      nameOf(node.callee) === 'RegExp' &&
      typeof node.arguments?.[1]?.value === 'string' &&
      node.arguments[1].value.includes('v')
    ) {
      found.push({ api: 'the regex v flag', at: node.start })
    }
    if (
      node.type === 'VariableDeclaration' &&
      (node.kind === 'using' || node.kind === 'await using')
    ) {
      found.push({ api: `${String(node.kind)} declarations`, at: node.start })
    }
    if (node.type === 'CallExpression' && nameOf(node.callee) === 'require') {
      found.push({ api: 'require()', at: node.start })
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const source = node.source?.value
      if (typeof source !== 'string') return
      if (!source.startsWith('node:'))
        found.push({ api: `an import of "${source}" (built-ins only)`, at: node.start })
      if (MODULES.has(source)) found.push({ api: source, at: node.start })
      for (const specifier of node.specifiers ?? []) {
        const imported = nameOf(specifier.imported)
        if (imported && IMPORTS[source]?.includes(imported)) {
          found.push({ api: `${imported} from ${source}`, at: node.start })
        }
        if (specifier.local?.name === 'crypto') cryptoImported = true
      }
    }
  })
  return found
    .filter((hit) => !(cryptoImported && hit.api.startsWith('crypto ')))
    .map((hit) => ({ api: hit.api, line: code.slice(0, hit.at).split('\n').length }))
}

/* -------------------------------------------------------------------- the bundle --- */

/**
 * Comments as the source has them. rolldown prints a doc comment's inner lines as `* text`
 * flush with the code, which reads badly over three thousand lines, and marks every
 * top-level `new Set()` with a pure annotation nothing downstream needs. Only the comment
 * ranges the parser reports are touched, never code.
 * @param {string} code
 * @returns {string}
 */
export function tidyComments(code) {
  const { comments, errors } = parseSync('bundle.mjs', code, { sourceType: 'module', lang: 'js' })
  if (errors.length)
    throw new Error(`The bundle does not parse: ${errors.map((e) => e.message).join('; ')}`)
  let out = ''
  let at = 0
  for (const comment of comments) {
    if (comment.type !== 'Block') continue
    if (/^\s*[@#]__PURE__\s*$/.test(comment.value)) {
      out += code.slice(at, comment.start)
      at = code[comment.end] === ' ' ? comment.end + 1 : comment.end
    } else if (comment.value.startsWith('*')) {
      const text = code.slice(comment.start, comment.end)
      out += code.slice(at, comment.start) + text.replace(/\n([ \t]*)\*/g, '\n$1 *')
      at = comment.end
    }
  }
  return out + code.slice(at)
}

/** @param {string} header @returns {string} */
const asComment = (header) =>
  [
    '/*',
    ...header
      .trimEnd()
      .split('\n')
      .map((line) => (line ? ` * ${line}` : ' *')),
    ' */',
  ].join('\n')

/**
 * The helper as one file: shebang, header comment, then the bundle.
 * @returns {Promise<{ code: string, version: string, regions: string[] }>}
 */
export async function bundleHelper() {
  /** @type {string[]} */
  const warnings = []
  const result = await build({
    cwd: HELPER,
    input: 'src/main.ts',
    platform: 'node',
    transform: { target: 'node18' },
    write: false,
    onLog(level, log) {
      if (level === 'warn') warnings.push(log.message)
    },
    output: {
      format: 'esm',
      minify: false,
      comments: { legal: true, annotation: false, jsdoc: true },
    },
  })
  if (warnings.length) throw new Error(`rolldown warned:\n${warnings.join('\n')}`)
  const chunks = result.output.filter((item) => item.type === 'chunk')
  if (chunks.length !== 1 || !chunks[0])
    throw new Error(`Expected one chunk, got ${String(chunks.length)}.`)
  const body = tidyComments(chunks[0].code)

  const constants = readFileSync(path.join(HELPER, 'src/constants.ts'), 'utf8')
  const version = /^export const VERSION = '([^']+)'$/m.exec(constants)?.[1]
  if (!version) throw new Error('VERSION not found in src/constants.ts.')
  const declared = [...body.matchAll(/^const VERSION = "([^"]+)";$/gm)]
  if (declared.length !== 1 || declared[0]?.[1] !== version) {
    throw new Error(`Expected exactly one 'const VERSION = "${version}";' line in the bundle.`)
  }

  const regionLines = body
    .split('\n')
    .map((line, index) => ({ name: /^\/\/#region (\S+)$/.exec(line)?.[1], index }))
    .filter((region) => region.name !== undefined)
  const regions = regionLines.map((region) => String(region.name))
  if (regions[0] !== 'src/guard.ts') {
    throw new Error(
      `The version guard must be the first code in the bundle, not ${String(regions[0])}.`,
    )
  }

  const template = readFileSync(path.join(HELPER, 'header.txt'), 'utf8').replace(
    '{{VERSION}}',
    version,
  )
  /** @param {(index: number) => number} lineOf @returns {string} */
  const contents = (lineOf) =>
    regionLines
      .map((region) => {
        const title = SECTIONS[String(region.name)] ?? String(region.name)
        return `  ${String(lineOf(region.index)).padStart(5)}  ${title.padEnd(36)} ${String(region.name)}`
      })
      .join('\n')
  // The header's length does not depend on the numbers in it, so one dry run measures it.
  const headerLines = asComment(
    template.replace(
      '{{CONTENTS}}',
      contents(() => 0),
    ),
  ).split('\n').length
  const offset = 1 + headerLines + 1
  const header = asComment(
    template.replace(
      '{{CONTENTS}}',
      contents((index) => index + offset),
    ),
  )
  const code = `#!/usr/bin/env node\n${header}\n${body.endsWith('\n') ? body : body + '\n'}`

  const forbidden = forbiddenApis(code)
  if (forbidden.length) {
    const list = forbidden.map((hit) => `  line ${String(hit.line)}: ${hit.api}`).join('\n')
    throw new Error(`The bundle uses APIs newer than Node 18:\n${list}`)
  }
  return { code, version, regions }
}

async function cli() {
  const { code, version, regions } = await bundleHelper()
  const relative = path.relative(process.cwd(), OUT_FILE)
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null
    if (current !== code) {
      console.error(
        `${relative} is ${current === null ? 'missing' : 'stale'}. Run: npm run helper:build`,
      )
      process.exit(1)
    }
    console.log(`${relative} is up to date (${version}).`)
    return
  }
  mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, code)
  const lines = code.split('\n').length - 1
  console.log(
    `Wrote ${relative}: ${version}, ${String(lines)} lines, ${String(regions.length)} modules.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
