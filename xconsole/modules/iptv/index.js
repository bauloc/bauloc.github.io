/* ============================================================
   XConsole Module: IPTV
   ============================================================ */

const IPTV_DEFAULT_SOURCE = 'https://raw.githubusercontent.com/giangnam0201/All-In-One-IPTV/main/channels.m3u';
const IPTV_TARGET_PATH    = 'iptv';
const IPTV_META_PATH      = 'xconsole/modules/iptv/data/meta.json';
const IPTV_PUBLIC_URL     = 'https://bauloc.github.io/iptv';

/* ---- Date Formatter --------------------------------------- */

function iptvFormatDateTime(isoStr) {
  if (!isoStr) return 'Never';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return 'Unknown';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---- Render ----------------------------------------------- */

async function initIPTV(container) {
  container.innerHTML = `
    <div class="module-header">
      <div class="module-title">IPTV</div>
    </div>
    <div class="module-body">
      <div class="loading-spinner"><div class="spinner"></div></div>
    </div>
  `;

  let meta = { last_synced_at: null, channel_count: 0, source_url: IPTV_DEFAULT_SOURCE };
  try {
    const raw = await rawReadFile(IPTV_META_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      meta = {
        last_synced_at: parsed.last_synced_at || null,
        channel_count:  parsed.channel_count  || 0,
        source_url:     parsed.source_url     || IPTV_DEFAULT_SOURCE
      };
    }
  } catch {
    // Fall back to defaults if meta is missing/corrupt.
  }

  renderIPTV(container, meta);
}

function renderIPTV(container, meta) {
  const lastSync = iptvFormatDateTime(meta.last_synced_at);
  const channels = meta.channel_count || 0;

  container.innerHTML = `
    <div class="module-header">
      <div class="module-title">IPTV</div>
      <button class="btn btn-primary" id="iptv-sync-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M21 3v5h-5"/>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          <path d="M3 21v-5h5"/>
        </svg>
        SYNC
      </button>
    </div>
    <div class="module-body">
      <div class="card-list">
        <div class="card">
          <div class="form-group" style="margin-bottom:14px">
            <label for="iptv-source-input">Source URL</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="url" id="iptv-source-input" class="form-control"
                placeholder="https://example.com/playlist.m3u"
                value="${escapeAttr(meta.source_url)}" style="flex:1">
              <button class="btn btn-secondary" id="iptv-reset-btn" title="Reset to default URL">Reset</button>
            </div>
            <div class="form-hint">M3U/M3U8 playlist URL. Default: giangnam0201/All-In-One-IPTV.</div>
          </div>

          <div class="card-urls">
            <div class="card-url-row">
              <span class="url-label">Public</span>
              <a class="url-text" href="${IPTV_PUBLIC_URL}" target="_blank" rel="noopener">${IPTV_PUBLIC_URL}</a>
              <button class="url-copy-btn" data-url="${IPTV_PUBLIC_URL}">Copy</button>
            </div>
          </div>

          <div class="card-meta" style="margin-top:14px;font-size:12.5px;color:var(--text-muted);gap:14px">
            <span><strong style="color:var(--text)">Last sync:</strong> ${lastSync}</span>
            <span>&middot;</span>
            <span><strong style="color:var(--text)">${channels}</strong> channel${channels === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const input = container.querySelector('#iptv-source-input');

  container.querySelector('#iptv-sync-btn').addEventListener('click', () => {
    handleIPTVSync(input.value.trim(), container);
  });

  container.querySelector('#iptv-reset-btn').addEventListener('click', () => {
    input.value = IPTV_DEFAULT_SOURCE;
    input.focus();
  });

  container.querySelectorAll('.url-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.url, btn));
  });
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- Sync ------------------------------------------------- */

async function handleIPTVSync(sourceUrl, container) {
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    showToast('Invalid URL', 'Source must start with http:// or https://', 'error');
    return;
  }

  let m3u;
  showSaving('Fetching source...');
  try {
    const cacheBust = (sourceUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const res = await fetch(sourceUrl + cacheBust);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    m3u = await res.text();
  } catch (e) {
    hideSaving();
    showToast('Fetch failed', (e.message || 'Network error') + ' (check URL / CORS)', 'error');
    return;
  }

  if (!m3u.trimStart().startsWith('#EXTM3U')) {
    hideSaving();
    showToast('Invalid M3U', 'Response does not start with #EXTM3U', 'error');
    return;
  }

  const channelCount = (m3u.match(/^#EXTINF/gm) || []).length;
  const meta = {
    last_synced_at: new Date().toISOString(),
    channel_count:  channelCount,
    source_url:     sourceUrl
  };

  showSaving('Committing to GitHub...');
  try {
    let host = sourceUrl;
    try { host = new URL(sourceUrl).hostname; } catch {}
    await githubCommitMultiple({
      writes: [
        { path: IPTV_TARGET_PATH, content: m3u },
        { path: IPTV_META_PATH,   content: JSON.stringify(meta, null, 2) + '\n' }
      ],
      message: `iptv: sync ${channelCount} channels from ${host}`
    });
  } catch (e) {
    hideSaving();
    if (e.message === 'AUTH_ERROR') {
      showToast('Auth failed', 'GitHub token is invalid. Update it in Settings.', 'error');
    } else {
      showToast('Commit failed', e.message || 'Unknown error', 'error');
    }
    return;
  }

  hideSaving();
  showToast('Synced', `${channelCount} channels updated`, 'success');
  renderIPTV(container, meta);
}

/* ---- Register --------------------------------------------- */

registerModule('iptv', initIPTV);
