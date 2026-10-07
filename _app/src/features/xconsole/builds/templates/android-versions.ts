/*
  Android's API levels by the version names people know them by. An APK states its minimum and
  target as API levels (minSdkVersion 24); a tester checks their phone's Settings › About phone
  and finds "Android version 14". The install page says both.

  14 is where the table starts: Ice Cream Sandwich, the oldest level the AndroidX libraries ever
  supported. Levels below 21 are not history in a build's manifest — Flutter and React Native
  defaulted to minSdk 16 for years, and apps built then still declare it — so each is named.
  A level missing here (a new release, or one older than 14) is shown as the level alone.
*/

const VERSIONS: Readonly<Record<number, string>> = {
  14: '4.0',
  15: '4.0.3',
  16: '4.1',
  17: '4.2',
  18: '4.3',
  19: '4.4',
  20: '4.4W',
  21: '5.0',
  22: '5.1',
  23: '6.0',
  24: '7.0',
  25: '7.1',
  26: '8.0',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12L',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
}

/** An API level as written in a manifest or an index: digits only, or null. */
export function apiLevel(value: string | number): number | null {
  const text = String(value).trim()
  if (!/^\d{1,3}$/.test(text)) return null
  const level = Number(text)
  return level > 0 ? level : null
}

/** `24` → `Android 7.0 (API 24)`; `40` → `API 40`; '' for what is not an API level. */
export function androidRelease(value: string | number): string {
  const level = apiLevel(value)
  if (level === null) return ''
  const name = Object.hasOwn(VERSIONS, level) ? VERSIONS[level] : undefined
  return name ? `Android ${name} (API ${String(level)})` : `API ${String(level)}`
}
