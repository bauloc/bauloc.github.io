// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Device } from '../model'
import { inlineChecks, toolChecks } from '../preflight/checks'
import { DeviceDetailPane, screenshotTitle, screenshotVia } from './device-detail'
import { LANES, REPORT, helperStatus } from './helper-status.fixture'

afterEach(() => {
  cleanup()
})

const IPHONE: Device = {
  id: '00008101-000A1B2C3D4E5F02',
  backend: 'agent',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone',
  model: 'iPhone 12 Pro',
  osVersion: '27.0',
  blockers: ['XCODE_REQUIRED'],
  capabilities: { screenshot: false, identifiers: true, logs: true },
}

function pane(props: Partial<ComponentProps<typeof DeviceDetailPane>> = {}) {
  const onCapture = vi.fn()
  const onRetry = vi.fn(() => Promise.resolve())
  render(
    <DeviceDetailPane
      device={IPHONE}
      goneId={null}
      detail={{ status: 'idle' }}
      shots={[]}
      zoom={160}
      capturing={false}
      retrying={false}
      tab="overview"
      onTab={vi.fn()}
      onCapture={onCapture}
      onRetry={onRetry}
      onReloadDetail={vi.fn()}
      onDoctor={vi.fn()}
      onZoom={vi.fn()}
      onClearShots={vi.fn()}
      {...props}
    />,
  )
  return { onCapture, onRetry }
}

describe('screenshotVia and screenshotTitle', () => {
  it('names the tool that takes the screenshot', () => {
    expect(screenshotVia(IPHONE, LANES)).toBe('Xcode’s devicectl')
    expect(screenshotVia(IPHONE, { ...LANES, ios: { ...LANES.ios, screenshots: 'none' } })).toBe(
      null,
    )
    expect(screenshotVia({ ...IPHONE, connection: 'simulator' }, LANES)).toBe('simctl')
    expect(screenshotVia({ ...IPHONE, platform: 'android' }, null)).toBe('Google’s adb server')
    expect(screenshotVia({ ...IPHONE, backend: 'webusb', platform: 'android' }, null)).toBe(
      'WebUSB',
    )
    expect(screenshotVia({ ...IPHONE, backend: 'mock' }, LANES)).toBeNull()
  })

  it('says why the button can’t be used', () => {
    expect(screenshotTitle({ state: 'locked', capabilities: {} }, null)).toBe(
      'The device is not ready',
    )
    expect(screenshotTitle(IPHONE, 'Xcode’s devicectl')).toBe(
      'Screenshots are unavailable for this device — see the note above.',
    )
    expect(
      screenshotTitle({ ...IPHONE, capabilities: { screenshot: true } }, 'Xcode’s devicectl'),
    ).toBe('Take a screenshot (S) · through Xcode’s devicectl')
  })
})

describe('DeviceDetailPane, a helper device', () => {
  const inline = inlineChecks(IPHONE, toolChecks(helperStatus('connected'), REPORT))

  it('lists the tool its blocker needs under the hint, and points the button at it', () => {
    const { onCapture } = pane({ inline })
    const note = screen.getAllByRole('note').at(-1)
    expect(note).toBeDefined()
    if (!note) return
    expect(within(note).getByText('Xcode')).toBeInTheDocument()
    expect(within(note).getByRole('link', { name: /Get Xcode from the App Store/ })).toBeTruthy()
    // The header's button and the Screenshots card's say the same, and neither takes one.
    const buttons = screen.getAllByRole('button', { name: 'Take Screenshot' })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAttribute(
        'title',
        'Screenshots are unavailable for this device — see the note above.',
      )
      expect(button).toHaveAccessibleDescription(/Xcode isn’t installed/)
      fireEvent.click(button)
    }
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('names the tool in the tooltip of a device that can take screenshots', () => {
    const { onCapture } = pane({
      device: { ...IPHONE, blockers: [], capabilities: { screenshot: true } },
      captureVia: 'Xcode’s devicectl',
    })
    const buttons = screen.getAllByRole('button', { name: 'Take Screenshot' })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toHaveAttribute('title', 'Take a screenshot (S) · through Xcode’s devicectl')
      fireEvent.click(button)
    }
    expect(onCapture).toHaveBeenCalledTimes(2)
  })
})
