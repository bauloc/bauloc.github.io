import { createFileRoute } from '@tanstack/react-router'

import { IptvPage } from '@/features/xconsole/iptv/iptv-page'

export const Route = createFileRoute('/_shell/xconsole/iptv')({
  component: IptvPage,
})
