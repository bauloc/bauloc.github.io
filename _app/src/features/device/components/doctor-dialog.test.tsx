// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  browserChecks,
  checklistText,
  featureChecks,
  helperChecks,
  phoneChecks,
} from '../preflight/checks'
import type { BrowserEnv, CheckItem } from '../preflight/types'
import { DoctorDialog, checklistSummary } from './doctor-dialog'

const ENV: BrowserEnv = {
  secure: true,
  https: true,
  href: 'https://bauloc.github.io/device/',
  webusb: true,
  usbPolicy: true,
  inflate: true,
  lna: 'prompt',
  os: 'mac',
  browser: 'chrome',
  version: '1.0.0',
  appUpdated: false,
}

/** What the page shows with Pixel 9 connected and ready, in P1 (no helper). */
const ITEMS: CheckItem[] = [
  ...browserChecks(ENV),
  ...phoneChecks({
    device: { name: 'Pixel 9', state: 'ready', blockers: [] },
    picker: 'picked',
    usb: { kind: 'unknown' },
    authorizingSince: null,
    now: 0,
    os: 'mac',
    browser: 'chrome',
    otherTab: false,
    holder: null,
  }),
  ...helperChecks(null, null),
  ...featureChecks('summary', {
    phone: { name: 'Pixel 9', sdk: 37, release: '17', brand: 'google', manufacturer: 'Google' },
    inflate: true,
  }),
]

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('checklistSummary', () => {
  it('counts what isn’t OK, worst first', () => {
    expect(checklistSummary(ITEMS)).toBe('1 Warning · 8 Not checked')
    expect(checklistSummary(browserChecks(ENV))).toBe('Everything checked is OK.')
    expect(checklistSummary(browserChecks({ ...ENV, appUpdated: true }))).toBe('1 Blocking')
  })
})

describe('DoctorDialog', () => {
  it('groups the rows as This browser · Phone: {name} · Helper · Features', () => {
    render(<DoctorDialog open onOpenChange={vi.fn()} items={ITEMS} phoneName="Pixel 9" />)
    const titles = screen
      .getAllByRole('heading')
      .map((h) => h.textContent)
      .filter((t) => t !== 'Environment check')
    expect(titles).toEqual(['This browser', 'Phone: Pixel 9', 'Helper', 'Features'])
    expect(screen.getByText(/1 Warning · 8 Not checked/)).toBeInTheDocument()
  })

  it('copies the checklist as text, phone name included', async () => {
    render(<DoctorDialog open onOpenChange={vi.fn()} items={ITEMS} phoneName="Pixel 9" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(checklistText(ITEMS, 'Pixel 9'))
    })
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^This browser\nOK — Secure page — /)
  })

  it('closes from its Close button', () => {
    const onOpenChange = vi.fn()
    render(<DoctorDialog open onOpenChange={onOpenChange} items={ITEMS} />)
    const close = screen.getAllByRole('button', { name: 'Close' })
    fireEvent.click(close[0] as HTMLElement)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
