import { describe, expect, it } from 'vitest'

import {
  actionMessages,
  argbCss,
  avatarTone,
  badgeView,
  canStartExport,
  canUninstall,
  confirmCopy,
  exportNote,
  exportPercent,
  exportShortText,
  exportText,
  fmtVersion,
  initials,
  releaseBadgeView,
} from './app-sheet'

describe('names and wording', () => {
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

  it('words an export from listing the APKs to packing them', () => {
    expect(exportText({ phase: 'reading', received: 0, total: null, files: 0 })).toBe(
      'Finding the APK files…',
    )
    expect(exportText({ phase: 'pulling', received: 512, total: null, files: 1 })).toBe(
      'Exporting 512 B…',
    )
    expect(
      exportText({ phase: 'pulling', received: 1024 * 1024, total: 4 * 1024 * 1024, files: 3 }),
    ).toBe('Exporting 1.0 MB of 4.0 MB (3 APKs) · 25%')
    expect(exportText({ phase: 'packing', received: 0, total: null, files: 3 })).toBe(
      'Packing 3 APKs into an .xapk…',
    )
    expect(exportText({ phase: 'packing', received: 3, total: 4, files: 3 })).toBe(
      'Packing 3 APKs into an .xapk · 75%',
    )
  })

  it('words it shorter for a row, the percentage first', () => {
    expect(
      exportShortText({
        phase: 'pulling',
        received: 1024 * 1024,
        total: 4 * 1024 * 1024,
        files: 3,
      }),
    ).toBe('Exporting · 25% of 4.0 MB')
    expect(exportShortText({ phase: 'pulling', received: 512, total: null, files: 1 })).toBe(
      'Exporting · 512 B',
    )
    expect(exportShortText({ phase: 'packing', received: 0, total: null, files: 3 })).toBe(
      'Packing the .xapk…',
    )
    expect(exportShortText({ phase: 'packing', received: 1, total: 4, files: 3 })).toBe(
      'Packing the .xapk · 25%',
    )
  })

  it('measures an export only once its size is known', () => {
    expect(exportPercent({ phase: 'reading', received: 0, total: null, files: 0 })).toBeNull()
    expect(exportPercent({ phase: 'pulling', received: 5, total: null, files: 1 })).toBeNull()
    expect(exportPercent({ phase: 'pulling', received: 999, total: 1000, files: 1 })).toBe(99)
    expect(exportPercent({ phase: 'pulling', received: 2000, total: 1000, files: 1 })).toBe(100)
  })

  it('starts packing from 0, so a long checksum never shows as a full bar', () => {
    expect(exportPercent({ phase: 'packing', received: 0, total: null, files: 2 })).toBeNull()
    expect(exportPercent({ phase: 'packing', received: 0, total: 1000, files: 2 })).toBe(0)
    expect(exportPercent({ phase: 'packing', received: 400, total: 1000, files: 2 })).toBe(40)
    expect(exportPercent({ phase: 'packing', received: 1000, total: 1000, files: 2 })).toBe(100)
  })

  it('says what the export saves once the APKs are listed', () => {
    expect(exportNote(null)).toBeNull()
    expect(exportNote(0)).toBeNull()
    expect(exportNote(1)).toBe('Saves one .apk.')
    expect(exportNote(3)).toBe('Saves its 3 APKs as one .xapk.')
  })

  it('keeps an export and an uninstall of the same app apart; Clear data is not held back', () => {
    const pulling = { phase: 'pulling', received: 0, total: 10, files: 2 } as const
    expect(canUninstall(undefined, undefined)).toBe(true)
    expect(canUninstall(undefined, pulling)).toBe(false)
    expect(canUninstall('stop', undefined)).toBe(false)
    expect(canStartExport(undefined, undefined)).toBe(true)
    expect(canStartExport(undefined, pulling)).toBe(false)
    expect(canStartExport('uninstall', undefined)).toBe(false)
    // pm clear leaves the APKs alone, and a stop or launch doesn't touch them either.
    expect(canStartExport('clear', undefined)).toBe(true)
    expect(canStartExport('launch', undefined)).toBe(true)
  })
})

describe('badgeView', () => {
  it('keeps a bitmap icon’s bytes, for the .xapk an export writes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const view = badgeView({
      label: ' Shop ',
      icon: { kind: 'bitmap', mime: 'image/png', bytes: png },
    })
    expect(view.label).toBe('Shop')
    if (view.icon?.kind !== 'bitmap') throw new Error('bitmap expected')
    expect(view.icon.url).toMatch(/^blob:/)
    expect(view.icon.blob.type).toBe('image/png')
    expect(new Uint8Array(await view.icon.blob.arrayBuffer())).toEqual(png)
    releaseBadgeView(view)
  })
})
