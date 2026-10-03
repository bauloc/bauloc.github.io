import { createFileRoute } from '@tanstack/react-router'

import { TermPrivacyPage } from '@/features/xconsole/term-privacy/term-privacy-page'

export const Route = createFileRoute('/_shell/xconsole/term-privacy')({
  component: TermPrivacyPage,
})
