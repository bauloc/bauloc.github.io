import { describe, expect, it } from 'vitest'

import { openZip } from '../backends/archive/zip'
import {
  actionMessages,
  apkFileName,
  argbCss,
  avatarTone,
  confirmCopy,
  crc32,
  downloadName,
  downloadText,
  fmtVersion,
  initials,
  storedZip,
} from './app-sheet'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('crc32', () => {
  it('gives the standard check value', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('continues across pieces', () => {
    const whole = crc32(bytes('The quick brown fox jumps over the lazy dog'))
    expect(whole).toBe(0x414fa339)
    expect(crc32(bytes(' over the lazy dog'), crc32(bytes('The quick brown fox jumps')))).toBe(
      whole,
    )
  })
})

describe('storedZip', () => {
  it('writes a zip the archive reader opens, byte for byte, with the names kept', async () => {
    const base = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff)
    const split = bytes('split payload')
    const zip = await storedZip(
      [
        { name: 'base.apk', blob: new Blob([base]) },
        { name: 'split_config.xxhdpi.apk', blob: new Blob([split]) },
      ],
      new Date(2026, 9, 4, 11, 30, 10),
    )
    expect(zip.type).toBe('application/zip')
    expect(zip.size).toBe(30 * 2 + 46 * 2 + 22 + 2 * (8 + 23) + base.length + split.length)

    const archive = await openZip(zip)
    expect(archive.entries.map((e) => e.name)).toEqual(['base.apk', 'split_config.xxhdpi.apk'])
    const [first, second] = archive.entries
    if (!first || !second) throw new Error('entries missing')
    expect(await archive.bytes(first)).toEqual(base)
    expect(await archive.bytes(second)).toEqual(split)

    // The CRC in the central directory is the data's.
    const head = new DataView(await zip.arrayBuffer())
    expect(head.getUint32(14, true)).toBe(crc32(base))
  })

  it('writes an empty archive as just the end record', async () => {
    const zip = await storedZip([])
    expect(zip.size).toBe(22)
    expect((await openZip(zip)).entries).toEqual([])
  })
})

describe('names and wording', () => {
  it('takes the APK file name from a pm path', () => {
    expect(apkFileName('/data/app/~~ab==/com.example.shop-cd==/split_config.xxhdpi.apk')).toBe(
      'split_config.xxhdpi.apk',
    )
    expect(apkFileName('')).toBe('base.apk')
  })

  it('names downloads safely, .zip for split apps', () => {
    expect(downloadName('com.example.shop', '1.4.0', 1)).toBe('com.example.shop-1.4.0.apk')
    expect(downloadName('com.example.shop', '1.4 beta/2', 3)).toBe(
      'com.example.shop-1.4_beta_2.zip',
    )
    expect(downloadName('com.example.shop', '', 1)).toBe('com.example.shop.apk')
  })

  it('formats versions', () => {
    expect(fmtVersion('1.4.0', 812)).toBe('1.4.0 (812)')
    expect(fmtVersion(null, 812)).toBe('812')
    expect(fmtVersion('1.4.0', null)).toBe('1.4.0')
    expect(fmtVersion(undefined, null)).toBe('')
  })

  it('picks initials from a label, else from the package’s meaningful last segment', () => {
    expect(initials('Google Maps', 'com.google.android.apps.maps')).toBe('GM')
    expect(initials('  shop  ', 'com.example.shop')).toBe('S')
    expect(initials(null, 'com.example.shop.debug')).toBe('S')
    expect(initials(null, 'com.google.android.youtube')).toBe('Y')
    expect(initials(null, 'com.example.app')).toBe('E')
    expect(initials('', 'android')).toBe('A')
  })

  it('keeps an app’s avatar colour stable', () => {
    expect(avatarTone('com.example.shop')).toBe(avatarTone('com.example.shop'))
    expect(avatarTone('com.example.shop')).toMatch(/^bg-\w+-500\/15 /)
  })

  it('turns ARGB into a CSS colour with no hex literal', () => {
    expect(argbCss(0xff3ddc84)).toBe('rgb(61 220 132 / 1)')
    expect(argbCss(0x80000000)).toBe('rgb(0 0 0 / 0.502)')
  })

  it('says what each action did, naming the phone where it matters', () => {
    expect(actionMessages('uninstall', 'Shop', 'Pixel 9')).toEqual({
      done: 'Uninstalled Shop from Pixel 9.',
      failed: 'Couldn’t uninstall Shop',
    })
    expect(actionMessages('launch', 'Shop', 'Pixel 9').failed).toBe('Couldn’t open Shop')
    expect(actionMessages('stop', 'Shop', 'Pixel 9').done).toBe('Stopped Shop.')
  })

  it('confirmations name the app, its package, the phone and what is lost', () => {
    const uninstall = confirmCopy('uninstall', 'Shop', 'com.example.shop', 'Pixel 9')
    expect(uninstall.title).toBe('Uninstall Shop from Pixel 9?')
    expect(uninstall.body).toContain('Shop (com.example.shop)')
    expect(uninstall.body).toContain('It can’t be undone.')
    expect(uninstall.confirm).toBe('Uninstall')

    const clear = confirmCopy('clear', 'com.example.shop', 'com.example.shop', 'Pixel 9')
    expect(clear.title).toBe('Clear all data of com.example.shop on Pixel 9?')
    expect(clear.body).not.toContain('(com.example.shop)')
    expect(clear.body).toContain('The app stays installed.')
    expect(clear.confirm).toBe('Clear data')
  })

  it('words download progress with and without a known size', () => {
    expect(downloadText({ received: 512, total: null, files: 1 })).toBe('Downloading 512 B…')
    expect(downloadText({ received: 1024 * 1024, total: 4 * 1024 * 1024, files: 3 })).toBe(
      'Downloading 1.0 MB of 4.0 MB (3 APKs) · 25%',
    )
  })
})
