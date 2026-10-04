/*
  Fake system resolvers for §4.8 (systemBrowse() in mdns.ts): a fake /usr/bin/dns-sd and a fake
  avahi-browse, written into the test's private bin directory by fakes/bin.ts, so no test
  ever asks the real mDNSResponder or avahi-daemon anything.

  The dns-sd outputs below are byte for byte what the real tool printed on the owner's Mac
  and network on 2026-10-04 (the Pixel 9 with Wireless debugging dozing, so only the daemon's
  cache knew it; the BRAVIA's Cast service), plus the TV's adb and Remote answers in the same
  format. Like the real one, the fake dns-sd prints and then never exits: the helper has to
  kill every process it starts.

  The avahi-browse output is what `avahi-browse -r -p -t -k` prints for the same devices.
*/
import type { FakeBin } from './bin'

/** What the real `dns-sd -B` printed (the header goes out with the first answer). */
export function browseOutput(type: string, adds: readonly string[], op = 'Add'): string {
  const lines = [
    `Browsing for ${type}.local.`,
    'DATE: ---Sun 04 Oct 2026---',
    '21:00:20.680  ...STARTING...',
    'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
    ...adds.map(
      (instance) =>
        `21:00:20.680  ${op.padEnd(3)}        2  14 local.               ${`${type}.`.padEnd(20)} ${instance}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

/** What the real `dns-sd -L` printed: the full name escaped, then the TXT line when there is one. */
export function resolveOutput(fullName: string, host: string, port: number, txt?: string): string {
  return (
    [
      `Lookup ${fullName}`,
      'DATE: ---Sun 04 Oct 2026---',
      '21:00:42.922  ...STARTING...',
      `21:00:43.125  ${fullName} can be reached at ${host}:${String(port)} (interface 14)`,
      ...(txt === undefined ? [] : [txt]),
    ].join('\n') + '\n'
  )
}

/** What the real `dns-sd -G v4` printed. */
export function lookupOutput(host: string, addresses: readonly string[]): string {
  return (
    [
      'DATE: ---Sun 04 Oct 2026---',
      '21:00:50.986  ...STARTING...',
      'Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL',
      ...addresses.map(
        (address) =>
          `21:00:50.987  Add  40000002      14  ${host.padEnd(38)} ${address.padEnd(44)} 120`,
      ),
    ].join('\n') + '\n'
  )
}

/** The Pixel 9 as the owner's dns-sd showed it, Wireless debugging on, the phone dozing. */
export const REAL_PIXEL = {
  instance: 'adb-55090DLAQ0026D-nK25Qn',
  browse:
    'Browsing for _adb-tls-connect._tcp.local.\n' +
    'DATE: ---Sun 04 Oct 2026---\n' +
    '21:00:20.680  ...STARTING...\n' +
    'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name\n' +
    '21:00:20.680  Add        2  14 local.               _adb-tls-connect._tcp. adb-55090DLAQ0026D-nK25Qn\n',
  resolve:
    'Lookup adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp.local.\n' +
    'DATE: ---Sun 04 Oct 2026---\n' +
    '21:00:42.922  ...STARTING...\n' +
    '21:00:43.125  adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp.local. can be reached at Android_GWZJSA15.local.:43141 (interface 14)\n' +
    ' given_name=BAULOC\\ Pixel\\ 9 serial=55090DLAQ0026D v=2.1 api=37.1 name=Pixel\\ 9\n',
  host: 'Android_GWZJSA15.local.',
  lookup:
    'DATE: ---Sun 04 Oct 2026---\n' +
    '21:00:50.986  ...STARTING...\n' +
    'Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL\n' +
    '21:00:50.987  Add  40000002      14  Android_GWZJSA15.local.                192.168.68.114                               120\n',
  address: '192.168.68.114',
  port: 43141,
} as const

/** The BRAVIA's Cast service as the owner's dns-sd resolved it. */
export const REAL_CAST = {
  instance: 'BRAVIA-4K-UR3-208b30c617f370775350bf056804e1d5',
  resolve:
    'Lookup BRAVIA-4K-UR3-208b30c617f370775350bf056804e1d5._googlecast._tcp.local.\n' +
    'DATE: ---Sun 04 Oct 2026---\n' +
    '21:00:48.969  ...STARTING...\n' +
    '21:00:48.970  BRAVIA-4K-UR3-208b30c617f370775350bf056804e1d5._googlecast._tcp.local. can be reached at 208b30c6-17f3-7077-5350-bf056804e1d5.local.:8009 (interface 14)\n' +
    ' id=208b30c617f370775350bf056804e1d5 cd=BA2047E2A51EF1D94B857CF9B9D71EA6 rm=595912410F9FC069 ve=05 md=BRAVIA\\ 4K\\ UR3 ic=/setup/icon.png fn=SONY\\ KD-43X8050H ca=264709 st=0 bs=FA8F28BDCF73 nf=1 ct=C23B46 rs=\n',
  host: '208b30c6-17f3-7077-5350-bf056804e1d5.local.',
} as const

/** The TV's adb and Remote services, in the same format (both on `Android.local`). */
export const TV_ADB = {
  instance: 'adb-b120be004010859',
  resolve: resolveOutput('adb-b120be004010859._adb._tcp.local.', 'Android.local.', 5555),
}
export const TV_REMOTE = {
  instance: 'SONY KD-43X8050H',
  resolve: resolveOutput(
    'SONY\\032KD-43X8050H._androidtvremote2._tcp.local.',
    'Android.local.',
    6466,
    ' bt=A0:B1:C2:D3:E4:F5',
  ),
}

/** One answer of the fake dns-sd: what it prints, after how long, and whether it then exits. */
export interface FakeAnswer {
  out: string
  /** Seconds before printing. */
  delay?: number
  /** Exit with this code after printing instead of running on, as dns-sd does on an error. */
  exit?: number
  stderr?: string
  /** Ignore SIGTERM (inherited by the `sleep` it execs), as a wedged tool would: only SIGKILL ends it. */
  ignoreTerm?: boolean
}

export interface FakeDnsSd {
  /** `dns-sd -B <type> local.` by type (`_adb._tcp`). */
  browse?: Record<string, string | FakeAnswer>
  /** `dns-sd -L <instance> <type> local.` by `<instance>|<type>`. */
  resolve?: Record<string, string | FakeAnswer>
  /** `dns-sd -G v4 <host>` by host as passed. */
  lookup?: Record<string, string | FakeAnswer>
  /** For anything else: print nothing and run on (the default), or exit with this code. */
  otherwise?: FakeAnswer
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** A shell `case` branch printing a fixture, then running on (or exiting). */
function branch(bin: FakeBin, tag: string, key: string, answer: string | FakeAnswer): string {
  const a = typeof answer === 'string' ? { out: answer } : answer
  const name = `${tag}-${Buffer.from(key).toString('hex').slice(0, 80)}`
  bin.fixture(name, a.out)
  if (a.stderr !== undefined) bin.fixture(`${name}.err`, a.stderr)
  const body = [
    a.ignoreTerm ? `trap '' TERM` : '',
    a.delay ? `sleep ${String(a.delay)}` : '',
    `cat "$FAKE_STATE/fixtures/${name}"`,
    a.stderr !== undefined ? `cat "$FAKE_STATE/fixtures/${name}.err" >&2` : '',
    a.exit !== undefined ? `exit ${String(a.exit)}` : 'exec sleep 30',
  ].filter(Boolean)
  return `  ${quote(key)}) ${body.join('; ')} ;;`
}

/** Writes the fake `dns-sd` into bin.dir and returns its path (harness: options.dnsSdPath). */
export function fakeDnsSd(bin: FakeBin, spec: FakeDnsSd): string {
  /** The `*)` branch: its body only, so `*` stays a pattern. */
  const otherwise = spec.otherwise
    ? branch(bin, 'X', '*', spec.otherwise)
        .replace(/^ {2}'\*'\) /, '')
        .replace(/ ;;$/, '')
    : 'exec sleep 30'
  const cases = (tag: string, map: Record<string, string | FakeAnswer> | undefined): string =>
    Object.entries(map ?? {})
      .map(([key, answer]) => branch(bin, tag, key, answer))
      .join('\n')
  return bin.tool(
    'dns-sd',
    `case "$1" in
-B) case "$2" in
${cases('B', spec.browse)}
  *) ${otherwise} ;;
  esac ;;
-L) case "$2|$3" in
${cases('L', spec.resolve)}
  *) ${otherwise} ;;
  esac ;;
-G) case "$3" in
${cases('G', spec.lookup)}
  *) ${otherwise} ;;
  esac ;;
*) echo "dns-sd: unexpected $1" >&2; exit 2 ;;
esac`,
  )
}

/** `avahi-browse -r -p -t -k` for the Pixel: browse line, then IPv6 and IPv4 resolutions. */
export const AVAHI_PIXEL =
  '+;wlan0;IPv6;adb-55090DLAQ0026D-nK25Qn;_adb-tls-connect._tcp;local\n' +
  '+;wlan0;IPv4;adb-55090DLAQ0026D-nK25Qn;_adb-tls-connect._tcp;local\n' +
  '=;wlan0;IPv6;adb-55090DLAQ0026D-nK25Qn;_adb-tls-connect._tcp;local;Android_GWZJSA15.local;fe80::1c2d:3eff:fe4f:5a6b;43141;"given_name=BAULOC Pixel 9" "serial=55090DLAQ0026D" "v=2.1" "api=37.1" "name=Pixel 9"\n' +
  '=;wlan0;IPv4;adb-55090DLAQ0026D-nK25Qn;_adb-tls-connect._tcp;local;Android_GWZJSA15.local;192.168.68.114;43141;"given_name=BAULOC Pixel 9" "serial=55090DLAQ0026D" "v=2.1" "api=37.1" "name=Pixel 9"\n'

/** The TV's Remote through avahi: its name escaped (`\032`), as avahi_escape_label writes it. */
export const AVAHI_REMOTE =
  '+;eth0;IPv4;SONY\\032KD-43X8050H;_androidtvremote2._tcp;local\n' +
  '=;eth0;IPv4;SONY\\032KD-43X8050H;_androidtvremote2._tcp;local;Android.local;192.168.68.101;6466;"bt=A0:B1:C2:D3:E4:F5"\n'

export interface FakeAvahi {
  /** By type: what `avahi-browse … <type>` prints. */
  types?: Record<string, string | FakeAnswer>
  /** For a type not listed: exit 0 having found nothing (the default), or this. */
  otherwise?: FakeAnswer
}

/** Writes the fake `avahi-browse` into bin.dir and returns its path. */
export function fakeAvahiBrowse(bin: FakeBin, spec: FakeAvahi): string {
  const branches = Object.entries(spec.types ?? {}).map(([type, answer]) => {
    const a = typeof answer === 'string' ? { out: answer, exit: 0 } : answer
    return branch(bin, 'A', type, a)
  })
  const o = spec.otherwise
  const otherwise = o ? branch(bin, 'A', '*', o).replace(/^ {2}'\*'\)/, '  *)') : '  *) exit 0 ;;'
  return bin.tool(
    'avahi-browse',
    `type=""; for a in "$@"; do type="$a"; done
case "$type" in
${branches.join('\n')}
${otherwise}
esac`,
  )
}
