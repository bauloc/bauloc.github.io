import type { Tone } from '../model'
import type { BrowserName, CheckGroup, CheckId, CheckStatus, Fix } from './types'

/*
  Every word the checklist shows. The sentences are the plan's (PLAN §3.2–3.4), kept as
  written so one pasted into a ticket can be found here; the few the plan left open are
  written in the same voice: what is true, then what to do. checks.ts decides which sentence
  applies; this file only says it.
*/

/** Every status is a word next to its dot; colour is never shown alone. */
export const STATUS_META: Readonly<Record<CheckStatus, { tone: Tone; label: string }>> = {
  ok: { tone: 'ok', label: 'OK' },
  warning: { tone: 'warn', label: 'Warning' },
  blocking: { tone: 'bad', label: 'Blocking' },
  unchecked: { tone: 'off', label: 'Not checked' },
}

/** Section titles; the phone's becomes "Phone: Pixel 9" when there is one. */
export const GROUP_TITLES: Readonly<Record<CheckGroup, string>> = {
  browser: 'This browser',
  phone: 'Phone',
  helper: 'Helper',
  feature: 'Features',
}

export const LABELS: Readonly<Record<CheckId, string>> = {
  'browser.secure': 'Secure page',
  'browser.webusb': 'WebUSB',
  'app.current': 'Device Lab version',
  'phone.usbDebugging': 'USB debugging',
  'phone.cable': 'Data cable',
  'phone.permission': 'Phone allowed in the browser',
  'phone.authorized': 'Allowed on the phone',
  'phone.notHeld': 'No other program has the phone',
  'phone.osAccess': 'System access to USB',
  'helper.running': 'Device Lab helper',
  'helper.lna': 'Browser may reach the helper',
  'helper.paired': 'Paired with the helper',
  'helper.version': 'Helper version',
  'helper.adbServer': 'adb server',
  'aab.java': 'Java 11 or newer',
  'aab.bundletool': 'bundletool',
  'aab.key': 'Signing key',
  'aab.build': 'APKs from the .aab',
  'aab.manual': 'Build the .apks yourself',
  'install.android': 'Android 7.0 or newer',
  'install.oem': 'Installs over USB allowed',
  'install.verify': 'Play Protect',
  'install.unzip': 'Unpack .xapk and .apkm',
  'install.apkmEncrypted': 'Unencrypted .apkm',
  'images.mediastore': 'Image list',
  'images.heic': 'Image preview',
}

/** How a sentence names the browser: "Chrome may use Pixel 9." */
export const BROWSER_NAMES: Readonly<Record<BrowserName, string>> = {
  chrome: 'Chrome',
  edge: 'Edge',
  opera: 'Opera',
  firefox: 'Firefox',
  safari: 'Safari',
  other: 'This browser',
}

export const LINKS = {
  securePage: 'https://bauloc.github.io/device/',
  chrome: 'https://www.google.com/chrome/',
  devOptions: 'https://developer.android.com/studio/debug/dev-options',
  winUsb: 'https://developer.android.com/studio/run/win-usb',
  java: 'https://adoptium.net/',
  helperPage: 'http://127.0.0.1:8787/device/',
  helperDownload: 'https://bauloc.github.io/device/agent/device-bridge.mjs',
} as const

/**
 * The fixes that never change. One that is the way out wherever it appears is primary here;
 * checks.ts promotes the others in the rows where they come first.
 */
export const FIX = {
  openSecure: { label: 'Open the secure page', href: LINKS.securePage, primary: true },
  getChrome: { label: 'Get Chrome', href: LINKS.chrome },
  reload: { label: 'Reload', action: 'reload', primary: true },
  developerOptions: {
    label: 'Turn on Developer options',
    path: 'Settings → About phone → tap Build number 7 times (Samsung: About phone → Software information → Build number)',
  },
  usbDebugging: {
    label: 'Turn on USB debugging',
    path: 'Settings → System → Developer options → USB debugging (some phones: System → Advanced)',
  },
  devOptionsGuide: { label: 'Read Android’s guide', href: LINKS.devOptions },
  addDevice: { label: 'Add device', action: 'add-device' },
  findPhone: { label: 'Find my phone…', action: 'find-phone' },
  retry: { label: 'Retry', action: 'retry' },
  revoke: {
    label: 'Revoke authorizations',
    path: 'Settings → System → Developer options → Revoke USB debugging authorizations',
  },
  killServer: { label: 'Copy “adb kill-server”', copy: 'adb kill-server' },
  reconnect: { label: 'Reconnect', action: 'retry' },
  releaseOtherTab: { label: 'Ask the other tab to let go', action: 'release-other-tab' },
  // The udev rules ship in a different package on each distribution; one per family a tester
  // is likely to run, each named, so nobody pastes apt-get into Fedora.
  udevRules: {
    label: 'Copy udev rules: Debian/Ubuntu',
    copy: 'sudo apt-get install android-sdk-platform-tools-common',
  },
  udevFedora: { label: 'Copy udev rules: Fedora', copy: 'sudo dnf install android-tools' },
  udevArch: { label: 'Copy udev rules: Arch', copy: 'sudo pacman -S android-udev' },
  plugdev: { label: 'Copy the plugdev command', copy: 'sudo usermod -aG plugdev $LOGNAME' },
  // Snap's confinement refuses USB to Chromium (Ubuntu's default) whatever udev allows.
  snapUsb: { label: 'Copy the snap Chromium command', copy: 'sudo snap connect chromium:raw-usb' },
  winUsb: { label: 'Get Google’s USB driver', href: LINKS.winUsb },
  // A maker's driver (Samsung's, say) on the ADB interface keeps the browser out; WinUSB lets it in.
  winUsbSwitch: {
    label: 'Switch the ADB interface to WinUSB',
    path: 'Device Manager → the phone’s “ADB Interface” (under Universal Serial Bus devices, Android Device or Portable Devices) → Update driver → Browse my computer for drivers → Let me pick → “Android ADB Interface” or “WinUSB Device”',
  },
  startHelper: { label: 'Copy the start command', copy: 'node device-bridge.mjs' },
  checkHelper: { label: 'Check again', action: 'check-helper', primary: true },
  lnaChromium: {
    label: 'Allow it again',
    path: 'Site controls (left of the address) → Site settings → Apps on device → Allow',
  },
  lnaFirefox: {
    label: 'Allow it again',
    path: 'Settings → Privacy & Security → Device apps and services',
  },
  helperPage: { label: 'Open the helper’s page', href: LINKS.helperPage, primary: true },
  pair: { label: 'Pair…', action: 'pair-helper', primary: true },
  helperDownload: { label: 'Download the helper', href: LINKS.helperDownload },
  java: { label: 'Get Java (Temurin 21 LTS)', href: LINKS.java },
  brewJava: { label: 'Copy “brew install --cask temurin”', copy: 'brew install --cask temurin' },
  downloadBundletool: { label: 'Download now', action: 'get-bundletool' },
  brewBundletool: { label: 'Copy “brew install bundletool”', copy: 'brew install bundletool' },
  createKey: { label: 'Create key', action: 'create-key', primary: true },
  xiaomiUsbInstall: {
    label: 'Allow installs over USB',
    path: 'Settings → Additional settings → Developer options → Install via USB (needs a Mi account)',
  },
  retryImages: { label: 'Retry', action: 'retry-images' },
  saveImage: { label: 'Save', action: 'save-image', primary: true },
} satisfies Record<string, Fix>

/** "Copy this page's link", for a page embedded where USB is blocked. */
export function copyLinkFix(href: string): Fix {
  return { label: 'Copy this page’s link', copy: href, primary: true }
}

/** Chrome's site settings for this page, as an address to paste (edge://, opera:// alike). */
export function siteSettingsFix(scheme: 'chrome' | 'edge' | 'opera'): Fix {
  return {
    label: 'Copy the settings address',
    copy: `${scheme}://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io`,
  }
}

export function bundletoolFix(command: string): Fix {
  return { label: 'Copy the bundletool command', copy: command, primary: true }
}

/** A name a terminal takes as one argument: bare when plain, double-quoted when that is safe. */
function terminalArg(name: string): string | null {
  if (/^[\w.+-]+$/.test(name)) return name
  // Double quotes keep spaces together in sh, zsh, PowerShell and cmd alike; these characters
  // would still be interpreted inside them by one shell or another.
  if (/["$`\\!%\n]/.test(name)) return null
  return `"${name}"`
}

/**
 * The manual .aab fallback (PLAN §3.3), for a terminal on this computer — not the phone's
 * shell. Uses the tester's own file name when a terminal can take it as it is.
 */
export function bundletoolCommand(fileName?: string): string {
  const aab = fileName && /\.aab$/i.test(fileName) ? fileName : null
  const bundle = aab === null ? null : terminalArg(aab)
  const output = aab === null ? null : terminalArg(aab.replace(/\.aab$/i, '.apks'))
  return bundle && output
    ? `bundletool build-apks --bundle=${bundle} --output=${output} --mode=universal`
    : 'bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal'
}

/** The sentences, by check. Functions fill in what the check knows. */
export const COPY = {
  secure: {
    ok: 'Opened over HTTPS.',
    okLocal: 'Opened on this computer (localhost), which counts as secure.',
    blocking:
      'USB access only works on https:// pages or on localhost. This page was opened over plain http.',
  },
  webusb: {
    ok: 'This browser can talk to Android phones over USB.',
    missing: 'This browser can’t talk to USB devices. Use Chrome, Edge or Opera on a computer.',
    policy: 'The page that embeds Device Lab blocks USB. Open Device Lab in its own tab.',
    unchecked: 'Can’t check until the page is on HTTPS.',
  },
  app: {
    ok: (version: string) => `This tab runs Device Lab ${version}.`,
    updated: 'Device Lab was updated while this tab was open. Reload to continue.',
  },
  /** For any phone row that needs a connection Device Lab doesn't have yet. */
  notConnected: 'Checked once Device Lab connects to the phone.',
  usbDebugging: {
    ok: 'USB debugging is on.',
    unchecked: 'Turn it on once per phone.',
    off: (name: string) => `${name} is plugged in, but USB debugging is off.`,
    notAndroid: 'That device has no Android debugging interface. Pick your phone.',
    picked: (name: string, sure: boolean) =>
      sure
        ? `You picked ${name}.`
        : `You picked ${name}. If it is your phone, turn on USB debugging, then pick it again.`,
    notListed:
      'The computer doesn’t see the phone. Try another cable or port (some cables only charge), unlock the phone, and check USB debugging.',
    bootloader: (name: string) =>
      `${name} is in fastboot mode. Restart it into Android, then add it again.`,
  },
  cable: {
    ok: 'The phone is on a cable that carries data.',
    unchecked: 'Use a cable that carries data. Some cables only charge.',
  },
  permission: {
    ok: (browser: string, name: string) => `${browser} may use ${name}.`,
    none: 'No phone allowed yet. Click Add device and pick your phone in the browser’s list.',
    dismissed:
      'No phone was picked. If yours wasn’t in the list, check USB debugging and the cable.',
  },
  authorized: {
    ok: 'This computer is allowed.',
    first: 'When the phone asks “Allow USB debugging?”, tap Allow.',
    waiting:
      'Unlock the phone and tap Allow on “Allow USB debugging?”. Tick “Always allow from this computer” so it stops asking.',
    stuck:
      'No prompt on the phone? Unplug and replug the cable. Still nothing: Developer options → Revoke USB debugging authorizations, then reconnect.',
    newKey: 'Clearing this site’s data makes a new key, so the phone asks again.',
  },
  notHeld: {
    ok: 'Device Lab has the phone’s debugging connection.',
    held: 'Another program is using the phone’s debugging connection: usually Google’s adb server (Android Studio, Flutter, scrcpy, a terminal), another browser tab, or chrome://inspect with “Discover USB devices” on.',
    otherTab: (name: string) => `Another Device Lab tab in this browser has ${name}.`,
    adb: (pid: number, name: string) => `The adb server (pid ${String(pid)}) has ${name}.`,
    browser: (process: string, pid: number, name: string) =>
      `${process} (pid ${String(pid)}) has ${name}, probably another tab.`,
    other: (process: string, pid: number, name: string) =>
      `${process} (pid ${String(pid)}) has ${name}. Quit it, then reconnect.`,
    /**
     * Windows: Chrome only finds out who owns the ADB interface when it claims it, so "unable
     * to claim" there is either a running adb or a maker's driver, and nothing tells them apart.
     */
    heldWindows:
      'Something else has the phone’s debugging connection: usually Google’s adb server (Android Studio, Flutter, scrcpy, a terminal) or another browser tab. No adb running? Then a phone maker’s USB driver probably owns the phone’s ADB interface: switch it to WinUSB.',
    osDenied: 'Can’t check until the system lets the browser open the phone.',
  },
  osAccess: {
    ok: 'The system lets this browser open the phone.',
    unchecked: 'Checked once Device Lab opens the phone.',
    linux:
      'Linux must allow the browser to open the phone. Install the Android udev rules for your distribution, then unplug and replug.',
    linuxDetail:
      'On Debian or Ubuntu, also run the plugdev command, then log out and back in. Chromium installed as a snap needs USB access too: run the snap command, then restart Chromium.',
    windows:
      'A phone maker’s USB driver may be blocking the browser. Switch the phone’s ADB interface to WinUSB in Device Manager, or install Google’s USB driver.',
    windowsDetail:
      'A running adb server can cause this too: quit it with “adb kill-server”, then reconnect.',
    other:
      'The system didn’t let the browser open the phone. Unplug and replug it, then reconnect.',
  },
  helper: {
    /** P1: the helper isn't built yet (decision 3). */
    coming: 'Coming with the Device Lab helper.',
    waitAnswer: 'Checked once the helper answers.',
    waitPairing: 'Checked once this page is paired with the helper.',
  },
  running: {
    ok: (version: string) => `Helper ${version} is running on this computer.`,
    down: 'The helper isn’t running. Start it in Terminal, then press Check again.',
    node: 'Needs Node.js 18 or newer.',
    blocked: 'Can’t tell while the browser blocks this page from reaching the helper.',
  },
  lna: {
    ok: 'This page may reach apps on this computer.',
    prompt: (browser: string) =>
      `${browser} will ask once to let this page reach apps on this computer. Choose Allow.`,
    denied: (browser: string) => `${browser} blocks this page from reaching the helper.`,
    safari: 'Safari can’t reach the helper from this page. Open the helper’s own page.',
    unsupported: 'This browser doesn’t report this permission.',
  },
  paired: {
    ok: 'This page is paired with the helper.',
    none: 'Pair this page with the helper using the link it printed (…#pair=…).',
    stale:
      'The helper has restarted since this page was paired. Pair again using the link it printed (…#pair=…).',
  },
  version: {
    ok: (version: string) => `Helper ${version} can build APKs from an .aab.`,
    old: 'This helper is too old for .aab installs. Download the latest one and restart it.',
  },
  java: {
    ok: (version: string, vendor?: string) =>
      vendor ? `Java ${version} (${vendor}).` : `Java ${version}.`,
    missing: 'Building APKs from an .aab needs Java, and none was found.',
    old: (version: string) => `Java ${version} is too old. bundletool needs 11 or newer.`,
    unreadable:
      'The helper found Java but couldn’t read its version. bundletool needs 11 or newer.',
  },
  bundletool: {
    ok: (version: string) => `bundletool ${version}.`,
    missing:
      'The helper will download bundletool 1.18.3 (32.5 MB, checksum-checked) the first time you install an .aab.',
  },
  key: {
    ok: 'APKs are signed with this computer’s debug key.',
    missing: 'There’s no debug signing key on this computer. The helper can create one.',
    play: 'A build signed here can’t update a copy installed from Google Play.',
  },
  adbServer: {
    ok: 'No adb server is running.',
    running:
      'An adb server is running on this computer. It can take the phone away from the browser.',
    holds: (names: string) => `The adb server on this computer has ${names}.`,
  },
  aab: {
    build: 'Browsers can’t install an .aab directly: bundletool has to build APKs from it first.',
    manual: 'No helper? Build an .apks yourself and drop it here:',
    manualDetail:
      'Needs Java 11 or newer, bundletool, and the debug key Android Studio creates (~/.android/debug.keystore). A build signed with it can’t update a copy installed from Google Play.',
  },
  install: {
    /** `running`: "Android 17", or "API 37" when the release can't be read. */
    ok: (running: string) => `${running} supports installs over USB.`,
    old: (running: string) => `Installing needs Android 7.0 or newer. This phone runs ${running}.`,
    unchecked: 'Checked once the phone is connected.',
    xiaomi: 'Xiaomi, Redmi and POCO phones refuse installs over USB until you allow them.',
    restricted:
      'The phone blocks installs over USB. Look for a setting that allows them in Developer options, or ask whoever manages the phone.',
    verifyOff: '“Verify apps over USB” is off on this phone.',
    verify:
      'Play Protect may scan the app and ask on the phone. Keep the phone unlocked and watch its screen.',
  },
  unzip: {
    ok: 'This browser can unpack .xapk and .apkm files.',
    missing:
      'This browser can’t unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer).',
    unchecked: 'Checked when the file is opened.',
  },
  apkm: {
    ok: 'This .apkm isn’t encrypted.',
    encrypted:
      'This .apkm is encrypted (an old APKMirror format). Download it again from APKMirror.',
  },
  images: {
    ok: 'Android listed the images.',
    loading: 'Checked when the images load.',
    failed: (line: string) =>
      line ? `Android didn’t list the images: ${line}.` : 'Android didn’t list the images.',
    fallback: 'Showing folders only (Screenshots, Camera, Download). Dates are file times.',
    heic: (browser: string) =>
      `${browser} can’t show HEIC images. Save it to open it on this computer.`,
  },
} as const
