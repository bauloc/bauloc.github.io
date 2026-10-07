import { Clock, RotateCw } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { defineMessages, useMessages } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

/*
  What a build or artifact link shows when Pages has no file for it: just published (Pages takes
  about a minute to deploy a commit), or removed since. GitHub Pages answers such an address with
  404.html, the app itself, and this route catches it — instead of the site-wide rule that sends
  an unknown address to the profile. A tester who opens their link a little early must stay on
  it and simply try again, not land on someone's profile with a menu of the site's sections
  (the owner's call): so no site header, no link anywhere, one button.
*/

const PENDING_MESSAGES = defineMessages({
  en: {
    build: {
      title: 'This build isn’t ready yet',
      body: 'If you just got this link, the build is still being published: try again in a minute. If the link is older, the build may have been removed; ask whoever sent it for a new one.',
    },
    artifact: {
      title: 'This page isn’t ready yet',
      body: 'If you just got this link, the page is still being published: try again in a minute. If the link is older, the page may have been removed; ask whoever sent it for a new one.',
    },
    retry: 'Try again',
  },
  vi: {
    build: {
      title: 'Bản build này chưa sẵn sàng',
      body: 'Nếu bạn vừa nhận link, bản build có thể vẫn đang được đăng: hãy thử lại sau khoảng một phút. Nếu link đã cũ, bản build có thể đã bị xoá; hãy xin người gửi link mới.',
    },
    artifact: {
      title: 'Trang này chưa sẵn sàng',
      body: 'Nếu bạn vừa nhận link, trang có thể vẫn đang được đăng: hãy thử lại sau khoảng một phút. Nếu link đã cũ, trang có thể đã bị xoá; hãy xin người gửi link mới.',
    },
    retry: 'Thử lại',
  },
})

/** `/build/<id>/` or `/artifact/<id>.html` with nothing published there (yet). */
export function PendingPage({ kind }: { kind: 'build' | 'artifact' }) {
  const t = useMessages(PENDING_MESSAGES)
  // Keeps <html class="dark"> in step with the visitor's choice, as every page does.
  useTheme()
  const words = t[kind]

  useEffect(() => {
    const previous = document.title
    document.title = words.title
    return () => {
      document.title = previous
    }
  }, [words.title])

  return (
    <main
      data-shell="console"
      className="bg-background text-foreground grid min-h-svh place-items-center px-4 py-12"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div className="bg-primary/10 text-primary grid size-14 place-items-center rounded-2xl [&_svg]:size-7">
          <Clock aria-hidden="true" />
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{words.title}</h1>
        <p className="text-muted-foreground mt-3 leading-relaxed">{words.body}</p>
        <Button
          size="lg"
          className="mt-8 h-12 w-full max-w-xs text-base"
          onClick={() => {
            window.location.reload()
          }}
        >
          <RotateCw /> {t.retry}
        </Button>
        <p className="text-muted-foreground mt-6 font-mono text-xs break-all">
          {window.location.host}
          {window.location.pathname}
        </p>
      </div>
    </main>
  )
}
