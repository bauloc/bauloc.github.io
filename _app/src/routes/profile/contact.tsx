import { createFileRoute } from '@tanstack/react-router'

import { ContactPage } from '@/features/profile/pages/contact-page'

export const Route = createFileRoute('/profile/contact')({
  component: ContactPage,
})
