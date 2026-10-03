import { createFileRoute } from '@tanstack/react-router'

import { AboutMePage } from '@/features/profile/pages/about-me-page'

export const Route = createFileRoute('/profile/about_me')({
  component: AboutMePage,
})
