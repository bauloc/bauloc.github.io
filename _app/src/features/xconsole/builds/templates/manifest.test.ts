// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { BuildEntry } from '../types'
import { IOS, RELEASE, everyText } from './__fixtures__/entries'
import { manifestPlist } from './manifest'

/** The manifest as iOS reads it: a plist whose values come back exactly as they went in. */
function read(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  const value = (dict: Element, key: string) => {
    const keys = [...dict.children].filter((c) => c.tagName === 'key')
    const found = keys.find((k) => k.textContent === key)
    return found?.nextElementSibling ?? null
  }
  const item = doc.querySelector('plist > dict > array > dict')!
  const assets = [...value(item, 'assets')!.children].map((dict) => ({
    kind: value(dict, 'kind')?.textContent,
    url: value(dict, 'url')?.textContent,
  }))
  const metadata = value(item, 'metadata')!
  const meta = Object.fromEntries(
    ['bundle-identifier', 'bundle-version', 'kind', 'platform-identifier', 'title'].map((key) => [
      key,
      value(metadata, key)?.textContent,
    ]),
  )
  return { assets, meta }
}

describe('manifestPlist', () => {
  it('points iOS at the IPA and the icon on the live site', () => {
    const xml = manifestPlist(IOS)
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC/)
    expect(read(xml)).toEqual({
      assets: [
        {
          kind: 'software-package',
          url: 'https://bauloc.github.io/build/pw7h2c4n/pl-wallet-1.8.0-112.ipa',
        },
        { kind: 'display-image', url: 'https://bauloc.github.io/build/pw7h2c4n/icon.png' },
        { kind: 'full-size-image', url: 'https://bauloc.github.io/build/pw7h2c4n/icon.png' },
      ],
      meta: {
        'bundle-identifier': 'vn.plsoft.wallet',
        'bundle-version': '1.8.0',
        kind: 'software',
        'platform-identifier': 'com.apple.platform.iphoneos',
        title: 'PL Wallet',
      },
    })
  })

  it('lists no image when the build has no icon', () => {
    expect(read(manifestPlist({ ...IOS, icon: '' })).assets).toEqual([
      {
        kind: 'software-package',
        url: 'https://bauloc.github.io/build/pw7h2c4n/pl-wallet-1.8.0-112.ipa',
      },
    ])
  })

  it('escapes every value, so a name like “Tom & Jerry’s <Pro>” stays a name', () => {
    for (const name of [`Tom & Jerry's "<Pro>"`, ']]></string></dict><dict><string>', '&amp;']) {
      const entry: BuildEntry = { ...IOS, name, bundle_id: `${name}.id`, version: name }
      const xml = manifestPlist(entry)
      const { meta } = read(xml)
      expect(meta.title).toBe(name)
      expect(meta['bundle-identifier']).toBe(`${name}.id`)
      expect(meta['bundle-version']).toBe(name)
    }
    expect(manifestPlist({ ...IOS, name: `Tom & Jerry's "<Pro>"` })).toContain(
      '<string>Tom &amp; Jerry&apos;s &quot;&lt;Pro&gt;&quot;</string>',
    )
  })

  it('keeps a hand-edited id or file name inside the build’s directory', () => {
    const hostile = everyText(IOS, '../<x> "y" & z')
    const { assets } = read(manifestPlist(hostile))
    expect(assets[0]!.url).toBe(
      'https://bauloc.github.io/build/..%2F%3Cx%3E%20%22y%22%20%26%20z/..%2F%3Cx%3E%20%22y%22%20%26%20z',
    )
    expect(assets[1]!.url).toBe(
      'https://bauloc.github.io/build/..%2F%3Cx%3E%20%22y%22%20%26%20z/icon.png',
    )
  })

  it('points iOS at a large IPA’s release on github.com, the icon still on the site', () => {
    const { assets } = read(manifestPlist({ ...IOS, release: RELEASE }))
    expect(assets).toEqual([
      {
        kind: 'software-package',
        url: `https://github.com/bauloc/bauloc.github.io/releases/download/${RELEASE.tag}/pl-wallet-1.8.0-112.ipa`,
      },
      { kind: 'display-image', url: 'https://bauloc.github.io/build/pw7h2c4n/icon.png' },
      { kind: 'full-size-image', url: 'https://bauloc.github.io/build/pw7h2c4n/icon.png' },
    ])
  })
})
