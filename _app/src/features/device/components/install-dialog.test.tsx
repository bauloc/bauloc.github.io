// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { readFileSync } from 'node:fs'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEVICE_ERRORS, fileChangedFailure, type InstallFacts } from '../backends/backend'
import type { InstallFailure, InstallOutcome } from '../backends/android/pm-output'
import type * as PlanModule from '../backends/archive/plan'
import type { InstallPart, InstallPlan } from '../backends/archive/plan'
import type { CheckItem } from '../preflight/types'
import {
  InstallDialog,
  appName,
  argbCss,
  detailsText,
  failureWording,
  featureOf,
  imageUrl,
  initialOf,
  installGate,
  installOptions,
  issueRows,
  NO_CONSENT,
  partReason,
  selectionLine,
  sendingText,
  successTitle,
  uninstallFirstGate,
  type InstallActions,
  type InstallDialogProps,
  type InstallJob,
  type InstallResult,
} from './install-dialog'

/*
  The Install dialog as a tester meets it: what the file is, what stands in the way and the
  consent that gets past it, progress with Cancel until Android commits, and every outcome in
  plain words with its way forward. The planner is real where a fixture can drive it (the
  probe .aab) and scripted where the test is about the dialog, not the archive.
*/

const planner = vi.hoisted(() => ({ next: null as InstallPlan | null }))

vi.mock('../backends/archive/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof PlanModule>()
  return {
    ...actual,
    planInstall: (files: readonly File[], spec: Parameters<typeof actual.planInstall>[1]) => {
      const scripted = planner.next
      return scripted ? Promise.resolve(scripted) : actual.planInstall(files, spec)
    },
  }
})

beforeAll(() => {
  // Radix's Switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  planner.next = null
  vi.restoreAllMocks()
})

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const SPEC = {
  supportedAbis: ['arm64-v8a'],
  supportedLocales: ['en-US'],
  deviceFeatures: [],
  glExtensions: [],
  screenDensity: 420,
  sdkVersion: 36,
}

const PHONE = {
  name: 'Pixel 9',
  sdk: 36,
  release: '16',
  brand: 'google',
  manufacturer: 'Google',
}

const FACTS: InstallFacts = {
  sdk: 36,
  freeBytes: 8 * 1024 ** 3,
  installed: null,
  verifyAdbInstalls: '0',
}

const part = (over: Partial<InstallPart> = {}): InstallPart => ({
  name: '0.apk',
  source: 'base.apk',
  split: '',
  role: { module: 'base', kind: 'base', value: '' },
  size: 2_000_000,
  open: () => Promise.resolve(new ReadableStream<Uint8Array>()),
  ...over,
})

function makePlan(over: Partial<InstallPlan> = {}): InstallPlan {
  return {
    kind: 'apk',
    inputs: [{ name: 'probe.apk', size: 2_000_000, kind: 'apk', used: true }],
    app: {
      packageName: 'com.example.probe',
      versionCode: 812,
      versionName: '1.4.0',
      minSdk: 24,
      targetSdk: 35,
      testOnly: false,
      debuggable: false,
      nativeAbis: [],
      label: 'Probe',
      icon: null,
    },
    parts: [part()],
    totalBytes: 2_000_000,
    selection: null,
    expansions: [],
    problems: [],
    warnings: [],
    notes: [],
    ...over,
  }
}

const failure = (over: Partial<InstallFailure>): InstallFailure => ({
  ok: false,
  code: 'UNKNOWN',
  androidCode: null,
  message: '',
  params: {},
  output: '',
  ...over,
})

const success: InstallOutcome = { ok: true, warnings: [], output: 'Success' }

const done = (outcome: InstallOutcome): InstallResult => ({
  phase: outcome.ok ? 'done' : 'failed',
  outcome,
})

/**
 * An install the test drives, as the store runs it: the job moves through its phases in the
 * `job` prop, and lab.install's promise settles with how it ended.
 */
function drivenInstall(view: ReturnType<typeof renderDialog>) {
  let settle: (result: InstallResult) => void = () => {}
  const cancel = vi.fn(() => {
    settle({ phase: 'cancelled' })
  })
  const install = vi.fn<InstallActions['install']>(
    () =>
      new Promise<InstallResult>((resolve) => {
        settle = resolve
      }),
  )
  const show = (job: InstallJob | null) => {
    view.props.job = job
    view.rerender(<InstallDialog {...view.props} />)
  }
  return {
    install,
    cancel,
    sending: (sent: number, total = 2_000_000) => {
      show({ id: 'job_1', phase: 'sending', sent, total, phaseSince: Date.now(), cancel })
    },
    installing: () => {
      show({ id: 'job_1', phase: 'installing', sent: 2e6, total: 2e6, phaseSince: Date.now() })
    },
    settle: async (result: InstallResult) => {
      await act(async () => {
        settle(result)
        await Promise.resolve()
      })
      show(null)
    },
  }
}

function fakeActions(over: Partial<InstallActions> = {}): InstallActions {
  return {
    deviceSpec: vi.fn(() => Promise.resolve(SPEC)),
    installFacts: vi.fn(() => Promise.resolve(FACTS)),
    install: vi.fn(() => Promise.resolve(done(success))),
    openApp: vi.fn(() => Promise.resolve()),
    uninstall: vi.fn(() => Promise.resolve()),
    ...over,
  }
}

const FILES = [new File(['x'], 'probe.apk')]

function renderDialog(props: Partial<InstallDialogProps> = {}) {
  const all: InstallDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    device: { id: 'pixel', name: 'Pixel 9' },
    phone: PHONE,
    ready: true,
    job: null,
    files: FILES,
    actions: fakeActions(),
    ...props,
  }
  return { ...render(<InstallDialog {...all} />), props: all }
}

const installButton = () => screen.findByRole('button', { name: 'Install' })

/* ---------------------------------------------------------------- *
 * Pure helpers
 * ---------------------------------------------------------------- */

describe('reading the plan', () => {
  it('picks the preflight rows by container', () => {
    expect(featureOf(makePlan())).toBe('install')
    expect(featureOf(makePlan({ kind: 'apks' }))).toBe('install')
    expect(featureOf(makePlan({ kind: 'xapk' }))).toBe('xapk')
    expect(featureOf(makePlan({ kind: 'aab' }))).toBe('aab')
    const encrypted = makePlan({
      kind: 'none',
      inputs: [{ name: 'old.apkm', size: 9, kind: 'apkm-encrypted', used: false }],
    })
    expect(featureOf(encrypted)).toBe('apkm')
  })

  it('lists problems then warnings, leaving out what a preflight row says', () => {
    const plan = makePlan({
      problems: [
        { code: 'AAB_NEEDS_HELPER', message: 'needs the helper' },
        { code: 'OLDER_SDK', message: 'too new' },
      ],
      warnings: [{ code: 'LOW_SPACE', message: 'tight' }],
    })
    const phone = {
      problems: [{ code: 'INSUFFICIENT_SPACE' as const, message: 'no room' }],
      warnings: [],
      notes: [],
    }
    expect(issueRows(plan, phone).map((r) => [r.status, r.sentence])).toEqual([
      ['blocking', 'too new'],
      ['blocking', 'no room'],
      ['warning', 'tight'],
    ])
  })
})

describe('installGate', () => {
  const where = { deviceName: 'Pixel 9', ready: true, busy: false }
  const blockingCheck: CheckItem = {
    id: 'install.unzip',
    group: 'feature',
    label: 'Unpack',
    status: 'blocking',
    sentence: 'no',
  }

  it('opens when nothing stands in the way', () => {
    expect(installGate(makePlan(), [], [], NO_CONSENT, where)).toBeNull()
  })

  it('says why it stays shut', () => {
    const plan = makePlan()
    expect(installGate(plan, [], [], NO_CONSENT, { ...where, ready: false })).toBe(
      'Pixel 9 isn’t ready. Reconnect it to install.',
    )
    expect(installGate(plan, [], [], NO_CONSENT, { ...where, busy: true })).toMatch(
      /^Another install is running on Pixel 9/,
    )
    expect(installGate(plan, [blockingCheck], [], NO_CONSENT, where)).toMatch(/Blocking/)
    expect(installGate(makePlan({ parts: [] }), [], [], NO_CONSENT, where)).toMatch(/Blocking/)
  })

  it('waits for the consent a warning asks for', () => {
    const plan = makePlan()
    const anyway = [
      { key: 'w', status: 'warning' as const, sentence: 'old', action: 'install-anyway' as const },
    ]
    expect(installGate(plan, [], anyway, NO_CONSENT, where)).toMatch(/Install anyway/)
    expect(installGate(plan, [], anyway, { ...NO_CONSENT, bypass: true }, where)).toBeNull()
    const downgrade = [{ ...anyway[0]!, action: 'allow-downgrade' as const }]
    expect(installGate(plan, [], downgrade, NO_CONSENT, where)).toMatch(/Allow downgrade/)
    expect(installGate(plan, [], downgrade, { ...NO_CONSENT, downgrade: true }, where)).toBeNull()
  })

  it('lets “Uninstall and install” run only when the installed copy is all that blocks', () => {
    const plan = makePlan()
    const downgrade = {
      key: 'blocking-VERSION_DOWNGRADE-0',
      status: 'blocking' as const,
      sentence: 'A newer version is installed.',
      action: 'uninstall-first' as const,
    }
    expect(installGate(plan, [], [downgrade], NO_CONSENT, where)).toMatch(/Blocking/)
    expect(uninstallFirstGate(plan, [], [downgrade], NO_CONSENT, where)).toBeNull()

    // Anything else in the way would fail the install after the app's data was deleted.
    const noAbi = { key: 'blocking-NO_MATCHING_ABIS-0', status: 'blocking' as const, sentence: 'x' }
    const helpless = /^Uninstalling wouldn’t help yet/
    expect(uninstallFirstGate(plan, [], [noAbi, downgrade], NO_CONSENT, where)).toMatch(helpless)
    expect(uninstallFirstGate(makePlan({ parts: [] }), [], [downgrade], NO_CONSENT, where)).toMatch(
      helpless,
    )
    expect(uninstallFirstGate(plan, [blockingCheck], [downgrade], NO_CONSENT, where)).toMatch(
      helpless,
    )
    const anyway = {
      key: 'w',
      status: 'warning' as const,
      sentence: 'old',
      action: 'install-anyway' as const,
    }
    expect(uninstallFirstGate(plan, [], [downgrade, anyway], NO_CONSENT, where)).toMatch(
      /Install anyway/,
    )
    expect(
      uninstallFirstGate(plan, [], [downgrade], NO_CONSENT, { ...where, ready: false }),
    ).toMatch(/isn’t ready/)
  })

  it('turns consent into flags', () => {
    expect(installOptions({ bypass: true, downgrade: false, grant: true })).toEqual({
      grantPermissions: true,
      allowDowngrade: false,
      bypassLowTargetSdkBlock: true,
    })
  })
})

describe('wording', () => {
  it('names the app by label, package, then file', () => {
    expect(appName(makePlan())).toBe('Probe')
    const unlabelled = makePlan()
    expect(appName({ ...unlabelled, app: { ...unlabelled.app!, label: null } })).toBe(
      'com.example.probe',
    )
    expect(appName(makePlan({ app: null }))).toBe('probe.apk')
  })

  it('summarises a picked set', () => {
    expect(selectionLine(makePlan())).toBeNull()
    const set = makePlan({
      parts: [part(), part({ name: '1.apk' }), part({ name: '2.apk' })],
      selection: { offered: 9, abi: 'arm64-v8a', density: 'xxhdpi', languages: ['en', 'vi'] },
    })
    expect(selectionLine(set)).toBe('3 of 9 APKs for this phone · arm64-v8a · xxhdpi · en, vi')
  })

  it('says why each part was picked', () => {
    const role = (r: InstallPart['role']) => partReason({ role: r })
    expect(role({ module: 'base', kind: 'base', value: '' })).toBe('The app itself')
    expect(role({ module: 'base', kind: 'abi', value: 'arm64-v8a' })).toBe(
      'Native code for arm64-v8a',
    )
    expect(role({ module: 'maps', kind: 'language', value: 'vi' })).toBe('Language vi of maps')
    expect(role({ module: 'base', kind: 'density', value: '480' })).toBe(
      'Graphics for 480 dpi screens',
    )
    expect(role({ module: 'levels', kind: 'asset-pack', value: '' })).toBe(
      'Asset pack levels, installed with the app',
    )
  })

  it('writes the sending line the plan shows', () => {
    const MB = 1024 * 1024
    expect(sendingText('Pixel 9', 21.5 * MB, 34.7 * MB, 28 * MB)).toBe(
      'Sending to Pixel 9 · 21.5 of 34.7 MB · 61% · 28 MB/s',
    )
    expect(sendingText('Pixel 9', 0, 34.7 * MB, null)).toBe(
      'Sending to Pixel 9 · 0.0 of 34.7 MB · 0%',
    )
  })

  it('says what was installed, with its version', () => {
    expect(successTitle(makePlan(), 'Pixel 9')).toBe('Installed Probe 1.4.0 (812) on Pixel 9.')
  })

  it('fills the failure wording from the file and the phone when Android didn’t say', () => {
    const plan = makePlan()
    const installed = { versionCode: 900, versionName: '1.5.0', debuggable: false }
    const down = failureWording(failure({ code: 'VERSION_DOWNGRADE' }), {
      plan,
      spec: SPEC,
      facts: { installed },
    })
    expect(down.text).toBe(
      'The phone has a newer version (1.5.0 (900)) than this file (1.4.0 (812)).',
    )
    expect(down.action?.kind).toBe('uninstall-and-install')

    const debuggable = failureWording(failure({ code: 'VERSION_DOWNGRADE' }), {
      plan,
      spec: SPEC,
      facts: { installed: { ...installed, debuggable: true } },
    })
    expect(debuggable.action?.kind).toBe('allow-downgrade')

    const abis = failureWording(failure({ code: 'NO_MATCHING_ABIS' }), {
      plan,
      spec: SPEC,
      facts: null,
    })
    expect(abis.text).toBe(
      'This app has no native code for arm64-v8a. This phone runs 64-bit apps only.',
    )
  })

  it('lets Android’s own values win', () => {
    const wording = failureWording(
      failure({ code: 'OLDER_SDK', params: { requiredSdk: '37', deviceSdk: '36' } }),
      { plan: makePlan(), spec: { ...SPEC, sdkVersion: 30 }, facts: null },
    )
    expect(wording.text).toBe('This app needs Android API 37. This phone has API 36.')
  })

  it('says a browser-side failure in its own words, with Retry', () => {
    const wording = failureWording(failure({ message: 'A file changed size while it was sent.' }), {
      plan: makePlan(),
      spec: SPEC,
      facts: null,
    })
    expect(wording.text).toBe('A file changed size while it was sent.')
    expect(wording.action).toEqual({ kind: 'retry', label: 'Retry' })
  })

  it('says a file that changed since it was picked must be picked again, without Retry', () => {
    const wording = failureWording(fileChangedFailure(), {
      plan: makePlan(),
      spec: SPEC,
      facts: null,
    })
    expect(wording.text).toBe(DEVICE_ERRORS.FILE_CHANGED)
    expect(wording.action).toBeNull()
  })

  it('puts Android’s code first in the details, without repeating itself', () => {
    expect(
      detailsText(
        failure({
          androidCode: 'INSTALL_FAILED_ABORTED',
          message: 'User rejected permissions',
          output: 'Failure [INSTALL_FAILED_ABORTED: User rejected permissions]\n',
        }),
      ),
    ).toBe(
      'INSTALL_FAILED_ABORTED: User rejected permissions\n\nFailure [INSTALL_FAILED_ABORTED: User rejected permissions]',
    )
    expect(detailsText(failure({ message: 'x', output: 'x' }))).toBe('x')
  })
})

describe('icons', () => {
  it('turns ARGB into a CSS colour at runtime', () => {
    expect(argbCss(0xff3ddc84)).toBe('rgb(61 220 132 / 1)')
    expect(argbCss(0x80000000)).toBe('rgb(0 0 0 / 0.502)')
  })

  it('embeds the bitmap as a data URL', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(imageUrl({ mime: 'image/png', bytes })).toBe('data:image/png;base64,iVBORw==')
  })

  it('falls back to an initial', () => {
    expect(initialOf('Probe')).toBe('P')
    expect(initialOf('com.example.maps')).toBe('M')
    expect(initialOf('')).toBe('?')
  })
})

/* ---------------------------------------------------------------- *
 * The dialog
 * ---------------------------------------------------------------- */

describe('InstallDialog', () => {
  it('reads the file, then shows the app and an enabled Install', async () => {
    planner.next = makePlan()
    const actions = fakeActions()
    renderDialog({ actions })
    expect(screen.getByRole('status')).toHaveTextContent('Reading probe.apk and Pixel 9’s details…')
    const install = await installButton()
    expect(install).not.toHaveAttribute('aria-disabled')
    expect(screen.getByText('Probe')).toBeInTheDocument()
    expect(screen.getByText('1.4.0 (812) · com.example.probe · 1.9 MB')).toBeInTheDocument()
    expect(actions.installFacts).toHaveBeenCalledWith('com.example.probe')
  })

  it('follows the job: progress and Cancel, then installing, then Open app', async () => {
    planner.next = makePlan()
    const view = renderDialog()
    const run = drivenInstall(view)
    view.props.actions = fakeActions({ install: run.install })
    view.rerender(<InstallDialog {...view.props} />)
    fireEvent.click(await installButton())

    expect(run.install).toHaveBeenCalledOnce()
    expect(run.install.mock.calls[0]?.[1]).toEqual({
      grantPermissions: false,
      allowDowngrade: false,
      bypassLowTargetSdkBlock: false,
    })
    run.sending(1_000_000)
    expect(screen.getByRole('progressbar', { name: 'Sending to Pixel 9' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
    expect(screen.getByText(/^Sending to Pixel 9 · 1\.0 of 1\.9 MB · 50%/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel install' })).toBeInTheDocument()

    run.installing()
    expect(screen.getByText('Installing on the phone…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel install' })).toBeNull()

    await run.settle(done(success))
    expect(await screen.findByText('Installed Probe 1.4.0 (812) on Pixel 9.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }))
    expect(view.props.actions.openApp).toHaveBeenCalledWith('com.example.probe')
  })

  it('cancels through the job, and says nothing was installed', async () => {
    planner.next = makePlan()
    const view = renderDialog()
    const run = drivenInstall(view)
    view.props.actions = fakeActions({ install: run.install })
    view.rerender(<InstallDialog {...view.props} />)
    fireEvent.click(await installButton())
    run.sending(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel install' }))
    expect(run.cancel).toHaveBeenCalledOnce()
    expect(await screen.findByText('Cancelled. Nothing was installed.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to install' }))
    expect(await installButton()).toBeInTheDocument()
  })

  it('keeps Install shut while another install runs on the phone', async () => {
    planner.next = makePlan()
    renderDialog({
      job: { id: 'job_9', phase: 'sending', sent: 0, total: 1, phaseSince: 0, cancel: vi.fn() },
    })
    const install = await installButton()
    expect(install).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText('Another install is running on Pixel 9. Wait for it to finish.'),
    ).toBeInTheDocument()
  })

  it('says why when the store refuses to start', async () => {
    planner.next = makePlan()
    renderDialog({
      actions: fakeActions({
        install: vi.fn(() => Promise.reject(new Error('INSTALL_IN_PROGRESS'))),
      }),
    })
    fireEvent.click(await installButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An install is already running on this phone. Wait for it, or cancel it.',
    )
  })

  it('holds Install until “Install anyway” is on, then sends the bypass flag', async () => {
    planner.next = makePlan({
      warnings: [
        {
          code: 'DEPRECATED_SDK_VERSION',
          message: 'This app targets an old Android (API 22).',
          action: 'install-anyway',
        },
      ],
    })
    const actions = fakeActions()
    renderDialog({ actions })
    const install = await installButton()
    expect(install).toHaveAttribute('aria-disabled', 'true')
    const reason = screen.getByText(/Turn on “Install anyway”/)
    expect(install.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id)

    fireEvent.click(install)
    expect(actions.install).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('switch', { name: 'Install anyway' }))
    expect(install).not.toHaveAttribute('aria-disabled')
    fireEvent.click(install)
    await waitFor(() => {
      expect(actions.install).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(actions.install).mock.calls[0]?.[1].bypassLowTargetSdkBlock).toBe(true)
  })

  it('offers Allow downgrade under Options for a debuggable install', async () => {
    planner.next = makePlan({ app: { ...makePlan().app!, versionCode: 1 } })
    const actions = fakeActions({
      installFacts: vi.fn(() =>
        Promise.resolve({
          ...FACTS,
          installed: { versionCode: 900, versionName: '1.5.0', debuggable: true },
        }),
      ),
    })
    renderDialog({ actions })
    const install = await installButton()
    expect(screen.getByText(/A newer version is installed \(1\.5\.0 \(900\)\)/)).toBeInTheDocument()
    expect(install).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('switch', { name: 'Allow downgrade' }))
    fireEvent.click(install)
    await waitFor(() => {
      expect(actions.install).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(actions.install).mock.calls[0]?.[1].allowDowngrade).toBe(true)
  })

  it('shows the .aab prerequisite card and the manual bundletool command', async () => {
    // Under jsdom import.meta.url isn't a file: URL; tests run from _app/.
    const aab = readFileSync('src/features/device/backends/archive/__fixtures__/probe.aab')
    const file = new File([aab], 'my app.aab')
    renderDialog({ files: [file] })
    const install = await installButton()
    expect(install).toHaveAttribute('aria-disabled', 'true')

    const card = screen.getByRole('note', { name: 'Fix this first' })
    expect(install.getAttribute('aria-describedby')?.split(' ')).toContain(card.id)
    expect(
      within(card).getByText(
        'Browsers can’t install an .aab directly: bundletool has to build APKs from it first.',
      ),
    ).toBeInTheDocument()
    // The command uses the tester's own file name, quoted for a terminal.
    expect(
      within(card).getByText(
        'bundletool build-apks --bundle="my app.aab" --output="my app.apks" --mode=universal',
      ),
    ).toBeInTheDocument()
    // The helper's rows are one line, not eight.
    expect(within(card).getAllByText('Coming with the Device Lab helper.')).toHaveLength(1)
    // The plan's own "needs the helper" sentence is the card's job.
    expect(screen.queryByText(/is an app bundle/)).toBeNull()
  })

  it('confirms before replacing a differently signed copy, then uninstalls and installs', async () => {
    planner.next = makePlan()
    const install = vi
      .fn<InstallActions['install']>()
      .mockResolvedValueOnce(
        done(
          failure({
            code: 'UPDATE_INCOMPATIBLE',
            androidCode: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
            message: 'Existing package signatures do not match',
            output: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: …]',
          }),
        ),
      )
      .mockResolvedValueOnce(done(success))
    const actions = fakeActions({ install })
    renderDialog({ actions })
    fireEvent.click(await installButton())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t install Probe')
    expect(alert).toHaveTextContent(
      'A different build of this app is installed, signed with another key',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and install…' }))

    const confirm = await screen.findByRole('alertdialog', { name: 'Replace Probe on Pixel 9?' })
    expect(confirm).toHaveTextContent('deletes its data on the phone')
    expect(actions.uninstall).not.toHaveBeenCalled()
    const go = within(confirm).getByRole('button', { name: 'Uninstall and install' })
    // Red, not the primary colour: asChild joins the variant's classes with its own unmerged,
    // so a bg-destructive passed as a class lost to the default variant's bg-primary.
    expect(go.className).toMatch(/\bbg-destructive\b/)
    expect(go.className).not.toMatch(/\bbg-primary\b/)
    fireEvent.click(go)

    expect(await screen.findByText('Installed Probe 1.4.0 (812) on Pixel 9.')).toBeInTheDocument()
    expect(actions.uninstall).toHaveBeenCalledWith('com.example.probe')
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('shows a refusal’s raw output under Details', async () => {
    planner.next = makePlan()
    const actions = fakeActions({
      install: vi.fn(() =>
        Promise.resolve(
          done(
            failure({
              code: 'UNKNOWN',
              androidCode: 'INSTALL_FAILED_INTERNAL_ERROR',
              message: 'Session relinquished',
              output: 'Failure [INSTALL_FAILED_INTERNAL_ERROR: Session relinquished]',
            }),
          ),
        ),
      ),
    })
    renderDialog({ actions })
    fireEvent.click(await installButton())
    expect(
      await screen.findByText('Android refused the install: Session relinquished'),
    ).toBeVisible()
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument()
  })

  it('says when the phone can’t be read, and tries again', async () => {
    planner.next = makePlan()
    const deviceSpec = vi
      .fn<InstallActions['deviceSpec']>()
      .mockRejectedValueOnce(new Error('DEVICE_NOT_READY'))
      .mockResolvedValueOnce(SPEC)
    renderDialog({ actions: fakeActions({ deviceSpec }) })
    expect(await screen.findByText('The device is not ready yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await installButton()).toBeInTheDocument()
  })

  it('keeps Install shut while the phone isn’t ready', async () => {
    planner.next = makePlan()
    renderDialog({ ready: false })
    const install = await installButton()
    expect(install).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Pixel 9 isn’t ready. Reconnect it to install.')).toBeInTheDocument()
  })

  it('starts over for new files, and keeps files that arrive under a running install for after', async () => {
    const success_ = vi.spyOn(toast, 'success')
    planner.next = makePlan()
    const view = renderDialog()
    const run = drivenInstall(view)
    view.props.actions = fakeActions({ install: run.install })
    view.rerender(<InstallDialog {...view.props} />)
    fireEvent.click(await installButton())
    run.sending(0)
    planner.next = makePlan({ app: { ...makePlan().app!, label: 'Other' } })
    view.props.files = [new File(['y'], 'other.apk')]
    view.rerender(<InstallDialog {...view.props} />)
    // The running install keeps the dialog, and says what waits for it.
    expect(screen.getByRole('button', { name: 'Cancel install' })).toBeInTheDocument()
    expect(screen.getByText('Next: other.apk. It’s read once this install ends.')).toBeVisible()

    // Once it ends the dialog moves on to the waiting file, so a toast says how it went.
    await run.settle(done(success))
    expect(await installButton()).toBeInTheDocument()
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(success_).toHaveBeenCalledWith(
      'Installed Probe 1.4.0 (812) on Pixel 9.',
      expect.anything(),
    )

    planner.next = makePlan({ app: { ...makePlan().app!, label: 'Third' } })
    view.props.files = [new File(['z'], 'third.apk')]
    view.rerender(<InstallDialog {...view.props} />)
    expect(await screen.findByText('Third')).toBeInTheDocument()
  })

  it('toasts a failure the dialog moved on from, without a Show that would lead elsewhere', async () => {
    const error = vi.spyOn(toast, 'error')
    planner.next = makePlan()
    const view = renderDialog()
    const run = drivenInstall(view)
    view.props.actions = fakeActions({ install: run.install })
    view.rerender(<InstallDialog {...view.props} />)
    fireEvent.click(await installButton())
    run.sending(0)
    view.props.files = [new File(['y'], 'other.apk')]
    view.rerender(<InstallDialog {...view.props} />)
    await run.settle(done(failure({ code: 'INSUFFICIENT_STORAGE' })))
    await installButton()
    expect(error).toHaveBeenCalledWith('Couldn’t install Probe on Pixel 9', {
      description: 'Not enough free space on the phone.',
    })
  })

  it('toasts how an install ended after the dialog was unmounted mid-send', async () => {
    const error = vi.spyOn(toast, 'error')
    planner.next = makePlan()
    let settle: (result: InstallResult) => void = () => {}
    const install = vi.fn(
      () =>
        new Promise<InstallResult>((resolve) => {
          settle = resolve
        }),
    )
    const view = renderDialog({ actions: fakeActions({ install }) })
    fireEvent.click(await installButton())
    expect(install).toHaveBeenCalledOnce()
    // The phone was unplugged and dropped from the list, taking the open dialog with it.
    view.unmount()
    await act(async () => {
      settle(done(failure({ code: 'CONNECTION_LOST' })))
      await Promise.resolve()
    })
    expect(error).toHaveBeenCalledWith(
      'Couldn’t install Probe on Pixel 9',
      expect.objectContaining({
        description: 'The phone disconnected during the install. Nothing was installed.',
      }),
    )
  })

  describe('Uninstall and install, for a newer copy on the phone', () => {
    const newer: InstallFacts = {
      ...FACTS,
      installed: { versionCode: 900, versionName: '2.0.0', debuggable: false },
    }
    const replaceButton = () => screen.findByRole('button', { name: 'Uninstall and install…' })

    it('uninstalls, then installs, when the newer copy is the only thing in the way', async () => {
      planner.next = makePlan()
      const actions = fakeActions({ installFacts: vi.fn(() => Promise.resolve(newer)) })
      renderDialog({ actions })
      const replace = await replaceButton()
      expect(replace).not.toHaveAttribute('aria-disabled')
      expect(await installButton()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(replace)
      const confirm = await screen.findByRole('alertdialog', { name: 'Replace Probe on Pixel 9?' })
      fireEvent.click(within(confirm).getByRole('button', { name: 'Uninstall and install' }))
      expect(await screen.findByText('Installed Probe 1.4.0 (812) on Pixel 9.')).toBeInTheDocument()
      expect(actions.uninstall).toHaveBeenCalledWith('com.example.probe')
      expect(actions.install).toHaveBeenCalledOnce()
    })

    it('checks again on confirming, and uninstalls nothing if the way is shut by then', async () => {
      const error = vi.spyOn(toast, 'error')
      planner.next = makePlan()
      const actions = fakeActions({ installFacts: vi.fn(() => Promise.resolve(newer)) })
      const view = renderDialog({ actions })
      fireEvent.click(await replaceButton())
      const confirm = await screen.findByRole('alertdialog', { name: 'Replace Probe on Pixel 9?' })
      // Another install started on the phone while the confirmation was up.
      view.props.job = { id: 'job_9', phase: 'sending', sent: 0, total: 1, phaseSince: 0 }
      view.rerender(<InstallDialog {...view.props} />)
      fireEvent.click(within(confirm).getByRole('button', { name: 'Uninstall and install' }))
      await waitFor(() => {
        expect(error).toHaveBeenCalledWith('Didn’t uninstall com.example.probe', {
          description: 'Another install is running on Pixel 9. Wait for it to finish.',
        })
      })
      expect(actions.uninstall).not.toHaveBeenCalled()
      expect(actions.install).not.toHaveBeenCalled()
    })

    it('never uninstalls when something else would still stop the install', async () => {
      // A 32-bit-only build on a 64-bit-only phone: nothing to install even once it's gone.
      planner.next = makePlan({
        parts: [],
        problems: [
          { code: 'NO_MATCHING_ABIS', message: 'This app has no native code for arm64-v8a.' },
        ],
      })
      const actions = fakeActions({ installFacts: vi.fn(() => Promise.resolve(newer)) })
      renderDialog({ actions })
      const replace = await replaceButton()
      expect(replace).toHaveAttribute('aria-disabled', 'true')
      const reason = screen.getByText(/^Uninstalling wouldn’t help yet/)
      expect(reason).toBeVisible()
      expect(replace).toHaveAttribute('aria-describedby', reason.id)
      fireEvent.click(replace)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(actions.uninstall).not.toHaveBeenCalled()
      expect(actions.install).not.toHaveBeenCalled()
    })
  })

  it('offers to pick a file again when it changed since it was picked, and reads the new pick', async () => {
    planner.next = makePlan()
    const actions = fakeActions({
      install: vi.fn(() => Promise.resolve(done(fileChangedFailure()))),
    })
    const { container } = renderDialog({ actions })
    fireEvent.click(await installButton())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(DEVICE_ERRORS.FILE_CHANGED)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pick again…' })).toBeInTheDocument()

    planner.next = makePlan({ app: { ...makePlan().app!, label: 'Rebuilt' } })
    // The dialog is portalled out of the container; its picker is the page's only file input.
    const input = container.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('no file input')
    fireEvent.change(input, { target: { files: [new File(['n'], 'probe.apk')] } })
    expect(await screen.findByText('Rebuilt')).toBeInTheDocument()
    expect(await installButton()).not.toHaveAttribute('aria-disabled')
  })
})
