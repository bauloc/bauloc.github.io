/* ============================================================
   XConsole - DEV MODE
   Load this file ONLY for local testing.
   Remove from index.html before committing to GitHub.
   ============================================================ */

console.log('%c[XConsole DEV MODE]', 'color:#4f6ef7;font-weight:bold;font-size:13px', 'GitHub API mocked. No real commits will be made.');

/* ---- In-memory mock database ------------------------------ */

const _mockDB = {
  version: 1,
  updated_at: '2026-03-19T00:00:00Z',
  entries: [
    {
      slug: 'habit-tracker-app',
      app_name: 'Habit Tracker',
      created_at: '2026-03-10T08:00:00Z',
      updated_at: '2026-03-10T08:00:00Z',
      terms_url:   'https://bauloc.github.io/terms/habit-tracker-app/',
      privacy_url: 'https://bauloc.github.io/privacy/habit-tracker-app/',
      platform: ['ios']
    },
    {
      slug: 'weather-widget-pro',
      app_name: 'Weather Widget Pro',
      created_at: '2026-03-15T10:30:00Z',
      updated_at: '2026-03-15T10:30:00Z',
      terms_url:   'https://bauloc.github.io/terms/weather-widget-pro/',
      privacy_url: 'https://bauloc.github.io/privacy/weather-widget-pro/',
      platform: ['ios', 'android']
    },
    {
      slug: 'note-keeper',
      app_name: 'Note Keeper',
      created_at: '2026-03-18T14:00:00Z',
      updated_at: '2026-03-18T14:00:00Z',
      terms_url:   'https://bauloc.github.io/terms/note-keeper/',
      privacy_url: 'https://bauloc.github.io/privacy/note-keeper/',
      platform: ['android']
    }
  ]
};

const _mockPages = {
  'habit-tracker-app': {
    slug: 'habit-tracker-app',
    app_name: 'Habit Tracker',
    developer_name: 'Nguyen Van A',
    developer_email: 'dev@habitapp.com',
    website_url: 'https://habitapp.com',
    platform: ['ios'],
    app_description: 'A simple habit tracking app to help you build positive daily routines and achieve your personal goals.',
    effective_date: '2026-03-10',
    last_updated: '2026-03-10',
    data_collected: ['email', 'usage_data'],
    data_used_for: 'To sync your habits across devices and provide personalized insights.',
    third_party_services: ['Firebase'],
    has_account_creation: true,
    children_under_13: false,
    contact_email: 'privacy@habitapp.com',
    country: 'Vietnam',
    created_at: '2026-03-10T08:00:00Z',
    updated_at: '2026-03-10T08:00:00Z'
  },
  'weather-widget-pro': {
    slug: 'weather-widget-pro',
    app_name: 'Weather Widget Pro',
    developer_name: 'Tran Thi B',
    developer_email: 'hello@weatherpro.io',
    website_url: 'https://weatherpro.io',
    platform: ['ios', 'android'],
    app_description: 'Real-time weather forecasts and beautiful widgets for your home screen.',
    effective_date: '2026-03-15',
    last_updated: '2026-03-15',
    data_collected: ['location', 'device_info'],
    data_used_for: 'To provide accurate local weather forecasts based on your location.',
    third_party_services: ['OpenWeatherMap API'],
    has_account_creation: false,
    children_under_13: false,
    contact_email: 'privacy@weatherpro.io',
    country: 'Vietnam',
    created_at: '2026-03-15T10:30:00Z',
    updated_at: '2026-03-15T10:30:00Z'
  },
  'note-keeper': {
    slug: 'note-keeper',
    app_name: 'Note Keeper',
    developer_name: 'Le Van C',
    developer_email: 'support@notekeeper.app',
    website_url: '',
    platform: ['android'],
    app_description: 'A clean and fast note-taking app with markdown support.',
    effective_date: '2026-03-18',
    last_updated: '2026-03-18',
    data_collected: [],
    data_used_for: 'We do not collect any personal data. All notes are stored locally on your device.',
    third_party_services: [],
    has_account_creation: false,
    children_under_13: false,
    contact_email: 'support@notekeeper.app',
    country: 'Vietnam',
    created_at: '2026-03-18T14:00:00Z',
    updated_at: '2026-03-18T14:00:00Z'
  }
};

/* ---- Override GitHub API functions ----------------------- */

// Skip PAT check — always return a fake token
getToken = () => 'dev-fake-token';

// rawReadFile: return mock data based on path
rawReadFile = async (path) => {
  await _delay(300); // simulate network

  if (path.startsWith('xconsole/modules/term-privacy/data/db.json')) {
    return JSON.stringify(_mockDB);
  }

  const pagesPrefix = 'xconsole/modules/term-privacy/data/pages/';
  if (path.startsWith(pagesPrefix)) {
    const slug = path.replace(pagesPrefix, '').replace('.json', '').split('?')[0];
    const page = _mockPages[slug];
    return page ? JSON.stringify(page) : null;
  }

  return null;
};

// githubReadFile: simulate file existence check (for duplicate slug detection)
githubReadFile = async (path) => {
  await _delay(200);

  const pagesPrefix = 'xconsole/modules/term-privacy/data/pages/';
  if (path.startsWith(pagesPrefix)) {
    const slug = path.replace(pagesPrefix, '').replace('.json', '');
    return _mockPages[slug] ? { sha: 'mock-sha', content: '{}' } : null;
  }

  return null;
};

// githubWriteFile: simulate write, update in-memory data, log to console
githubWriteFile = async (path, content, message) => {
  await _delay(400); // simulate network

  console.log(`%c[DEV] githubWriteFile`, 'color:#38a169;font-weight:bold', '\n', message, '\n', path);

  // Update in-memory state so UI refreshes correctly
  const pagesPrefix = 'xconsole/modules/term-privacy/data/pages/';
  if (path.startsWith(pagesPrefix)) {
    const slug = path.replace(pagesPrefix, '').replace('.json', '');
    const data = JSON.parse(content);
    _mockPages[slug] = data;
  }

  if (path === 'xconsole/modules/term-privacy/data/db.json') {
    const db = JSON.parse(content);
    _mockDB.entries = db.entries;
    _mockDB.updated_at = db.updated_at;
  }

  // Simulate terms/privacy HTML writes (just log)
  if (path.startsWith('terms/') || path.startsWith('privacy/')) {
    console.log(`%c[DEV] HTML page would be written to: ${path}`, 'color:#718096');
  }

  return { commit: { sha: 'mock-commit-sha' } };
};

// githubDeleteFile: simulate delete, update in-memory data, log to console
githubDeleteFile = async (path, message) => {
  await _delay(300);

  console.log(`%c[DEV] githubDeleteFile`, 'color:#e53e3e;font-weight:bold', '\n', message, '\n', path);

  const pagesPrefix = 'xconsole/modules/term-privacy/data/pages/';
  if (path.startsWith(pagesPrefix)) {
    const slug = path.replace(pagesPrefix, '').replace('.json', '');
    delete _mockPages[slug];
  }
};

/* ---- Preview: intercept URL clicks to show generated HTML - */

document.addEventListener('click', e => {
  const link = e.target.closest('a.url-text[data-slug]');
  if (!link) return;

  e.preventDefault();

  const slug = link.dataset.slug;
  const type = link.dataset.type; // 'terms' or 'privacy'
  const data = _mockPages[slug];

  if (!data) {
    alert('Page data not found for slug: ' + slug);
    return;
  }

  // Generate HTML using the same templates as production
  const html = type === 'terms' ? TERMS_TEMPLATE(data) : PRIVACY_TEMPLATE(data);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
});

/* ---- Helper ---------------------------------------------- */

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
