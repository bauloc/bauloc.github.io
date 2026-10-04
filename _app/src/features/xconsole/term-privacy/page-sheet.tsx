import { ArrowLeft, ArrowRight, Check, Eye, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import { useConsole } from '../console-context'
import { toastFailure } from '../errors'
import { XCONSOLE_MESSAGES } from '../messages'
import { AuthError, type Repo } from '../repo/github'
import {
  DATA_COLLECTED_OPTIONS,
  DB_PATH,
  editConflict,
  emptyDraft,
  pagePath,
  parseDb,
  parsePage,
  planPublish,
  privacyUrl,
  slugify,
  termsUrl,
  validateGeneral,
  validatePrivacy,
  type DbIndex,
  type LegalPage,
  type PageDraft,
  type Platform,
} from './model'

const today = () => new Date().toISOString().split('T')[0] ?? ''

const NO_PAGES: DbIndex = { version: 1, entries: [] }

function Field({
  id,
  label,
  required,
  hint,
  children,
}: {
  id?: string
  label: string
  required?: boolean
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {hint !== undefined && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h3 className="text-muted-foreground border-b pb-2 text-xs font-semibold tracking-wider uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Steps({ step }: { step: 1 | 2 }) {
  const t = useMessages(XCONSOLE_MESSAGES).sheet
  const items = [
    { n: 1, title: t.general, sub: t.generalSub },
    { n: 2, title: t.privacyDetails, sub: t.privacyDetailsSub },
  ] as const
  return (
    <ol className="bg-muted/40 flex items-center gap-3 border-y px-6 py-3">
      {items.map((item, index) => {
        const active = item.n === step
        const done = item.n < step
        return (
          <li key={item.n} className="flex flex-1 items-center gap-3">
            {index > 0 && <span aria-hidden="true" className="bg-border -ml-1 h-px w-6 shrink-0" />}
            <span
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
                active && 'bg-primary text-primary-foreground',
                done && 'bg-success text-white',
                !active && !done && 'bg-muted text-muted-foreground border',
              )}
            >
              {done ? <Check className="size-4" /> : item.n}
            </span>
            <span className="leading-tight">
              <span className={cn('block text-sm font-medium', !active && 'text-muted-foreground')}>
                {item.title}
              </span>
              <span className="text-muted-foreground block text-xs">{item.sub}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Open a generated page in a new tab, from the answers as they stand — before publishing. */
function preview(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60_000)
}

/**
 * Create or edit a Terms & Privacy page, in a sheet from the right: two steps, like the
 * legacy console's wizard, then one commit that publishes both pages.
 *
 * An edit keeps the slug: it is the URL already submitted to the stores, and changing it
 * would leave the old pages orphaned (the legacy console allowed it, and did).
 */
export function PageSheet({
  editing,
  onClose,
  onIndex,
}: {
  /** The slug being edited, or null for a new page. */
  editing: string | null
  onClose: () => void
  /** The index as it now stands: after a publish, or as read when a publish was refused. */
  onIndex: (db: DbIndex) => void
}) {
  const { repo, openSettings } = useConsole()
  const all = useMessages(XCONSOLE_MESSAGES)
  const t = all.sheet
  const locale = useLocale()
  const [draft, setDraft] = useState<PageDraft>(() => emptyDraft(today()))
  const [existing, setExisting] = useState<LegalPage | null>(null)
  /** The page file exactly as the edit loaded it, to tell at publish whether it changed since. */
  const loadedText = useRef('')
  const [loading, setLoading] = useState(editing !== null)
  const [step, setStep] = useState<1 | 2>(1)
  const [slugTouched, setSlugTouched] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  /**
   * The repo whose token the last publish was refused with. The error box offers to replace
   * the token, keeping the draft, for as long as that is still the token in use.
   */
  const [refusedRepo, setRefusedRepo] = useState<Repo | null>(null)
  const tokenRefused = refusedRepo !== null && refusedRepo === repo
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  // Each step starts at its top.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [step])

  /** Bumped each time a problem is shown, so the box comes into view even when it repeats. */
  const [shown, setShown] = useState(0)
  const showErrors = (problems: string[]) => {
    setErrors(problems)
    if (problems.length > 0) setShown((n) => n + 1)
  }

  // The error box renders at the top of the scrolled body: bring it into view once it is in
  // the DOM, or Next looks dead. Never on a keystroke, which only clears problems.
  useLayoutEffect(() => {
    if (shown > 0) body.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [shown])

  // Loads the page once per sheet. An effect event, so a new `repo` — which replacing the
  // token produces, as the error box below offers mid-edit — does not reload the page over the
  // answers typed so far, nor move the baseline that publish() compares against.
  const load = useEffectEvent((slug: string, isLive: () => boolean) => {
    repo
      .read(pagePath(slug))
      .then((text) => {
        if (!isLive()) return
        if (text === null) throw new Error(t.noAnswers(slug))
        const page = parsePage(text)
        loadedText.current = text
        setExisting(page)
        // The services field joins on ',' (see below); a leading space keeps it readable.
        setDraft({
          ...page,
          third_party_services: page.third_party_services.map((s, i) => (i === 0 ? s : ` ${s}`)),
        })
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (!isLive()) return
        toastFailure(t.loadFailed, error, openSettings)
        onClose()
      })
  })

  useEffect(() => {
    if (editing === null) return
    let live = true
    load(editing, () => live)
    return () => {
      live = false
    }
  }, [editing])

  const set = <K extends keyof PageDraft>(key: K, value: PageDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors([])
  }

  const togglePlatform = (p: Platform, on: boolean) => {
    set('platform', on ? [...draft.platform, p] : draft.platform.filter((x) => x !== p))
  }

  const toggleData = (id: string, on: boolean) => {
    set(
      'data_collected',
      on ? [...draft.data_collected, id] : draft.data_collected.filter((x) => x !== id),
    )
  }

  const next = () => {
    const problems = validateGeneral(draft, locale)
    showErrors(problems)
    if (problems.length === 0) setStep(2)
  }

  // The pages depend on the answers alone, so the preview needs no index.
  const previewPage = (kind: 'terms' | 'privacy') => {
    const plan = planPublish(draft, NO_PAGES, existing, new Date().toISOString())
    const file = plan.writes.find((w) => w.path.startsWith(`${kind}/`))
    if (file) preview(file.content)
  }

  const publish = async () => {
    const problems = [...validateGeneral(draft, locale), ...validatePrivacy(draft, locale)]
    showErrors(problems)
    setRefusedRepo(null)
    if (problems.length > 0) return
    const used = repo

    setBusy(true)
    const id = toast.loading(existing ? t.updating : t.publishing)
    try {
      // Everything is read at ONE commit and the change is built on that same commit: if the
      // branch moves in between, GitHub refuses the update instead of this publish silently
      // undoing what landed (another tab, another device).
      const head = await repo.head()
      const fresh = await repo.read(DB_PATH, head)
      if (fresh === null) throw new Error(t.indexMissingNothingPublished(DB_PATH))
      const index = parseDb(fresh)
      if (existing === null) {
        const slugNow = draft.slug.trim()
        const taken =
          index.entries.some((e) => e.slug === slugNow) ||
          (await repo.read(pagePath(slugNow), head)) !== null
        if (taken) {
          toast.dismiss(id)
          setStep(1)
          showErrors([t.slugTaken(slugNow)])
          return
        }
      } else {
        const current = await repo.read(pagePath(existing.slug), head)
        const conflict = editConflict(existing.slug, index, loadedText.current, current, locale)
        if (conflict !== null) {
          toast.dismiss(id)
          // The list behind the sheet shows the index as it is now, deleted page gone.
          onIndex(index)
          showErrors([conflict])
          return
        }
      }
      const plan = planPublish(draft, index, existing, new Date().toISOString())
      await repo.commit({ ...plan, parent: head })
      const slug = existing?.slug ?? draft.slug.trim()
      toast.success(existing ? t.updated : t.published, {
        id,
        description: (
          <span>
            {t.liveSoon({
              terms: (
                <a
                  className="underline"
                  href={termsUrl(slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {all.pages.terms}
                </a>
              ),
              privacy: (
                <a
                  className="underline"
                  href={privacyUrl(slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {all.pages.privacy}
                </a>
              ),
            })}
          </span>
        ),
        duration: 8000,
      })
      onIndex(plan.db)
      onClose()
    } catch (error) {
      if (error instanceof AuthError) {
        // A toast's action cannot be clicked under the open sheet, so the fix lives in the
        // sheet: replacing the token opens Settings on top and keeps every answer typed here.
        toast.dismiss(id)
        setRefusedRepo(used)
        setShown((n) => n + 1)
      } else {
        toastFailure(t.publishFailed, error, openSettings, id)
      }
    } finally {
      setBusy(false)
    }
  }

  const slug = draft.slug.trim() || 'slug'

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="px-6 pt-6 pb-4">
          <SheetTitle className="text-lg">{existing ? t.editTitle : t.newTitle}</SheetTitle>
          <SheetDescription>
            {existing ? t.editDescription(existing.slug) : t.newDescription}
            {t.answersInEnglish && ` ${t.answersInEnglish}`}
          </SheetDescription>
        </SheetHeader>
        <Steps step={step} />

        <div ref={body} className="flex-1 overflow-y-auto px-6 py-6">
          {(errors.length > 0 || tokenRefused) && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive mb-6 flex gap-3 rounded-lg border p-3 text-sm"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1 space-y-2">
                <ul className="list-inside space-y-0.5">
                  {tokenRefused && <li>{t.tokenRefused}</li>}
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                {tokenRefused && (
                  <Button size="sm" variant="outline" onClick={openSettings}>
                    {all.updateToken}
                  </Button>
                )}
              </div>
            </div>
          )}

          {loading ? (
            <div className="space-y-4" aria-label={all.loading}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : step === 1 ? (
            <div className="grid gap-8">
              <Section title={t.app}>
                <Field id="tp-app-name" label={t.appName} required>
                  <Input
                    id="tp-app-name"
                    placeholder={t.appNamePlaceholder}
                    value={draft.app_name}
                    onChange={(e) => {
                      const name = e.target.value
                      setDraft((d) => ({
                        ...d,
                        app_name: name,
                        slug: existing || slugTouched ? d.slug : slugify(name),
                      }))
                      setErrors([])
                    }}
                  />
                </Field>
                <Field
                  id="tp-slug"
                  label={t.slug}
                  required
                  hint={
                    existing ? (
                      t.slugFixed
                    ) : (
                      <span className="font-mono">
                        bauloc.github.io/terms/<b className="text-foreground">{slug}</b>/ ·
                        /privacy/<b className="text-foreground">{slug}</b>/
                      </span>
                    )
                  }
                >
                  <Input
                    id="tp-slug"
                    placeholder="my-awesome-app"
                    value={draft.slug}
                    disabled={existing !== null}
                    className="font-mono"
                    onChange={(e) => {
                      setSlugTouched(true)
                      set('slug', e.target.value)
                    }}
                  />
                </Field>
                <Field label={t.platform} required>
                  <div className="flex gap-2">
                    {(['ios', 'android'] as const).map((p) => (
                      <Toggle
                        key={p}
                        variant="outline"
                        pressed={draft.platform.includes(p)}
                        onPressedChange={(on) => {
                          togglePlatform(p, on)
                        }}
                        className="data-[state=on]:border-primary px-4"
                      >
                        {p === 'ios' ? 'iOS' : 'Android'}
                      </Toggle>
                    ))}
                  </div>
                </Field>
                <Field id="tp-desc" label={t.appDescription} required>
                  <Textarea
                    id="tp-desc"
                    rows={3}
                    placeholder={t.appDescriptionPlaceholder}
                    value={draft.app_description}
                    onChange={(e) => {
                      set('app_description', e.target.value)
                    }}
                  />
                </Field>
              </Section>

              <Section title={t.developer}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="tp-dev-name" label={t.name} required>
                    <Input
                      id="tp-dev-name"
                      value={draft.developer_name}
                      onChange={(e) => {
                        set('developer_name', e.target.value)
                      }}
                    />
                  </Field>
                  <Field id="tp-dev-email" label={t.email} required>
                    <Input
                      id="tp-dev-email"
                      type="email"
                      value={draft.developer_email}
                      onChange={(e) => {
                        set('developer_email', e.target.value)
                      }}
                    />
                  </Field>
                  <Field id="tp-website" label={t.website}>
                    <Input
                      id="tp-website"
                      type="url"
                      placeholder={t.websitePlaceholder}
                      value={draft.website_url}
                      onChange={(e) => {
                        set('website_url', e.target.value)
                      }}
                    />
                  </Field>
                  <Field id="tp-country" label={t.country} required>
                    <Input
                      id="tp-country"
                      value={draft.country}
                      onChange={(e) => {
                        set('country', e.target.value)
                      }}
                    />
                  </Field>
                </div>
              </Section>

              <Section title={t.effectiveDate}>
                <Field id="tp-date" label={t.date} required>
                  <Input
                    id="tp-date"
                    type="date"
                    className="w-48"
                    // Without a bound Chrome lets a stray keystroke make a five-digit year.
                    max="9999-12-31"
                    value={draft.effective_date}
                    onChange={(e) => {
                      set('effective_date', e.target.value)
                    }}
                  />
                </Field>
              </Section>
            </div>
          ) : (
            <div className="grid gap-8">
              <Section title={t.dataCollection}>
                <Field label={t.dataCollected} hint={t.dataCollectedHint}>
                  <div className="flex flex-wrap gap-2">
                    {DATA_COLLECTED_OPTIONS.map((id) => (
                      <Toggle
                        key={id}
                        size="sm"
                        variant="outline"
                        pressed={draft.data_collected.includes(id)}
                        onPressedChange={(on) => {
                          toggleData(id, on)
                        }}
                        className="data-[state=on]:border-primary rounded-full px-3"
                      >
                        {t.data[id]}
                      </Toggle>
                    ))}
                  </div>
                </Field>
                <Field id="tp-used-for" label={t.dataUsedFor} required>
                  <Textarea
                    id="tp-used-for"
                    rows={3}
                    placeholder={t.dataUsedForPlaceholder}
                    value={draft.data_used_for}
                    onChange={(e) => {
                      set('data_used_for', e.target.value)
                    }}
                  />
                </Field>
                <Field id="tp-third" label={t.thirdParty} hint={t.thirdPartyHint}>
                  <Input
                    id="tp-third"
                    placeholder={t.thirdPartyPlaceholder}
                    // Joined on ',' alone so typing round-trips exactly; saving trims.
                    value={draft.third_party_services.join(',')}
                    onChange={(e) => {
                      set('third_party_services', e.target.value.split(','))
                    }}
                  />
                </Field>
              </Section>

              <Section title={t.appSettings}>
                {(
                  [
                    ['has_account_creation', t.accountCreation],
                    ['children_under_13', t.children],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <Label htmlFor={`tp-${key}`} className="font-normal">
                      {label}
                    </Label>
                    <Switch
                      id={`tp-${key}`}
                      checked={draft[key]}
                      onCheckedChange={(on) => {
                        set(key, on)
                      }}
                    />
                  </div>
                ))}
              </Section>

              <Section title={t.contact}>
                <Field id="tp-contact" label={t.contactEmail} required>
                  <Input
                    id="tp-contact"
                    type="email"
                    value={draft.contact_email}
                    onChange={(e) => {
                      set('contact_email', e.target.value)
                    }}
                  />
                </Field>
              </Section>

              <Section title={t.preview}>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      previewPage('terms')
                    }}
                  >
                    <Eye /> {t.termsOfService}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      previewPage('privacy')
                    }}
                  >
                    <Eye /> {t.privacyPolicy}
                  </Button>
                </div>
              </Section>
            </div>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {all.cancel}
          </Button>
          {step === 2 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setErrors([])
                setStep(1)
              }}
            >
              <ArrowLeft /> {t.back}
            </Button>
          )}
          {step === 1 ? (
            <Button disabled={loading} onClick={next}>
              {t.next} <ArrowRight />
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() => {
                void publish()
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              {existing ? t.savePublish : t.publish}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
