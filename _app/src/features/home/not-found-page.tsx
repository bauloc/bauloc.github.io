import { useEffect } from 'react'

import { useMessages } from '@/lib/i18n'
import { LANGUAGES, setLocale, useLocale } from '@/lib/locale'

import { TextSwitch } from './components/text-switch'
import { ThemeSwitch } from './components/theme-switch'
import { HOME_MESSAGES } from './messages'

/**
 * Any address the site has no page for. GitHub Pages answers it with 404.html, a copy of the
 * app, and the router lands here instead of on its bare "Not Found".
 *
 * Set in the index's language — its field, its type, its corner switches — with one way out:
 * the home page.
 */
export function NotFoundPage() {
  const messages = useMessages(HOME_MESSAGES)
  const t = messages.notFound
  const locale = useLocale()

  useEffect(() => {
    const previous = document.title
    document.title = t.documentTitle
    return () => {
      document.title = previous
    }
  }, [t.documentTitle])

  return (
    <main
      data-page="index"
      className="font-display text-index-ink bg-index-ground grid min-h-dvh place-items-center px-6 py-24"
    >
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
      <TextSwitch
        label={messages.language}
        options={LANGUAGES.map((language) => ({
          value: language.value,
          label: language.name,
          lang: language.value,
        }))}
        value={locale}
        onSelect={setLocale}
        className="top-6 right-6"
      />
      <ThemeSwitch />
    </main>
  )
}
