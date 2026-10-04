import{i as e,t}from"./c-jsx-runtime-Cx0BB4qO.js";import{t as n}from"./c-react-CkpLvutn.js";import{h as r,i,m as a,n as o,p as s,r as c,t as l}from"./c-label-D9LuXyqZ.js";import{a as u,c as d,i as f,n as p,o as m,r as h,s as g,t as _,u as v}from"./c-copy-button-JxqEv29N.js";import{D as y,E as ee,O as b,T as te,_ as x,a as S,c as C,f as w,i as T,k as ne,l as E,m as D,n as O,o as k,p as A,r as j,s as re,t as ie,u as ae,y as M}from"./c-switch-6airPyhF.js";import{t as oe}from"./c-ellipsis-BlfrYs47.js";import{c as N,n as se,o as ce,r as le}from"./c-console-context-BaaUFLN2.js";import{u as P}from"./c-dialog-CIaXmUUG.js";import{t as F}from"./c-cn-DojpP95n.js";import{a as ue,i as de,n as fe,o as pe,r as me,t as he}from"./c-sheet-BjR9Zjqx.js";import{n as I,r as L,t as R}from"./c-errors-DmosAdNO.js";var ge=r(`arrow-left`,[[`path`,{d:`m12 19-7-7 7-7`,key:`1l729n`}],[`path`,{d:`M19 12H5`,key:`x3x0zl`}]]),_e=r(`arrow-right`,[[`path`,{d:`M5 12h14`,key:`1ays0h`}],[`path`,{d:`m12 5 7 7-7 7`,key:`xquz4c`}]]),ve=r(`calendar-days`,[[`path`,{d:`M8 2v3`,key:`1ioesn`}],[`path`,{d:`M16 2v3`,key:`otl347`}],[`rect`,{x:`3`,y:`3`,width:`18`,height:`18`,rx:`2`,key:`h1oib`}],[`path`,{d:`M3 9h18`,key:`1pudct`}],[`path`,{d:`M8 13h.01`,key:`1sbv64`}],[`path`,{d:`M12 13h.01`,key:`y0uutt`}],[`path`,{d:`M16 13h.01`,key:`wip0gl`}],[`path`,{d:`M8 17h.01`,key:`p3bg7i`}],[`path`,{d:`M12 17h.01`,key:`p32p05`}],[`path`,{d:`M16 17h.01`,key:`ql8jdd`}]]),ye=r(`eye`,[[`path`,{d:`M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0`,key:`1nclc0`}],[`circle`,{cx:`12`,cy:`12`,r:`3`,key:`1v7zrd`}]]),be=r(`pencil`,[[`path`,{d:`M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z`,key:`1a8usu`}],[`path`,{d:`m15 5 4 4`,key:`1mk7zo`}]]),z=e(n(),1),xe=[`Jan`,`Feb`,`Mar`,`Apr`,`May`,`Jun`,`Jul`,`Aug`,`Sep`,`Oct`,`Nov`,`Dec`];function Se(e){let[,t=``,n=``,r=``]=/^(\d{4})-(\d{2})-(\d{2})$/.exec(e)??[],i=xe[Number(n)-1],a=new Date(Date.UTC(Number(t),Number(n)-1,Number(r)));return!i||a.getUTCDate()!==Number(r)||a.getUTCMonth()!==Number(n)-1?null:{y:t,month:i,d:r}}var Ce=e=>Se(e)!==null;function B(e){let t=Se(e);return t?`${t.d}-${t.month}-${t.y}`:``}function V(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}function we(e){let t=e.trim();return/^https?:\/\//i.test(t)?t:``}function Te(e){return`<style>
${e}
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
</style>`}function Ee(e){let t=we(e.website_url),n=`${H}/terms/${V(e.slug)}/`,r=Te(`:root{--accent:#10b981;--accent-dark:#059669;--accent-dim:#ecfdf5;--accent-mid:#6ee7b7;--hdr-a:#0a1f18;--hdr-b:#052e16}`),i=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,a=e.data_collected&&e.data_collected.length>0?`<div class="pill-list">${e.data_collected.map(e=>`<span class="pill">${V(Object.hasOwn(je,e)?je[e]??e:e)}</span>`).join(``)}</div>`:`<p class="no-data">We do not collect any personal information from you.</p>`,o=e.third_party_services&&e.third_party_services.filter(Boolean).length>0?`<p>The App uses the following third-party services that may collect information:</p>
       <div class="pill-list">${e.third_party_services.filter(Boolean).map(e=>`<span class="pill">${V(e)}</span>`).join(``)}</div>
       <p>Each service operates under its own privacy policy governing the use of your information.</p>`:`<p>We do not use any third-party analytics, advertising, or tracking services.</p>`,s=e.children_under_13?`<div class="callout">This App is designed for children. We take children&#39;s privacy seriously and comply with the Children&#39;s Online Privacy Protection Act (COPPA) and applicable laws. We do not knowingly collect personal information from children under 13 without verifiable parental consent. If you believe we have collected information from a child without proper consent, please contact us immediately.</div>`:`<p>The App is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected such information, we will delete it promptly.</p>`;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — ${V(e.app_name)}</title>
  ${r}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Privacy Policy</div>
    <h1>${V(e.app_name)}</h1>
    <div class="header-meta">
      <span>Effective: ${B(e.effective_date)}</span>
      <span>Last Updated: ${B(e.last_updated||e.effective_date)}</span>
    </div>
    <a class="sibling-btn" href="${n}">${i} View Terms of Service</a>
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
      <p class="intro-text">This Privacy Policy describes how <strong>${V(e.developer_name)}</strong> ("we," "us," or "our") collects, uses, and protects your information when you use the <strong>${V(e.app_name)}</strong> mobile application ("the App").</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Information We Collect</h2></div>
        ${a}
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>How We Use Your Information</h2></div>
        <p>${V(e.data_used_for)}</p>
      </div>

      <div class="section-block" id="s3">
        <div class="section-heading"><span class="section-num">03</span><h2>Information Sharing</h2></div>
        <p>We do not sell, trade, or otherwise transfer your personal information to outside parties except as described in this policy. We may share information with trusted third parties who assist us in operating the App, provided those parties agree to keep this information confidential.</p>
      </div>

      <div class="section-block" id="s4">
        <div class="section-heading"><span class="section-num">04</span><h2>Third-Party Services</h2></div>
        ${o}
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
        ${s}
      </div>

      <div class="section-block" id="s8">
        <div class="section-heading"><span class="section-num">08</span><h2>Your Rights</h2></div>
        <p>Depending on your location, you may have the right to access, correct, or delete personal information we hold about you. To exercise these rights, please contact us at <a href="mailto:${V(e.contact_email)}">${V(e.contact_email)}</a>.</p>
      </div>

      <div class="section-block" id="s9">
        <div class="section-heading"><span class="section-num">09</span><h2>Changes to This Policy</h2></div>
        <p>We may update this Privacy Policy from time to time. We will notify you of significant changes by updating the "Last Updated" date. Please review this policy periodically.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact Us</h2></div>
        <p>If you have any questions about this Privacy Policy, please contact us:</p>
        <div class="contact-box">
          <p><strong>${V(e.developer_name)}</strong></p>
          <p>Email: <a href="mailto:${V(e.contact_email)}">${V(e.contact_email)}</a></p>
          ${t?`<p>Website: <a href="${V(t)}">${V(t)}</a></p>`:``}
          <p>${V(e.country)}</p>
        </div>
      </div>
    </main>
  </div>

  <footer class="page-footer">
    <div class="footer-left">
      <strong>${V(e.developer_name)}</strong> &bull; ${V(e.country)}
      ${t?`<br><a href="${V(t)}">${V(t)}</a>`:``}
    </div>
    <a class="footer-sibling" href="${n}">${i} Terms of Service</a>
  </footer>

</div>
</body>
</html>`}function De(e){let t=we(e.website_url),n=`${H}/privacy/${V(e.slug)}/`,r=Te(`:root{--accent:#4f6ef7;--accent-dark:#3a57e8;--accent-dim:#eef2ff;--accent-mid:#a5b4fc;--hdr-a:#0f172a;--hdr-b:#1e1b4b}`),i=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — ${V(e.app_name)}</title>
  ${r}
</head>
<body>
<div class="page-wrap">

  <header class="page-header">
    <div class="page-type-label">Terms of Service</div>
    <h1>${V(e.app_name)}</h1>
    <div class="header-meta">
      <span>Effective: ${B(e.effective_date)}</span>
      <span>Last Updated: ${B(e.last_updated||e.effective_date)}</span>
    </div>
    <a class="sibling-btn" href="${n}">${i} View Privacy Policy</a>
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
      <p class="intro-text">These Terms of Service govern your use of <strong>${V(e.app_name)}</strong>, operated by <strong>${V(e.developer_name)}</strong>. By downloading, installing, or using the App you agree to these terms.</p>

      <div class="section-block" id="s1">
        <div class="section-heading"><span class="section-num">01</span><h2>Acceptance of Terms</h2></div>
        <p>By downloading, installing, or using <strong>${V(e.app_name)}</strong> ("the App"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the App.</p>
      </div>

      <div class="section-block" id="s2">
        <div class="section-heading"><span class="section-num">02</span><h2>Description of the App</h2></div>
        <p>${V(e.app_description)}</p>
      </div>

      <div class="section-block" id="s3">
        <div class="section-heading"><span class="section-num">03</span><h2>Use of the App</h2></div>
        <p>You agree to use the App only for lawful purposes and in a way that does not infringe the rights of others or restrict their use and enjoyment of the App. You must not misuse the App by knowingly introducing viruses or other malicious material.</p>
      </div>

      <div class="section-block" id="s4">
        <div class="section-heading"><span class="section-num">04</span><h2>Intellectual Property</h2></div>
        <p>The App and its original content, features, and functionality are owned by <strong>${V(e.developer_name)}</strong> and are protected by applicable intellectual property laws. You may not copy, modify, distribute, sell, or lease any part of the App without prior written permission.</p>
      </div>

      <div class="section-block" id="s5">
        <div class="section-heading"><span class="section-num">05</span><h2>User Accounts</h2></div>
        ${e.has_account_creation?`<p>You may need to create an account to use certain features of the App. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.</p>`:`<p>The App does not require you to create an account. You can use all features without registering.</p>`}
      </div>

      <div class="section-block" id="s6">
        <div class="section-heading"><span class="section-num">06</span><h2>Limitation of Liability</h2></div>
        <p>To the maximum extent permitted by applicable law, <strong>${V(e.developer_name)}</strong> shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of, or inability to use, the App.</p>
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
        <p>These Terms shall be governed by and construed in accordance with the laws of ${V(e.country)}, without regard to its conflict of law provisions.</p>
      </div>

      <div class="section-block" id="s10">
        <div class="section-heading"><span class="section-num">10</span><h2>Contact</h2></div>
        <p>If you have any questions about these Terms of Service, please contact us:</p>
        <div class="contact-box">
          <p><strong>${V(e.developer_name)}</strong></p>
          <p>Email: <a href="mailto:${V(e.contact_email)}">${V(e.contact_email)}</a></p>
          ${t?`<p>Website: <a href="${V(t)}">${V(t)}</a></p>`:``}
          <p>${V(e.country)}</p>
        </div>
      </div>
    </main>
  </div>

  <footer class="page-footer">
    <div class="footer-left">
      <strong>${V(e.developer_name)}</strong> &bull; ${V(e.country)}
      ${t?`<br><a href="${V(t)}">${V(t)}</a>`:``}
    </div>
    <a class="footer-sibling" href="${n}">${i} Privacy Policy</a>
  </footer>

</div>
</body>
</html>`}var H=`https://bauloc.github.io`,U=`data/term-privacy/db.json`,Oe=`data/term-privacy/pages/`,ke=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,Ae=[{id:`name`,label:`Name`},{id:`email`,label:`Email`},{id:`location`,label:`Location`},{id:`device_info`,label:`Device Info`},{id:`usage_data`,label:`Usage Data`},{id:`camera`,label:`Camera`},{id:`microphone`,label:`Microphone`},{id:`contacts`,label:`Contacts`},{id:`payment`,label:`Payment Info`}],je={name:`User name`,email:`Email address`,location:`Location data`,device_info:`Device information and identifiers`,usage_data:`App usage data and analytics`,camera:`Camera access`,microphone:`Microphone access`,contacts:`Contact list`,payment:`Payment information`},W=e=>`${H}/terms/${e}/`,G=e=>`${H}/privacy/${e}/`,K=e=>`${Oe}${e}.json`;function q(e){return typeof e==`object`&&!!e&&!Array.isArray(e)}var J=(e,t=``)=>typeof e==`string`?e:t,Y=e=>Array.isArray(e)?e.filter(e=>typeof e==`string`):[];function Me(e){let t=Y(e);return(t.includes(`both`)?[`ios`,`android`]:t).filter(e=>e===`ios`||e===`android`)}function X(e){let t=JSON.parse(e);if(!q(t)||!Array.isArray(t.entries))throw Error(`${U} is not a page index (no "entries" list)`);return{version:typeof t.version==`number`?t.version:1,...typeof t.updated_at==`string`?{updated_at:t.updated_at}:{},entries:t.entries.filter(q).map(e=>{let t=J(e.slug);return{slug:t,app_name:J(e.app_name,t),created_at:J(e.created_at),updated_at:J(e.updated_at),terms_url:J(e.terms_url,W(t)),privacy_url:J(e.privacy_url,G(t)),platform:Me(e.platform)}})}}function Ne(e){let t=JSON.parse(e);if(!q(t))throw Error(`Page data is not an object`);return{slug:J(t.slug),app_name:J(t.app_name),developer_name:J(t.developer_name),developer_email:J(t.developer_email),website_url:J(t.website_url),platform:Me(t.platform),app_description:J(t.app_description),effective_date:J(t.effective_date),last_updated:J(t.last_updated),data_collected:Y(t.data_collected),data_used_for:J(t.data_used_for),third_party_services:Y(t.third_party_services),has_account_creation:t.has_account_creation===!0,children_under_13:t.children_under_13===!0,contact_email:J(t.contact_email),country:J(t.country,`Vietnam`),created_at:J(t.created_at),updated_at:J(t.updated_at)}}function Pe(e){return{slug:``,app_name:``,developer_name:`PLSOFT`,developer_email:`loc.plsoft@gmail.com`,website_url:``,platform:[],app_description:``,effective_date:e,data_collected:[],data_used_for:``,third_party_services:[],has_account_creation:!1,children_under_13:!1,contact_email:`loc.plsoft@gmail.com`,country:`Vietnam`}}function Fe(e){return e.normalize(`NFD`).replace(/[\u0300-\u036f]/g,``).replace(/đ/g,`d`).replace(/Đ/g,`D`).toLowerCase().trim().replace(/[^a-z0-9\s-]/g,``).replace(/\s+/g,`-`).replace(/-+/g,`-`).replace(/^-|-$/g,``)}function Ie(e){let t=[];e.app_name.trim()||t.push(`App Name is required`),e.slug.trim()?ke.test(e.slug)||t.push(`URL Slug may use only a–z, 0–9 and inner hyphens, at most 64 characters`):t.push(`URL Slug is required`),e.platform.length===0&&t.push(`Platform is required`),e.app_description.trim()||t.push(`App Description is required`),e.developer_name.trim()||t.push(`Developer Name is required`),e.developer_email.trim()||t.push(`Developer Email is required`);let n=e.website_url.trim();return n&&!/^https?:\/\//i.test(n)&&t.push(`Website must start with http:// or https://`),e.country.trim()||t.push(`Country is required`),e.effective_date?Ce(e.effective_date)||t.push(`Effective Date must be a valid date`):t.push(`Effective Date is required`),t}function Le(e){let t=[];return e.data_used_for.trim()||t.push(`Data usage description is required`),e.contact_email.trim()||t.push(`Contact email is required`),t}function Re(e){return{...e,slug:e.slug.trim(),app_name:e.app_name.trim(),developer_name:e.developer_name.trim(),developer_email:e.developer_email.trim(),website_url:e.website_url.trim(),app_description:e.app_description.trim(),data_used_for:e.data_used_for.trim(),contact_email:e.contact_email.trim(),country:e.country.trim(),third_party_services:e.third_party_services.map(e=>e.trim()).filter(Boolean)}}function ze(e,t,n,r){let i=Re(n?{...e,slug:n.slug}:e),a=n?.created_at||r,o={slug:i.slug,app_name:i.app_name,developer_name:i.developer_name,developer_email:i.developer_email,website_url:i.website_url,platform:i.platform,app_description:i.app_description,effective_date:i.effective_date,last_updated:i.effective_date,data_collected:i.data_collected,data_used_for:i.data_used_for,third_party_services:i.third_party_services,has_account_creation:i.has_account_creation,children_under_13:i.children_under_13,contact_email:i.contact_email,country:i.country,created_at:a,updated_at:r},s={slug:o.slug,app_name:o.app_name,created_at:a,updated_at:r,terms_url:W(o.slug),privacy_url:G(o.slug),platform:o.platform},c=t.entries.filter(e=>e.slug!==o.slug),l=t.entries.findIndex(e=>e.slug===o.slug)>=0?t.entries.map(e=>e.slug===o.slug?s:e):[s,...c],u={...t,entries:l,updated_at:r};return{writes:[{path:K(o.slug),content:JSON.stringify(o,null,2)},{path:U,content:JSON.stringify(u,null,2)},{path:`terms/${o.slug}/index.html`,content:De(o)},{path:`privacy/${o.slug}/index.html`,content:Ee(o)}],deletes:[],message:`${n?`Update`:`Add`} term & privacy: ${o.slug}`,db:u}}function Be(e,t,n,r){return r===null||!t.entries.some(t=>t.slug===e)?`"${e}" was deleted after you opened it, so nothing was published. Close this and check the list.`:r===n?null:`"${e}" was changed elsewhere after you opened it, so nothing was published. Close this and open it again to edit the latest version.`}function Ve(e,t,n){let r={...t,entries:t.entries.filter(t=>t.slug!==e),updated_at:n};return{writes:[{path:U,content:JSON.stringify(r,null,2)}],deletes:[K(e),`terms/${e}/index.html`,`privacy/${e}/index.html`],message:`Delete term & privacy: ${e}`,db:r}}var Z=t(),He={ios:{label:`iOS`,className:`bg-sky-500/10 text-sky-700 dark:text-sky-300`},android:{label:`Android`,className:`bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`}};function Ue({platforms:e}){return e.map(e=>(0,Z.jsx)(P,{variant:`secondary`,className:F(`border-transparent`,He[e].className),children:He[e].label},e))}function We({kind:e,url:t}){let n=e===`terms`;return(0,Z.jsxs)(`div`,{className:`bg-muted/40 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3`,children:[(0,Z.jsx)(`span`,{className:F(`w-14 shrink-0 text-[11px] font-semibold tracking-wide uppercase`,n?`text-indigo-600 dark:text-indigo-300`:`text-emerald-600 dark:text-emerald-300`),children:n?`Terms`:`Privacy`}),(0,Z.jsx)(`a`,{href:t,target:`_blank`,rel:`noopener noreferrer`,className:`text-foreground/80 hover:text-primary min-w-0 flex-1 truncate font-mono text-xs hover:underline`,children:t.replace(/^https:\/\//,``)}),(0,Z.jsx)(_,{text:t,label:`Copy the ${n?`Terms`:`Privacy`} URL`})]})}function Ge({entry:e,busy:t,onEdit:n,onDelete:r}){let o=B(e.created_at.split(`T`)[0]??``);return(0,Z.jsxs)(p,{className:`min-w-0 gap-4 py-5 transition-shadow hover:shadow-md`,children:[(0,Z.jsxs)(m,{className:`px-5`,children:[(0,Z.jsx)(g,{className:`truncate text-base`,children:e.app_name}),(0,Z.jsxs)(u,{className:`flex flex-wrap items-center gap-1.5`,children:[(0,Z.jsx)(Ue,{platforms:e.platform}),o&&(0,Z.jsxs)(`span`,{className:`text-xs`,children:[`· `,o]})]}),(0,Z.jsx)(h,{children:(0,Z.jsxs)(w,{children:[(0,Z.jsx)(M,{asChild:!0,children:(0,Z.jsx)(i,{variant:`ghost`,size:`icon`,className:`size-8`,"aria-label":`Actions for ${e.app_name}`,children:(0,Z.jsx)(oe,{})})}),(0,Z.jsxs)(A,{align:`end`,className:`w-44`,children:[(0,Z.jsxs)(D,{disabled:t,onSelect:n,children:[(0,Z.jsx)(be,{}),` Edit`]}),(0,Z.jsx)(D,{asChild:!0,children:(0,Z.jsxs)(`a`,{href:e.terms_url,target:`_blank`,rel:`noopener noreferrer`,children:[(0,Z.jsx)(a,{}),` Open Terms`]})}),(0,Z.jsx)(D,{asChild:!0,children:(0,Z.jsxs)(`a`,{href:e.privacy_url,target:`_blank`,rel:`noopener noreferrer`,children:[(0,Z.jsx)(a,{}),` Open Privacy`]})}),(0,Z.jsx)(x,{}),(0,Z.jsxs)(D,{variant:`destructive`,disabled:t,onSelect:r,children:[(0,Z.jsx)(ee,{}),` Delete`]})]})]})})]}),(0,Z.jsxs)(f,{className:`space-y-2 px-5`,children:[(0,Z.jsx)(We,{kind:`terms`,url:e.terms_url}),(0,Z.jsx)(We,{kind:`privacy`,url:e.privacy_url})]})]})}function Ke({className:e,...t}){return(0,Z.jsx)(`textarea`,{"data-slot":`textarea`,className:F(`flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40`,e),...t})}var qe=()=>new Date().toISOString().split(`T`)[0]??``,Je={version:1,entries:[]};function Q({id:e,label:t,required:n,hint:r,children:i}){return(0,Z.jsxs)(`div`,{className:`grid gap-2`,children:[(0,Z.jsxs)(l,{htmlFor:e,children:[t,n&&(0,Z.jsx)(`span`,{className:`text-destructive`,children:`*`})]}),i,r!==void 0&&(0,Z.jsx)(`div`,{className:`text-muted-foreground text-xs`,children:r})]})}function $({title:e,children:t}){return(0,Z.jsxs)(`section`,{className:`grid gap-4`,children:[(0,Z.jsx)(`h3`,{className:`text-muted-foreground border-b pb-2 text-xs font-semibold tracking-wider uppercase`,children:e}),t]})}function Ye({step:e}){return(0,Z.jsx)(`ol`,{className:`bg-muted/40 flex items-center gap-3 border-y px-6 py-3`,children:[{n:1,title:`General info`,sub:`Terms & Privacy`},{n:2,title:`Privacy details`,sub:`Privacy Policy`}].map((t,n)=>{let r=t.n===e,i=t.n<e;return(0,Z.jsxs)(`li`,{className:`flex flex-1 items-center gap-3`,children:[n>0&&(0,Z.jsx)(`span`,{"aria-hidden":`true`,className:`bg-border -ml-1 h-px w-6 shrink-0`}),(0,Z.jsx)(`span`,{className:F(`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold`,r&&`bg-primary text-primary-foreground`,i&&`bg-success text-white`,!r&&!i&&`bg-muted text-muted-foreground border`),children:i?(0,Z.jsx)(v,{className:`size-4`}):t.n}),(0,Z.jsxs)(`span`,{className:`leading-tight`,children:[(0,Z.jsx)(`span`,{className:F(`block text-sm font-medium`,!r&&`text-muted-foreground`),children:t.title}),(0,Z.jsx)(`span`,{className:`text-muted-foreground block text-xs`,children:t.sub})]})]},t.n)})})}function Xe(e){let t=URL.createObjectURL(new Blob([e],{type:`text/html`}));window.open(t,`_blank`,`noopener`),window.setTimeout(()=>{URL.revokeObjectURL(t)},6e4)}function Ze({editing:e,onClose:t,onIndex:n}){let{repo:r,openSettings:a}=se(),[u,d]=(0,z.useState)(()=>Pe(qe())),[f,p]=(0,z.useState)(null),m=(0,z.useRef)(``),[h,g]=(0,z.useState)(e!==null),[_,y]=(0,z.useState)(1),[ee,b]=(0,z.useState)(!1),[x,S]=(0,z.useState)([]),[C,w]=(0,z.useState)(null),T=C!==null&&C===r,[E,D]=(0,z.useState)(!1),O=(0,z.useRef)(null);(0,z.useEffect)(()=>{O.current?.scrollTo({top:0})},[_]);let[k,A]=(0,z.useState)(0),j=e=>{S(e),e.length>0&&A(e=>e+1)};(0,z.useLayoutEffect)(()=>{k>0&&O.current?.scrollTo({top:0,behavior:`smooth`})},[k]);let re=(0,z.useEffectEvent)((e,n)=>{r.read(K(e)).then(t=>{if(!n())return;if(t===null)throw Error(`No saved answers for "${e}"`);let r=Ne(t);m.current=t,p(r),d({...r,third_party_services:r.third_party_services.map((e,t)=>t===0?e:` ${e}`)}),g(!1)}).catch(e=>{n()&&(R(`Could not load the page`,e,a),t())})});(0,z.useEffect)(()=>{if(e===null)return;let t=!0;return re(e,()=>t),()=>{t=!1}},[e]);let M=(e,t)=>{d(n=>({...n,[e]:t})),S([])},oe=(e,t)=>{M(`platform`,t?[...u.platform,e]:u.platform.filter(t=>t!==e))},N=(e,t)=>{M(`data_collected`,t?[...u.data_collected,e]:u.data_collected.filter(t=>t!==e))},ce=()=>{let e=Ie(u);j(e),e.length===0&&y(2)},P=e=>{let t=ze(u,Je,f,new Date().toISOString()).writes.find(t=>t.path.startsWith(`${e}/`));t&&Xe(t.content)},F=async()=>{let e=[...Ie(u),...Le(u)];if(j(e),w(null),e.length>0)return;let i=r;D(!0);let o=s.loading(f?`Updating…`:`Publishing…`);try{let e=await r.head(),i=await r.read(U,e);if(i===null)throw Error(`${U} is missing on GitHub — nothing was published.`);let a=X(i);if(f===null){let t=u.slug.trim();if(a.entries.some(e=>e.slug===t)||await r.read(K(t),e)!==null){s.dismiss(o),y(1),j([`A page with the slug "${t}" already exists. Choose another.`]);return}}else{let t=await r.read(K(f.slug),e),i=Be(f.slug,a,m.current,t);if(i!==null){s.dismiss(o),n(a),j([i]);return}}let c=ze(u,a,f,new Date().toISOString());await r.commit({...c,parent:e});let l=f?.slug??u.slug.trim();s.success(f?`Updated`:`Published`,{id:o,description:(0,Z.jsxs)(`span`,{children:[`Live in about a minute:`,` `,(0,Z.jsx)(`a`,{className:`underline`,href:W(l),target:`_blank`,rel:`noopener noreferrer`,children:`Terms`}),` `,`·`,` `,(0,Z.jsx)(`a`,{className:`underline`,href:G(l),target:`_blank`,rel:`noopener noreferrer`,children:`Privacy`})]}),duration:8e3}),n(c.db),t()}catch(e){e instanceof le?(s.dismiss(o),w(i),A(e=>e+1)):R(`Publish failed`,e,a,o)}finally{D(!1)}},I=u.slug.trim()||`slug`;return(0,Z.jsx)(he,{open:!0,onOpenChange:e=>{!e&&!E&&t()},children:(0,Z.jsxs)(fe,{className:`w-full gap-0 p-0 sm:max-w-xl`,children:[(0,Z.jsxs)(ue,{className:`px-6 pt-6 pb-4`,children:[(0,Z.jsx)(pe,{className:`text-lg`,children:f?`Edit Terms & Privacy`:`New Terms & Privacy page`}),(0,Z.jsx)(me,{children:f?`Changes publish over ${f.slug}.`:`Both pages publish together in one commit.`})]}),(0,Z.jsx)(Ye,{step:_}),(0,Z.jsxs)(`div`,{ref:O,className:`flex-1 overflow-y-auto px-6 py-6`,children:[(x.length>0||T)&&(0,Z.jsxs)(`div`,{role:`alert`,className:`border-destructive/30 bg-destructive/5 text-destructive mb-6 flex gap-3 rounded-lg border p-3 text-sm`,children:[(0,Z.jsx)(te,{className:`mt-0.5 size-4 shrink-0`}),(0,Z.jsxs)(`div`,{className:`flex-1 space-y-2`,children:[(0,Z.jsxs)(`ul`,{className:`list-inside space-y-0.5`,children:[T&&(0,Z.jsx)(`li`,{children:`GitHub refused the token. Update it, then publish again — your answers are kept.`}),x.map(e=>(0,Z.jsx)(`li`,{children:e},e))]}),T&&(0,Z.jsx)(i,{size:`sm`,variant:`outline`,onClick:a,children:`Update token`})]})]}),h?(0,Z.jsx)(`div`,{className:`space-y-4`,"aria-label":`Loading`,children:[0,1,2,3].map(e=>(0,Z.jsx)(o,{className:`h-9 w-full`},e))}):_===1?(0,Z.jsxs)(`div`,{className:`grid gap-8`,children:[(0,Z.jsxs)($,{title:`App`,children:[(0,Z.jsx)(Q,{id:`tp-app-name`,label:`App name`,required:!0,children:(0,Z.jsx)(c,{id:`tp-app-name`,placeholder:`e.g. Habit Tracker`,value:u.app_name,onChange:e=>{let t=e.target.value;d(e=>({...e,app_name:t,slug:f||ee?e.slug:Fe(t)})),S([])}})}),(0,Z.jsx)(Q,{id:`tp-slug`,label:`URL slug`,required:!0,hint:f?`The slug is the published URL, so it cannot change.`:(0,Z.jsxs)(`span`,{className:`font-mono`,children:[`bauloc.github.io/terms/`,(0,Z.jsx)(`b`,{className:`text-foreground`,children:I}),`/ · /privacy/`,(0,Z.jsx)(`b`,{className:`text-foreground`,children:I}),`/`]}),children:(0,Z.jsx)(c,{id:`tp-slug`,placeholder:`my-awesome-app`,value:u.slug,disabled:f!==null,className:`font-mono`,onChange:e=>{b(!0),M(`slug`,e.target.value)}})}),(0,Z.jsx)(Q,{label:`Platform`,required:!0,children:(0,Z.jsx)(`div`,{className:`flex gap-2`,children:[`ios`,`android`].map(e=>(0,Z.jsx)(ae,{variant:`outline`,pressed:u.platform.includes(e),onPressedChange:t=>{oe(e,t)},className:`data-[state=on]:border-primary px-4`,children:e===`ios`?`iOS`:`Android`},e))})}),(0,Z.jsx)(Q,{id:`tp-desc`,label:`App description`,required:!0,children:(0,Z.jsx)(Ke,{id:`tp-desc`,rows:3,placeholder:`Briefly describe what your app does and who it's for.`,value:u.app_description,onChange:e=>{M(`app_description`,e.target.value)}})})]}),(0,Z.jsx)($,{title:`Developer / company`,children:(0,Z.jsxs)(`div`,{className:`grid gap-4 sm:grid-cols-2`,children:[(0,Z.jsx)(Q,{id:`tp-dev-name`,label:`Name`,required:!0,children:(0,Z.jsx)(c,{id:`tp-dev-name`,value:u.developer_name,onChange:e=>{M(`developer_name`,e.target.value)}})}),(0,Z.jsx)(Q,{id:`tp-dev-email`,label:`Email`,required:!0,children:(0,Z.jsx)(c,{id:`tp-dev-email`,type:`email`,value:u.developer_email,onChange:e=>{M(`developer_email`,e.target.value)}})}),(0,Z.jsx)(Q,{id:`tp-website`,label:`Website`,children:(0,Z.jsx)(c,{id:`tp-website`,type:`url`,placeholder:`https://… (optional)`,value:u.website_url,onChange:e=>{M(`website_url`,e.target.value)}})}),(0,Z.jsx)(Q,{id:`tp-country`,label:`Country`,required:!0,children:(0,Z.jsx)(c,{id:`tp-country`,value:u.country,onChange:e=>{M(`country`,e.target.value)}})})]})}),(0,Z.jsx)($,{title:`Effective date`,children:(0,Z.jsx)(Q,{id:`tp-date`,label:`Date`,required:!0,children:(0,Z.jsx)(c,{id:`tp-date`,type:`date`,className:`w-48`,max:`9999-12-31`,value:u.effective_date,onChange:e=>{M(`effective_date`,e.target.value)}})})})]}):(0,Z.jsxs)(`div`,{className:`grid gap-8`,children:[(0,Z.jsxs)($,{title:`Data collection`,children:[(0,Z.jsx)(Q,{label:`Data collected`,hint:`Leave all off if the app collects nothing.`,children:(0,Z.jsx)(`div`,{className:`flex flex-wrap gap-2`,children:Ae.map(e=>(0,Z.jsx)(ae,{size:`sm`,variant:`outline`,pressed:u.data_collected.includes(e.id),onPressedChange:t=>{N(e.id,t)},className:`data-[state=on]:border-primary rounded-full px-3`,children:e.label},e.id))})}),(0,Z.jsx)(Q,{id:`tp-used-for`,label:`How data is used`,required:!0,children:(0,Z.jsx)(Ke,{id:`tp-used-for`,rows:3,placeholder:`e.g. To sync your data across devices and improve the app experience.`,value:u.data_used_for,onChange:e=>{M(`data_used_for`,e.target.value)}})}),(0,Z.jsx)(Q,{id:`tp-third`,label:`Third-party services`,hint:`Comma separated. Leave empty if none.`,children:(0,Z.jsx)(c,{id:`tp-third`,placeholder:`e.g. Firebase, Google Analytics`,value:u.third_party_services.join(`,`),onChange:e=>{M(`third_party_services`,e.target.value.split(`,`))}})})]}),(0,Z.jsx)($,{title:`App settings`,children:[[`has_account_creation`,`App allows account creation`],[`children_under_13`,`App is directed at children under 13`]].map(([e,t])=>(0,Z.jsxs)(`div`,{className:`flex items-center justify-between gap-4`,children:[(0,Z.jsx)(l,{htmlFor:`tp-${e}`,className:`font-normal`,children:t}),(0,Z.jsx)(ie,{id:`tp-${e}`,checked:u[e],onCheckedChange:t=>{M(e,t)}})]},e))}),(0,Z.jsx)($,{title:`Contact`,children:(0,Z.jsx)(Q,{id:`tp-contact`,label:`Privacy contact email`,required:!0,children:(0,Z.jsx)(c,{id:`tp-contact`,type:`email`,value:u.contact_email,onChange:e=>{M(`contact_email`,e.target.value)}})})}),(0,Z.jsx)($,{title:`Preview`,children:(0,Z.jsxs)(`div`,{className:`flex flex-wrap gap-2`,children:[(0,Z.jsxs)(i,{variant:`outline`,size:`sm`,onClick:()=>{P(`terms`)},children:[(0,Z.jsx)(ye,{}),` Terms of Service`]}),(0,Z.jsxs)(i,{variant:`outline`,size:`sm`,onClick:()=>{P(`privacy`)},children:[(0,Z.jsx)(ye,{}),` Privacy Policy`]})]})})]})]}),(0,Z.jsxs)(de,{className:`flex-row justify-end gap-2 border-t px-6 py-4`,children:[(0,Z.jsx)(i,{variant:`outline`,disabled:E,onClick:t,children:`Cancel`}),_===2&&(0,Z.jsxs)(i,{variant:`outline`,disabled:E,onClick:()=>{S([]),y(1)},children:[(0,Z.jsx)(ge,{}),` Back`]}),_===1?(0,Z.jsxs)(i,{disabled:h,onClick:ce,children:[`Next `,(0,Z.jsx)(_e,{})]}):(0,Z.jsxs)(i,{disabled:E,onClick:()=>{F()},children:[E?(0,Z.jsx)(ne,{className:`animate-spin`}):(0,Z.jsx)(v,{}),f?`Save & publish`:`Publish`]})]})]})})}var Qe=ce[0];async function $e(e){try{let t=await e(U);return t===null?{status:`missing`}:{status:`ready`,db:X(t)}}catch(e){return{status:`failed`,message:e instanceof Error?e.message:`Unknown error`,auth:e instanceof le}}}function et(){let{repo:e,openSettings:t}=se(),[n,r]=(0,z.useState)({status:`loading`}),[a,c]=(0,z.useState)(null),[l,u]=(0,z.useState)(null),[f,p]=(0,z.useState)(!1);(0,z.useEffect)(()=>{let t=!0;return $e(t=>e.read(t)).then(e=>{t&&r(e)}),()=>{t=!1}},[e]);let m=()=>{r({status:`loading`}),$e(t=>e.read(t)).then(r)},h=(0,z.useCallback)(()=>{c(null)},[]),g=async n=>{p(!0);let i=s.loading(`Deleting ${n.app_name}…`);try{let t=await e.head(),a=await e.read(U,t);if(a===null)throw Error(`${U} is missing on GitHub — nothing was deleted.`);let o=X(a);if(!o.entries.some(e=>e.slug===n.slug)){r({status:`ready`,db:o}),s.info(`Already deleted`,{id:i,description:`${n.app_name} was deleted elsewhere.`});return}let c=Ve(n.slug,o,new Date().toISOString());await e.commit({...c,parent:t}),r({status:`ready`,db:c.db}),s.success(`Deleted`,{id:i,description:`${n.app_name} and both of its pages are gone.`})}catch(e){R(`Delete failed`,e,t,i)}finally{p(!1)}},_=n.status===`ready`?n.db.entries:[],v=_.map(e=>e.updated_at).sort().at(-1);return(0,Z.jsxs)(`div`,{className:`space-y-6`,children:[(0,Z.jsx)(I,{title:Qe.title,description:Qe.description,actions:(0,Z.jsxs)(i,{disabled:n.status!==`ready`||f,onClick:()=>{c({editing:null})},children:[(0,Z.jsx)(b,{}),` New page`]})}),n.status===`loading`&&(0,Z.jsxs)(`div`,{className:`grid gap-4 md:grid-cols-3`,"aria-label":`Loading`,children:[[0,1,2].map(e=>(0,Z.jsx)(o,{className:`h-28 rounded-xl`},e)),(0,Z.jsx)(o,{className:`h-44 rounded-xl md:col-span-3`})]}),(n.status===`missing`||n.status===`failed`)&&(0,Z.jsxs)(`div`,{className:`border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-xl border p-5 sm:flex-row sm:items-center`,children:[(0,Z.jsx)(te,{className:`text-destructive size-5 shrink-0`}),(0,Z.jsxs)(`div`,{className:`flex-1 text-sm`,children:[(0,Z.jsx)(`p`,{className:`font-medium`,children:n.status===`missing`?`The page index was not found`:`Could not load the pages`}),(0,Z.jsx)(`p`,{className:`text-muted-foreground mt-0.5`,children:n.status===`missing`?`There is no data/term-privacy/db.json on the master branch. Publishing stays off until it is back, so the real list cannot be overwritten.`:n.message})]}),n.status===`failed`&&n.auth?(0,Z.jsx)(i,{variant:`outline`,onClick:t,children:`Update token`}):(0,Z.jsxs)(i,{variant:`outline`,onClick:m,children:[(0,Z.jsx)(d,{}),` Retry`]})]}),n.status===`ready`&&(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsxs)(`div`,{className:`grid gap-4 sm:grid-cols-3`,children:[(0,Z.jsx)(L,{label:`Apps`,value:_.length,hint:`${String(_.length*2)} pages live`,icon:(0,Z.jsx)(N,{})}),(0,Z.jsx)(L,{label:`Platforms`,value:(0,Z.jsxs)(`span`,{children:[_.filter(e=>e.platform.includes(`ios`)).length,(0,Z.jsx)(`span`,{className:`text-muted-foreground text-base font-normal`,children:` iOS · `}),_.filter(e=>e.platform.includes(`android`)).length,(0,Z.jsx)(`span`,{className:`text-muted-foreground text-base font-normal`,children:` Android`})]}),icon:(0,Z.jsx)(y,{})}),(0,Z.jsx)(L,{label:`Last published`,value:v&&B(v.split(`T`)[0]??``)||`—`,hint:`Pages go live about a minute after publishing`,icon:(0,Z.jsx)(ve,{})})]}),_.length===0?(0,Z.jsxs)(`div`,{className:`flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center`,children:[(0,Z.jsx)(`div`,{className:`bg-primary/10 text-primary grid size-12 place-items-center rounded-full`,children:(0,Z.jsx)(N,{className:`size-6`})}),(0,Z.jsx)(`h2`,{className:`mt-4 font-semibold`,children:`No pages yet`}),(0,Z.jsx)(`p`,{className:`text-muted-foreground mt-1 max-w-sm text-sm`,children:`Create the Terms of Service and Privacy Policy an app needs for the App Store and Google Play.`}),(0,Z.jsxs)(i,{className:`mt-6`,onClick:()=>{c({editing:null})},children:[(0,Z.jsx)(b,{}),` Create the first page`]})]}):(0,Z.jsx)(`div`,{className:`grid gap-4 lg:grid-cols-2`,children:_.map(e=>(0,Z.jsx)(Ge,{entry:e,busy:f,onEdit:()=>{c({editing:e.slug})},onDelete:()=>{u(e)}},e.slug))})]}),a!==null&&(0,Z.jsx)(Ze,{editing:a.editing,onClose:h,onIndex:e=>{r({status:`ready`,db:e})}},a.editing??`(new)`),(0,Z.jsx)(O,{open:l!==null,onOpenChange:e=>{e||u(null)},children:(0,Z.jsxs)(S,{children:[(0,Z.jsxs)(C,{children:[(0,Z.jsxs)(E,{children:[`Delete `,l?.app_name,`?`]}),(0,Z.jsx)(k,{children:`This removes its saved answers and both published pages from GitHub. Any store listing that links to them will show a 404.`})]}),(0,Z.jsxs)(re,{children:[(0,Z.jsx)(T,{children:`Cancel`}),(0,Z.jsx)(j,{variant:`destructive`,onClick:()=>{l&&g(l)},children:`Delete`})]})]})})]})}export{et as t};