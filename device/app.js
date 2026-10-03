/* ============================================================
   Device Lab — bootstrap loader

   PINNED FILENAME. Together with app.css this is the ONLY asset path
   the agent shell is allowed to know about, so an agent a tester
   downloaded months ago must still be able to load this file.
   Keep it forever-compatible: never rename, never add a second
   entry point, and never require a feature older agents lack.

   The module list below is a PRIVATE implementation detail — add,
   split or reorder freely.
   ============================================================ */

(function () {
  var selfScript = document.currentScript;

  /* In local mode the document origin is http://127.0.0.1:PORT while this
     script comes from the agent's /assets/ path (or, in hosted mode, from
     bauloc.github.io). Relative URLs inside injected scripts resolve against
     the DOCUMENT, not the script — so every asset URL must be built from
     this base. Getting this wrong is the classic "works hosted, broken
     locally" bug. */
  var BASE = ((selfScript && selfScript.src) || '/device/app.js').replace(/[^/]*$/, '');
  window.DVC_ASSET_BASE = BASE;

  /* Bump on every deploy: GitHub Pages serves max-age=600, so a query
     bump is the only reliable cache buster available to a no-build repo. */
  var V = '2026-09-08.1';
  window.DVC_ASSET_VERSION = V;

  var FILES = [
    'js/01-core.js',
    'js/02-backend.js',
    'js/03-webusb.js',
    'js/06-devices.js',
    'js/07-detail.js',
    'js/12-boot.js'
  ];

  /* ?mock=1 stubs every backend so the whole UI is buildable and
     demoable with no device and no agent attached. Query-gated rather
     than a tracked-but-unlinked file, so it never has to be removed
     before committing. */
  if (/[?&]mock=1\b/.test(location.search)) {
    FILES.splice(FILES.length - 1, 0, 'js/99-mock.js');
  }

  var i = 0;

  (function next() {
    if (i >= FILES.length) {
      if (typeof window.dvcBoot === 'function') {
        try {
          window.dvcBoot();
        } catch (err) {
          fatal(null, err);
        }
      }
      return;
    }
    var s = document.createElement('script');
    s.src = BASE + FILES[i++] + '?v=' + V;
    s.async = false;                       // injected scripts default to async
    s.onload = next;
    s.onerror = function () { fatal(s.src, null); };
    (document.head || document.documentElement).appendChild(s);
  })();

  /* No helpers exist yet at this point — plain DOM only, and textContent
     so a hostile URL can never become markup. */
  function fatal(src, err) {
    var box = document.createElement('div');
    box.className = 'dvc-fatal';

    var h = document.createElement('strong');
    h.textContent = 'Device Lab could not start';
    box.appendChild(h);

    var p = document.createElement('p');
    p.style.marginTop = '8px';
    p.textContent = src
      ? 'Failed to load ' + src + ' — check your internet connection, then reload.'
      : 'The interface loaded but failed to start' + (err && err.message ? ': ' + err.message : '.');
    box.appendChild(p);

    (document.body || document.documentElement).appendChild(box);
    if (err) throw err;
  }
})();
