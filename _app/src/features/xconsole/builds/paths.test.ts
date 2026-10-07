import { describe, expect, it } from 'vitest'

import {
  FILE_NAME_PATTERN,
  MAX_BUILD_BYTES,
  RELEASE_MAX_BYTES,
  RELEASE_TAG_PATTERN,
  binaryFileName,
  binaryUrl,
  buildFiles,
  buildUrl,
  itmsUrl,
  manifestUrl,
  needsRelease,
  releaseDownloadUrl,
  releaseTag,
} from './paths'

describe('binaryFileName', () => {
  it('names the binary after the app and its version, for a tester’s Downloads', () => {
    expect(binaryFileName('My App', '1.2.0', '45', 'android')).toBe('my-app-1.2.0-45.apk')
    expect(binaryFileName('Cải Lương Nam Bộ', '2.0', '7', 'ios')).toBe('cai-luong-nam-bo-2.0-7.ipa')
    expect(binaryFileName('Đố vui', '1', '1', 'android')).toBe('do-vui-1-1.apk')
  })

  it('never starts with a character Jekyll would drop, and always has a name', () => {
    expect(binaryFileName('_hidden', '.1', '', 'android')).toBe('hidden-1.apk')
    expect(binaryFileName('😀', '', '', 'ios')).toBe('app.ipa')
    expect(binaryFileName('', '', '', 'android')).toBe('app.apk')
  })

  it('stays short and inside the pattern it is checked against', () => {
    const long = binaryFileName('x'.repeat(200), '1.0.0-beta+build.5', '123456789', 'ios')
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long).toMatch(FILE_NAME_PATTERN)
    for (const name of [
      binaryFileName('A/B\\C<script>', '1', '2', 'android'),
      binaryFileName('Tom & Jerry', 'v1 (beta)', '3', 'ios'),
    ]) {
      expect(name, name).toMatch(FILE_NAME_PATTERN)
    }
  })
})

describe('addresses', () => {
  it('links the page with its slash, and the manifest on the live site', () => {
    expect(buildUrl('k3x9q2mf')).toBe('https://bauloc.github.io/build/k3x9q2mf/')
    expect(buildUrl('k3x9q2mf', 'http://localhost:7360')).toBe(
      'http://localhost:7360/build/k3x9q2mf/',
    )
    expect(manifestUrl('k3x9q2mf')).toBe('https://bauloc.github.io/build/k3x9q2mf/manifest.plist')
    expect(itmsUrl('k3x9q2mf')).toBe(
      'itms-services://?action=download-manifest&url=https://bauloc.github.io/build/k3x9q2mf/manifest.plist',
    )
  })

  it('lists every file a build owns', () => {
    expect(buildFiles({ id: 'a', platform: 'ios', file: 'x-1-1.ipa', icon: 'icon.png' })).toEqual([
      'build/a/index.html',
      'build/a/x-1-1.ipa',
      'build/a/icon.png',
      'build/a/manifest.plist',
    ])
    expect(buildFiles({ id: 'b', platform: 'android', file: 'y.apk', icon: '' })).toEqual([
      'build/b/index.html',
      'build/b/y.apk',
    ])
  })
})

describe('a binary of 100 MiB or more', () => {
  const RELEASE = { id: 4242, tag: 'build-k3x9q2mf-20261007081530', asset_id: 777 }

  it('goes to a release from GitHub’s file limit up, up to its asset limit', () => {
    expect(needsRelease(MAX_BUILD_BYTES - 1)).toBe(false)
    expect(needsRelease(MAX_BUILD_BYTES)).toBe(true)
    expect(RELEASE_MAX_BYTES).toBe(2_147_483_647)
  })

  it('is tagged with its link and the time in UTC, as the index checks it', () => {
    const tag = releaseTag('k3x9q2mf', new Date('2026-10-07T08:15:30.123Z'))
    expect(tag).toBe('build-k3x9q2mf-20261007081530')
    expect(tag).toMatch(RELEASE_TAG_PATTERN)
    expect(releaseTag('my-app', new Date('2026-01-02T03:04:05Z'))).toBe(
      'build-my-app-20260102030405',
    )
    for (const bad of [
      'build-k3x9q2mf',
      'build-k3x9q2mf-2026100708153',
      'build--x-20261007081530',
      'build-K3X9-20261007081530',
      'build-a/b-20261007081530',
      'v1.0',
      'build-k3x9q2mf-20261007081530/x',
    ]) {
      expect(bad, bad).not.toMatch(RELEASE_TAG_PATTERN)
    }
  })

  it('downloads from the release, absolutely, wherever the page is', () => {
    expect(releaseDownloadUrl(RELEASE.tag, 'app-1.0-1.apk')).toBe(
      'https://github.com/bauloc/bauloc.github.io/releases/download/build-k3x9q2mf-20261007081530/app-1.0-1.apk',
    )
    const entry = { id: 'k3x9q2mf', file: 'app-1.0-1.apk', release: RELEASE }
    expect(binaryUrl(entry)).toBe(releaseDownloadUrl(RELEASE.tag, 'app-1.0-1.apk'))
    expect(binaryUrl(entry, '')).toBe(releaseDownloadUrl(RELEASE.tag, 'app-1.0-1.apk'))
  })

  it('downloads from the repo otherwise, on the origin asked for', () => {
    const entry = { id: 'k3x9q2mf', file: 'app-1.0-1.apk', release: null }
    expect(binaryUrl(entry)).toBe('https://bauloc.github.io/build/k3x9q2mf/app-1.0-1.apk')
    expect(binaryUrl(entry, '')).toBe('/build/k3x9q2mf/app-1.0-1.apk')
    expect(binaryUrl(entry, 'http://localhost:7360')).toBe(
      'http://localhost:7360/build/k3x9q2mf/app-1.0-1.apk',
    )
  })

  it('keeps a hand-edited id, file or tag from pointing anywhere else', () => {
    expect(binaryUrl({ id: '../x', file: '../index.html', release: null }, '')).toBe(
      '/build/..%2Fx/..%2Findex.html',
    )
    expect(
      binaryUrl({ id: 'a', file: 'a.apk', release: { ...RELEASE, tag: '../../evil?x=1#' } }),
    ).toBe(
      'https://github.com/bauloc/bauloc.github.io/releases/download/..%2F..%2Fevil%3Fx%3D1%23/a.apk',
    )
  })

  it('is not one of the files the build has in the repo', () => {
    expect(
      buildFiles({
        id: 'a',
        platform: 'ios',
        file: 'x-1-1.ipa',
        icon: 'icon.png',
        release: RELEASE,
      }),
    ).toEqual(['build/a/index.html', 'build/a/icon.png', 'build/a/manifest.plist'])
    expect(
      buildFiles({ id: 'b', platform: 'android', file: 'y.apk', icon: '', release: null }),
    ).toEqual(['build/b/index.html', 'build/b/y.apk'])
  })
})
