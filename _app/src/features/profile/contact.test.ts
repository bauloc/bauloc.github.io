import { describe, expect, it, vi } from 'vitest'

import {
  FAILED,
  SENT,
  configuredTelegram,
  mailtoHref,
  sendToTelegram,
  telegramMessage,
  validateContact,
} from './contact'

const DRAFT = { name: 'Loc', email: 'loc@example.com', message: 'Hello' }
const TARGET = { token: 'test-token', chatId: '-100' }

describe('validateContact', () => {
  it('accepts a complete draft', () => {
    expect(validateContact(DRAFT)).toBeNull()
  })

  it('checks the fields in the order the form shows them, one message at a time', () => {
    expect(validateContact({ name: ' ', email: '', message: '' })).toBe('Please enter your name.')
    expect(validateContact({ ...DRAFT, email: '  ' })).toBe('Please enter a valid email.')
    expect(validateContact({ ...DRAFT, message: '\n ' })).toBe('Please enter your message.')
  })

  it("asks only for an '@' in the email, as the Flutter build did", () => {
    expect(validateContact({ ...DRAFT, email: 'not an email' })).toBe('Please enter a valid email.')
    expect(validateContact({ ...DRAFT, email: 'a@b' })).toBeNull()
  })
})

describe('configuredTelegram', () => {
  it('needs both the token and the chat', () => {
    expect(configuredTelegram({})).toBeNull()
    expect(configuredTelegram({ VITE_TELEGRAM_BOT_TOKEN: 't' })).toBeNull()
    expect(
      configuredTelegram({ VITE_TELEGRAM_BOT_TOKEN: ' ', VITE_TELEGRAM_CHAT_ID: '1' }),
    ).toBeNull()
    expect(
      configuredTelegram({ VITE_TELEGRAM_BOT_TOKEN: 't', VITE_TELEGRAM_CHAT_ID: '1' }),
    ).toEqual({
      token: 't',
      chatId: '1',
    })
  })
})

describe('telegramMessage', () => {
  it('keeps the Flutter wording and trims the fields', () => {
    expect(telegramMessage({ name: ' Loc ', email: 'loc@example.com', message: 'Hi\n' })).toBe(
      [
        '<i>Có liên hệ mới từ người dùng</i>',
        'Sender name: <b>Loc</b>',
        'Sender mail: <b>loc@example.com</b>',
        'Sender message: <b>Hi</b>',
      ].join('\n'),
    )
  })

  it("escapes what Telegram's HTML mode would refuse to parse", () => {
    const text = telegramMessage({ ...DRAFT, message: 'a < b && <b>bold</b>' })
    expect(text).toContain('Sender message: <b>a &lt; b &amp;&amp; &lt;b&gt;bold&lt;/b&gt;</b>')
  })
})

describe('mailtoHref', () => {
  it('writes the email for the visitor, encoded for a URL', () => {
    const href = mailtoHref({ name: 'Loc', email: 'loc@example.com', message: 'Hi & bye?' })
    const url = new URL(href)
    expect(url.protocol).toBe('mailto:')
    expect(url.pathname).toBe('bauloc79@gmail.com')
    expect(url.searchParams.get('subject')).toBe('Contact from Loc')
    expect(url.searchParams.get('body')).toBe('Hi & bye?\n\nLoc <loc@example.com>')
  })
})

describe('sendToTelegram', () => {
  it('posts the message form-encoded and thanks the sender', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })))
    await expect(sendToTelegram(DRAFT, TARGET, fetchImpl)).resolves.toEqual({
      ok: true,
      toast: SENT,
    })

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage')
    expect(init?.method).toBe('POST')
    const body = init?.body as URLSearchParams
    expect(body.get('chat_id')).toBe('-100')
    expect(body.get('parse_mode')).toBe('html')
    expect(body.get('text')).toBe(telegramMessage(DRAFT))
  })

  it("shows Telegram's own explanation when it refuses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ ok: false, description: 'Too Many Requests' }, { status: 429 }),
      ),
    )
    await expect(sendToTelegram(DRAFT, TARGET, fetchImpl)).resolves.toEqual({
      ok: false,
      toast: 'Too Many Requests',
    })
  })

  it('falls back to the generic failure when the reply is not Telegram JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 })),
    )
    await expect(sendToTelegram(DRAFT, TARGET, fetchImpl)).resolves.toEqual({
      ok: false,
      toast: FAILED,
    })
  })

  it('reports a network failure instead of throwing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(sendToTelegram(DRAFT, TARGET, fetchImpl)).resolves.toEqual({
      ok: false,
      toast: FAILED,
    })
  })
})
