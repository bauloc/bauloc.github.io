import { createFileRoute } from '@tanstack/react-router'

import { RelaxPage } from '@/features/profile/pages/relax-page'

export const Route = createFileRoute('/profile/relax')({
  component: RelaxPage,
})
