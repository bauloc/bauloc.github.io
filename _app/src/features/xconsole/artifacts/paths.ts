import { SITE } from '../site'

/*
  Where artifacts live in the repo and on the site. Its own module, below both the model and
  the wrapper template, because the template needs the link too and the model needs the template.

    data/artifact/db.json      the index the console lists
    artifact/<id>.html         the served page: the sandbox wrapper, or the page itself
*/

export const ARTIFACT_DB_PATH = 'data/artifact/db.json'
export const ARTIFACT_DIR = 'artifact'

export const artifactPath = (id: string) => `${ARTIFACT_DIR}/${id}.html`

/** The link readers get: the live site, or the dev mock's own origin when the console passes it. */
export const artifactUrl = (id: string, origin = SITE) => `${origin}/${ARTIFACT_DIR}/${id}.html`
