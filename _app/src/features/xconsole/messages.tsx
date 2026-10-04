import type { ReactNode } from 'react'

import { defineMessages } from '@/lib/i18n'

import { formatDate } from './term-privacy/templates/format'

/*
  The console's words. Only the console's: the Terms and Privacy pages it publishes are
  English documents whose bytes are pinned (templates/), whatever language the console is in.
  So are the answers that go into them, which is why the Vietnamese form asks for English.

  A message with markup in it is a function that takes the marked-up parts, so each language
  keeps its own word order around them.
*/

/** `2026-03-19` as the console shows a date: the legacy `19-Mar-2026`, or `19/03/2026`. */
function viDate(isoDate: string): string {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate) ?? []
  return formatDate(isoDate) && y && m && d ? `${d}/${m}/${y}` : ''
}

export const XCONSOLE_MESSAGES = defineMessages({
  en: {
    module: {
      termPrivacy: {
        title: 'Term & Privacy',
        description: 'Legal pages for App Store and Google Play submissions.',
      },
      iptv: {
        title: 'IPTV',
        description: 'Mirror an upstream M3U playlist to bauloc.github.io/iptv.',
      },
    },
    modules: 'Modules',
    repository: 'Repository on GitHub',
    settings: 'Settings',
    mock: 'Mock',
    mockDetail: ' data — nothing is committed',
    loading: 'Loading',
    unknownError: 'Unknown error',
    cancel: 'Cancel',
    updateToken: 'Update token',

    token: {
      connectTitle: 'Connect to GitHub',
      connectDescription:
        'XConsole publishes by committing to the repository, so it needs a Personal Access Token.',
      settingsDescription: 'The token XConsole commits with. It is stored in this browser only.',
      label: 'Personal Access Token',
      placeholder: 'github_pat_… or ghp_…',
      hint: (parts: { permission: ReactNode; repo: ReactNode; scope: ReactNode }) => (
        <>
          Fine-grained with {parts.permission} on {parts.repo}, or classic with the {parts.scope}{' '}
          scope.
        </>
      ),
      create: 'Create one',
      missing: 'Enter a token to continue.',
      logOut: 'Log out',
      connect: 'Connect',
      save: 'Save',
    },

    refused: 'GitHub refused the token',
    refusedDetail: 'It may have expired or lost the repo scope.',

    iptv: {
      readFailed: 'Could not read the last sync',
      invalidSource: 'Invalid source',
      invalidSourceDetail: 'The URL must start with http:// or https://',
      fetching: 'Fetching the playlist…',
      networkError: 'Network error',
      fetchFailed: (reason: string) => `${reason} — check the URL, and that it allows CORS.`,
      committing: (channels: string) => `Committing ${channels} channels…`,
      synced: 'Synced',
      syncedDetail: (channels: string) => `${channels} channels are live at /iptv.`,
      syncFailed: 'Sync failed',
      syncNow: 'Sync now',
      channels: 'Channels',
      lastSync: 'Last sync',
      source: 'Source',
      sourcePlaylist: 'Source playlist',
      sourceDescription: 'An M3U or M3U8 URL. Syncing copies it to /iptv in one commit.',
      resetTitle: 'Reset to the default source',
      reset: 'Reset',
      defaultSource: 'Default: giangnam0201/All-In-One-IPTV.',
      publicPlaylist: 'Public playlist',
      publicDescription: 'Add this URL to any IPTV player.',
      copyUrl: 'Copy the playlist URL',
      open: 'Open the playlist',
    },

    pages: {
      newPage: 'New page',
      deleting: (app: string) => `Deleting ${app}…`,
      indexMissingNothingDeleted: (path: string) =>
        `${path} is missing on GitHub — nothing was deleted.`,
      alreadyDeleted: 'Already deleted',
      alreadyDeletedDetail: (app: string) => `${app} was deleted elsewhere.`,
      deleted: 'Deleted',
      deletedDetail: (app: string) => `${app} and both of its pages are gone.`,
      deleteFailed: 'Delete failed',
      indexMissing: 'The page index was not found',
      loadFailed: 'Could not load the pages',
      indexMissingDetail: (path: string) =>
        `There is no ${path} on the master branch. Publishing stays off until it is back, so the real list cannot be overwritten.`,
      retry: 'Retry',
      apps: 'Apps',
      pagesLive: (count: number) => `${String(count)} pages live`,
      platforms: 'Platforms',
      lastPublished: 'Last published',
      goLive: 'Pages go live about a minute after publishing',
      empty: 'No pages yet',
      emptyDetail:
        'Create the Terms of Service and Privacy Policy an app needs for the App Store and Google Play.',
      createFirst: 'Create the first page',
      deleteTitle: (app: string) => `Delete ${app}?`,
      deleteDetail:
        'This removes its saved answers and both published pages from GitHub. Any store listing that links to them will show a 404.',
      delete: 'Delete',
      terms: 'Terms',
      privacy: 'Privacy',
      copyUrl: (page: string) => `Copy the ${page} URL`,
      actionsFor: (app: string) => `Actions for ${app}`,
      edit: 'Edit',
      openTerms: 'Open Terms',
      openPrivacy: 'Open Privacy',
    },

    sheet: {
      general: 'General info',
      generalSub: 'Terms & Privacy',
      privacyDetails: 'Privacy details',
      privacyDetailsSub: 'Privacy Policy',
      loadFailed: 'Could not load the page',
      noAnswers: (slug: string) => `No saved answers for "${slug}"`,
      updating: 'Updating…',
      publishing: 'Publishing…',
      indexMissingNothingPublished: (path: string) =>
        `${path} is missing on GitHub — nothing was published.`,
      slugTaken: (slug: string) => `A page with the slug "${slug}" already exists. Choose another.`,
      updated: 'Updated',
      published: 'Published',
      liveSoon: (links: { terms: ReactNode; privacy: ReactNode }) => (
        <>
          Live in about a minute: {links.terms} · {links.privacy}
        </>
      ),
      publishFailed: 'Publish failed',
      editTitle: 'Edit Terms & Privacy',
      newTitle: 'New Terms & Privacy page',
      editDescription: (slug: string) => `Changes publish over ${slug}.`,
      newDescription: 'Both pages publish together in one commit.',
      /** The pages are English, so are the answers that go into them; English needs no reminder. */
      answersInEnglish: '',
      tokenRefused:
        'GitHub refused the token. Update it, then publish again — your answers are kept.',
      app: 'App',
      appName: 'App name',
      appNamePlaceholder: 'e.g. Habit Tracker',
      slug: 'URL slug',
      slugFixed: 'The slug is the published URL, so it cannot change.',
      platform: 'Platform',
      appDescription: 'App description',
      appDescriptionPlaceholder: "Briefly describe what your app does and who it's for.",
      developer: 'Developer / company',
      name: 'Name',
      email: 'Email',
      website: 'Website',
      websitePlaceholder: 'https://… (optional)',
      country: 'Country',
      effectiveDate: 'Effective date',
      date: 'Date',
      dataCollection: 'Data collection',
      dataCollected: 'Data collected',
      dataCollectedHint: 'Leave all off if the app collects nothing.',
      data: {
        name: 'Name',
        email: 'Email',
        location: 'Location',
        device_info: 'Device Info',
        usage_data: 'Usage Data',
        camera: 'Camera',
        microphone: 'Microphone',
        contacts: 'Contacts',
        payment: 'Payment Info',
      },
      dataUsedFor: 'How data is used',
      dataUsedForPlaceholder:
        'e.g. To sync your data across devices and improve the app experience.',
      thirdParty: 'Third-party services',
      thirdPartyHint: 'Comma separated. Leave empty if none.',
      thirdPartyPlaceholder: 'e.g. Firebase, Google Analytics',
      appSettings: 'App settings',
      accountCreation: 'App allows account creation',
      children: 'App is directed at children under 13',
      contact: 'Contact',
      contactEmail: 'Privacy contact email',
      preview: 'Preview',
      termsOfService: 'Terms of Service',
      privacyPolicy: 'Privacy Policy',
      back: 'Back',
      next: 'Next',
      savePublish: 'Save & publish',
      publish: 'Publish',
    },

    date: formatDate,
  },
  vi: {
    module: {
      termPrivacy: {
        title: 'Điều khoản & Bảo mật',
        description: 'Trang pháp lý để nộp ứng dụng lên App Store và Google Play.',
      },
      iptv: {
        title: 'IPTV',
        description: 'Chép một playlist M3U từ nguồn về bauloc.github.io/iptv.',
      },
    },
    modules: 'Mô-đun',
    repository: 'Repo trên GitHub',
    settings: 'Cài đặt',
    mock: 'Mock',
    mockDetail: ' — dữ liệu thử, không commit gì',
    loading: 'Đang tải',
    unknownError: 'Lỗi không xác định',
    cancel: 'Hủy',
    updateToken: 'Cập nhật token',

    token: {
      connectTitle: 'Kết nối GitHub',
      connectDescription:
        'XConsole đăng trang bằng cách commit vào repo, nên cần một Personal Access Token.',
      settingsDescription:
        'Token XConsole dùng để commit. Token chỉ được lưu trong trình duyệt này.',
      label: 'Personal Access Token',
      placeholder: 'github_pat_… hoặc ghp_…',
      hint: (parts: { permission: ReactNode; repo: ReactNode; scope: ReactNode }) => (
        <>
          Loại fine-grained có quyền {parts.permission} trên {parts.repo}, hoặc loại classic có
          scope {parts.scope}.
        </>
      ),
      create: 'Tạo token',
      missing: 'Nhập token để tiếp tục.',
      logOut: 'Đăng xuất',
      connect: 'Kết nối',
      save: 'Lưu',
    },

    refused: 'GitHub từ chối token',
    refusedDetail: 'Token có thể đã hết hạn hoặc mất quyền repo.',

    iptv: {
      readFailed: 'Không đọc được lần đồng bộ gần nhất',
      invalidSource: 'Nguồn không hợp lệ',
      invalidSourceDetail: 'URL phải bắt đầu bằng http:// hoặc https://',
      fetching: 'Đang tải playlist…',
      networkError: 'Lỗi mạng',
      fetchFailed: (reason: string) => `${reason} — kiểm tra URL và nguồn có cho phép CORS không.`,
      committing: (channels: string) => `Đang commit ${channels} kênh…`,
      synced: 'Đã đồng bộ',
      syncedDetail: (channels: string) => `${channels} kênh đã có tại /iptv.`,
      syncFailed: 'Đồng bộ thất bại',
      syncNow: 'Đồng bộ ngay',
      channels: 'Số kênh',
      lastSync: 'Đồng bộ gần nhất',
      source: 'Nguồn',
      sourcePlaylist: 'Playlist nguồn',
      sourceDescription:
        'URL M3U hoặc M3U8. Khi đồng bộ, playlist được chép về /iptv trong một commit.',
      resetTitle: 'Về nguồn mặc định',
      reset: 'Đặt lại',
      defaultSource: 'Mặc định: giangnam0201/All-In-One-IPTV.',
      publicPlaylist: 'Playlist công khai',
      publicDescription: 'Thêm URL này vào trình phát IPTV bất kỳ.',
      copyUrl: 'Sao chép URL playlist',
      open: 'Mở playlist',
    },

    pages: {
      newPage: 'Trang mới',
      deleting: (app: string) => `Đang xóa ${app}…`,
      indexMissingNothingDeleted: (path: string) =>
        `Không thấy ${path} trên GitHub — chưa xóa gì cả.`,
      alreadyDeleted: 'Đã bị xóa từ trước',
      alreadyDeletedDetail: (app: string) => `${app} đã bị xóa ở nơi khác.`,
      deleted: 'Đã xóa',
      deletedDetail: (app: string) => `Đã xóa ${app} cùng cả hai trang của ứng dụng.`,
      deleteFailed: 'Xóa thất bại',
      indexMissing: 'Không tìm thấy chỉ mục trang',
      loadFailed: 'Không tải được danh sách trang',
      indexMissingDetail: (path: string) =>
        `Nhánh master không có ${path}. Chức năng đăng tạm khóa cho đến khi file trở lại, để danh sách thật không bị ghi đè.`,
      retry: 'Thử lại',
      apps: 'Ứng dụng',
      pagesLive: (count: number) => `${String(count)} trang đang chạy`,
      platforms: 'Nền tảng',
      lastPublished: 'Lần đăng gần nhất',
      goLive: 'Trang lên sóng khoảng một phút sau khi đăng',
      empty: 'Chưa có trang nào',
      emptyDetail:
        'Tạo trang Điều khoản dịch vụ và Chính sách quyền riêng tư mà ứng dụng cần khi lên App Store và Google Play.',
      createFirst: 'Tạo trang đầu tiên',
      deleteTitle: (app: string) => `Xóa ${app}?`,
      deleteDetail:
        'Thao tác này xóa câu trả lời đã lưu và cả hai trang đã đăng khỏi GitHub. Trang cửa hàng nào đang liên kết tới chúng sẽ báo lỗi 404.',
      delete: 'Xóa',
      terms: 'Điều khoản',
      privacy: 'Bảo mật',
      copyUrl: (page: string) => `Sao chép URL ${page}`,
      actionsFor: (app: string) => `Thao tác với ${app}`,
      edit: 'Sửa',
      openTerms: 'Mở trang Điều khoản',
      openPrivacy: 'Mở trang Bảo mật',
    },

    sheet: {
      general: 'Thông tin chung',
      generalSub: 'Điều khoản & Bảo mật',
      privacyDetails: 'Chi tiết quyền riêng tư',
      privacyDetailsSub: 'Chính sách quyền riêng tư',
      loadFailed: 'Không tải được trang',
      noAnswers: (slug: string) => `Không có câu trả lời đã lưu cho "${slug}"`,
      updating: 'Đang cập nhật…',
      publishing: 'Đang đăng…',
      indexMissingNothingPublished: (path: string) =>
        `Không thấy ${path} trên GitHub — chưa đăng gì cả.`,
      slugTaken: (slug: string) => `Đã có trang với slug "${slug}". Hãy chọn slug khác.`,
      updated: 'Đã cập nhật',
      published: 'Đã đăng',
      liveSoon: (links: { terms: ReactNode; privacy: ReactNode }) => (
        <>
          Lên sóng sau khoảng một phút: {links.terms} · {links.privacy}
        </>
      ),
      publishFailed: 'Đăng thất bại',
      editTitle: 'Sửa Điều khoản & Bảo mật',
      newTitle: 'Trang Điều khoản & Bảo mật mới',
      editDescription: (slug: string) => `Thay đổi sẽ được đăng đè lên ${slug}.`,
      newDescription: 'Cả hai trang được đăng cùng lúc trong một commit.',
      answersInEnglish: 'Hai trang này là tiếng Anh, nên hãy trả lời bằng tiếng Anh.',
      tokenRefused:
        'GitHub từ chối token. Hãy cập nhật token rồi đăng lại — các câu trả lời vẫn được giữ.',
      app: 'Ứng dụng',
      appName: 'Tên ứng dụng',
      appNamePlaceholder: 'vd: Habit Tracker',
      slug: 'Slug của URL',
      slugFixed: 'Slug là URL đã đăng nên không thể đổi.',
      platform: 'Nền tảng',
      appDescription: 'Mô tả ứng dụng',
      appDescriptionPlaceholder: 'Mô tả ngắn, bằng tiếng Anh: ứng dụng làm gì, dành cho ai.',
      developer: 'Nhà phát triển / công ty',
      name: 'Tên',
      email: 'Email',
      website: 'Website',
      websitePlaceholder: 'https://… (không bắt buộc)',
      country: 'Quốc gia',
      effectiveDate: 'Ngày hiệu lực',
      date: 'Ngày',
      dataCollection: 'Thu thập dữ liệu',
      dataCollected: 'Dữ liệu thu thập',
      dataCollectedHint: 'Để tắt hết nếu ứng dụng không thu thập gì.',
      data: {
        name: 'Họ tên',
        email: 'Email',
        location: 'Vị trí',
        device_info: 'Thông tin thiết bị',
        usage_data: 'Dữ liệu sử dụng',
        camera: 'Camera',
        microphone: 'Micro',
        contacts: 'Danh bạ',
        payment: 'Thông tin thanh toán',
      },
      dataUsedFor: 'Cách dùng dữ liệu',
      dataUsedForPlaceholder:
        'vd: To sync your data across devices and improve the app experience.',
      thirdParty: 'Dịch vụ bên thứ ba',
      thirdPartyHint: 'Phân cách bằng dấu phẩy. Để trống nếu không có.',
      thirdPartyPlaceholder: 'vd: Firebase, Google Analytics',
      appSettings: 'Cài đặt ứng dụng',
      accountCreation: 'Ứng dụng cho phép tạo tài khoản',
      children: 'Ứng dụng hướng tới trẻ em dưới 13 tuổi',
      contact: 'Liên hệ',
      contactEmail: 'Email liên hệ về quyền riêng tư',
      preview: 'Xem trước',
      termsOfService: 'Điều khoản dịch vụ',
      privacyPolicy: 'Chính sách quyền riêng tư',
      back: 'Quay lại',
      next: 'Tiếp',
      savePublish: 'Lưu và đăng',
      publish: 'Đăng',
    },

    date: viDate,
  },
})
