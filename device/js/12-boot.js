/* ============================================================
   Device Lab — boot and chrome

   The zero state is the PRIMARY screen, not an error page: most
   visitors arrive with nothing connected. On Chrome/Edge the Android
   lane already works at that moment, so the gate says so instead of
   blocking. Help for the most common failure (Google's adb server
   holding the phone) lives inline in that screen, not in docs.
   ============================================================ */

const DVC_CURL_CMD =
  'curl -fsSL ' + DVC_AGENT_URL + ' -o ~/devlab-agent.mjs';
const DVC_RUN_CMD = 'node ~/devlab-agent.mjs';

/* ---- Top bar ---------------------------------------------- */

function dvcRenderTopbar() {
  const laneChip  = document.getElementById('dvc-chip-lane');
  const agentChip = document.getElementById('dvc-chip-agent');

  /* Two chips, deliberately. "Helper unreachable" and "helper up, zero
     devices" must never look the same — conflating them is Maestro
     issue #3012, where the UI reported "0 devices" while the real
     failure was agent-side. */
  if (laneChip) {
    const supported = dvcState.webusbSupported;
    const n = dvcState.devices.filter(d => d.backend === 'webusb').length;
    const ready = dvcState.devices.filter(d => d.backend === 'webusb' && d.state === 'ready').length;
    const tone = !supported ? 'warn' : n === 0 ? 'idle' : ready ? 'ok' : 'warn';
    laneChip.dataset.tone = tone;
    laneChip.replaceChildren(
      dvcEl('span', { class: 'dvc-dot', dataset: { st: tone === 'idle' ? 'off' : tone } }),
      dvcText(!supported ? 'No WebUSB' : n === 0 ? 'WebUSB ready' : ready + '/' + n + ' Android ready')
    );
    laneChip.title = supported
      ? 'This browser talks to Android devices directly over USB.'
      : 'Firefox and Safari do not implement WebUSB. Android needs the local helper here.';
  }

  if (agentChip) {
    agentChip.dataset.tone = 'idle';
    agentChip.replaceChildren(
      dvcEl('span', { class: 'dvc-dot', dataset: { st: 'off' } }),
      dvcText('Helper not detected')
    );
    agentChip.title = 'The local helper adds iOS support. Not running yet.';
  }
}

/* ---- Zero state ------------------------------------------- */

function dvcCmdBlock(cmd) {
  return dvcEl('div', { class: 'dvc-cmd' }, [
    dvcEl('code', { text: cmd }),
    dvcEl('button', {
      class: 'url-copy-btn', type: 'button', text: 'Copy',
      'aria-label': 'Copy command',
      onclick: e => dvcCopy(cmd, e.currentTarget)
    })
  ]);
}

function dvcRenderGate() {
  const gate = document.getElementById('dvc-gate');
  if (!gate) return;

  const webusb = dvcState.webusbSupported;

  /* --- Android lane --- */
  const androidLane = dvcEl('div', { class: 'dvc-lane' }, [
    dvcEl('div', { class: 'dvc-lane-head' }, [
      dvcEl('span', { class: 'badge badge-android', text: 'Android' }),
      dvcEl('span', { class: 'dvc-lane-title', text: webusb ? 'Ready' : 'Needs the helper' })
    ]),
    dvcEl('div', { class: 'dvc-lane-body' }, [
      webusb
        ? dvcText('Click Add device and pick your phone from the browser prompt. Nothing to install.')
        : dvcText('This browser has no WebUSB, so Android goes through the local helper too. Chrome or Edge gets you the no-install path.')
    ]),
    dvcEl('div', { class: 'dvc-lane-actions' }, [
      dvcEl('button', {
        class: 'btn btn-primary', type: 'button',
        disabled: !webusb,
        html: dvcIcon('plus', 14, 2.5) + ' Add device',
        onclick: dvcRequestAndroidDevice
      })
    ])
  ]);

  if (webusb) {
    /* The single most common failure on a developer's Mac. Put the fix
       where the failure happens, not three clicks away in a doc. */
    const details = dvcEl('details');
    details.appendChild(dvcEl('summary', { text: 'Picker empty, or “unable to claim interface”?' }));
    details.appendChild(dvcEl('div', { class: 'dvc-note', style: 'margin-top:8px' }, [
      dvcEl('p', { style: 'margin-bottom:8px', text:
        'One program at a time can own a USB device, and Google’s adb server usually got there first. Quit it, then try again:' }),
      dvcCmdBlock('adb kill-server'),
      dvcEl('p', { style: 'margin-top:8px', text:
        'If adb comes straight back, an IDE is restarting it — Android Studio, IntelliJ, Flutter, VS Code, Unity or scrcpy. Quit that too, or use the local helper instead, which shares the adb server rather than fighting it.' })
    ]));
    androidLane.appendChild(details);
  }

  /* --- iOS lane --- */
  const iosLane = dvcEl('div', { class: 'dvc-lane' }, [
    dvcEl('div', { class: 'dvc-lane-head' }, [
      dvcEl('span', { class: 'badge badge-ios', text: 'iOS' }),
      dvcEl('span', { class: 'dvc-lane-title', text: 'Needs the helper' })
    ]),
    dvcEl('div', { class: 'dvc-lane-body' }, [
      dvcText('macOS keeps the iPhone USB connection for itself, so no browser can reach it. A small local helper bridges the gap — it is not built yet.')
    ]),
    dvcEl('div', { class: 'dvc-lane-actions' }, [
      dvcEl('button', {
        class: 'btn btn-secondary', type: 'button', disabled: true,
        html: dvcIcon('download', 14, 2.5) + ' Get the helper'
      }),
      dvcEl('span', { style: 'font-size:13px;color:var(--text-muted)', text: 'Coming in phase 2' })
    ])
  ]);

  gate.replaceChildren(dvcEl('div', { class: 'dvc-gate-col' }, [
    dvcEl('h1', { text: webusb ? 'Android is ready. iOS needs a helper.' : 'Device Lab' }),
    dvcEl('p', { class: 'dvc-lede', text:
      'Identifiers, screenshots and one-click bug reports for the phones plugged into this computer. Everything runs locally — nothing about your devices is uploaded anywhere.' }),
    dvcEl('div', { class: 'dvc-lanes' }, [androidLane, iosLane]),
    dvcEl('p', { class: 'dvc-reqs', text:
      'WebUSB needs Chrome, Edge or Opera · USB debugging must be on · the helper needs macOS and Node 18+' })
  ]));
}

/* ---- Gate <-> app switching -------------------------------- */

function dvcSyncView() {
  const gate = document.getElementById('dvc-gate');
  const app  = document.getElementById('dvc-app');
  const has  = dvcState.devices.length > 0;

  if (gate) gate.classList.toggle('hidden', has);
  if (app)  app.classList.toggle('hidden', !has);

  if (has && !dvcState.selectedId) {
    /* Auto-select the first usable device, but never silently pick when
       several are attached and none is ready — scrcpy #3137 and Maestro
       #2096 are both this bug. One ready device is not ambiguous. */
    const ready = dvcState.devices.filter(d => d.state === 'ready');
    if (ready.length === 1) dvcSelectDevice(ready[0].id);
  }
  if (!has) dvcRenderGate();
}

/* ---- Keyboard --------------------------------------------- */

function dvcIsTyping() {
  const el = document.activeElement;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

function dvcBindKeys() {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (dvcIsTyping()) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    switch (e.key) {
      case '/': {
        const f = document.getElementById('dvc-list-filter');
        if (f) { e.preventDefault(); f.focus(); }
        break;
      }
      case 's': case 'S':
        if (dvcState.selectedId) { e.preventDefault(); dvcCaptureScreenshot(dvcState.selectedId); }
        break;
      case 'r': case 'R': {
        const b = document.getElementById('dvc-refresh-btn');
        if (b) { e.preventDefault(); b.click(); }
        break;
      }
    }
  });
}

/* ---- Chrome buttons --------------------------------------- */

function dvcBindChrome() {
  const doctor = document.getElementById('dvc-doctor-btn');
  if (doctor) {
    doctor.innerHTML = dvcIcon('activity', 15, 2.2);
    doctor.addEventListener('click', dvcOpenDoctor);
  }

  const settings = document.getElementById('dvc-settings-btn');
  if (settings) {
    settings.innerHTML = dvcIcon('settings', 15, 2);
    settings.addEventListener('click', () => {
      dvcToast('Settings', 'Port and token settings arrive with the local helper.', 'info');
    });
  }
}

/* A trimmed environment check for the WebUSB-only phase. The full
   tool-by-tool report belongs to the helper. */
function dvcOpenDoctor() {
  const modal = document.getElementById('dvc-modal');
  if (!modal) return;

  const rows = [
    ['Browser WebUSB', dvcState.webusbSupported ? 'available' : 'not implemented in this browser'],
    ['Secure context', window.isSecureContext ? 'yes' : 'no — WebUSB requires HTTPS or localhost'],
    ['Page mode', dvcState.mode],
    ['Asset base', window.DVC_ASSET_BASE || '—'],
    ['UI version', DVC_VERSION],
    ['Devices seen', String(dvcState.devices.length)],
    ['Local helper', 'not running (iOS unavailable)']
  ];

  modal.replaceChildren(dvcEl('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
    dvcEl('h2', { text: 'Environment check' }),
    dvcEl('p', { text: 'What this page can currently do, and why.' }),
    dvcEl('div', { class: 'dvc-idgrid', style: 'grid-template-columns:1fr' },
      rows.map(([k, v]) => dvcIdRow(k, v, { muted: true, noCopy: true }))),
    dvcEl('div', { class: 'modal-actions' }, [
      dvcEl('button', {
        class: 'btn btn-secondary', type: 'button', text: 'Copy as text',
        onclick: e => dvcCopy(rows.map(r => r[0] + ': ' + r[1]).join('\n'), e.currentTarget)
      }),
      dvcEl('button', {
        class: 'btn btn-primary', type: 'button', text: 'Close',
        onclick: () => modal.classList.add('hidden')
      })
    ])
  ]));
  modal.classList.remove('hidden');
}

/* ---- Boot ------------------------------------------------- */

async function dvcBoot() {
  dvcResolveEnv();

  /* Feature-detect, never sniff. */
  dvcState.webusbSupported = typeof navigator !== 'undefined' && !!navigator.usb;

  dvcBindChrome();
  dvcBindList();
  dvcBindKeys();

  /* One place reacts to a device-set change, so backends stay render-free. */
  dvcOn('devices', () => {
    dvcRenderTopbar();
    dvcSyncView();
    /* Keep the open detail pane honest when a state changes underneath it. */
    if (dvcState.selectedId) {
      const d = dvcFindDevice(dvcState.selectedId);
      if (d && d.state !== 'ready' && dvcState.detail) {
        dvcState.detail = null;
        dvcRenderDetail(d.id);
      } else if (d && d.state === 'ready' && !dvcState.detail) {
        dvcRenderDetail(d.id);
      }
    }
  });

  dvcRenderTopbar();
  dvcSyncView();

  for (const b of dvcActiveBackends()) {
    try {
      if (b.start) await b.start();
    } catch (err) {
      console.warn('[dvc] backend "' + b.kind + '" failed to start', err);
    }
  }

  dvcAnnounce('Device Lab ready.');
  console.info('[dvc] boot', {
    ui: DVC_VERSION,
    mode: dvcState.mode,
    apiBase: dvcState.apiBase,
    assetBase: window.DVC_ASSET_BASE,
    secureContext: window.isSecureContext,
    webusb: dvcState.webusbSupported,
    backends: dvcActiveBackends().map(b => b.kind)
  });
}

window.dvcBoot = dvcBoot;
