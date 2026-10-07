/*
  The install page's one script, the same bytes in every page: everything it needs to know
  about the build it reads from the markup, so the page's Content-Security-Policy can allow
  exactly this script by its hash and nothing else. That matters on this origin: the console's
  GitHub token lives in its localStorage, and a page that ran any other script could read it.

  It runs in <head>, before the first paint, and sets what the CSS keys on:
    html.dark          the saved theme ('bauloc:theme'), else the system's — as on the whole site
    html[lang]         the saved language ('bauloc:locale'), else the browser's first en/vi
    html[data-device]  ios (iPadOS too: a Mac's user agent with a touch screen), android
                       (Chrome's "Desktop site" too: a Linux user agent with a touch screen, on
                       an ARM chip by navigator.platform — Chrome on Android says 'Linux armv81'
                       even then, a touch-screen Linux laptop 'Linux x86_64'), or desktop
    html[data-browser] in-app (a chat or social app's own browser, which may not download or
                       install: the known apps by name, and any Android WebView or iOS web view
                       without Safari's token), other (an iOS browser that is not Safari), or
                       default
    html.expired       an iOS build whose profile's data-expires has passed
  Then, once the page is parsed, it wires the EN·VI and theme switches and the copy buttons,
  writes each <time> in the reader's zone and language, takes the Install link away where it
  cannot work (the other platform's phone, an expired profile) and marks html.tapped once it is
  tapped.

  ES5 and ASCII only, for the oldest WebView a tester's chat app may open it in. Written as a
  raw string so its backslashes reach the page as they are written here.
*/
export const INSTALL_SCRIPT = String.raw`(function () {
  var d = document
  var root = d.documentElement
  var THEME = 'bauloc:theme'
  var LOCALE = 'bauloc:locale'
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {}
  }
  function all(selector, each) {
    var list = d.querySelectorAll(selector)
    for (var i = 0; i < list.length; i++) each(list[i])
  }

  var system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  function theme() {
    var saved = read(THEME)
    if (saved === 'light' || saved === 'dark') return saved
    return system && system.matches ? 'dark' : 'light'
  }
  function paint(value) {
    if (value === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    var meta = d.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', meta.getAttribute('data-' + value) || '')
  }
  function language() {
    var saved = read(LOCALE)
    if (saved === 'en' || saved === 'vi') return saved
    var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']
    for (var i = 0; i < tags.length; i++) {
      var primary = String(tags[i]).toLowerCase().split('-')[0]
      if (primary === 'en' || primary === 'vi') return primary
    }
    return 'en'
  }

  var ua = navigator.userAgent || ''
  var touch = navigator.maxTouchPoints || 0
  var device = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)
    ? 'ios'
    : /Android/.test(ua) || (/Linux/.test(ua) && !/CrOS/.test(ua) && touch > 1 && /arm|aarch64/i.test(navigator.platform || ''))
      ? 'android'
      : 'desktop'
  var inApp = /FBAN|FBAV|Instagram|Line\/|Zalo|Messenger|TikTok|musical_ly|Bytedance|MicroMessenger|Twitter|Snapchat|GSA\//.test(ua) ||
    (device === 'android' && /; wv\)/.test(ua)) ||
    (device === 'ios' && !/Safari\//.test(ua))
  var other = device === 'ios' && /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|YaBrowser/.test(ua)
  var platform = root.getAttribute('data-platform')
  var wrong = (platform === 'ios' && device === 'android') || (platform === 'android' && device === 'ios')
  var expired = Date.parse(root.getAttribute('data-expires') || '') < new Date().getTime()

  root.setAttribute('data-device', device)
  root.setAttribute('data-browser', inApp ? 'in-app' : other ? 'other' : 'default')
  if (expired) root.classList.add('expired')
  paint(theme())
  root.setAttribute('lang', language())

  function two(n) {
    return (n < 10 ? '0' : '') + n
  }
  function stamp(date, lang) {
    var time = two(date.getHours()) + ':' + two(date.getMinutes())
    var month = lang === 'vi' ? '/' + two(date.getMonth() + 1) + '/' : '-' + MONTHS[date.getMonth()] + '-'
    return two(date.getDate()) + month + date.getFullYear() + ' ' + time
  }
  function name(element, text) {
    if (!text) return
    element.setAttribute('aria-label', text)
    if (element.hasAttribute('title')) element.setAttribute('title', text)
  }
  function word() {
    var lang = root.getAttribute('lang') === 'vi' ? 'vi' : 'en'
    var next = root.classList.contains('dark') ? 'light' : 'dark'
    all('[data-label-en]', function (element) {
      name(element, element.getAttribute('data-label-' + lang))
    })
    all('[data-theme-toggle]', function (element) {
      name(element, element.getAttribute('data-' + next + '-' + lang))
    })
    all('[data-set-lang]', function (element) {
      element.setAttribute('aria-pressed', element.getAttribute('data-set-lang') === lang ? 'true' : 'false')
    })
    all('time[datetime]', function (element) {
      var date = new Date(element.getAttribute('datetime'))
      if (!isNaN(date.getTime())) element.textContent = stamp(date, lang)
    })
  }

  function legacyCopy(text) {
    var area = d.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.className = 'offscreen'
    d.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    var copied = false
    try {
      copied = d.execCommand('copy')
    } catch (e) {}
    d.body.removeChild(area)
    return copied
  }
  function copy(button) {
    var text = button.getAttribute('data-copy') || ''
    var status = d.getElementById('status')
    function done() {
      button.setAttribute('data-state', 'copied')
      if (status) status.textContent = status.getAttribute('data-' + (root.getAttribute('lang') === 'vi' ? 'vi' : 'en')) || ''
      clearTimeout(Number(button.getAttribute('data-timer')))
      button.setAttribute('data-timer', String(setTimeout(function () {
        button.removeAttribute('data-state')
        if (status) status.textContent = ''
      }, 2000)))
    }
    function byHand() {
      if (legacyCopy(text)) return done()
      var host = (button.closest && button.closest('[data-copy-host]')) || button.parentNode
      var field = host.querySelector('.copy-field')
      if (!field) {
        field = d.createElement('input')
        field.className = 'copy-field'
        field.setAttribute('readonly', '')
        host.appendChild(field)
      }
      field.value = text
      field.focus()
      field.setSelectionRange(0, text.length)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, byHand)
    else byHand()
  }

  function ready() {
    word()
    all('[data-set-lang]', function (button) {
      button.addEventListener('click', function () {
        var lang = button.getAttribute('data-set-lang')
        save(LOCALE, lang)
        root.setAttribute('lang', lang)
        word()
      })
    })
    all('[data-theme-toggle]', function (button) {
      button.addEventListener('click', function () {
        var next = root.classList.contains('dark') ? 'light' : 'dark'
        save(THEME, next)
        paint(next)
        word()
      })
    })
    all('[data-copy]', function (button) {
      button.addEventListener('click', function () {
        copy(button)
      })
    })
    all('.install', function (link) {
      if (wrong || expired) {
        link.removeAttribute('href')
        link.setAttribute('aria-disabled', 'true')
      }
      link.addEventListener('click', function () {
        root.classList.add('tapped')
      })
    })
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', ready)
  else ready()

  window.addEventListener('storage', function (event) {
    if (event.key === THEME) paint(theme())
    else if (event.key === LOCALE) root.setAttribute('lang', language())
    else return
    word()
  })
  function followSystem() {
    if (read(THEME) !== 'light' && read(THEME) !== 'dark') {
      paint(theme())
      word()
    }
  }
  if (system && system.addEventListener) system.addEventListener('change', followSystem)
  else if (system && system.addListener) system.addListener(followSystem)
})()`

/**
 * The script's SHA-256, base64: the CSP source that lets it, and only it, run
 * (`script-src 'sha256-…'`). Computed once from the bytes above; install-page.test.ts recomputes
 * it and fails the moment the script changes without it.
 */
export const INSTALL_SCRIPT_SHA256 = 'FnvXJEIgB0EpuzmAjdrJpJOkWJ4rhwS+4OYIzJRjdX8='
