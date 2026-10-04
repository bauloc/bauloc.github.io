import { ExternalLink, KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'

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
import { useMessages } from '@/lib/i18n'

import { XCONSOLE_MESSAGES } from '../messages'
import { REPO } from '../repo/github'
import { clearToken, readToken, saveToken } from '../repo/token'

const NEW_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?description=XConsole%20for%20bauloc.github.io'

/**
 * The GitHub token, asked for in two situations: `connect` when there is none — the console
 * can do nothing without one, so this cannot be dismissed — and `settings`, to replace it or
 * log out.
 */
export function TokenDialog({
  mode,
  open,
  onClose,
}: {
  mode: 'connect' | 'settings'
  open: boolean
  onClose: () => void
}) {
  const [value, setValue] = useState(() => (mode === 'settings' ? readToken() : ''))
  const [missing, setMissing] = useState(false)
  const connect = mode === 'connect'
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = all.token

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value.trim()) {
      setMissing(true)
      return
    }
    saveToken(value)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !connect) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!connect}
        onEscapeKeyDown={(event) => {
          if (connect) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (connect) event.preventDefault()
        }}
      >
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <div className="bg-primary/10 text-primary mb-2 grid size-10 place-items-center rounded-lg">
              <KeyRound className="size-5" />
            </div>
            <DialogTitle>{connect ? t.connectTitle : all.settings}</DialogTitle>
            <DialogDescription>
              {connect ? t.connectDescription : t.settingsDescription}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="xconsole-token">{t.label}</Label>
            <Input
              id="xconsole-token"
              type="password"
              autoComplete="off"
              placeholder={t.placeholder}
              value={value}
              aria-invalid={missing}
              onChange={(event) => {
                setValue(event.target.value)
                setMissing(false)
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t.hint({
                permission: (
                  <span className="text-foreground font-medium">Contents: Read and write</span>
                ),
                repo: <code className="bg-muted rounded px-1 py-0.5 font-mono">{REPO}</code>,
                scope: <code className="bg-muted rounded px-1 py-0.5 font-mono">repo</code>,
              })}{' '}
              <a
                href={NEW_TOKEN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-0.5 font-medium hover:underline"
              >
                {t.create} <ExternalLink className="size-3" />
              </a>
            </p>
            {missing && <p className="text-destructive text-xs">{t.missing}</p>}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {connect ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  clearToken()
                  onClose()
                }}
              >
                {t.logOut}
              </Button>
            )}
            <div className="flex gap-2">
              {!connect && (
                <Button type="button" variant="outline" onClick={onClose}>
                  {all.cancel}
                </Button>
              )}
              <Button type="submit">{connect ? t.connect : t.save}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
