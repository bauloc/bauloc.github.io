import { DATA_LABELS, SITE, type LegalPage } from '../model'
import { escapeHtml, formatDate, safeWebsite } from './format'
import { sharedCss } from './shared-css'

/*
  The Privacy Policy page, ported character for character from the legacy console's
  PRIVACY_TEMPLATE — see terms.ts. templates.test.ts holds it byte-identical to the deployed
  page; what the user typed is HTML-escaped.
*/

export function privacyHtml(d: LegalPage): string {
  // Only an http(s) website becomes a link: a javascript: URL would run script on this origin.
  const site = safeWebsite(d.website_url)
  // Escaped although a published slug is only a-z, 0-9 and '-': the templates trust nothing
  // they are handed, so a hand-edited page file cannot break out even past the form's checks.
  const termsUrl = `${SITE}/terms/${escapeHtml(d.slug)}/`
  const css = sharedCss(
    `:root{--accent:#10b981;--accent-dark:#059669;--accent-dim:#ecfdf5;--accent-mid:#6ee7b7;--hdr-a:#0a1f18;--hdr-b:#052e16}`,
  )
  const arrow = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`

  const collectedContent =
    d.data_collected && d.data_collected.length > 0
      ? `<div class="pill-list">${d.data_collected.map((k) => `<span class="pill">${escapeHtml(Object.hasOwn(DATA_LABELS, k) ? (DATA_LABELS[k] ?? k) : k)}</span>`).join('')}</div>`
      : `<p class="no-data">We do not collect any personal information from you.</p>`

  const thirdPartyContent =
    d.third_party_services && d.third_party_services.filter(Boolean).length > 0
      ? `<p>The App uses the following third-party services that may collect information:</p>
       <div class="pill-list">${d.third_party_services
         .filter(Boolean)
         .map((s) => `<span class="pill">${escapeHtml(s)}</span>`)
         .join('')}</div>
       <p>Each service operates under its own privacy policy governing the use of your information.</p>`
      : `<p>We do not use any third-party analytics, advertising, or tracking services.</p>`

  const childrenContent = d.children_under_13
    ? `<div class="callout">This App is designed for children. We take children&#39;s privacy seriously and comply with the Children&#39;s Online Privacy Protection Act (COPPA) and applicable laws. We do not knowingly collect personal information from children under 13 without verifiable parental consent. If you believe we have collected information from a child without proper consent, please contact us immediately.</div>`
    : `<p>The App is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected such information, we will delete it promptly.</p>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — ${escapeHtml(d.app_name)}</title>
  ${css}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Privacy Policy</div>
    <h1>${escapeHtml(d.app_name)}</h1>
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
      <p class="intro-text">This Privacy Policy describes how <strong>${escapeHtml(d.developer_name)}</strong> ("we," "us," or "our") collects, uses, and protects your information when you use the <strong>${escapeHtml(d.app_name)}</strong> mobile application ("the App").</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Information We Collect</h2></div>
        ${collectedContent}
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>How We Use Your Information</h2></div>
        <p>${escapeHtml(d.data_used_for)}</p>
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
        <p>Depending on your location, you may have the right to access, correct, or delete personal information we hold about you. To exercise these rights, please contact us at <a href="mailto:${escapeHtml(d.contact_email)}">${escapeHtml(d.contact_email)}</a>.</p>
      </div>

      <div class="section-block" id="s9">
        <div class="section-heading"><span class="section-num">09</span><h2>Changes to This Policy</h2></div>
        <p>We may update this Privacy Policy from time to time. We will notify you of significant changes by updating the "Last Updated" date. Please review this policy periodically.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact Us</h2></div>
        <p>If you have any questions about this Privacy Policy, please contact us:</p>
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
    <a class="footer-sibling" href="${termsUrl}">${arrow} Terms of Service</a>
  </footer>

</div>
</body>
</html>`
}
