import { defineMessages } from '@/lib/i18n'

/** What the controls shared by every section say: the site header, Close, Copy. */
export const SITE_MESSAGES = defineMessages({
  en: {
    home: 'Home',
    /** The site header's sections, named by their icons' tooltips. */
    sections: 'Sections',
    section: { profile: 'Profile', xconsole: 'XConsole', device: 'Device Lab' },
    language: 'Language',
    lightMode: 'Switch to light mode',
    darkMode: 'Switch to dark mode',
    close: 'Close',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    copyByHand: 'Select the text and copy it by hand.',
    toggleSidebar: 'Toggle Sidebar',
    sidebar: 'Sidebar',
    sidebarDescription: 'Displays the mobile sidebar.',
    notifications: 'Notifications',
    closeToast: 'Close toast',
  },
  vi: {
    home: 'Trang chủ',
    sections: 'Các mục',
    section: { profile: 'Hồ sơ', xconsole: 'XConsole', device: 'Device Lab' },
    language: 'Ngôn ngữ',
    lightMode: 'Chuyển sang giao diện sáng',
    darkMode: 'Chuyển sang giao diện tối',
    close: 'Đóng',
    copied: 'Đã sao chép',
    copyFailed: 'Không sao chép được',
    copyByHand: 'Hãy bôi đen đoạn chữ và tự sao chép.',
    toggleSidebar: 'Ẩn/hiện thanh bên',
    sidebar: 'Thanh bên',
    sidebarDescription: 'Thanh điều hướng trên điện thoại.',
    notifications: 'Thông báo',
    closeToast: 'Đóng thông báo',
  },
})
