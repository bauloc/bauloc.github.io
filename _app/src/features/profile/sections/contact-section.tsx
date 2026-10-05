import { ArrowUpRight, Send } from 'lucide-react'
import { useState, type ComponentProps, type FormEvent } from 'react'

import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import mailIcon from '../assets/mail.png'
import telegramIcon from '../assets/telegram.png'
import zaloIcon from '../assets/zalo.png'
import { Section } from '../components/section'
import { Spinner } from '../components/spinner'
import { Toast, useToast } from '../components/toast'
import {
  CONTACT_EMAIL,
  configuredTelegram,
  mailtoHref,
  sendToTelegram,
  validateContact,
} from '../contact'
import { PROFILE_MESSAGES } from '../messages'

const CHANNELS = [
  { title: 'Zalo', value: '+84973989634', href: 'https://zalo.me/+84973989634', icon: zaloIcon },
  { title: 'Telegram', value: 'bauloc', href: 'https://t.me/bauloc', icon: telegramIcon },
  { title: 'Email', value: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}`, icon: mailIcon },
] as const

const TELEGRAM = configuredTelegram(import.meta.env)

/** The reference's card light, snug around a one-line row. */
const ROW_GLOW =
  'absolute -inset-x-4 -inset-y-1 z-0 hidden rounded-md transition motion-reduce:transition-none lg:-inset-x-6 lg:block lg:group-hover:bg-profile-hover lg:group-hover:shadow-[inset_0_1px_0_0_rgb(161_161_170/0.1)]'

const LABEL = 'text-profile-muted mb-1.5 block text-xs font-semibold tracking-wide uppercase'
const FIELD =
  'border-profile-line text-profile-ink placeholder:text-profile-muted focus:border-profile-tint focus:ring-profile-tint/25 w-full rounded-md border bg-transparent px-3 py-2 text-[15px] outline-none transition focus:ring-4 motion-reduce:transition-none'

function Field({ label, className, ...props }: { label: string } & ComponentProps<'input'>) {
  return (
    <label className={cn('block', className)}>
      <span className={LABEL}>{label}</span>
      <input className={FIELD} {...props} />
    </label>
  )
}

/**
 * The call to work together, three ways to reach out, then the form.
 *
 * The form says what is missing in a toast, one field at a time, as the Flutter build did. A
 * complete message goes to Telegram when the build was configured for it (see contact.ts),
 * behind a dimmed spinner; otherwise it opens in the visitor's mail app. The toasts are worded
 * when they show, in the language on screen then.
 */
export function ContactSection() {
  const t = useMessages(PROFILE_MESSAGES)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const { toast, show } = useToast()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const draft = { name, email, message }
    const missing = validateContact(draft)
    if (missing !== null) {
      show(t.missing[missing])
      return
    }
    if (TELEGRAM === null) {
      window.location.href = mailtoHref(draft)
      return
    }
    setSending(true)
    const result = await sendToTelegram(draft, TELEGRAM)
    setSending(false)
    show(result.ok ? t.sent : (result.detail ?? t.failed))
  }

  return (
    <Section id="contact" title={t.section.contact}>
      <h3 className="text-profile-ink text-xl font-semibold tracking-tight">{t.workTogether}</h3>
      <p className="mt-3">{t.workTogetherBody}</p>

      <ul className="group/list mt-10 space-y-2">
        {CHANNELS.map((channel) => {
          const mail = channel.href.startsWith('mailto:')
          return (
            <li key={channel.title}>
              <a
                href={channel.href}
                target={mail ? undefined : '_blank'}
                rel="noopener noreferrer"
                className="group relative flex items-center gap-4 py-3 transition-all motion-reduce:transition-none lg:group-hover/list:opacity-50 lg:hover:!opacity-100"
              >
                <span className={ROW_GLOW} />
                <img
                  src={channel.icon}
                  alt=""
                  width={40}
                  height={40}
                  className="relative z-10 size-10 shrink-0"
                />
                <span className="relative z-10 min-w-0 flex-1">
                  <span className="text-profile-muted block text-xs font-semibold tracking-wide uppercase">
                    {channel.title}
                  </span>
                  <span className="text-profile-ink group-hover:text-profile-primary block truncate font-medium transition-colors">
                    {channel.value}
                  </span>
                </span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="text-profile-muted group-hover:text-profile-primary relative z-10 size-4 shrink-0 transition group-hover:translate-x-1 group-hover:-translate-y-1 motion-reduce:transition-none"
                />
                {!mail && <span className="sr-only">{t.newTab}</span>}
              </a>
            </li>
          )
        })}
      </ul>

      <h3 className="text-profile-ink mt-14 mb-5 font-semibold">{t.contactFormHeading}</h3>
      <form
        noValidate
        inert={sending}
        onSubmit={(event) => {
          void submit(event)
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t.name}
            name="name"
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
          <Field
            label={t.email}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          />
        </div>
        <label className="block">
          <span className={LABEL}>{t.message}</span>
          <textarea
            name="message"
            rows={5}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value)
            }}
            className={cn(FIELD, 'resize-y')}
          />
        </label>
        <button
          type="submit"
          className="bg-profile-primary text-profile-on-primary inline-flex cursor-pointer items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold transition hover:opacity-90 motion-reduce:transition-none"
        >
          <Send aria-hidden="true" className="size-4" />
          {t.submit}
        </button>
      </form>

      {sending && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/10">
          <Spinner size={36} stroke={2} className="text-profile-tint" />
        </div>
      )}
      <Toast toast={toast} />
    </Section>
  )
}
