/* Device rows as lanes publish them: the real phones of the spec's checklist (§9.6). */
import type { HelperDevice } from '../../src/types'

const ALL = { screenshot: true, identifiers: true, logs: true, install: false } as const

export const IPHONE: HelperDevice = {
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state: 'ready',
  name: 'Ngọc’s iPhone 12 Pro',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: { ...ALL },
}

export const PIXEL: HelperDevice = {
  id: '55090DLAQ0026D',
  platform: 'android',
  connection: 'usb',
  state: 'ready',
  name: 'Pixel 9',
  model: 'Pixel 9',
  modelId: 'tokay',
  osVersion: '17',
  blockers: [],
  capabilities: { ...ALL },
}

export const SIMULATOR: HelperDevice = {
  id: 'C1A2B3C4-D5E6-47F8-9A0B-1C2D3E4F5A6B',
  platform: 'ios',
  connection: 'simulator',
  state: 'ready',
  name: 'iPhone 17 Pro',
  model: 'iPhone 17 Pro',
  modelId: 'iPhone18,1',
  osVersion: '27.0',
  blockers: [],
  capabilities: { ...ALL },
}

/** A copy of `base` with `patch` applied. */
export function row(base: HelperDevice, patch: Partial<HelperDevice> = {}): HelperDevice {
  return { ...base, capabilities: { ...base.capabilities }, blockers: [...base.blockers], ...patch }
}
