import { CircleCheck, Loader2, RefreshCw, SquareTerminal, TriangleAlert } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { helperCommand, pairHelper, type HelperProbe, type ReadyHelper } from './helper'
import { BUILD_MESSAGES } from './messages'

/*
  The Device Lab helper, as the Upload sheet shows it under a build of 100 MiB or more: where
  the helper stands, and the one thing to do about it — start it, update it, pair this page —
  until it is ready to send the file to GitHub Releases. The sheet probes; this only says what
  the probe found and hands back what the owner did (Check again, a pairing).
*/

/** What the card shows: a probe under way, or what it found. */
export type HelperView = { readonly state: 'checking' } | HelperProbe

/** A command to copy into Terminal, drawn as Device Lab draws its commands. */
function Command({ text }: { text: string }) {
  const t = useMessages(BUILD_MESSAGES).sheet.helper
  return (
    <div className="bg-muted/60 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs whitespace-pre">
        {text}
      </code>
      <CopyButton text={text} label={t.copyCommand} />
    </div>
  )
}

/** The input a helper's printed link (or its token) is pasted into, and its Pair button. */
function PairForm({
  disabled,
  onPaired,
}: {
  disabled: boolean
  onPaired: (helper: ReadyHelper) => void
}) {
  const t = useMessages(BUILD_MESSAGES).sheet.helper
  const id = useId()
  const [input, setInput] = useState('')
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pairing || disabled || !input.trim()) return
    setPairing(true)
    setError(null)
    void pairHelper(input)
      .then((outcome) => {
        if (outcome.ok) {
          setInput('')
          onPaired(outcome.helper)
          return
        }
        const words = t.pairErrors
        setError(
          outcome.reason === 'format'
            ? words.format
            : outcome.reason === 'stale'
              ? words.stale(outcome.tokenId)
              : outcome.reason === 'foreign'
                ? words.foreign(outcome.port)
                : outcome.reason === 'outdated'
                  ? words.outdated
                  : outcome.reason === 'blocked'
                    ? t.blocked
                    : outcome.reason === 'safari'
                      ? t.safari
                      : words.unreachable(outcome.port),
        )
      })
      .finally(() => {
        setPairing(false)
      })
  }

  return (
    <form className="grid gap-2" onSubmit={submit}>
      <label htmlFor={id} className="sr-only">
        {t.pasteLabel}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={input}
          disabled={disabled || pairing}
          placeholder={t.pastePlaceholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? `${id}-error` : undefined}
          className="font-mono text-xs"
          onChange={(e) => {
            setInput(e.target.value)
            setError(null)
          }}
        />
        <Button type="submit" variant="outline" disabled={disabled || pairing || !input.trim()}>
          {pairing && <Loader2 className="animate-spin" />}
          {t.pair}
        </Button>
      </div>
      {error !== null && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  )
}

/**
 * The helper card. `mock`: the dev mock, which never uses the helper, so the card only says so.
 * `dev`: the console runs on a dev server, so the command starts the helper with --dev.
 */
export function HelperCard({
  view,
  mock,
  dev,
  disabled,
  onCheck,
  onPaired,
}: {
  view: HelperView
  mock: boolean
  dev: boolean
  /** A publish is under way: nothing here may start another probe or pairing. */
  disabled: boolean
  onCheck: () => void
  onPaired: (helper: ReadyHelper) => void
}) {
  const t = useMessages(BUILD_MESSAGES).sheet.helper
  const titleId = useId()

  const checkAgain = (
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCheck}>
      <RefreshCw /> {t.checkAgain}
    </Button>
  )
  const permission = <p className="text-muted-foreground text-xs">{t.permission}</p>

  /*
    Each state as a lead sentence — what the probe found, said once by the live region below —
    and what to do about it, outside that region: a screen reader hears the news, not the form.
  */
  let tone: 'ok' | 'warn' | 'idle' = 'warn'
  let lead: ReactNode
  let todo: ReactNode = null
  if (mock) {
    tone = 'idle'
    lead = <span className="text-muted-foreground">{t.mock}</span>
  } else if (view.state === 'checking') {
    tone = 'idle'
    lead = (
      <span className="text-muted-foreground flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        {t.checking}
      </span>
    )
    todo = permission
  } else if (view.state === 'ready') {
    tone = 'ok'
    lead = (
      <span className="text-success flex items-center gap-2 font-medium">
        <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
        {t.ready(view.version)}
      </span>
    )
  } else if (view.state === 'unpaired') {
    lead = t.unpaired
    todo = (
      <>
        <PairForm disabled={disabled} onPaired={onPaired} />
        <p className="text-muted-foreground text-xs">{t.pairElsewhere}</p>
        <div>{checkAgain}</div>
      </>
    )
  } else if (view.state === 'outdated') {
    lead = t.update(view.version)
    todo = (
      <>
        <Command text={helperCommand(view.port, dev)} />
        <div>{checkAgain}</div>
      </>
    )
  } else if (view.reason === 'safari') {
    lead = t.safari
  } else if (view.reason === 'blocked') {
    lead = t.blocked
    todo = <div>{checkAgain}</div>
  } else if (view.reason === 'foreign') {
    // A link from a helper on another port carries that port: pairing with it moves the console.
    lead = t.foreign(view.port)
    todo = (
      <>
        <Command text={helperCommand(view.port + 1, dev)} />
        <PairForm disabled={disabled} onPaired={onPaired} />
        <div>{checkAgain}</div>
      </>
    )
  } else {
    lead = t.start
    todo = (
      <>
        <Command text={helperCommand(view.port, dev)} />
        {permission}
        <div>{checkAgain}</div>
      </>
    )
  }

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'grid gap-3 rounded-xl border p-4 text-sm',
        tone === 'ok' && 'border-success/40 bg-success/5',
        tone === 'warn' && 'border-amber-500/40 bg-amber-500/5',
        tone === 'idle' && 'bg-muted/30',
      )}
    >
      <h4 id={titleId} className="flex items-center gap-2 font-medium">
        {tone === 'warn' ? (
          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <SquareTerminal className="text-muted-foreground size-4 shrink-0" />
        )}
        {t.title}
      </h4>
      {/* One live region for every state, there from the start, so the probe's end is heard. */}
      <p role="status">{lead}</p>
      {todo}
    </section>
  )
}
