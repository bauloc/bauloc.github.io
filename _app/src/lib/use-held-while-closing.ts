import { useState } from 'react'

/**
 * `value` while `open`; once it closes, the value it had last. An overlay closed by clearing
 * what it shows (`pending`, `row`) still plays its exit animation, and should fade out what
 * the user was looking at rather than an empty box. Each value must keep its identity while
 * it doesn't change (state, or an item of a list), or this re-renders on every render.
 */
export function useHeldWhileClosing<T>(open: boolean, value: T): T {
  const [held, setHeld] = useState(value)
  if (open && !Object.is(held, value)) setHeld(value)
  return open ? value : held
}
