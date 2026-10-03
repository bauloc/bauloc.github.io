/* ============================================================
   Device Lab — WebUSB backend (Android, zero install)

   Speaks the ADB protocol straight from the browser via ya-webadb
   ("Tango", MIT). No helper, no daemon, no adb on PATH.

   Two facts shape this file:

   1. A USB interface has exactly ONE owner. If Google's adb server got
      there first, claimInterface fails — and the adb server respawns
      the moment any IDE polls for devices. That is the single most
      common failure here, so it gets a first-class state (`held`) and
      an actionable hint, not a generic error.

   2. Only requestDevice() needs a user gesture. getDevices() and
      connect() do not — so once a device has been granted, a reload
      reconnects it silently. That is the whole reason this lane feels
      like "it just works" on the second visit.

   Bare specifiers below resolve through the import map in index.html.
   Import maps apply to dynamic import() from classic scripts too, which
   is what lets this page stay plain global-scope JS with no bundler.
   The import is lazy: Firefox and Safari never pay for it.
   ============================================================ */

const DVC_TANGO_APP_NAME = 'BauLoc Device Lab';

/* serial -> { device, adb, state, blockers, props, error } */
const dvcUsbSessions = new Map();

let dvcTango = null;            // resolved module namespace bundle
let dvcTangoLoading = null;
let dvcUsbManager = null;
let dvcUsbCredentials = null;
let dvcUsbStarted = false;
let dvcUsbSyncing = false;

async function dvcLoadTango() {
  if (dvcTango) return dvcTango;
  if (dvcTangoLoading) return dvcTangoLoading;

  dvcTangoLoading = (async () => {
    const [core, webusb, credential] = await Promise.all([
      import('@yume-chan/adb'),
      import('@yume-chan/adb-daemon-webusb'),
      import('@yume-chan/adb-credential-web')
    ]);
    dvcTango = {
      Adb: core.Adb,
      AdbDaemonTransport: core.AdbDaemonTransport,
      Manager: webusb.AdbDaemonWebUsbDeviceManager,
      CredentialStore: credential.default || credential.AdbWebCredentialStore
    };
    return dvcTango;
  })();

  try {
    return await dvcTangoLoading;
  } catch (err) {
    dvcTangoLoading = null;
    throw err;
  }
}

async function dvcUsbEnsureManager() {
  const t = await dvcLoadTango();
  if (!dvcUsbManager) {
    /* undefined when navigator.usb is missing — the same check Tango
       makes internally, so we never diverge from it. */
    dvcUsbManager = t.Manager.BROWSER;
    if (!dvcUsbManager) throw new Error('WEBUSB_UNSUPPORTED');
    /* RSA keypair lives in Web Crypto + IndexedDB. On Android 11+ the
       phone's prompt shows this name, so make it recognisable. */
    dvcUsbCredentials = new t.CredentialStore(DVC_TANGO_APP_NAME);
  }
  return dvcUsbManager;
}

/* ---- Session bookkeeping ---------------------------------- */

function dvcUsbEntry(device) {
  const serial = device.serial || device.name || 'unknown';
  let e = dvcUsbSessions.get(serial);
  if (!e) {
    e = { serial, device, adb: null, state: 'connecting', blockers: [], props: {}, error: null };
    dvcUsbSessions.set(serial, e);
  } else {
    e.device = device;
  }
  return e;
}

function dvcUsbSetState(entry, state, blockers, error) {
  entry.state = state;
  entry.blockers = blockers || [];
  entry.error = error || null;
  dvcPublishDevices();
}

/* Classify a connect/authenticate failure into something the tester can
   act on. The claim-interface case is the one that actually matters. */
function dvcUsbClassify(err) {
  const name = err && err.name ? String(err.name) : '';
  const msg  = err && err.message ? String(err.message) : '';

  if (name === 'DeviceBusyError' || /claim|busy|already in use/i.test(msg)) {
    return { state: 'held', blockers: ['ADB_SERVER_HOLDING'] };
  }
  if (name === 'NetworkError' || /disconnect|transfer|no such device/i.test(msg)) {
    return { state: 'offline', blockers: ['ANDROID_OFFLINE'] };
  }
  if (name === 'NotFoundError' || /no device/i.test(msg)) {
    return { state: 'absent', blockers: [] };
  }
  if (name === 'SecurityError' || /access denied|permission/i.test(msg)) {
    return { state: 'held', blockers: ['WEBUSB_CLAIM_FAILED'] };
  }
  return { state: 'offline', blockers: ['WEBUSB_CLAIM_FAILED'] };
}

async function dvcUsbConnect(entry) {
  if (entry.adb || entry.connecting) return;
  entry.connecting = true;
  const t = await dvcLoadTango();

  try {
    dvcUsbSetState(entry, 'connecting', []);
    const connection = await entry.device.connect();   // claims the interface

    /* authenticate() stays pending while the phone shows "Allow USB
       debugging?" — so the honest state here is `authorizing`, not a
       spinner that looks like our own slowness. */
    dvcUsbSetState(entry, 'authorizing', ['ANDROID_UNAUTHORIZED']);

    const transport = await t.AdbDaemonTransport.authenticate({
      serial: entry.serial,
      connection,
      credentialStore: dvcUsbCredentials
    });

    const adb = new t.Adb(transport);
    entry.adb = adb;

    /* Cheap identity for the list row; the full dump waits for detail(). */
    const [model, brand, release] = await Promise.all([
      adb.getProp('ro.product.model').catch(() => ''),
      adb.getProp('ro.product.manufacturer').catch(() => ''),
      adb.getProp('ro.build.version.release').catch(() => '')
    ]);
    entry.props = { model, brand, release };

    /* A device can vanish mid-session (cable, reboot, sleep). Reflect it
       rather than leaving a stale "Ready". */
    adb.disconnected.then(
      () => dvcUsbOnLost(entry),
      () => dvcUsbOnLost(entry)
    );

    dvcUsbSetState(entry, 'ready', []);
    dvcAnnounce((model || entry.serial) + ' connected.');
  } catch (err) {
    const c = dvcUsbClassify(err);
    console.warn('[dvc] webusb connect failed for ' + entry.serial, err);
    dvcUsbSetState(entry, c.state, c.blockers, err);
  } finally {
    entry.connecting = false;
  }
}

function dvcUsbOnLost(entry) {
  entry.adb = null;
  if (dvcUsbSessions.has(entry.serial)) {
    dvcUsbSetState(entry, 'absent', []);
    /* Drop it on the next sync rather than immediately, so a brief
       re-enumeration (USB mode switch) doesn't make the row flicker. */
  }
}

/* Reconcile our session map with what the browser says is granted and
   present. Auto-connects anything new: no gesture needed. */
async function dvcUsbSync() {
  if (dvcUsbSyncing) return;
  dvcUsbSyncing = true;
  try {
    const manager = await dvcUsbEnsureManager();
    const devices = await manager.getDevices();
    const present = new Set();

    for (const device of devices) {
      const entry = dvcUsbEntry(device);
      present.add(entry.serial);
      /* `held` is sticky on purpose: retrying a claim every few seconds
         would hammer the USB stack and spam the log while adb owns the
         device. It is cleared only by an explicit Reconnect / Refresh
         (dvcUsbRetryHeld), which is why the hint ships a Reconnect
         button — see ADB_SERVER_HOLDING. */
      if (!entry.adb && !entry.connecting && entry.state !== 'held') {
        dvcUsbConnect(entry);      // deliberately not awaited: parallel
      }
    }

    for (const [serial, entry] of Array.from(dvcUsbSessions)) {
      if (!present.has(serial)) {
        if (entry.adb) { try { await entry.adb.close(); } catch { /* already gone */ } }
        dvcUsbSessions.delete(serial);
      }
    }

    dvcPublishDevices();
  } catch (err) {
    if (err && err.message === 'WEBUSB_UNSUPPORTED') return;
    console.warn('[dvc] webusb sync failed', err);
  } finally {
    dvcUsbSyncing = false;
  }
}

/* ---- Detail ----------------------------------------------- */

function dvcParseGetprop(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function dvcUsbDetail(id) {
  const entry = dvcUsbSessions.get(id);
  if (!entry || !entry.adb) throw new Error('DEVICE_NOT_READY');
  const sh = entry.adb.subprocess.noneProtocol;

  /* Separate concurrent calls rather than one compound shell command:
     the transport multiplexes sockets, and building a compound command
     would mean quoting for the DEVICE's shell — a trap we avoid entirely
     by never assembling shell strings. */
  const [propsText, sizeText, densityText, batteryText, dfText, androidId] = await Promise.all([
    sh.spawnWaitText(['getprop']).catch(() => ''),
    sh.spawnWaitText(['wm', 'size']).catch(() => ''),
    sh.spawnWaitText(['wm', 'density']).catch(() => ''),
    sh.spawnWaitText(['dumpsys', 'battery']).catch(() => ''),
    sh.spawnWaitText(['df', '/data']).catch(() => ''),
    sh.spawnWaitText(['settings', 'get', 'secure', 'android_id']).catch(() => '')
  ]);

  const p = dvcParseGetprop(propsText);

  /* Prefer "Override size" when the tester has changed resolution. */
  const size = /Override size:\s*(\d+)x(\d+)/.exec(sizeText) || /Physical size:\s*(\d+)x(\d+)/.exec(sizeText);
  const dens = /Override density:\s*(\d+)/.exec(densityText) || /Physical density:\s*(\d+)/.exec(densityText);

  const battLevel = /^\s*level:\s*(\d+)/m.exec(batteryText);
  const battTemp  = /^\s*temperature:\s*(-?\d+)/m.exec(batteryText);   // deci-°C
  const battStatus = /^\s*status:\s*(\d+)/m.exec(batteryText);
  const powered = /(AC|USB|Wireless) powered:\s*true/.test(batteryText);

  /* df prints the mount point as /data/user/0, not /data — don't validate
     on it. Columns are 1K blocks. */
  const dfCols = String(dfText).trim().split('\n').pop().trim().split(/\s+/);
  const kTotal = Number(dfCols[1]), kUsed = Number(dfCols[2]), kFree = Number(dfCols[3]);

  return {
    platform: 'android',
    /* Identity. IMEI is deliberately absent: since Android 10 the shell
       user lacks READ_PRIVILEGED_PHONE_STATE and `service call
       iphonesubinfo` returns a SecurityException. Showing an empty field
       would imply we could get it. */
    identity: {
      'Device name':  p['ro.product.model'] || entry.serial,
      'Model':        p['ro.product.model'] || '',
      'Manufacturer': p['ro.product.manufacturer'] || '',
      'Brand':        p['ro.product.brand'] || '',
      'Codename':     p['ro.product.device'] || '',
      'Serial':       p['ro.serialno'] || entry.serial,
      'ANDROID_ID':   String(androidId || '').trim()
    },
    software: {
      'Android':        p['ro.build.version.release_or_codename'] || p['ro.build.version.release'] || '',
      'API level':      p['ro.build.version.sdk'] || '',
      'Build':          p['ro.build.display.id'] || p['ro.build.id'] || '',
      'Security patch': p['ro.build.version.security_patch'] || '',
      'Fingerprint':    p['ro.build.fingerprint'] || '',
      'Build type':     p['ro.build.type'] || ''
    },
    hardware: {
      'ABI':      p['ro.product.cpu.abi'] || '',
      'ABI list': p['ro.product.cpu.abilist'] || '',
      'Screen':   size ? size[1] + ' × ' + size[2] + ' px' : '',
      'Density':  dens ? dens[1] + ' dpi' : '',
      'Locale':   p['persist.sys.locale'] || '',
      'Timezone': p['persist.sys.timezone'] || ''
    },
    status: {
      'Battery': battLevel
        ? battLevel[1] + '%' +
          (powered || (battStatus && (battStatus[1] === '2' || battStatus[1] === '5')) ? ' · charging' : '') +
          (battTemp ? ' · ' + (Number(battTemp[1]) / 10).toFixed(1) + ' °C' : '')
        : '',
      'Storage': isFinite(kFree) && isFinite(kTotal)
        ? dvcFmtBytes(kFree * 1024) + ' free of ' + dvcFmtBytes(kTotal * 1024) +
          (isFinite(kUsed) ? ' (' + Math.round((kUsed / kTotal) * 100) + '% used)' : '')
        : '',
      'Connection': 'USB (WebUSB)',
      'ANDROID_ID note': 'This is the shell user’s ANDROID_ID — an app reports a different value.'
    },
    /* Kept for the bug-report bundle. */
    raw: { getprop: propsText }
  };
}

/* ---- Screenshot ------------------------------------------- */

async function dvcUsbScreenshot(id) {
  const entry = dvcUsbSessions.get(id);
  if (!entry || !entry.adb) throw new Error('DEVICE_NOT_READY');

  /* `screencap -p` rather than framebuffer(): framebuffer throws
     AdbFrameBufferForbiddenError whenever anything on screen sets
     FLAG_SECURE (lock screen, banking apps, Netflix) and its payload is
     far larger. spawnWait concatenates to bytes, so the PNG is exact —
     no text decoding anywhere near it. */
  const bytes = await entry.adb.subprocess.noneProtocol.spawnWait(['screencap', '-p']);
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (buf.length < 8 ||
      buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('SCREENSHOT_NOT_PNG');
  }
  return new Blob([buf], { type: 'image/png' });
}

/* ---- Backend registration --------------------------------- */

dvcRegisterBackend({
  kind: 'webusb',
  label: 'WebUSB',
  platforms: ['android'],
  canRequest: true,

  isAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.usb;
  },

  async start() {
    if (dvcUsbStarted || !this.isAvailable()) return;
    dvcUsbStarted = true;

    /* navigator.usb events are the authoritative signal; the interval is
       only a backstop for the cases Chrome does not fire one (notably a
       device added by requestDevice itself). */
    navigator.usb.addEventListener('connect', () => dvcUsbSync());
    navigator.usb.addEventListener('disconnect', () => dvcUsbSync());
    setInterval(() => { if (!document.hidden) dvcUsbSync(); }, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) dvcUsbSync(); });

    await dvcUsbSync();
  },

  /* USER GESTURE ONLY — the spec rejects requestDevice without transient
     activation, so this must be called straight from a click handler. */
  async requestDevice() {
    const manager = await dvcUsbEnsureManager();
    const device = await manager.requestDevice();
    if (!device) return null;                       // user dismissed the picker
    const entry = dvcUsbEntry(device);
    await dvcUsbConnect(entry);
    dvcPublishDevices();
    return entry.serial;
  },

  list() {
    const out = [];
    for (const entry of dvcUsbSessions.values()) {
      out.push(dvcNormalizeDevice({
        id: entry.serial,
        backend: 'webusb',
        platform: 'android',
        connection: 'usb',
        state: entry.state,
        name: entry.props.model || entry.device.name || entry.serial,
        model: entry.props.model || '',
        osVersion: entry.props.release || '',
        serial: entry.serial,
        blockers: entry.blockers,
        capabilities: {
          screenshot: !!entry.adb,
          identifiers: !!entry.adb,
          install: !!entry.adb,
          logs: !!entry.adb
        }
      }));
    }
    return out;
  },

  detail: dvcUsbDetail,
  screenshot: dvcUsbScreenshot,

  async retry(id) {
    const entry = dvcUsbSessions.get(id);
    if (!entry) return;
    entry.adb = null;
    entry.connecting = false;
    entry.state = 'connecting';        // clear `held` so the claim is attempted
    await dvcUsbConnect(entry);
  },

  /* Refresh reclaims everything currently held, so the button in the list
     bar is a real recovery action and not just a re-poll. */
  async retryHeld() {
    const held = Array.from(dvcUsbSessions.values()).filter(e => e.state === 'held' && !e.adb);
    for (const e of held) { e.connecting = false; e.state = 'connecting'; }
    await Promise.all(held.map(e => dvcUsbConnect(e)));
  },

  async forget(id) {
    const entry = dvcUsbSessions.get(id);
    if (!entry) return;
    try { if (entry.adb) await entry.adb.close(); } catch { /* already gone */ }
    try { if (entry.device.raw && entry.device.raw.forget) await entry.device.raw.forget(); } catch { /* not supported */ }
    dvcUsbSessions.delete(id);
    dvcPublishDevices();
  }
});
