import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { SITE } from '../../site'
import { qrSvg } from '../qr'
import type { BuildEntry } from '../types'
import { ANDROID, IOS, RELEASE, everyText } from './__fixtures__/entries'
import { installPageHtml, versionText } from './install-page'
import { INSTALL_SCRIPT, INSTALL_SCRIPT_SHA256 } from './install-script'

const QR = qrSvg('https://bauloc.github.io/build/k3x9q2mf/')
const page = (entry: BuildEntry) => installPageHtml(entry, { qrSvg: QR })

/** Every attribute value of `name` in the page, as written (still escaped). */
const attributes = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1] ?? '')

describe('the inline script', () => {
  it('is allowed by its hash, and the constant is that hash', () => {
    const hash = createHash('sha256').update(INSTALL_SCRIPT, 'utf8').digest('base64')
    // If this fails, the script changed: set INSTALL_SCRIPT_SHA256 to the value received.
    expect(INSTALL_SCRIPT_SHA256).toBe(hash)
    for (const entry of [ANDROID, IOS]) {
      expect(page(entry)).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'">`,
      )
    }
  })

  it('is the page’s only script, byte for byte the hashed one, and in <head>', () => {
    for (const entry of [ANDROID, IOS]) {
      const html = page(entry)
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      expect(scripts).toHaveLength(1)
      expect(scripts[0]![1]).toBe(INSTALL_SCRIPT)
      expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</head>'))
      // The policy is in force before anything from the entry is parsed.
      expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'))
    }
  })

  it('holds nothing of any build, and nothing that could end its element early', () => {
    for (const entry of [ANDROID, IOS]) {
      for (const value of [entry.id, entry.name, entry.bundle_id, entry.file, entry.sha256]) {
        expect(INSTALL_SCRIPT).not.toContain(value)
      }
    }
    expect(INSTALL_SCRIPT).toMatch(/^[\x20-\x7e\n]*$/)
    expect(INSTALL_SCRIPT).not.toMatch(/<\/script|<!--/i)
    expect(INSTALL_SCRIPT).not.toMatch(/=>|`|\b(?:let|const|class)\s/)
  })
})

describe('the install page', () => {
  it('stays out of search engines and declares both colour schemes', () => {
    const html = page(ANDROID)
    expect(html).toMatch(
      /^<!DOCTYPE html>\n<html lang="en" data-platform="android">\n<head>\n<meta charset="utf-8">/,
    )
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
  })

  it('names the build in its title and link previews, with absolute addresses on the live site', () => {
    const html = page(ANDROID)
    expect(html).toContain('<title>Lịch Âm Việt 2.4.1 (241)</title>')
    expect(html).toContain('<meta property="og:title" content="Lịch Âm Việt 2.4.1 (241)">')
    expect(html).toContain(`<meta property="og:url" content="${SITE}/build/k3x9q2mf/">`)
    expect(html).toContain(`<link rel="canonical" href="${SITE}/build/k3x9q2mf/">`)
    expect(html).toContain(`<meta property="og:image" content="${SITE}/build/k3x9q2mf/icon.png">`)
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).toContain('<link rel="icon" type="image/png" href="/build/k3x9q2mf/icon.png">')
    expect(html).toContain('<meta name="description" content="Android build · 23.4 MB')
  })

  it('describes the link in both languages, as plain text, for a chat app’s preview card', () => {
    const say = (platform: string, size: string) =>
      `${platform} build · ${size} · Open this link on your phone to install it · Mở link này trên điện thoại để cài đặt`
    for (const [entry, description] of [
      [ANDROID, say('Android', '23.4 MB')],
      [IOS, say('iOS', '48.2 MB')],
    ] as const) {
      const html = page(entry)
      expect(html).toContain(`<meta name="description" content="${description}">`)
      expect(html).toContain(`<meta property="og:description" content="${description}">`)
    }
  })

  it('offers an Android build as a download of the binary, root-relative', () => {
    const html = page(ANDROID)
    expect(html).toContain(
      '<a class="install" href="/build/k3x9q2mf/lich-am-viet-2.4.1-241.apk" download="lich-am-viet-2.4.1-241.apk">',
    )
    expect(html).not.toContain('itms-services')
  })

  it('installs an iOS build through itms-services and the manifest on the live site', () => {
    const html = page(IOS)
    expect(html).toContain(
      `<a class="install" href="itms-services://?action=download-manifest&amp;url=${SITE}/build/pw7h2c4n/manifest.plist">`,
    )
    expect(html).toContain(
      '<html lang="en" data-platform="ios" data-expires="2027-03-14T08:00:00.000Z">',
    )
    // A desk still gets the file itself, for Apple Configurator or Xcode.
    expect(html).toContain(
      '<a class="btn" href="/build/pw7h2c4n/pl-wallet-1.8.0-112.ipa" download="pl-wallet-1.8.0-112.ipa">',
    )
  })

  it('loads nothing from anywhere else', () => {
    for (const entry of [ANDROID, IOS, { ...ANDROID, icon: '' }]) {
      const html = page(entry)
      for (const url of [...attributes(html, 'src'), ...attributes(html, 'href')]) {
        expect(url, url).toMatch(/^(?:\/|#|https:\/\/bauloc\.github\.io\/|itms-services:\/\/)/)
      }
      for (const url of attributes(html, 'content').filter((c) => /:\/\//.test(c))) {
        expect(url, url).toMatch(/^https:\/\/bauloc\.github\.io\//)
      }
      expect(html).not.toMatch(/url\(|@import|<link rel="stylesheet"|<iframe|<object|<embed|<form/i)
      // The page's own resources are root-relative, so the dev server's copy works as well.
      for (const url of attributes(html, 'src')) expect(url).toMatch(/^\//)
    }
  })

  it('carries both languages, the Android installer’s words quoted as AOSP has them', () => {
    const html = page(ANDROID)
    expect(html).toContain(
      '<span class="en" lang="en">Install</span><span class="vi" lang="vi">Cài đặt</span>',
    )
    expect(html).toContain(
      '<span class="en" lang="en">Release notes</span><span class="vi" lang="vi">Ghi chú phát hành</span>',
    )
    expect(html).toContain(
      '“Để bảo mật, điện thoại của bạn hiện không được phép cài đặt các ứng dụng không xác định từ nguồn này”',
    )
    expect(html).toContain('bật <b>Cho phép từ nguồn này</b>')
    expect(html).toContain('“Chưa cài đặt được ứng dụng do gói xung đột với một gói hiện có”')
    expect(html).toContain(
      '“For your security, your phone currently isn’t allowed to install unknown apps from this source”',
    )
    expect(html).toContain('turn on <b>Allow from this source</b>')
    expect(html).toContain('“App not installed as package conflicts with an existing package”')
    expect(html).toContain(
      '<span class="en" lang="en">23.4 MB</span><span class="vi" lang="vi">23,4 MB</span>',
    )
  })

  it('embeds the QR code it is handed, and only an SVG', () => {
    expect(page(ANDROID)).toContain(`<div class="qr-tile">${QR}</div>`)
    const html = installPageHtml(ANDROID, { qrSvg: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<div class="qr-tile">')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('bauloc.github.io/build/k3x9q2mf/</code>')
  })

  it('writes each time as a <time> in UTC, for the script to put in the reader’s zone', () => {
    const html = page({ ...ANDROID, uploaded_at: '2026-10-07T08:15:00+07:00' })
    expect(html).toContain('<time datetime="2026-10-07T01:15:00.000Z">07-Oct-2026 01:15 UTC</time>')
    expect(page({ ...ANDROID, uploaded_at: '', created_at: 'yesterday' })).not.toContain('<time')
    // An edit of the name or notes moves updated_at, not the upload time the page shows.
    expect(page({ ...ANDROID, updated_at: '2030-01-01T00:00:00.000Z' })).not.toContain('2030')
  })

  it('shows release notes as typed, and no card without them', () => {
    expect(page(ANDROID)).toContain(
      '<p class="release">• Widgets refresh again\n• New: lunar holidays for 2027</p>',
    )
    expect(page(ANDROID)).toContain('id="notes-title"')
    expect(page(IOS)).not.toContain('class="release"')
    expect(page(IOS)).not.toContain('id="notes-title"')
  })

  it('lists an Android build’s facts, its API levels named', () => {
    const html = page(ANDROID)
    // Identifiers may wrap at their dots.
    expect(html).toContain('<dd><span class="mono">vn.<wbr>plsoft.<wbr>lichamviet</span></dd>')
    expect(html).toContain('<dd>Android 7.0 (API 24)</dd>')
    expect(html).toContain('<dd>Android 15 (API 35)</dd>')
    expect(html).toContain('<dd><span class="mono">arm64-v8a, armeabi-v7a</span></dd>')
    expect(html).toContain('<span class="mono">9f86d081…b0f00a08</span>')
    expect(html).toContain(`data-copy="${ANDROID.sha256}"`)
    const pure = page({ ...ANDROID, min_os: '', android: { ...ANDROID.android!, abis: [] } })
    expect(pure).not.toContain('<span class="en" lang="en">Requires</span>')
    expect(pure).toContain('<span class="en" lang="en">Any</span>')
  })

  it('lists an iOS build’s facts and the steps its profile asks for', () => {
    const html = page(IOS)
    expect(html).toContain('<dd>iOS 15.0</dd>')
    expect(html).toContain('<dd>iPhone, iPad</dd>')
    expect(html).toContain(
      '<dd>Ad Hoc · <span class="en" lang="en">12 devices</span><span class="vi" lang="vi">12 thiết bị</span></dd>',
    )
    expect(html).toContain('<dd>PLSOFT Co., Ltd</dd>')
    expect(html).toContain('<time datetime="2027-03-14T08:00:00.000Z" class="expires">')
    expect(html).toContain('Only the 12 registered devices can install it')
    expect(html).not.toContain('Developer Mode')

    const development = page({
      ...IOS,
      ios: {
        devices: ['iphone'],
        profile: { ...IOS.ios!.profile!, kind: 'development', device_count: 1 },
      },
    })
    expect(development).toContain('Privacy &amp; Security › Developer Mode')
    expect(development).toContain('Quyền riêng tư &amp; Bảo mật › Chế độ nhà phát triển')
    expect(development).toContain('Only the one registered device can install it')

    const enterprise = page({
      ...IOS,
      ios: {
        devices: ['iphone'],
        profile: { ...IOS.ios!.profile!, kind: 'enterprise', device_count: null },
      },
    })
    expect(enterprise).toContain(
      'VPN &amp; Device Management</b>, tap “PLSOFT Co., Ltd” and trust it.',
    )
    expect(enterprise).toContain(
      'Quản lý VPN &amp; thiết bị</b>, chạm “PLSOFT Co., Ltd” rồi chọn Tin cậy.',
    )
    expect(enterprise).not.toContain('registered device')
    expect(enterprise).toContain('<dd>Enterprise</dd>')

    const unsigned = page({ ...IOS, ios: { devices: [], profile: null } })
    expect(unsigned).toContain('<html lang="en" data-platform="ios">')
    expect(unsigned).not.toContain('class="note bad n-expired"')
    expect(html).toContain('class="note bad n-expired"')
  })

  it('draws the app’s initial when it has no icon', () => {
    const html = page({ ...ANDROID, icon: '', name: 'đố vui' })
    expect(html).toContain('<span class="initial" aria-hidden="true">Đ</span>')
    expect(html).not.toContain('icon.png')
  })
})

describe('what the index holds cannot break the page', () => {
  const HOSTILE = `"'><script>alert(1)</script><img src=x onerror=alert(2)>&amp;</p></dd>`

  for (const entry of [ANDROID, IOS]) {
    it(`escapes every text of an ${entry.platform} entry`, () => {
      const html = page(everyText(entry, HOSTILE))
      expect(html.match(/<script/g)).toHaveLength(1)
      expect(html.match(/<\/script>/g)).toHaveLength(1)
      expect(html).not.toContain('<img src=x')
      expect(html).not.toContain(`"'>`)
      expect(html).not.toMatch(/<\/p><\/dd>(?!<\/div>)/)
      expect(html).not.toMatch(/&amp;<\/p>/)
      // It is all there, as text.
      expect(html).toContain(
        "&quot;'&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&amp;amp;&lt;/p&gt;&lt;/dd&gt;",
      )
      // Addresses are encoded on top, so an id or a file name cannot leave the build's directory.
      for (const url of [...attributes(html, 'src'), ...attributes(html, 'href')]) {
        expect(url).not.toMatch(/[<>"]|\/\.\.\//)
      }
    })
  }

  it('keeps a hand-edited id or file name inside the build’s directory', () => {
    const html = page({ ...ANDROID, id: '../../xconsole', file: '../index.html' })
    expect(html).toContain('href="/build/..%2F..%2Fxconsole/..%2Findex.html"')
  })
})

describe('versionText', () => {
  it('says the build once, and only when it adds something', () => {
    expect(versionText('1.2.0', '45')).toBe('1.2.0 (45)')
    expect(versionText('3.0', '3.0')).toBe('3.0')
    expect(versionText('', '7')).toBe('7')
    expect(versionText(' 1.0 ', '')).toBe('1.0')
  })
})

describe('what the page leads with', () => {
  it('has no site header: the app, its version and the Install button come first', () => {
    const html = page(ANDROID)
    expect(html).not.toContain('<header')
    expect(html).not.toContain('bauloc@github.io')
    const body = html.slice(html.indexOf('<body>'))
    const order = ['id="app-name"', 'class="app-sub"', 'class="install"', 'class="scan"']
    const at = order.map((marker) => body.indexOf(marker))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The details come after the hero; the language and the theme sit in a row above the app.
    expect(body.indexOf('id="details-title"')).toBeGreaterThan(at[3]!)
    expect(body.indexOf('<div class="top">')).toBeGreaterThan(0)
    expect(body.indexOf('<div class="top">')).toBeLessThan(body.indexOf('id="app-name"'))
    expect(body).not.toContain('<footer')
  })

  it('keeps the QR code and the link in the hero for a desk, and for the other platform’s phone', () => {
    const html = page(IOS)
    const scan = html.slice(
      html.indexOf('<div class="scan"'),
      html.indexOf('</div>', html.indexOf('class="scan-actions"')),
    )
    expect(scan).toContain('<div class="qr-tile">')
    expect(scan).toContain('data-copy="https://bauloc.github.io/build/pw7h2c4n/"')
    expect(scan).toContain('download="pl-wallet-1.8.0-112.ipa"')
    expect(scan).toContain('scan the QR code with your iPhone or iPad')
  })
})

describe('a build whose binary is a GitHub Release’s asset (100 MB or more)', () => {
  const download = (file: string) =>
    `https://github.com/bauloc/bauloc.github.io/releases/download/${RELEASE.tag}/${file}`

  it('links Install and Download to the release, and changes nothing else', () => {
    const url = download(ANDROID.file)
    const html = page({ ...ANDROID, release: RELEASE })
    expect(html).toContain(
      `<a class="install" href="${url}" download="lich-am-viet-2.4.1-241.apk">`,
    )
    expect(html).toContain(`<a class="btn" href="${url}" download="lich-am-viet-2.4.1-241.apk">`)
    expect(html).not.toContain('href="/build/k3x9q2mf/lich-am-viet')
    // The QR code, the link previews, the icon and the layout are the repo build's, byte for byte.
    expect(html.replaceAll(url, `/build/k3x9q2mf/${ANDROID.file}`)).toBe(page(ANDROID))
  })

  it('still installs an iOS build through the manifest on the site, and downloads from the release', () => {
    const url = download(IOS.file)
    const html = page({ ...IOS, release: RELEASE })
    expect(html).toContain(
      `<a class="install" href="itms-services://?action=download-manifest&amp;url=${SITE}/build/pw7h2c4n/manifest.plist">`,
    )
    expect(html).toContain(`<a class="btn" href="${url}" download="pl-wallet-1.8.0-112.ipa">`)
    expect(html.replaceAll(url, `/build/pw7h2c4n/${IOS.file}`)).toBe(page(IOS))
  })

  it('loads nothing from github.com: it only links there', () => {
    for (const entry of [ANDROID, IOS]) {
      const html = page({ ...entry, release: RELEASE })
      for (const url of attributes(html, 'src')) expect(url).toMatch(/^\//)
      for (const url of attributes(html, 'href')) {
        expect(url, url).toMatch(
          /^(?:\/|#|https:\/\/bauloc\.github\.io\/|itms-services:\/\/|https:\/\/github\.com\/bauloc\/bauloc\.github\.io\/releases\/download\/)/,
        )
      }
      expect(html).not.toMatch(/<(?:img|script|link)\b[^>]*github\.com/)
    }
  })

  it('keeps a hand-edited tag inside the repo’s release downloads', () => {
    const html = page({ ...ANDROID, release: { ...RELEASE, tag: '../../../evil"><x' } })
    expect(html).toContain(
      'href="https://github.com/bauloc/bauloc.github.io/releases/download/..%2F..%2F..%2Fevil%22%3E%3Cx/lich-am-viet-2.4.1-241.apk"',
    )
  })
})
