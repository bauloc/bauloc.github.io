import { describe, expect, it } from 'vitest'

import { ID_PATTERN, isId, randomId } from './ids'

describe('randomId', () => {
  it('is lowercase letters and digits of the asked length, and a valid id', () => {
    for (const length of [6, 8, 12]) {
      const id = randomId(length)
      expect(id).toMatch(new RegExp(`^[a-z0-9]{${String(length)}}$`))
      expect(isId(id)).toBe(true)
    }
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomId()))
    expect(ids.size).toBe(2000)
  })
})

describe('ID_PATTERN', () => {
  it('is the shape `npm run publish` checks: a–z, 0–9, inner hyphens, at most 64', () => {
    for (const ok of ['a', 'k3x9q2mf', 'my-app-1', 'x'.repeat(64)]) expect(isId(ok), ok).toBe(true)
    for (const bad of ['', '-a', 'a-', 'A1', 'a_b', 'a.b', 'a/b', 'x'.repeat(65), 'ả']) {
      expect(ID_PATTERN.test(bad), bad).toBe(false)
    }
  })
})
