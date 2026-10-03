import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

/** Copies `text`; the icon turns into a check for two seconds. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => {
      setCopied(false)
    }, 2000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [copied])

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true)
          },
          () => {
            toast.error('Copy failed', { description: 'Select the text and copy it by hand.' })
          },
        )
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  )
}
