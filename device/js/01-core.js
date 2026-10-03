/* ============================================================
   Device Lab — core: constants, state, escaping, toast, copy,
   formatting, icons, event bus, announcements.

   Everything here is global and prefixed `dvc` / `DVC_`. This page
   shares its global scope with nothing else today, but the agent
   shell may one day inject app.js into a document that has its own
   globals — so the discipline is not optional.
   ============================================================ */

/* ---- Constants -------------------------------------------- */

const DVC_VERSION      = '0.1.0';
const DVC_DEFAULT_PORT = 8787;
const DVC_MIN_AGENT    = 1;                    // major protocol the UI requires
const DVC_AGENT_URL    = 'https://bauloc.github.io/device/agent/device-bridge.mjs';
const DVC_REPO_URL     = 'https://github.com/bauloc/bauloc.github.io/blob/master/device/agent/device-bridge.mjs';

/* localStorage / sessionStorage keys. The device token defaults to
   sessionStorage: bauloc.github.io is ONE origin for every page on this
   site, and xconsole already keeps a GitHub PAT with Contents:write in
   localStorage.xconsole_pat. Putting a device-agent token in the same
   bucket would mean one XSS anywhere yields both "commit to the repo"
   and "install an APK on a phone". */
const DVC_KEY_TOKEN  = 'dvc_token';
const DVC_KEY_PORT   = 'dvc_port';
const DVC_KEY_DRAFT  = 'dvc_draft';
const DVC_KEY_PREFS  = 'dvc_prefs';

/* Device sort weights, so the list self-prioritises: usable devices rise,
   dead ones sink. Borrowed from DeviceFarmer/stf, which learned it the
   hard way across a physical device shelf. */
const DVC_STATE_WEIGHT = {
  ready:        10,
  busy:         20,
  connecting:   30,
  authorizing:  40,
  locked:       50,
  held:         55,
  unauthorized: 60,
  untrusted:    60,
  offline:      70,
  recovery:     80,
  unknown:      90,
  absent:       95
};

/* state -> dot tone + human label. Note the deliberate split:
   `unauthorized` is RED because the tester can fix it right now, while
   `offline` is GREY because it is inert and usually a cable. Colour is
   always paired with this label — never colour alone. */
const DVC_STATE_META = {
  ready:        { tone: 'ok',   label: 'Ready' },
  busy:         { tone: 'busy', label: 'Busy' },
  connecting:   { tone: 'busy', label: 'Connecting…' },
  authorizing:  { tone: 'warn', label: 'Authorizing…' },
  locked:       { tone: 'warn', label: 'Locked' },
  held:         { tone: 'bad',  label: 'Held by adb' },
  unauthorized: { tone: 'bad',  label: 'Not authorized' },
  untrusted:    { tone: 'bad',  label: 'Not trusted' },
  offline:      { tone: 'off',  label: 'Offline' },
  recovery:     { tone: 'off',  label: 'Recovery mode' },
  unknown:      { tone: 'off',  label: 'Unknown' },
  absent:       { tone: 'off',  label: 'Disconnected' }
};

/* ---- State ------------------------------------------------ */

const dvcState = {
  conn: 'BOOT',
  connDetail: null,
  mode: 'hosted',                 // 'hosted' | 'local'
  apiBase: '',
  token: '',
  agent: null,                    // /api/health payload
  backends: {},                   // kind -> backend impl
  devices: [],
  selectedId: null,
  detail: null,
  shots: [],
  failStreak: 0,
  webusbSupported: false,
  prefs: dvcLoadPrefs()
};

function dvcLoadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(DVC_KEY_PREFS) || '{}') || {};
  } catch {
    return {};
  }
}

function dvcSavePrefs() {
  try {
    localStorage.setItem(DVC_KEY_PREFS, JSON.stringify(dvcState.prefs));
  } catch {
    /* private window, or site data blocked — prefs are a convenience only */
  }
}

/* ---- Escaping --------------------------------------------- */

/* Device names are user-editable on Android, app labels come from the
   device, and log lines and raw adb/devicectl stderr are all
   attacker-influenceable: a malicious test build can emit a log line that
   becomes a script tag. Rule for this codebase: device-supplied strings go
   through textContent (dvcText / dvcEl), and anything that must be
   interpolated into a template literal goes through dvcEsc/dvcEscAttr at
   EVERY interpolation site. */

function dvcEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dvcEscAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- Tiny DOM helpers ------------------------------------- */

function dvcEl(tag, props, children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class')        el.className = v;
      else if (k === 'text')    el.textContent = v;
      else if (k === 'html')    el.innerHTML = v;     // callers must pass trusted markup only
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style')   el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true)      el.setAttribute(k, '');
      else                      el.setAttribute(k, v);
    }
  }
  if (children) {
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return el;
}

function dvcText(s) { return document.createTextNode(String(s == null ? '' : s)); }

function dvcQ(sel, root)  { return (root || document).querySelector(sel); }
function dvcQA(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* ---- Icons (inline 24x24 stroke SVG, matching xconsole's style) ---- */

const DVC_ICON_PATHS = {
  refresh:    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  camera:     '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  bug:        '<path d="M8 2l1.88 1.88M14.12 3.88L16 2"/><path d="M9 7.13V6a3 3 0 0 1 6 0v1.13"/><path d="M18 11v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4z"/><path d="M3 13h3M18 13h3M4.5 7.5L7 9M19.5 7.5L17 9M4.5 18.5L7 17M19.5 18.5L17 17"/>',
  settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  stethoscope:'<path d="M4 3v6a5 5 0 0 0 10 0V3"/><path d="M4 3h3M11 3h3"/><path d="M9 14v2a4 4 0 0 0 8 0v-1"/><circle cx="18" cy="12" r="2"/>',
  activity:   '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  check:      '<path d="M20 6L9 17l-5-5"/>',
  x:          '<path d="M18 6L6 18M6 6l12 12"/>',
  alert:      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info:       '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  plus:       '<path d="M12 5v14M5 12h14"/>',
  download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  external:   '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  terminal:   '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
  clipboard:  '<rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/>'
};

/* Returns an SVG *string* for use inside trusted template literals.
   Never pass a caller-supplied name that came off the network. */
function dvcIcon(name, size, strokeWidth) {
  const body = DVC_ICON_PATHS[name];
  if (!body) return '';
  const s = size || 24;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
         'stroke="currentColor" stroke-width="' + (strokeWidth || 2) +
         '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

/* ---- Formatting ------------------------------------------- */

const DVC_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function dvcPad(n) { return String(n).padStart(2, '0'); }

function dvcFmtDateTime(value) {
  if (!value) return 'Never';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return 'Unknown';
  return dvcPad(d.getDate()) + '-' + DVC_MONTHS[d.getMonth()] + '-' + d.getFullYear() +
         ' ' + dvcPad(d.getHours()) + ':' + dvcPad(d.getMinutes());
}

function dvcFmtClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '--:--:--';
  return dvcPad(d.getHours()) + ':' + dvcPad(d.getMinutes()) + ':' + dvcPad(d.getSeconds());
}

/* ISO 8601 with the local UTC offset, so a timestamp pasted into a ticket
   is unambiguous. A bare local time in a bug report is a bug in itself. */
function dvcFmtIsoOffset(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + dvcPad(d.getMonth() + 1) + '-' + dvcPad(d.getDate()) +
         'T' + dvcPad(d.getHours()) + ':' + dvcPad(d.getMinutes()) + ':' + dvcPad(d.getSeconds()) +
         sign + dvcPad(Math.floor(abs / 60)) + ':' + dvcPad(abs % 60);
}

function dvcFmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  return Math.round(m / 60) + 'h ago';
}

function dvcFmtBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
}

/* Mask an identifier for the "Redact identifiers" switch. Keeps enough
   for a human to correlate two reports without publishing the full UDID. */
function dvcMask(value) {
  const s = String(value == null ? '' : value);
  if (s.length <= 8) return s ? s.slice(0, 2) + '…' : '';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

/* Turn a package name into something readable. adb genuinely cannot give
   us an app label — `resolve-activity` returns a resource ID and there is
   no adb command that resolves it — so this heuristic is the honest
   default, not a placeholder for something better. */
function dvcPrettyPackage(pkg) {
  const last = String(pkg || '').split('.').filter(Boolean).pop() || '';
  return last.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || pkg || '';
}

/* ---- Event bus -------------------------------------------- */

const dvcBus = new Map();

function dvcOn(event, fn) {
  if (!dvcBus.has(event)) dvcBus.set(event, new Set());
  dvcBus.get(event).add(fn);
  return () => dvcBus.get(event).delete(fn);
}

function dvcEmit(event, payload) {
  const set = dvcBus.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[dvc] listener for "' + event + '" threw', err);
    }
  }
}

/* ---- Screen-reader announcements -------------------------- */

/* Announce connection transitions, device arrive/depart and job
   completion — once each, not per tick. The log console deliberately
   stays aria-live="off"; narrating every logcat line is unusable. */
function dvcAnnounce(message) {
  const el = document.getElementById('dvc-status');
  if (el) el.textContent = message;
}

/* ---- Toast (copy of xconsole showToast, text-safe by default) ---- */

const DVC_TOAST_ICONS = {
  success: dvcIcon('check', 16, 2.5),
  error:   dvcIcon('alert', 16, 2),
  info:    dvcIcon('info', 16, 2)
};

function dvcToast(title, message, type, opts) {
  const o = opts || {};
  const kind = type || 'info';
  const host = document.getElementById('toast-container');
  if (!host) return null;

  const toast = dvcEl('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' });
  toast.appendChild(dvcEl('div', { class: 'toast-icon', html: DVC_TOAST_ICONS[kind] || '' }));

  const body = dvcEl('div', { class: 'toast-body' }, [
    dvcEl('div', { class: 'toast-title', text: title })
  ]);
  if (message) {
    /* Default is textContent. `opts.html` exists only for our own trusted
       markup (a link back into the UI); never hand it device output. */
    body.appendChild(o.html
      ? dvcEl('div', { class: 'toast-msg', html: message })
      : dvcEl('div', { class: 'toast-msg', text: message }));
  }
  if (o.action && o.actionLabel) {
    body.appendChild(dvcEl('button', {
      class: 'btn btn-link',
      style: 'padding:6px 0 0;font-size:12.5px',
      text: o.actionLabel,
      onclick: () => { dismiss(); o.action(); }
    }));
  }
  toast.appendChild(body);

  toast.appendChild(dvcEl('button', {
    class: 'toast-close',
    'aria-label': 'Dismiss',
    html: dvcIcon('x', 14, 2.5),
    onclick: dismiss
  }));

  host.appendChild(toast);
  dvcAnnounce(title + (message ? '. ' + message : ''));

  const duration = o.duration == null ? 5000 : o.duration;
  let timer = duration > 0 ? setTimeout(dismiss, duration) : 0;

  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = 0;
    toast.remove();
  }

  return { el: toast, dismiss };
}

/* ---- Clipboard (copy of xconsole copyToClipboard) ---- */

async function dvcCopy(text, btn) {
  const original = btn ? btn.textContent : '';
  try {
    await navigator.clipboard.writeText(String(text));
    if (btn) {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 2000);
    }
    /* The label swap is invisible to a screen reader on its own. */
    dvcAnnounce('Copied to clipboard');
    return true;
  } catch {
    dvcToast('Copy failed', 'Your browser blocked clipboard access. Select the text and copy manually.', 'error');
    return false;
  }
}

/* ---- Busy pill (copy of xconsole showSaving/hideSaving) ---- */

function dvcBusy(text) {
  let pill = document.getElementById('dvc-busy');
  if (!pill) {
    pill = dvcEl('div', { class: 'saving-progress', id: 'dvc-busy', role: 'status' }, [
      dvcEl('div', { class: 'spinner' }),
      dvcEl('span', { class: 'saving-progress-text', id: 'dvc-busy-text' })
    ]);
    document.body.appendChild(pill);
  }
  document.getElementById('dvc-busy-text').textContent = text || 'Working…';
  pill.classList.remove('hidden');
}

function dvcBusyDone() {
  const pill = document.getElementById('dvc-busy');
  if (pill) pill.classList.add('hidden');
}

/* ---- Environment ------------------------------------------ */

const DVC_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function dvcIsLocalOrigin() {
  return location.protocol === 'http:' && DVC_LOCAL_HOSTS.has(location.hostname);
}

/* Safari is the one browser that refuses https -> http://127.0.0.1
   outright (WebKit bug 171934, open since 2017). We must detect it to
   REORDER the setup guide, never to hide the working path. */
function dvcIsSafari() {
  return /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent) &&
         navigator.vendor === 'Apple Computer, Inc.';
}

/* Resolve mode / API base / token. The agent shell inlines window.DVC_BOOT
   before app.js, which is what makes the locally served page self-pairing. */
function dvcResolveEnv() {
  const boot = window.DVC_BOOT || null;
  if (boot && boot.apiBase) {
    dvcState.mode    = 'local';
    dvcState.apiBase = String(boot.apiBase).replace(/\/+$/, '');
    dvcState.token   = boot.token || '';
    return;
  }

  /* 404.html is an SPA redirect shim, so /device/anything arrives here as
     ?/anything. URLSearchParams parses that to a harmless "/anything" key —
     do not "fix" it. */
  const q = new URLSearchParams(location.search);
  let port = q.get('port') || '';
  try {
    port = port || localStorage.getItem(DVC_KEY_PORT) || '';
  } catch { /* storage blocked */ }
  port = /^\d{1,5}$/.test(port) ? port : String(DVC_DEFAULT_PORT);

  const base = (q.get('api') || 'http://127.0.0.1:' + port).replace(/\/+$/, '');

  /* If the agent served this page but forgot to inline DVC_BOOT, we are
     still same-origin and must not fall into hosted mode. */
  dvcState.mode    = (location.origin === base || dvcIsLocalOrigin()) ? 'local' : 'hosted';
  dvcState.apiBase = dvcState.mode === 'local' ? location.origin : base;

  let stored = '';
  try {
    stored = sessionStorage.getItem(DVC_KEY_TOKEN) || localStorage.getItem(DVC_KEY_TOKEN) || '';
  } catch { /* storage blocked */ }
  dvcState.token = stored;
}

function dvcSaveToken(token, remember) {
  dvcState.token = token || '';
  try {
    sessionStorage.setItem(DVC_KEY_TOKEN, dvcState.token);
    if (remember) localStorage.setItem(DVC_KEY_TOKEN, dvcState.token);
    else          localStorage.removeItem(DVC_KEY_TOKEN);
  } catch { /* storage blocked — the token still works for this page load */ }
}

/* SHA-256 prefix, to compare against the agent's /api/health tokenId and
   tell "this token is from a previous agent run" apart from "you typed it
   wrong" BEFORE sending a request. crypto.subtle needs a secure context;
   http://127.0.0.1 counts as one, so this works in both modes. */
async function dvcTokenId(token) {
  if (!token || !crypto?.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}
