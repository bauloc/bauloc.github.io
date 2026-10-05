import { useEffect } from 'react'

import { SiteHeader } from '@/components/site-header'
import { useMessages } from '@/lib/i18n'

import { HOME_MESSAGES } from './messages'

/**
 * Any address the site has no page for. GitHub Pages answers it with 404.html, a copy of the
 * app, and the router lands here instead of on its bare "Not Found".
 *
 * Set in the index's language — its field, its type — under the site's header, which every
 * page off the home page shares, with one way out of the message itself: the home page.
 */
export function NotFoundPage() {
  const messages = useMessages(HOME_MESSAGES)
  const t = messages.notFound

  useEffect(() => {
    const previous = document.title
    document.title = t.documentTitle
    return () => {
      document.title = previous
    }
  }, [t.documentTitle])

  return (
    <div
      data-page="index"
      className="font-display text-index-ink bg-index-ground flex min-h-dvh flex-col"
    >
      <SiteHeader current={null} />
      <main className="grid flex-1 place-items-center px-6 py-24">
        <div className="w-full max-w-[640px]">
          <p className="text-index-label text-[14px] leading-none">404</p>
          <h1 className="mt-4 text-[40px] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[64px]">
            {t.title}
          </h1>
          <p className="text-index-label mt-5 text-[16px] leading-snug">{t.body}</p>
          <a
            href="/"
            className="decoration-index-rule hover:decoration-index-ink mt-10 inline-block text-[16px] underline decoration-1 underline-offset-4 transition-colors"
          >
            ← {t.home}
          </a>
        </div>
      </main>
    </div>
  )
}
