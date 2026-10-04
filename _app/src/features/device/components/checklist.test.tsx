// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserChecks, featureChecks, helperChecks, phoneChecks } from '../preflight/checks'
import type { BrowserEnv, CheckItem, PhoneInput } from '../preflight/types'
import {
  Checklist,
  InlineChecklist,
  collapseRepeats,
  featureButtonProps,
  joinLabels,
  splitFixes,
} from './checklist'

/*
  The checklist as a tester meets it: status words beside every dot, commands shown in full
  and copied byte for byte, buttons only where something answers them, and a compact card
  the feature's button points at. Rows come from the real preflight functions.
*/

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

const NO_PHONE: PhoneInput = {
  device: null,
  picker: 'none',
  usb: { kind: 'unknown' },
  authorizingSince: null,
  now: 0,
  os: 'mac',
  browser: 'chrome',
  otherTab: false,
  holder: null,
}

const ok = (id: CheckItem['id'], label: string): CheckItem => ({
  id,
  group: 'feature',
  label,
  status: 'ok',
  sentence: `${label} is fine.`,
})

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('pure helpers', () => {
  it('joins labels the way a sentence would', () => {
    expect(joinLabels([])).toBe('')
    expect(joinLabels(['Java'])).toBe('Java')
    expect(joinLabels(['Java', 'bundletool'])).toBe('Java and bundletool')
    expect(joinLabels(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('collapses the P1 helper rows, which all say the same thing, into one line', () => {
    const helper = helperChecks(null, null)
    const entries = collapseRepeats(helper)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.labels).toEqual(helper.map((item) => item.label))
    expect(entries[0]?.item.sentence).toBe('Coming with the Device Lab helper.')
  })

  it('keeps rows that carry a fix, a detail or a status worth reading on lines of their own', () => {
    const phone = phoneChecks(NO_PHONE)
    // Step 1 has fixes, step 2 and 4 differ in sentence: nothing merges.
    expect(collapseRepeats(phone)).toHaveLength(phone.length)
    const warnings: CheckItem[] = [
      { ...ok('install.verify', 'A'), status: 'warning', sentence: 'Same.' },
      { ...ok('install.oem', 'B'), status: 'warning', sentence: 'Same.' },
    ]
    expect(collapseRepeats(warnings)).toHaveLength(2)
  })

  it('sorts fixes by how they are drawn', () => {
    const usb = phoneChecks(NO_PHONE).find((item) => item.id === 'phone.usbDebugging')
    const { commands, paths, buttons } = splitFixes(usb?.fixes)
    expect(commands).toEqual([])
    expect(paths.map((f) => f.label)).toEqual([
      'Turn on Developer options',
      'Turn on USB debugging',
    ])
    expect(buttons.map((f) => f.label)).toEqual(['Read Android’s guide'])
  })

  it('describes the feature button by the card, and disables it only while a row blocks', () => {
    expect(featureButtonProps([ok('install.android', 'Android')], 'card')).toEqual({})
    const warning = featureChecks('install', {
      phone: { name: 'Pixel 9', sdk: 37, release: '17', brand: 'google', manufacturer: 'Google' },
    })
    expect(featureButtonProps(warning, 'card')).toEqual({ 'aria-describedby': 'card' })
    const blocking = featureChecks('install', {
      phone: { name: 'Old', sdk: 23, release: '6.0', brand: 'x', manufacturer: 'x' },
    })
    expect(featureButtonProps(blocking, 'card')).toEqual({
      'aria-disabled': true,
      'aria-describedby': 'card',
    })
  })
})

describe('Checklist', () => {
  it('writes every status as a word, not only as a coloured dot', () => {
    const items = [
      ...browserChecks({ ...ENV, webusb: false }),
      ...phoneChecks(NO_PHONE),
      ...helperChecks(null, null),
    ]
    render(<Checklist items={items} phoneName="Pixel 9" />)
    for (const word of ['OK', 'Blocking', 'Warning', 'Not checked']) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0)
    }
    expect(screen.getByRole('heading', { name: 'This browser' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Phone: Pixel 9' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Helper' })).toBeInTheDocument()
    // The eight helper rows read as one line.
    const helper = screen.getByRole('region', { name: 'Helper' })
    expect(within(helper).getAllByRole('listitem')).toHaveLength(1)
    expect(within(helper).getByText(/^Device Lab helper, .* and adb server$/)).toBeInTheDocument()
  })

  it('shows a command in full and copies exactly that command', () => {
    const items = featureChecks('aab', { fileName: 'my app.aab' })
    render(<Checklist items={items} />)
    const command =
      'bundletool build-apks --bundle="my app.aab" --output="my app.apks" --mode=universal'
    expect(screen.getByText(command).tagName).toBe('CODE')
    fireEvent.click(screen.getByRole('button', { name: 'Copy the bundletool command' }))
    expect(writeText).toHaveBeenCalledWith(command)
  })

  it('shows an action only when something answers it, and runs it on click', () => {
    const items = phoneChecks({ ...NO_PHONE, picker: 'dismissed' })
    const { rerender } = render(<Checklist items={items} />)
    expect(screen.queryByRole('button', { name: 'Add device' })).toBeNull()

    const add = vi.fn()
    rerender(<Checklist items={items} wiring={{ on: { 'add-device': add } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }))
    expect(add).toHaveBeenCalledTimes(1)
    // Find my phone… has no handler here, so it isn't offered.
    expect(screen.queryByRole('button', { name: 'Find my phone…' })).toBeNull()
  })

  it('keeps a pending or blocked action focusable but inert', () => {
    const items = phoneChecks({ ...NO_PHONE, picker: 'dismissed' })
    const add = vi.fn()
    const find = vi.fn()
    render(
      <>
        <p id="why">Use Chrome.</p>
        <Checklist
          items={items}
          wiring={{
            on: { 'add-device': add, 'find-phone': find },
            pending: ['find-phone'],
            blocked: ['add-device'],
            blockedBy: 'why',
          }}
        />
      </>,
    )
    const addButton = screen.getByRole('button', { name: 'Add device' })
    expect(addButton).toHaveAttribute('aria-disabled', 'true')
    expect(addButton).toHaveAccessibleDescription('Use Chrome.')
    fireEvent.click(addButton)
    const findButton = screen.getByRole('button', { name: 'Find my phone…' })
    expect(findButton).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(findButton)
    expect(add).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })

  it('renders links as links that open in a new tab, and settings paths as text', () => {
    render(<Checklist items={phoneChecks(NO_PHONE)} />)
    const guide = screen.getByRole('link', { name: /Read Android’s guide/ })
    expect(guide).toHaveAttribute('href', 'https://developer.android.com/studio/debug/dev-options')
    expect(guide).toHaveAttribute('target', '_blank')
    expect(
      screen.getByText(
        'Settings → System → Developer options → USB debugging (some phones: System → Advanced)',
      ),
    ).toBeInTheDocument()
  })
})

describe('InlineChecklist', () => {
  it('renders nothing when every row is OK', () => {
    const { container } = render(
      <InlineChecklist id="card" items={[ok('install.android', 'Android')]} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists only the rows that are not OK, worst first, and the feature button points at it', () => {
    const items: CheckItem[] = [
      ok('install.android', 'Android 7.0 or newer'),
      { ...ok('install.verify', 'Play Protect'), status: 'warning', sentence: 'Watch the phone.' },
      {
        ...ok('install.unzip', 'Unpack .xapk and .apkm'),
        status: 'blocking',
        sentence: 'Update Chrome.',
      },
    ]
    const install = vi.fn()
    render(
      <>
        <InlineChecklist id="install-checks" items={items} />
        <button type="button" {...featureButtonProps(items, 'install-checks')} onClick={install}>
          Install
        </button>
      </>,
    )
    const card = screen.getByRole('note')
    expect(card).toHaveAttribute('id', 'install-checks')
    expect(within(card).getByRole('heading', { name: 'Fix this first' })).toBeInTheDocument()
    expect(within(card).queryByText('Android 7.0 or newer')).toBeNull()
    const labels = within(card)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(labels[0]).toMatch(/^Unpack \.xapk and \.apkm/)
    expect(labels[1]).toMatch(/^Play Protect/)

    const button = screen.getByRole('button', { name: 'Install' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-describedby', 'install-checks')
    expect(button).toHaveAccessibleDescription(/Update Chrome\./)
  })

  it('collapses the .aab card’s “coming with the helper” rows into one', () => {
    render(<InlineChecklist id="aab" items={featureChecks('aab', { fileName: 'app.aab' })} />)
    const rows = within(screen.getByRole('note')).getAllByRole('listitem')
    const text = rows.map((li) => li.textContent ?? '')
    // Worst first: the build can't happen here, then the manual way out, then what is
    // unknown until a phone connects, then the helper's rows as one line.
    expect(text).toHaveLength(4)
    expect(text[0]).toMatch(/^APKs from the \.aabBlocking/)
    expect(text[1]).toMatch(/^Build the \.apks yourselfWarning/)
    expect(text[2]).toMatch(/^Android 7\.0 or newer and Play ProtectNot checked/)
    expect(text[3]).toMatch(/^Device Lab helper, .* and Signing keyNot checkedComing with/)
  })
})
