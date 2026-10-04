import { describe, expect, it } from 'vitest'
import {
  createRegistry,
  initialLanes,
  laneLines,
  normalizeRow,
  transitionLines,
} from '../src/registry'
import type { HelperDevice } from '../src/types'
import { IPHONE, PIXEL, SIMULATOR, row } from './fakes/devices'

function setup(now = () => 1_000) {
  const lines: string[] = []
  const bugs: string[] = []
  const registry = createRegistry({
    runId: 'abcd1234',
    lanes: initialLanes({ platform: 'darwin', wifi: false, android: true, simulators: false }),
    now,
    activeMs: 30_000,
    log: (line) => lines.push(line),
    bug: (line) => bugs.push(line),
  })
  return { registry, lines, bugs }
}

describe('rev and runId (§2.4)', () => {
  it('starts at 1 and moves only when the serialised devices or lanes change', () => {
    const { registry } = setup()
    expect(registry.snapshot()).toMatchObject({ rev: 1, runId: 'abcd1234', devices: [] })
    registry.publish('ios', [IPHONE])
    expect(registry.snapshot().rev).toBe(2)
    registry.publish('ios', [row(IPHONE)])
    expect(registry.snapshot().rev).toBe(2)
    registry.setLane('ios', { status: 'ok' })
    expect(registry.snapshot().rev).toBe(3)
    registry.setLane('ios', { status: 'ok' })
    expect(registry.snapshot().rev).toBe(3)
    registry.publish('ios', [row(IPHONE, { state: 'locked', blockers: ['IOS_LOCKED'] })])
    expect(registry.snapshot().rev).toBe(4)
  })
})

describe('the merged list', () => {
  it('sorts by usability, then name, and finds each id’s lane', () => {
    const { registry } = setup()
    registry.publish('android', [
      row(PIXEL, { state: 'unauthorized', blockers: ['ANDROID_UNAUTHORIZED'] }),
    ])
    registry.publish('ios', [IPHONE])
    registry.publish('simulators', [SIMULATOR])
    expect(registry.devices().map((d) => d.id)).toEqual([SIMULATOR.id, IPHONE.id, PIXEL.id])
    expect(registry.owner(PIXEL.id)).toBe('android')
    expect(registry.owner(SIMULATOR.id)).toBe('simulators')
    expect(registry.owner('nope')).toBeNull()
    expect(registry.device(IPHONE.id)?.name).toBe('Ngọc’s iPhone 12 Pro')
  })
  it('tells subscribers which ids left', () => {
    const { registry } = setup()
    const removed: string[][] = []
    const unsubscribe = registry.subscribe((change) => removed.push(change.removed))
    registry.publish('ios', [IPHONE])
    registry.publish('ios', [])
    unsubscribe()
    registry.publish('ios', [IPHONE])
    registry.publish('ios', [])
    expect(removed).toEqual([[IPHONE.id]])
  })
  it('drops a row no request could address and reports the lane bug', () => {
    const { registry, bugs } = setup()
    registry.publish('android', [row(PIXEL, { id: '-u' }), PIXEL])
    expect(registry.devices().map((d) => d.id)).toEqual([PIXEL.id])
    expect(bugs[0]).toContain('"-u"')
  })
})

describe('normalizeRow', () => {
  it('cleans names, filters blocker codes and forces install:false', () => {
    const dirty = {
      ...IPHONE,
      name: '\x1b[31mEvil\x1b[0m\u0007' + 'x'.repeat(300),
      blockers: ['IOS_LOCKED', 'IOS_LOCKED', 'lower', 'OK_1'],
      capabilities: { screenshot: true, identifiers: true, logs: true, install: true },
    } as unknown as HelperDevice
    const clean = normalizeRow(dirty)
    expect(clean?.name).toBe('Evil' + 'x'.repeat(196))
    expect(clean?.blockers).toEqual(['IOS_LOCKED', 'OK_1'])
    expect(clean?.capabilities.install).toBe(false)
  })
})

describe('terminal transitions (§1.10)', () => {
  it('prints arrivals, blockers, state changes and departures', () => {
    const trusted = transitionLines([], [row(IPHONE, { blockers: ['IOS_DEVELOPER_MODE_OFF'] })])
    expect(trusted).toEqual([
      '+ Ngọc’s iPhone 12 Pro · iOS 27.0 · USB · trusted',
      '  Developer Mode is off: screenshots stay off until it is on',
    ])
    expect(transitionLines([], [PIXEL])).toEqual([
      '+ Pixel 9 (55090DLAQ0026D) · Android 17 · USB · ready via adb',
    ])
    expect(transitionLines([], [SIMULATOR])).toEqual([
      '+ iPhone 17 Pro · iOS 27.0 · Simulator · booted',
    ])
    const untrusted = row(IPHONE, { state: 'untrusted', blockers: ['IOS_UNTRUSTED'] })
    expect(transitionLines([untrusted], [IPHONE])).toEqual(['~ Ngọc’s iPhone 12 Pro · trusted'])
    expect(transitionLines([IPHONE], [])).toEqual(['- Ngọc’s iPhone 12 Pro'])
  })
  it('a departure the lane explains says why, only for that row', () => {
    const tv = row(PIXEL, { id: '192.168.1.20:5555', connection: 'network', name: 'BRAVIA 4K UR3' })
    expect(
      transitionLines([tv, PIXEL], [], { '192.168.1.20:5555': 'disconnected', other: 'x' }),
    ).toEqual(['- BRAVIA 4K UR3 (192.168.1.20:5555) · disconnected', '- Pixel 9 (55090DLAQ0026D)'])
    const { registry, lines } = setup()
    registry.publish('android', [tv])
    registry.publish('android', [], { '192.168.1.20:5555': 'disconnected' })
    expect(lines.at(-1)).toBe('- BRAVIA 4K UR3 (192.168.1.20:5555) · disconnected')
  })
  it('says nothing about a lane’s first report, then announces the adb server', () => {
    const { registry, lines } = setup()
    registry.setLane('android', { status: 'stopped' })
    expect(lines).toEqual([])
    registry.setLane('android', { status: 'ok', serverProtocol: 41 })
    registry.setLane('android', { status: 'stopped' })
    expect(lines).toEqual([
      'adb server appeared (protocol 41): sharing it for Android',
      "adb server stopped: Android phones are back with Chrome's WebUSB",
    ])
  })
  it('words usbmuxd going and coming back', () => {
    const base = initialLanes({
      platform: 'darwin',
      wifi: false,
      android: false,
      simulators: false,
    }).ios
    expect(
      laneLines(
        'ios',
        { ...base, status: 'ok' },
        { ...base, status: 'error', reason: 'socket closed' },
      ),
    ).toEqual(["macOS's iPhone service (usbmuxd) stopped answering: socket closed"])
    expect(laneLines('ios', { ...base, status: 'error' }, { ...base, status: 'ok' })).toEqual([
      "macOS's iPhone service (usbmuxd) is back",
    ])
  })
})

describe('initialLanes', () => {
  it('reflects the flags and the platform before any lane reports', () => {
    expect(
      initialLanes({ platform: 'linux', wifi: false, android: false, simulators: true }),
    ).toEqual({
      ios: {
        status: 'unavailable',
        screenshots: 'none',
        xcode: 'not-installed',
        wifi: false,
        wifiHidden: 0,
        reason: 'iPhones need macOS.',
      },
      android: { status: 'off', adb: 'missing', startedByHelper: false },
      simulators: { status: 'unavailable', booted: 0, reason: 'Simulators need macOS.' },
    })
  })
})

describe('activity', () => {
  it('is active for 30 s after an authenticated request', () => {
    let now = 1_000
    const { registry } = setup(() => now)
    expect(registry.isActive()).toBe(false)
    registry.touch()
    now += 29_999
    expect(registry.isActive()).toBe(true)
    now += 2
    expect(registry.isActive()).toBe(false)
  })
})
