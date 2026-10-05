import { defineMessages } from '@/lib/i18n'

/*
  The profile's words. The records it shows — apps, games, the resume, the CV — keep both
  wordings beside each entry in their own files; this is everything else.

  Written to bring in work, in both languages: every claim is backed by the Resume page, the
  2016 CV or a live store listing, and the Vietnamese says the same things, not more.
*/
export const PROFILE_MESSAGES = defineMessages({
  en: {
    /** The Flutter build's `MaterialApp.title`. */
    documentTitle: "BAULOC's Profile",
    section: {
      about: 'About me',
      portfolio: 'Portfolio',
      resume: 'Resume',
      relax: 'Relax',
      contact: 'Contact',
    },

    role: 'Software Developer',
    engineer: 'Electrical & Electronic Engineer',
    /** The one-page layout: the section nav, the links under it, the full CV. */
    sectionsNav: 'Profile sections',
    elsewhere: 'Elsewhere',
    newTab: '(opens in a new tab)',
    viewFullCv: 'View the full CV',

    workTogether: "Let's work together",
    workTogetherBody:
      "I'm available for freelance and contract projects. Whether it's a new app, a feature for an existing one, or an app that needs rescuing, tell me what you're building and I'll get back to you as soon as possible.",
    downloadCv: 'Download CV (PDF)',

    aboutLead: 'I build products end to end, from the first idea to stable, profitable operation.',
    about: [
      "I'm Nguyễn Phước Lộc, a software developer based in Ho Chi Minh City, Vietnam, with more than ten years of building apps that people use every day. For nearly seven years at FPT Telecom I built and developed FPT Play, its TV and video streaming service, for iOS and Apple TV. Since 2022 I have been working at Tevi, a platform where content creators earn directly from their fans.",
      'Alongside that, I publish apps of my own under my own developer account: audio, utility and game apps for iOS and Android. Doing every part myself means I know the whole road a product travels: the idea, the design, the build, store review, the launch, and the updates that come after it.',
      'I started out as an electrical and electronic engineer: automatic control at Ho Chi Minh City University of Technology, then PLC and embedded programming in industry. That background still shows in how I work. I am systematic, careful with details, and focused on software that keeps running.',
    ],
    helpWith: 'What I can help with',
    helpWithLead:
      'I can take on every stage, from the idea to a product running in full, or join at whichever stage you need.',
    services: [
      'Idea and planning: clarifying the need, choosing the core features for the first version, a roadmap and time estimates',
      'UI/UX design: screen flows and interfaces that follow iOS and Android conventions',
      'Native iOS apps: Swift and Objective-C, including Apple TV (tvOS), app extensions and push notifications',
      'Android and cross-platform apps: native Android, and Flutter for iOS, Android and the web from one codebase',
      'Video and audio streaming: live TV with programme guides, video on demand, DRM-protected content and casting',
      'Testing and release: TestFlight betas, App Store and Google Play submissions, privacy policy and terms pages',
      'Running it after launch: crash monitoring with Crashlytics, push notifications, content updated remotely through Firebase, regular releases',
      'Monetization: ads, in-app purchases, memberships and paid content',
      'Taking over existing apps: fixing crashes, updating for new OS versions, adding features',
    ],

    portfolioLead:
      'Apps I have built over the past ten years: for FPT Telecom and Tevi, and under my own name.',
    professionalWork: 'Professional work',
    ownApps: 'My own apps',
    ownAppsNote:
      'Designed, built and published on my own developer account. Some of the older ones are no longer on the stores.',
    platforms: 'Platforms',

    play: (game: string) => `Play ${game}`,
    loadingGame: (game: string) => `Loading ${game}`,

    contactFormHeading: 'You can get in touch via the contact form',
    name: 'Name',
    email: 'Email',
    message: 'Message',
    submit: 'Submit',
    missing: {
      name: 'Please enter your name.',
      email: 'Please enter a valid email.',
      message: 'Please enter your message.',
    },
    sent: 'Thank you, I will respond as soon as possible.',
    failed: 'Request failed. Please try again.',

    print: 'Print / Save as PDF',
  },
  vi: {
    documentTitle: 'Hồ sơ của BAULOC',
    section: {
      about: 'Về tôi',
      portfolio: 'Dự án',
      resume: 'Lý lịch',
      relax: 'Giải trí',
      contact: 'Liên hệ',
    },

    role: 'Lập trình viên phần mềm',
    engineer: 'Kỹ sư Điện – Điện tử',
    sectionsNav: 'Các phần của hồ sơ',
    elsewhere: 'Liên kết',
    newTab: '(mở trong thẻ mới)',
    viewFullCv: 'Xem CV đầy đủ',

    workTogether: 'Cùng hợp tác nhé',
    workTogetherBody:
      'Tôi đang nhận dự án freelance và hợp đồng. Dù bạn cần một ứng dụng mới, thêm tính năng cho ứng dụng sẵn có hay cứu một ứng dụng đang gặp sự cố, hãy cho tôi biết bạn đang làm gì, tôi sẽ phản hồi sớm nhất có thể.',
    downloadCv: 'Tải CV (PDF)',

    aboutLead:
      'Tôi phát triển sản phẩm trọn vòng đời, từ ý tưởng ban đầu đến khi vận hành ổn định và tạo ra lợi nhuận.',
    about: [
      'Tôi là Nguyễn Phước Lộc, lập trình viên phần mềm sống tại TP. Hồ Chí Minh, với hơn mười năm làm những ứng dụng mà mọi người dùng hằng ngày. Gần bảy năm ở FPT Telecom, tôi xây dựng và phát triển FPT Play, dịch vụ truyền hình và video trực tuyến của công ty, trên iOS và Apple TV. Từ năm 2022, tôi làm việc tại Tevi, nền tảng nơi nhà sáng tạo nội dung kiếm thu nhập trực tiếp từ người hâm mộ.',
      'Song song đó, tôi phát hành ứng dụng của riêng mình bằng tài khoản nhà phát triển cá nhân: ứng dụng âm thanh, tiện ích và trò chơi cho iOS lẫn Android. Tự tay làm mọi khâu nên tôi hiểu trọn chặng đường của một sản phẩm: ý tưởng, thiết kế, lập trình, vòng duyệt của cửa hàng, ngày ra mắt và những bản cập nhật sau đó.',
      'Tôi khởi nghiệp là kỹ sư điện – điện tử: học ngành Điều khiển tự động tại Trường Đại học Bách khoa TP.HCM, rồi lập trình PLC và lập trình nhúng trong công nghiệp. Nền tảng ấy vẫn hiện rõ trong cách tôi làm việc: có hệ thống, cẩn thận từng chi tiết và chú trọng phần mềm chạy ổn định.',
    ],
    helpWith: 'Tôi có thể giúp gì cho bạn',
    helpWithLead:
      'Tôi có thể đảm nhận mọi khâu, từ ý tưởng đến khi sản phẩm vận hành hoàn chỉnh, hoặc tham gia ở bất kỳ khâu nào bạn cần.',
    services: [
      'Lên ý tưởng và kế hoạch: làm rõ nhu cầu, chọn tính năng cốt lõi cho phiên bản đầu tiên, lên lộ trình và ước lượng thời gian',
      'Thiết kế UI/UX: luồng màn hình và giao diện theo chuẩn của iOS và Android',
      'Ứng dụng iOS native: Swift và Objective-C, kể cả Apple TV (tvOS), app extension và thông báo đẩy',
      'Ứng dụng Android và đa nền tảng: Android native, Flutter cho iOS, Android và web từ cùng một mã nguồn',
      'Phát video và âm thanh trực tuyến: truyền hình trực tiếp kèm lịch phát sóng, video theo yêu cầu, nội dung bảo vệ bằng DRM và truyền lên TV',
      'Kiểm thử và phát hành: thử nghiệm qua TestFlight, nộp lên App Store và Google Play, trang chính sách quyền riêng tư và điều khoản',
      'Vận hành sau ra mắt: theo dõi crash bằng Crashlytics, gửi thông báo đẩy, cập nhật nội dung từ xa qua Firebase, phát hành bản cập nhật đều đặn',
      'Kiếm tiền từ sản phẩm: quảng cáo, mua trong ứng dụng, gói hội viên và nội dung trả phí',
      'Tiếp quản ứng dụng có sẵn: sửa lỗi crash, cập nhật cho hệ điều hành mới, thêm tính năng',
    ],

    portfolioLead:
      'Những ứng dụng tôi đã làm trong mười năm qua: cho FPT Telecom, cho Tevi và dưới tên của chính tôi.',
    professionalWork: 'Dự án tại công ty',
    ownApps: 'Ứng dụng của riêng tôi',
    ownAppsNote:
      'Tự thiết kế, lập trình và phát hành bằng tài khoản nhà phát triển của tôi. Vài ứng dụng cũ không còn trên cửa hàng.',
    platforms: 'Nền tảng',

    play: (game: string) => `Chơi ${game}`,
    loadingGame: (game: string) => `Đang tải ${game}`,

    contactFormHeading: 'Bạn cũng có thể gửi lời nhắn qua biểu mẫu',
    name: 'Họ tên',
    email: 'Email',
    message: 'Lời nhắn',
    submit: 'Gửi',
    missing: {
      name: 'Vui lòng nhập họ tên.',
      email: 'Vui lòng nhập email hợp lệ.',
      message: 'Vui lòng nhập lời nhắn.',
    },
    sent: 'Cảm ơn bạn, tôi sẽ phản hồi sớm nhất có thể.',
    failed: 'Gửi không thành công. Vui lòng thử lại.',

    print: 'In / Lưu thành PDF',
  },
})
