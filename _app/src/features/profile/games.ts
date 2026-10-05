import type { Localized } from '@/lib/i18n'

import cover2048 from './assets/games/2048.jpg'
import candyCrush from './assets/games/candy_crush.jpg'
import fruitMerge from './assets/games/fruit_merge.jpg'
import puzzle from './assets/games/puzzle.jpg'
import tetris from './assets/games/tetris.jpg'

/**
 * The Relax section's games, from the Flutter build's list: Tevi's web minigames, each played
 * in place in an embedded frame. Its other fields (banners, store links, ids) were never shown.
 */
export interface Game {
  readonly title: string
  readonly description: Localized<string>
  readonly url: string
  readonly cover: string
}

export const GAMES: readonly Game[] = [
  {
    title: 'Fruit Merge',
    description: {
      en: 'Merge Fruits is a casual merging game that lets you drop fruits and combine identical ones to whip up new and exciting blends.',
      vi: 'Trò chơi ghép trái cây nhẹ nhàng: thả trái cây xuống và gộp những quả giống nhau để tạo ra loại mới.',
    },
    url: 'https://tevi-minigame-fruit-merge.web.app/',
    cover: fruitMerge,
  },
  {
    title: 'Candy Crush',
    description: {
      en: "Play Candy Crush Saga and switch and match your way through hundreds of levels in this divine puzzle adventure! Ain't it the sweetest game ever?",
      vi: 'Đổi chỗ và xếp những viên kẹo cùng màu để vượt qua hàng trăm màn chơi trong cuộc phiêu lưu giải đố ngọt ngào này!',
    },
    url: 'https://tevi-minigame-candy-crush.web.app/',
    cover: candyCrush,
  },
  {
    title: 'Jungle Puzzle',
    description: {
      en: 'Jungle Puzzle is a classic slide puzzle game set in a jungle theme, where players move tiles numbered 1 through 8 on a 3x3 grid to arrange them in the correct order.',
      vi: 'Trò chơi xếp hình trượt cổ điển theo chủ đề rừng xanh: di chuyển các ô số từ 1 đến 8 trên lưới 3x3 cho đúng thứ tự.',
    },
    url: 'https://tevi-minigame-puzzle-hack.web.app/',
    cover: puzzle,
  },
  {
    title: 'Tetris',
    description: {
      en: 'Tetris challenges players to align falling blocks, clearing lines to keep the playfield open. This timeless puzzle game combines strategy and speed, captivating players since the 1980s.',
      vi: 'Xếp những khối gạch đang rơi thành hàng ngang để xóa dòng và giữ cho sân chơi luôn trống. Trò chơi kinh điển kết hợp chiến thuật và tốc độ, cuốn hút người chơi từ những năm 1980.',
    },
    url: 'https://tevi-minigame-tetris.web.app/',
    cover: tetris,
  },
  {
    title: '2048',
    description: {
      en: '2048 is a sliding tile puzzle game where players combine tiles with matching numbers to double their value, aiming to reach the 2048 tile. Its addictive gameplay blends simple arithmetic with strategic planning, captivating players since its inception.',
      vi: 'Trượt và gộp các ô cùng số để nhân đôi giá trị, với mục tiêu chạm tới ô 2048. Lối chơi gây nghiện kết hợp phép cộng đơn giản với tính toán chiến thuật.',
    },
    url: 'https://tevi-minigame-2048.web.app/',
    cover: cover2048,
  },
]
