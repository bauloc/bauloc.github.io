import { createFileRoute } from '@tanstack/react-router'

import { PendingPage } from '@/features/published/pending-page'

/** `/artifact/<id>.html` with no page published there yet, or any more: see PendingPage. */
export const Route = createFileRoute('/artifact/$file')({
  component: () => <PendingPage kind="artifact" />,
})
