import { useEffect, useRef } from 'react'

/**
 * brittanychiang.com's spotlight: a wide, faint glow of the tint under the pointer. It moves by
 * two custom properties set on its own element, so the page never re-renders for it. Only with
 * a fine pointer (a touch screen has nothing to follow), and it stays put with reduced motion.
 */
export function Spotlight() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const fine = window.matchMedia('(pointer: fine)').matches
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!fine || still) return
    const move = (event: PointerEvent) => {
      element.style.setProperty('--spot-x', `${String(event.clientX)}px`)
      element.style.setProperty('--spot-y', `${String(event.clientY)}px`)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
    }
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-30 bg-[radial-gradient(600px_circle_at_var(--spot-x,-1000px)_var(--spot-y,-1000px),var(--profile-spot),transparent_80%)] transition duration-300"
    />
  )
}
