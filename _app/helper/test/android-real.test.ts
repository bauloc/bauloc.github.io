/*
  Opt-in, read-only check against this Mac's REAL adb server (§9.2):
    DEVICE_BRIDGE_REAL=1 npm run test:helper -- android-real

  Exactly one request, `host:version`, on ANDROID_ADB_SERVER_PORT or 5037. Skipped when
  nothing answers: it never starts a server, never runs the adb CLI and never touches a phone,
  so Chrome's WebUSB keeps every phone it has.
*/
import { describe, expect, it } from 'vitest'
import { createAdbClient } from '../src/android-lane'
import { TIMEOUTS } from '../src/constants'

const REAL = process.env.DEVICE_BRIDGE_REAL === '1'
const PORT = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037

describe.runIf(REAL)('the real adb server (opt-in, host:version only)', () => {
  it('answers host:version with its protocol, or is absent', async (context) => {
    const version = await createAdbClient({ port: PORT, timeouts: TIMEOUTS }).version()
    if (version === null) {
      context.skip()
      return
    }
    console.info(`adb server on ${String(PORT)} speaks protocol ${String(version)}`)
    expect(Number.isInteger(version)).toBe(true)
    expect(version).toBeGreaterThanOrEqual(31)
  })
})
