import { createFileRoute } from '@tanstack/react-router'

import { PortfolioPage } from '@/features/profile/pages/portfolio-page'

export const Route = createFileRoute('/profile/portfolio')({
  component: PortfolioPage,
})
