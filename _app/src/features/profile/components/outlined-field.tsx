import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

/*
  Material 3's outlined text field with its label always floating, as the Flutter build set it
  (`FloatingLabelBehavior.always`, `OutlineInputBorder`).

  The notch the label sits in is a <fieldset>'s <legend>, which is what cuts a gap in a border
  natively. The fieldset is decoration only, so it is hidden from assistive tech and the
  control is named by `aria-label` — the same text as the visible label.
*/

const CONTROL =
  'peer block size-full rounded-sm bg-transparent px-3 text-[16px] leading-6 tracking-[0.5px] text-profile-on-surface outline-none'

/** Border and label. Must come AFTER the control: it reads the control's state as a `peer`. */
function Outline({ label }: { label: string }) {
  return (
    <fieldset
      aria-hidden="true"
      className={cn(
        // -top: half the legend's height, so the border's top edge is the box's top edge.
        'border-profile-outline pointer-events-none absolute inset-x-0 -top-1.5 bottom-0 m-0 rounded-sm border pr-2 pl-[7px]',
        'peer-hover:border-profile-on-surface',
        'peer-focus:border-profile-primary peer-focus:*:text-profile-primary peer-focus:border-2 peer-focus:pl-1.5',
      )}
    >
      <legend className="text-profile-on-surface-variant px-1 text-[12px] leading-3 tracking-[0.4px]">
        {label}
      </legend>
    </fieldset>
  )
}

export function OutlinedField({
  label,
  className,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn('relative h-12', className)}>
      <input aria-label={label} className={CONTROL} {...props} />
      <Outline label={label} />
    </div>
  )
}

export function OutlinedArea({
  label,
  className,
  ...props
}: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div className={cn('relative', className)}>
      <textarea aria-label={label} className={cn(CONTROL, 'resize-none py-3')} {...props} />
      <Outline label={label} />
    </div>
  )
}
