import { defineMessages } from '@/lib/i18n'

/** The index's words. The sheets' own titles and descriptions are in home-links.ts. */
export const HOME_MESSAGES = defineMessages({
  en: {
    /*
      The statement, one phrase per line with every other line indented — the reference's
      rhythm. Only the owner's own titles, as the profile gives them ("Software Developer",
      "Electrical & Electronic Engineer"), recombined into a sentence.
    */
    statement: [
      'bauloc',
      'is a software',
      'developer',
      'and an electrical',
      '& electronic',
      'engineer',
    ],
    layout: 'Layout',
    list: 'List',
    grid: 'Grid',
    needsToken: 'Needs a GitHub token',
    inProgress: 'In progress',
    newTab: 'opens in a new tab',
  },
  vi: {
    // The same sentence in Vietnamese word order, which needs one line fewer.
    statement: ['bauloc', 'là lập trình viên', 'phần mềm', 'và là kỹ sư', 'điện – điện tử'],
    layout: 'Bố cục',
    list: 'Danh sách',
    grid: 'Lưới',
    needsToken: 'Cần GitHub token',
    inProgress: 'Đang hoàn thiện',
    newTab: 'mở trong thẻ mới',
  },
})
