/*
  Dev script, not run in CI: asks bundletool itself which APKs `extract-apks` picks for each
  device spec, and writes the answers to picks.json, which select.test.ts holds the port to.

    JAVA=/path/to/java BUNDLETOOL_JAR=/path/to/bundletool-all-1.18.3.jar node make-picks.mjs
    npx prettier --write picks.json

  It needs nothing but the *.toc.pb files beside it: bundletool picks by the table of contents
  alone, so each set is rebuilt as a skeleton (its toc.pb and an empty file per APK it lists).
  To add a set, pass NAME=/path/to/set.apks once: its toc.pb is copied here as NAME.toc.pb.

  Only extract-apks runs, which never talks to a device, in an environment with no ANDROID_HOME
  and a PATH without platform-tools, so nothing can start an adb server.

  The sets: probe-all and probe-packs are the bundle-install research's probe app
  (com.bauloc.bundleprobe) without and with Play Asset Delivery packs; matrix is a bundle built
  for these tests (com.bauloc.matrixprobe) with texture-format and device-tier splits, two
  conditional modules and an install-time texture asset pack.
*/
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Node runs the port's toc reader as it is (type stripping); it only lists the paths to stub.
const { parseToc } = await import('../toc.ts')

const here = new URL('.', import.meta.url).pathname
const java = process.env.JAVA
const jar = process.env.BUNDLETOOL_JAR
if (!java || !jar) throw new Error('Set JAVA and BUNDLETOOL_JAR.')

for (const arg of process.argv.slice(2)) {
  const [name, apks] = arg.split('=')
  const tmp = mkdtempSync(join(tmpdir(), 'toc-'))
  execFileSync('unzip', ['-o', '-q', apks, 'toc.pb', '-d', tmp])
  writeFileSync(join(here, `${name}.toc.pb`), readFileSync(join(tmp, 'toc.pb')))
  rmSync(tmp, { recursive: true, force: true })
}

const pixel9 = {
  supportedAbis: ['arm64-v8a'],
  supportedLocales: ['en-US'],
  screenDensity: 420,
  sdkVersion: 37,
}

/** The prototype's 56 specs: densities, SDK levels, ABI lists and locale sets around a Pixel 9. */
const common = [
  ...[
    100, 120, 140, 160, 180, 200, 213, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400, 420, 440,
    460, 480, 520, 560, 600, 640, 700,
  ].map((screenDensity) => ({ ...pixel9, screenDensity })),
  ...[21, 24, 26, 28, 29, 30, 31, 32, 33, 34, 35, 37].map((sdkVersion) => ({
    ...pixel9,
    sdkVersion,
  })),
  ...[
    ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
    ['armeabi-v7a', 'armeabi'],
    ['x86_64', 'x86', 'arm64-v8a'],
    ['x86', 'armeabi-v7a'],
    ['riscv64'],
    ['x86'],
  ].map((supportedAbis) => ({ ...pixel9, supportedAbis })),
  ...[
    ['vi-VN'],
    ['fr-FR', 'ja-JP'],
    ['de-DE'],
    ['en-US', 'vi-VN'],
    ['zh-TW'],
    ['he-IL'],
    ['iw-IL'],
    ['id-ID'],
    ['in-ID'],
    ['yi'],
    ['pt-BR', 'es-419'],
    ['sr-Latn-RS'],
  ].map((supportedLocales) => ({ ...pixel9, supportedLocales })),
]

const ASTC = 'GL_KHR_texture_compression_astc_ldr'
/** The dimensions only the matrix bundle uses: GPU formats, device features, device tier. */
const matrix = [
  pixel9,
  {
    ...pixel9,
    glExtensions: [ASTC, 'GL_OES_compressed_ETC1_RGB8_texture'],
    deviceFeatures: ['reqGlEsVersion=0x30002', 'android.hardware.camera.ar'],
  },
  {
    ...pixel9,
    glExtensions: ['GL_IMG_texture_compression_pvrtc'],
    deviceFeatures: ['reqGlEsVersion=0x20000'],
  },
  {
    ...pixel9,
    glExtensions: ['GL_OES_EGL_image_external'],
    deviceFeatures: ['reqGlEsVersion=0x30000', 'android.hardware.camera.ar'],
  },
  {
    ...pixel9,
    glExtensions: ['GL_OES_compressed_ETC1_RGB8_texture'],
    deviceFeatures: ['reqGlEsVersion=0x20000'],
  },
  { ...pixel9, deviceTier: 0 },
  { ...pixel9, deviceTier: 2 },
  {
    ...pixel9,
    sdkVersion: 29,
    deviceFeatures: ['android.hardware.camera.ar', 'reqGlEsVersion=0x30002'],
  },
  {
    ...pixel9,
    sdkVersion: 33,
    deviceFeatures: ['android.hardware.camera.ar', 'reqGlEsVersion=0x30002'],
  },
  { ...pixel9, supportedAbis: ['x86'] },
  { ...pixel9, supportedAbis: ['armeabi-v7a'], screenDensity: 240, sdkVersion: 28 },
]

/** bundletool with no Android SDK in reach: no ANDROID_HOME, no platform-tools on PATH. */
function bundletool(args) {
  return execFileSync(java, ['-jar', jar, ...args], {
    env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' },
    stdio: 'pipe',
  })
}

/** The set as bundletool needs it to pick: the toc and an empty stand-in for each APK. */
function skeleton(tocPath, dir) {
  const toc = parseToc(readFileSync(tocPath))
  const apks = [
    ...toc.variants.flatMap((v) => v.modules.flatMap((m) => m.apks)),
    ...toc.assetPacks.flatMap((p) => p.apks),
  ]
  const root = join(dir, 'set')
  mkdirSync(root)
  writeFileSync(join(root, 'toc.pb'), readFileSync(tocPath))
  for (const { path } of apks) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  const set = join(dir, 'set.apks')
  execFileSync('zip', ['-q', '-r', '-0', set, '.'], { cwd: root })
  return set
}

const out = { bundletool: String(bundletool(['version'])).trim(), sets: {} }
for (const tocFile of readdirSync(here)
  .filter((f) => f.endsWith('.toc.pb'))
  .sort()) {
  const name = tocFile.replace(/\.toc\.pb$/, '')
  const tmp = mkdtempSync(join(tmpdir(), 'picks-'))
  try {
    const set = skeleton(join(here, tocFile), tmp)
    out.sets[name] = (name === 'matrix' ? matrix : common).map((spec, i) => {
      const specPath = join(tmp, `spec${String(i)}.json`)
      const dir = join(tmp, `x${String(i)}`)
      writeFileSync(specPath, JSON.stringify(spec))
      try {
        bundletool([
          'extract-apks',
          `--apks=${set}`,
          `--device-spec=${specPath}`,
          `--output-dir=${dir}`,
          '--include-metadata',
        ])
        const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
        return { spec, apks: meta.apks.map((a) => basename(a.path)).sort() }
      } catch (e) {
        const line = String(e.stderr ?? e)
          .split('\n')
          .find((l) => l.includes('Error'))
        return { spec, error: (line ?? 'error').replace(/^\[BT:[^\]]+\]\s*/, '').trim() }
      }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
writeFileSync(join(here, 'picks.json'), JSON.stringify(out, null, 1) + '\n')
const counts = Object.entries(out.sets).map(([n, s]) => `${n} ${String(s.length)}`)
console.log(`picks.json: ${counts.join(', ')}`)
