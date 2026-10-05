import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useMessages } from '@/lib/i18n'

import { SITE_MESSAGES } from './messages'

/** Where the site's home page is, for a page that is not served from the site itself. */
export const SITE_URL = 'https://bauloc.github.io/'

/**
 * Back to the site's home page, first in a console's header. A full page load, like every
 * link between the site's sections. The word hides on a phone, where the arrow alone has to
 * fit; it stays in the link's name.
 */
export function HomeButton({ href = '/' }: { href?: string }) {
  const t = useMessages(SITE_MESSAGES)
  return (
    <Button variant="ghost" size="sm" className="-ml-1.5 px-2 has-[>svg]:px-2" asChild>
      <a href={href} title={t.homeTitle}>
        <ArrowLeft />
        <span className="sr-only sm:not-sr-only">{t.home}</span>
      </a>
    </Button>
  )
}
