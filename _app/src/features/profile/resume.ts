import { defineMessages } from '@/lib/i18n'

/** The resume timeline, oldest first, as the Flutter build listed it. */
export interface ResumeEntry {
  readonly when: string
  readonly what: string
  readonly details?: readonly string[]
}

export const RESUME = defineMessages<readonly ResumeEntry[]>({
  en: [
    { when: 'October 10, 1991', what: 'Birthday' },
    { when: '2009', what: 'Completed high school program' },
    {
      when: '2009 - 04/2014',
      what: 'Studied at Ho Chi Minh City University of Technology',
      details: ['Faculty of Electricity - Electronics, major in Automatic Control'],
    },
    {
      when: '04/2014 - 08/2015',
      what: 'Worked at V.T.E.C.H Electrical Technology Co',
      details: [
        'Electrical - Automation Engineer',
        'Power quality testing of transformer equipment',
        'Embedded programming for microcontrollers',
        'PLC Programming',
      ],
    },
    {
      when: '08/2014 - 08/2015',
      what: 'Studied at Informatics Center - University of Science',
      details: ['Android Developer', 'iOS Developer'],
    },
    {
      when: '09/2015 - 04/2022',
      what: 'Worked at FPT Telecom',
      details: ['Software developer', 'Building and developing FPT Play application'],
    },
    { when: '04/2022 - Today', what: 'Worked at Tevi', details: ['Software developer'] },
  ],
  vi: [
    { when: '10/10/1991', what: 'Ngày sinh' },
    { when: '2009', what: 'Tốt nghiệp trung học phổ thông' },
    {
      when: '2009 - 04/2014',
      what: 'Học tại Trường Đại học Bách khoa TP.HCM',
      details: ['Khoa Điện – Điện tử, chuyên ngành Điều khiển tự động'],
    },
    {
      when: '04/2014 - 08/2015',
      what: 'Làm việc tại V.T.E.C.H Electrical Technology Co',
      details: [
        'Kỹ sư Điện – Tự động hóa',
        'Đo kiểm chất lượng điện năng cho thiết bị máy biến áp',
        'Lập trình nhúng cho vi điều khiển',
        'Lập trình PLC',
      ],
    },
    {
      when: '08/2014 - 08/2015',
      what: 'Học tại Trung tâm Tin học – Trường Đại học Khoa học Tự nhiên',
      details: ['Lập trình Android', 'Lập trình iOS'],
    },
    {
      when: '09/2015 - 04/2022',
      what: 'Làm việc tại FPT Telecom',
      details: ['Lập trình viên phần mềm', 'Xây dựng và phát triển ứng dụng FPT Play'],
    },
    { when: '04/2022 - nay', what: 'Làm việc tại Tevi', details: ['Lập trình viên phần mềm'] },
  ],
})
