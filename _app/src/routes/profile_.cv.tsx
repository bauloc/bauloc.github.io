import { createFileRoute } from '@tanstack/react-router'

import { CvPage } from '@/features/profile/pages/cv-page'

/** `/profile/cv`: a page of its own, outside the one-page profile. */
export const Route = createFileRoute('/profile_/cv')({
  component: CvPage,
})
