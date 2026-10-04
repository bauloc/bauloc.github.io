// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useHeldWhileClosing } from './use-held-while-closing'

describe('useHeldWhileClosing', () => {
  it('follows the value while open, and keeps the last one once closed', () => {
    interface Props {
      open: boolean
      value: string | null
    }
    const initialProps: Props = { open: true, value: 'Shop' }
    const { result, rerender } = renderHook(
      ({ open, value }: Props) => useHeldWhileClosing(open, value),
      { initialProps },
    )
    expect(result.current).toBe('Shop')
    rerender({ open: true, value: 'Notes' })
    expect(result.current).toBe('Notes')
    rerender({ open: false, value: null })
    expect(result.current).toBe('Notes')
    // Opening again shows the new value at once, not the held one.
    rerender({ open: true, value: 'Maps' })
    expect(result.current).toBe('Maps')
  })

  it('starts from the value it is first given, even when closed', () => {
    const { result } = renderHook(() => useHeldWhileClosing(false, null))
    expect(result.current).toBeNull()
  })
})
