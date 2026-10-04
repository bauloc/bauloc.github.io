import { describe, expect, it } from 'vitest'

import {
  INSTALL_ERROR_CODES,
  classifyPmOutput,
  installFailure,
  type InstallFailure,
} from './backends/android/pm-output'
import {
  DEVICE_HINTS,
  INSTALL_ERRORS,
  hintFor,
  installErrorWording,
  installPhoneOf,
  mergeDevices,
  normalizeDevice,
  type Device,
  type DeviceState,
} from './model'

/*
  The Android wording added to model.ts: every install failure says what happened and what
  to do, with the values the phone's message carried, and nothing reads as a template.
*/

const fail = (text: string) => classifyPmOutput(text) as InstallFailure

describe('installErrorWording', () => {
  it('has words for every code pm-output can return, and none left as a {placeholder}', () => {
    for (const code of INSTALL_ERROR_CODES) {
      const words = installErrorWording(installFailure(code))
      expect(INSTALL_ERRORS[code].text).toBeTruthy()
      expect(words.text).not.toMatch(/[{}]/)
      expect(words.action?.label ?? '').not.toMatch(/[{}]/)
    }
  })

  it('fills in the versions, and offers -d only over a debuggable install', () => {
    const f = fail(
      'Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 1 is older than current 2]',
    )
    expect(installErrorWording(f)).toMatchObject({
      text: 'The phone has a newer version (2) than this file (1).',
      action: { kind: 'uninstall-and-install', label: 'Uninstall and install…' },
    })
    expect(installErrorWording(f, { debuggable: true }).action).toEqual({
      kind: 'allow-downgrade',
      label: 'Install the older version',
    })
  })

  it('names the phone’s ABIs, and says when it runs 64-bit apps only', () => {
    const f = fail(
      'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    )
    expect(installErrorWording(f, { abis: ['arm64-v8a'] }).text).toBe(
      'This app has no native code for arm64-v8a. This phone runs 64-bit apps only.',
    )
    expect(installErrorWording(f, { abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'] }).text).toBe(
      'This app has no native code for arm64-v8a, armeabi-v7a and armeabi.',
    )
    expect(installErrorWording(f).text).toBe('This app has no native code for this phone’s CPU.')
  })

  it('offers to uninstall the other app only when Android named it', () => {
    const named = fail(
      "Failure [INSTALL_FAILED_CONFLICTING_PROVIDER: Can't install because provider name com.x.files (in package com.b) is already used by com.example.notes.debug]",
    )
    expect(installErrorWording(named)).toMatchObject({
      text: 'Another installed app (com.example.notes.debug) declares the same provider, usually another flavour of this app.',
      action: { kind: 'uninstall-other', label: 'Uninstall com.example.notes.debug…' },
    })
    const unnamed = installErrorWording(installFailure('DUPLICATE_PERMISSION'))
    expect(unnamed.action).toBeNull()
    expect(unnamed.text).toMatch(/^Another installed app declares/)
  })

  it('words the rest with their way out', () => {
    expect(
      installErrorWording(
        fail(
          'Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: App package must target at least SDK version 24, but found 22]',
        ),
      ),
    ).toMatchObject({
      text: 'This app targets an old Android (API 22). Android blocks it unless you allow it.',
      action: { kind: 'install-anyway' },
    })
    expect(
      installErrorWording(fail('Failure [INSTALL_FAILED_ABORTED: User rejected permissions]'))
        .action,
    ).toEqual({
      kind: 'retry',
      label: 'Retry and watch the phone',
    })
    expect(
      installErrorWording(
        fail('Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]'),
      ).fixes[0],
    ).toMatchObject({
      path: expect.stringMatching(/Install via USB/) as string,
    })
    expect(
      installErrorWording(fail('Failure [INSTALL_FAILED_INTERNAL_ERROR: Session relinquished]')),
    ).toMatchObject({
      text: 'Android refused the install: Session relinquished',
      action: { kind: 'copy-details' },
    })
    expect(installErrorWording(installFailure('UNKNOWN')).text).toBe('Android refused the install.')
  })

  it('says a phone lost mid-commit may have installed the app', () => {
    const sending = installFailure('CONNECTION_LOST', '', '', null, { phase: 'sending' })
    const installing = installFailure('CONNECTION_LOST', '', '', null, { phase: 'installing' })
    expect(installErrorWording(sending).text).toMatch(/Nothing was installed\.$/)
    expect(installErrorWording(installing).text).toMatch(/whether the app was installed/)
  })
})

describe('Android hints and facts', () => {
  it('words USB_ACCESS_DENIED with the system’s fixes, links included', () => {
    const hint = hintFor(
      normalizeDevice({ id: 'd', backend: 'webusb', blockers: ['USB_ACCESS_DENIED'] }),
    )
    expect(hint?.title).toBe('The system won’t let the browser open the phone')
    expect(
      hint?.fixes?.map((f) => Object.keys(f).find((k) => k !== 'label' && k !== 'primary')),
    ).toEqual(['copy', 'copy', 'copy', 'copy', 'href', 'action'])
    // The udev command is named for its distribution, beside Fedora's, Arch's and snap's.
    expect(hint?.fixes?.flatMap((f) => ('copy' in f ? [f.copy] : []))).toEqual([
      'sudo apt-get install android-sdk-platform-tools-common',
      'sudo dnf install android-tools',
      'sudo pacman -S android-udev',
      'sudo snap connect chromium:raw-usb',
    ])
    expect(hint?.body).not.toMatch(/built-in WinUSB/)
    expect(Object.keys(DEVICE_HINTS)).toContain('USB_ACCESS_DENIED')
  })

  it('gives the install rows the phone facts connect read', () => {
    const bare = normalizeDevice({ id: 'd', backend: 'webusb', name: 'Pixel 9' })
    expect(installPhoneOf(bare)).toBeNull()
    const pixel = normalizeDevice({
      id: 'd',
      backend: 'webusb',
      name: 'Pixel 9',
      android: {
        sdk: 37,
        release: '17',
        manufacturer: 'Google',
        brand: 'google',
        abis: ['arm64-v8a'],
      },
    })
    expect(installPhoneOf(pixel)).toEqual({
      name: 'Pixel 9',
      sdk: 37,
      release: '17',
      brand: 'google',
      manufacturer: 'Google',
    })
  })
})

describe('the helper’s hints', () => {
  it.each([
    ['XCODE_REQUIRED', 'Screenshots need Xcode on this Mac', ['doctor', 'retry']],
    ['XCODE_SETUP_REQUIRED', 'Xcode needs to finish setting up', ['doctor', 'retry']],
    ['IOS_DDI_REQUIRED', 'Screenshots need Apple’s developer disk image', ['retry', 'doctor']],
    ['IOS_LOCKDOWN_FAILED', 'The device isn’t answering', ['retry']],
  ])('words %s with what to do', (code, title, actions) => {
    const hint = hintFor(normalizeDevice({ id: 'd', backend: 'agent', blockers: [code] }))
    expect(hint?.title).toBe(title)
    expect(hint?.body).toMatch(/\.$/)
    expect(hint?.fixes?.map((f) => ('action' in f ? f.action : null))).toEqual(actions)
  })

  it('words an Android device over Wi‑Fi by its screen and its network, never a cable', () => {
    const tv = (code: string, connection: 'network' | 'usb' = 'network') =>
      hintFor(
        normalizeDevice({
          id: '192.168.1.42:5555',
          backend: 'agent',
          platform: 'android',
          connection,
          blockers: [code],
        }),
      )
    expect(tv('ANDROID_UNAUTHORIZED')?.title).toBe('Waiting for you to allow debugging')
    expect(tv('ANDROID_UNAUTHORIZED')?.body).toMatch(/with the remote/)
    expect(tv('ANDROID_OFFLINE')).toMatchObject({
      code: 'ANDROID_OFFLINE',
      title: 'The device stopped answering over Wi‑Fi',
      fixes: [{ label: 'Connect over Wi‑Fi…', action: 'open-wifi' }],
    })
    // On a cable, the cable's words, as before.
    expect(tv('ANDROID_OFFLINE', 'usb')?.body).toMatch(/Reseat the cable/)
    // A code Wi‑Fi doesn't change keeps its usual words.
    expect(tv('IOS_LOCKDOWN_FAILED')?.title).toBe('The device isn’t answering')
  })

  it('says Xcode is only for screenshots', () => {
    expect(DEVICE_HINTS.XCODE_REQUIRED?.extra).toBe('Identifiers and logs work without it.')
  })
})

describe('mergeDevices', () => {
  const row = (backend: Device['backend'], state: DeviceState, id = 'same', name = id): Device =>
    normalizeDevice({ id, backend, state, name })
  const merged = (...lanes: Device[][]) => mergeDevices(lanes).map((d) => `${d.backend}:${d.state}`)

  it('keeps one row per id, the more usable one, and sorts the rest as before', () => {
    expect(merged([row('webusb', 'held')], [row('agent', 'ready')])).toEqual(['agent:ready'])
    expect(merged([row('webusb', 'ready')], [row('agent', 'offline')])).toEqual(['webusb:ready'])
    expect(merged([row('webusb', 'ready')], [row('agent', 'ready')])).toEqual(['webusb:ready'])
    expect(
      merged(
        [row('webusb', 'offline', 'a')],
        [row('agent', 'ready', 'b'), row('agent', 'held', 'c')],
      ),
    ).toEqual(['agent:ready', 'agent:held', 'webusb:offline'])
  })

  it('lets a held row lose to anything a real lane lists, and the mock lose to everything real', () => {
    expect(merged([row('webusb', 'held')], [row('agent', 'absent')])).toEqual(['agent:absent'])
    expect(merged([row('mock', 'ready')], [row('agent', 'untrusted')])).toEqual(['agent:untrusted'])
    expect(merged([row('mock', 'ready')], [row('webusb', 'held')])).toEqual(['webusb:held'])
  })

  it('keeps a simulator’s connection', () => {
    const sim = normalizeDevice({
      id: 's',
      backend: 'agent',
      connection: 'simulator',
      platform: 'ios',
    })
    expect(mergeDevices([[sim]])[0]?.connection).toBe('simulator')
  })
})
