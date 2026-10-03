import { createFileRoute } from '@tanstack/react-router'

import { TermPrivacyPage } from '@/features/xconsole/term-privacy/term-privacy-page'

/** `/xconsole/` opens on Term & Privacy, as the legacy console did. */
export const Route = createFileRoute('/_shell/xconsole/')({
  component: TermPrivacyPage,
})
