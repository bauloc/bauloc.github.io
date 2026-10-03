import type { ButtonHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

/**
 * Material 3's ElevatedButton as the Flutter build drew it: a pill on the surface-container
 * tone, primary-coloured label (set at 16 px there), elevation 1 lifting to 2 under the
 * pointer, and a primary state layer — the `::before` — for hover and press.
 *
 * 32 px tall, not the M3 spec's 40: that is what the Flutter build drew, measured on both a
 * desktop and a phone viewport.
 *
 * Exported as classes too, for a link that should read as a button.
 */
export const ELEVATED_BUTTON = cn(
  'relative inline-flex h-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full px-6 no-underline select-none',
  'bg-profile-surface-container-low text-[16px] leading-5 font-medium tracking-[0.1px] text-profile-primary',
  'shadow-profile-1 transition-shadow duration-200 hover:shadow-profile-2 active:shadow-profile-1',
  'before:pointer-events-none before:absolute before:inset-0 before:bg-profile-primary before:opacity-0 before:transition-opacity',
  'hover:before:opacity-[0.08] focus-visible:before:opacity-10 active:before:opacity-10',
  'disabled:cursor-default disabled:shadow-none disabled:before:opacity-0',
)

export function ElevatedButton({
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cn(ELEVATED_BUTTON, className)} {...props} />
}
