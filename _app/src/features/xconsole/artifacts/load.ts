import { currentLocale, type Locale } from '@/lib/locale'

import type { Repo, RepoEntry } from '../repo/github'
import { ARTIFACT_MESSAGES } from './messages'
import {
  ARTIFACT_DB_PATH,
  ARTIFACT_DIR,
  NO_ARTIFACTS,
  artifactPath,
  parseArtifactDb,
  type ArtifactDb,
  type ArtifactEntry,
} from './model'
import { artifactSource } from './templates/wrapper'

/*
  The reads every action starts from. A missing data/artifact/db.json is an empty index only
  while artifact/ serves no page: if pages are there, the index was lost, and treating it as
  empty would publish a list without them over it — what Term & Privacy refuses to do too.
*/

/** A served page in a listing of artifact/. */
export const isServedPage = (entry: RepoEntry) =>
  entry.type === 'file' && entry.name.endsWith('.html')

/**
 * The index at `ref` (the published branch by default). Null when it is missing while artifact/
 * still serves pages: the caller then refuses to publish rather than overwrite the real one.
 */
export async function loadArtifactDb(
  repo: Pick<Repo, 'read' | 'list'>,
  ref?: string,
  locale: Locale = currentLocale(),
): Promise<ArtifactDb | null> {
  const text = await repo.read(ARTIFACT_DB_PATH, ref)
  if (text !== null) return parseArtifactDb(text, locale)
  const listed = await repo.list(ARTIFACT_DIR, ref)
  return listed?.some(isServedPage) ? null : NO_ARTIFACTS
}

/**
 * Whether artifact/<id>.html exists at `ref`, from a listing: a read would download the whole
 * page just to learn that it is there.
 */
export async function isServed(
  repo: Pick<Repo, 'list'>,
  id: string,
  ref?: string,
): Promise<boolean> {
  const path = artifactPath(id)
  const listed = await repo.list(ARTIFACT_DIR, ref)
  return listed?.some((entry) => entry.type === 'file' && entry.path === path) ?? false
}

/** An artifact as it is published now: its index entry and its page, read at one commit. */
export interface PublishedArtifact {
  /** The index at that commit: the list as it now stands. */
  readonly index: ArtifactDb
  /** The artifact's entry in it, which says how the served file holds the page. */
  readonly entry: ArtifactEntry
  /** The served file, exactly as read: an edit publishes over it only while it is unchanged. */
  readonly served: string
  /** The page itself: the served file, or the page inside the wrapper. */
  readonly source: string
}

/**
 * Why an artifact's page could not be read back, in the console's language. `index` is the list
 * as read at the same commit, when it could be read, for the caller to show: a page deleted
 * elsewhere then leaves the list, rather than failing the same way at the next click.
 */
export class PublishedReadError extends Error {
  readonly index: ArtifactDb | null
  constructor(message: string, index: ArtifactDb | null) {
    super(message)
    this.name = 'PublishedReadError'
    this.index = index
  }
}

/**
 * An artifact's entry and its served file, read at ONE commit. The entry's sandbox flag says how
 * the file holds the page, so it must be the flag that file was written with. A list read
 * earlier may predate another tab turning the sandbox on, and would take the wrapper for the page
 * itself — which an edit would then publish, wrapper and all, as a full page.
 *
 * `listed` is the artifact as the list shows it: only its id and title are used.
 */
export async function loadPublished(
  repo: Pick<Repo, 'head' | 'read' | 'list'>,
  listed: Pick<ArtifactEntry, 'id' | 'title'>,
  locale: Locale = currentLocale(),
): Promise<PublishedArtifact> {
  const t = ARTIFACT_MESSAGES[locale]
  const head = await repo.head()
  const path = artifactPath(listed.id)
  const [index, served] = await Promise.all([
    loadArtifactDb(repo, head, locale),
    repo.read(path, head),
  ])
  if (index === null) throw new PublishedReadError(t.servedMissing(ARTIFACT_DB_PATH), null)
  const entry = index.entries.find((e) => e.id === listed.id)
  if (entry === undefined) {
    throw new PublishedReadError(t.alreadyDeletedDetail(listed.title), index)
  }
  if (served === null) throw new PublishedReadError(t.servedMissing(path), index)
  const source = artifactSource(served, entry.sandbox)
  if (source === null) throw new PublishedReadError(t.servedUnreadable(path), index)
  return { index, entry, served, source }
}
