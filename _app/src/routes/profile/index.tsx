import { createFileRoute } from '@tanstack/react-router'

import { ContactPage } from '@/features/profile/pages/contact-page'

/** `/profile/` opens on Contact, as the Flutter build did. */
export const Route = createFileRoute('/profile/')({
  component: ContactPage,
})
