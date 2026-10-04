import { describe, expect, it } from 'vitest'

import { menuItemFor } from './profile-menu'

describe('menuItemFor', () => {
  it('finds a section by the path the Flutter build used for it', () => {
    expect(menuItemFor('/profile/about_me').id).toBe('about')
    expect(menuItemFor('/profile/resume').id).toBe('resume')
  })

  it('ignores a trailing slash, which GitHub Pages adds to directory URLs', () => {
    expect(menuItemFor('/profile/relax/').id).toBe('relax')
  })

  it('opens /profile/ itself on Contact, as the Flutter build did', () => {
    expect(menuItemFor('/profile/').id).toBe('contact')
    expect(menuItemFor('/profile').id).toBe('contact')
  })
})
