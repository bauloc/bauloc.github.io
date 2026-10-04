import { describe, expect, it } from 'vitest'

import { logLevel, logSourceName, logStatusText } from './log-console'

/*
  The console colours a line by its level, whichever of the three sources wrote it. The
  samples are the real formats: logcat `-v threadtime` from the Pixel 9, an iPhone's
  syslog_relay and idevicesyslog lines, and a simulator's `log stream --style compact`.
*/

describe('logLevel', () => {
  it.each([
    ['10-04 08:41:02.123  1234  5678 E AndroidRuntime: FATAL EXCEPTION: main', 'E'],
    ['10-04 08:41:02.123  1234  5678 F libc    : Fatal signal 11', 'F'],
    ['10-04 08:41:02.123  1234  5678 W OkHttp  : retrying', 'W'],
    ['10-04 08:41:02.123  1234  5678 D Shop    : debug', 'D'],
    ['10-04 08:41:02.123  1234  5678 V Shop    : verbose', 'D'],
    ['10-04 08:41:02.123  1234  5678 I ActivityManager: Start proc', ''],
  ])('reads logcat: %s', (line, level) => {
    expect(logLevel(line)).toBe(level)
  })

  it.each([
    ['Oct  4 09:53:23 iPhone Shop(CFNetwork)[612] <Error>: Task failed', 'E'],
    ['Oct  4 09:53:23 iPhone kernel[0] <Fault>: panic', 'F'],
    ['Oct  4 09:53:23 iPhone kernel[0] <Critical>: thermal', 'F'],
    ['Oct  4 09:53:23 iPhone kernel[0] <Alert>: x', 'F'],
    ['Oct  4 09:53:23 iPhone kernel[0] <Emergency>: x', 'F'],
    ['Oct  4 09:53:23 iPhone locationd[275] <Warning>: weak signal', 'W'],
    ['Oct  4 09:53:23.101270 locationd[27551] <Debug>: tick', 'D'],
    ['Oct  4 09:53:23 iPhone SpringBoard[60] <Info>: idle', 'D'],
    ['Oct  4 09:53:23 iPhone SpringBoard[60] <Notice>: launched', ''],
    // pymobiledevice3 writes the level in capitals.
    ['2026-10-04 09:53:29.376293 kernel{}[0] <ERROR>: x', 'E'],
  ])('reads an iPhone’s syslog: %s', (line, level) => {
    expect(logLevel(line)).toBe(level)
  })

  it.each([
    ['2026-10-04 09:53:29.376 E  Shop[1234:5678] [com.example:net] failed', 'E'],
    ['2026-10-04 09:53:29.376 F  Shop[1234:5678] assertion', 'F'],
    ['2026-10-04 09:53:29.376 Db Shop[1234:5678] verbose', 'D'],
    ['2026-10-04 09:53:29.376 I  Shop[1234:5678] info', 'D'],
    ['2026-10-04 09:53:29.376 Df Shop[1234:5678] default', ''],
    ['2026-10-04 09:53:29.376 A  Shop[1234:5678] activity', ''],
  ])('reads a simulator’s log: %s', (line, level) => {
    expect(logLevel(line)).toBe(level)
  })

  it('leaves anything else plain', () => {
    expect(logLevel('— Connected through idevicesyslog')).toBe('')
    expect(logLevel('[connected:00008101-000A1B2C3D4E5F02]')).toBe('')
    expect(logLevel('')).toBe('')
    // A level word inside a message is not a level.
    expect(logLevel('Shop: the server said <Error> once')).toBe('')
  })
})

describe('logSourceName', () => {
  it('names the log by where it comes from', () => {
    expect(logSourceName({ platform: 'android', connection: 'usb' })).toBe('logcat')
    expect(logSourceName({ platform: 'android', connection: 'simulator' })).toBe('logcat')
    expect(logSourceName({ platform: 'ios', connection: 'usb' })).toBe('syslog')
    expect(logSourceName({ platform: 'ios', connection: 'network' })).toBe('syslog')
    expect(logSourceName({ platform: 'ios', connection: 'simulator' })).toBe('simulator log')
  })
})

describe('logStatusText', () => {
  it('says the log waits for its device, and until when', () => {
    expect(logStatusText('running', null)).toBe('newest at the bottom')
    expect(logStatusText('idle', null)).toBe('newest at the bottom')
    expect(logStatusText('waiting', new Date(2026, 9, 4, 15, 51, 44).getTime())).toBe(
      'waiting for the device until 15:51:44',
    )
    expect(logStatusText('waiting', null)).toBe('waiting for the device to come back')
  })
})
