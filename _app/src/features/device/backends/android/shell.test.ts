import { escapeArg as tangoEscapeArg } from '@yume-chan/adb'
import { describe, expect, it } from 'vitest'

import { fakeAdb } from './fake-adb'
import {
  assertCmdToken,
  assertDevicePath,
  assertMediaId,
  assertPackageName,
  assertSessionId,
  escapeArg,
  failed,
  isPackageName,
  isShellCommand,
  phoneMessage,
  run,
  runBytes,
  shellCmd,
  type ShellCommand,
} from './shell'

/** What `sh -c` would make of a quoted word: the single-quote rules, and nothing else. */
function unquote(word: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < word.length; i++) {
    const c = word[i]
    if (c === "'") quoted = !quoted
    else if (c === '\\' && !quoted) out += word[++i] ?? ''
    else out += c
  }
  return out
}

const HOSTILE = [
  'com.example.app',
  "it's",
  "''",
  'a;reboot',
  '$(reboot)',
  '`reboot`',
  'a && b || c',
  'two\nlines',
  'back\\slash',
  "'; pm uninstall com.android.vending; '",
  '',
  '*',
]

describe('escapeArg', () => {
  it.each(HOSTILE)('quotes %j byte for byte as Tango does', (value) => {
    expect(escapeArg(value)).toBe(tangoEscapeArg(value))
  })

  it.each(HOSTILE)('gives %j back unchanged to the shell', (value) => {
    expect(unquote(escapeArg(value))).toBe(value)
  })
})

describe('shellCmd', () => {
  it('sends literal text as written and quotes every interpolation, numbers too', () => {
    const pkg = 'com.example.app'
    expect(shellCmd`pm path ${pkg}`.text).toBe("pm path 'com.example.app'")
    expect(shellCmd`tail -c +${41} x`.text).toBe("tail -c +'41' x")
  })

  it('keeps hostile text inside one argument', () => {
    const cmd = shellCmd`pm path ${"a'; reboot; echo '"}`
    expect(cmd.text).toBe(String.raw`pm path 'a'\''; reboot; echo '\'''`)
    expect(unquote(cmd.text.slice('pm path '.length))).toBe("a'; reboot; echo '")
  })

  it('turns a list into several quoted arguments', () => {
    expect(shellCmd`rm ${['a b', 'c']}`.text).toBe("rm 'a b' 'c'")
  })

  it('splices another shellCmd result in as written, to assemble optional parts', () => {
    const flags = shellCmd`-f -i`
    const none = shellCmd``
    expect(shellCmd`pm list packages ${flags}${none} ${'-3'}`.text).toBe(
      "pm list packages -f -i '-3'",
    )
  })

  it('refuses what is not a string, a number, a list or a shellCmd result', () => {
    const forged = { text: 'reboot' } as ShellCommand
    expect(() => shellCmd`echo ${forged}`).toThrow(TypeError)
    expect(() => shellCmd`echo ${Number.NaN}`).toThrow(TypeError)
    expect(() => shellCmd`echo ${Infinity}`).toThrow(TypeError)
    expect(() => shellCmd`echo ${'a\0b'}`).toThrow(TypeError)
  })

  it('makes commands only it can make', () => {
    expect(isShellCommand(shellCmd`id`)).toBe(true)
    expect(isShellCommand({ text: 'id' })).toBe(false)
    expect(isShellCommand('id')).toBe(false)
  })
})

describe('validation', () => {
  it('accepts package names as Android writes them, the framework included', () => {
    for (const name of ['com.example.app', 'org.sample.reader_2', 'A.b', 'android']) {
      expect(isPackageName(name)).toBe(true)
      expect(assertPackageName(name)).toBe(name)
    }
  })

  it('refuses anything else before it nears the phone', () => {
    for (const name of [
      '',
      'example',
      '1com.example',
      'com..example',
      'com.example.',
      'com.ex ample',
      "com.e'x",
      'com.example;reboot',
      '$(id).x',
      'a'.repeat(250) + '.b'.repeat(4),
    ]) {
      expect(isPackageName(name)).toBe(false)
      expect(() => assertPackageName(name)).toThrow('INVALID_PACKAGE_NAME')
    }
  })

  it('takes media ids as digits only', () => {
    expect(assertMediaId('1000012345')).toBe('1000012345')
    for (const id of ['', '12a', '-1', '1 2', '1;id', '12345678901234567890']) {
      expect(() => assertMediaId(id)).toThrow('INVALID_MEDIA_ID')
    }
  })

  it('takes session ids as positive Java ints', () => {
    expect(assertSessionId(1234567)).toBe(1234567)
    for (const id of [0, -1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => assertSessionId(id)).toThrow('INVALID_SESSION_ID')
    }
  })

  it('lets only shell-inert tokens down the Cmd route', () => {
    for (const token of [
      'package',
      'install-write',
      '-S',
      '3000',
      '0.apk',
      '-',
      '--bypass-low-target-sdk-block',
    ]) {
      expect(assertCmdToken(token)).toBe(token)
    }
    for (const token of ['', 'a b', "a'b", 'a;b', '$x', 'a/b', 'a\0b']) {
      expect(() => assertCmdToken(token)).toThrow('INVALID_ARGUMENT')
    }
  })

  it('takes absolute device paths, without control characters or ..', () => {
    expect(assertDevicePath('/storage/emulated/0/DCIM/a b, c.jpg')).toBe(
      '/storage/emulated/0/DCIM/a b, c.jpg',
    )
    for (const path of ['', 'sdcard/a', '/sdcard/../data/x', '/a\nb', '/a\0b']) {
      expect(() => assertDevicePath(path)).toThrow('INVALID_DEVICE_PATH')
    }
  })
})

describe('run', () => {
  it('sends exactly the built text, as one argument, over the shell protocol', async () => {
    const { adb, calls } = fakeAdb({
      answer: () => ({ stdout: 'package:/a.apk\n', stderr: 'warn\n', exitCode: 0 }),
    })
    const result = await run(adb, shellCmd`pm path ${'com.example.app'}   --user 0`)
    expect(calls).toMatchObject([{ via: 'shell', command: "pm path 'com.example.app'   --user 0" }])
    expect(result).toEqual({ stdout: 'package:/a.apk\n', stderr: 'warn\n', exitCode: 0 })
  })

  it('falls back to exec: on phones without the shell protocol: output mixed, no exit code', async () => {
    const { adb, calls } = fakeAdb({
      features: ['cmd'],
      answer: () => ({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 }),
    })
    const result = await run(adb, shellCmd`id`)
    expect(calls).toMatchObject([{ via: 'exec', command: 'id' }])
    expect(result).toEqual({ stdout: 'out\nerr\n', stderr: '', exitCode: null })
  })

  it('returns bytes untouched by text decoding', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x80])
    const { adb } = fakeAdb({ answer: () => ({ stdout: bytes }) })
    expect((await runBytes(adb, shellCmd`cat x`)).stdout).toEqual(bytes)
  })

  it('refuses a command shellCmd did not build', async () => {
    const { adb, calls } = fakeAdb()
    await expect(run(adb, { text: 'reboot' })).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it('stops a command on abort and rejects with the abort', async () => {
    const { adb, calls } = fakeAdb({ answer: () => ({ hang: true }) })
    const controller = new AbortController()
    const pending = run(adb, shellCmd`logcat`, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    expect(calls[0]?.killed).toBe(true)
  })

  it('does not start a command once aborted', async () => {
    const { adb, calls } = fakeAdb()
    await expect(run(adb, shellCmd`id`, AbortSignal.abort())).rejects.toThrow(/abort/i)
    expect(calls).toEqual([])
  })
})

describe('reading results', () => {
  it('counts a non-zero exit as failed, and an unknown exit code as not', () => {
    expect(failed({ stdout: '', stderr: '', exitCode: 1 })).toBe(true)
    expect(failed({ stdout: '', stderr: '', exitCode: 0 })).toBe(false)
    expect(failed({ stdout: '', stderr: '', exitCode: null })).toBe(false)
  })

  it("prefers the phone's stderr, then its stdout", () => {
    expect(phoneMessage({ stdout: 'out', stderr: '\n  Failed\nmore' })).toBe('Failed')
    expect(phoneMessage({ stdout: '\nError: x\n', stderr: '' })).toBe('Error: x')
    expect(phoneMessage({ stdout: '', stderr: '' })).toBe('')
  })
})
