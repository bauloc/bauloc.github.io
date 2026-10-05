import { CheckCircle2, ChevronDown, Info, Loader2, PackagePlus, RotateCcw, X } from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { defineMessages, localized, useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'
import { useHeldWhileClosing } from '@/lib/use-held-while-closing'

import {
  deviceErrorMessage,
  isFileChangedFailure,
  isLocalFailure,
  phoneFactsOf,
  type DeviceSpec,
  type InstallFacts,
  type InstallOptions,
} from '../backends/backend'
import type { InstallFailure, InstallOutcome } from '../backends/android/pm-output'
import type { BadgeIcon, IconImage } from '../backends/archive/apk-badge'
import type {
  InstallPart,
  InstallPlan,
  PhoneCheck,
  PlanIssue,
  PlanIssueCode,
} from '../backends/archive/plan'
import { featureChecks } from '../preflight/checks'
import { COPY, STATUS_META } from '../preflight/copy'
import { isStaleBuildError } from '../preflight/env'
import type { CheckItem, Feature, InstallPhone } from '../preflight/types'
import {
  fmtBytes,
  installErrorWording,
  type Device,
  type InstallErrorAction,
  type InstallErrorWording,
} from '../model'
import {
  Command,
  FixButton,
  InlineChecklist,
  PathFix,
  StatusWord,
  splitFixes,
  type FixWiring,
} from './checklist'
import type { Job } from '../store'
import { ProgressBar, fmtTransfer, percentOf } from './jobs-strip'
import { TONE_SURFACE } from './status'

/*
  Install an app on one phone (PLAN §4.1–4.3): whatever was dropped or picked is read here,
  in the browser, into an install plan; the phone's own checks join it; nothing is sent until
  Install. Then the bytes stream into one install session, with Cancel until Android starts
  committing, and the outcome is said in plain words with the way forward.

  The archive code (zip, toc, matchers, manifest readers) loads on the first install, never
  with the page. The dialog never talks to the phone itself: the page hands it `actions`, and
  `install` runs as a job in the store, which owns its progress, its Cancel and its
  announcements. Closing the dialog mid-send leaves the job in the jobs strip, where it can
  still be cancelled; the dialog follows it through the `job` prop.
*/

const INSTALL_MESSAGES = defineMessages({
  en: {
    gate: {
      blocked: 'Fix what’s marked Blocking above first.',
      notReady: (device: string) => `${device} isn’t ready. Reconnect it to install.`,
      busy: (device: string) => `Another install is running on ${device}. Wait for it to finish.`,
      installAnyway: 'Turn on “Install anyway” to install an app that targets an old Android.',
      allowDowngrade:
        'Turn on “Allow downgrade” under Options to put the older version over the newer one.',
      uninstallWontHelp:
        'Uninstalling wouldn’t help yet: something else marked Blocking above stops the install. Fix that first.',
    },
    theApp: 'the app',
    apks: (parts: number) => `${String(parts)} APKs`,
    apksForPhone: (parts: number, offered: number) =>
      `${String(parts)} of ${String(offered)} APKs for this phone`,
    part: {
      of: (module: string) => ` of ${module}`,
      base: 'The app itself',
      feature: (module: string) => `Module ${module}, installed with the app`,
      assetPack: (module: string) => `Asset pack ${module}, installed with the app`,
      abi: (abi: string, of: string) => `Native code for ${abi}${of}`,
      density: (dpi: string, of: string) => `Graphics for ${dpi} dpi screens${of}`,
      language: (language: string, of: string) => `Language ${language}${of}`,
      other: (value: string, of: string) => `For ${value}${of}`,
      unnamed: (of: string) => `Part${of}`,
    },
    sendingTo: (device: string) => `Sending to ${device}`,
    installedOn: (app: string, version: string, device: string) =>
      `Installed ${app}${version ? ` ${version}` : ''} on ${device}.`,
    retry: 'Retry',
    noAnswer: 'The install ended without an answer from the phone. Check the Apps tab.',
    theFile: 'the file',
    files: (count: number) => `${String(count)} files`,

    openFailed: (pkg: string) => `Android couldn’t open ${pkg}`,
    installedWithWarnings: 'Installed, with warnings.',
    open: 'Open',
    installFailedOn: (app: string, device: string) => `Couldn’t install ${app} on ${device}`,
    show: 'Show',
    notUninstalled: (pkg: string) => `Didn’t uninstall ${pkg}`,
    uninstallFailed: (pkg: string) => `Couldn’t uninstall ${pkg}`,
    nothingInstalledAfter: (message: string) => `${message} Nothing was installed.`,
    copiedDetails: 'Copied the details',
    copyFailed: 'Copy failed',
    copyByHand: 'Select the text and copy it by hand.',
    dropUnreadable: 'Couldn’t read what was dropped',
    dropUnreadableHint: 'Pick the files with Install app instead.',

    title: (device: string) => `Install on ${device}`,
    description: 'The file is read on this computer. Nothing is sent until you press Install.',
    issueTitle: { blocking: 'Can’t install this yet', warning: 'Before you install' },
    details: 'Details',
    copyOutput: 'Copy the phone’s output',
    whyThese: 'Why these?',
    installAnyway: 'Install anyway',
    uninstallFirst: 'Uninstall and install…',
    close: 'Close',
    done: 'Done',
    backToInstall: 'Back to install',
    next: (files: string) => `Next: ${files}. It’s read once this install ends.`,
    reading: (files: string, device: string) => `Reading ${files} and ${device}’s details…`,
    unreadable: 'Couldn’t get ready to install',
    reload: 'Reload',
    tryAgain: 'Try again',
    options: 'Options',
    grant: 'Grant all runtime permissions',
    grantHint:
      'The app won’t ask for the camera, location and the like. Leave it off to test those prompts.',
    allowDowngrade: 'Allow downgrade',
    allowDowngradeHint:
      'The installed copy is debuggable, so Android lets an older version replace it and keeps its data.',
    install: 'Install',
    uninstallingFrom: (pkg: string, device: string) => `Uninstalling ${pkg} from ${device}…`,
    uninstalling: (pkg: string) => `Uninstalling ${pkg}`,
    installing: 'Installing on the phone…',
    installingBar: 'Installing on the phone',
    stillInstalling:
      'Still installing. Check the phone: it may be asking you to confirm (Play Protect).',
    keepsRunning:
      'Closing this window doesn’t stop the install: its progress and Cancel stay on the page.',
    cancelInstall: 'Cancel install',
    cancelled: 'Cancelled. Nothing was installed.',
    nothingInstalled: 'Nothing was installed.',
    installedWithWarningsList: 'Installed, with warnings:',
    openApp: 'Open app',
    installFailed: (app: string) => `Couldn’t install ${app}`,
    pickAgain: 'Pick again…',
    notReadyFirst: (device: string) => `${device} isn’t ready. Reconnect it first.`,
    replaceTitle: (app: string, device: string) => `Replace ${app} on ${device}?`,
    replaceSigned:
      'The installed copy is signed with a different key (for example from Google Play), so Android can’t update it. Device Lab will uninstall it, which deletes its data on the phone, and then install this build.',
    replaceNewer:
      'A newer version is installed, and Android won’t put an older one over it. Device Lab will uninstall it, which deletes its data on the phone, and then install this build.',
    uninstallOtherTitle: (pkg: string, device: string) => `Uninstall ${pkg} from ${device}?`,
    uninstallOtherBody: (app: string) =>
      `This removes the app and all of its data on the phone: accounts, settings and files. It can’t be undone. Device Lab then installs ${app}.`,
    cancel: 'Cancel',
    uninstallAndInstall: 'Uninstall and install',
    dropToInstall: (device: string) => `Drop to install on ${device}`,
    installApp: 'Install app',
  },
  vi: {
    gate: {
      blocked: 'Hãy xử lý trước các mục Đang chặn ở trên.',
      notReady: (device: string) => `${device} chưa sẵn sàng. Hãy kết nối lại để cài.`,
      busy: (device: string) => `${device} đang có một lượt cài khác. Hãy đợi lượt đó xong.`,
      installAnyway: 'Bật “Vẫn cài” để cài ứng dụng nhắm tới Android cũ.',
      allowDowngrade:
        'Bật “Cho phép hạ cấp” trong Tùy chọn để cài phiên bản cũ đè lên bản mới hơn.',
      uninstallWontHelp:
        'Gỡ cài đặt lúc này chưa giúp được gì: vẫn còn mục Đang chặn khác ở trên ngăn việc cài. Hãy xử lý mục đó trước.',
    },
    theApp: 'ứng dụng',
    apks: (parts: number) => `${String(parts)} APK`,
    apksForPhone: (parts: number, offered: number) =>
      `${String(parts)}/${String(offered)} APK cho điện thoại này`,
    part: {
      of: (module: string) => ` của ${module}`,
      base: 'Phần chính của ứng dụng',
      feature: (module: string) => `Mô-đun ${module}, cài cùng ứng dụng`,
      assetPack: (module: string) => `Gói tài nguyên ${module}, cài cùng ứng dụng`,
      abi: (abi: string, of: string) => `Mã native cho ${abi}${of}`,
      density: (dpi: string, of: string) => `Đồ họa cho màn hình ${dpi} dpi${of}`,
      language: (language: string, of: string) => `Ngôn ngữ ${language}${of}`,
      other: (value: string, of: string) => `Dành cho ${value}${of}`,
      unnamed: (of: string) => `Thành phần${of}`,
    },
    sendingTo: (device: string) => `Đang gửi tới ${device}`,
    installedOn: (app: string, version: string, device: string) =>
      `Đã cài ${app}${version ? ` ${version}` : ''} lên ${device}.`,
    retry: 'Thử lại',
    noAnswer: 'Lượt cài đã kết thúc mà điện thoại không trả lời. Hãy xem thẻ Ứng dụng.',
    theFile: 'tệp',
    files: (count: number) => `${String(count)} tệp`,

    openFailed: (pkg: string) => `Android không mở được ${pkg}`,
    installedWithWarnings: 'Đã cài, có cảnh báo.',
    open: 'Mở',
    installFailedOn: (app: string, device: string) => `Không cài được ${app} lên ${device}`,
    show: 'Xem',
    notUninstalled: (pkg: string) => `Chưa gỡ cài đặt ${pkg}`,
    uninstallFailed: (pkg: string) => `Không gỡ cài đặt được ${pkg}`,
    nothingInstalledAfter: (message: string) => `${message} Chưa cài gì cả.`,
    copiedDetails: 'Đã sao chép chi tiết',
    copyFailed: 'Không sao chép được',
    copyByHand: 'Hãy bôi đen đoạn chữ và tự sao chép.',
    dropUnreadable: 'Không đọc được nội dung vừa thả',
    dropUnreadableHint: 'Hãy chọn tệp bằng nút Cài ứng dụng.',

    title: (device: string) => `Cài đặt lên ${device}`,
    description: 'Tệp được đọc ngay trên máy tính này. Chưa gửi gì cho đến khi bạn bấm Cài đặt.',
    issueTitle: { blocking: 'Chưa cài được', warning: 'Trước khi cài' },
    details: 'Chi tiết',
    copyOutput: 'Sao chép đầu ra của điện thoại',
    whyThese: 'Vì sao chọn các APK này?',
    installAnyway: 'Vẫn cài',
    uninstallFirst: 'Gỡ cài đặt rồi cài…',
    close: 'Đóng',
    done: 'Xong',
    backToInstall: 'Quay lại bước cài đặt',
    next: (files: string) => `Tiếp theo: ${files}. Sẽ được đọc khi lượt cài này kết thúc.`,
    reading: (files: string, device: string) => `Đang đọc ${files} và thông tin của ${device}…`,
    unreadable: 'Không thể chuẩn bị cài đặt',
    reload: 'Tải lại',
    tryAgain: 'Thử lại',
    options: 'Tùy chọn',
    grant: 'Cấp mọi quyền khi chạy',
    grantHint:
      'Ứng dụng sẽ không hỏi quyền máy ảnh, vị trí và các quyền tương tự. Hãy để tắt nếu cần thử các hộp thoại xin quyền đó.',
    allowDowngrade: 'Cho phép hạ cấp',
    allowDowngradeHint:
      'Bản đã cài có thể gỡ lỗi, nên Android cho phiên bản cũ hơn thay thế và vẫn giữ dữ liệu của nó.',
    install: 'Cài đặt',
    uninstallingFrom: (pkg: string, device: string) => `Đang gỡ cài đặt ${pkg} khỏi ${device}…`,
    uninstalling: (pkg: string) => `Đang gỡ cài đặt ${pkg}`,
    installing: 'Đang cài trên điện thoại…',
    installingBar: 'Đang cài trên điện thoại',
    stillInstalling:
      'Vẫn đang cài. Hãy xem điện thoại: có thể máy đang hỏi bạn xác nhận (Play Protect).',
    keepsRunning:
      'Đóng cửa sổ này không làm dừng việc cài: tiến độ và nút Hủy vẫn hiện trên trang.',
    cancelInstall: 'Hủy cài đặt',
    cancelled: 'Đã hủy. Chưa cài gì cả.',
    nothingInstalled: 'Chưa cài gì cả.',
    installedWithWarningsList: 'Đã cài, có cảnh báo:',
    openApp: 'Mở ứng dụng',
    installFailed: (app: string) => `Không cài được ${app}`,
    pickAgain: 'Chọn lại…',
    notReadyFirst: (device: string) => `${device} chưa sẵn sàng. Hãy kết nối lại trước.`,
    replaceTitle: (app: string, device: string) => `Thay thế ${app} trên ${device}?`,
    replaceSigned:
      'Bản đã cài được ký bằng khóa khác (ví dụ bản từ Google Play), nên Android không cập nhật được. Device Lab sẽ gỡ cài đặt bản đó (việc này xóa dữ liệu của nó trên điện thoại) rồi cài bản dựng này.',
    replaceNewer:
      'Điện thoại đang có phiên bản mới hơn và Android không cho cài bản cũ hơn đè lên. Device Lab sẽ gỡ cài đặt bản đó (việc này xóa dữ liệu của nó trên điện thoại) rồi cài bản dựng này.',
    uninstallOtherTitle: (pkg: string, device: string) => `Gỡ cài đặt ${pkg} khỏi ${device}?`,
    uninstallOtherBody: (app: string) =>
      `Thao tác này xóa ứng dụng đó cùng toàn bộ dữ liệu của nó trên điện thoại: tài khoản, chế độ cài đặt và tệp. Không thể hoàn tác. Sau đó Device Lab sẽ cài ${app}.`,
    cancel: 'Hủy',
    uninstallAndInstall: 'Gỡ cài đặt rồi cài',
    dropToInstall: (device: string) => `Thả để cài lên ${device}`,
    installApp: 'Cài ứng dụng',
  },
})

/**
 * The same words for what is worded outside a render: the wording functions below, and the
 * toasts once an install or a read ends, in the language on screen by then.
 */
const INSTALL_WORDS = localized(INSTALL_MESSAGES)

/** The picker's filter. Files are recognised by content; this only narrows the list. */
export const INSTALL_ACCEPT = '.apk,.apks,.xapk,.apkm,.aab,.zip'

/** What the dialog needs from the page: the selected phone's operations, bound to it. */
export interface InstallActions {
  /** The phone as bundletool would describe it, for picking splits. */
  readonly deviceSpec: () => Promise<DeviceSpec>
  /** Free space, the installed copy and Play Protect's setting. Rejecting only skips those checks. */
  readonly installFacts: (packageName: string | null) => Promise<InstallFacts>
  /**
   * Starts the install as a store job (lab.install) and resolves with the job once it ended:
   * done or failed with Android's outcome, or cancelled. Rejects when it couldn't start.
   */
  readonly install: (plan: InstallPlan, options: InstallOptions) => Promise<InstallResult>
  /** Rejects with the failure's wording. */
  readonly openApp: (packageName: string) => Promise<void>
  /** Rejects with the failure's wording. */
  readonly uninstall: (packageName: string) => Promise<void>
}

/** The store's install job, as far as the dialog follows it. */
export type InstallJob = Pick<Job, 'id' | 'phase' | 'sent' | 'total' | 'phaseSince' | 'cancel'>

/** How a job ended. */
export type InstallResult = Pick<Job, 'phase' | 'outcome'>

/** A job still sending or installing; one per device. */
export const isRunningJob = (job: Pick<Job, 'phase'> | null | undefined): boolean =>
  job?.phase === 'sending' || job?.phase === 'installing'

/* ---------------------------------------------------------------- *
 * Reading the plan
 * ---------------------------------------------------------------- */

/** Which preflight rows apply: the container decides, an encrypted .apkm counts as an .apkm. */
export function featureOf(plan: InstallPlan): Feature {
  if (plan.kind === 'aab') return 'aab'
  if (plan.kind === 'apkm' || plan.inputs.some((i) => i.kind === 'apkm-encrypted')) return 'apkm'
  if (plan.kind === 'xapk') return 'xapk'
  return 'install'
}

/** Plan issues a preflight row already says, in the same words or with more help. */
const COVERED: ReadonlySet<PlanIssueCode> = new Set([
  'AAB_NEEDS_HELPER',
  'APKM_ENCRYPTED',
  'UNZIP_UNSUPPORTED',
])

/** A problem or warning from the plan or the phone's checks, as the dialog lists it. */
export interface IssueRow {
  readonly key: string
  readonly status: 'blocking' | 'warning'
  readonly sentence: string
  readonly action?: PlanIssue['action']
}

/** The plan's and the phone's problems, then their warnings; notes are listed apart. */
export function issueRows(plan: InstallPlan, phone: PhoneCheck | null): IssueRow[] {
  const rows = (status: IssueRow['status'], issues: readonly PlanIssue[]) =>
    issues
      .filter((issue) => !COVERED.has(issue.code))
      .map((issue, i): IssueRow => ({
        key: `${status}-${issue.code}-${String(i)}`,
        status,
        sentence: issue.message,
        ...(issue.action ? { action: issue.action } : {}),
      }))
  return [
    ...rows('blocking', [...plan.problems, ...(phone?.problems ?? [])]),
    ...rows('warning', [...plan.warnings, ...(phone?.warnings ?? [])]),
  ]
}

/** What the tester agreed to: each one adds a flag. */
export interface Consent {
  /** `--bypass-low-target-sdk-block`, for an old targetSdk. */
  readonly bypass: boolean
  /** `-d`, offered only when the installed copy is debuggable. */
  readonly downgrade: boolean
  /** `-g`. Off by default: it hides the permission prompts a tester may be testing. */
  readonly grant: boolean
}

export const NO_CONSENT: Consent = { bypass: false, downgrade: false, grant: false }

/** Why Install is held, before it is worded: code compares these, never the sentences. */
type GateReason = 'not-ready' | 'busy' | 'blocked' | 'install-anyway' | 'allow-downgrade'

function gateReason(
  plan: InstallPlan,
  checks: readonly CheckItem[],
  issues: readonly IssueRow[],
  consent: Consent,
  phone: { readonly ready: boolean; readonly busy: boolean },
): GateReason | null {
  if (!phone.ready) return 'not-ready'
  if (phone.busy) return 'busy'
  const blocked =
    checks.some((c) => c.status === 'blocking') || issues.some((i) => i.status === 'blocking')
  if (blocked || plan.parts.length === 0) return 'blocked'
  if (issues.some((r) => r.action === 'install-anyway') && !consent.bypass) {
    return 'install-anyway'
  }
  if (issues.some((r) => r.action === 'allow-downgrade') && !consent.downgrade) {
    return 'allow-downgrade'
  }
  return null
}

function gateSentence(reason: GateReason | null, deviceName: string): string | null {
  const words = INSTALL_WORDS.gate
  switch (reason) {
    case null:
      return null
    case 'not-ready':
      return words.notReady(deviceName)
    case 'busy':
      return words.busy(deviceName)
    case 'blocked':
      return words.blocked
    case 'install-anyway':
      return words.installAnyway
    case 'allow-downgrade':
      return words.allowDowngrade
  }
}

/**
 * Whether Install may run, and the sentence when it may not. A warning whose way past is a
 * consent (Install anyway, Allow downgrade) holds the button until it is given: Android would
 * refuse without it, after the whole app had been sent.
 */
export function installGate(
  plan: InstallPlan,
  checks: readonly CheckItem[],
  issues: readonly IssueRow[],
  consent: Consent,
  phone: { readonly deviceName: string; readonly ready: boolean; readonly busy: boolean },
): string | null {
  return gateSentence(gateReason(plan, checks, issues, consent, phone), phone.deviceName)
}

/**
 * Whether "Uninstall and install" may run, and the sentence when it may not. Uninstalling
 * deletes the app's data on the phone, so it is only worth it when the installed copy is the
 * one thing in the way: anything else still Blocking (no APK for this CPU, too old an Android,
 * installs over USB turned off…) would make the install fail after the data was gone.
 */
export function uninstallFirstGate(
  plan: InstallPlan,
  checks: readonly CheckItem[],
  issues: readonly IssueRow[],
  consent: Consent,
  phone: { readonly deviceName: string; readonly ready: boolean; readonly busy: boolean },
): string | null {
  // The rows uninstalling clears are left out; every other reason Install is shut still holds.
  const others = issues.filter((r) => r.action !== 'uninstall-first')
  const reason = gateReason(plan, checks, others, consent, phone)
  return reason === 'blocked'
    ? INSTALL_WORDS.gate.uninstallWontHelp
    : gateSentence(reason, phone.deviceName)
}

/** The flags for this install; `-t` follows the plan, in the lane. */
export function installOptions(consent: Consent): InstallOptions {
  return {
    grantPermissions: consent.grant,
    allowDowngrade: consent.downgrade,
    bypassLowTargetSdkBlock: consent.bypass,
  }
}

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

const versionText = (name: string, code: number) =>
  name ? `${name} (${String(code)})` : String(code)

/** "1.4.0 (812)"; empty when the plan has no app. */
export function appVersion(plan: InstallPlan): string {
  return plan.app ? versionText(plan.app.versionName, plan.app.versionCode) : ''
}

/** What the dialog calls the app: its label, its package name, or the file. */
export function appName(plan: InstallPlan): string {
  return plan.app?.label ?? plan.app?.packageName ?? plan.inputs[0]?.name ?? INSTALL_WORDS.theApp
}

/** "3 of 9 APKs for this phone · arm64-v8a · xxhdpi · en, vi"; null for a single APK. */
export function selectionLine(plan: InstallPlan): string | null {
  const s = plan.selection
  if (!s) return plan.parts.length > 1 ? INSTALL_WORDS.apks(plan.parts.length) : null
  const facets = [s.abi, s.density, s.languages.join(', ')].filter(Boolean)
  return [INSTALL_WORDS.apksForPhone(plan.parts.length, s.offered), ...facets].join(' · ')
}

/** Why a part was picked, for "Why these?". */
export function partReason(part: Pick<InstallPart, 'role'>): string {
  const { module, kind, value } = part.role
  const words = INSTALL_WORDS.part
  const of = module === 'base' ? '' : words.of(module)
  switch (kind) {
    case 'base':
      return words.base
    case 'feature':
      return words.feature(module)
    case 'asset-pack':
      return words.assetPack(module)
    case 'abi':
      return words.abi(value, of)
    case 'density':
      return words.density(value, of)
    case 'language':
      return words.language(value, of)
    case 'other':
      return value ? words.other(value, of) : words.unnamed(of)
  }
}

/** "34 MB/s". */
export function fmtRate(bytesPerSecond: number): string {
  return `${fmtBytes(Math.round(bytesPerSecond))}/s`
}

/** "Sending to Pixel 9 · 21.5 of 34.7 MB · 62% · 28 MB/s". */
export function sendingText(
  deviceName: string,
  sent: number,
  total: number,
  rate: number | null,
): string {
  const parts = [INSTALL_WORDS.sendingTo(deviceName)]
  if (total > 0) parts.push(fmtTransfer(sent, total), `${String(percentOf(sent, total))}%`)
  if (rate !== null && rate > 0) parts.push(fmtRate(rate))
  return parts.join(' · ')
}

/** What a successful install says: "Installed Probe 1.4.0 (812) on Pixel 9." */
export function successTitle(plan: InstallPlan, deviceName: string): string {
  return INSTALL_WORDS.installedOn(appName(plan), appVersion(plan), deviceName)
}

/** What the wording knows besides the failure itself. */
export interface FailureContext {
  readonly plan: InstallPlan
  readonly spec: Pick<DeviceSpec, 'sdkVersion' | 'supportedAbis'> | null
  readonly facts: Pick<InstallFacts, 'installed'> | null
}

/**
 * INSTALL_ERRORS' wording for a refusal, with the values Android didn't print filled in from
 * what the file and the phone said. Android's own values win.
 */
export function failureWording(failure: InstallFailure, ctx: FailureContext): InstallErrorWording {
  const app = ctx.plan.app
  const installed = ctx.facts?.installed ?? null
  const params: Record<string, string> = {
    ...(app
      ? {
          fileVersionCode: versionText(app.versionName, app.versionCode),
          requiredSdk: String(app.minSdk),
          targetSdk: String(app.targetSdk),
        }
      : {}),
    ...(installed
      ? { installedVersionCode: versionText(installed.versionName, installed.versionCode) }
      : {}),
    ...(ctx.spec ? { deviceSdk: String(ctx.spec.sdkVersion) } : {}),
    ...failure.params,
  }
  // A file that changed or moved since it was picked: Retry would send the same stale File, so
  // the way past is picking it again, which the dialog offers beside this wording.
  if (isFileChangedFailure(failure)) {
    return { text: failure.message, advice: null, action: null, fixes: [] }
  }
  // Not Android's refusal but the browser's (a phone that stopped answering, say): its own words.
  if (isLocalFailure(failure)) {
    return {
      text: failure.message,
      advice: null,
      action: { kind: 'retry', label: INSTALL_WORDS.retry },
      fixes: [],
    }
  }
  return installErrorWording(
    { ...failure, params },
    { abis: ctx.spec?.supportedAbis ?? [], debuggable: installed?.debuggable ?? false },
  )
}

/**
 * A failure that came from the browser side rather than from pm. Its sentence is worded at each
 * read, so an outcome left on screen follows a language switch.
 */
const localFailure = (word: () => string): InstallFailure => ({
  ok: false,
  code: 'UNKNOWN',
  androidCode: null,
  get message() {
    return word()
  },
  params: {},
  output: '',
})

/** A refusal's Details: Android's code and message, then everything it printed. */
export function detailsText(failure: InstallFailure): string {
  const head = failure.androidCode ? `${failure.androidCode}: ${failure.message}` : failure.message
  return [head, failure.output]
    .map((t) => t.trim())
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .join('\n\n')
}

/* ---------------------------------------------------------------- *
 * Icons
 * ---------------------------------------------------------------- */

/** A data: URL rather than a blob URL: nothing to revoke, so nothing leaks or breaks on remount. */
export function imageUrl(image: IconImage): string {
  let binary = ''
  for (let i = 0; i < image.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000))
  }
  return `data:${image.mime};base64,${btoa(binary)}`
}

/** 0xAARRGGBB → `rgb(r g b / a)`, built at runtime: no colour literals in the source. */
export function argbCss(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255
  const r = (argb >>> 16) & 0xff
  const g = (argb >>> 8) & 0xff
  const b = argb & 0xff
  return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(Math.round(a * 1000) / 1000)})`
}

/** The initials avatar's text: the label's first letter, or the package's last segment's. */
export function initialOf(name: string): string {
  const word = name.includes('.') && !name.includes(' ') ? (name.split('.').pop() ?? name) : name
  return (word.trim()[0] ?? '?').toUpperCase()
}

/**
 * The app's icon as the launcher shows it. An adaptive icon's layers are 108 dp squares of
 * which the launcher shows the middle 72: both are drawn at 150% and clipped.
 */
function AppIcon({ icon, name }: { icon: BadgeIcon | null; name: string }) {
  const layers = useMemo(() => {
    if (!icon) return null
    if (icon.kind === 'bitmap') return { fg: imageUrl(icon), bg: null, color: null }
    const bg = icon.background
    return {
      fg: imageUrl(icon.foreground),
      bg: bg && 'bytes' in bg ? imageUrl(bg) : null,
      color: bg && 'argb' in bg ? argbCss(bg.argb) : null,
    }
  }, [icon])
  const box = 'relative size-12 shrink-0 overflow-hidden rounded-xl border'
  if (!layers) {
    return (
      <div
        aria-hidden="true"
        className={cn(box, 'bg-muted text-muted-foreground grid place-items-center text-lg')}
      >
        {initialOf(name)}
      </div>
    )
  }
  if (icon?.kind === 'bitmap') {
    return <img src={layers.fg} alt="" className={cn(box, 'bg-muted/40 object-contain')} />
  }
  const layer = 'absolute -inset-1/4 size-[150%] max-w-none'
  return (
    <div
      aria-hidden="true"
      className={cn(box, 'bg-muted')}
      style={layers.color ? { backgroundColor: layers.color } : undefined}
    >
      {layers.bg && <img src={layers.bg} alt="" className={layer} />}
      <img src={layers.fg} alt="" className={layer} />
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * Pieces
 * ---------------------------------------------------------------- */

/**
 * What the file and the phone say about this install, in the inline card's look: tinted by
 * the worst row, whose status the heading carries. A row of another status (a warning under
 * Blocking) says so above its sentence. `extra` adds a row's control, such as its Install
 * anyway switch.
 */
function IssuesCard({
  id,
  issues,
  extra,
}: {
  id: string
  issues: readonly IssueRow[]
  extra: (row: IssueRow) => ReactNode
}) {
  const t = useMessages(INSTALL_MESSAGES)
  if (issues.length === 0) return null
  const status = issues.some((i) => i.status === 'blocking') ? 'blocking' : 'warning'
  const headingId = `${id}-title`
  return (
    <div
      id={id}
      role="note"
      aria-labelledby={headingId}
      className={cn('rounded-xl border p-4', TONE_SURFACE[STATUS_META[status].tone])}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="font-semibold">
          {t.issueTitle[status]}
        </h3>
        <StatusWord status={status} />
      </div>
      <ul className="mt-3 space-y-3">
        {issues.map((issue) => (
          <li key={issue.key} className="space-y-2">
            {issue.status !== status && <StatusWord status={issue.status} className="h-5" />}
            <p className="text-muted-foreground text-sm leading-5">{issue.sentence}</p>
            {extra(issue)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Notes({ notes }: { notes: readonly PlanIssue[] }) {
  if (notes.length === 0) return null
  return (
    <ul className="text-muted-foreground space-y-1 text-xs leading-relaxed">
      {notes.map((note, i) => (
        <li key={`${note.code}-${String(i)}`} className="flex gap-2">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {note.message}
        </li>
      ))}
    </ul>
  )
}

/** Everything the phone printed, copyable for a ticket. */
function Details({ text }: { text: string }) {
  const t = useMessages(INSTALL_MESSAGES)
  if (!text.trim()) return null
  return (
    <details className="group text-sm">
      <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
        {t.details}
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="bg-muted/60 mt-2 flex items-start gap-2 rounded-lg border p-2">
        <pre className="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
        <CopyButton text={text} label={t.copyOutput} />
      </div>
    </details>
  )
}

/** Step 1: what the file is, read locally. */
function AppSummary({ plan }: { plan: InstallPlan }) {
  const t = useMessages(INSTALL_MESSAGES)
  const name = appName(plan)
  const line = selectionLine(plan)
  const size = plan.totalBytes || plan.inputs.reduce((n, i) => n + i.size, 0)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <AppIcon icon={plan.app?.icon ?? null} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-muted-foreground truncate text-xs">
            {[appVersion(plan), plan.app?.label ? plan.app.packageName : '', fmtBytes(size)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {line && <p className="text-muted-foreground truncate text-xs">{line}</p>}
        </div>
      </div>
      {plan.parts.length > 1 && (
        <details className="group text-sm">
          <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
            {t.whyThese}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {plan.parts.map((part) => (
              <li key={part.name} className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-1.5 text-xs">
                <span className="truncate font-mono" title={part.source}>
                  {part.source}
                </span>
                <span className="text-muted-foreground tabular-nums">{fmtBytes(part.size)}</span>
                <span className="text-muted-foreground col-span-2">{partReason(part)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* A single file is the header's name already (appName), so it isn't listed again. */}
      {!plan.app && plan.inputs.length > 1 && (
        <ul className="text-muted-foreground text-xs">
          {plan.inputs.map((input, i) => (
            <li key={`${input.name}-${String(i)}`} className="truncate">
              {input.name} · {fmtBytes(input.size)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>}
      </div>
    </div>
  )
}

/** A panel in the tone of how it went: the outcome, the removal that failed. */
function Outcome({
  tone,
  title,
  children,
  alert = false,
}: {
  tone: 'ok' | 'bad'
  title: ReactNode
  children?: ReactNode
  alert?: boolean
}) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      className={cn('space-y-2 rounded-xl border p-4 text-sm', TONE_SURFACE[tone])}
    >
      <p className="flex items-center gap-2 font-medium">{title}</p>
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * The dialog
 * ---------------------------------------------------------------- */

interface Prepared {
  readonly plan: InstallPlan
  readonly spec: DeviceSpec
  readonly facts: InstallFacts | null
  readonly check: PhoneCheck | null
  readonly inflate: boolean
}

/** A failed step keeps its error, not a sentence: it is worded when shown, in the language then. */
type Stage =
  | { readonly step: 'reading' }
  | { readonly step: 'unreadable'; readonly error: unknown; readonly stale: boolean }
  | { readonly step: 'review' }
  | { readonly step: 'removing'; readonly pkg: string }
  /** The store's job runs it; the `job` prop says how far it got. */
  | { readonly step: 'running'; readonly slow: boolean }
  | { readonly step: 'done'; readonly outcome: InstallOutcome }
  | { readonly step: 'remove-failed'; readonly pkg: string; readonly error: unknown }
  | { readonly step: 'cancelled' }

interface Session {
  readonly files: readonly File[] | null
  /** Bumped by Try again after a failed read, to read the files once more. */
  readonly attempt: number
  readonly prepared: Prepared | null
  readonly stage: Stage
  readonly consent: Consent
  /** Android refused with INSTALL_FAILED_USER_RESTRICTED: the OEM row turns Blocking. */
  readonly userRestricted: boolean
}

const freshSession = (files: readonly File[] | null): Session => ({
  files,
  attempt: 0,
  prepared: null,
  stage: { step: 'reading' },
  consent: NO_CONSENT,
  userRestricted: false,
})

/**
 * Reads the files into a plan for this phone, then the phone's side of the checks. The archive
 * code loads here, on the first install. Rejects only when the phone or the build fails it.
 */
async function preparePlan(files: readonly File[], actions: InstallActions): Promise<Prepared> {
  const [{ planInstall, checkPhone }, { canInflate }] = await Promise.all([
    import('../backends/archive/plan'),
    import('../backends/archive/zip'),
  ])
  const spec = await actions.deviceSpec()
  const plan = await planInstall(files, spec)
  const facts = await actions
    .installFacts(plan.kind === 'aab' ? null : (plan.app?.packageName ?? null))
    .catch(() => null)
  const phoneFacts = facts ? phoneFactsOf(facts) : null
  const check = plan.app && phoneFacts ? checkPhone(plan, phoneFacts) : null
  return { plan, spec, facts, check, inflate: canInflate() }
}

const RUNNING: ReadonlySet<Stage['step']> = new Set(['removing', 'running'])

/** "probe.apk", or "3 files". */
const filesText = (list: readonly File[] | null) =>
  list?.length === 1
    ? (list[0]?.name ?? INSTALL_WORDS.theFile)
    : INSTALL_WORDS.files(list?.length ?? 0)

/** Android may sit on a Play Protect prompt; after this long the dialog says to look. */
export const SLOW_COMMIT_MS = 10_000
/** How often the speed is worked out again while sending. */
const RATE_MS = 500

type Confirm =
  | { readonly kind: 'replace'; readonly reason: 'signature' | 'downgrade' }
  | { readonly kind: 'uninstall-other'; readonly pkg: string }

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

export interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: Pick<Device, 'id' | 'name'>
  /** What connect read off the phone (model.installPhoneOf), for the preflight rows. */
  phone: InstallPhone | null
  /** The device is Ready. Install waits for it. */
  ready: boolean
  /**
   * The device's latest install job from the store (running, or ended and not dismissed).
   * While this dialog's own install runs it is that job; otherwise a running one holds Install.
   */
  job: InstallJob | null
  /** What was dropped or picked. A new array starts over, unless an install is running. */
  files: readonly File[] | null
  actions: InstallActions
  /** The checklist's own buttons (Reload, Check again…), as the page wires them. */
  wiring?: FixWiring
}

/** "Install on Pixel 9": read, check, send, install, and say how it went. */
export function InstallDialog({
  open,
  onOpenChange,
  device,
  phone,
  ready,
  job,
  files,
  actions,
  wiring,
}: InstallDialogProps) {
  const t = useMessages(INSTALL_MESSAGES)
  const locale = useLocale()
  const [session, setSession] = useState<Session>(() => freshSession(files))
  const [seen, setSeen] = useState(files)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  // What the confirmation fades out with; its action reads the live `confirm`.
  const shownConfirm = useHeldWhileClosing(confirm !== null, confirm)
  const [clock, setClock] = useState(0)
  const openRef = useRef(open)
  /** Files arrived while the install ran: the dialog moves on to them once it ends. */
  const waitingRef = useRef(false)
  const ids = useId()
  const checksId = `${ids}-checks`
  const issuesId = `${ids}-issues`
  const gateId = `${ids}-gate`
  const replaceId = `${ids}-replace`

  // New files start a new session, but never under a running install, whose outcome is still
  // to come: they wait, unread, until it ends. Adjusted while rendering, as React recommends
  // over an effect.
  const running = RUNNING.has(session.stage.step)
  if (files !== seen && !running) {
    setSeen(files)
    setSession(freshSession(files))
  }
  const waiting = running && files !== seen && files && files.length > 0 ? files : null

  useEffect(() => {
    openRef.current = open
    // Unmounted (its phone unplugged and dropped from the list) counts as closed, so an install
    // still in flight says how it ended in a toast.
    return () => {
      openRef.current = false
    }
  }, [open])

  useEffect(() => {
    waitingRef.current = waiting !== null
  }, [waiting])

  const setStage = (stage: Stage) => {
    setSession((s) => ({ ...s, stage }))
  }

  // The latest actions, without restarting the read when the page passes new ones.
  const readPlan = useEffectEvent((list: readonly File[]) => preparePlan(list, actions))

  useEffect(() => {
    const list = session.files
    if (!list || list.length === 0) return
    // A reply for files since replaced, or for an unmounted dialog, is dropped.
    let live = true
    readPlan(list).then(
      (ready) => {
        if (live) setSession((s) => ({ ...s, prepared: ready, stage: { step: 'review' } }))
      },
      (error: unknown) => {
        if (!live) return
        const stale = isStaleBuildError(error)
        setSession((s) => ({ ...s, stage: { step: 'unreadable', stale, error } }))
      },
    )
    return () => {
      live = false
    }
  }, [session.files, session.attempt])

  const ours = session.stage.step === 'running'
  const live = ours && isRunningJob(job) ? job : null

  // The speed needs the time, which a render may not read: a clock ticks while sending.
  const sending = live?.phase === 'sending'
  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => {
      setClock(Date.now())
    }, RATE_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [sending])

  // Android can't be hurried, but after a while the tester should look at the phone.
  const installing = live?.phase === 'installing'
  useEffect(() => {
    if (!installing) return
    const timer = window.setTimeout(() => {
      setSession((s) =>
        s.stage.step === 'running' ? { ...s, stage: { step: 'running', slow: true } } : s,
      )
    }, SLOW_COMMIT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [installing])

  const { prepared, stage, consent } = session
  const busy = !ours && isRunningJob(job)
  const plan = prepared?.plan ?? null
  const name = plan ? appName(plan) : t.theApp
  const pkg = plan?.app?.packageName ?? null

  const checks = useMemo(() => {
    if (!prepared) return []
    const { plan, facts, inflate } = prepared
    return featureChecks(featureOf(plan), {
      phone,
      verifyAdbInstalls: facts?.verifyAdbInstalls ?? null,
      userRestricted: session.userRestricted,
      inflate,
      ...(plan.inputs.some((i) => i.kind === 'apkm-encrypted') ? { apkmEncrypted: true } : {}),
      fileName: plan.inputs.find((i) => i.kind === 'aab')?.name,
      probe: null,
      doctor: null,
    })
    // The rows are worded in the language on screen: a switch words them again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared, phone, session.userRestricted, locale])
  const issues = useMemo(
    () => (prepared ? issueRows(prepared.plan, prepared.check) : []),
    // The plan words its issues at each read, in the language on screen: a switch reads them again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepared, locale],
  )
  const notes = prepared ? [...prepared.plan.notes, ...(prepared.check?.notes ?? [])] : []
  const phoneState = { deviceName: device.name, ready, busy }
  const gate = plan ? installGate(plan, checks, issues, consent, phoneState) : null
  const replaceGate = plan
    ? uninstallFirstGate(plan, checks, issues, consent, phoneState)
    : t.gate.blocked
  const downgradeOffered = issues.some((r) => r.action === 'allow-downgrade')
  const describedBy = [
    checks.some((c) => c.status !== 'ok') ? checksId : '',
    issues.length > 0 ? issuesId : '',
    gate ? gateId : '',
  ]
    .filter(Boolean)
    .join(' ')

  const openApp = (packageName: string) => {
    actions.openApp(packageName).catch((error: unknown) => {
      toast.error(INSTALL_WORDS.openFailed(packageName), {
        description: deviceErrorMessage(error),
      })
    })
  }

  const wordingOf = (failure: InstallFailure, current: Prepared) =>
    failureWording(failure, { plan: current.plan, spec: current.spec, facts: current.facts })

  /**
   * Whether the dialog won't show how this install ended, so a toast must: it is closed (the
   * install ran in the background), or files are waiting and it moves straight on to them.
   */
  const unseen = () => !openRef.current || waitingRef.current

  const finish = (outcome: InstallOutcome, current: Prepared) => {
    setSession((s) => ({
      ...s,
      stage: { step: 'done', outcome },
      userRestricted: s.userRestricted || (!outcome.ok && outcome.code === 'USER_RESTRICTED'),
    }))
    if (outcome.ok) {
      const title = successTitle(current.plan, device.name)
      const packageName = current.plan.app?.packageName
      if (unseen()) {
        toast.success(title, {
          ...(outcome.warnings.length > 0
            ? { description: INSTALL_WORDS.installedWithWarnings }
            : {}),
          ...(packageName
            ? {
                action: {
                  label: INSTALL_WORDS.open,
                  onClick: () => {
                    openApp(packageName)
                  },
                },
              }
            : {}),
        })
      }
      return
    }
    const { text } = wordingOf(outcome, current)
    const appLabel = appName(current.plan)
    if (unseen()) {
      // Show reopens the dialog on this outcome, unless it has moved on to the waiting files.
      const movedOn = waitingRef.current
      toast.error(INSTALL_WORDS.installFailedOn(appLabel, device.name), {
        description: text,
        ...(movedOn
          ? {}
          : {
              action: {
                label: INSTALL_WORDS.show,
                onClick: () => {
                  onOpenChange(true)
                },
              },
            }),
      })
    }
  }

  /**
   * Sends the plan, after uninstalling `remove` first when asked to. The store announces the
   * job's phases and its end; the dialog shows them.
   */
  const run = async (overrides: Partial<Consent> = {}, remove?: string) => {
    const current = prepared
    if (!current || RUNNING.has(stage.step)) return
    const agreed = { ...consent, ...overrides }

    if (remove) {
      // Checked again here, whatever button led here: uninstalling deletes the app's data, and
      // must not happen when the install would fail anyway.
      const why = uninstallFirstGate(current.plan, checks, issues, agreed, phoneState)
      if (why !== null) {
        toast.error(INSTALL_WORDS.notUninstalled(remove), { description: why })
        return
      }
    }
    setSession((s) => ({ ...s, consent: agreed }))

    if (remove) {
      setStage({ step: 'removing', pkg: remove })
      try {
        await actions.uninstall(remove)
      } catch (error) {
        setStage({ step: 'remove-failed', pkg: remove, error })
        if (unseen()) {
          toast.error(INSTALL_WORDS.uninstallFailed(remove), {
            description: INSTALL_WORDS.nothingInstalledAfter(deviceErrorMessage(error)),
          })
        }
        return
      }
    }

    setStage({ step: 'running', slow: false })
    try {
      const result = await actions.install(current.plan, installOptions(agreed))
      if (result.phase === 'cancelled') setStage({ step: 'cancelled' })
      else finish(result.outcome ?? localFailure(() => INSTALL_WORDS.noAnswer), current)
    } catch (error) {
      finish(
        localFailure(() => deviceErrorMessage(error)),
        current,
      )
    }
  }

  const copyDetails = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(INSTALL_WORDS.copiedDetails),
      () =>
        toast.error(INSTALL_WORDS.copyFailed, {
          description: INSTALL_WORDS.copyByHand,
        }),
    )
  }

  /** The button under a refusal, by what INSTALL_ERRORS says gets past it. */
  const remedy = (failure: InstallFailure, kind: InstallErrorAction, details: string) => {
    switch (kind) {
      case 'uninstall-and-install':
        setConfirm({
          kind: 'replace',
          reason: failure.code === 'UPDATE_INCOMPATIBLE' ? 'signature' : 'downgrade',
        })
        return
      case 'uninstall-other': {
        const other = failure.params.other ?? ''
        if (PACKAGE.test(other)) setConfirm({ kind: 'uninstall-other', pkg: other })
        return
      }
      case 'allow-downgrade':
        void run({ downgrade: true })
        return
      case 'install-anyway':
        void run({ bypass: true })
        return
      case 'retry':
        void run()
        return
      case 'copy-details':
        copyDetails(details)
    }
  }

  const issueControl = (row: IssueRow): ReactNode => {
    if (row.action === 'install-anyway') {
      return (
        <div className="pl-[6.25rem]">
          <Toggle
            id={`${ids}-bypass`}
            label={t.installAnyway}
            checked={consent.bypass}
            onChange={(bypass) => {
              setSession((s) => ({ ...s, consent: { ...s.consent, bypass } }))
            }}
          />
        </div>
      )
    }
    if (row.action === 'uninstall-first' && pkg) {
      // The phone's own reasons (not ready, busy) are already said under the cards.
      const own = replaceGate !== null && replaceGate !== gate
      const describedBy = replaceGate === null ? undefined : own ? replaceId : gateId
      return (
        <div className="space-y-1 pl-[6.25rem]">
          <Button
            size="sm"
            variant="outline"
            aria-disabled={replaceGate !== null || undefined}
            aria-describedby={describedBy}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (replaceGate === null) setConfirm({ kind: 'replace', reason: 'downgrade' })
            }}
          >
            {t.uninstallFirst}
          </Button>
          {own && (
            <p id={replaceId} className="text-muted-foreground text-xs">
              {replaceGate}
            </p>
          )}
        </div>
      )
    }
    return null
  }

  /* ---- what each stage shows ---- */

  let body: ReactNode = null
  let footer: ReactNode = null
  const closeButton = (label = t.close) => (
    <Button
      variant="outline"
      onClick={() => {
        onOpenChange(false)
      }}
    >
      {label}
    </Button>
  )
  const backButton = (
    <Button
      onClick={() => {
        setStage({ step: 'review' })
      }}
    >
      {t.backToInstall}
    </Button>
  )

  /** Said under a running install when files arrived meanwhile, so they don't seem lost. */
  const waitingLine = waiting && (
    <p role="status" className="text-muted-foreground text-xs">
      {t.next(filesText(waiting))}
    </p>
  )

  if (stage.step === 'reading') {
    const what = filesText(session.files)
    body = (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
        {t.reading(what, device.name)}
      </p>
    )
    footer = closeButton()
  } else if (stage.step === 'unreadable') {
    body = (
      <Outcome tone="bad" title={t.unreadable} alert>
        <p className="text-muted-foreground">
          {stage.stale ? COPY.app.updated : deviceErrorMessage(stage.error)}
        </p>
      </Outcome>
    )
    footer = (
      <>
        {closeButton()}
        {stage.stale ? (
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            {t.reload}
          </Button>
        ) : (
          <Button
            onClick={() => {
              setSession((s) => ({ ...s, attempt: s.attempt + 1, stage: { step: 'reading' } }))
            }}
          >
            <RotateCcw /> {t.tryAgain}
          </Button>
        )}
      </>
    )
  } else if (plan && prepared) {
    const summary = <AppSummary plan={plan} />
    switch (stage.step) {
      case 'review':
        body = (
          <>
            {summary}
            <InlineChecklist id={checksId} items={checks} wiring={wiring} />
            <IssuesCard id={issuesId} issues={issues} extra={issueControl} />
            <Notes notes={notes} />
            {plan.parts.length > 0 && (
              <details className="group text-sm" open={downgradeOffered || undefined}>
                <summary className="text-primary flex cursor-pointer list-none items-center gap-1 font-medium">
                  {t.options}
                  <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-3 space-y-3">
                  <Toggle
                    id={`${ids}-grant`}
                    label={t.grant}
                    hint={t.grantHint}
                    checked={consent.grant}
                    onChange={(grant) => {
                      setSession((s) => ({ ...s, consent: { ...s.consent, grant } }))
                    }}
                  />
                  {downgradeOffered && (
                    <Toggle
                      id={`${ids}-downgrade`}
                      label={t.allowDowngrade}
                      hint={t.allowDowngradeHint}
                      checked={consent.downgrade}
                      onChange={(downgrade) => {
                        setSession((s) => ({ ...s, consent: { ...s.consent, downgrade } }))
                      }}
                    />
                  )}
                </div>
              </details>
            )}
            {gate && (
              <p id={gateId} className="text-muted-foreground text-xs">
                {gate}
              </p>
            )}
          </>
        )
        footer = (
          <>
            {closeButton()}
            {/* aria-disabled, not disabled: it stays focusable and the cards say why. */}
            <Button
              aria-disabled={gate !== null || undefined}
              aria-describedby={describedBy || undefined}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (gate === null) void run()
              }}
            >
              <PackagePlus /> {t.install}
            </Button>
          </>
        )
        break

      case 'removing':
        body = (
          <>
            {summary}
            <div role="status" className="space-y-2">
              <p className="text-sm">{t.uninstallingFrom(stage.pkg, device.name)}</p>
              <ProgressBar label={t.uninstalling(stage.pkg)} />
            </div>
            {waitingLine}
          </>
        )
        footer = closeButton()
        break

      case 'running': {
        if (live?.phase === 'installing') {
          body = (
            <>
              {summary}
              <div className="space-y-2">
                <p className="text-sm">{t.installing}</p>
                <ProgressBar label={t.installingBar} />
                {stage.slow && (
                  <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
                    {t.stillInstalling}
                  </p>
                )}
              </div>
              {waitingLine}
            </>
          )
          footer = closeButton()
          break
        }
        const sent = live?.sent ?? 0
        const total = live?.total ?? plan.totalBytes
        const elapsed = live ? (clock - live.phaseSince) / 1000 : 0
        const text = sendingText(device.name, sent, total, elapsed >= 0.5 ? sent / elapsed : null)
        const cancel = live?.cancel
        body = (
          <>
            {summary}
            <div className="space-y-2">
              <p className="text-sm tabular-nums">{text}</p>
              <ProgressBar label={t.sendingTo(device.name)} value={sent} max={total} />
              <p className="text-muted-foreground text-xs">{t.keepsRunning}</p>
            </div>
            {waitingLine}
          </>
        )
        footer = (
          <>
            {closeButton()}
            {cancel && (
              <Button variant="outline" onClick={cancel}>
                <X /> {t.cancelInstall}
              </Button>
            )}
          </>
        )
        break
      }

      case 'cancelled':
        body = (
          <>
            {summary}
            <p className="text-sm">{t.cancelled}</p>
          </>
        )
        footer = (
          <>
            {closeButton()}
            {backButton}
          </>
        )
        break

      case 'remove-failed':
        body = (
          <>
            {summary}
            <Outcome tone="bad" title={t.uninstallFailed(stage.pkg)} alert>
              <p className="text-muted-foreground">{deviceErrorMessage(stage.error)}</p>
              <p className="text-muted-foreground">{t.nothingInstalled}</p>
            </Outcome>
          </>
        )
        footer = (
          <>
            {closeButton()}
            {backButton}
          </>
        )
        break

      case 'done': {
        const outcome = stage.outcome
        if (outcome.ok) {
          body = (
            <>
              {summary}
              <Outcome
                tone="ok"
                title={
                  <>
                    <CheckCircle2 aria-hidden="true" className="text-success size-4 shrink-0" />
                    {successTitle(plan, device.name)}
                  </>
                }
              >
                {outcome.warnings.length > 0 && (
                  <>
                    <p>{t.installedWithWarningsList}</p>
                    <ul className="text-muted-foreground list-disc space-y-0.5 pl-5">
                      {outcome.warnings.map((w, i) => (
                        <li key={`${String(i)}-${w}`}>{w}</li>
                      ))}
                    </ul>
                  </>
                )}
              </Outcome>
              {outcome.warnings.length > 0 && <Details text={outcome.output} />}
            </>
          )
          footer = (
            <>
              {closeButton(t.done)}
              {pkg && (
                <Button
                  onClick={() => {
                    openApp(pkg)
                  }}
                >
                  {t.openApp}
                </Button>
              )}
            </>
          )
          break
        }
        const wording = wordingOf(outcome, prepared)
        const details = detailsText(outcome)
        const { commands, paths, buttons } = splitFixes(wording.fixes)
        const action = wording.action
        body = (
          <>
            {summary}
            <Outcome tone="bad" title={t.installFailed(name)} alert>
              <p className="text-muted-foreground leading-relaxed">{wording.text}</p>
              {wording.advice && <p className="leading-relaxed">{wording.advice}</p>}
              {commands.map((fix) => (
                <Command key={fix.copy} text={fix.copy} label={fix.label} />
              ))}
              {paths.map((fix) => (
                <PathFix key={fix.label + fix.path} fix={fix} />
              ))}
              {buttons.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {buttons.map((fix) => (
                    <FixButton key={fix.label} fix={fix} wiring={wiring} />
                  ))}
                </div>
              )}
            </Outcome>
            <Details text={details} />
          </>
        )
        // Copying needs no phone; everything else does.
        const needsPhone = action !== null && action.kind !== 'copy-details'
        const held = needsPhone && (!ready || busy)
        footer = (
          <>
            {closeButton()}
            {isFileChangedFailure(outcome) && (
              <InstallButton
                label={t.pickAgain}
                onFiles={(picked) => {
                  setSession(freshSession(picked))
                }}
              />
            )}
            {action && (
              <Button
                aria-disabled={held || undefined}
                title={held ? t.notReadyFirst(device.name) : undefined}
                className="aria-disabled:opacity-50"
                onClick={() => {
                  if (!held) remedy(outcome, action.kind, details)
                }}
              >
                {action.label}
              </Button>
            )}
          </>
        )
        break
      }
    }
  }

  const copyOf = (c: Confirm | null) =>
    c === null
      ? null
      : c.kind === 'replace'
        ? {
            title: t.replaceTitle(name, device.name),
            body: c.reason === 'signature' ? t.replaceSigned : t.replaceNewer,
            remove: pkg,
          }
        : {
            title: t.uninstallOtherTitle(c.pkg, device.name),
            body: t.uninstallOtherBody(name),
            remove: c.pkg,
          }
  const confirmCopy = copyOf(confirm)
  const shownCopy = copyOf(shownConfirm)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t.title(device.name)}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-4">{body}</div>
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmCopy !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{shownCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{shownCopy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const remove = confirmCopy?.remove
                if (remove) void run({}, remove)
              }}
            >
              {t.uninstallAndInstall}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* ---------------------------------------------------------------- *
 * Entry points: the button and the page-level drop target
 * ---------------------------------------------------------------- */

const MAX_DROPPED = 200
const MAX_DEPTH = 4

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    // readEntries hands over a batch at a time (100 in Chrome) until it returns none.
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject)
  })

async function walk(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (out.length >= MAX_DROPPED || entry.name.startsWith('.')) return
  if (entry.isFile) {
    out.push(await fileOf(entry as FileSystemFileEntry))
    return
  }
  if (!entry.isDirectory || depth >= MAX_DEPTH) return
  for (const child of await readEntries(entry as FileSystemDirectoryEntry)) {
    await walk(child, depth + 1, out)
  }
}

/**
 * The files of a drop, with dropped folders opened: "a folder of APKs" is one app. The items
 * are taken synchronously, as the drop event requires; hidden files are skipped.
 */
export function filesFromDrop(data: DataTransfer): Promise<File[]> {
  const items = Array.from(data.items ?? [])
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
  const plain = Array.from(data.files)
  if (entries.length === 0 || entries.some((e) => e === null)) return Promise.resolve(plain)
  return (async () => {
    const out: File[] = []
    for (const entry of entries) if (entry) await walk(entry, 0, out)
    return out
  })()
}

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

/**
 * Wraps the detail column: dragging files over it shows "Drop to install on Pixel 9", and a
 * drop hands the files (folders opened) to `onFiles`. When installing isn't possible the drop
 * is still caught, so the browser doesn't navigate away to the file, and `onRefused` says why.
 */
export function InstallDropZone({
  enabled,
  deviceName,
  onFiles,
  onRefused,
  className,
  children,
}: {
  enabled: boolean
  deviceName: string
  onFiles: (files: File[]) => void
  onRefused?: () => void
  className?: string
  children: ReactNode
}) {
  const t = useMessages(INSTALL_MESSAGES)
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        depth.current++
        if (enabled) setOver(true)
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (!enabled) {
          onRefused?.()
          return
        }
        filesFromDrop(e.dataTransfer).then(
          (files) => {
            if (files.length > 0) onFiles(files)
          },
          () => {
            toast.error(INSTALL_WORDS.dropUnreadable, {
              description: INSTALL_WORDS.dropUnreadableHint,
            })
          },
        )
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden="true"
          className="bg-background/90 text-muted-foreground border-primary/50 pointer-events-none absolute inset-0 z-20 rounded-xl border-2 border-dashed text-sm backdrop-blur-sm"
        >
          {/* Sticky, so on a zone taller than the window the words stay in view. */}
          <div className="sticky top-1/2 flex -translate-y-1/2 flex-col items-center py-16">
            <PackagePlus className="mb-2 size-7 opacity-60" />
            {t.dropToInstall(deviceName)}
          </div>
        </div>
      )}
    </div>
  )
}

/** "Install app": opens the file picker (several files at once) and hands the pick on. */
export function InstallButton({
  disabled = false,
  title,
  label,
  onFiles,
}: {
  disabled?: boolean
  title?: string
  /** "Install app" when left out. */
  label?: string
  onFiles: (files: File[]) => void
}) {
  const t = useMessages(INSTALL_MESSAGES)
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        title={title}
        onClick={() => {
          input.current?.click()
        }}
      >
        <PackagePlus /> {label ?? t.installApp}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={INSTALL_ACCEPT}
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          // Cleared, so picking the same file again still fires change.
          e.target.value = ''
          if (picked.length > 0) onFiles(picked)
        }}
      />
    </>
  )
}
