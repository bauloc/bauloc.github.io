/*
  Pair-record certificate chains for the fake lockdownd, made at suite start with the Mac's
  /usr/bin/openssl (LibreSSL 3.3.6 [V]). No private key is ever committed.

  Two RSA-2048, SHA-1 chains, Root → Host and Root → Device, like a real pair record:
  - 'empty': every subject and issuer name is empty (`-subj "/"`), exactly as in the records
    usbmuxd hands out [V, §0.2];
  - 'named': CN=Root / CN=Host / CN=Device. OpenSSL 3 at its default security level refuses
    this one synchronously (ERR_SSL_CA_MD_TOO_WEAK), which is why the client always uses
    `@SECLEVEL=0` (§3.3).
  Plus a mismatched key, which makes tls.connect throw synchronously (the "bad key" case).

  Tests that need TLS skip when /usr/bin/openssl is missing.
*/
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PairRecord } from '../../src/usbmuxd'
import type { PlistInput } from '../../src/plist'

export const OPENSSL = '/usr/bin/openssl'
export const hasOpenssl = existsSync(OPENSSL)

export type ChainKind = 'empty' | 'named'

export interface Chain {
  kind: ChainKind
  root: { cert: Buffer; key: Buffer }
  host: { cert: Buffer; key: Buffer }
  device: { cert: Buffer; key: Buffer }
  /** A key that does not belong to host.cert. */
  strayKey: Buffer
}

function run(dir: string, args: string[]): void {
  execFileSync(OPENSSL, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
}

/** One chain in `dir` (which must exist and be private to the test). */
export function makeChain(dir: string, kind: ChainKind): Chain {
  const subject = (cn: string): string => (kind === 'empty' ? '/' : `/CN=${cn}`)
  const file = (name: string): string => path.join(dir, `${kind}-${name}`)
  run(dir, ['genrsa', '-out', file('root.key'), '2048'])
  run(dir, [
    'req',
    '-new',
    '-x509',
    '-sha1',
    '-key',
    file('root.key'),
    '-subj',
    subject('Root'),
    '-days',
    '3650',
    '-out',
    file('root.pem'),
  ])
  let serial = 2
  for (const leaf of ['host', 'device']) {
    run(dir, ['genrsa', '-out', file(`${leaf}.key`), '2048'])
    run(dir, [
      'req',
      '-new',
      '-key',
      file(`${leaf}.key`),
      '-subj',
      subject(leaf === 'host' ? 'Host' : 'Device'),
      '-out',
      file(`${leaf}.csr`),
    ])
    run(dir, [
      'x509',
      '-req',
      '-sha1',
      '-in',
      file(`${leaf}.csr`),
      '-CA',
      file('root.pem'),
      '-CAkey',
      file('root.key'),
      '-set_serial',
      String(serial++),
      '-days',
      '3650',
      '-out',
      file(`${leaf}.pem`),
    ])
  }
  run(dir, ['genrsa', '-out', file('stray.key'), '2048'])
  const read = (name: string): Buffer => readFileSync(file(name))
  return {
    kind,
    root: { cert: read('root.pem'), key: read('root.key') },
    host: { cert: read('host.pem'), key: read('host.key') },
    device: { cert: read('device.pem'), key: read('device.key') },
    strayKey: read('stray.key'),
  }
}

/**
 * A pair record as usbmuxd stores it, including the fields the helper must drop on arrival
 * (the root private key, the escrow bag, the Wi-Fi MAC).
 */
export function pairRecordPlist(
  chain: Chain,
  patch: Partial<Record<string, PlistInput>> = {},
): Record<string, PlistInput> {
  const record: Record<string, PlistInput> = {
    DeviceCertificate: chain.device.cert,
    EscrowBag: Buffer.alloc(32, 7),
    HostCertificate: chain.host.cert,
    HostID: randomUUID().toUpperCase(),
    HostPrivateKey: chain.host.key,
    RootCertificate: chain.root.cert,
    RootPrivateKey: chain.root.key,
    SystemBUID: randomUUID().toUpperCase(),
    WiFiMACAddress: 'aa:bb:cc:dd:ee:ff',
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) record[key] = value
  }
  return record
}

/** The same record as the helper holds it, for the lockdown client tests. */
export function pairRecord(chain: Chain, patch: Partial<PairRecord> = {}): PairRecord {
  return {
    HostID: randomUUID().toUpperCase(),
    SystemBUID: randomUUID().toUpperCase(),
    HostCertificate: chain.host.cert,
    HostPrivateKey: chain.host.key,
    DeviceCertificate: chain.device.cert,
    RootCertificate: chain.root.cert,
    ...patch,
  }
}
