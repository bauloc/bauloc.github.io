import { SITE, type LegalPage } from '../model'
import { escapeHtml, formatDate, safeWebsite } from './format'
import { sharedCss } from './shared-css'

/*
  The Terms of Service page, ported character for character from the legacy console's
  TERMS_TEMPLATE: its output is a live, store-referenced document, and templates.test.ts holds
  it byte-identical to the deployed page. The one change: what the user typed is HTML-escaped,
  which leaves any page without `& < > "` in it unchanged.
*/

export function termsHtml(d: LegalPage): string {
  // Only an http(s) website becomes a link: a javascript: URL would run script on this origin.
  const site = safeWebsite(d.website_url)
  // Escaped although a published slug is only a-z, 0-9 and '-': the templates trust nothing
  // they are handed, so a hand-edited page file cannot break out even past the form's checks.
  const privacyUrl = `${SITE}/privacy/${escapeHtml(d.slug)}/`
  const css = sharedCss(
    `:root{--accent:#4f6ef7;--accent-dark:#3a57e8;--accent-dim:#eef2ff;--accent-mid:#a5b4fc;--hdr-a:#0f172a;--hdr-b:#1e1b4b}`,
  )
  const arrow = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — ${escapeHtml(d.app_name)}</title>
  ${css}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Terms of Service</div>
    <h1>${escapeHtml(d.app_name)}</h1>
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
      <p class="intro-text">These Terms of Service govern your use of <strong>${escapeHtml(d.app_name)}</strong>, operated by <strong>${escapeHtml(d.developer_name)}</strong>. By downloading, installing, or using the App you agree to these terms.</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Acceptance of Terms</h2></div>
        <p>By downloading, installing, or using <strong>${escapeHtml(d.app_name)}</strong> ("the App"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the App.</p>
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>Description of the App</h2></div>
        <p>${escapeHtml(d.app_description)}</p>
      </div>

      <div class="section-block" id="s3">
        <div class="section-heading"><span class="section-num">03</span><h2>Use of the App</h2></div>
        <p>You agree to use the App only for lawful purposes and in a way that does not infringe the rights of others or restrict their use and enjoyment of the App. You must not misuse the App by knowingly introducing viruses or other malicious material.</p>
      </div>

      <div class="section-block" id="s4">
        <div class="section-heading"><span class="section-num">04</span><h2>Intellectual Property</h2></div>
        <p>The App and its original content, features, and functionality are owned by <strong>${escapeHtml(d.developer_name)}</strong> and are protected by applicable intellectual property laws. You may not copy, modify, distribute, sell, or lease any part of the App without prior written permission.</p>
      </div>

      <div class="section-block" id="s5">
        <div class="section-heading"><span class="section-num">05</span><h2>User Accounts</h2></div>
        ${
          d.has_account_creation
            ? `<p>You may need to create an account to use certain features of the App. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.</p>`
            : `<p>The App does not require you to create an account. You can use all features without registering.</p>`
        }
      </div>

      <div class="section-block" id="s6">
        <div class="section-heading"><span class="section-num">06</span><h2>Limitation of Liability</h2></div>
        <p>To the maximum extent permitted by applicable law, <strong>${escapeHtml(d.developer_name)}</strong> shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of, or inability to use, the App.</p>
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
        <p>These Terms shall be governed by and construed in accordance with the laws of ${escapeHtml(d.country)}, without regard to its conflict of law provisions.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact</h2></div>
        <p>If you have any questions about these Terms of Service, please contact us:</p>
        <div class="contact-box">
          <p><strong>${escapeHtml(d.developer_name)}</strong></p>
          <p>Email: <a href="mailto:${escapeHtml(d.contact_email)}">${escapeHtml(d.contact_email)}</a></p>
          ${site ? `<p>Website: <a href="${escapeHtml(site)}">${escapeHtml(site)}</a></p>` : ''}
          <p>${escapeHtml(d.country)}</p>
        </div>
      </div>
    </main>
  </div>

  <footer class="page-footer">
    <div class="footer-left">
      <strong>${escapeHtml(d.developer_name)}</strong> &bull; ${escapeHtml(d.country)}
      ${site ? `<br><a href="${escapeHtml(site)}">${escapeHtml(site)}</a>` : ''}
    </div>
    <a class="footer-sibling" href="${privacyUrl}">${arrow} Privacy Policy</a>
  </footer>

</div>
</body>
</html>`
}
