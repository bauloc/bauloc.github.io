import { createFileRoute } from '@tanstack/react-router'

import { DeviceLabPage } from '@/features/device/device-lab-page'

export const Route = createFileRoute('/_shell/device')({
  component: DeviceLabPage,
})
