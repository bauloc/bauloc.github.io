/*
  The contact form's logic, kept free of React so it can be tested: the Flutter build's
  validation messages, and two ways to deliver a message.

  - Telegram, as the Flutter build did: a bot posts the message into a group. The site is
    static, so the browser calls the Bot API itself and the bot's token ends up in the
    published bundle, readable by anyone. For that reason it is NOT in this repo's source: it
    comes from VITE_TELEGRAM_BOT_TOKEN and VITE_TELEGRAM_CHAT_ID at build time (see
    .env.example), and setting them is a decision to publish that token.
  - Email, whenever those are not set: the visitor's mail app opens on a message to the
    address the Contact cards show, already written.
*/

export const CONTACT_EMAIL = 'bauloc79@gmail.com'

export interface ContactDraft {
  readonly name: string
  readonly email: string
  readonly message: string
}

export interface TelegramTarget {
  readonly token: string
  readonly chatId: string
}

/** The Telegram target the build was given, if any. */
export function configuredTelegram(env: {
  VITE_TELEGRAM_BOT_TOKEN?: string
  VITE_TELEGRAM_CHAT_ID?: string
}): TelegramTarget | null {
  const token = env.VITE_TELEGRAM_BOT_TOKEN?.trim() ?? ''
  const chatId = env.VITE_TELEGRAM_CHAT_ID?.trim() ?? ''
  return token !== '' && chatId !== '' ? { token, chatId } : null
}

/** What is wrong with a draft, as the toast that says so; null when it can be sent. */
export function validateContact(draft: ContactDraft): string | null {
  if (draft.name.trim() === '') return 'Please enter your name.'
  const email = draft.email.trim()
  if (email === '' || !email.includes('@')) return 'Please enter a valid email.'
  if (draft.message.trim() === '') return 'Please enter your message.'
  return null
}

/**
 * Telegram's HTML parse mode rejects a message with a stray `<` or `&` ("can't parse
 * entities"). The Flutter build interpolated input raw, so such a message never arrived.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The message as it lands in the Telegram group: the Flutter build's wording, in Vietnamese. */
export function telegramMessage(draft: ContactDraft): string {
  return [
    '<i>Có liên hệ mới từ người dùng</i>',
    `Sender name: <b>${escapeHtml(draft.name.trim())}</b>`,
    `Sender mail: <b>${escapeHtml(draft.email.trim())}</b>`,
    `Sender message: <b>${escapeHtml(draft.message.trim())}</b>`,
  ].join('\n')
}

/** The same message as an email, for the visitor's mail app to send. */
export function mailtoHref(draft: ContactDraft): string {
  const subject = `Contact from ${draft.name.trim()}`
  const body = `${draft.message.trim()}\n\n${draft.name.trim()} <${draft.email.trim()}>`
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export const SENT = 'Thank you, I will respond as soon as possible.'
export const FAILED = 'Request failed. Please try again.'

/**
 * Post a draft to Telegram and say how it went, as the toast to show.
 *
 * A form-encoded POST is a CORS "simple request" — no preflight — and, unlike the Flutter
 * build's GET, keeps a long message out of the URL.
 */
export async function sendToTelegram(
  draft: ContactDraft,
  target: TelegramTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; toast: string }> {
  const body = new URLSearchParams({
    chat_id: target.chatId,
    parse_mode: 'html',
    text: telegramMessage(draft),
  })
  let response: Response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: 'POST',
      body,
    })
  } catch {
    return { ok: false, toast: FAILED }
  }
  if (response.ok) return { ok: true, toast: SENT }

  // Telegram explains a refusal in `description`; the Flutter build showed it as-is.
  const reply: unknown = await response.json().catch(() => null)
  const description =
    typeof reply === 'object' && reply !== null && 'description' in reply ? reply.description : null
  return { ok: false, toast: typeof description === 'string' ? description : FAILED }
}
