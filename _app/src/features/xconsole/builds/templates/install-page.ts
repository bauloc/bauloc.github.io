import { SITE_MESSAGES } from '@/components/messages'

import { formatBytes } from '../../format'
import { escapeHtml } from '../../term-privacy/templates/format'
import { ICON_FILE, binaryUrl, buildFileUrl, buildUrl, itmsUrl } from '../paths'
import type {
  AndroidFacts,
  AppleDevice,
  BuildEntry,
  IosFacts,
  ProfileInfo,
  ProfileKind,
} from '../types'
import { androidRelease } from './android-versions'
import { icon, platformMark, type IconName } from './icons'
import { INSTALL_CSS } from './install-css'
import { INSTALL_SCRIPT, INSTALL_SCRIPT_SHA256 } from './install-script'
import { INSTALL_COPY, both, say, type Pick } from './strings'

/*
  The install page at build/<id>/index.html: what a tester opens from the link they were sent.
  Written once, when the build is uploaded, and served as it is for as long as the build is up,
  so it depends on nothing — no app bundle, no font, no request to anywhere. A tester comes here
  to press one button, so the page leads with it: no site header above it (the owner's call),
  just the app, its version and a large Install button, or the QR code at a desk; the details
  follow. The language and theme switches sit in a small row at the very top, the only
  controls besides the button (no link leads anywhere else). The cards wear the console's look.

  Everything the entry holds is escaped where it lands (escapeHtml), and the addresses are built
  by paths.ts from the id and the file name, percent-encoded on the way in: an index edited by
  hand can break neither the markup nor out of the build's directory. The page's own resources
  (the binary, the icon) are root-relative, so the dev server's mock serves a working page too;
  the addresses that leave the page (the QR code, the iOS manifest, the link previews) are the
  live site's. A binary of 100 MiB or more is the exception: it is a GitHub Release's asset, not
  a file of the site, so both links to it (Install on Android, Download at a desk) take its
  absolute address on github.com. They keep `download` all the same; a browser ignores it for
  another site, and GitHub names the file itself (Content-Disposition).

  The page holds both languages and every case at once — each platform's note for each kind of
  browser — and its script, run before the first paint, sets the attributes on <html> that let
  the CSS show the ones that fit (install-script.ts, install-css.ts).
*/

const esc = escapeHtml

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An instant as <time datetime> carries it (normalised ISO 8601, UTC), or null for anything else. */
function isoTime(value: string): string | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/**
 * A <time> for an instant, or '' when `value` is none. Its text is UTC and says so: the script
 * rewrites it in the reader's own zone and language, and only a reader without scripts sees this.
 */
function timeTag(value: string, className = ''): string {
  const iso = isoTime(value)
  if (!iso) return ''
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  const date = `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()] ?? ''}-${String(d.getUTCFullYear())}`
  const text = `${date} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`
  return `<time datetime="${iso}"${className ? ` class="${className}"` : ''}>${text}</time>`
}

/** `1.2.0 (45)`; one number when the build repeats the version or either is missing. */
export function versionText(version: string, build: string): string {
  const v = version.trim()
  const b = build.trim()
  return v && b && b !== v ? `${v} (${b})` : v || b
}

/** ` data-label-en="…" data-label-vi="…"`: the script names the element in the reader's language. */
function labels(en: string, vi: string): string {
  return ` data-label-en="${esc(en)}" data-label-vi="${esc(vi)}"`
}

/** An element's accessible name and tooltip, English until the script words it. */
function named(en: string, vi: string): string {
  return ` title="${esc(en)}" aria-label="${esc(en)}"${labels(en, vi)}`
}

/* ---------------------------------------------------------------- *
 * The top row: EN·VI and the theme, the same choices the whole site shares
 * ---------------------------------------------------------------- */

/** The site header's own words, so these switches say exactly what the site's say. */
const BAR = SITE_MESSAGES

/**
 * The language and the theme, in a quiet row above the app, at the owner's request. They are all
 * that is left of the site's header: no section links, so a tester stays on the page; the language
 * and theme a visitor saved anywhere on the site apply here too.
 */
function pageTop(): string {
  const languages = [
    `<button type="button" lang="en" data-set-lang="en" title="English" aria-label="English" aria-pressed="true">EN</button>`,
    `<button type="button" lang="vi" data-set-lang="vi" title="Tiếng Việt" aria-label="Tiếng Việt" aria-pressed="false">VI</button>`,
  ].join('')
  const theme = [
    `title="${esc(BAR.en.darkMode)}" aria-label="${esc(BAR.en.darkMode)}"`,
    `data-dark-en="${esc(BAR.en.darkMode)}" data-dark-vi="${esc(BAR.vi.darkMode)}"`,
    `data-light-en="${esc(BAR.en.lightMode)}" data-light-vi="${esc(BAR.vi.lightMode)}"`,
  ].join(' ')
  return `<div class="top">
<div class="seg" role="group" aria-label="${esc(BAR.en.language)}"${labels(BAR.en.language, BAR.vi.language)}>${languages}</div>
<button type="button" class="top-button theme" data-theme-toggle ${theme}><span class="sun">${icon('sun')}</span><span class="moon">${icon('moon')}</span></button>
</div>`
}

/* ---------------------------------------------------------------- *
 * Pieces of the cards
 * ---------------------------------------------------------------- */

/** Copy `text`: a labelled button (`Copy link`), or an icon beside what it copies. */
function copyButton(text: string, label: Pick, iconOnly = false): string {
  const idle = `<span class="idle">${icon('copy')}${iconOnly ? '' : say(label)}</span>`
  const done = `<span class="done">${icon('check')}${iconOnly ? '' : say((t) => t.copied)}</span>`
  const data = `data-copy="${esc(text)}"`
  return iconOnly
    ? `<button type="button" class="icon-btn copy" ${data}${named(label(INSTALL_COPY.en), label(INSTALL_COPY.vi))}>${idle}${done}</button>`
    : `<button type="button" class="btn copy" ${data}>${idle}${done}</button>`
}

interface Note {
  /** Which case it is: the class the CSS shows it by (n-wrong, n-desktop…). */
  readonly kind: string
  readonly tone?: 'info' | 'warn' | 'bad'
  readonly icon: IconName
  readonly lead: string
  readonly detail?: string
  /** Buttons; also where a copy that failed shows the link to copy by hand (data-copy-host). */
  readonly actions?: string
}

/** One of the hero's notes: an icon, a lead line, what to do about it, and what to do it with. */
function note({ kind, tone, icon: mark, lead, detail, actions }: Note): string {
  const text = detail ? `<p class="lead">${lead}</p><p>${detail}</p>` : `<p>${lead}</p>`
  const buttons = actions ? `<div class="note-actions" data-copy-host>${actions}</div>` : ''
  return `<div class="note ${tone ? `${tone} ` : ''}${kind}">${icon(mark, 18)}<div>${text}${buttons}</div></div>`
}

/** One row of the details; a row with nothing to say is left out. */
function row(label: Pick, value: string): string {
  return value ? `<div><dt>${say(label)}</dt><dd>${value}</dd></div>` : ''
}

/** An identifier in monospace; it may wrap after any of its dots rather than anywhere in a word. */
function mono(text: string): string {
  return text ? `<span class="mono">${esc(text).replace(/\./g, '.<wbr>')}</span>` : ''
}

/** SHA-256 as the details show it: the first and last eight digits, the whole on copy. */
function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash
}

/** A count from the index, or null for anything that is not one. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

const DEVICE_NAMES: Readonly<Record<AppleDevice, string>> = { iphone: 'iPhone', ipad: 'iPad' }

/** Apple's names for the ways an IPA is signed, the same in both languages, as Xcode says them. */
const PROFILE_KINDS: Readonly<Record<ProfileKind, string | null>> = {
  development: 'Development',
  'ad-hoc': 'Ad Hoc',
  enterprise: 'Enterprise',
  'app-store': 'App Store',
  unknown: null,
}

/** Only these profiles name the devices that may install the build. */
const registers = (profile: ProfileInfo | null) =>
  profile?.kind === 'development' || profile?.kind === 'ad-hoc'

function androidFacts(android: AndroidFacts | null, minOs: string): string[] {
  const abis = (android?.abis ?? []).filter(Boolean)
  return [
    row((t) => t.requires, esc(androidRelease(minOs))),
    row((t) => t.target, android ? esc(androidRelease(android.target_sdk)) : ''),
    row(
      (t) => t.abis,
      abis.length > 0 ? mono(abis.join(', ')) : android ? say((t) => t.anyAbi) : '',
    ),
  ]
}

function iosFacts(ios: IosFacts | null, minOs: string, expires: string | null): string[] {
  const profile = ios?.profile ?? null
  const devices = (ios?.devices ?? [])
    .map((device) => (Object.hasOwn(DEVICE_NAMES, device) ? DEVICE_NAMES[device] : undefined))
    .filter((device): device is string => device !== undefined)
  const kind =
    profile && Object.hasOwn(PROFILE_KINDS, profile.kind) ? PROFILE_KINDS[profile.kind] : null
  const allowed = profile ? count(profile.device_count) : null
  const distribution = profile
    ? `${kind ?? say((t) => t.unknown)}${registers(profile) && allowed !== null ? ` · ${say((t) => t.deviceCount(allowed))}` : ''}`
    : ''
  const expiry = expires
    ? `${timeTag(expires, 'expires')}<span class="expired-tag">${say((t) => t.expiredTag)}</span>`
    : ''
  return [
    row((t) => t.requires, minOs.trim() ? `iOS ${esc(minOs.trim())}` : ''),
    row((t) => t.devices, esc(devices.join(', '))),
    row((t) => t.distribution, distribution),
    row((t) => t.team, esc(profile?.team.trim() ?? '')),
    row((t) => t.profileExpires, expiry),
  ]
}

/** How to install, in the steps the platform (and an IPA's profile) asks for. */
function steps(ios: boolean, profile: ProfileInfo | null): string {
  const picks: Pick[] = ios
    ? [(t) => t.iosSafari, (t) => t.iosTap, (t) => t.iosWait]
    : [
        (t) => t.androidTap,
        (t) => t.androidOpen,
        (t) => t.androidUnknownSources,
        (t) => t.androidConflict,
      ]
  if (profile?.kind === 'development') picks.push((t) => t.developerMode)
  if (profile?.kind === 'enterprise') picks.push((t) => t.trustTeam(esc(profile.team.trim())))
  if (registers(profile)) picks.push((t) => t.registeredOnly(count(profile?.device_count)))
  return `<ol class="steps">${picks.map((pick) => `<li>${say(pick)}</li>`).join('')}</ol>`
}

/* ---------------------------------------------------------------- *
 * The page
 * ---------------------------------------------------------------- */

/** The install page at build/<id>/index.html. */
export function installPageHtml(entry: BuildEntry, options: { qrSvg: string }): string {
  const ios = entry.platform === 'ios'
  const platform = ios ? 'ios' : 'android'
  // Encoding leaves a valid id and file name as they are (see paths.ts's patterns).
  const id = encodeURIComponent(entry.id)
  const link = buildUrl(id)
  // Root-relative in the repo; a release's asset is on github.com (binaryUrl encodes it too).
  const binary = binaryUrl(entry, '')
  const iconPath = entry.icon ? buildFileUrl(id, ICON_FILE, '') : ''

  const name = entry.name.trim() || entry.bundle_id.trim() || 'App'
  const version = versionText(entry.version, entry.build)
  const title = version ? `${name} ${version}` : name
  const sizeEn = formatBytes(entry.size, 'en')
  const size = both(esc(sizeEn), esc(formatBytes(entry.size, 'vi')))
  const uploaded = timeTag(entry.uploaded_at || entry.created_at)
  const profile = ios ? (entry.ios?.profile ?? null) : null
  const expires = profile ? isoTime(profile.expires) : null
  const notes = entry.notes.trim()
  const hash = entry.sha256.trim()
  /*
    The link's preview card in a chat app: the first words a tester reads, before the page is
    even open. Chat apps read it without running the script that picks a language, so it says
    both, as plain text — INSTALL_COPY's entries are markup.
  */
  const description = `${ios ? 'iOS' : 'Android'} build · ${sizeEn} · Open this link on your phone to install it · Mở link này trên điện thoại để cài đặt`

  /* The hero: whose build, which version, and the one button. */
  const appIcon = iconPath
    ? `<img src="${esc(iconPath)}" alt="" width="120" height="120">`
    : `<span class="initial" aria-hidden="true">${esc((Array.from(name)[0] ?? 'A').toUpperCase())}</span>`
  const badge = `<span class="badge ${platform}">${platformMark(platform)}${ios ? 'iOS' : 'Android'}</span>`
  const install = ios
    ? `<a class="install" href="${esc(itmsUrl(id))}">`
    : `<a class="install" href="${esc(binary)}" download="${esc(entry.file)}">`
  /*
    At a desk the button stays where the eye goes first (the owner's call). An APK simply
    downloads from it; an IPA cannot be installed on a computer, so there the button leads to the
    QR code just below and lights it up for the reader's iPhone (CSS shows this one only then).
  */
  const deskInstall = ios
    ? `<a class="install desk" href="#scan">${icon('download', 24)}${say((t) => t.install)}</a>`
    : ''
  const meta = [size, uploaded].filter(Boolean).join(' · ')
  const copyLink = copyButton(link, (t) => t.copyLink)
  const download = `<a class="btn" href="${esc(binary)}" download="${esc(entry.file)}">${icon('download')}${say((t) => t.download(ios ? 'ipa' : 'apk'))}</a>`

  const notesByCase = [
    expires
      ? note({
          kind: 'n-expired',
          tone: 'bad',
          icon: 'calendar-x',
          lead: say((t) => t.expired(timeTag(expires))),
        })
      : '',
    note({
      kind: 'n-wrong',
      tone: 'warn',
      icon: 'triangle-alert',
      lead: say((t) => (ios ? t.wrongIos : t.wrongAndroid)),
    }),
    ios
      ? note({
          kind: 'n-safari',
          tone: 'warn',
          icon: 'compass',
          lead: say((t) => t.safari),
          detail: say((t) => t.safariDetail),
          actions: copyLink,
        })
      : note({
          kind: 'n-chrome',
          tone: 'warn',
          icon: 'globe',
          lead: say((t) => t.chrome),
          detail: say((t) => t.chromeDetail),
          actions: copyLink,
        }),
    note({
      kind: 'n-after',
      tone: 'info',
      icon: 'circle-check',
      lead: say((t) => (ios ? t.afterIos : t.afterAndroid)),
    }),
  ].join('')

  /*
    The QR code, for a reader at a desk, in the Install button's place: it is the way to install
    from there. It is markup by nature, so only an SVG is let in.
  */
  const qrMarkup = /^<svg[\s>][\s\S]*<\/svg>$/.test(options.qrSvg) ? options.qrSvg : ''
  const scan = `<div class="scan" id="scan" data-copy-host>
${qrMarkup ? `<div class="qr-tile">${qrMarkup}</div>\n` : ''}<p class="scan-lead">${say((t) => (ios ? t.desktopIos : t.desktopAndroid))}</p>
<p class="qr-link"><code>${esc(link.replace(/^https:\/\//, ''))}</code></p>
<div class="scan-actions">${copyLink}${download}</div>
<p class="meta">${meta}</p>
</div>`

  /* The hero: whose build, which version, and the one button — the reason the page exists. */
  const hero = `<section class="hero" aria-labelledby="app-name">
<div class="app-icon">${appIcon}</div>
<h1 id="app-name">${esc(name)}</h1>
<div class="app-sub">${badge}${version ? `<span>${say((t) => t.version(esc(version)))}</span>` : ''}</div>
<div class="actions">${install}${icon('download', 24)}${say((t) => t.install)}</a>${deskInstall}<p class="meta">${meta}</p></div>
${scan}
${notesByCase}
</section>`

  const releaseNotes = notes
    ? `<section class="card" aria-labelledby="notes-title">
<h2 id="notes-title">${icon('file-text')}${say((t) => t.releaseNotes)}</h2>
<p class="release">${esc(notes)}</p>
</section>
`
    : ''

  const facts = [
    row(ios ? (t) => t.bundleId : (t) => t.package, mono(entry.bundle_id.trim())),
    row((t) => t.versionLabel, esc(entry.version.trim())),
    row((t) => t.build, esc(entry.build.trim())),
    ...(ios
      ? iosFacts(entry.ios, entry.min_os, expires)
      : androidFacts(entry.android, entry.min_os)),
    row((t) => t.size, size),
    row(
      (t) => t.sha256,
      hash
        ? `<span class="with-copy">${mono(shortHash(hash))}${copyButton(hash, (t) => t.copyHash, true)}</span>`
        : '',
    ),
    row((t) => t.uploaded, uploaded),
  ]
  const details = `<section class="card" data-copy-host aria-labelledby="details-title">
<h2 id="details-title">${icon('info')}${say((t) => t.details)}</h2>
<dl class="facts">${facts.join('')}</dl>
</section>`

  const howTo = `<section class="card" aria-labelledby="howto-title">
<h2 id="howto-title">${icon('list-ordered')}${say((t) => t.howTo)}</h2>
${steps(ios, profile)}
</section>`

  const csp = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${INSTALL_SCRIPT_SHA256}'; base-uri 'none'; form-action 'none'`
  // icon.png is drawn at 256 px (inspect/icon.ts); chat apps size their preview card by it.
  const ogImage = entry.icon ? buildFileUrl(id, ICON_FILE) : ''
  const icons = iconPath
    ? `<link rel="icon" type="image/png" href="${esc(iconPath)}">\n<link rel="apple-touch-icon" href="${esc(iconPath)}">\n`
    : ''

  return `<!DOCTYPE html>
<html lang="en" data-platform="${platform}"${expires ? ` data-expires="${expires}"` : ''}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" data-light="#ffffff" data-dark="#0a0a0a">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(link)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="bauloc.github.io">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(link)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta property="og:image:width" content="256">\n<meta property="og:image:height" content="256">\n<meta property="og:image:alt" content="${esc(name)}">\n` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">\n` : ''}
${icons}<style>${INSTALL_CSS}</style>
<script>${INSTALL_SCRIPT}</script>
</head>
<body>
${pageTop()}
<main class="page">
${hero}
<div class="cards">
${releaseNotes}${howTo}
${details}
</div>
</main>
<p id="status" class="sr-only" role="status" data-en="${esc(INSTALL_COPY.en.copied)}" data-vi="${esc(INSTALL_COPY.vi.copied)}"></p>
</body>
</html>
`
}
