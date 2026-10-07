import { createFileRoute } from '@tanstack/react-router'

import { BuildsPage } from '@/features/xconsole/builds/builds-page'

export const Route = createFileRoute('/_shell/xconsole/builds')({
  component: BuildsPage,
})
