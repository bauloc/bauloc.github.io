import { createFileRoute } from '@tanstack/react-router'

import { ResumePage } from '@/features/profile/pages/resume-page'

export const Route = createFileRoute('/profile/resume')({
  component: ResumePage,
})
