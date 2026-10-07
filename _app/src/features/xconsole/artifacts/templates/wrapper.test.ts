import { Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  FRAME_ALLOW,
  LOADER,
  PREVIEW_ALLOW,
  PREVIEW_SANDBOX_FLAGS,
  SANDBOX_FLAGS,
  SHIM,
  artifactHtml,
  artifactSource,
  htmlMeta,
  htmlTitle,
  previewDoc,
  shimmedDoc,
  type ArtifactPage,
  type HtmlMeta,
} from './wrapper'

/*
  The served file is the security boundary between an uploaded page and the console's token, so
  it is tested as one: what the page can put into the wrapper (nothing executable outside the
  frame), what the frame may do (never share the site's origin), and that the page survives the
  trip into the wrapper and back out byte for byte.
*/

const NO_META: HtmlMeta = { description: '', image: '', icon: '' }

const page = (overrides: Partial<ArtifactPage> = {}): ArtifactPage => ({
  id: 'k3x9q2mf',
  title: 'Quarterly report',
  source: '<!DOCTYPE html><title>Q3</title><p>Hello</p>',
  sandbox: true,
  meta: NO_META,
  ...overrides,
})

/** Pages chosen to break a careless wrapper. */
const NASTY = [
  '</script><script>alert(document.cookie)</script>',
  '<!-- <script> -->',
  '</SCRIPT >',
  'line\u2028separator\u2029paragraph',
  'Phước Lộc 😀 ✓',
  'windows\r\nline\r\nendings\r\n',
  '\uFEFF<!DOCTYPE html><p>a BOM first</p>',
  '<p>no doctype at all</p>',
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>upper</p>',
  '<!doctype html><p>lower</p>',
  'quotes " \' ` and backslashes \\ \\u003c',
  'a lone surrogate \uD800 and a NUL \u0000',
  '',
]

/** The wrapper with its JSON block cut out: everything the page's own text cannot reach. */
const withoutSource = (html: string) =>
  html.replace(/<script type="application\/json" id="artifact-source">[^<]*<\/script>/, '')

/** A start tag's attributes by name. Values are double-quoted and escaped, so `"` ends one. */
const attributesOf = (tag: string) =>
  new Map([...tag.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1]!, m[2] ?? '']))

/** The one <iframe> start tag's attributes. */
const frameAttributes = (html: string) => attributesOf(/<iframe\b[^>]*>/.exec(html)?.[0] ?? '')

/**
 * How long `run` takes, in milliseconds. The pages below took seconds to minutes with the
 * patterns they guard against (each comment doubled the time; unclosed tags made it quadratic);
 * linear code reads them in well under one, so the bound is loose enough for any machine.
 */
function timed(run: () => unknown): number {
  const start = performance.now()
  run()
  return performance.now() - start
}
const FAST_MS = 250

describe('htmlTitle', () => {
  it('reads <title>, entities decoded and whitespace collapsed', () => {
    const source =
      '<head><TITLE lang="en">\n  Tom &amp; Jerry &lt;Pro&gt; &#x1F600;&nbsp;&#8211; v2 </TITLE>'
    expect(htmlTitle(source)).toBe('Tom & Jerry <Pro> 😀 – v2')
  })

  it("falls back to the first <h1>'s text, without its markup", () => {
    expect(
      htmlTitle('<title> </title><h1 class="x">Hello <em>big</em>\n world</h1><h1>No</h1>'),
    ).toBe('Hello big world')
  })

  it('is empty when the page names itself nowhere, and keeps what it cannot decode', () => {
    expect(htmlTitle('<p>Just text</p>')).toBe('')
    expect(htmlTitle('<title>&bogus; &#0; &constructor;</title>')).toBe(
      '&bogus; \uFFFD &constructor;',
    )
  })

  it('reads the first title, wherever its end tag is, and ignores one never closed', () => {
    expect(htmlTitle('<title data-x="1">One</title><title>Two</title>')).toBe('One')
    expect(htmlTitle('<title>Open<h1>Heading</h1>')).toBe('Heading')
    expect(htmlTitle('<title >Spaced</title >')).toBe('Spaced')
    expect(htmlTitle('<titles>Not a title</titles><h1>Real</h1>')).toBe('Real')
  })

  it('takes linear time on a page of unclosed tags', () => {
    expect(timed(() => htmlTitle('<title>'.repeat(40_000)))).toBeLessThan(FAST_MS)
    expect(timed(() => htmlTitle('<title '.repeat(40_000)))).toBeLessThan(FAST_MS)
    expect(timed(() => htmlTitle('<h1>'.repeat(40_000)))).toBeLessThan(FAST_MS)
    expect(timed(() => htmlTitle(`<h1>${'<'.repeat(100_000)}</h1>`))).toBeLessThan(FAST_MS)
    expect(htmlTitle('<title>'.repeat(40_000))).toBe('')
  })
})

describe('htmlMeta', () => {
  it('reads a description whatever the attribute order and quoting', () => {
    const source = `<head><meta content='A "quoted" > description' name=Description></head>`
    expect(htmlMeta(source).description).toBe('A "quoted" > description')
  })

  it('takes the first description, else og:description', () => {
    expect(
      htmlMeta(
        '<meta name="description" content=" one\n two "><meta name="description" content="2">',
      ).description,
    ).toBe('one two')
    expect(htmlMeta('<meta property="og:description" content="From OG">').description).toBe(
      'From OG',
    )
  })

  it('keeps only an https preview image, falling back to twitter:image', () => {
    expect(htmlMeta('<meta property="og:image" content="https://x.dev/a.png">').image).toBe(
      'https://x.dev/a.png',
    )
    expect(htmlMeta('<meta property="og:image" content="http://x.dev/a.png">').image).toBe('')
    expect(htmlMeta('<meta name="twitter:image" content="https://x.dev/t.png">').image).toBe(
      'https://x.dev/t.png',
    )
  })

  it('keeps only a data:image or https icon', () => {
    const icon = (link: string) => htmlMeta(`<head>${link}</head>`).icon
    expect(icon('<link rel="shortcut icon" href="https://x.dev/i.png">')).toBe(
      'https://x.dev/i.png',
    )
    expect(icon('<link href="data:image/svg+xml,<svg/>" rel=icon>')).toBe(
      'data:image/svg+xml,<svg/>',
    )
    expect(icon('<link rel="icon" href="javascript:alert(1)">')).toBe('')
    expect(icon('<link rel="icon" href="/favicon.ico">')).toBe('')
    expect(icon('<link rel="apple-touch-icon" href="https://x.dev/a.png">')).toBe('')
  })

  it('reads only the head', () => {
    expect(
      htmlMeta('<head></head><body><meta name="description" content="late">').description,
    ).toBe('')
  })

  it('looks for the head only in the first 256 KB', () => {
    const meta = '<meta name="description" content="Found">'
    expect(htmlMeta(`<head><script>${'x'.repeat(200_000)}</script>${meta}`).description).toBe(
      'Found',
    )
    expect(htmlMeta(`<head><script>${'x'.repeat(300_000)}</script>${meta}`).description).toBe('')
  })

  it('reads no tag past one left open, as the browser reads none', () => {
    const late = '<meta name="description" content="late">'
    expect(htmlMeta(`<meta name="x" content="open ${late}`).description).toBe('')
    expect(htmlMeta(`<meta name="x" ${late}`).description).toBe('')
    expect(
      htmlMeta(`<meta content="a > b" name="description"><meta name="keywords" content="k">`)
        .description,
    ).toBe('a > b')
  })

  it('takes linear time on a page of unclosed tags and quotes', () => {
    for (const piece of ['<meta ', '<meta content="', "<link href='", '<meta>']) {
      expect(
        timed(() => htmlMeta(piece.repeat(60_000))),
        piece,
      ).toBeLessThan(FAST_MS)
    }
  })
})

describe('artifactHtml without the sandbox', () => {
  it('is the page itself, byte for byte', () => {
    for (const source of NASTY) {
      expect(artifactHtml(page({ source, sandbox: false }))).toBe(source)
      expect(artifactSource(source, false)).toBe(source)
    }
  })
})

describe('artifactHtml with the sandbox', () => {
  it('is a small standards-mode page around one frame', () => {
    const html = artifactHtml(page())
    expect(
      html.startsWith('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'),
    ).toBe(true)
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(html).toContain('<title>Quarterly report</title>')
    expect(html).toContain(
      '<meta property="og:url" content="https://bauloc.github.io/artifact/k3x9q2mf.html">',
    )
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).not.toContain('name="description"')
    expect(html).toContain('<p lang="vi">')
    expect(html.match(/<iframe\b/g)).toHaveLength(1)
    expect(html.endsWith('</html>\n')).toBe(true)
  })

  it('repeats the description, preview image and icon it is given', () => {
    const html = artifactHtml(
      page({
        meta: {
          description: 'Numbers & notes',
          image: 'https://x.dev/a.png?w=1&h=2',
          icon: 'data:image/svg+xml,<svg/>',
        },
      }),
    )
    expect(html).toContain('<meta name="description" content="Numbers &amp; notes">')
    expect(html).toContain('<meta property="og:description" content="Numbers &amp; notes">')
    expect(html).toContain('<meta property="og:image" content="https://x.dev/a.png?w=1&amp;h=2">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,&lt;svg/&gt;">')
  })

  it('never lets the frame share the site origin', () => {
    for (const flags of [SANDBOX_FLAGS, PREVIEW_SANDBOX_FLAGS]) {
      expect(flags).not.toContain('allow-same-origin')
      expect(flags).toContain('allow-scripts')
    }
    expect(PREVIEW_SANDBOX_FLAGS).not.toContain('allow-top-navigation')
    expect(SANDBOX_FLAGS).toContain('allow-top-navigation-by-user-activation')
    // A device grant made to the site must not reach a page that is only being previewed.
    expect(PREVIEW_ALLOW).toBe('fullscreen; clipboard-write; autoplay')
    for (const device of ['camera', 'microphone', 'geolocation', 'display-capture']) {
      expect(PREVIEW_ALLOW).not.toContain(device)
      expect(FRAME_ALLOW).toContain(device)
    }
    for (const source of NASTY) {
      const html = artifactHtml(page({ source }))
      expect(withoutSource(html)).not.toContain('allow-same-origin')
      const frame = frameAttributes(html)
      expect(frame.get('sandbox')).toBe(SANDBOX_FLAGS)
      expect(frame.get('allow')).toBe(FRAME_ALLOW)
      // The clipboard may hold the XConsole token: a page may write it, never read it.
      expect(FRAME_ALLOW).not.toContain('clipboard-read')
    }
  })

  it("gives the console's preview in a tab of its own no device, and changes nothing else", () => {
    const html = artifactHtml(page(), PREVIEW_ALLOW)
    const frame = frameAttributes(html)
    expect(frame.get('allow')).toBe(PREVIEW_ALLOW)
    expect(frame.get('sandbox')).toBe(SANDBOX_FLAGS)
    expect(html.replace(`allow="${PREVIEW_ALLOW}"`, `allow="${FRAME_ALLOW}"`)).toBe(
      artifactHtml(page()),
    )
    // Without the sandbox there is no frame to hold back: the page itself, as ever.
    expect(artifactHtml(page({ sandbox: false }), PREVIEW_ALLOW)).toBe(page().source)
  })

  it('escapes the title, the id and every meta value, so none can add markup or attributes', () => {
    const evil = '" sandbox="allow-same-origin allow-scripts" onload="alert(1)'
    const html = artifactHtml(
      page({
        id: 'a"b',
        title: `</title><script>alert(1)</script>${evil}`,
        meta: { description: evil, image: `https://x.dev/${evil}`, icon: `https://x.dev/${evil}` },
      }),
    )
    const frame = frameAttributes(html)
    expect(frame.get('sandbox')).toBe(SANDBOX_FLAGS)
    expect(frame.has('onload')).toBe(false)
    expect(frame.get('data-id')).toBe('a&quot;b')
    expect(html).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot; sandbox',
    )
    // The loader's own text writes a <script> tag for the frame; nothing else may.
    expect(html.replace(LOADER, '').match(/<script\b/g)).toHaveLength(2)
    for (const tag of html.replace(LOADER, '').match(/<[a-z]+\b[^>]*>/g) ?? []) {
      const names = [...attributesOf(tag).keys()]
      expect(names, tag).not.toContain('onload')
      if (!tag.startsWith('<iframe')) expect(names, tag).not.toContain('sandbox')
    }
  })

  it('carries the page as data no `<` can end, then the constant loader', () => {
    for (const source of NASTY) {
      const html = artifactHtml(page({ source }))
      const block =
        /<script type="application\/json" id="artifact-source">([\s\S]*?)<\/script>/.exec(html)?.[1]
      expect(block).toBeDefined()
      expect(block).not.toContain('<')
      // Two script elements, each ended exactly once: nothing in the page closed one early.
      expect(html.match(/<\/script>/gi)).toHaveLength(2)
      expect(html).toContain(`<script>${LOADER}</script>`)
    }
  })

  it('round-trips every page exactly', () => {
    for (const source of NASTY) {
      expect(artifactSource(artifactHtml(page({ source })), true)).toBe(source)
    }
  })

  it('finds no page in a file it did not write', () => {
    expect(artifactSource('<!DOCTYPE html><p>raw</p>', true)).toBeNull()
    expect(
      artifactSource(
        '<script type="application/json" id="artifact-source">{"not":1}</script>',
        true,
      ),
    ).toBeNull()
    expect(
      artifactSource('<script type="application/json" id="artifact-source">"x</script>', true),
    ).toBeNull()
  })
})

describe('the loader and the shim', () => {
  it('can sit inside a <script> element: no end tag, no comment opener, no line separators', () => {
    for (const script of [LOADER, SHIM]) {
      expect(script).not.toMatch(/<\/script/i)
      expect(script).not.toContain('<!--')
      expect(script).not.toMatch(/[\u2028\u2029]/)
    }
  })

  it('parse as JavaScript', () => {
    // Compiled, not run: running them is the jsdom suite's job (wrapper.dom.test.ts).
    expect(() => new Script(LOADER)).not.toThrow()
    expect(() => new Script(`(${SHIM})`)).not.toThrow()
  })

  it("find the doctype with shimmedDoc's own pattern", () => {
    // Written into the loader with `-{2}` for `--`; read back, it is the same pattern.
    const pattern = /var lead = \/(.+)\/i\.exec\(text\);/.exec(LOADER)?.[1]
    expect(pattern).toContain('-{2}')
    const text = '\n<!-- a -->\n<?xml version="1.0"?><!DOCTYPE html><p>x</p>'
    expect(new RegExp(pattern ?? '', 'i').exec(text)?.[0]).toBe(
      '\n<!-- a -->\n<?xml version="1.0"?><!DOCTYPE html>',
    )
    expect(pattern?.replaceAll('-{2}', '--')).toBe(
      String.raw`^(?:\s|<!--(?:(?!-->)[\s\S])*-->|<\?[^>]*>)*<!doctype[^>]*>`,
    )
  })

  it('hold no artifact of their own: every wrapper runs the same loader', () => {
    const a = artifactHtml(page({ id: 'aaaa', source: '<p>a</p>' }))
    const b = artifactHtml(page({ id: 'bbbb', source: '<p>b</p>' }))
    expect(a).toContain(`<script>${LOADER}</script>`)
    expect(b).toContain(`<script>${LOADER}</script>`)
    expect(LOADER).not.toMatch(/aaaa|bbbb/)
  })
})

describe('shimmedDoc', () => {
  const shimTag = (saved: string, served: boolean) =>
    `<script>(${SHIM})(${saved}, ${String(served)})</script>`

  it('puts the shim right after a leading doctype, so the page keeps its mode', () => {
    expect(shimmedDoc('<!DOCTYPE html><p>x</p>', null, true)).toBe(
      `<!DOCTYPE html>${shimTag('null', true)}<p>x</p>`,
    )
    expect(shimmedDoc('<!doctype HTML>\n<p>x</p>', null, false)).toBe(
      `<!doctype HTML>${shimTag('null', false)}\n<p>x</p>`,
    )
  })

  it('looks past a BOM, whitespace, comments and an XML declaration to find the doctype', () => {
    const source = '\uFEFF \n<!-- built 2026 -->\n<?xml version="1.0"?><!DOCTYPE html><p>x</p>'
    expect(shimmedDoc(source, null, true)).toBe(
      ` \n<!-- built 2026 -->\n<?xml version="1.0"?><!DOCTYPE html>${shimTag('null', true)}<p>x</p>`,
    )
  })

  it('goes first when the page has no leading doctype', () => {
    expect(shimmedDoc('<p>x</p>', null, true)).toBe(`${shimTag('null', true)}<p>x</p>`)
    expect(shimmedDoc('<p>x</p><!DOCTYPE html>', null, true)).toBe(
      `${shimTag('null', true)}<p>x</p><!DOCTYPE html>`,
    )
    expect(shimmedDoc('\uFEFF<p>x</p>', null, true)).toBe(`${shimTag('null', true)}<p>x</p>`)
  })

  it('ends a comment at its first `-->`, as the browser does', () => {
    // Text after a comment's end is content, so a doctype after it no longer leads the page.
    expect(shimmedDoc('<!-- a --> x --><!DOCTYPE html>', null, true)).toBe(
      `${shimTag('null', true)}<!-- a --> x --><!DOCTYPE html>`,
    )
    // A `--` inside a comment does not end it; nor does a comment that never closes lead.
    expect(shimmedDoc('<!----><!-- a -- b --><!DOCTYPE html>', null, true)).toBe(
      `<!----><!-- a -- b --><!DOCTYPE html>${shimTag('null', true)}`,
    )
    expect(shimmedDoc('<!-- open --<!DOCTYPE html>', null, true)).toBe(
      `${shimTag('null', true)}<!-- open --<!DOCTYPE html>`,
    )
  })

  it('takes linear time on many comments with no doctype after them', () => {
    // 30 empty comments took about four seconds with comments that could run on past `-->`.
    const comments = '<!---->'.repeat(30)
    expect(timed(() => previewDoc(`${comments}<p>x</p>`))).toBeLessThan(FAST_MS)
    expect(timed(() => previewDoc('<!-- license line -->\n'.repeat(5_000)))).toBeLessThan(FAST_MS)
    expect(previewDoc(`${comments}<p>x</p>`)).toBe(`${shimTag('null', false)}${comments}<p>x</p>`)
  })

  it('embeds kept storage as a literal that cannot end the script', () => {
    const saved = JSON.stringify({ note: '</script><script>alert(1)</script>\u2028' })
    const doc = shimmedDoc('<p>x</p>', saved, true)
    expect(doc.indexOf('</script>')).toBe(doc.indexOf(', true)</script>') + ', true)'.length)
    expect(doc).not.toMatch(/[\u2028\u2029]/)
    const literal = /\)\(("(?:[^"\\]|\\.)*"), true\)<\/script>/.exec(doc)?.[1] ?? ''
    expect(JSON.parse(literal)).toBe(saved)
  })

  it('is what the preview shows, with nothing kept', () => {
    expect(previewDoc('<p>x</p>')).toBe(shimmedDoc('<p>x</p>', null, false))
  })
})
