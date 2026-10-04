import type { Tone } from '../model'
import { LINKS } from '../preflight/copy'
import type { Os } from '../preflight/types'
import type { HelperPhase, HelperStatus, PairResult } from './connection'
import { localPageUrl } from './env'
import { DEFAULT_PORT, type HelperDevice } from './protocol'

/*
  What the page says about the local helper, phase by phase (spec §6.8): the header chip, the
  Gate's iPhone card, the notice strip above the grid, the pair dialog's errors, and the
  live-region announcements. Pure functions of HelperStatus, so every phase's words are tested
  without a DOM, and the components only lay them out in the locked shadcn look.

  The page owns these words, the helper owns its codes: nothing here repeats what the helper
  says about this Mac's tools (that is the checklist, worded by /api/doctor).
*/

/** Where the helper's file lives, and the commands a tester copies. */
export const HELPER_URL = 'https://bauloc.github.io/device/agent/device-bridge.mjs'
export const SOURCE_URL =
  'https://github.com/bauloc/bauloc.github.io/blob/master/device/agent/device-bridge.mjs'
/** ` --port N` for any port but the default, so a copied command starts where the page looks. */
const portFlag = (port: number) => (port === DEFAULT_PORT ? '' : ` --port ${String(port)}`)
/** Fetches the file (again: it replaces the old one) and starts it on `port`. */
export const downloadCommand = (port: number = DEFAULT_PORT) =>
  `curl -fsSL ${HELPER_URL} -o ~/device-bridge.mjs && node ~/device-bridge.mjs${portFlag(port)}`
/** Starts the file a download command already fetched, on `port`. */
export const startCommand = (port: number = DEFAULT_PORT) =>
  `node ~/device-bridge.mjs${portFlag(port)}`
export const DOWNLOAD_COMMAND = downloadCommand()
export const START_COMMAND = startCommand()
/** From _app/, for `npm run dev`: dev origins are refused unless the helper runs with --dev. */
export const DEV_COMMAND = 'node ../device/agent/device-bridge.mjs --dev'
/**
 * Port taken: the helper on the next one. It downloads too, since a first-time tester whose port
 * is held by another program has no file yet.
 */
export const otherPortCommand = (port: number) => downloadCommand(port + 1)

/** Where to get Node.js: the page detects the system and offers its installer. */
export const NODE_URL = LINKS.node
const NODE_CHECK = 'Needs Node.js 18 or newer (node -v shows yours).'

/** What the helper runs on, and the shortest way to get it on this system. */
export function nodeHint(os?: Os): string {
  switch (os) {
    case 'windows':
      return `${NODE_CHECK} No Node? Get the installer from nodejs.org, or run winget install OpenJS.NodeJS.LTS.`
    case 'linux':
    case 'chromeos':
      return `${NODE_CHECK} No Node? nodejs.org gives the install commands for Linux.`
    default:
      return `${NODE_CHECK} No Node? Get the installer from nodejs.org, or run brew install node.`
  }
}

/** A button the page wires up. `check` opens the Environment check. */
export type HelperAction = 'connect' | 'pair' | 'check' | 'open-local' | 'reload' | 'copy-command'

export interface HelperActionView {
  readonly action: HelperAction
  readonly label: string
  /** open-local: the helper's page. */
  readonly href?: string
  /** copy-command: what is copied. */
  readonly command?: string
  /**
   * Working on it: the button stays, aria-disabled with a spinner, so the focus a keyboard user
   * put on it doesn't fall to <body> while the page looks.
   */
  readonly busy?: boolean
}

const address = (status: HelperStatus) => `127.0.0.1:${String(status.env.port)}`

/* ---------------------------------------------------------------- *
 * Header chip
 * ---------------------------------------------------------------- */

export interface HelperChipView {
  readonly tone: Tone
  readonly text: string
  /** What a click does; null: nothing (the chip is then plain text). */
  readonly action: HelperActionView | null
  readonly tooltip: string
}

const CHECK: HelperActionView = { action: 'check', label: 'Environment check' }
const CONNECT: HelperActionView = { action: 'connect', label: 'Connect helper' }
const PAIR: HelperActionView = { action: 'pair', label: 'Pair…' }
const RELOAD: HelperActionView = { action: 'reload', label: 'Reload' }

const openLocal = (status: HelperStatus): HelperActionView => ({
  action: 'open-local',
  label: 'Open the helper’s page',
  href: localPageUrl(status.env.port),
})

/**
 * The header chip, next to the WebUSB one: two chips keep "the helper isn't running" and "the
 * helper runs, with no devices" from looking alike. `devices` are the helper's own rows.
 */
export function helperChip(status: HelperStatus, devices: readonly HelperDevice[]): HelperChipView {
  const port = String(status.env.port)
  switch (status.phase) {
    case 'off':
      return {
        tone: 'off',
        text: 'Connect helper',
        action: CONNECT,
        tooltip: 'Looks for the Device Lab helper on this Mac. The browser may ask first.',
      }
    case 'checking':
      return status.promptLikely
        ? {
            tone: 'warn',
            text: 'Allow in the browser prompt',
            action: null,
            tooltip:
              'The browser asks whether this page may reach apps on this device. Choose Allow.',
          }
        : {
            tone: 'busy',
            text: 'Looking for the helper…',
            action: null,
            tooltip: `Looking for the helper on ${address(status)}.`,
          }
    case 'absent':
      return {
        tone: 'off',
        text: 'Helper not running',
        action: CHECK,
        tooltip: `Nothing answers on ${address(status)}. Start the helper in Terminal.`,
      }
    case 'dismissed':
      return {
        tone: 'warn',
        text: 'Helper needs permission',
        action: CONNECT,
        tooltip: 'The browser’s permission prompt was closed. Connect again to see it.',
      }
    case 'denied':
      return {
        tone: 'bad',
        text: 'Browser blocked the helper',
        action: CHECK,
        tooltip: 'This browser stops this page from reaching apps on this device.',
      }
    case 'safari':
      return {
        tone: 'off',
        text: 'Helper: use its own page',
        action: openLocal(status),
        tooltip: 'Safari can’t reach the helper from this page; the helper serves its own copy.',
      }
    case 'foreign':
      return {
        tone: 'bad',
        text: `Port ${port} is another app`,
        action: CHECK,
        tooltip: `Something other than the helper answers on ${address(status)}.`,
      }
    case 'outdated':
      return {
        tone: 'warn',
        text: 'Helper outdated',
        action: CHECK,
        tooltip: 'This helper is older than this page needs. Download it again.',
      }
    case 'newer':
      return {
        tone: 'warn',
        text: 'Reload for the new helper',
        action: RELOAD,
        tooltip: 'The helper is newer than this page.',
      }
    case 'unpaired':
      return {
        tone: 'warn',
        text: 'Pair this page',
        action: PAIR,
        tooltip: 'The helper is running. Open the link it printed, or paste its token.',
      }
    case 'stale':
      return {
        tone: 'warn',
        text: 'Helper restarted — pair again',
        action: PAIR,
        tooltip: 'The helper restarted, so this page’s pairing ended.',
      }
    case 'connected': {
      const ready = devices.filter((d) => d.state === 'ready').length
      if (devices.length === 0) {
        return {
          tone: 'ok',
          text: 'Helper ready · no devices',
          action: CHECK,
          tooltip: 'The helper runs. Plug in an iPhone with a cable and unlock it.',
        }
      }
      return {
        tone: ready === devices.length ? 'ok' : 'warn',
        text: `${String(ready)}/${String(devices.length)} ready via helper`,
        action: CHECK,
        tooltip:
          ready === devices.length
            ? 'Every device the helper sees is ready.'
            : 'Some devices need something first; their cards say what.',
      }
    }
    case 'lost':
      return {
        tone: 'bad',
        text: 'Helper stopped',
        action: CHECK,
        tooltip: 'The helper stopped answering. Start it again; this page reconnects by itself.',
      }
  }
}

/* ---------------------------------------------------------------- *
 * Gate: the iPhone card
 * ---------------------------------------------------------------- */

export interface HelperCardView {
  readonly title: string
  /** Paragraphs, in order. */
  readonly body: readonly string[]
  /** What the helper needs to run (Node.js), said before the command that runs it; or null. */
  readonly requires: string | null
  /** A command to copy (the shared Command block), and the line that leads into it. */
  readonly command: { readonly lead: string; readonly text: string } | null
  /** The line before the actions ("Already running?"), or null. */
  readonly actionsLead: string | null
  readonly actions: readonly HelperActionView[]
  /** Links beside the actions: where to get Node.js, the helper's source. */
  readonly links: readonly { readonly label: string; readonly href: string }[]
  /** Quieter lines under everything. */
  readonly notes: readonly string[]
}

/** The card's case for the helper, which is about iPhones; the Wi‑Fi dialog leaves it out. */
export const NEEDS_HELPER =
  'macOS keeps the iPhone’s USB connection for itself, so no browser can reach it. A small helper on this Mac bridges the gap: one file that runs with Node.js, only while its Terminal window is open.'
const HOSTED_NOTE =
  'Chrome, Edge and Firefox ask once to let this page reach apps on this device. Choose Allow.'
/** The iPhone card on a system that isn't macOS: the helper reaches iPhones only there. */
export const NEEDS_MAC =
  'Only macOS lets the helper reach an iPhone. Open Device Lab on a Mac to use one.'

const NODE_LINK = { label: 'Get Node.js (LTS)', href: NODE_URL } as const
const SOURCE_LINK = { label: 'Review the source', href: SOURCE_URL } as const

/** The phases whose card is "Needs the helper". */
const NEEDS: ReadonlySet<HelperPhase> = new Set(['off', 'absent', 'dismissed', 'checking'])

/** The systems whose browsers may show this page but whose helper never reaches an iPhone. */
const NOT_MAC: ReadonlySet<Os> = new Set(['windows', 'linux', 'chromeos', 'android', 'ios'])

export interface HelperCardOptions {
  /** The system this page runs on (preflight/env.ts); undefined is taken for a Mac. */
  readonly os?: Os
  /**
   * The Gate's iPhone card (the default). False for the Wi‑Fi dialog, which needs the helper
   * on any system, for Android.
   */
  readonly iphone?: boolean
}

/** The Gate's iPhone card, shown while nothing is listed. */
export function helperCard(status: HelperStatus, options: HelperCardOptions = {}): HelperCardView {
  const { os, iphone = true } = options
  const port = String(status.env.port)
  const hosted = status.env.mode === 'hosted'
  const mac = os === undefined || !NOT_MAC.has(os)
  const card = (view: Partial<HelperCardView> & { title: string }): HelperCardView => ({
    body: [],
    requires: null,
    command: null,
    actionsLead: null,
    actions: [],
    links: [],
    notes: [],
    ...view,
  })
  // A tester who never ran the helper may have no Node.js yet: say so where the first command is.
  const firstRun = { requires: nodeHint(os), links: [NODE_LINK] }
  const terminal = mac ? 'Run this in Terminal on this Mac:' : 'Run this in a terminal:'
  // A helper that ran before: no "on this Mac", but still no macOS app name off macOS.
  const again = mac ? 'Run this in Terminal:' : 'Run this in a terminal:'

  // No helper reaches an iPhone off macOS, so the iPhone card offers none (the helper's own
  // mac.os row says the same once it runs).
  if (iphone && !mac) return card({ title: 'iPhones need a Mac', body: [NEEDS_MAC] })

  if (NEEDS.has(status.phase)) {
    const extra: string[] = []
    if (status.phase === 'absent') {
      extra.push(
        `Nothing answers on ${address(status)}. Is the helper running` +
          // A dev server's origin is refused unless the helper runs with --dev (§6.6).
          (status.env.devOrigin ? ', and started with --dev?' : '?'),
      )
    } else if (status.phase === 'dismissed') {
      extra.push('The permission prompt was closed. Connect again to see it.')
    } else if (status.phase === 'checking') {
      extra.push(
        status.promptLikely
          ? 'Waiting for your answer to the browser’s prompt…'
          : `Looking for the helper on ${address(status)}…`,
      )
    }
    return card({
      title: 'Needs the helper',
      body: [NEEDS_HELPER, ...extra],
      ...firstRun,
      command: {
        lead: terminal,
        text: status.env.devOrigin ? DEV_COMMAND : downloadCommand(status.env.port),
      },
      actionsLead: 'It opens this page paired. Already running?',
      // Kept while looking, busy: the button a keyboard user pressed stays where focus is.
      actions: [status.phase === 'checking' ? { ...CONNECT, busy: true } : CONNECT],
      links: [NODE_LINK, SOURCE_LINK],
      notes: hosted ? [HOSTED_NOTE] : [],
    })
  }

  switch (status.phase) {
    case 'denied':
      return card({
        title: 'Blocked by this browser',
        body: [
          'This browser stops this page from reaching apps on this device. In Chrome or Edge: Site settings → Apps on device → Allow, then reload. In Firefox: Settings → Privacy & Security → Device apps and services. Or use the helper’s own page, which needs no permission.',
        ],
        // The helper's page exists only while the helper runs: how to start it comes first.
        ...firstRun,
        command: { lead: terminal, text: downloadCommand(status.env.port) },
        actionsLead: 'Already running? Open its page:',
        actions: [openLocal(status)],
      })
    case 'safari':
      return card({
        title: 'Use the helper’s page in Safari',
        body: [
          'Safari never lets a secure page talk to this Mac’s helper, so the helper serves this same page itself. Start the helper; it opens the right page.',
        ],
        ...firstRun,
        command: { lead: terminal, text: downloadCommand(status.env.port) },
        actions: [openLocal(status)],
      })
    case 'foreign':
      return card({
        title: `Port ${port} is taken`,
        body: [
          `Another program answers on port ${port}. Start the helper on another port; it opens the right page.`,
        ],
        ...firstRun,
        command: { lead: terminal, text: otherPortCommand(status.env.port) },
      })
    case 'outdated':
      return card({
        title: 'Update the helper',
        body: [
          `Your helper${status.health?.version ? ` (${status.health.version})` : ''} is older than this page needs. Download it again; the command replaces it.`,
        ],
        command: { lead: again, text: downloadCommand(status.env.port) },
      })
    case 'newer':
      return card({
        title: 'Reload this page',
        body: ['The helper is newer than this page.'],
        actions: [RELOAD],
      })
    case 'unpaired':
    case 'stale':
      return card({
        title: 'Pair this page',
        body: [
          status.phase === 'unpaired'
            ? 'The helper is running. Open the link it printed, or paste its token.'
            : 'The helper restarted, so this page’s pairing ended. Open the new link it printed, or paste the new token.',
        ],
        actions: [PAIR],
      })
    case 'connected':
      return card({
        title: 'Ready for iPhones',
        body: [
          'Plug in an iPhone with a cable and unlock it. If it asks, tap Trust.',
          ...(status.lanes?.ios.screenshots === 'none'
            ? ['Screenshots of iOS 17 and newer need Xcode on this Mac — see the checklist below.']
            : []),
        ],
      })
    case 'lost':
      return card({
        title: 'The helper stopped',
        body: [
          hosted
            ? 'Start it again; this page reconnects by itself.'
            : 'Start it again, then open the link it prints.',
        ],
        // On the port this page polls, or "reconnects by itself" never happens.
        command: { lead: again, text: startCommand(status.env.port) },
      })
    default:
      // NEEDS phases returned above; this keeps the switch exhaustive for the compiler.
      return card({ title: 'Needs the helper', body: [NEEDS_HELPER] })
  }
}

/* ---------------------------------------------------------------- *
 * Gate: the Android card without WebUSB
 * ---------------------------------------------------------------- */

export interface HelperAndroidView {
  readonly sentence: string
  readonly command: string | null
  /** Start adb server, with its note; only when the helper can start one. */
  readonly startAdb: { readonly label: string; readonly note: string } | null
}

/**
 * Android through the helper, for a browser without WebUSB. Null while the helper isn't
 * connected: the card keeps today's words then.
 */
export function helperAndroid(status: HelperStatus): HelperAndroidView | null {
  if (status.phase !== 'connected' || !status.lanes) return null
  const { android } = status.lanes
  if (android.status === 'off') return null
  if (android.adb === 'missing' && android.status !== 'ok') {
    return {
      sentence: 'Install Android’s platform tools first:',
      command: 'brew install --cask android-platform-tools',
      startAdb: null,
    }
  }
  if (android.status === 'stopped') {
    return {
      sentence: 'The helper reaches Android through Google’s adb server, which isn’t running.',
      command: null,
      startAdb: status.health?.features.includes('android.start-server')
        ? {
            label: 'Start adb server',
            note: 'While it runs, Chrome’s WebUSB can’t use Android phones on this Mac; adb kill-server gives them back.',
          }
        : null,
    }
  }
  if (android.status === 'error') {
    return {
      sentence: android.reason ?? 'The helper can’t use Google’s adb server right now.',
      command: null,
      startAdb: null,
    }
  }
  return {
    sentence: 'Ready through the helper. Plug in a phone with USB debugging on.',
    command: null,
    startAdb: null,
  }
}

/* ---------------------------------------------------------------- *
 * The notice strip above the device grid
 * ---------------------------------------------------------------- */

export interface HelperNoticeView {
  readonly tone: Tone
  readonly text: string
  readonly action: HelperActionView
}

/** "14:05", in local time: when the helper stopped. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The strip shown once devices are listed (the Gate is gone), and only when the tester showed
 * they want the helper in this page view. Null otherwise.
 */
export function helperNotice(status: HelperStatus): HelperNoticeView | null {
  if (!status.intent) return null
  const port = String(status.env.port)
  switch (status.phase) {
    case 'stale':
      return {
        tone: 'warn',
        text: 'The helper restarted. Pair this page again to see iPhones.',
        action: PAIR,
      }
    case 'lost':
      return {
        tone: 'bad',
        text: `The helper stopped at ${clockTime(status.since)}. Start it again; this page reconnects by itself.`,
        action: {
          action: 'copy-command',
          label: 'Copy command',
          command: startCommand(status.env.port),
        },
      }
    case 'outdated':
      return {
        tone: 'warn',
        text: 'The helper is older than this page needs. Download it again.',
        action: {
          action: 'copy-command',
          label: 'Copy command',
          command: downloadCommand(status.env.port),
        },
      }
    case 'newer':
      return { tone: 'warn', text: 'The helper is newer than this page.', action: RELOAD }
    case 'foreign':
      return {
        tone: 'bad',
        text: `Port ${port} is used by another program, not the helper.`,
        action: { action: 'check', label: 'Open check' },
      }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- *
 * Pair dialog and announcements
 * ---------------------------------------------------------------- */

/** The note under "Remember on this computer". */
export function rememberNote(tokenPersistent: boolean): string {
  return tokenPersistent
    ? 'Keeps this browser paired, even after the helper restarts (it runs with --keep-token). Leave it off on a shared Mac.'
    : 'Keeps this browser paired while this helper keeps running. Leave it off on a shared Mac.'
}

/**
 * The pair dialog's note on the helper's own page, which never remembers a pairing (its origin
 * is whatever listens on the port next): no switch, just how long the pairing lasts there.
 */
export function localPairingNote(tokenPersistent: boolean): string {
  return tokenPersistent
    ? 'This is the helper’s own page, so the pairing isn’t saved. Pair again after you reload it.'
    : 'This is the helper’s own page, so the pairing isn’t saved. It lasts while this tab stays open.'
}

/**
 * The pair dialog's error for a failed attempt. A link may name another port than the page's:
 * the port the attempt tried (`result.port`, when the connection reports it) is the one named.
 */
export function pairError(
  result: Exclude<PairResult, { ok: true }> & { readonly port?: number },
  status: HelperStatus,
): string {
  const port = String(result.port ?? status.env.port)
  switch (result.reason) {
    case 'format':
      return 'That isn’t a helper token. Copy the whole line the helper printed.'
    case 'stale':
      return result.tokenId
        ? `That token is from another helper run. This helper’s fingerprint is ${result.tokenId}.`
        : 'That token is from another helper run.'
    case 'foreign':
      return `Something on port ${port} answered but couldn’t prove it is your helper. Nothing was sent.`
    case 'unreachable':
      return `The helper isn’t answering on 127.0.0.1:${port}.`
    case 'outdated':
      return 'This helper is older than this page needs. Download it again, then pair.'
    case 'newer':
      return 'The helper is newer than this page. Reload the page, then pair.'
  }
}

/**
 * How a look for the helper ended, said once it ends: the Connect button stays put while the
 * page looks, so without these a screen reader hears nothing of the answer.
 */
const OUTCOMES: Partial<Record<HelperPhase, string>> = {
  absent: 'Local helper not found. Is it running?',
  dismissed: 'The browser’s prompt was closed. Connect again to see it.',
  denied: 'This browser blocked the local helper.',
  safari: 'Safari can’t reach the local helper from this page. Use the helper’s own page.',
  foreign: 'Another program answers on the helper’s port.',
  outdated: 'The local helper is outdated. Download it again.',
  newer: 'The local helper is newer than this page. Reload the page.',
  unpaired: 'The local helper is running. Pair this page.',
}

/**
 * What the polite live region says when the phase changes, once each; null for no change worth
 * saying. "Lost" is also a toast, since the chip is hidden on narrow screens. How a look ended
 * is said only to a tester who asked for the helper (`intent`): a browser that probes by itself
 * on load must not tell every visitor the helper isn't running.
 */
export function helperAnnouncement(
  before: HelperPhase,
  after: HelperPhase,
  intent = false,
): string | null {
  if (before === after) return null
  if (after === 'connected') return 'Local helper connected.'
  if (before === 'connected' && after === 'lost') return 'Local helper stopped.'
  if (after === 'stale' && (before === 'connected' || before === 'lost'))
    return 'The local helper restarted. Pair this page again.'
  if (intent && before === 'checking') return OUTCOMES[after] ?? null
  return null
}
