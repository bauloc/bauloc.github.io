/** The resume timeline, oldest first, as the Flutter build listed it. */
export interface ResumeEntry {
  readonly when: string
  readonly what: string
  readonly details?: readonly string[]
}

export const RESUME: readonly ResumeEntry[] = [
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
]
