/* ============================================================
   XConsole Module: Term & Privacy
   ============================================================ */

const TP_DB_PATH = 'xconsole/modules/term-privacy/data/db.json';
const TP_PAGES_PATH = 'xconsole/modules/term-privacy/data/pages/';
const BASE_URL = 'https://bauloc.github.io';

const DATA_COLLECTED_OPTIONS = [
  { id: 'name',         label: 'Name' },
  { id: 'email',        label: 'Email' },
  { id: 'location',     label: 'Location' },
  { id: 'device_info',  label: 'Device Info' },
  { id: 'usage_data',   label: 'Usage Data' },
  { id: 'camera',       label: 'Camera' },
  { id: 'microphone',   label: 'Microphone' },
  { id: 'contacts',     label: 'Contacts' },
  { id: 'payment',      label: 'Payment Info' },
];

const DATA_LABELS = {
  name:        'User name',
  email:       'Email address',
  location:    'Location data',
  device_info: 'Device information and identifiers',
  usage_data:  'App usage data and analytics',
  camera:      'Camera access',
  microphone:  'Microphone access',
  contacts:    'Contact list',
  payment:     'Payment information',
};

/* ---- Date Formatter --------------------------------------- */

function formatDate(isoStr) {
  if (!isoStr) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, m, d] = isoStr.split('-');
  return `${d}-${months[parseInt(m, 10) - 1]}-${y}`;
}

/* ---- Shared CSS helper ------------------------------------ */

function SHARED_CSS(rootVars) {
  return `<style>
${rootVars}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;font-size:16px;line-height:1.75;color:#334155;background:#f1f5f9}
.page-wrap{max-width:860px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 0 1px #e2e8f0}
/* Header */
.page-header{background:linear-gradient(135deg,var(--hdr-a) 0%,var(--hdr-b) 100%);padding:52px 52px 44px}
.page-type-label{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-mid);margin-bottom:12px}
.page-header h1{font-size:2.4rem;font-weight:800;color:#fff;line-height:1.15;letter-spacing:-.02em;margin-bottom:18px}
.header-meta{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:13px;color:#94a3b8;margin-bottom:24px}
.sibling-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 18px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:8px;color:#e2e8f0;font-size:13px;font-weight:600;text-decoration:none;transition:background .15s}
.sibling-btn:hover{background:rgba(255,255,255,.18);text-decoration:none}
.sibling-btn svg{opacity:.7}
/* Layout */
.layout-wrap{display:flex;align-items:flex-start}
.toc-col{width:210px;flex-shrink:0;position:sticky;top:0;max-height:100vh;overflow-y:auto;padding:36px 0 36px 28px;border-right:1px solid #e2e8f0}
.toc-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:14px;padding-left:10px}
.toc-list{list-style:none;display:flex;flex-direction:column;gap:1px}
.toc-list li a{display:block;font-size:12.5px;color:#64748b;text-decoration:none;padding:5px 10px;border-left:2px solid transparent;line-height:1.4;transition:color .12s,border-color .12s,background .12s;border-radius:0 4px 4px 0}
.toc-list li a:hover{color:var(--accent);border-left-color:var(--accent);background:var(--accent-dim)}
/* Content */
.content-col{flex:1;min-width:0;padding:48px 52px}
.intro-text{font-size:15.5px;color:#475569;margin-bottom:44px;padding-bottom:32px;border-bottom:1px solid #e2e8f0;line-height:1.8}
/* Sections */
.section-block{margin-bottom:52px;scroll-margin-top:24px}
.section-heading{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.section-num{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--accent);color:#fff;font-size:12px;font-weight:800;flex-shrink:0;letter-spacing:.02em}
.section-heading h2{font-size:1.05rem;font-weight:700;color:#1e293b;line-height:1.3}
.section-block p{font-size:15px;color:#475569;margin-bottom:12px;line-height:1.8}
.section-block p:last-child{margin-bottom:0}
.section-block strong{color:#1e293b;font-weight:600}
.section-block a{color:var(--accent);text-decoration:none}
.section-block a:hover{text-decoration:underline}
/* Pills */
.pill-list{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 13px;background:var(--accent-dim);border:1px solid var(--accent-mid);border-radius:99px;font-size:12.5px;font-weight:600;color:var(--accent-dark);white-space:nowrap}
.pill::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--accent);flex-shrink:0}
/* Contact box */
.contact-box{background:var(--accent-dim);border:1px solid var(--accent-mid);border-left:4px solid var(--accent);border-radius:10px;padding:20px 24px;margin-top:14px}
.contact-box p{margin-bottom:6px !important;font-size:14.5px !important}
.contact-box p:last-child{margin-bottom:0 !important}
/* Callout */
.callout{background:#fffbeb;border:1px solid #fcd34d;border-left:4px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-top:12px;font-size:14.5px;color:#78350f;line-height:1.7}
/* No data */
.no-data{font-size:15px;color:#64748b;font-style:italic;margin-top:4px}
/* Footer */
.page-footer{background:#f8fafc;border-top:1px solid #e2e8f0;padding:32px 52px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}
.footer-left{font-size:13px;color:#64748b;line-height:1.7}
.footer-left a{color:var(--accent);text-decoration:none}
.footer-left a:hover{text-decoration:underline}
.footer-sibling{display:inline-flex;align-items:center;gap:7px;padding:8px 18px;background:var(--accent-dim);border:1px solid var(--accent-mid);border-radius:8px;color:var(--accent-dark);font-size:13px;font-weight:600;text-decoration:none}
.footer-sibling:hover{opacity:.85;text-decoration:none}
/* Responsive */
@media(max-width:768px){
  .page-header{padding:36px 24px 32px}
  .page-header h1{font-size:1.8rem}
  .toc-col{display:none}
  .content-col{padding:36px 24px}
  .page-footer{padding:24px}
}
@media(max-width:480px){
  .page-header{padding:28px 18px 24px}
  .page-header h1{font-size:1.5rem}
  .content-col{padding:24px 18px}
  .page-footer{padding:20px 18px;flex-direction:column;align-items:flex-start}
}
</style>`;
}

/* ---- Templates -------------------------------------------- */

function TERMS_TEMPLATE(d) {
  const termsUrl   = `${BASE_URL}/terms/${d.slug}/`;
  const privacyUrl = `${BASE_URL}/privacy/${d.slug}/`;
  const css = SHARED_CSS(`:root{--accent:#4f6ef7;--accent-dark:#3a57e8;--accent-dim:#eef2ff;--accent-mid:#a5b4fc;--hdr-a:#0f172a;--hdr-b:#1e1b4b}`);
  const arrow = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — ${d.app_name}</title>
  ${css}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Terms of Service</div>
    <h1>${d.app_name}</h1>
    <div class="header-meta">
      <span>Effective: ${formatDate(d.effective_date)}</span>
      <span>Last Updated: ${formatDate(d.last_updated || d.effective_date)}</span>
    </div>
    <a class="sibling-btn" href="${privacyUrl}">${arrow} View Privacy Policy</a>
  </header>

  <div class="layout-wrap">
    <nav class="toc-col">
      <div class="toc-label">On this page</div>
      <ol class="toc-list">
        <li><a href="#s1">Acceptance of Terms</a></li>
        <li><a href="#s2">Description of App</a></li>
        <li><a href="#s3">Use of App</a></li>
        <li><a href="#s4">Intellectual Property</a></li>
        <li><a href="#s5">User Accounts</a></li>
        <li><a href="#s6">Limitation of Liability</a></li>
        <li><a href="#s7">Disclaimer of Warranties</a></li>
        <li><a href="#s8">Changes to Terms</a></li>
        <li><a href="#s9">Governing Law</a></li>
        <li><a href="#s10">Contact</a></li>
      </ol>
    </nav>

    <main class="content-col">
      <p class="intro-text">These Terms of Service govern your use of <strong>${d.app_name}</strong>, operated by <strong>${d.developer_name}</strong>. By downloading, installing, or using the App you agree to these terms.</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Acceptance of Terms</h2></div>
        <p>By downloading, installing, or using <strong>${d.app_name}</strong> ("the App"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the App.</p>
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>Description of the App</h2></div>
        <p>${d.app_description}</p>
      </div>

      <div class="section-block" id="s3">
        <div class="section-heading"><span class="section-num">03</span><h2>Use of the App</h2></div>
        <p>You agree to use the App only for lawful purposes and in a way that does not infringe the rights of others or restrict their use and enjoyment of the App. You must not misuse the App by knowingly introducing viruses or other malicious material.</p>
      </div>

      <div class="section-block" id="s4">
        <div class="section-heading"><span class="section-num">04</span><h2>Intellectual Property</h2></div>
        <p>The App and its original content, features, and functionality are owned by <strong>${d.developer_name}</strong> and are protected by applicable intellectual property laws. You may not copy, modify, distribute, sell, or lease any part of the App without prior written permission.</p>
      </div>

      <div class="section-block" id="s5">
        <div class="section-heading"><span class="section-num">05</span><h2>User Accounts</h2></div>
        ${d.has_account_creation
          ? `<p>You may need to create an account to use certain features of the App. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.</p>`
          : `<p>The App does not require you to create an account. You can use all features without registering.</p>`}
      </div>

      <div class="section-block" id="s6">
        <div class="section-heading"><span class="section-num">06</span><h2>Limitation of Liability</h2></div>
        <p>To the maximum extent permitted by applicable law, <strong>${d.developer_name}</strong> shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of, or inability to use, the App.</p>
      </div>

      <div class="section-block" id="s7">
        <div class="section-heading"><span class="section-num">07</span><h2>Disclaimer of Warranties</h2></div>
        <p>The App is provided "as is" and "as available" without any warranties of any kind, either express or implied. We do not warrant that the App will be uninterrupted, error-free, or free of viruses or other harmful components.</p>
      </div>

      <div class="section-block" id="s8">
        <div class="section-heading"><span class="section-num">08</span><h2>Changes to Terms</h2></div>
        <p>We reserve the right to modify these Terms of Service at any time. We will notify you of significant changes by updating the "Last Updated" date. Your continued use of the App after changes are posted constitutes your acceptance of the updated terms.</p>
      </div>

      <div class="section-block" id="s9">
        <div class="section-heading"><span class="section-num">09</span><h2>Governing Law</h2></div>
        <p>These Terms shall be governed by and construed in accordance with the laws of ${d.country}, without regard to its conflict of law provisions.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact</h2></div>
        <p>If you have any questions about these Terms of Service, please contact us:</p>
        <div class="contact-box">
          <p><strong>${d.developer_name}</strong></p>
          <p>Email: <a href="mailto:${d.contact_email}">${d.contact_email}</a></p>
          ${d.website_url ? `<p>Website: <a href="${d.website_url}">${d.website_url}</a></p>` : ''}
          <p>${d.country}</p>
        </div>
      </div>
    </main>
  </div>

  <footer class="page-footer">
    <div class="footer-left">
      <strong>${d.developer_name}</strong> &bull; ${d.country}
      ${d.website_url ? `<br><a href="${d.website_url}">${d.website_url}</a>` : ''}
    </div>
    <a class="footer-sibling" href="${privacyUrl}">${arrow} Privacy Policy</a>
  </footer>

</div>
</body>
</html>`;
}

function PRIVACY_TEMPLATE(d) {
  const termsUrl   = `${BASE_URL}/terms/${d.slug}/`;
  const privacyUrl = `${BASE_URL}/privacy/${d.slug}/`;
  const css = SHARED_CSS(`:root{--accent:#10b981;--accent-dark:#059669;--accent-dim:#ecfdf5;--accent-mid:#6ee7b7;--hdr-a:#0a1f18;--hdr-b:#052e16}`);
  const arrow = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

  const collectedContent = d.data_collected && d.data_collected.length > 0
    ? `<div class="pill-list">${d.data_collected.map(k => `<span class="pill">${DATA_LABELS[k] || k}</span>`).join('')}</div>`
    : `<p class="no-data">We do not collect any personal information from you.</p>`;

  const thirdPartyContent = d.third_party_services && d.third_party_services.filter(Boolean).length > 0
    ? `<p>The App uses the following third-party services that may collect information:</p>
       <div class="pill-list">${d.third_party_services.filter(Boolean).map(s => `<span class="pill">${s}</span>`).join('')}</div>
       <p>Each service operates under its own privacy policy governing the use of your information.</p>`
    : `<p>We do not use any third-party analytics, advertising, or tracking services.</p>`;

  const childrenContent = d.children_under_13
    ? `<div class="callout">This App is designed for children. We take children&#39;s privacy seriously and comply with the Children&#39;s Online Privacy Protection Act (COPPA) and applicable laws. We do not knowingly collect personal information from children under 13 without verifiable parental consent. If you believe we have collected information from a child without proper consent, please contact us immediately.</div>`
    : `<p>The App is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected such information, we will delete it promptly.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — ${d.app_name}</title>
  ${css}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Privacy Policy</div>
    <h1>${d.app_name}</h1>
    <div class="header-meta">
      <span>Effective: ${formatDate(d.effective_date)}</span>
      <span>Last Updated: ${formatDate(d.last_updated || d.effective_date)}</span>
    </div>
    <a class="sibling-btn" href="${termsUrl}">${arrow} View Terms of Service</a>
  </header>

  <div class="layout-wrap">
    <nav class="toc-col">
      <div class="toc-label">On this page</div>
      <ol class="toc-list">
        <li><a href="#s1">Information We Collect</a></li>
        <li><a href="#s2">How We Use It</a></li>
        <li><a href="#s3">Information Sharing</a></li>
        <li><a href="#s4">Third-Party Services</a></li>
        <li><a href="#s5">Data Security</a></li>
        <li><a href="#s6">Data Retention</a></li>
        <li><a href="#s7">Children's Privacy</a></li>
        <li><a href="#s8">Your Rights</a></li>
        <li><a href="#s9">Changes to Policy</a></li>
        <li><a href="#s10">Contact Us</a></li>
      </ol>
    </nav>

    <main class="content-col">
      <p class="intro-text">This Privacy Policy describes how <strong>${d.developer_name}</strong> ("we," "us," or "our") collects, uses, and protects your information when you use the <strong>${d.app_name}</strong> mobile application ("the App").</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Information We Collect</h2></div>
        ${collectedContent}
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>How We Use Your Information</h2></div>
        <p>${d.data_used_for}</p>
      </div>

      <div class="section-block" id="s3">
        <div class="section-heading"><span class="section-num">03</span><h2>Information Sharing</h2></div>
        <p>We do not sell, trade, or otherwise transfer your personal information to outside parties except as described in this policy. We may share information with trusted third parties who assist us in operating the App, provided those parties agree to keep this information confidential.</p>
      </div>

      <div class="section-block" id="s4">
        <div class="section-heading"><span class="section-num">04</span><h2>Third-Party Services</h2></div>
        ${thirdPartyContent}
      </div>

      <div class="section-block" id="s5">
        <div class="section-heading"><span class="section-num">05</span><h2>Data Security</h2></div>
        <p>We implement appropriate technical and organizational measures to protect your information against unauthorized access, alteration, disclosure, or destruction. However, no method of transmission over the Internet or electronic storage is 100% secure.</p>
      </div>

      <div class="section-block" id="s6">
        <div class="section-heading"><span class="section-num">06</span><h2>Data Retention</h2></div>
        <p>We retain your information for as long as necessary to provide the services offered by the App, or as required by law. You may request deletion of your data at any time by contacting us.</p>
      </div>

      <div class="section-block" id="s7">
        <div class="section-heading"><span class="section-num">07</span><h2>Children's Privacy</h2></div>
        ${childrenContent}
      </div>

      <div class="section-block" id="s8">
        <div class="section-heading"><span class="section-num">08</span><h2>Your Rights</h2></div>
        <p>Depending on your location, you may have the right to access, correct, or delete personal information we hold about you. To exercise these rights, please contact us at <a href="mailto:${d.contact_email}">${d.contact_email}</a>.</p>
      </div>

      <div class="section-block" id="s9">
        <div class="section-heading"><span class="section-num">09</span><h2>Changes to This Policy</h2></div>
        <p>We may update this Privacy Policy from time to time. We will notify you of significant changes by updating the "Last Updated" date. Please review this policy periodically.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact Us</h2></div>
        <p>If you have any questions about this Privacy Policy, please contact us:</p>
        <div class="contact-box">
          <p><strong>${d.developer_name}</strong></p>
          <p>Email: <a href="mailto:${d.contact_email}">${d.contact_email}</a></p>
          ${d.website_url ? `<p>Website: <a href="${d.website_url}">${d.website_url}</a></p>` : ''}
          <p>${d.country}</p>
        </div>
      </div>
    </main>
  </div>

  <footer class="page-footer">
    <div class="footer-left">
      <strong>${d.developer_name}</strong> &bull; ${d.country}
      ${d.website_url ? `<br><a href="${d.website_url}">${d.website_url}</a>` : ''}
    </div>
    <a class="footer-sibling" href="${termsUrl}">${arrow} Terms of Service</a>
  </footer>

</div>
</body>
</html>`;
}

/* ---- Render List ------------------------------------------ */

function renderList(container, entries) {
  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="module-header">
        <div class="module-title">Term &amp; Privacy</div>
        <button class="btn btn-primary" id="tp-create-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          New Page
        </button>
      </div>
      <div class="module-body">
        <div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <h3>No pages yet</h3>
          <p>Create your first Terms &amp; Privacy page for an app.</p>
          <button class="btn btn-primary" id="tp-create-empty-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
            Create First Page
          </button>
        </div>
      </div>
    `;
    container.querySelector('#tp-create-btn')?.addEventListener('click', () => openForm());
    container.querySelector('#tp-create-empty-btn')?.addEventListener('click', () => openForm());
    return;
  }

  const platformBadge = platforms => {
    if (!platforms || platforms.length === 0) return '';
    let normalized = platforms.includes('both') ? ['ios', 'android'] : platforms;
    const map = { ios: 'iOS', android: 'Android' };
    return normalized.map(p => `<span class="badge badge-${p}">${map[p] || p}</span>`).join('');
  };

  const cards = entries.map(e => {
    const termsUrl   = `${BASE_URL}/terms/${e.slug}/`;
    const privacyUrl = `${BASE_URL}/privacy/${e.slug}/`;
    const dateStr = e.created_at ? e.created_at.split('T')[0] : '';
    const date = formatDate(dateStr);
    return `
      <div class="card" data-slug="${e.slug}">
        <div class="card-top">
          <div class="card-info">
            <div class="card-app-name">${e.app_name}</div>
            <div class="card-meta">
              ${platformBadge(e.platform)}
              ${date ? `<span class="card-date">&middot; ${date}</span>` : ''}
            </div>
          </div>
          <div class="card-actions">
            <button class="btn btn-icon edit-btn" data-slug="${e.slug}" title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn btn-icon delete-btn" data-slug="${e.slug}" data-name="${e.app_name}" title="Delete" style="color:#e53e3e;border-color:#fed7d7">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
        <div class="card-urls">
          <div class="card-url-row">
            <span class="url-label url-label-terms">Terms</span>
            <a class="url-text" href="${termsUrl}" target="_blank" data-slug="${e.slug}" data-type="terms">${termsUrl}</a>
            <button class="url-copy-btn" data-url="${termsUrl}">Copy</button>
          </div>
          <div class="card-url-row">
            <span class="url-label url-label-privacy">Privacy</span>
            <a class="url-text" href="${privacyUrl}" target="_blank" data-slug="${e.slug}" data-type="privacy">${privacyUrl}</a>
            <button class="url-copy-btn" data-url="${privacyUrl}">Copy</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="module-header">
      <div class="module-title">Term &amp; Privacy</div>
      <button class="btn btn-primary" id="tp-create-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        New Page
      </button>
    </div>
    <div class="module-body">
      <div class="card-list">${cards}</div>
    </div>
  `;

  container.querySelector('#tp-create-btn').addEventListener('click', () => openForm());

  container.querySelectorAll('.url-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.url, btn));
  });

  container.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openForm(btn.dataset.slug));
  });

  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDelete(btn.dataset.slug, btn.dataset.name));
  });
}

/* ---- Form Panel ------------------------------------------- */

let _currentSlug = null; // null = create mode, string = edit mode
let _slugManuallyEdited = false;
let _currentStep = 1;

function updateSlugHints(slug) {
  const display = slug || 'slug';
  const t = document.getElementById('tp-slug-hint-terms');
  const p = document.getElementById('tp-slug-hint-privacy');
  if (t) t.innerHTML = `bauloc.github.io/terms/<em>${display}</em>/`;
  if (p) p.innerHTML = `bauloc.github.io/privacy/<em>${display}</em>/`;
}

function goToStep(n) {
  _currentStep = n;
  document.getElementById('tp-step-1').classList.toggle('hidden', n !== 1);
  document.getElementById('tp-step-2').classList.toggle('hidden', n !== 2);
  document.querySelectorAll('.wizard-step').forEach(el =>
    el.classList.toggle('active', +el.dataset.step === n)
  );
  document.getElementById('tp-next-btn').classList.toggle('hidden', n !== 1);
  document.getElementById('tp-back-btn').classList.toggle('hidden', n !== 2);
  document.getElementById('tp-save-btn').classList.toggle('hidden', n !== 2);
  // Scroll panel body to top
  const body = document.querySelector('.form-panel-body');
  if (body) body.scrollTop = 0;
}

function validateStep1() {
  const fields = [
    { id: 'tp-app-name',       label: 'App Name' },
    { id: 'tp-slug',           label: 'URL Slug' },
    { id: 'tp-app-description',label: 'App Description' },
    { id: 'tp-developer-name', label: 'Developer Name' },
    { id: 'tp-developer-email',label: 'Developer Email' },
    { id: 'tp-country',        label: 'Country' },
    { id: 'tp-effective-date', label: 'Effective Date' },
  ];
  const errors = fields
    .filter(f => !document.getElementById(f.id)?.value.trim())
    .map(f => f.label + ' is required');

  const platform = [...document.querySelectorAll('.tp-platform-btn.checked')];
  if (!platform.length) errors.push('Platform is required');

  if (errors.length) {
    showToast('Step 1 incomplete', errors.join('<br>'), 'error', 5000);
    return false;
  }
  return true;
}

function openForm(slug = null) {
  _currentSlug = slug;
  _slugManuallyEdited = false;

  // Inject form panel HTML if not present
  if (!document.getElementById('tp-form-overlay')) {
    document.body.insertAdjacentHTML('beforeend', buildFormHTML());
    bindFormEvents();
  }

  const overlay = document.getElementById('tp-form-overlay');
  const panel   = document.getElementById('tp-form-panel');
  const title   = document.getElementById('tp-form-title');

  title.textContent = slug ? 'Edit Term & Privacy Page' : 'New Term & Privacy Page';

  if (slug) {
    loadFormData(slug);
  } else {
    resetForm();
    setDefaultDate();
  }

  goToStep(1);
  overlay.classList.add('open');
  panel.classList.add('open');
}

function closeForm() {
  document.getElementById('tp-form-overlay')?.classList.remove('open');
  document.getElementById('tp-form-panel')?.classList.remove('open');
}

function setDefaultDate() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('tp-effective-date').value = today;
}

async function loadFormData(slug) {
  const path = TP_PAGES_PATH + slug + '.json';
  try {
    const result = await githubReadFile(path);
    if (!result) return;
    const data = JSON.parse(result.content);
    fillForm(data);
  } catch {
    showToast('Load error', 'Could not load page data', 'error');
  }
}

function fillForm(d) {
  document.getElementById('tp-app-name').value       = d.app_name || '';
  document.getElementById('tp-slug').value            = d.slug || '';
  document.getElementById('tp-app-description').value = d.app_description || '';
  document.getElementById('tp-developer-name').value  = d.developer_name || '';
  document.getElementById('tp-developer-email').value = d.developer_email || '';
  document.getElementById('tp-website-url').value     = d.website_url || '';
  document.getElementById('tp-country').value         = d.country || 'Vietnam';
  document.getElementById('tp-effective-date').value  = d.effective_date || '';
  document.getElementById('tp-data-used-for').value   = d.data_used_for || '';
  document.getElementById('tp-third-party').value     = (d.third_party_services || []).join(', ');
  document.getElementById('tp-contact-email').value   = d.contact_email || '';

  // Platform — normalize legacy "both" value
  let platforms = d.platform || [];
  if (platforms.includes('both')) platforms = ['ios', 'android'];
  document.querySelectorAll('.tp-platform-btn').forEach(btn => {
    btn.classList.toggle('checked', platforms.includes(btn.dataset.value));
  });

  // Data collected checkboxes
  DATA_COLLECTED_OPTIONS.forEach(opt => {
    const el = document.querySelector(`.tp-data-check[data-id="${opt.id}"]`);
    if (el) el.classList.toggle('checked', (d.data_collected || []).includes(opt.id));
  });

  // Toggles
  setToggle('tp-has-account', d.has_account_creation || false);
  setToggle('tp-children',    d.children_under_13    || false);

  _slugManuallyEdited = true; // don't auto-overwrite slug in edit mode
  updateSlugHints(d.slug || '');
}

function resetForm() {
  document.getElementById('tp-form').reset();
  document.querySelectorAll('.tp-platform-btn').forEach(b => b.classList.remove('checked'));
  document.querySelectorAll('.tp-data-check').forEach(b => b.classList.remove('checked'));
  setToggle('tp-has-account', false);
  setToggle('tp-children',    false);
  document.getElementById('tp-country').value = 'Vietnam';
}

function setToggle(id, value) {
  const input = document.getElementById(id);
  if (input) input.checked = value;
}

function getToggle(id) {
  const input = document.getElementById(id);
  return input ? input.checked : false;
}

function buildFormHTML() {
  const dataCheckboxes = DATA_COLLECTED_OPTIONS.map(o =>
    `<label class="checkbox-item tp-data-check" data-id="${o.id}">${o.label}</label>`
  ).join('');

  return `
    <div class="form-overlay" id="tp-form-overlay"></div>
    <div class="form-panel" id="tp-form-panel">

      <!-- Header -->
      <div class="form-panel-header">
        <div class="form-panel-title" id="tp-form-title">New Term &amp; Privacy Page</div>
        <button class="btn btn-icon" id="tp-close-btn" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Wizard Step Indicator -->
      <div class="wizard-steps">
        <div class="wizard-step active" data-step="1">
          <div class="step-dot">1</div>
          <div class="step-info">
            <div class="step-title">General Info</div>
            <div class="step-sub">Terms &amp; Privacy</div>
          </div>
        </div>
        <div class="wizard-divider"></div>
        <div class="wizard-step" data-step="2">
          <div class="step-dot">2</div>
          <div class="step-info">
            <div class="step-title">Privacy Details</div>
            <div class="step-sub">Privacy Policy</div>
          </div>
        </div>
      </div>

      <!-- Form Body -->
      <div class="form-panel-body">
        <form id="tp-form" novalidate>

          <!-- ═══ STEP 1: General Info ═══ -->
          <div id="tp-step-1" class="wizard-content">

            <div class="form-section">
              <div class="form-section-title">App</div>
              <div class="form-group">
                <label for="tp-app-name">App Name <span class="required">*</span></label>
                <input type="text" id="tp-app-name" class="form-control" placeholder="e.g. Habit Tracker" required>
              </div>
              <div class="form-group">
                <label for="tp-slug">URL Slug <span class="required">*</span></label>
                <input type="text" id="tp-slug" class="form-control" placeholder="my-awesome-app" required>
                <div class="form-hint" id="tp-slug-hint-terms">bauloc.github.io/terms/<em>slug</em>/</div>
              <div class="form-hint" id="tp-slug-hint-privacy">bauloc.github.io/privacy/<em>slug</em>/</div>
              </div>
              <div class="form-group">
                <label>Platform <span class="required">*</span></label>
                <div class="radio-group">
                  <label class="radio-item tp-platform-btn" data-value="ios">iOS</label>
                  <label class="radio-item tp-platform-btn" data-value="android">Android</label>
                </div>
              </div>
              <div class="form-group">
                <label for="tp-app-description">App Description <span class="required">*</span></label>
                <textarea id="tp-app-description" class="form-control" rows="3" placeholder="Briefly describe what your app does and who it's for." required></textarea>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-title">Developer / Company</div>
              <div class="form-group">
                <label for="tp-developer-name">Name <span class="required">*</span></label>
                <input type="text" id="tp-developer-name" class="form-control" placeholder="Your name or company name" value="PLSOFT" required>
              </div>
              <div class="form-group">
                <label for="tp-developer-email">Email <span class="required">*</span></label>
                <input type="email" id="tp-developer-email" class="form-control" placeholder="Contact email shown in legal pages" value="loc.plsoft@gmail.com" required>
              </div>
              <div class="form-group">
                <label for="tp-website-url">Website</label>
                <input type="url" id="tp-website-url" class="form-control" placeholder="https://yourwebsite.com (optional)">
              </div>
              <div class="form-group">
                <label for="tp-country">Country <span class="required">*</span></label>
                <input type="text" id="tp-country" class="form-control" value="Vietnam" required>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-title">Effective Date</div>
              <div class="form-group">
                <label for="tp-effective-date">Date <span class="required">*</span></label>
                <input type="date" id="tp-effective-date" class="form-control" required>
              </div>
            </div>

          </div><!-- end step-1 -->

          <!-- ═══ STEP 2: Privacy Details ═══ -->
          <div id="tp-step-2" class="wizard-content hidden">

            <div class="form-section">
              <div class="form-section-title">Data Collection</div>
              <div class="form-group">
                <label>Data Collected</label>
                <div class="checkbox-group">${dataCheckboxes}</div>
                <div class="form-hint">Leave empty if no data is collected.</div>
              </div>
              <div class="form-group">
                <label for="tp-data-used-for">How data is used <span class="required">*</span></label>
                <textarea id="tp-data-used-for" class="form-control" rows="3" placeholder="e.g. To sync your data across devices and improve the app experience." required></textarea>
              </div>
              <div class="form-group">
                <label for="tp-third-party">Third-party Services</label>
                <input type="text" id="tp-third-party" class="form-control" placeholder="e.g. Firebase, Google Analytics — comma separated">
                <div class="form-hint">Leave empty if none.</div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-title">App Settings</div>
              <div class="toggle-row">
                <span class="toggle-label">App allows account creation</span>
                <label class="toggle-switch">
                  <input type="checkbox" id="tp-has-account">
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="toggle-row">
                <span class="toggle-label">App directed at children under 13</span>
                <label class="toggle-switch">
                  <input type="checkbox" id="tp-children">
                  <span class="toggle-track"></span>
                </label>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-title">Contact</div>
              <div class="form-group">
                <label for="tp-contact-email">Privacy Contact Email <span class="required">*</span></label>
                <input type="email" id="tp-contact-email" class="form-control" placeholder="Email users can reach you for privacy questions" value="loc.plsoft@gmail.com" required>
              </div>
            </div>

          </div><!-- end step-2 -->

        </form>
      </div>

      <!-- Footer -->
      <div class="form-panel-footer">
        <button class="btn btn-secondary" id="tp-cancel-btn">Cancel</button>
        <button class="btn btn-secondary hidden" id="tp-back-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          Back
        </button>
        <button class="btn btn-primary" id="tp-next-btn">
          Next
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
        <button class="btn btn-primary hidden" id="tp-save-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
          Save &amp; Publish
        </button>
      </div>
    </div>
  `;
}

function bindFormEvents() {
  document.getElementById('tp-close-btn').addEventListener('click', closeForm);
  document.getElementById('tp-cancel-btn').addEventListener('click', closeForm);
  document.getElementById('tp-form-overlay').addEventListener('click', closeForm);

  // Auto-slug from app name
  document.getElementById('tp-app-name').addEventListener('input', e => {
    if (!_slugManuallyEdited) {
      document.getElementById('tp-slug').value = generateSlug(e.target.value);
    }
  });

  document.getElementById('tp-slug').addEventListener('input', e => {
    _slugManuallyEdited = true;
    updateSlugHints(e.target.value.trim());
  });

  // Also update hints when app name auto-fills slug
  const origAppNameListener = document.getElementById('tp-app-name')._slugListener;
  document.getElementById('tp-app-name').addEventListener('input', e => {
    if (!_slugManuallyEdited) updateSlugHints(generateSlug(e.target.value));
  });

  // Platform radio-like buttons
  document.querySelectorAll('.tp-platform-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('checked'));
  });

  // Data collected checkboxes
  document.querySelectorAll('.tp-data-check').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('checked'));
  });

  document.getElementById('tp-next-btn').addEventListener('click', () => {
    if (validateStep1()) goToStep(2);
  });

  document.getElementById('tp-back-btn').addEventListener('click', () => goToStep(1));

  document.getElementById('tp-save-btn').addEventListener('click', handleFormSubmit);
}

/* ---- Form Submit ------------------------------------------ */

async function handleFormSubmit() {
  const appName       = document.getElementById('tp-app-name').value.trim();
  const slug          = document.getElementById('tp-slug').value.trim();
  const appDesc       = document.getElementById('tp-app-description').value.trim();
  const devName       = document.getElementById('tp-developer-name').value.trim();
  const devEmail      = document.getElementById('tp-developer-email').value.trim();
  const websiteUrl    = document.getElementById('tp-website-url').value.trim();
  const country       = document.getElementById('tp-country').value.trim();
  const effectiveDate = document.getElementById('tp-effective-date').value;
  const dataUsedFor   = document.getElementById('tp-data-used-for').value.trim();
  const thirdPartyRaw = document.getElementById('tp-third-party').value.trim();
  const contactEmail  = document.getElementById('tp-contact-email').value.trim();

  const platform       = [...document.querySelectorAll('.tp-platform-btn.checked')].map(b => b.dataset.value);
  const dataCollected  = [...document.querySelectorAll('.tp-data-check.checked')].map(b => b.dataset.id);
  const hasAccount     = getToggle('tp-has-account');
  const childrenU13    = getToggle('tp-children');
  const thirdParty     = thirdPartyRaw ? thirdPartyRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  // Validation
  const errors = [];
  if (!appName)       errors.push('App name is required');
  if (!slug)          errors.push('URL slug is required');
  if (!platform.length) errors.push('Platform is required');
  if (!appDesc)       errors.push('App description is required');
  if (!devName)       errors.push('Developer name is required');
  if (!devEmail)      errors.push('Developer email is required');
  if (!country)       errors.push('Country is required');
  if (!effectiveDate) errors.push('Effective date is required');
  if (!dataUsedFor)   errors.push('Data usage description is required');
  if (!contactEmail)  errors.push('Contact email is required');

  if (errors.length) {
    showToast('Validation Error', errors.join('<br>'), 'error', 6000);
    return;
  }

  const now = new Date().toISOString();
  const data = {
    slug,
    app_name:            appName,
    developer_name:      devName,
    developer_email:     devEmail,
    website_url:         websiteUrl,
    platform,
    app_description:     appDesc,
    effective_date:      effectiveDate,
    last_updated:        effectiveDate,
    data_collected:      dataCollected,
    data_used_for:       dataUsedFor,
    third_party_services: thirdParty,
    has_account_creation: hasAccount,
    children_under_13:   childrenU13,
    contact_email:       contactEmail,
    country,
    created_at:          _currentSlug ? undefined : now,
    updated_at:          now,
  };

  const saveBtn = document.getElementById('tp-save-btn');
  saveBtn.disabled = true;

  try {
    // 1. Check for slug conflict (only in create mode)
    if (!_currentSlug) {
      showSaving('Checking for conflicts...');
      const existing = await githubReadFile(TP_PAGES_PATH + slug + '.json');
      if (existing) {
        showToast('Slug conflict', `A page with slug "${slug}" already exists. Please choose a different slug.`, 'error');
        saveBtn.disabled = false;
        hideSaving();
        return;
      }
      data.created_at = now;
    }

    // 2. Build db.json update
    showSaving('Preparing data...');
    const dbResult = await githubReadFile(TP_DB_PATH);
    const db = dbResult ? JSON.parse(dbResult.content) : { version: 1, entries: [] };
    const entry = {
      slug,
      app_name:    appName,
      created_at:  data.created_at || now,
      updated_at:  now,
      terms_url:   `${BASE_URL}/terms/${slug}/`,
      privacy_url: `${BASE_URL}/privacy/${slug}/`,
      platform,
    };
    if (_currentSlug) {
      const idx = db.entries.findIndex(e => e.slug === _currentSlug);
      if (idx >= 0) db.entries[idx] = entry;
      else db.entries.unshift(entry);
    } else {
      db.entries.unshift(entry);
    }
    db.updated_at = now;

    // 3. Commit all 4 files in a single commit via Git Data API
    showSaving('Publishing...');
    const action = _currentSlug ? 'Update' : 'Add';
    await githubCommitMultiple({
      writes: [
        { path: TP_PAGES_PATH + slug + '.json', content: JSON.stringify(data, null, 2) },
        { path: TP_DB_PATH,                     content: JSON.stringify(db, null, 2) },
        { path: `terms/${slug}/index.html`,     content: TERMS_TEMPLATE(data) },
        { path: `privacy/${slug}/index.html`,   content: PRIVACY_TEMPLATE(data) },
      ],
      message: `${action} term & privacy: ${slug}`
    });

    hideSaving();
    closeForm();

    const termsUrl   = `${BASE_URL}/terms/${slug}/`;
    const privacyUrl = `${BASE_URL}/privacy/${slug}/`;
    showToast(
      'Published!',
      `Pages will be live in ~1 minute.<br>
       <a href="${termsUrl}" target="_blank">Terms</a> &bull;
       <a href="${privacyUrl}" target="_blank">Privacy</a>`,
      'success',
      8000
    );

    // Re-render list directly from memory (no re-fetch needed)
    renderList(document.getElementById('module-content'), db.entries);

  } catch (err) {
    hideSaving();
    saveBtn.disabled = false;

    if (err.message === 'AUTH_ERROR') {
      showToast('Authentication Error', 'Invalid token. Please update in Settings.', 'error');
    } else {
      showToast('Publish Failed', err.message || 'Unknown error', 'error');
    }
  }
}

/* ---- Delete Page ------------------------------------------ */

async function handleDelete(slug, appName) {
  if (!confirm(`Delete "${appName}"?\n\nThis will remove the page data, Terms, and Privacy files from GitHub.`)) return;

  const btn = document.querySelector(`.delete-btn[data-slug="${slug}"]`);
  if (btn) btn.disabled = true;

  try {
    showSaving('Deleting...');

    // 1. Build updated db.json
    const dbResult = await githubReadFile(TP_DB_PATH);
    const db = dbResult ? JSON.parse(dbResult.content) : { entries: [] };
    db.entries = db.entries.filter(e => e.slug !== slug);
    db.updated_at = new Date().toISOString();

    // 2. Update db.json + delete 3 files in a single commit
    await githubCommitMultiple({
      writes:  [{ path: TP_DB_PATH, content: JSON.stringify(db, null, 2) }],
      deletes: [
        TP_PAGES_PATH + slug + '.json',
        `terms/${slug}/index.html`,
        `privacy/${slug}/index.html`,
      ],
      message: `Delete term & privacy: ${slug}`
    });

    hideSaving();
    showToast('Deleted', `"${appName}" has been removed.`, 'success');
    // Re-render list directly from memory (no re-fetch needed)
    renderList(document.getElementById('module-content'), db.entries);

  } catch (err) {
    hideSaving();
    if (btn) btn.disabled = false;
    if (err.message === 'AUTH_ERROR') {
      showToast('Authentication Error', 'Invalid token. Please update in Settings.', 'error');
    } else {
      showToast('Delete Failed', err.message || 'Unknown error', 'error');
    }
  }
}

/* ---- Module Init ------------------------------------------ */

async function initTermPrivacy(container) {
  container.innerHTML = `
    <div class="module-header">
      <div class="module-title">Term &amp; Privacy</div>
    </div>
    <div class="module-body">
      <div class="loading-spinner"><div class="spinner"></div></div>
    </div>
  `;

  try {
    // Use githubReadFile (API) instead of rawReadFile (CDN) to avoid stale cache
    const result = await githubReadFile(TP_DB_PATH);
    const db = result ? JSON.parse(result.content) : { entries: [] };
    renderList(container, db.entries || []);
  } catch {
    renderList(container, []);
  }
}

// Register with core router
registerModule('term-privacy', initTermPrivacy);
