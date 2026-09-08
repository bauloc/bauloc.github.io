/* ============================================================
   Device Lab — device list

   The one rule that matters here: the list PATCHES in place, it never
   re-renders wholesale. The house pattern (container.innerHTML =
   template, then re-bind) is right for xconsole, where a render is
   user-triggered. Here updates arrive every few seconds, and a full
   re-render would kill focus in the filter box, reset the scroll
   position, drop drag-hover state and wipe an in-flight progress bar —
   four bugs from one convenience.
   ============================================================ */

let dvcListFilter = '';
const dvcFacetState = { android: true, ios: true };

/* Everything that appears on a card, joined. Unchanged signature ⇒ zero
   DOM work for that row. */
function dvcDeviceSig(d) {
  return [d.state, d.name, d.osVersion, d.platform, d.connection, (d.blockers || []).join(',')].join('|');
}

function dvcDeviceVisible(d) {
  if (!dvcFacetState[d.platform]) return false;
  if (!dvcListFilter) return true;
  const hay = [d.name, d.model, d.id, d.osVersion, d.platform].join(' ').toLowerCase();
  return hay.includes(dvcListFilter);
}

/* ---- Facets: one table, platform filter with live counts ---- */

function dvcRenderFacets() {
  const host = document.getElementById('dvc-facets');
  if (!host) return;

  const counts = { android: 0, ios: 0 };
  for (const d of dvcState.devices) counts[d.platform] = (counts[d.platform] || 0) + 1;

  host.replaceChildren(...['android', 'ios'].map(platform => {
    const on = dvcFacetState[platform];
    const label = platform === 'ios' ? 'iOS' : 'Android';
    return dvcEl('button', {
      type: 'button',
      class: 'badge ' + (on ? 'badge-' + platform : 'badge-muted'),
      style: 'border:1px solid ' + (on ? 'transparent' : 'var(--border)') + ';cursor:pointer;padding:4px 11px',
      'aria-pressed': on ? 'true' : 'false',
      text: label + ' (' + (counts[platform] || 0) + ')',
      onclick: () => {
        dvcFacetState[platform] = !dvcFacetState[platform];
        dvcRenderFacets();
        dvcRenderDeviceList(dvcState.devices);
      }
    });
  }));
}

/* ---- Card ------------------------------------------------- */

function dvcDeviceCardEl(d) {
  const li = dvcEl('li', {
    class: 'dvc-device',
    dataset: { deviceId: d.id, platform: d.platform, sig: '' },
    style: 'position:relative;border:1px solid var(--border);border-radius:var(--radius);' +
           'padding:12px 14px;background:var(--card-bg);cursor:pointer;transition:border-color .15s,box-shadow .15s'
  });

  /* A stretched-link button, so the whole card is one keyboard-reachable
     control without nesting interactive elements inside a <button>. */
  li.appendChild(dvcEl('button', {
    type: 'button',
    class: 'dvc-device-hit',
    style: 'position:absolute;inset:0;background:none;border:none;cursor:pointer;border-radius:var(--radius)',
    'aria-pressed': 'false',
    onclick: () => dvcSelectDevice(d.id)
  }, [dvcEl('span', { class: 'dvc-sr', text: 'Select ' + d.name })]));

  li.appendChild(dvcEl('div', { class: 'dvc-device-main', style: 'position:relative;pointer-events:none' }));
  dvcUpdateDeviceCardEl(li, d);
  return li;
}

function dvcUpdateDeviceCardEl(li, d) {
  const meta = DVC_STATE_META[d.state] || DVC_STATE_META.unknown;
  const main = li.querySelector('.dvc-device-main');
  const hint = dvcHintFor(d);

  main.replaceChildren(
    dvcEl('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' }, [
      dvcEl('span', { class: 'dvc-dot', dataset: { st: meta.tone }, 'aria-hidden': 'true' }),
      /* Device names are user-editable on the phone, so textContent. */
      dvcEl('span', { style: 'font-size:15.5px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: d.name }),
      dvcEl('span', { style: 'flex:1' }),
      dvcEl('span', { style: 'font-size:13px;font-weight:600;color:var(--text-muted)', text: meta.label })
    ]),
    dvcEl('div', { class: 'card-meta' }, [
      dvcEl('span', {
        class: 'badge badge-' + d.platform,
        text: (d.platform === 'ios' ? 'iOS' : 'Android') + (d.osVersion ? ' ' + d.osVersion : '')
      }),
      d.connection === 'network' ? dvcEl('span', { class: 'badge badge-muted', text: 'Wi-Fi' }) : null,
      dvcEl('span', {
        style: 'font-family:var(--mono);font-size:12.5px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0',
        text: d.id
      })
    ]),
    hint ? dvcEl('div', {
      style: 'margin-top:8px;font-size:13px;line-height:1.5;color:var(--text-muted);' +
             'border-left:2px solid var(--' + (meta.tone === 'bad' ? 'danger' : 'warn') + ');padding-left:8px',
      text: hint.title
    }) : null
  );

  li.dataset.sig = dvcDeviceSig(d);
  li.classList.toggle('selected', d.id === dvcState.selectedId);
  li.style.borderColor = d.id === dvcState.selectedId ? 'var(--accent)' : 'var(--border)';
  li.style.boxShadow = d.id === dvcState.selectedId ? '0 0 0 3px rgba(79,110,247,0.12)' : 'none';

  const hit = li.querySelector('.dvc-device-hit');
  if (hit) hit.setAttribute('aria-pressed', d.id === dvcState.selectedId ? 'true' : 'false');
}

/* ---- Patch, don't re-render ------------------------------- */

function dvcRenderDeviceList(devices) {
  const root = document.getElementById('dvc-list');
  const empty = document.getElementById('dvc-list-empty');
  if (!root) return;

  dvcRenderFacets();

  const visible = devices.filter(dvcDeviceVisible);
  const seen = new Set();

  visible.forEach((d, i) => {
    seen.add(d.id);
    let el = root.querySelector('[data-device-id="' + CSS.escape(d.id) + '"]');
    if (!el) {
      el = dvcDeviceCardEl(d);
      root.appendChild(el);
    } else if (el.dataset.sig !== dvcDeviceSig(d)) {
      dvcUpdateDeviceCardEl(el, d);
    } else {
      /* Selection is not part of the signature — keep it in sync cheaply. */
      const isSel = d.id === dvcState.selectedId;
      el.style.borderColor = isSel ? 'var(--accent)' : 'var(--border)';
      el.style.boxShadow = isSel ? '0 0 0 3px rgba(79,110,247,0.12)' : 'none';
    }
    if (root.children[i] !== el) root.insertBefore(el, root.children[i]);
  });

  Array.from(root.children).forEach(el => {
    if (!seen.has(el.dataset.deviceId)) el.remove();
  });

  const nothing = visible.length === 0;
  root.classList.toggle('hidden', nothing);
  if (empty) {
    empty.classList.toggle('hidden', !nothing);
    if (nothing) dvcRenderListEmpty(empty, devices.length > 0);
  }

  /* If the selected device disappeared, say so rather than silently
     redirecting — STF's no-device controller redirects with no message
     and it is a genuine UX bug worth not repeating. */
  if (dvcState.selectedId && !devices.some(d => d.id === dvcState.selectedId)) {
    dvcMarkSelectedGone();
  }
}

function dvcRenderListEmpty(host, filteredOut) {
  host.replaceChildren();
  host.appendChild(dvcEl('div', { class: 'empty-state-icon', html: dvcIcon('smartphone', 56, 1.5) }));
  host.appendChild(dvcEl('h3', { text: filteredOut ? 'Nothing matches this filter' : 'No devices yet' }));
  host.appendChild(dvcEl('p', {
    text: filteredOut
      ? 'Clear the filter or switch the platform toggles back on.'
      : 'Connect a phone over USB, then add it.'
  }));
  if (!filteredOut) {
    host.appendChild(dvcEl('button', {
      class: 'btn btn-primary',
      type: 'button',
      html: dvcIcon('plus', 14, 2.5) + ' Add device',
      onclick: dvcRequestAndroidDevice
    }));
  }
}

function dvcMarkSelectedGone() {
  const lost = dvcState.selectedId;
  dvcState.selectedId = null;
  dvcState.detail = null;
  const pane = document.getElementById('dvc-detail');
  if (pane) {
    pane.replaceChildren(dvcEl('div', { class: 'empty-state' }, [
      dvcEl('div', { class: 'empty-state-icon', html: dvcIcon('alert', 56, 1.5) }),
      dvcEl('h3', { text: 'That device disconnected' }),
      dvcEl('p', { text: lost + ' is no longer attached. Reconnect the cable and it will reappear in the list.' })
    ]));
  }
  dvcAnnounce('The selected device disconnected.');
}

/* ---- Selection -------------------------------------------- */

async function dvcSelectDevice(id) {
  dvcState.selectedId = id;
  dvcRenderDeviceList(dvcState.devices);
  await dvcRenderDetail(id);
}

/* ---- Entry point for the Android picker -------------------- */

/* Must run inside a click handler: requestDevice() is rejected without
   transient activation. */
async function dvcRequestAndroidDevice() {
  const backend = dvcBackend('webusb');
  if (!backend || !backend.isAvailable()) {
    dvcToast('WebUSB not available',
      'Firefox and Safari do not implement WebUSB. Use Chrome or Edge, or run the local helper.', 'error');
    return;
  }
  try {
    const id = await backend.requestDevice();
    if (!id) return;                          // picker dismissed — not an error
    await dvcSelectDevice(id);
  } catch (err) {
    console.warn('[dvc] requestDevice failed', err);
    if (err && /No device selected/i.test(err.message || '')) return;
    dvcToast('Could not open that device', err && err.message ? err.message : 'Unknown error', 'error');
  }
}

/* ---- List chrome ------------------------------------------ */

function dvcBindList() {
  const filter = document.getElementById('dvc-list-filter');
  if (filter) {
    filter.addEventListener('input', () => {
      dvcListFilter = filter.value.trim().toLowerCase();
      dvcRenderDeviceList(dvcState.devices);
    });
  }

  const refresh = document.getElementById('dvc-refresh-btn');
  if (refresh) {
    refresh.innerHTML = dvcIcon('refresh', 15, 2);
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        for (const b of dvcActiveBackends()) {
          if (b.start) await b.start();
          if (b.retryHeld) await b.retryHeld();   // Refresh is a recovery action
        }
        await dvcUsbSync();
      } finally {
        refresh.disabled = false;
      }
    });
  }

  dvcOn('devices', devices => dvcRenderDeviceList(devices));
}
