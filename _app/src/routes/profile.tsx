import { createFileRoute } from '@tanstack/react-router'

import { ProfileLayout } from '@/features/profile/profile-layout'

export const Route = createFileRoute('/profile')({
  component: ProfileLayout,
})
