// @vitest-environment jsdom
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  STORAGE_LIMIT,
  STORAGE_MESSAGE,
  STORAGE_MIRROR,
  artifactHtml,
  htmlMeta,
  previewDoc,
  shimmedDoc,
} from './wrapper'

/*
  The shim and the loader, run for real. Each page gets a fresh jsdom document at about:srcdoc:
  an opaque origin, where — as in the sandboxed frame — touching localStorage throws. The
  wrapper runs at its real address, so its loader reads and keeps the site's own storage, and
  the frame's posts reach it as the browser would deliver them.
*/

type DomWindow = Window & typeof globalThis

interface Dom {
  readonly window: DomWindow
}

interface DomOptions {
  readonly runScripts: 'dangerously'
  readonly url: string
  readonly beforeParse?: (window: DomWindow) => void
}

// jsdom ships no types; this is the little of its API the tests use.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: DomOptions) => Dom
}

interface Post {
  readonly data: unknown
  readonly origin: string
}

/**
 * What belongs to the frame rather than to the document in it, and so outlives a reload inside
 * the frame: its name. A browser keeps it for the frame; jsdom has no frame to keep it for, so
 * the tests carry it from one document to the next.
 */
interface FrameContext {
  name: string
}

/** A frame's document, run with `parent` standing in for the wrapper. */
function runFrame(
  html: string,
  {
    onPost,
    before,
    context = { name: '' },
  }: {
    onPost?: (data: unknown) => void
    before?: (w: DomWindow) => void
    context?: FrameContext
  } = {},
) {
  const posts: Post[] = []
  const parent = {
    postMessage: (data: unknown, origin: string) => {
      posts.push({ data, origin })
      onPost?.(data)
    },
  }
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'about:srcdoc',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { configurable: true, get: () => parent })
      // As browsers define it: an accessor over the frame's name, which the context keeps.
      Object.defineProperty(window, 'name', {
        configurable: true,
        enumerable: true,
        get: () => context.name,
        set: (value: string) => {
          context.name = String(value)
        },
      })
      before?.(window)
    },
  })
  return { window: dom.window, posts, context }
}

/** What the frame posted, as the wrapper receives it. */
const posted = (posts: readonly Post[]) => posts.map((post) => post.data)

/** A change as the shim posts it. */
const change = (fields: { op: string; key?: string; value?: string }) => ({
  type: STORAGE_MESSAGE,
  ...fields,
})

/** The localStorage items a frame's name mirrors, or null when it holds no mirror. */
function mirrored(context: FrameContext): unknown {
  return context.name.startsWith(STORAGE_MIRROR)
    ? JSON.parse(context.name.slice(STORAGE_MIRROR.length))
    : null
}

describe('the shim', () => {
  it('stands in for storage where the opaque origin would throw', () => {
    // The control: the same frame without the shim, as a page would meet it.
    expect(() => runFrame('<p>x</p>').window.localStorage).toThrow(/opaque origins/)
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true))
    expect(() => window.localStorage.getItem('x')).not.toThrow()
    expect(() => window.sessionStorage.getItem('x')).not.toThrow()
    expect(() => {
      window.document.cookie = 'a=1'
    }).not.toThrow()
  })

  it('behaves like Storage through its methods', () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true))
    const ls = window.localStorage
    ls.setItem('a', '1')
    ls.setItem('n', 5 as unknown as string)
    ls.setItem(7 as unknown as string, true as unknown as string)
    expect(ls.getItem('a')).toBe('1')
    expect(ls.getItem('n')).toBe('5')
    expect(ls.getItem('7')).toBe('true')
    expect(ls.getItem('missing')).toBeNull()
    expect(ls).toHaveLength(3)
    expect([ls.key(0), ls.key(1), ls.key(2), ls.key(3), ls.key(-1)]).toEqual([
      'a',
      'n',
      '7',
      null,
      null,
    ])
    ls.removeItem('n')
    expect(ls.getItem('n')).toBeNull()
    expect(ls).toHaveLength(2)
    ls.clear()
    expect(ls).toHaveLength(0)
  })

  it('behaves like Storage through properties, `in`, Object.keys and JSON', () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true))
    const ls = window.localStorage
    ls.theme = 'dark'
    expect(ls.getItem('theme')).toBe('dark')
    expect(ls.theme as unknown).toBe('dark')
    expect('theme' in ls).toBe(true)
    expect('nothing' in ls).toBe(false)
    expect('getItem' in ls).toBe(true)
    ls.setItem('score', '42')
    expect(Object.keys(ls)).toEqual(['theme', 'score'])
    expect(JSON.stringify(ls)).toBe('{"theme":"dark","score":"42"}')
    expect(Object.prototype.toString.call(ls)).toBe('[object Storage]')
    delete ls.theme
    expect(ls.getItem('theme')).toBeNull()
    expect(Object.keys(ls)).toEqual(['score'])
  })

  it('keeps its methods when an item is named like one, as Storage does', () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true))
    const ls = window.localStorage
    ls.setItem('getItem', 'shadow')
    Reflect.set(ls, 'length', 99)
    expect(typeof ls.getItem).toBe('function')
    expect(ls.getItem('getItem')).toBe('shadow')
    expect(ls.getItem('length')).toBe('99')
    expect(ls).toHaveLength(2)
  })

  it('starts from the kept items, dropping anything that is not a string', () => {
    const saved = JSON.stringify({ a: '1', n: 2, o: {}, empty: '' })
    const { window } = runFrame(shimmedDoc('<p>x</p>', saved, true))
    expect(Object.keys(window.localStorage)).toEqual(['a', 'empty'])
    expect(window.localStorage.getItem('empty')).toBe('')
    for (const broken of ['not json', '["a"]', 'null', '"text"']) {
      expect(runFrame(shimmedDoc('<p>x</p>', broken, true)).window.localStorage).toHaveLength(0)
    }
  })

  it('posts each change to the wrapper as that one change, and only a change', () => {
    const { window, posts } = runFrame(shimmedDoc('<p>x</p>', '{"kept":"yes"}', true))
    const ls = window.localStorage
    ls.setItem('a', '1')
    expect(posts.at(-1)?.origin).toBe('*')
    ls.setItem('a', '1')
    ls.removeItem('missing')
    expect(posts).toHaveLength(1)
    ls.b = '2'
    delete ls.kept
    ls.clear()
    ls.clear()
    // Never the whole map: another tab of the page keeps keys this one has not seen.
    expect(posted(posts)).toEqual([
      change({ op: 'set', key: 'a', value: '1' }),
      change({ op: 'set', key: 'b', value: '2' }),
      change({ op: 'remove', key: 'kept' }),
      change({ op: 'clear' }),
    ])
  })

  it('keeps an item named __proto__ as an item', () => {
    const { window, posts, context } = runFrame(shimmedDoc('<p>x</p>', null, true))
    window.localStorage.setItem('__proto__', 'x')
    expect(window.localStorage.getItem('__proto__')).toBe('x')
    expect(posted(posts)).toEqual([change({ op: 'set', key: '__proto__', value: 'x' })])
    expect(context.name).toBe(`${STORAGE_MIRROR}{"__proto__":"x"}`)
  })

  it('posts nothing in the preview, and neither reads nor writes a mirror', () => {
    const name = `${STORAGE_MIRROR}{"a":"from a published page"}`
    const { window, posts, context } = runFrame(previewDoc('<p>x</p>'), {
      context: { name },
    })
    expect(window.localStorage.getItem('a')).toBeNull()
    window.localStorage.setItem('a', '1')
    expect(window.localStorage.getItem('a')).toBe('1')
    expect(posts).toEqual([])
    expect(context.name).toBe(name)
  })

  it('refuses more than the wrapper keeps, as a full Storage does, and changes nothing', () => {
    const { window, posts, context } = runFrame(shimmedDoc('<p>x</p>', null, true))
    const ls = window.localStorage
    ls.setItem('a', '1')
    let thrown: unknown = null
    try {
      ls.setItem('big', 'x'.repeat(STORAGE_LIMIT))
    } catch (error) {
      thrown = error
    }
    expect((thrown as { name?: unknown } | null)?.name).toBe('QuotaExceededError')
    expect(ls.getItem('big')).toBeNull()
    expect(Object.keys(ls)).toEqual(['a'])
    expect(posts).toHaveLength(1)
    expect(mirrored(context)).toEqual({ a: '1' })
    // Replacing a value that then would not fit puts the old value back.
    try {
      ls.setItem('a', 'x'.repeat(STORAGE_LIMIT))
    } catch {
      // Expected: QuotaExceededError, checked above.
    }
    expect(ls.getItem('a')).toBe('1')
  })

  it('keeps sessionStorage apart, in memory only', () => {
    const { window, posts, context } = runFrame(shimmedDoc('<p>x</p>', '{"a":"1"}', true))
    window.sessionStorage.setItem('tab', 'one')
    expect(window.sessionStorage.getItem('tab')).toBe('one')
    expect(window.sessionStorage.getItem('a')).toBeNull()
    expect(window.localStorage.getItem('tab')).toBeNull()
    expect(posts).toEqual([])
    expect(context.name).toBe('')
  })

  it('keeps cookies in a jar, and drops one that expires', () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true))
    const doc = window.document
    doc.cookie = 'a=1'
    doc.cookie = 'b = two words ; path=/; SameSite=Lax'
    doc.cookie = 'flag'
    expect(doc.cookie).toBe('a=1; b=two words; flag')
    doc.cookie = 'a=; Max-Age=0'
    doc.cookie = 'b=gone; expires=Thu, 01 Jan 1970 00:00:00 GMT'
    doc.cookie = 'c=3; max-age=nonsense'
    expect(doc.cookie).toBe('flag; c=3')
  })

  it("runs before the page's own scripts", () => {
    const page =
      '<!DOCTYPE html><html><head><script>' +
      'var n = Number(localStorage.getItem("count") || "0") + 1;' +
      'localStorage.setItem("count", String(n));' +
      'document.documentElement.dataset.count = String(n);' +
      '</script></head><body></body></html>'
    const { window, posts } = runFrame(shimmedDoc(page, '{"count":"2"}', true))
    expect(window.document.documentElement.dataset.count).toBe('3')
    expect(posted(posts)).toEqual([change({ op: 'set', key: 'count', value: '3' })])
    // Still a standards-mode document: the shim went in after the doctype.
    expect(window.document.compatMode).toBe('CSS1Compat')
  })

  it('leaves the page running when the browser refuses a stand-in', () => {
    const page = '<script>document.documentElement.dataset.after = "ran"</script>'
    const { window } = runFrame(shimmedDoc(page, null, true), {
      before: (w) => {
        Object.defineProperty(w, 'localStorage', { value: 'native', configurable: false })
      },
    })
    expect(window.localStorage as unknown).toBe('native')
    expect(window.document.documentElement.dataset.after).toBe('ran')
    expect(window.sessionStorage.getItem('x')).toBeNull()
  })
})

describe("the shim's mirror in the frame's name", () => {
  /** A todo list that shows what it kept, and a "Clear all" that clears it and reloads. */
  const todos =
    '<!DOCTYPE html><body><script>' +
    'document.body.dataset.todos = localStorage.getItem("todos") || "none";' +
    'document.body.dataset.lang = localStorage.getItem("lang") || "en";' +
    '</script></body>'

  it('mirrors the items after every change', () => {
    const { window, context } = runFrame(shimmedDoc('<p>x</p>', '{"kept":"yes"}', true))
    expect(context.name).toBe('')
    window.localStorage.setItem('a', '1')
    expect(context.name).toBe(`${STORAGE_MIRROR}{"kept":"yes","a":"1"}`)
    window.localStorage.removeItem('kept')
    expect(mirrored(context)).toEqual({ a: '1' })
    window.localStorage.clear()
    expect(context.name).toBe(`${STORAGE_MIRROR}{}`)
  })

  it('outlives a reload inside the frame, which reruns the srcdoc and its stale copy', () => {
    // The srcdoc carries the copy the wrapper read when it loaded; a reload runs it again.
    const doc = shimmedDoc(todos, '{"todos":"milk,eggs"}', true)
    const first = runFrame(doc)
    expect(first.window.document.body.dataset.todos).toBe('milk,eggs')
    first.window.localStorage.clear()
    first.window.localStorage.setItem('lang', 'vi')

    const reloaded = runFrame(doc, { context: first.context })
    expect(reloaded.window.document.body.dataset.todos).toBe('none')
    expect(reloaded.window.document.body.dataset.lang).toBe('vi')
    // The next write is that one change, so the cleared list cannot come back with it.
    reloaded.window.localStorage.setItem('todos', 'bread')
    expect(posted(reloaded.posts)).toEqual([change({ op: 'set', key: 'todos', value: 'bread' })])
    expect(mirrored(reloaded.context)).toEqual({ lang: 'vi', todos: 'bread' })
  })

  it('gives the page a window.name of its own, so it neither sees nor overwrites the mirror', () => {
    const page =
      '<body><script>' +
      'document.body.dataset.name = window.name;' +
      'window.name = "page state";' +
      'document.body.dataset.after = name;' +
      '</script></body>'
    const doc = shimmedDoc(page, null, true)
    const first = runFrame(doc)
    expect(first.window.document.body.dataset.after).toBe('page state')
    first.window.localStorage.setItem('a', '1')
    expect(first.window.name).toBe('page state')
    expect(mirrored(first.context)).toEqual({ a: '1' })

    const reloaded = runFrame(doc, { context: first.context })
    expect(reloaded.window.document.body.dataset.name).toBe('')
    expect(reloaded.window.localStorage.getItem('a')).toBe('1')
    expect(mirrored(reloaded.context)).toEqual({ a: '1' })
  })

  it("leaves the page a frame name that is not a mirror, and the saved copy's items", () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', '{"a":"saved"}', true), {
      context: { name: 'named by someone' },
    })
    expect(window.name).toBe('named by someone')
    expect(window.localStorage.getItem('a')).toBe('saved')
  })

  it('falls back to the saved copy when the mirror cannot be read', () => {
    for (const broken of ['not json', '["a"]', '"text"', 'null']) {
      const { window } = runFrame(shimmedDoc('<p>x</p>', '{"a":"saved"}', true), {
        context: { name: `${STORAGE_MIRROR}${broken}` },
      })
      expect(window.localStorage.getItem('a'), broken).toBe('saved')
      expect(window.name).toBe('')
    }
  })

  it('still mirrors where the name is a plain property it cannot stand in for', () => {
    const { window } = runFrame(shimmedDoc('<p>x</p>', null, true), {
      before: (w) => {
        Object.defineProperty(w, 'name', { value: '', writable: true, configurable: true })
      },
    })
    window.localStorage.setItem('a', '1')
    expect(window.name).toBe(`${STORAGE_MIRROR}{"a":"1"}`)
  })
})

/** Clicks or submits with navigation stopped afterwards, so jsdom is not asked to navigate. */
function stopped(window: DomWindow, type: 'click' | 'submit', act: () => void) {
  const stop = (event: Event) => {
    event.preventDefault()
  }
  window.addEventListener(type, stop)
  act()
  window.removeEventListener(type, stop)
}

describe("the shim's links", () => {
  const page =
    '<a id="part" href="#part-2">Part 2</a>' +
    '<a id="out" href="https://example.com/">Out</a>' +
    '<a id="blank" href="https://example.com/" target="_blank">New tab</a>' +
    '<a id="routed" href="https://example.com/app">Routed</a>' +
    '<h2 id="part-2">Part 2</h2>'

  function click(window: DomWindow, id: string, init: MouseEventInit = {}) {
    const link = window.document.getElementById(id)
    stopped(window, 'click', () => {
      link?.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
      )
    })
    return link
  }

  it('moves to an in-page anchor within the frame', () => {
    const { window } = runFrame(shimmedDoc(page, null, true))
    click(window, 'part')
    expect(window.location.hash).toBe('#part-2')
  })

  it('sends a plain web link to the whole tab, or to a new tab from the preview', () => {
    expect(
      click(runFrame(shimmedDoc(page, null, true)).window, 'out')?.getAttribute('target'),
    ).toBe('_top')
    expect(click(runFrame(previewDoc(page)).window, 'out')?.getAttribute('target')).toBe('_blank')
  })

  it('leaves a link alone when it names its own target, a key is held, or the page handled it', () => {
    const { window } = runFrame(shimmedDoc(page, null, true))
    expect(click(window, 'blank')?.getAttribute('target')).toBe('_blank')
    expect(click(window, 'out', { metaKey: true })?.getAttribute('target')).toBeNull()
    window.document.getElementById('routed')?.addEventListener('click', (event) => {
      event.preventDefault()
    })
    expect(click(window, 'routed')?.getAttribute('target')).toBeNull()
  })

  it("aims a link by the page's <base target>, as the browser does", () => {
    const based =
      '<base href="https://example.com/"><base target="_blank">' +
      '<a id="out" href="https://example.com/">Out</a>' +
      '<a id="self" href="https://example.com/" target="_SELF">Self</a>' +
      '<a id="part" href="#part-2">Part 2</a>'
    const { window } = runFrame(shimmedDoc(based, null, true))
    // The base already sends it to a new tab: left so, not taken over for the whole tab.
    expect(click(window, 'out')?.getAttribute('target')).toBeNull()
    expect(click(window, 'part')?.getAttribute('target')).toBeNull()
    expect(window.location.hash).toBe('')
    // Its own target outranks the base.
    expect(click(window, 'self')?.getAttribute('target')).toBe('_top')
    // A base that keeps links in the frame is no reason to leave one there.
    const selfBase = '<base target="_self"><a id="out" href="https://example.com/">Out</a>'
    const kept = runFrame(shimmedDoc(selfBase, null, true)).window
    expect(click(kept, 'out')?.getAttribute('target')).toBe('_top')
  })
})

describe("the shim's forms", () => {
  const page =
    '<form id="search" action="https://www.google.com/search"><input name="q">' +
    '<button id="go">Search</button></form>' +
    '<form id="blank" action="https://example.com/" target="_blank"><button>Go</button></form>' +
    '<form id="local"><button id="stay">Go</button>' +
    '<button id="far" formaction="https://example.org/find">Find</button></form>' +
    '<form id="buttons" action="https://example.com/">' +
    '<button id="new-tab" formtarget="_blank">Tab</button>' +
    '<button id="here" formtarget="_self">Here</button>' +
    '<button id="empty" formaction="">Nowhere</button></form>'

  /** Submits a form as its button would, and returns the form and that button. */
  function submit(window: DomWindow, formId: string, buttonId?: string) {
    const form = window.document.getElementById(formId) as HTMLFormElement
    const button = buttonId ? (window.document.getElementById(buttonId) as HTMLButtonElement) : null
    stopped(window, 'submit', () => {
      // Enter in a field submits with no button; jsdom wants no argument rather than null.
      if (button) form.requestSubmit(button)
      else form.requestSubmit()
    })
    return { form, button }
  }

  it('sends a form to a web address to the whole tab, or to a new tab from the preview', () => {
    const served = runFrame(shimmedDoc(page, null, true)).window
    expect(submit(served, 'search', 'go').form.getAttribute('target')).toBe('_top')
    const preview = runFrame(previewDoc(page)).window
    expect(submit(preview, 'search', 'go').form.getAttribute('target')).toBe('_blank')
  })

  it('follows the button that submitted it: its own target, its own address', () => {
    const { window } = runFrame(shimmedDoc(page, null, true))
    const tab = submit(window, 'buttons', 'new-tab')
    expect(tab.button?.getAttribute('formtarget')).toBe('_blank')
    expect(tab.form.getAttribute('target')).toBeNull()

    const here = submit(window, 'buttons', 'here')
    expect(here.button?.getAttribute('formtarget')).toBe('_top')
    expect(here.form.getAttribute('target')).toBeNull()

    // A form with no address of its own is sent where its button says.
    expect(submit(window, 'local', 'far').form.getAttribute('target')).toBe('_top')
  })

  it('leaves a form alone when it names its target, goes nowhere on the web, or was handled', () => {
    const { window } = runFrame(shimmedDoc(page, null, true))
    expect(submit(window, 'blank').form.getAttribute('target')).toBe('_blank')
    // No action is the srcdoc document itself, and an empty formaction is too.
    expect(submit(window, 'local', 'stay').form.getAttribute('target')).toBeNull()
    expect(submit(window, 'buttons', 'empty').form.getAttribute('target')).toBeNull()
    window.document.getElementById('search')?.addEventListener('submit', (event) => {
      event.preventDefault()
    })
    expect(submit(window, 'search', 'go').form.getAttribute('target')).toBeNull()
  })

  it("aims a form by the page's <base target>", () => {
    const based = `<base target="_blank">${page}`
    const { window } = runFrame(shimmedDoc(based, null, true))
    expect(submit(window, 'search', 'go').form.getAttribute('target')).toBeNull()
  })

  it('works where the event names no submitter, as in older browsers', () => {
    const { window } = runFrame(shimmedDoc(page, null, true))
    const form = window.document.getElementById('search') as HTMLFormElement
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    expect(form.getAttribute('target')).toBe('_top')
  })
})

describe('the loader', () => {
  const counter =
    '<!DOCTYPE html><html><head><title>Counter</title></head><body><script>' +
    'var n = Number(localStorage.getItem("count") || "0") + 1;' +
    'localStorage.setItem("count", String(n));' +
    'document.body.dataset.count = String(n);' +
    '</script></body></html>'

  /** A published wrapper at its real address, with `kept` already in the site's storage. */
  function serve(id: string, kept: string | null, source = counter) {
    const html = artifactHtml({
      id,
      title: 'Counter',
      source,
      sandbox: true,
      meta: htmlMeta(source),
    })
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: `https://bauloc.github.io/artifact/${id}.html`,
      beforeParse(window) {
        window.localStorage.clear()
        if (kept !== null) window.localStorage.setItem(`bauloc:artifact:${id}`, kept)
      },
    })
    const frame = dom.window.document.getElementById('artifact') as HTMLIFrameElement
    const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source }))
    }
    const stored = () => dom.window.localStorage.getItem(`bauloc:artifact:${id}`)
    return { window: dom.window, frame, post, stored }
  }

  it('hands the frame the page with the shim and the kept storage, as shimmedDoc does', () => {
    const { window, frame } = serve('loader1', '{"count":"2"}')
    expect(frame.getAttribute('srcdoc')).toBe(shimmedDoc(counter, '{"count":"2"}', true))
    expect(window.document.activeElement).toBe(frame)
  })

  it('finds where the shim goes exactly as shimmedDoc does, whatever leads the page', () => {
    const sources = [
      '<p>no doctype</p>',
      '﻿ \n<!-- built 2026 -->\n<?xml version="1.0"?><!DOCTYPE html><p>x</p>',
      '<!----><!-- a -- b --><!DOCTYPE html><p>x</p>',
      '<!-- a --> x --><!DOCTYPE html>',
      '<!-- open --<!DOCTYPE html>',
      '',
    ]
    for (const source of sources) {
      const { frame } = serve('lead', '{"a":"1"}', source)
      expect(frame.getAttribute('srcdoc'), source).toBe(shimmedDoc(source, '{"a":"1"}', true))
    }
  })

  it('reads past many comments with no doctype after them in linear time', () => {
    // 30 empty comments kept the reader's tab busy for seconds with the old pattern.
    const source = `${'<!---->'.repeat(30)}<p>x</p>`
    const start = performance.now()
    const { frame } = serve('comments', null, source)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(frame.getAttribute('srcdoc')).toBe(shimmedDoc(source, null, true))
  })

  it("keeps what the page saves, under the artifact's own key, across visits", () => {
    const first = serve('loader2', '{"count":"2"}')
    const frame = runFrame(first.frame.getAttribute('srcdoc') ?? '', {
      onPost: (data) => {
        first.post(data)
      },
    })
    expect(frame.window.document.body.dataset.count).toBe('3')
    expect(first.stored()).toBe('{"count":"3"}')
    expect(first.window.localStorage).toHaveLength(1)
  })

  it('applies each change to what is kept when it arrives, so another tab keeps its keys', () => {
    const tab = serve('tabs', null, '<p>x</p>')
    const frame = runFrame(tab.frame.getAttribute('srcdoc') ?? '', {
      onPost: (data) => {
        tab.post(data)
      },
    })
    // Another tab of the same page, sharing the site's storage, saved after this one loaded.
    tab.window.localStorage.setItem('bauloc:artifact:tabs', '{"theirs":"b","both":"old"}')
    frame.window.localStorage.setItem('mine', 'a')
    frame.window.localStorage.setItem('both', 'new')
    expect(JSON.parse(tab.stored() ?? 'null')).toEqual({ theirs: 'b', both: 'new', mine: 'a' })
    frame.window.localStorage.removeItem('mine')
    expect(JSON.parse(tab.stored() ?? 'null')).toEqual({ theirs: 'b', both: 'new' })
    frame.window.localStorage.clear()
    expect(tab.stored()).toBe('{}')
  })

  it('ignores every other message', () => {
    const { window, frame, post, stored } = serve('loader3', '{"count":"2"}')
    const set = { type: STORAGE_MESSAGE, op: 'set', key: 'from', value: 'x' }
    post(set, null)
    post(set, window)
    post({ ...set, type: 'other' })
    post({ ...set, op: 'replace' })
    post({ ...set, key: 7 })
    post({ ...set, value: { not: 'a string' } })
    post({ type: STORAGE_MESSAGE, op: 'remove' })
    post({ type: STORAGE_MESSAGE, items: '{"from":"a shim of an older wrapper"}' })
    post({ type: STORAGE_MESSAGE, op: 'clear' }, null)
    post('bauloc:artifact-storage')
    post(null)
    expect(stored()).toBe('{"count":"2"}')
    post({ type: STORAGE_MESSAGE, op: 'set', key: 'count', value: '9' }, frame.contentWindow)
    expect(stored()).toBe('{"count":"9"}')
    expect(window.localStorage).toHaveLength(1)
  })

  it('refuses a change that would keep more than STORAGE_LIMIT, keeping what it had', () => {
    const { window, post, stored } = serve('big', '{"a":"1"}')
    post({ type: STORAGE_MESSAGE, op: 'set', key: 'big', value: 'x'.repeat(STORAGE_LIMIT) })
    expect(stored()).toBe('{"a":"1"}')
    // Small on its own, but not with what another tab already keeps.
    const theirs = JSON.stringify({ theirs: 'y'.repeat(STORAGE_LIMIT - 100) })
    window.localStorage.setItem('bauloc:artifact:big', theirs)
    post({ type: STORAGE_MESSAGE, op: 'set', key: 'mine', value: 'z'.repeat(200) })
    expect(stored()).toBe(theirs)
  })

  it('keeps an item named __proto__ as an item, and starts over from a kept copy it cannot use', () => {
    const proto = serve('proto', 'not json')
    proto.post({ type: STORAGE_MESSAGE, op: 'set', key: '__proto__', value: 'x' })
    expect(proto.stored()).toBe('{"__proto__":"x"}')
    proto.post({ type: STORAGE_MESSAGE, op: 'remove', key: '__proto__' })
    expect(proto.stored()).toBe('{}')
    const mixed = serve('mixed', '{"n":2,"s":"ok"}')
    mixed.post({ type: STORAGE_MESSAGE, op: 'set', key: 'a', value: '1' })
    expect(mixed.stored()).toBe('{"s":"ok","a":"1"}')
  })

  it('still shows the page when the site storage cannot be read', () => {
    const dom = new JSDOM(
      artifactHtml({
        id: 'opaque',
        title: 'x',
        source: '<p>x</p>',
        sandbox: true,
        meta: htmlMeta(''),
      }),
      { runScripts: 'dangerously', url: 'about:blank' },
    )
    const frame = dom.window.document.getElementById('artifact')
    expect(frame?.getAttribute('srcdoc')).toBe(shimmedDoc('<p>x</p>', null, true))
  })
})
