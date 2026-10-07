import { localized } from '@/lib/i18n'

import type { GatedFeature } from '../helper/update'
import type { Tone } from '../model'
import type { BrowserName, CheckGroup, CheckStatus, Fix, FixedCheckId } from './types'

/*
  Every word the checklist shows. The sentences are the plan's (PLAN §3.2–3.4), kept as
  written so one pasted into a ticket can be found here; the few the plan left open are
  written in the same voice: what is true, then what to do. checks.ts decides which sentence
  applies; this file only says it.

  Each table holds both languages (`localized`), so checks.ts and the components read it as
  before and get the language on screen. The Vietnamese says the same things, and its settings
  paths use the names the phone, the TV or the computer shows in Vietnamese. Commands, links
  and action ids are the same in both.
*/

/** Every status is a word next to its dot; colour is never shown alone. */
export const STATUS_META = localized<Readonly<Record<CheckStatus, { tone: Tone; label: string }>>>({
  en: {
    ok: { tone: 'ok', label: 'OK' },
    warning: { tone: 'warn', label: 'Warning' },
    blocking: { tone: 'bad', label: 'Blocking' },
    unchecked: { tone: 'off', label: 'Not checked' },
  },
  vi: {
    ok: { tone: 'ok', label: 'OK' },
    warning: { tone: 'warn', label: 'Cảnh báo' },
    blocking: { tone: 'bad', label: 'Đang chặn' },
    unchecked: { tone: 'off', label: 'Chưa kiểm tra' },
  },
})

/** Section titles; the phone's becomes "Phone: Pixel 9" when there is one. */
export const GROUP_TITLES = localized<Readonly<Record<CheckGroup, string>>>({
  en: {
    browser: 'This browser',
    phone: 'Phone',
    helper: 'Helper',
    mac: 'This Mac',
    ios: 'iPhone tools',
    android: 'Android tools',
    device: 'Devices',
    wifi: 'Wi‑Fi devices',
    optional: 'Optional tools',
    feature: 'Features',
  },
  vi: {
    browser: 'Trình duyệt này',
    phone: 'Điện thoại',
    helper: 'Helper',
    mac: 'Máy Mac này',
    ios: 'Công cụ cho iPhone',
    android: 'Công cụ cho Android',
    device: 'Thiết bị',
    wifi: 'Thiết bị qua Wi‑Fi',
    optional: 'Công cụ không bắt buộc',
    feature: 'Tính năng',
  },
})

export const LABELS = localized<Readonly<Record<FixedCheckId, string>>>({
  en: {
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
    'helper.update': 'Published helper',
    'helper.adbServer': 'adb server',
    'mac.tools': 'This Mac’s tools',
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
    'wifi.helper': 'Local helper',
    'wifi.adbServer': 'Google’s adb server',
    'wifi.localNetwork': 'This computer reaches the local network',
    'wifi.reachable': 'Device answers on the network',
    'wifi.authorized': 'Allowed on the device',
  },
  vi: {
    'browser.secure': 'Trang bảo mật',
    'browser.webusb': 'WebUSB',
    'app.current': 'Phiên bản Device Lab',
    'phone.usbDebugging': 'Gỡ lỗi qua USB',
    'phone.cable': 'Cáp truyền dữ liệu',
    'phone.permission': 'Trình duyệt được phép dùng điện thoại',
    'phone.authorized': 'Điện thoại cho phép máy tính này',
    'phone.notHeld': 'Không chương trình nào khác giữ điện thoại',
    'phone.osAccess': 'Hệ thống cho phép truy cập USB',
    'helper.running': 'Helper của Device Lab',
    'helper.lna': 'Trình duyệt được phép kết nối với helper',
    'helper.paired': 'Đã ghép nối với helper',
    'helper.version': 'Phiên bản helper',
    'helper.update': 'Bản helper đã phát hành',
    'helper.adbServer': 'adb server',
    'mac.tools': 'Công cụ trên máy Mac này',
    'aab.java': 'Java 11 trở lên',
    'aab.bundletool': 'bundletool',
    'aab.key': 'Khóa ký',
    'aab.build': 'APK từ tệp .aab',
    'aab.manual': 'Tự dựng tệp .apks',
    'install.android': 'Android 7.0 trở lên',
    'install.oem': 'Được phép cài đặt qua USB',
    'install.verify': 'Play Protect',
    'install.unzip': 'Giải nén .xapk và .apkm',
    'install.apkmEncrypted': 'Tệp .apkm không mã hóa',
    'images.mediastore': 'Danh sách ảnh',
    'images.heic': 'Xem trước ảnh',
    'wifi.helper': 'Helper cục bộ',
    'wifi.adbServer': 'adb server của Google',
    'wifi.localNetwork': 'Máy tính này truy cập được mạng cục bộ',
    'wifi.reachable': 'Thiết bị phản hồi qua mạng',
    'wifi.authorized': 'Thiết bị cho phép máy tính này',
  },
})

/** How a sentence names the browser: "Chrome may use Pixel 9." */
export const BROWSER_NAMES = localized<Readonly<Record<BrowserName, string>>>({
  en: {
    chrome: 'Chrome',
    edge: 'Edge',
    opera: 'Opera',
    firefox: 'Firefox',
    safari: 'Safari',
    other: 'This browser',
  },
  vi: {
    chrome: 'Chrome',
    edge: 'Edge',
    opera: 'Opera',
    firefox: 'Firefox',
    safari: 'Safari',
    other: 'Trình duyệt này',
  },
})

export const LINKS = {
  securePage: 'https://bauloc.github.io/device/',
  chrome: 'https://www.google.com/chrome/',
  devOptions: 'https://developer.android.com/studio/debug/dev-options',
  winUsb: 'https://developer.android.com/studio/run/win-usb',
  java: 'https://adoptium.net/',
  helperPage: 'http://127.0.0.1:8787/device/',
  helperDownload: 'https://bauloc.github.io/device/agent/device-bridge.mjs',
  /** nodejs.org's download page: it detects the system and offers its installer. */
  node: 'https://nodejs.org/en/download',
} as const

/**
 * The fixes that never change. One that is the way out wherever it appears is primary here;
 * checks.ts promotes the others in the rows where they come first.
 */
export const FIX = localized({
  en: {
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
    snapUsb: {
      label: 'Copy the snap Chromium command',
      copy: 'sudo snap connect chromium:raw-usb',
    },
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
    connectHelper: { label: 'Connect helper', action: 'connect-helper' },
    useHelper: { label: 'Use the helper instead', action: 'connect-helper' },
    startAdb: { label: 'Start adb server', action: 'start-adb', primary: true },
    openWifi: { label: 'Connect over Wi‑Fi…', action: 'open-wifi' },
    installAdb: {
      label: 'Copy the install command',
      copy: 'brew install --cask android-platform-tools',
    },
    updateAdb: {
      label: 'Copy the update command',
      copy: 'brew upgrade --cask android-platform-tools',
    },
    tvNetworkDebugging: {
      label: 'Android TV',
      path: 'Settings → Device Preferences → About → select Build 7 times; then Settings → Device Preferences → Developer options → Network debugging (on Google TV: Wireless debugging)',
    },
    phoneWirelessDebugging: {
      label: 'Phone',
      path: 'Settings → System → Developer options → Wireless debugging → On (Android 11 or newer)',
    },
    pairWithCode: {
      label: 'Phone or Google TV',
      path: 'Settings → System → Developer options → Wireless debugging → Pair device with pairing code',
    },
    helperDownload: { label: 'Download the helper', href: LINKS.helperDownload },
    getNode: { label: 'Get Node.js (LTS)', href: LINKS.node },
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
  } satisfies Record<string, Fix>,
  // The paths name what each screen says in Vietnamese: stock Android (Pixel), Samsung's and
  // Xiaomi's own words where they differ, Android TV, Windows, Chrome and Firefox.
  vi: {
    openSecure: { label: 'Mở trang bảo mật', href: LINKS.securePage, primary: true },
    getChrome: { label: 'Tải Chrome', href: LINKS.chrome },
    reload: { label: 'Tải lại', action: 'reload', primary: true },
    developerOptions: {
      label: 'Bật Tuỳ chọn cho nhà phát triển',
      path: 'Cài đặt → Giới thiệu về điện thoại → chạm vào Số bản dựng 7 lần (Samsung: Thông tin điện thoại → Thông tin phần mềm → Số hiệu bản tạo)',
    },
    usbDebugging: {
      label: 'Bật Gỡ lỗi qua USB',
      path: 'Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Gỡ lỗi qua USB (một số điện thoại: Hệ thống → Nâng cao)',
    },
    devOptionsGuide: { label: 'Đọc hướng dẫn của Android', href: LINKS.devOptions },
    addDevice: { label: 'Thêm thiết bị', action: 'add-device' },
    findPhone: { label: 'Tìm điện thoại của tôi…', action: 'find-phone' },
    retry: { label: 'Thử lại', action: 'retry' },
    revoke: {
      label: 'Thu hồi ủy quyền',
      path: 'Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Thu hồi các lượt ủy quyền gỡ lỗi qua USB',
    },
    killServer: { label: 'Sao chép “adb kill-server”', copy: 'adb kill-server' },
    reconnect: { label: 'Kết nối lại', action: 'retry' },
    releaseOtherTab: { label: 'Yêu cầu thẻ kia nhả điện thoại', action: 'release-other-tab' },
    udevRules: {
      label: 'Sao chép quy tắc udev: Debian/Ubuntu',
      copy: 'sudo apt-get install android-sdk-platform-tools-common',
    },
    udevFedora: { label: 'Sao chép quy tắc udev: Fedora', copy: 'sudo dnf install android-tools' },
    udevArch: { label: 'Sao chép quy tắc udev: Arch', copy: 'sudo pacman -S android-udev' },
    plugdev: { label: 'Sao chép lệnh plugdev', copy: 'sudo usermod -aG plugdev $LOGNAME' },
    snapUsb: {
      label: 'Sao chép lệnh snap cho Chromium',
      copy: 'sudo snap connect chromium:raw-usb',
    },
    winUsb: { label: 'Tải trình điều khiển USB của Google', href: LINKS.winUsb },
    winUsbSwitch: {
      label: 'Chuyển giao diện ADB sang WinUSB',
      path: 'Trình quản lý thiết bị → “ADB Interface” của điện thoại (trong Thiết bị Universal Serial Bus, Android Device hoặc Thiết bị di động) → Cập nhật trình điều khiển → Duyệt máy tính để tìm trình điều khiển → Để tôi chọn → “Android ADB Interface” hoặc “WinUSB Device”',
    },
    startHelper: { label: 'Sao chép lệnh khởi động', copy: 'node device-bridge.mjs' },
    checkHelper: { label: 'Kiểm tra lại', action: 'check-helper', primary: true },
    lnaChromium: {
      label: 'Cho phép lại',
      path: 'Biểu tượng điều khiển trang (bên trái thanh địa chỉ) → Cài đặt trang web → Ứng dụng trên thiết bị → Cho phép',
    },
    lnaFirefox: {
      label: 'Cho phép lại',
      path: 'Cài đặt → Riêng tư & bảo mật → Ứng dụng và dịch vụ thiết bị',
    },
    helperPage: { label: 'Mở trang của helper', href: LINKS.helperPage, primary: true },
    pair: { label: 'Ghép nối…', action: 'pair-helper', primary: true },
    connectHelper: { label: 'Kết nối helper', action: 'connect-helper' },
    useHelper: { label: 'Chuyển sang dùng helper', action: 'connect-helper' },
    startAdb: { label: 'Khởi động adb server', action: 'start-adb', primary: true },
    openWifi: { label: 'Kết nối qua Wi‑Fi…', action: 'open-wifi' },
    installAdb: {
      label: 'Sao chép lệnh cài đặt',
      copy: 'brew install --cask android-platform-tools',
    },
    updateAdb: {
      label: 'Sao chép lệnh cập nhật',
      copy: 'brew upgrade --cask android-platform-tools',
    },
    tvNetworkDebugging: {
      label: 'Android TV',
      path: 'Cài đặt → Lựa chọn ưu tiên về thiết bị (TV cũ: Tùy chọn thiết bị) → Giới thiệu → chọn Bản dựng 7 lần; sau đó Cài đặt → Lựa chọn ưu tiên về thiết bị → Tùy chọn nhà phát triển → Gỡ lỗi mạng (trên Google TV: Gỡ lỗi qua Wi‑Fi)',
    },
    phoneWirelessDebugging: {
      label: 'Điện thoại',
      path: 'Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Gỡ lỗi qua Wi‑Fi → Bật (Android 11 trở lên)',
    },
    pairWithCode: {
      label: 'Điện thoại hoặc Google TV',
      path: 'Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Gỡ lỗi qua Wi‑Fi → Ghép nối thiết bị bằng mã ghép nối',
    },
    helperDownload: { label: 'Tải xuống helper', href: LINKS.helperDownload },
    getNode: { label: 'Tải Node.js (LTS)', href: LINKS.node },
    java: { label: 'Tải Java (Temurin 21 LTS)', href: LINKS.java },
    brewJava: {
      label: 'Sao chép “brew install --cask temurin”',
      copy: 'brew install --cask temurin',
    },
    downloadBundletool: { label: 'Tải xuống ngay', action: 'get-bundletool' },
    brewBundletool: {
      label: 'Sao chép “brew install bundletool”',
      copy: 'brew install bundletool',
    },
    createKey: { label: 'Tạo khóa', action: 'create-key', primary: true },
    xiaomiUsbInstall: {
      label: 'Cho phép cài đặt qua USB',
      path: 'Cài đặt → Cài đặt bổ sung → Tùy chọn nhà phát triển → Cài đặt qua USB (cần tài khoản Mi)',
    },
    retryImages: { label: 'Thử lại', action: 'retry-images' },
    saveImage: { label: 'Lưu', action: 'save-image', primary: true },
  },
})

/** The labels of the fixes built from what the page knows: its address, the helper's port… */
const FIX_LABELS = localized({
  en: {
    copyLink: 'Copy this page’s link',
    helperPage: 'Open the helper’s page',
    siteSettings: 'Copy the settings address',
    bundletool: 'Copy the bundletool command',
  },
  vi: {
    copyLink: 'Sao chép liên kết trang này',
    helperPage: 'Mở trang của helper',
    siteSettings: 'Sao chép địa chỉ trang cài đặt',
    bundletool: 'Sao chép lệnh bundletool',
  },
})

/** "Copy this page's link", for a page embedded where USB is blocked. */
export function copyLinkFix(href: string): Fix {
  return { label: FIX_LABELS.copyLink, copy: href, primary: true }
}

/** "Open the helper's page": the copy the helper serves itself, which needs no permission. */
export function helperPageFix(port: number): Fix {
  return {
    label: FIX_LABELS.helperPage,
    href: `http://127.0.0.1:${String(port)}/device/`,
    primary: true,
  }
}

/** Chrome's site settings for this page, as an address to paste (edge://, opera:// alike). */
export function siteSettingsFix(scheme: 'chrome' | 'edge' | 'opera'): Fix {
  return {
    label: FIX_LABELS.siteSettings,
    copy: `${scheme}://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io`,
  }
}

export function bundletoolFix(command: string): Fix {
  return { label: FIX_LABELS.bundletool, copy: command, primary: true }
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

/** What each gated feature lets the page do, to finish "it can’t … yet". */
const OLDER_CAN = localized<Readonly<Record<GatedFeature, string>>>({
  en: {
    'android.discover': 'look for devices on this network',
    'android.connect': 'connect to devices over Wi‑Fi',
    'android.start-server': 'start Google’s adb server',
    'lan.discover': 'list every device on this network',
    'android.adb': 'list apps, show images or install apps on this device',
  },
  vi: {
    'android.discover': 'tìm thiết bị trên mạng này',
    'android.connect': 'kết nối với thiết bị qua Wi‑Fi',
    'android.start-server': 'khởi động adb server của Google',
    'lan.discover': 'liệt kê mọi thiết bị trên mạng này',
    'android.adb': 'liệt kê ứng dụng, xem ảnh hay cài ứng dụng trên thiết bị này',
  },
})

/** The sentences, by check. Functions fill in what the check knows. */
export const COPY = localized({
  en: {
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
      notNeeded: (name: string) =>
        `Not needed: ${name} is ready through the local helper, which doesn’t use WebUSB.`,
      notUsed: (name: string) =>
        `Not checked: ${name} goes through the local helper, which doesn’t use WebUSB. For an Android phone on a cable in this browser, click Add device.`,
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
      /** The .aab rows: building APKs from an .aab comes with a later helper version. */
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
      old: (running: string) =>
        `Installing needs Android 7.0 or newer. This phone runs ${running}.`,
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
    /*
      The local helper (spec §12b), worded by the page: reaching it, its version, the pairing,
      and the published file. The Mac's tools are worded by the helper itself.
    */
    reach: {
      local: 'Not needed: the helper serves this page.',
      /** What the helper's own page costs (spec §6.4). */
      localCosts:
        'This copy is a separate site: the theme, USB permissions and the browser’s adb key from bauloc.github.io don’t carry over. It needs internet access, and can’t reload once the helper stops.',
      granted: 'Allowed to reach apps on this device.',
      /** The grant is for the whole site, not the helper alone (spec §8, T12). */
      grantedScope:
        'The permission covers every page of this site and every app on this Mac that listens locally; the helper still answers only to its token.',
      unsupported: 'This browser doesn’t ask for this permission.',
      prompt: 'The browser will ask once to let this page reach apps on this device; choose Allow.',
      denied: 'This browser blocks this page from reaching apps on this device.',
      safari: 'Safari can’t reach the helper from this secure page.',
    },
    helperRunning: {
      ok: (version: string, address: string) => `Helper ${version} answers on ${address}.`,
      unchecked: 'Not checked yet.',
      checking: (address: string) => `Looking for the helper on ${address}…`,
      absent: (address: string) => `Nothing answers on ${address}.`,
      /** A dev server: the helper refuses its origin unless it runs with --dev. */
      absentDev: (address: string) =>
        `Nothing answers on ${address}, or the helper was started without --dev.`,
      lost: 'The helper stopped.',
      foreign: (port: number) => `Another program answers on port ${String(port)}.`,
      dismissed: 'The browser’s prompt was closed before the helper could be checked.',
      /** Denied or Safari: a blocked request fails exactly like a stopped helper. */
      blocked:
        'Can’t tell while the browser blocks this page from reaching the helper. Not started yet? Start it with this command.',
      node: 'The helper needs Node.js 18 or newer: node -v shows yours.',
    },
    helperVersion: {
      ok: (protocol: number, version: string) =>
        `Protocol ${String(protocol)}, version ${version}.`,
      outdated: (version: string) =>
        version
          ? `This helper (${version}) is older than this page needs.`
          : 'This helper is older than this page needs.',
      newer: 'This page is older than the helper.',
    },
    pairing: {
      ok: (tokenId: string, remembered: boolean) =>
        `Paired · fingerprint ${tokenId} · ${remembered ? 'remembered on this computer' : 'this tab only'}.`,
      unpaired: 'This page isn’t paired with the helper.',
      stale: 'The helper restarted, so this page’s pairing ended.',
      foreign: (port: number) =>
        `The program on port ${String(port)} couldn’t prove it is your helper; nothing was sent.`,
      waitVersion: 'Checked once the helper and this page agree on a version.',
    },
    update: {
      ok: (version: string) => `Matches the published helper (${version}).`,
      newer: (version: string) => `A newer helper (${version}) is published.`,
      differs: 'This helper differs from the published file.',
      unchecked: 'Couldn’t read the published helper, so this wasn’t compared.',
    },
    /**
     * A feature this page would use, missing from a helper downloaded before the feature shipped
     * (helper/update.ts featureSupport). Said where the feature would be: `sentence`, the
     * download command, then `then`.
     */
    older: {
      sentence: (feature: GatedFeature) =>
        `Your helper is older than this page: it can’t ${OLDER_CAN[feature]} yet. Update it: press Ctrl+C in its window, then run:`,
      then: 'Then reload this page.',
    },
    tools: {
      notConnected:
        'This Mac’s tools aren’t checked yet; start the helper to check Xcode, adb and the rest.',
      pending: 'Checked once the helper reports this Mac’s tools.',
      /** The helper answered, but only a paired page may read its tools. */
      unpaired: 'Checked once this page is paired with the helper.',
      /** android.adb-server stopped, in a browser without WebUSB (spec §12c relevance). */
      adbServerNeeded:
        'Without WebUSB, Android goes through Google’s adb server, which isn’t running.',
    },
    /** Android over Wi‑Fi (§4.7): the Wi‑Fi dialog and its checklist rows. */
    wifi: {
      helperOk: (tokenId: string) =>
        `Running and paired (fingerprint ${tokenId}). Wi‑Fi devices go through it.`,
      helperOff:
        'Browsers can’t open network connections to a TV or a phone, so Wi‑Fi devices go through the local helper on this computer. Start it and pair this page.',
      helperUnpaired: 'The helper is running, but this page isn’t paired with it yet.',
      adbUnchecked: 'Checked once the helper is connected.',
      adbOk: 'Running. The helper reaches Wi‑Fi devices through it.',
      adbStopped: 'Google’s adb server isn’t running, and Wi‑Fi devices go through it.',
      adbStartNote:
        'While it runs, Chrome’s WebUSB can’t use Android phones on a cable; adb kill-server gives them back.',
      adbMissing: 'Google’s adb isn’t installed on this Mac, and Wi‑Fi devices go through it.',
      adbOff: 'The helper was started with --no-android, so it can’t reach Android devices.',
      adbOffStep: 'Stop the helper (Ctrl+C) and start it again without --no-android.',
      reachUnchecked: 'Checked when you connect.',
      reaching: (address: string) => `Connecting to ${address}…`,
      pairing: (address: string) => `Pairing with ${address}…`,
      reachOk: (address: string) => `${address} answered.`,
      paired: (address: string) =>
        `Paired with ${address}. Now connect, with the port the Wireless debugging screen shows next to “IP address & Port”.`,
      unreachable: (address: string) => `Nothing answered at ${address}.`,
      /** reason `blocked`: the connection never left this computer (§4.7). */
      blocked: (address: string) =>
        `This computer blocked the connection to ${address}, so the device never saw it. The problem is on this computer, not the TV or phone.`,
      blockedVpn:
        'Turn off the VPN (Cloudflare WARP, a work VPN), or let it reach the local network, then connect again.',
      blockedMac:
        'Stop the helper (Ctrl+C), start it again from the Terminal app, and choose Allow when macOS asks to find devices on your local network. Asked before: System Settings → Privacy & Security → Local Network → turn on Terminal.',
      /** The same, next to the command that starts the helper: it is drawn above the steps. */
      blockedMacCommand:
        'Stop the helper (Ctrl+C), start it again from the Terminal app with the command above, and choose Allow when macOS asks to find devices on your local network. Asked before: System Settings → Privacy & Security → Local Network → turn on Terminal.',
      reachBlocked: 'Checked once this computer can reach the local network.',
      unreachableStep:
        'Check that the device is on and awake, on the same Wi‑Fi as this computer, and that the address matches the one on its screen.',
      timeout: (address: string) => `${address} didn’t answer in time.`,
      refused: (host: string, port: number) =>
        `${host} answered, but nothing accepts debugging on port ${String(port)}.`,
      refusedStep:
        'Turn on Network debugging (TV) or Wireless debugging (phone), then use the port that screen shows. A TV uses 5555.',
      unresolved: (host: string) => `No device called ${host} was found on this network.`,
      unresolvedStep:
        'Use the IP address instead: Settings → Network & Internet → your Wi‑Fi on the device, or the Wireless debugging screen.',
      needsPairing: (address: string) =>
        `${address} uses Wireless debugging, which needs pairing with a code first.`,
      pairWrong: 'The pairing code was wrong, or the pairing screen closed.',
      pairWrongStep:
        'Settings → System → Developer options → Wireless debugging → Pair device with pairing code, then type the new code and port (both change each time).',
      pairUnsupported: 'This Mac’s adb is too old to pair with a code.',
      failed: (address: string) => `adb couldn’t connect to ${address}.`,
      pairFailed: (address: string) => `adb couldn’t pair with ${address}.`,
      busy: (host: string) => `Already connecting to ${host}. Wait for that to finish.`,
      adbSaid: (message: string) => `adb said: “${message}”`,
      authUnchecked: 'Checked once the device answers.',
      authWaiting: (name: string) =>
        `${name} is waiting for you to choose Allow on “Allow debugging?”.`,
      authOk: (name: string) =>
        `${name} allows this computer. Details, screenshots, logs, apps, images and installs all work.`,
      offline: (name: string) => `${name} stopped answering over Wi‑Fi.`,
      offlineStep: 'Wake the device, check it is still on the same Wi‑Fi, then connect again.',
      allowStep:
        'Choose Allow on “Allow debugging?” (on a TV, with the remote), and tick Always allow from this computer.',
      /** The address field's own problems, before anything is sent. */
      hostEmpty: 'Enter the device’s IP address, as its screen shows it.',
      hostInvalid: 'That isn’t an IP address. It looks like 192.168.1.20.',
      hostPublic:
        'Only devices on your local network: an address that starts with 192.168., 10., 172.16–31., 169.254. or 100.64–127.',
      hostLoopback:
        'That address is this computer. Enter the TV’s or phone’s address, from its network settings.',
      hostName:
        'Use the device’s IP address, or a name of up to 100 characters that ends in .local, .lan or .home.arpa.',
      portInvalid: 'The port is a number from 1 to 65535.',
      portEmpty: 'Enter the port the Wireless debugging screen shows.',
      codeEmpty: 'Enter the six-digit code the device shows.',
      codeInvalid: 'The pairing code is six digits.',
    },
    /**
     * "On this network": the Android devices the helper heard advertising debugging over mDNS.
     * Listing is only looking; every connect is still the tester's click.
     */
    nearby: {
      helperOff:
        'To list the TVs and phones on this network, start the local helper and pair this page.',
      empty: 'No Android device on this network has debugging turned on.',
      /** Heard, but every one is in the list already. */
      allListed: 'Every device found on this network is connected.',
      emptyStep: 'Turn it on, on the device, then refresh:',
      /** Heard nothing: the other likely causes, after the steps (§4.8). */
      emptyOther:
        'Already on? Check that the device is on the same Wi‑Fi as this computer, and that no VPN (Cloudflare WARP, a work VPN) is on here.',
      /** The mDNS socket was refused: the same causes as a connect's `blocked` (§4.7). */
      blocked:
        'This computer can’t reach the local network, so it can’t look for devices on it. The problem is on this computer, not the TV or phone.',
      blockedVpn:
        'Turn off the VPN (Cloudflare WARP, a work VPN), or let it reach the local network, then refresh.',
      unavailable: 'The helper couldn’t look for devices on this network.',
      found: (n: number) =>
        n === 1 ? '1 device found on this network.' : `${String(n)} devices found on this network.`,
      none: 'No devices found on this network.',
      pickHint: 'Choose one to fill in its address.',
    },
    /** Rows about the devices the helper lists (spec §12b, Devices). */
    device: {
      noneIos: 'Plug in an iPhone with a cable and unlock it.',
      noneIosStep:
        'When asked, tap Trust and enter the passcode. If nothing asks, open Finder and select the iPhone in the sidebar.',
      noneAndroid: 'Plug in a phone with USB debugging on.',
      noneAndroidStep:
        'Settings → About phone → tap Build number 7 times, then Settings → System → Developer options → USB debugging.',
      trustOk: 'Trusted.',
      trust: 'This iPhone doesn’t trust this Mac yet.',
      lockOk: 'Unlocked since it restarted.',
      lock: 'The iPhone hasn’t been unlocked since it restarted.',
      lockStep: 'Unlock it with the passcode.',
      devModeOk: 'Developer Mode is on.',
      devMode: 'Developer Mode is off, so screenshots are off.',
      devModeStep: 'Settings → Privacy & Security → Developer Mode → On (it restarts).',
      iosOk: (version: string) => `iOS ${version} is supported.`,
      iosOld: 'iOS 14 and older are untested; some details may be missing.',
      iosNew: (major: number) =>
        `iOS ${String(major)} is newer than this helper knows; update the helper if something fails.`,
      shotsOk: 'Screenshots work.',
      shotsOff: 'Screenshots are off for this device.',
      ddi: 'iOS 16 and older need Apple’s developer disk image mounted before a screenshot.',
      ddiStep:
        'Unlock the iPhone and open it once in Xcode’s Devices and Simulators window, then retry.',
      androidAuth: 'The phone is waiting for you to allow USB debugging.',
      androidAuthStep: 'Unlock it and tap Allow on “Allow USB debugging?” (tick Always allow).',
      conflict: 'Google’s adb server is holding this phone.',
      shared: 'Shared through Google’s adb server.',
      sharedWifi: 'Connected over Wi‑Fi through Google’s adb server.',
      offline: 'The phone isn’t answering.',
      offlineStep: 'Reseat the cable and avoid USB hubs.',
      /** Labels: "Ngọc’s iPhone: Trust". */
      label: (name: string, what: string) => `${name}: ${what}`,
    },
  },
  /*
    Sentences say the fact, then "Hãy …" for what to do; a step shown after its label ("iPhone:
    …", "VPN: …") is a plain imperative. The name a USB finding carries never starts a sentence:
    when the phone reports none, usb-diagnose.ts calls it "điện thoại của bạn", in lower case.
  */
  vi: {
    secure: {
      ok: 'Đã mở qua HTTPS.',
      okLocal: 'Đã mở trên máy tính này (localhost), được coi là trang bảo mật.',
      blocking:
        'Chỉ trang https:// hoặc localhost mới truy cập được USB. Trang này đang mở qua http thường.',
    },
    webusb: {
      ok: 'Trình duyệt này giao tiếp được với điện thoại Android qua USB.',
      missing:
        'Trình duyệt này không giao tiếp được với thiết bị USB. Hãy dùng Chrome, Edge hoặc Opera trên máy tính.',
      policy: 'Trang đang nhúng Device Lab chặn USB. Hãy mở Device Lab trong một thẻ riêng.',
      unchecked: 'Chưa thể kiểm tra cho đến khi trang dùng HTTPS.',
    },
    app: {
      ok: (version: string) => `Thẻ này đang chạy Device Lab ${version}.`,
      updated: 'Device Lab đã được cập nhật trong lúc thẻ này đang mở. Hãy tải lại để tiếp tục.',
    },
    notConnected: 'Sẽ kiểm tra khi Device Lab kết nối với điện thoại.',
    usbDebugging: {
      ok: 'Gỡ lỗi qua USB đang bật.',
      unchecked: 'Mỗi điện thoại chỉ cần bật một lần.',
      off: (name: string) => `Đã cắm ${name} nhưng Gỡ lỗi qua USB đang tắt.`,
      notAndroid:
        'Thiết bị đó không có giao diện gỡ lỗi Android. Hãy chọn đúng điện thoại của bạn.',
      picked: (name: string, sure: boolean) =>
        sure
          ? `Bạn đã chọn ${name}.`
          : `Bạn đã chọn ${name}. Nếu đó là điện thoại của bạn, hãy bật Gỡ lỗi qua USB rồi chọn lại.`,
      notListed:
        'Máy tính không thấy điện thoại. Hãy thử cáp hoặc cổng khác (một số cáp chỉ sạc được), mở khóa điện thoại và kiểm tra Gỡ lỗi qua USB.',
      bootloader: (name: string) =>
        `Phát hiện ${name} đang ở chế độ fastboot. Hãy khởi động lại máy vào Android rồi thêm lại.`,
    },
    cable: {
      ok: 'Điện thoại đang cắm bằng cáp truyền dữ liệu.',
      unchecked: 'Hãy dùng cáp truyền dữ liệu. Một số cáp chỉ sạc được.',
    },
    permission: {
      ok: (browser: string, name: string) => `${browser} được phép dùng ${name}.`,
      none: 'Chưa cho phép điện thoại nào. Hãy bấm Thêm thiết bị rồi chọn điện thoại của bạn trong danh sách của trình duyệt.',
      notNeeded: (name: string) =>
        `Không cần: ${name} đã sẵn sàng qua helper cục bộ, vốn không dùng WebUSB.`,
      notUsed: (name: string) =>
        `Chưa kiểm tra: ${name} kết nối qua helper cục bộ, vốn không dùng WebUSB. Để dùng điện thoại Android cắm cáp trong trình duyệt này, hãy bấm Thêm thiết bị.`,
      dismissed:
        'Chưa chọn điện thoại nào. Nếu điện thoại của bạn không có trong danh sách, hãy kiểm tra Gỡ lỗi qua USB và cáp.',
    },
    authorized: {
      ok: 'Máy tính này đã được cho phép.',
      first: 'Khi điện thoại hỏi “Cho phép gỡ lỗi qua USB?”, hãy chạm Cho phép.',
      waiting:
        'Hãy mở khóa điện thoại và chạm Cho phép trong hộp thoại “Cho phép gỡ lỗi qua USB?”. Đánh dấu “Luôn cho phép từ máy tính này” để điện thoại không hỏi lại.',
      stuck:
        'Điện thoại không hỏi gì? Hãy rút cáp ra rồi cắm lại. Vẫn không thấy gì: Tuỳ chọn cho nhà phát triển → Thu hồi các lượt ủy quyền gỡ lỗi qua USB, rồi kết nối lại.',
      newKey: 'Xóa dữ liệu của trang web này sẽ tạo khóa mới, nên điện thoại sẽ hỏi lại.',
    },
    notHeld: {
      ok: 'Device Lab đang giữ kết nối gỡ lỗi của điện thoại.',
      held: 'Một chương trình khác đang dùng kết nối gỡ lỗi của điện thoại: thường là adb server của Google (Android Studio, Flutter, scrcpy, một cửa sổ dòng lệnh), một thẻ trình duyệt khác, hoặc chrome://inspect khi đang bật “Discover USB devices”.',
      otherTab: (name: string) => `Một thẻ Device Lab khác trong trình duyệt này đang giữ ${name}.`,
      adb: (pid: number, name: string) => `adb server (pid ${String(pid)}) đang giữ ${name}.`,
      browser: (process: string, pid: number, name: string) =>
        `${process} (pid ${String(pid)}) đang giữ ${name}, có lẽ là một thẻ khác.`,
      other: (process: string, pid: number, name: string) =>
        `${process} (pid ${String(pid)}) đang giữ ${name}. Hãy tắt chương trình đó rồi kết nối lại.`,
      heldWindows:
        'Có thứ khác đang giữ kết nối gỡ lỗi của điện thoại: thường là adb server của Google (Android Studio, Flutter, scrcpy, một cửa sổ dòng lệnh) hoặc một thẻ trình duyệt khác. Không có adb nào đang chạy? Vậy nhiều khả năng trình điều khiển USB của hãng điện thoại đang giữ giao diện ADB của máy: hãy chuyển giao diện đó sang WinUSB.',
      osDenied: 'Chưa thể kiểm tra cho đến khi hệ thống cho trình duyệt mở điện thoại.',
    },
    osAccess: {
      ok: 'Hệ thống cho phép trình duyệt này mở điện thoại.',
      unchecked: 'Sẽ kiểm tra khi Device Lab mở điện thoại.',
      linux:
        'Linux phải cho phép trình duyệt mở điện thoại. Hãy cài quy tắc udev của Android cho bản phân phối của bạn, rồi rút ra và cắm lại.',
      linuxDetail:
        'Trên Debian hoặc Ubuntu, hãy chạy thêm lệnh plugdev, rồi đăng xuất và đăng nhập lại. Chromium cài dạng snap cũng cần quyền truy cập USB: hãy chạy lệnh snap, rồi khởi động lại Chromium.',
      windows:
        'Trình điều khiển USB của hãng điện thoại có thể đang chặn trình duyệt. Hãy chuyển giao diện ADB của điện thoại sang WinUSB trong Trình quản lý thiết bị, hoặc cài trình điều khiển USB của Google.',
      windowsDetail:
        'Một adb server đang chạy cũng có thể gây ra lỗi này: hãy tắt nó bằng “adb kill-server”, rồi kết nối lại.',
      other:
        'Hệ thống không cho trình duyệt mở điện thoại. Hãy rút điện thoại ra rồi cắm lại, sau đó kết nối lại.',
    },
    helper: {
      coming: 'Sẽ có trong helper của Device Lab.',
      waitAnswer: 'Sẽ kiểm tra khi helper phản hồi.',
      waitPairing: 'Sẽ kiểm tra khi trang này đã ghép nối với helper.',
    },
    running: {
      ok: (version: string) => `Helper ${version} đang chạy trên máy tính này.`,
      down: 'Helper chưa chạy. Hãy chạy helper trong Terminal, rồi bấm Kiểm tra lại.',
      node: 'Cần Node.js 18 trở lên.',
      blocked: 'Chưa thể biết khi trình duyệt còn chặn trang này kết nối với helper.',
    },
    lna: {
      ok: 'Trang này được phép truy cập ứng dụng trên máy tính này.',
      prompt: (browser: string) =>
        `${browser} sẽ hỏi một lần xem có cho trang này truy cập ứng dụng trên máy tính này không. Hãy chọn Cho phép.`,
      denied: (browser: string) => `${browser} đang chặn trang này kết nối với helper.`,
      safari: 'Safari không kết nối được với helper từ trang này. Hãy mở trang riêng của helper.',
      unsupported: 'Trình duyệt này không cho biết trạng thái của quyền này.',
    },
    paired: {
      ok: 'Trang này đã ghép nối với helper.',
      none: 'Hãy ghép nối trang này với helper bằng liên kết mà helper đã in ra (…#pair=…).',
      stale:
        'Helper đã khởi động lại kể từ khi trang này được ghép nối. Hãy ghép nối lại bằng liên kết mà helper đã in ra (…#pair=…).',
    },
    version: {
      ok: (version: string) => `Helper ${version} dựng được APK từ tệp .aab.`,
      old: 'Helper này quá cũ để cài tệp .aab. Hãy tải bản mới nhất rồi khởi động lại.',
    },
    java: {
      ok: (version: string, vendor?: string) =>
        vendor ? `Java ${version} (${vendor}).` : `Java ${version}.`,
      missing: 'Dựng APK từ tệp .aab cần Java, nhưng không tìm thấy Java nào.',
      old: (version: string) => `Java ${version} quá cũ. bundletool cần Java 11 trở lên.`,
      unreadable:
        'Helper đã tìm thấy Java nhưng không đọc được phiên bản. bundletool cần Java 11 trở lên.',
    },
    bundletool: {
      ok: (version: string) => `bundletool ${version}.`,
      missing:
        'Helper sẽ tải bundletool 1.18.3 (32,5 MB, có kiểm tra checksum) vào lần đầu bạn cài tệp .aab.',
    },
    key: {
      ok: 'APK được ký bằng khóa debug của máy tính này.',
      missing: 'Máy tính này chưa có khóa ký debug. Helper có thể tạo một khóa.',
      play: 'Bản dựng ký ở đây không cập nhật được bản đã cài từ Google Play.',
    },
    adbServer: {
      ok: 'Không có adb server nào đang chạy.',
      running:
        'Có một adb server đang chạy trên máy tính này. Nó có thể giành điện thoại khỏi trình duyệt.',
      holds: (names: string) => `adb server trên máy tính này đang giữ ${names}.`,
    },
    aab: {
      build:
        'Trình duyệt không cài trực tiếp được tệp .aab: bundletool phải dựng APK từ tệp đó trước.',
      manual: 'Không có helper? Hãy tự dựng tệp .apks rồi thả vào đây:',
      manualDetail:
        'Cần Java 11 trở lên, bundletool và khóa debug mà Android Studio tạo ra (~/.android/debug.keystore). Bản dựng ký bằng khóa này không cập nhật được bản đã cài từ Google Play.',
    },
    install: {
      ok: (running: string) => `${running} hỗ trợ cài đặt qua USB.`,
      old: (running: string) =>
        `Cài ứng dụng cần Android 7.0 trở lên. Điện thoại này đang chạy ${running}.`,
      unchecked: 'Sẽ kiểm tra khi điện thoại đã kết nối.',
      xiaomi: 'Điện thoại Xiaomi, Redmi và POCO từ chối cài đặt qua USB cho đến khi bạn cho phép.',
      restricted:
        'Điện thoại đang chặn cài đặt qua USB. Hãy tìm trong Tuỳ chọn cho nhà phát triển mục cho phép cài đặt qua USB, hoặc hỏi người quản lý điện thoại.',
      verifyOff: '“Xác minh ứng dụng qua USB” đang tắt trên điện thoại này.',
      verify:
        'Play Protect có thể quét ứng dụng và hỏi trên điện thoại. Hãy giữ điện thoại ở trạng thái mở khóa và để ý màn hình.',
    },
    unzip: {
      ok: 'Trình duyệt này giải nén được tệp .xapk và .apkm.',
      missing:
        'Trình duyệt này không giải nén được tệp .xapk hoặc .apkm. Hãy cập nhật Chrome hoặc Edge (phiên bản 103 trở lên).',
      unchecked: 'Sẽ kiểm tra khi mở tệp.',
    },
    apkm: {
      ok: 'Tệp .apkm này không bị mã hóa.',
      encrypted:
        'Tệp .apkm này bị mã hóa (định dạng cũ của APKMirror). Hãy tải xuống lại từ APKMirror.',
    },
    images: {
      ok: 'Android đã liệt kê được ảnh.',
      loading: 'Sẽ kiểm tra khi ảnh tải xong.',
      failed: (line: string) =>
        line ? `Android không liệt kê được ảnh: ${line}.` : 'Android không liệt kê được ảnh.',
      fallback:
        'Chỉ hiện các thư mục (Screenshots, Camera, Download). Ngày hiển thị là thời gian của tệp.',
      heic: (browser: string) =>
        `${browser} không hiển thị được ảnh HEIC. Hãy lưu ảnh để mở trên máy tính này.`,
    },
    reach: {
      local: 'Không cần: trang này do chính helper cung cấp.',
      localCosts:
        'Bản này là một trang web riêng: giao diện sáng/tối, quyền USB và khóa adb của trình duyệt từ bauloc.github.io không được chuyển sang. Bản này cần kết nối Internet và không tải lại được khi helper đã dừng.',
      granted: 'Được phép truy cập ứng dụng trên thiết bị này.',
      grantedScope:
        'Quyền này áp dụng cho mọi trang của trang web này và mọi ứng dụng trên máy Mac này đang lắng nghe cục bộ; helper vẫn chỉ phản hồi khi có đúng token của nó.',
      unsupported: 'Trình duyệt này không hỏi quyền này.',
      prompt:
        'Trình duyệt sẽ hỏi một lần xem có cho trang này truy cập ứng dụng trên thiết bị này không; hãy chọn Cho phép.',
      denied: 'Trình duyệt này đang chặn trang này truy cập ứng dụng trên thiết bị này.',
      safari: 'Safari không kết nối được với helper từ trang bảo mật này.',
    },
    helperRunning: {
      ok: (version: string, address: string) => `Helper ${version} đang phản hồi tại ${address}.`,
      unchecked: 'Chưa kiểm tra.',
      checking: (address: string) => `Đang tìm helper tại ${address}…`,
      absent: (address: string) => `Không có phản hồi từ ${address}.`,
      absentDev: (address: string) =>
        `Không có phản hồi từ ${address}, hoặc helper đã chạy mà không kèm --dev.`,
      lost: 'Helper đã dừng.',
      foreign: (port: number) => `Một chương trình khác đang phản hồi trên cổng ${String(port)}.`,
      dismissed: 'Hộp thoại của trình duyệt đã bị đóng trước khi kiểm tra được helper.',
      blocked:
        'Chưa thể biết khi trình duyệt còn chặn trang này kết nối với helper. Chưa chạy helper? Hãy chạy helper bằng lệnh này.',
      node: 'Helper cần Node.js 18 trở lên: lệnh node -v cho biết phiên bản bạn đang có.',
    },
    helperVersion: {
      ok: (protocol: number, version: string) =>
        `Giao thức ${String(protocol)}, phiên bản ${version}.`,
      outdated: (version: string) =>
        version
          ? `Helper này (${version}) cũ hơn phiên bản trang này cần.`
          : 'Helper này cũ hơn phiên bản trang này cần.',
      newer: 'Trang này cũ hơn helper.',
    },
    pairing: {
      ok: (tokenId: string, remembered: boolean) =>
        `Đã ghép nối · vân tay ${tokenId} · ${remembered ? 'đã ghi nhớ trên máy tính này' : 'chỉ trong thẻ này'}.`,
      unpaired: 'Trang này chưa ghép nối với helper.',
      stale: 'Helper đã khởi động lại nên trang này không còn được ghép nối.',
      foreign: (port: number) =>
        `Chương trình trên cổng ${String(port)} không chứng minh được đó là helper của bạn; chưa gửi gì cả.`,
      waitVersion: 'Sẽ kiểm tra khi helper và trang này thống nhất được phiên bản.',
    },
    update: {
      ok: (version: string) => `Khớp với bản helper đã phát hành (${version}).`,
      newer: (version: string) => `Đã phát hành bản helper mới hơn (${version}).`,
      differs: 'Helper này khác với tệp đã phát hành.',
      unchecked: 'Không đọc được bản helper đã phát hành nên chưa so sánh.',
    },
    older: {
      sentence: (feature: GatedFeature) =>
        `Helper của bạn cũ hơn trang này nên chưa thể ${OLDER_CAN[feature]}. Hãy cập nhật: nhấn Ctrl+C trong cửa sổ của helper, rồi chạy:`,
      then: 'Sau đó tải lại trang này.',
    },
    tools: {
      notConnected:
        'Chưa kiểm tra công cụ trên máy Mac này; hãy chạy helper để kiểm tra Xcode, adb và các công cụ khác.',
      pending: 'Sẽ kiểm tra khi helper báo cáo công cụ trên máy Mac này.',
      unpaired: 'Sẽ kiểm tra khi trang này đã ghép nối với helper.',
      adbServerNeeded:
        'Không có WebUSB thì Android phải đi qua adb server của Google, nhưng adb server chưa chạy.',
    },
    wifi: {
      helperOk: (tokenId: string) =>
        `Đang chạy và đã ghép nối (vân tay ${tokenId}). Thiết bị Wi‑Fi đi qua helper này.`,
      helperOff:
        'Trình duyệt không mở được kết nối mạng tới TV hay điện thoại, nên thiết bị Wi‑Fi phải đi qua helper cục bộ trên máy tính này. Hãy chạy helper và ghép nối trang này.',
      helperUnpaired: 'Helper đang chạy nhưng trang này chưa ghép nối với helper.',
      adbUnchecked: 'Sẽ kiểm tra khi helper đã kết nối.',
      adbOk: 'Đang chạy. Helper kết nối tới thiết bị Wi‑Fi thông qua adb server này.',
      adbStopped: 'adb server của Google chưa chạy, mà thiết bị Wi‑Fi phải đi qua nó.',
      adbStartNote:
        'Khi adb server chạy, WebUSB của Chrome không dùng được điện thoại Android cắm cáp; lệnh adb kill-server sẽ trả lại các điện thoại đó.',
      adbMissing: 'Máy Mac này chưa cài adb của Google, mà thiết bị Wi‑Fi phải đi qua adb.',
      adbOff: 'Helper được chạy với --no-android nên không kết nối được thiết bị Android.',
      adbOffStep: 'Hãy dừng helper (Ctrl+C) rồi chạy lại mà không có --no-android.',
      reachUnchecked: 'Sẽ kiểm tra khi bạn kết nối.',
      reaching: (address: string) => `Đang kết nối tới ${address}…`,
      pairing: (address: string) => `Đang ghép nối với ${address}…`,
      reachOk: (address: string) => `${address} đã phản hồi.`,
      paired: (address: string) =>
        `Đã ghép nối với ${address}. Giờ hãy kết nối, dùng cổng hiển thị cạnh “Địa chỉ IP và cổng” trên màn hình Gỡ lỗi qua Wi‑Fi.`,
      unreachable: (address: string) => `Không có phản hồi từ ${address}.`,
      blocked: (address: string) =>
        `Máy tính này đã chặn kết nối tới ${address}, nên thiết bị chưa hề nhận được. Vấn đề nằm ở máy tính này, không phải ở TV hay điện thoại.`,
      blockedVpn:
        'Tắt VPN (Cloudflare WARP, VPN công ty), hoặc cho phép VPN truy cập mạng cục bộ, rồi kết nối lại.',
      blockedMac:
        'Dừng helper (Ctrl+C), chạy lại từ ứng dụng Terminal, và chọn Cho phép khi macOS hỏi có cho tìm thiết bị trên mạng cục bộ không. Nếu đã từng được hỏi: Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Mạng cục bộ → bật Terminal.',
      blockedMacCommand:
        'Dừng helper (Ctrl+C), chạy lại từ ứng dụng Terminal bằng lệnh ở trên, và chọn Cho phép khi macOS hỏi có cho tìm thiết bị trên mạng cục bộ không. Nếu đã từng được hỏi: Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Mạng cục bộ → bật Terminal.',
      reachBlocked: 'Sẽ kiểm tra khi máy tính này truy cập được mạng cục bộ.',
      unreachableStep:
        'Kiểm tra thiết bị đang bật và không ở chế độ ngủ, dùng cùng mạng Wi‑Fi với máy tính này, và địa chỉ khớp với địa chỉ trên màn hình thiết bị.',
      timeout: (address: string) => `${address} không phản hồi kịp.`,
      refused: (host: string, port: number) =>
        `${host} có phản hồi, nhưng cổng ${String(port)} không nhận kết nối gỡ lỗi.`,
      refusedStep:
        'Bật Gỡ lỗi mạng (TV) hoặc Gỡ lỗi qua Wi‑Fi (điện thoại), rồi dùng cổng hiển thị trên màn hình đó. TV dùng cổng 5555.',
      unresolved: (host: string) => `Không tìm thấy thiết bị nào tên ${host} trên mạng này.`,
      unresolvedStep:
        'Dùng địa chỉ IP thay cho tên: Cài đặt → Mạng và Internet → mạng Wi‑Fi của bạn trên thiết bị, hoặc màn hình Gỡ lỗi qua Wi‑Fi.',
      needsPairing: (address: string) =>
        `${address} dùng Gỡ lỗi qua Wi‑Fi nên cần ghép nối bằng mã trước.`,
      pairWrong: 'Mã ghép nối không đúng, hoặc màn hình ghép nối đã đóng.',
      pairWrongStep:
        'Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Gỡ lỗi qua Wi‑Fi → Ghép nối thiết bị bằng mã ghép nối, rồi nhập mã và cổng mới (cả hai đều đổi sau mỗi lần).',
      pairUnsupported: 'adb trên máy Mac này quá cũ, không ghép nối bằng mã được.',
      failed: (address: string) => `adb không kết nối được tới ${address}.`,
      pairFailed: (address: string) => `adb không ghép nối được với ${address}.`,
      busy: (host: string) => `Đang kết nối tới ${host}. Hãy đợi lần kết nối đó xong.`,
      adbSaid: (message: string) => `adb báo: “${message}”`,
      authUnchecked: 'Sẽ kiểm tra khi thiết bị phản hồi.',
      authWaiting: (name: string) =>
        `${name} đang chờ bạn chọn Cho phép trong hộp thoại “Cho phép gỡ lỗi?”.`,
      authOk: (name: string) =>
        `${name} đã cho phép máy tính này. Thông tin chi tiết, ảnh chụp màn hình, log, ứng dụng, ảnh và cài đặt đều dùng được.`,
      offline: (name: string) => `${name} không còn phản hồi qua Wi‑Fi.`,
      offlineStep:
        'Đánh thức thiết bị, kiểm tra thiết bị vẫn dùng cùng mạng Wi‑Fi, rồi kết nối lại.',
      allowStep:
        'Chọn Cho phép trong hộp thoại “Cho phép gỡ lỗi?” (trên TV thì dùng điều khiển từ xa), và đánh dấu Luôn cho phép từ máy tính này.',
      hostEmpty: 'Hãy nhập địa chỉ IP của thiết bị, đúng như trên màn hình thiết bị.',
      hostInvalid: 'Đó không phải địa chỉ IP. Địa chỉ IP có dạng 192.168.1.20.',
      hostPublic:
        'Chỉ dùng được thiết bị trên mạng cục bộ của bạn: địa chỉ bắt đầu bằng 192.168., 10., 172.16–31., 169.254. hoặc 100.64–127.',
      hostLoopback:
        'Địa chỉ đó là của máy tính này. Hãy nhập địa chỉ của TV hoặc điện thoại, lấy trong cài đặt mạng của thiết bị.',
      hostName:
        'Hãy dùng địa chỉ IP của thiết bị, hoặc một tên dài tối đa 100 ký tự, kết thúc bằng .local, .lan hoặc .home.arpa.',
      portInvalid: 'Cổng là một số từ 1 đến 65535.',
      portEmpty: 'Hãy nhập cổng hiển thị trên màn hình Gỡ lỗi qua Wi‑Fi.',
      codeEmpty: 'Hãy nhập mã gồm sáu chữ số hiển thị trên thiết bị.',
      codeInvalid: 'Mã ghép nối gồm sáu chữ số.',
    },
    nearby: {
      helperOff:
        'Để liệt kê TV và điện thoại trên mạng này, hãy chạy helper cục bộ và ghép nối trang này.',
      empty: 'Không có thiết bị Android nào trên mạng này đang bật gỡ lỗi.',
      allListed: 'Mọi thiết bị tìm thấy trên mạng này đều đã kết nối.',
      emptyStep: 'Hãy bật gỡ lỗi trên thiết bị, rồi làm mới:',
      emptyOther:
        'Đã bật rồi? Hãy kiểm tra thiết bị dùng cùng mạng Wi‑Fi với máy tính này, và máy tính này không bật VPN nào (Cloudflare WARP, VPN công ty).',
      blocked:
        'Máy tính này không truy cập được mạng cục bộ nên không thể tìm thiết bị trên mạng đó. Vấn đề nằm ở máy tính này, không phải ở TV hay điện thoại.',
      blockedVpn:
        'Tắt VPN (Cloudflare WARP, VPN công ty), hoặc cho phép VPN truy cập mạng cục bộ, rồi làm mới.',
      unavailable: 'Helper không thể tìm thiết bị trên mạng này.',
      found: (n: number) => `Tìm thấy ${String(n)} thiết bị trên mạng này.`,
      none: 'Không tìm thấy thiết bị nào trên mạng này.',
      pickHint: 'Chọn một thiết bị để điền sẵn địa chỉ.',
    },
    device: {
      noneIos: 'Hãy cắm iPhone bằng cáp và mở khóa máy.',
      noneIosStep:
        'Khi được hỏi, chạm Tin cậy và nhập mật mã. Nếu không thấy hỏi, mở Finder và chọn iPhone ở thanh bên.',
      noneAndroid: 'Hãy cắm một điện thoại đã bật Gỡ lỗi qua USB.',
      noneAndroidStep:
        'Cài đặt → Giới thiệu về điện thoại → chạm vào Số bản dựng 7 lần, rồi Cài đặt → Hệ thống → Tuỳ chọn cho nhà phát triển → Gỡ lỗi qua USB.',
      trustOk: 'Đã tin cậy.',
      trust: 'iPhone này chưa tin cậy máy Mac này.',
      lockOk: 'Đã mở khóa kể từ lần khởi động lại gần nhất.',
      lock: 'iPhone chưa được mở khóa kể từ lần khởi động lại gần nhất.',
      lockStep: 'Mở khóa bằng mật mã.',
      devModeOk: 'Chế độ nhà phát triển đang bật.',
      devMode: 'Chế độ nhà phát triển đang tắt nên không chụp màn hình được.',
      devModeStep:
        'Cài đặt → Quyền riêng tư & Bảo mật → Chế độ nhà phát triển → Bật (máy sẽ khởi động lại).',
      iosOk: (version: string) => `iOS ${version} được hỗ trợ.`,
      iosOld: 'iOS 14 trở xuống chưa được kiểm thử; một số thông tin có thể bị thiếu.',
      iosNew: (major: number) =>
        `iOS ${String(major)} mới hơn những gì helper này biết; hãy cập nhật helper nếu có gì không hoạt động.`,
      shotsOk: 'Có thể chụp màn hình.',
      shotsOff: 'Không chụp màn hình được trên thiết bị này.',
      ddi: 'iOS 16 trở xuống cần gắn developer disk image của Apple trước khi chụp màn hình.',
      ddiStep:
        'Mở khóa iPhone và chọn iPhone một lần trong cửa sổ Devices and Simulators của Xcode, rồi thử lại.',
      androidAuth: 'Điện thoại đang chờ bạn cho phép gỡ lỗi qua USB.',
      androidAuthStep:
        'Mở khóa và chạm Cho phép trong hộp thoại “Cho phép gỡ lỗi qua USB?” (đánh dấu Luôn cho phép).',
      conflict: 'adb server của Google đang giữ điện thoại này.',
      shared: 'Dùng chung qua adb server của Google.',
      sharedWifi: 'Đã kết nối qua Wi‑Fi bằng adb server của Google.',
      offline: 'Điện thoại không phản hồi.',
      offlineStep: 'Cắm lại cáp cho chắc và tránh dùng hub USB.',
      label: (name: string, what: string) => `${name}: ${what}`,
    },
  },
})
