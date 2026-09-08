/* ============================================================
   Device Lab — backend interface

   ONE interface, two implementations: WebUSB (Android, no install)
   and the local helper (iOS, plus Android where WebUSB can't run).
   This boundary exists from day one on purpose — retrofitting it
   later would mean rewriting the UI.

   A backend implements:
     kind        'webusb' | 'agent'
     label       human name for the lane
     platforms   ['android'] | ['ios','android']
     isAvailable()                 -> bool          (cheap, sync)
     start()                       -> Promise       (idle -> watching)
     stop()                        -> Promise
     canRequest                    bool            (has a picker flow)
     requestDevice()               -> Promise<id|null>   (USER GESTURE ONLY)
     list()                        -> DvcDevice[]   (from cache, sync)
     detail(id)                    -> Promise<object>
     screenshot(id)                -> Promise<Blob>
     forget(id)                    -> Promise

   Backends never render. They emit on the bus and the UI reacts:
     'devices'      full snapshot (idempotent — no diff reconciliation)
     'backend'      lane health changed
   ============================================================ */

const dvcBackends = new Map();

function dvcRegisterBackend(impl) {
  dvcBackends.set(impl.kind, impl);
  dvcState.backends[impl.kind] = impl;
}

function dvcBackend(kind) { return dvcBackends.get(kind); }

/* Every available backend, in preference order. WebUSB first: it needs no
   install, so when both lanes can serve the same Android device we use the
   one the tester didn't have to set up. */
function dvcActiveBackends() {
  return ['webusb', 'agent']
    .map(k => dvcBackends.get(k))
    .filter(b => b && b.isAvailable());
}

/* ---- Normalised device shape ------------------------------ */

/* Backends return this. `state` drives the dot + label + sort weight;
   `blockers` are taxonomy codes the UI turns into an actionable hint.
   The backend owns codes, the UI owns wording — so a new backend can
   surface a new blocker without the UI shipping first. */
function dvcNormalizeDevice(raw) {
  const d = Object.assign({
    id: '',
    backend: '',
    platform: 'android',
    connection: 'usb',
    state: 'unknown',
    name: '',
    model: '',
    osVersion: '',
    blockers: [],
    capabilities: {}
  }, raw);

  d.name = d.name || d.model || d.id;
  if (!DVC_STATE_META[d.state]) d.state = 'unknown';
  return d;
}

/* Merge every backend's cache into one list. One table for both
   platforms — never two separate lists (atxserver2's answer, and the
   right one: a tester thinks "my devices", not "my transports"). */
function dvcCollectDevices() {
  const out = [];
  const seen = new Set();
  for (const b of dvcActiveBackends()) {
    for (const d of b.list()) {
      /* The same Android phone can be visible to both lanes. Never run two
         backends against one device: whichever claimed the USB interface
         owns it, and the other would fail confusingly. First lane wins. */
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return dvcSortDevices(out);
}

function dvcSortDevices(list) {
  return list.slice().sort((a, b) => {
    const wa = DVC_STATE_WEIGHT[a.state] ?? 99;
    const wb = DVC_STATE_WEIGHT[b.state] ?? 99;
    if (wa !== wb) return wa - wb;
    return String(a.name).localeCompare(String(b.name));
  });
}

function dvcFindDevice(id) {
  return dvcState.devices.find(d => d.id === id) || null;
}

/* Called by backends whenever their cache changes. */
function dvcPublishDevices() {
  dvcState.devices = dvcCollectDevices();
  dvcEmit('devices', dvcState.devices);
}

/* ---- Blocker -> actionable hint ---------------------------

   Every entry names what to DO. A hint that only restates the problem
   ("device unauthorized") is the failure mode that makes
   "Could not find AltServer" the most-searched string in sideloading.
   ---------------------------------------------------------- */

const DVC_DEVICE_HINTS = {
  ADB_SERVER_HOLDING: {
    title: 'Google’s adb server is holding this phone',
    body: 'One program at a time can own a USB device. Quit the adb server, then reconnect here.',
    /* Two fixes, in order: run the command, then reconnect. Shipping only
       the copy button left the tester stranded — nothing reclaims a `held`
       device automatically, so without Reconnect the page looked broken
       until a reload. */
    fixes: [
      { label: 'Copy “adb kill-server”', copy: 'adb kill-server' },
      { label: 'Reconnect', action: 'retry', primary: true }
    ],
    extra: 'If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ, Flutter, VS Code, Unity or scrcpy.'
  },
  ANDROID_UNAUTHORIZED: {
    title: 'Waiting for you to allow USB debugging',
    body: 'Unlock the phone and tap Allow on the “Allow USB debugging?” prompt. Tick “Always allow” so it stops asking.',
    fixes: [{ label: 'Retry', action: 'retry' }]
  },
  ANDROID_OFFLINE: {
    title: 'The phone is on the bus but not answering',
    body: 'Reseat the cable and avoid USB hubs, then toggle USB debugging off and on.',
    fixes: [{ label: 'Retry', action: 'retry' }]
  },
  ANDROID_RECOVERY: {
    title: 'Device is in recovery / bootloader mode',
    body: 'Screenshots, installs and logs are unavailable until it boots normally.'
  },
  IOS_UNTRUSTED: {
    title: 'Waiting for you to trust this Mac',
    body: 'Unlock the iPhone, tap Trust on “Trust This Computer?”, then enter the passcode.',
    fixes: [{ label: 'Retry', action: 'retry' }]
  },
  IOS_LOCKED: {
    title: 'Unlock the device to read its details',
    body: 'iOS only reports serial number, storage and battery while the device is unlocked.',
    fixes: [{ label: 'Retry', action: 'retry' }]
  },
  IOS_DEVELOPER_MODE_OFF: {
    title: 'Developer Mode is off',
    body: 'Settings → Privacy & Security → Developer Mode → On. The device restarts, then tap Turn On.',
    extra: 'There is no button for this: enabling it fails when a passcode is set, and it reboots the device.'
  },
  TUNNEL_REQUIRED: {
    title: 'This device needs the privileged tunnel',
    body: 'On iOS 17 and newer, screenshots need a system tunnel that must run as root. It stops when you quit the helper.',
    fixes: [{ label: 'Copy command', copy: 'sudo pymobiledevice3 remote tunneld -d' }]
  },
  IOS_NETWORK_ONLY: {
    title: 'Connected over Wi‑Fi',
    body: 'Identifiers work. Install and logs need a cable — plug it in over USB.'
  },
  TOOL_MISSING: {
    title: 'A required tool is missing',
    body: 'Open the environment check for the exact install command.',
    fixes: [{ label: 'Open check', action: 'doctor' }]
  },
  WEBUSB_CLAIM_FAILED: {
    title: 'Could not claim the USB interface',
    body: 'Another program owns this device. Quit adb and any device tooling, unplug and replug, then reconnect.',
    fixes: [
      { label: 'Copy “adb kill-server”', copy: 'adb kill-server' },
      { label: 'Reconnect', action: 'retry', primary: true }
    ]
  }
};

function dvcHintFor(device) {
  if (!device || !device.blockers) return null;
  for (const code of device.blockers) {
    if (DVC_DEVICE_HINTS[code]) return Object.assign({ code }, DVC_DEVICE_HINTS[code]);
  }
  return null;
}
