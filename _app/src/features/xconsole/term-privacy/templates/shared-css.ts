/*
  The stylesheet every generated legal page inlines. These are the EMITTED BYTES of pages
  that are live and referenced by App Store and Play Console submissions — keep them exactly
  as they are. templates.test.ts compares the output with the deployed pages byte for byte,
  which is also why the hex colours here are allowed (see eslint.config.js).
*/

export function sharedCss(rootVars: string): string {
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
</style>`
}
