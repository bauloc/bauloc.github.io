import { createFileRoute } from '@tanstack/react-router'

import { PendingPage } from '@/features/published/pending-page'

/**
 * `/build/<id>/` reaches the app only when Pages has no install page there: not deployed yet, or
 * removed. The tester stays on their link (see PendingPage) rather than being sent to /profile.
 */
export const Route = createFileRoute('/build/$id')({
  component: () => <PendingPage kind="build" />,
})
