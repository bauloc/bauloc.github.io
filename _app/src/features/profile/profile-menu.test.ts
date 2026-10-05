import { describe, expect, it } from 'vitest'

import { PROFILE_MENU, menuItemFor, sectionId } from './profile-menu'

describe('menuItemFor', () => {
  it('finds a section by the path the Flutter build used for it', () => {
    expect(menuItemFor('/profile/about_me')?.id).toBe('about')
    expect(menuItemFor('/profile/resume')?.id).toBe('resume')
  })

  it('ignores a trailing slash, which GitHub Pages adds to directory URLs', () => {
    expect(menuItemFor('/profile/relax/')?.id).toBe('relax')
  })

  it('names no section for /profile/ itself, which opens at the top of the page', () => {
    expect(menuItemFor('/profile/')).toBeNull()
    expect(menuItemFor('/profile')).toBeNull()
  })
})

describe('sectionId', () => {
  it('is the last part of the path, so a section lands where its address points', () => {
    expect(PROFILE_MENU.map(sectionId)).toEqual([
      'about_me',
      'portfolio',
      'resume',
      'relax',
      'contact',
    ])
  })
})
