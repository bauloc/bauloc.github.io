/*
  The system resolver (§4.8, systemBrowse() in mdns.ts): dns-sd's and avahi-browse's output formats
  (the real lines from the owner's Mac, and hostile ones), browsing through fake tools in a
  private bin directory (fakes/dns-sd.ts) with slow, hanging, failing and missing tools, how
  its finds merge with the helper's own queries and adb's list, and GET /api/android/nearby
  and --doctor when the helper's own queries are blocked but dns-sd still looks.
  Neither the real dns-sd nor avahi-browse ever runs; no packet leaves.
*/
import { describe, expect, it } from 'vitest'
import {
  createAndroidLane,
  mergeNearby,
  nearbyFailureLines,
  nearbyFromBrowse,
  scanNearby,
  uniqueServices,
  androidVersionOfApi,
  adbTxtDetails,
  type AndroidCadence,
  type FoundService,
} from '../src/android-lane'
import { createBridge } from '../src/bridge'
import { streamTool } from '../src/process'
import {
  parseAvahiLine,
  parseAvahiTxt,
  parseDnsSdAddressLine,
  parseDnsSdBrowseLine,
  parseDnsSdReached,
  parseDnsSdTxt,
  presentationLabels,
  systemBrowse,
  systemMdnsTools,
  type SystemBrowseOptions,
  type SystemBrowseResult,
} from '../src/mdns'
import type { AndroidNearbyDevice, AndroidNearbyResult, Timeouts } from '../src/types'
import { alive, createFakeBin, type FakeBin } from './fakes/bin'
import {
  AVAHI_PIXEL,
  AVAHI_REMOTE,
  REAL_CAST,
  REAL_PIXEL,
  TV_ADB,
  TV_REMOTE,
  browseOutput,
  fakeAvahiBrowse,
  fakeDnsSd,
  lookupOutput,
  resolveOutput,
  type FakeDnsSd,
} from './fakes/dns-sd'
import { braviaTv, errno, fakeMdnsNetwork, pixel9, silentMdns } from './fakes/mdns'
import { freePort, isolation, onCleanup, request, tempDir, toolbox } from './harness'

const SERVICES = [
  '_adb._tcp.local',
  '_adb-tls-connect._tcp.local',
  '_adb-tls-pairing._tcp.local',
  '_androidtvremote2._tcp.local',
  '_googlecast._tcp.local',
]

/** The Pixel as the page gets it from dns-sd alone. */
const PIXEL: AndroidNearbyDevice = {
  id: 'wireless:192.168.68.114:43141',
  host: '192.168.68.114',
  port: 43141,
  kind: 'wireless',
  instance: REAL_PIXEL.instance,
  name: 'BAULOC Pixel 9',
  model: 'Pixel 9',
  osVersion: '17',
  serial: '55090DLAQ0026D',
  tv: false,
  connected: false,
  paired: false,
}

/** The owner's network as dns-sd saw it: the dozing Pixel, and the TV's three services. */
const OWNER: FakeDnsSd = {
  browse: {
    '_adb-tls-connect._tcp': REAL_PIXEL.browse,
    '_adb._tcp': browseOutput('_adb._tcp', [TV_ADB.instance]),
    '_androidtvremote2._tcp': browseOutput('_androidtvremote2._tcp', [TV_REMOTE.instance]),
    '_googlecast._tcp': browseOutput('_googlecast._tcp', [REAL_CAST.instance]),
  },
  resolve: {
    [`${REAL_PIXEL.instance}|_adb-tls-connect._tcp`]: REAL_PIXEL.resolve,
    [`${TV_ADB.instance}|_adb._tcp`]: TV_ADB.resolve,
    [`${TV_REMOTE.instance}|_androidtvremote2._tcp`]: TV_REMOTE.resolve,
    [`${REAL_CAST.instance}|_googlecast._tcp`]: REAL_CAST.resolve,
  },
  lookup: {
    [REAL_PIXEL.host]: REAL_PIXEL.lookup,
    'Android.local.': lookupOutput('Android.local.', ['192.168.68.101']),
    [REAL_CAST.host]: lookupOutput(REAL_CAST.host, ['192.168.68.101']),
  },
}

function bin(): FakeBin {
  return createFakeBin(tempDir('system-resolver-'))
}

/** systemBrowse() with the fake tool, the real streamTool, and test-sized deadlines. */
function browseWith(
  tools: SystemBrowseOptions['tools'],
  o: Partial<SystemBrowseOptions> = {},
): Promise<SystemBrowseResult> {
  return systemBrowse({
    services: SERVICES,
    tools,
    streamTool,
    browseMs: 1_200,
    resolveMs: 1_500,
    ...o,
  })
}

/** Every process a fake tool started is gone (each logged its PID first). */
async function allGone(b: FakeBin): Promise<void> {
  const deadline = Date.now() + 3_000
  while (b.calls().some((c) => alive(c.pid))) {
    if (Date.now() > deadline) throw new Error('a fake tool outlived its run')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/* ------------------------------------------------------------------- formats --- */

describe('dns-sd’s output, line by line', () => {
  it('-B: the real lines; a header, a Rmv, junk and a short line are told apart', () => {
    const lines = REAL_PIXEL.browse.split('\n')
    expect(lines.map(parseDnsSdBrowseLine).filter(Boolean)).toEqual([
      {
        op: 'Add',
        domain: 'local.',
        type: '_adb-tls-connect._tcp.',
        instance: 'adb-55090DLAQ0026D-nK25Qn',
      },
    ])
    /** An instance name with spaces is printed raw, padded columns before it. */
    expect(
      parseDnsSdBrowseLine(
        '21:00:24.704  Add        2  14 local.               _androidtvremote2._tcp. SONY KD-43X8050H',
      ),
    ).toMatchObject({ instance: 'SONY KD-43X8050H', type: '_androidtvremote2._tcp.' })
    expect(
      parseDnsSdBrowseLine(
        '21:00:24.704  Rmv        0  14 local.               _adb._tcp.           adb-b120be004010859',
      ),
    ).toMatchObject({ op: 'Rmv', instance: 'adb-b120be004010859' })
    for (const junk of [
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '21:00:20.680  ...STARTING...',
      '21:00:20.680  Add        2  14 local.',
      'Add 2 14 local. _adb._tcp. x',
      '',
    ]) {
      expect(parseDnsSdBrowseLine(junk)).toBeNull()
    }
  })

  it('-L: the real answer, an escaped full name, Flags, and lines that only look like one', () => {
    expect(parseDnsSdReached(REAL_PIXEL.resolve.split('\n')[3] ?? '')).toEqual({
      instance: 'adb-55090DLAQ0026D-nK25Qn',
      host: 'Android_GWZJSA15.local.',
      port: 43141,
    })
    expect(
      parseDnsSdReached(
        '21:00:43.125  SONY\\032KD-43X8050H._androidtvremote2._tcp.local. can be reached at Android.local.:6466 (interface 14) Flags: 1',
      ),
    ).toEqual({ instance: 'SONY KD-43X8050H', host: 'Android.local.', port: 6466 })
    /** A dot inside the instance is `\.`; a backslash `\\`. */
    expect(
      parseDnsSdReached(
        'TV\\032v2\\.0\\\\x._adb._tcp.local. can be reached at tv.local.:5555 (interface 4)',
      )?.instance,
    ).toBe('TV v2.0\\x')
    for (const junk of [
      'Lookup adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp.local.',
      'x._adb._tcp.local. can be reached at tv.local.:0 (interface 4)',
      'x._adb._tcp.local. can be reached at tv.local.:70000 (interface 4)',
      'x._adb._tcp.local. can be reached at tv.local. (interface 4)',
      'bad\\999._adb._tcp.local. can be reached at tv.local.:5555',
    ]) {
      expect(parseDnsSdReached(junk)).toBeNull()
    }
  })

  it('TXT: escaped spaces, an empty value, four backslashes for one, \\\\xHH, metacharacters', () => {
    expect(parseDnsSdTxt(REAL_PIXEL.resolve.split('\n')[4] ?? '')).toEqual([
      'given_name=BAULOC Pixel 9',
      'serial=55090DLAQ0026D',
      'v=2.1',
      'api=37.1',
      'name=Pixel 9',
    ])
    const cast = parseDnsSdTxt(REAL_CAST.resolve.split('\n')[4] ?? '')
    expect(cast).toContain('fn=SONY KD-43X8050H')
    expect(cast).toContain('md=BRAVIA 4K UR3')
    expect(cast[cast.length - 1]).toBe('rs=')
    expect(parseDnsSdTxt(' a=back\\\\\\\\slash b=new\\\\x0Aline c=\\&\\;\\$\\(x\\)')).toEqual([
      'a=back\\slash',
      'b=new\nline',
      'c=&;$(x)',
    ])
    expect(parseDnsSdTxt(' ' + 'k=v '.repeat(100)).length).toBe(32)
    expect(parseDnsSdTxt('')).toEqual([])
  })

  it('-G v4: the real answer; Rmv; an IPv6, a negative or a malformed answer is not an address', () => {
    expect(parseDnsSdAddressLine(REAL_PIXEL.lookup.split('\n')[3] ?? '')).toEqual({
      op: 'Add',
      host: 'Android_GWZJSA15.local.',
      address: '192.168.68.114',
    })
    expect(
      parseDnsSdAddressLine('21:00:50.987  Rmv  0  14  tv.local.  192.168.68.101  0'),
    ).toMatchObject({ op: 'Rmv' })
    for (const junk of [
      '21:00:50.987  Add  40000002  14  tv.local.  fe80::1  120',
      '21:00:50.987  Add  40000002  14  tv.local.  0.0.0.0  120   No Such Record',
      '21:00:50.987  Add  40000002  14  tv.local.  192.168.68.300  120',
      'Timestamp     A/R  Flags         IF  Hostname   Address   TTL',
    ]) {
      expect(parseDnsSdAddressLine(junk)).toBeNull()
    }
  })

  it('presentation names: \\DDD, \\X and UTF-8; a bad escape is refused', () => {
    expect(presentationLabels('SONY\\032KD-43X8050H._x._tcp.local.')).toEqual([
      'SONY KD-43X8050H',
      '_x',
      '_tcp',
      'local',
    ])
    expect(presentationLabels('Wohnzimmer\\032\\195\\188ber.local')).toEqual([
      'Wohnzimmer über',
      'local',
    ])
    expect(presentationLabels('Café.local.')).toEqual(['Café', 'local'])
    expect(presentationLabels('a\\256b')).toBeNull()
    expect(presentationLabels('trailing\\')).toBeNull()
  })
})

describe('avahi-browse’s output', () => {
  it('browse and resolve lines, a name escaped with \\032, a `;` inside a name, quoted TXT', () => {
    const [plus, , six, four] = AVAHI_PIXEL.split('\n')
    expect(parseAvahiLine(plus ?? '', '_adb-tls-connect._tcp')).toEqual({
      op: '+',
      protocol: 'IPv6',
      instance: 'adb-55090DLAQ0026D-nK25Qn',
      type: '_adb-tls-connect._tcp',
    })
    expect(parseAvahiLine(six ?? '', '_adb-tls-connect._tcp')).toMatchObject({
      protocol: 'IPv6',
      address: 'fe80::1c2d:3eff:fe4f:5a6b',
    })
    expect(parseAvahiLine(four ?? '', '_adb-tls-connect._tcp')).toEqual({
      op: '=',
      protocol: 'IPv4',
      instance: 'adb-55090DLAQ0026D-nK25Qn',
      type: '_adb-tls-connect._tcp',
      host: 'Android_GWZJSA15.local',
      address: '192.168.68.114',
      port: 43141,
      txt: [
        'given_name=BAULOC Pixel 9',
        'serial=55090DLAQ0026D',
        'v=2.1',
        'api=37.1',
        'name=Pixel 9',
      ],
    })
    expect(
      parseAvahiLine(AVAHI_REMOTE.split('\n')[1] ?? '', '_androidtvremote2._tcp'),
    ).toMatchObject({
      instance: 'SONY KD-43X8050H',
      host: 'Android.local',
      port: 6466,
    })
    expect(
      parseAvahiLine('=;eth0;IPv4;a;b;_adb._tcp;local;tv.local;192.168.1.5;5555;""', '_adb._tcp'),
    ).toMatchObject({ instance: 'a;b', txt: [''] })
    for (const junk of [
      '+;eth0;IPv4;x;_googlecast._tcp;local',
      '=;eth0;IPv4;x;_adb._tcp;local;tv.local;192.168.1.5;99999;""',
      '=;eth0;IPv4;x;_adb._tcp;local;tv.local;192.168.1.5',
      '+;eth0;IPv4;x;_adb._tcp;local;junk',
      'Failed to resolve service',
      '+;eth0',
    ]) {
      expect(parseAvahiLine(junk, '_adb._tcp')).toBeNull()
    }
  })

  it('TXT: escaped quotes and backslashes, \\DDD bytes, an unterminated string ends it', () => {
    expect(parseAvahiTxt('"a=say \\"hi\\"" "b=c:\\\\d" "e=\\195\\188"')).toEqual([
      'a=say "hi"',
      'b=c:\\d',
      'e=ü',
    ])
    expect(parseAvahiTxt('"a=1" "b=never closed')).toEqual(['a=1'])
    expect(parseAvahiTxt('')).toEqual([])
  })
})

describe('TXT details', () => {
  it('given_name, model, serial and the Android version of api=', () => {
    expect(
      adbTxtDetails([
        'given_name=BAULOC Pixel 9',
        'serial=55090DLAQ0026D',
        'v=2.1',
        'api=37.1',
        'name=Pixel 9',
      ]),
    ).toEqual({
      name: 'BAULOC Pixel 9',
      model: 'Pixel 9',
      serial: '55090DLAQ0026D',
      osVersion: '17',
    })
    expect(adbTxtDetails(['v=ADB_SECURE_SERVICE_VERSION=1'])).toEqual({})
    expect(
      adbTxtDetails(['serial=../../etc', 'given_name=\u001b[31mred\u0007', 'api=nope']),
    ).toEqual({
      name: 'red',
    })
    expect([30, 32, 33, 36, 37].map((n) => androidVersionOfApi(String(n)))).toEqual([
      '11',
      '12L',
      '13',
      '16',
      '17',
    ])
    expect(['20', '61', '37.1.1', ''].map(androidVersionOfApi)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

/* ------------------------------------------------------------------- dns-sd --- */

describe('browsing with dns-sd (macOS)', () => {
  it('the owner’s network: the dozing Pixel named by its TXT, and the TV named by Cast', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, OWNER)
    const started = Date.now()
    const result = await browseWith({ dnsSd, avahiBrowse: null })
    expect(Date.now() - started).toBeLessThan(1_200 + 2 * 1_500 + 1_000)
    expect(result).toMatchObject({ tool: 'dns-sd', looked: true })
    expect(result.instances.find((i) => i.instance === REAL_PIXEL.instance)).toEqual({
      service: '_adb-tls-connect._tcp.local',
      instance: REAL_PIXEL.instance,
      target: 'Android_GWZJSA15.local',
      port: 43141,
      addresses: ['192.168.68.114'],
      txt: [
        'given_name=BAULOC Pixel 9',
        'serial=55090DLAQ0026D',
        'v=2.1',
        'api=37.1',
        'name=Pixel 9',
      ],
    })
    const { found, names } = nearbyFromBrowse(result.instances)
    expect(mergeNearby(found, names, [])).toEqual([
      {
        id: 'adb:192.168.68.101:5555',
        host: '192.168.68.101',
        port: 5555,
        kind: 'adb',
        instance: TV_ADB.instance,
        name: 'SONY KD-43X8050H',
        serial: 'b120be004010859',
        tv: true,
        connected: false,
      },
      PIXEL,
    ])
    /** Exactly these, each argument as one argv entry (the TV's name with its space). */
    const argv = b.calls().map((c) => c.argv.join(' | '))
    expect(argv.filter((a) => a.startsWith('-B')).sort()).toEqual(
      SERVICES.map((s) => `-B | ${s.replace(/\.local$/, '')} | local.`).sort(),
    )
    expect(argv).toContain('-L | SONY KD-43X8050H | _androidtvremote2._tcp | local.')
    expect(argv).toContain(`-L | ${REAL_PIXEL.instance} | _adb-tls-connect._tcp | local.`)
    expect(argv).toContain('-G | v4 | Android_GWZJSA15.local.')
    /** `Android.local.` is asked once although two services point at it. */
    expect(argv.filter((a) => a === '-G | v4 | Android.local.')).toHaveLength(1)
    await allGone(b)
  })

  it('a resolve that never answers is killed on its deadline; the others still count', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      ...OWNER,
      resolve: {
        ...OWNER.resolve,
        [`${TV_ADB.instance}|_adb._tcp`]: { out: 'Lookup adb-b120be004010859._adb._tcp.local.\n' },
      },
    })
    const started = Date.now()
    const result = await browseWith(
      { dnsSd, avahiBrowse: null },
      { browseMs: 1_500, resolveMs: 900 },
    )
    expect(Date.now() - started).toBeLessThan(1_500 + 2 * 900 + 1_000)
    expect(result.instances.map((i) => i.instance).sort()).toEqual(
      [REAL_CAST.instance, REAL_PIXEL.instance, TV_REMOTE.instance].sort(),
    )
    await allGone(b)
  })

  it('slow answers inside the deadline still arrive; a lookup past it is cut off', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      browse: { '_adb-tls-connect._tcp': { out: REAL_PIXEL.browse, delay: 0.3 } },
      resolve: {
        [`${REAL_PIXEL.instance}|_adb-tls-connect._tcp`]: { out: REAL_PIXEL.resolve, delay: 0.3 },
      },
      lookup: { [REAL_PIXEL.host]: { out: REAL_PIXEL.lookup, delay: 0.3 } },
    })
    // Deadlines well past the 0.3 s delays: a freshly written fake's first exec can wait on
    // macOS's executable scan (syspolicyd) for most of a second under load.
    const ok = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 2_500, resolveMs: 3_000 })
    expect(ok.instances.map((i) => i.addresses)).toEqual([['192.168.68.114']])

    const slow = fakeDnsSd(b, {
      browse: { '_adb-tls-connect._tcp': REAL_PIXEL.browse },
      resolve: { [`${REAL_PIXEL.instance}|_adb-tls-connect._tcp`]: REAL_PIXEL.resolve },
      lookup: { [REAL_PIXEL.host]: { out: REAL_PIXEL.lookup, delay: 5 } },
    })
    const started = Date.now()
    const cut = await browseWith(
      { dnsSd: slow, avahiBrowse: null },
      { browseMs: 800, resolveMs: 800 },
    )
    expect(Date.now() - started).toBeLessThan(800 + 2 * 800 + 1_000)
    /** Resolved but no address: nothing nearbyFromBrowse would offer. */
    expect(cut.instances.map((i) => [i.port, i.addresses])).toEqual([[43141, []]])
    expect(cut.looked).toBe(true)
    await allGone(b)
  })

  it('a removed instance is dropped; one asked about twice is resolved once', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      browse: {
        '_adb-tls-connect._tcp':
          REAL_PIXEL.browse +
          browseOutput('_adb-tls-connect._tcp', [REAL_PIXEL.instance])
            .split('\n')
            .slice(4)
            .join('\n'),
        '_adb._tcp':
          browseOutput('_adb._tcp', [TV_ADB.instance]) +
          browseOutput('_adb._tcp', [TV_ADB.instance], 'Rmv').split('\n').slice(4).join('\n'),
      },
      resolve: OWNER.resolve,
      lookup: OWNER.lookup,
    })
    const result = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 })
    expect(result.instances.map((i) => i.instance)).toEqual([REAL_PIXEL.instance])
    expect(
      b.calls().filter((c) => c.argv[0] === '-L' && c.argv[1] === REAL_PIXEL.instance),
    ).toHaveLength(1)
    await allGone(b)
  })

  it('hostile output: options, oversized names, foreign answers, non-local hosts never go further', async () => {
    const b = bin()
    const long = 'x'.repeat(64)
    const dnsSd = fakeDnsSd(b, {
      browse: {
        '_adb._tcp':
          browseOutput('_adb._tcp', [
            '-rf',
            long,
            'adb-foreign',
            'adb-evilhost',
            'adb-other-domain',
          ]) +
          '21:00:20.680  Add        2  14 example.com.         _adb._tcp.           adb-other-domain\n' +
          '\u001b[2J21:00:20.680  Add  2  14 local. _googlecast._tcp. wrong-type\n' +
          'z'.repeat(20_000) +
          '\n',
      },
      resolve: {
        /** Answers for an instance it was not asked about. */
        'adb-foreign|_adb._tcp': resolveOutput(
          'adb-stranger._adb._tcp.local.',
          'stranger.local.',
          5555,
        ),
        /** A host outside .local, or one that is an option. */
        'adb-evilhost|_adb._tcp': resolveOutput(
          'adb-evilhost._adb._tcp.local.',
          'evil.example.com.',
          5555,
        ),
      },
    })
    const result = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900, resolveMs: 900 })
    expect(result.instances).toEqual([])
    const calls = b.calls().filter((c) => c.argv[0] !== '-B')
    expect(calls.map((c) => c.argv[1]).sort()).toEqual([
      'adb-evilhost',
      'adb-foreign',
      'adb-other-domain',
    ])
    expect(b.calls().some((c) => c.argv[0] === '-G')).toBe(false)
    await allGone(b)
  })

  it('two devices calling themselves Android.local: neither gets an address from a lookup', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      browse: { '_adb._tcp': browseOutput('_adb._tcp', ['adb-aaaa1111', 'adb-bbbb2222']) },
      resolve: {
        'adb-aaaa1111|_adb._tcp': resolveOutput(
          'adb-aaaa1111._adb._tcp.local.',
          'Android.local.',
          5555,
        ),
        'adb-bbbb2222|_adb._tcp': resolveOutput(
          'adb-bbbb2222._adb._tcp.local.',
          'Android.local.',
          5555,
        ),
      },
      lookup: {
        'Android.local.': lookupOutput('Android.local.', ['192.168.68.101', '192.168.68.102']),
      },
    })
    const result = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 })
    expect(result.instances.map((i) => [i.instance, i.addresses])).toEqual([
      ['adb-aaaa1111', []],
      ['adb-bbbb2222', []],
    ])
    expect(nearbyFromBrowse(result.instances).found).toEqual([])
  })

  it('caps what it keeps and how many resolve at once', async () => {
    const b = bin()
    const many = Array.from({ length: 40 }, (_, n) => `adb-device${String(n).padStart(4, '0')}`)
    const dnsSd = fakeDnsSd(b, { browse: { '_adb._tcp': browseOutput('_adb._tcp', many) } })
    const result = await browseWith(
      { dnsSd, avahiBrowse: null },
      { browseMs: 600, resolveMs: 300, max: 6, concurrency: 2 },
    )
    expect(result.instances).toEqual([])
    const resolves = b.calls().filter((c) => c.argv[0] === '-L')
    /** 6 kept; 2 at a time for 300 ms each within a 600 + 600 ms run: at most 6, at least 2. */
    expect(resolves.length).toBeLessThanOrEqual(6)
    expect(resolves.length).toBeGreaterThanOrEqual(2)
    await allGone(b)
  })

  it('Cast entries that never answer cannot starve the adb device of a resolve slot or of its place', async () => {
    /** Sleeping Chromecasts macOS still lists: their -L never answers (the fake's default). */
    const casts = Array.from({ length: 16 }, (_, n) => `Chromecast-${String(n)}`)
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      browse: {
        '_googlecast._tcp': browseOutput('_googlecast._tcp', casts),
        /** The phone shows up after them, so a first-come queue would put it last. */
        '_adb-tls-connect._tcp': { out: REAL_PIXEL.browse, delay: 0.2 },
      },
      resolve: { [`${REAL_PIXEL.instance}|_adb-tls-connect._tcp`]: REAL_PIXEL.resolve },
      lookup: { [REAL_PIXEL.host]: REAL_PIXEL.lookup },
    })
    /** 16 hanging resolves 4 at a time would fill the whole browse + 2 × resolve run. */
    for (const max of [undefined, 4]) {
      const started = Date.now()
      const result = await browseWith(
        { dnsSd, avahiBrowse: null },
        { browseMs: 900, resolveMs: 600, ...(max ? { max } : {}) },
      )
      expect(Date.now() - started).toBeLessThan(900 + 2 * 600 + 500)
      expect(result.instances.map((i) => i.instance)).toEqual([REAL_PIXEL.instance])
      expect(result.instances[0]?.addresses).toEqual([REAL_PIXEL.address])
    }
    /** The Casts got one slot at a time: at most 1 + (900 + 2 × 600) / 600 resolves a run. */
    const castResolves = b
      .calls()
      .filter((c) => c.argv[0] === '-L' && c.argv[2] === '_googlecast._tcp')
    expect(castResolves.length).toBeLessThanOrEqual(2 * 5)
    await allGone(b)
  })

  it('avahi: name-only services cannot take the adb devices’ places either', async () => {
    const b = bin()
    const casts = Array.from(
      { length: 6 },
      (_, n) =>
        `=;eth0;IPv4;Chromecast-${String(n)};_googlecast._tcp;local;cast-${String(n)}.local;192.168.68.${String(150 + n)};8009;"fn=TV ${String(n)}"\n`,
    ).join('')
    const avahi = fakeAvahiBrowse(b, {
      types: {
        '_googlecast._tcp': casts,
        '_adb-tls-connect._tcp': { out: AVAHI_PIXEL, exit: 0, delay: 0.3 },
      },
    })
    const result = await browseWith({ dnsSd: null, avahiBrowse: avahi }, { max: 2 })
    expect(result.instances.map((i) => i.instance)).toEqual([
      REAL_PIXEL.instance,
      'Chromecast-0',
      'Chromecast-1',
    ])
  })

  it('a dns-sd that ignores SIGTERM holds neither a slot nor the run past its deadline', async () => {
    const b = bin()
    const wedged = (out: string) => ({ out, ignoreTerm: true })
    const dnsSd = fakeDnsSd(b, {
      browse: {
        '_adb._tcp': wedged(browseOutput('_adb._tcp', ['adb-hang1', 'adb-hang2', TV_ADB.instance])),
      },
      resolve: { [`${TV_ADB.instance}|_adb._tcp`]: wedged(TV_ADB.resolve) },
      lookup: { 'Android.local.': wedged(lookupOutput('Android.local.', ['192.168.68.101'])) },
      /** Every other browse and both hanging resolves: print nothing, ignore SIGTERM. */
      otherwise: { out: '', ignoreTerm: true },
    })
    const started = Date.now()
    const result = await browseWith(
      { dnsSd, avahiBrowse: null },
      { browseMs: 400, resolveMs: 400, concurrency: 2 },
    )
    /** The bound is browse + 2 × resolve; waiting for SIGKILL (1.5 s here) would break it. */
    expect(Date.now() - started).toBeLessThan(400 + 2 * 400 + 350)
    /** The two hanging resolves were cut at 400 ms and freed their slots for the TV's. */
    expect(result.instances.map((i) => i.instance)).toEqual([TV_ADB.instance])
    expect(result.instances[0]?.addresses).toEqual(['192.168.68.101'])
    /** SIGKILL still follows, shortly. */
    await allGone(b)
  })

  it('a dns-sd that fails at once did not look, and says why; a missing one is never run', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      otherwise: { out: '', exit: 1, stderr: 'DNSServiceBrowse failed -65563\n' },
    })
    const failed = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 })
    expect(failed).toEqual({
      tool: 'dns-sd',
      looked: false,
      instances: [],
      detail: 'dns-sd exited with code 1: DNSServiceBrowse failed -65563',
    })
    const none = await browseWith({ dnsSd: null, avahiBrowse: null })
    expect(none).toEqual({ tool: null, looked: false, instances: [] })
  })

  it('a dns-sd with nothing to say still looked: it ran until stopped', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {})
    const result = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 700 })
    expect(result).toEqual({ tool: 'dns-sd', looked: true, instances: [] })
    await allGone(b)
  })

  it('stops everything when the scan is aborted', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, OWNER)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 300)
    const started = Date.now()
    await browseWith(
      { dnsSd, avahiBrowse: null },
      { browseMs: 5_000, resolveMs: 5_000, signal: abort.signal },
    )
    expect(Date.now() - started).toBeLessThan(2_500)
    await allGone(b)
  })
})

/* ------------------------------------------------------------------- avahi --- */

describe('browsing with avahi-browse (Linux)', () => {
  it('IPv4 answers only, the TXT read, a name with a space', async () => {
    const b = bin()
    const avahiBrowse = fakeAvahiBrowse(b, {
      types: { '_adb-tls-connect._tcp': AVAHI_PIXEL, '_androidtvremote2._tcp': AVAHI_REMOTE },
    })
    const result = await browseWith({ dnsSd: null, avahiBrowse })
    expect(result.tool).toBe('avahi-browse')
    expect(result.looked).toBe(true)
    expect(result.instances).toEqual([
      {
        service: '_adb-tls-connect._tcp.local',
        instance: REAL_PIXEL.instance,
        target: 'Android_GWZJSA15.local',
        port: 43141,
        addresses: ['192.168.68.114'],
        txt: [
          'given_name=BAULOC Pixel 9',
          'serial=55090DLAQ0026D',
          'v=2.1',
          'api=37.1',
          'name=Pixel 9',
        ],
      },
      {
        service: '_androidtvremote2._tcp.local',
        instance: 'SONY KD-43X8050H',
        target: 'Android.local',
        port: 6466,
        addresses: ['192.168.68.101'],
        txt: ['bt=A0:B1:C2:D3:E4:F5'],
      },
    ])
    expect(b.calls().map((c) => c.argv.slice(0, 4).join(' '))).toEqual(
      SERVICES.map(() => '-r -p -t -k'),
    )
    const { found, names } = nearbyFromBrowse(result.instances)
    expect(mergeNearby(found, names, [])).toEqual([PIXEL])
  })

  it('no daemon: did not look, says why; a hanging one is killed with what it printed kept', async () => {
    const b = bin()
    const down = fakeAvahiBrowse(b, {
      otherwise: {
        out: '',
        exit: 1,
        stderr: 'Failed to create client object: Daemon not running\n',
      },
    })
    expect(await browseWith({ dnsSd: null, avahiBrowse: down })).toEqual({
      tool: 'avahi-browse',
      looked: false,
      instances: [],
      detail: 'avahi-browse exited with code 1: Failed to create client object: Daemon not running',
    })
    const b2 = bin()
    const hanging = fakeAvahiBrowse(b2, {
      types: { '_adb-tls-connect._tcp': { out: AVAHI_PIXEL } },
      otherwise: { out: '' },
    })
    const started = Date.now()
    const result = await browseWith(
      { dnsSd: null, avahiBrowse: hanging },
      { browseMs: 500, resolveMs: 500 },
    )
    expect(Date.now() - started).toBeLessThan(500 + 500 + 1_500)
    expect(result.looked).toBe(true)
    expect(result.instances.map((i) => i.instance)).toEqual([REAL_PIXEL.instance])
    await allGone(b2)
  })

  it('a removed service is dropped', async () => {
    const b = bin()
    const avahiBrowse = fakeAvahiBrowse(b, {
      types: {
        '_adb-tls-connect._tcp':
          AVAHI_PIXEL + '-;wlan0;IPv4;adb-55090DLAQ0026D-nK25Qn;_adb-tls-connect._tcp;local\n',
      },
    })
    expect((await browseWith({ dnsSd: null, avahiBrowse })).instances).toEqual([])
  })
})

describe('which tool', () => {
  it('dns-sd at its fixed path on macOS only; avahi-browse on Linux from PATH; nothing elsewhere', () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {})
    const avahi = fakeAvahiBrowse(b, {})
    const base = { avahiBrowsePath: undefined, searchPath: b.dir, extraDirs: [] }
    expect(systemMdnsTools({ ...base, platform: 'darwin', dnsSdPath: dnsSd })).toEqual({
      dnsSd,
      avahiBrowse: null,
    })
    expect(systemMdnsTools({ ...base, platform: 'darwin', dnsSdPath: `${b.dir}/nope` })).toEqual({
      dnsSd: null,
      avahiBrowse: null,
    })
    /** Never looked up on PATH: a relative path is refused. */
    expect(systemMdnsTools({ ...base, platform: 'darwin', dnsSdPath: 'dns-sd' }).dnsSd).toBeNull()
    expect(systemMdnsTools({ ...base, platform: 'linux', dnsSdPath: dnsSd })).toEqual({
      dnsSd: null,
      avahiBrowse: avahi,
    })
    expect(
      systemMdnsTools({ ...base, platform: 'linux', dnsSdPath: dnsSd, searchPath: `.:bin:` })
        .avahiBrowse,
    ).toBeNull()
    expect(
      systemMdnsTools({
        ...base,
        platform: 'linux',
        dnsSdPath: dnsSd,
        avahiBrowsePath: '/nowhere/avahi-browse',
      }).avahiBrowse,
    ).toBeNull()
    expect(systemMdnsTools({ ...base, platform: 'win32', dnsSdPath: dnsSd })).toEqual({
      dnsSd: null,
      avahiBrowse: null,
    })
  })
})

/* ------------------------------------------------------------------- merging --- */

const found = (
  f: Partial<FoundService> & Pick<FoundService, 'kind' | 'host' | 'port' | 'instance'>,
): FoundService => f

describe('merging the three sources', () => {
  const system = (result: Partial<SystemBrowseResult>) => () =>
    Promise.resolve({ tool: 'dns-sd' as const, looked: true, instances: [], ...result })

  it('blocked queries but dns-sd looked: no error, a note, and what dns-sd found', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    const b = bin()
    const dnsSd = fakeDnsSd(b, OWNER)
    const scan = await scanNearby({
      open: network.open,
      windowMs: 100,
      now: Date.now,
      adbList: () => Promise.resolve(''),
      system: () => browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 }),
    })
    expect(scan.error).toBeUndefined()
    expect(scan.note).toEqual({
      reason: 'blocked',
      message: expect.stringContaining("Looked through this computer's own resolver") as unknown,
      detail: 'send EHOSTUNREACH 224.0.0.251:5353',
    })
    expect(scan.system).toBe('dns-sd')
    expect(mergeNearby(scan.found, scan.names, []).map((d) => d.id)).toEqual([
      'adb:192.168.68.101:5555',
      'wireless:192.168.68.114:43141',
    ])
  })

  it('blocked queries and no resolver that looked: the blocked error, as before', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    for (const resolver of [
      undefined,
      system({ looked: false, detail: 'dns-sd exited with code 1' }),
      () => Promise.reject(new Error('boom')),
    ]) {
      const scan = await scanNearby({
        open: network.open,
        windowMs: 100,
        now: Date.now,
        adbList: () => Promise.resolve(''),
        system: resolver,
      })
      expect(scan.error?.reason).toBe('blocked')
      expect(scan.note).toBeUndefined()
    }
  })

  it('both failed: the resolver’s own words join the socket’s in error.detail and the lines', async () => {
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      otherwise: { out: '', exit: 1, stderr: 'DNSServiceBrowse failed -65563\n' },
    })
    const scan = await scanNearby({
      open: network.open,
      windowMs: 100,
      now: Date.now,
      adbList: () => Promise.resolve(''),
      system: () => browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 }),
    })
    const why = 'dns-sd exited with code 1: DNSServiceBrowse failed -65563'
    expect(scan.error).toMatchObject({
      reason: 'blocked',
      detail: `send EHOSTUNREACH 224.0.0.251:5353; ${why}`,
    })
    expect(scan.systemDetail).toBe(why)
    const lines = nearbyFailureLines(scan.error!, 'linux', scan.systemDetail)
    expect(lines[0]).toBe(
      "Wi-Fi: could not look for Android devices on the network: no route to host, so this computer can't reach the local network",
    )
    expect(lines.at(-1)).toBe(`  The system resolver could not look either: ${why}`)
    /** The cause still comes from the socket's words only. */
    expect(
      nearbyFailureLines(
        { reason: 'blocked', message: '', detail: 'send EPERM 224.0.0.251:5353; dns-sd: EACCES' },
        'linux',
        'dns-sd: EACCES',
      )[0],
    ).toContain('not permitted')
    expect(
      nearbyFailureLines(
        { reason: 'failed', message: '', detail: `send EIO 224.0.0.251:5353; ${why}` },
        'linux',
        why,
      ),
    ).toEqual([
      'Wi-Fi: could not look for Android devices on the network: send EIO 224.0.0.251:5353',
      `  The system resolver could not look either: ${why}`,
    ])
    /** No resolver at all: nothing to add. */
    const none = await scanNearby({
      open: network.open,
      windowMs: 100,
      now: Date.now,
      adbList: () => Promise.resolve(''),
    })
    expect(none.error?.detail).toBe('send EHOSTUNREACH 224.0.0.251:5353')
    expect(none.systemDetail).toBeUndefined()
  })

  it('the helper’s queries find the TV, dns-sd the dozing phone: both offered, once each', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, OWNER)
    const scan = await scanNearby({
      open: fakeMdnsNetwork([braviaTv()]).open,
      windowMs: 150,
      now: Date.now,
      adbList: () => Promise.resolve(''),
      system: () => browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 }),
    })
    expect(scan.error).toBeUndefined()
    expect(scan.note).toBeUndefined()
    const devices = mergeNearby(scan.found, scan.names, [])
    expect(devices.map((d) => `${d.id} ${d.name}`)).toEqual([
      'adb:192.168.68.101:5555 SONY KD-43X8050H',
      'wireless:192.168.68.114:43141 BAULOC Pixel 9',
    ])
  })

  it('the same service from two sources: the first kept, the TXT name filled in from the other', () => {
    const udp = found({
      kind: 'wireless',
      host: '192.168.68.114',
      port: 39601,
      instance: REAL_PIXEL.instance,
    })
    const sys = found({
      kind: 'wireless',
      host: '192.168.68.114',
      port: 39601,
      instance: REAL_PIXEL.instance,
      name: 'BAULOC Pixel 9',
      model: 'Pixel 9',
      osVersion: '17',
    })
    expect(uniqueServices([udp, sys])).toEqual([
      { ...udp, name: 'BAULOC Pixel 9', model: 'Pixel 9', osVersion: '17' },
    ])
    expect(mergeNearby([udp, sys], new Map(), [])[0]).toMatchObject({
      name: 'BAULOC Pixel 9',
      model: 'Pixel 9',
    })
  })

  it('by serial too: adb’s stale instance at an old port goes; the pairing port of the same phone stays', () => {
    const current = found({
      kind: 'wireless',
      host: '192.168.68.114',
      port: 43141,
      instance: REAL_PIXEL.instance,
    })
    const stale = found({
      kind: 'wireless',
      host: '192.168.68.114',
      port: 40001,
      instance: 'adb-55090DLAQ0026D-AbC123',
    })
    const pairing = found({
      kind: 'pairing',
      host: '192.168.68.114',
      port: 37123,
      instance: 'adb-55090DLAQ0026D-AbC123',
    })
    /** A TXT serial counts when the instance carries none: same host, another port. */
    const txtOnly = found({
      kind: 'adb',
      host: '192.168.68.120',
      port: 5555,
      instance: 'Living Room',
      serial: 'XYZ123',
    })
    const txtDup = found({
      kind: 'adb',
      host: '192.168.68.120',
      port: 5556,
      instance: 'Living Room 2',
      serial: 'XYZ123',
    })
    /** adb's own list may keep the phone at an old address: there the serial counts anywhere. */
    const adbOld = found({
      kind: 'wireless',
      host: '192.168.68.99',
      port: 38000,
      instance: 'adb-55090DLAQ0026D-Old000',
      fromAdb: true,
    })
    expect(
      uniqueServices([current, stale, pairing, txtOnly, txtDup, adbOld]).map(
        (f) => `${f.kind}:${f.port}:${f.host}`,
      ),
    ).toEqual([
      'wireless:43141:192.168.68.114',
      'pairing:37123:192.168.68.114',
      'adb:5555:192.168.68.120',
    ])
    expect(uniqueServices([adbOld])[0]).not.toHaveProperty('fromAdb')
  })

  it('two boxes at different addresses sharing one serial are two devices; a junk serial never merges', () => {
    /** Cheap TV boxes ship with ro.serialno 0123456789ABCDEF: one in the name, one in TXT. */
    const box1 = found({
      kind: 'adb',
      host: '192.168.1.10',
      port: 5555,
      instance: 'adb-0123456789ABCDEF',
    })
    const box2 = found({
      kind: 'adb',
      host: '192.168.1.11',
      port: 5555,
      instance: 'box2',
      serial: '0123456789ABCDEF',
    })
    /** A real serial shared at two addresses by the network sources: kept apart too. */
    const twin1 = found({
      kind: 'wireless',
      host: '192.168.1.20',
      port: 40001,
      instance: 'a',
      serial: 'R58M123',
    })
    const twin2 = found({
      kind: 'wireless',
      host: '192.168.1.21',
      port: 40001,
      instance: 'b',
      serial: 'R58M123',
    })
    /** Junk serials on one host: still two services (different ports and instances). */
    const same1 = found({
      kind: 'adb',
      host: '192.168.1.30',
      port: 5555,
      instance: 'x',
      serial: 'unknown',
    })
    const same2 = found({
      kind: 'adb',
      host: '192.168.1.30',
      port: 5556,
      instance: 'y',
      serial: 'unknown',
    })
    /** adb's list with a junk serial at another address: not the same box either. */
    const adbJunk = found({
      kind: 'adb',
      host: '192.168.1.12',
      port: 5555,
      instance: 'adb-0123456789abcdef (2)',
      serial: '0123456789abcdef',
      fromAdb: true,
    })
    const ids = uniqueServices([box1, box2, twin1, twin2, same1, same2, adbJunk]).map(
      (f) => `${f.host}:${f.port}`,
    )
    expect(ids).toEqual([
      '192.168.1.10:5555',
      '192.168.1.11:5555',
      '192.168.1.20:40001',
      '192.168.1.21:40001',
      '192.168.1.30:5555',
      '192.168.1.30:5556',
      '192.168.1.12:5555',
    ])
    /** The page gets both boxes, and a junk serial over USB does not mark either connected. */
    const devices = mergeNearby([box1, box2], new Map(), [
      { serial: '0123456789ABCDEF', state: 'device', props: {} },
    ])
    expect(devices.map((d) => `${d.id} ${String(d.connected)}`)).toEqual([
      'adb:192.168.1.10:5555 false',
      'adb:192.168.1.11:5555 false',
    ])
  })

  it('the same local-address rules and cap: public, loopback and names are never offered', async () => {
    const b = bin()
    const dnsSd = fakeDnsSd(b, {
      browse: {
        '_adb._tcp': browseOutput('_adb._tcp', ['adb-public1', 'adb-loop1', 'adb-local1']),
      },
      resolve: {
        'adb-public1|_adb._tcp': resolveOutput('adb-public1._adb._tcp.local.', 'pub.local.', 5555),
        'adb-loop1|_adb._tcp': resolveOutput('adb-loop1._adb._tcp.local.', 'loop.local.', 5555),
        'adb-local1|_adb._tcp': resolveOutput('adb-local1._adb._tcp.local.', 'ok.local.', 5555),
      },
      lookup: {
        'pub.local.': lookupOutput('pub.local.', ['8.8.8.8']),
        'loop.local.': lookupOutput('loop.local.', ['127.0.0.1']),
        'ok.local.': lookupOutput('ok.local.', ['10.0.0.7']),
      },
    })
    const result = await browseWith({ dnsSd, avahiBrowse: null }, { browseMs: 900 })
    expect(nearbyFromBrowse(result.instances).found.map((f) => f.host)).toEqual(['10.0.0.7'])
    const lots = Array.from({ length: 80 }, (_, n) =>
      found({
        kind: 'adb',
        host: `10.0.${String(n >> 8)}.${String(n & 255)}`,
        port: 5555,
        instance: `adb-x${String(n)}`,
      }),
    )
    expect(mergeNearby(lots, new Map(), [])).toHaveLength(64)
  })
})

/* ------------------------------------------------------------------- the bridge --- */

const FAST: Partial<Timeouts> = {
  adbConnect: 1_000,
  adbRequest: 1_000,
  mdnsWindow: 150,
  systemBrowse: 900,
  systemResolve: 1_000,
}
const CADENCE: Partial<AndroidCadence> = {
  presenceMs: 100,
  pollMs: 100,
  nearbyCacheMs: 1_500,
  nearbyGapMs: 600,
}

describe('GET /api/android/nearby and --doctor with dns-sd', () => {
  it('blocked queries, dns-sd looked: 200 without an error, the Pixel listed, one quiet note', async () => {
    const iso = await isolation({ adbPort: await freePort(), timeouts: FAST, platform: 'darwin' })
    fakeDnsSd(iso.bin, OWNER)
    const network = fakeMdnsNetwork([braviaTv(), pixel9()])
    network.sendError = errno('EHOSTUNREACH')
    const bridge = createBridge({
      ...iso.input,
      mdns: network.open,
      lanes: { ios: null, simulators: null, android: (ctx) => createAndroidLane(ctx, CADENCE) },
      resolveTools: () =>
        Promise.resolve(toolbox((t) => (t.adb = { path: '/nowhere/adb', version: '36.0.0' }))),
    })
    const { port } = await bridge.listen()
    onCleanup(() => bridge.close())
    const reply = await request(port, {
      path: '/api/android/nearby',
      headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' },
    })
    expect(reply.status).toBe(200)
    const body = reply.json<AndroidNearbyResult>()
    expect(body.error).toBeUndefined()
    expect(body.note?.reason).toBe('blocked')
    expect(body.devices.map((d) => d.id)).toEqual([
      'adb:192.168.68.101:5555',
      'wireless:192.168.68.114:43141',
    ])
    expect(body.devices[1]).toEqual(PIXEL)
    const lines = iso.logs
      .map((l) => l.replace(/^\S+ {2}/, ''))
      .filter((l) => l.startsWith('Wi-Fi'))
    expect(lines).toEqual([
      "Wi-Fi: looked through dns-sd; the helper's own mDNS queries could not leave (send EHOSTUNREACH 224.0.0.251:5353), so connecting may be refused too",
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging)',
    ])
    expect(iso.logs.some((l) => /VPN|Terminal\.app/.test(l))).toBe(false)
    await bridge.close()
    await allGone(iso.bin)
  })

  it('both blocked and dns-sd failing: the endpoint’s error and the terminal and --doctor say why dns-sd could not look', async () => {
    const iso = await isolation({ adbPort: await freePort(), timeouts: FAST, platform: 'darwin' })
    fakeDnsSd(iso.bin, {
      otherwise: { out: '', exit: 1, stderr: 'DNSServiceBrowse failed -65563\n' },
    })
    const network = fakeMdnsNetwork([braviaTv()])
    network.sendError = errno('EHOSTUNREACH')
    const bridge = createBridge({
      ...iso.input,
      mdns: network.open,
      lanes: { ios: null, simulators: null, android: (ctx) => createAndroidLane(ctx, CADENCE) },
      resolveTools: () =>
        Promise.resolve(toolbox((t) => (t.adb = { path: '/nowhere/adb', version: '36.0.0' }))),
    })
    const { port } = await bridge.listen()
    onCleanup(() => bridge.close())
    const reply = await request(port, {
      path: '/api/android/nearby',
      headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://bauloc.github.io' },
    })
    expect(reply.status).toBe(200)
    const why = 'dns-sd exited with code 1: DNSServiceBrowse failed -65563'
    expect(reply.json<AndroidNearbyResult>().error).toMatchObject({
      reason: 'blocked',
      detail: `send EHOSTUNREACH 224.0.0.251:5353; ${why}`,
    })
    const said = `  The system resolver could not look either: ${why}`
    expect(iso.logs.some((l) => l.endsWith(said))).toBe(true)
    const doctor: string[] = []
    await bridge.lanes.android?.probeForDoctor?.((line) => doctor.push(line))
    expect(doctor).toContain(said)
    await bridge.close()
    await allGone(iso.bin)
  })

  it('--doctor names the Pixel by its own name, with its Android version', async () => {
    const iso = await isolation({
      adbPort: await freePort(),
      timeouts: FAST,
      platform: 'darwin',
      mdns: silentMdns(),
    })
    fakeDnsSd(iso.bin, OWNER)
    const bridge = createBridge({
      ...iso.input,
      lanes: { ios: null, simulators: null, android: createAndroidLane },
    })
    const lines: string[] = []
    await bridge.lanes.android?.probeForDoctor?.((line) => lines.push(line))
    expect(lines.slice(1)).toEqual([
      'Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging)',
      '  SONY KD-43X8050H · 192.168.68.101:5555 · Network debugging · not connected',
      '  BAULOC Pixel 9 · 192.168.68.114:43141 · Wireless debugging · Android 17 · not connected',
    ])
    await allGone(iso.bin)
  })
})
