import { ExternalLink, QrCode } from 'lucide-react'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { useMessages } from '@/lib/i18n'

import { BUILD_MESSAGES } from './messages'

/**
 * A build's install link: the address, Copy, Open, and the QR code when the caller has one to
 * show. Drawn like Term & Privacy's URL rows, so the console's links all look alike.
 */
export function LinkRow({ url, onQr }: { url: string; onQr?: () => void }) {
  const t = useMessages(BUILD_MESSAGES).card
  return (
    <div className="bg-muted/40 flex min-w-0 items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground/80 hover:text-primary min-w-0 flex-1 truncate font-mono text-xs hover:underline"
      >
        {url.replace(/^https?:\/\//, '')}
      </a>
      <CopyButton text={url} label={t.copy} />
      <Button variant="ghost" size="icon" className="size-7" asChild>
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t.open} title={t.open}>
          <ExternalLink />
        </a>
      </Button>
      {onQr && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t.showQr}
          title={t.showQr}
          onClick={onQr}
        >
          <QrCode />
        </Button>
      )}
    </div>
  )
}
