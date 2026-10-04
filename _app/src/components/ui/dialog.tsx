"use client"

import * as React from "react"
import { cn } from "@/lib/cn"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { SITE_MESSAGES } from "@/components/messages"
import { useMessages } from "@/lib/i18n"

/*
  What the overlays here (dialog, alert dialog, sheet) add to Radix, so the way out leaves
  the user where they were. The root tells its content whether it is open.

  While it closes, the content is inert. It is still on screen for its exit animation, but
  what it shows is going: no click or key should act on it, and focus leaves it at once.

  Focus goes back even without a trigger. Radix returns it to the overlay's Trigger; one
  opened from state (a row's sheet, an alert opened from a menu item) has none, and focus
  fell to <body>, losing the user's place in a long list. Those return it to what had focus
  when they opened or, when that was an item in a menu (gone with the menu), to the button
  that opened the menu.

  Not done here: holding the content while it closes. A consumer that derives what it shows
  from the open state (`{row && <Body />}`) empties it in the render that closes it, so the
  exit fades an empty box; it should keep showing its last value (image-viewer.tsx does).
  Freezing the children here would also freeze the props a consumer passes while closing
  (the viewer's `closing`, which stops its reads).
*/
const OverlayOpen = React.createContext(true)

/** The root's open state, controlled or not, so the content can tell that it is closing. */
function useOverlayOpenState(root: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?(open: boolean): void
}) {
  const [own, setOwn] = React.useState(root.defaultOpen ?? false)
  const shown = root.open ?? own
  const change = (next: boolean) => {
    if (root.open === undefined) setOwn(next)
    root.onOpenChange?.(next)
  }
  return [shown, change] as const
}

/** Where focus goes back to: the element itself, or for an item in a menu, the menu's button. */
function returnTarget(focused: Element | null): HTMLElement | null {
  let target = focused
  for (let hops = 0; target && hops < 8; hops++) {
    const menu = target.closest('[role="menu"]')
    const opener = menu?.getAttribute("aria-labelledby")
    if (!opener) break
    target = document.getElementById(opener)
  }
  return target instanceof HTMLElement && target !== document.body
    ? target
    : null
}

/**
 * onCloseAutoFocus for an overlay's content. A consumer's own handler goes first and wins if
 * it prevents the default; otherwise Radix focuses the trigger, and if there was none (focus
 * is left on <body>), focus goes back to what had it when the overlay opened.
 */
function useReturnFocus(
  open: boolean,
  onCloseAutoFocus?: (event: Event) => void
) {
  const opener = React.useRef<HTMLElement | null>(null)
  // On opening, in a layout effect: before Radix's focus scope moves focus into the content.
  React.useLayoutEffect(() => {
    if (open) opener.current = returnTarget(document.activeElement)
  }, [open])
  return (event: Event) => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    // After Radix's own handler, which runs right after this one.
    queueMicrotask(() => {
      const lost =
        document.activeElement === null ||
        document.activeElement === document.body
      if (lost && opener.current?.isConnected) opener.current.focus()
    })
  }
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [shown, change] = useOverlayOpenState(props)
  return (
    <OverlayOpen value={shown}>
      <DialogPrimitive.Root
        data-slot="dialog"
        {...props}
        open={shown}
        onOpenChange={change}
      />
    </OverlayOpen>
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

// Overlay motion (dialog, alert dialog, sheet, menus and tooltips all follow it): a short
// fade, in 150 ms and out in 100 ms, with at most a 2% scale or a small slide. The overlay
// fades out exactly as long as its content: it holds Radix's scroll lock, and letting go
// early brings the page's scrollbar back while the content is still on screen.
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100 data-[state=closed]:ease-in data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=open]:ease-out",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const open = React.useContext(OverlayOpen)
  const returnFocus = useReturnFocus(open, onCloseAutoFocus)
  const t = useMessages(SITE_MESSAGES)
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-100 data-[state=closed]:ease-in data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:duration-150 data-[state=open]:ease-out sm:max-w-lg",
          className
        )}
        inert={!open}
        onCloseAutoFocus={returnFocus}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">{t.close}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const t = useMessages(SITE_MESSAGES)
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{t.close}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  OverlayOpen,
  useOverlayOpenState,
  useReturnFocus,
}
