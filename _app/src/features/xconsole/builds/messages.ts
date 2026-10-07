import { defineMessages } from '@/lib/i18n'

import type { FindingCode } from './model'
import type { AppleDevice, BuildPlatform, ProfileKind } from './types'

/*
  The Builds module's words, in the console's two languages. Only the console's: what a tester
  reads is the install page (templates/), which carries both of its languages in its own markup.

  A finding — what reading a build found wrong with it, or worth knowing — is worded with the
  fix, because the person reading it is about to go back to Android Studio or Xcode and needs
  to know what to do there. Each takes the same values, so the sheet words any of them alike.
*/

/** What a finding's wording may use, already written in the console's language. */
export interface FindingValues {
  /** The finding's own detail (a split's name, the current build's bundle id), or ''. */
  readonly detail: string
  /** The detail as a date, as the console writes dates, or '' when it is not one. */
  readonly date: string
  /** The file's size. */
  readonly size: string
  /** How many devices the profile lists, or '' when any device may install the build. */
  readonly devices: string
  /** The platform of the build the link holds now, when a new version replaces it. */
  readonly platform: string
}

type FindingWords = Readonly<Record<FindingCode, (v: FindingValues) => string>>

/** One language's findings, every one taking the same values, so the sheet words any code alike. */
const findings = (words: FindingWords): FindingWords => words

const PLATFORM_NAMES: Readonly<Record<BuildPlatform, string>> = { android: 'Android', ios: 'iOS' }
const DEVICE_NAMES: Readonly<Record<AppleDevice, string>> = { iphone: 'iPhone', ipad: 'iPad' }

export const BUILD_MESSAGES = defineMessages({
  en: {
    page: {
      upload: 'Upload build',
      loadFailed: 'Could not load the builds',
      indexMissing: 'The build index was not found',
      indexMissingDetail: (path: string) =>
        `There is no ${path} on the master branch, but build/ is not empty. Uploading stays off until the index is back, so the real list cannot be overwritten.`,
      retry: 'Retry',
      builds: 'Builds',
      perPlatform: (android: number, ios: number) =>
        `${String(android)} Android · ${String(ios)} iOS`,
      storage: 'Storage',
      storageOf: 'of 1 GB',
      storageHint: 'GitHub Pages limit',
      lastUpload: 'Last upload',
      liveHint: 'Links go live about a minute after uploading',
      platform: 'Platform',
      platforms: { all: 'All', android: 'Android', ios: 'iOS' },
      search: 'Search builds',
      searchPlaceholder: 'Search name, bundle ID, version…',
      empty: 'No builds yet',
      emptyDetail:
        'Upload an APK or IPA to get an install link for your testers. They open it on their phone and tap Install.',
      uploadFirst: 'Upload the first build',
      noMatch: 'No build matches',
      noMatchDetail: 'Clear the search, or choose All.',
      deleting: (name: string) => `Deleting ${name}…`,
      indexMissingNothingDeleted: (path: string) =>
        `${path} is missing on GitHub — nothing was deleted.`,
      alreadyDeleted: 'Already deleted',
      alreadyDeletedDetail: (name: string) => `${name} was deleted elsewhere.`,
      deleted: 'Deleted',
      deletedDetail: (name: string) => `${name} and its install link are gone.`,
      deleteFailed: 'Delete failed',
      deleteTitle: (name: string) => `Delete ${name}?`,
      deleteDetail:
        'This removes the build, its file and its install page from the site, and testers who open the link get a 404. The file itself stays in the repository’s history.',
      deleteDetailRelease:
        'This removes the build and its install page from the site, and its file from GitHub Releases. Testers who open the link get a 404.',
      releaseLeft: (name: string, tag: string) =>
        `${name} is deleted, but its file’s release ${tag} could not be removed. Delete it on GitHub, under Releases.`,
      delete: 'Delete',
    },

    card: {
      actionsFor: (name: string) => `Actions for ${name}`,
      edit: 'Edit name and notes',
      replace: 'Upload new version',
      download: (extension: string) => `Download the .${extension}`,
      open: 'Open the install page',
      copy: 'Copy the install link',
      showQr: 'Show the QR code',
      delete: 'Delete',
      inRelease: 'GitHub Releases',
    },

    qr: {
      description: 'Scan it with a phone’s camera to open the install page.',
      label: (name: string) => `QR code of the install link for ${name}`,
      mockNote:
        'Mock mode: this link points at this computer’s dev server, which a phone cannot open.',
    },

    sheet: {
      newTitle: 'Upload a build',
      newDescription: 'An APK or IPA becomes an install link for testers, in one commit.',
      replaceTitle: 'Upload a new version',
      replaceDescription: (name: string) =>
        `The new build replaces ${name}; the link testers hold stays the same.`,
      editTitle: 'Edit build',
      editDescription: (name: string) => `Changes publish over ${name}’s install page.`,
      file: 'Build file',
      drop: 'Drop an .apk or .ipa here, or click to choose one',
      dropHint:
        'Up to 2 GB; from 100 MB it goes to GitHub Releases through the Device Lab helper. Android: a universal APK. iOS: Distribute App › Release Testing (Ad Hoc), Debugging (Development) or Enterprise.',
      reading: 'Reading the build…',
      readResult: (subject: string, problems: number, warnings: number) => {
        const found = [
          problems > 0 ? `${String(problems)} ${problems === 1 ? 'problem' : 'problems'}` : '',
          warnings > 0 ? `${String(warnings)} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
        ].filter(Boolean)
        return `Read ${subject}: ${found.length > 0 ? found.join(', ') : 'no problems'}`
      },
      readFailed: 'Could not read this file',
      chooseAnother: 'Choose another file',
      current: 'Current build',
      details: 'Details',
      appName: 'App name',
      appNameHint: 'Shown on the install page.',
      link: 'Link',
      regenerate: 'Make another random link',
      linkFixed: 'Testers already hold this link, so it cannot change.',
      notes: 'Release notes',
      notesPlaceholder: 'What’s new, what to test, a test account…',
      notesHint: 'Optional. Shown on the install page as typed.',
      notesFromCurrent: 'Copied from the current build: update them for this version.',
      count: (length: number, max: number) => `${String(length)} / ${String(max)}`,
      publish: 'Publish',
      save: 'Save & publish',
      done: 'Done',
      hashing: 'Checking the file…',
      uploadingIcon: 'Uploading the icon…',
      uploading: (sent: string, total: string, percent: number) =>
        `Uploading ${sent} of ${total} · ${String(percent)}%`,
      storing: 'Waiting for GitHub to store the file…',
      creatingRelease: 'Creating the GitHub release…',
      uploadingRelease: (sent: string, total: string, percent: number) =>
        `Uploading to GitHub Releases through the helper… ${sent} of ${total} · ${String(percent)}%`,
      uploadingReleaseMock: (sent: string, total: string, percent: number) =>
        `Uploading to the mock’s GitHub Releases… ${sent} of ${total} · ${String(percent)}%`,
      cleaningUp: 'Removing the unfinished release…',
      releaseLeft: (tag: string) =>
        `The unfinished release ${tag} could not be removed. Delete it on GitHub, under Releases.`,
      oldReleaseLeft: (tag: string) =>
        `Published, but the previous version’s release ${tag} could not be removed. Delete it on GitHub, under Releases.`,
      helperNotReady:
        'The Device Lab helper is not ready any more, so nothing was sent. See the helper card, then publish again.',
      committing: 'Publishing…',
      cancelUpload: 'Cancel upload',
      cancelled: 'Upload cancelled',
      cancelledDetail: 'Nothing was published.',
      indexMissingNothingPublished: (path: string) =>
        `${path} is missing on GitHub — nothing was published.`,
      idTaken: (id: string) => `The link /build/${id}/ is already in use. Choose another.`,
      publishFailed: 'Publish failed',
      saved: 'Saved',
      savedDetail: (name: string) => `${name}’s install page updates in about a minute.`,
      tokenRefused:
        'GitHub refused the token. Update it, then publish again — the file and everything typed here are kept.',
      publishedNew: 'Build published',
      publishedReplace: 'New version published',
      liveSoon: 'Live in about a minute, once GitHub Pages has deployed it.',
      liveMock: 'Mock mode: the dev server serves it now, and nothing was committed.',
      share: 'Send testers the link, or let them scan the code.',
      facts: {
        package: 'Package',
        bundleId: 'Bundle ID',
        requires: 'Requires',
        target: 'Target',
        abis: 'ABIs',
        devices: 'Devices',
        distribution: 'Distribution',
        team: 'Team',
        expires: 'Profile expires',
        size: 'Size',
        api: (level: string) => `API ${level}`,
        ios: (version: string) => `iOS ${version}`,
        deviceCount: (count: number) => (count === 1 ? '1 device' : `${String(count)} devices`),
        profile: {
          development: 'Development',
          'ad-hoc': 'Ad Hoc',
          enterprise: 'Enterprise',
          'app-store': 'App Store',
          unknown: 'Unknown',
        } satisfies Readonly<Record<ProfileKind, string>>,
        appleDevices: DEVICE_NAMES,
      },
      helper: {
        title: 'Device Lab helper',
        checking: 'Looking for the helper on this Mac…',
        start: 'Start the helper on this Mac:',
        foreign: (port: number) =>
          `Another program answers on port ${String(port)}, not the helper. Start the helper on another port, then paste the link it prints:`,
        update: (version: string) =>
          `This helper (${version}) cannot upload to GitHub Releases yet. Update it: press Ctrl+C in its window, then run:`,
        unpaired:
          'The helper is running. Paste the link it printed in Terminal, or its token, to pair this page:',
        pasteLabel: 'The helper’s link or token',
        pastePlaceholder: 'https://bauloc.github.io/device/#pair=…',
        pair: 'Pair',
        pairElsewhere:
          'The helper also opens Device Lab with that link: pairing there with “Remember on this computer” works here too.',
        ready: (version: string) =>
          `Helper ${version} connected — the file goes to GitHub Releases.`,
        checkAgain: 'Check again',
        permission:
          'Chrome may ask to let this page reach apps and services on this device: choose Allow.',
        blocked:
          'This browser blocks this page from reaching apps on this Mac. In Chrome or Edge: Site settings › Apps on device › Allow. In Firefox: Settings › Privacy & Security › Device apps and services. Then check again.',
        safari:
          'Safari never lets a secure page reach the helper on this Mac. Open XConsole in Chrome, Edge or Firefox to upload this file.',
        mock: 'Mock mode: the file goes to a simulated GitHub Release in the dev server, without the helper.',
        copyCommand: 'Copy the command',
        pairErrors: {
          format: 'That isn’t a helper link or token. Copy the whole line the helper printed.',
          stale: (tokenId: string) =>
            `That token is from another run of the helper. This helper’s fingerprint is ${tokenId}: use the link it printed last.`,
          foreign: (port: number) =>
            `Something on port ${String(port)} answered but couldn’t prove it is your helper. Nothing was sent.`,
          unreachable: (port: number) => `The helper isn’t answering on 127.0.0.1:${String(port)}.`,
          outdated: 'That helper cannot upload to GitHub Releases yet. Update it first.',
        },
      },
    },

    /** Why an upload through the helper failed, by the code helper.ts gives it. */
    helperErrors: {
      HELPER_UNREACHABLE:
        'The helper stopped answering during the upload. Is its Terminal window still open? Start it again, then publish again.',
      HELPER_UNAUTHORIZED: 'The helper restarted, so this page’s pairing ended. Pair it again.',
      HELPER_OUTDATED: 'This helper cannot upload to GitHub Releases yet. Update it first.',
      HELPER_BAD_REPLY:
        'The helper answered something this page can’t read. Update the helper, then try again.',
      UPLOAD_BUSY: 'The helper is already uploading another file. Wait for it to finish.',
      BAD_REQUEST: 'The helper refused the upload as malformed. Update the helper, then try again.',
      PAYLOAD_TOO_LARGE:
        'The helper refused the file’s size: GitHub takes release files under 2 GB.',
      GITHUB_ASSET_EXISTS:
        'GitHub already has a file of that name in this release. Publish again: it makes a new release.',
      GITHUB_UPLOAD_FAILED: (status: number, message: string) =>
        `GitHub refused the file${message ? `: ${message}` : ''} (HTTP ${String(status)}).`,
      GITHUB_UNREACHABLE:
        'The helper could not reach GitHub. Check this Mac’s internet connection, then try again.',
    },

    platformNames: PLATFORM_NAMES,

    finding: findings({
      NOT_A_BUILD: () =>
        'This is not an .apk or .ipa file. Choose the APK that Android Studio or Gradle built, or the IPA that Xcode exported.',
      TOO_LARGE: (v) =>
        `At ${v.size} it is too big: GitHub refuses files of 2 GB or more, even in GitHub Releases. Make the app smaller (Android: a release build with R8 shrinking, or one APK per ABI; iOS: drop unused assets and frameworks), then upload it again.`,
      VIA_RELEASE: (v) =>
        `At ${v.size} it is over GitHub’s 100 MB limit for a file in the repository, so it goes to GitHub Releases instead (up to 2 GB), uploaded through the Device Lab helper on this Mac. Testers get the same install link.`,
      LARGE: (v) =>
        `At ${v.size} it uploads fine, but it stays in the repository’s history for good, even after the build is deleted.`,
      NO_INFLATE: () =>
        'This browser cannot unzip the file. Use a current Chrome, Edge, Firefox or Safari.',
      APK_INVALID: () =>
        'This APK cannot be read: it is not a zip, or it has no AndroidManifest.xml. Build it again and upload the .apk from app/build/outputs/apk/.',
      APK_SPLIT: (v) =>
        `This APK${v.detail ? ` (${v.detail})` : ''} is one part of a split app, and Android does not install it on its own. Upload a universal APK instead: in Android Studio, Build › Generate Bundle(s) / APK(s) › Generate APK(s); or run bundletool build-apks --mode=universal and upload the universal.apk inside the .apks it writes.`,
      APK_TEST_ONLY: () =>
        'This APK came from Android Studio’s Run button (android:testOnly), and Android refuses to install it from a file. Build it with Build › Generate Bundle(s) / APK(s) › Generate APK(s), or ./gradlew assembleDebug (a release build needs a signingConfig, or it comes out unsigned).',
      APK_UNSIGNED: () =>
        'This APK is not signed, and Android refuses to install it (“App not installed as package appears to be invalid”). Sign it — a signingConfig in Gradle, or apksigner sign — and upload it again. AGP names an unsigned release build app-release-unsigned.apk.',
      APK_V1_ONLY: () =>
        'This APK is signed with v1 (JAR) only, and it targets API 30 or higher, so Android 11 and later refuse to install it (“App not installed as package appears to be invalid”). Keep v2 signing on in Gradle’s signingConfig (v2SigningEnabled, or enableV2Signing), or re-sign it with apksigner, which signs with v2 and later, then upload it again.',
      APK_DEBUGGABLE: () =>
        'A debuggable build: fine for testing, but slower than a release build.',
      IPA_INVALID: () =>
        'This IPA cannot be read: it has no Payload/<App>.app/Info.plist inside. Export it again from Xcode’s Organizer.',
      IPA_NO_PROFILE: () =>
        'There is no provisioning profile inside: the IPA is unsigned, or built for the Simulator. Archive it for a device, then in Xcode’s Organizer choose Distribute App › Release Testing (Ad Hoc), Debugging (Development) or Enterprise.',
      IPA_APP_STORE: () =>
        'Signed for the App Store, so no iPhone installs it from a link. Export it again with Release Testing (Ad Hoc), Debugging (Development) or Enterprise (or send it through TestFlight).',
      IPA_EXPIRED: (v) =>
        `Its provisioning profile expired${v.date ? ` on ${v.date}` : ''}, so the app would not open. Renew the profile, then export and upload it again.`,
      IPA_DEVELOPMENT: (v) =>
        `Development-signed: only ${v.devices === '1' ? 'the one registered device' : v.devices ? `the ${v.devices} registered devices` : 'registered devices'} can install it, and testers on iOS 16 or later must turn on Developer Mode (Settings › Privacy & Security › Developer Mode).`,
      IPA_EXPIRES_SOON: (v) =>
        `Its provisioning profile expires${v.date ? ` on ${v.date}` : ' soon'}, and the app stops opening then. Upload a build with a renewed profile before that.`,
      REPLACE_PLATFORM: (v) =>
        `This link holds the ${v.platform} build, so a new version must be one too. Upload the other platform as a new build.`,
      REPLACE_BUNDLE: (v) =>
        `A different app: the link holds ${v.detail} now. Testers who open it will get this app instead.`,
    }),

    problems: {
      idRequired: 'Link is required',
      idPattern: 'The link may use only a–z, 0–9 and inner hyphens, at most 64 characters',
      nameRequired: 'App name is required',
      nameTooLong: (max: number) => `App name must be at most ${String(max)} characters`,
      notesTooLong: (max: number) => `Release notes must be at most ${String(max)} characters`,
      deleted: (name: string) =>
        `"${name}" was deleted after you opened it, so nothing was published. Close this and check the list.`,
      changed: (name: string) =>
        `"${name}" was changed elsewhere after you opened it, so nothing was published. Close this and open it again to work on the latest version.`,
      notAnIndex: (path: string) => `${path} is not a build index (no "entries" list)`,
    },
  },
  vi: {
    page: {
      upload: 'Tải lên bản build',
      loadFailed: 'Không tải được danh sách bản build',
      indexMissing: 'Không tìm thấy chỉ mục bản build',
      indexMissingDetail: (path: string) =>
        `Nhánh master không có ${path} dù thư mục build/ vẫn có dữ liệu. Chức năng tải lên tạm khóa cho đến khi file trở lại, để danh sách thật không bị ghi đè.`,
      retry: 'Thử lại',
      builds: 'Bản build',
      perPlatform: (android: number, ios: number) =>
        `${String(android)} Android · ${String(ios)} iOS`,
      storage: 'Dung lượng',
      storageOf: 'trên 1 GB',
      storageHint: 'Giới hạn của GitHub Pages',
      lastUpload: 'Lần tải lên gần nhất',
      liveHint: 'Link hoạt động khoảng một phút sau khi tải lên',
      platform: 'Nền tảng',
      platforms: { all: 'Tất cả', android: 'Android', ios: 'iOS' },
      search: 'Tìm bản build',
      searchPlaceholder: 'Tìm theo tên, bundle ID, phiên bản…',
      empty: 'Chưa có bản build nào',
      emptyDetail:
        'Tải lên tệp APK hoặc IPA để có link cài đặt gửi cho tester. Tester mở link trên điện thoại rồi chạm Cài đặt.',
      uploadFirst: 'Tải lên bản build đầu tiên',
      noMatch: 'Không có bản build nào khớp',
      noMatchDetail: 'Hãy xóa từ khóa tìm kiếm hoặc chọn Tất cả.',
      deleting: (name: string) => `Đang xóa ${name}…`,
      indexMissingNothingDeleted: (path: string) =>
        `Không thấy ${path} trên GitHub — chưa xóa gì cả.`,
      alreadyDeleted: 'Đã bị xóa từ trước',
      alreadyDeletedDetail: (name: string) => `${name} đã bị xóa ở nơi khác.`,
      deleted: 'Đã xóa',
      deletedDetail: (name: string) => `Đã xóa ${name} cùng link cài đặt của nó.`,
      deleteFailed: 'Xóa thất bại',
      deleteTitle: (name: string) => `Xóa ${name}?`,
      deleteDetail:
        'Thao tác này xóa bản build, tệp và trang cài đặt của nó khỏi trang web; tester mở link sẽ gặp lỗi 404. Bản thân tệp vẫn còn trong lịch sử của repo.',
      deleteDetailRelease:
        'Thao tác này xóa bản build và trang cài đặt của nó khỏi trang web, và xóa tệp của nó khỏi GitHub Releases. Tester mở link sẽ gặp lỗi 404.',
      releaseLeft: (name: string, tag: string) =>
        `Đã xóa ${name}, nhưng không xóa được release ${tag} chứa tệp của nó. Hãy xóa release đó trên GitHub, trong mục Releases.`,
      delete: 'Xóa',
    },

    card: {
      actionsFor: (name: string) => `Thao tác với ${name}`,
      edit: 'Sửa tên và ghi chú',
      replace: 'Tải lên phiên bản mới',
      download: (extension: string) => `Tải tệp .${extension} về`,
      open: 'Mở trang cài đặt',
      copy: 'Sao chép link cài đặt',
      showQr: 'Hiện mã QR',
      delete: 'Xóa',
      inRelease: 'GitHub Releases',
    },

    qr: {
      description: 'Quét bằng camera điện thoại để mở trang cài đặt.',
      label: (name: string) => `Mã QR của link cài đặt ${name}`,
      mockNote:
        'Chế độ mock: link này trỏ tới dev server trên máy tính này, điện thoại không mở được.',
    },

    sheet: {
      newTitle: 'Tải lên bản build',
      newDescription:
        'Đăng tệp APK hoặc IPA thành link cài đặt cho tester, trong một commit duy nhất.',
      replaceTitle: 'Tải lên phiên bản mới',
      replaceDescription: (name: string) =>
        `Bản mới sẽ thay thế ${name}; link tester đang dùng không đổi.`,
      editTitle: 'Sửa bản build',
      editDescription: (name: string) => `Thay đổi sẽ được đăng đè lên trang cài đặt của ${name}.`,
      file: 'Tệp build',
      drop: 'Thả tệp .apk hoặc .ipa vào đây, hoặc bấm để chọn',
      dropHint:
        'Tối đa 2 GB; từ 100 MB tệp được đưa lên GitHub Releases qua helper của Device Lab. Android: APK universal. iOS: Distribute App › Release Testing (Ad Hoc), Debugging (Development) hoặc Enterprise.',
      reading: 'Đang đọc bản build…',
      readResult: (subject: string, problems: number, warnings: number) => {
        const found = [
          problems > 0 ? `${String(problems)} vấn đề` : '',
          warnings > 0 ? `${String(warnings)} cảnh báo` : '',
        ].filter(Boolean)
        return `Đã đọc ${subject}: ${found.length > 0 ? found.join(', ') : 'không có vấn đề nào'}`
      },
      readFailed: 'Không đọc được tệp này',
      chooseAnother: 'Chọn tệp khác',
      current: 'Bản build hiện tại',
      details: 'Thông tin',
      appName: 'Tên ứng dụng',
      appNameHint: 'Hiển thị trên trang cài đặt.',
      link: 'Link',
      regenerate: 'Tạo link ngẫu nhiên khác',
      linkFixed: 'Tester đã có link này nên không thể đổi.',
      notes: 'Ghi chú phát hành',
      notesPlaceholder: 'Có gì mới, cần thử gì, tài khoản dùng thử…',
      notesHint: 'Không bắt buộc. Hiển thị nguyên văn trên trang cài đặt.',
      notesFromCurrent: 'Chép từ bản hiện tại: hãy cập nhật cho phiên bản này.',
      count: (length: number, max: number) => `${String(length)} / ${String(max)}`,
      publish: 'Đăng',
      save: 'Lưu và đăng',
      done: 'Xong',
      hashing: 'Đang kiểm tra tệp…',
      uploadingIcon: 'Đang tải biểu tượng lên…',
      uploading: (sent: string, total: string, percent: number) =>
        `Đang tải lên ${sent} / ${total} · ${String(percent)}%`,
      storing: 'Đang chờ GitHub lưu tệp…',
      creatingRelease: 'Đang tạo GitHub release…',
      uploadingRelease: (sent: string, total: string, percent: number) =>
        `Đang tải lên GitHub Releases qua helper… ${sent} / ${total} · ${String(percent)}%`,
      uploadingReleaseMock: (sent: string, total: string, percent: number) =>
        `Đang tải lên GitHub Releases giả lập của chế độ mock… ${sent} / ${total} · ${String(percent)}%`,
      cleaningUp: 'Đang xóa release dở dang…',
      releaseLeft: (tag: string) =>
        `Không xóa được release dở dang ${tag}. Hãy xóa nó trên GitHub, trong mục Releases.`,
      oldReleaseLeft: (tag: string) =>
        `Đã đăng, nhưng không xóa được release ${tag} của phiên bản trước. Hãy xóa nó trên GitHub, trong mục Releases.`,
      helperNotReady:
        'Helper của Device Lab không còn sẵn sàng nên chưa gửi gì cả. Hãy xem thẻ helper rồi đăng lại.',
      committing: 'Đang đăng…',
      cancelUpload: 'Hủy tải lên',
      cancelled: 'Đã hủy tải lên',
      cancelledDetail: 'Chưa đăng gì cả.',
      indexMissingNothingPublished: (path: string) =>
        `Không thấy ${path} trên GitHub — chưa đăng gì cả.`,
      idTaken: (id: string) => `Link /build/${id}/ đã được dùng. Hãy chọn link khác.`,
      publishFailed: 'Đăng thất bại',
      saved: 'Đã lưu',
      savedDetail: (name: string) => `Trang cài đặt của ${name} sẽ cập nhật sau khoảng một phút.`,
      tokenRefused:
        'GitHub từ chối token. Hãy cập nhật token rồi đăng lại — tệp và mọi thông tin đã nhập vẫn được giữ.',
      publishedNew: 'Đã đăng bản build',
      publishedReplace: 'Đã đăng phiên bản mới',
      liveSoon: 'Link sẽ hoạt động sau khoảng một phút, khi GitHub Pages triển khai xong.',
      liveMock: 'Chế độ mock: dev server phục vụ ngay, không có gì được commit.',
      share: 'Gửi link cho tester, hoặc cho họ quét mã.',
      facts: {
        package: 'Package',
        bundleId: 'Bundle ID',
        requires: 'Yêu cầu',
        target: 'Target',
        abis: 'ABI',
        devices: 'Thiết bị',
        distribution: 'Phân phối',
        team: 'Team',
        expires: 'Profile hết hạn',
        size: 'Dung lượng',
        api: (level: string) => `API ${level}`,
        ios: (version: string) => `iOS ${version}`,
        deviceCount: (count: number) => `${String(count)} thiết bị`,
        profile: {
          development: 'Development',
          'ad-hoc': 'Ad Hoc',
          enterprise: 'Enterprise',
          'app-store': 'App Store',
          unknown: 'Không rõ',
        },
        appleDevices: DEVICE_NAMES,
      },
      helper: {
        title: 'Helper của Device Lab',
        checking: 'Đang tìm helper trên máy Mac này…',
        start: 'Hãy chạy helper trên máy Mac này:',
        foreign: (port: number) =>
          `Một chương trình khác đang phản hồi trên cổng ${String(port)}, không phải helper. Hãy chạy helper trên cổng khác, rồi dán link mà nó in ra:`,
        update: (version: string) =>
          `Helper này (${version}) chưa tải lên GitHub Releases được. Hãy cập nhật: bấm Ctrl+C trong cửa sổ của helper, rồi chạy:`,
        unpaired:
          'Helper đang chạy. Hãy dán link mà helper đã in ra trong Terminal, hoặc token của nó, để ghép nối trang này:',
        pasteLabel: 'Link hoặc token của helper',
        pastePlaceholder: 'https://bauloc.github.io/device/#pair=…',
        pair: 'Ghép nối',
        pairElsewhere:
          'Helper cũng mở Device Lab bằng link đó: ghép nối ở đó với “Ghi nhớ trên máy tính này” thì ở đây cũng dùng được.',
        ready: (version: string) =>
          `Đã kết nối helper ${version} — tệp sẽ được đưa lên GitHub Releases.`,
        checkAgain: 'Kiểm tra lại',
        permission:
          'Chrome có thể hỏi xem có cho trang này truy cập ứng dụng và dịch vụ trên thiết bị này không: hãy chọn Cho phép.',
        blocked:
          'Trình duyệt này không cho trang này truy cập ứng dụng trên máy Mac này. Trong Chrome hoặc Edge: Cài đặt trang web › Ứng dụng trên thiết bị › Cho phép. Trong Firefox: Cài đặt › Riêng tư & bảo mật › Ứng dụng và dịch vụ thiết bị. Rồi kiểm tra lại.',
        safari:
          'Safari không bao giờ cho một trang bảo mật kết nối với helper trên máy Mac này. Hãy mở XConsole bằng Chrome, Edge hoặc Firefox để tải tệp này lên.',
        mock: 'Chế độ mock: tệp được đưa lên GitHub Release giả lập trong dev server, không cần helper.',
        copyCommand: 'Sao chép lệnh',
        pairErrors: {
          format:
            'Đây không phải link hay token của helper. Hãy sao chép nguyên dòng mà helper đã in ra.',
          stale: (tokenId: string) =>
            `Token này thuộc một lần chạy khác của helper. Vân tay của helper này là ${tokenId}: hãy dùng link mà nó in ra gần nhất.`,
          foreign: (port: number) =>
            `Một chương trình trên cổng ${String(port)} có phản hồi nhưng không chứng minh được đó là helper của bạn. Chưa gửi gì cả.`,
          unreachable: (port: number) => `Helper không phản hồi tại 127.0.0.1:${String(port)}.`,
          outdated: 'Helper đó chưa tải lên GitHub Releases được. Hãy cập nhật helper trước.',
        },
      },
    },

    helperErrors: {
      HELPER_UNREACHABLE:
        'Helper ngừng phản hồi khi đang tải lên. Cửa sổ Terminal của helper còn mở không? Hãy chạy lại helper rồi đăng lại.',
      HELPER_UNAUTHORIZED:
        'Helper đã khởi động lại nên trang này không còn được ghép nối. Hãy ghép nối lại.',
      HELPER_OUTDATED: 'Helper này chưa tải lên GitHub Releases được. Hãy cập nhật helper trước.',
      HELPER_BAD_REPLY:
        'Helper trả về nội dung mà trang này không đọc được. Hãy cập nhật helper rồi thử lại.',
      UPLOAD_BUSY: 'Helper đang tải lên một tệp khác. Hãy chờ tệp đó xong.',
      BAD_REQUEST:
        'Helper từ chối yêu cầu tải lên vì sai định dạng. Hãy cập nhật helper rồi thử lại.',
      PAYLOAD_TOO_LARGE:
        'Helper từ chối dung lượng của tệp: GitHub chỉ nhận tệp release dưới 2 GB.',
      GITHUB_ASSET_EXISTS:
        'Release này trên GitHub đã có tệp trùng tên. Hãy đăng lại: mỗi lần đăng sẽ tạo một release mới.',
      GITHUB_UPLOAD_FAILED: (status: number, message: string) =>
        `GitHub từ chối tệp${message ? `: ${message}` : ''} (HTTP ${String(status)}).`,
      GITHUB_UNREACHABLE:
        'Helper không kết nối được tới GitHub. Hãy kiểm tra kết nối internet của máy Mac này rồi thử lại.',
    },

    platformNames: PLATFORM_NAMES,

    finding: findings({
      NOT_A_BUILD: () =>
        'Đây không phải tệp .apk hay .ipa. Hãy chọn tệp APK do Android Studio hoặc Gradle tạo ra, hoặc tệp IPA xuất từ Xcode.',
      TOO_LARGE: (v) =>
        `Tệp nặng ${v.size}, quá lớn: GitHub từ chối tệp từ 2 GB trở lên, kể cả trong GitHub Releases. Hãy giảm dung lượng ứng dụng (Android: bản release có R8, hoặc mỗi ABI một APK; iOS: bỏ tài nguyên, framework không dùng) rồi tải lên lại.`,
      VIA_RELEASE: (v) =>
        `Tệp nặng ${v.size}, vượt giới hạn 100 MB cho mỗi tệp trong repo của GitHub, nên sẽ được đưa lên GitHub Releases (tối đa 2 GB) qua helper của Device Lab trên máy Mac này. Tester vẫn dùng link cài đặt như bình thường.`,
      LARGE: (v) =>
        `Tệp nặng ${v.size}: vẫn tải lên được, nhưng sẽ nằm mãi trong lịch sử của repo, kể cả khi đã xóa bản build.`,
      NO_INFLATE: () =>
        'Trình duyệt này không giải nén được tệp. Hãy dùng Chrome, Edge, Firefox hoặc Safari bản mới.',
      APK_INVALID: () =>
        'Không đọc được APK này: tệp không phải dạng zip hoặc thiếu AndroidManifest.xml. Hãy build lại và tải lên tệp .apk trong app/build/outputs/apk/.',
      APK_SPLIT: (v) =>
        `APK này${v.detail ? ` (${v.detail})` : ''} chỉ là một phần của ứng dụng dạng split, Android không cài riêng nó được. Hãy tải lên APK universal: trong Android Studio, chọn Build › Generate Bundle(s) / APK(s) › Generate APK(s); hoặc chạy bundletool build-apks --mode=universal rồi tải lên tệp universal.apk nằm trong tệp .apks mà lệnh này tạo ra.`,
      APK_TEST_ONLY: () =>
        'APK này tạo từ nút Run của Android Studio (android:testOnly), Android sẽ từ chối cài từ tệp. Hãy build bằng Build › Generate Bundle(s) / APK(s) › Generate APK(s), hoặc ./gradlew assembleDebug (bản release cần có signingConfig, nếu không sẽ ra bản chưa ký).',
      APK_UNSIGNED: () =>
        'APK này chưa được ký nên Android sẽ không cài (“Chưa cài đặt được ứng dụng do gói có vẻ không hợp lệ.”). Hãy ký APK (signingConfig trong Gradle, hoặc apksigner sign) rồi tải lên lại. AGP đặt tên bản release chưa ký là app-release-unsigned.apk.',
      APK_V1_ONLY: () =>
        'APK này chỉ được ký bằng v1 (JAR) trong khi nhắm tới API 30 trở lên, nên Android 11 trở lên sẽ từ chối cài (“Chưa cài đặt được ứng dụng do gói có vẻ không hợp lệ.”). Hãy bật lại ký v2 trong signingConfig của Gradle (v2SigningEnabled, hoặc enableV2Signing), hoặc ký lại bằng apksigner (ký v2 trở lên) rồi tải lên lại.',
      APK_DEBUGGABLE: () => 'Bản build debug: dùng để thử thì ổn, nhưng chạy chậm hơn bản release.',
      IPA_INVALID: () =>
        'Không đọc được IPA này: bên trong không có Payload/<App>.app/Info.plist. Hãy xuất lại từ Organizer của Xcode.',
      IPA_NO_PROFILE: () =>
        'Bên trong không có provisioning profile: IPA chưa được ký, hoặc là bản cho Simulator. Hãy archive cho thiết bị thật, rồi trong Organizer của Xcode chọn Distribute App › Release Testing (Ad Hoc), Debugging (Development) hoặc Enterprise.',
      IPA_APP_STORE: () =>
        'Bản này được ký để lên App Store nên không iPhone nào cài được qua link. Hãy xuất lại với Release Testing (Ad Hoc), Debugging (Development) hoặc Enterprise (hoặc gửi qua TestFlight).',
      IPA_EXPIRED: (v) =>
        `Provisioning profile đã hết hạn${v.date ? ` từ ${v.date}` : ''} nên ứng dụng sẽ không mở được. Hãy gia hạn profile, rồi xuất và tải lên lại.`,
      IPA_DEVELOPMENT: (v) =>
        `Bản ký Development: chỉ ${v.devices ? `${v.devices} ` : ''}thiết bị đã đăng ký mới cài được, và tester dùng iOS 16 trở lên phải bật Chế độ nhà phát triển (Cài đặt › Quyền riêng tư & Bảo mật › Chế độ nhà phát triển).`,
      IPA_EXPIRES_SOON: (v) =>
        `Provisioning profile sắp hết hạn${v.date ? ` (${v.date})` : ''}, khi đó ứng dụng sẽ không mở được nữa. Hãy tải lên bản có profile đã gia hạn trước thời điểm này.`,
      REPLACE_PLATFORM: (v) =>
        `Link này đang chứa bản build ${v.platform}, nên phiên bản mới cũng phải là ${v.platform}. Hãy tải nền tảng kia lên thành một bản build mới.`,
      REPLACE_BUNDLE: (v) =>
        `Đây là một ứng dụng khác: link đang chứa ${v.detail}. Tester mở link sẽ nhận ứng dụng này thay thế.`,
    }),

    problems: {
      idRequired: 'Cần nhập link',
      idPattern: 'Link chỉ gồm a–z, 0–9 và dấu gạch nối ở giữa, tối đa 64 ký tự',
      nameRequired: 'Cần nhập tên ứng dụng',
      nameTooLong: (max: number) => `Tên ứng dụng tối đa ${String(max)} ký tự`,
      notesTooLong: (max: number) => `Ghi chú phát hành tối đa ${String(max)} ký tự`,
      deleted: (name: string) =>
        `"${name}" đã bị xóa sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại và kiểm tra danh sách.`,
      changed: (name: string) =>
        `"${name}" đã được sửa ở nơi khác sau khi bạn mở, nên chưa đăng gì cả. Hãy đóng lại rồi mở lại để làm trên bản mới nhất.`,
      notAnIndex: (path: string) =>
        `${path} không phải chỉ mục bản build (thiếu danh sách "entries")`,
    },
  },
})
