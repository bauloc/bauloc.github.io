import { createFileRoute } from '@tanstack/react-router'

import { XConsoleLayout } from '@/features/xconsole/xconsole-layout'

export const Route = createFileRoute('/_shell/xconsole')({
  component: XConsoleLayout,
})
