import { createFileRoute } from '@tanstack/react-router'

import { parseView, type DeviceView } from '@/features/device/components/mode-switch'
import { DeviceLabPage } from '@/features/device/device-lab-page'

interface DeviceSearch {
  /** Scan Device or Connect Device: /device/?view=scan opens Scan Device directly. */
  view?: DeviceView
  /** ?mock=1, the fixture devices, read by the page itself; kept as the view changes. */
  mock?: unknown
}

export const Route = createFileRoute('/_shell/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    ...(search.view === 'scan' || search.view === 'connect' ? { view: search.view } : {}),
    ...(search.mock !== undefined ? { mock: search.mock } : {}),
  }),
  component: DevicePage,
})

function DevicePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <DeviceLabPage
      view={parseView(search.view)}
      onViewChange={(view) => {
        void navigate({ search: (prev) => ({ ...prev, view }) })
      }}
    />
  )
}
