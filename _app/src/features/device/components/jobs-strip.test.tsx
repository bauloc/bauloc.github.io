// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEVICE_ERRORS, fileChangedFailure } from '../backends/backend'
import {
  JobsStrip,
  ProgressBar,
  fmtTransfer,
  jobPhaseText,
  percentOf,
  type StripJob,
} from './jobs-strip'

/*
  The jobs strip: every phase in words, the numbers a tester reads off a transfer, a Cancel
  only while the work can still be stopped, and an ended job's result until it is dismissed.
*/

afterEach(cleanup)

const MB = 1024 * 1024

const job = (over: Partial<StripJob> = {}): StripJob => ({
  id: 'job-1',
  deviceId: 'pixel',
  deviceName: 'Pixel 9',
  kind: 'install',
  label: 'Probe',
  phase: 'sending',
  sent: 21.5 * MB,
  total: 34.7 * MB,
  ...over,
})

describe('fmtTransfer', () => {
  it('writes both numbers in the total’s unit', () => {
    expect(fmtTransfer(21.5 * MB, 34.7 * MB)).toBe('21.5 of 34.7 MB')
    expect(fmtTransfer(512 * 1024, 34.7 * MB)).toBe('0.5 of 34.7 MB')
    expect(fmtTransfer(0, 2 * 1024 * MB)).toBe('0.0 of 2.0 GB')
  })

  it('keeps bytes whole and drops decimals past 100', () => {
    expect(fmtTransfer(300, 900)).toBe('300 of 900 B')
    expect(fmtTransfer(150 * MB, 210 * MB)).toBe('150 of 210 MB')
  })
})

describe('percentOf', () => {
  it('floors, and says 100 only when every byte is there', () => {
    expect(percentOf(62.9, 100)).toBe(62)
    expect(percentOf(99.99, 100)).toBe(99)
    expect(percentOf(100, 100)).toBe(100)
    expect(percentOf(5, 0)).toBe(0)
  })
})

describe('jobPhaseText', () => {
  it('words each phase', () => {
    expect(jobPhaseText(job())).toBe('Sending · 21.5 of 34.7 MB · 61%')
    expect(jobPhaseText(job({ total: 0 }))).toBe('Sending…')
    expect(jobPhaseText(job({ phase: 'installing' }))).toBe('Installing on the phone…')
    expect(jobPhaseText(job({ phase: 'cancelled' }))).toBe('Cancelled. Nothing was installed.')
  })

  it('says how an ended install went', () => {
    const ok = { ok: true as const, warnings: [], output: 'Success' }
    expect(jobPhaseText(job({ phase: 'done', outcome: ok }))).toBe('Installed')
    expect(jobPhaseText(job({ phase: 'done', outcome: { ...ok, warnings: ['w'] } }))).toBe(
      'Installed, with warnings',
    )
    const refused = {
      ok: false as const,
      code: 'INSUFFICIENT_STORAGE' as const,
      androidCode: 'INSTALL_FAILED_INSUFFICIENT_STORAGE',
      message: '',
      params: {},
      output: '',
    }
    expect(jobPhaseText(job({ phase: 'failed', outcome: refused }))).toBe(
      'Didn’t install: Not enough free space on the phone.',
    )
    // Not the phone's refusal: the file changed in this tab after it was picked.
    expect(jobPhaseText(job({ phase: 'failed', outcome: fileChangedFailure() }))).toBe(
      `Didn’t install: ${DEVICE_ERRORS.FILE_CHANGED}`,
    )
  })
})

describe('ProgressBar', () => {
  it('reports a known amount as a percentage', () => {
    render(<ProgressBar label="Sending to Pixel 9" value={50} max={200} />)
    const bar = screen.getByRole('progressbar', { name: 'Sending to Pixel 9' })
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  it('has no value while the amount is unknown', () => {
    render(<ProgressBar label="Installing on the phone" />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })
})

describe('JobsStrip', () => {
  it('renders nothing without jobs', () => {
    const { container } = render(<JobsStrip jobs={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a running job with its phase and progress, and cancels it', () => {
    const cancel = vi.fn()
    render(<JobsStrip jobs={[job({ cancel })]} onDismiss={vi.fn()} />)
    const strip = screen.getByRole('region', { name: 'Jobs' })
    expect(within(strip).getByText('Probe')).toBeInTheDocument()
    expect(within(strip).getByText('Sending · 21.5 of 34.7 MB · 61%')).toBeInTheDocument()
    expect(within(strip).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '61')
    // A running job can't be dismissed.
    expect(within(strip).queryByRole('button', { name: 'Dismiss Probe' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel installing Probe' }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('has no Cancel once Android commits, and no number for it', () => {
    render(<JobsStrip jobs={[job({ phase: 'installing' })]} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Installing on the phone…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it('keeps an ended job with Show and Dismiss', () => {
    const onShow = vi.fn()
    const onDismiss = vi.fn()
    const ended = job({ phase: 'cancelled' })
    render(<JobsStrip jobs={[ended]} onShow={onShow} onDismiss={onDismiss} />)
    expect(screen.getByText('Cancelled. Nothing was installed.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(onShow).toHaveBeenCalledWith(ended)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Probe' }))
    expect(onDismiss).toHaveBeenCalledWith('job-1')
  })

  it('names the device only when jobs of several devices are listed', () => {
    const { rerender } = render(<JobsStrip jobs={[job()]} />)
    expect(screen.queryByText('Pixel 9')).toBeNull()
    rerender(
      <JobsStrip
        jobs={[
          job(),
          job({ id: 'job-2', deviceId: 'galaxy', deviceName: 'Galaxy S24', label: 'Maps' }),
        ]}
      />,
    )
    expect(screen.getByText('Pixel 9')).toBeInTheDocument()
    expect(screen.getByText('Galaxy S24')).toBeInTheDocument()
  })
})
