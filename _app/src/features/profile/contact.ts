/*
  The contact form's logic, kept free of React and of wording so it can be tested: the
  Flutter build's validation, and two ways to deliver a message. What it finds is said by
  the page, in the visitor's language (messages.ts).

  - Telegram, as the Flutter build did: a bot posts the message into a group. The site is
    static, so the browser calls the Bot API itself and the bot's token ends up in the
    published bundle, readable by anyone; its owner accepts that. It comes from
    VITE_TELEGRAM_BOT_TOKEN and VITE_TELEGRAM_CHAT_ID at build time, set by the committed
    .env.production. They once lived only in the git-ignored .env, which a git worktree does
    not have, and a build made in one published a form that never reached Telegram.
  - Email, whenever those are not set (a dev server without .env): the visitor's mail app
    opens on a message to the address the Contact cards show, already written.
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

/** A field the form can find missing, in the order it shows them. */
export type ContactField = 'name' | 'email' | 'message'

/** The first field a draft lacks, one at a time as the Flutter build did; null when it can be sent. */
export function validateContact(draft: ContactDraft): ContactField | null {
  if (draft.name.trim() === '') return 'name'
  const email = draft.email.trim()
  if (email === '' || !email.includes('@')) return 'email'
  if (draft.message.trim() === '') return 'message'
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

/**
 * How a send went. A refusal carries Telegram's own explanation when it gave one, which the
 * Flutter build showed as-is; `null` means the page's generic failure.
 */
export type SendResult =
  { readonly ok: true } | { readonly ok: false; readonly detail: string | null }

/**
 * Post a draft to Telegram and say how it went.
 *
 * A form-encoded POST is a CORS "simple request" — no preflight — and, unlike the Flutter
 * build's GET, keeps a long message out of the URL.
 */
export async function sendToTelegram(
  draft: ContactDraft,
  target: TelegramTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
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
    return { ok: false, detail: null }
  }
  if (response.ok) return { ok: true }

  // Telegram explains a refusal in `description`.
  const reply: unknown = await response.json().catch(() => null)
  const description =
    typeof reply === 'object' && reply !== null && 'description' in reply ? reply.description : null
  return { ok: false, detail: typeof description === 'string' ? description : null }
}
