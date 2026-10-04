import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useMessages } from '@/lib/i18n'

import { SITE_MESSAGES } from './messages'

/** Copies `text`; the icon turns into a check for two seconds. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const t = useMessages(SITE_MESSAGES)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => {
      setCopied(false)
    }, 2000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [copied])

  // The label swap alone is not reliably spoken, so a polite status says it too.
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={copied ? t.copied : label}
        title={copied ? t.copied : label}
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true)
            },
            () => {
              toast.error(t.copyFailed, { description: t.copyByHand })
            },
          )
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t.copied : ''}
      </span>
    </>
  )
}
