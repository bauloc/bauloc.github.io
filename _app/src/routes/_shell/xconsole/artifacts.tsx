import { createFileRoute } from '@tanstack/react-router'

import { ArtifactsPage } from '@/features/xconsole/artifacts/artifacts-page'

export const Route = createFileRoute('/_shell/xconsole/artifacts')({
  component: ArtifactsPage,
})
