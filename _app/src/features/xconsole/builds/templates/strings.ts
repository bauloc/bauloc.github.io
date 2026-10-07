import { defineMessages } from '@/lib/i18n'

/*
  What the install page says, in both of the site's languages. The page carries both at once
  (see `both`): it is written once, at upload, and read by testers who may read either, so the
  language is chosen where it is read — by the same saved choice as the rest of the site.

  Messages are HTML: the few tags in them are constants, a message that takes a value is handed
  it already escaped, and a no-break space keeps each dash from starting a line. The Android installer's dialogs are quoted in AOSP's own words
  (PackageInstaller and Settings, en and vi), so a tester recognises them on their screen.
*/

export const INSTALL_COPY = defineMessages({
  en: {
    install: 'Install',
    version: (version: string) => `Version ${version}`,
    releaseNotes: 'Release notes',
    details: 'Details',
    howTo: 'How to install',
    scanTitle: 'Scan to install',
    scanCaption: 'Scan with your phone’s camera',
    copyLink: 'Copy link',
    copyHash: 'Copy SHA-256',
    copied: 'Copied',

    package: 'Package',
    bundleId: 'Bundle ID',
    versionLabel: 'Version',
    build: 'Build',
    requires: 'Requires',
    target: 'Target SDK',
    abis: 'ABIs',
    anyAbi: 'Any',
    size: 'Size',
    sha256: 'SHA-256',
    uploaded: 'Uploaded',
    devices: 'Devices',
    distribution: 'Distribution',
    team: 'Team',
    profileExpires: 'Profile expires',
    expiredTag: 'Expired',
    unknown: 'Unknown',
    deviceCount: (count: number) => (count === 1 ? '1 device' : `${String(count)} devices`),

    wrongIos: 'This build is for iPhone and iPad&nbsp;— open this page on one to install it.',
    wrongAndroid: 'This build is for Android&nbsp;— open this page on an Android phone or tablet.',
    desktopIos: 'To install, scan the QR code with your iPhone or iPad.',
    desktopAndroid: 'To install, scan the QR code with your Android phone.',
    download: (extension: string) => `Download .${extension}`,
    safari: 'To install, open this page in Safari.',
    safariDetail:
      'Other browsers, and the browsers inside apps, cannot install apps. Copy the link and paste it into Safari.',
    chrome: 'If the download doesn’t start, open this page in Chrome.',
    chromeDetail:
      'The browsers inside apps often block downloads. Copy the link and paste it into Chrome.',
    expired: (date: string) =>
      `This build’s provisioning profile expired on ${date}, so it can no longer be installed or opened. Ask the developer for a new build.`,
    afterIos:
      'Now tap <b>Install</b> in the dialog, then go to your Home Screen: the app appears there while it downloads.',
    afterAndroid:
      'Downloading… When it finishes, open the file from the notification to install it.',

    androidTap: 'Tap <b>Install</b>.',
    androidOpen: 'Open the downloaded file from the notification or your Files app.',
    androidUnknownSources:
      'If Android says “For your security, your phone currently isn’t allowed to install unknown apps from this source”, tap <b>Settings</b>, turn on <b>Allow from this source</b>, go back and tap <b>Install</b>.',
    androidConflict:
      '“App not installed as package conflicts with an existing package” means an older copy signed with another key is installed&nbsp;— uninstall it first.',
    iosSafari: 'Open this page in <b>Safari</b>.',
    iosTap: 'Tap <b>Install</b>, then <b>Install</b> in the dialog.',
    iosWait: 'Go to the Home Screen and wait while the app downloads.',
    developerMode:
      'On iOS 16 or later, turn on <b>Settings › Privacy &amp; Security › Developer Mode</b> and restart when asked, then open the app.',
    trustTeam: (team: string) =>
      `Before opening it, go to <b>Settings › General › VPN &amp; Device Management</b>, tap ${team ? `“${team}”` : 'the developer’s name'} and trust it.`,
    registeredOnly: (count: number | null) =>
      `Only ${count === null ? 'registered devices' : count === 1 ? 'the one registered device' : `the ${String(count)} registered devices`} can install it&nbsp;— “Unable to Install” means this device is not registered: send its UDID to the developer.`,
  },
  vi: {
    install: 'Cài đặt',
    version: (version: string) => `Phiên bản ${version}`,
    releaseNotes: 'Ghi chú phát hành',
    details: 'Chi tiết',
    howTo: 'Cách cài đặt',
    scanTitle: 'Quét mã để cài đặt',
    scanCaption: 'Quét bằng camera điện thoại',
    copyLink: 'Sao chép link',
    copyHash: 'Sao chép SHA-256',
    copied: 'Đã sao chép',

    package: 'Tên gói',
    bundleId: 'Bundle ID',
    versionLabel: 'Phiên bản',
    build: 'Số build',
    requires: 'Yêu cầu',
    target: 'SDK đích',
    abis: 'ABI',
    anyAbi: 'Mọi loại',
    size: 'Dung lượng',
    sha256: 'SHA-256',
    uploaded: 'Ngày tải lên',
    devices: 'Thiết bị',
    distribution: 'Phân phối',
    team: 'Nhóm',
    profileExpires: 'Hồ sơ hết hạn',
    expiredTag: 'Đã hết hạn',
    unknown: 'Không rõ',
    deviceCount: (count: number) => `${String(count)} thiết bị`,

    wrongIos:
      'Bản build này dành cho iPhone và iPad&nbsp;— hãy mở trang này trên iPhone hoặc iPad để cài.',
    wrongAndroid:
      'Bản build này dành cho Android&nbsp;— hãy mở trang này trên điện thoại hoặc máy tính bảng Android.',
    desktopIos: 'Để cài đặt, hãy quét mã QR bằng iPhone hoặc iPad.',
    desktopAndroid: 'Để cài đặt, hãy quét mã QR bằng điện thoại Android.',
    download: (extension: string) => `Tải tệp .${extension}`,
    safari: 'Để cài đặt, hãy mở trang này bằng Safari.',
    safariDetail:
      'Trình duyệt khác và trình duyệt bên trong ứng dụng không cài được ứng dụng. Hãy sao chép link rồi dán vào Safari.',
    chrome: 'Nếu tệp không tự tải về, hãy mở trang này bằng Chrome.',
    chromeDetail:
      'Trình duyệt bên trong ứng dụng thường chặn tải tệp. Hãy sao chép link rồi dán vào Chrome.',
    expired: (date: string) =>
      `Hồ sơ cấp phép (provisioning profile) của bản build này đã hết hạn vào ${date} nên không cài đặt hay mở được nữa. Hãy xin nhà phát triển bản build mới.`,
    afterIos:
      'Giờ hãy chạm <b>Cài đặt</b> trong hộp thoại, rồi về Màn hình chính: ứng dụng sẽ hiện ở đó trong lúc tải về.',
    afterAndroid: 'Đang tải về… Khi xong, hãy mở tệp từ thông báo để cài đặt.',

    androidTap: 'Chạm <b>Cài đặt</b>.',
    androidOpen: 'Mở tệp vừa tải từ thông báo hoặc ứng dụng Files.',
    androidUnknownSources:
      'Nếu Android báo “Để bảo mật, điện thoại của bạn hiện không được phép cài đặt các ứng dụng không xác định từ nguồn này”, chạm <b>Cài đặt</b>, bật <b>Cho phép từ nguồn này</b> rồi quay lại chạm <b>Cài đặt</b>.',
    androidConflict:
      'Lỗi “Chưa cài đặt được ứng dụng do gói xung đột với một gói hiện có” nghĩa là máy đang có bản cũ ký bằng khóa khác&nbsp;— gỡ bản đó trước.',
    iosSafari: 'Mở trang này bằng <b>Safari</b>.',
    iosTap: 'Chạm <b>Cài đặt</b>, rồi chạm <b>Cài đặt</b> trong hộp thoại.',
    iosWait: 'Về Màn hình chính và đợi ứng dụng tải về xong.',
    developerMode:
      'Trên iOS 16 trở lên, bật <b>Cài đặt › Quyền riêng tư &amp; Bảo mật › Chế độ nhà phát triển</b> và khởi động lại khi được hỏi, rồi mở ứng dụng.',
    trustTeam: (team: string) =>
      `Trước khi mở, vào <b>Cài đặt › Cài đặt chung › Quản lý VPN &amp; thiết bị</b>, chạm ${team ? `“${team}”` : 'tên nhà phát triển'} rồi chọn Tin cậy.`,
    registeredOnly: (count: number | null) =>
      `Chỉ ${count === null ? 'các thiết bị đã đăng ký' : `${String(count)} thiết bị đã đăng ký`} mới cài được&nbsp;— lỗi “Không thể cài đặt” nghĩa là máy này chưa được đăng ký: hãy gửi UDID của máy cho nhà phát triển.`,
  },
})

export type InstallCopy = (typeof INSTALL_COPY)['en']

/** Which message of the copy: `(t) => t.install`. */
export type Pick = (t: InstallCopy) => string

/**
 * One message in both languages, each in its own span; the page's CSS shows the one html[lang]
 * names. Words that are the same in both (`SHA-256`, `Bundle ID`) are written once.
 */
export function both(en: string, vi: string): string {
  if (en === vi) return en
  return `<span class="en" lang="en">${en}</span><span class="vi" lang="vi">${vi}</span>`
}

/** A message of the page's copy in both languages: `say((t) => t.install)`. */
export function say(pick: Pick): string {
  return both(pick(INSTALL_COPY.en), pick(INSTALL_COPY.vi))
}
