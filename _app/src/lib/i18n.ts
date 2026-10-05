import { currentLocale, useLocale, type Locale } from './locale'

/*
  The site's words in both its languages, without a library: each page keeps its messages
  next to its code as one object per language, and a component picks the current one.

  Two shapes, one type. A page's interface text is a catalog — `defineMessages({ en, vi })`
  — read with `useMessages`. Content that is a list of records (the portfolio's apps, the
  resume) keeps each record's two wordings side by side instead, as `Localized<string>`
  fields, so adding an app means writing both of its descriptions in one place.

  A message that needs a value is a function: `devices: (n: number) => …`. Each language
  then words its own plurals and order instead of sharing a template.
*/

/** The same thing in each of the site's languages. */
export type Localized<T> = Readonly<Record<Locale, T>>

/**
 * A page's messages. English is the reference: its keys and signatures are what the
 * Vietnamese must match exactly, so a missing or extra message is a type error, never a
 * blank on screen.
 */
export function defineMessages<T>(messages: {
  readonly en: T
  readonly vi: NoInfer<T>
}): Localized<T> {
  return messages
}

/** The messages in the current language; the component re-renders when it changes. */
export function useMessages<T>(messages: Localized<T>): T {
  return messages[useLocale()]
}

/**
 * A module's catalog for code outside React: the tables a checker or an error map looks its
 * words up in (`COPY.title`, `DEVICE_ERRORS.offline`). It reads as the language on screen at
 * every property access, so nothing has to pass a language down to those callers; whatever
 * shows the result re-renders on a switch (Device Lab's page subscribes at its root) and
 * reads the new language then.
 *
 * Only its top-level keys are live, so it takes an object of messages, never an array. Keep a
 * value read from it only as long as the render that read it.
 */
export function localized<T extends object>(messages: {
  readonly en: T
  readonly vi: NoInfer<T>
}): T {
  const view = {}
  for (const key of Object.keys(messages.en)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => (messages[currentLocale()] as Record<string, unknown>)[key],
    })
  }
  return view as T
}
