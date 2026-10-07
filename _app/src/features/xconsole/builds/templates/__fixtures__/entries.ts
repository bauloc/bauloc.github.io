import type { BuildEntry } from '../../types'

/*
  Builds as the index holds them, for the templates' tests: one of each platform with
  everything filled in, and a way to fill every text in an entry with the same value — which a
  hand-edited data/build/db.json could hold — to prove nothing reaches the page unescaped.
*/

export const ANDROID: BuildEntry = {
  id: 'k3x9q2mf',
  platform: 'android',
  name: 'Lịch Âm Việt',
  bundle_id: 'vn.plsoft.lichamviet',
  version: '2.4.1',
  build: '241',
  file: 'lich-am-viet-2.4.1-241.apk',
  size: 24537088,
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  icon: 'icon.png',
  min_os: '24',
  notes: '• Widgets refresh again\n• New: lunar holidays for 2027',
  android: { target_sdk: 35, debuggable: false, abis: ['arm64-v8a', 'armeabi-v7a'] },
  ios: null,
  release: null,
  uploaded_at: '2026-10-07T01:15:00.000Z',
  created_at: '2026-10-05T03:20:00.000Z',
  updated_at: '2026-10-07T01:15:00.000Z',
}

export const IOS: BuildEntry = {
  id: 'pw7h2c4n',
  platform: 'ios',
  name: 'PL Wallet',
  bundle_id: 'vn.plsoft.wallet',
  version: '1.8.0',
  build: '112',
  file: 'pl-wallet-1.8.0-112.ipa',
  size: 50541363,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  icon: 'icon.png',
  min_os: '15.0',
  notes: '',
  android: null,
  ios: {
    devices: ['iphone', 'ipad'],
    profile: {
      kind: 'ad-hoc',
      name: 'PL Wallet Ad Hoc',
      team: 'PLSOFT Co., Ltd',
      expires: '2027-03-14T08:00:00.000Z',
      device_count: 12,
    },
  },
  release: null,
  uploaded_at: '2026-10-07T02:40:00.000Z',
  created_at: '2026-10-06T10:02:00.000Z',
  updated_at: '2026-10-07T02:40:00.000Z',
}

/** A release a large build's binary went up to, as the console records it. */
export const RELEASE = { id: 182736455, tag: 'build-k3x9q2mf-20261007011500', asset_id: 9081726 }

/** `entry` with every text in it, nested ones and enum-typed ones included, set to `value`. */
export function everyText(entry: BuildEntry, value: string): BuildEntry {
  return {
    ...entry,
    id: value,
    name: value,
    bundle_id: value,
    version: value,
    build: value,
    file: value,
    sha256: value,
    icon: value,
    min_os: value,
    notes: value,
    uploaded_at: value,
    created_at: value,
    updated_at: value,
    android: entry.android && { ...entry.android, abis: [value, value] },
    ios: entry.ios && {
      devices: [value as 'iphone'],
      profile: entry.ios.profile && {
        ...entry.ios.profile,
        kind: value as 'ad-hoc',
        name: value,
        team: value,
        expires: value,
      },
    },
  }
}
