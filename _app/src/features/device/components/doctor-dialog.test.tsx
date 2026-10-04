// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  browserChecks,
  checklistText,
  featureChecks,
  helperChecks,
  phoneChecks,
} from '../preflight/checks'
import { deviceChecks, sortChecks } from '../preflight/checks'
import type { BrowserEnv, CheckItem } from '../preflight/types'
import { DoctorDialog, aboutRows, checklistSummary, environmentText } from './doctor-dialog'
import { REPORT, helperStatus } from './helper-status.fixture'

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

beforeAll(() => {
  // Radix's Switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

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

describe('DoctorDialog, with the local helper', () => {
  const status = helperStatus('connected', {
    pairing: { tokenId: '4d1566a1', remembered: false, tokenPersistent: false },
  })
  const items: CheckItem[] = [
    ...browserChecks(ENV),
    ...sortChecks([
      ...helperChecks(status, REPORT, {
        webusb: true,
        published: { version: '1.0.0', sha256: 'ab'.repeat(32) },
      }),
      ...deviceChecks([], { connected: true, webusb: true }),
    ]),
  ]
  const about = aboutRows({
    status,
    doctor: REPORT,
    version: '2026.10.04',
    mock: false,
    devices: [{ backend: 'agent' }, { backend: 'webusb' }],
  })

  it('lists the About rows, never with the token', () => {
    expect(about).toEqual([
      { label: 'Page mode', value: 'Hosted' },
      { label: 'Helper address', value: 'http://127.0.0.1:8787' },
      { label: 'UI version', value: '2026.10.04' },
      { label: 'Mock devices', value: 'Off' },
      { label: 'Devices seen', value: '2 (1 through the helper)' },
      { label: 'Helper', value: '1.0.0 · protocol 1' },
      { label: 'Helper runs on', value: 'Node 24.12.0 · darwin-arm64 · macOS 27.0.1' },
      { label: 'Helper started', value: '09:30' },
      { label: 'Helper options', value: '--simulators' },
      { label: 'Fingerprint', value: '4d1566a1' },
    ])
    expect(
      aboutRows({
        status: helperStatus('off', {
          env: { ...status.env, mode: 'local', apiBase: 'http://127.0.0.1:8787' },
        }),
        doctor: null,
        version: '1',
        mock: true,
        devices: [],
      }).slice(0, 5),
    ).toEqual([
      { label: 'Page mode', value: 'The helper’s own page' },
      { label: 'Helper address', value: 'http://127.0.0.1:8787' },
      { label: 'UI version', value: '1' },
      { label: 'Mock devices', value: 'On' },
      { label: 'Devices seen', value: '0' },
    ])
  })

  it('groups the helper’s rows as Helper · This Mac · iPhone tools · Devices · Optional tools', () => {
    render(<DoctorDialog open onOpenChange={vi.fn()} items={items} about={about} />)
    const titles = screen
      .getAllByRole('heading')
      .map((h) => h.textContent)
      .filter((t) => t !== 'Environment check')
    expect(titles).toEqual([
      'About',
      'This browser',
      'Helper',
      'This Mac',
      'iPhone tools',
      'Devices',
      'Optional tools',
    ])
    expect(screen.getByText('Matches the published helper (1.0.0).')).toBeInTheDocument()
    expect(screen.getByText('python3 -m pip install -U pymobiledevice3').tagName).toBe('CODE')
  })

  it('copies the About rows and every row as text, never the token', async () => {
    const token = 'Qx7-' + 'a'.repeat(39)
    const withToken = [{ label: 'Oops', value: token }, ...about]
    render(<DoctorDialog open onOpenChange={vi.fn()} items={items} about={withToken} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    const text = writeText.mock.calls[0]?.[0] ?? ''
    expect(text).toBe(environmentText(withToken, items))
    expect(text).not.toContain(token)
    expect(text).toMatch(/^About\nOops: …\nPage mode: Hosted\n/)
    expect(text).toContain('\n\nThis Mac\nOK — Node 24.12.0 — Node 24.12.0 runs the helper.')
  })

  it('re-checks, forgets the pairing and remembers it, from its own controls', () => {
    const onRecheck = vi.fn()
    const onForget = vi.fn()
    const onChange = vi.fn()
    const { rerender } = render(
      <DoctorDialog
        open
        onOpenChange={vi.fn()}
        items={items}
        about={about}
        onRecheck={onRecheck}
        onForget={onForget}
        remember={{ on: false, note: 'Keeps this browser paired.', onChange }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(onRecheck).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }))
    expect(onForget).toHaveBeenCalledTimes(1)
    const toggle = screen.getByRole('switch', { name: 'Remember on this computer' })
    expect(toggle).toHaveAccessibleDescription('Keeps this browser paired.')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)

    // While it runs, Re-check keeps focus and does nothing more.
    rerender(
      <DoctorDialog
        open
        onOpenChange={vi.fn()}
        items={items}
        about={about}
        onRecheck={onRecheck}
        rechecking
      />,
    )
    const busy = screen.getByRole('button', { name: 'Checking…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    expect(onRecheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Forget pairing' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
