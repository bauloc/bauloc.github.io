import { describe, expect, it } from 'vitest'
import { UsageError, helpText, parseCli, scriptHint } from '../src/cli'

describe('parseCli (§1.9)', () => {
  it('has the documented defaults', () => {
    expect(parseCli([])).toEqual({
      port: 8787,
      open: true,
      keepToken: false,
      newToken: false,
      wifi: false,
      simulators: false,
      android: true,
      local: true,
      dev: false,
      verbose: false,
      doctor: false,
      help: false,
      version: false,
    })
  })
  it('reads every flag', () => {
    const flags = '--port 8788 --no-open --keep-token --new-token --wifi --simulators --no-android'
    const all = parseCli(`${flags} --no-local --dev --verbose --doctor --version -h`.split(' '))
    expect(all).toEqual({
      port: 8788,
      open: false,
      keepToken: true,
      newToken: true,
      wifi: true,
      simulators: true,
      android: false,
      local: false,
      dev: true,
      verbose: true,
      doctor: true,
      help: true,
      version: true,
    })
    expect(parseCli(['--port=9000']).port).toBe(9000)
  })
  it('refuses an unknown option with the exact sentence', () => {
    expect(() => parseCli(['--foo'], '~/device-bridge.mjs')).toThrow(
      new UsageError('Unknown option --foo. Run: node ~/device-bridge.mjs --help'),
    )
    expect(() => parseCli(['stray'])).toThrow(UsageError)
  })
  it.each([['80'], ['65536'], ['abc'], ['8787x'], ['-1'], ['']])('refuses --port %s', (value) => {
    expect(() => parseCli(['--port', value])).toThrow(UsageError)
  })
  it('refuses --port without a value and --new-token without --keep-token', () => {
    expect(() => parseCli(['--port'])).toThrow(/--port needs a whole number from 1024 to 65535/)
    expect(() => parseCli(['--new-token'])).toThrow(/--new-token works only with --keep-token/)
  })
  it('has no flag that widens exposure or carries a secret', () => {
    for (const flag of ['--host', '--api', '--token', '--origin']) {
      expect(() => parseCli([flag, 'x'])).toThrow(UsageError)
    }
  })
})

describe('scriptHint', () => {
  it('shows ~/ for files under home, else the shorter of relative and absolute', () => {
    expect(scriptHint('/Users/b/device-bridge.mjs', '/Users/b', '/Users/b/Downloads')).toBe(
      '~/device-bridge.mjs',
    )
    expect(scriptHint('/Users/b/My Tools/device-bridge.mjs', '/Users/b', '/')).toBe(
      "~/'My Tools/device-bridge.mjs'",
    )
    expect(scriptHint('/repo/device/agent/device-bridge.mjs', '/Users/b', '/repo/_app')).toBe(
      '../device/agent/device-bridge.mjs',
    )
    expect(scriptHint(undefined, '/Users/b', '/')).toBe('~/device-bridge.mjs')
  })
})

describe('helpText', () => {
  it('lists every option of §1.9', () => {
    const help = helpText('~/device-bridge.mjs')
    expect(help.startsWith('node ~/device-bridge.mjs [options]\n')).toBe(true)
    for (const flag of [
      '--port <n>',
      '--no-open',
      '--keep-token',
      '--new-token',
      '--wifi',
      '--simulators',
      '--no-android',
      '--no-local',
      '--dev',
      '--verbose',
      '--doctor',
      '--version',
      '-h, --help',
    ]) {
      expect(help).toContain(flag)
    }
  })
})
