import { localized } from '@/lib/i18n'

import type { Tone } from '../model'
import { LINKS } from '../preflight/copy'
import type { Os } from '../preflight/types'
import type { HelperPhase, HelperStatus, PairResult } from './connection'
import { localPageUrl } from './env'
import { DEFAULT_PORT, type HelperDevice } from './protocol'
import { featureSupport, type GatedFeature, type HelperUpdate } from './update'

/*
  What the page says about the local helper, phase by phase (spec §6.8): the header chip, the
  Gate's iPhone card, the notice strip above the grid, the pair dialog's errors, and the
  live-region announcements. Pure functions of HelperStatus, so every phase's words are tested
  without a DOM, and the components only lay them out in the locked shadcn look.

  The page owns these words, the helper owns its codes: nothing here repeats what the helper
  says about this Mac's tools (that is the checklist, worded by /api/doctor).

  The words are in both of the site's languages, in the `localized` tables beside the code that
  says them: a view is worded when it is built, in the language on screen. The commands are the
  same in both.
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

/** What the helper runs on (`check`), then the shortest way to get it, per system. */
const NODE = localized({
  en: {
    check: 'Needs Node.js 18 or newer (node -v shows yours).',
    windows: (check: string) =>
      `${check} No Node? Get the installer from nodejs.org, or run winget install OpenJS.NodeJS.LTS.`,
    linux: (check: string) => `${check} No Node? nodejs.org gives the install commands for Linux.`,
    mac: (check: string) =>
      `${check} No Node? Get the installer from nodejs.org, or run brew install node.`,
  },
  vi: {
    check: 'Cần Node.js 18 trở lên (xem phiên bản bằng node -v).',
    windows: (check: string) =>
      `${check} Chưa có Node? Hãy tải trình cài đặt từ nodejs.org, hoặc chạy winget install OpenJS.NodeJS.LTS.`,
    linux: (check: string) => `${check} Chưa có Node? nodejs.org có sẵn các lệnh cài cho Linux.`,
    mac: (check: string) =>
      `${check} Chưa có Node? Hãy tải trình cài đặt từ nodejs.org, hoặc chạy brew install node.`,
  },
})

/** What the helper runs on, and the shortest way to get it on this system. */
export function nodeHint(os?: Os): string {
  switch (os) {
    case 'windows':
      return NODE.windows(NODE.check)
    case 'linux':
    case 'chromeos':
      return NODE.linux(NODE.check)
    default:
      return NODE.mac(NODE.check)
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

/** The buttons' words. */
const LABELS = localized({
  en: {
    check: 'Environment check',
    connect: 'Connect helper',
    pair: 'Pair…',
    reload: 'Reload',
    openLocal: 'Open the helper’s page',
    copyCommand: 'Copy command',
    openCheck: 'Open check',
  },
  vi: {
    check: 'Kiểm tra môi trường',
    connect: 'Kết nối helper',
    pair: 'Ghép nối…',
    reload: 'Tải lại',
    openLocal: 'Mở trang của helper',
    copyCommand: 'Sao chép lệnh',
    openCheck: 'Mở kiểm tra',
  },
})

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

// Built with each view, so the label is in the language on screen.
const checkButton = (): HelperActionView => ({ action: 'check', label: LABELS.check })
const connectButton = (): HelperActionView => ({ action: 'connect', label: LABELS.connect })
const pairButton = (): HelperActionView => ({ action: 'pair', label: LABELS.pair })
const reloadButton = (): HelperActionView => ({ action: 'reload', label: LABELS.reload })

const openLocal = (status: HelperStatus): HelperActionView => ({
  action: 'open-local',
  label: LABELS.openLocal,
  href: localPageUrl(status.env.port),
})

/**
 * A published helper newer than the running one, in one sentence; and how to update a running
 * helper, after the command is copied (`steps`).
 */
const UPDATE = localized({
  en: {
    newer: (version: string, running: string) =>
      `Helper ${version} is out; this one is ${running}.`,
    rebuilt: (version: string) => `A newer build of helper ${version} is out.`,
    steps: 'Press Ctrl+C in its window, run the command, then reload this page.',
  },
  vi: {
    newer: (version: string, running: string) =>
      `Đã có helper ${version}; bản đang chạy là ${running}.`,
    rebuilt: (version: string) => `Đã có bản dựng mới hơn của helper ${version}.`,
    steps: 'Hãy nhấn Ctrl+C trong cửa sổ của helper, chạy lệnh, rồi tải lại trang này.',
  },
})

/** What a published helper newer than the running one is, in one sentence. */
export function updateSentence(update: HelperUpdate): string {
  return update.kind === 'newer'
    ? UPDATE.newer(update.version, update.running)
    : UPDATE.rebuilt(update.version)
}

/** The chip's words per phase: what it says, and the tooltip that says more. */
const CHIP = localized({
  en: {
    off: {
      text: 'Connect helper',
      tooltip: 'Looks for the Device Lab helper on this Mac. The browser may ask first.',
    },
    prompt: {
      text: 'Allow in the browser prompt',
      tooltip: 'The browser asks whether this page may reach apps on this device. Choose Allow.',
    },
    checking: {
      text: 'Looking for the helper…',
      tooltip: (address: string) => `Looking for the helper on ${address}.`,
    },
    absent: {
      text: 'Helper not running',
      tooltip: (address: string) => `Nothing answers on ${address}. Start the helper in Terminal.`,
    },
    dismissed: {
      text: 'Helper needs permission',
      tooltip: 'The browser’s permission prompt was closed. Connect again to see it.',
    },
    denied: {
      text: 'Browser blocked the helper',
      tooltip: 'This browser stops this page from reaching apps on this device.',
    },
    safari: {
      text: 'Helper: use its own page',
      tooltip: 'Safari can’t reach the helper from this page; the helper serves its own copy.',
    },
    foreign: {
      text: (port: string) => `Port ${port} is another app`,
      tooltip: (address: string) => `Something other than the helper answers on ${address}.`,
    },
    outdated: {
      text: 'Helper outdated',
      tooltip: 'This helper is older than this page needs. Download it again.',
    },
    newer: { text: 'Reload for the new helper', tooltip: 'The helper is newer than this page.' },
    unpaired: {
      text: 'Pair this page',
      tooltip: 'The helper is running. Open the link it printed, or paste its token.',
    },
    stale: {
      text: 'Helper restarted — pair again',
      tooltip: 'The helper restarted, so this page’s pairing ended.',
    },
    empty: {
      text: 'Helper ready · no devices',
      tooltip: 'The helper runs. Plug in an iPhone with a cable and unlock it.',
    },
    ready: (ready: string, total: string) => `${ready}/${total} ready via helper`,
    allReady: 'Every device the helper sees is ready.',
    someReady: 'Some devices need something first; their cards say what.',
    lost: {
      text: 'Helper stopped',
      tooltip: 'The helper stopped answering. Start it again; this page reconnects by itself.',
    },
    /** A connected helper that a newer published one should replace. */
    update: {
      empty: 'Helper ready · update available',
      ready: (ready: string, total: string) =>
        `${ready}/${total} ready via helper · update available`,
      tooltip: (sentence: string) => `${sentence} The Environment check has the command.`,
    },
  },
  vi: {
    off: {
      text: 'Kết nối helper',
      tooltip: 'Tìm helper của Device Lab trên máy Mac này. Trình duyệt có thể hỏi bạn trước.',
    },
    prompt: {
      text: 'Bấm Cho phép trên trình duyệt',
      tooltip:
        'Trình duyệt hỏi xem có cho trang này truy cập ứng dụng trên thiết bị này không. Hãy chọn Cho phép.',
    },
    checking: {
      text: 'Đang tìm helper…',
      tooltip: (address: string) => `Đang tìm helper tại ${address}.`,
    },
    absent: {
      text: 'Helper chưa chạy',
      tooltip: (address: string) =>
        `Không có phản hồi từ ${address}. Hãy chạy helper trong Terminal.`,
    },
    dismissed: {
      text: 'Helper cần được cấp quyền',
      tooltip:
        'Hộp thoại xin quyền của trình duyệt đã bị đóng. Hãy kết nối lại để hộp thoại hiện ra.',
    },
    denied: {
      text: 'Trình duyệt đã chặn helper',
      tooltip: 'Trình duyệt này không cho trang này truy cập ứng dụng trên thiết bị này.',
    },
    safari: {
      text: 'Helper: dùng trang riêng',
      tooltip:
        'Safari không kết nối được với helper từ trang này; helper có sẵn một bản riêng của trang.',
    },
    foreign: {
      text: (port: string) => `Cổng ${port} thuộc ứng dụng khác`,
      tooltip: (address: string) =>
        `Một chương trình khác, không phải helper, đang phản hồi tại ${address}.`,
    },
    outdated: {
      text: 'Helper đã cũ',
      tooltip: 'Helper này cũ hơn phiên bản trang này cần. Hãy tải lại tệp helper.',
    },
    newer: { text: 'Tải lại trang cho helper mới', tooltip: 'Helper mới hơn trang này.' },
    unpaired: {
      text: 'Ghép nối trang này',
      tooltip: 'Helper đang chạy. Hãy mở liên kết mà helper đã in ra, hoặc dán token.',
    },
    stale: {
      text: 'Helper đã khởi động lại — ghép nối lại',
      tooltip: 'Helper đã khởi động lại nên trang này không còn được ghép nối.',
    },
    empty: {
      text: 'Helper sẵn sàng · chưa có thiết bị',
      tooltip: 'Helper đang chạy. Hãy cắm iPhone bằng cáp và mở khóa máy.',
    },
    ready: (ready: string, total: string) => `${ready}/${total} sẵn sàng qua helper`,
    allReady: 'Mọi thiết bị mà helper thấy đều đã sẵn sàng.',
    someReady: 'Một số thiết bị cần thêm thao tác; hãy xem từng thiết bị để biết cần làm gì.',
    lost: {
      text: 'Helper đã dừng',
      tooltip: 'Helper không còn phản hồi. Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
    },
    update: {
      empty: 'Helper sẵn sàng · có bản cập nhật',
      ready: (ready: string, total: string) =>
        `${ready}/${total} sẵn sàng qua helper · có bản cập nhật`,
      tooltip: (sentence: string) => `${sentence} Lệnh cập nhật có trong Kiểm tra môi trường.`,
    },
  },
})

/**
 * The header chip, next to the WebUSB one: two chips keep "the helper isn't running" and "the
 * helper runs, with no devices" from looking alike. `devices` are the helper's own rows;
 * `update` (helperUpdate) adds "update available" to a connected helper's chip.
 */
export function helperChip(
  status: HelperStatus,
  devices: readonly HelperDevice[],
  update: HelperUpdate | null = null,
): HelperChipView {
  const port = String(status.env.port)
  switch (status.phase) {
    case 'off':
      return {
        tone: 'off',
        text: CHIP.off.text,
        action: connectButton(),
        tooltip: CHIP.off.tooltip,
      }
    case 'checking':
      return status.promptLikely
        ? {
            tone: 'warn',
            text: CHIP.prompt.text,
            action: null,
            tooltip: CHIP.prompt.tooltip,
          }
        : {
            tone: 'busy',
            text: CHIP.checking.text,
            action: null,
            tooltip: CHIP.checking.tooltip(address(status)),
          }
    case 'absent':
      return {
        tone: 'off',
        text: CHIP.absent.text,
        action: checkButton(),
        tooltip: CHIP.absent.tooltip(address(status)),
      }
    case 'dismissed':
      return {
        tone: 'warn',
        text: CHIP.dismissed.text,
        action: connectButton(),
        tooltip: CHIP.dismissed.tooltip,
      }
    case 'denied':
      return {
        tone: 'bad',
        text: CHIP.denied.text,
        action: checkButton(),
        tooltip: CHIP.denied.tooltip,
      }
    case 'safari':
      return {
        tone: 'off',
        text: CHIP.safari.text,
        action: openLocal(status),
        tooltip: CHIP.safari.tooltip,
      }
    case 'foreign':
      return {
        tone: 'bad',
        text: CHIP.foreign.text(port),
        action: checkButton(),
        tooltip: CHIP.foreign.tooltip(address(status)),
      }
    case 'outdated':
      return {
        tone: 'warn',
        text: CHIP.outdated.text,
        action: checkButton(),
        tooltip: CHIP.outdated.tooltip,
      }
    case 'newer':
      return {
        tone: 'warn',
        text: CHIP.newer.text,
        action: reloadButton(),
        tooltip: CHIP.newer.tooltip,
      }
    case 'unpaired':
      return {
        tone: 'warn',
        text: CHIP.unpaired.text,
        action: pairButton(),
        tooltip: CHIP.unpaired.tooltip,
      }
    case 'stale':
      return {
        tone: 'warn',
        text: CHIP.stale.text,
        action: pairButton(),
        tooltip: CHIP.stale.tooltip,
      }
    case 'connected': {
      const ready = devices.filter((d) => d.state === 'ready').length
      if (update) {
        return {
          tone: 'warn',
          text:
            devices.length === 0
              ? CHIP.update.empty
              : CHIP.update.ready(String(ready), String(devices.length)),
          action: checkButton(),
          tooltip: CHIP.update.tooltip(updateSentence(update)),
        }
      }
      if (devices.length === 0) {
        return {
          tone: 'ok',
          text: CHIP.empty.text,
          action: checkButton(),
          tooltip: CHIP.empty.tooltip,
        }
      }
      return {
        tone: ready === devices.length ? 'ok' : 'warn',
        text: CHIP.ready(String(ready), String(devices.length)),
        action: checkButton(),
        tooltip: ready === devices.length ? CHIP.allReady : CHIP.someReady,
      }
    }
    case 'lost':
      return {
        tone: 'bad',
        text: CHIP.lost.text,
        action: checkButton(),
        tooltip: CHIP.lost.tooltip,
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
/** The iPhone card on a system that isn't macOS: the helper reaches iPhones only there. */
export const NEEDS_MAC =
  'Only macOS lets the helper reach an iPhone. Open Device Lab on a Mac to use one.'

/**
 * The card's sentences that helper-card.tsx finds by their words, in the language on screen (the
 * two constants above are their English): the case for the helper, left out where a step says
 * it, and the iPhone card off macOS. Compare a card with these, never with the English.
 */
export const CARD_SENTENCES = localized({
  en: {
    needsHelper: NEEDS_HELPER,
    needsMac: NEEDS_MAC,
  },
  vi: {
    needsHelper:
      'macOS giữ kết nối USB của iPhone cho riêng mình, nên không trình duyệt nào kết nối được. Một helper nhỏ trên máy Mac này sẽ làm cầu nối: một tệp duy nhất chạy bằng Node.js, chỉ hoạt động khi cửa sổ Terminal của nó còn mở.',
    needsMac:
      'Chỉ trên macOS, helper mới kết nối được với iPhone. Hãy mở Device Lab trên máy Mac để dùng iPhone.',
  },
})

/** The card's other words, by phase. */
const CARD = localized({
  en: {
    hostedNote:
      'Chrome, Edge and Firefox ask once to let this page reach apps on this device. Choose Allow.',
    nodeLink: 'Get Node.js (LTS)',
    sourceLink: 'Review the source',
    lead: {
      mac: 'Run this in Terminal on this Mac:',
      other: 'Run this in a terminal:',
      again: 'Run this in Terminal:',
    },
    needsMac: 'iPhones need a Mac',
    needs: 'Needs the helper',
    absent: (address: string, dev: boolean) =>
      `Nothing answers on ${address}. Is the helper running${dev ? ', and started with --dev?' : '?'}`,
    dismissed: 'The permission prompt was closed. Connect again to see it.',
    waiting: 'Waiting for your answer to the browser’s prompt…',
    looking: (address: string) => `Looking for the helper on ${address}…`,
    /**
     * Before Connect on a first run. helper-card.tsx's opensPaired is how it starts, in each
     * language: the Gate's step moves that sentence up to what the step is about.
     */
    firstRunLead: 'It opens this page paired. Already running?',
    denied: {
      title: 'Blocked by this browser',
      body: 'This browser stops this page from reaching apps on this device. In Chrome or Edge: Site settings → Apps on device → Allow, then reload. In Firefox: Settings → Privacy & Security → Device apps and services. Or use the helper’s own page, which needs no permission.',
      lead: 'Already running? Open its page:',
    },
    safari: {
      title: 'Use the helper’s page in Safari',
      body: 'Safari never lets a secure page talk to this Mac’s helper, so the helper serves this same page itself. Start the helper; it opens the right page.',
    },
    foreign: {
      title: (port: string) => `Port ${port} is taken`,
      body: (port: string) =>
        `Another program answers on port ${port}. Start the helper on another port; it opens the right page.`,
    },
    outdated: {
      title: 'Update the helper',
      body: (version: string | undefined) =>
        `Your helper${version ? ` (${version})` : ''} is older than this page needs. Download it again; the command replaces it.`,
    },
    newer: { title: 'Reload this page', body: 'The helper is newer than this page.' },
    pair: {
      title: 'Pair this page',
      unpaired: 'The helper is running. Open the link it printed, or paste its token.',
      stale:
        'The helper restarted, so this page’s pairing ended. Open the new link it printed, or paste the new token.',
    },
    connected: {
      title: 'Ready for iPhones',
      body: 'Plug in an iPhone with a cable and unlock it. If it asks, tap Trust.',
      xcode: 'Screenshots of iOS 17 and newer need Xcode on this Mac — see the checklist below.',
    },
    lost: {
      title: 'The helper stopped',
      hosted: 'Start it again; this page reconnects by itself.',
      local: 'Start it again, then open the link it prints.',
    },
  },
  vi: {
    hostedNote:
      'Chrome, Edge và Firefox sẽ hỏi một lần xem có cho trang này truy cập ứng dụng trên thiết bị này không. Hãy chọn Cho phép.',
    nodeLink: 'Tải Node.js (LTS)',
    sourceLink: 'Xem mã nguồn',
    lead: {
      mac: 'Chạy lệnh này trong Terminal trên máy Mac này:',
      other: 'Chạy lệnh này trong cửa sổ dòng lệnh:',
      again: 'Chạy lệnh này trong Terminal:',
    },
    needsMac: 'iPhone cần máy Mac',
    needs: 'Cần helper',
    absent: (address: string, dev: boolean) =>
      `Không có phản hồi từ ${address}. Helper đã chạy chưa${dev ? ', và có chạy kèm --dev không?' : '?'}`,
    dismissed: 'Hộp thoại xin quyền đã bị đóng. Hãy kết nối lại để hộp thoại hiện ra.',
    waiting: 'Đang chờ bạn trả lời hộp thoại của trình duyệt…',
    looking: (address: string) => `Đang tìm helper tại ${address}…`,
    firstRunLead: 'Helper sẽ tự mở trang này và ghép nối sẵn. Helper đang chạy rồi?',
    denied: {
      title: 'Bị trình duyệt này chặn',
      body: 'Trình duyệt này không cho trang này truy cập ứng dụng trên thiết bị này. Trong Chrome hoặc Edge: Cài đặt trang web → Ứng dụng trên thiết bị → Cho phép, rồi tải lại trang. Trong Firefox: Cài đặt → Riêng tư & bảo mật → Ứng dụng và dịch vụ thiết bị. Hoặc dùng trang riêng của helper, trang đó không cần cấp quyền.',
      lead: 'Helper đang chạy rồi? Hãy mở trang của helper:',
    },
    safari: {
      title: 'Dùng trang của helper trong Safari',
      body: 'Safari không bao giờ cho trang web bảo mật giao tiếp với helper trên máy Mac này, nên helper có sẵn một bản của chính trang này. Hãy chạy helper; nó sẽ tự mở đúng trang.',
    },
    foreign: {
      title: (port: string) => `Cổng ${port} đã bị chiếm`,
      body: (port: string) =>
        `Một chương trình khác đang phản hồi trên cổng ${port}. Hãy chạy helper trên cổng khác; nó sẽ tự mở đúng trang.`,
    },
    outdated: {
      title: 'Cập nhật helper',
      body: (version: string | undefined) =>
        `Helper của bạn${version ? ` (${version})` : ''} cũ hơn phiên bản trang này cần. Hãy tải lại tệp helper; lệnh tải sẽ thay bản cũ.`,
    },
    newer: { title: 'Tải lại trang này', body: 'Helper mới hơn trang này.' },
    pair: {
      title: 'Ghép nối trang này',
      unpaired: 'Helper đang chạy. Hãy mở liên kết mà helper đã in ra, hoặc dán token.',
      stale:
        'Helper đã khởi động lại nên trang này không còn được ghép nối. Hãy mở liên kết mới mà helper đã in ra, hoặc dán token mới.',
    },
    connected: {
      title: 'Sẵn sàng cho iPhone',
      body: 'Cắm iPhone bằng cáp và mở khóa máy. Nếu máy hỏi, hãy chạm Tin cậy.',
      xcode:
        'Chụp màn hình iOS 17 trở lên cần Xcode trên máy Mac này — xem danh sách kiểm tra bên dưới.',
    },
    lost: {
      title: 'Helper đã dừng',
      hosted: 'Hãy chạy lại helper; trang này sẽ tự kết nối lại.',
      local: 'Hãy chạy lại helper, rồi mở liên kết mà helper in ra.',
    },
  },
})

const nodeLink = () => ({ label: CARD.nodeLink, href: NODE_URL })
const sourceLink = () => ({ label: CARD.sourceLink, href: SOURCE_URL })

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
  const firstRun = { requires: nodeHint(os), links: [nodeLink()] }
  const terminal = mac ? CARD.lead.mac : CARD.lead.other
  // A helper that ran before: no "on this Mac", but still no macOS app name off macOS.
  const again = mac ? CARD.lead.again : CARD.lead.other

  // No helper reaches an iPhone off macOS, so the iPhone card offers none (the helper's own
  // mac.os row says the same once it runs).
  if (iphone && !mac) return card({ title: CARD.needsMac, body: [CARD_SENTENCES.needsMac] })

  if (NEEDS.has(status.phase)) {
    const extra: string[] = []
    if (status.phase === 'absent') {
      // A dev server's origin is refused unless the helper runs with --dev (§6.6).
      extra.push(CARD.absent(address(status), status.env.devOrigin))
    } else if (status.phase === 'dismissed') {
      extra.push(CARD.dismissed)
    } else if (status.phase === 'checking') {
      extra.push(status.promptLikely ? CARD.waiting : CARD.looking(address(status)))
    }
    return card({
      title: CARD.needs,
      body: [CARD_SENTENCES.needsHelper, ...extra],
      ...firstRun,
      command: {
        lead: terminal,
        text: status.env.devOrigin ? DEV_COMMAND : downloadCommand(status.env.port),
      },
      actionsLead: CARD.firstRunLead,
      // Kept while looking, busy: the button a keyboard user pressed stays where focus is.
      actions: [status.phase === 'checking' ? { ...connectButton(), busy: true } : connectButton()],
      links: [nodeLink(), sourceLink()],
      notes: hosted ? [CARD.hostedNote] : [],
    })
  }

  switch (status.phase) {
    case 'denied':
      return card({
        title: CARD.denied.title,
        body: [CARD.denied.body],
        // The helper's page exists only while the helper runs: how to start it comes first.
        ...firstRun,
        command: { lead: terminal, text: downloadCommand(status.env.port) },
        actionsLead: CARD.denied.lead,
        actions: [openLocal(status)],
      })
    case 'safari':
      return card({
        title: CARD.safari.title,
        body: [CARD.safari.body],
        ...firstRun,
        command: { lead: terminal, text: downloadCommand(status.env.port) },
        actions: [openLocal(status)],
      })
    case 'foreign':
      return card({
        title: CARD.foreign.title(port),
        body: [CARD.foreign.body(port)],
        ...firstRun,
        command: { lead: terminal, text: otherPortCommand(status.env.port) },
      })
    case 'outdated':
      return card({
        title: CARD.outdated.title,
        body: [CARD.outdated.body(status.health?.version)],
        command: { lead: again, text: downloadCommand(status.env.port) },
      })
    case 'newer':
      return card({
        title: CARD.newer.title,
        body: [CARD.newer.body],
        actions: [reloadButton()],
      })
    case 'unpaired':
    case 'stale':
      return card({
        title: CARD.pair.title,
        body: [status.phase === 'unpaired' ? CARD.pair.unpaired : CARD.pair.stale],
        actions: [pairButton()],
      })
    case 'connected':
      return card({
        title: CARD.connected.title,
        body: [
          CARD.connected.body,
          ...(status.lanes?.ios.screenshots === 'none' ? [CARD.connected.xcode] : []),
        ],
      })
    case 'lost':
      return card({
        title: CARD.lost.title,
        body: [hosted ? CARD.lost.hosted : CARD.lost.local],
        // On the port this page polls, or "reconnects by itself" never happens.
        command: { lead: again, text: startCommand(status.env.port) },
      })
    default:
      // NEEDS phases returned above; this keeps the switch exhaustive for the compiler.
      return card({ title: CARD.needs, body: [CARD_SENTENCES.needsHelper] })
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
  /** A helper older than the feature it would need here: the update notice for it. */
  readonly update?: GatedFeature
}

const ANDROID = localized({
  en: {
    noAdb: 'Install Android’s platform tools first:',
    stopped: 'The helper reaches Android through Google’s adb server, which isn’t running.',
    startAdb: 'Start adb server',
    startNote:
      'While it runs, Chrome’s WebUSB can’t use Android phones on this Mac; adb kill-server gives them back.',
    error: 'The helper can’t use Google’s adb server right now.',
    ready: 'Ready through the helper. Plug in a phone with USB debugging on.',
  },
  vi: {
    noAdb: 'Cài platform tools của Android trước:',
    stopped: 'Helper kết nối Android qua adb server của Google, nhưng adb server chưa chạy.',
    startAdb: 'Khởi động adb server',
    startNote:
      'Khi adb server chạy, WebUSB của Chrome không dùng được điện thoại Android trên máy Mac này; lệnh adb kill-server sẽ trả lại các điện thoại đó.',
    error: 'Hiện helper không dùng được adb server của Google.',
    ready: 'Sẵn sàng qua helper. Hãy cắm một điện thoại đã bật Gỡ lỗi qua USB.',
  },
})

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
      sentence: ANDROID.noAdb,
      command: 'brew install --cask android-platform-tools',
      startAdb: null,
    }
  }
  if (android.status === 'stopped') {
    const support = featureSupport(status, 'android.start-server')
    return {
      sentence: ANDROID.stopped,
      command: null,
      startAdb: support === 'ready' ? { label: ANDROID.startAdb, note: ANDROID.startNote } : null,
      ...(support === 'older' ? { update: 'android.start-server' as const } : {}),
    }
  }
  if (android.status === 'error') {
    return {
      // The helper's own reason, when it gave one: its words, in English.
      sentence: android.reason ?? ANDROID.error,
      command: null,
      startAdb: null,
    }
  }
  return {
    sentence: ANDROID.ready,
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

const NOTICE = localized({
  en: {
    stale: 'The helper restarted. Pair this page again to see iPhones.',
    lost: (time: string) =>
      `The helper stopped at ${time}. Start it again; this page reconnects by itself.`,
    outdated: 'The helper is older than this page needs. Download it again.',
    newer: 'The helper is newer than this page.',
    foreign: (port: string) => `Port ${port} is used by another program, not the helper.`,
    /** updateSentence(…), then UPDATE.steps. */
    update: (sentence: string, steps: string) => `Helper update available. ${sentence} ${steps}`,
  },
  vi: {
    stale: 'Helper đã khởi động lại. Hãy ghép nối lại trang này để thấy iPhone.',
    lost: (time: string) =>
      `Helper đã dừng lúc ${time}. Hãy chạy lại helper; trang này sẽ tự kết nối lại.`,
    outdated: 'Helper cũ hơn phiên bản trang này cần. Hãy tải lại tệp helper.',
    newer: 'Helper mới hơn trang này.',
    foreign: (port: string) => `Một chương trình khác, không phải helper, đang dùng cổng ${port}.`,
    update: (sentence: string, steps: string) => `Có bản cập nhật cho helper. ${sentence} ${steps}`,
  },
})

/**
 * The strip shown once devices are listed (the Gate is gone), and only when the tester showed
 * they want the helper in this page view. Null otherwise. `update` (helperUpdate): a connected
 * helper that a newer published one should replace.
 */
export function helperNotice(
  status: HelperStatus,
  update: HelperUpdate | null = null,
): HelperNoticeView | null {
  if (!status.intent) return null
  const port = String(status.env.port)
  switch (status.phase) {
    case 'connected':
      return update
        ? {
            tone: 'warn',
            text: NOTICE.update(updateSentence(update), UPDATE.steps),
            action: {
              action: 'copy-command',
              label: LABELS.copyCommand,
              command: downloadCommand(status.env.port),
            },
          }
        : null
    case 'stale':
      return {
        tone: 'warn',
        text: NOTICE.stale,
        action: pairButton(),
      }
    case 'lost':
      return {
        tone: 'bad',
        text: NOTICE.lost(clockTime(status.since)),
        action: {
          action: 'copy-command',
          label: LABELS.copyCommand,
          command: startCommand(status.env.port),
        },
      }
    case 'outdated':
      return {
        tone: 'warn',
        text: NOTICE.outdated,
        action: {
          action: 'copy-command',
          label: LABELS.copyCommand,
          command: downloadCommand(status.env.port),
        },
      }
    case 'newer':
      return { tone: 'warn', text: NOTICE.newer, action: reloadButton() }
    case 'foreign':
      return {
        tone: 'bad',
        text: NOTICE.foreign(port),
        action: { action: 'check', label: LABELS.openCheck },
      }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- *
 * Pair dialog and announcements
 * ---------------------------------------------------------------- */

const PAIRING = localized({
  en: {
    remember:
      'Keeps this browser paired while this helper keeps running. Leave it off on a shared Mac.',
    rememberKept:
      'Keeps this browser paired, even after the helper restarts (it runs with --keep-token). Leave it off on a shared Mac.',
    local:
      'This is the helper’s own page, so the pairing isn’t saved. It lasts while this tab stays open.',
    localKept:
      'This is the helper’s own page, so the pairing isn’t saved. Pair again after you reload it.',
  },
  vi: {
    remember:
      'Giữ ghép nối cho trình duyệt này khi helper này còn chạy. Trên máy Mac dùng chung, hãy để tắt.',
    rememberKept:
      'Giữ ghép nối cho trình duyệt này, kể cả sau khi helper khởi động lại (helper chạy với --keep-token). Trên máy Mac dùng chung, hãy để tắt.',
    local:
      'Đây là trang riêng của helper nên ghép nối không được lưu. Ghép nối còn hiệu lực khi thẻ này còn mở.',
    localKept:
      'Đây là trang riêng của helper nên ghép nối không được lưu. Hãy ghép nối lại sau khi tải lại trang.',
  },
})

/** The note under "Remember on this computer". */
export function rememberNote(tokenPersistent: boolean): string {
  return tokenPersistent ? PAIRING.rememberKept : PAIRING.remember
}

/**
 * The pair dialog's note on the helper's own page, which never remembers a pairing (its origin
 * is whatever listens on the port next): no switch, just how long the pairing lasts there.
 */
export function localPairingNote(tokenPersistent: boolean): string {
  return tokenPersistent ? PAIRING.localKept : PAIRING.local
}

const PAIR_ERRORS = localized({
  en: {
    format: 'That isn’t a helper token. Copy the whole line the helper printed.',
    stale: 'That token is from another helper run.',
    staleId: (tokenId: string) =>
      `That token is from another helper run. This helper’s fingerprint is ${tokenId}.`,
    foreign: (port: string) =>
      `Something on port ${port} answered but couldn’t prove it is your helper. Nothing was sent.`,
    unreachable: (port: string) => `The helper isn’t answering on 127.0.0.1:${port}.`,
    outdated: 'This helper is older than this page needs. Download it again, then pair.',
    newer: 'The helper is newer than this page. Reload the page, then pair.',
  },
  vi: {
    format: 'Đây không phải token của helper. Hãy sao chép nguyên dòng mà helper đã in ra.',
    stale: 'Token này thuộc một lần chạy khác của helper.',
    // "Vân tay", as Android names a key's fingerprint ("Vân tay khóa RSA"), across Device Lab.
    staleId: (tokenId: string) =>
      `Token này thuộc một lần chạy khác của helper. Vân tay của helper này là ${tokenId}.`,
    foreign: (port: string) =>
      `Một chương trình trên cổng ${port} có phản hồi nhưng không chứng minh được đó là helper của bạn. Chưa gửi gì cả.`,
    unreachable: (port: string) => `Helper không phản hồi tại 127.0.0.1:${port}.`,
    outdated: 'Helper này cũ hơn phiên bản trang này cần. Hãy tải lại tệp helper rồi ghép nối.',
    newer: 'Helper mới hơn trang này. Hãy tải lại trang rồi ghép nối.',
  },
})

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
      return PAIR_ERRORS.format
    case 'stale':
      return result.tokenId ? PAIR_ERRORS.staleId(result.tokenId) : PAIR_ERRORS.stale
    case 'foreign':
      return PAIR_ERRORS.foreign(port)
    case 'unreachable':
      return PAIR_ERRORS.unreachable(port)
    case 'outdated':
      return PAIR_ERRORS.outdated
    case 'newer':
      return PAIR_ERRORS.newer
  }
}

/**
 * How a look for the helper ended, said once it ends: the Connect button stays put while the
 * page looks, so without these a screen reader hears nothing of the answer.
 */
const OUTCOMES = localized({
  en: {
    absent: 'Local helper not found. Is it running?',
    dismissed: 'The browser’s prompt was closed. Connect again to see it.',
    denied: 'This browser blocked the local helper.',
    safari: 'Safari can’t reach the local helper from this page. Use the helper’s own page.',
    foreign: 'Another program answers on the helper’s port.',
    outdated: 'The local helper is outdated. Download it again.',
    newer: 'The local helper is newer than this page. Reload the page.',
    unpaired: 'The local helper is running. Pair this page.',
  },
  vi: {
    absent: 'Không tìm thấy helper cục bộ. Helper đã chạy chưa?',
    dismissed: 'Hộp thoại của trình duyệt đã bị đóng. Hãy kết nối lại để hộp thoại hiện ra.',
    denied: 'Trình duyệt này đã chặn helper cục bộ.',
    safari:
      'Safari không kết nối được với helper cục bộ từ trang này. Hãy dùng trang riêng của helper.',
    foreign: 'Một chương trình khác đang phản hồi trên cổng của helper.',
    outdated: 'Helper cục bộ đã cũ. Hãy tải lại tệp helper.',
    newer: 'Helper cục bộ mới hơn trang này. Hãy tải lại trang.',
    unpaired: 'Helper cục bộ đang chạy. Hãy ghép nối trang này.',
  },
})

const ANNOUNCEMENTS = localized({
  en: {
    connected: 'Local helper connected.',
    stopped: 'Local helper stopped.',
    restarted: 'The local helper restarted. Pair this page again.',
  },
  vi: {
    connected: 'Đã kết nối helper cục bộ.',
    stopped: 'Helper cục bộ đã dừng.',
    restarted: 'Helper cục bộ đã khởi động lại. Hãy ghép nối lại trang này.',
  },
})

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
  if (after === 'connected') return ANNOUNCEMENTS.connected
  if (before === 'connected' && after === 'lost') return ANNOUNCEMENTS.stopped
  if (after === 'stale' && (before === 'connected' || before === 'lost'))
    return ANNOUNCEMENTS.restarted
  if (intent && before === 'checking') {
    const outcomes: Partial<Record<HelperPhase, string>> = OUTCOMES
    return outcomes[after] ?? null
  }
  return null
}
