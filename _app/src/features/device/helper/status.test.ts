import { describe, expect, it } from 'vitest'

import type { HelperPhase, HelperStatus } from './connection'
import type { Health, HelperDevice, Lanes } from './protocol'
import {
  DEV_COMMAND,
  DOWNLOAD_COMMAND,
  NEEDS_HELPER,
  START_COMMAND,
  clockTime,
  helperAndroid,
  helperAnnouncement,
  helperCard,
  helperChip,
  helperNotice,
  pairError,
  nodeHint,
  localPairingNote,
  rememberNote,
} from './status'

/* Every phase yields its chip, card and notice, in the words of spec §6.8. */

const PHASES: readonly HelperPhase[] = [
  'off',
  'checking',
  'absent',
  'dismissed',
  'denied',
  'safari',
  'foreign',
  'outdated',
  'newer',
  'unpaired',
  'stale',
  'connected',
  'lost',
]

const LANES: Lanes = {
  ios: { status: 'ok', screenshots: 'devicectl', xcode: 'ready', wifi: false, wifiHidden: 0 },
  android: { status: 'ok', adb: 'found', serverProtocol: 41, startedByHelper: false },
  simulators: { status: 'off', booted: 0 },
}

const HEALTH: Health = {
  name: 'bauloc-device-bridge',
  version: '0.9.0',
  protocol: 0,
  features: ['android.start-server'],
  port: 8787,
  tokenId: '4d1566a1',
  tokenPersistent: false,
  runId: 'r',
  startedAt: 0,
  local: false,
  platform: 'darwin-arm64',
  sha256: '',
}

function status(phase: HelperPhase, patch: Partial<HelperStatus> = {}): HelperStatus {
  return {
    phase,
    promptLikely: false,
    env: {
      mode: 'hosted',
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: false,
      devOrigin: false,
    },
    permission: 'granted',
    health: HEALTH,
    lanes: LANES,
    pairing: null,
    remember: false,
    intent: true,
    since: new Date(2026, 9, 4, 14, 5).getTime(),
    error: null,
    ...patch,
  }
}

const device = (state: HelperDevice['state']): HelperDevice => ({
  id: '00008101-000A1B2C3D4E5F02',
  platform: 'ios',
  connection: 'usb',
  state,
  name: 'iPhone',
  model: '',
  modelId: 'iPhone13,3',
  osVersion: '27.0',
  blockers: [],
  capabilities: { screenshot: true, identifiers: true, logs: true, install: false },
})

describe('helperChip', () => {
  it('says each phase in its own words', () => {
    const texts = Object.fromEntries(PHASES.map((p) => [p, helperChip(status(p), []).text]))
    expect(texts).toEqual({
      off: 'Connect helper',
      checking: 'Looking for the helper…',
      absent: 'Helper not running',
      dismissed: 'Helper needs permission',
      denied: 'Browser blocked the helper',
      safari: 'Helper: use its own page',
      foreign: 'Port 8787 is another app',
      outdated: 'Helper outdated',
      newer: 'Reload for the new helper',
      unpaired: 'Pair this page',
      stale: 'Helper restarted — pair again',
      connected: 'Helper ready · no devices',
      lost: 'Helper stopped',
    })
  })

  it('a click does what the phase needs', () => {
    const actions = Object.fromEntries(
      PHASES.map((p) => [p, helperChip(status(p), []).action?.action ?? null]),
    )
    expect(actions).toEqual({
      off: 'connect',
      checking: null,
      absent: 'check',
      dismissed: 'connect',
      denied: 'check',
      safari: 'open-local',
      foreign: 'check',
      outdated: 'check',
      newer: 'reload',
      unpaired: 'pair',
      stale: 'pair',
      connected: 'check',
      lost: 'check',
    })
    expect(helperChip(status('safari'), []).action?.href).toBe('http://127.0.0.1:8787/device/')
  })

  it('the tone never stands alone: every chip has text and a tooltip', () => {
    for (const p of PHASES) {
      const chip = helperChip(status(p), [])
      expect(chip.text).not.toBe('')
      expect(chip.tooltip).not.toBe('')
    }
    expect(helperChip(status('lost'), []).tone).toBe('bad')
    expect(helperChip(status('off'), []).tone).toBe('off')
  })

  it('asks for the prompt while one is likely up', () => {
    expect(helperChip(status('checking', { promptLikely: true }), [])).toMatchObject({
      tone: 'warn',
      text: 'Allow in the browser prompt',
    })
  })

  it('counts ready devices when connected', () => {
    expect(helperChip(status('connected'), [device('ready'), device('ready')])).toMatchObject({
      tone: 'ok',
      text: '2/2 ready via helper',
    })
    expect(helperChip(status('connected'), [device('ready'), device('untrusted')])).toMatchObject({
      tone: 'warn',
      text: '1/2 ready via helper',
    })
  })

  it('names the port the page uses', () => {
    const env = {
      mode: 'hosted' as const,
      apiBase: 'http://127.0.0.1:8788',
      port: 8788,
      safariLike: false,
      devOrigin: false,
    }
    expect(helperChip(status('foreign', { env }), []).text).toBe('Port 8788 is another app')
  })
})

describe('helperCard', () => {
  it('needs the helper while nothing answers, with the command, Connect and the source', () => {
    for (const p of ['off', 'absent', 'dismissed'] as const) {
      const card = helperCard(status(p))
      expect(card.title).toBe('Needs the helper')
      expect(card.body[0]).toMatch(/^macOS keeps the iPhone’s USB connection for itself/)
      expect(card.command?.text).toBe(DOWNLOAD_COMMAND)
      expect(card.actions.map((a) => a.action)).toEqual(['connect'])
      expect(card.links.map((l) => l.label)).toEqual(['Get Node.js (LTS)', 'Review the source'])
      expect(card.notes).toEqual([
        'Chrome, Edge and Firefox ask once to let this page reach apps on this device. Choose Allow.',
      ])
    }
    expect(DOWNLOAD_COMMAND).toBe(
      'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs',
    )
  })

  it('says why, per phase', () => {
    expect(helperCard(status('absent')).body[1]).toBe(
      'Nothing answers on 127.0.0.1:8787. Is the helper running?',
    )
    expect(helperCard(status('dismissed')).body[1]).toBe(
      'The permission prompt was closed. Connect again to see it.',
    )
    expect(helperCard(status('checking')).body[1]).toBe('Looking for the helper on 127.0.0.1:8787…')
    expect(helperCard(status('checking', { promptLikely: true })).body[1]).toBe(
      'Waiting for your answer to the browser’s prompt…',
    )
    // Still there while it looks, busy: focus stays on the button a keyboard user pressed.
    expect(helperCard(status('checking')).actions).toEqual([
      { action: 'connect', label: 'Connect helper', busy: true },
    ])
  })

  it('says what the helper runs on, and where to get it, before the first command', () => {
    expect(NEEDS_HELPER).not.toMatch(/nothing to install/)
    expect(NEEDS_HELPER).toMatch(/runs with Node\.js/)
    for (const p of ['off', 'absent', 'checking', 'denied', 'safari', 'foreign'] as const) {
      const card = helperCard(status(p))
      expect(card.requires).toBe(
        'Needs Node.js 18 or newer (node -v shows yours). No Node? Get the installer from nodejs.org, or run brew install node.',
      )
      expect(card.links[0]).toEqual({
        label: 'Get Node.js (LTS)',
        href: 'https://nodejs.org/en/download',
      })
    }
    // A helper that answered, or once ran, had Node.
    for (const p of ['outdated', 'unpaired', 'lost'] as const) {
      expect(helperCard(status(p)).requires).toBeNull()
    }
  })

  it('words the way to Node.js per system', () => {
    expect(nodeHint('windows')).toBe(
      'Needs Node.js 18 or newer (node -v shows yours). No Node? Get the installer from nodejs.org, or run winget install OpenJS.NodeJS.LTS.',
    )
    expect(nodeHint('linux')).toBe(
      'Needs Node.js 18 or newer (node -v shows yours). No Node? nodejs.org gives the install commands for Linux.',
    )
    expect(nodeHint('mac')).toBe(nodeHint())
    // The Wi‑Fi dialog needs the helper on any system: its card is worded for this one.
    const linux = helperCard(status('absent'), { os: 'linux', iphone: false })
    expect(linux.requires).toBe(nodeHint('linux'))
    expect(linux.command?.lead).toBe('Run this in a terminal:')
    expect(linux.command?.text).toBe(DOWNLOAD_COMMAND)
  })

  it('off macOS, the iPhone card says iPhones need a Mac, with no command', () => {
    for (const os of ['windows', 'linux', 'chromeos', 'android'] as const) {
      for (const p of ['off', 'absent', 'connected'] as const) {
        expect(helperCard(status(p), { os })).toEqual({
          title: 'iPhones need a Mac',
          body: [
            'Only macOS lets the helper reach an iPhone. Open Device Lab on a Mac to use one.',
          ],
          requires: null,
          command: null,
          actionsLead: null,
          actions: [],
          links: [],
          notes: [],
        })
      }
    }
    expect(helperCard(status('absent'), { os: 'mac' }).title).toBe('Needs the helper')
    expect(helperCard(status('absent'), { os: 'other' }).title).toBe('Needs the helper')
  })

  it('off macOS, the Wi‑Fi dialog’s card never names Terminal or this Mac', () => {
    for (const p of ['absent', 'denied', 'foreign', 'outdated', 'lost'] as const) {
      const lead = helperCard(status(p), { os: 'windows', iphone: false }).command?.lead
      expect(lead).toBe('Run this in a terminal:')
    }
    expect(helperCard(status('lost'), { os: 'mac' }).command?.lead).toBe('Run this in Terminal:')
  })

  it('blocked by the browser: how to start the helper comes before its page', () => {
    expect(helperCard(status('denied'))).toMatchObject({
      command: { lead: 'Run this in Terminal on this Mac:', text: DOWNLOAD_COMMAND },
      actionsLead: 'Already running? Open its page:',
      actions: [{ action: 'open-local' }],
    })
  })

  it('every command starts the helper on the port this page uses', () => {
    const env = {
      mode: 'hosted' as const,
      apiBase: 'http://127.0.0.1:8790',
      port: 8790,
      safariLike: false,
      devOrigin: false,
    }
    const at = (p: HelperPhase) => status(p, { env })
    expect(helperCard(at('lost')).command?.text).toBe('node ~/device-bridge.mjs --port 8790')
    expect(helperNotice(at('lost'))?.action.command).toBe('node ~/device-bridge.mjs --port 8790')
    expect(helperCard(at('absent')).command?.text).toBe(`${DOWNLOAD_COMMAND} --port 8790`)
    expect(helperCard(at('denied')).command?.text).toBe(`${DOWNLOAD_COMMAND} --port 8790`)
    expect(helperCard(at('outdated')).command?.text).toBe(`${DOWNLOAD_COMMAND} --port 8790`)
    expect(helperNotice(at('outdated'))?.action.command).toBe(`${DOWNLOAD_COMMAND} --port 8790`)
    expect(helperCard(at('foreign')).command?.text).toBe(`${DOWNLOAD_COMMAND} --port 8791`)
  })

  it('on a dev origin, adds the --dev clause and the dev command', () => {
    const env = {
      mode: 'hosted' as const,
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: false,
      devOrigin: true,
    }
    const card = helperCard(status('absent', { env }))
    expect(card.body[1]).toBe(
      'Nothing answers on 127.0.0.1:8787. Is the helper running, and started with --dev?',
    )
    expect(card.command?.text).toBe(DEV_COMMAND)
  })

  it('no permission note on the helper’s own page', () => {
    const env = {
      mode: 'local' as const,
      apiBase: 'http://127.0.0.1:8787',
      port: 8787,
      safariLike: true,
      devOrigin: false,
    }
    expect(helperCard(status('absent', { env })).notes).toEqual([])
  })

  it('the other phases', () => {
    expect(helperCard(status('denied'))).toMatchObject({
      title: 'Blocked by this browser',
      actions: [{ action: 'open-local', href: 'http://127.0.0.1:8787/device/' }],
    })
    expect(helperCard(status('safari'))).toMatchObject({
      title: 'Use the helper’s page in Safari',
      actions: [{ action: 'open-local' }],
    })
    expect(helperCard(status('foreign'))).toMatchObject({
      title: 'Port 8787 is taken',
      // A first-time tester has no file yet: the command downloads it too.
      command: {
        text: 'curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs --port 8788',
      },
    })
    expect(helperCard(status('outdated')).body).toEqual([
      'Your helper (0.9.0) is older than this page needs. Download it again; the command replaces it.',
    ])
    expect(helperCard(status('newer'))).toMatchObject({
      title: 'Reload this page',
      actions: [{ action: 'reload' }],
    })
    expect(helperCard(status('unpaired'))).toMatchObject({
      title: 'Pair this page',
      body: ['The helper is running. Open the link it printed, or paste its token.'],
      actions: [{ action: 'pair' }],
    })
    expect(helperCard(status('stale')).body).toEqual([
      'The helper restarted, so this page’s pairing ended. Open the new link it printed, or paste the new token.',
    ])
    expect(helperCard(status('lost'))).toMatchObject({
      title: 'The helper stopped',
      body: ['Start it again; this page reconnects by itself.'],
      command: { text: START_COMMAND },
    })
  })

  it('ready for iPhones, and says when screenshots need Xcode', () => {
    expect(helperCard(status('connected')).body).toEqual([
      'Plug in an iPhone with a cable and unlock it. If it asks, tap Trust.',
    ])
    const noXcode = {
      ...LANES,
      ios: { ...LANES.ios, screenshots: 'none' as const, xcode: 'not-installed' as const },
    }
    expect(helperCard(status('connected', { lanes: noXcode })).body[1]).toBe(
      'Screenshots of iOS 17 and newer need Xcode on this Mac — see the checklist below.',
    )
  })

  it('every phase has a card', () => {
    for (const p of PHASES) expect(helperCard(status(p)).title).not.toBe('')
  })
})

describe('helperAndroid', () => {
  const lanes = (android: Lanes['android']): Lanes => ({ ...LANES, android })

  it('says nothing until connected, or with --no-android', () => {
    expect(helperAndroid(status('absent'))).toBeNull()
    expect(
      helperAndroid(
        status('connected', {
          lanes: lanes({ status: 'off', adb: 'missing', startedByHelper: false }),
        }),
      ),
    ).toBeNull()
  })

  it('adb missing, server stopped, running', () => {
    expect(
      helperAndroid(
        status('connected', {
          lanes: lanes({ status: 'stopped', adb: 'missing', startedByHelper: false }),
        }),
      ),
    ).toMatchObject({ command: 'brew install --cask android-platform-tools', startAdb: null })
    expect(
      helperAndroid(
        status('connected', {
          lanes: lanes({ status: 'stopped', adb: 'found', startedByHelper: false }),
        }),
      ),
    ).toMatchObject({
      sentence: 'The helper reaches Android through Google’s adb server, which isn’t running.',
      startAdb: { label: 'Start adb server' },
    })
    expect(helperAndroid(status('connected'))?.sentence).toBe(
      'Ready through the helper. Plug in a phone with USB debugging on.',
    )
  })

  it('offers Start adb server only when the helper can', () => {
    const health = { ...HEALTH, features: [] }
    expect(
      helperAndroid(
        status('connected', {
          health,
          lanes: lanes({ status: 'stopped', adb: 'found', startedByHelper: false }),
        }),
      )?.startAdb,
    ).toBeNull()
  })
})

describe('helperNotice', () => {
  it('appears only when the tester showed intent', () => {
    expect(helperNotice(status('lost', { intent: false }))).toBeNull()
  })

  it('says each phase that needs saying above the grid', () => {
    expect(helperNotice(status('stale'))).toMatchObject({
      text: 'The helper restarted. Pair this page again to see iPhones.',
      action: { action: 'pair' },
    })
    expect(helperNotice(status('lost'))).toMatchObject({
      text: 'The helper stopped at 14:05. Start it again; this page reconnects by itself.',
      action: { action: 'copy-command', command: START_COMMAND },
    })
    expect(helperNotice(status('outdated'))?.action.command).toBe(DOWNLOAD_COMMAND)
    expect(helperNotice(status('newer'))?.action.action).toBe('reload')
    expect(helperNotice(status('foreign'))?.text).toBe(
      'Port 8787 is used by another program, not the helper.',
    )
    for (const p of ['off', 'checking', 'absent', 'connected', 'unpaired'] as const) {
      expect(helperNotice(status(p))).toBeNull()
    }
  })

  it('clockTime is 24-hour HH:MM', () => {
    expect(clockTime(new Date(2026, 0, 1, 9, 7).getTime())).toBe('09:07')
  })
})

describe('pair dialog and announcements', () => {
  it('words each failure', () => {
    const s = status('unpaired')
    expect(pairError({ ok: false, reason: 'format' }, s)).toBe(
      'That isn’t a helper token. Copy the whole line the helper printed.',
    )
    expect(pairError({ ok: false, reason: 'stale', tokenId: '4d1566a1' }, s)).toBe(
      'That token is from another helper run. This helper’s fingerprint is 4d1566a1.',
    )
    expect(pairError({ ok: false, reason: 'foreign' }, s)).toBe(
      'Something on port 8787 answered but couldn’t prove it is your helper. Nothing was sent.',
    )
    expect(pairError({ ok: false, reason: 'unreachable' }, s)).toBe(
      'The helper isn’t answering on 127.0.0.1:8787.',
    )
  })

  it('names the port the attempt tried, which a link may set, not the page’s', () => {
    const s = status('absent')
    expect(pairError({ ok: false, reason: 'unreachable', port: 8790 }, s)).toBe(
      'The helper isn’t answering on 127.0.0.1:8790.',
    )
    expect(pairError({ ok: false, reason: 'foreign', port: 8790 }, s)).toBe(
      'Something on port 8790 answered but couldn’t prove it is your helper. Nothing was sent.',
    )
  })

  it('the Remember note depends on --keep-token', () => {
    expect(rememberNote(false)).toBe(
      'Keeps this browser paired while this helper keeps running. Leave it off on a shared Mac.',
    )
    expect(rememberNote(true)).toMatch(
      /even after the helper restarts \(it runs with --keep-token\)/,
    )
  })

  it('on the helper’s own page, says the pairing isn’t saved and how long it lasts', () => {
    expect(localPairingNote(false)).toMatch(/isn’t saved\. It lasts while this tab stays open\.$/)
    // --keep-token: the token stays in memory only, so a reload needs the pairing again.
    expect(localPairingNote(true)).toMatch(/isn’t saved\. Pair again after you reload it\.$/)
  })

  it('announces connected, stopped and restarted, once each', () => {
    expect(helperAnnouncement('checking', 'connected')).toBe('Local helper connected.')
    expect(helperAnnouncement('lost', 'connected')).toBe('Local helper connected.')
    expect(helperAnnouncement('connected', 'lost')).toBe('Local helper stopped.')
    expect(helperAnnouncement('connected', 'stale')).toBe(
      'The local helper restarted. Pair this page again.',
    )
    expect(helperAnnouncement('connected', 'connected')).toBeNull()
    expect(helperAnnouncement('off', 'absent')).toBeNull()
  })

  it('says how a look the tester asked for ended, and only then', () => {
    expect(helperAnnouncement('checking', 'absent', true)).toBe(
      'Local helper not found. Is it running?',
    )
    expect(helperAnnouncement('checking', 'denied', true)).toBe(
      'This browser blocked the local helper.',
    )
    expect(helperAnnouncement('checking', 'foreign', true)).toBe(
      'Another program answers on the helper’s port.',
    )
    expect(helperAnnouncement('checking', 'unpaired', true)).toBe(
      'The local helper is running. Pair this page.',
    )
    // A browser that probes by itself on load says nothing to a visitor who never asked.
    expect(helperAnnouncement('checking', 'absent')).toBeNull()
    expect(helperAnnouncement('checking', 'absent', false)).toBeNull()
    // Polls after the first answer aren't news.
    expect(helperAnnouncement('absent', 'foreign', true)).toBeNull()
  })
})
