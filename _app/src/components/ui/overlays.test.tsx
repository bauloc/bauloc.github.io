// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './sheet'

/*
  The overlays' motion was retuned (globals.css, and the classes here): Radix's behaviour
  must not have moved with it. Focus goes in, stays in, and comes back to what opened it;
  Escape and a click outside close; the page is inert while a modal one is up and usable
  again after. jsdom runs no animations, so what closes unmounts at once, as it would in a
  browser with reduced motion.
*/

afterEach(cleanup)

function renderAlert() {
  render(
    <AlertDialog>
      <AlertDialogTrigger>Uninstall…</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>!</AlertDialogMedia>
          <AlertDialogTitle>Uninstall Notes from Pixel 9?</AlertDialogTitle>
          <AlertDialogDescription>Its data goes too.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Uninstall</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  )
  return screen.getByRole('button', { name: 'Uninstall…' })
}

describe('AlertDialog', () => {
  it('takes focus to Cancel, keeps the page inert, and gives focus back on Escape', async () => {
    const trigger = renderAlert()
    trigger.focus()
    fireEvent.click(trigger)

    const alert = await screen.findByRole('alertdialog')
    expect(alert).toHaveAttribute('data-state', 'open')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    })
    // The scroll lock and the outside-pointer block are on while it is up.
    expect(document.body).toHaveAttribute('data-scroll-locked')
    expect(document.body.style.pointerEvents).toBe('none')

    fireEvent.keyDown(alert, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
    expect(document.body).not.toHaveAttribute('data-scroll-locked')
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('puts the title beside the media by sibling order, not by a :has() on the dialog', () => {
    renderAlert()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall…' }))
    const title = screen.getByRole('heading', { name: 'Uninstall Notes from Pixel 9?' })
    expect(title.className).toContain('[[data-slot=alert-dialog-media]~&]:col-start-2')
    expect(title.className).not.toMatch(/group-has-/)
    expect(title.previousElementSibling).toHaveAttribute('data-slot', 'alert-dialog-media')
  })
})

describe('Dialog', () => {
  it('closes on a click outside it and gives focus back', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open photo</DialogTrigger>
        <DialogContent>
          <DialogTitle>Screenshot.png</DialogTitle>
          <DialogDescription>1080 × 2424</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    const trigger = screen.getByRole('button', { name: 'Open photo' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    })

    // Radix reads an outside click as a pointerdown outside the content (here, on the
    // overlay) and acts on the click that follows; it listens from the tick after opening.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    fireEvent.pointerDown(overlay as Element)
    fireEvent.click(overlay as Element)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
  })
})

describe('Sheet', () => {
  it('hides the page behind the panel, closes on Escape and gives focus back', async () => {
    render(
      <>
        <button type="button">Behind</button>
        <Sheet>
          <SheetTrigger>Notes</SheetTrigger>
          <SheetContent>
            <SheetTitle>Notes</SheetTitle>
            <SheetDescription>com.example.notes</SheetDescription>
            <button type="button">Open</button>
          </SheetContent>
        </Sheet>
      </>,
    )
    const trigger = screen.getByRole('button', { name: 'Notes' })
    trigger.focus()
    fireEvent.click(trigger)
    const sheet = await screen.findByRole('dialog')
    expect(sheet).toHaveAttribute('data-state', 'open')
    // Everything outside the panel is hidden from assistive tech while it is up.
    expect(screen.queryByRole('button', { name: 'Behind' })).not.toBeInTheDocument()

    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Behind' })).toBeInTheDocument()
  })
})

describe('DropdownMenu', () => {
  it('opens from the keyboard onto its first item and gives focus back on Escape', async () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>More actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuItem>Force stop</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'More actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
    })

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
  })
})

/*
  The way out, for overlays opened from state the way the Device Lab opens them: an alert
  opened from a menu item, a sheet whose body exists while a row is chosen. While one closes
  it is inert, and with no Trigger, focus goes back to where the user was.

  jsdom runs no animations, so Radix would unmount at once: these give everything with a
  data-state an `enter` or `exit` animation, as the CSS does, and finish the exits by hand.
*/
describe('closing an overlay opened from state', () => {
  const realStyle = window.getComputedStyle.bind(window)

  beforeEach(() => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = realStyle(el, pseudo)
      if (!(el instanceof HTMLElement) || !el.hasAttribute('data-state')) return style
      return new Proxy(style, {
        get(target, key) {
          if (key === 'animationName') return el.dataset.state === 'closed' ? 'exit' : 'enter'
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value
        },
      })
    })
    // Radix's Presence matches the animation that ended by CSS.escape, which jsdom lacks.
    if (typeof globalThis.CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (s: string) => s })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Ends every exit animation under way, as the browser would once it has played. */
  function finishExits() {
    act(() => {
      for (const el of document.querySelectorAll('[data-state="closed"]')) {
        el.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'exit' }))
      }
    })
  }

  function Apps() {
    const [pending, setPending] = useState<string | null>(null)
    const [row, setRow] = useState<string | null>(null)
    return (
      <>
        <button type="button" onClick={() => setRow('Notes')}>
          Notes
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger>More actions for Notes</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setPending('Notes')}>Uninstall…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{pending && `Uninstall ${pending} from Pixel 9?`}</AlertDialogTitle>
              <AlertDialogDescription>{pending && 'Its data goes too.'}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>{pending && 'Uninstall'}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Sheet
          open={row !== null}
          onOpenChange={(open) => {
            if (!open) setRow(null)
          }}
        >
          <SheetContent>
            {row && (
              <>
                <SheetTitle>{row}</SheetTitle>
                <SheetDescription>com.example.notes</SheetDescription>
              </>
            )}
          </SheetContent>
        </Sheet>
      </>
    )
  }

  async function openAlertFromMenu() {
    const more = screen.getByRole('button', { name: 'More actions for Notes' })
    more.focus()
    fireEvent.keyDown(more, { key: 'Enter' })
    const item = await screen.findByRole('menuitem', { name: 'Uninstall…' })
    await waitFor(() => {
      expect(item).toHaveFocus()
    })
    fireEvent.keyDown(item, { key: 'Enter' })
    const alert = await screen.findByRole('alertdialog')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    })
    finishExits() // the menu's
    return { more, alert }
  }

  it('makes the alert inert while it fades out, so nothing in it acts on a cancel', async () => {
    render(<Apps />)
    const { alert } = await openAlertFromMenu()

    fireEvent.keyDown(alert, { key: 'Escape' })
    expect(alert).toHaveAttribute('data-state', 'closed')
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute('inert')

    finishExits()
    expect(alert).not.toBeInTheDocument()
  })

  it('gives focus back to the menu button the alert was opened from', async () => {
    render(<Apps />)
    const { more, alert } = await openAlertFromMenu()

    fireEvent.keyDown(alert, { key: 'Escape' })
    finishExits()
    await waitFor(() => {
      expect(more).toHaveFocus()
    })
  })

  it('makes the sheet inert while it fades out, and gives focus back to its row', async () => {
    render(<Apps />)
    const row = screen.getByRole('button', { name: 'Notes' })
    row.focus()
    fireEvent.click(row)
    const sheet = await screen.findByRole('dialog')
    await waitFor(() => {
      expect(sheet).toContainElement(document.activeElement as HTMLElement)
    })

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(sheet).toHaveAttribute('data-state', 'closed')
    expect(sheet).toHaveAttribute('inert')

    finishExits()
    expect(sheet).not.toBeInTheDocument()
    await waitFor(() => {
      expect(row).toHaveFocus()
    })
  })

  it('is usable again when reopened before it has finished closing', async () => {
    render(<Apps />)
    const row = screen.getByRole('button', { name: 'Notes' })
    fireEvent.click(row)
    const sheet = await screen.findByRole('dialog')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(sheet).toHaveAttribute('data-state', 'closed')

    fireEvent.click(row)
    expect(sheet).toHaveAttribute('data-state', 'open')
    expect(sheet).not.toHaveAttribute('inert')
    expect(sheet).toHaveTextContent('com.example.notes')
  })

  it('renders what the consumer gives it while closing, not a frozen copy', () => {
    // Holding the last content is the consumer's to do (image-viewer.tsx): a frozen copy would
    // also freeze what it passes while closing, such as the viewer's `closing`.
    function Viewer() {
      const [open, setOpen] = useState(true)
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Screenshot.png</DialogTitle>
            <DialogDescription>{open ? 'Reading' : 'Stopped'}</DialogDescription>
          </DialogContent>
        </Dialog>
      )
    }
    render(<Viewer />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(dialog).toHaveAttribute('data-state', 'closed')
    expect(dialog).toHaveTextContent('Stopped')
  })

  it('leaves focus to a consumer that handles it, and to Radix when there is a trigger', async () => {
    const onCloseAutoFocus = vi.fn((e: Event) => {
      e.preventDefault()
    })
    render(
      <>
        <button type="button">Elsewhere</button>
        <Dialog>
          <DialogTrigger>Open photo</DialogTrigger>
          <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
            <DialogTitle>Screenshot.png</DialogTitle>
            <DialogDescription>1080 × 2424</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    )
    const trigger = screen.getByRole('button', { name: 'Open photo' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    finishExits()
    await waitFor(() => {
      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1)
    })
    // The consumer prevented the default and moved focus nowhere: it stays where it fell.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(trigger).not.toHaveFocus()
  })
})
