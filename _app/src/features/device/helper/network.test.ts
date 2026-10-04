import { describe, expect, it } from 'vitest'

import {
  addressOf,
  checkHost,
  forgetRecent,
  parseAddress,
  parsePairingCode,
  parsePort,
  readRecent,
  RECENT_KEY,
  RECENT_MAX,
  recentLabel,
  rememberRecent,
  renameRecent,
  targetOfSerial,
  type RecentStore,
} from './network'

/*
  The Wi‑Fi dialog's checks before anything is sent. They mirror the helper's own
  (parseNetworkHost: a local-network address or a local name, never loopback or a public
  address), so a refusal shows at once in plain words; the helper still checks everything.
*/

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const store: RecentStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
  return { store, data }
}

const throwing: RecentStore = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('checkHost', () => {
  it.each([
    ['192.168.1.20', '192.168.1.20'],
    ['10.0.0.7', '10.0.0.7'],
    ['172.16.4.2', '172.16.4.2'],
    ['172.31.255.254', '172.31.255.254'],
    ['169.254.10.1', '169.254.10.1'],
    ['100.64.0.9', '100.64.0.9'],
    ['  192.168.1.20  ', '192.168.1.20'],
    ['Living-Room-TV.local', 'living-room-tv.local'],
    ['shield.lan.', 'shield.lan'],
    ['tv.home.arpa', 'tv.home.arpa'],
    ['fe80::1%en0', 'fe80::1%en0'],
    ['[FD12:3456::42]', 'fd12:3456::42'],
  ])('takes %s', (input, host) => {
    expect(checkHost(input)).toEqual({ ok: true, host })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['192.168.1', 'invalid'],
    ['192.168.1.256', 'invalid'],
    ['192.168.01.20', 'invalid'],
    ['http://192.168.1.20', 'invalid'],
    ['192.168.1.20/24', 'invalid'],
    ['tv;rm -rf', 'invalid'],
    ['-tv.local', 'invalid'],
    ['fe80::1%en0/x', 'invalid'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['2001:db8::1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['localhost', 'loopback'],
    ['example.com', 'name'],
    ['tv', 'name'],
    ['.local', 'invalid'],
    // The helper's limit for a name: longer ones are refused there, so here too.
    [`${'a'.repeat(50)}.${'b'.repeat(44)}.local`, 'name'],
  ])('refuses %j as %s', (input, problem) => {
    expect(checkHost(input)).toEqual({ ok: false, problem })
  })
})

describe('parseAddress', () => {
  it('splits a pasted host and port, as the Wireless debugging screen writes them', () => {
    expect(parseAddress('192.168.1.20:41235')).toEqual({
      ok: true,
      host: '192.168.1.20',
      port: 41235,
    })
    expect(parseAddress('[fe80::1%en0]:5555')).toEqual({
      ok: true,
      host: 'fe80::1%en0',
      port: 5555,
    })
    expect(parseAddress('192.168.1.20')).toEqual({ ok: true, host: '192.168.1.20', port: null })
    // A bare IPv6 address is not "host:port".
    expect(parseAddress('fe80::1')).toEqual({ ok: true, host: 'fe80::1', port: null })
  })

  it('refuses a port out of range, and a bad host whatever the port', () => {
    expect(parseAddress('192.168.1.20:0')).toEqual({ ok: false, problem: 'invalid' })
    expect(parseAddress('192.168.1.20:70000')).toEqual({ ok: false, problem: 'invalid' })
    expect(parseAddress('8.8.8.8:5555')).toEqual({ ok: false, problem: 'public' })
    expect(parseAddress('')).toEqual({ ok: false, problem: 'empty' })
  })
})

describe('parsePort and parsePairingCode', () => {
  it('defaults an empty port to 5555, or asks for one when there is no default', () => {
    expect(parsePort('')).toEqual({ ok: true, port: 5555 })
    expect(parsePort(' 37099 ')).toEqual({ ok: true, port: 37099 })
    expect(parsePort('', null)).toEqual({ ok: false, problem: 'empty' })
    expect(parsePort('5555a')).toEqual({ ok: false, problem: 'invalid' })
    expect(parsePort('65536')).toEqual({ ok: false, problem: 'invalid' })
    expect(parsePort('0')).toEqual({ ok: false, problem: 'invalid' })
  })

  it('takes six digits, typed with spaces or dashes', () => {
    expect(parsePairingCode('482913')).toEqual({ ok: true, code: '482913' })
    expect(parsePairingCode('482 913')).toEqual({ ok: true, code: '482913' })
    expect(parsePairingCode('482-913')).toEqual({ ok: true, code: '482913' })
    expect(parsePairingCode('')).toEqual({ ok: false, problem: 'empty' })
    expect(parsePairingCode('48291')).toEqual({ ok: false, problem: 'invalid' })
    expect(parsePairingCode('48291a')).toEqual({ ok: false, problem: 'invalid' })
  })
})

describe('addressOf and targetOfSerial', () => {
  it('writes and reads adb’s network serials, IPv6 in brackets', () => {
    expect(addressOf({ host: '192.168.1.20', port: 5555 })).toBe('192.168.1.20:5555')
    expect(addressOf({ host: 'fe80::1%en0', port: 5555 })).toBe('[fe80::1%en0]:5555')
    expect(targetOfSerial('192.168.1.20:5555')).toEqual({ host: '192.168.1.20', port: 5555 })
    expect(targetOfSerial('[fe80::1%en0]:5555')).toEqual({ host: 'fe80::1%en0', port: 5555 })
  })

  it('is null for serials that are not an address', () => {
    expect(targetOfSerial('55090DLAQ0026D')).toBeNull()
    expect(targetOfSerial('emulator-5554')).toBeNull()
    expect(targetOfSerial('adb-R5CT1234-AbCdEf._adb-tls-connect._tcp')).toBeNull()
  })
})

describe('remembered devices', () => {
  const TV = { host: '192.168.1.42', port: 5555 }

  it('remembers newest first, keeps a known name, and caps the list', () => {
    const { store } = memory()
    rememberRecent({ ...TV, name: 'Living Room TV' }, 1, store)
    rememberRecent({ host: '192.168.1.50', port: 5555 }, 2, store)
    // Connected again before its row is listed: the name it had stays.
    const again = rememberRecent({ ...TV, name: '' }, 3, store)
    expect(again.map(recentLabel)).toEqual([
      'Living Room TV · 192.168.1.42:5555',
      '192.168.1.50:5555',
    ])
    for (let i = 0; i < RECENT_MAX + 3; i++) {
      rememberRecent({ host: `192.168.1.${String(100 + i)}`, port: 5555 }, 10 + i, store)
    }
    expect(readRecent(store)).toHaveLength(RECENT_MAX)
  })

  it('renames once listed, and forgets', () => {
    const { store } = memory()
    rememberRecent(TV, 1, store)
    expect(renameRecent(TV, 'SHIELD', store)[0]?.name).toBe('SHIELD')
    expect(forgetRecent(TV, store)).toEqual([])
    expect(readRecent(store)).toEqual([])
  })

  it('reads nothing from storage that is blocked, broken or tampered with', () => {
    expect(readRecent(throwing)).toEqual([])
    expect(rememberRecent(TV, 1, throwing)).toHaveLength(1)
    expect(readRecent(memory({ [RECENT_KEY]: '{not json' }).store)).toEqual([])
    const tampered = memory({
      [RECENT_KEY]: JSON.stringify({
        v: 1,
        items: [
          { host: '8.8.8.8', port: 5555, name: 'x', at: 1 },
          { host: '192.168.1.42', port: 99999, name: 'x', at: 1 },
          { host: '192.168.1.42', port: 5555, name: 7, at: 1 },
          { host: '192.168.1.42', port: 5555, name: 'TV', at: 2 },
        ],
      }),
    })
    expect(readRecent(tampered.store)).toEqual([
      { host: '192.168.1.42', port: 5555, name: 'TV', at: 2 },
    ])
    expect(readRecent(null)).toEqual([])
  })
})
