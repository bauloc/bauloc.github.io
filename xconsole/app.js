/* ============================================================
   XConsole - Core App
   ============================================================ */

const GITHUB_REPO = 'bauloc/bauloc.github.io';
const GITHUB_API  = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/';
const RAW_BASE    = 'https://raw.githubusercontent.com/' + GITHUB_REPO + '/master/';

/* ---- PAT Management ---------------------------------------- */

function getToken() {
  return localStorage.getItem('xconsole_pat') || '';
}

function saveToken(token) {
  localStorage.setItem('xconsole_pat', token.trim());
}

/* ---- GitHub API Helpers ------------------------------------ */

/**
 * Read a file from the repo.
 * Returns { sha, content (decoded string) } or null if not found.
 */
async function githubReadFile(path) {
  const token = getToken();
  const res = await fetch(GITHUB_API + path, {
    headers: { Authorization: 'token ' + token }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub API error: ' + res.status);
  const data = await res.json();
  return {
    sha: data.sha,
    content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))
  };
}

/**
 * Write (create or update) a file in the repo.
 * content is a plain string (UTF-8 safe).
 */
async function githubWriteFile(path, content, message) {
  const token = getToken();
  // Get current SHA if the file exists (needed for updates)
  let sha;
  const existing = await githubReadFile(path);
  if (existing) sha = existing.sha;

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const body = { message, content: encoded };
  if (sha) body.sha = sha;

  const res = await fetch(GITHUB_API + path, {
    method: 'PUT',
    headers: {
      Authorization: 'token ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.status === 401) throw new Error('AUTH_ERROR');
  if (res.status === 409) throw new Error('CONFLICT');
  if (!res.ok) throw new Error('GitHub write error: ' + res.status);
  return res.json();
}

/**
 * Delete a file from the repo.
 */
async function githubDeleteFile(path, message) {
  const token = getToken();
  const existing = await githubReadFile(path);
  if (!existing) return; // already gone
  const res = await fetch(GITHUB_API + path, {
    method: 'DELETE',
    headers: {
      Authorization: 'token ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, sha: existing.sha })
  });
  if (res.status === 401) throw new Error('AUTH_ERROR');
  if (!res.ok && res.status !== 404) throw new Error('GitHub delete error: ' + res.status);
}

/**
 * Read a file using raw.githubusercontent.com (no auth, faster for public repos).
 */
async function rawReadFile(path) {
  const res = await fetch(RAW_BASE + path + '?t=' + Date.now());
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Raw read error: ' + res.status);
  return res.text();
}

/* ---- Toast ------------------------------------------------- */

function showToast(title, msg, type = 'info', duration = 5000) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
    </div>
    <button class="toast-close" aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  `;

  const container = document.getElementById('toast-container');
  container.appendChild(toast);

  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());

  if (duration > 0) setTimeout(() => toast.remove(), duration);
  return toast;
}

/* ---- Copy to Clipboard ------------------------------------- */

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 2000);
  } catch {
    showToast('Copy failed', 'Please copy manually', 'error');
  }
}

/* ---- Slug Generator --------------------------------------- */

function generateSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/* ---- Saving Progress Indicator ---------------------------- */

function showSaving(text) {
  let el = document.getElementById('saving-progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'saving-progress';
    el.className = 'saving-progress';
    el.innerHTML = `<div class="spinner"></div><div class="saving-progress-text"></div>`;
    document.body.appendChild(el);
  }
  el.querySelector('.saving-progress-text').textContent = text;
  el.classList.remove('hidden');
}

function hideSaving() {
  const el = document.getElementById('saving-progress');
  if (el) el.classList.add('hidden');
}

/* ---- Router ----------------------------------------------- */

const modules = {};

function registerModule(id, initFn) {
  modules[id] = initFn;
}

function navigateTo(moduleId) {
  // Update nav active state
  document.querySelectorAll('.nav-item[data-module]').forEach(el => {
    el.classList.toggle('active', el.dataset.module === moduleId);
  });

  // Load module
  const init = modules[moduleId];
  if (init) {
    init(document.getElementById('module-content'));
  } else {
    document.getElementById('module-content').innerHTML =
      '<div class="module-body"><p>Module not found.</p></div>';
  }
}

/* ---- PAT Modal ------------------------------------------- */

function showPatModal() {
  document.getElementById('pat-modal').classList.remove('hidden');
  document.getElementById('pat-input').value = '';
  document.getElementById('pat-input').focus();
}

function hidePatModal() {
  document.getElementById('pat-modal').classList.add('hidden');
}

/* ---- Settings Modal -------------------------------------- */

function showSettingsModal() {
  document.getElementById('settings-pat-input').value = getToken();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

/* ---- Init ------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  // PAT setup
  document.getElementById('pat-save-btn').addEventListener('click', () => {
    const val = document.getElementById('pat-input').value.trim();
    if (!val) { showToast('Token required', 'Please enter your GitHub PAT', 'error'); return; }
    saveToken(val);
    hidePatModal();
    boot();
  });

  // Settings
  document.getElementById('open-settings-btn').addEventListener('click', showSettingsModal);
  document.getElementById('settings-cancel-btn').addEventListener('click', hideSettingsModal);
  document.getElementById('settings-save-btn').addEventListener('click', () => {
    const val = document.getElementById('settings-pat-input').value.trim();
    if (!val) { showToast('Token required', '', 'error'); return; }
    saveToken(val);
    hideSettingsModal();
    showToast('Saved', 'Token updated', 'success');
  });

  document.getElementById('settings-logout-btn').addEventListener('click', () => {
    localStorage.removeItem('xconsole_pat');
    hideSettingsModal();
    showPatModal();
  });

  // Sidebar nav
  document.querySelectorAll('.nav-item[data-module]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.module);
    });
  });

  boot();
});

function boot() {
  if (!getToken()) {
    showPatModal();
    return;
  }
  // Navigate to first module (term-privacy)
  navigateTo('term-privacy');
}
