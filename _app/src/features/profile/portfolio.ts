import type { Localized } from '@/lib/i18n'

import abcPlay from './assets/apps/abc-play.jpg'
import caiLuongNamBo from './assets/apps/cailuong-nam-bo.jpg'
import fptPlay from './assets/apps/fpt-play.jpg'
import selfiePuzzle from './assets/apps/selfie-puzzle.jpg'
import tevi from './assets/apps/tevi.jpg'
import webDien from './assets/apps/webdien.jpg'
import xoSo from './assets/apps/xoso.jpg'

/**
 * The apps on the Portfolio page.
 *
 * Sources: the Resume timeline, the 2016 CV (which listed these apps with their features and
 * store links), and the App Store itself. A `link` is set only where the listing was checked
 * and is still live; the older indie apps have left the stores and carry none.
 */
export interface Project {
  readonly title: string
  /** Who it was built for, and when, where that is known. */
  readonly context?: Localized<string>
  readonly platforms: string
  readonly description: Localized<string>
  readonly icon: string
  readonly link?: string
}

export const PROFESSIONAL_WORK: readonly Project[] = [
  {
    title: 'FPT Play',
    context: { en: 'FPT Telecom · 2015 – 2022', vi: 'FPT Telecom · 2015 – 2022' },
    platforms: 'iOS, tvOS',
    description: {
      en: "FPT Telecom's streaming service for live TV, sports, films and shows. I built and developed its iOS and Apple TV apps: live channels with program guides, video on demand, DRM-protected content and casting to the TV.",
      vi: 'Dịch vụ xem trực tuyến của FPT Telecom với truyền hình trực tiếp, thể thao, phim và chương trình giải trí. Tôi xây dựng và phát triển ứng dụng iOS và Apple TV của dịch vụ: kênh trực tiếp kèm lịch phát sóng, video theo yêu cầu, nội dung bảo vệ bằng DRM và truyền lên TV.',
    },
    icon: fptPlay,
    link: 'https://apps.apple.com/vn/app/id646297996',
  },
  {
    title: 'ABC Play',
    context: { en: 'FPT Telecom', vi: 'FPT Telecom' },
    platforms: 'iOS, tvOS',
    description: {
      en: 'An entertainment and learning app for children, with cartoons, music and shows, and a separate area for parents.',
      vi: 'Ứng dụng giải trí và học tập cho trẻ em, có phim hoạt hình, âm nhạc, chương trình thiếu nhi và khu vực riêng cho phụ huynh.',
    },
    icon: abcPlay,
    link: 'https://apps.apple.com/vn/app/id1059281751',
  },
  {
    title: 'Tevi',
    context: { en: 'TEVI Corporation · 2022 – today', vi: 'TEVI Corporation · 2022 – nay' },
    platforms: 'iOS',
    description: {
      en: 'A platform where content creators earn directly from their fans: livestreams, interactive games, memberships and paid posts. I work on it as a software developer.',
      vi: 'Nền tảng nơi nhà sáng tạo nội dung kiếm thu nhập trực tiếp từ người hâm mộ: livestream, trò chơi tương tác, gói hội viên và bài đăng trả phí. Tôi tham gia với vai trò lập trình viên phần mềm.',
    },
    icon: tevi,
    link: 'https://apps.apple.com/vn/app/id1613448814',
  },
]

export const OWN_APPS: readonly Project[] = [
  {
    title: 'Cải Lương Nam Bộ',
    platforms: 'iOS, Android',
    description: {
      en: 'For listening to cải lương, the traditional opera of Southern Vietnam. Its sister apps, Cải Lương 75 and Lời Vọng Cổ, are written in Flutter.',
      vi: 'Ứng dụng nghe cải lương, loại hình sân khấu truyền thống của Nam Bộ. Hai ứng dụng anh em, Cải Lương 75 và Lời Vọng Cổ, được viết bằng Flutter.',
    },
    icon: caiLuongNamBo,
    link: 'https://apps.apple.com/vn/app/id1171018791',
  },
  {
    title: 'Xổ Số Ba Miền',
    platforms: 'iOS, Android',
    description: {
      en: 'Lottery results from all three regions of Vietnam: live draws, a ticket checker that adds up the prize, statistics by week, month and year, and sharing.',
      vi: 'Kết quả xổ số cả ba miền: tường thuật trực tiếp, dò vé kèm cộng tiền thưởng, thống kê theo tuần, tháng, năm và chia sẻ kết quả.',
    },
    icon: xoSo,
  },
  {
    title: 'Web Điện',
    platforms: 'Android',
    description: {
      en: 'A native client for Webdien.com, a forum for electrical engineers: read, post, edit and quote, subscribe to threads and get notified of new replies.',
      vi: 'Ứng dụng native cho Webdien.com, diễn đàn của kỹ sư điện: đọc, đăng, sửa và trích dẫn bài, theo dõi chủ đề và nhận thông báo khi có trả lời mới.',
    },
    icon: webDien,
  },
  {
    title: 'Selfie Puzzle',
    platforms: 'iOS',
    description: {
      en: 'A sliding-puzzle game made from your own photos, taken from the camera, the library or the cloud, in sizes from 3×3 to 6×6.',
      vi: 'Trò chơi xếp hình trượt làm từ chính ảnh của bạn, chụp bằng camera, lấy từ thư viện hoặc đám mây, với kích thước từ 3×3 đến 6×6.',
    },
    icon: selfiePuzzle,
  },
]
