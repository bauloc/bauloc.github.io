import { ChevronDown, Download, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyButton } from '@/components/copy-button'

import { PlatformBadge } from './status'

function Command({ text }: { text: string }) {
  return (
    <div className="bg-muted/60 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{text}</code>
      <CopyButton text={text} label="Copy command" />
    </div>
  )
}

/**
 * The zero state — the PRIMARY screen, not an error page: most visitors arrive with nothing
 * connected. On Chrome and Edge the Android lane already works at that moment, so this says
 * so instead of blocking; help for the most common failure (adb holding the phone) lives
 * right here, not in docs.
 */
export function Gate({ webusb, onAdd }: { webusb: boolean; onAdd: () => void }) {
  return (
    <div className="mx-auto w-full max-w-4xl py-6 md:py-12">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
        {webusb ? 'Android is ready. iOS needs a helper.' : 'Device Lab'}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
        Identifiers, screenshots and logs for the phones plugged into this computer. Everything runs
        locally — nothing about your devices is uploaded anywhere.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PlatformBadge platform="android" />
              <CardTitle>{webusb ? 'Ready' : 'Needs the helper'}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              {webusb
                ? 'Click Add device and pick your phone from the browser prompt. Nothing to install.'
                : 'This browser has no WebUSB, so Android goes through the local helper too. Chrome or Edge gets you the no-install path.'}
            </p>
            <Button disabled={!webusb} onClick={onAdd}>
              <Plus /> Add device
            </Button>
            {webusb && (
              <details className="group text-sm">
                <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
                  Picker empty, or “unable to claim interface”?
                  <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="text-muted-foreground mt-3 space-y-3 leading-relaxed">
                  <p>
                    One program at a time can own a USB device, and Google’s adb server usually got
                    there first. Quit it, then try again:
                  </p>
                  <Command text="adb kill-server" />
                  <p>
                    If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ,
                    Flutter, VS Code, Unity or scrcpy. Quit that too, or use the local helper
                    instead, which shares the adb server rather than fighting it.
                  </p>
                </div>
              </details>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PlatformBadge platform="ios" />
              <CardTitle>Needs the helper</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              macOS keeps the iPhone USB connection for itself, so no browser can reach it. A small
              local helper bridges the gap — it is not built yet.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" disabled>
                <Download /> Get the helper
              </Button>
              <span className="text-muted-foreground text-xs">Coming in phase 2</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground mt-6 text-xs">
        WebUSB needs Chrome, Edge or Opera · USB debugging must be on · the helper needs macOS and
        Node 18+
      </p>
    </div>
  )
}
