import { Camera, Copy, Download, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { fmtClock } from '../model'
import type { Shot } from '../store'

/**
 * Put an image on the clipboard. ClipboardItem gets a PROMISE rather than an awaited blob:
 * Safari loses the user gesture across an await and rejects the write.
 */
function copyImage(shot: Shot) {
  if (!('ClipboardItem' in window) || !('write' in navigator.clipboard)) {
    toast.error('Copy image unsupported', {
      description: 'This browser cannot put images on the clipboard. Use Save.',
    })
    return
  }
  const item = new ClipboardItem({ 'image/png': Promise.resolve(shot.blob) })
  navigator.clipboard.write([item]).then(
    () => toast.success('Screenshot copied'),
    (error: unknown) =>
      toast.error('Copy image failed', {
        description: error instanceof Error ? error.message : 'The clipboard write was rejected.',
      }),
  )
}

/** The device's screenshots this session, newest first, at a size the tester picks. */
export function Screenshots({
  shots,
  zoom,
  onZoom,
  onClear,
}: {
  shots: readonly Shot[]
  zoom: number
  onZoom: (zoom: number) => void
  onClear: () => void
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Screenshots</CardTitle>
        <CardAction className="flex items-center gap-3">
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            Size
            <input
              type="range"
              min={80}
              max={480}
              step={20}
              value={zoom}
              aria-label="Thumbnail size"
              className="accent-primary w-28"
              onChange={(e) => {
                onZoom(Number(e.target.value))
              }}
            />
          </label>
          {/* aria-disabled: once it has cleared, a disabled button would drop focus to <body>. */}
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={shots.length === 0}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (shots.length > 0) onClear()
            }}
          >
            <Trash2 /> Clear
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {shots.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center rounded-lg border border-dashed py-10 text-sm">
            <Camera className="mb-2 size-7 opacity-60" />
            No screenshots yet — press S or Take Screenshot.
          </div>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {shots.map((shot) => (
              <li
                key={shot.id}
                className="bg-muted/30 overflow-hidden rounded-lg border"
                style={{ width: zoom }}
              >
                <a href={shot.url} target="_blank" rel="noopener noreferrer" title="Open full size">
                  <img
                    src={shot.url}
                    alt={`Screenshot of ${shot.deviceName} at ${fmtClock(shot.at)}`}
                    loading="lazy"
                    className="block w-full"
                  />
                </a>
                <div className="flex items-center gap-1 border-t px-2 py-1.5">
                  <span className="text-muted-foreground flex-1 font-mono text-xs tabular-nums">
                    {fmtClock(shot.at)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Copy image"
                    title="Copy image"
                    onClick={() => {
                      copyImage(shot)
                    }}
                  >
                    <Copy />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7" asChild>
                    <a
                      href={shot.url}
                      download={shot.fileName}
                      aria-label={`Save ${shot.fileName}`}
                      title="Save"
                    >
                      <Download />
                    </a>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
