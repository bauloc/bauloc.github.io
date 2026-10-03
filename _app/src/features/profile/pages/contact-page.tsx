import { useState, type FormEvent } from 'react'

import mailIcon from '../assets/mail.png'
import telegramIcon from '../assets/telegram.png'
import zaloIcon from '../assets/zalo.png'
import { ElevatedButton } from '../components/elevated-button'
import { OutlinedArea, OutlinedField } from '../components/outlined-field'
import { Spinner } from '../components/spinner'
import { Toast, useToast } from '../components/toast'
import {
  CONTACT_EMAIL,
  configuredTelegram,
  mailtoHref,
  sendToTelegram,
  validateContact,
} from '../contact'

const CHANNELS = [
  { title: 'Zalo', value: '+84973989634', href: 'https://zalo.me/+84973989634', icon: zaloIcon },
  { title: 'Telegram', value: 'bauloc', href: 'https://t.me/bauloc', icon: telegramIcon },
  { title: 'Email', value: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}`, icon: mailIcon },
] as const

const TELEGRAM = configuredTelegram(import.meta.env)

/**
 * Three ways to reach out — a row of cards at `wide`, a column below it — then the form.
 *
 * The form says what is missing in a toast, one field at a time, as the Flutter build did. A
 * complete message goes to Telegram when the build was configured for it (see contact.ts),
 * behind the same dimmed spinner; otherwise it opens in the visitor's mail app.
 */
export function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const { toast, show } = useToast()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const draft = { name, email, message }
    const problem = validateContact(draft)
    if (problem !== null) {
      show(problem)
      return
    }
    if (TELEGRAM === null) {
      window.location.href = mailtoHref(draft)
      return
    }
    setSending(true)
    const result = await sendToTelegram(draft, TELEGRAM)
    setSending(false)
    show(result.toast)
  }

  return (
    <div className="wide:p-8 p-3">
      <ul className="wide:flex-row wide:gap-4 flex flex-col gap-3">
        {CHANNELS.map((channel) => (
          <li key={channel.title} className="wide:flex-1 min-w-0">
            <a
              href={channel.href}
              target={channel.href.startsWith('mailto:') ? undefined : '_blank'}
              rel="noopener noreferrer"
              className="bg-profile-teal-50 wide:h-[100px] wide:p-4 wide:pl-7 flex h-[70px] items-center gap-3 rounded-sm p-2 text-black no-underline transition-colors hover:bg-[color-mix(in_srgb,var(--profile-teal-50),black_4%)] active:bg-[color-mix(in_srgb,var(--profile-teal-50),black_10%)]"
            >
              <img
                src={channel.icon}
                alt=""
                width={50}
                height={50}
                className="size-[50px] shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="wide:text-[16px] block truncate text-[14px]">{channel.title}</span>
                <span className="wide:text-[18px] mt-[3px] block truncate text-[16px] font-bold">
                  {channel.value}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>

      <h2 className="wide:text-[24px] py-6 text-[18px] font-semibold">
        You can get in touch via the contact form
      </h2>

      <form
        noValidate
        inert={sending}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <div className="flex gap-4">
          <OutlinedField
            label="Name"
            name="name"
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            className="min-w-0 flex-1"
          />
          <OutlinedField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
            className="min-w-0 flex-1"
          />
        </div>
        <OutlinedArea
          label="Message"
          name="message"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value)
          }}
          className="mt-4 h-[139px]"
        />
        <ElevatedButton type="submit" className="mt-4">
          Submit
        </ElevatedButton>
      </form>

      {sending && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/10">
          <Spinner size={36} stroke={2} className="text-profile-teal" />
        </div>
      )}
      <Toast toast={toast} />
    </div>
  )
}
