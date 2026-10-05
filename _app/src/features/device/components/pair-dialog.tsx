import { Loader2 } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { defineMessages, useMessages } from '@/lib/i18n'

import type { HelperStatus, PairResult } from '../helper/connection'
import { localPairingNote, pairError, rememberNote } from '../helper/status'
import { HELPER_CARD_TITLE_ID } from './helper-card'

/*
  Pairing by hand (spec §6.8): the token, or the whole link the helper printed in Terminal,
  pasted here when the link didn't open this tab. The connection checks the helper's proof
  before it sends anything, and a failed attempt never replaces a pairing that works, so this
  dialog only collects the text and says what went wrong in plain words.

  The token is a secret: the field is never autofilled, spell-checked or auto-capitalised,
  and it is cleared whenever the dialog closes.
*/

const PAIR_MESSAGES = defineMessages({
  en: {
    title: 'Pair this page with the helper',
    description: 'Paste the token or the link the helper printed in Terminal.',
    input: 'Token or link',
    remember: 'Remember on this computer',
    cancel: 'Cancel',
    pairing: 'Pairing…',
    pair: 'Pair',
  },
  vi: {
    title: 'Ghép nối trang này với helper',
    description: 'Dán token hoặc liên kết mà helper đã in ra trong Terminal.',
    input: 'Token hoặc liên kết',
    remember: 'Ghi nhớ trên máy tính này',
    cancel: 'Hủy',
    pairing: 'Đang ghép nối…',
    pair: 'Ghép nối',
  },
})

export function PairDialog({
  open,
  onOpenChange,
  status,
  onPair,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: HelperStatus
  /** HelperConnection.pair. */
  onPair: (input: string, remember: boolean) => Promise<PairResult>
}) {
  const t = useMessages(PAIR_MESSAGES)
  const uid = useId()
  // Opened from the chip, the Gate, a notice or a checklist row, none a DialogTrigger: put focus
  // back on whichever it was, instead of leaving it on <body>.
  const opener = useRef<HTMLElement | null>(null)
  const [input, setInput] = useState('')
  const [remember, setRemember] = useState(status.remember)
  // The failure, not its sentence: worded when shown, so it follows a language switch. It keeps
  // the port it tried, so the words stay the ones it failed with.
  const [failure, setFailure] = useState<Exclude<PairResult, { ok: true }> | null>(null)
  const error = failure ? pairError(failure, status) : null
  const [busy, setBusy] = useState(false)
  const persistent = status.health?.tokenPersistent ?? status.pairing?.tokenPersistent ?? false
  // The helper's own page never remembers a pairing (connection.ts), so it offers no switch.
  const local = status.env.mode === 'local'
  const inputId = `${uid}-token`
  const errorId = `${uid}-error`
  const noteId = `${uid}-note`

  const close = (next: boolean) => {
    if (!next) {
      setInput('')
      setFailure(null)
    }
    onOpenChange(next)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(null)
    onPair(input, remember && !local)
      .then((result) => {
        if (result.ok) close(false)
        else setFailure({ ...result, port: result.port ?? status.env.port })
      })
      .catch(() => {
        setFailure({ ok: false, reason: 'unreachable', port: status.env.port })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e) => {
          // Paired from the Gate: its Pair button is gone with the phase, so the iPhone card's
          // title (which says the new phase) takes focus. Nothing to return to: Radix's default.
          const target = opener.current?.isConnected
            ? opener.current
            : document.getElementById(HELPER_CARD_TITLE_ID)
          if (!target) return
          e.preventDefault()
          target.focus()
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={inputId}>{t.input}</Label>
            <Input
              id={inputId}
              name="helper-token"
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                if (failure) setFailure(null)
              }}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              placeholder="http://127.0.0.1:8787/device/#pair=…"
              className="font-mono"
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error && (
              <p id={errorId} role="alert" className="text-destructive text-sm leading-relaxed">
                {error}
              </p>
            )}
          </div>

          {local ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {localPairingNote(persistent)}
            </p>
          ) : (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-3">
                <Switch
                  id={`${uid}-remember`}
                  checked={remember}
                  onCheckedChange={setRemember}
                  aria-describedby={noteId}
                />
                <Label htmlFor={`${uid}-remember`}>{t.remember}</Label>
              </div>
              <p id={noteId} className="text-muted-foreground text-xs leading-relaxed">
                {rememberNote(persistent)}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                close(false)
              }}
            >
              {t.cancel}
            </Button>
            {/* aria-disabled while pairing: disabling the focused button drops focus to <body>. */}
            <Button
              type="submit"
              aria-disabled={busy || input.trim() === '' || undefined}
              className="aria-disabled:opacity-50"
              onClick={(e) => {
                if (busy || input.trim() === '') e.preventDefault()
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t.pairing : t.pair}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
