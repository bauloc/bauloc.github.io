/*
  The install page's stylesheet, inlined into every page: the console's look (the shadcn palette
  in hex, radius 10–16 px, hairline borders and soft shadows), written for the browsers testers
  actually have: no oklch, no color-mix and no :is() or :has(), which old Android WebViews and
  in-app browsers do not understand.

  The page leads with one thing for each reader, and the attributes the script sets on <html>
  pick it (install-script.ts):
    - the build's own platform (data-platform = data-device): the large Install button;
    - the other platform's phone: no button — a warning saying which phone the build is for, and
      the QR code and link to carry it there;
    - a desk (data-device=desktop): the QR code in the button's place;
    - an expired profile (.expired): no button, and why.
  `lang` shows only the matching half of every `.en`/`.vi` pair; `.dark` is the theme; `.tapped`
  shows what happens next. Without the script none of them is set: the page reads in English, in
  light, with both the Install button and the QR code, and no note.
*/

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
const SANS =
  'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif'

/** The other platform's phone: the build cannot be installed on it. */
const WRONG = [
  'html[data-platform=ios][data-device=android]',
  'html[data-platform=android][data-device=ios]',
]
/** Where the QR code leads: a desk, the wrong phone, or a page whose script never ran. */
const WITH_QR = ['html[data-device=desktop]', 'html:not([data-device])', ...WRONG]
/** Where there is no Install button: the wrong phone, an expired profile. */
const NO_BUTTON = [...WRONG, 'html.expired']
const under = (roots: readonly string[], selector: string) =>
  roots.map((root) => `${root} ${selector}`).join(',')

export const INSTALL_CSS = `
:root{--bg:#ffffff;--card:#ffffff;--fg:#0a0a0a;--muted-fg:#737373;--border:#e5e5e5;--muted:#f5f5f5;--soft:#fafafa;--primary:#4f46e5;--primary-hover:#4338ca;--on-primary:#ffffff;--ring:rgba(79,70,229,.4);--glow:rgba(79,70,229,.5);--halo:rgba(79,70,229,.09);--install:#16a34a;--install-hover:#15803d;--install-glow:rgba(22,163,74,.5);--install-ring:rgba(34,197,94,.55);--success:#059669;--destructive:#dc2626;--android:#047857;--android-bg:rgba(16,185,129,.1);--ios:#0369a1;--ios-bg:rgba(14,165,233,.1);--info:#3730a3;--info-bg:#eef2ff;--info-line:#c7d2fe;--warn:#92400e;--warn-bg:#fffbeb;--warn-line:#fde68a;--bad:#991b1b;--bad-bg:#fef2f2;--bad-line:#fecaca;--note-detail:#404040;--shadow:0 1px 2px rgba(0,0,0,.05);color-scheme:light}
html.dark{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted-fg:#a3a3a3;--border:rgba(255,255,255,.1);--muted:#262626;--soft:#1f1f1f;--primary:#6366f1;--primary-hover:#4f46e5;--ring:rgba(129,140,248,.5);--glow:rgba(99,102,241,.45);--halo:rgba(99,102,241,.16);--install:#16a34a;--install-hover:#15803d;--install-glow:rgba(34,197,94,.4);--install-ring:rgba(74,222,128,.5);--success:#34d399;--destructive:#f87171;--android:#6ee7b7;--android-bg:rgba(16,185,129,.14);--ios:#7dd3fc;--ios-bg:rgba(14,165,233,.14);--info:#c7d2fe;--info-bg:rgba(99,102,241,.14);--info-line:rgba(129,140,248,.3);--warn:#fcd34d;--warn-bg:rgba(245,158,11,.1);--warn-line:rgba(245,158,11,.28);--bad:#fca5a5;--bad-bg:rgba(239,68,68,.1);--bad-line:rgba(248,113,113,.3);--note-detail:#d4d4d4;--shadow:0 1px 2px rgba(0,0,0,.5);color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;background:radial-gradient(900px 420px at 50% -160px,var(--halo),transparent 70%) no-repeat,var(--bg);color:var(--fg);font-family:${SANS};font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
html:not([lang=vi]) .vi,html[lang=vi] .en{display:none!important}
a{color:inherit}
b{font-weight:600}
code,.mono{font-family:${MONO}}
svg{flex:none}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.offscreen{position:fixed;top:0;left:-9999px;font-size:16px;opacity:0}

.top{display:flex;align-items:center;justify-content:flex-end;gap:8px;max-width:600px;margin:0 auto;padding:12px 16px 0}
.page{max-width:600px;margin:0 auto;padding:16px 16px 48px}

.hero{display:flex;flex-direction:column;align-items:center;text-align:center}
.app-icon{position:relative;flex:none;width:104px;height:104px;overflow:hidden;border-radius:23%;background:var(--muted);box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.12)}
.app-icon::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
html.dark .app-icon::after{box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.app-icon img{display:block;width:100%;height:100%}
.initial{display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:linear-gradient(140deg,#818cf8 0%,#4f46e5 55%,#4338ca 100%);color:#ffffff;font-size:44px;font-weight:600}
.hero h1{max-width:100%;margin:20px 0 0;font-size:27px;font-weight:700;line-height:1.2;letter-spacing:-.02em;word-break:break-word;overflow-wrap:anywhere}
.app-sub{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 10px;margin-top:10px;color:var(--muted-fg);font-size:15px;line-height:22px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:12.5px;font-weight:500;line-height:18px;white-space:nowrap}
.badge.android{background:var(--android-bg);color:var(--android)}
.badge.ios{background:var(--ios-bg);color:var(--ios)}

.actions{display:flex;flex-direction:column;align-items:stretch;gap:12px;width:100%;max-width:400px;margin-top:30px}
/*
  The one button, in green — the colour of an install button everywhere testers have seen one —
  large enough to find without looking for it, and ringed by a pulse three times as the page opens.
*/
.install{position:relative;display:flex;align-items:center;justify-content:center;gap:12px;min-height:66px;padding:0 32px;border-radius:18px;background:var(--install);color:#ffffff;font-size:23px;font-weight:700;letter-spacing:.01em;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.14),0 16px 36px -12px var(--install-glow),inset 0 1px 0 rgba(255,255,255,.18);-webkit-tap-highlight-color:transparent;transition:background-color .15s,transform .1s}
.install::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:inherit;pointer-events:none;animation:install-pulse 2.2s ease-out .6s 3}
@keyframes install-pulse{0%{box-shadow:0 0 0 0 var(--install-ring)}70%{box-shadow:0 0 0 16px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.install:hover{background:var(--install-hover)}
.install:active{transform:scale(.98)}
.install:focus-visible{outline:3px solid var(--install-ring);outline-offset:3px}
.install.desk,html[data-device=desktop][data-platform=ios] .install:not(.desk){display:none}
html[data-device=desktop][data-platform=ios] .install.desk{display:flex}
.meta{margin:0;color:var(--muted-fg);font-size:13.5px;text-align:center}
${under(NO_BUTTON, '.actions')}{display:none}

.scan{display:none;flex-direction:column;align-items:center;width:100%;max-width:400px;margin-top:28px}
${under(WITH_QR, '.scan')}{display:flex}
html:not([data-device]) .scan .meta,html[data-device=desktop] .scan .meta{display:none}
/* At a desk the Install button already downloads an APK: no second button for the same file. */
html[data-device=desktop][data-platform=android] .scan-actions [download]{display:none}
/* Reached from the desk's Install button: the code to scan lights up. */
.scan:target .qr-tile{animation:qr-call 1.4s ease-out 2}
@keyframes qr-call{0%{box-shadow:0 0 0 0 var(--install-ring)}70%{box-shadow:0 0 0 14px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
/* The binary itself is no use on the other platform's phone: there only the link travels. */
${under(WRONG, '.scan-actions [download]')}{display:none}
.qr-tile{width:220px;max-width:100%;padding:8px;border:1px solid var(--border);border-radius:16px;background:#ffffff;box-shadow:var(--shadow)}
.qr-tile svg{display:block;width:100%;height:auto}
.scan-lead{margin:16px 0 0;font-size:15px;font-weight:500}
.qr-link{margin:6px 0 0;color:var(--muted-fg);font-size:12.5px;line-height:1.5;word-break:break-all}
.scan-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:16px 0 12px}

.note{display:none;align-items:flex-start;gap:12px;width:100%;max-width:440px;margin-top:20px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--soft);font-size:14.5px;line-height:1.5;text-align:left}
.note>svg{margin-top:1px;color:var(--muted-fg)}
.note p{margin:0}
.note .lead{font-weight:600}
.note .lead+p{margin-top:2px;color:var(--note-detail)}
.note.info{border-color:var(--info-line);background:var(--info-bg);color:var(--info)}
.note.warn{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.note.bad{border-color:var(--bad-line);background:var(--bad-bg);color:var(--bad)}
.note.info>svg,.note.warn>svg,.note.bad>svg{color:inherit}
.note-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
${under(WRONG, '.n-wrong')},html[data-platform=ios][data-device=ios][data-browser=in-app] .n-safari,html[data-platform=ios][data-device=ios][data-browser=other] .n-safari,html[data-platform=android][data-device=android][data-browser=in-app] .n-chrome,html.tapped[data-platform=android][data-device=android] .n-after,html.tapped[data-platform=ios][data-device=ios][data-browser=default] .n-after{display:flex}
/* In the button's place, the notes first and then the QR code: the wrong phone reads why first. */
.hero>.note{order:1}
.hero>.scan{order:2}
${under(WRONG, '.n-wrong')}{margin-top:28px;font-size:15.5px}
html.expired .note{display:none!important}
html.expired .n-expired{display:flex!important;margin-top:28px}
html.expired .scan{display:none}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--fg);font:inherit;font-size:14px;font-weight:500;line-height:1;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.05);cursor:pointer;transition:background-color .15s}
.btn:hover{background:var(--muted)}
.btn:focus-visible,.icon-btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.icon-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--muted-fg);cursor:pointer;transition:background-color .15s,color .15s}
.icon-btn::before{content:"";position:absolute;top:-7px;right:-7px;bottom:-7px;left:-7px}
.icon-btn:hover{background:var(--muted);color:var(--fg)}
.copy .idle,.copy .done{display:inline-flex;align-items:center;gap:6px}
.copy .done,.copy[data-state=copied] .idle{display:none}
.copy[data-state=copied] .done{display:inline-flex}
.copy[data-state=copied] svg{color:var(--success)}
.copy-field{display:block;width:100%;margin-top:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);font:16px ${MONO}}
.copy-field:focus{outline:2px solid var(--primary);outline-offset:1px}

.cards{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin-top:40px}
.card{min-width:0;padding:20px;border:1px solid var(--border);border-radius:14px;background:var(--card);box-shadow:var(--shadow)}
.card h2{display:flex;align-items:center;gap:8px;margin:0 0 16px;font-size:15px;font-weight:600;line-height:20px}
.card h2 svg{color:var(--muted-fg)}

.release{margin:0;font-size:14.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}

.facts{margin:0}
.facts>div{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--border);line-height:20px}
.facts>div:first-child{padding-top:0;border-top:0}
.facts>div:last-child{padding-bottom:0}
.facts dt{flex:none;color:var(--muted-fg);font-size:14px}
.facts dd{min-width:0;margin:0;font-size:14px;text-align:right;word-break:break-word;overflow-wrap:anywhere}
.facts .mono{font-size:13px}
.with-copy{display:inline-flex;align-items:center;gap:6px;vertical-align:middle}
.facts .icon-btn{margin:-6px -6px -6px 0}
.expired-tag{display:none;margin-left:8px;padding:1px 7px;border-radius:999px;background:var(--bad-bg);color:var(--bad);font-size:12px;font-weight:500;line-height:16px}
html.expired .expired-tag{display:inline-block}
html.expired .expires{color:var(--destructive)}

.steps{margin:0;padding:0;list-style:none;counter-reset:step}
.steps li{position:relative;min-height:24px;padding-left:36px;font-size:14.5px;line-height:1.6;counter-increment:step}
.steps li+li{margin-top:14px}
.steps li::before{content:counter(step);position:absolute;top:0;left:0;width:24px;height:24px;border-radius:999px;background:var(--muted);color:var(--fg);font-size:12px;font-weight:600;line-height:24px;text-align:center}

.seg{display:flex;flex:none;height:32px;padding:3px;border:1px solid var(--border);border-radius:9px;background:var(--muted)}
.seg button{min-width:36px;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--muted-fg);font:500 12px/1 ${MONO};cursor:pointer;transition:color .15s,background-color .15s}
.seg button:hover{color:var(--fg)}
html:not([lang=vi]) .seg [data-set-lang=en],html[lang=vi] .seg [data-set-lang=vi]{background:var(--card);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.top-button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--muted-fg);cursor:pointer;transition:background-color .15s,color .15s}
.top-button:hover{background:var(--muted);color:var(--fg)}
.seg button:focus-visible,.top-button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.theme .moon,html.dark .theme .sun{display:none}
html.dark .theme .moon{display:block}

@media (min-width:640px){
.top{padding:16px 24px 0}
.page{padding-top:32px}
.app-icon{width:120px;height:120px}
.initial{font-size:52px}
.hero h1{font-size:32px}
.card{padding:24px}
.btn{min-height:38px}
}
@media (prefers-reduced-motion:reduce){
*{transition:none!important}
.install:active{transform:none}
.install::after,.scan:target .qr-tile{animation:none}
}
`
