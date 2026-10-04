// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DeviceLabPage, keepListed, withOpen } from './device-lab-page'

const APK = new File(['PK'], 'shop.apk', { type: 'application/vnd.android.package-archive' })

describe('keepListed', () => {
  const installs = {
    PIXEL: { files: [APK], open: true },
    GALAXY: { files: null, open: false },
  }

  it('forgets the dialog of a device that left the list, so a replug opens nothing', () => {
    const kept = keepListed(installs, [{ id: 'GALAXY' }])
    expect(kept).toEqual({ GALAXY: { files: null, open: false } })
    // Plugged back in under the same id: still nothing to mount.
    expect(keepListed(kept, [{ id: 'PIXEL' }, { id: 'GALAXY' }]).PIXEL).toBeUndefined()
  })

  it('returns the same object when every device is still listed', () => {
    expect(keepListed(installs, [{ id: 'PIXEL' }, { id: 'GALAXY' }, { id: 'OTHER' }])).toBe(
      installs,
    )
  })
})

describe('withOpen', () => {
  it('keeps the files that are there now, not the ones of an older render', () => {
    const newer = [new File(['PK'], 'other.apk')]
    // The toast's Show, from the render where the first install started, after B was dropped.
    const now = { PIXEL: { files: newer, open: true } }
    expect(withOpen(now, 'PIXEL', true).PIXEL).toEqual({ files: newer, open: true })
    expect(withOpen(now, 'PIXEL', false).PIXEL).toEqual({ files: newer, open: false })
  })

  it('opens a forgotten device’s dialog with no files, and leaves it forgotten when closing', () => {
    expect(withOpen({}, 'PIXEL', true)).toEqual({ PIXEL: { files: null, open: true } })
    const none = {}
    expect(withOpen(none, 'PIXEL', false)).toBe(none)
  })
})

/** A file drag event as Chrome sends it: `types` says Files, the files come with the drop. */
function fileDrag(type: 'dragover' | 'drop', files: File[] = [APK]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const data = {
    types: ['Files'],
    files,
    items: [],
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return event
}

describe('DeviceLabPage, files dropped outside the drop zone', () => {
  beforeAll(() => {
    // jsdom has no matchMedia; the theme toggle asks it for the system's dark mode.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    // Sonner's toasts outlive the Toaster: a later test must not see this one's.
    act(() => {
      toast.dismiss()
    })
    cleanup()
  })

  it('stops the browser’s own file drop on the header, and says why it can’t install', async () => {
    render(<DeviceLabPage />)
    const header = document.querySelector('header')
    expect(header).toBeTruthy()

    const over = fileDrag('dragover')
    header?.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)

    // No ready Android phone is selected (no WebUSB, no mock lane): the existing refusal.
    const drop = fileDrag('drop')
    act(() => {
      header?.dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(await screen.findByText('Can’t install here')).toBeTruthy()
    expect(screen.getByText('Select a ready Android phone first, then drop the file again.'))
  })

  it('leaves a drag of text alone', () => {
    render(<DeviceLabPage />)
    const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'] } })
    document.querySelector('header')?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('handles a drop on the zone once, through the zone', () => {
    const error = vi.spyOn(toast, 'error')
    try {
      render(<DeviceLabPage />)
      const drop = fileDrag('drop')
      act(() => {
        document.querySelector('main')?.dispatchEvent(drop)
      })
      expect(drop.defaultPrevented).toBe(true)
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith('Can’t install here', expect.anything())
    } finally {
      error.mockRestore()
    }
  })

  it('takes a drop on the header to the selected phone, as the zone would', async () => {
    window.history.replaceState(null, '', '/device/?mock=1')
    try {
      render(<DeviceLabPage />)
      act(() => {
        screen.getByRole('button', { name: /Pixel 9/ }).click()
      })
      act(() => {
        document.querySelector('header')?.dispatchEvent(fileDrag('drop'))
      })
      expect(await screen.findByRole('dialog')).toBeTruthy()
      expect(screen.queryByText('Can’t install here')).toBeNull()
    } finally {
      window.history.replaceState(null, '', '/device/')
    }
  })

  it('stops catching drops once the page is gone', () => {
    const { unmount } = render(<DeviceLabPage />)
    unmount()
    const over = fileDrag('dragover')
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
  })
})

describe('DeviceLabPage, the S, R and / shortcuts', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    window.history.replaceState(null, '', '/device/?mock=1')
  })

  afterAll(() => {
    window.history.replaceState(null, '', '/device/')
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    cleanup()
    vi.restoreAllMocks()
  })

  it('leaves letters to a menu that has focus: there they are its typeahead', async () => {
    render(<DeviceLabPage />)
    act(() => {
      screen.getByRole('button', { name: /Pixel 9/ }).click()
    })
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Apps/ }))
    const more = await screen.findAllByRole(
      'button',
      { name: /^More actions for / },
      { timeout: 4000 },
    )
    fireEvent.keyDown(more[0]!, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    const item = within(menu).getAllByRole('menuitem')[0]!
    item.focus()

    // The Screenshots card's button, the one S presses.
    const shoot = document.querySelector('[aria-keyshortcuts="S"]')
    const filter = screen.getByRole('searchbox', { name: 'Filter devices' })
    const clicks = vi.spyOn(HTMLButtonElement.prototype, 'click')
    for (const key of ['s', 'S', 'r', 'R', '/']) fireEvent.keyDown(item, { key })
    expect(shoot).toHaveAttribute('aria-disabled', 'false')
    expect(clicks).not.toHaveBeenCalled()
    expect(filter).not.toHaveFocus()
    expect(screen.getByRole('menu')).toBe(menu)

    // Outside the menu they are the page's again.
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    fireEvent.keyDown(document.body, { key: 'r' })
    expect(clicks.mock.contexts).toContain(document.querySelector('[data-device-refresh]'))
    fireEvent.keyDown(document.body, { key: 's' })
    expect(shoot).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(document.body, { key: '/' })
    expect(filter).toHaveFocus()
  })
})
