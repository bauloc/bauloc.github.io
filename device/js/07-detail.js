/* ============================================================
   Device Lab — device detail: identifiers, hints, screenshots

   Field names follow Apple's and Google's own vocabulary ("Identifier",
   "Model", "Capacity", "Take Screenshot") rather than invented ones —
   testers already know those words, and every new word costs support
   time.

   The highest-value control on this pane is "Copy all as Markdown":
   the identifier block is the part people otherwise retype by hand
   into a ticket.
   ============================================================ */

const DVC_SHOT_LIMIT = 12;

function dvcDetailBackend(device) {
  return device ? dvcBackend(device.backend) : null;
}

/* ---- Row / section rendering ------------------------------ */

function dvcIdRow(label, value, opts) {
  const o = opts || {};
  const text = value == null ? '' : String(value);
  const row = dvcEl('div', { class: 'dvc-idrow' }, [
    dvcEl('span', { class: 'dvc-idlabel', text: label }),
    /* Device-supplied, so textContent — never innerHTML. */
    dvcEl('span', {
      class: 'dvc-idvalue' + (o.muted ? ' muted' : ''),
      text: text || '—',
      title: text
    })
  ]);
  if (text && !o.noCopy) {
    row.appendChild(dvcEl('button', {
      class: 'url-copy-btn',
      type: 'button',
      text: 'Copy',
      'aria-label': 'Copy ' + label,
      onclick: e => dvcCopy(text, e.currentTarget)
    }));
  }
  return row;
}

function dvcDetailSection(title, fields, extraControls) {
  const rows = Object.entries(fields || {}).filter(([, v]) => v !== '' && v != null);
  if (!rows.length) return null;

  const head = dvcEl('div', { class: 'dvc-section-title' }, [dvcEl('span', { text: title })]);
  if (extraControls) for (const c of [].concat(extraControls)) head.appendChild(c);

  return dvcEl('div', { class: 'dvc-section' }, [
    head,
    dvcEl('div', { class: 'dvc-idgrid' },
      rows.map(([k, v]) => dvcIdRow(k, v, { muted: /note$/i.test(k), noCopy: /note$/i.test(k) })))
  ]);
}

/* ---- Hint card -------------------------------------------- */

function dvcHintCard(device, hint) {
  const meta = DVC_STATE_META[device.state] || DVC_STATE_META.unknown;
  const card = dvcEl('div', { class: 'dvc-hintcard', dataset: { tone: meta.tone } }, [
    dvcEl('h4', { text: hint.title }),
    dvcEl('p', { text: hint.body })
  ]);

  const actions = dvcEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center' });

  for (const fix of hint.fixes || []) {
    if (fix.copy) {
      actions.appendChild(dvcEl('button', {
        class: 'btn ' + (fix.primary ? 'btn-primary' : 'btn-secondary'),
        type: 'button',
        text: fix.label,
        onclick: e => dvcCopy(fix.copy, e.currentTarget)
      }));
    } else if (fix.action === 'retry') {
      actions.appendChild(dvcEl('button', {
        class: 'btn ' + (fix.primary ? 'btn-primary' : 'btn-secondary'),
        type: 'button',
        text: fix.label,
        onclick: async e => {
          const b = dvcDetailBackend(device);
          if (!b || !b.retry) return;
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Reconnecting…';
          try {
            await b.retry(device.id);
          } finally {
            await dvcRenderDetail(device.id);
          }
        }
      }));
    } else if (fix.action === 'doctor') {
      actions.appendChild(dvcEl('button', {
        class: 'btn btn-secondary', type: 'button', text: fix.label,
        onclick: dvcOpenDoctor
      }));
    }
  }

  if (actions.childNodes.length) card.appendChild(actions);

  if (hint.extra) {
    card.appendChild(dvcEl('p', {
      style: 'margin:10px 0 0;font-size:13px',
      text: hint.extra
    }));
  }
  return card;
}

/* ---- Main render ------------------------------------------ */

async function dvcRenderDetail(id) {
  const pane = document.getElementById('dvc-detail');
  if (!pane) return;

  const device = dvcFindDevice(id);
  if (!device) { dvcMarkSelectedGone(); return; }

  const meta = DVC_STATE_META[device.state] || DVC_STATE_META.unknown;
  const canAct = device.state === 'ready';

  /* --- header (always renders, even when the device is not ready) --- */
  const head = dvcEl('div', { class: 'dvc-detail-head' }, [
    dvcEl('div', { class: 'dvc-detail-title' }, [
      dvcEl('span', { class: 'dvc-dot', dataset: { st: meta.tone }, 'aria-hidden': 'true' }),
      dvcEl('span', { class: 'dvc-detail-name', text: device.name }),
      dvcEl('span', {
        class: 'badge badge-' + device.platform,
        text: (device.platform === 'ios' ? 'iOS' : 'Android') + (device.osVersion ? ' ' + device.osVersion : '')
      }),
      dvcEl('span', { style: 'font-size:13.5px;font-weight:600;color:var(--text-muted)', text: meta.label })
    ])
  ]);

  const actions = dvcEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' }, [
    dvcEl('button', {
      class: 'btn btn-primary', type: 'button', id: 'dvc-shot-btn',
      disabled: !canAct,
      title: canAct ? 'Take a screenshot (S)' : 'Device is not ready',
      html: dvcIcon('camera', 14, 2.5) + ' Take Screenshot',
      onclick: () => dvcCaptureScreenshot(device.id)
    }),
    dvcEl('button', {
      class: 'btn btn-secondary', type: 'button',
      disabled: !canAct,
      html: dvcIcon('clipboard', 14, 2.5) + ' Copy all as Markdown',
      onclick: e => dvcCopyDetailMarkdown(device, e.currentTarget)
    })
  ]);
  head.appendChild(actions);

  const body = dvcEl('div', { class: 'dvc-detail-body' });

  const hint = dvcHintFor(device);
  if (hint) body.appendChild(dvcHintCard(device, hint));

  pane.replaceChildren(head, body);

  if (!canAct) {
    body.appendChild(dvcEl('p', {
      style: 'font-size:14.5px;color:var(--text-muted);line-height:1.6',
      text: 'Identifiers appear once the device is ready.'
    }));
    return;
  }

  /* --- detail is a device round trip, so show progress --- */
  body.appendChild(dvcEl('div', { class: 'loading-spinner', id: 'dvc-detail-loading' }, [
    dvcEl('div', { class: 'spinner' })
  ]));

  let detail;
  try {
    const backend = dvcDetailBackend(device);
    detail = await backend.detail(device.id);
  } catch (err) {
    console.warn('[dvc] detail failed', err);
    body.replaceChildren(dvcEl('div', { class: 'dvc-hintcard', dataset: { tone: 'bad' } }, [
      dvcEl('h4', { text: 'Could not read details from ' + device.name }),
      dvcEl('p', { text: err && err.message ? err.message : 'Unknown error' }),
      dvcEl('button', {
        class: 'btn btn-secondary', type: 'button', text: 'Retry',
        onclick: () => dvcRenderDetail(device.id)
      })
    ]));
    return;
  }

  /* The selection may have moved while we awaited. */
  if (dvcState.selectedId !== device.id) return;
  dvcState.detail = detail;

  const loading = document.getElementById('dvc-detail-loading');
  if (loading) loading.remove();

  const sections = [
    dvcDetailSection('Identity', detail.identity),
    dvcDetailSection('Software', detail.software),
    dvcDetailSection('Hardware', detail.hardware),
    dvcDetailSection('Status', detail.status)
  ].filter(Boolean);

  for (const s of sections) body.appendChild(s);
  body.appendChild(dvcRenderShotSection(device.id));
}

/* ---- Copy-all as Markdown --------------------------------- */

function dvcCopyDetailMarkdown(device, btn) {
  const d = dvcState.detail;
  if (!d) return;

  const lines = ['| | |', '|---|---|'];
  const push = (k, v) => { if (v) lines.push('| ' + k + ' | `' + String(v).replace(/\|/g, '\\|') + '` |'); };

  for (const group of ['identity', 'software', 'hardware', 'status']) {
    for (const [k, v] of Object.entries(d[group] || {})) {
      if (/note$/i.test(k)) continue;              // notes are UI guidance, not data
      push(k, v);
    }
  }
  lines.push('| Captured | ' + dvcFmtIsoOffset(new Date()) + ' |');

  dvcCopy(lines.join('\n'), btn);
}

/* ---- Screenshots ------------------------------------------ */

function dvcShotFilename(device, at) {
  const stamp = dvcFmtIsoOffset(at).replace(/[:+]/g, '-').replace(/\..*$/, '');
  const slug = String(device.name || device.id).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';
  return slug + '_' + stamp + '.png';
}

async function dvcCaptureScreenshot(deviceId) {
  const device = dvcFindDevice(deviceId);
  if (!device) return;
  const backend = dvcDetailBackend(device);
  if (!backend || !backend.screenshot) return;

  const btn = document.getElementById('dvc-shot-btn');
  if (btn) btn.disabled = true;
  dvcBusy('Capturing screenshot…');

  try {
    const blob = await backend.screenshot(deviceId);
    const at = new Date();
    const shot = {
      id: 'shot_' + at.getTime(),
      deviceId,
      deviceName: device.name,
      blob,
      /* A blob URL, never a token-bearing src: <img> cannot carry an
         Authorization header, and a token in a URL lands in history. */
      url: URL.createObjectURL(blob),
      at,
      name: dvcShotFilename(device, at)
    };
    dvcState.shots.unshift(shot);
    while (dvcState.shots.length > DVC_SHOT_LIMIT) {
      const dropped = dvcState.shots.pop();
      URL.revokeObjectURL(dropped.url);            // revoke or leak
    }
    dvcRefreshShotSection();
    dvcAnnounce('Screenshot captured from ' + device.name + '.');
  } catch (err) {
    console.warn('[dvc] screenshot failed', err);
    const msg = err && err.message === 'SCREENSHOT_NOT_PNG'
      ? 'The device returned something that is not a PNG. Try again, or reconnect the cable.'
      : (err && err.message) || 'Unknown error';
    dvcToast('Screenshot failed on ' + device.name, msg, 'error');
  } finally {
    dvcBusyDone();
    if (btn) btn.disabled = false;
  }
}

function dvcShotZoom() {
  const z = Number(dvcState.prefs.shotZoom);
  return z >= 80 && z <= 480 ? z : 160;
}

function dvcRenderShotSection(deviceId) {
  const shots = dvcState.shots.filter(s => s.deviceId === deviceId);

  const zoom = dvcEl('div', { class: 'dvc-zoom' }, [
    dvcEl('span', { text: 'Size' }),
    dvcEl('input', {
      type: 'range', min: '80', max: '480', step: '20', value: String(dvcShotZoom()),
      'aria-label': 'Thumbnail size',
      oninput: e => {
        dvcState.prefs.shotZoom = Number(e.currentTarget.value);
        dvcSavePrefs();
        const strip = document.getElementById('dvc-shotstrip');
        if (strip) strip.style.setProperty('--shot-w', dvcShotZoom() + 'px');
      }
    })
  ]);

  const clearBtn = dvcEl('button', {
    class: 'btn btn-icon', type: 'button', text: 'Clear',
    disabled: shots.length === 0,
    onclick: () => {
      for (const s of dvcState.shots.filter(s => s.deviceId === deviceId)) URL.revokeObjectURL(s.url);
      dvcState.shots = dvcState.shots.filter(s => s.deviceId !== deviceId);
      dvcRefreshShotSection();
    }
  });

  const section = dvcEl('div', { class: 'dvc-section', id: 'dvc-shot-section' }, [
    dvcEl('div', { class: 'dvc-section-title' }, [
      dvcEl('span', { text: 'Screenshots' }),
      dvcEl('span', { style: 'flex:1' }),
      zoom,
      clearBtn
    ])
  ]);

  if (!shots.length) {
    section.appendChild(dvcEl('div', { class: 'empty-state', style: 'padding:32px 16px' }, [
      dvcEl('div', { class: 'empty-state-icon', html: dvcIcon('camera', 40, 1.5) }),
      dvcEl('h3', { text: 'No screenshots taken' })
    ]));
    return section;
  }

  const strip = dvcEl('div', {
    class: 'dvc-shotstrip',
    id: 'dvc-shotstrip',
    style: '--shot-w:' + dvcShotZoom() + 'px'
  });

  for (const shot of shots) {
    strip.appendChild(dvcEl('div', { class: 'dvc-shot' }, [
      dvcEl('a', { href: shot.url, target: '_blank', rel: 'noopener', title: 'Open full size' }, [
        dvcEl('img', { src: shot.url, alt: 'Screenshot of ' + shot.deviceName + ' at ' + dvcFmtClock(shot.at), loading: 'lazy' })
      ]),
      dvcEl('div', { class: 'dvc-shot-meta' }, [
        dvcEl('span', { text: dvcFmtClock(shot.at) }),
        dvcEl('span', { style: 'flex:1' }),
        dvcEl('button', {
          class: 'url-copy-btn', type: 'button', text: 'Copy',
          'aria-label': 'Copy image to clipboard',
          onclick: e => dvcShotCopyImage(shot, e.currentTarget)
        }),
        dvcEl('a', {
          class: 'url-copy-btn', href: shot.url, download: shot.name,
          style: 'text-decoration:none', text: 'Save'
        })
      ])
    ]));
  }

  section.appendChild(strip);
  return section;
}

function dvcRefreshShotSection() {
  const old = document.getElementById('dvc-shot-section');
  if (!old || !dvcState.selectedId) return;
  old.replaceWith(dvcRenderShotSection(dvcState.selectedId));
}

function dvcShotCopyImage(shot, btn) {
  if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
    dvcToast('Copy image unsupported',
      'This browser cannot put images on the clipboard. Use Save instead.', 'error');
    return;
  }
  /* Hand ClipboardItem a PROMISE rather than awaiting the blob first:
     Safari loses the user gesture across an await and rejects the write. */
  const item = new ClipboardItem({ 'image/png': Promise.resolve(shot.blob) });
  navigator.clipboard.write([item]).then(
    () => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      dvcAnnounce('Screenshot copied to clipboard');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);
    },
    err => dvcToast('Copy image failed', (err && err.message) || 'Clipboard write was rejected.', 'error')
  );
}
