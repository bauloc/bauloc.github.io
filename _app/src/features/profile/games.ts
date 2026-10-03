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
  readonly description: string
  readonly url: string
  readonly cover: string
}

export const GAMES: readonly Game[] = [
  {
    title: 'Fruit Merge',
    description:
      'Merge Fruits is a casual merging game that lets you drop fruits and combine identical ones to whip up new and exciting blends.',
    url: 'https://tevi-minigame-fruit-merge.web.app/',
    cover: fruitMerge,
  },
  {
    title: 'Candy Crush',
    description:
      "Play Candy Crush Saga and switch and match your way through hundreds of levels in this divine puzzle adventure! Ain't it the sweetest game ever?",
    url: 'https://tevi-minigame-candy-crush.web.app/',
    cover: candyCrush,
  },
  {
    title: 'Jungle Puzzle',
    description:
      'Jungle Puzzle is a classic slide puzzle game set in a jungle theme, where players move tiles numbered 1 through 8 on a 3x3 grid to arrange them in the correct order.',
    url: 'https://tevi-minigame-puzzle-hack.web.app/',
    cover: puzzle,
  },
  {
    title: 'Tetris',
    description:
      'Tetris challenges players to align falling blocks, clearing lines to keep the playfield open. This timeless puzzle game combines strategy and speed, captivating players since the 1980s.',
    url: 'https://tevi-minigame-tetris.web.app/',
    cover: tetris,
  },
  {
    title: '2048',
    description:
      '2048 is a sliding tile puzzle game where players combine tiles with matching numbers to double their value, aiming to reach the 2048 tile. Its addictive gameplay blends simple arithmetic with strategic planning, captivating players since its inception.',
    url: 'https://tevi-minigame-2048.web.app/',
    cover: cover2048,
  },
]
