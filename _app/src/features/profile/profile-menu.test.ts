import { describe, expect, it } from 'vitest'

import { menuItemFor } from './profile-menu'

describe('menuItemFor', () => {
  it('finds a section by the path the Flutter build used for it', () => {
    expect(menuItemFor('/profile/about_me').title).toBe('About me')
    expect(menuItemFor('/profile/resume').title).toBe('Resume')
  })

  it('ignores a trailing slash, which GitHub Pages adds to directory URLs', () => {
    expect(menuItemFor('/profile/relax/').title).toBe('Relax')
  })

  it('opens /profile/ itself on Contact, as the Flutter build did', () => {
    expect(menuItemFor('/profile/').title).toBe('Contact')
    expect(menuItemFor('/profile').title).toBe('Contact')
  })
})
