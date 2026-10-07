import { useMemo } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { useConsole } from '../console-context'
import { LinkRow } from './link-row'
import { BUILD_MESSAGES } from './messages'
import { qrPath } from './qr'

/**
 * A link as a QR code. Drawn as React's own <svg> from the path's data, never as markup from a
 * string: nothing here is parsed as HTML. Black on a white tile in both themes, because phone
 * cameras read a code dark on light; the path's quiet zone is inside the viewBox already.
 */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string
  label: string
  className?: string
}) {
  const { size, path } = useMemo(() => qrPath(text), [text])
  const box = String(size)
  return (
    <div className={cn('rounded-xl bg-white p-1 shadow-xs ring-1 ring-black/10', className)}>
      <svg
        viewBox={`0 0 ${box} ${box}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
        className="block size-full"
      >
        <path d={path} className="fill-black" />
      </svg>
    </div>
  )
}

/** A build's install link as a QR code, for a tester's phone to scan off the owner's screen. */
export function QrDialog({
  open,
  onOpenChange,
  name,
  url,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  url: string
}) {
  const { mock } = useConsole()
  const t = useMessages(BUILD_MESSAGES).qr
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate pr-6">{name}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <QrCode
          text={url}
          label={t.label(name)}
          className="mx-auto aspect-square w-60 max-w-full"
        />
        <LinkRow url={url} />
        {mock && <p className="text-muted-foreground text-xs">{t.mockNote}</p>}
      </DialogContent>
    </Dialog>
  )
}
