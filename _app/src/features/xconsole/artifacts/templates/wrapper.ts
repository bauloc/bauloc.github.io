import { escapeHtml } from '../../term-privacy/templates/format'
import { artifactUrl } from '../paths'

/*
  The file served at artifact/<id>.html, and how the page inside it runs.

  WHY A WRAPPER. XConsole keeps its GitHub token in the localStorage of https://bauloc.github.io,
  and any page served from that origin can read it. So an uploaded page is not served as itself:
  the served file is a small wrapper whose only content is a full-window iframe WITHOUT
  `allow-same-origin`. The page runs in an opaque origin and can reach nothing of the site's —
  not the token, not the console, not another artifact. Its HTML rides in the wrapper as a JSON
  string, and a constant loader script hands it to the frame as `srcdoc`.

  WHAT THE PAGE LOSES, AND GETS BACK. An opaque origin has no localStorage, sessionStorage or
  cookies; touching them throws, which breaks most pages that remember anything. A shim, run in
  the frame before the page's own scripts, puts in-memory stand-ins in their place. Changes to
  localStorage are posted to the wrapper, which keeps them under one key for this artifact, so a
  game's high score or a form's draft survives a reload. Nothing else crosses the frame's edge.

  Both scripts are constants. What differs per artifact lives in the markup — the id on the
  frame, the page in its JSON block — so every wrapper ever published runs the same reviewed
  code, and a page's HTML never becomes script outside the frame.

  The scripts are written for the oldest browser a reader may bring (var, function, no template
  strings) and must never contain `</script` or `<!--`: inside a <script> element either one
  would end it, or change how the rest of it is parsed. The tests check both.
*/

/** What a page says about itself, for the wrapper's head. '' wherever it says nothing usable. */
export interface HtmlMeta {
  readonly description: string
  /** og:image, else twitter:image; https only, as a link preview fetches it from anywhere. */
  readonly image: string
  /** The first rel=icon link's href, as data:image/… or https only. */
  readonly icon: string
}

export interface ArtifactPage {
  readonly id: string
  readonly title: string
  /** The page's own HTML, as uploaded or pasted. */
  readonly source: string
  /** Served inside the sandbox wrapper (true) or as the page itself (false). */
  readonly sandbox: boolean
  readonly meta: HtmlMeta
}

/**
 * The frame's sandbox. Everything a page normally does — scripts, forms, dialogs, popups,
 * downloads, fullscreen, a link that replaces the whole tab — except the one thing that matters:
 * there is NO `allow-same-origin`, so the frame never shares the site's origin or its storage.
 */
export const SANDBOX_FLAGS = [
  'allow-scripts',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-orientation-lock',
  'allow-top-navigation-by-user-activation',
].join(' ')

/**
 * The console's own preview: the same sandbox, less navigating the top window. There the top
 * window is the console, and a click on a link inside the preview must not take it — and the
 * draft being edited — away. The shim sends such links to a new tab instead.
 */
export const PREVIEW_SANDBOX_FLAGS = SANDBOX_FLAGS.replace(
  ' allow-top-navigation-by-user-activation',
  '',
)

/**
 * Powerful features a served page may ask for, so that a page which scans, records or maps works
 * as it would on its own. A reader's grant is per SITE, not per page: once a reader lets one page
 * of bauloc.github.io use the camera, the microphone or their location and the browser remembers
 * it, every artifact on the site gets the same access, and the next one that asks is not prompted
 * at all. Not clipboard-read, for the same reason: the clipboard on this site may well hold the
 * XConsole token someone just pasted into Settings.
 */
export const FRAME_ALLOW = [
  'fullscreen',
  'clipboard-write',
  'autoplay',
  'encrypted-media',
  'picture-in-picture',
  'web-share',
  'screen-wake-lock',
  'gamepad',
  'accelerometer',
  'gyroscope',
  'camera',
  'microphone',
  'geolocation',
  'display-capture',
].join('; ')

/**
 * The console's own preview, in its frame and in a tab of its own: what a page needs to look and
 * sound right, and no device. A page only being looked at before it is published, perhaps one
 * not trusted yet, must not inherit a camera, microphone or location grant made to the site
 * (FRAME_ALLOW), with nothing on screen to say so. The tab is a blob: of the console's own
 * origin, so the site's grants would reach it just the same.
 */
export const PREVIEW_ALLOW = ['fullscreen', 'clipboard-write', 'autoplay'].join('; ')

/** Where the wrapper keeps a page's localStorage: one key per artifact, in the site's storage. */
export const STORAGE_KEY_PREFIX = 'bauloc:artifact:'
/** The one message the frame may send the wrapper. */
export const STORAGE_MESSAGE = 'bauloc:artifact-storage'
/** What starts the frame's window.name when it mirrors the page's localStorage (see SHIM). */
export const STORAGE_MIRROR = 'bauloc:artifact-storage:'
/**
 * The most a page may keep, as the length of its items' JSON. The site's storage is shared with
 * the console, so one artifact must not be able to fill it; past this, setItem throws
 * QuotaExceededError, as a real Storage does when it is full.
 */
export const STORAGE_LIMIT = 500_000

/** The storage id every preview shares: parentheses are in no link, so it is no artifact's key. */
export const PREVIEW_STORAGE_ID = '(preview)'

/*
  THE SHIM, as the source of a function `(saved, served)`: `saved` is the JSON of the page's kept
  localStorage, or null; `served` is true in a published wrapper and false in the console's
  preview. It runs in the frame before anything of the page's.

  - localStorage and sessionStorage: Proxies over a Map that behave like Storage — the methods,
    `length`, `ls.x` / `ls.x = 'y'` / `delete ls.x`, `'x' in ls`, Object.keys, JSON.stringify —
    with every value a string. localStorage starts from `saved` (an object of strings; anything
    else is dropped). When served, each change goes to the wrapper as that one change — a key
    set, a key removed, everything cleared — never as the whole map: a second tab of the same
    page holds its own copy, and a map posted from it would erase every key written here since.
  - Surviving a reload INSIDE the frame. `location.reload()` reruns the same srcdoc, and with it
    the `saved` the wrapper read once when it loaded, so a cleared list would come back and the
    next write would make that stick. The frame's window.name belongs to the frame, not to its
    document, and outlives the reload: every change is mirrored there behind STORAGE_MIRROR, and
    a page that finds the mirror starts from it. The page gets a window.name of its own in its
    place, so it neither reads the mirror nor overwrites it. (Like any name, the mirror also
    outlives a page that sends its own frame to another site; a link or form never does, below.)
  - document.cookie: a small in-memory jar; Max-Age <= 0 or a past Expires removes a cookie.
  - Links and forms, aimed as the browser aims them: the element's own target, else the page's
    <base target>. Only those that stay in the frame are changed. A srcdoc document's links
    resolve against the WRAPPER's address, so `#section` would load the wrapper itself inside
    the frame: in-page links set the fragment instead. A plain http(s) link or form would open
    inside the frame, where most sites refuse to be framed: it takes the whole tab, as on a page
    of its own (a new tab in the preview).
  Each stand-in is installed with defineProperty in a try, so a browser that refuses one keeps
  its own behaviour rather than losing the page.
*/
export const SHIM = String.raw`function (saved, served) {
  var host = window.parent;
  var mark = ${JSON.stringify(STORAGE_MIRROR)};
  function storage(seed, save) {
    var items = new Map();
    if (seed && typeof seed === 'object' && !Array.isArray(seed)) {
      Object.keys(seed).forEach(function (name) {
        if (typeof seed[name] === 'string') items.set(name, seed[name]);
      });
    }
    function changed(change, undo) {
      if (!save) return;
      var plain = {};
      items.forEach(function (value, name) {
        Object.defineProperty(plain, name, { value: value, enumerable: true, writable: true, configurable: true });
      });
      var json = JSON.stringify(plain);
      if (undo && json.length > ${String(STORAGE_LIMIT)}) {
        undo();
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      save(json, change);
    }
    var api = {
      getItem: function (name) {
        name = String(name);
        return items.has(name) ? items.get(name) : null;
      },
      setItem: function (name, value) {
        name = String(name);
        value = String(value);
        var had = items.has(name);
        var old = items.get(name);
        if (had && old === value) return;
        items.set(name, value);
        changed({ op: 'set', key: name, value: value }, function () {
          if (had) items.set(name, old);
          else items.delete(name);
        });
      },
      removeItem: function (name) {
        name = String(name);
        if (items.delete(name)) changed({ op: 'remove', key: name }, null);
      },
      clear: function () {
        if (items.size === 0) return;
        items.clear();
        changed({ op: 'clear' }, null);
      },
      key: function (index) {
        var at = Number(index) >>> 0;
        return at < items.size ? Array.from(items.keys())[at] : null;
      }
    };
    var proto = Object.create(typeof Storage === 'function' ? Storage.prototype : Object.prototype);
    Object.keys(api).forEach(function (name) {
      Object.defineProperty(proto, name, { value: api[name], enumerable: true, writable: true, configurable: true });
    });
    Object.defineProperty(proto, 'length', {
      enumerable: true,
      configurable: true,
      get: function () {
        return items.size;
      }
    });
    function isItem(name) {
      return typeof name === 'string' && items.has(name);
    }
    return new Proxy(Object.create(proto), {
      get: function (target, name, receiver) {
        return isItem(name) && !(name in proto) ? items.get(name) : Reflect.get(target, name, receiver);
      },
      set: function (target, name, value, receiver) {
        if (typeof name !== 'string') return Reflect.set(target, name, value, receiver);
        api.setItem(name, value);
        return true;
      },
      has: function (target, name) {
        return isItem(name) || Reflect.has(target, name);
      },
      deleteProperty: function (target, name) {
        if (!isItem(name)) return Reflect.deleteProperty(target, name);
        api.removeItem(name);
        return true;
      },
      ownKeys: function (target) {
        return Array.from(items.keys()).concat(
          Reflect.ownKeys(target).filter(function (name) {
            return !isItem(name);
          })
        );
      },
      getOwnPropertyDescriptor: function (target, name) {
        if (!isItem(name)) return Reflect.getOwnPropertyDescriptor(target, name);
        return { value: items.get(name), writable: true, enumerable: true, configurable: true };
      },
      defineProperty: function (target, name, descriptor) {
        if (typeof name !== 'string' || !('value' in descriptor)) {
          return Reflect.defineProperty(target, name, descriptor);
        }
        api.setItem(name, descriptor.value);
        return true;
      }
    });
  }
  function install(object, name, value) {
    try {
      Object.defineProperty(object, name, {
        enumerable: true,
        configurable: true,
        get: function () {
          return value;
        }
      });
    } catch (error) {}
  }
  function parsed(text) {
    try {
      var value = typeof text === 'string' ? JSON.parse(text) : null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (error) {
      return null;
    }
  }
  function nameProperty() {
    try {
      for (var object = window; object; object = Object.getPrototypeOf(object)) {
        var found = Object.getOwnPropertyDescriptor(object, 'name');
        if (found) return found.get && found.set ? found : null;
      }
    } catch (error) {}
    return null;
  }
  var named = served ? nameProperty() : null;
  function frameName() {
    try {
      var value = named ? named.get.call(window) : window.name;
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }
  function mirror(text) {
    try {
      if (named) named.set.call(window, text);
      else window.name = text;
    } catch (error) {}
  }
  var current = served ? frameName() : '';
  var mirrored = current.indexOf(mark) === 0 ? current.slice(mark.length) : null;
  if (named) {
    var own = mirrored === null ? current : '';
    try {
      Object.defineProperty(window, 'name', {
        enumerable: true,
        configurable: true,
        get: function () {
          return own;
        },
        set: function (value) {
          own = String(value);
        }
      });
    } catch (error) {}
  }
  install(window, 'localStorage', storage(parsed(mirrored) || parsed(saved), function (items, change) {
    if (!served) return;
    mirror(mark + items);
    if (!host || host === window) return;
    try {
      host.postMessage(Object.assign({ type: ${JSON.stringify(STORAGE_MESSAGE)} }, change), '*');
    } catch (error) {}
  }));
  install(window, 'sessionStorage', storage(null, null));
  var jar = new Map();
  try {
    Object.defineProperty(document, 'cookie', {
      enumerable: true,
      configurable: true,
      get: function () {
        var pairs = [];
        jar.forEach(function (value, name) {
          pairs.push(name ? name + '=' + value : value);
        });
        return pairs.join('; ');
      },
      set: function (text) {
        var parts = String(text).split(';');
        var pair = parts.shift();
        var at = pair.indexOf('=');
        var name = at < 0 ? '' : pair.slice(0, at).trim();
        var value = (at < 0 ? pair : pair.slice(at + 1)).trim();
        var expired = parts.some(function (part) {
          var attribute = /^\s*(max-age|expires)\s*=\s*(.*?)\s*$/i.exec(part);
          if (!attribute) return false;
          if (attribute[1].toLowerCase() === 'max-age') {
            return /^-?\d+$/.test(attribute[2]) && Number(attribute[2]) <= 0;
          }
          var when = Date.parse(attribute[2]);
          return !isNaN(when) && when <= Date.now();
        });
        if (expired) jar.delete(name);
        else jar.set(name, value);
      }
    });
  } catch (error) {}
  try {
    var getAttribute = Element.prototype.getAttribute;
    var hasAttribute = Element.prototype.hasAttribute;
    var setAttribute = Element.prototype.setAttribute;
    var findBase = Document.prototype.querySelector;
    var formAction = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get;
    var away = served ? '_top' : '_blank';
    var targetOf = function (element, name) {
      if (hasAttribute.call(element, name)) return getAttribute.call(element, name) || '';
      var base = findBase.call(document, 'base[target]');
      return (base && getAttribute.call(base, 'target')) || '';
    };
    var staysInFrame = function (target) {
      target = target.toLowerCase();
      return target === '' || target === '_self';
    };
    var address = function (value) {
      try {
        return value ? new URL(value, document.baseURI).href : '';
      } catch (error) {
        return '';
      }
    };
    window.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var path = event.composedPath ? event.composedPath() : [];
      var link = null;
      for (var i = 0; i < path.length && !link; i++) {
        if (path[i].localName === 'a' && path[i].hasAttribute('href')) link = path[i];
      }
      if (!link || !staysInFrame(targetOf(link, 'target'))) return;
      var href = link.getAttribute('href');
      if (href.charAt(0) === '#') {
        event.preventDefault();
        location.hash = href;
      } else if (typeof link.href === 'string' && /^https?:/i.test(link.href)) {
        link.setAttribute('target', away);
      }
    });
    window.addEventListener('submit', function (event) {
      var form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return;
      var button = event.submitter || null;
      var byButton = button !== null && hasAttribute.call(button, 'formtarget');
      var target = byButton ? getAttribute.call(button, 'formtarget') || '' : targetOf(form, 'target');
      if (!staysInFrame(target)) return;
      var action = button !== null && hasAttribute.call(button, 'formaction') ? address(getAttribute.call(button, 'formaction')) : formAction.call(form);
      if (typeof action !== 'string' || !/^https?:/i.test(action)) return;
      if (byButton) setAttribute.call(button, 'formtarget', away);
      else setAttribute.call(form, 'target', away);
    });
  } catch (error) {}
}`

/**
 * Whitespace, comments and processing instructions (`<?xml …?>`), then the doctype. A comment
 * ends at its first `-->`, as the HTML tokenizer ends it, so there is one way to read any run of
 * them: a page of many comments and no doctype fails at once, instead of being retried in every
 * way the comments could be grouped (twice as many with each one more), which froze the tab.
 * The loader runs this same pattern (below).
 */
const LEADING_DOCTYPE = /^(?:\s|<!--(?:(?!-->)[\s\S])*-->|<\?[^>]*>)*<!doctype[^>]*>/i

/*
  THE LOADER, the wrapper's one script. It reads the page from the JSON block and the kept
  storage from the site's localStorage, puts the shim first in the page, hands that to the frame,
  and keeps what the frame posts back — only from that frame, only that message, only strings,
  and only ever under this artifact's own key. Each change is applied to the items kept NOW, read
  when it arrives, not to a copy from when the wrapper loaded: another tab of the same page may
  have written since, and its keys stay. The result must still fit STORAGE_LIMIT.
  `shimmedDoc` below is the same transformation in TypeScript, for the console's preview; its
  doctype pattern is the loader's own, and a test holds the two equal. Last, it focuses the
  frame: the reader's keys belong to the page, as on a page of its own, and a keyboard game
  would otherwise ignore them until clicked.

  `<!-{2}` is `<!--` spelled so that the script never contains the sequence itself (`-{2}>`
  likewise), which is how LEADING_DOCTYPE is written into it.
*/
export const LOADER = String.raw`(function () {
  var frame = document.getElementById('artifact');
  var block = document.getElementById('artifact-source');
  if (!frame || !block) return;
  var source;
  try {
    source = JSON.parse(block.textContent);
  } catch (error) {
    return;
  }
  if (typeof source !== 'string') return;
  var key = ${JSON.stringify(STORAGE_KEY_PREFIX)} + frame.getAttribute('data-id');
  var saved = null;
  try {
    saved = window.localStorage.getItem(key);
  } catch (error) {}
  function put(items, name, value) {
    Object.defineProperty(items, name, { value: value, enumerable: true, writable: true, configurable: true });
  }
  function kept() {
    var items = {};
    try {
      var stored = JSON.parse(window.localStorage.getItem(key));
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        Object.keys(stored).forEach(function (name) {
          if (typeof stored[name] === 'string') put(items, name, stored[name]);
        });
      }
    } catch (error) {}
    return items;
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== frame.contentWindow || !data || data.type !== ${JSON.stringify(STORAGE_MESSAGE)}) return;
    var items;
    if (data.op === 'clear') {
      items = {};
    } else if (typeof data.key !== 'string' || data.key.length > ${String(STORAGE_LIMIT)}) {
      return;
    } else if (data.op === 'remove') {
      items = kept();
      delete items[data.key];
    } else if (data.op === 'set' && typeof data.value === 'string' && data.value.length <= ${String(STORAGE_LIMIT)}) {
      items = kept();
      put(items, data.key, data.value);
    } else {
      return;
    }
    var json = JSON.stringify(items);
    if (json.length > ${String(STORAGE_LIMIT)}) return;
    try {
      window.localStorage.setItem(key, json);
    } catch (error) {}
  });
  function literal(text) {
    if (text === null) return 'null';
    return JSON.stringify(text).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  var text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  var lead = /${LEADING_DOCTYPE.source.replace(/--/g, '-{2}')}/i.exec(text);
  var at = lead ? lead[0].length : 0;
  var shim = '<script>(' + ${JSON.stringify(SHIM)} + ')(' + literal(saved) + ', true)</' + 'script>';
  frame.srcdoc = text.slice(0, at) + shim + text.slice(at);
  frame.focus();
})();`

/** A string as a JS literal fit for a <script>: no `<`, no line separators old engines refuse. */
function scriptLiteral(text: string | null): string {
  if (text === null) return 'null'
  return JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The page with the shim as its first script: right after a leading doctype, so the page keeps
 * its rendering mode, else at the very start. A BOM means nothing in a string and is dropped.
 * The loader does exactly this in the browser, with `served` true.
 */
export function shimmedDoc(source: string, saved: string | null, served: boolean): string {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const at = LEADING_DOCTYPE.exec(text)?.[0].length ?? 0
  const shim = `<script>(${SHIM})(${scriptLiteral(saved)}, ${String(served)})</script>`
  return text.slice(0, at) + shim + text.slice(at)
}

/** The console's preview of a page: the same shim, nothing kept, links to a new tab. */
export const previewDoc = (source: string) => shimmedDoc(source, null, false)

/** The page as the JSON block carries it: with every `<` escaped, nothing in it ends the block. */
const sourceJson = (source: string) => JSON.stringify(source).replace(/</g, '\\u003c')

const SOURCE_BLOCK = /<script type="application\/json" id="artifact-source">([^<]*)<\/script>/

const STYLE = [
  'html,body{margin:0;height:100%}',
  'iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}',
  'noscript p{position:relative;margin:2rem 1rem;font:16px/1.5 system-ui,sans-serif;text-align:center}',
].join('')

/**
 * The file served at artifact/<id>.html. Without the sandbox it is the page itself, byte for
 * byte. With it, the wrapper: the page's title, description, preview image and icon for tabs
 * and link previews (a frame's own are not read), the frame, and the page as data.
 *
 * `allow` is what the frame may ask the browser for: FRAME_ALLOW in the served file. The
 * console's preview in a tab of its own is this same wrapper, and passes PREVIEW_ALLOW.
 */
export function artifactHtml(
  { id, title, source, sandbox, meta }: ArtifactPage,
  allow = FRAME_ALLOW,
): string {
  if (!sandbox) return source
  const name = escapeHtml(title)
  const description = escapeHtml(meta.description)
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${name}</title>`,
    ...(description ? [`<meta name="description" content="${description}">`] : []),
    `<meta property="og:title" content="${name}">`,
    ...(description ? [`<meta property="og:description" content="${description}">`] : []),
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${escapeHtml(artifactUrl(id))}">`,
    ...(meta.image ? [`<meta property="og:image" content="${escapeHtml(meta.image)}">`] : []),
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
    ...(meta.icon ? [`<link rel="icon" href="${escapeHtml(meta.icon)}">`] : []),
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<iframe id="artifact" data-id="${escapeHtml(id)}" title="${name}" sandbox="${SANDBOX_FLAGS}" allow="${escapeHtml(allow)}" allowfullscreen></iframe>`,
    '<noscript>',
    '<p lang="en">This page needs JavaScript.</p>',
    '<p lang="vi">Trang này cần bật JavaScript.</p>',
    '</noscript>',
    `<script type="application/json" id="artifact-source">${sourceJson(source)}</script>`,
    `<script>${LOADER}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * The page inside a served file: artifactHtml's inverse. Null when a sandboxed file holds no
 * page in the form the wrapper writes — hand-made, or not a wrapper at all.
 */
export function artifactSource(served: string, sandbox: boolean): string | null {
  if (!sandbox) return served
  const json = SOURCE_BLOCK.exec(served)?.[1]
  if (json === undefined) return null
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- *
 * Reading a page's head — with regular expressions, not a DOM, so it runs in the tests' Node
 * too. A page that hides its title somewhere clever only loses a prefilled field.
 * ---------------------------------------------------------------- */

/** The entities titles and descriptions actually use; numeric references cover the rest. */
const ENTITIES = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    laquo: '«',
    raquo: '»',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    bull: '•',
    middot: '·',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
    times: '×',
    euro: '€',
  }),
)

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);?/gi, (match: string, body: string) => {
    if (!body.startsWith('#')) return ENTITIES.get(body) ?? match
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    return valid ? String.fromCodePoint(code) : '\uFFFD'
  })
}

/** Markup's text as one line: entities decoded, whitespace runs collapsed. */
const plain = (html: string) => decodeEntities(html).replace(/\s+/g, ' ').trim()

/**
 * The markup inside the page's first `<name …>…</name>`, or null. The start tag is found once,
 * then its end tag searched for once. A lazy pattern would be retried from every later start
 * tag, each time scanning to the end of the page, so a page of many unclosed ones took time
 * quadratic in its length; and the sheet asks on every change to the pasted HTML.
 */
function firstElement(source: string, name: 'title' | 'h1'): string | null {
  const start = new RegExp(`<${name}\\b`, 'i').exec(source)
  const open = start ? source.indexOf('>', start.index) : -1
  if (open < 0) return null
  const end = new RegExp(`</${name}\\s*>`, 'gi')
  end.lastIndex = open + 1
  const close = end.exec(source)
  return close ? source.slice(open + 1, close.index) : null
}

/** The page's `<title>`, else its first `<h1>`'s text, else ''. */
export function htmlTitle(source: string): string {
  const title = firstElement(source, 'title')
  const titled = title === null ? '' : plain(title)
  if (titled) return titled
  const heading = firstElement(source, 'h1')
  // `[^<>]`: a `<` that never closes ends its own try at the next `<`, not at the far end.
  return heading === null ? '' : plain(heading.replace(/<[^<>]*>/g, ''))
}

/** A tag's attributes: names lowercased, values decoded, the first of a repeated name kept. */
function attributes(inside: string): Map<string, string> {
  const found = new Map<string, string>()
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const [, name = '', double, single, bare] of inside.matchAll(pattern)) {
    const key = name.toLowerCase()
    if (!found.has(key)) found.set(key, decodeEntities(double ?? single ?? bare ?? ''))
  }
  return found
}

/**
 * Where the start tag whose attributes begin at `from` ends: its first `>` outside quotes, or -1
 * when a quote or the tag itself is left open to the end of the text.
 */
function tagEnd(html: string, from: number): number {
  for (let at = from; at < html.length; at++) {
    const char = html[at]
    if (char === '>') return at
    if (char === '"' || char === "'") {
      at = html.indexOf(char, at + 1)
      if (at < 0) return -1
    }
  }
  return -1
}

/**
 * Every `<name …>` start tag's attributes, in one pass over the text. A quoted `>` does not end
 * a tag. A tag left open runs to the end of the text, as the HTML tokenizer reads it, so no tag
 * follows it; a pattern retried at every later `<name` would scan to the end each time.
 */
function tags(html: string, name: string): Map<string, string>[] {
  const found: Map<string, string>[] = []
  const start = new RegExp(`<${name}\\b`, 'gi')
  let match = start.exec(html)
  while (match !== null) {
    const from = match.index + match[0].length
    const end = tagEnd(html, from)
    if (end < 0) break
    found.push(attributes(html.slice(from, end)))
    start.lastIndex = end + 1
    match = start.exec(html)
  }
  return found
}

/**
 * How much of a page is searched for its head's tags. They come first in a head, and a
 * single-file app may put megabytes of inline script ahead of its body: all of it would be
 * scanned for nothing, on every change to the pasted HTML.
 */
const HEAD_LIMIT = 256 * 1024

/** What the wrapper's head repeats from the page's: its description, preview image and icon. */
export function htmlMeta(source: string): HtmlMeta {
  // Only the head is read: the body can be megabytes of inline data with nothing to say here.
  const text = source.slice(0, HEAD_LIMIT)
  const end = /<\/head\s*>|<body\b/i.exec(text)
  const head = end ? text.slice(0, end.index) : text
  const metas = tags(head, 'meta')
  const content = (...names: string[]) => {
    for (const name of names) {
      const tag = metas.find((attrs) =>
        [attrs.get('name'), attrs.get('property')].some((v) => v?.trim().toLowerCase() === name),
      )
      const value = tag?.get('content')?.replace(/\s+/g, ' ').trim()
      if (value) return value
    }
    return ''
  }
  const image = content('og:image', 'twitter:image')
  const icon =
    tags(head, 'link')
      .find((attrs) => (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('icon'))
      ?.get('href')
      ?.trim() ?? ''
  return {
    description: content('description', 'og:description'),
    image: /^https:\/\//i.test(image) ? image : '',
    icon: /^(?:data:image\/|https:\/\/)/i.test(icon) ? icon : '',
  }
}
