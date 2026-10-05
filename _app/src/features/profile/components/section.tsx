import type { ReactNode } from 'react'

/**
 * One section of the one-page profile, after brittanychiang.com. Its id is the last part of
 * the section's address, so `/profile/resume` lands on it, clear of the site header. Its title
 * is a bar that sticks under the header on a phone, and is for screen readers only from lg up,
 * where the nav beside the page already names it.
 */
export function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      aria-label={title}
      tabIndex={-1}
      className="mb-16 scroll-mt-26 last:mb-0 focus:outline-none md:mb-24 lg:mb-36 lg:scroll-mt-34"
    >
      <div className="bg-profile-page/75 sticky top-10 z-20 -mx-6 mb-4 w-screen px-6 py-5 backdrop-blur md:-mx-12 md:px-12 lg:sr-only lg:relative lg:top-auto lg:mx-auto lg:w-full lg:px-0 lg:py-0 lg:opacity-0">
        <h2 className="text-profile-ink text-sm font-bold tracking-widest uppercase lg:sr-only">
          {title}
        </h2>
      </div>
      {children}
    </section>
  )
}

/** A group's label inside a section: quiet, in capitals, like the reference's dates. */
export const GROUP_LABEL = 'text-profile-muted mb-6 text-xs font-semibold tracking-widest uppercase'

/**
 * The reference's hover card. The `li`'s child gets `CARD`; inside it the first element is the
 * `CARD_GLOW` that lights up under the pointer, and the list around them is a `group/list`, so
 * the cards the pointer is not on fade back (from lg up, where there is a pointer to follow).
 */
export const CARD =
  'group relative grid gap-4 pb-1 transition-all sm:grid-cols-8 sm:gap-8 md:gap-4 lg:group-hover/list:opacity-50 lg:hover:!opacity-100 motion-reduce:transition-none'
export const CARD_GLOW =
  'absolute -inset-x-4 -inset-y-4 z-0 hidden rounded-md transition motion-reduce:transition-none lg:-inset-x-6 lg:block lg:group-hover:bg-profile-hover lg:group-hover:shadow-[inset_0_1px_0_0_rgb(161_161_170/0.1)] lg:group-hover:drop-shadow-lg'

/** A technology or platform, as a small green pill. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <li className="mt-2 mr-1.5">
      <span className="bg-profile-tag dark:text-profile-primary flex items-center rounded-full px-3 py-1 text-xs leading-5 font-medium text-green-800">
        {children}
      </span>
    </li>
  )
}
