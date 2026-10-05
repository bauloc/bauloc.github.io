import { defineMessages } from '@/lib/i18n'

/** The index's words. The sheets' own titles and descriptions are in home-links.ts. */
export const HOME_MESSAGES = defineMessages({
  en: {
    /*
      The statement, one phrase per line with every other line indented — the reference's
      rhythm. Only the site's existing copy ("BAULOC — Mobile Developer", "Software
      Developer, Electrical & Electronic Engineer"), recombined into a sentence.
    */
    statement: [
      'bauloc',
      'is a mobile',
      'software developer',
      'and an electrical',
      '& electronic',
      'engineer',
    ],
    layout: 'Layout',
    list: 'List',
    grid: 'Grid',
    theme: 'Colour theme',
    light: 'Light',
    dark: 'Dark',
    language: 'Language',
    needsToken: 'Needs a GitHub token',
    inProgress: 'In progress',
    newTab: 'opens in a new tab',
  },
  vi: {
    // The same sentence in Vietnamese word order, which needs one line fewer.
    statement: ['bauloc', 'là lập trình viên', 'ứng dụng di động', 'và là kỹ sư', 'điện – điện tử'],
    layout: 'Bố cục',
    list: 'Danh sách',
    grid: 'Lưới',
    theme: 'Giao diện',
    light: 'Sáng',
    dark: 'Tối',
    language: 'Ngôn ngữ',
    needsToken: 'Cần GitHub token',
    inProgress: 'Đang hoàn thiện',
    newTab: 'mở trong thẻ mới',
  },
})
